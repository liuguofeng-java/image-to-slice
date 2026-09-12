import type { Layer } from './domain.js';

interface Point {
  x: number;
  y: number;
}

interface Node {
  layer: Layer;
  children: Node[];
}

const EPSILON = 1e-7;

function corners(layer: Layer): Point[] {
  const cx = layer.x + layer.width / 2,
    cy = layer.y + layer.height / 2,
    radians = (layer.rotation * Math.PI) / 180,
    cos = Math.cos(radians),
    sin = Math.sin(radians);
  return [
    [-layer.width / 2, -layer.height / 2],
    [layer.width / 2, -layer.height / 2],
    [layer.width / 2, layer.height / 2],
    [-layer.width / 2, layer.height / 2],
  ].map(([x, y]) => ({ x: cx + x * cos - y * sin, y: cy + x * sin + y * cos }));
}

function contains(parent: Layer, child: Layer) {
  const parentArea = parent.width * parent.height,
    childArea = child.width * child.height,
    areaTolerance = Math.max(1, parentArea, childArea) * EPSILON;
  if (parentArea <= childArea + areaTolerance) return false;
  const cx = parent.x + parent.width / 2,
    cy = parent.y + parent.height / 2,
    radians = (parent.rotation * Math.PI) / 180,
    cos = Math.cos(radians),
    sin = Math.sin(radians),
    tolerance = Math.max(1, parent.width, parent.height) * EPSILON;
  return corners(child).every((point) => {
    const dx = point.x - cx,
      dy = point.y - cy,
      x = dx * cos + dy * sin,
      y = -dx * sin + dy * cos;
    return (
      Math.abs(x) <= parent.width / 2 + tolerance && Math.abs(y) <= parent.height / 2 + tolerance
    );
  });
}

/** 与前端画布一致：父层先合成、子孙后合成，同级保留原叠放关系。 */
export function layerPaintOrder(layers: Layer[]) {
  const entries = layers.map((layer, index) => ({
      layer,
      index,
      area: layer.width * layer.height,
    })),
    nodes = new Map<string, Node>(layers.map((layer) => [layer.id, { layer, children: [] }])),
    parents = new Map<string, string>();
  for (const child of entries) {
    let best: (typeof entries)[number] | undefined;
    for (const candidate of entries) {
      if (
        candidate.layer.id === child.layer.id ||
        candidate.layer.type !== 'image' ||
        !contains(candidate.layer, child.layer)
      )
        continue;
      if (!best) best = candidate;
      else {
        const tolerance = Math.max(1, candidate.area, best.area) * EPSILON;
        if (
          candidate.area < best.area - tolerance ||
          (Math.abs(candidate.area - best.area) <= tolerance && candidate.index > best.index)
        )
          best = candidate;
      }
    }
    if (best) parents.set(child.layer.id, best.layer.id);
  }
  const roots: Node[] = [];
  for (const entry of entries) {
    const node = nodes.get(entry.layer.id)!,
      parent = parents.get(entry.layer.id);
    if (parent) nodes.get(parent)!.children.push(node);
    else roots.push(node);
  }
  const order = new Map(entries.map((entry) => [entry.layer.id, entry.index]));
  const sort = (list: Node[]) => {
    list.sort((a, b) => order.get(b.layer.id)! - order.get(a.layer.id)!);
    for (const node of list) sort(node.children);
  };
  sort(roots);
  const result: Layer[] = [];
  const visit = (list: Node[]) => {
    for (const node of [...list].reverse()) {
      result.push(node.layer);
      visit(node.children);
    }
  };
  visit(roots);
  return result;
}
