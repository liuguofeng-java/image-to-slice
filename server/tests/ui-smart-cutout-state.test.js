const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applySliceTransparencyResult,
  restoreSliceTransparencyState
} = require("../src/ui/state/slice-ai-state");
const { buildSliceExportManifest } = require("../src/ui/services/export-manifest");

test("restoring a smart cutout removes SAM-only state and restores the original pixels", () => {
  const asset = { id: "coin", dataUrl: "data:image/png;base64,original", originalDataUrl: "data:image/png;base64,original" };
  applySliceTransparencyResult(asset, { dataUrl: "data:image/png;base64,cutout", ai: true });
  Object.assign(asset, {
    cutoutMethod: "sam2-local",
    cutoutMaskDataUrl: "data:image/png;base64,mask",
    cutoutSettings: { fillHoles: true },
    cutoutSessionSourceSignature: "children:v1"
  });
  assert.equal(restoreSliceTransparencyState(asset), true);
  assert.equal(asset.dataUrl, "data:image/png;base64,original");
  assert.equal(asset.cutoutMethod, undefined);
  assert.equal(asset.cutoutMaskDataUrl, undefined);
});

test("slice manifest preserves the local cutout method, mask, settings and source signature", () => {
  const activeImage = { sliceManifest: { assets: [{
    id: "button", name: "button", contentType: "image", dataUrl: "data:image/png;base64,result",
    transparent: true, aiTransparent: true, placement: { x: 0, y: 0, width: 64, height: 64 },
    cutoutMethod: "sam2-local", cutoutMaskDataUrl: "data:image/png;base64,mask",
    cutoutSettings: { tolerance: 20, fillHoles: true }, cutoutSessionSourceSignature: "child:a"
  }] } };
  const exported = buildSliceExportManifest({
    manifest: { screen: { name: "screen", width: 64, height: 64 } }, activeImage, imageIndex: 0,
    getSliceRadius: () => 0, getSliceRadii: () => null
  });
  assert.deepEqual(exported.assets[0].cutoutSettings, { tolerance: 20, fillHoles: true });
  assert.equal(exported.assets[0].cutoutMethod, "sam2-local");
  assert.equal(exported.assets[0].cutoutSessionSourceSignature, "child:a");
});
