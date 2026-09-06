const test = require("node:test");
const assert = require("node:assert/strict");
const { createLocalSegmentationRoutes } = require("../../src/server/routes/local-segmentation-routes");

function createHarness(payload = {}) {
  const calls = [];
  let sent = null;
  const client = {
    async health() { calls.push(["health"]); return { ok: true, model: "sam2.1_hiera_tiny" }; },
    async request(action, value, timeout) {
      calls.push([action, value, timeout]);
      return action === "create_session" ? { sessionId: "session-1" } : { ok: true };
    }
  };
  const handler = createLocalSegmentationRoutes({
    client,
    async readJson(_request, limit) { calls.push(["readJson", limit]); return payload; },
    sendJson(_response, status, body) { sent = { status, body }; }
  });
  return { calls, handler, client, get sent() { return sent; } };
}

test("local segmentation health exposes the persistent worker status", async () => {
  const harness = createHarness();
  assert.equal(await harness.handler({ method: "GET", url: "/api/local-segmentation/health" }, {}), true);
  assert.deepEqual(harness.sent, { status: 200, body: { ok: true, model: "sam2.1_hiera_tiny" } });
});

test("session and prediction routes forward JSON payloads", async () => {
  const payload = { sessionId: "session-1", points: [{ x: 2, y: 3, label: "foreground" }] };
  const harness = createHarness(payload);
  await harness.handler({ method: "POST", url: "/api/local-segmentation/predict" }, {});
  assert.deepEqual(harness.calls.at(-1), ["predict", payload, undefined]);
  assert.deepEqual(harness.sent, { status: 200, body: { ok: true } });
});

test("delete session releases the matching worker session", async () => {
  const harness = createHarness();
  await harness.handler({ method: "DELETE", url: "/api/local-segmentation/session/session_1" }, {});
  assert.deepEqual(harness.calls.at(-1), ["close_session", { sessionId: "session_1" }, 10000]);
});
