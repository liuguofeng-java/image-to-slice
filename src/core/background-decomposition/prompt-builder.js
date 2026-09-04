function buildBackgroundDecompositionPrompt({ width, height, sourceImageName }) {
  return [
    "Analyze the attached UI screenshot and return both reusable PNG crops and reusable visual background restoration plans.",
    `Source image: ${sourceImageName || "source-ui.png"}.`,
    `All bbox values must use original ${width}x${height} image pixel coordinates. Do not normalize to 750px or percentages.`,
    "For assets, use only these kind values: icon, avatar, illustration, photo, product-image, complex-decoration, complex-chart, logo.",
    "For an asset visually contained by a returned background, set parentBackgroundId to that background id; otherwise use null.",
    "Return an asset when its exact raster appearance cannot be reliably reconstructed as ordinary text or simple CSS shapes.",
    "A logo, badge, or illustration containing inseparable artistic text may be returned as one complete PNG crop.",
    "Do not return ordinary UI text, button backgrounds, cards, dividers, simple rectangles, circles, or layout containers as assets.",
    "Do not merge visually independent assets merely because their boxes overlap. Preserve source reading order.",
    "Give every asset and background a specific semantic English name in lowercase snake_case, such as woodcarving_course_cover or old_street_hero_background.",
    "Names must not contain Chinese, spaces, hyphens, file extensions, or generic labels such as asset_01. Use slice_01 only when the visual meaning truly cannot be identified.",
    "Find continuous illustrated, photographic, textured, or decorative background regions that are partially covered by obvious interface controls.",
    "Preserve baked visual content inside each background: illustrations, scenery, products, decorative frames, artistic text, calligraphy, campaign lettering, and integrated branding.",
    "Classify only obvious foreground UI as code-overlay: navigation controls, ordinary buttons, cards, menus, tabs, form controls, checkboxes, and ordinary interface text placed over the background.",
    "Use raster-overlay only for a visually independent foreground bitmap that cannot be accurately rebuilt with text, CSS, or a simple vector icon.",
    "An independent raster-overlay may also appear in assets when it should be preserved as a reusable PNG crop.",
    "Do not mark artistic text or integrated branding as an overlay merely because it contains readable characters.",
    "Each overlay bbox must intersect its parent background bbox.",
    "Only detect editable ordinary text inside one of the returned background regions. Never scan or return ordinary text outside those backgrounds.",
    "Return each such text in texts with its exact characters, parentBackgroundId, bbox, confidence, and editable style. Do not also return the same text as a raster asset or overlay.",
    "Return one JSON object with this shape:",
    '{"assets":[{"name":"specific_english_asset_name","kind":"icon","parentBackgroundId":"background_01","bbox":{"x":0,"y":0,"width":8,"height":8},"confidence":0.0,"containsEmbeddedText":false,"reason":"why raster is required"}],"texts":[{"id":"text_01","name":"shoe_label","parentBackgroundId":"background_01","bbox":{"x":0,"y":0,"width":40,"height":20},"confidence":0.0,"reason":"ordinary editable text","text":{"characters":"鞋子","fontSize":20,"fontWeight":700,"fontFamily":"sans-serif","lineHeight":24,"letterSpacing":0,"color":"#ffffff","textAlignHorizontal":"CENTER","strokeColor":"#000000","strokeWidth":1,"shadow":{"color":"#000000","opacity":0.4,"x":0,"y":2,"blur":4}}}],"backgrounds":[{"id":"background_01","name":"specific_english_background_name","bbox":{"x":0,"y":0,"width":100,"height":100},"confidence":0.0,"reason":"why this is a reusable background","bakedVisuals":["content that must remain"],"overlays":[{"id":"overlay_01","name":"overlay name","kind":"code-overlay","bbox":{"x":0,"y":0,"width":20,"height":20},"confidence":0.0,"reason":"why this is placed above the background"}]}]}',
    "Return an empty assets array when no reusable PNG crop exists.",
    "Return an empty backgrounds array when no reusable covered background exists.",
    "Return an empty texts array when no editable ordinary text exists inside returned backgrounds.",
    "Return JSON only. Do not include Markdown or explanations outside the JSON object."
  ].join("\n");
}

function buildBackgroundDecompositionJsonRepairPrompt(rawText) {
  return [
    "Repair the following model output without adding, deleting, merging, or deduplicating asset, background, or overlay entries.",
    "Return one valid JSON object only with an assets array, a texts array, and a backgrounds array, preserving the original values whenever recoverable.",
    String(rawText || "")
  ].join("\n\n");
}

module.exports = {
  buildBackgroundDecompositionPrompt,
  buildBackgroundDecompositionJsonRepairPrompt
};
