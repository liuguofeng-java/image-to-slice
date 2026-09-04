const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ALLOWED_BACKGROUND_OVERLAY_KINDS,
  MAX_BACKGROUND_CANDIDATES,
  MAX_BACKGROUND_OVERLAYS,
  buildBackgroundDecompositionPrompt,
  buildBackgroundDecompositionJsonRepairPrompt,
  parseBackgroundDecompositionText,
  parseUiDecompositionText
} = require("../../src/core/background-decomposition");

test("background decomposition prompt preserves integrated artistic content", () => {
  const prompt = buildBackgroundDecompositionPrompt({
    width: 750,
    height: 1624,
    sourceImageName: "login.png"
  });

  assert.match(prompt, /login\.png/);
  assert.match(prompt, /750x1624/);
  assert.match(prompt, /artistic text/i);
  assert.match(prompt, /integrated branding/i);
  assert.match(prompt, /code-overlay/);
  assert.match(prompt, /raster-overlay/);
  assert.match(prompt, /"assets"/);
  assert.match(prompt, /"backgrounds"/);
  assert.match(prompt, /"texts"/);
  assert.match(prompt, /only detect editable ordinary text inside/i);
  assert.match(prompt, /lowercase snake_case/);
  assert.match(prompt, /icon, avatar, illustration, photo, product-image, complex-decoration, complex-chart, logo/);
  assert.match(prompt, /Return JSON only/);
});

test("background decomposition repair prompt preserves entries", () => {
  const prompt = buildBackgroundDecompositionJsonRepairPrompt('{"assets":[],"backgrounds":[]}');

  assert.match(prompt, /Repair the following model output/);
  assert.match(prompt, /without adding, deleting, merging, or deduplicating/i);
  assert.match(prompt, /assets array/i);
  assert.match(prompt, /"backgrounds"/);
});

test("unified decomposition parser returns ordinary assets and covered backgrounds", () => {
  const result = parseUiDecompositionText(JSON.stringify({
    assets: [{
      name: "活动 Logo",
      kind: "logo",
      bbox: { x: 4, y: 6, width: 30, height: 20 },
      confidence: 0.9,
      containsEmbeddedText: true,
      reason: "artistic bitmap"
    }],
    backgrounds: [{
      id: "hero",
      name: "主视觉",
      bbox: { x: 0, y: 0, width: 100, height: 80 },
      overlays: [{
        id: "back",
        name: "返回按钮",
        kind: "code-overlay",
        bbox: { x: 4, y: 4, width: 12, height: 12 }
      }]
    }]
  }), { width: 100, height: 80 });

  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].name, "logo");
  assert.equal(result.backgrounds.length, 1);
  assert.equal(result.backgrounds[0].id, "hero");
});

test("background decomposition parser clamps candidates and overlays", () => {
  const result = parseBackgroundDecompositionText(JSON.stringify({
    backgrounds: [{
      id: "hero",
      name: "old_street_hero_background",
      bbox: { x: -10, y: 5.4, width: 130, height: 110 },
      confidence: 1.4,
      reason: "continuous artwork",
      bakedVisuals: ["端午安康艺术字", "龙舟"],
      overlays: [{
        id: "back",
        name: "返回按钮",
        kind: "code-overlay",
        bbox: { x: 2, y: -4, width: 24.2, height: 30.7 },
        confidence: -1,
        reason: "navigation"
      }]
    }]
  }), { width: 100, height: 80 });

  assert.deepEqual(result, {
    backgrounds: [{
      id: "hero",
      name: "old_street_hero_background",
      bbox: { x: 0, y: 5, width: 100, height: 75 },
      confidence: 1,
      reason: "continuous artwork",
      bakedVisuals: ["端午安康艺术字", "龙舟"],
      overlays: [{
        id: "back",
        name: "返回按钮",
        kind: "code-overlay",
        bbox: { x: 2, y: 5, width: 24, height: 22 },
        confidence: 0,
        reason: "navigation"
      }]
    }],
    texts: []
  });
});

test("background decomposition returns editable text only when fully contained by its parent background", () => {
  const result = parseUiDecompositionText(JSON.stringify({
    assets: [{
      name: "shoe_icon",
      kind: "icon",
      parentBackgroundId: "tile",
      bbox: { x: 20, y: 20, width: 30, height: 30 }
    }],
    backgrounds: [{ id: "tile", name: "shoe_tile", bbox: { x: 10, y: 10, width: 80, height: 80 }, overlays: [] }],
    texts: [
      {
        id: "shoe-label",
        name: "shoe_label",
        parentBackgroundId: "tile",
        bbox: { x: 20, y: 60, width: 40, height: 20 },
        confidence: 0.9,
        text: { characters: "鞋子", fontSize: 18, lineHeight: 22, textAlignHorizontal: "CENTER" }
      },
      {
        id: "outside",
        parentBackgroundId: "tile",
        bbox: { x: 80, y: 80, width: 30, height: 20 },
        text: { characters: "越界" }
      }
    ]
  }), { width: 120, height: 120 });

  assert.equal(result.assets[0].parentBackgroundId, "tile");
  assert.equal(result.texts.length, 1);
  assert.equal(result.texts[0].text.characters, "鞋子");
  assert.equal(result.texts[0].parentBackgroundId, "tile");
});

test("background decomposition parser filters invalid kinds and overlays outside the background", () => {
  const result = parseBackgroundDecompositionText(JSON.stringify({
    backgrounds: [{
      name: "Hero",
      bbox: { x: 10, y: 10, width: 60, height: 60 },
      overlays: [
        { name: "Title", kind: "baked-visual", bbox: { x: 20, y: 20, width: 20, height: 20 } },
        { name: "Outside", kind: "code-overlay", bbox: { x: 80, y: 80, width: 10, height: 10 } },
        { name: "Card", kind: "code-overlay", bbox: { x: 0, y: 20, width: 30, height: 20 } }
      ]
    }]
  }), { width: 100, height: 100 });

  assert.equal(result.backgrounds.length, 1);
  assert.equal(result.backgrounds[0].id, "background_01");
  assert.deepEqual(result.backgrounds[0].overlays, [{
    id: "overlay_03",
    name: "Card",
    kind: "code-overlay",
    bbox: { x: 10, y: 20, width: 20, height: 20 },
    confidence: null,
    reason: ""
  }]);
});

test("background decomposition parser enforces candidate and overlay limits", () => {
  const backgrounds = Array.from({ length: MAX_BACKGROUND_CANDIDATES + 3 }, (_, backgroundIndex) => ({
    name: `Background ${backgroundIndex}`,
    bbox: { x: 0, y: 0, width: 100, height: 100 },
    overlays: Array.from({ length: MAX_BACKGROUND_OVERLAYS + 4 }, (_, overlayIndex) => ({
      name: `Overlay ${overlayIndex}`,
      kind: "code-overlay",
      bbox: { x: 1, y: 1, width: 10, height: 10 }
    }))
  }));

  const result = parseBackgroundDecompositionText(JSON.stringify({ backgrounds }), {
    width: 100,
    height: 100
  });

  assert.equal(result.backgrounds.length, MAX_BACKGROUND_CANDIDATES);
  assert.equal(result.backgrounds[0].overlays.length, MAX_BACKGROUND_OVERLAYS);
});

test("background decomposition constants expose supported overlay kinds", () => {
  assert.deepEqual([...ALLOWED_BACKGROUND_OVERLAY_KINDS], [
    "code-overlay",
    "raster-overlay"
  ]);
});
