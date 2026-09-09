function hasProcessedSliceResult(asset) {
  return Boolean(asset?.trimmed || asset?.transparent || asset?.aiTransparent || asset?.aiRedrawn || asset?.localInpaintMethod || asset?.upscaleMethod);
}

const sliceGeometrySnapshotKeys = ['placement', 'initialPlacement', 'trimPositionVersion', 'sourcePixelWidth', 'sourcePixelHeight', 'outputPixelWidth', 'outputPixelHeight', 'trimmed', 'upscaleMethod', 'upscaleScale', 'transparent', 'aiTransparent', 'transparentDataUrl', 'aiTransparentDataUrl', 'aiTransparentPlacement', 'cutoutMaskDataUrl', 'cutoutSettings', 'cutoutMethod', 'localInpaintMaskDataUrl', 'localInpaintDataUrl', 'localInpaintMethod', 'parentId', 'imageProcessingRestoreState', 'transparencyRestoreState', 'regeneration'];
function captureSliceGeometryState(asset) {
  return Object.fromEntries(sliceGeometrySnapshotKeys.map(key => [key, asset?.[key] === undefined ? null : structuredClone(asset[key])]));
}
function restoreSliceGeometryState(asset, state) {
  if (!state) return;
  for (const key of sliceGeometrySnapshotKeys) {
    if (!Object.prototype.hasOwnProperty.call(state, key)) continue;
    if (state[key] == null) delete asset[key];
    else asset[key] = structuredClone(state[key]);
  }
}
function slicePlacementSignature(placement) {
  return JSON.stringify(['x', 'y', 'width', 'height'].map(key => Number(placement?.[key]) || 0));
}

function applySliceTrimResult(asset, result) {
  const { sourcePixelWidth: W, sourcePixelHeight: H, left, top, outputPixelWidth: width, outputPixelHeight: height } = result;
  if (![W, H, left, top, width, height].every(Number.isInteger) || W <= 0 || H <= 0 || width <= 0 || height <= 0
    || width > 16384 || height > 16384 || width * height > 32_000_000 || !result.dataUrl || !asset?.placement) throw new Error('边缘切除尺寸无效。');
  asset.imageProcessingRestoreState = createSliceImageProcessingRestoreState(asset);
  const placement = asset.placement;
  const initial = asset.initialPlacement || placement;
  // Cropping changes the image origin, not the subject's original design position.
  asset.initialPlacement = { x: initial.x + left * placement.width / W, y: initial.y + top * placement.height / H };
  asset.placement = { ...placement, x: placement.x + left * placement.width / W, y: placement.y + top * placement.height / H,
    width: width * placement.width / W, height: height * placement.height / H };
  asset.dataUrl = result.dataUrl;
  asset.trimmed = true;
  asset.trimPositionVersion = 1;
  asset.sourcePixelWidth = width; asset.sourcePixelHeight = height;
  asset.outputPixelWidth = width; asset.outputPixelHeight = height;
  if (asset.transparent) asset.transparentDataUrl = result.dataUrl;
  if (asset.aiTransparent) { asset.aiTransparentDataUrl = result.dataUrl; asset.aiTransparentPlacement = { ...asset.placement }; }
  if (asset.localInpaintMethod) asset.localInpaintDataUrl = result.dataUrl;
  asset.svgData = null; asset.aiRedrawn = false; asset.aiRedrawnPlacement = null;
  delete asset.cutoutMaskDataUrl; delete asset.cutoutSessionSourceSignature; delete asset.localInpaintMaskDataUrl;
  asset.lastAiOperation = 'trim';
  return true;
}

function shouldPreserveProcessedSliceResult(asset, geometryChange) {
  return hasProcessedSliceResult(asset) && ["move", "x", "y"].includes(String(geometryChange || ""));
}

function shouldRefreshSliceCropAfterPositionRestore(asset) {
  return !isLockedAiCompleteAsset(asset) && !shouldPreserveProcessedSliceResult(asset, "move");
}

function restoreSliceInitialPosition(asset, normalizePlacement) {
  if (!asset?.placement || !asset?.initialPlacement) return false;
  const placement = { ...asset.placement, x: asset.initialPlacement.x, y: asset.initialPlacement.y };
  // Transparent padding may extend outside the design; rounding or clamping it shifts the subject.
  asset.placement = asset.trimmed ? placement : normalizePlacement(placement);
  if (asset.aiTransparent) asset.aiTransparentPlacement = { ...asset.placement };
  if (asset.aiRedrawn) asset.aiRedrawnPlacement = { ...asset.placement };
  return true;
}

async function recoverLegacySliceTrimPosition(asset, decodePixels) {
  const state = asset?.imageProcessingRestoreState;
  const geometry = state?.geometryState;
  if (!asset?.trimmed || asset.trimPositionVersion === 1 || !geometry?.placement
    || Object.prototype.hasOwnProperty.call(geometry, 'initialPlacement') || geometry.trimmed
    || asset.upscaleMethod || geometry.upscaleMethod || !asset.initialPlacement || !state.dataUrl) return false;
  const currentUrl = asset.dataUrl;
  const currentPlacement = slicePlacementSignature(asset.placement);
  const initial = { ...asset.initialPlacement };
  const before = await decodePixels(state.dataUrl);
  const after = await decodePixels(currentUrl);
  // Recover only a verifiable crop of identical pixels. Do not guess from a possibly moved preview cache.
  const alphaBounds = image => {
    let left = image.width, top = image.height, right = -1, bottom = -1;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      if (!image.data[(y * image.width + x) * 4 + 3]) continue;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
    return { left, top, width: right - left + 1, height: bottom - top + 1 };
  };
  const a = alphaBounds(before), b = alphaBounds(after);
  if (a.width <= 0 || a.height <= 0 || a.width !== b.width || a.height !== b.height) return false;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const i = ((y + a.top) * before.width + x + a.left) * 4;
    const j = ((y + b.top) * after.width + x + b.left) * 4;
    if (before.data[i + 3] !== after.data[j + 3]) return false;
    if (before.data[i + 3]) for (let c = 0; c < 3; c++) if (before.data[i + c] !== after.data[j + c]) return false;
  }
  const scaleX = geometry.placement.width / before.width, scaleY = geometry.placement.height / before.height;
  if (Math.abs(asset.placement.width - after.width * scaleX) > 1e-6
    || Math.abs(asset.placement.height - after.height * scaleY) > 1e-6) return false;
  if (asset.dataUrl !== currentUrl || asset.imageProcessingRestoreState !== state
    || slicePlacementSignature(asset.placement) !== currentPlacement
    || asset.initialPlacement.x !== initial.x || asset.initialPlacement.y !== initial.y) return false;
  asset.initialPlacement = { x: initial.x + (a.left - b.left) * scaleX, y: initial.y + (a.top - b.top) * scaleY };
  asset.trimPositionVersion = 1;
  geometry.initialPlacement = initial;
  geometry.trimPositionVersion = null;
  // Do not move the asset here: the existing restore-position action remains undoable.
  return true;
}

function isLockedAiCompleteAsset(asset) {
  return Boolean(
    asset?.aiCompleted
    && asset?.aiCompletedDataUrl
  );
}

function getSliceBaseAiOperation(asset, restoreState) {
  const candidates = [
    restoreState?.lastAiOperation,
    asset?.transparencyRestoreState?.lastAiOperation,
    asset?.svgRestoreState?.lastAiOperation,
    asset?.lastAiOperation
  ];
  const operation = candidates.find((value) => ["complete", "backgroundRestore"].includes(value));
  return operation || (asset?.aiCompleted ? "complete" : null);
}

function getSliceActiveImageDataUrl(asset) {
  const svgData = String(asset?.svgData || "").trim();
  if (svgData) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgData)}`;
  }
  return asset?.dataUrl || "";
}

function getSliceTransparencySourceDataUrl(asset) {
  return asset?.transparencyRestoreState?.dataUrl
    || asset?.transparencyRestoreDataUrl
    || asset?.dataUrl
    || asset?.originalDataUrl
    || "";
}

function getSliceTransparencyRestoreDataUrl(asset) {
  return asset?.transparencyRestoreState?.dataUrl
    || asset?.transparencyRestoreDataUrl
    || asset?.originalDataUrl
    || asset?.dataUrl
    || "";
}

function createSliceTransparencyRestoreState(asset) {
  if (asset?.transparencyRestoreState?.dataUrl) {
    return { ...asset.transparencyRestoreState };
  }
  return {
    dataUrl: getSliceTransparencySourceDataUrl(asset),
    geometryState: captureSliceGeometryState(asset),
    aiCompleted: Boolean(asset?.aiCompleted),
    aiRedrawn: Boolean(asset?.aiRedrawn),
    svgData: asset?.svgData || null,
    aiRedrawnPlacement: asset?.aiRedrawnPlacement ? { ...asset.aiRedrawnPlacement } : null,
    lastAiOperation: asset?.lastAiOperation || null,
    backgroundCleanupStatus: asset?.backgroundCleanupStatus || null,
    compositeCleanupStatus: asset?.compositeCleanupStatus || null
  };
}

function restoreSliceTransparencyState(asset) {
  const restoreDataUrl = getSliceTransparencyRestoreDataUrl(asset);
  if (!asset || !restoreDataUrl) return false;
  const restoreState = asset.transparencyRestoreState;
  asset.dataUrl = restoreDataUrl;
  asset.transparentDataUrl = null;
  asset.aiTransparentDataUrl = null;
  asset.aiTransparentPlacement = null;
  asset.transparent = false;
  asset.aiTransparent = false;
  if (restoreState) {
    asset.aiCompleted = Boolean(restoreState.aiCompleted);
    asset.aiRedrawn = Boolean(restoreState.aiRedrawn);
    asset.svgData = restoreState.svgData || null;
    asset.aiRedrawnPlacement = restoreState.aiRedrawnPlacement
      ? { ...restoreState.aiRedrawnPlacement }
      : null;
    asset.lastAiOperation = restoreState.lastAiOperation || null;
    asset.backgroundCleanupStatus = restoreState.backgroundCleanupStatus || null;
    asset.compositeCleanupStatus = restoreState.compositeCleanupStatus || null;
  } else if (asset.lastAiOperation === "transparent") {
    asset.lastAiOperation = null;
  }
  delete asset.transparencyRestoreState;
  delete asset.transparencyRestoreDataUrl;
  delete asset.aiTransparentChildSignature;
  delete asset.aiTransparentExcludedChildCount;
  delete asset.cutoutMethod;
  delete asset.cutoutMaskDataUrl;
  delete asset.cutoutSettings;
  delete asset.cutoutSessionSourceSignature;
  restoreSliceGeometryState(asset, restoreState?.geometryState);
  return true;
}

function applySliceTransparencyResult(asset, { dataUrl, ai = false } = {}) {
  if (!asset || !dataUrl) return false;
  const restoreState = createSliceTransparencyRestoreState(asset);
  asset.transparencyRestoreState = restoreState;
  asset.dataUrl = dataUrl;
  asset.transparentDataUrl = ai ? null : dataUrl;
  asset.aiTransparentDataUrl = ai ? dataUrl : null;
  asset.aiTransparentPlacement = ai && asset.placement ? { ...asset.placement } : null;
  asset.transparent = true;
  asset.aiTransparent = Boolean(ai);
  asset.aiRedrawn = false;
  asset.svgData = null;
  asset.aiRedrawnPlacement = null;
  asset.lastAiOperation = ai ? "transparent" : getSliceBaseAiOperation(asset, restoreState);
  if (!ai) {
    delete asset.aiTransparentChildSignature;
    delete asset.aiTransparentExcludedChildCount;
    delete asset.cutoutMethod;
    delete asset.cutoutMaskDataUrl;
    delete asset.cutoutSettings;
    delete asset.cutoutSessionSourceSignature;
  }
  return true;
}

function createSliceSvgRestoreState(asset) {
  if (asset?.svgRestoreState) {
    return {
      ...asset.svgRestoreState,
      aiRedrawnPlacement: asset.svgRestoreState.aiRedrawnPlacement
        ? { ...asset.svgRestoreState.aiRedrawnPlacement }
        : null
    };
  }
  return {
    svgData: asset?.svgData || null,
    aiRedrawn: Boolean(asset?.aiRedrawn),
    aiRedrawnPlacement: asset?.aiRedrawnPlacement ? { ...asset.aiRedrawnPlacement } : null,
    lastAiOperation: asset?.lastAiOperation || null
  };
}

function applySliceSvgResult(asset, { svgData, ai = false } = {}) {
  if (!asset || !String(svgData || "").trim()) return false;
  const restoreState = createSliceSvgRestoreState(asset);
  asset.svgRestoreState = restoreState;
  asset.svgData = svgData;
  asset.aiRedrawn = Boolean(ai);
  asset.aiRedrawnPlacement = ai && asset.placement ? { ...asset.placement } : null;
  asset.lastAiOperation = ai ? "redrawSvg" : getSliceBaseAiOperation(asset, restoreState);
  return true;
}

function restoreSliceSvgState(asset) {
  if (!asset) return false;
  const restoreState = asset.svgRestoreState;
  asset.svgData = restoreState?.svgData || null;
  asset.aiRedrawn = Boolean(restoreState?.aiRedrawn);
  asset.aiRedrawnPlacement = restoreState?.aiRedrawnPlacement
    ? { ...restoreState.aiRedrawnPlacement }
    : null;
  asset.lastAiOperation = restoreState
    ? restoreState.lastAiOperation || getSliceBaseAiOperation(asset)
    : getSliceBaseAiOperation(asset);
  delete asset.svgRestoreState;
  return true;
}

function createSliceImageProcessingRestoreState(asset) {
  if (asset?.imageProcessingRestoreState?.dataUrl) {
    return { ...asset.imageProcessingRestoreState };
  }
  return {
    dataUrl: asset?.dataUrl || "",
    geometryState: captureSliceGeometryState(asset),
    svgData: asset?.svgData || null,
    aiRedrawn: Boolean(asset?.aiRedrawn),
    aiRedrawnPlacement: asset?.aiRedrawnPlacement ? { ...asset.aiRedrawnPlacement } : null,
    lastAiOperation: asset?.lastAiOperation || null
  };
}

function applySliceImageProcessingResult(asset, result = {}) {
  if (!asset || !result.dataUrl) return false;
  asset.imageProcessingRestoreState = createSliceImageProcessingRestoreState(asset);
  asset.dataUrl = result.dataUrl;
  asset.svgData = null;
  asset.aiRedrawn = false;
  asset.aiRedrawnPlacement = null;
  if (result.operation === "inpaint") {
    asset.localInpaintMethod = "iopaint-lama";
    asset.localInpaintMaskDataUrl = result.maskDataUrl || null;
    asset.localInpaintSourceSignature = result.sourceSignature || "";
    asset.localInpaintDataUrl = result.dataUrl;
    asset.lastAiOperation = "localInpaint";
  }
  if (result.operation === "upscale") {
    asset.upscaleMethod = "realesrgan-x4plus-anime-6b";
    asset.upscaleScale = Number(result.scale) || 2;
    asset.sourcePixelWidth = Number(result.sourcePixelWidth) || null;
    asset.sourcePixelHeight = Number(result.sourcePixelHeight) || null;
    asset.outputPixelWidth = Number(result.outputPixelWidth) || null;
    asset.outputPixelHeight = Number(result.outputPixelHeight) || null;
    asset.lastAiOperation = "localUpscale";
  }
  return true;
}

function restoreSliceImageProcessingState(asset) {
  const restoreState = asset?.imageProcessingRestoreState;
  if (!asset || !restoreState?.dataUrl) return false;
  asset.dataUrl = restoreState.dataUrl;
  asset.svgData = restoreState.svgData || null;
  asset.aiRedrawn = Boolean(restoreState.aiRedrawn);
  asset.aiRedrawnPlacement = restoreState.aiRedrawnPlacement
    ? { ...restoreState.aiRedrawnPlacement }
    : null;
  asset.lastAiOperation = restoreState.lastAiOperation || null;
  clearSliceImageProcessingState(asset);
  restoreSliceGeometryState(asset, restoreState.geometryState);
  return true;
}

function clearSliceImageProcessingState(asset) {
  if (!asset) return;
  delete asset.regeneration;
  delete asset.imageProcessingRestoreState;
  delete asset.localInpaintMethod;
  delete asset.localInpaintMaskDataUrl;
  delete asset.localInpaintSourceSignature;
  delete asset.localInpaintDataUrl;
  delete asset.upscaleMethod;
  delete asset.upscaleScale;
  delete asset.sourcePixelWidth;
  delete asset.sourcePixelHeight;
  delete asset.outputPixelWidth;
  delete asset.outputPixelHeight;
  delete asset.trimmed;
  delete asset.trimPositionVersion;
}

function getProcessedSliceResetMessage(asset) {
  const name = asset?.name || "切图资产";
  if (asset?.regeneration) return `“${name}”已有 AI 重新生成结果，调整切图将取消该结果，是否继续？`;
  const hasTransparent = Boolean(asset?.aiTransparent);
  const hasSvg = Boolean(asset?.aiRedrawn);
  if (asset?.localInpaintMethod || asset?.upscaleMethod) {
    return `“${name}”已有本地图像处理结果，调整切图将取消修复或高清化，是否继续？`;
  }
  if (hasTransparent && hasSvg) {
    return `“${name}”已被透明化并转为 SVG，调整切图将取消透明和 SVG，是否继续？`;
  }
  if (hasTransparent) {
    return `“${name}”已被透明化，调整切图将取消透明，是否继续？`;
  }
  if (hasSvg) {
    return `“${name}”已被转为 SVG，调整切图将取消 SVG，是否继续？`;
  }
  return `“${name}”已被处理，调整切图将取消处理结果，是否继续？`;
}

if (typeof module !== "undefined") {
  module.exports = {
    recoverLegacySliceTrimPosition,
    restoreSliceInitialPosition,
    applySliceTrimResult,
    slicePlacementSignature,
    applySliceSvgResult,
    applySliceImageProcessingResult,
    applySliceTransparencyResult,
    createSliceImageProcessingRestoreState,
    clearSliceImageProcessingState,
    createSliceTransparencyRestoreState,
    getSliceActiveImageDataUrl,
    getSliceTransparencyRestoreDataUrl,
    getSliceTransparencySourceDataUrl,
    getProcessedSliceResetMessage,
    hasProcessedSliceResult,
    shouldPreserveProcessedSliceResult,
    shouldRefreshSliceCropAfterPositionRestore,
    isLockedAiCompleteAsset,
    restoreSliceSvgState,
    restoreSliceImageProcessingState,
    restoreSliceTransparencyState
  };
}
