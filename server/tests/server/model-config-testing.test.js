const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { testModelConfig } = require('../../src/server/services/model-config-tester');
const { createModelConfigRoutes } = require('../../src/server/routes/model-config-routes');
const { validateModelConfigInput, summarizeModelConfig } = require('../../src/server/config/model-config');

test('model testing returns failures and continues other tasks', async () => {
  const report = await testModelConfig({ id: 'mock', tasks: ['vision', 'generation', 'inpaint'] }, {
    vision: async () => { throw new Error('No available compatible accounts'); },
    generation: async () => ({}), inpaint: async () => ({ maskMode: 'native-mask' })
  });
  assert.equal(report.results.vision.status, 'failed');
  assert.match(report.results.vision.error, /compatible accounts/);
  assert.equal(report.results.generation.status, 'success');
  assert.equal(report.results.inpaint.nativeMaskSupported, true);
});

test('cancelled tests never start later tasks even if the current runner ignores cancellation', async () => {
  for (const mode of ['before', 'during', 'reject']) {
    const controller = new AbortController(), calls = [];
    if (mode === 'before') controller.abort();
    await assert.rejects(testModelConfig({ id: 'mock', tasks: ['vision', 'generation'] }, {
      signal: controller.signal,
      vision: async () => { calls.push('vision'); controller.abort(); if (mode === 'reject') throw controller.signal.reason; },
      generation: async () => { calls.push('generation'); }
    }), { name: 'AbortError' });
    assert.deepEqual(calls, mode === 'before' ? [] : ['vision']);
  }
});

function fixture(runner, payload = {}) {
  const config = validateModelConfigInput({ id: 'mock', name: '', model: 'mock', baseUrl: 'https://example.test', apiKey: 'fake-test-key', tasks: ['vision'], timeoutMs: 90000 });
  const state = { version: 2, modelConfigs: [config], taskRouting: { vision: 'mock' } };
  const request = new EventEmitter(), response = new EventEmitter();
  request.method = 'POST'; response.writableEnded = false;
  const handle = createModelConfigRoutes({
    headers: {}, readJson: async () => payload, getState: () => state,
    mutateState: () => { throw new Error('tests must not persist results'); },
    validateModelConfigInput, summarizeModelConfig, testModelConfig: runner,
    sendJson: (res, status, body) => { res.status = status; res.body = body; res.writableEnded = true; }
  });
  return { request, response, handle, state };
}

for (const endpoint of ['/api/model-configs/mock/test', '/api/model-configs/preview/test']) {
  for (const event of ['aborted', 'close']) test(`${endpoint} propagates ${event} and cleans listeners`, async () => {
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    const f = fixture(async (_config, { signal }) => {
      ready(signal);
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }, { configId: 'mock' });
    f.request.url = endpoint;
    const pending = f.handle(f.request, f.response), signal = await started;
    (event === 'close' ? f.response : f.request).emit(event);
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(signal.aborted, true);
    assert.equal(f.request.listenerCount('aborted'), 0);
    assert.equal(f.response.listenerCount('close'), 0);
    assert.equal(f.response.body, undefined);
  });
}

test('preview reuses saved key via configId and returns transient results without revealing credentials', async () => {
  const f = fixture(async (config, { signal }) => {
    assert.equal(config.apiKey, 'fake-test-key'); assert.equal(signal.aborted, false);
    return { results: { vision: { status: 'failed', error: 'mock failure' } } };
  }, { configId: 'mock', model: 'mock-edited' });
  f.request.url = '/api/model-configs/preview/test';
  await f.handle(f.request, f.response);
  assert.equal(f.response.status, 200);
  assert.equal(f.response.body.config.testResults.vision.error, 'mock failure');
  assert.equal(f.response.body.config.model, 'mock-edited');
  assert.equal(f.response.body.config.apiKey, undefined);
  assert.deepEqual(f.state.modelConfigs[0].testResults, {});
  f.request.method = 'GET'; f.request.url = '/api/model-configs';
  await f.handle(f.request, f.response);
  assert.deepEqual(f.response.body.modelConfigs[0].testResults, {});
});
