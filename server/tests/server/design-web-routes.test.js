const test = require('node:test');
const assert = require('node:assert/strict');
const { createDesignRoutes } = require('../../src/server/routes/design-routes');
test('removed design endpoints do not route or trigger any model work', async () => {
  const fail = () => { throw new Error('must not run'); };
  const route = createDesignRoutes({ readJson: fail, getTaskRequestContext: fail, runWithAiProgress: fail, sendJson: fail });
  for (const url of ['/api/design/capture-figma', '/api/design/export-fig']) assert.equal(await route({ method: 'POST', url }, {}), false);
});
test('HTML generation retains the vision route and response contract', async () => {
  let response, task;
  const route = createDesignRoutes({ readJson: async () => ({ imageDataUrl: 'fixture' }), getTaskRequestContext: t => { task = t; return {}; }, runWithAiProgress: (_p, _m, fn) => fn(), reconstructEditableDesignH5: async () => ({ mode: 'h5-fast-direct', html: '<html></html>' }), sendJson: (_r, status, body) => { response = { status, body }; } });
  assert.equal(await route({ method: 'POST', url: '/api/design/reconstruct-h5' }, {}), true); assert.equal(task, 'vision'); assert.equal(response.status, 200); assert.equal(response.body.mode, 'h5-fast-direct');
});
