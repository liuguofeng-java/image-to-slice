const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { decodeDataUrl, resolveLocalImageOptions } = require("../../src/server/services/local-image-worker-client");

test("local image worker defaults to adjacent repositories", () => {
  const root = path.resolve("D:/not-installed/image-to-slice");
  const options = resolveLocalImageOptions(root, { USERPROFILE: "C:/Users/demo" });
  assert.equal(options.iopaintRoot, path.resolve(root, "../IOPaint"));
  assert.equal(options.realesrganRoot, path.resolve(root, "../Real-ESRGAN"));
  assert.ok(options.lamaModelPath.endsWith(path.join(".cache", "torch", "hub", "checkpoints", "big-lama.pt")));
  assert.ok(options.realesrganModelPath.endsWith(path.join("weights", "RealESRGAN_x4plus_anime_6B.pth")));
});

test("local image worker prefers a model stored inside the IOPaint repository", (context) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "image-to-slice-model-test-"));
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, "image-to-slice");
  const model = path.join(parent, "IOPaint", "models", "big-lama.pt");
  fs.mkdirSync(path.dirname(model), { recursive: true });
  fs.writeFileSync(model, "fixture");
  const options = resolveLocalImageOptions(root, { USERPROFILE: "C:/Users/demo" });
  assert.equal(options.lamaModelPath, model);
});

test("local image environment variables override every external path", () => {
  const options = resolveLocalImageOptions("D:/project/image-to-slice", {
    IOPAINT_ROOT: "D:/ai/iopaint",
    REALESRGAN_ROOT: "D:/ai/esrgan",
    LOCAL_IMAGE_PYTHON: "D:/python/python.exe",
    LAMA_MODEL_PATH: "D:/models/lama.pt",
    REALESRGAN_MODEL_PATH: "D:/models/esrgan.pth"
  });
  assert.equal(options.python, "D:/python/python.exe");
  assert.deepEqual(options.pythonArgs, []);
  assert.equal(options.lamaModelPath, path.resolve("D:/models/lama.pt"));
});

test("data URL validation rejects non-image payloads", () => {
  assert.equal(decodeDataUrl("data:image/png;base64,YQ==", "源图").toString(), "a");
  assert.throws(() => decodeDataUrl("https://example.com/a.png", "源图"), /base64/);
});
