const { spawn } = require("node:child_process");
const path = require("node:path");

const serverRoot = path.resolve(__dirname, "..");

function run(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, script)], {
      cwd: serverRoot,
      env: process.env,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", code => code === 0
      ? resolve()
      : reject(new Error(`${script} 检查失败（退出码 ${code}）`)));
  });
}

async function main() {
  await run("check-sam2.js");
  await run("check-local-ai.js");
  console.log("智能抠图、局部修复和高清化检查全部通过。");
}

main().catch(error => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
