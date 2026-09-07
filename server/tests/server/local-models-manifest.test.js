const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverRoot = path.resolve(__dirname, "../..");
const manifest = JSON.parse(fs.readFileSync(
  path.join(serverRoot, "scripts", "local-models.manifest.json"),
  "utf8"
));

test("local model manifest pins repositories and verified artifacts", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.python.majorMinor, "3.10");
  assert.ok(manifest.minimumFreeBytes >= 8 * 1024 ** 3);
  for (const repository of Object.values(manifest.repositories)) {
    assert.match(repository.revision, /^[a-f0-9]{40}$/);
    assert.equal(path.isAbsolute(repository.directory), false);
    assert.equal(repository.directory.includes(".."), false);
    assert.match(repository.url, /^https:\/\/github\.com\//);
    if (repository.tag) assert.equal(typeof repository.tag, "string");
  }
  for (const artifact of Object.values(manifest.artifacts)) {
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    assert.ok(artifact.bytes > 1_000_000);
    assert.equal(path.isAbsolute(artifact.path), false);
    assert.equal(artifact.path.includes(".."), false);
    assert.match(artifact.url, /^https:\/\//);
  }
});

test("each Python environment references a checked-in lock file", () => {
  for (const environment of Object.values(manifest.environments)) {
    assert.match(environment.torch, /^\d+\.\d+\.\d+$/);
    assert.match(environment.torchvision, /^\d+\.\d+\.\d+$/);
    assert.ok(fs.existsSync(path.join(serverRoot, environment.lockFile)));
    for (const directory of environment.editablePackages || []) {
      assert.equal(path.isAbsolute(directory), false);
      assert.equal(directory.includes(".."), false);
    }
    for (const [key, value] of Object.entries(environment.variables || {})) {
      assert.match(key, /^[A-Z][A-Z0-9_]+$/);
      assert.equal(typeof value, "string");
    }
  }
});
