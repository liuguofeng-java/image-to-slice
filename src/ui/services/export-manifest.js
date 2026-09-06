const exportManifestReserveSliceAssetName = typeof require === "function"
  ? require("../../core/slice-asset-name").reserveSliceAssetName
  : reserveSliceAssetName;

function buildSliceExportManifest({
  manifest,
  activeImage,
  imageIndex,
  getSliceRadius,
  getSliceRadii
}) {
  const screen = manifest.screen;
  const usedNames = new Set();
  const assets = activeImage.sliceManifest.assets.map((asset) => {
    const basename = exportManifestReserveSliceAssetName(asset.name, usedNames);
    const contentType = String(asset.contentType || "image");
    const isText = contentType === "text";
    const filename = isText ? null : `assets/${basename}.png`;
    return {
      id: asset.id,
      name: basename,
      filename,
      svgFilename: !isText && asset.svgData ? filename.replace(/\.png$/, ".svg") : null,
      format: isText ? "text" : "png",
      formats: isText ? ["text"] : (asset.svgData ? ["png", "svg"] : ["png"]),
      contentType,
      parentId: asset.parentId || null,
      ...(isText ? { text: { ...(asset.text || {}) } } : {}),
      transparent: Boolean(asset.transparent),
      aiTransparent: Boolean(asset.aiTransparent),
      ...(asset.cutoutMethod ? {
        cutoutMethod: asset.cutoutMethod,
        cutoutMaskDataUrl: asset.cutoutMaskDataUrl || null,
        cutoutSettings: asset.cutoutSettings ? { ...asset.cutoutSettings } : null,
        cutoutSessionSourceSignature: asset.cutoutSessionSourceSignature || ""
      } : {}),
      ...(asset.localInpaintMethod ? {
        localInpaintMethod: asset.localInpaintMethod,
        localInpaintSourceSignature: asset.localInpaintSourceSignature || ""
      } : {}),
      ...(asset.upscaleMethod ? {
        upscaleMethod: asset.upscaleMethod,
        upscaleScale: Number(asset.upscaleScale) || 2,
        sourcePixelWidth: Number(asset.sourcePixelWidth) || null,
        sourcePixelHeight: Number(asset.sourcePixelHeight) || null,
        outputPixelWidth: Number(asset.outputPixelWidth) || null,
        outputPixelHeight: Number(asset.outputPixelHeight) || null
      } : {}),
      aiRedrawn: Boolean(asset.aiRedrawn),
      hasOriginalRaster: Boolean(asset.originalDataUrl),
      selectedImageIndex: imageIndex,
      radius: getSliceRadius(asset),
      ...(typeof getSliceRadii === "function" && asset.radii
        ? { radii: { ...getSliceRadii(asset) } }
        : {}),
      placement: { ...asset.placement }
    };
  });
  return {
    version: "1.1.0",
    exportedAt: new Date().toISOString(),
    sourcePrompt: manifest.sourcePrompt || "",
    selectedImageIndex: imageIndex,
    screen: {
      name: screen.name,
      width: screen.width,
      height: screen.height
    },
    assets
  };
}

function buildDownloadFilename(index) {
  const paddedIndex = String(index + 1).padStart(2, "0");
  return `gpt-image-${paddedIndex}.png`;
}

function createScreenFromResultImage(image, fallback) {
  const width = Math.round(image?.naturalWidth || fallback.width);
  const height = Math.round(image?.naturalHeight || fallback.height);
  return {
    name: fallback.name,
    width,
    height
  };
}

if (typeof module !== "undefined") {
  module.exports = {
    buildDownloadFilename,
    buildSliceExportManifest,
    createScreenFromResultImage
  };
}
