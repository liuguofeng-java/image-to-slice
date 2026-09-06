function hasProcessedSliceResult(asset) {
  return Boolean(asset?.transparent || asset?.aiTransparent || asset?.aiRedrawn || asset?.localInpaintMethod || asset?.upscaleMethod);
}

function shouldPreserveProcessedSliceResult(asset, geometryChange) {
  return hasProcessedSliceResult(asset) && ["move", "x", "y"].includes(String(geometryChange || ""));
}

function shouldRefreshSliceCropAfterPositionRestore(asset) {
  return !isLockedAiCompleteAsset(asset) && !shouldPreserveProcessedSliceResult(asset, "move");
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
  return true;
}

function clearSliceImageProcessingState(asset) {
  if (!asset) return;
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
}

function getProcessedSliceResetMessage(asset) {
  const name = asset?.name || "切图资产";
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
