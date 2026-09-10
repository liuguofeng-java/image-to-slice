const test = require('node:test');
const assert = require('node:assert/strict');
const { applySliceTrimResult, applySliceImageProcessingResult, restoreSliceImageProcessingState, applySliceTransparencyResult, restoreSliceTransparencyState, slicePlacementSignature, shouldPreserveProcessedSliceResult } = require('../src/ui/state/slice-ai-state');
const { buildSliceExportManifest } = require('../src/ui/services/export-manifest');
const { restoreSliceInitialPosition, recoverLegacySliceTrimPosition } = require('../src/ui/state/slice-ai-state');
const trim = { dataUrl: 'trimmed', left: -2, top: 3, sourcePixelWidth: 200, sourcePixelHeight: 100, outputPixelWidth: 104, outputPixelHeight: 60 };

test('legacy draft recovers crop offset from pixels, not stale preview coordinates, exactly once', async () => {
  const pixels = (width, height, left, top) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = top; y < top + 57; y++) for (let x = left; x < left + 184; x++) data.set([20, 80, 30, 255], (y * width + x) * 4);
    return { width, height, data };
  };
  const before = pixels(221, 78, 11, 10), after = pixels(196, 69, 6, 6);
  const asset = { trimmed: true, dataUrl: 'after', initialPlacement: { x: 453, y: 1146 },
    placement: { x: 453, y: 1146, width: 196, height: 69 }, aiTransparentPlacement: { x: 900, y: 900, width: 196, height: 69 },
    imageProcessingRestoreState: { dataUrl: 'before', geometryState: { placement: { x: 453, y: 1146, width: 221, height: 78 } } } };
  const decode = async url => url === 'before' ? before : after;
  const invalid = structuredClone(asset);
  const different = structuredClone(after); different.data[(6 * 196 + 6) * 4] = 250;
  assert.equal(await recoverLegacySliceTrimPosition(invalid, async url => url === 'before' ? before : different), false);
  assert.deepEqual(invalid, asset, 'different images must not be guessed into position');
  assert.equal(await recoverLegacySliceTrimPosition(asset, decode), true);
  assert.deepEqual(asset.initialPlacement, { x: 458, y: 1150 });
  assert.equal(asset.placement.x, 453, 'migration itself does not move user content');
  restoreSliceInitialPosition(asset, value => value);
  assert.deepEqual(asset.placement, { x: 458, y: 1150, width: 196, height: 69 });
  assert.equal(await recoverLegacySliceTrimPosition(asset, decode), false);
  restoreSliceImageProcessingState(asset);
  assert.deepEqual(asset.initialPlacement, { x: 453, y: 1146 });
});
test('trim maps pixel bounds to design coordinates and restores geometry', () => {
  const asset = { id: 'a', name: 'a', dataUrl: 'original', placement: { x: 10, y: 20, width: 100, height: 50 } };
  const initial = structuredClone(asset);
  applySliceTrimResult(asset, trim);
  assert.deepEqual(asset.placement, { x: 9, y: 21.5, width: 52, height: 30 });
  assert.equal(shouldPreserveProcessedSliceResult(asset, 'move'), true);
  assert.notEqual(slicePlacementSignature(asset.placement), slicePlacementSignature(initial.placement));
  const exported = buildSliceExportManifest({ manifest: { screen: { width: 400, height: 400 } }, activeImage: { sliceManifest: { assets: [asset] } }, imageIndex: 0, getSliceRadius: () => 0 });
  assert.deepEqual(exported.assets[0].placement, asset.placement);
  assert.equal(exported.assets[0].outputPixelWidth, 104);
  restoreSliceImageProcessingState(asset);
  assert.deepEqual(asset.placement, initial.placement); assert.equal(asset.dataUrl, initial.dataUrl); assert.equal(asset.trimmed, undefined);
});
test('upscale and trim preserve scale and transparency restoration', () => {
  const asset = { dataUrl: 'original', placement: { x: 0, y: 0, width: 100, height: 50 } };
  applySliceTransparencyResult(asset, { dataUrl: 'cutout', ai: true });
  applySliceImageProcessingResult(asset, { operation: 'upscale', dataUrl: 'large', scale: 2, sourcePixelWidth: 100, sourcePixelHeight: 50, outputPixelWidth: 200, outputPixelHeight: 100 });
  applySliceTrimResult(asset, trim);
  assert.deepEqual(asset.placement, { x: -1, y: 1.5, width: 52, height: 30 });
  assert.equal(asset.aiTransparentDataUrl, 'trimmed');
  assert.equal(asset.cutoutMaskDataUrl, undefined);
  applySliceImageProcessingResult(asset, { operation: 'upscale', dataUrl: 'larger', scale: 4, sourcePixelWidth: 104, sourcePixelHeight: 60, outputPixelWidth: 416, outputPixelHeight: 240 });
  assert.equal(asset.placement.width, 52);
  restoreSliceTransparencyState(asset);
  assert.equal(asset.dataUrl, 'original'); assert.deepEqual(asset.placement, { x: 0, y: 0, width: 100, height: 50 });
  assert.equal(restoreSliceImageProcessingState(asset), false, 'restoring before cutout must discard later processing restore points');
});

test('restoring trim after a later cutout discards stale cutout restoration', () => {
  const asset = { dataUrl: 'original', placement: { x: 0, y: 0, width: 100, height: 50 } };
  applySliceTrimResult(asset, trim);
  applySliceTransparencyResult(asset, { dataUrl: 'cutout', ai: true });
  restoreSliceImageProcessingState(asset);
  assert.equal(asset.dataUrl, 'original');
  assert.equal(asset.transparencyRestoreState, undefined);
  assert.deepEqual(asset.placement, { x: 0, y: 0, width: 100, height: 50 });
});

test('restore position preserves the trimmed subject origin, fractional scale and padding outside the design', () => {
  const asset = { dataUrl: 'original', placement: { x: 0, y: 0, width: 101, height: 51 }, initialPlacement: { x: 0, y: 0 } };
  applySliceTrimResult(asset, trim);
  const expected = structuredClone(asset.placement);
  assert.deepEqual(asset.initialPlacement, { x: expected.x, y: expected.y });
  asset.placement.x += 40; asset.placement.y += 30;
  restoreSliceInitialPosition(asset, () => { throw new Error('trim position must not be rounded or clamped'); });
  assert.deepEqual(asset.placement, expected);
  restoreSliceInitialPosition(asset, () => { throw new Error('unexpected normalization'); });
  assert.deepEqual(asset.placement, expected, 'repeated restoration is stable');
  restoreSliceImageProcessingState(asset);
  assert.deepEqual(asset.initialPlacement, { x: 0, y: 0 });
});

test('trimming an already moved slice preserves its original restore target through multiple trims', () => {
  const asset = { dataUrl: 'original', placement: { x: 40, y: 30, width: 100, height: 50 }, initialPlacement: { x: 0, y: 0 } };
  applySliceTrimResult(asset, trim);
  applySliceImageProcessingResult(asset, { operation: 'upscale', dataUrl: 'large', scale: 2, sourcePixelWidth: 104, sourcePixelHeight: 60, outputPixelWidth: 208, outputPixelHeight: 120 });
  applySliceTrimResult(asset, { ...trim, left: 4, top: -6, sourcePixelWidth: 208, sourcePixelHeight: 120 });
  const beforeRestore = { ...asset.placement };
  restoreSliceInitialPosition(asset, value => value);
  assert.equal(asset.placement.x, beforeRestore.x - 40);
  assert.equal(asset.placement.y, beforeRestore.y - 30);
  assert.equal(asset.placement.width, beforeRestore.width);
  assert.equal(asset.placement.height, beforeRestore.height);
  assert.equal(asset.dataUrl, 'trimmed');
});

test('trim geometry survives serialization, export and restoration', async () => {
  const dataUrl = 'data:image/png;base64,AA==';
  const asset = { id: 'a', name: 'trimmed-subject', dataUrl, placement: { x: 0, y: 0, width: 101, height: 51 } };
  const original = structuredClone(asset);
  applySliceTrimResult(asset, { ...trim, dataUrl });
  const restoredWorkspaceAsset = JSON.parse(JSON.stringify(asset));
  assert.deepEqual(restoredWorkspaceAsset, asset);
  const manifest = buildSliceExportManifest({ manifest: { screen: { width: 400, height: 400 } }, activeImage: { sliceManifest: { assets: [restoredWorkspaceAsset] } }, imageIndex: 0, getSliceRadius: () => 0 });
  manifest.previewImage = { dataUrl };
  manifest.assets[0].dataUrl = dataUrl;
  const exported = manifest.assets[0].placement;
  assert.deepEqual(exported, asset.placement);
  assert.ok(exported.x < 0, 'transparent padding may extend beyond the design');
  assert.equal(Number.isInteger(exported.width), false, 'design coordinates must not be rounded');
  restoreSliceImageProcessingState(restoredWorkspaceAsset);
  assert.deepEqual(restoredWorkspaceAsset.placement, original.placement);
  assert.equal(restoredWorkspaceAsset.dataUrl, original.dataUrl);
});
