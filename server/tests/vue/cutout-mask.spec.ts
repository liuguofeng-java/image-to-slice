import { describe, expect, it } from 'vitest';
import {
  applyAlphaMatte,
  combineMasks,
  createLabPixels,
  createWandMask,
  fillMaskHoles,
  packMask,
  unpackMask
} from '../../src/ui/services/cutout-mask';

class TestImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  colorSpace = 'srgb' as const;
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}
Object.defineProperty(globalThis, 'ImageData', { configurable: true, value: TestImageData });

function pixels(values: number[][], width: number, height: number) {
  return new ImageData(new Uint8ClampedArray(values.flat()), width, height);
}

describe('智能抠图选区运算', () => {
  it('魔棒使用 Lab 色差并限制在八方向连续区域', () => {
    const image = pixels([
      [255, 0, 0, 255], [255, 1, 0, 255], [0, 0, 255, 255],
      [0, 0, 255, 255], [255, 0, 0, 255], [0, 0, 255, 255]
    ], 3, 2);
    const mask = createWandMask(image, createLabPixels(image), 3, 2, 0, 0, 3, true);
    expect(Array.from(mask)).toEqual([255, 255, 0, 0, 255, 0]);
  });

  it('填充主体内部孔洞但保留与边界连通的背景', () => {
    const mask = new Uint8Array([
      0, 0, 0, 0, 0,
      0, 255, 255, 255, 0,
      0, 255, 0, 255, 0,
      0, 255, 255, 255, 0,
      0, 0, 0, 0, 0
    ]);
    const filled = fillMaskHoles(mask, 5, 5);
    expect(filled[12]).toBe(255);
    expect(filled[0]).toBe(0);
  });

  it('减去模式支持软画笔 alpha，而不是破坏原图', () => {
    const result = combineMasks(new Uint8Array([255]), new Uint8Array([128]), 'subtract');
    expect(result[0]).toBe(127);
    const source = pixels([[21, 34, 55, 128]], 1, 1);
    const composited = applyAlphaMatte(source, new Uint8ClampedArray([128]), 1, 1, 0);
    expect(Array.from(composited.data)).toEqual([21, 34, 55, 64]);
  });

  it('撤销位图按一位压缩并可无损恢复二值选区', () => {
    const source = new Uint8Array([0, 255, 255, 0, 255, 0, 0, 255, 255]);
    const packed = packMask(source);
    expect(packed.byteLength).toBe(2);
    expect(Array.from(unpackMask(packed, source.length))).toEqual(Array.from(source));
  });
});
