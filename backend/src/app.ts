import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { Storage } from './storage.js';
import { editImage, providerRequest, type Analyzer, type ImageEditor } from './provider.js';
import { documentSchema, fail, idSchema, modelSchema } from './domain.js';
import { schema, registerResponseContracts } from './contracts.js';
import { registerSplitRoutes } from './split-routes.js';
import { exportProject } from './exports.js';
export async function createApp(options: {
  dataDir: string;
  origins?: string[];
  analyzer?: Analyzer;
  imageEditor?: ImageEditor;
  fetcher?: typeof fetch;
}) {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  const storage = new Storage(options.dataDir);
  await storage.init();
  const origins = options.origins || ['http://127.0.0.1:4174', 'http://localhost:4174'];
  await app.register(cors, { origin: origins, methods: ['GET', 'POST', 'PUT', 'DELETE'] });
  await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024, files: 1 } });
  await app.register(swagger, {
    openapi: {
      info: { title: 'Slice Studio API', version: '1.0.0' },
      servers: [{ url: 'http://127.0.0.1:3002' }],
    },
  });
  registerResponseContracts(app);
  app.addHook('onRequest', async (req) => {
    const origin = req.headers.origin;
    if (origin && !origins.includes(origin)) fail('不允许的请求来源', 403);
    if (req.headers['sec-fetch-site'] === 'cross-site' && !origin) fail('不允许跨站访问', 403);
    const host = req.hostname;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) fail('不允许的主机名', 403);
  });
  app.setErrorHandler((e: any, _req, reply) => {
    const status = e instanceof z.ZodError ? 400 : e.statusCode || 500;
    reply
      .code(status)
      .send({ error: status === 500 ? '操作失败，请重试' : String(e.message).slice(0, 800) });
  });
  app.get('/health', () => ({ status: 'ok', version: '0.1.0' }));
  app.get('/openapi.json', () => app.swagger());
  app.get('/api/v1/projects', async () => ({ projects: await storage.list() }));
  app.post(
    '/api/v1/projects',
    {
      schema: { body: schema(z.object({ name: z.string().min(1).max(200).default('Untitled') })) },
    },
    async (req) => storage.create((req.body as any).name),
  );
  app.get('/api/v1/projects/:id', async (req) => storage.project((req.params as any).id));
  app.put(
    '/api/v1/projects/:id',
    {
      schema: {
        body: schema(z.object({ revision: z.number().int().min(0), document: documentSchema })),
      },
    },
    async (req) => {
      const b = req.body as any;
      return storage.save((req.params as any).id, b.revision, documentSchema.parse(b.document));
    },
  );
  app.post('/api/v1/assets', { schema: { consumes: ['multipart/form-data'] } }, async (req) => {
    const file = await req.file();
    if (!file) fail('请选择图片');
    return storage.import(await file.toBuffer(), file.filename);
  });
  app.get('/api/v1/assets/:id', async (req) => storage.asset((req.params as any).id));
  app.get('/api/v1/assets/:id/image', async (req, reply) => {
    const id = (req.params as any).id;
    await storage.asset(id);
    return reply
      .type('image/png')
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(await readFile(storage.imagePath(id)));
  });
  function publicConfig(c: any) {
    if (!c) return null;
    const { apiKey, ...rest } = c;
    return { ...rest, imageQuality: c.imageQuality || 'max', hasApiKey: !!apiKey };
  }
  app.get('/api/v1/model-configs', async () => ({ config: publicConfig(await storage.model()) }));
  app.put('/api/v1/model-configs', { schema: { body: schema(modelSchema) } }, async (req) => ({
    config: publicConfig(await storage.saveModel(modelSchema.parse(req.body))),
  }));
  async function configured() {
    const c = await storage.model();
    if (!c) fail('请先设置图片理解模型');
    return c;
  }
  async function withDisconnect<T>(
    request: any,
    reply: any,
    operation: (signal: AbortSignal) => Promise<T>,
  ) {
    const c = new AbortController();
    const close = () => {
      if (!reply.raw.writableEnded) c.abort();
    };
    reply.raw.once('close', close);
    try {
      return await operation(c.signal);
    } finally {
      reply.raw.off('close', close);
    }
  }
  app.post('/api/v1/model-configs/models', async (req, reply) =>
    withDisconnect(req, reply, async (signal) => {
      const result = await providerRequest(
        await configured(),
        'models',
        undefined,
        signal,
        options.fetcher,
      );
      return {
        models: (result.data || []).map((m: any) => m.id).filter((m: any) => typeof m === 'string'),
      };
    }),
  );
  app.post('/api/v1/model-configs/test', async (req, reply) =>
    withDisconnect(req, reply, async (signal) => {
      const c = await configured();
      const sharp = (await import('sharp')).default;
      const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'white' } })
        .png()
        .toBuffer();
      const result = await providerRequest(
        c,
        'chat/completions',
        {
          model: c.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Describe this image in one word.' },
                {
                  type: 'image_url',
                  image_url: { url: 'data:image/png;base64,' + png.toString('base64') },
                },
              ],
            },
          ],
          max_tokens: 32,
          stream: false,
        },
        signal,
        options.fetcher,
      );
      if (!result.choices?.[0]?.message?.content) fail('模型未返回内容', 502);
      return { status: 'success' };
    }),
  );
  app.post('/api/v1/model-configs/test-image', async (req, reply) =>
    withDisconnect(req, reply, async (signal) => {
      const c = await configured();
      if (!c.imageModel?.trim()) fail('请先设置图片生成模型');
      const sharp = (await import('sharp')).default;
      const png = await sharp({
        create: { width: 64, height: 64, channels: 4, background: '#f0f0f0' },
      })
        .png()
        .toBuffer();
      const mask = await sharp({
        create: {
          width: 64,
          height: 64,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 0 },
        },
      })
        .png()
        .toBuffer();
      await (options.imageEditor || editImage)(
        c,
        {
          image: png,
          mask,
          prompt: 'Create a plain light gray square with no text, icons, or objects.',
          size: '1024x1024',
          background: 'opaque',
        },
        signal,
        options.fetcher,
      );
      return { status: 'success' };
    }),
  );
  registerSplitRoutes(app, storage, options);
  app.post(
    '/api/v1/exports',
    {
      schema: {
        body: schema(
          z.object({
            projectId: idSchema,
            sceneId: idSchema,
            kind: z.enum(['png', 'zip', 'scene']),
            layerIds: z.array(idSchema).max(1000),
          }),
        ),
      },
    },
    async (req, reply) => {
      const b = req.body as any;
      const r = await exportProject(
        storage,
        await storage.project(b.projectId),
        b.sceneId,
        b.kind,
        b.layerIds,
      );
      return reply
        .type(r.type)
        .header('Content-Disposition', `attachment; filename="${r.name}"`)
        .send(r.bytes);
    },
  );
  return { app, storage };
}
