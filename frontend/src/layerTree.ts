import type { Layer } from './types';

export interface LayerTreeNode {
  layer: Layer;
  children: LayerTreeNode[];
}

export interface LayerTree {
  roots: LayerTreeNode[];
  nodesById: Map<string, LayerTreeNode>;
  parentById: Map<string, string>;
}

interface Point {
  x: number;
  y: number;
}

const EPSILON = 1e-7;

/** 图片的变换后矩形轮廓；翻转不会改变矩形覆盖区域。 */
export function transformedCorners(layer: Layer): Point[] {
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

/** 完整轮廓包含才建立父子关系；同面积图片永远不会互相成为父级。 */
export function containsLayer(parent: Layer, child: Layer) {
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
  return transformedCorners(child).every((point) => {
    const dx = point.x - cx,
      dy = point.y - cy,
      // 逆旋转到父图片的局部坐标，再与其矩形边界比较。
      x = dx * cos + dy * sin,
      y = -dx * sin + dy * cos;
    return (
      Math.abs(x) <= parent.width / 2 + tolerance && Math.abs(y) <= parent.height / 2 + tolerance
    );
  });
}

/**
 * scene.layers 从底到顶保存叠放顺序。树中选择最小容器作为直接父级，
 * 面积相同时选择叠放位置更高者；根和同级节点也按顶到底排列。
 */
export function buildLayerTree(layers: Layer[]): LayerTree {
  const entries = layers.map((layer, index) => ({
      layer,
      index,
      area: layer.width * layer.height,
    })),
    nodesById = new Map<string, LayerTreeNode>(
      layers.map((layer) => [layer.id, { layer, children: [] }]),
    ),
    parentById = new Map<string, string>();

  for (const child of entries) {
    let best: (typeof entries)[number] | undefined;
    for (const candidate of entries) {
      if (
        candidate.layer.id === child.layer.id ||
        candidate.layer.type !== 'image' ||
        !containsLayer(candidate.layer, child.layer)
      )
        continue;
      if (!best) {
        best = candidate;
        continue;
      }
      const tolerance = Math.max(1, candidate.area, best.area) * EPSILON;
      if (
        candidate.area < best.area - tolerance ||
        (Math.abs(candidate.area - best.area) <= tolerance && candidate.index > best.index)
      )
        best = candidate;
    }
    if (best) parentById.set(child.layer.id, best.layer.id);
  }

  const roots: LayerTreeNode[] = [];
  for (const entry of entries) {
    const node = nodesById.get(entry.layer.id)!,
      parentId = parentById.get(entry.layer.id);
    if (parentId) nodesById.get(parentId)!.children.push(node);
    else roots.push(node);
  }
  const order = new Map(entries.map((entry) => [entry.layer.id, entry.index]));
  const sort = (nodes: LayerTreeNode[]) => {
    nodes.sort((a, b) => order.get(b.layer.id)! - order.get(a.layer.id)!);
    for (const node of nodes) sort(node.children);
  };
  sort(roots);
  return { roots, nodesById, parentById };
}

/** 父图层先绘制、子孙后绘制；同级分支继续遵循原始叠放顺序。 */
export function layerPaintOrder(layers: Layer[]) {
  const result: Layer[] = [],
    tree = buildLayerTree(layers);
  const visit = (nodes: LayerTreeNode[]) => {
    for (const node of [...nodes].reverse()) {
      result.push(node.layer);
      visit(node.children);
    }
  };
  visit(tree.roots);
  return result;
}
