import { describe, it, expect } from 'vitest';
import { sourcePoint, worldPoint, normalizeRect, bounds } from '../../src/geometry';
import type { Layer } from '../../src/types';
describe('source coordinate transforms', () => {
  for (const rotation of [0, 37, 90, -142])
    for (const flipX of [false, true])
      for (const flipY of [false, true])
        it(`inverts ${rotation}/${flipX}/${flipY}`, () => {
          const l = {
              x: -22.5,
              y: 133.75,
              width: 200,
              height: 800,
              rotation,
              flipX,
              flipY,
            } as Layer,
            a = { id: 'a', name: 'a', width: 1600, height: 3200 };
          const world = worldPoint(l, a, 156, 2950),
            p = sourcePoint(l, a, world.x, world.y);
          expect(p.x).toBeCloseTo(156, 8);
          expect(p.y).toBeCloseTo(2950, 8);
        });
  it('normalizes the same source pixels for preview and crop', () => {
    expect(normalizeRect({ x: -0.1, y: 3.7, width: 6.3, height: 4.6 }, 10, 10)).toEqual({
      x: 0,
      y: 3,
      width: 7,
      height: 6,
    });
    expect(() => normalizeRect({ x: 20, y: 0, width: 1, height: 2 }, 10, 10)).toThrow();
  });
  it('bounds rotated images for selection and alignment', () => {
    const b = bounds({
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      rotation: 90,
      flipX: false,
      flipY: false,
    } as Layer);
    expect(b.x).toBeCloseTo(25);
    expect(b.y).toBeCloseTo(-25);
    expect(b.width).toBeCloseTo(50);
    expect(b.height).toBeCloseTo(100);
  });
});
