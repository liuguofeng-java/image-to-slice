const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCompositeSliceDisplayTree,
  getCompositeImportState,
  getDirectChildRemovalRegions,
  getDirectChildRemovalSignature,
  inferSmallestContainingBackgroundId,
  isAiTransparentChildCleanupCurrent,
  isValidSliceParent,
  normalizeCompositeSliceLayers,
  normalizeSliceTextDefinition
} = require("../src/ui/state/composite-slice-layers");

test("legacy slices migrate to image layers", () => {
  const [layer] = normalizeCompositeSliceLayers([{ id: "legacy", placement: { x: 0, y: 0, width: 20, height: 20 } }]);
  assert.equal(layer.contentType, "image");
  assert.equal(layer.parentId, null);
});

test("smallest containing background or image becomes the automatic parent", () => {
  const child = { id: "shoe", placement: { x: 30, y: 30, width: 20, height: 20 } };
  const layers = [
    { id: "large", contentType: "background", placement: { x: 0, y: 0, width: 100, height: 100 } },
    { id: "small", contentType: "background", placement: { x: 20, y: 20, width: 50, height: 50 } }
  ];
  assert.equal(inferSmallestContainingBackgroundId(child, layers), "small");
  assert.equal(inferSmallestContainingBackgroundId(child, [
    { id: "tile", contentType: "image", placement: { x: 25, y: 25, width: 40, height: 40 } }
  ]), "tile");
});

test("composite display tree places parents before indented children", () => {
  const layers = [
    { id: "background", contentType: "background" },
    { id: "first-label", contentType: "text", parentId: "background" },
    { id: "tile", contentType: "image" },
    { id: "tile-label", contentType: "text", parentId: "tile" }
  ];
  assert.deepEqual(buildCompositeSliceDisplayTree(layers).map(({ layer, depth, childCount }) => ({
    id: layer.id,
    depth,
    childCount
  })), [
    { id: "tile", depth: 0, childCount: 1 },
    { id: "tile-label", depth: 1, childCount: 0 },
    { id: "background", depth: 0, childCount: 1 },
    { id: "first-label", depth: 1, childCount: 0 }
  ]);
});

test("parent validation rejects cycles and non-containing parents", () => {
  const layers = [
    { id: "a", contentType: "background", parentId: "b", placement: { x: 0, y: 0, width: 100, height: 100 } },
    { id: "b", contentType: "background", parentId: "a", placement: { x: 10, y: 10, width: 60, height: 60 } },
    { id: "outside", contentType: "image", placement: { x: 120, y: 120, width: 10, height: 10 } }
  ];
  assert.equal(isValidSliceParent(layers[1], "a", layers), false);
  assert.equal(isValidSliceParent(layers[2], "a", layers), false);
});

test("import state skips unclassified and warns about pending backgrounds", () => {
  const layers = [
    { id: "bg", contentType: "background", backgroundCleanupStatus: "pending" },
    { id: "unknown", contentType: "unclassified" },
    { id: "text", contentType: "text", text: { characters: "鞋子" } }
  ];
  const state = getCompositeImportState(layers);
  assert.deepEqual(state.importable.map((layer) => layer.id), ["bg", "text"]);
  assert.deepEqual(state.unclassified.map((layer) => layer.id), ["unknown"]);
  assert.deepEqual(state.dirtyBackgrounds.map((layer) => layer.id), ["bg"]);
});

test("text definitions preserve editable visual properties", () => {
  const text = normalizeSliceTextDefinition({
    characters: "鞋子",
    fontSize: 28,
    fontWeight: 800,
    color: "#ffffff",
    strokeColor: "#123456",
    strokeWidth: 2,
    shadow: { color: "#000000", opacity: 0.5, x: 1, y: 3, blur: 5 }
  }, { height: 40 });
  assert.equal(text.characters, "鞋子");
  assert.equal(text.color, "#FFFFFF");
  assert.equal(text.strokeWidth, 2);
  assert.deepEqual(text.shadow, { color: "#000000", opacity: 0.5, x: 1, y: 3, blur: 5 });
});

test("background cleanup uses confirmed direct children", () => {
  const parent = { id: "card", placement: { x: 10, y: 10, width: 100, height: 100 } };
  const regions = getDirectChildRemovalRegions(parent, [
    { id: "shoe", parentId: "card", contentType: "image", placement: { x: 30, y: 20, width: 30, height: 30 } },
    { id: "label", parentId: "card", contentType: "text", placement: { x: 25, y: 60, width: 40, height: 20 } },
    { id: "draft", parentId: "card", contentType: "unclassified", placement: { x: 10, y: 10, width: 5, height: 5 } }
  ]);
  assert.deepEqual(regions, [
    { x: 30, y: 20, width: 30, height: 30 },
    { x: 25, y: 60, width: 40, height: 20 }
  ]);
});

test("AI transparent parent cleanup becomes stale when a child region changes", () => {
  const parent = {
    id: "card",
    aiTransparent: true,
    aiTransparentChildSignature: "label:25:60:40:20",
    placement: { x: 10, y: 10, width: 100, height: 100 }
  };
  const layers = [
    parent,
    { id: "label", parentId: "card", contentType: "text", placement: { x: 25, y: 60, width: 40, height: 20 } }
  ];
  assert.equal(getDirectChildRemovalSignature(parent, layers), "label:25:60:40:20");
  assert.equal(isAiTransparentChildCleanupCurrent(parent, layers), true);
  layers[1].placement.x = 30;
  assert.equal(isAiTransparentChildCleanupCurrent(parent, layers), false);
});
