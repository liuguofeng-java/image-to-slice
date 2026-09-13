import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  buildGenerationTargets,
  buildLayerRegenerationTarget,
  imageHasTransparency,
  regenerateTarget,
} from '../src/regeneration.js';
import {
  point,
  type Asset,
  type Candidate,
  type ImageLayer,
  type TextLayer,
} from '../src/domain.js';

const layer: ImageLayer = {
  id: 'source',
  type: 'image',
  assetId: 'asset',
  name: '来源',
  x: 10,
  y: 20,
  width: 80,
  height: 60,
  rotation: 25,
  flipX: true,
  flipY: false,
  opacity: 1,
  radius: 0,
  locked: false,
  hidden: false,
};
const asset: Asset = { id: 'asset', name: 'source.png', width: 40, height: 30 };

test('candidate tree selects the smallest containing image parent and keeps text out of targets', () => {
  const candidates: Candidate[] = [
    {
      id: 'panel',
      name: '面板',
      category: 'background',
      enabled: true,
      x: 2,
      y: 2,
      width: 30,
      height: 24,
    },
    { id: 'icon', name: '图标', category: 'icon', enabled: true, x: 5, y: 5, width: 8, height: 8 },
    {
      id: 'text',
      name: '文字',
      category: 'text',
      enabled: true,
      x: 6,
      y: 6,
      width: 3,
      height: 2,
      text: {
        content: 'A',
        fontFamily: 'sans-serif',
        fontSize: 2,
        fontWeight: 400,
        fontStyle: 'normal',
        fill: '#fff',
        align: 'left',
        verticalAlign: 'top',
        lineHeight: 1.2,
        letterSpacing: 0,
        resizeMode: 'fixed',
      },
    },
  ];
  const targets = buildGenerationTargets(layer, asset, candidates);
  assert.deepEqual(
    targets.map((target) => target.key),
    ['source', 'panel', 'icon'],
  );
  assert.deepEqual(
    targets[0].children.map((child) => child.id),
    ['panel'],
  );
  assert.deepEqual(
    targets[1].children.map((child) => child.id),
    ['icon'],
  );
  assert.deepEqual(
    targets[2].children.map((child) => child.id),
    ['text'],
  );
  assert.equal(targets[0].renderIntent.alphaMode, 'opaque');
  assert.equal(targets[2].renderIntent.alphaMode, 'cutout');
});

test('parent generation changes only masked child pixels while leaf uses the complete result', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'slice-regeneration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'source.png');
  await sharp({ create: { width: 40, height: 30, channels: 4, background: '#ff0000' } })
    .png()
    .toFile(path);
  const candidate: Candidate = {
    id: 'leaf',
    name: '叶子',
    category: 'image',
    enabled: true,
    x: 12,
    y: 8,
    width: 8,
    height: 6,
  };
  const targets = buildGenerationTargets(layer, asset, [candidate]);
  const editor = async (_config: any, input: any) => {
    const [width, height] = input.size.split('x').map(Number);
    return sharp({ create: { width, height, channels: 4, background: '#0000ff' } })
      .png()
      .toBuffer();
  };
  const config = {
    baseUrl: 'http://localhost',
    model: 'vision',
    imageModel: 'image',
    timeoutSeconds: 10,
  };
  const root = await regenerateTarget(
    config,
    path,
    targets[0],
    editor,
    new AbortController().signal,
  );
  const rootMeta = await sharp(root).metadata(),
    rootRaw = await sharp(root).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual(
    { width: rootMeta.width, height: rootMeta.height },
    { width: 1365, height: 1024 },
  );
  const pixel = (x: number, y: number) => [
    ...rootRaw.data.subarray(
      (y * rootRaw.info.width + x) * 4,
      (y * rootRaw.info.width + x) * 4 + 4,
    ),
  ];
  assert.deepEqual(pixel(0, 0), [255, 0, 0, 255]);
  assert.ok(pixel(546, 375)[2] > 200);
  const leaf = await regenerateTarget(
    config,
    path,
    targets[1],
    editor,
    new AbortController().signal,
  );
  const meta = await sharp(leaf).metadata(),
    leafPixel = await sharp(leaf)
      .extract({ left: 3, top: 2, width: 1, height: 1 })
      .raw()
      .toBuffer();
  assert.deepEqual({ width: meta.width, height: meta.height }, { width: 1365, height: 1024 });
  assert.deepEqual([...leafPixel], [0, 0, 255, 255]);
});

test('single layer regeneration redacts direct children, edits only their mask and preserves dimensions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'single-regeneration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'source.png');
  await sharp({ create: { width: 40, height: 30, channels: 4, background: '#ff0000' } })
    .png()
    .toFile(path);
  const center = point(layer, 14, 11, asset),
    child: ImageLayer = {
      ...layer,
      id: 'direct-child',
      name: '独立文字',
      x: center.x - 8,
      y: center.y - 6,
      width: 16,
      height: 12,
      rotation: layer.rotation,
      flipX: false,
      flipY: false,
    },
    grandchild: TextLayer = {
      id: 'grandchild',
      type: 'text',
      name: '更深子节点',
      x: center.x - 2,
      y: center.y - 2,
      width: 4,
      height: 4,
      rotation: layer.rotation,
      flipX: false,
      flipY: false,
      opacity: 1,
      locked: false,
      hidden: false,
      content: '不应生成',
      fontFamily: 'sans-serif',
      fontSize: 8,
      fontWeight: 400,
      fontStyle: 'normal',
      fill: '#ffffff',
      align: 'center',
      verticalAlign: 'middle',
      lineHeight: 1.2,
      letterSpacing: 0,
      resizeMode: 'fixed',
    },
    target = buildLayerRegenerationTarget([layer, child, grandchild], layer, asset, false);
  assert.deepEqual(
    target.children.map((item) => item.id),
    ['direct-child'],
  );
  assert.equal(target.fullRedraw, false);
  let captured: any;
  const output = await regenerateTarget(
    {
      baseUrl: 'http://localhost',
      model: 'vision',
      imageModel: 'image',
      timeoutSeconds: 10,
    },
    path,
    target,
    async (_config, input) => {
      captured = input;
      const [width, height] = input.size.split('x').map(Number);
      return sharp({ create: { width, height, channels: 4, background: '#0000ff' } })
        .png()
        .toBuffer();
    },
    new AbortController().signal,
  );
  const maskStats = await sharp(captured.mask).ensureAlpha().stats(),
    imageStats = await sharp(captured.image).ensureAlpha().stats(),
    meta = await sharp(output).metadata(),
    pixel = await sharp(output).extract({ left: 2, top: 2, width: 1, height: 1 }).raw().toBuffer();
  assert.equal(maskStats.channels[3].min, 0);
  assert.equal(maskStats.channels[3].max, 255);
  assert.equal(imageStats.channels[3].min, 0);
  assert.match(captured.prompt, /independent child layers/);
  assert.deepEqual({ width: meta.width, height: meta.height }, { width: 1365, height: 1024 });
  assert.deepEqual([...pixel], [255, 0, 0, 255]);
  assert.equal(await imageHasTransparency(path), false);
  await sharp(path)
    .composite([
      {
        input: {
          create: {
            width: 40,
            height: 30,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0.5 },
          },
        },
        blend: 'dest-in',
      },
    ])
    .png()
    .toFile(join(dir, 'transparent.png'));
  assert.equal(await imageHasTransparency(join(dir, 'transparent.png')), true);
});

test('translucent containers fully redraw at model resolution with transparent background', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'translucent-regeneration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'source.png');
  await sharp({ create: { width: 40, height: 30, channels: 4, background: '#ff0000' } })
    .png()
    .toFile(path);
  const target = buildGenerationTargets(layer, asset, [
    {
      id: 'panel',
      name: '半透明面板',
      category: 'background',
      enabled: true,
      x: 2,
      y: 2,
      width: 30,
      height: 24,
      renderIntent: {
        alphaMode: 'translucent',
        visualDescription: '深灰蓝色半透明面板，边框和高光更清晰。',
      },
    },
    {
      id: 'child',
      name: '面板内容',
      category: 'image',
      enabled: true,
      x: 8,
      y: 8,
      width: 8,
      height: 6,
    },
  ])[1];
  assert.equal(target.fullRedraw, true);
  let captured: any;
  const output = await regenerateTarget(
    { baseUrl: 'http://localhost', model: 'vision', imageModel: 'image', timeoutSeconds: 10 },
    path,
    target,
    async (_config, input) => {
      captured = input;
      const [width, height] = input.size.split('x').map(Number);
      return sharp({ create: { width, height, channels: 4, background: '#0000ff' } })
        .png()
        .toBuffer();
    },
    new AbortController().signal,
  );
  const meta = await sharp(output).metadata();
  assert.equal(captured.background, 'transparent');
  assert.match(captured.prompt, /semi-transparent|partial alpha|translucent/i);
  assert.deepEqual({ width: meta.width, height: meta.height }, { width: 1280, height: 1024 });
});

test('transparent icon accepts the provider result without alpha semantics validation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'icon-fallback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'source.png');
  await sharp({ create: { width: 40, height: 30, channels: 4, background: '#456789' } })
    .png()
    .toFile(path);
  const target = buildGenerationTargets(layer, asset, [
    {
      id: 'icon',
      name: '箭头',
      category: 'icon',
      enabled: true,
      x: 4,
      y: 5,
      width: 8,
      height: 9,
    },
  ])[1];
  const output = await regenerateTarget(
    { baseUrl: 'http://localhost', model: 'vision', imageModel: 'image', timeoutSeconds: 10 },
    path,
    target,
    async (_config, input) => {
      const [width, height] = input.size.split('x').map(Number);
      return sharp({ create: { width, height, channels: 3, background: '#000000' } })
        .png()
        .toBuffer();
    },
    new AbortController().signal,
  );
  const meta = await sharp(output).metadata(),
    pixel = await sharp(output)
      .extract({ left: 100, top: 100, width: 1, height: 1 })
      .raw()
      .toBuffer();
  assert.deepEqual({ width: meta.width, height: meta.height }, { width: 910, height: 1024 });
  assert.deepEqual([...pixel], [0, 0, 0]);
});
