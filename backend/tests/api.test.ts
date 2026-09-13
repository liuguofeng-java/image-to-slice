import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import {
  normalizeRect,
  croppedLayer,
  point,
  type ImageLayer,
  type TextLayer,
  type Candidate,
} from '../src/domain.js';
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
async function fixture(t: any, analyzer?: any, imageEditor?: any) {
  const dir = await mkdtemp(join(tmpdir(), 'slice-studio-test-'));
  const ctx = await createApp({ dataDir: dir, analyzer, imageEditor });
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
  const layer: ImageLayer = {
    id: 'source',
    type: 'image',
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
async function waitForJob(app: any, id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = (await app.inject('/api/v1/split-jobs/' + id)).json();
    if (job.status !== 'generating') return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('generation did not finish');
}
async function waitForLayerJob(app: any, id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = (await app.inject('/api/v1/layer-regeneration-jobs/' + id)).json();
    if (job.status !== 'generating') return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('layer regeneration did not finish');
}
test('legacy model configuration exposes max image quality by default', async (t) => {
  const { app, dir } = await fixture(t);
  await writeFile(
    join(dir, 'private', 'model.json'),
    JSON.stringify({
      baseUrl: 'http://localhost:8080',
      model: 'legacy-vision',
      imageModel: 'legacy-image',
      timeoutSeconds: 120,
      apiKey: 'private-secret',
    }),
  );
  const response = await app.inject('/api/v1/model-configs');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().config.imageQuality, 'max');
  assert.equal(response.json().config.hasApiKey, true);
  assert.equal(response.body.includes('private-secret'), false);
});
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
    } as ImageLayer,
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
test('local layer regeneration recrops a resized split layer without calling AI', async (t) => {
  const { app, storage, project, asset, layer } = await fixture(t),
    candidate = {
      id: 'gift',
      name: '礼物',
      category: 'image' as const,
      enabled: true,
      x: 5,
      y: 6,
      width: 10,
      height: 8,
    },
    childAsset = await storage.crop(asset.id, candidate, '礼物.png'),
    child = croppedLayer(layer, asset, candidate, childAsset);
  child.x -= child.width * 0.25;
  child.y -= child.height * 0.5;
  child.x += 10;
  child.y += 6;
  child.width *= 1.5;
  child.height *= 2;
  project.scenes[0].layers.push(child);
  const saved = await storage.save(project.id, project.revision, project),
    response = await app.inject({
      method: 'POST',
      url: '/api/v1/layer-local-regeneration',
      payload: {
        projectId: saved.id,
        sceneId: saved.activeSceneId,
        layerId: child.id,
        revision: saved.revision,
        operationId: 'local-regenerate-once',
      },
    });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json(),
    resultLayer = result.scenes[0].layers.find((item: ImageLayer) => item.id === child.id),
    resultAsset = await storage.asset(resultLayer.assetId);
  assert.notEqual(resultLayer.assetId, childAsset.id);
  assert.ok(resultAsset.width > 0 && resultAsset.height > 0);
  assert.deepEqual(
    { width: resultLayer.source.rect.width, height: resultLayer.source.rect.height },
    { width: resultAsset.width, height: resultAsset.height },
  );
  assert.notDeepEqual(resultLayer.source.rect, child.source?.rect);
  assert.equal(resultLayer.x, child.x);
  assert.equal(resultLayer.width, child.width);
  assert.equal(result.revision, saved.revision + 1);
});
test('local layer regeneration uses the visible full-source layer when the original moved', async (t) => {
  const { app, storage, project, asset } = await fixture(t),
    source = project.scenes[0].layers[0] as ImageLayer;
  Object.assign(source, {
    x: 0,
    y: 0,
    width: asset.width,
    height: asset.height,
    rotation: 0,
    flipX: false,
    flipY: false,
  });
  const fullCandidate = {
      id: 'full',
      name: '完整画面',
      category: 'background' as const,
      enabled: true,
      x: 0,
      y: 0,
      width: asset.width,
      height: asset.height,
    },
    iconCandidate = {
      id: 'icon',
      name: '图标',
      category: 'icon' as const,
      enabled: true,
      x: 2,
      y: 3,
      width: 7,
      height: 8,
    },
    fullAsset = await storage.crop(asset.id, fullCandidate, '完整画面.png'),
    iconAsset = await storage.crop(asset.id, iconCandidate, '图标.png'),
    fullLayer = croppedLayer(source, asset, fullCandidate, fullAsset),
    iconLayer = croppedLayer(source, asset, iconCandidate, iconAsset);
  Object.assign(iconLayer, { x: 20, y: 10, width: 8, height: 9 });
  Object.assign(source, { x: 500, y: -500 });
  project.scenes[0].layers.push(fullLayer, iconLayer);
  const saved = await storage.save(project.id, project.revision, project),
    response = await app.inject({
      method: 'POST',
      url: '/api/v1/layer-local-regeneration',
      payload: {
        projectId: saved.id,
        sceneId: saved.activeSceneId,
        layerId: iconLayer.id,
        revision: saved.revision,
        operationId: 'local-regenerate-visible-source',
      },
    });
  assert.equal(response.statusCode, 200, response.body);
  const resultLayer = response
      .json()
      .scenes[0].layers.find((item: ImageLayer) => item.id === iconLayer.id),
    resultAsset = await storage.asset(resultLayer.assetId);
  assert.deepEqual(resultLayer.source.rect, { x: 20, y: 10, width: 8, height: 9 });
  assert.deepEqual(
    { width: resultAsset.width, height: resultAsset.height },
    { width: 8, height: 9 },
  );
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
test('mixed AI candidates atomically create image and editable text layers', async (t) => {
  const { app, project, layer } = await fixture(t);
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
  const text: Candidate = {
    id: 'text-candidate',
    name: '按钮文字',
    category: 'text',
    enabled: true,
    x: 4,
    y: 6,
    width: 20,
    height: 8,
    text: {
      content: '开始游戏',
      fontFamily: 'sans-serif',
      fontSize: 10,
      fontWeight: 700,
      fontStyle: 'normal',
      fill: '#ffffff',
      align: 'center',
      verticalAlign: 'middle',
      lineHeight: 1.2,
      letterSpacing: 0,
      resizeMode: 'fixed',
    },
  };
  const applied = await app.inject({
    method: 'POST',
    url: `/api/v1/split-jobs/${started.json().id}/apply`,
    payload: {
      revision: project.revision,
      operationId: 'mixed-apply',
      candidates: [row, text],
    },
  });
  assert.equal(applied.statusCode, 200, applied.body);
  const layers = applied.json().scenes[0].layers;
  assert.deepEqual(layers[0], layer);
  assert.equal(layers[1].type, 'image');
  assert.equal(layers[2].type, 'text');
  assert.equal(layers[2].content, '开始游戏');
  assert.equal(layers[2].assetId, undefined);
});
test('tree-aware generation calls parent and image targets, then commits all layers once', async (t) => {
  let calls = 0;
  const editor = async (_config: any, input: any) => {
    calls++;
    const [width, height] = input.size.split('x').map(Number);
    return sharp({ create: { width, height, channels: 4, background: '#2367d1' } })
      .png()
      .toBuffer();
  };
  const { app, storage, project, layer } = await fixture(t, undefined, editor);
  await storage.saveModel({
    baseUrl: 'http://localhost:8080',
    model: 'vision',
    imageModel: 'gptimage2.5-configured',
    apiKey: 'secret',
    timeoutSeconds: 120,
  });
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
  const text: Candidate = {
    id: 'text-generate',
    name: '程序字体',
    category: 'text',
    enabled: true,
    x: 16,
    y: 10,
    width: 10,
    height: 5,
    text: {
      content: '开始',
      fontFamily: 'sans-serif',
      fontSize: 5,
      fontWeight: 700,
      fontStyle: 'normal',
      fill: '#ffffff',
      align: 'center',
      verticalAlign: 'middle',
      lineHeight: 1.2,
      letterSpacing: 0,
      resizeMode: 'fixed',
    },
  };
  const body = {
    revision: project.revision,
    operationId: 'generate-once',
    candidates: [row, text],
  };
  const accepted = await app.inject({
    method: 'POST',
    url: `/api/v1/split-jobs/${started.json().id}/generate`,
    payload: body,
  });
  assert.equal(accepted.statusCode, 202, accepted.body);
  const job = await waitForJob(app, started.json().id);
  assert.equal(job.status, 'applied', JSON.stringify(job));
  assert.equal(job.generation.total, 2);
  assert.equal(calls, 2);
  const saved = await storage.project(project.id),
    layers = saved.scenes[0].layers;
  assert.equal(saved.revision, project.revision + 1);
  assert.equal(layers.length, 3);
  assert.equal((layers[0] as ImageLayer).assetId === layer.assetId, false);
  assert.deepEqual({ ...layers[0], assetId: layer.assetId }, layer);
  assert.equal(layers[1].type, 'image');
  assert.equal(layers[2].type, 'text');
  assert.equal((layers[2] as TextLayer).content, '开始');
  const duplicate = await app.inject({
    method: 'POST',
    url: `/api/v1/split-jobs/${started.json().id}/generate`,
    payload: body,
  });
  assert.equal(duplicate.statusCode, 202, duplicate.body);
  assert.equal(calls, 2);
  assert.equal((await storage.project(project.id)).revision, saved.revision);
});

test('partial generation failure leaves project unchanged and retry bills only failed targets', async (t) => {
  let calls = 0;
  const editor = async (_config: any, input: any) => {
    calls++;
    if (calls === 2) throw new Error('temporary image failure');
    const [width, height] = input.size.split('x').map(Number);
    return sharp({ create: { width, height, channels: 4, background: '#55aa22' } })
      .png()
      .toBuffer();
  };
  const { app, storage, project, layer } = await fixture(t, undefined, editor);
  await storage.saveModel({
    baseUrl: 'http://localhost:8080',
    model: 'vision',
    imageModel: 'image-model',
    timeoutSeconds: 120,
  });
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
  const body = { revision: project.revision, operationId: 'retry-failed', candidates: [row] };
  await app.inject({
    method: 'POST',
    url: `/api/v1/split-jobs/${started.json().id}/generate`,
    payload: body,
  });
  const failed = await waitForJob(app, started.json().id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.generation.completed, 1);
  assert.equal(failed.generation.failed, 1);
  const unchanged = await storage.project(project.id);
  assert.equal(unchanged.revision, project.revision);
  assert.deepEqual(unchanged.scenes, project.scenes);
  await app.inject({
    method: 'POST',
    url: `/api/v1/split-jobs/${started.json().id}/generate`,
    payload: body,
  });
  const applied = await waitForJob(app, started.json().id);
  assert.equal(applied.status, 'applied', JSON.stringify(applied));
  assert.equal(calls, 3);
  assert.equal((await storage.project(project.id)).revision, project.revision + 1);
});

test('image generation provider concurrency never exceeds two requests', async (t) => {
  let active = 0,
    maximum = 0,
    calls = 0;
  const editor = async (_config: any, input: any) => {
    calls++;
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 80));
    active--;
    const [width, height] = input.size.split('x').map(Number);
    return sharp({ create: { width, height, channels: 4, background: '#334455' } })
      .png()
      .toBuffer();
  };
  const { app, storage, project, layer } = await fixture(t, undefined, editor);
  await storage.saveModel({
    baseUrl: 'http://localhost:8080',
    model: 'vision',
    imageModel: 'image-model',
    timeoutSeconds: 120,
  });
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
  const candidates = Array.from(
    { length: 4 },
    (_, index): Candidate => ({
      id: `parallel-${index}`,
      name: `图片 ${index}`,
      category: 'image',
      enabled: true,
      x: index * 9,
      y: 2,
      width: 6,
      height: 6,
    }),
  );
  await app.inject({
    method: 'POST',
    url: `/api/v1/split-jobs/${started.json().id}/generate`,
    payload: { revision: project.revision, operationId: 'parallel-two', candidates },
  });
  const job = await waitForJob(app, started.json().id);
  assert.equal(job.status, 'applied', JSON.stringify(job));
  assert.equal(calls, 5);
  assert.equal(maximum, 2);
});

test('unselected AI targets use local processing without model configuration or remote calls', async (t) => {
  let calls = 0;
  const { app, storage, project, layer, asset } = await fixture(t, undefined, async () => {
    calls++;
    throw new Error('remote editor must not be called');
  });
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
  const localRow = { ...row, id: 'local-only', generate: false };
  const accepted = await app.inject({
    method: 'POST',
    url: `/api/v1/split-jobs/${started.json().id}/generate`,
    payload: {
      revision: project.revision,
      operationId: 'local-processing',
      generateSource: false,
      candidates: [localRow],
    },
  });
  assert.equal(accepted.statusCode, 202, accepted.body);
  const job = await waitForJob(app, started.json().id);
  assert.equal(job.status, 'applied', JSON.stringify(job));
  assert.equal(job.generation.total, 0);
  assert.equal(calls, 0);
  const saved = await storage.project(project.id),
    layers = saved.scenes[0].layers;
  assert.deepEqual(layers[0], layer);
  const expected = await sharp(storage.imagePath(asset.id))
      .extract({ left: row.x, top: row.y, width: row.width, height: row.height })
      .raw()
      .toBuffer(),
    actual = await sharp(storage.imagePath((layers[1] as ImageLayer).assetId))
      .raw()
      .toBuffer();
  assert.deepEqual(actual, expected);
});

test('single image regeneration replaces only the selected asset and is idempotent', async (t) => {
  let calls = 0;
  const editor = async (_config: any, input: any) => {
    calls++;
    const [width, height] = input.size.split('x').map(Number);
    return sharp({ create: { width, height, channels: 4, background: '#336699' } })
      .png()
      .toBuffer();
  };
  const { app, storage, project, layer } = await fixture(t, undefined, editor);
  await storage.saveModel({
    baseUrl: 'http://localhost:8080',
    model: 'vision',
    imageModel: 'image-model',
    timeoutSeconds: 120,
  });
  const center = point(layer, 20, 15, { id: layer.assetId, name: '', width: 40, height: 30 }),
    child: TextLayer = {
      id: 'preserved-child',
      type: 'text',
      name: '保留文字',
      x: center.x - 5,
      y: center.y - 3,
      width: 10,
      height: 6,
      rotation: layer.rotation,
      flipX: false,
      flipY: false,
      opacity: 1,
      hidden: false,
      locked: false,
      content: '保留',
      fontFamily: 'sans-serif',
      fontSize: 6,
      fontWeight: 400,
      fontStyle: 'normal',
      fill: '#ffffff',
      align: 'center',
      verticalAlign: 'middle',
      lineHeight: 1.2,
      letterSpacing: 0,
      resizeMode: 'fixed',
    };
  project.scenes[0].layers.push(child);
  const withChild = await storage.save(project.id, project.revision, project),
    body = {
      projectId: project.id,
      sceneId: project.activeSceneId,
      layerId: layer.id,
      revision: withChild.revision,
      operationId: 'regenerate-single',
    },
    started = await app.inject({
      method: 'POST',
      url: '/api/v1/layer-regeneration-jobs',
      payload: body,
    });
  assert.equal(started.statusCode, 202, started.body);
  const job = await waitForLayerJob(app, started.json().id);
  assert.equal(job.status, 'applied', JSON.stringify(job));
  assert.equal(job.generation.total, 1);
  assert.equal(calls, 1);
  const saved = await storage.project(project.id),
    source = saved.scenes[0].layers[0] as ImageLayer;
  assert.notEqual(source.assetId, layer.assetId);
  assert.deepEqual({ ...source, assetId: layer.assetId }, layer);
  assert.deepEqual(saved.scenes[0].layers[1], child);
  const textAttempt = await app.inject({
    method: 'POST',
    url: '/api/v1/layer-regeneration-jobs',
    payload: {
      ...body,
      layerId: child.id,
      revision: saved.revision,
      operationId: 'regenerate-text-not-allowed',
    },
  });
  assert.equal(textAttempt.statusCode, 400, textAttempt.body);
  assert.match(textAttempt.body, /只有图片图层/);
  const duplicate = await app.inject({
    method: 'POST',
    url: '/api/v1/layer-regeneration-jobs',
    payload: body,
  });
  assert.equal(duplicate.statusCode, 202, duplicate.body);
  assert.equal(duplicate.json().id, started.json().id);
  assert.equal(calls, 1);
  assert.equal((await storage.project(project.id)).revision, saved.revision);
});

test('single image regeneration failure and cancellation leave the project unchanged', async (t) => {
  let calls = 0,
    release!: () => void,
    delayed = false;
  const editor = async (_config: any, input: any) => {
    calls++;
    if (calls === 1) throw new Error('temporary generation failure');
    if (delayed) await new Promise<void>((resolve) => (release = resolve));
    const [width, height] = input.size.split('x').map(Number);
    return sharp({ create: { width, height, channels: 4, background: '#884422' } })
      .png()
      .toBuffer();
  };
  const { app, storage, project, layer } = await fixture(t, undefined, editor);
  await storage.saveModel({
    baseUrl: 'http://localhost:8080',
    model: 'vision',
    imageModel: 'image-model',
    timeoutSeconds: 120,
  });
  const body = {
      projectId: project.id,
      sceneId: project.activeSceneId,
      layerId: layer.id,
      revision: project.revision,
      operationId: 'regenerate-retry',
    },
    started = await app.inject({
      method: 'POST',
      url: '/api/v1/layer-regeneration-jobs',
      payload: body,
    }),
    failed = await waitForLayerJob(app, started.json().id);
  assert.equal(failed.status, 'failed');
  assert.deepEqual((await storage.project(project.id)).scenes, project.scenes);
  const retried = await app.inject({
    method: 'POST',
    url: `/api/v1/layer-regeneration-jobs/${started.json().id}/retry`,
  });
  assert.equal(retried.statusCode, 202, retried.body);
  assert.equal((await waitForLayerJob(app, started.json().id)).status, 'applied');
  assert.equal(calls, 2);

  const afterRetry = await storage.project(project.id);
  delayed = true;
  const cancelledStart = await app.inject({
      method: 'POST',
      url: '/api/v1/layer-regeneration-jobs',
      payload: {
        ...body,
        revision: afterRetry.revision,
        operationId: 'regenerate-cancel',
      },
    }),
    cancelledId = cancelledStart.json().id;
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  await app.inject({ method: 'DELETE', url: `/api/v1/layer-regeneration-jobs/${cancelledId}` });
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    (await app.inject(`/api/v1/layer-regeneration-jobs/${cancelledId}`)).json().status,
    'cancelled',
  );
  assert.deepEqual(await storage.project(project.id), afterRetry);
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
test('editable text exports at design pixels and cannot be used as an AI split source', async (t) => {
  const { app, storage, project } = await fixture(t);
  const text: TextLayer = {
    id: 'editable-text',
    type: 'text',
    name: '安全文字',
    x: 20,
    y: 30,
    width: 180,
    height: 56,
    rotation: 0,
    flipX: false,
    flipY: false,
    opacity: 0.8,
    hidden: false,
    locked: false,
    content: '<span foreground="red">不执行标记</span> & 中文\u0000',
    fontFamily: 'sans-serif',
    fontSize: 22,
    fontWeight: 700,
    fontStyle: 'italic',
    fill: '#123456cc',
    align: 'center',
    verticalAlign: 'middle',
    lineHeight: 1.3,
    letterSpacing: 1,
    resizeMode: 'fixed',
  };
  project.scenes[0].layers.push(text);
  const saved = await storage.save(project.id, project.revision, project);
  const png = await app.inject({
    method: 'POST',
    url: '/api/v1/exports',
    payload: {
      projectId: project.id,
      sceneId: project.activeSceneId,
      layerIds: [text.id],
      kind: 'png',
    },
  });
  assert.equal(png.statusCode, 200, png.body.slice(0, 200));
  const meta = await sharp(png.rawPayload).metadata();
  assert.equal(meta.width, 180);
  assert.equal(meta.height, 56);

  const split = await app.inject({
    method: 'POST',
    url: '/api/v1/split-jobs',
    payload: {
      projectId: project.id,
      sceneId: project.activeSceneId,
      layerId: text.id,
      region: { x: 0, y: 0, width: 10, height: 10 },
      manual: true,
    },
  });
  assert.equal(split.statusCode, 400, split.body);
  assert.match(split.body, /只有图片图层/);
  assert.equal(saved.scenes[0].layers.find((layer) => layer.id === text.id)?.type, 'text');
});
test('OpenAPI request contract and origin/host protections', async (t) => {
  const { app } = await fixture(t);
  const spec = (await app.inject('/openapi.json')).json();
  for (const path of [
    '/api/v1/projects',
    '/api/v1/assets',
    '/api/v1/split-jobs',
    '/api/v1/layer-regeneration-jobs',
    '/api/v1/layer-regeneration-jobs/{id}',
    '/api/v1/layer-regeneration-jobs/{id}/retry',
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
