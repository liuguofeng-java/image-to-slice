const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateAnchoredCanvasScroll,
  calculateWheelZoom
} = require("../src/ui/services/canvas-viewport");

test("canvas zoom keeps the viewport center anchored when content crosses the fit boundary", () => {
  const scroll = calculateAnchoredCanvasScroll({
    scrollLeft: 0,
    scrollTop: 0,
    anchorX: 500,
    anchorY: 400,
    previousZoom: 1,
    nextZoom: 3,
    previousLeft: 250,
    previousTop: 200,
    nextLeft: 0,
    nextTop: 0
  });

  assert.deepEqual(scroll, { left: 250, top: 200 });
});

test("canvas zoom keeps a pointer anchor stable while already scrolled", () => {
  const scroll = calculateAnchoredCanvasScroll({
    scrollLeft: 120,
    scrollTop: 75,
    anchorX: 240,
    anchorY: 180,
    previousZoom: 2,
    nextZoom: 2.5,
    previousLeft: 0,
    previousTop: 0,
    nextLeft: 0,
    nextTop: 0
  });

  assert.deepEqual(scroll, { left: 210, top: 138.75 });
});

test("mouse wheel zooms in upward and zooms out downward with bounded steps", () => {
  const zoomedIn = calculateWheelZoom(1, -100);
  const zoomedOut = calculateWheelZoom(1, 100);
  const veryLargeWheelStep = calculateWheelZoom(1, 10000);

  assert.ok(zoomedIn > 1);
  assert.ok(zoomedOut < 1);
  assert.ok(veryLargeWheelStep > 0.7);
});
