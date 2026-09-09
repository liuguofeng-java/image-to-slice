const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { prepareRegeneration, restoreRegeneration, regenerateAsset } = require('../../src/server/services/ai-regenerate');
const { createAssetRoutes } = require('../../src/server/routes/asset-routes');
const { unionRegenerationRegions, validateRegenerationDimensions } = require('../../src/core/regeneration');
const { canMarkRegeneration, mapRegenerationChildren, regenerationSignature, applyRegenerationResult } = require('../../src/ui/state/slice-regeneration');
const { normalizeCompositeSliceLayers, getDirectChildRemovalRegions, getDirectChildRemovalSignature } = require('../../src/ui/state/composite-slice-layers');
const { buildSliceExportManifest } = require('../../src/ui/services/export-manifest');
const { requestRegeneration } = require('../../src/ui/state/slice-regeneration');
const url = b => `data:image/png;base64,${b.toString('base64')}`;
const buffer = u => Buffer.from(u.split(',')[1], 'base64');
test('old running backend is blocked before paid generation; malformed responses remain blocked', async () => {
  const calls = [];
  let health = { ok: true }, generated = { images: [{ dataUrl: 'old-result' }] };
  const request = async path => {
    calls.push(path);
    return new Response(JSON.stringify(path === '/health' ? health : generated));
  };
  await assert.rejects(() => requestRegeneration(request, {}), /本次未发送生成请求/);
  assert.deepEqual(calls, ['/health']);
  health = { ok: true, capabilities: { regenerate: 1 } };
  await assert.rejects(() => requestRegeneration(request, {}), /旧版重绘结果/);
  generated.operation = 'regenerate';
  await assert.rejects(() => requestRegeneration(request, {}), /缺少有效的像素尺寸/);
  generated.images[0].width = 199; generated.images[0].height = 67;
  const result = await requestRegeneration(request, {});
  assert.equal(result.width, 199); assert.equal(result.height, 67);
});
async function fixture(width = 20, height = 10) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) data.set([30, 80, 120, x === 1 ? 80 : 255], (y * width + x) * 4);
  return url(await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer());
}
test('regeneration eligibility, type normalization and exact pixel union after trim/upscale', () => {
  for (const contentType of ['text', 'background', 'unclassified']) assert.equal(canMarkRegeneration({ contentType }), false);
  assert.equal(canMarkRegeneration({ contentType: 'image', hidden: true }), true);
  assert.equal(canMarkRegeneration({ contentType: 'image', aiProcessing: true }), false);
  const parent = { id: 'p', contentType: 'image', placement: { x: -2.5, y: 3.5, width: 20, height: 10 } };
  const children = [
    { id: 'a', parentId: 'p', contentType: 'image', placement: { x: 0, y: 5, width: 5, height: 4 } },
    { id: 'b', parentId: 'a', contentType: 'image', placement: { x: 1, y: 6, width: 1, height: 1 } },
    { id: 'c', parentId: 'p', hidden: true, placement: { x: 10, y: 4, width: 1, height: 1 } }
  ];
  const regions = getDirectChildRemovalRegions(parent, children);
  assert.equal(regions.length, 1);
  assert.deepEqual(mapRegenerationChildren(parent, regions, 80, 40), [{ x: 10, y: 6, width: 20, height: 16 }]);
  const union = unionRegenerationRegions([{ x: 0, y: 0, width: 3, height: 2 }, { x: 2, y: 1, width: 2, height: 3 }], 10, 10);
  assert.equal(union.reduce((a, r) => a + r.width * r.height, 0), 11, 'overlaps count once; gaps not erased');
  const signature = regenerationSignature(parent, getDirectChildRemovalSignature(parent, children));
  children[0].hidden = true;
  assert.notEqual(regenerationSignature(parent, getDirectChildRemovalSignature(parent, children)), signature);
  assert.equal(normalizeCompositeSliceLayers([{ id: 't', contentType: 'text', regenerateMarked: true }])[0].regenerateMarked, undefined);
  assert.throws(() => validateRegenerationDimensions(100, 99, 100, 100), /清晰度/);
  assert.throws(() => validateRegenerationDimensions(8000, 8000), /超限/);
});
test('reference child RGB is erased; aligned mask, HD unpadding and alpha retained', async () => {
  const dataUrl = await fixture();
  const prepared = await prepareRegeneration({ dataUrl, width: 20, height: 10, excludeRegions: [{ x: 4, y: 3, width: 4, height: 3 }] }, '40x40');
  const raw = await sharp(prepared.reference).raw().toBuffer();
  assert.deepEqual([...raw.subarray(((10 + 8) * 40 + 12) * 4, ((10 + 8) * 40 + 12) * 4 + 4)], [0, 0, 0, 0]);
  const generated = url(await sharp({ create: { width: 80, height: 80, channels: 4, background: '#f09030' } }).png().toBuffer());
  const result = await restoreRegeneration(generated, prepared);
  assert.equal(result.width, 80); assert.equal(result.height, 40);
  const pixels = await sharp(buffer(result.dataUrl)).raw().toBuffer();
  assert.equal(pixels[3], 0);
  assert.equal(pixels[(8 * 80 + 4) * 4 + 3], 80, 'soft edge alpha preserved');
  assert.equal(pixels[(16 * 80 + 20) * 4 + 3], 255, 'child reconstruction is allowed opaque');
  assert.deepEqual([...pixels.subarray((16 * 80 + 20) * 4, (16 * 80 + 20) * 4 + 3)], [240, 144, 48]);
  await assert.rejects(() => restoreRegeneration(dataUrl, prepared), /宽高比/);
  const tiny = url(await sharp({ create: { width: 10, height: 10, channels: 4, background: '#fff' } }).png().toBuffer());
  await assert.rejects(() => restoreRegeneration(tiny, prepared), /清晰度/);
  await assert.rejects(() => prepareRegeneration({ dataUrl, width: 21, height: 10, excludeRegions: [] }, '40x40'), /真实像素/);
});
test('remote-only generation makes exactly one high quality call and no hidden fallback', async () => {
  const dataUrl = await fixture(); let calls = 0;
  const config = { configId: 'remote', baseUrl: 'https://example.test', model: 'configured-model', apiKey: 'secret' };
  const context = { config, callForm: async (path, form) => {
    calls++; assert.equal(path, '/v1/images/edits'); assert.equal(form.get('model'), config.model);
    assert.equal(form.get('quality'), 'high'); assert.equal(form.get('n'), '1'); assert.equal(form.getAll('image[]').length, 2);
    return { images: [{ dataUrl: url(await sharp({ create: { width: 80, height: 80, channels: 4, background: '#ff0' } }).png().toBuffer()) }] };
  } };
  const payload = { dataUrl, width: 20, height: 10, excludeRegions: [], expectedProvider: { id: config.configId, model: config.model, baseUrl: config.baseUrl } };
  const deps = { normalizeImageResponse: async r => r, toImageSize: () => '40x40' };
  const result = await regenerateAsset(payload, context, deps);
  assert.equal(calls, 1); assert.equal(result.images[0].width, 80); assert.equal(JSON.stringify(result).includes('secret'), false);
  context.callForm = async () => { calls++; throw new Error('unsupported'); };
  await assert.rejects(() => regenerateAsset(payload, context, deps), /unsupported/); assert.equal(calls, 2);
  await assert.rejects(() => regenerateAsset({ ...payload, expectedProvider: { ...payload.expectedProvider, model: 'changed' } }, context, deps), /配置已变化/);
  let routed;
  const route = createAssetRoutes({ readJson: async () => ({ operation: 'regenerate', preserveBackground: true, maskDataUrl: 'mask' }), getTaskRequestContext: task => { routed = task; return {}; }, runWithAiProgress: async (_, __, run) => run(), redrawAsset: async () => ({}), sendJson: () => {} });
  await route({ method: 'POST', url: '/api/assets/ai-redraw' }, {}); assert.equal(routed, 'generation');
});
test('apply preserves design geometry and export HD metadata, clears marks and stale caches', () => {
  const asset = { id: 'a', name: 'parent', contentType: 'image', hidden: true, parentId: 'root', radius: 5, placement: { x: -2.5, y: 3.5, width: 20, height: 10 }, regenerateMarked: true, dataUrl: 'before', cutoutMaskDataUrl: 'mask', localInpaintDataUrl: 'old', upscaleMethod: 'old' };
  const before = structuredClone(asset);
  applyRegenerationResult(asset, { width: 80, height: 40, dataUrl: 'after', transparent: true }, { width: 40, height: 20 }, { model: 'remote' });
  for (const key of ['id', 'name', 'hidden', 'parentId', 'radius', 'placement']) assert.deepEqual(asset[key], before[key]);
  assert.equal(asset.regenerateMarked, false); assert.equal(asset.transparentDataUrl, 'after');
  assert.equal(asset.cutoutMaskDataUrl, undefined); assert.equal(asset.localInpaintDataUrl, undefined);
  const exported = buildSliceExportManifest({ manifest: { screen: {} }, activeImage: { sliceManifest: { assets: [asset] } }, getSliceRadius: a => a.radius }).assets[0];
  assert.deepEqual(exported.placement, before.placement); assert.equal(exported.outputPixelWidth, 80);
});
