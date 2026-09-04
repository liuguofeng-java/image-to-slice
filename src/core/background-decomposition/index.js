const {
  ALLOWED_BACKGROUND_OVERLAY_KINDS,
  MAX_BACKGROUND_CANDIDATES,
  MAX_BACKGROUND_OVERLAYS,
  MIN_BACKGROUND_SIZE,
  MIN_OVERLAY_SIZE
} = require("./constants");
const {
  buildBackgroundDecompositionPrompt,
  buildBackgroundDecompositionJsonRepairPrompt
} = require("./prompt-builder");
const {
  parseBackgroundDecompositionText
} = require("./result-parser");
const {
  parseSliceAssetDetectionText
} = require("../slice-detection");

function parseUiDecompositionText(text, dimensions) {
  const assetResult = parseSliceAssetDetectionText(text, dimensions);
  const backgroundResult = parseBackgroundDecompositionText(text, dimensions);
  const backgroundById = new Map(backgroundResult.backgrounds.map((background) => [background.id, background]));
  return {
    ...assetResult,
    assets: assetResult.assets.map((asset) => {
      const parent = asset.parentBackgroundId ? backgroundById.get(asset.parentBackgroundId) : null;
      return {
        ...asset,
        parentBackgroundId: parent && containsBox(parent.bbox, asset.bbox) ? parent.id : null
      };
    }),
    ...backgroundResult
  };
}

function containsBox(parent, child) {
  return child.x >= parent.x
    && child.y >= parent.y
    && child.x + child.width <= parent.x + parent.width
    && child.y + child.height <= parent.y + parent.height;
}

module.exports = {
  ALLOWED_BACKGROUND_OVERLAY_KINDS,
  MAX_BACKGROUND_CANDIDATES,
  MAX_BACKGROUND_OVERLAYS,
  MIN_BACKGROUND_SIZE,
  MIN_OVERLAY_SIZE,
  buildBackgroundDecompositionPrompt,
  buildBackgroundDecompositionJsonRepairPrompt,
  parseBackgroundDecompositionText,
  parseUiDecompositionText
};
