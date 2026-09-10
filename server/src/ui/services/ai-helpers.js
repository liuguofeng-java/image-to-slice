function createAiProgressId(prefix = "ai") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function buildAiTransparentPrompt() {
  return [
    "Use the attached image as the only source of truth.",
    "Only remove the background and make it transparent.",
    "Preserve the subject's shape, colors, proportions, angle, shadows, antialiased edges, composition, and canvas size exactly.",
    "Do not redraw, regenerate, complete, replace, crop, resize, reposition, recolor, or add anything.",
    "Output one transparent PNG with the original canvas dimensions."
  ].join("\n");
}

function buildCompositeParentCleanupPrompt(asset, regions) {
  const localRegions = (Array.isArray(regions) ? regions : []).map((region) => ({
    x: Math.round(region.x - asset.placement.x),
    y: Math.round(region.y - asset.placement.y),
    width: Math.round(region.width),
    height: Math.round(region.height)
  }));
  return [
    `Create a clean reusable parent background from the sliced asset named "${asset?.name || "ui_asset"}".`,
    "The white mask rectangles are confirmed child layers that will be placed separately.",
    `Remove every child-layer pixel inside these slice-local rectangles: ${JSON.stringify(localRegions)}.`,
    "Inside the rectangles, reconstruct only the parent background by continuing its colors, gradient, border, glow, texture, lighting, and perspective.",
    "Do not keep, redraw, regenerate, or invent any text, icon, product image, symbol, label, or foreground object inside the masked rectangles.",
    "Outside the rectangles, preserve the source pixels exactly. Keep the original canvas dimensions and avoid seams, halos, duplicated content, and rectangular patch edges."
  ].join("\n");
}

function buildAiCompletePrompt(asset, regions) {
  const localRegions = regions.map((region) => ({
    x: Math.round(region.x - asset.placement.x),
    y: Math.round(region.y - asset.placement.y),
    width: Math.round(region.width),
    height: Math.round(region.height)
  }));
  return [
    `Restore the background hidden by foreground UI slices in the image named "${asset?.name || "ui_asset"}".`,
    "Reference image 1 is the current slice with the reconstruction area already cleared to transparent pixels.",
    "Reference image 2 is a black-and-white mask aligned pixel-for-pixel with image 1. Reconstruct only the white pixels; black pixels are context and must remain unchanged.",
    `Only reconstruct these slice-local rectangles: ${JSON.stringify(localRegions)}.`,
    "Inside those rectangles, remove the overlapping foreground elements and infer the original background from the surrounding pixels, continuing colors, textures, gradients, lighting, perspective, and background details naturally.",
    "Match the protected source pixels' white balance, color temperature, tint, exposure, gamma, contrast, saturation, black point, and white point exactly.",
    "Do not apply global relighting, HDR, auto-enhancement, cinematic grading, sharpening, or color styling.",
    "Outside those rectangles, reproduce the input pixels unchanged. Do not redesign, crop, resize, reposition, sharpen, recolor, or add any object or text.",
    "Return one image at the same canvas size and preserve the original background and opacity. Avoid seams, halos, duplicated elements, or rectangular patch edges."
  ].join("\n");
}

function buildBackgroundRestorePrompt(background) {
  const width = Math.max(1, Math.round(Number(background?.bbox?.width) || 1));
  const height = Math.max(1, Math.round(Number(background?.bbox?.height) || 1));
  const bakedVisuals = (Array.isArray(background?.bakedVisuals) ? background.bakedVisuals : [])
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  const regions = (Array.isArray(background?.regions) ? background.regions : []).map((region) => ({
    x: Math.round(Number(region.x) || 0),
    y: Math.round(Number(region.y) || 0),
    width: Math.max(1, Math.round(Number(region.width) || 1)),
    height: Math.max(1, Math.round(Number(region.height) || 1))
  }));
  return [
    `Restore the complete reusable UI background named "${background?.name || "complete_background"}".`,
    "Reference image 1 is the original background crop with confirmed interface-overlay areas already cleared to transparent pixels.",
    "Reference image 2 is a black-and-white mask aligned pixel-for-pixel with image 1. Reconstruct only the white pixels; black pixels are protected source pixels.",
    `The following baked visual content is part of the background and must remain unchanged: ${bakedVisuals.length ? bakedVisuals.join("; ") : "all unmasked artwork, artistic text, integrated branding, scenery, and decoration"}.`,
    `Only reconstruct these slice-local rectangles: ${JSON.stringify(regions)}.`,
    "Remove only the confirmed foreground interface overlays inside those rectangles. Continue the underlying texture, illustration, lighting, perspective, borders, and decorative details naturally.",
    "Match the protected source pixels' white balance, color temperature, tint, exposure, gamma, contrast, saturation, black point, and white point exactly.",
    "Do not apply global relighting, HDR, auto-enhancement, cinematic grading, sharpening, or color styling.",
    "Outside those rectangles, reproduce the input pixels unchanged. Do not remove or rewrite artistic text, calligraphy, integrated branding, illustrations, products, scenery, or decoration.",
    `Return one image at the same ${width}x${height} canvas size. Avoid seams, halos, duplicated controls, or rectangular patch edges.`
  ].join("\n");
}

export {
    buildAiCompletePrompt,
    buildAiTransparentPrompt,
    buildCompositeParentCleanupPrompt,
    buildBackgroundRestorePrompt,
    createAiProgressId
  };
