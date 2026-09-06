const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

function serviceError(message, statusCode = 503) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function abortError(message = "本地图像处理已取消") {
  const error = new Error(message);
  error.name = "AbortError";
  error.statusCode = 499;
  return error;
}

function resolveLocalImageOptions(projectRoot, environment = process.env) {
  const iopaintRoot = path.resolve(environment.IOPAINT_ROOT || path.join(projectRoot, "..", "IOPaint"));
  const realesrganRoot = path.resolve(environment.REALESRGAN_ROOT || path.join(projectRoot, "..", "Real-ESRGAN"));
  const python = environment.LOCAL_IMAGE_PYTHON || (process.platform === "win32" ? "py" : "python3");
  const pythonArgs = environment.LOCAL_IMAGE_PYTHON ? [] : (process.platform === "win32" ? ["-3.11"] : []);
  const defaultCacheRoot = environment.USERPROFILE
    ? path.join(environment.USERPROFILE, ".cache", "torch", "hub", "checkpoints")
    : path.join(os.homedir(), ".cache", "torch", "hub", "checkpoints");
  const repositoryLamaModelPath = path.join(iopaintRoot, "models", "big-lama.pt");
  const defaultLamaModelPath = fs.existsSync(repositoryLamaModelPath)
    ? repositoryLamaModelPath
    : path.join(defaultCacheRoot, "big-lama.pt");
  return {
    iopaintRoot,
    realesrganRoot,
    python,
    pythonArgs,
    lamaModelPath: path.resolve(environment.LAMA_MODEL_PATH || defaultLamaModelPath),
    realesrganModelPath: path.resolve(environment.REALESRGAN_MODEL_PATH
      || path.join(realesrganRoot, "weights", "RealESRGAN_x4plus_anime_6B.pth")),
    workerPath: path.join(projectRoot, "scripts", "local-image-worker.py")
  };
}

function decodeDataUrl(dataUrl, label) {
  const match = String(dataUrl || "").match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
  if (!match) throw serviceError(`${label}必须是 base64 图片`, 400);
  return Buffer.from(match[1], "base64");
}

class LocalImageWorkerClient {
  constructor(options) {
    this.options = options;
    this.child = null;
    this.lines = null;
    this.queue = [];
    this.active = null;
    this.nextId = 1;
    this.closing = false;
    this.lastError = "";
    this.restartAttempts = 0;
  }

  validateBasePaths() {
    if (!fs.existsSync(this.options.workerPath)) throw serviceError(`本地图像 worker 不存在：${this.options.workerPath}`);
  }

  start() {
    if (this.child && !this.child.killed) return;
    this.validateBasePaths();
    const options = this.options;
    const child = spawn(options.python, [
      ...options.pythonArgs,
      "-u",
      options.workerPath,
      "--iopaint-root", options.iopaintRoot,
      "--realesrgan-root", options.realesrganRoot,
      "--lama-model", options.lamaModelPath,
      "--realesrgan-model", options.realesrganModelPath
    ], {
      cwd: path.dirname(options.workerPath),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.child = child;
    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(child, line));
    child.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message && !/FutureWarning|UserWarning/.test(message)) console.warn(`[Local image worker] ${message}`);
    });
    child.once("error", (error) => {
      this.lastError = error.message || String(error);
      this.handleExit(child, null, "启动失败");
    });
    child.once("exit", (code, signal) => this.handleExit(child, code, signal));
  }

  handleLine(child, line) {
    if (this.child !== child || !this.active) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.lastError = "本地图像 worker 返回了无效响应";
      return;
    }
    if (String(message.id) !== this.active.id) return;
    const entry = this.active;
    this.active = null;
    clearTimeout(entry.timer);
    entry.removeAbort?.();
    if (message.ok) {
      this.restartAttempts = 0;
      entry.resolve(message.result);
    } else {
      const error = serviceError(message.error || "本地图像处理失败", 422);
      error.workerTrace = message.trace || "";
      entry.reject(error);
    }
    this.refreshQueuePositions();
    this.pump();
  }

  handleExit(child, code, signal) {
    if (this.child !== child) return;
    this.lines?.close();
    this.lines = null;
    this.child = null;
    const wasCancelling = Boolean(child.__localImageCancellation);
    if (this.active) {
      const entry = this.active;
      this.active = null;
      clearTimeout(entry.timer);
      entry.removeAbort?.();
      if (!entry.settled) {
        const reason = signal ? `信号 ${signal}` : `退出码 ${code}`;
        entry.reject(serviceError(`本地图像 worker 已退出（${reason}）`));
      }
    }
    if (this.closing) return;
    if (!wasCancelling && this.restartAttempts >= 1) {
      const error = serviceError(`本地图像 worker 重启失败：${this.lastError || "未知错误"}`);
      this.queue.splice(0).forEach((entry) => entry.reject(error));
      return;
    }
    if (!wasCancelling) this.restartAttempts += 1;
    try {
      this.start();
      this.pump();
    } catch (error) {
      this.lastError = error.message || String(error);
      this.queue.splice(0).forEach((entry) => entry.reject(error));
    }
  }

  refreshQueuePositions() {
    this.queue.forEach((entry, index) => entry.onQueue?.(index + 1));
  }

  pump() {
    if (this.closing || this.active || !this.queue.length) return;
    try {
      this.start();
    } catch (error) {
      this.queue.splice(0).forEach((entry) => entry.reject(error));
      return;
    }
    const entry = this.queue.shift();
    if (entry.signal?.aborted) {
      entry.removeAbort?.();
      entry.reject(abortError());
      this.pump();
      return;
    }
    this.active = entry;
    entry.onStart?.();
    this.refreshQueuePositions();
    entry.timer = setTimeout(() => {
      if (this.active !== entry) return;
      this.cancelActive(entry, serviceError("本地图像处理超时，请缩小图片后重试", 504));
    }, entry.timeoutMs);
    this.child.stdin.write(`${JSON.stringify({ id: entry.id, action: entry.action, payload: entry.payload })}\n`, (error) => {
      if (!error || this.active !== entry) return;
      this.cancelActive(entry, serviceError(`无法发送本地图像处理请求：${error.message}`));
    });
  }

  cancelActive(entry, error = abortError()) {
    if (this.active !== entry) return;
    this.active = null;
    clearTimeout(entry.timer);
    entry.removeAbort?.();
    entry.settled = true;
    entry.reject(error);
    const child = this.child;
    if (child && !child.killed) {
      child.__localImageCancellation = true;
      child.kill();
    } else {
      this.pump();
    }
  }

  request(action, payload = {}, { timeoutMs = 5 * 60 * 1000, signal, onQueue, onStart } = {}) {
    if (this.closing) return Promise.reject(serviceError("本地图像 worker 正在关闭"));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const entry = { id, action, payload, timeoutMs, signal, onQueue, onStart, resolve, reject, timer: null, settled: false };
      const abort = () => {
        if (this.active === entry) {
          this.cancelActive(entry);
          return;
        }
        const index = this.queue.indexOf(entry);
        if (index >= 0) {
          this.queue.splice(index, 1);
          entry.removeAbort?.();
          entry.settled = true;
          reject(abortError());
          this.refreshQueuePositions();
        }
      };
      if (signal) {
        signal.addEventListener("abort", abort, { once: true });
        entry.removeAbort = () => signal.removeEventListener("abort", abort);
      }
      this.queue.push(entry);
      this.refreshQueuePositions();
      this.pump();
    });
  }

  async health() {
    try {
      return {
        ...(await this.request("health", {}, { timeoutMs: 30000 })),
        python: this.options.python,
        queueLength: this.queue.length + (this.active ? 1 : 0),
        lastError: this.lastError
      };
    } catch (error) {
      return {
        ok: false,
        device: "cpu",
        python: this.options.python,
        iopaintRoot: this.options.iopaintRoot,
        realesrganRoot: this.options.realesrganRoot,
        lamaModelPath: this.options.lamaModelPath,
        realesrganModelPath: this.options.realesrganModelPath,
        iopaintRootFound: fs.existsSync(this.options.iopaintRoot),
        realesrganRootFound: fs.existsSync(this.options.realesrganRoot),
        lamaModelFound: fs.existsSync(this.options.lamaModelPath),
        realesrganModelFound: fs.existsSync(this.options.realesrganModelPath),
        pythonDependenciesFound: false,
        error: error.message || String(error)
      };
    }
  }

  async withTemporaryImages(payload, needsMask, operation) {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "image-to-slice-local-ai-"));
    const sourcePath = path.join(directory, "source.png");
    const maskPath = path.join(directory, "mask.png");
    const outputPath = path.join(directory, "output.png");
    try {
      await fs.promises.writeFile(sourcePath, decodeDataUrl(payload.dataUrl, "源图"));
      if (needsMask) await fs.promises.writeFile(maskPath, decodeDataUrl(payload.maskDataUrl, "修复蒙版"));
      const result = await operation({ sourcePath, maskPath, outputPath });
      const output = await fs.promises.readFile(outputPath);
      return { ...result, dataUrl: `data:image/png;base64,${output.toString("base64")}` };
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  inpaint(payload, options = {}) {
    return this.withTemporaryImages(payload, true, (paths) => this.request("inpaint", {
      ...paths,
      maskExpand: payload.maskExpand,
      maskFeather: payload.maskFeather
    }, options));
  }

  upscale(payload, options = {}) {
    return this.withTemporaryImages(payload, false, (paths) => this.request("upscale", {
      sourcePath: paths.sourcePath,
      outputPath: paths.outputPath,
      scale: payload.scale
    }, options));
  }

  async close() {
    this.closing = true;
    const error = abortError("本地图像 worker 已关闭");
    this.queue.splice(0).forEach((entry) => entry.reject(error));
    if (this.active) this.cancelActive(this.active, error);
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill();
  }
}

function createLocalImageWorkerClient({ projectRoot = path.resolve(__dirname, "../../.."), environment } = {}) {
  return new LocalImageWorkerClient(resolveLocalImageOptions(projectRoot, environment));
}

module.exports = {
  LocalImageWorkerClient,
  createLocalImageWorkerClient,
  decodeDataUrl,
  resolveLocalImageOptions
};
