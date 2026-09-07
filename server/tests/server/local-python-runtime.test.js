const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  resolvePythonRuntime,
  virtualEnvironmentPython
} = require("../../src/server/services/local-python-runtime");

test("environment override has priority over a bundled virtual environment", () => {
  const runtime = resolvePythonRuntime({
    projectRoot: "D:/project/image-to-slice/server",
    environment: { SAM2_PYTHON: "D:/custom/python.exe" },
    overrideKey: "SAM2_PYTHON",
    virtualEnvironment: ".venv-sam2",
    platform: "win32",
    existsSync: () => true
  });
  assert.deepEqual(runtime, { python: "D:/custom/python.exe", pythonArgs: [] });
});

test("Windows uses the adjacent virtual environment when it exists", () => {
  const projectRoot = path.resolve("D:/project/image-to-slice/server");
  const expected = path.resolve(projectRoot, "../.venv-sam2/Scripts/python.exe");
  const runtime = resolvePythonRuntime({
    projectRoot,
    environment: {},
    overrideKey: "SAM2_PYTHON",
    virtualEnvironment: ".venv-sam2",
    platform: "win32",
    existsSync: value => value === expected
  });
  assert.deepEqual(runtime, { python: expected, pythonArgs: [] });
});

test("Unix uses the adjacent virtual environment bin directory", () => {
  const projectRoot = "/workspace/image-to-slice/server";
  const expected = path.resolve(projectRoot, "../.venv-local-image/bin/python");
  assert.equal(virtualEnvironmentPython(projectRoot, ".venv-local-image", "linux"), expected);
  const runtime = resolvePythonRuntime({
    projectRoot,
    environment: {},
    overrideKey: "LOCAL_IMAGE_PYTHON",
    virtualEnvironment: ".venv-local-image",
    platform: "linux",
    existsSync: value => value === expected
  });
  assert.deepEqual(runtime, { python: expected, pythonArgs: [] });
});

test("system launcher remains the final fallback", () => {
  const windows = resolvePythonRuntime({
    projectRoot: "D:/missing/server",
    environment: {},
    overrideKey: "SAM2_PYTHON",
    virtualEnvironment: ".venv-sam2",
    platform: "win32",
    existsSync: () => false
  });
  const unix = resolvePythonRuntime({
    projectRoot: "/missing/server",
    environment: {},
    overrideKey: "LOCAL_IMAGE_PYTHON",
    virtualEnvironment: ".venv-local-image",
    platform: "linux",
    existsSync: () => false
  });
  assert.deepEqual(windows, { python: "py", pythonArgs: ["-3.11"] });
  assert.deepEqual(unix, { python: "python3", pythonArgs: [] });
});
