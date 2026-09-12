<script setup lang="ts">
import { ref, shallowRef, watch, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Konva from 'konva';
import { useEditor } from '../store';
import { imageUrl } from '../api';
import { between, bounds, sourcePoint } from '../geometry';
import type { Layer, Rect, Candidate } from '../types';

// 本组件只持有画布运行态：图片实例、Konva 引用、缩放和平移不进入保存/撤销快照。
// 三种坐标：屏幕像素 → pointer() 的设计坐标 → sourcePoint() 的原图像素。
const props = defineProps<{
  tool: 'select' | 'hand' | 'split';
  source?: Layer;
  region: Rect | null;
  candidates: Candidate[];
  busy: boolean;
}>();
const emit = defineEmits<{
  region: [r: Rect];
  candidate: [id: string, patch: Partial<Candidate>];
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
  drawing = ref<Rect | null>(null);
let observer: ResizeObserver,
  start: { x: number; y: number } | null = null,
  panStart: { x: number; y: number; vx: number; vy: number } | null = null,
  dragPositions: Record<string, { x: number; y: number }> = {},
  alive = true;
const stage = () => stageRef.value?.getNode() as Konva.Stage;
const visible = computed(() => store.layers.filter((l) => !l.hidden));
const sourceAsset = computed(() => (props.source ? store.assets[props.source.assetId] : undefined));
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
function config(l: Layer) {
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
    draggable: !l.locked && !store.exclusive && props.tool === 'select' && !space.value,
    image: images.value[l.assetId],
    listening: !l.locked,
    cornerRadius: l.radius,
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
  () => store.layers.map((l) => l.assetId),
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
function syncTransformer() {
  const s = stage(),
    tr = transformer.value?.getNode();
  if (!s || !tr) return;
  tr.nodes(
    props.tool === 'select'
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
function down(e: any) {
  if (store.exclusive) return;
  const p = stage().getPointerPosition()!;
  if (space.value || props.tool === 'hand' || e.evt.button === 1) {
    panStart = { ...p, vx: view.value.x, vy: view.value.y };
    e.evt.preventDefault();
    return;
  }
  if (props.tool === 'split') {
    if (props.busy || !props.source || !sourceAsset.value || e.target.name() === 'candidate')
      return;
    start = sourcePoint(props.source, sourceAsset.value, pointer().x, pointer().y);
    drawing.value = null;
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
  else marquee.value = between(start, pointer());
}
function up() {
  if (panStart) {
    panStart = null;
    return;
  }
  if (drawing.value && drawing.value.width >= 1 && drawing.value.height >= 1)
    emit('region', drawing.value);
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
}
function select(e: any, l: Layer) {
  if (props.tool !== 'select' || space.value || l.locked) return;
  e.cancelBubble = true;
  store.select(l.id, e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey);
}
function dragStart(e: any, l: Layer) {
  if (!store.selected.includes(l.id)) store.select(l.id);
  dragPositions = {};
  for (const item of store.selection) {
    const node = stage().findOne('#' + item.id);
    if (node && !item.locked) dragPositions[item.id] = { x: node.x(), y: node.y() };
  }
}
function dragMove(e: any, l: Layer) {
  const origin = dragPositions[l.id];
  if (!origin) return;
  const dx = e.target.x() - origin.x,
    dy = e.target.y() - origin.y;
  for (const [id, p] of Object.entries(dragPositions)) {
    if (id !== l.id)
      stage()
        .findOne('#' + id)
        ?.position({ x: p.x + dx, y: p.y + dy });
  }
}
/** 拖动/变换结束才提交一步。Konva 的 scale 需折回尺寸，翻转仅保留正负号。 */
function commit() {
  store.mutate(() => {
    for (const l of store.selection) {
      const n = stage().findOne('#' + l.id);
      if (!n || l.locked) continue;
      const width = n.width() * Math.abs(n.scaleX()),
        height = n.height() * Math.abs(n.scaleY());
      if (width > 16384 || height > 16384 || width * height > 32e6) {
        n.setAttrs(config(l));
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
  space.value = false;
  start = null;
  panStart = null;
}
function candidateEnd(e: any, c: Candidate) {
  emit('candidate', c.id, { x: e.target.x(), y: e.target.y() });
  void nextTick(() => e.target.position({ x: c.x, y: c.y }));
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
  void nextTick(fit);
});
onBeforeUnmount(() => {
  alive = false;
  observer?.disconnect();
  window.removeEventListener('keydown', key);
  window.removeEventListener('keyup', key);
  window.removeEventListener('blur', blur);
});
defineExpose({ fit, zoom });
</script>
<template>
  <div
    ref="host"
    class="canvas-host"
    :class="{ 'is-panning': space || tool === 'hand', 'is-splitting': tool === 'split' }"
    data-testid="canvas"
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
        <v-image
          v-for="l in visible"
          :key="l.id"
          :config="config(l)"
          @click="(e: any) => select(e, l)"
          @tap="(e: any) => select(e, l)"
          @dragstart="(e: any) => dragStart(e, l)"
          @dragmove="(e: any) => dragMove(e, l)"
          @dragend="commit"
        />
        <v-transformer
          ref="transformer"
          :config="{
            borderStroke: '#a3e600',
            anchorStroke: '#a3e600',
            anchorFill: '#111',
            anchorSize: 7,
            rotateAnchorOffset: 24,
            flipEnabled: false,
            keepRatio: false,
            ignoreStroke: true,
            boundBoxFunc: (old: any, next: any) =>
              Math.abs(next.width) < 2 || Math.abs(next.height) < 2 ? old : next,
          }"
          @transformend="commit"
        />
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
                name: 'candidate',
                stroke: c.enabled ? '#a3e600' : '#777',
                strokeWidth: 2,
                strokeScaleEnabled: false,
                fill: '#a3e60015',
                draggable: !busy,
              }"
              @dragend="(e: any) => candidateEnd(e, c)"
            />
            <v-label :config="{ x: c.x, y: c.y, listening: false }"
              ><v-tag :config="{ fill: '#a3e600' }" /><v-text
                :config="{ text: String(i + 1), fontSize: 16, padding: 4, fill: '#080808' }"
            /></v-label>
          </template>
        </v-group>
      </v-layer>
    </v-stage>
    <div class="ruler ruler-top" aria-hidden="true">
      <span v-for="t in rulerTicks.horizontal" :key="t.value" :style="{ left: t.pos + 'px' }">{{
        t.value
      }}</span>
    </div>
    <div class="ruler ruler-left" aria-hidden="true">
      <span v-for="t in rulerTicks.vertical" :key="t.value" :style="{ top: t.pos + 'px' }">{{
        t.value
      }}</span>
    </div>
    <div v-if="!store.layers.length" class="canvas-empty">
      <span class="empty-cross">＋</span><strong>把图片放到这里</strong>
      <p>拖放、粘贴，或点击底部导入图片</p>
      <small>PNG / JPEG / WebP · 单张最多 30 MB</small>
    </div>
    <div v-if="tool === 'split'" class="canvas-hint">
      在图片上拖动框选 · 候选框可拖动 · 参数以原图像素为准
    </div>
  </div>
</template>
