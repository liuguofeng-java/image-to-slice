import { describe, expect, it } from 'vitest';
import { scrubbedValue } from '../../src/directives/numberScrub';

describe('number scrubber', () => {
  it('decreases left, increases right and waits for a full pixel step', () => {
    const options = { step: 1, pixelsPerStep: 4, precision: 2 };
    expect(scrubbedValue(10, 12, options)).toBe(13);
    expect(scrubbedValue(10, -8, options)).toBe(8);
    expect(scrubbedValue(10, 3, options)).toBe(10);
  });

  it('supports decimal precision and clamps to field bounds', () => {
    const options = { step: 0.05, pixelsPerStep: 4, precision: 2, min: 0.5, max: 5 };
    expect(scrubbedValue(1.2, 8, options)).toBe(1.3);
    expect(scrubbedValue(0.5, -100, options)).toBe(0.5);
    expect(scrubbedValue(5, 100, options)).toBe(5);
  });
});
