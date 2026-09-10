<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import type { Placement, SliceAsset } from '../types/workspace';
import { cropImage, loadBitmap, downloadBlob } from '../services/workspace-image';
import { createSliceRepairPatch } from '../services/slice-repair.js';
import { calculateWheelZoom, calculateAnchoredCanvasScroll } from '../services/canvas-viewport.js';
import { hasProcessedSliceResult, isLockedAiCompleteAsset } from '../state/slice-ai-state.js';
import { getSliceRadiiCssValue, getSliceRadii, setSliceCornerRadius, calculateDraggedSliceRadius, calculateSliceRadiusHandleInset } from '../services/slice-geometry.js';
import { assetEditSignature } from '../services/asset-edit-signature';
import { replaceSliceCrop } from '../services/slice-crop';
const props = defineProps<{ tool: 'select' | 'draw'; repairPreview: boolean; overlapRegions?: Placement[] }>();
const emit = defineEmits<{ error: [message: string]; settings: [id: string] }>();
const store = useWorkspaceStore(), viewport = ref<HTMLElement>(), board = ref<HTMLElement>();
const panOffset = ref({ x: 0, y: 0 });
const editing = ref(false);
let fitMode = true;
const zoom = ref(1), drawing = ref<Placement | null>(null), preview = ref('');
let observer: ResizeObserver | undefined, space = false, renderVersion = 0;
let gesture: { id: number; kind: 'pan' | 'draw' | 'move' | 'resize'; x: number; y: number; scrollX: number; scrollY: number; handle: string; epoch: number; signatures: Map<string, string>; positions: Map<string, Placement>; moved: boolean } | null = null;
let radiusGesture: { id: number; assetId: string; corner: string; startX: number; startY: number; startRadius: number; value: number; epoch: number } | null = null;
const radiusValue = ref<{ id: string; corner: string; value: number } | null>(null);
function radiusStyle(a: SliceAsset) { const copy = { ...a, radii: { ...getSliceRadii(a, store.screen) } }; if (radiusValue.value?.id === a.id) copy.radii[radiusValue.value.corner] = radiusValue.value.value; const corners = { nw: 'topLeft', ne: 'topRight', se: 'bottomRight', sw: 'bottomLeft' }; const style: Record<string, string> = { borderRadius: getSliceRadiiCssValue(copy, store.screen) }; for (const [handle, corner] of Object.entries(corners)) { const inset = calculateSliceRadiusHandleInset(copy.radii[corner] * zoom.value, a.placement.width * zoom.value, a.placement.height * zoom.value) + 'px'; style['--slice-radius-' + handle + '-x'] = inset; style['--slice-radius-' + handle + '-y'] = inset; } return style; }
function startRadius(event: PointerEvent, a: SliceAsset, corner: string) { if (store.saving || a.aiProcessing) return; event.preventDefault(); const p = point(event); radiusGesture = { id: event.pointerId, assetId: a.id, corner, startX: p.x, startY: p.y, startRadius: getSliceRadii(a, store.screen)[({ nw: 'topLeft', ne: 'topRight', se: 'bottomRight', sw: 'bottomLeft' } as Record<string, string>)[corner]!], value: 0, epoch: store.epoch }; viewport.value!.setPointerCapture(event.pointerId); }
async function download() { if (store.image) downloadBlob(await (await fetch(store.image.dataUrl)).blob(), 'image-' + (store.draft.activeResultIndex + 1) + '.png'); }
const transient = ref<Record<string, Placement>>({});
const boardStyle = computed(() => ({ width: `${store.screen.width * zoom.value}px`, height: `${store.screen.height * zoom.value}px`, transform: `translate(${panOffset.value.x}px, ${panOffset.value.y}px)` }));
function fit() { fitMode = true; panOffset.value = { x: 0, y: 0 }; if (viewport.value) zoom.value = Math.min(4, Math.max(.1, Math.min((viewport.value.clientWidth - 24) / store.screen.width, (viewport.value.clientHeight - 24) / store.screen.height))); }
function changeZoom(direction: number) { fitMode = false; zoom.value = Math.max(.1, Math.min(4, zoom.value + direction * .1)); }
function resetZoom() { fitMode = false; zoom.value = 1; }
defineExpose({ zoom, fit, changeZoom, resetZoom });
function point(e: PointerEvent) { const r = board.value!.getBoundingClientRect(); return { x: (e.clientX - r.left) / zoom.value, y: (e.clientY - r.top) / zoom.value }; }
function rectStyle(p: Placement) { return { left: `${p.x * zoom.value}px`, top: `${p.y * zoom.value}px`, width: `${p.width * zoom.value}px`, height: `${p.height * zoom.value}px` }; }
function start(e: PointerEvent, assetId?: string, handle = '') {
  if (e.button !== 0 && e.button !== 1) return;
  if (!store.image || store.saving || editing.value) return;
  viewport.value?.focus({ preventScroll: true });
  const pan = e.button === 1 || space, p = point(e);
  if (assetId && store.assets.find(a => a.id === assetId)?.aiProcessing && !pan) return;
  if (!pan && props.tool === 'draw' && (p.x < 0 || p.y < 0 || p.x > store.screen.width || p.y > store.screen.height)) return;
  if (!pan && !assetId && props.tool === 'select') { store.selectedIds = []; store.draft.activeSliceId = null; }
  if (!pan && assetId && (e.ctrlKey || e.metaKey || e.shiftKey)) { store.select(assetId, e.ctrlKey || e.metaKey, e.shiftKey); return; }
  if (!pan && assetId && props.tool === 'select') { if (e.ctrlKey || e.metaKey || e.shiftKey || !store.selectedIds.includes(assetId)) store.select(assetId, e.ctrlKey || e.metaKey, e.shiftKey); else store.draft.activeSliceId = assetId; }
  const kind = pan ? 'pan' : props.tool === 'draw' ? 'draw' : assetId ? (handle ? 'resize' : 'move') : 'pan';
  gesture = { id: e.pointerId, kind, x: kind === 'pan' ? e.clientX : p.x, y: kind === 'pan' ? e.clientY : p.y, scrollX: panOffset.value.x, scrollY: panOffset.value.y, handle,
    epoch: store.epoch, signatures: new Map(store.selected.map(a => [a.id, assetEditSignature(a)])), positions: new Map(store.selected.map(a => [a.id, { ...a.placement }])), moved: false };
  viewport.value!.setPointerCapture(e.pointerId); e.preventDefault();
}
function move(e: PointerEvent) {
  if (radiusGesture?.id === e.pointerId) { const a = store.assets.find(a => a.id === radiusGesture!.assetId); if (!a) return; const value = calculateDraggedSliceRadius(radiusGesture, point(e), Math.min(a.placement.width, a.placement.height) / 2); radiusGesture.value = value; radiusValue.value = { id: a.id, corner: ({ nw: 'topLeft', ne: 'topRight', se: 'bottomRight', sw: 'bottomLeft' } as Record<string, string>)[radiusGesture.corner]!, value }; return; }
  const g = gesture; if (!g || g.id !== e.pointerId) return;
  if (g.kind === 'pan') { fitMode = false; panOffset.value = { x: g.scrollX + e.clientX - g.x, y: g.scrollY + e.clientY - g.y }; return; }
  const p = point(e), dx = p.x - g.x, dy = p.y - g.y; if (Math.abs(dx) + Math.abs(dy) > 1) g.moved = true;
  if (g.kind === 'draw') { const x = Math.max(0, Math.min(store.screen.width, Math.min(g.x, p.x))), y = Math.max(0, Math.min(store.screen.height, Math.min(g.y, p.y)));
    drawing.value = { x: Math.round(x), y: Math.round(y), width: Math.round(Math.max(0, Math.min(store.screen.width, Math.max(g.x, p.x)) - x)), height: Math.round(Math.max(0, Math.min(store.screen.height, Math.max(g.y, p.y)) - y)) }; }
  else transient.value = Object.fromEntries([...g.positions].map(([id, position]) => [id, g.kind === 'resize' ? resizePlacement(position, g.handle, dx, dy) : { ...position, x: position.x + dx, y: position.y + dy }]));
}
function resizePlacement(p: Placement, handle: string, dx: number, dy: number): Placement {
  const x = handle.includes('w') ? Math.min(p.x + dx, p.x + p.width - 2) : p.x;
  const y = handle.includes('n') ? Math.min(p.y + dy, p.y + p.height - 2) : p.y;
  return { x, y, width: handle.includes('w') ? p.width + p.x - x : handle.includes('e') ? Math.max(2, p.width + dx) : p.width, height: handle.includes('n') ? p.height + p.y - y : handle.includes('s') ? Math.max(2, p.height + dy) : p.height };
}
function settings(id: string) { if (!store.selectedIds.includes(id)) store.select(id); emit('settings', id); }
async function end(e: PointerEvent) {
  if (radiusGesture?.id === e.pointerId) { const g = radiusGesture, value = radiusValue.value; radiusGesture = null; radiusValue.value = null; if (value && e.type !== 'pointercancel' && g.epoch === store.epoch) store.mutate(() => setSliceCornerRadius(store.assets.find(a => a.id === g.assetId), value.corner, value.value, store.screen)); return; }
  const g = gesture; if (!g || g.id !== e.pointerId) return;
  gesture = null; if (viewport.value?.hasPointerCapture(e.pointerId)) viewport.value.releasePointerCapture(e.pointerId);
  const drawn = drawing.value, positions = transient.value; drawing.value = null; transient.value = {};
  if (g.epoch !== store.epoch || e.type === 'pointercancel') return;
  editing.value = true;
  try {
    if (g.kind === 'draw' && drawn) await store.createSlice(drawn);
    else if (g.moved && (g.kind === 'move' || g.kind === 'resize')) {
      if (g.kind === 'resize' && store.selected.some(a => hasProcessedSliceResult(a)) && !confirm('调整尺寸会重新裁取原设计图，并清除此图的处理结果。继续？')) return;
      const replacements = new Map<string, string>();
      for (const [id, p] of Object.entries(positions)) { const a = store.assets.find(a => a.id === id)!; if (g.kind === 'resize' || isLockedAiCompleteAsset(a) || (!hasProcessedSliceResult(a) && !a.aiCompleted)) replacements.set(id, await cropImage(store.image!.dataUrl, p, store.screen)); }
      if (g.epoch !== store.epoch) return;
      if ([...g.signatures].some(([id, signature]) => assetEditSignature(store.assets.find(a => a.id === id)) !== signature)) throw new Error('切图已被其他操作修改，未覆盖当前结果。');
      store.mutate(() => { for (const a of [...store.assets]) if (positions[a.id]) { const target = store.editableMovementTarget(a); if (replacements.has(a.id)) store.preserveProcessedVariant(target); target.placement = positions[a.id]!; if (replacements.has(a.id)) replaceSliceCrop(target, replacements.get(a.id)!); } });
    }
  } catch (failure) { emit('error', (failure as Error).message); } finally { editing.value = false; }
}
async function renderPreview() {
  const version = ++renderVersion; preview.value = '';
  if (!props.repairPreview || !store.image) return;
  try { const img = await loadBitmap(store.image.dataUrl), canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight; const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0);
    for (const a of store.assets) { const p = { ...a.placement, ...(a.initialPlacement || {}) }; const patch = await createSliceRepairPatch(store.image.dataUrl, p); const bitmap = await loadBitmap(patch.repairDataUrl); ctx.drawImage(bitmap, p.x, p.y, p.width, p.height); }
    if (version === renderVersion) preview.value = canvas.toDataURL();
  } catch (failure) { if (version === renderVersion) emit('error', (failure as Error).message); }
}
function wheel(e: WheelEvent) {
  if (!store.image) return; fitMode = false;
  e.preventDefault(); const view = viewport.value!, bounds = board.value!.getBoundingClientRect(), viewBounds = view.getBoundingClientRect();
  const scrollLeft = view.scrollLeft, scrollTop = view.scrollTop;
  const previousLeft = bounds.left - viewBounds.left + scrollLeft, previousTop = bounds.top - viewBounds.top + scrollTop;
  const before = zoom.value; zoom.value = Math.max(.1, Math.min(4, calculateWheelZoom(before, e.deltaY, e.deltaMode, view.clientHeight)));
  void nextTick(() => { const next = board.value!.getBoundingClientRect(); const scroll = calculateAnchoredCanvasScroll({ scrollLeft, scrollTop, anchorX: e.clientX - viewBounds.left, anchorY: e.clientY - viewBounds.top, previousZoom: before, nextZoom: zoom.value, previousLeft, previousTop, nextLeft: next.left - viewBounds.left + view.scrollLeft, nextTop: next.top - viewBounds.top + view.scrollTop }); view.scrollLeft = scroll.left; view.scrollTop = scroll.top; });
}
function key(e: KeyboardEvent) { if ((e.target as HTMLElement).closest('input,textarea,select,dialog,[role=dialog],[contenteditable=true]')) return;
  if (e.type === 'keydown' && viewport.value?.contains(e.target as Node)) { if (['+', '='].includes(e.key)) changeZoom(1); if (['-', '_'].includes(e.key)) changeZoom(-1); if (e.key === '0') resetZoom(); if (e.key.toLowerCase() === 'f') fit(); } if (e.code === 'Space') { space = e.type === 'keydown'; if (space) e.preventDefault(); } }
watch(() => store.image?.id, () => { gesture = null; transient.value = {}; void nextTick(fit); });
watch(() => [props.repairPreview, store.revision, store.image?.id], renderPreview);
onMounted(() => { observer = new ResizeObserver(() => { if (!gesture && fitMode) fit(); }); observer.observe(viewport.value!); window.addEventListener('keydown', key); window.addEventListener('keyup', key); fit(); });
onBeforeUnmount(() => { renderVersion++; observer?.disconnect(); window.removeEventListener('keydown', key); window.removeEventListener('keyup', key); });
</script>
<template><section class="workspace-canvas main">
  <div ref="viewport" class="canvas-scroll" tabindex="0" :aria-busy="editing" aria-label="设计图画布" @pointerdown="start($event)" @pointermove="move" @pointerup="end" @pointercancel="end" @wheel="wheel">
    <div v-if="store.image" class="board-space"><div ref="board" class="design-board" :style="boardStyle" :class="{ drawing: tool === 'draw' }">
      <img class="design-source" :src="preview || store.image.dataUrl" alt="当前设计图" draggable="false" />
      <div v-for="a in store.assets.filter(a => !a.hidden && !repairPreview)" :key="'preview-' + a.id" class="slice-cutout" :class="{ processed: hasProcessedSliceResult(a) || isLockedAiCompleteAsset(a) || a.isAiProcessedVariant || a.regeneration }" :style="{ ...rectStyle(transient[a.id] || a.placement), ...radiusStyle(a) }"><img v-if="hasProcessedSliceResult(a) || isLockedAiCompleteAsset(a) || a.isAiProcessedVariant || a.regeneration" :src="a.dataUrl" alt="" draggable="false" /></div>
      <div v-for="(a, index) in store.assets.filter(a => !a.hidden && !repairPreview)" :key="a.id" class="canvas-slice slice-box" :class="['slice-type-' + a.contentType, { active: store.selectedIds.includes(a.id), 'ai-processing': a.aiProcessing }]" :data-asset-id="a.id" :style="{ ...rectStyle(transient[a.id] || a.placement), ...radiusStyle(a) }" @pointerdown.stop="start($event, a.id)" @contextmenu.prevent.stop="settings(a.id)" @dblclick.stop="settings(a.id)">
        <span v-if="store.selectedIds.includes(a.id)" class="slice-label" title="打开切图设置" @pointerdown.stop @click.stop="settings(a.id)">{{ index + 1 }}. {{ a.name }}</span>
        <template v-if="a.id === store.draft.activeSliceId && tool === 'select' && !a.aiProcessing">
          <button v-if="!isLockedAiCompleteAsset(a)" v-for="handle in ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']" :key="handle" class="slice-handle" :data-slice-handle="handle" :aria-label="'调整切图大小 ' + handle" @pointerdown.stop="start($event, a.id, handle)"></button>
          <button v-for="corner in ['nw', 'ne', 'se', 'sw']" :key="'radius-' + corner" class="slice-radius-handle" :data-slice-radius-handle="corner" :aria-label="'调整圆角 ' + corner" @pointerdown.stop="startRadius($event, a, corner)"></button>
        </template>
      </div><div v-for="(region, index) in overlapRegions" :key="'overlap-' + index" class="slice-overlap-preview" :style="rectStyle(region)"></div><div v-if="drawing" class="draw-outline" :style="rectStyle(drawing)"></div>
    </div></div><div v-else class="canvas-empty" aria-label="等待上传设计图"></div>
  </div><button v-if="store.image" class="download" aria-label="下载单张" @click="download">↓</button></section></template>
