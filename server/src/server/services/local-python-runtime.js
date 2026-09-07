const fs = require("node:fs");
const path = require("node:path");

function virtualEnvironmentPython(projectRoot, directoryName, platform = process.platform) {
  const environmentRoot = path.resolve(projectRoot, "..", directoryName);
  return platform === "win32"
    ? path.join(environmentRoot, "Scripts", "python.exe")
    : path.join(environmentRoot, "bin", "python");
}

function resolvePythonRuntime({
  projectRoot,
  environment = process.env,
  overrideKey,
  virtualEnvironment,
  platform = process.platform,
  existsSync = fs.existsSync
}) {
  const override = environment[overrideKey];
  if (override) return { python: override, pythonArgs: [] };

  const bundledPython = virtualEnvironmentPython(projectRoot, virtualEnvironment, platform);
  if (existsSync(bundledPython)) return { python: bundledPython, pythonArgs: [] };

  return platform === "win32"
    ? { python: "py", pythonArgs: ["-3.11"] }
    : { python: "python3", pythonArgs: [] };
}

module.exports = { resolvePythonRuntime, virtualEnvironmentPython };
