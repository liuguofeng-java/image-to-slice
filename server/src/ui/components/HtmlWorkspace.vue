<script setup lang="ts">
import { ref, computed, reactive, onMounted, onBeforeUnmount, watch } from 'vue';
import { usePreviewViewport } from '../composables/use-preview-viewport';
import AppModal from './AppModal.vue';
import { useWorkspaceStore } from '../stores/workspace';
import { api, jsonRequest, pollProgress } from '../api/client';
import { createEditableAssetDescriptors, createEditablePreviewContextSignature, hydrateCanonicalAssetHtml, dehydrateCanonicalAssetHtml } from '../services/editable-reference-assets.js';
import { createHtmlPreviewCacheEntry, normalizeHtmlPreviewCache } from '../state/html-preview-cache.js';
import { sanitizeFastGeneratedHtml } from '../../server/services/fast-html-sanitizer.js';
import { createZipBlob, textToUint8Array, dataUrlToUint8Array } from '../services/zip.js';
import { downloadBlob } from '../services/workspace-image';
import { readInspectorLayout, canDeleteInspectorElement, readInspectorImageAsset, clampInspectorWidth } from '../services/html-preview-inspector.js';
const emit = defineEmits<{ close: [] }>(), store = useWorkspaceStore();
const iframe = ref<HTMLIFrameElement>(), html = ref(''), busy = ref(false), error = ref(''), message = ref(''), inspecting = ref(true), selectedLabel = ref(''), text = ref(''), color = ref('#20232a'), fontSize = ref('16px');
const stage = ref<HTMLElement>(), inspectorWidth = ref(360), tree = ref<{ label: string; depth: number; index: number; ancestors: number[]; expandable: boolean }[]>([]), selectedIndex = ref(-1);
const selectionLocked = ref(false);
const collapsed = ref(new Set<number>());
const visibleTree = computed(() => tree.value.filter(row => !row.ancestors.some(id => collapsed.value.has(id))));
function toggleTree(index: number) { const value = new Set(collapsed.value); value.has(index) ? value.delete(index) : value.add(index); collapsed.value = value; }
const previewViewport = usePreviewViewport(stage, () => store.screen), view = previewViewport.view;
let treeElements: HTMLElement[] = [], cleanupDoc: (() => void) | null = null;
const imageAsset = ref<{ name: string; dataUrl: string } | null>(null);
const detailGroups = computed(() => {
  const l = layout.value; if (!l) return [];
  const sides = (value: Record<string, string>) => ['top', 'right', 'bottom', 'left'].map(k => value[k] || '0px').join(' ');
  return [
    { name: 'Geometry', entries: Object.entries(l.geometry).map(([k,v]) => [k, v + 'px']) },
    { name: 'Box model', entries: ['margin', 'border', 'padding'].map(k => [k, sides(l[k])]) },
    ...[['Layout','layout'], ['Typography','typography'], ['Appearance','appearance']].map(([name,key]) => ({ name, entries: Object.entries(l[key!]) }))
  ];
});
const highlight = ref<Record<string, string> | null>(null);
function updateHighlight() { if (!selected || !iframe.value || !stage.value) { highlight.value = null; return; } const r = selected.getBoundingClientRect(), f = iframe.value.getBoundingClientRect(), p = stage.value.getBoundingClientRect(); highlight.value = { left: (f.left - p.left + r.left * view.value.zoom) + 'px', top: (f.top - p.top + r.top * view.value.zoom) + 'px', width: r.width * view.value.zoom + 'px', height: r.height * view.value.zoom + 'px' }; }
function buildTree() { const doc = iframe.value?.contentDocument; treeElements = []; tree.value = []; function visit(element: Element, depth: number, ancestors: number[] = []) { if (!(element instanceof doc!.defaultView!.HTMLElement) || ['SCRIPT', 'STYLE', 'META', 'LINK'].includes(element.tagName)) return; const index = treeElements.length; treeElements.push(element as HTMLElement); tree.value.push({ index, depth, ancestors, expandable: !!element.children.length, label: element.tagName.toLowerCase() + (element.id ? '#' + element.id : '') + (element.getAttribute('class') ? '.' + element.getAttribute('class')!.trim().split(/\s+/).join('.') : '') }); for (const child of element.children) visit(child, depth + 1, [...ancestors, index]); } if (doc?.body) visit(doc.body, 0); }
function selectElement(el: HTMLElement, lock = true) {
  selectionLocked.value = lock;
  const doc = iframe.value!.contentDocument!; imageAsset.value = readInspectorImageAsset(el, store.assets); selected = el; selectedIndex.value = treeElements.indexOf(el); const row = tree.value[selectedIndex.value]; if (row) collapsed.value = new Set([...collapsed.value].filter(id => !row.ancestors.includes(id))); selectedLabel.value = el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''); text.value = el.children.length ? '' : el.textContent || '';
  const style = doc.defaultView!.getComputedStyle(el); color.value = style.color; fontSize.value = style.fontSize; layout.value = readInspectorLayout(el, doc.querySelector('.screen')); canDelete.value = canDeleteInspectorElement(el, doc.querySelector('.screen')); Object.keys(styleFields).forEach(key => { styleFields[key as keyof typeof styleFields] = style[key as keyof typeof styleFields]; }); updateHighlight();
}
const resizeStart = ref<{ x: number; width: number } | null>(null);
function resize(event: PointerEvent) { if (resizeStart.value) inspectorWidth.value = clampInspectorWidth(resizeStart.value.width + resizeStart.value.x - event.clientX); }
let controller: AbortController | null = null, progressId = '', selected: HTMLElement | null = null;
const layout = ref<Record<string, any> | null>(null), canDelete = ref(false);
const styleFields = reactive({ width: '', height: '', margin: '', padding: '', backgroundColor: '', borderRadius: '' });
const styleLabels = { width: '宽度', height: '高度', margin: '外边距', padding: '内边距', backgroundColor: '背景颜色', borderRadius: '圆角' };
const epoch = store.epoch;
function contextSignature() { return createEditablePreviewContextSignature({ sourceImageDataUrl: store.image?.dataUrl, ...store.screen, prompt: store.draft.prompt, assets: store.assets }); }
function sanitize(source: string) {
  const safe = sanitizeFastGeneratedHtml(source, createEditableAssetDescriptors(store.assets.filter(a => !a.hidden)), { previewWidth: store.screen.width, previewHeight: store.screen.height, sourceWidth: store.screen.width, sourceHeight: store.screen.height }).html;
  const doc = new DOMParser().parseFromString(hydrateCanonicalAssetHtml(safe, store.assets), 'text/html');
  doc.querySelectorAll('script,iframe,frame,object,embed,base,form,link,meta[http-equiv]').forEach(n => n.remove());
  for (const el of doc.querySelectorAll('*')) for (const attr of [...el.attributes]) if (/^on/i.test(attr.name) || /^(?:javascript|vbscript):/i.test(attr.value.trim())) el.removeAttribute(attr.name);
  const csp = doc.createElement('meta'); csp.httpEquiv = 'Content-Security-Policy'; csp.content = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; form-action 'none'"; doc.head.prepend(csp);
  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}
async function generate(force = false) {
  const cached = normalizeHtmlPreviewCache(store.draft);
  if (!force && cached) { try { html.value = sanitize(cached.canonicalHtml); message.value = cached.contextSignature !== contextSignature() ? '切图已发生变化，可重新生成 HTML 更新布局。' : '已恢复 HTML 缓存'; return; } catch (failure) { error.value = (failure as Error).message; return; } }
  if (!confirm('将当前设计图发送至图片理解 API 生成 HTML，可能计费。继续？')) return;
  cancel(); controller = new AbortController(); const request = controller, signature = contextSignature(); progressId = `html_${crypto.randomUUID()}`; busy.value = true; error.value = '';
  const stop = pollProgress(progressId, value => { message.value = value; });
  try { const result = await api('/api/design/reconstruct-h5', jsonRequest({ imageDataUrl: store.image!.dataUrl, sourceImageName: store.image!.id, referenceAssets: createEditableAssetDescriptors(store.assets.filter(a => !a.hidden)), prompt: store.draft.prompt, width: store.screen.width, height: store.screen.height, ratio: store.draft.currentRatio, progressId }, request.signal));
    if (request.signal.aborted || epoch !== store.epoch) return;
    if (signature !== contextSignature()) throw new Error('设计图或切图已变化，请重新生成 HTML。');
    const source = result.canonicalHtml || result.html; if (!source) throw new Error('模型未返回 HTML。');
    html.value = sanitize(source); store.draft.htmlPreview = createHtmlPreviewCacheEntry({ ...result, canonicalHtml: dehydrateCanonicalAssetHtml(html.value) }, signature); store.touch(); await store.save();
  } catch (failure) { if (!request.signal.aborted) error.value = (failure as Error).message; } finally { stop(); busy.value = false; }
}
function cancel() { controller?.abort(); if (progressId) void api(`/api/progress/${progressId}/cancel`, { method: 'POST' }).catch(() => {}); }
function bind() {
  cleanupDoc?.(); const doc = iframe.value?.contentDocument; selected = null; selectedLabel.value = ''; highlight.value = null; buildTree();
  if (!doc) return;
  const clearSelection = () => { selected = null; selectedLabel.value = ''; highlight.value = null; imageAsset.value = null; selectionLocked.value = false; };
  const click = (event: MouseEvent) => { event.preventDefault(); if (!inspecting.value || !(event.target instanceof doc.defaultView!.HTMLElement)) return; if (selectionLocked.value && selected === event.target) clearSelection(); else selectElement(event.target as HTMLElement); };
  const hover = (event: MouseEvent) => { if (inspecting.value && !selectionLocked.value && event.target instanceof doc.defaultView!.HTMLElement) selectElement(event.target as HTMLElement, false); };
  const key = (event: KeyboardEvent) => { if (event.key === 'Delete' && canDelete.value) { event.preventDefault(); void saveEdit(true); } };
  doc.addEventListener('click', click); doc.addEventListener('mousemove', hover); doc.addEventListener('keydown', key);
  cleanupDoc = () => { doc.removeEventListener('click', click); doc.removeEventListener('mousemove', hover); doc.removeEventListener('keydown', key); };
  if (doc.defaultView) previewViewport.forward(doc.defaultView);
  previewViewport.fit();
}
async function saveEdit(remove = false) {
  const doc = iframe.value?.contentDocument; if (!doc || !selected) return;
  if (remove) { if (!canDelete.value) return; selected.remove(); } else { if (!selected.children.length) selected.textContent = text.value; selected.style.color = color.value; selected.style.fontSize = fontSize.value; for (const key of Object.keys(styleFields) as (keyof typeof styleFields)[]) selected.style[key] = styleFields[key]; }
  const value = '<!doctype html>\n' + doc.documentElement.outerHTML;
  store.draft.htmlPreview = createHtmlPreviewCacheEntry({ mode: 'h5-fast-direct', canonicalHtml: dehydrateCanonicalAssetHtml(value) }, contextSignature()); store.touch();
  try { await store.save(); message.value = 'HTML 编辑已保存'; } catch (failure) { error.value = (failure as Error).message; }
  selectedLabel.value = ''; selected = null; selectionLocked.value = false; highlight.value = null; buildTree();
}
function download() {
  const doc = iframe.value?.contentDocument; if (!doc) return;
  const copy = new DOMParser().parseFromString(doc.documentElement.outerHTML, 'text/html'), assets: { name: string; data: Uint8Array }[] = [];
  copy.querySelectorAll('script,meta[http-equiv]').forEach(n => n.remove());
  for (const [index, img] of [...copy.images].entries()) if (img.src.startsWith('data:')) { const name = `assets/image-${index + 1}.png`; assets.push({ name, data: dataUrlToUint8Array(img.src) }); img.setAttribute('src', name); }
  downloadBlob(createZipBlob([{ name: 'index.html', data: textToUint8Array('<!doctype html>\n' + copy.documentElement.outerHTML) }, ...assets]), 'design-html.zip');
}
watch(() => store.epoch, () => { cancel(); emit('close'); });
watch(view, () => requestAnimationFrame(updateHighlight));
onMounted(() => generate()); onBeforeUnmount(() => { cancel(); cleanupDoc?.(); });
</script>
<template><AppModal title="HTML 预览" class="html-workspace" @close="cancel(); emit('close')">
  <template #header><div class="html-preview-title"><strong>HTML 预览</strong><nav class="canvas-zoom-controls html-preview-zoom-controls" aria-label="预览缩放"><button aria-label="缩小" @click="previewViewport.zoom(-1)">−</button><button aria-label="恢复到 100%" @click="previewViewport.reset()">{{ Math.round(view.zoom * 100) }}%</button><button aria-label="放大" @click="previewViewport.zoom(1)">＋</button><button @click="previewViewport.fit()">适应</button></nav></div><div class="html-preview-actions"><button class="html-preview-regenerate" :disabled="busy" @click="generate(true)">重新 AI 识别</button><button class="html-preview-download" :disabled="!html" @click="download">下载 HTML</button><button class="html-preview-inspector-toggle" :class="{ active: inspecting }" :aria-pressed="inspecting" @click="inspecting = !inspecting">检查与编辑</button><button v-if="busy" @click="cancel">取消</button><button class="html-preview-close" aria-label="关闭" @click="cancel(); emit('close')">×</button></div></template>
  <div class="html-preview-body"><div class="html-preview-viewport"><div ref="stage" class="html-preview-stage" tabindex="0" @scroll="updateHighlight"><div class="html-preview-sizer" :style="{ width: Math.max(view.contentWidth + view.left, 1) + 'px', height: Math.max(view.contentHeight + view.top, 1) + 'px' }"><iframe v-if="html" ref="iframe" class="html-preview-frame" title="生成的 HTML 预览" sandbox="allow-same-origin" :srcdoc="html" :style="{ width: store.screen.width + 'px', height: store.screen.height + 'px', transform: 'scale(' + view.zoom + ')', left: view.left + 'px', top: view.top + 'px' }" @load="bind"></iframe></div></div><div v-if="inspecting && highlight" class="html-preview-inspector-highlight" :style="highlight"><span>{{ selectedLabel }}</span></div></div>
    <div v-if="inspecting" class="html-preview-inspector-resize" role="separator" aria-label="调整布局检查器宽度" aria-orientation="vertical" :aria-valuenow="inspectorWidth" aria-valuemin="280" aria-valuemax="560" tabindex="0" @pointerdown="resizeStart = { x: $event.clientX, width: inspectorWidth }; ($event.currentTarget as HTMLElement).setPointerCapture($event.pointerId)" @pointermove="resize" @pointerup="resizeStart = null" @pointercancel="resizeStart = null" @keydown.left.prevent="inspectorWidth = clampInspectorWidth(inspectorWidth + 20)" @keydown.right.prevent="inspectorWidth = clampInspectorWidth(inspectorWidth - 20)"></div>
    <aside v-if="inspecting" class="html-preview-inspector" aria-label="布局检查器" :style="{ width: inspectorWidth + 'px' }">
      <div class="html-preview-inspector-head"><div class="html-preview-inspector-heading"><strong>Elements</strong><span>选择后可删除生成元素</span></div><div class="html-preview-inspector-actions"><button class="danger" :disabled="!canDelete || !selectedLabel" @click="saveEdit(true)">删除</button></div></div>
      <div class="html-preview-inspector-tree"><div v-for="row in visibleTree" :key="row.index" class="html-preview-inspector-tree-row" :class="{ selected: row.index === selectedIndex }" :style="{ paddingLeft: (6 + row.depth * 12) + 'px' }"><button class="html-preview-inspector-disclosure" :disabled="!row.expandable" :aria-label="(collapsed.has(row.index) ? '展开 ' : '收起 ') + row.label" :aria-expanded="row.expandable ? !collapsed.has(row.index) : undefined" @click="toggleTree(row.index)">{{ row.expandable ? (collapsed.has(row.index) ? '▸' : '▾') : '' }}</button><button class="html-preview-inspector-node-label" @click="selectElement(treeElements[row.index]!)">{{ row.label }}</button></div><div v-if="!tree.length" class="html-preview-inspector-empty">等待预览内容</div></div>
      <section class="html-preview-inspector-details" aria-label="元素布局">
        <div class="html-preview-inspector-section-title">{{ imageAsset ? '切图资产' : 'Layout' }}</div>
        <div v-if="!selectedLabel" class="html-preview-inspector-empty">选择元素以查看布局</div>
        <figure v-else-if="imageAsset" class="html-preview-inspector-asset-preview"><img v-if="imageAsset.dataUrl" :src="imageAsset.dataUrl" :alt="imageAsset.name" /><figcaption>{{ imageAsset.name }}</figcaption></figure>
        <template v-else>
          <section v-for="group in detailGroups" :key="group.name" class="html-preview-inspector-detail-group"><strong>{{ group.name }}</strong><div v-for="[key,value] in group.entries" :key="String(key)" class="html-preview-inspector-detail-row"><span>{{ key }}</span><code>{{ value || '—' }}</code></div></section>
          <details class="html-preview-inspector-detail-group"><summary>编辑属性</summary><label>文字<input v-model="text" /></label><div class="field-grid"><label>颜色<input v-model="color" /></label><label>字号<input v-model="fontSize" /></label><label v-for="(label, key) in styleLabels" :key="key">{{ label }}<input v-model="styleFields[key]" /></label></div><div class="button-row"><button @click="saveEdit()">应用编辑</button><button :disabled="!canDelete" title="切图锚点及其父容器不能删除，请在工作区管理资产" @click="saveEdit(true)">删除元素</button></div></details>
        </template>
      </section>
    </aside>
  </div>
  <template #footer><span role="status" :class="{ 'field-error': error }">{{ error || message }}</span></template>
</AppModal></template>
