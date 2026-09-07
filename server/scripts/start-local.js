const { spawn } = require("node:child_process");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const services = [
  {
    name: "本地 API",
    command: process.execPath,
    args: [path.join(projectRoot, "server.js")]
  },
  {
    name: "浏览器预览",
    command: process.execPath,
    args: [
      path.join(projectRoot, "node_modules", "vite", "bin", "vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      "4173",
      "--strictPort"
    ]
  }
];

const children = [];
let shuttingDown = false;

function stopServices(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exitCode = exitCode;
}

for (const service of services) {
  const child = spawn(service.command, service.args, {
    cwd: projectRoot,
    stdio: "inherit"
  });
  children.push(child);
  child.once("error", (error) => {
    console.error(`${service.name}启动失败：${error.message}`);
    stopServices(1);
  });
  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    const reason = signal ? `信号 ${signal}` : `退出码 ${code}`;
    console.error(`${service.name}已停止（${reason}）。`);
    stopServices(code || 1);
  });
}

console.log("本地 API：http://127.0.0.1:18787");
console.log("浏览器预览：http://127.0.0.1:4173/figma-sim.html");
console.log("按 Ctrl+C 停止全部服务。");

process.once("SIGINT", () => stopServices(0));
process.once("SIGTERM", () => stopServices(0));
