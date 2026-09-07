const test = require("node:test");
const assert = require("node:assert/strict");
const { createLocalImageProcessingRoutes } = require("../../src/server/routes/local-image-processing-routes");

function createHarness(payload = {}) {
  const calls = [];
  let sent;
  const client = {
    async health() { return { ok: true, device: "cpu" }; },
    async inpaint(value, options) {
      calls.push(["inpaint", value]);
      options.onQueue(2);
      options.onStart();
      return { dataUrl: "data:image/png;base64,AA==", model: "iopaint-lama" };
    },
    async upscale(value, options) {
      calls.push(["upscale", value]);
      options.onQueue(1);
      options.onStart();
      return { dataUrl: "data:image/png;base64,AA==", scale: value.scale };
    }
  };
  const handler = createLocalImageProcessingRoutes({
    client,
    async readJson(_request, limit) { calls.push(["limit", limit]); return payload; },
    async runWithProgress(value, label, operation) {
      calls.push(["progress", value.progressId, label]);
      return operation(new AbortController().signal);
    },
    updateProgress(id, label) { calls.push(["status", id, label]); },
    sendJson(_response, status, body) { sent = { status, body }; }
  });
  return { calls, handler, get sent() { return sent; } };
}

test("local image health exposes both CPU engines", async () => {
  const harness = createHarness();
  assert.equal(await harness.handler({ method: "GET", url: "/api/local-image-processing/health" }, {}), true);
  assert.deepEqual(harness.sent, { status: 200, body: { ok: true, device: "cpu" } });
});

test("inpaint route reports queue and running stages", async () => {
  const payload = { dataUrl: "data:image/png;base64,AA==", maskDataUrl: "data:image/png;base64,AA==", progressId: "repair_1" };
  const harness = createHarness(payload);
  await harness.handler({ method: "POST", url: "/api/local-image-processing/inpaint" }, {});
  assert.equal(harness.sent.status, 200);
  assert.ok(harness.calls.some((entry) => entry[0] === "status" && /排队中/.test(entry[2])));
  assert.ok(harness.calls.some((entry) => entry[0] === "status" && /LaMa/.test(entry[2])));
});

test("upscale route accepts only 2x and 4x", async () => {
  const invalid = createHarness({ dataUrl: "data:image/png;base64,AA==", scale: 3 });
  await assert.rejects(() => invalid.handler({ method: "POST", url: "/api/local-image-processing/upscale" }, {}), /仅支持/);
  const valid = createHarness({ dataUrl: "data:image/png;base64,AA==", scale: 4, progressId: "up_1" });
  await valid.handler({ method: "POST", url: "/api/local-image-processing/upscale" }, {});
  assert.equal(valid.sent.body.scale, 4);
});
