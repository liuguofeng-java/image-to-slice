import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Storage } from './storage.js';
import { analyze, editImage, type Analyzer, type ImageEditor } from './provider.js';
import {
  buildGenerationTargets,
  buildLayerRegenerationTarget,
  imageHasTransparency,
  regenerateTarget,
  type GenerationTarget,
} from './regeneration.js';
import {
  candidateSchema,
  candidateTextLayer,
  croppedLayer,
  fail,
  idSchema,
  normalizeRect,
  rectSchema,
  signature,
  sourcePoint,
  uid,
  type Candidate,
  type Asset,
  type ImageLayer,
  type Rect,
} from './domain.js';
import { schema } from './contracts.js';
import { containsLayer, transformedCorners } from './layer-tree.js';

/** 任务只驻留进程内存。图片引用/项目写盘，AbortController 和未确认候选不写盘。 */
type GeneratedTarget = GenerationTarget & {
  state: 'pending' | 'running' | 'ready' | 'failed';
  asset?: Asset;
  message: string;
};
type GenerationState = {
  fingerprint: string;
  operationId: string;
  revision: number;
  generateSource: boolean;
  candidates: Candidate[];
  targets: GeneratedTarget[];
};
type Job = {
  id: string;
  projectId: string;
  sceneId: string;
  layerId: string;
  sourceSignature: string;
  source: ImageLayer;
  region: Rect;
  status: 'running' | 'ready' | 'generating' | 'failed' | 'cancelled' | 'applied';
  message: string;
  candidates: Candidate[];
  controller: AbortController;
  createdAt: number;
  generation?: GenerationState;
  resultRevision?: number;
};
type LayerRegenerationJob = {
  id: string;
  projectId: string;
  sceneId: string;
  layerId: string;
  revision: number;
  operationId: string;
  fingerprint: string;
  sourceSignature: string;
  sourcePath: string;
  target: GeneratedTarget;
  status: 'generating' | 'failed' | 'cancelled' | 'applied';
  message: string;
  controller: AbortController;
  createdAt: number;
  resultRevision?: number;
};

/** 分析和应用分别处理：分析可取消，应用在项目串行锁内一次提交。 */
export function registerSplitRoutes(
  app: FastifyInstance,
  storage: Storage,
  options: { analyzer?: Analyzer; imageEditor?: ImageEditor; fetcher?: typeof fetch },
) {
  const jobs = new Map<string, Job>(),
    layerJobs = new Map<string, LayerRegenerationJob>();
  let activeImageRequests = 0;
  const imageWaiters: Array<() => void> = [];
  async function withImageSlot<T>(signal: AbortSignal, operation: () => Promise<T>) {
    while (activeImageRequests >= 2) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          const index = imageWaiters.indexOf(wake);
          if (index >= 0) imageWaiters.splice(index, 1);
          reject(new DOMException('已取消', 'AbortError'));
        };
        imageWaiters.push(wake);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    activeImageRequests++;
    try {
      return await operation();
    } finally {
      activeImageRequests--;
      imageWaiters.shift()?.();
    }
  }
  async function configured() {
    const config = await storage.model();
    if (!config) fail('请先设置图片理解模型');
    return config;
  }
  async function configuredImage() {
    const config = await configured();
    if (!config.imageModel?.trim()) fail('请先设置图片生成模型');
    return config;
  }
  const startSchema = z.object({
    projectId: idSchema,
    sceneId: idSchema,
    layerId: idSchema,
    region: rectSchema,
    manual: z.boolean().default(false),
  });
  function cleanupJobs() {
    for (const [id, job] of jobs)
      if (!['running', 'generating'].includes(job.status) && Date.now() - job.createdAt > 3600e3)
        jobs.delete(id);
    for (const [id, job] of layerJobs)
      if (job.status !== 'generating' && Date.now() - job.createdAt > 3600e3) layerJobs.delete(id);
  }
  app.post('/api/v1/split-jobs', { schema: { body: schema(startSchema) } }, async (req, reply) => {
    cleanupJobs();
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
    const generation = j.generation
      ? {
          completed: j.generation.targets.filter((target) => target.state === 'ready').length,
          total: j.generation.targets.length,
          failed: j.generation.targets.filter((target) => target.state === 'failed').length,
          targets: j.generation.targets.map(({ key, name, state, message }) => ({
            id: key,
            name,
            status: state,
            message,
          })),
        }
      : undefined;
    return {
      id: j.id,
      status: j.status,
      message: j.message,
      region: j.region,
      candidates: j.candidates,
      ...(generation ? { generation } : {}),
      ...(j.resultRevision === undefined ? {} : { resultRevision: j.resultRevision }),
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
    candidates: z.array(candidateSchema).min(1),
  });
  const generateSchema = applySchema.extend({ generateSource: z.boolean().default(true) });

  function validatedCandidates(j: Job, asset: Asset, rows: Candidate[]) {
    const selected = z
      .array(candidateSchema)
      .min(1)
      .parse(rows)
      .filter((c) => c.enabled);
    if (!selected.length) fail('请至少选择一个候选');
    if (new Set(selected.map((c) => c.id)).size !== selected.length) fail('候选 ID 重复');
    if (selected.some((c) => c.id === j.layerId)) fail('候选 ID 不能与来源图层重复');
    return selected.map((candidate) => {
      const r = normalizeRect(candidate, asset.width, asset.height);
      if (
        r.x < j.region.x ||
        r.y < j.region.y ||
        r.x + r.width > j.region.x + j.region.width ||
        r.y + r.height > j.region.y + j.region.height
      )
        fail('候选必须在分析范围内');
      const normalized = { ...candidate, ...r };
      if (normalized.category === 'text' && !normalized.text?.content.trim())
        fail('文字候选必须填写文字内容');
      return normalized;
    });
  }

  async function commitGenerated(j: Job) {
    const generation = j.generation!;
    return storage.serial(j.projectId, async () => {
      const p = await storage.project(j.projectId);
      if (p.receipts?.[generation.operationId]) {
        if (p.receipts[generation.operationId] !== generation.fingerprint)
          fail('操作标识已用于不同内容', 409);
        j.status = 'applied';
        j.resultRevision = p.revision;
        return p;
      }
      if (p.revision !== generation.revision) fail('项目已修改，请重新分析后生成', 409);
      const scene = p.scenes.find((s) => s.id === j.sceneId),
        index = scene?.layers.findIndex((layer) => layer.id === j.layerId) ?? -1,
        source = scene?.layers[index];
      if (!source || source.type !== 'image' || signature(source) !== j.sourceSignature)
        fail('来源图片已改变，请重新分析', 409);
      const originalSource = { ...source },
        originalAsset = await storage.asset(source.assetId),
        assets = new Map(
          generation.targets.map((target) => {
            if (!target.asset) fail('生成结果不完整', 409);
            return [target.key, target.asset] as const;
          }),
        ),
        rootAsset = assets.get(j.layerId),
        layers = [];
      for (const candidate of generation.candidates) {
        if (candidate.category === 'text') {
          layers.push(candidateTextLayer(originalSource, originalAsset, candidate));
          continue;
        }
        const generatedAsset = assets.get(candidate.id),
          candidateAsset =
            generatedAsset || (await storage.crop(originalAsset.id, candidate, candidate.name));
        layers.push(croppedLayer(originalSource, originalAsset, candidate, candidateAsset));
      }
      if (rootAsset) source.assetId = rootAsset.id;
      scene!.layers.splice(index + 1, 0, ...layers);
      p.revision++;
      p.updatedAt = new Date().toISOString();
      p.receipts = { ...p.receipts, [generation.operationId]: generation.fingerprint };
      const result = await storage.writeProject(p);
      j.status = 'applied';
      j.message = `已生成 ${generation.targets.length} 张图片并创建 ${layers.length} 个图层`;
      j.resultRevision = result.revision;
      return result;
    });
  }

  async function runGeneration(j: Job, config: Awaited<ReturnType<typeof configuredImage>> | null) {
    const generation = j.generation!,
      pending = generation.targets.filter((target) => target.state !== 'ready'),
      sourcePath = storage.imagePath(j.source.assetId);
    let cursor = 0;
    const updateProgress = () => {
      const completed = generation.targets.filter((target) => target.state === 'ready').length;
      j.message = `正在重生成 ${completed} / ${generation.targets.length}`;
    };
    const worker = async () => {
      while (!j.controller.signal.aborted) {
        const target = pending[cursor++];
        if (!target) return;
        target.state = 'running';
        target.message = '正在生成';
        try {
          const bytes = await withImageSlot(j.controller.signal, () =>
            regenerateTarget(
              config!,
              sourcePath,
              target,
              options.imageEditor || editImage,
              j.controller.signal,
              options.fetcher,
            ),
          );
          if (j.controller.signal.aborted) return;
          target.asset = await storage.import(bytes, `${target.name} AI 重生成.png`);
          target.state = 'ready';
          target.message = '已完成';
          updateProgress();
        } catch (e) {
          if (j.controller.signal.aborted) return;
          target.state = 'failed';
          target.message = (e as Error).message.slice(0, 500);
          updateProgress();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, pending.length) }, () => worker()));
    if (j.controller.signal.aborted) return;
    const failed = generation.targets.filter((target) => target.state === 'failed');
    if (failed.length) {
      j.status = 'failed';
      j.message = `${failed.length} 张图片生成失败；重试只会请求失败项`;
      return;
    }
    try {
      j.message = '图片生成完成，正在提交项目';
      await commitGenerated(j);
    } catch (e) {
      j.status = 'failed';
      j.message = (e as Error).message.slice(0, 800);
    }
  }

  app.post(
    '/api/v1/split-jobs/:id/generate',
    { schema: { body: schema(generateSchema) } },
    async (req, reply) => {
      const j = getJob((req.params as any).id),
        b = generateSchema.parse(req.body),
        fingerprint = signature({
          jobId: j.id,
          mode: 'generate',
          generateSource: b.generateSource,
          candidates: b.candidates,
        });
      const p = await storage.project(j.projectId);
      if (p.receipts?.[b.operationId]) {
        if (p.receipts[b.operationId] !== fingerprint) fail('操作标识已用于不同内容', 409);
        j.status = 'applied';
        j.resultRevision = p.revision;
        return reply.code(202).send({ id: j.id, status: j.status });
      }
      if (j.generation) {
        if (j.generation.fingerprint !== fingerprint || j.generation.operationId !== b.operationId)
          fail('生成已开始，候选内容不能再修改', 409);
        if (j.status !== 'failed') fail('生成任务当前不可重试', 409);
      } else if (j.status !== 'ready') fail('任务尚不可生成', 409);
      if (p.revision !== b.revision) fail('项目已修改，请重新分析后生成', 409);
      const scene = p.scenes.find((s) => s.id === j.sceneId),
        source = scene?.layers.find((layer) => layer.id === j.layerId);
      if (!source || source.type !== 'image' || signature(source) !== j.sourceSignature)
        fail('来源图片已改变，请重新分析', 409);
      const asset = await storage.asset(source.assetId),
        candidates = validatedCandidates(j, asset, b.candidates);
      if (scene!.layers.length + candidates.length > 1000)
        fail('生成后的场景图层总数不能超过 1000，请减少候选');
      let config: Awaited<ReturnType<typeof configuredImage>> | null = null;
      if (!j.generation) {
        const targets = buildGenerationTargets(source, asset, candidates)
          .filter(
            (target) =>
              (target.root && b.generateSource) ||
              (!target.root &&
                candidates.find((candidate) => candidate.id === target.key)?.generate !== false),
          )
          .map(
            (target): GeneratedTarget => ({
              ...target,
              state: 'pending',
              message: '等待生成',
            }),
          );
        if (targets.length) config = await configuredImage();
        j.candidates = candidates;
        j.generation = {
          fingerprint,
          operationId: b.operationId,
          revision: b.revision,
          generateSource: b.generateSource,
          candidates,
          targets,
        };
      } else {
        if (j.generation.targets.some((target) => target.state !== 'ready'))
          config = await configuredImage();
        for (const target of j.generation.targets)
          if (target.state === 'failed' || target.state === 'running') {
            target.state = 'pending';
            target.message = '等待重试';
          }
      }
      j.controller = new AbortController();
      j.status = 'generating';
      j.message = j.generation.targets.length
        ? `正在重生成 0 / ${j.generation.targets.length}`
        : '正在本地创建图层';
      void runGeneration(j, config);
      return reply.code(202).send({ id: j.id, status: j.status });
    },
  );

  const regenerateLayerSchema = z.object({
    projectId: idSchema,
    sceneId: idSchema,
    layerId: idSchema,
    revision: z.number().int().min(0),
    operationId: idSchema,
  });
  const localRegenerateLayerSchema = z.object({
    projectId: idSchema,
    sceneId: idSchema,
    layerId: idSchema,
    revision: z.number().int().min(0),
    operationId: idSchema,
  });
  const layerJobResult = (job: LayerRegenerationJob) => ({
    id: job.id,
    status: job.status,
    message: job.message,
    generation: {
      completed: job.target.state === 'ready' ? 1 : 0,
      total: 1,
      failed: job.target.state === 'failed' ? 1 : 0,
      targets: [
        {
          id: job.target.key,
          name: job.target.name,
          status: job.target.state,
          message: job.target.message,
        },
      ],
    },
    ...(job.resultRevision === undefined ? {} : { resultRevision: job.resultRevision }),
  });

  async function commitLayerRegeneration(job: LayerRegenerationJob) {
    return storage.serial(job.projectId, async () => {
      const project = await storage.project(job.projectId);
      if (project.receipts?.[job.operationId]) {
        if (project.receipts[job.operationId] !== job.fingerprint)
          fail('操作标识已用于不同内容', 409);
        job.status = 'applied';
        job.resultRevision = project.revision;
        return project;
      }
      if (project.revision !== job.revision) fail('项目已修改，请重新发起图片生成', 409);
      const scene = project.scenes.find((item) => item.id === job.sceneId),
        layer = scene?.layers.find((item) => item.id === job.layerId);
      if (!layer || layer.type !== 'image' || signature(layer) !== job.sourceSignature)
        fail('来源图片已改变，请重新发起图片生成', 409);
      if (!job.target.asset) fail('图片生成结果不完整', 409);
      layer.assetId = job.target.asset.id;
      project.revision++;
      project.updatedAt = new Date().toISOString();
      project.receipts = { ...project.receipts, [job.operationId]: job.fingerprint };
      const result = await storage.writeProject(project);
      job.status = 'applied';
      job.message = '图片已重新生成';
      job.resultRevision = result.revision;
      return result;
    });
  }

  async function runLayerRegeneration(
    job: LayerRegenerationJob,
    config: Awaited<ReturnType<typeof configuredImage>> | null,
  ) {
    try {
      if (!job.target.asset) {
        job.target.state = 'running';
        job.target.message = '正在生成';
        const bytes = await withImageSlot(job.controller.signal, () =>
          regenerateTarget(
            config!,
            job.sourcePath,
            job.target,
            options.imageEditor || editImage,
            job.controller.signal,
            options.fetcher,
          ),
        );
        if (job.controller.signal.aborted) return;
        job.target.asset = await storage.import(bytes, `${job.target.name} AI 重生成.png`);
        job.target.state = 'ready';
        job.target.message = '已完成';
      }
      if (job.controller.signal.aborted) return;
      job.message = '图片生成完成，正在提交项目';
      await commitLayerRegeneration(job);
    } catch (error) {
      if (job.controller.signal.aborted) return;
      if (!job.target.asset) {
        job.target.state = 'failed';
        job.target.message = (error as Error).message.slice(0, 500);
      }
      job.status = 'failed';
      job.message = job.target.asset
        ? `图片已生成，但提交失败：${(error as Error).message.slice(0, 500)}`
        : `图片生成失败：${(error as Error).message.slice(0, 500)}`;
    }
  }

  app.post(
    '/api/v1/layer-local-regeneration',
    { schema: { body: schema(localRegenerateLayerSchema) } },
    async (req) => {
      const body = localRegenerateLayerSchema.parse(req.body),
        fingerprint = signature({ mode: 'local-regenerate-layer', ...body });
      return storage.serial(body.projectId, async () => {
        const project = await storage.project(body.projectId);
        if (project.receipts?.[body.operationId]) {
          if (project.receipts[body.operationId] !== fingerprint)
            fail('操作标识已用于不同内容', 409);
          return project;
        }
        if (project.revision !== body.revision) fail('项目已修改，请保存后重试', 409);
        const scene = project.scenes.find((item) => item.id === body.sceneId),
          layer = scene?.layers.find((item) => item.id === body.layerId);
        if (!layer || layer.type !== 'image') fail('只有图片图层可以重新裁切');
        if (layer.hidden || layer.locked) fail('请选择可见、未锁定的图片');
        if (!layer.source) fail('当前图片没有可重新裁切的来源图层');
        const source = scene?.layers.find((item) => item.id === layer.source!.layerId);
        if (!source || source.type !== 'image') fail('来源图层不存在或不是图片');
        const sourceAsset = await storage.asset(source.assetId),
          layerIndex = scene!.layers.indexOf(layer),
          references = scene!.layers
            .slice(0, layerIndex)
            .filter(
              (item): item is ImageLayer =>
                item.type === 'image' &&
                !item.hidden &&
                item.id !== layer.id &&
                (item.id === source.id || item.source?.layerId === source.id) &&
                containsLayer(item, layer),
            ),
          fullReferences = references.filter((item) => {
            if (item.id === source.id) return true;
            const rect = item.source!.rect;
            return (
              rect.x <= 0 &&
              rect.y <= 0 &&
              rect.x + rect.width >= sourceAsset.width &&
              rect.y + rect.height >= sourceAsset.height
            );
          }),
          reference = fullReferences.at(-1) || references.at(-1) || source,
          referenceAsset = await storage.asset(reference.assetId),
          referenceRect =
            reference.id === source.id
              ? { x: 0, y: 0, width: sourceAsset.width, height: sourceAsset.height }
              : reference.source!.rect,
          points = transformedCorners(layer).map((point) => {
            const local = sourcePoint(reference, referenceAsset, point.x, point.y);
            return {
              x: referenceRect.x + (local.x / referenceAsset.width) * referenceRect.width,
              y: referenceRect.y + (local.y / referenceAsset.height) * referenceRect.height,
            };
          }),
          left = Math.min(...points.map((point) => point.x)),
          top = Math.min(...points.map((point) => point.y)),
          right = Math.max(...points.map((point) => point.x)),
          bottom = Math.max(...points.map((point) => point.y)),
          rect = normalizeRect(
            { x: left, y: top, width: right - left, height: bottom - top },
            sourceAsset.width,
            sourceAsset.height,
          ),
          output = await storage.crop(sourceAsset.id, rect, layer.name);
        layer.assetId = output.id;
        layer.source = { layerId: source.id, rect };
        project.revision++;
        project.updatedAt = new Date().toISOString();
        project.receipts = { ...project.receipts, [body.operationId]: fingerprint };
        return storage.writeProject(project);
      });
    },
  );

  app.post(
    '/api/v1/layer-regeneration-jobs',
    { schema: { body: schema(regenerateLayerSchema) } },
    async (req, reply) => {
      cleanupJobs();
      const body = regenerateLayerSchema.parse(req.body),
        fingerprint = signature({ mode: 'regenerate-layer', ...body }),
        existing = [...layerJobs.values()].find(
          (job) => job.projectId === body.projectId && job.operationId === body.operationId,
        );
      if (existing) {
        if (existing.fingerprint !== fingerprint) fail('操作标识已用于不同内容', 409);
        return reply.code(202).send({ id: existing.id, status: existing.status });
      }
      const project = await storage.project(body.projectId);
      if (project.receipts?.[body.operationId]) {
        if (project.receipts[body.operationId] !== fingerprint) fail('操作标识已用于不同内容', 409);
        const applied: LayerRegenerationJob = {
          ...body,
          id: uid(),
          fingerprint,
          sourceSignature: '',
          sourcePath: '',
          target: {
            key: body.layerId,
            name: '图片',
            rect: { x: 0, y: 0, width: 1, height: 1 },
            category: 'background',
            root: true,
            children: [],
            renderIntent: { alphaMode: 'opaque', visualDescription: '' },
            fullRedraw: true,
            state: 'ready',
            message: '已完成',
          },
          status: 'applied',
          message: '图片已重新生成',
          controller: new AbortController(),
          createdAt: Date.now(),
          resultRevision: project.revision,
        };
        layerJobs.set(applied.id, applied);
        return reply.code(202).send({ id: applied.id, status: applied.status });
      }
      if (project.revision !== body.revision) fail('项目已修改，请重新发起图片生成', 409);
      const scene = project.scenes.find((item) => item.id === body.sceneId),
        layer = scene?.layers.find((item) => item.id === body.layerId);
      if (!layer) fail('来源图层不存在');
      if (layer.type !== 'image') fail('只有图片图层可以重新生成');
      if (layer.hidden || layer.locked) fail('请选择可见、未锁定的图片');
      const config = await configuredImage(),
        asset = await storage.asset(layer.assetId),
        sourcePath = storage.imagePath(asset.id),
        target = buildLayerRegenerationTarget(
          scene!.layers,
          layer,
          asset,
          await imageHasTransparency(sourcePath),
        ),
        job: LayerRegenerationJob = {
          ...body,
          id: uid(),
          fingerprint,
          sourceSignature: signature(layer),
          sourcePath,
          target: { ...target, state: 'pending', message: '等待生成' },
          status: 'generating',
          message: '正在重新生成 0 / 1',
          controller: new AbortController(),
          createdAt: Date.now(),
        };
      layerJobs.set(job.id, job);
      void runLayerRegeneration(job, config);
      return reply.code(202).send({ id: job.id, status: job.status });
    },
  );
  app.get('/api/v1/layer-regeneration-jobs/:id', async (req) =>
    layerJobResult(
      layerJobs.get((req.params as any).id) || fail('任务不存在或服务已重启，请重新生成', 404),
    ),
  );
  app.post('/api/v1/layer-regeneration-jobs/:id/retry', async (req, reply) => {
    const job =
      layerJobs.get((req.params as any).id) || fail('任务不存在或服务已重启，请重新生成', 404);
    if (job.status !== 'failed') fail('任务当前不可重试', 409);
    const project = await storage.project(job.projectId),
      scene = project.scenes.find((item) => item.id === job.sceneId),
      layer = scene?.layers.find((item) => item.id === job.layerId);
    if (
      project.revision !== job.revision ||
      !layer ||
      layer.type !== 'image' ||
      signature(layer) !== job.sourceSignature
    )
      fail('项目或来源图片已改变，请重新发起图片生成', 409);
    const config = job.target.asset ? null : await configuredImage();
    job.controller = new AbortController();
    job.status = 'generating';
    job.message = job.target.asset ? '正在重新提交项目' : '正在重新生成 0 / 1';
    if (!job.target.asset) {
      job.target.state = 'pending';
      job.target.message = '等待重试';
    }
    void runLayerRegeneration(job, config);
    return reply.code(202).send({ id: job.id, status: job.status });
  });
  app.delete('/api/v1/layer-regeneration-jobs/:id', async (req) => {
    const job =
      layerJobs.get((req.params as any).id) || fail('任务不存在或服务已重启，请重新生成', 404);
    if (job.status !== 'applied') {
      job.controller.abort();
      job.status = 'cancelled';
      job.message = '已取消；项目未发生变化';
    }
    return { status: job.status };
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
    for (const j of layerJobs.values()) j.controller.abort();
  });
}
