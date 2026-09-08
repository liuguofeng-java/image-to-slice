export interface TrimSettings { enabled: boolean; linked: boolean; top: number; right: number; bottom: number; left: number }
export interface TrimBounds { left: number; top: number; width: number; height: number }
export function defaultTrimSettings(): TrimSettings {
  return { enabled: false, linked: false, top: 0, right: 0, bottom: 0, left: 0 };
}

/** Bounds include every nonzero alpha pixel, including feathered edges. */
export function calculateTrimBounds(source: Pick<ImageData, 'width' | 'height' | 'data'>, padding: TrimSettings): TrimBounds {
  for (const value of [padding.top, padding.right, padding.bottom, padding.left]) {
    if (!Number.isInteger(value) || value < 0 || value > 4096) throw new Error('四边间距请输入 0–4096 的整数。');
  }
  let left = source.width, top = source.height, right = -1, bottom = -1;
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    if (!source.data[(y * source.width + x) * 4 + 3]) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right < left) throw new Error('请先选择主体，当前图片没有可保留的内容。');
  const width = right - left + 1 + padding.left + padding.right;
  const height = bottom - top + 1 + padding.top + padding.bottom;
  if (width > 16384 || height > 16384 || width * height > 32_000_000) throw new Error('输出尺寸过大：单边最多 16384 px，总面积最多 3200 万像素。');
  return { left: left - padding.left, top: top - padding.top, width, height };
}

export function trimImage(source: ImageData, bounds: TrimBounds): ImageData {
  const output = new ImageData(bounds.width, bounds.height);
  const fromX = Math.max(0, bounds.left), toX = Math.min(source.width, bounds.left + bounds.width);
  for (let y = Math.max(0, bounds.top); y < Math.min(source.height, bounds.top + bounds.height); y++) {
    output.data.set(source.data.subarray((y * source.width + fromX) * 4, (y * source.width + toX) * 4),
      ((y - bounds.top) * bounds.width + fromX - bounds.left) * 4);
  }
  return output;
}
