import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateTextLayer,
  documentSchema,
  parseStoredDocument,
  textLayerSchema,
  type ImageLayer,
} from '../src/domain.js';

const base = {
  id: 'layer',
  name: '图层',
  x: 0,
  y: 0,
  width: 100,
  height: 40,
  rotation: 0,
  flipX: false,
  flipY: false,
  opacity: 1,
  hidden: false,
  locked: false,
};

test('stored projects migrate missing layer type, while the write contract stays strict', () => {
  const legacy = {
    name: '旧项目',
    activeSceneId: 'scene',
    scenes: [
      {
        id: 'scene',
        name: '场景',
        width: 800,
        height: 600,
        layers: [{ ...base, assetId: 'asset', radius: 0 }],
      },
    ],
  };
  assert.equal(parseStoredDocument(legacy).scenes[0].layers[0].type, 'image');
  assert.equal(documentSchema.safeParse(legacy).success, false);
});

test('text validation rejects invalid colors and oversized content', () => {
  const valid = {
    ...base,
    type: 'text' as const,
    content: '可编辑文字',
    fontFamily: 'Microsoft YaHei',
    fontSize: 24,
    fontWeight: 400,
    fontStyle: 'normal' as const,
    fill: '#12abEF80',
    align: 'left' as const,
    verticalAlign: 'top' as const,
    lineHeight: 1.2,
    letterSpacing: 0,
    resizeMode: 'auto-height' as const,
  };
  assert.equal(textLayerSchema.safeParse(valid).success, true);
  assert.equal(textLayerSchema.safeParse({ ...valid, fill: 'red' }).success, false);
  assert.equal(textLayerSchema.safeParse({ ...valid, content: 'x'.repeat(20001) }).success, false);
});

test('AI text layers map ROI position and text metrics without changing source pixels', () => {
  const source: ImageLayer = {
    ...base,
    type: 'image',
    assetId: 'asset',
    radius: 0,
    width: 200,
    height: 100,
  };
  const layer = candidateTextLayer(
    source,
    { id: 'asset', name: '源图', width: 100, height: 50 },
    {
      id: 'candidate',
      name: '标题',
      category: 'text',
      enabled: true,
      x: 10,
      y: 5,
      width: 50,
      height: 10,
      text: {
        content: '  开始游戏  ',
        fontFamily: 'sans-serif',
        fontSize: 12,
        fontWeight: 700,
        fontStyle: 'normal',
        fill: '#ffffff',
        align: 'center',
        verticalAlign: 'middle',
        lineHeight: 1.2,
        letterSpacing: 1.5,
        resizeMode: 'fixed',
      },
    },
  );
  assert.equal(layer.type, 'text');
  assert.equal(layer.content, '开始游戏');
  assert.equal(layer.fontSize, 24);
  assert.equal(layer.letterSpacing, 3);
  assert.deepEqual(layer.source?.rect, { x: 10, y: 5, width: 50, height: 10 });
});
