const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

function serviceError(message, statusCode = 503) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function resolveSam2Options(projectRoot, environment = process.env) {
  const sam2Root = path.resolve(environment.SAM2_ROOT || path.join(projectRoot, "..", "sam2-main"));
  const python = environment.SAM2_PYTHON || (process.platform === "win32" ? "py" : "python3");
  const pythonArgs = environment.SAM2_PYTHON
    ? []
    : (process.platform === "win32" ? ["-3.11"] : []);
  return {
    sam2Root,
    python,
    pythonArgs,
    workerPath: path.join(projectRoot, "scripts", "sam2-worker.py")
  };
}

class Sam2WorkerClient {
  constructor(options) {
    this.options = options;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.closing = false;
    this.restartAttempts = 0;
    this.lastError = "";
  }

  validatePaths() {
    const { sam2Root, workerPath } = this.options;
    const checkpoint = path.join(sam2Root, "checkpoints", "sam2.1_hiera_tiny.pt");
    if (!fs.existsSync(sam2Root)) throw serviceError(`SAM 2 目录不存在：${sam2Root}`);
    if (!fs.existsSync(checkpoint)) throw serviceError(`SAM 2 tiny 权重不存在：${checkpoint}`);
    if (!fs.existsSync(workerPath)) throw serviceError(`SAM 2 worker 不存在：${workerPath}`);
  }

  start() {
    if (this.child && !this.child.killed) return;
    this.validatePaths();
    const { python, pythonArgs, workerPath, sam2Root } = this.options;
    const child = spawn(python, [...pythonArgs, "-u", workerPath, "--sam2-root", sam2Root], {
      cwd: sam2Root,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.child = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message && !/FutureWarning|UserWarning/.test(message)) console.warn(`[SAM 2] ${message}`);
    });
    child.once("error", (error) => {
      this.lastError = error.message || String(error);
      this.handleExit(child, null, "启动失败");
    });
    child.once("exit", (code, signal) => this.handleExit(child, code, signal));
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.lastError = "SAM 2 worker 返回了无效响应";
      return;
    }
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    this.pending.delete(String(message.id));
    clearTimeout(pending.timer);
    if (message.ok) {
      this.restartAttempts = 0;
      pending.resolve(message.result);
    } else {
      pending.reject(serviceError(message.error || "SAM 2 推理失败", 422));
    }
  }

  handleExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    const reason = signal ? `信号 ${signal}` : `退出码 ${code}`;
    const error = serviceError(`SAM 2 worker 已退出（${reason}），当前会话已失效`);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.closing && this.restartAttempts < 1) {
      this.restartAttempts += 1;
      try { this.start(); } catch (restartError) { this.lastError = restartError.message || String(restartError); }
    }
  }

  request(action, payload = {}, timeoutMs = 60000) {
    if (this.closing) return Promise.reject(serviceError("SAM 2 worker 正在关闭"));
    try { this.start(); } catch (error) { return Promise.reject(error); }
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(serviceError("SAM 2 推理超时，请减少提示点后重试", 504));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, action, payload })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(serviceError(`无法发送 SAM 2 请求：${error.message}`));
      });
    });
  }

  async health() {
    try {
      return { ...(await this.request("health", {}, 10000)), lastError: this.lastError };
    } catch (error) {
      return {
        ok: false,
        sam2Root: this.options.sam2Root,
        python: this.options.python,
        model: "sam2.1_hiera_tiny",
        device: "cpu",
        modelLoaded: false,
        checkpointFound: fs.existsSync(path.join(this.options.sam2Root, "checkpoints", "sam2.1_hiera_tiny.pt")),
        error: error.message || String(error)
      };
    }
  }

  async close() {
    this.closing = true;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill();
  }
}

function createSam2WorkerClient({ projectRoot = path.resolve(__dirname, "../../.."), environment } = {}) {
  return new Sam2WorkerClient(resolveSam2Options(projectRoot, environment));
}

module.exports = { Sam2WorkerClient, createSam2WorkerClient, resolveSam2Options };
