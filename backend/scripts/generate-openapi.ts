import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/app.js';

const dataDir = await mkdtemp(join(tmpdir(), 'slice-openapi-'));
try {
  const { app } = await createApp({ dataDir });
  await app.ready();
  const response = await app.inject('/openapi.json');
  if (response.statusCode !== 200) throw new Error(`OpenAPI generation failed: ${response.body}`);
  await writeFile(resolve('../docs/openapi.json'), `${JSON.stringify(response.json(), null, 2)}\n`);
  await app.close();
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
