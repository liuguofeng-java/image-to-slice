import { describe, it, expect } from 'vitest';
import { calculateTrimBounds, defaultTrimSettings, trimImage } from '../../src/ui/services/trim-image';

class Pixels {
  data: Uint8ClampedArray;
  constructor(public width: number, public height: number) { this.data = new Uint8ClampedArray(width * height * 4); }
}
globalThis.ImageData = Pixels as unknown as typeof ImageData;
const fixture = () => {
  const image = new ImageData(10, 8);
  for (let y = 2; y < 6; y++) for (let x = 3; x < 8; x++) image.data.set([10, 90, 30, x === 3 ? 1 : 255], (y * 10 + x) * 4);
  return image;
};
describe('transparent edge trimming', () => {
  it('retains alpha=1 edges and adds asymmetric margins', () => {
    const input = fixture();
    const bounds = calculateTrimBounds(input, { ...defaultTrimSettings(), top: 1, right: 2, bottom: 3, left: 4 });
    expect(bounds).toEqual({ left: -1, top: 1, width: 11, height: 8 });
    const output = trimImage(input, bounds);
    expect(Array.from(output.data.slice((1 * 11 + 4) * 4, (1 * 11 + 4) * 4 + 4))).toEqual([10, 90, 30, 1]);
    expect(output.data[3]).toBe(0);
    expect(input.width).toBe(10);
  });
  it('zero margin fits the subject, opaque images keep their extent', () => {
    expect(calculateTrimBounds(fixture(), defaultTrimSettings())).toEqual({ left: 3, top: 2, width: 5, height: 4 });
    const opaque = new ImageData(3, 2); opaque.data.fill(255);
    expect(calculateTrimBounds(opaque, defaultTrimSettings())).toEqual({ left: 0, top: 0, width: 3, height: 2 });
  });
  it('rejects empty images, malformed margins and excessive output', () => {
    expect(() => calculateTrimBounds(new ImageData(2, 2), defaultTrimSettings())).toThrow('请先选择主体');
    for (const left of [-1, .5, NaN, 4097]) expect(() => calculateTrimBounds(fixture(), { ...defaultTrimSettings(), left })).toThrow('整数');
    expect(() => calculateTrimBounds(fixture(), { ...defaultTrimSettings(), left: 4096, right: 4096, top: 4096, bottom: 4096 })).toThrow('输出尺寸过大');
    const wide = new ImageData(16385, 1); wide.data.fill(255);
    expect(() => calculateTrimBounds(wide, defaultTrimSettings())).toThrow('输出尺寸过大');
  });
});
