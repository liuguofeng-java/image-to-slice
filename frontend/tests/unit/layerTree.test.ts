import { describe, expect, it } from 'vitest';
import { buildLayerTree, containsLayer, layerPaintOrder } from '../../src/layerTree';
import type { ImageLayer, TextLayer } from '../../src/types';

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

function textLayer(id: string, patch: Partial<TextLayer> = {}): TextLayer {
  return {
    id,
    type: 'text',
    name: id,
    x: 20,
    y: 20,
    width: 40,
    height: 20,
    rotation: 0,
    flipX: false,
    flipY: false,
    opacity: 1,
    hidden: false,
    locked: false,
    content: id,
    fontFamily: 'sans-serif',
    fontSize: 16,
    fontWeight: 400,
    fontStyle: 'normal',
    fill: '#000000',
    align: 'left',
    verticalAlign: 'top',
    lineHeight: 1.2,
    letterSpacing: 0,
    resizeMode: 'auto-width',
    ...patch,
  };
}

describe('automatic layer tree', () => {
  it('accepts touching edges but rejects partial overlap and equal-sized layers', () => {
    const parent = layer('parent', { width: 200, height: 200 });
    expect(containsLayer(parent, layer('edge', { x: 100, y: 100 }))).toBe(true);
    expect(containsLayer(parent, layer('outside', { x: 101, y: 100 }))).toBe(false);
    expect(containsLayer(parent, layer('same', { width: 200, height: 200 }))).toBe(false);
  });

  it('uses transformed rectangular outlines instead of axis-aligned bounds', () => {
    const parent = layer('parent', { x: -50, y: -50, width: 200, height: 200, rotation: 45 });
    expect(containsLayer(parent, layer('inside', { x: 25, y: 25, width: 50, height: 50 }))).toBe(
      true,
    );
    expect(containsLayer(parent, layer('corner', { x: 180, y: 180, width: 10, height: 10 }))).toBe(
      false,
    );
  });

  it('chooses the smallest enclosing layer and creates deep acyclic nesting', () => {
    const outer = layer('outer', { width: 400, height: 400 }),
      middle = layer('middle', { x: 50, y: 50, width: 250, height: 250 }),
      inner = layer('inner', { x: 100, y: 100, width: 50, height: 50 }),
      tree = buildLayerTree([outer, middle, inner]);
    expect(tree.parentById.get('middle')).toBe('outer');
    expect(tree.parentById.get('inner')).toBe('middle');
    expect(tree.roots.map((node) => node.layer.id)).toEqual(['outer']);
    expect(tree.roots[0].children[0].children[0].layer.id).toBe('inner');
  });

  it('breaks equal-area parent candidates by higher z-order and sorts siblings top-first', () => {
    const low = layer('low', { width: 300, height: 200 }),
      high = layer('high', { width: 200, height: 300 }),
      first = layer('first', { x: 20, y: 20, width: 20, height: 20 }),
      second = layer('second', { x: 50, y: 50, width: 20, height: 20 }),
      tree = buildLayerTree([low, high, first, second]);
    expect(tree.parentById.get('first')).toBe('high');
    expect(tree.nodesById.get('high')?.children.map((node) => node.layer.id)).toEqual([
      'second',
      'first',
    ]);
  });

  it('includes hidden and locked layers in hierarchy calculation', () => {
    const parent = layer('parent', { width: 200, height: 200, hidden: true, locked: true }),
      child = layer('child', { x: 20, y: 20, width: 30, height: 30 }),
      tree = buildLayerTree([parent, child]);
    expect(tree.parentById.get('child')).toBe('parent');
  });

  it('paints every descendant above its parent while retaining sibling order', () => {
    const parent = layer('parent', { width: 300, height: 300 }),
      highChild = layer('high-child', { x: 20, y: 20, width: 30, height: 30 }),
      lowChild = layer('low-child', { x: 80, y: 80, width: 30, height: 30 });
    expect(layerPaintOrder([highChild, parent, lowChild]).map((item) => item.id)).toEqual([
      'parent',
      'high-child',
      'low-child',
    ]);
  });

  it('allows text as an image child but never uses text as a container', () => {
    const image = layer('image', { width: 300, height: 200 }),
      title = textLayer('title'),
      badge = layer('badge', { x: 22, y: 22, width: 10, height: 10 }),
      tree = buildLayerTree([image, title, badge]);
    expect(tree.parentById.get('title')).toBe('image');
    expect(tree.parentById.get('badge')).toBe('image');
    expect(tree.parentById.get('badge')).not.toBe('title');
    expect(layerPaintOrder([title, image]).map((item) => item.id)).toEqual(['image', 'title']);
  });
});
