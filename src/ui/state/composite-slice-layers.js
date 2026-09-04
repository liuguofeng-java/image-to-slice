const SLICE_CONTENT_TYPES = new Set(["unclassified", "background", "image", "text"]);

function normalizeSliceContentType(value, fallback = "image") {
  const normalized = String(value || "").trim().toLowerCase();
  return SLICE_CONTENT_TYPES.has(normalized) ? normalized : fallback;
}

function normalizeSliceTextDefinition(value = {}, placement = {}) {
  const fontSize = clampLayerNumber(value.fontSize, 8, 160, Math.max(12, Math.round(Number(placement.height) * 0.7) || 16));
  return {
    characters: String(value.characters ?? value.text ?? "").slice(0, 4000),
    fontFamily: String(value.fontFamily || "").trim().slice(0, 120),
    fontWeight: clampLayerNumber(value.fontWeight, 100, 900, 600),
    fontSize,
    lineHeight: clampLayerNumber(value.lineHeight, fontSize, 240, Math.round(fontSize * 1.2)),
    letterSpacing: clampLayerNumber(value.letterSpacing, -20, 100, 0),
    color: normalizeHexColor(value.color, "#FFFFFF"),
    textAlignHorizontal: ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"].includes(String(value.textAlignHorizontal || "").toUpperCase())
      ? String(value.textAlignHorizontal).toUpperCase()
      : "CENTER",
    strokeColor: normalizeHexColor(value.strokeColor, "#000000"),
    strokeWidth: clampLayerNumber(value.strokeWidth, 0, 24, 0),
    shadow: normalizeSliceTextShadow(value.shadow)
  };
}

function normalizeSliceTextShadow(value) {
  if (!value || typeof value !== "object") return null;
  return {
    color: normalizeHexColor(value.color, "#000000"),
    opacity: clampLayerNumber(value.opacity, 0, 1, 0.35),
    x: clampLayerNumber(value.x, -100, 100, 0),
    y: clampLayerNumber(value.y, -100, 100, 2),
    blur: clampLayerNumber(value.blur, 0, 100, 4)
  };
}

function normalizeCompositeSliceLayers(layers = []) {
  const normalized = (Array.isArray(layers) ? layers : []).map((layer) => {
    const contentType = normalizeSliceContentType(layer?.contentType, "image");
    return {
      ...layer,
      contentType,
      parentId: typeof layer?.parentId === "string" && layer.parentId.trim() ? layer.parentId.trim() : null,
      ...(contentType === "text" ? { text: normalizeSliceTextDefinition(layer?.text, layer?.placement) } : {})
    };
  });
  const byId = new Map(normalized.map((layer) => [String(layer?.id || ""), layer]));
  for (const layer of normalized) {
    if (!isValidSliceParent(layer, layer.parentId, byId)) layer.parentId = null;
  }
  return normalized;
}

function inferSmallestContainingBackgroundId(layer, layers = []) {
  if (!layer?.placement) return null;
  return (Array.isArray(layers) ? layers : [])
    .filter((candidate) => candidate?.id !== layer.id
      && isCompositeSliceParentType(candidate?.contentType)
      && containsSlicePlacement(candidate.placement, layer.placement)
      && slicePlacementArea(candidate.placement) > slicePlacementArea(layer.placement))
    .sort((left, right) => slicePlacementArea(left.placement) - slicePlacementArea(right.placement))[0]?.id || null;
}

function isCompositeSliceParentType(contentType) {
  return ["background", "image"].includes(normalizeSliceContentType(contentType, "image"));
}

function isValidSliceParent(layer, parentId, layersOrMap = []) {
  if (!parentId || !layer?.id || parentId === layer.id) return false;
  const byId = layersOrMap instanceof Map
    ? layersOrMap
    : new Map((Array.isArray(layersOrMap) ? layersOrMap : []).map((entry) => [String(entry?.id || ""), entry]));
  const parent = byId.get(String(parentId));
  if (!parent || !isCompositeSliceParentType(parent.contentType)) return false;
  if (!containsSlicePlacement(parent.placement, layer.placement)) return false;
  const visited = new Set([String(layer.id)]);
  let cursor = parent;
  while (cursor) {
    const id = String(cursor.id || "");
    if (visited.has(id)) return false;
    visited.add(id);
    cursor = cursor.parentId ? byId.get(String(cursor.parentId)) : null;
  }
  return true;
}

function buildCompositeSliceDisplayTree(layers = []) {
  const source = Array.isArray(layers) ? layers : [];
  const byId = new Map(source.map((layer) => [String(layer?.id || ""), layer]));
  const childrenByParent = new Map();
  const roots = [];

  for (const layer of source) {
    const parentId = String(layer?.parentId || "");
    if (!parentId || !byId.has(parentId)) {
      roots.push(layer);
      continue;
    }
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(layer);
  }

  const entries = [];
  const visited = new Set();
  const appendBranch = (layer, depth) => {
    const id = String(layer?.id || "");
    if (!id || visited.has(id)) return;
    visited.add(id);
    const children = [...(childrenByParent.get(id) || [])].reverse();
    entries.push({ layer, depth, childCount: children.length });
    children.forEach((child) => appendBranch(child, depth + 1));
  };

  [...roots].reverse().forEach((layer) => appendBranch(layer, 0));
  [...source].reverse().forEach((layer) => appendBranch(layer, 0));
  return entries;
}

function containsSlicePlacement(parent, child) {
  if (![parent, child].every((value) => value && [value.x, value.y, value.width, value.height].every(Number.isFinite))) return false;
  return child.x >= parent.x
    && child.y >= parent.y
    && child.x + child.width <= parent.x + parent.width
    && child.y + child.height <= parent.y + parent.height;
}

function getCompositeImportState(layers = []) {
  const importable = [];
  const unclassified = [];
  const dirtyBackgrounds = [];
  for (const layer of Array.isArray(layers) ? layers : []) {
    if (layer?.hidden || layer?.selected === false) continue;
    const contentType = normalizeSliceContentType(layer?.contentType, "image");
    if (contentType === "unclassified") {
      unclassified.push(layer);
      continue;
    }
    if (contentType === "text" && !String(layer?.text?.characters || "").trim()) {
      unclassified.push(layer);
      continue;
    }
    if (contentType === "background" && layer?.backgroundCleanupStatus === "pending") dirtyBackgrounds.push(layer);
    importable.push(layer);
  }
  return { importable, unclassified, dirtyBackgrounds };
}

function getDirectChildRemovalRegions(parent, layers = []) {
  if (!parent?.placement) return [];
  return getDirectChildRemovalLayers(parent, layers)
    .map((layer) => ({
      x: layer.placement.x,
      y: layer.placement.y,
      width: layer.placement.width,
      height: layer.placement.height
    }));
}

function getDirectChildRemovalSignature(parent, layers = []) {
  return getDirectChildRemovalLayers(parent, layers)
    .map((layer) => {
      const placement = layer.placement || {};
      return [layer.id, placement.x, placement.y, placement.width, placement.height].join(":");
    })
    .sort()
    .join("|");
}

function isAiTransparentChildCleanupCurrent(parent, layers = []) {
  if (!parent?.aiTransparent) return false;
  const currentSignature = getDirectChildRemovalSignature(parent, layers);
  if (!("aiTransparentChildSignature" in parent)) return currentSignature === "";
  return String(parent.aiTransparentChildSignature || "") === currentSignature;
}

function getDirectChildRemovalLayers(parent, layers = []) {
  if (!parent?.placement) return [];
  return (Array.isArray(layers) ? layers : [])
    .filter((layer) => layer?.parentId === parent.id
      && !layer.hidden
      && normalizeSliceContentType(layer.contentType, "image") !== "unclassified"
      && layer.placement);
}

function slicePlacementArea(value = {}) {
  return Math.max(0, Number(value.width) || 0) * Math.max(0, Number(value.height) || 0);
}

function normalizeHexColor(value, fallback) {
  const color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : fallback;
}

function clampLayerNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

if (typeof module !== "undefined") {
  module.exports = {
    SLICE_CONTENT_TYPES,
    buildCompositeSliceDisplayTree,
    containsSlicePlacement,
    getCompositeImportState,
    getDirectChildRemovalRegions,
    getDirectChildRemovalSignature,
    inferSmallestContainingBackgroundId,
    isAiTransparentChildCleanupCurrent,
    isCompositeSliceParentType,
    isValidSliceParent,
    normalizeCompositeSliceLayers,
    normalizeSliceContentType,
    normalizeSliceTextDefinition
  };
}
