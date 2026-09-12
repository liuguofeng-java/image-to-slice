import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { analyze } from '../src/provider.js';
test('vision request uses configured model, only ROI, and maps downscaled result to original pixels', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'slice-provider-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'source.png');
  await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#c0ffee' } })
    .png()
    .toFile(path);
  let requests = 0;
  const fetcher: typeof fetch = async (url, init) => {
    requests++;
    assert.equal(url, 'http://localhost:8080/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'configured-vision');
    assert.equal(body.stream, false);
    const png = Buffer.from(body.messages[1].content[1].image_url.url.split(',')[1], 'base64'),
      meta = await sharp(png).metadata();
    assert.equal(meta.width, 1600);
    assert.equal(meta.height, 800);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                elements: [
                  { name: 'icon', category: 'icon', x: 20, y: 10, width: 40, height: 20 },
                  {
                    name: 'title',
                    category: 'text',
                    x: 100,
                    y: 40,
                    width: 200,
                    height: 50,
                    text: {
                      content: '开始游戏',
                      fontFamily: '',
                      fontSize: 20,
                      fontWeight: 950,
                      fill: 'not-a-color',
                      lineHeight: 0,
                      letterSpacing: 2,
                      align: 'center',
                    },
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
  };
  const rows = await analyze(
    {
      baseUrl: 'http://localhost:8080',
      model: 'configured-vision',
      apiKey: 'only-backend',
      timeoutSeconds: 10,
    },
    path,
    { x: 100, y: 200, width: 3200, height: 1600 },
    new AbortController().signal,
    fetcher,
  );
  assert.equal(requests, 1);
  assert.deepEqual(
    { x: rows[0].x, y: rows[0].y, width: rows[0].width, height: rows[0].height },
    { x: 140, y: 220, width: 80, height: 40 },
  );
  assert.equal(rows[1].text?.content, '开始游戏');
  assert.equal(rows[1].text?.fontSize, 40);
  assert.equal(rows[1].text?.letterSpacing, 4);
  assert.equal(rows[1].text?.fontFamily, 'sans-serif');
  assert.equal(rows[1].text?.fontWeight, 400);
  assert.equal(rows[1].text?.fill, '#000000');
  assert.equal(rows[1].text?.lineHeight, 1.2);
  assert.equal(rows[1].text?.align, 'center');
});
test('empty, malformed and oversized model results fail without retry', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'slice-provider-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'source.png');
  await sharp({ create: { width: 40, height: 30, channels: 3, background: 'white' } })
    .png()
    .toFile(path);
  for (const response of [
    'not json',
    '{"elements":[]}',
    JSON.stringify({
      elements: [{ name: 'outside', category: 'image', x: 200, y: 0, width: 10, height: 10 }],
    }),
    JSON.stringify({
      elements: Array.from({ length: 201 }, () => ({
        name: 'a',
        category: 'image',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      })),
    }),
  ]) {
    let requests = 0;
    await assert.rejects(
      analyze(
        { baseUrl: 'http://localhost:8080', model: 'fake', timeoutSeconds: 10 },
        path,
        { x: 0, y: 0, width: 40, height: 30 },
        new AbortController().signal,
        async () => {
          requests++;
          return new Response(JSON.stringify({ choices: [{ message: { content: response } }] }));
        },
      ),
    );
    assert.equal(requests, 1);
  }
});
