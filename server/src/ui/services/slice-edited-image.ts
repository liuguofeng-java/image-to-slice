import type { SliceAsset } from '../types/workspace';
import { applySliceImageProcessingResult } from '../state/slice-ai-state.js';

// Pixel editing at the existing resolution is not a new crop: keep trim geometry,
// original source and HD density, while invalidating masks from the previous pixels.
export function replaceSliceEditedImage(asset: SliceAsset, dataUrl: string) {
  applySliceImageProcessingResult(asset, { dataUrl, operation: 'remote-inpaint' });
  for (const key of Object.keys(asset)) if (/^(cutout|localInpaint)/.test(key)) delete asset[key];
  asset.aiTransparent = false; asset.aiTransparentDataUrl = null;
  if (asset.transparent) asset.transparentDataUrl = dataUrl;
  asset.aiCompleted = true; asset.aiCompletedDataUrl = dataUrl;
  asset.aiCompletedPlacement = { ...asset.placement }; asset.lastAiOperation = 'complete';
}
