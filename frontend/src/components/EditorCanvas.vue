<script setup lang="ts">
import { ref, shallowRef, watch, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Konva from 'konva';
import { Loading, Refresh } from '@element-plus/icons-vue';
import { useEditor } from '../store';
import { imageUrl } from '../api';
import { between, bounds, sourcePoint, worldPoint } from '../geometry';
import { buildLayerTree, layerPaintOrder } from '../layerTree';
import { defaultTextStyle, effectiveFontFamily, fitTextLayer, textConfig } from '../text';
import type { Layer, Rect, Candidate, ImageLayer, TextLayer, Document } from '../types';
import type { LayerTree } from '../layerTree';

// Konva 10 默认也允许中键启动节点拖拽；编辑器将中键完整保留给画布平移。
Konva.dragButtons = [0];

// 本组件只持有画布运行态：图片实例、Konva 引用、缩放和平移不进入保存/撤销快照。
// 三种坐标：屏幕像素 → pointer() 的设计坐标 → sourcePoint() 的原图像素。
const props = defineProps<{
  tool: 'select' | 'hand' | 'split' | 'text';
  source?: ImageLayer;
  region: Rect | null;
  candidates: Candidate[];
  selectedCandidateId: string;
  busy: boolean;
  localRegenerationBusy: boolean;
  localRegenerationAvailable: boolean;
}>();
const emit = defineEmits<{
  region: [r: Rect];
  candidate: [id: string, patch: Partial<Candidate>];
  selectCandidate: [id: string];
  regenerateCandidate: [id: string];
  regenerateLocalLayer: [];
  zoom: [value: number];
  error: [message: string];
}>();
const store = useEditor(),
  host = ref<HTMLElement>(),
  stageRef = ref<any>(),
  transformer = ref<any>(),
  size = ref({ width: 1000, height: 800 }),
  view = ref({ x: 0, y: 0, scale: 1 }),
  images = shallowRef<Record<string, HTMLImageElement>>({}),
  space = ref(false),
  marquee = ref<Rect | null>(null),
  drawing = ref<Rect | null>(null),
  textDrawing = ref<Rect | null>(null),
  pointerPanning = ref(false),
  textEditor = ref<HTMLTextAreaElement>(),
  editing = ref<{ id: string; value: string; created: boolean; before?: Document } | null>(null);
let observer: ResizeObserver,
  start: { x: number; y: number } | null = null,
  panStart: { x: number; y: number; vx: number; vy: number } | null = null,
  dragPositions: Record<string, { x: number; y: number }> = {},
  dragLayerPositions: Record<string, { x: number; y: number }> = {},
  dragBefore: Document | null = null,
  dragTreeSnapshot: LayerTree | null = null,
  alive = true;
const stage = () => stageRef.value?.getNode() as Konva.Stage;
const visible = computed(() => store.layers.filter((l) => !l.hidden));
const painted = computed(() => layerPaintOrder(store.layers).filter((layer) => !layer.hidden));
const selectionBounds = computed<Rect | null>(() => {
  if (props.tool !== 'select' || editing.value) return null;
  const boxes = store.selection.filter((layer) => !layer.hidden).map(bounds);
  if (!boxes.length) return null;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
});
// 拖动期间冻结父子关系，避免节点跨越边界时树在指针移动中跳动；结束后再按最终位置重算。
const layerTree = computed(() => dragTreeSnapshot || buildLayerTree(store.layers));
const hitLayers = computed(() => {
  const depth = (id: string) => {
    let value = 0,
      parent = layerTree.value.parentById.get(id);
    while (parent) {
      value++;
      parent = layerTree.value.parentById.get(parent);
    }
    return value;
  };
  // 命中层中更深的子节点最后绘制，从而优先接收鼠标事件；视觉层仍保持原叠放顺序。
  return visible.value
    .map((layer, index) => ({ layer, index, depth: depth(layer.id) }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index)
    .map((entry) => entry.layer);
});
const sourceAsset = computed(() => (props.source ? store.assets[props.source.assetId] : undefined));
const selectedCandidate = computed(() =>
  props.candidates.find((candidate) => candidate.id === props.selectedCandidateId),
);
const candidateRegenerateStyle = computed(() => {
  const l = props.source,
    a = sourceAsset.value,
    c = selectedCandidate.value;
  if (props.tool !== 'split' || props.busy || !l || !a || !c) return {};
  const p = worldPoint(l, a, c.x + c.width / 2, c.y);
  return {
    left: `${view.value.x + p.x * view.value.scale}px`,
    top: `${view.value.y + p.y * view.value.scale}px`,
  };
});
const selectedImageLayer = computed(() =>
  store.single?.type === 'image' ? store.single : undefined,
);
type RegenerationBaseline = {
  id: string;
  sourceVersion: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
const regenerationBaseline = ref<RegenerationBaseline | null>(null);
function regenerationState(layer: ImageLayer): RegenerationBaseline {
  const rect = layer.source?.rect;
  return {
    id: layer.id,
    sourceVersion: `${layer.assetId}:${layer.source?.layerId || ''}:${rect?.x ?? ''}:${rect?.y ?? ''}:${rect?.width ?? ''}:${rect?.height ?? ''}`,
    x: layer.x,
    y: layer.y,
    width: layer.width,
    height: layer.height,
  };
}
watch(
  () => (selectedImageLayer.value ? regenerationState(selectedImageLayer.value) : null),
  (state) => {
    const baseline = regenerationBaseline.value;
    if (!state) regenerationBaseline.value = null;
    else if (
      !baseline ||
      baseline.id !== state.id ||
      baseline.sourceVersion !== state.sourceVersion
    )
      regenerationBaseline.value = state;
  },
  { immediate: true },
);
const layerGeometryChanged = computed(() => {
  const layer = selectedImageLayer.value,
    baseline = regenerationBaseline.value,
    epsilon = 1e-4;
  return (
    !!layer &&
    !!baseline &&
    layer.id === baseline.id &&
    (Math.abs(layer.x - baseline.x) > epsilon ||
      Math.abs(layer.y - baseline.y) > epsilon ||
      Math.abs(layer.width - baseline.width) > epsilon ||
      Math.abs(layer.height - baseline.height) > epsilon)
  );
});
const layerRegenerateStyle = computed(() => {
  const l = selectedImageLayer.value;
  if (props.tool !== 'select' || !l) return {};
  const b = bounds(l),
    gap = 10,
    buttonWidth = 32,
    left = view.value.x + b.x * view.value.scale,
    right = view.value.x + (b.x + b.width) * view.value.scale,
    top = view.value.y + b.y * view.value.scale,
    placeRight = right + gap + buttonWidth <= size.value.width - 8,
    placeAbove = top - gap - buttonWidth >= 20;
  return {
    left: `${placeRight ? right + gap : left - gap}px`,
    top: `${placeAbove ? top - gap : top + gap}px`,
    transform: `translate(${placeRight ? '0' : '-100%'}, ${placeAbove ? '-100%' : '0'})`,
  };
});
// 候选框使用源像素坐标，共用图片的中心旋转/翻转变换，因此无需反复换算矩形。
const overlay = computed(() => {
  const l = props.source,
    a = sourceAsset.value;
  if (!l || !a) return {};
  return {
    x: l.x + l.width / 2,
    y: l.y + l.height / 2,
    rotation: l.rotation,
    scaleX: (l.width / a.width) * (l.flipX ? -1 : 1),
    scaleY: (l.height / a.height) * (l.flipY ? -1 : 1),
    offsetX: a.width / 2,
    offsetY: a.height / 2,
  };
});
const rulerTicks = computed(() => {
  const step = 10 ** Math.ceil(Math.log10(80 / view.value.scale));
  return {
    horizontal: Array.from(
      { length: Math.ceil(size.value.width / (step * view.value.scale)) + 2 },
      (_, i) => {
        const value = (Math.floor(-view.value.x / view.value.scale / step) + i) * step;
        return { value, pos: view.value.x + value * view.value.scale };
      },
    ),
    vertical: Array.from(
      { length: Math.ceil(size.value.height / (step * view.value.scale)) + 2 },
      (_, i) => {
        const value = (Math.floor(-view.value.y / view.value.scale / step) + i) * step;
        return { value, pos: view.value.y + value * view.value.scale };
      },
    ),
  };
});
/** Konva 节点以中心定位；持久化 Layer 始终使用旋转前左上角。 */
function baseConfig(l: Layer) {
  return {
    id: l.id,
    name: 'asset',
    x: l.x + l.width / 2,
    y: l.y + l.height / 2,
    width: l.width,
    height: l.height,
    offsetX: l.width / 2,
    offsetY: l.height / 2,
    rotation: l.rotation,
    scaleX: l.flipX ? -1 : 1,
    scaleY: l.flipY ? -1 : 1,
    opacity: l.opacity,
    draggable: false,
    listening: false,
  };
}
function imageConfig(l: ImageLayer) {
  return { ...baseConfig(l), image: images.value[l.assetId], cornerRadius: l.radius };
}
function canvasTextConfig(l: TextLayer) {
  return {
    ...baseConfig(l),
    ...textConfig(l),
    width: l.width,
    height: l.height,
    visible: editing.value?.id !== l.id,
  };
}
function nodeConfig(l: Layer) {
  return l.type === 'image' ? imageConfig(l) : canvasTextConfig(l);
}
/** 透明命中节点与视觉图片分层，避免高层父图片挡住内部子图片。 */
function hitConfig(l: Layer) {
  return {
    id: `hit-${l.id}`,
    name: 'asset-hit',
    x: l.x + l.width / 2,
    y: l.y + l.height / 2,
    width: l.width,
    height: l.height,
    offsetX: l.width / 2,
    offsetY: l.height / 2,
    rotation: l.rotation,
    scaleX: l.flipX ? -1 : 1,
    scaleY: l.flipY ? -1 : 1,
    fill: '#000',
    opacity: 0.001,
    listening: !l.locked && props.tool === 'select' && editing.value?.id !== l.id,
    draggable: !l.locked && !store.exclusive && props.tool === 'select' && !space.value,
  };
}
function fit() {
  const bs = visible.value.map(bounds);
  if (!bs.length) {
    view.value = { x: size.value.width / 2 - 200, y: size.value.height / 2 - 150, scale: 1 };
    return;
  }
  const left = Math.min(...bs.map((b) => b.x)),
    top = Math.min(...bs.map((b) => b.y)),
    right = Math.max(...bs.map((b) => b.x + b.width)),
    bottom = Math.max(...bs.map((b) => b.y + b.height));
  const side = size.value.width >= 960 ? 340 : 24,
    z = Math.min(
      2,
      (size.value.width - side * 2 - 40) / Math.max(1, right - left),
      (size.value.height - 210) / Math.max(1, bottom - top),
    );
  view.value = {
    x: size.value.width / 2 - ((left + right) / 2) * z,
    y: size.value.height / 2 - ((top + bottom) / 2) * z,
    scale: Math.max(0.01, z),
  };
}
function focusLayer(id: string) {
  const layer = store.layers.find((item) => item.id === id);
  if (!layer || layer.hidden) return;
  const b = bounds(layer);
  const scale = view.value.scale;
  view.value = {
    x: size.value.width / 2 - (b.x + b.width / 2) * scale,
    y: size.value.height / 2 - (b.y + b.height / 2) * scale,
    scale: view.value.scale,
  };
}
/** 缩放围绕鼠标或画布中心，保持该点对应的设计坐标不动。 */
function zoom(
  factor: number,
  absolute = false,
  anchor = { x: size.value.width / 2, y: size.value.height / 2 },
) {
  const old = view.value,
    scale = Math.min(20, Math.max(0.01, absolute ? factor : old.scale * factor));
  view.value = {
    x: anchor.x - ((anchor.x - old.x) / old.scale) * scale,
    y: anchor.y - ((anchor.y - old.y) / old.scale) * scale,
    scale,
  };
}
watch(
  () => view.value.scale,
  (z) => emit('zoom', z),
  { immediate: true },
);
watch(
  () => store.layers.filter((l) => l.type === 'image').map((l) => l.assetId),
  async (ids) => {
    await Promise.all(
      [...new Set(ids)]
        .filter((id) => !images.value[id])
        .map(
          (id) =>
            new Promise<void>((resolve) => {
              const im = new Image();
              im.crossOrigin = 'anonymous';
              im.onload = () => {
                if (alive) images.value = { ...images.value, [id]: im };
                resolve();
              };
              im.onerror = () => {
                emit('error', '图片读取失败，请检查后端连接');
                resolve();
              };
              im.src = imageUrl(id);
            }),
        ),
    );
    await nextTick();
    syncTransformer();
  },
  { immediate: true },
);
watch(
  () => [...store.selected, props.tool, store.generation],
  () => void nextTick(syncTransformer),
);
watch(
  () => store.scene?.id,
  () => void nextTick(fit),
);
watch(
  () => store.layers.length,
  (n, old) => {
    if (!old && n) void nextTick(fit);
  },
);
const transformerOptions = computed(() => {
  const layer = store.single;
  const text = layer?.type === 'text' ? layer : undefined;
  return {
    borderStroke: '#a3e600',
    anchorStroke: '#a3e600',
    anchorFill: '#111',
    anchorSize: 7,
    rotateAnchorOffset: 24,
    flipEnabled: false,
    keepRatio: !!text,
    ignoreStroke: true,
    enabledAnchors:
      text && text.resizeMode !== 'fixed'
        ? ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle-left', 'middle-right']
        : undefined,
    boundBoxFunc: (old: any, next: any) =>
      Math.abs(next.width) < 2 || Math.abs(next.height) < 2 ? old : next,
  };
});
const textEditorStyle = computed(() => {
  const layer = editing.value
    ? store.layers.find((item) => item.id === editing.value?.id && item.type === 'text')
    : undefined;
  if (!layer || layer.type !== 'text') return {};
  const scale = view.value.scale;
  return {
    left: `${view.value.x + layer.x * scale}px`,
    top: `${view.value.y + layer.y * scale}px`,
    width: `${Math.max(24, layer.width * scale)}px`,
    height: `${Math.max(layer.fontSize * layer.lineHeight * scale, layer.height * scale)}px`,
    fontFamily: effectiveFontFamily(layer.fontFamily),
    fontSize: `${layer.fontSize * scale}px`,
    fontWeight: String(layer.fontWeight),
    fontStyle: layer.fontStyle,
    lineHeight: String(layer.lineHeight),
    letterSpacing: `${layer.letterSpacing * scale}px`,
    color: layer.fill,
    textAlign: layer.align,
    opacity: String(layer.opacity),
    transform: `rotate(${layer.rotation}deg) scaleX(${layer.flipX ? -1 : 1}) scaleY(${layer.flipY ? -1 : 1})`,
  };
});
function resizeTextEditor() {
  const editor = textEditor.value,
    layer = editing.value
      ? store.layers.find((item) => item.id === editing.value?.id && item.type === 'text')
      : undefined;
  if (!editor || !layer || layer.type !== 'text') return;
  if (layer.resizeMode === 'auto-width') {
    const measure = new Konva.Text({
      ...textConfig({ ...layer, content: editing.value?.value || '' }),
    });
    editor.style.width = `${Math.max(24, measure.width() * view.value.scale + 3)}px`;
    editor.style.height = `${Math.max(layer.fontSize * layer.lineHeight * view.value.scale, measure.height() * view.value.scale + 3)}px`;
    measure.destroy();
  } else if (layer.resizeMode !== 'fixed') {
    editor.style.height = 'auto';
    editor.style.height = `${Math.max(layer.fontSize * layer.lineHeight * view.value.scale, editor.scrollHeight + 3)}px`;
  }
}
async function editText(layer: TextLayer, created = false, before?: Document) {
  if (layer.locked || layer.hidden || store.exclusive) return;
  if (editing.value && editing.value.id !== layer.id) commitTextEdit();
  store.select(layer.id);
  editing.value = { id: layer.id, value: layer.content, created, before };
  await nextTick();
  textEditor.value?.focus();
  if (created) textEditor.value?.select();
  resizeTextEditor();
  syncTransformer();
}
function commitTextEdit(keepEmpty = false) {
  const current = editing.value;
  if (!current) return;
  const layer = store.layers.find((item) => item.id === current.id);
  editing.value = null;
  if (!layer || layer.type !== 'text') return;
  if (current.created && !current.value.trim() && !keepEmpty) {
    store.mutate(() => {
      store.scene!.layers = store.layers.filter((item) => item.id !== layer.id);
      store.selected = [];
    }, current.before);
  } else {
    store.mutate(() => {
      layer.content = current.value;
      layer.name = current.value.trim().split(/\r?\n/)[0]?.slice(0, 200) || '文字';
      fitTextLayer(layer);
    }, current.before);
  }
  void nextTick(syncTransformer);
}
function textEditorKey(event: KeyboardEvent) {
  if (event.isComposing) return;
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    commitTextEdit();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    commitTextEdit();
  }
}
function outsideTextEditor(event: PointerEvent) {
  if (!editing.value || event.target === textEditor.value) return;
  const target = event.target as HTMLElement | null;
  commitTextEdit(!!target?.closest('.right-panel'));
}
function createText(rect: Rect, dragged: boolean) {
  const before = store.doc(),
    style = defaultTextStyle(),
    layer: TextLayer = {
      id: crypto.randomUUID(),
      type: 'text',
      name: '文字',
      x: rect.x,
      y: rect.y,
      width: dragged ? Math.max(24, rect.width) : 160,
      height: dragged ? Math.max(28, rect.height) : 32,
      rotation: 0,
      flipX: false,
      flipY: false,
      opacity: 1,
      hidden: false,
      locked: false,
      ...style,
      resizeMode: dragged ? 'auto-height' : 'auto-width',
    };
  store.mutate(() => {
    store.layers.push(layer);
    store.selected = [layer.id];
  });
  void editText(layer, true, before);
}
function syncTransformer() {
  const s = stage(),
    tr = transformer.value?.getNode();
  if (!s || !tr) return;
  tr.nodes(
    props.tool === 'select' && !editing.value
      ? store.selection
          .filter((l) => !l.locked && !l.hidden)
          .map((l) => s.findOne('#' + l.id))
          .filter(Boolean)
      : [],
  );
  tr.getLayer()?.batchDraw();
}
function pointer() {
  const p = stage().getPointerPosition()!;
  return { x: (p.x - view.value.x) / view.value.scale, y: (p.y - view.value.y) / view.value.scale };
}
function hostPointer(e: PointerEvent) {
  const rect = host.value!.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}
// 在 DOM 捕获阶段接管平移手势，避免 Konva 节点、Transformer 或候选框抢先启动拖拽。
function middleDown(e: PointerEvent) {
  const panButton = e.button === 1 || (e.button === 0 && (space.value || props.tool === 'hand'));
  if (!panButton || store.exclusive) return;
  const p = hostPointer(e);
  panStart = { ...p, vx: view.value.x, vy: view.value.y };
  pointerPanning.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  e.preventDefault();
  e.stopPropagation();
}
function middleMove(e: PointerEvent) {
  if (!pointerPanning.value || !panStart) return;
  const p = hostPointer(e);
  view.value = {
    ...view.value,
    x: panStart.vx + p.x - panStart.x,
    y: panStart.vy + p.y - panStart.y,
  };
  e.preventDefault();
  e.stopPropagation();
}
function middleUp(e: PointerEvent) {
  if (!pointerPanning.value) return;
  panStart = null;
  pointerPanning.value = false;
  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  e.preventDefault();
  e.stopPropagation();
}
function down(e: any) {
  if (store.exclusive) return;
  const p = stage().getPointerPosition()!;
  if (space.value || props.tool === 'hand' || e.evt.button === 1) {
    panStart = { ...p, vx: view.value.x, vy: view.value.y };
    pointerPanning.value = true;
    e.evt.preventDefault();
    return;
  }
  if (props.tool === 'split') {
    if (
      props.busy ||
      !props.source ||
      !sourceAsset.value ||
      e.target.name() === 'candidate' ||
      e.target.getClassName?.() === 'Transformer' ||
      e.target.getParent?.()?.getClassName?.() === 'Transformer'
    )
      return;
    start = sourcePoint(props.source, sourceAsset.value, pointer().x, pointer().y);
    drawing.value = null;
    return;
  }
  if (props.tool === 'text') {
    start = pointer();
    textDrawing.value = null;
    e.evt.preventDefault();
    return;
  }
  if (e.target === stage()) {
    start = pointer();
    marquee.value = null;
    if (!e.evt.shiftKey) store.selected = [];
  }
}
function move() {
  if (panStart) {
    const p = stage().getPointerPosition()!;
    view.value = {
      ...view.value,
      x: panStart.vx + p.x - panStart.x,
      y: panStart.vy + p.y - panStart.y,
    };
    return;
  }
  if (!start) return;
  if (props.tool === 'split' && props.source && sourceAsset.value)
    drawing.value = between(
      start,
      sourcePoint(props.source, sourceAsset.value, pointer().x, pointer().y),
    );
  else if (props.tool === 'text') textDrawing.value = between(start, pointer());
  else marquee.value = between(start, pointer());
}
function up() {
  if (panStart) {
    panStart = null;
    pointerPanning.value = false;
    return;
  }
  if (drawing.value && drawing.value.width >= 1 && drawing.value.height >= 1)
    emit('region', drawing.value);
  if (props.tool === 'text' && start) {
    const rect = textDrawing.value || { x: start.x, y: start.y, width: 0, height: 0 },
      dragged = rect.width >= 4 && rect.height >= 4;
    createText(dragged ? rect : { x: start.x, y: start.y, width: 160, height: 32 }, dragged);
  }
  if (marquee.value) {
    const r = marquee.value;
    store.selected = [
      ...new Set([
        ...store.selected,
        ...visible.value
          .filter((l) => !l.locked)
          .filter((l) => {
            const b = bounds(l);
            return (
              b.x < r.x + r.width &&
              b.x + b.width > r.x &&
              b.y < r.y + r.height &&
              b.y + b.height > r.y
            );
          })
          .map((l) => l.id),
      ]),
    ];
  }
  start = null;
  marquee.value = null;
  drawing.value = null;
  textDrawing.value = null;
}
function select(e: any, l: Layer) {
  if (
    props.tool !== 'select' ||
    space.value ||
    l.locked ||
    (typeof e.evt.button === 'number' && e.evt.button !== 0)
  )
    return;
  e.cancelBubble = true;
  store.select(l.id, e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey);
}
function doubleClick(e: any, layer: Layer) {
  if (props.tool !== 'select' || layer.type !== 'text' || layer.locked) return;
  e.cancelBubble = true;
  void editText(layer);
}
function dragStart(e: any, l: Layer) {
  if (!store.selected.includes(l.id)) store.select(l.id);
  dragPositions = {};
  dragLayerPositions = {};
  dragBefore = store.doc();
  dragTreeSnapshot = buildLayerTree(store.layers);
  const tree = dragTreeSnapshot,
    moving = new Set<string>();
  const includeSubtree = (id: string) => {
    if (moving.has(id)) return;
    moving.add(id);
    for (const child of tree.nodesById.get(id)?.children || []) includeSubtree(child.layer.id);
  };
  // 顶层选中项仍遵守自身锁定；一旦父图层可拖动，其完整子树保持相对位置。
  for (const item of store.selection) if (!item.locked) includeSubtree(item.id);
  for (const id of moving) {
    const item = store.layers.find((layer) => layer.id === id),
      node = stage().findOne('#' + id);
    if (!item) continue;
    dragLayerPositions[id] = { x: item.x, y: item.y };
    if (node) dragPositions[id] = { x: node.x(), y: node.y() };
  }
}
function dragMove(e: any, l: Layer) {
  const origin = dragPositions[l.id];
  if (!origin) return;
  const dx = e.target.x() - origin.x,
    dy = e.target.y() - origin.y;
  for (const [id, p] of Object.entries(dragPositions)) {
    stage()
      .findOne('#' + id)
      ?.position({ x: p.x + dx, y: p.y + dy });
  }
  // 同步更新持久化图层，使属性面板和画布在拖动过程中都反映子树的实时位置。
  store.mutate(() => {
    for (const [id, position] of Object.entries(dragLayerPositions)) {
      const layer = store.layers.find((item) => item.id === id);
      if (layer) Object.assign(layer, { x: position.x + dx, y: position.y + dy });
    }
  }, dragBefore || undefined);
}
function commitDrag(e: any, l: Layer) {
  const origin = dragPositions[l.id],
    dx = origin ? e.target.x() - origin.x : 0,
    dy = origin ? e.target.y() - origin.y : 0;
  store.mutate(() => {
    for (const [id, position] of Object.entries(dragLayerPositions)) {
      const layer = store.layers.find((item) => item.id === id);
      if (layer) Object.assign(layer, { x: position.x + dx, y: position.y + dy });
    }
  });
  dragPositions = {};
  dragLayerPositions = {};
  dragBefore = null;
  dragTreeSnapshot = null;
  void nextTick(syncTransformer);
}
/** 拖动/变换结束才提交一步。Konva 的 scale 需折回尺寸，翻转仅保留正负号。 */
function commit() {
  const activeAnchor = transformer.value?.getNode()?.getActiveAnchor?.() || '',
    corner = /^(top|bottom)-(left|right)$/.test(activeAnchor);
  store.mutate(() => {
    for (const l of store.selection) {
      const n = stage().findOne('#' + l.id);
      if (!n || l.locked) continue;
      const scaleX = Math.abs(n.scaleX()),
        scaleY = Math.abs(n.scaleY()),
        width = n.width() * scaleX,
        height = n.height() * scaleY;
      if (width > 16384 || height > 16384 || width * height > 32e6) {
        n.setAttrs(nodeConfig(l));
        emit('error', '图层尺寸超过限制');
        continue;
      }
      Object.assign(l, {
        x: n.x() - width / 2,
        y: n.y() - height / 2,
        width,
        height,
        rotation: n.rotation(),
        flipX: n.scaleX() < 0,
        flipY: n.scaleY() < 0,
      });
      if (l.type === 'text') {
        if (corner) {
          l.fontSize = Math.max(1, Math.min(2048, l.fontSize * scaleY));
          l.letterSpacing *= scaleY;
        } else if (activeAnchor === 'middle-left' || activeAnchor === 'middle-right') {
          l.resizeMode = 'auto-height';
        } else if (activeAnchor === 'top-center' || activeAnchor === 'bottom-center') {
          l.resizeMode = 'fixed';
        }
        fitTextLayer(l);
      }
      n.scale({ x: l.flipX ? -1 : 1, y: l.flipY ? -1 : 1 });
      n.width(width);
      n.height(height);
      n.offset({ x: width / 2, y: height / 2 });
    }
  });
  void nextTick(syncTransformer);
}
function key(e: KeyboardEvent) {
  if ((e.target as HTMLElement).closest('input,textarea,[contenteditable=true],.el-overlay'))
    return;
  if (e.code === 'Space') {
    space.value = e.type === 'keydown';
    e.preventDefault();
  }
}
function blur() {
  commitTextEdit();
  space.value = false;
  pointerPanning.value = false;
  start = null;
  panStart = null;
}
function candidateEnd(e: any, c: Candidate) {
  emit('candidate', c.id, { x: e.target.x(), y: e.target.y() });
  void nextTick(() => e.target.position({ x: c.x, y: c.y }));
}
function selectCandidate(c?: Candidate) {
  if (!c) return;
  if (!props.busy) emit('selectCandidate', c.id);
}
function regenerateCandidate() {
  if (selectedCandidate.value && !props.busy)
    emit('regenerateCandidate', selectedCandidate.value.id);
}
function regenerateLocalLayer() {
  if (selectedImageLayer.value && props.localRegenerationAvailable && !props.localRegenerationBusy)
    emit('regenerateLocalLayer');
}
const candidateHandleKeys = [
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;
type CandidateHandle = (typeof candidateHandleKeys)[number];
function candidateHandlePosition(c: Candidate | undefined, key: CandidateHandle) {
  if (!c) return { x: 0, y: 0 };
  return {
    x: key.includes('left') ? c.x : key.includes('right') ? c.x + c.width : c.x + c.width / 2,
    y: key.includes('top') ? c.y : key.includes('bottom') ? c.y + c.height : c.y + c.height / 2,
  };
}
function candidateHandlePatch(c: Candidate, key: CandidateHandle, x: number, y: number) {
  const right = c.x + c.width,
    bottom = c.y + c.height,
    left = key.includes('left') ? Math.min(x, right - 1) : c.x,
    top = key.includes('top') ? Math.min(y, bottom - 1) : c.y,
    nextRight = key.includes('right') ? Math.max(x, left + 1) : right,
    nextBottom = key.includes('bottom') ? Math.max(y, top + 1) : bottom;
  return { x: left, y: top, width: nextRight - left, height: nextBottom - top };
}
function candidateHandleMove(e: any, c: Candidate | undefined, key: CandidateHandle) {
  if (!c) return;
  stage()
    .findOne('#candidate-' + c.id)
    ?.setAttrs(candidateHandlePatch(c, key, e.target.x(), e.target.y()));
}
function candidateHandleEnd(e: any, c: Candidate | undefined, key: CandidateHandle) {
  if (!c) return;
  emit('candidate', c.id, candidateHandlePatch(c, key, e.target.x(), e.target.y()));
}
onMounted(() => {
  observer = new ResizeObserver((entries) => {
    const r = entries[0].contentRect;
    size.value = { width: r.width, height: r.height };
  });
  observer.observe(host.value!);
  window.addEventListener('keydown', key);
  window.addEventListener('keyup', key);
  window.addEventListener('blur', blur);
  window.addEventListener('pointerdown', outsideTextEditor, true);
  void nextTick(fit);
});
onBeforeUnmount(() => {
  alive = false;
  observer?.disconnect();
  window.removeEventListener('keydown', key);
  window.removeEventListener('keyup', key);
  window.removeEventListener('blur', blur);
  window.removeEventListener('pointerdown', outsideTextEditor, true);
});
defineExpose({ fit, focusLayer, zoom });
</script>
<template>
  <div
    ref="host"
    class="canvas-host"
    :style="{
      backgroundPosition: `${view.x}px ${view.y}px`,
      backgroundSize: '16px 16px',
    }"
    :class="{
      'is-panning': space || tool === 'hand' || pointerPanning,
      'is-panning-active': pointerPanning,
      'is-splitting': tool === 'split',
      'is-typing': tool === 'text',
    }"
    data-testid="canvas"
    @pointerdown.capture="middleDown"
    @pointermove.capture="middleMove"
    @pointerup.capture="middleUp"
    @pointercancel.capture="middleUp"
  >
    <v-stage
      ref="stageRef"
      :config="{ ...size, x: view.x, y: view.y, scaleX: view.scale, scaleY: view.scale }"
      @mousedown="down"
      @touchstart="down"
      @mousemove="move"
      @touchmove="move"
      @mouseup="up"
      @touchend="up"
      @wheel="
        (e: any) => {
          e.evt.preventDefault();
          zoom(e.evt.deltaY > 0 ? 1 / 1.12 : 1.12, false, stage().getPointerPosition()!);
        }
      "
    >
      <v-layer>
        <v-rect
          v-for="l in hitLayers"
          :key="l.id"
          :config="hitConfig(l)"
          @click="(e: any) => select(e, l)"
          @tap="(e: any) => select(e, l)"
          @dblclick="(e: any) => doubleClick(e, l)"
          @dbltap="(e: any) => doubleClick(e, l)"
          @dragstart="(e: any) => dragStart(e, l)"
          @dragmove="(e: any) => dragMove(e, l)"
          @dragend="(e: any) => commitDrag(e, l)"
        />
      </v-layer>
      <v-layer>
        <template v-for="l in painted" :key="l.id">
          <v-image v-if="l.type === 'image'" :config="imageConfig(l)" />
          <v-text v-else :config="canvasTextConfig(l)" />
        </template>
        <v-transformer ref="transformer" :config="transformerOptions" @transformend="commit" />
        <v-rect
          v-if="marquee"
          :config="{
            ...marquee,
            fill: '#a3e60022',
            stroke: '#a3e600',
            strokeWidth: 1 / view.scale,
            listening: false,
          }"
        />
        <v-rect
          v-if="textDrawing"
          :config="{
            ...textDrawing,
            fill: '#a3e60012',
            stroke: '#a3e600',
            strokeWidth: 1 / view.scale,
            dash: [6 / view.scale, 4 / view.scale],
            listening: false,
          }"
        />
        <v-group v-if="tool === 'split' && sourceAsset" :config="overlay">
          <v-rect
            v-if="drawing || region"
            :config="{
              ...(drawing || region),
              stroke: '#a3e600',
              strokeWidth: 2,
              strokeScaleEnabled: false,
              dash: [8, 4],
              fill: '#a3e60012',
              listening: false,
            }"
          />
          <template v-for="(c, i) in candidates" :key="c.id">
            <v-rect
              :config="{
                ...c,
                id: 'candidate-' + c.id,
                name: 'candidate',
                stroke: selectedCandidateId === c.id ? '#ffffff' : c.enabled ? '#a3e600' : '#777',
                strokeWidth: selectedCandidateId === c.id ? 3 : 2,
                strokeScaleEnabled: false,
                fill: '#a3e60015',
                draggable: !busy,
              }"
              @mousedown="() => selectCandidate(c)"
              @touchstart="() => selectCandidate(c)"
              @click="() => selectCandidate(c)"
              @tap="() => selectCandidate(c)"
              @dragstart="() => selectCandidate(c)"
              @dragend="(e: any) => candidateEnd(e, c)"
            />
            <v-label
              :config="{ x: c.x, y: c.y, name: 'candidate', listening: true }"
              @click="() => selectCandidate(c)"
              @tap="() => selectCandidate(c)"
              ><v-tag :config="{ name: 'candidate', fill: '#a3e600' }" /><v-text
                :config="{
                  name: 'candidate',
                  text: String(i + 1),
                  fontSize: 16,
                  padding: 4,
                  fill: '#080808',
                }"
            /></v-label>
          </template>
          <template v-if="selectedCandidate && !busy">
            <v-circle
              v-for="key in candidateHandleKeys"
              :key="key"
              :config="{
                ...candidateHandlePosition(selectedCandidate, key),
                name: 'candidate',
                radius:
                  5 /
                  (view.scale *
                    Math.max(
                      Math.abs(Number(overlay.scaleX) || 1),
                      Math.abs(Number(overlay.scaleY) || 1),
                    )),
                fill: '#111111',
                stroke: '#a3e600',
                strokeWidth: 2,
                strokeScaleEnabled: false,
                draggable: true,
              }"
              @mousedown="() => selectCandidate(selectedCandidate)"
              @dragmove="(event: any) => candidateHandleMove(event, selectedCandidate, key)"
              @dragend="(event: any) => candidateHandleEnd(event, selectedCandidate, key)"
            />
          </template>
        </v-group>
      </v-layer>
    </v-stage>
    <textarea
      v-if="editing"
      ref="textEditor"
      v-model="editing.value"
      class="canvas-text-editor"
      :style="textEditorStyle"
      aria-label="编辑画布文字"
      spellcheck="false"
      @input="resizeTextEditor"
      @keydown="textEditorKey"
    />
    <button
      v-if="selectedCandidate && !busy"
      class="candidate-regenerate"
      type="button"
      :style="candidateRegenerateStyle"
      aria-label="重新生成当前候选拆图"
      @click.stop="regenerateCandidate"
    >
      重新生成
    </button>
    <button
      v-if="
        tool === 'select' &&
        selectedImageLayer &&
        localRegenerationAvailable &&
        layerGeometryChanged
      "
      class="candidate-regenerate layer-regenerate"
      type="button"
      :style="layerRegenerateStyle"
      :disabled="localRegenerationBusy"
      :aria-busy="localRegenerationBusy"
      :aria-label="localRegenerationBusy ? '正在重新生成当前图片图层' : '重新生成当前图片图层'"
      :title="localRegenerationBusy ? '重新生成中…' : '重新生成'"
      @click.stop="regenerateLocalLayer"
    >
      <el-icon :class="{ 'is-loading': localRegenerationBusy }" :size="17" aria-hidden="true">
        <component :is="localRegenerationBusy ? Loading : Refresh" />
      </el-icon>
    </button>
    <div class="ruler ruler-top" aria-hidden="true">
      <div
        v-if="selectionBounds"
        class="selection-ruler-range selection-ruler-range-x"
        :style="{
          left: view.x + selectionBounds.x * view.scale + 'px',
          width: selectionBounds.width * view.scale + 'px',
        }"
      />
      <span v-for="t in rulerTicks.horizontal" :key="t.value" :style="{ left: t.pos + 'px' }">{{
        t.value
      }}</span>
      <template v-if="selectionBounds">
        <span
          class="selection-ruler-marker selection-ruler-marker-x"
          :style="{ left: view.x + selectionBounds.x * view.scale + 'px' }"
          >{{ Math.round(selectionBounds.x) }}</span
        ><span
          class="selection-ruler-marker selection-ruler-marker-x"
          :style="{
            left: view.x + (selectionBounds.x + selectionBounds.width) * view.scale + 'px',
          }"
          >{{ Math.round(selectionBounds.x + selectionBounds.width) }}</span
        >
      </template>
    </div>
    <div class="ruler ruler-left" aria-hidden="true">
      <div
        v-if="selectionBounds"
        class="selection-ruler-range selection-ruler-range-y"
        :style="{
          top: view.y + selectionBounds.y * view.scale + 'px',
          height: selectionBounds.height * view.scale + 'px',
        }"
      />
      <span v-for="t in rulerTicks.vertical" :key="t.value" :style="{ top: t.pos + 'px' }">{{
        t.value
      }}</span>
      <template v-if="selectionBounds">
        <span
          class="selection-ruler-marker selection-ruler-marker-y"
          :style="{ top: view.y + selectionBounds.y * view.scale + 'px' }"
          >{{ Math.round(selectionBounds.y) }}</span
        ><span
          class="selection-ruler-marker selection-ruler-marker-y"
          :style="{
            top: view.y + (selectionBounds.y + selectionBounds.height) * view.scale + 'px',
          }"
          >{{ Math.round(selectionBounds.y + selectionBounds.height) }}</span
        >
      </template>
    </div>
    <span
      v-if="selectionBounds"
      class="selection-size-marker"
      :style="{
        left: view.x + (selectionBounds.x + selectionBounds.width / 2) * view.scale + 'px',
        top: view.y + (selectionBounds.y + selectionBounds.height) * view.scale + 7 + 'px',
      }"
      >{{ Math.round(selectionBounds.width) }} × {{ Math.round(selectionBounds.height) }}</span
    >
    <div v-if="!store.layers.length" class="canvas-empty">
      <span class="empty-cross">＋</span><strong>把图片放到这里</strong>
      <p>拖放、粘贴，或点击底部导入图片</p>
      <small>PNG / JPEG / WebP · 单张最多 30 MB</small>
    </div>
    <div v-if="tool === 'split'" class="canvas-hint">
      在图片上拖动框选 · 候选框可拖动 · 参数以原图像素为准
    </div>
    <div v-if="tool === 'text' && !editing" class="canvas-hint">
      点击创建自动宽度文字 · 拖动创建自动高度文本框
    </div>
  </div>
</template>
