import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Storage } from './storage.js';
import { analyze, type Analyzer } from './provider.js';
import {
  candidateSchema,
  candidateTextLayer,
  croppedLayer,
  fail,
  idSchema,
  normalizeRect,
  rectSchema,
  signature,
  uid,
  type Candidate,
  type ImageLayer,
  type Rect,
} from './domain.js';
import { schema } from './contracts.js';

/** 任务只驻留进程内存。图片引用/项目写盘，AbortController 和未确认候选不写盘。 */
type Job = {
  id: string;
  projectId: string;
  sceneId: string;
  layerId: string;
  sourceSignature: string;
  source: ImageLayer;
  region: Rect;
  status: 'running' | 'ready' | 'failed' | 'cancelled' | 'applied';
  message: string;
  candidates: Candidate[];
  controller: AbortController;
  createdAt: number;
};

/** 分析和应用分别处理：分析可取消，应用在项目串行锁内一次提交。 */
export function registerSplitRoutes(
  app: FastifyInstance,
  storage: Storage,
  options: { analyzer?: Analyzer; fetcher?: typeof fetch },
) {
  const jobs = new Map<string, Job>();
  async function configured() {
    const config = await storage.model();
    if (!config) fail('请先设置图片理解模型');
    return config;
  }
  const startSchema = z.object({
    projectId: idSchema,
    sceneId: idSchema,
    layerId: idSchema,
    region: rectSchema,
    manual: z.boolean().default(false),
  });
  app.post('/api/v1/split-jobs', { schema: { body: schema(startSchema) } }, async (req, reply) => {
    for (const [id, j] of jobs)
      if (j.status !== 'running' && Date.now() - j.createdAt > 3600e3) jobs.delete(id);
    if ([...jobs.values()].filter((j) => j.status === 'running').length >= 2)
      fail('已有拆图任务运行，请等待或取消', 409);
    const b = startSchema.parse(req.body),
      p = await storage.project(b.projectId),
      source = p.scenes.find((s) => s.id === b.sceneId)?.layers.find((l) => l.id === b.layerId);
    if (!source) fail('来源图层不存在');
    if (source.type !== 'image') fail('只有图片图层可以进行 AI 拆图');
    if (source.hidden || source.locked) fail('请选择可见、未锁定的图片');
    const asset = await storage.asset(source.assetId),
      region = normalizeRect(b.region, asset.width, asset.height);
    const config = b.manual ? null : await configured();
    const job: Job = {
      ...b,
      id: uid(),
      sourceSignature: signature(source),
      source,
      region,
      status: b.manual ? 'ready' : 'running',
      message: b.manual ? '手动添加候选' : '正在等待模型识别',
      candidates: [],
      controller: new AbortController(),
      createdAt: Date.now(),
    };
    jobs.set(job.id, job);
    if (config)
      void (async () => {
        try {
          const rows = await (options.analyzer || analyze)(
            config,
            storage.imagePath(asset.id),
            region,
            job.controller.signal,
            options.fetcher,
          );
          if (job.controller.signal.aborted) return;
          job.candidates = z
            .array(candidateSchema)
            .min(1)
            .max(200)
            .parse(rows)
            .map((c) => ({ ...c, ...normalizeRect(c, asset.width, asset.height) }));
          job.status = 'ready';
          job.message = `已识别 ${rows.length} 个候选`;
        } catch (e) {
          if (!job.controller.signal.aborted) {
            job.status = 'failed';
            job.message = (e as Error).message.slice(0, 800);
          }
        }
      })();
    return reply.code(202).send({ id: job.id, status: job.status });
  });
  function getJob(id: string) {
    const j = jobs.get(id);
    if (!j) fail('任务不存在或服务已重启，请重新框选', 404);
    return j;
  }
  app.get('/api/v1/split-jobs/:id', async (req) => {
    const j = getJob((req.params as any).id);
    return {
      id: j.id,
      status: j.status,
      message: j.message,
      region: j.region,
      candidates: j.candidates,
    };
  });
  app.delete('/api/v1/split-jobs/:id', async (req) => {
    const j = getJob((req.params as any).id);
    if (j.status !== 'applied') {
      j.controller.abort();
      j.status = 'cancelled';
      j.message = '已取消';
    }
    return { status: j.status };
  });
  const applySchema = z.object({
    revision: z.number().int().min(0),
    operationId: idSchema,
    candidates: z.array(candidateSchema).min(1).max(200),
  });
  app.post(
    '/api/v1/split-jobs/:id/apply',
    { schema: { body: schema(applySchema) } },
    async (req) => {
      const j = getJob((req.params as any).id),
        b = applySchema.parse(req.body),
        fingerprint = signature({ jobId: j.id, candidates: b.candidates });
      // 版本校验、来源校验和最终提交必须处于同一个锁内，防止检查后被其他请求修改。
      return storage.serial(j.projectId, async () => {
        const p = await storage.project(j.projectId);
        // 回执检查先于任务状态：首次请求可能已成功落盘，但客户端没收到响应。
        if (p.receipts?.[b.operationId]) {
          if (p.receipts[b.operationId] !== fingerprint) fail('操作标识已用于不同内容', 409);
          return p;
        }
        if (j.status !== 'ready') fail('任务尚不可应用', 409);
        if (p.revision !== b.revision) fail('项目已修改，请保存后重试', 409);
        const scene = p.scenes.find((s) => s.id === j.sceneId),
          index = scene?.layers.findIndex((l) => l.id === j.layerId) ?? -1;
        const source = scene?.layers[index];
        if (!source || source.type !== 'image' || signature(source) !== j.sourceSignature)
          fail('来源图片已改变，请重新分析', 409);
        const asset = await storage.asset(source.assetId),
          selected = b.candidates.filter((c) => c.enabled);
        if (!selected.length) fail('请至少选择一个候选');
        if (new Set(selected.map((c) => c.id)).size !== selected.length) fail('候选 ID 重复');
        const layers = [];
        for (const candidate of selected) {
          const r = normalizeRect(candidate, asset.width, asset.height);
          if (
            r.x < j.region.x ||
            r.y < j.region.y ||
            r.x + r.width > j.region.x + j.region.width ||
            r.y + r.height > j.region.y + j.region.height
          )
            fail('候选必须在分析范围内');
          const c = { ...candidate, ...r };
          if (c.category === 'text') layers.push(candidateTextLayer(source, asset, c));
          else {
            const cropped = await storage.crop(asset.id, c, c.name);
            layers.push(croppedLayer(source, asset, c, cropped));
          }
        }
        // 裁片全部就绪后才一次更新图层与回执。失败时可留下未引用的不可变图片，
        // 但绝不能保存半套图层；首期不自动清理资源，以保护撤销引用。
        scene!.layers.splice(index + 1, 0, ...layers);
        p.revision++;
        p.updatedAt = new Date().toISOString();
        p.receipts = { ...p.receipts, [b.operationId]: fingerprint };
        const result = await storage.writeProject(p);
        j.status = 'applied';
        return result;
      });
    },
  );
  app.addHook('onClose', async () => {
    for (const j of jobs.values()) j.controller.abort();
  });
}
