import type { Layer, Asset, Rect } from './types';

/**
 * 坐标约定：Layer 的 x/y 是旋转前左上角，旋转中心是图片中心。
 * Asset 尺寸是原始像素；Layer 尺寸是设计尺寸。这里不接收屏幕缩放倍率。
 * 前后端独立构建，因此不跨项目导入；坐标契约由两端单测和端到端裁切验证。
 */

/** 设计坐标 → 源像素：先撤销中心旋转，再撤销翻转及非等比缩放。 */
export function sourcePoint(l: Layer, a: Asset, x: number, y: number) {
  const r = (-l.rotation * Math.PI) / 180,
    dx = x - l.x - l.width / 2,
    dy = y - l.y - l.height / 2;
  return {
    x: (((dx * Math.cos(r) - dy * Math.sin(r)) * (l.flipX ? -1 : 1)) / l.width + 0.5) * a.width,
    y: (((dx * Math.sin(r) + dy * Math.cos(r)) * (l.flipY ? -1 : 1)) / l.height + 0.5) * a.height,
  };
}
/** 源像素 → 设计坐标，必须与 sourcePoint 互为逆变换。 */
export function worldPoint(l: Layer, a: Asset, x: number, y: number) {
  const r = (l.rotation * Math.PI) / 180,
    dx = (x / a.width - 0.5) * l.width * (l.flipX ? -1 : 1),
    dy = (y / a.height - 0.5) * l.height * (l.flipY ? -1 : 1);
  return {
    x: l.x + l.width / 2 + dx * Math.cos(r) - dy * Math.sin(r),
    y: l.y + l.height / 2 + dx * Math.sin(r) + dy * Math.cos(r),
  };
}
/** 向外取整并限制到源图内；预览和最终 Sharp 裁切使用相同整数边界。 */
export function normalizeRect(r: Rect, w: number, h: number) {
  const x = Math.max(0, Math.floor(r.x)),
    y = Math.max(0, Math.floor(r.y)),
    right = Math.min(w, Math.ceil(r.x + r.width)),
    bottom = Math.min(h, Math.ceil(r.y + r.height));
  if (right <= x || bottom <= y) throw new Error('选区在图片范围外');
  return { x, y, width: right - x, height: bottom - y };
}
export const between = (a: { x: number; y: number }, b: { x: number; y: number }): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
});
export function bounds(l: Layer): Rect {
  const a = { id: '', name: '', width: l.width, height: l.height };
  const ps = [
    [0, 0],
    [l.width, 0],
    [0, l.height],
    [l.width, l.height],
  ].map(([x, y]) => worldPoint(l, a, x, y));
  return {
    x: Math.min(...ps.map((p) => p.x)),
    y: Math.min(...ps.map((p) => p.y)),
    width: Math.max(...ps.map((p) => p.x)) - Math.min(...ps.map((p) => p.x)),
    height: Math.max(...ps.map((p) => p.y)) - Math.min(...ps.map((p) => p.y)),
  };
}
