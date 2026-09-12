import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const rectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive().max(16384),
  height: z.number().positive().max(16384),
});
export const assetSchema = z.object({
  id: idSchema,
  width: z.number().int().positive().max(16384),
  height: z.number().int().positive().max(16384),
  name: z.string().max(200),
});
const sourceSchema = z.object({ layerId: idSchema, rect: rectSchema });
const layerBaseSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(200),
  x: z.number().finite().min(-1e6).max(1e6),
  y: z.number().finite().min(-1e6).max(1e6),
  width: z.number().positive().max(16384),
  height: z.number().positive().max(16384),
  rotation: z.number().finite().min(-36000).max(36000),
  flipX: z.boolean(),
  flipY: z.boolean(),
  opacity: z.number().min(0).max(1),
  locked: z.boolean(),
  hidden: z.boolean(),
  source: sourceSchema.optional(),
});
export const textStyleSchema = z.object({
  content: z.string().max(20000),
  fontFamily: z.string().trim().min(1).max(200),
  fontSize: z.number().positive().max(2048),
  fontWeight: z.number().int().min(100).max(900),
  fontStyle: z.enum(['normal', 'italic']),
  fill: z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/),
  align: z.enum(['left', 'center', 'right']),
  verticalAlign: z.enum(['top', 'middle', 'bottom']),
  lineHeight: z.number().min(0.5).max(5),
  letterSpacing: z.number().finite().min(-1000).max(1000),
  resizeMode: z.enum(['auto-width', 'auto-height', 'fixed']),
});
export const imageLayerSchema = layerBaseSchema.extend({
  type: z.literal('image'),
  assetId: idSchema,
  radius: z.number().min(0).max(8192),
});
export const textLayerSchema = layerBaseSchema.extend({
  type: z.literal('text'),
  ...textStyleSchema.shape,
});
export const layerSchema = z.union([imageLayerSchema, textLayerSchema]);
export const sceneSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(200),
  width: z.number().int().positive().max(16384),
  height: z.number().int().positive().max(16384),
  layers: z.array(layerSchema).max(1000),
});
export const documentSchema = z
  .object({
    name: z.string().min(1).max(200),
    activeSceneId: idSchema,
    scenes: z.array(sceneSchema).min(1).max(100),
  })
  .superRefine((p, ctx) => {
    const ids = p.scenes.flatMap((s) => [s.id, ...s.layers.map((l) => l.id)]);
    if (new Set(ids).size !== ids.length || !p.scenes.some((s) => s.id === p.activeSceneId))
      ctx.addIssue({ code: 'custom', message: '场景/图层 ID 重复或当前场景无效' });
    if (
      p.scenes.some(
        (s) => s.width * s.height > 32e6 || s.layers.some((l) => l.width * l.height > 32e6),
      )
    )
      ctx.addIssue({ code: 'custom', message: '输出面积不能超过 3200 万像素' });
  });
export type Rect = z.infer<typeof rectSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type Layer = z.infer<typeof layerSchema>;
export type ImageLayer = z.infer<typeof imageLayerSchema>;
export type TextLayer = z.infer<typeof textLayerSchema>;
export type TextStyle = z.infer<typeof textStyleSchema>;
export type Document = z.infer<typeof documentSchema>;
export type Project = Document & {
  id: string;
  revision: number;
  updatedAt: string;
  receipts?: Record<string, string>;
};
/** 仅用于读取旧项目；公开写入契约保持严格，下一次保存会写回显式 type。 */
export function parseStoredDocument(value: unknown): Document {
  if (!value || typeof value !== 'object') return documentSchema.parse(value);
  const input = structuredClone(value) as any;
  if (Array.isArray(input.scenes))
    for (const scene of input.scenes)
      if (Array.isArray(scene?.layers))
        for (const layer of scene.layers)
          if (layer && typeof layer === 'object' && layer.type === undefined) layer.type = 'image';
  return documentSchema.parse(input);
}
export const candidateSchema = rectSchema.extend({
  id: idSchema,
  name: z.string().min(1).max(200),
  category: z.enum(['image', 'icon', 'text', 'background']),
  enabled: z.boolean(),
  text: textStyleSchema.optional(),
});
export type Candidate = z.infer<typeof candidateSchema>;
export const modelSchema = z
  .object({
    baseUrl: z.string().url(),
    model: z.string().trim().min(1).max(200),
    apiKey: z.string().max(8192).optional(),
    timeoutSeconds: z.number().int().min(10).max(1800).default(120),
  })
  .superRefine((c, ctx) => {
    const u = new URL(c.baseUrl);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
      ctx.addIssue({ code: 'custom', message: 'Base URL 必须是无凭据、查询参数的 HTTP(S) 地址' });
  });
export type ModelConfig = z.infer<typeof modelSchema>;
export const uid = () => randomUUID();
export function fail(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}
export function normalizeRect(r: Rect, w: number, h: number): Rect {
  rectSchema.parse(r);
  const x = Math.max(0, Math.floor(r.x)),
    y = Math.max(0, Math.floor(r.y));
  const right = Math.min(w, Math.ceil(r.x + r.width)),
    bottom = Math.min(h, Math.ceil(r.y + r.height));
  if (right <= x || bottom <= y) fail('选区在图片范围外');
  return { x, y, width: right - x, height: bottom - y };
}
export const signature = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function point(l: ImageLayer, px: number, py: number, asset: Asset) {
  const dx = (px / asset.width - 0.5) * l.width * (l.flipX ? -1 : 1),
    dy = (py / asset.height - 0.5) * l.height * (l.flipY ? -1 : 1),
    r = (l.rotation * Math.PI) / 180;
  return {
    x: l.x + l.width / 2 + dx * Math.cos(r) - dy * Math.sin(r),
    y: l.y + l.height / 2 + dx * Math.sin(r) + dy * Math.cos(r),
  };
}
export function croppedLayer(
  source: ImageLayer,
  asset: Asset,
  c: Candidate,
  output: Asset,
): ImageLayer {
  const center = point(source, c.x + c.width / 2, c.y + c.height / 2, asset),
    width = (c.width * source.width) / asset.width,
    height = (c.height * source.height) / asset.height;
  return {
    ...source,
    type: 'image',
    id: uid(),
    assetId: output.id,
    name: c.name,
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
    radius: 0,
    source: { layerId: source.id, rect: { x: c.x, y: c.y, width: c.width, height: c.height } },
  };
}
export const defaultTextStyle = (content = ''): TextStyle => ({
  content,
  fontFamily: 'sans-serif',
  fontSize: 24,
  fontWeight: 400,
  fontStyle: 'normal',
  fill: '#000000',
  align: 'left',
  verticalAlign: 'top',
  lineHeight: 1.2,
  letterSpacing: 0,
  resizeMode: 'auto-height',
});

export function candidateTextLayer(source: ImageLayer, asset: Asset, c: Candidate): TextLayer {
  if (c.category !== 'text' || !c.text?.content.trim()) fail('文字候选必须填写文字内容');
  const center = point(source, c.x + c.width / 2, c.y + c.height / 2, asset),
    width = (c.width * source.width) / asset.width,
    height = (c.height * source.height) / asset.height,
    scaleY = source.height / asset.height,
    scaleX = source.width / asset.width;
  return {
    id: uid(),
    type: 'text',
    name: c.name,
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
    rotation: source.rotation,
    flipX: source.flipX,
    flipY: source.flipY,
    opacity: source.opacity,
    hidden: false,
    locked: false,
    source: { layerId: source.id, rect: { x: c.x, y: c.y, width: c.width, height: c.height } },
    ...c.text,
    content: c.text.content.trim(),
    fontSize: c.text.fontSize * scaleY,
    letterSpacing: c.text.letterSpacing * scaleX,
  };
}
