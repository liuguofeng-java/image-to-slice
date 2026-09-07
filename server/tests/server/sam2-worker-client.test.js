const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveSam2Options } = require("../../src/server/services/sam2-worker-client");

test("SAM 2 defaults to the adjacent repository and Python 3.11 launcher on Windows", () => {
  const projectRoot = path.resolve("D:/workspace/image-to-slice");
  const options = resolveSam2Options(projectRoot, {});
  assert.equal(options.sam2Root, path.resolve(projectRoot, "../sam2-main"));
  assert.ok(options.workerPath.endsWith(path.join("scripts", "sam2-worker.py")));
  if (process.platform === "win32") {
    assert.equal(options.python, "py");
    assert.deepEqual(options.pythonArgs, ["-3.11"]);
  }
});

test("SAM2_ROOT and SAM2_PYTHON override local defaults", () => {
  const options = resolveSam2Options("D:/project/image-to-slice", {
    SAM2_ROOT: "D:/models/custom-sam2",
    SAM2_PYTHON: "D:/python/python.exe"
  });
  assert.equal(options.sam2Root, path.resolve("D:/models/custom-sam2"));
  assert.equal(options.python, "D:/python/python.exe");
  assert.deepEqual(options.pythonArgs, []);
});

test("SAM 2 automatically uses the adjacent virtual environment", (context) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "image-to-slice-sam2-python-"));
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const projectRoot = path.join(parent, "server");
  const python = process.platform === "win32"
    ? path.join(parent, ".venv-sam2", "Scripts", "python.exe")
    : path.join(parent, ".venv-sam2", "bin", "python");
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, "fixture");
  const options = resolveSam2Options(projectRoot, {});
  assert.equal(options.python, python);
  assert.deepEqual(options.pythonArgs, []);
});
