import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { analyze, editImage } from '../src/provider.js';
test('vision request provides whole-image context and precise ROI coordinates', async (t) => {
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
    const context = Buffer.from(body.messages[1].content[1].image_url.url.split(',')[1], 'base64'),
      detail = Buffer.from(body.messages[1].content[3].image_url.url.split(',')[1], 'base64'),
      contextMeta = await sharp(context).metadata(),
      detailMeta = await sharp(detail).metadata();
    assert.equal(contextMeta.width, 1600);
    assert.equal(contextMeta.height, 1200);
    assert.equal(detailMeta.width, 1600);
    assert.equal(detailMeta.height, 800);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                elements: [
                  {
                    name: 'panel',
                    category: 'background',
                    x: 20,
                    y: 10,
                    width: 40,
                    height: 20,
                    renderIntent: {
                      alphaMode: 'translucent',
                      visualDescription: '深灰蓝玻璃面板，描边清晰，背景透出',
                    },
                  },
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
  assert.equal(rows[0].renderIntent?.alphaMode, 'translucent');
  assert.equal(rows[0].renderIntent?.visualDescription, '深灰蓝玻璃面板，描边清晰，背景透出');
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
test('image edit sends multipart fields and accepts only inline image bytes', async () => {
  const source = await sharp({ create: { width: 12, height: 8, channels: 4, background: 'white' } })
      .png()
      .toBuffer(),
    mask = await sharp({
      create: {
        width: 12,
        height: 8,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 0 },
      },
    })
      .png()
      .toBuffer(),
    output = await sharp({
      create: { width: 1024, height: 1024, channels: 4, background: '#336699' },
    })
      .png()
      .toBuffer();
  let requests = 0;
  const result = await editImage(
    {
      baseUrl: 'http://localhost:8080/v1',
      model: 'vision',
      imageModel: 'configured-image-model',
      imageQuality: 'xhigh',
      apiKey: 'private',
      timeoutSeconds: 10,
    },
    {
      image: source,
      mask,
      prompt: 'fixed prompt',
      size: '1024x1024',
      background: 'transparent',
    },
    new AbortController().signal,
    async (url, init) => {
      requests++;
      assert.equal(url, 'http://localhost:8080/v1/images/edits');
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer private');
      assert.equal((init?.headers as Record<string, string>)['Content-Type'], undefined);
      assert.equal(init?.redirect, 'error');
      const form = init?.body as FormData;
      assert.equal(form.get('model'), 'configured-image-model');
      assert.equal(form.get('prompt'), 'fixed prompt');
      assert.equal(form.get('quality'), 'xhigh');
      assert.equal(form.get('input_fidelity'), 'high');
      assert.equal(form.get('background'), 'transparent');
      assert.equal(form.get('size'), '1024x1024');
      assert.ok(form.get('image[]') instanceof Blob);
      assert.ok(form.get('mask') instanceof Blob);
      return new Response(JSON.stringify({ data: [{ b64_json: output.toString('base64') }] }));
    },
  );
  assert.equal(requests, 1);
  assert.equal((await sharp(result).metadata()).format, 'png');
});
