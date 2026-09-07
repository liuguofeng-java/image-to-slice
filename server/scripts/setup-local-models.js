const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const serverRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(serverRoot, "..");
const manifestPath = path.join(__dirname, "local-models.manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || serverRoot,
      env: options.env || process.env,
      stdio: options.stdio || "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolve();
      const reason = signal ? `信号 ${signal}` : `退出码 ${code}`;
      reject(new Error(`${command} 执行失败（${reason}）`));
    });
  });
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || serverRoot,
    env: options.env || process.env,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `${command} 执行失败`).trim());
  }
  return String(result.stdout || "").trim();
}

function normalizeRemote(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\.git\/?$/i, "")
    .replace(/^git@github\.com:/i, "https://github.com/")
    .toLowerCase();
}

function deploymentArtifactPaths(repository) {
  const prefix = `${repository.directory.replace(/\\/g, "/")}/`;
  return Object.values(manifest.artifacts).flatMap((artifact) => {
    const artifactPath = artifact.path.replace(/\\/g, "/");
    if (!artifactPath.startsWith(prefix)) return [];
    const relative = artifactPath.slice(prefix.length);
    return [relative, `${relative}.part`];
  });
}

function configuredSubmodule(directory) {
  const gitmodules = path.join(projectRoot, ".gitmodules");
  if (!fs.existsSync(gitmodules) || !fs.existsSync(path.join(projectRoot, ".git"))) return false;
  const result = spawnSync("git", ["config", "--file", gitmodules, "--get-regexp", "^submodule\\..*\\.path$"], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) return false;
  return String(result.stdout || "")
    .split(/\r?\n/)
    .some(line => line.trim().split(/\s+/).slice(1).join(" ") === directory);
}

function resolveBootstrapPython() {
  const override = String(process.env.LOCAL_MODELS_BOOTSTRAP_PYTHON || "").trim();
  const runtime = override
    ? { command: override, args: [] }
    : process.platform === "win32"
      ? { command: "py", args: ["-3.10"] }
      : { command: "python3.10", args: [] };
  const version = capture(runtime.command, [...runtime.args, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"]);
  if (!version.startsWith(`${manifest.python.majorMinor}.`)) {
    throw new Error(`本地模型需要 Python ${manifest.python.majorMinor}，当前检测到 ${version}`);
  }
  console.log(`Python：${version}`);
  return runtime;
}

function ensureDiskSpace() {
  if (typeof fs.statfsSync !== "function") return;
  const stats = fs.statfsSync(projectRoot);
  const available = Number(stats.bavail) * Number(stats.bsize);
  const required = Number(manifest.minimumFreeBytes);
  if (available < required) {
    throw new Error(`磁盘空间不足：至少需要 ${Math.ceil(required / 1024 ** 3)} GB 可用空间`);
  }
  console.log(`可用磁盘空间：${(available / 1024 ** 3).toFixed(1)} GB`);
}

async function ensureRepository(name, repository) {
  const target = path.join(projectRoot, repository.directory);
  const gitDirectory = path.join(target, ".git");
  if ((!fs.existsSync(target) || !fs.existsSync(gitDirectory)) && configuredSubmodule(repository.directory)) {
    console.log(`\n[${name}] 初始化 Git submodule`);
    await run("git", ["submodule", "update", "--init", "--depth", "1", "--", repository.directory], {
      cwd: projectRoot
    });
  }
  if (!fs.existsSync(target)) {
    console.log(`\n[${name}] 克隆 ${repository.url}`);
    await run("git", ["clone", "--filter=blob:none", "--no-checkout", repository.url, target], { cwd: projectRoot });
    if (repository.sparsePaths?.length) {
      await run("git", ["sparse-checkout", "init", "--cone"], { cwd: target });
      await run("git", ["sparse-checkout", "set", ...repository.sparsePaths], { cwd: target });
    }
  } else if (!fs.existsSync(gitDirectory)) {
    throw new Error(`${target} 已存在但不是 Git 仓库；为避免覆盖，请手工移走该目录后重试`);
  }

  const remote = capture("git", ["remote", "get-url", "origin"], { cwd: target });
  if (normalizeRemote(remote) !== normalizeRemote(repository.url)) {
    throw new Error(`${target} 的 origin 不是 ${repository.url}；为避免覆盖，部署已停止`);
  }
  const allowedArtifacts = new Set(deploymentArtifactPaths(repository));
  const changes = capture("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: target })
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(line => !line.startsWith("?? ") || !allowedArtifacts.has(line.slice(3).replace(/\\/g, "/")));
  if (changes.length) throw new Error(`${target} 包含本地修改；请先处理这些文件再重试：\n${changes.join("\n")}`);

  const current = capture("git", ["rev-parse", "HEAD"], { cwd: target });
  if (current !== repository.revision) {
    console.log(`[${name}] 切换到固定提交 ${repository.revision.slice(0, 12)}`);
    await run("git", ["fetch", "--depth", "1", "origin", repository.revision], { cwd: target });
    await run("git", ["checkout", "--detach", repository.revision], { cwd: target });
  } else {
    console.log(`[${name}] 源码版本已就绪`);
  }
}

function fileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function validateArtifact(filePath, artifact) {
  if (!fs.existsSync(filePath)) return false;
  const stats = fs.statSync(filePath);
  if (stats.size !== artifact.bytes) return false;
  return (await fileSha256(filePath)) === artifact.sha256;
}

async function ensureArtifact(name, artifact) {
  const target = path.join(projectRoot, artifact.path);
  const partial = `${target}.part`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (await validateArtifact(target, artifact)) {
    console.log(`[${name}] 权重已通过 SHA-256 校验`);
    return;
  }
  if (fs.existsSync(target)) {
    throw new Error(`${target} 已存在但校验失败；为避免覆盖，请手工移走该文件后重试`);
  }
  if (await validateArtifact(partial, artifact)) {
    fs.renameSync(partial, target);
    console.log(`[${name}] 已完成的断点文件校验通过`);
    return;
  }
  if (fs.existsSync(partial)) {
    const partialSize = fs.statSync(partial).size;
    if (partialSize === artifact.bytes) {
      throw new Error(`${partial} 文件大小正确但 SHA-256 不匹配；请移走该文件后重试`);
    }
    if (partialSize > artifact.bytes) fs.unlinkSync(partial);
  }

  console.log(`[${name}] 下载权重（支持断点续传）`);
  await run("curl", [
    "--location",
    "--fail",
    "--retry", "3",
    "--retry-all-errors",
    "--connect-timeout", "30",
    "--speed-limit", "1024",
    "--speed-time", "60",
    "--continue-at", "-",
    "--output", partial,
    artifact.url
  ], { cwd: projectRoot });
  if (!(await validateArtifact(partial, artifact))) {
    throw new Error(`${partial} 下载完成但 SHA-256 或文件大小不匹配`);
  }
  fs.renameSync(partial, target);
  console.log(`[${name}] 权重校验通过`);
}

function environmentPython(directory) {
  const root = path.join(projectRoot, directory);
  return process.platform === "win32"
    ? path.join(root, "Scripts", "python.exe")
    : path.join(root, "bin", "python");
}

async function ensureVirtualEnvironment(name, environment, bootstrap) {
  const root = path.join(projectRoot, environment.directory);
  const python = environmentPython(environment.directory);
  if (!fs.existsSync(python)) {
    if (fs.existsSync(root)) {
      throw new Error(`${root} 已存在但不是完整的虚拟环境；为避免覆盖，请手工移走后重试`);
    }
    console.log(`\n[${name}] 创建 ${manifest.python.majorMinor} 虚拟环境`);
    await run(bootstrap.command, [...bootstrap.args, "-m", "venv", root], { cwd: projectRoot });
  } else {
    console.log(`\n[${name}] 虚拟环境已存在`);
  }

  const runtimeEnvironment = { ...process.env, ...(environment.variables || {}) };
  const pipNetworkOptions = ["--disable-pip-version-check", "--timeout", "120", "--retries", "10", "--progress-bar", "off"];
  await run(
    python,
    ["-m", "pip", "install", ...pipNetworkOptions, "--upgrade",
      `pip==${manifest.python.pip}`, `setuptools==${manifest.python.setuptools}`, `wheel==${manifest.python.wheel}`],
    { env: runtimeEnvironment }
  );
  const torchIndex = process.platform === "linux"
    ? manifest.python.linuxTorchIndex
    : manifest.python.torchIndex;
  await run(python, ["-m", "pip", "install", ...pipNetworkOptions,
    "--index-url", torchIndex,
    `torch==${environment.torch}`, `torchvision==${environment.torchvision}`], { env: runtimeEnvironment });
  await run(python, ["-m", "pip", "install", ...pipNetworkOptions, "--requirement",
    path.join(serverRoot, environment.lockFile)], { env: runtimeEnvironment });
  for (const directory of environment.editablePackages || []) {
    const packageRoot = path.join(projectRoot, directory);
    await run(python, ["-m", "pip", "install", ...pipNetworkOptions,
      "--no-deps", "--editable", packageRoot], { env: runtimeEnvironment });
  }
  await run(python, ["-m", "pip", "check"], { env: runtimeEnvironment });
  console.log(`[${name}] Python 依赖已就绪`);
}

async function main() {
  console.log("Image To Slice - 本地模型部署");
  console.log(`安装目录：${projectRoot}`);
  capture("git", ["--version"]);
  capture("curl", ["--version"]);
  const bootstrap = resolveBootstrapPython();
  ensureDiskSpace();

  for (const [name, repository] of Object.entries(manifest.repositories)) {
    await ensureRepository(name, repository);
  }
  for (const [name, artifact] of Object.entries(manifest.artifacts)) {
    await ensureArtifact(name, artifact);
  }
  for (const [name, environment] of Object.entries(manifest.environments)) {
    await ensureVirtualEnvironment(name, environment, bootstrap);
  }

  if (!process.argv.includes("--skip-checks")) {
    console.log("\n运行三项真实推理检查（CPU 首次加载可能需要几分钟）...");
    await run(process.execPath, [path.join(__dirname, "check-local-models.js")], { cwd: serverRoot });
  }
  console.log("\n本地模型部署完成。");
}

main().catch(error => {
  console.error(`\n本地模型部署失败：${error.message || String(error)}`);
  process.exitCode = 1;
});
