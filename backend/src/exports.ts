import sharp, { type OverlayOptions } from 'sharp';
import { zipSync } from 'fflate';
import { Storage } from './storage.js';
import { fail, type Layer, type Project } from './domain.js';
/** native 导出保留原图像素密度；场景合成用设计像素，不受前端缩放影响。 */
export async function layerPng(storage: Storage, layer: Layer, native = true) {
  const a = await storage.asset(layer.assetId),
    density = native ? Math.max(a.width / layer.width, a.height / layer.height) : 1,
    w = Math.max(1, Math.round(layer.width * density)),
    h = Math.max(1, Math.round(layer.height * density));
  if (w > 16384 || h > 16384 || w * h > 32e6) fail('导出尺寸超过限制');
  let data = await sharp(storage.imagePath(a.id)).resize(w, h).ensureAlpha().raw().toBuffer();
  const rx = Math.min(w / 2, (layer.radius * w) / layer.width),
    ry = Math.min(h / 2, (layer.radius * h) / layer.height);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let inside = true;
      if (rx > 0 && ry > 0) {
        const dx = Math.max(rx - x - 0.5, 0, x + 0.5 - (w - rx)),
          dy = Math.max(ry - y - 0.5, 0, y + 0.5 - (h - ry));
        if (dx && dy) inside = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
      }
      data[(y * w + x) * 4 + 3] = inside
        ? Math.round(data[(y * w + x) * 4 + 3] * layer.opacity)
        : 0;
    }
  let s = sharp(data, { raw: { width: w, height: h, channels: 4 } });
  if (layer.flipX) s = s.flop();
  if (layer.flipY) s = s.flip();
  const radians = (layer.rotation * Math.PI) / 180,
    bw = Math.abs(w * Math.cos(radians)) + Math.abs(h * Math.sin(radians)),
    bh = Math.abs(w * Math.sin(radians)) + Math.abs(h * Math.cos(radians));
  if (bw > 16384 || bh > 16384 || bw * bh > 32e6) fail('旋转后的导出尺寸超限');
  return s.rotate(layer.rotation, { background: '#00000000' }).png().toBuffer();
}
/** PNG/ZIP 只包含图片内容；场景按顺序合成并裁去画板外区域，不包含标尺与选区。 */
export async function exportProject(
  storage: Storage,
  p: Project,
  sceneId: string,
  kind: string,
  ids: string[],
) {
  const scene = p.scenes.find((s) => s.id === sceneId);
  if (!scene) fail('场景不存在', 404);
  const layers =
    kind === 'scene'
      ? scene.layers.filter((l) => !l.hidden)
      : scene.layers.filter((l) => ids.includes(l.id));
  if (!layers.length) fail('请选择需要导出的图片');
  if (kind === 'png') {
    if (layers.length !== 1) fail('单图导出只能选择一个图层');
    return { bytes: await layerPng(storage, layers[0]), type: 'image/png', name: 'slice.png' };
  }
  if (kind === 'zip') {
    const files: Record<string, Uint8Array> = {};
    let size = 0;
    for (const [i, l] of layers.entries()) {
      const data = await layerPng(storage, l);
      size += data.length;
      if (size > 256 * 1024 * 1024) fail('导出过大，请分批导出', 413);
      files[`${i + 1}-${l.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100)}.png`] = data;
    }
    return {
      bytes: Buffer.from(zipSync(files, { level: 0 })),
      type: 'application/zip',
      name: 'slices.zip',
    };
  }
  if (scene.width * scene.height > 32e6) fail('场景导出尺寸超限');
  const inputs: OverlayOptions[] = [];
  for (const l of layers) {
    let data = await layerPng(storage, l, false);
    const m = await sharp(data).metadata();
    let left = Math.round(l.x + l.width / 2 - m.width! / 2),
      top = Math.round(l.y + l.height / 2 - m.height! / 2);
    const cropLeft = Math.max(0, -left),
      cropTop = Math.max(0, -top),
      width = Math.min(m.width! - cropLeft, scene.width - Math.max(0, left)),
      height = Math.min(m.height! - cropTop, scene.height - Math.max(0, top));
    if (width <= 0 || height <= 0) continue;
    data = await sharp(data).extract({ left: cropLeft, top: cropTop, width, height }).toBuffer();
    inputs.push({ input: data, left: Math.max(0, left), top: Math.max(0, top) });
  }
  return {
    bytes: await sharp({
      create: { width: scene.width, height: scene.height, channels: 4, background: '#00000000' },
    })
      .composite(inputs)
      .png()
      .toBuffer(),
    type: 'image/png',
    name: 'scene.png',
  };
}
