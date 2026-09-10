import type { SliceAsset } from '../types/workspace';
// A new crop invalidates all image-coordinate caches but not user identity or design metadata.
export function replaceSliceCrop(asset: SliceAsset, dataUrl: string) {
  for (const key of Object.keys(asset)) if (/^(cutout|localInpaint|upscale|trim|aiTransparent|aiCompleted|aiRedrawn|transparent|transparencyRestore|imageProcessingRestore|svgRestore|sourcePixel|outputPixel)/.test(key)) delete asset[key];
  delete asset.regeneration; delete asset.lastAiOperation;
  asset.svgData = null; asset.dataUrl = dataUrl; asset.originalDataUrl = dataUrl;
}
