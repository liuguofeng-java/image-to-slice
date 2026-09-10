<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, computed, nextTick } from 'vue';
import { usePreviewViewport } from '../composables/use-preview-viewport';
import AppModal from './AppModal.vue';
import { api, fetchBackend, jsonRequest, pollProgress } from '../api/client';
import { useWorkspaceStore } from '../stores/workspace';
import type { Placement, SliceAsset } from '../types/workspace';
import { calculateDraggedSliceRadius, calculateSliceRadiusHandleInset } from '../services/slice-geometry.js';
import { cropImage } from '../services/workspace-image';
import { createBackgroundDecompositionReview, buildBackgroundRepairJobs, createBackgroundDecompositionCache, getCachedBackgroundDecomposition, updateDecompositionBackgroundRadius, updateDecompositionBackgroundCornerRadius, updateDecompositionBackground, moveDecompositionBackground, resizeDecompositionBackground, moveDecompositionOverlay, resizeDecompositionOverlay } from '../state/background-decomposition.js';
import { requestAiInpaint } from '../services/ai-inpaint.js';
import { buildBackgroundRestorePrompt } from '../services/ai-helpers.js';
import { createAiCompleteRegionsMaskDataUrl, createInnerFeatherMaskDataUrl, compositeAiInpaintResult } from '../services/inpaint-composite.js';
import { createAiInpaintResultPair } from '../services/ai-inpaint-results.js';
interface Overlay { id: string; name: string; bbox: Placement; remove: boolean }
interface Background { id: string; name: string; bbox: Placement; enabled: boolean; radius: number; radii?: Record<string, number>; overlays: Overlay[] }
const emit = defineEmits<{ close: [] }>(), store = useWorkspaceStore(), review = ref<{ imageId: string; backgrounds: Background[]; [key: string]: any } | null>(null), busy = ref(false), message = ref(''), error = ref('');
const viewport = ref<HTMLElement>(), selectedIndex = ref(0);
const previewViewport = usePreviewViewport(viewport, () => store.screen, 22), view = previewViewport.view;
const activeBackground = computed(() => review.value?.backgrounds[selectedIndex.value]);
const selectedOverlayId = ref('');
function reviewKey(event: KeyboardEvent) {
  if (busy.value || !review.value || (event.target as HTMLElement).closest('input,textarea,select,button')) return;
  const bg = activeBackground.value, overlay = bg?.overlays.find(o => o.id === selectedOverlayId.value && o.remove);
  if (!bg || !overlay) return;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault(); const step = event.shiftKey ? 10 : 1; if (!event.repeat) checkpoint();
    review.value = moveDecompositionOverlay(review.value, bg.id, overlay.id, { bbox: overlay.bbox, dx: event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, dy: event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0 }); persist();
  } else if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); change(() => { overlay.remove = false; }); }
}
const undo = ref<string[]>([]), redo = ref<string[]>([]);
function checkpoint() { if (review.value) { undo.value.push(JSON.stringify(review.value)); redo.value = []; } }
function restoreReview(back = true) { const stack = back ? undo : redo, other = back ? redo : undo; if (!review.value || !stack.value.length) return; other.value.push(JSON.stringify(review.value)); review.value = JSON.parse(stack.value.pop()!); persist(); }
function change(work: () => void) { checkpoint(); work(); persist(); }
function updateBox(bg: Background, key: keyof Placement, value: number, overlay?: Overlay) {
  if (!review.value || !Number.isFinite(value)) return;
  change(() => {
    const bbox = { ...(overlay?.bbox || bg.bbox), [key]: value };
    review.value = overlay
      ? moveDecompositionOverlay(review.value!, bg.id, overlay.id, { bbox })
      : updateDecompositionBackground(review.value!, bg.id, bbox);
  });
}
function updateRadius(bg: Background, value: number) {
  if (review.value && Number.isFinite(value)) change(() => { review.value = updateDecompositionBackgroundRadius(review.value!, bg.id, value); });
}
const radiusCorners: Record<string,string> = { nw: 'topLeft', ne: 'topRight', se: 'bottomRight', sw: 'bottomLeft' };
let radiusDrag: { id: number; backgroundId: string; corner: string; startX: number; startY: number; startRadius: number; snapshot: string } | null = null;
function radiusStyle(bg: Background) {
  const css: Record<string, string> = { borderRadius: ['topLeft','topRight','bottomRight','bottomLeft'].map(c => ((bg.radii?.[c] ?? bg.radius) * view.value.zoom) + 'px').join(' ') };
  for (const [corner, key] of Object.entries(radiusCorners)) { const value = calculateSliceRadiusHandleInset((bg.radii?.[key] ?? bg.radius) * view.value.zoom, bg.bbox.width * view.value.zoom, bg.bbox.height * view.value.zoom) + 'px'; css['--decomposition-radius-' + corner + '-x'] = css['--decomposition-radius-' + corner + '-y'] = value; }
  return css;
}
function startRadius(event: PointerEvent, bg: Background, corner: string) {
  if (busy.value || event.button !== 0 || !review.value) return; event.preventDefault(); checkpoint();
  radiusDrag = { id: event.pointerId, backgroundId: bg.id, corner, startX: event.clientX / view.value.zoom, startY: event.clientY / view.value.zoom, startRadius: bg.radii?.[radiusCorners[corner]!] ?? bg.radius, snapshot: JSON.stringify(review.value) };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
let drag: { id: number; backgroundId: string; overlayId?: string; before: Placement; snapshot: string; x: number; y: number; handle: string } | null = null;
function startDrag(event: PointerEvent, bg: Background, handle = '', overlay?: Overlay) {
  if (busy.value || event.button !== 0 || !review.value) return;
  selectedOverlayId.value = overlay?.id || ''; viewport.value?.focus({ preventScroll: true });
  event.preventDefault(); checkpoint();
  drag = { id: event.pointerId, backgroundId: bg.id, overlayId: overlay?.id, before: { ...(overlay?.bbox || bg.bbox) }, snapshot: JSON.stringify(review.value), x: event.clientX, y: event.clientY, handle };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function moveDrag(event: PointerEvent) {
  if (radiusDrag?.id === event.pointerId && review.value) { const bg = review.value.backgrounds.find(bg => bg.id === radiusDrag!.backgroundId)!; review.value = updateDecompositionBackgroundCornerRadius(review.value, bg.id, radiusCorners[radiusDrag.corner], calculateDraggedSliceRadius(radiusDrag, { x: event.clientX / view.value.zoom, y: event.clientY / view.value.zoom }, Math.min(bg.bbox.width, bg.bbox.height) / 2)); return; }
  if (!drag || drag.id !== event.pointerId || !review.value) return;
  const options = { bbox: drag.before, handle: drag.handle, dx: (event.clientX - drag.x) / view.value.zoom, dy: (event.clientY - drag.y) / view.value.zoom };
  if (drag.overlayId) review.value = (drag.handle ? resizeDecompositionOverlay : moveDecompositionOverlay)(review.value, drag.backgroundId, drag.overlayId, options);
  else review.value = (drag.handle ? resizeDecompositionBackground : moveDecompositionBackground)(review.value, drag.backgroundId, options);
}
function endDrag(event: PointerEvent) {
  if (radiusDrag?.id === event.pointerId) { if (event.type === 'pointercancel') { review.value = JSON.parse(radiusDrag.snapshot); undo.value.pop(); } radiusDrag = null; persist(); return; }
  if (!drag || drag.id !== event.pointerId) return;
  if (event.type === 'pointercancel') { review.value = JSON.parse(drag.snapshot); undo.value.pop(); }
  drag = null; persist();
}
let controller: AbortController | null = null, progressId = '', cancelled = false; const epoch = store.epoch;
function current() { if (cancelled || controller?.signal.aborted || epoch !== store.epoch) throw new DOMException('已取消', 'AbortError'); }
function cancel() { cancelled = true; controller?.abort(); if (progressId) void api(`/api/progress/${progressId}/cancel`, { method: 'POST' }).catch(() => {}); }
function persist() { if (review.value && store.image) { store.image.backgroundDecompositionCache = createBackgroundDecompositionCache(review.value, store.image); store.touch(); } }
async function plan(force = false) {
  const cached = getCachedBackgroundDecomposition(store.image?.backgroundDecompositionCache, store.image);
  if (!force && cached) { review.value = cached; return; }
  if (!confirm('将当前设计图发送至图片理解 API 分析切图，可能计费。继续？')) return;
  cancelled = false; controller = new AbortController(); progressId = `decompose_${crypto.randomUUID()}`; busy.value = true; error.value = '';
  const stop = pollProgress(progressId, text => { message.value = text; });
  try { const result = await api('/api/design/plan-background-decomposition', jsonRequest({ imageDataUrl: store.image!.dataUrl, width: store.screen.width, height: store.screen.height, sourceImageName: store.screen.name, progressId }, controller.signal)); current();
    const added: SliceAsset[] = [];
    for (const item of result.assets || []) { const p = item.bbox || item.placement; if (!p) continue; const dataUrl = await cropImage(store.image!.dataUrl, p, store.screen); added.push({ ...item, id: crypto.randomUUID(), name: item.name || `slice_${added.length + 1}`, contentType: 'image', placement: p, dataUrl, originalDataUrl: dataUrl }); }
    for (const item of result.texts || []) { const p = item.bbox || item.placement; if (p) added.push({ ...item, id: crypto.randomUUID(), name: item.name || '文字', placement: p, contentType: 'text', dataUrl: '', text: item.text || { ...item, characters: item.characters || item.content || '' } }); }
    current(); selectedIndex.value = 0; undo.value = []; redo.value = []; store.mutate(() => store.assets.push(...added)); review.value = { ...createBackgroundDecompositionReview(result, store.screen), imageId: store.image!.id }; persist(); message.value = `已添加 ${added.length} 个切图与文字层。确认背景和待移除区域后再生成。`;
  } catch (failure) { if ((failure as Error).name !== 'AbortError') error.value = (failure as Error).message; } finally { stop(); busy.value = false; }
}
async function generate() {
  if (!review.value || !confirm('使用图片生成 / 修补 API 还原已选背景，可能计费。继续？')) return;
  const jobs = buildBackgroundRepairJobs(review.value); cancelled = false; busy.value = true; error.value = '';
  try { for (const [index, job] of jobs.entries()) {
    if (cancelled || epoch !== store.epoch) break;
    controller = new AbortController(); progressId = `background_${crypto.randomUUID()}`; message.value = `背景 ${index + 1} / ${jobs.length}`;
    try { const source = await cropImage(store.image!.dataUrl, job.bbox, store.screen); current();
      const mask = createAiCompleteRegionsMaskDataUrl({ x: 0, y: 0, width: job.bbox.width, height: job.bbox.height }, job.regions);
      const generated = await requestAiInpaint({ fetchBackend, signal: controller.signal, sourceDataUrl: source, maskDataUrl: mask, name: job.name, width: job.bbox.width, height: job.bbox.height, prompt: buildBackgroundRestorePrompt(job), completeRegions: job.regions, progressId }); current();
      const dataUrl = await compositeAiInpaintResult(source, generated.dataUrl, await createInnerFeatherMaskDataUrl(mask, 6)); current();
      const id = crypto.randomUUID(); const pair = createAiInpaintResultPair({ compositeAsset: { id, name: job.name, contentType: 'background', placement: job.bbox, radius: job.radius, radii: job.radii, dataUrl, originalDataUrl: source, aiCompleted: true, aiCompletedDataUrl: dataUrl, backgroundCleanupStatus: 'clean', lastAiOperation: 'backgroundRestore' }, compositeDataUrl: dataUrl, rawFullDataUrl: generated.dataUrl, groupId: id, rawFullId: crypto.randomUUID() });
      await store.transaction(() => { current(); store.assets.push(pair.composite, pair.rawFull); });
    } catch (failure) { if ((failure as Error).name === 'AbortError') break; error.value += `${job.name}：${(failure as Error).message}\n`; }
  } } finally { busy.value = false; }
}
function box(p: Placement) { return { left: `${p.x / store.screen.width * 100}%`, top: `${p.y / store.screen.height * 100}%`, width: `${p.width / store.screen.width * 100}%`, height: `${p.height / store.screen.height * 100}%` }; }
onMounted(async () => { await plan(); await nextTick(); previewViewport.fit(); }); onBeforeUnmount(cancel); watch(() => store.epoch, () => { cancel(); emit('close'); });
</script>
<template><AppModal title="选择修补背景" class="decomposition-modal" @close="cancel(); emit('close')" @keydown="reviewKey" @keydown.ctrl.z.prevent="restoreReview()" @keydown.ctrl.y.prevent="restoreReview(false)">
  <template #header><div class="background-decomposition-title"><div><strong>选择修补背景</strong><span>蓝框是完整背景，红框会从背景中移除。艺术字、插画和融入画面的品牌内容默认保留。</span></div><nav class="canvas-zoom-controls html-preview-zoom-controls" aria-label="拆图画布缩放"><button aria-label="缩小" @click="previewViewport.zoom(-1)">−</button><button aria-label="恢复到 100%" @click="previewViewport.reset()">{{ Math.round(view.zoom * 100) }}%</button><button aria-label="放大" @click="previewViewport.zoom(1)">＋</button><button @click="previewViewport.fit()">适应</button></nav></div><div class="background-decomposition-head-actions"><button :disabled="busy" @click="plan(true)">重新 AI 识别</button><button class="background-decomposition-close" aria-label="关闭" @click="cancel(); emit('close')">×</button></div></template>
  <div class="background-decomposition-body"><div ref="viewport" class="background-decomposition-viewport" tabindex="0"><div class="background-decomposition-sizer" :style="{ width: Math.max(view.contentWidth + view.left, 1) + 'px', height: Math.max(view.contentHeight + view.top, 1) + 'px' }"><div class="background-decomposition-stage" :style="{ width: view.contentWidth + 'px', height: view.contentHeight + 'px', left: view.left + 'px', top: view.top + 'px' }">
    <img :src="store.image?.dataUrl" alt="背景范围预览" /><div class="background-decomposition-layer"><template v-for="(bg, index) in review?.backgrounds" :key="bg.id"><div class="background-decomposition-background" :class="{ disabled: !bg.enabled }" :style="{ ...box(bg.bbox), ...radiusStyle(bg) }" @pointerdown.stop="selectedIndex = index; startDrag($event, bg)" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag"><span class="background-decomposition-background-label">{{ bg.name }}</span><button v-if="selectedIndex === index" v-for="handle in ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']" :key="handle" class="background-decomposition-handle" :data-handle="handle" :aria-label="'调整背景 ' + handle" @pointerdown.stop="startDrag($event, bg, handle)" /><button v-if="selectedIndex === index" v-for="corner in ['nw','ne','se','sw']" :key="'radius-' + corner" class="background-decomposition-radius-handle" :data-decomposition-radius-handle="corner" :aria-label="'调整背景圆角 ' + corner" @pointerdown.stop="startRadius($event, bg, corner)" /></div></template>
    <template v-for="overlay in activeBackground?.overlays || []" :key="overlay.id"><div class="background-decomposition-overlay" :class="{ remove: overlay.remove }" :style="box(overlay.bbox)" @pointerdown.stop="startDrag($event, activeBackground!, '', overlay)" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag"><span class="background-decomposition-overlay-label">{{ overlay.name }}</span><button v-for="handle in ['nw', 'ne', 'se', 'sw']" :key="handle" class="background-decomposition-handle" :data-handle="handle" :aria-label="'调整覆盖区域 ' + handle" @pointerdown.stop="startDrag($event, activeBackground!, handle, overlay)" /></div></template>
    </div></div></div></div>
    <aside class="background-decomposition-list"><div class="background-decomposition-task-navigation"><span>{{ review?.backgrounds.length ? selectedIndex + 1 : 0 }} / {{ review?.backgrounds.length || 0 }}</span><div><button :disabled="selectedIndex === 0" @click="selectedIndex--">上一张</button><button :disabled="selectedIndex >= (review?.backgrounds.length || 0) - 1" @click="selectedIndex++">下一张</button></div></div>
      <p v-if="review && !review.backgrounds.length">未发现需要还原的完整背景。</p>
      <article v-for="(bg, index) in review?.backgrounds" :key="bg.id" class="background-decomposition-candidate" :class="{ active: selectedIndex === index, disabled: !bg.enabled }"><div class="background-decomposition-candidate-head"><input :checked="bg.enabled" :disabled="busy" type="checkbox" :aria-label="'生成 ' + bg.name" @change="change(() => bg.enabled = !bg.enabled)" /><button @click="selectedIndex = index"><span class="background-decomposition-candidate-index">{{ index + 1 }}</span>{{ bg.name }}</button></div>
      <div v-if="selectedIndex === index" class="background-decomposition-candidate-details"><div class="background-decomposition-fields"><label v-for="key in (['x', 'y', 'width', 'height'] as const)" :key="key">{{ key }}<input :value="bg.bbox[key]" :disabled="busy" type="number" @change="updateBox(bg, key, Number(($event.target as HTMLInputElement).value))" /></label><label>圆角<input :value="bg.radius" :disabled="busy" type="number" min="0" @change="updateRadius(bg, Number(($event.target as HTMLInputElement).value))" /></label></div>
      <div v-for="o in bg.overlays" :key="o.id" class="background-decomposition-candidate"><label><input :checked="o.remove" :disabled="busy" type="checkbox" @change="change(() => o.remove = !o.remove)" />移除 {{ o.name || o.id }}</label><div class="background-decomposition-fields"><label v-for="key in (['x', 'y', 'width', 'height'] as const)" :key="key">{{ key }}<input :value="o.bbox[key]" :disabled="busy" type="number" @change="updateBox(bg, key, Number(($event.target as HTMLInputElement).value), o)" /></label></div></div>
      </div></article>
    </aside>
  </div>
  <template #footer><span role="status" :class="{ 'field-error': error }">{{ error || message }}</span><div class="button-row"><button v-if="busy" @click="cancel">取消</button><button v-else @click="emit('close')">取消</button><button class="primary" :disabled="busy || !review || !buildBackgroundRepairJobs(review).length" @click="generate">生成完整背景</button></div></template>
</AppModal></template>
