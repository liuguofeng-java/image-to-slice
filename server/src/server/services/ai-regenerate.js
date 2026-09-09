const sharp = require('sharp');
const { unionRegenerationRegions, validateRegenerationDimensions } = require('../../core/regeneration');
const decode = value => {
  const match = String(value || '').match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
  if (!match) throw new Error('重新生成需要有效的参考图片。');
  return Buffer.from(match[1], 'base64');
};
const encode = bytes => `data:image/png;base64,${bytes.toString('base64')}`;

async function prepareRegeneration(payload, size) {
  const source = await sharp(decode(payload.dataUrl), { limitInputPixels: 32_000_000 }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = source.info;
  validateRegenerationDimensions(width, height);
  if (payload.width !== width || payload.height !== height) throw new Error('参考图片真实像素与请求尺寸不一致。');
  if (!Array.isArray(payload.excludeRegions) || payload.excludeRegions.length > 1000 || payload.excludeRegions.some(r => !r || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width < 0 || r.height < 0)) throw new Error('子级排除区域无效。');
  const regions = unionRegenerationRegions(payload.excludeRegions, width, height);
  const alpha = Buffer.alloc(width * height);
  const mask = Buffer.alloc(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = source.data[i * 4 + 3];
  for (const r of regions) for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) {
    const i = y * width + x;
    mask[i] = alpha[i] = 255;
    // Remove hidden RGB as well as alpha; the provider never receives child pixels.
    source.data.fill(0, i * 4, i * 4 + 4);
  }
  const [targetWidth, targetHeight] = size.split('x').map(Number);
  const scale = Math.min(targetWidth / width, targetHeight / height);
  const content = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  content.x = Math.floor((targetWidth - content.width) / 2); content.y = Math.floor((targetHeight - content.height) / 2);
  const padding = { left: content.x, top: content.y, right: targetWidth - content.width - content.x, bottom: targetHeight - content.height - content.y };
  const reference = await sharp(source.data, { raw: { width, height, channels: 4 } }).resize(content.width, content.height)
    .extend({ ...padding, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const alignedMask = await sharp(mask, { raw: { width, height, channels: 1 } }).resize(content.width, content.height, { kernel: 'nearest' })
    .extend({ ...padding, background: '#000' }).png().toBuffer();
  return { width, height, targetWidth, targetHeight, content, alpha, reference, alignedMask, regions };
}

async function restoreRegeneration(dataUrl, prepared) {
  const bytes = decode(dataUrl);
  const meta = await sharp(bytes, { limitInputPixels: 32_000_000 }).metadata();
  validateRegenerationDimensions(meta.width, meta.height);
  // Map the padding into the returned pixel grid. Never resize generated RGB.
  const sx = meta.width / prepared.targetWidth, sy = meta.height / prepared.targetHeight;
  if (Math.abs(sx / sy - 1) > .01) throw new Error('模型返回的宽高比与请求不一致，无法安全移除留边。');
  const left = Math.round(prepared.content.x * sx), top = Math.round(prepared.content.y * sy);
  const width = Math.min(meta.width - left, Math.round(prepared.content.width * sx));
  const height = Math.min(meta.height - top, Math.round(prepared.content.height * sy));
  validateRegenerationDimensions(width, height, prepared.width, prepared.height);
  const pixels = await sharp(bytes).extract({ left, top, width, height }).ensureAlpha().raw().toBuffer();
  const alpha = await sharp(prepared.alpha, { raw: { width: prepared.width, height: prepared.height, channels: 1 } })
    .resize(width, height, { kernel: 'nearest' }).greyscale().raw().toBuffer();
  for (let i = 0; i < alpha.length; i++) pixels[i * 4 + 3] = alpha[i];
  return { dataUrl: encode(await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer()),
    width, height, mapping: { left, top, paddedWidth: meta.width, paddedHeight: meta.height }, transparent: alpha.includes(0) || alpha.some(v => v < 255) };
}

async function regenerateAsset(payload, context, { normalizeImageResponse, toImageSize }) {
  if (payload.expectedProvider && (payload.expectedProvider.id !== context.config.configId || payload.expectedProvider.model !== context.config.model || payload.expectedProvider.baseUrl !== context.config.baseUrl)) throw new Error('图片生成 / 修补配置已变化，请关闭后重新确认 API 和模型。');
  const size = toImageSize(payload.width, payload.height);
  const prepared = await prepareRegeneration(payload, size);
  const form = new FormData();
  form.set('model', context.config.model); form.set('size', size); form.set('quality', 'high');
  form.set('output_format', 'png'); form.set('n', '1');
  form.set('prompt', `Redraw only the parent image in the first reference at high quality. Closely preserve its subject, composition, colors, text, proportions and style. Do not add new elements. The reference is aspect-preserving with padding; keep content in the same content box ${JSON.stringify(prepared.content)} on the ${size} canvas. The second image is an aligned exclusion guide: white regions have had independent child layers removed. Reconstruct the underlying parent naturally in those regions. Never recreate the removed child text, icons, buttons or overlays. Black regions remain reference context but should also be redrawn faithfully. Preserve the outer transparent silhouette. Output one image, no guide or mask.`);
  form.append('image[]', new File([prepared.reference], 'parent-reference.png', { type: 'image/png' }));
  form.append('image[]', new File([prepared.alignedMask], 'child-exclusion-mask.png', { type: 'image/png' }));
  // Intentionally one attempt: no compatibility retry, local model, or hidden extra charge.
  const response = await normalizeImageResponse(await context.callForm('/v1/images/edits', form));
  if (!response.images?.[0]?.dataUrl) throw new Error('远程模型未返回图片。');
  const image = await restoreRegeneration(response.images[0].dataUrl, prepared);
  return { images: [image], provider: { model: context.config.model, size }, operation: 'regenerate' };
}
module.exports = { prepareRegeneration, restoreRegeneration, regenerateAsset };
