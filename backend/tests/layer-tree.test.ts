import test from 'node:test';
import assert from 'node:assert/strict';
import { layerPaintOrder } from '../src/layer-tree.js';
import type { ImageLayer } from '../src/domain.js';

function layer(id: string, patch: Partial<ImageLayer> = {}): ImageLayer {
  return {
    id,
    type: 'image',
    assetId: 'asset',
    name: id,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    flipX: false,
    flipY: false,
    opacity: 1,
    radius: 0,
    hidden: false,
    locked: false,
    ...patch,
  };
}

test('scene paint order keeps descendants above parents', () => {
  const child = layer('child', { x: 20, y: 20, width: 40, height: 40 }),
    parent = layer('parent', { width: 200, height: 200 }),
    sibling = layer('sibling', { x: 100, y: 100, width: 30, height: 30 });
  assert.deepEqual(
    layerPaintOrder([child, parent, sibling]).map((item) => item.id),
    ['parent', 'child', 'sibling'],
  );
});
