<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import type { SliceAsset } from '../types/workspace';
import { useWorkspaceStore } from '../stores/workspace';
import { assetEditSignature } from '../services/asset-edit-signature';
import { loadBitmap } from '../services/workspace-image';
import { api, fetchBackend, pollProgress } from '../api/client';
import { requestAiInpaint } from '../services/ai-inpaint.js';
import { buildAiCompletePrompt } from '../services/ai-helpers.js';
import { compositeAiInpaintResult, createInnerFeatherMaskDataUrl } from '../services/inpaint-composite';
import { createAiInpaintResultPair } from '../services/ai-inpaint-results.js';
import { replaceSliceEditedImage } from '../services/slice-edited-image';
import { getSliceRadiiCssValue } from '../services/slice-geometry.js';
const props = defineProps<{ asset: SliceAsset }>(), emit = defineEmits<{ close: [] }>(), store = useWorkspaceStore();
const dialog = ref<HTMLDialogElement>(), base = ref<HTMLCanvasElement>(), mask = ref<HTMLCanvasElement>(), tool = ref('brush'), size = ref(24), dirty = ref(false), masked = ref(false), busy = ref(false), error = ref(''), status = ref(''), closePrompt = ref(false), aspect = ref(1);
let previous: HTMLElement | null = null, stroke: { id: number; x: number; y: number } | null = null, controller: AbortController | null = null, progressId = '', raw = '';
const unsavedPrompt = ref<HTMLElement>(); let promptReturn: HTMLElement | null = null;
watch(closePrompt, async open => { if (open) { promptReturn = document.activeElement as HTMLElement; await nextTick(); unsavedPrompt.value?.querySelector<HTMLButtonElement>('button')?.focus(); } else promptReturn?.focus(); });
function promptKey(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePrompt.value = false; return; }
  if (event.key !== 'Tab') return;
  const controls = [...unsavedPrompt.value!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], first = controls[0], last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
const signature = assetEditSignature(props.asset);
const source = JSON.stringify(props.asset), epoch = store.epoch;
function check() { if (epoch !== store.epoch || assetEditSignature(store.assets.find(a => a.id === props.asset.id)) !== signature) throw new Error('切图已变化，未覆盖外部修改。请重新打开。'); }
function cancel() { controller?.abort(); if (progressId) void api('/api/progress/' + progressId + '/cancel', { method: 'POST' }).catch(() => {}); }
function close() { if (closePrompt.value) { closePrompt.value = false; return; } if (dirty.value || masked.value) closePrompt.value = true; else { cancel(); emit('close'); } }
function point(e: PointerEvent) { const r = mask.value!.getBoundingClientRect(); return { x: (e.clientX - r.x) * mask.value!.width / r.width, y: (e.clientY - r.y) * mask.value!.height / r.height }; }
function paint(e: PointerEvent, start = false) {
  if (busy.value || (!start && stroke?.id !== e.pointerId)) return;
  const p = point(e);
  for (const canvas of tool.value === 'eraser' ? [base.value!, mask.value!] : [mask.value!]) {
    const ctx = canvas.getContext('2d')!; ctx.save(); ctx.globalCompositeOperation = tool.value === 'eraser' ? 'destination-out' : 'source-over'; ctx.strokeStyle = ctx.fillStyle = '#ff4040'; ctx.lineWidth = size.value; ctx.lineCap = ctx.lineJoin = 'round'; ctx.beginPath();
    if (!start && stroke) { ctx.moveTo(stroke.x, stroke.y); ctx.lineTo(p.x, p.y); ctx.stroke(); } else { ctx.arc(p.x, p.y, size.value / 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }
  if (tool.value === 'eraser') dirty.value = true;
  stroke = { id: e.pointerId, ...p };
  masked.value = mask.value!.getContext('2d')!.getImageData(0, 0, mask.value!.width, mask.value!.height).data.some((v, i) => i % 4 === 3 && v > 0);
}
async function complete() {
  if (busy.value || !masked.value || !confirm('确认通过图片生成 / 修补 API 补齐标记区域？可能计费。')) return;
  controller = new AbortController(); const request = controller; progressId = 'preview_' + crypto.randomUUID(); busy.value = true; error.value = '';
  const stop = pollProgress(progressId, value => { status.value = value; });
  try {
    check(); const w = base.value!.width, h = base.value!.height, sourceDataUrl = base.value!.toDataURL();
    const c = document.createElement('canvas'); c.width = w; c.height = h; const ctx = c.getContext('2d')!; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    const data = mask.value!.getContext('2d')!.getImageData(0, 0, w, h); for (let i = 0; i < data.data.length; i += 4) { const value = data.data[i + 3]!; data.data[i] = data.data[i + 1] = data.data[i + 2] = value; data.data[i + 3] = 255; } ctx.putImageData(data, 0, 0);
    const maskDataUrl = c.toDataURL(), regions = [{ x: 0, y: 0, width: w, height: h }];
    const image = await requestAiInpaint({ fetchBackend, signal: request.signal, sourceDataUrl, maskDataUrl, name: props.asset.name, width: w, height: h, prompt: buildAiCompletePrompt({ ...props.asset, placement: regions[0] }, regions), progressId });
    if (request.signal.aborted) return; check();
    const merged = await loadBitmap(await compositeAiInpaintResult(sourceDataUrl, image.dataUrl, await createInnerFeatherMaskDataUrl(maskDataUrl, 6)));
    if (request.signal.aborted) return; check(); base.value!.getContext('2d')!.clearRect(0, 0, w, h); base.value!.getContext('2d')!.drawImage(merged, 0, 0); mask.value!.getContext('2d')!.clearRect(0, 0, w, h); dirty.value = true; masked.value = false; raw = image.dataUrl;
  } catch (failure) { if (!request.signal.aborted) error.value = (failure as Error).message; } finally { stop(); busy.value = false; }
}
async function save() {
  if (!dirty.value || busy.value) return;
  busy.value = true; error.value = '';
  try { check(); const dataUrl = base.value!.toDataURL(); const next: SliceAsset = JSON.parse(source); replaceSliceEditedImage(next, dataUrl); Object.assign(next, { aiCompleted: true, aiCompletedDataUrl: dataUrl, lastAiOperation: 'complete', aiCompletedPlacement: { ...next.placement } });
    const pair = raw ? createAiInpaintResultPair({ compositeAsset: next, compositeDataUrl: dataUrl, rawFullDataUrl: raw, groupId: crypto.randomUUID(), rawFullId: crypto.randomUUID() }) : null;
    await store.transaction(() => { check(); const a = store.assets.find(a => a.id === props.asset.id)!; Object.keys(a).forEach(key => delete a[key]); Object.assign(a, pair?.composite || next); if (pair) store.assets.push(pair.rawFull); });
    dirty.value = false; masked.value = false; emit('close');
  } catch (failure) { error.value = (failure as Error).message; closePrompt.value = false; } finally { busy.value = false; }
}
onMounted(async () => { previous = document.activeElement as HTMLElement; dialog.value!.showModal(); try { const image = await loadBitmap(props.asset.dataUrl); if (!base.value || !mask.value) return; for (const canvas of [base.value, mask.value]) { canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; } base.value.getContext('2d')!.drawImage(image, 0, 0); aspect.value = image.naturalWidth / image.naturalHeight; size.value = Math.max(2, Math.min(24, Math.round(Math.min(image.naturalWidth, image.naturalHeight) * .04))); } catch (failure) { error.value = (failure as Error).message; } });
onBeforeUnmount(() => { cancel(); dialog.value?.close(); previous?.focus(); });
defineExpose({ hasUnsaved: () => dirty.value || masked.value || busy.value });
</script>
<template><dialog ref="dialog" class="slice-image-editor slice-preview-dialog" aria-label="编辑切图" @cancel.prevent="close">
  <div class="slice-image-editor-viewport"><div class="slice-image-editor-stage" :class="{ 'ai-processing': busy }" :style="{ '--slice-editor-aspect': aspect, borderRadius: getSliceRadiiCssValue(asset, store.screen), overflow: 'hidden' }"><canvas ref="base"></canvas><canvas ref="mask" id="sliceImageEditorMask" @pointerdown="if (!busy) { ($event.currentTarget as HTMLElement).setPointerCapture($event.pointerId); paint($event, true); }" @pointermove="paint($event)" @pointerup="stroke = null" @pointercancel="stroke = null"></canvas></div></div>
  <div class="slice-image-editor-toolbar"><button class="slice-image-editor-tool" :class="{ active: tool === 'brush' }" :disabled="busy" aria-label="画笔" title="画笔" @click="tool = 'brush'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 3 6 6-10 10-7 1 1-7Z"/><path d="m5 13 6 6"/></svg></button><button class="slice-image-editor-tool" :class="{ active: tool === 'eraser' }" :disabled="busy" aria-label="橡皮擦" title="橡皮擦" @click="tool = 'eraser'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 15 12-12 6 6-12 12H7Z"/><path d="m8 10 6 6M7 21h13"/></svg></button><label class="slice-image-editor-size"><span>粗细</span><input v-model.number="size" :disabled="busy" type="range" min="1" max="200" /><output>{{ size }}px</output></label><div class="slice-image-editor-actions"><button class="slice-image-editor-action" :disabled="busy || !masked" @click="complete">{{ busy ? status || '正在处理…' : 'AI补齐' }}</button><button v-if="busy" class="slice-image-editor-cancel-ai" aria-label="取消 AI 补齐" @click="cancel">×</button><button class="slice-image-editor-action primary" :disabled="busy || !dirty" @click="save">保存到切图</button></div></div>
  <button class="slice-image-preview-close" aria-label="关闭" @click="close">×</button><p v-if="error" class="preview-error" role="alert">{{ error }}</p>
  <section v-if="closePrompt" ref="unsavedPrompt" @keydown="promptKey" class="slice-image-editor-unsaved" role="alertdialog" aria-label="保存修改"><div class="slice-image-editor-unsaved-card"><strong>保存修改？</strong><p>当前切图存在未保存的图片修改。</p><div class="slice-image-editor-unsaved-actions"><button @click="closePrompt = false">取消</button><button @click="cancel(); emit('close')">不保存</button><button class="confirm" :disabled="busy || !dirty" @click="save">保存修改</button></div></div></section>
</dialog></template>
