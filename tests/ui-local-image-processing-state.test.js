const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applySliceImageProcessingResult,
  restoreSliceImageProcessingState,
  shouldPreserveProcessedSliceResult,
  shouldRefreshSliceCropAfterPositionRestore
} = require("../src/ui/state/slice-ai-state");

test("local repair and upscale share one processing restore point", () => {
  const asset = { dataUrl: "source", svgData: "<svg/>", aiRedrawn: true, lastAiOperation: "redrawSvg" };
  applySliceImageProcessingResult(asset, {
    operation: "inpaint",
    dataUrl: "repaired",
    maskDataUrl: "mask",
    sourceSignature: "signature"
  });
  applySliceImageProcessingResult(asset, {
    operation: "upscale",
    dataUrl: "upscaled",
    scale: 2,
    sourcePixelWidth: 32,
    sourcePixelHeight: 24,
    outputPixelWidth: 64,
    outputPixelHeight: 48
  });
  assert.equal(asset.imageProcessingRestoreState.dataUrl, "source");
  assert.equal(asset.localInpaintMethod, "iopaint-lama");
  assert.equal(asset.upscaleMethod, "realesrgan-x4plus-anime-6b");
  assert.equal(asset.dataUrl, "upscaled");
  assert.equal(restoreSliceImageProcessingState(asset), true);
  assert.equal(asset.dataUrl, "source");
  assert.equal(asset.svgData, "<svg/>");
  assert.equal(asset.localInpaintMethod, undefined);
  assert.equal(asset.upscaleMethod, undefined);
});

test("moving a processed slice preserves its pixels while resizing still invalidates them", () => {
  const asset = {
    dataUrl: "processed",
    localInpaintMethod: "iopaint-lama",
    upscaleMethod: "realesrgan-x4plus-anime-6b"
  };

  assert.equal(shouldPreserveProcessedSliceResult(asset, "move"), true);
  assert.equal(shouldPreserveProcessedSliceResult(asset, "x"), true);
  assert.equal(shouldPreserveProcessedSliceResult(asset, "y"), true);
  assert.equal(shouldPreserveProcessedSliceResult(asset, "width"), false);
  assert.equal(shouldPreserveProcessedSliceResult(asset, "height"), false);
  assert.equal(shouldPreserveProcessedSliceResult({}, "move"), false);
});

test("repair after upscale keeps the effective high-resolution metadata", () => {
  const asset = { dataUrl: "source" };
  applySliceImageProcessingResult(asset, {
    operation: "upscale",
    dataUrl: "upscaled",
    scale: 4,
    sourcePixelWidth: 32,
    sourcePixelHeight: 24,
    outputPixelWidth: 128,
    outputPixelHeight: 96
  });
  applySliceImageProcessingResult(asset, {
    operation: "inpaint",
    dataUrl: "upscaled-and-repaired",
    maskDataUrl: "mask",
    sourceSignature: "signature"
  });

  assert.equal(asset.dataUrl, "upscaled-and-repaired");
  assert.equal(asset.localInpaintMethod, "iopaint-lama");
  assert.equal(asset.upscaleMethod, "realesrgan-x4plus-anime-6b");
  assert.equal(asset.outputPixelWidth, 128);
  assert.equal(asset.outputPixelHeight, 96);
});

test("restoring position preserves every image-processing result", () => {
  const processedAssets = [
    { transparent: true },
    { aiTransparent: true },
    { aiRedrawn: true },
    { localInpaintMethod: "iopaint-lama" },
    { upscaleMethod: "realesrgan-x4plus-anime-6b" }
  ];

  for (const asset of processedAssets) {
    assert.equal(shouldRefreshSliceCropAfterPositionRestore(asset), false);
  }
  assert.equal(shouldRefreshSliceCropAfterPositionRestore({}), true);
  assert.equal(shouldRefreshSliceCropAfterPositionRestore({ aiCompleted: true, aiCompletedDataUrl: "locked" }), false);
});
