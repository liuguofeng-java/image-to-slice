import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { normalizeRect, croppedLayer, point, type Layer, type Candidate } from '../src/domain.js';
import { urlFor, providerRequest } from '../src/provider.js';
import { unzipSync } from 'fflate';

const row: Candidate = {
  id: 'candidate-1',
  name: '图标',
  category: 'icon',
  enabled: true,
  x: 2,
  y: 3,
  width: 7,
  height: 8,
};
async function fixture(t: any, analyzer?: any) {
  const dir = await mkdtemp(join(tmpdir(), 'slice-studio-test-'));
  const ctx = await createApp({ dataDir: dir, analyzer });
  await ctx.app.ready();
  t.after(async () => {
    await ctx.app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const bytes = await sharp({
    create: { width: 40, height: 30, channels: 4, background: '#fa294a' },
  })
    .png()
    .toBuffer();
  const asset = await ctx.storage.import(bytes, 'fixture.png'),
    project = await ctx.storage.create('测试项目');
  const layer: Layer = {
    id: 'source',
    assetId: asset.id,
    name: '来源图',
    x: -12.5,
    y: 31.2,
    width: 80,
    height: 60,
    rotation: 32,
    flipX: true,
    flipY: false,
    opacity: 1,
    radius: 0,
    locked: false,
    hidden: false,
  };
  project.scenes[0].layers = [layer];
  const saved = await ctx.storage.save(project.id, 0, project);
  return { ...ctx, dir, asset, layer, project: saved };
}
test('geometry: outward rounding and transform-preserving crops', () => {
  assert.deepEqual(normalizeRect({ x: -0.4, y: 2.2, width: 8, height: 4.2 }, 20, 20), {
    x: 0,
    y: 2,
    width: 8,
    height: 5,
  });
  assert.throws(() => normalizeRect({ x: 50, y: 0, width: 1, height: 1 }, 20, 20));
  const l = {
      x: 20,
      y: -10,
      width: 160,
      height: 80,
      rotation: 37,
      flipX: true,
      flipY: true,
    } as Layer,
    a = { id: 'asset', name: '', width: 80, height: 40 };
  const crop = croppedLayer(l, a, row, { id: 'out', name: '', width: 7, height: 8 });
  for (const [x, y] of [
    [0, 0],
    [7, 8],
    [3, 4],
  ]) {
    const before = point(l, x + row.x, y + row.y, a),
      after = point(crop, x, y, { id: 'out', name: '', width: 7, height: 8 });
    assert.ok(Math.abs(before.x - after.x) < 1e-8);
    assert.ok(Math.abs(before.y - after.y) < 1e-8);
  }
});
test('project save checks revision, rejects invalid assets, and rolls back failed writes', async (t) => {
  const { app, storage, project } = await fixture(t);
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/v1/projects/' + project.id,
    payload: { revision: project.revision, document: project },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().revision, 2);
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: '/api/v1/projects/' + project.id,
        payload: { revision: 1, document: project },
      })
    ).statusCode,
    409,
  );
  const before = await storage.project(project.id);
  const atomic = storage.atomic.bind(storage);
  storage.atomic = async () => {
    throw new Error('simulated disk failure');
  };
  const failed = await app.inject({
    method: 'PUT',
    url: '/api/v1/projects/' + project.id,
    payload: { revision: 2, document: { ...before, name: '不能落盘' } },
  });
  assert.equal(failed.statusCode, 500);
  storage.atomic = atomic;
  assert.deepEqual(await storage.project(project.id), before);
});
test('upload validates real bytes, EXIF and content limits', async (t) => {
  const { storage } = await fixture(t);
  await assert.rejects(storage.import(Buffer.from('<svg></svg>'), 'fake.png'));
  const jpeg = await sharp({
    create: { width: 40, height: 20, channels: 3, background: '#ffffff' },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const a = await storage.import(jpeg, 'rotated.jpg');
  assert.equal(a.width, 20);
  assert.equal(a.height, 40);
  await assert.rejects(storage.import(Buffer.alloc(30 * 1024 * 1024 + 1), 'large.png'));
});
test('manual split is atomic and idempotent; original pixels and source transform retained', async (t) => {
  const { app, storage, project, asset, layer } = await fixture(t);
  const started = await app.inject({
    method: 'POST',
    url: '/api/v1/split-jobs',
    payload: {
      projectId: project.id,
      sceneId: project.activeSceneId,
      layerId: layer.id,
      region: { x: 0, y: 0, width: 40, height: 30 },
      manual: true,
    },
  });
  assert.equal(started.statusCode, 202, started.body);
  const id = started.json().id,
    body = { revision: project.revision, operationId: 'apply-1', candidates: [row] };
  const atomic = storage.atomic.bind(storage);
  storage.atomic = async (path, v) => {
    if (path.includes('projects')) throw new Error('disk fail');
    await atomic(path, v);
  };
  assert.equal(
    (await app.inject({ method: 'POST', url: `/api/v1/split-jobs/${id}/apply`, payload: body }))
      .statusCode,
    500,
  );
  storage.atomic = atomic;
  assert.equal((await storage.project(project.id)).scenes[0].layers.length, 1);
  const result = await app.inject({
    method: 'POST',
    url: `/api/v1/split-jobs/${id}/apply`,
    payload: body,
  });
  assert.equal(result.statusCode, 200, result.body);
  const p = result.json();
  assert.equal(p.scenes[0].layers.length, 2);
  assert.deepEqual(p.scenes[0].layers[0], layer);
  const cropped = p.scenes[0].layers[1];
  assert.equal(cropped.width, 14);
  assert.equal(cropped.height, 16);
  const expected = await sharp(storage.imagePath(asset.id))
      .extract({ left: 2, top: 3, width: 7, height: 8 })
      .raw()
      .toBuffer(),
    actual = await sharp(storage.imagePath(cropped.assetId)).raw().toBuffer();
  assert.deepEqual(actual, expected);
  const retry = await app.inject({
    method: 'POST',
    url: `/api/v1/split-jobs/${id}/apply`,
    payload: body,
  });
  assert.deepEqual(retry.json(), p);
  const mismatch = await app.inject({
    method: 'POST',
    url: `/api/v1/split-jobs/${id}/apply`,
    payload: { ...body, candidates: [{ ...row, name: 'changed' }] },
  });
  assert.equal(mismatch.statusCode, 409);
});
test('cancel ignores late model response, source edits block application', async (t) => {
  let resolve!: (v: Candidate[]) => void;
  const { app, storage, project } = await fixture(
    t,
    () =>
      new Promise<Candidate[]>((r) => {
        resolve = r;
      }),
  );
  await storage.saveModel({
    baseUrl: 'http://localhost:8080',
    model: 'fake-vision',
    apiKey: 'private-secret',
    timeoutSeconds: 120,
  });
  const payload = {
    projectId: project.id,
    sceneId: project.activeSceneId,
    layerId: 'source',
    region: { x: 0, y: 0, width: 40, height: 30 },
    manual: false,
  };
  const start = await app.inject({ method: 'POST', url: '/api/v1/split-jobs', payload }),
    id = start.json().id;
  await app.inject({ method: 'DELETE', url: '/api/v1/split-jobs/' + id });
  resolve([row]);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await app.inject('/api/v1/split-jobs/' + id)).json().status, 'cancelled');
  const manual = await app.inject({
    method: 'POST',
    url: '/api/v1/split-jobs',
    payload: { ...payload, manual: true },
  });
  project.scenes[0].layers[0].x++;
  const changed = await storage.save(project.id, project.revision, project);
  const apply = await app.inject({
    method: 'POST',
    url: `/api/v1/split-jobs/${manual.json().id}/apply`,
    payload: { revision: changed.revision, operationId: 'apply', candidates: [row] },
  });
  assert.equal(apply.statusCode, 409);
  assert.match(apply.body, /来源图片已改变/);
  assert.equal((await app.inject('/api/v1/model-configs')).body.includes('private-secret'), false);
});
test('exports PNG at native resolution, ZIP and scene respect canvas bounds', async (t) => {
  const { app, storage, project } = await fixture(t);
  project.scenes[0].layers[0].rotation = 0;
  await storage.save(project.id, project.revision, project);
  const payload = { projectId: project.id, sceneId: project.activeSceneId, layerIds: ['source'] };
  const png = await app.inject({
    method: 'POST',
    url: '/api/v1/exports',
    payload: { ...payload, kind: 'png' },
  });
  assert.equal(png.statusCode, 200, png.body.slice(0, 100));
  const meta = await sharp(png.rawPayload).metadata();
  assert.equal(meta.width, 40);
  assert.equal(meta.height, 30);
  const zip = await app.inject({
    method: 'POST',
    url: '/api/v1/exports',
    payload: { ...payload, kind: 'zip' },
  });
  assert.equal(Object.keys(unzipSync(zip.rawPayload)).length, 1);
  const scene = await app.inject({
    method: 'POST',
    url: '/api/v1/exports',
    payload: { ...payload, kind: 'scene' },
  });
  assert.equal(scene.statusCode, 200);
  assert.equal((await sharp(scene.rawPayload).metadata()).width, 1440);
});
test('OpenAPI request contract and origin/host protections', async (t) => {
  const { app } = await fixture(t);
  const spec = (await app.inject('/openapi.json')).json();
  for (const path of [
    '/api/v1/projects',
    '/api/v1/assets',
    '/api/v1/split-jobs',
    '/api/v1/exports',
  ])
    assert.ok(spec.paths[path]);
  assert.ok(spec.paths['/api/v1/split-jobs'].post.requestBody);
  assert.equal(
    (await app.inject({ url: '/api/v1/projects', headers: { origin: 'https://evil.test' } }))
      .statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ url: '/health', headers: { host: 'evil.test' } })).statusCode,
    403,
  );
  assert.equal((await app.inject('/api/design/export-fig')).statusCode, 404);
});
test('provider URL, cancellation and secret redaction use controlled responses', async () => {
  assert.equal(urlFor('http://localhost:8080/v1/', 'models'), 'http://localhost:8080/v1/models');
  const cfg = {
    baseUrl: 'http://localhost:8080',
    model: 'mock',
    apiKey: 'secret-123',
    timeoutSeconds: 10,
  };
  await assert.rejects(
    providerRequest(
      cfg,
      'models',
      undefined,
      undefined,
      async () =>
        new Response(JSON.stringify({ error: { message: 'bad secret-123' } }), { status: 401 }),
    ),
    (e) => e instanceof Error && !e.message.includes('secret-123'),
  );
});
