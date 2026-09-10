<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import { api, jsonRequest, pollProgress } from '../api/client';
import { readFile } from '../services/workspace-image';
import AppModal from './AppModal.vue';
const store = useWorkspaceStore(), files = ref<HTMLInputElement>(), references = ref<HTMLInputElement>();
const busy = ref(false), status = ref(''), error = ref(''), custom = ref(false), customWidth = ref(750), customHeight = ref(1334), referencePreview = ref('');
let controller: AbortController | null = null, progressId = '';
const ratios = [
  { name: '1:1', label: '正方形', w: 1024, h: 1024 }, { name: '16:9', label: '横屏', w: 1920, h: 1080 },
  { name: '4:3', label: '传统屏', w: 1600, h: 1200 }, { name: '3:4', label: '竖屏', w: 1200, h: 1600 },
  { name: '9:16', label: '手机屏', w: 750, h: 1334 }
];
function mode(value: 'text-to-image' | 'image-to-image') { store.draft.currentMode = value; store.touch(); }
function openReferences(event: MouseEvent) { if (!(event.target as HTMLElement).closest('button,input')) references.value?.click(); }
async function importFiles(items: File[], reference = false) {
  const epoch = store.epoch;
  try {
    const images = await Promise.all(items.filter(f => /^image\/(png|jpeg|webp)$/.test(f.type)).map(async f => ({ name: f.name, dataUrl: await readFile(f) })));
    if (epoch !== store.epoch) return;
    if (reference) { store.draft.referenceImages.push(...images); store.draft.referenceImages.splice(16); store.touch(); }
    else if (images.length) await store.addImages(images);
  } catch (failure) { error.value = (failure as Error).message; }
}
async function upload(event: Event, reference = false) { const input = event.target as HTMLInputElement; await importFiles(Array.from(input.files || []), reference); input.value = ''; }
function paste(event: ClipboardEvent) {
  if (store.draft.currentMode !== 'image-to-image' || !event.clipboardData?.files.length) return;
  event.preventDefault(); event.stopPropagation(); void importFiles(Array.from(event.clipboardData.files), true);
}
function drop(event: DragEvent) { if (store.draft.currentMode !== 'image-to-image') return; event.preventDefault(); void importFiles(Array.from(event.dataTransfer?.files || []), true); }
function openCustom() { customWidth.value = store.draft.width; customHeight.value = store.draft.height; custom.value = true; }
function saveCustom() { if (![customWidth.value, customHeight.value].every(n => Number.isInteger(n) && n >= 256 && n <= 4096)) return; store.draft.currentRatio = 'custom'; store.draft.width = customWidth.value; store.draft.height = customHeight.value; store.touch(); custom.value = false; }
function cancel() { controller?.abort(); if (progressId) void api(`/api/progress/${progressId}/cancel`, { method: 'POST' }).catch(() => {}); }
async function generate() {
  if (!store.draft.prompt.trim()) { error.value = '请先输入描述词。'; return; }
  if (store.draft.currentMode === 'image-to-image' && !store.draft.referenceImages.length) { error.value = '请先添加参考图片。'; return; }
  if (!confirm('图片将发送到当前图片生成 / 修补 API，可能计费。开始生成？')) return;
  controller = new AbortController(); const request = controller, epoch = store.epoch; progressId = `image_${crypto.randomUUID()}`; busy.value = true; error.value = '';
  const stop = pollProgress(progressId, text => { status.value = text; });
  try {
    const result = await api(store.draft.currentMode === 'image-to-image' ? '/api/images/edit' : '/api/images/generate', jsonRequest({ prompt: store.draft.prompt, width: store.draft.width, height: store.draft.height, quality: 'high', images: store.draft.referenceImages, progressId }, request.signal));
    if (!request.signal.aborted && epoch === store.epoch) await store.addImages(result.images || []);
  } catch (failure) { if (!request.signal.aborted) error.value = (failure as Error).message; }
  finally { stop(); busy.value = false; controller = null; }
}
onBeforeUnmount(cancel);
</script>
<template>
  <nav class="tabs" aria-label="生成模式"><button class="tab" :class="{ active: store.draft.currentMode === 'text-to-image' }" @click="mode('text-to-image')">文生图</button><button class="tab" :class="{ active: store.draft.currentMode === 'image-to-image' }" @click="mode('image-to-image')">图生图</button></nav>
  <div class="controls source-controls">
    <section class="section"><label class="section-title" for="prompt">1. 输入描述词</label>
      <div class="prompt-box" :class="{ 'with-reference': store.draft.currentMode === 'image-to-image' }" @paste="paste" @dragover.prevent @drop="drop">
        <textarea id="prompt" v-model="store.draft.prompt" maxlength="1000" @input="store.touch" />
        <div class="char-count">{{ store.draft.prompt.length }} / 1000</div>
        <div v-if="store.draft.currentMode === 'image-to-image'" class="reference-strip" :class="{ 'has-overflow': store.draft.referenceImages.length > 4 }"><div class="reference-drop" :class="{ 'has-image': store.draft.referenceImages.length }" tabindex="0" aria-label="参考图片上传区" @click="openReferences" @keydown.enter.prevent="references?.click()">
          <input ref="references" type="file" aria-label="上传参考图片" accept="image/png,image/jpeg,image/webp" multiple @change="upload($event, true)" />
          <span v-if="!store.draft.referenceImages.length" class="reference-empty"><strong>粘贴图片或点击上传</strong><span>支持一次上传多张，也支持连续粘贴多张参考图</span></span>
          <div v-else class="reference-chips"><div v-for="(image, index) in store.draft.referenceImages" :key="index" class="reference-chip"><button type="button" class="reference-thumb" :aria-label="'预览参考图 ' + (index + 1)" @click="referencePreview = image.dataUrl"><img class="reference-preview" :src="image.dataUrl" :alt="'参考图 ' + (index + 1)" /><span class="reference-info"><strong>{{ image.name || '参考图 ' + (index + 1) }}</strong></span></button><button class="reference-remove" :aria-label="'移除参考图 ' + (index + 1)" @click="store.draft.referenceImages.splice(index, 1); store.touch()">×</button></div><button class="reference-add" aria-label="添加参考图片" @click="references?.click()">＋</button></div>
        </div><div v-if="store.draft.referenceImages.length > 4" class="reference-popover"><div class="reference-popover-grid"><div v-for="(image, index) in store.draft.referenceImages" :key="index" class="reference-chip"><button class="reference-thumb" @click="referencePreview = image.dataUrl"><img class="reference-preview" :src="image.dataUrl" alt="" /><span class="reference-info"><strong>{{ image.name }}</strong></span></button><button class="reference-remove" :aria-label="'移除参考图 ' + (index + 1)" @click="store.draft.referenceImages.splice(index, 1); store.touch()">×</button></div></div></div></div>
      </div>
    </section>
    <section class="section"><div class="section-title">2. 选片比例</div><div class="ratio-grid">
      <button v-for="ratio in ratios" :key="ratio.name" class="choice" :class="{ active: store.draft.currentRatio === ratio.name }" :aria-pressed="store.draft.currentRatio === ratio.name" @click="store.draft.currentRatio = ratio.name; store.draft.width = ratio.w; store.draft.height = ratio.h; store.touch()"><span class="choice-main">{{ ratio.name }}</span><span class="choice-label">{{ ratio.label }}</span><span class="choice-size">{{ ratio.w }}px × {{ ratio.h }}px</span></button>
      <button class="choice" :class="{ active: store.draft.currentRatio === 'custom' }" @click="openCustom"><span class="choice-main">自定义</span><span class="choice-size">{{ store.draft.currentRatio === 'custom' ? store.draft.width + 'px × ' + store.draft.height + 'px' : '手动输入宽高' }}</span></button>
    </div></section>
    <div class="generate-actions"><button class="generate" :disabled="busy || store.saving" @click="generate">AI生图</button><span class="generate-or">或</span><button class="generate secondary" :disabled="busy || store.saving" @click="files?.click()">本地图片</button><input ref="files" data-testid="local-image" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden @change="upload" /></div>
    <p v-if="busy" role="status">{{ status || '生成中…' }} <button @click="cancel">取消</button></p><p v-if="error" class="field-error" role="alert">{{ error }}</p>
  </div>
  <AppModal v-if="custom" title="自定义尺寸" class="custom-size-modal" @close="custom = false"><form @submit.prevent="saveCustom"><div class="custom-size-fields"><label class="size-field">宽度<span class="custom-size-input"><input v-model.number="customWidth" aria-label="宽度" type="number" min="256" max="4096" step="1" required /><span class="custom-size-unit">px</span></span></label><span class="link-icon">×</span><label class="size-field">高度<span class="custom-size-input"><input v-model.number="customHeight" aria-label="高度" type="number" min="256" max="4096" step="1" required /><span class="custom-size-unit">px</span></span></label></div><div class="hint">支持 256–4096px</div><div class="custom-size-actions"><button type="button" @click="custom = false">取消</button><button class="confirm" type="submit">确定</button></div></form></AppModal>
  <AppModal v-if="referencePreview" title="参考图片" @close="referencePreview = ''"><img class="asset-full-preview" :src="referencePreview" alt="参考图片预览" /></AppModal>
</template>
