// Only the explicit test:server command uses this mock. Production has no mock routes.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
const dir = await mkdtemp(join(tmpdir(), 'slice-studio-e2e-'));
const { app, storage } = await createApp({
  dataDir: dir,
  origins: ['http://127.0.0.1:4175'],
  analyzer: async (_c, _p, r, signal) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (signal.aborted) throw new Error('cancelled');
    return [
      {
        id: 'mock-1',
        name: '标题区域',
        category: 'text',
        enabled: true,
        x: r.x,
        y: r.y,
        width: Math.max(1, Math.floor(r.width / 2)),
        height: Math.max(1, Math.floor(r.height / 3)),
        text: {
          content: '探索自然',
          fontFamily: 'sans-serif',
          fontSize: 22,
          fontWeight: 700,
          fontStyle: 'normal',
          fill: '#ffffff',
          align: 'left',
          verticalAlign: 'top',
          lineHeight: 1.2,
          letterSpacing: 0,
          resizeMode: 'auto-height',
        },
      },
    ];
  },
  fetcher: async (_url, options) =>
    new Response(
      JSON.stringify(
        options?.method === 'POST'
          ? { choices: [{ message: { content: 'white' } }] }
          : { data: [{ id: 'mock-vision' }] },
      ),
      { headers: { 'Content-Type': 'application/json' } },
    ),
});
await storage.saveModel({
  baseUrl: 'http://localhost:9999',
  model: 'mock-vision',
  timeoutSeconds: 120,
  apiKey: 'e2e-only-not-a-real-secret',
});
await app.listen({ host: '127.0.0.1', port: 3003 });
for (const event of ['SIGINT', 'SIGTERM'] as const)
  process.on(event, async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
    process.exit(0);
  });
