import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
try {
  process.loadEnvFile();
} catch {}
const host = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', '::1', 'localhost'].includes(host))
  throw new Error('Slice Studio 首期仅支持本机监听');
const root = fileURLToPath(
  new URL(import.meta.url.includes('/dist/') ? '../../data/' : '../data/', import.meta.url),
);
const { app } = await createApp({
  dataDir: root,
  origins: process.env.ALLOWED_ORIGINS?.split(',').map((v) => v.trim()),
});
await app.listen({ port: Number(process.env.PORT || 3002), host });
console.log(`Slice Studio API: http://${host}:${process.env.PORT || 3002}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => void app.close().then(() => process.exit(0)));
