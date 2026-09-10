<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, computed, nextTick } from 'vue';
import { useWorkspaceStore, emptyDraft } from './stores/workspace';
import { useAiTasksStore } from './stores/ai-tasks';
import { useImageEditor } from './composables/use-image-editor';
import { useOverlapRepair } from './composables/use-overlap-repair';
import { useRegeneration } from './composables/use-regeneration';
import { api } from './api/client';
import { readFile } from './services/workspace-image';
import { exportSlices } from './services/workspace-export';
import type { SliceListEvent } from './types/slice-list';
import WorkspaceCanvas from './components/WorkspaceCanvas.vue';
import ImageSourcePanel from './components/ImageSourcePanel.vue';
import SliceAssetList from './components/SliceAssetList.vue';
import SliceCutoutEditor from './components/SliceCutoutEditor.vue';
import SliceRegenerationReview from './components/SliceRegenerationReview.vue';
import ModelSettings from './components/ModelSettings.vue';
import WorkspaceHistory from './components/WorkspaceHistory.vue';
import SliceSettings from './components/SliceSettings.vue';
import HtmlWorkspace from './components/HtmlWorkspace.vue';
import AiDecomposition from './components/AiDecomposition.vue';
import SliceImagePreview from './components/SliceImagePreview.vue';
const store = useWorkspaceStore(), tasks = useAiTasksStore(), { editor, backend, open: openEditor, commit } = useImageEditor(), regeneration = useRegeneration(), overlap = useOverlapRepair();
const tool = ref<'select' | 'draw'>('select'), repairPreview = ref(false), panel = ref<'settings' | 'history' | 'html' | 'decomposition' | null>(null), settingsId = ref(''), previewId = ref(''), sidebarOpen = ref(false), status = ref(''), connected = ref(false), connectionError = ref('');
const imagePreview = ref<InstanceType<typeof SliceImagePreview>>();
const sidebarToggle = ref<HTMLButtonElement>(), slicePanel = ref<HTMLElement>();
function closeSidebar(event?: KeyboardEvent) { if (!sidebarOpen.value) return; event?.preventDefault(); event?.stopPropagation(); sidebarOpen.value = false; sidebarToggle.value?.focus({ preventScroll: true }); }
watch(sidebarOpen, async open => { if (open) { await nextTick(); slicePanel.value?.focus({ preventScroll: true }); } });
const canvas = ref<InstanceType<typeof WorkspaceCanvas>>();
const single = computed(() => store.selected.length === 1 ? store.selected[0] : undefined);
const raster = computed(() => !!single.value && ['image', 'background'].includes(single.value.contentType));
const selectionBusy = computed(() => store.saving || store.selected.some(a => a.aiProcessing));
const canRestore = computed(() => store.selected.some(a => a.initialPlacement && (a.placement.x !== a.initialPlacement.x || a.placement.y !== a.initialPlacement.y)));
const markLabel = computed(() => store.selected.filter(a => a.contentType === 'image' && !a.aiProcessing).every(a => a.regenerateMarked) && markAllowed.value ? '取消重新生成标记' : '标记重新生成');
const settingsAsset = computed(() => store.assets.find(a => a.id === settingsId.value));
const previewAsset = computed(() => store.assets.find(a => a.id === previewId.value));
const markAllowed = computed(() => store.selected.some(a => a.contentType === 'image' && !a.aiProcessing));
const pendingActions = ref(0);
let saveTimer: ReturnType<typeof setTimeout>;
async function attempt(work: () => unknown) { pendingActions.value++; try { await work(); status.value = ''; } catch (failure) { status.value = (failure as Error).message; } finally { pendingActions.value--; } }
async function connect() {
  connectionError.value = ''; try { await api('/health'); const draft = await api('/api/workspace-draft'); if (draft.restorePreference === 'restore' && draft.draft) await store.restore(draft.draft, draft.draftId); else if (draft.recordCount) status.value = '可从“切图记录”恢复上次工作。'; connected.value = true; } catch (failure) { connectionError.value = (failure as Error).message; }
}
async function action(e: SliceListEvent) {
  await attempt(async () => {
    if (e.type === 'reorder') {
      const source = store.assets.find(a => a.id === e.sourceId), target = store.assets.find(a => a.id === e.targetId);
      if (!source || !target || source.id === target.id || source.aiProcessing || target.aiProcessing) return;
      if ((source.parentId || null) !== (target.parentId || null)) throw new Error('只能在同一父级内调整图层顺序。');
      store.mutate(() => {
        const display = [...store.assets].reverse(); display.splice(display.indexOf(source), 1);
        display.splice(display.indexOf(target) + ((e.before ?? true) ? 0 : 1), 0, source);
        store.assets.splice(0, store.assets.length, ...display.reverse());
      }); return;
    }
    const a = store.assets.find(a => a.id === e.id); if (!a) return;
    if (e.type === 'select') store.select(e.id, e.additive, e.shift);
    if (e.type === 'visibility') store.mutate(() => { a.hidden = !a.hidden; });
    if (e.type === 'remove') store.remove([a.id]);
    if (e.type === 'settings') { if (!store.selectedIds.includes(a.id)) store.select(a.id); settingsId.value = a.id; }
    if (e.type === 'preview') previewId.value = a.id;
    if (e.type === 'ai-cutout') await openEditor(a.id);
    if (e.type === 'cancel') { const task = tasks.get(a.id); task?.controller.abort(); if (task) await api(`/api/progress/${task.progressId}/cancel`, { method: 'POST' }); }
  });
}
async function newWork() { if (store.saving) return; if (store.dirty) { if (!confirm('当前工作尚未保存。保存后开始新工作？')) return; await store.save(); } tasks.abortAll(); await store.restore(emptyDraft(), null); await api('/api/workspace-draft', { method: 'DELETE' }); }
function key(e: KeyboardEvent) { if (document.querySelector('dialog[open]') || (e.target as HTMLElement).closest('input,textarea,select,dialog,[role=dialog],[role=alertdialog],[contenteditable=true]')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? store.redo() : store.undo(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); store.selectedIds = store.assets.map(a => a.id); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void attempt(store.save); }
  if (['Delete', 'Backspace'].includes(e.key) && store.selectedIds.length && !store.saving) { e.preventDefault(); store.remove(); }
  if (store.active && !e.ctrlKey && !e.metaKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); const step = e.shiftKey ? 10 : 1; void attempt(() => store.nudge(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0, e.repeat)); }
  if (e.key === 'Escape') { if (settingsId.value) settingsId.value = ''; else if (panel.value) panel.value = null; else { sidebarOpen.value = false; tool.value = 'select'; store.selectedIds = []; store.draft.activeSliceId = null; } }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'v') tool.value = 'select';
}
async function paste(e: ClipboardEvent) { if ((e.target as HTMLElement).closest('input,textarea,dialog,[role=dialog]')) return; const images = Array.from(e.clipboardData?.files || []).filter(f => f.type.startsWith('image/')); if (!images.length) return; e.preventDefault(); await attempt(async () => { const values = await Promise.all(images.map(async file => ({ dataUrl: await readFile(file), name: file.name }))); if (store.draft.currentMode === 'image-to-image') { store.draft.referenceImages.push(...values); store.draft.referenceImages.splice(16); store.touch(); } else await store.addImages(values); }); }
function beforeUnload(e: BeforeUnloadEvent) { if (store.dirty || store.saving || tasks.size || editor.value?.hasUnsaved() || imagePreview.value?.hasUnsaved() || regeneration.snapshot.value?.items.some(i => i.status === 'ready')) { e.preventDefault(); e.returnValue = ''; } }
watch(() => store.revision, () => { clearTimeout(saveTimer); if (!store.saving) saveTimer = setTimeout(() => { void store.save().catch(() => {}); }, 700); });
watch(() => store.epoch, () => { settingsId.value = ''; previewId.value = ''; tasks.abortAll(); });
onMounted(() => { void connect(); window.addEventListener('keydown', key); window.addEventListener('paste', paste); window.addEventListener('beforeunload', beforeUnload); });
onBeforeUnmount(() => { clearTimeout(saveTimer); tasks.abortAll(); window.removeEventListener('keydown', key); window.removeEventListener('paste', paste); window.removeEventListener('beforeunload', beforeUnload); });
</script>
<template>
<main class="shell vue-shell" :data-save-state="store.error ? 'error' : store.dirty || store.saving || pendingActions ? 'pending' : 'saved'">
  <header class="canvas-toolbar vue-topbar" aria-label="画布操作"><div class="topbar-actions">
    <button ref="sidebarToggle" class="mobile-panel-toggle text-action" :aria-expanded="sidebarOpen" aria-controls="slice-panel" @click="sidebarOpen ? closeSidebar() : sidebarOpen = true">图片与切图</button>
    <div class="import-action-group ai"><button class="text-action place-action" :disabled="!store.image || store.saving" @click="panel = 'decomposition'">AI拆图</button><button class="import-help" aria-label="说明 AI拆图" title="一次识别普通 PNG 切图和需要还原的完整主视觉背景；普通切图直接加入画布，背景确认范围后再生成"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.4 2.4 0 0 1 4.6 1c0 1.8-2.4 2-2.4 3.7M12 17h.01"/></svg></button></div>
    <nav v-if="store.image" class="canvas-zoom-controls preview-zoom-controls" aria-label="画布缩放"><button aria-label="缩小" @click="canvas?.changeZoom(-1)">−</button><button class="preview-zoom-value" aria-label="恢复到 100%" @click="canvas?.resetZoom()">{{ Math.round((canvas?.zoom || 1) * 100) }}%</button><button aria-label="放大" @click="canvas?.changeZoom(1)">＋</button><button @click="canvas?.fit()">适应</button></nav>
    <div class="import-action-group"><button class="text-action place-action" :disabled="!store.image || store.saving" @click="panel = 'html'">生成 HTML</button><button class="import-help" aria-label="说明生成 HTML" title="识别当前设计图的文字、布局和切图，生成可预览、编辑和下载的 HTML"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.4 2.4 0 0 1 4.6 1c0 1.8-2.4 2-2.4 3.7M12 17h.01"/></svg></button></div>
    <button class="text-action place-action" :disabled="!store.markedCount || store.saving" @click="attempt(regeneration.open)">AI重新生成 ({{ store.markedCount }})</button>
    <button class="settings-trigger" @click="panel = panel === 'settings' ? null : 'settings'">设置</button><button class="new-work-trigger" :disabled="store.saving" @click="attempt(newWork)">开始新工作</button><button class="drafts-trigger" @click="panel = panel === 'history' ? null : 'history'">切图记录</button>
  </div></header>
  <section class="workspace vue-workspace">
    <aside class="sidebar vue-sidebar" :class="{ 'has-result': !!store.image, 'image-mode': store.draft.currentMode === 'image-to-image', 'custom-mode': store.draft.currentRatio === 'custom', 'is-open': sidebarOpen }">
      <ImageSourcePanel />
      <section v-if="store.image" id="slice-panel" ref="slicePanel" class="cut-section open vue-slice-list" tabindex="-1" @keydown.esc="closeSidebar($event)">
        <div v-if="store.draft.manifest.resultImages.length > 1" class="result-strip"><button v-for="(image, index) in store.draft.manifest.resultImages" :key="image.id" :aria-pressed="index === store.draft.activeResultIndex" @click="store.activate(index)"><img :src="image.dataUrl" :alt="'设计图 ' + (index + 1)" /></button></div>
        <div class="cut-grid"><SliceAssetList :snapshot="store.list" @action="action" /></div>
      </section>
      <WorkspaceHistory v-if="panel === 'history'" @close="panel = null" />
    </aside>
    <WorkspaceCanvas ref="canvas" :tool="tool" :repair-preview="repairPreview" :overlap-regions="overlap.preview.value?.regions || []" @error="status = $event" @settings="settingsId = $event" />
  </section>
  <div v-if="store.image" class="resource-toolbar vue-resource-toolbar" role="toolbar" aria-label="切图工具栏">
    <div class="slice-tool-mode" role="group" aria-label="切图画布工具"><button v-for="mode in (['select', 'draw'] as const)" :key="mode" :data-slice-tool="mode" :class="{ active: tool === mode }" :aria-pressed="tool === mode" :aria-label="mode === 'select' ? '选择' : '连续框选'" :data-tooltip="mode === 'select' ? '选择' : '连续框选'" @click="tool = mode">{{ mode === 'select' ? '选择' : '连续框选' }}</button></div>
    <div class="cut-head-actions" role="group" aria-label="批量操作"><button id="exportSlices" :disabled="!store.assets.length" aria-label="导出切图包" data-tooltip="导出切图包" @click="attempt(exportSlices)">导出切图包</button><button id="toggleAllSlices" :disabled="!store.assets.length || store.saving" :data-visibility-state="store.assets.every(a => a.hidden) ? 'hidden' : 'visible'" :aria-label="store.assets.every(a => a.hidden) && store.assets.length ? '全部显示' : '全部隐藏'" :data-tooltip="store.assets.every(a => a.hidden) && store.assets.length ? '全部显示' : '全部隐藏'" @click="store.mutate(() => { const hidden = !store.assets.every(a => a.hidden); store.assets.forEach(a => { a.hidden = hidden; }); })">全部隐藏</button><button id="repairPreview" :disabled="!store.assets.length" :aria-pressed="repairPreview" aria-label="预览补齐" data-tooltip="预览补齐" title="使用周围颜色预览移除切图后的背景，不调用 AI" @click="repairPreview = !repairPreview">预览补齐</button></div>
    <div v-if="store.selected.length" class="selected-slice-actions" role="group" aria-label="所选资源操作">
      <template v-if="single"><button data-slice-toolbar-action="preview" :disabled="selectionBusy || !raster" aria-label="图片预览" data-tooltip="图片预览" @click="previewId = single.id">图片预览</button><button data-slice-toolbar-action="visibility" :disabled="selectionBusy" :data-visibility-state="single.hidden ? 'hidden' : 'visible'" :aria-label="single.hidden ? '显示图层' : '隐藏图层'" :data-tooltip="single.hidden ? '显示图层' : '隐藏图层'" @click="store.mutate(() => { single!.hidden = !single!.hidden; })">显隐</button><button data-slice-toolbar-action="ai-cutout" :disabled="selectionBusy || !raster" aria-label="AI 抠图" data-tooltip="AI 抠图" @click="attempt(() => openEditor(single!.id, 'cutout'))">AI 抠图</button></template>
      <button data-slice-toolbar-action="restore-position" :disabled="selectionBusy || !canRestore" :aria-label="single ? '还原位置' : '还原选中位置'" :data-tooltip="single ? '还原位置' : '还原选中位置'" @click="attempt(store.restorePosition)">还原位置</button>
      <button v-if="single?.aiProcessing" class="danger" data-slice-toolbar-action="cancel" aria-label="取消当前任务" data-tooltip="取消当前任务" @click="action({ type: 'cancel', id: single.id })">取消当前任务</button>
      <button data-slice-toolbar-action="mark-regenerate" :disabled="!markAllowed || store.saving" :aria-pressed="markLabel === '取消重新生成标记'" :aria-label="markLabel" :data-tooltip="markAllowed ? markLabel : '仅未运行任务的图片类型可标记'" @click="store.toggleMark">{{ markLabel }}</button>
    </div>
  </div>
  <div v-if="store.error || status || store.saving" class="workspace-status" role="status"><span>{{ store.error || status || '正在保存…' }}</span><button v-if="store.error" @click="attempt(store.save)">重试保存</button><button v-if="status" aria-label="关闭提示" @click="status = ''">×</button></div>
  <div v-if="!connected" class="startup-gate"><div class="startup-card"><span v-if="!connectionError" class="startup-spinner"></span><strong class="startup-title">{{ connectionError ? '无法连接本地服务' : '正在连接本地服务' }}</strong><p>{{ connectionError || '正在加载工作区…' }}</p><button v-if="connectionError" @click="connect">重新连接</button></div></div>
  <ModelSettings v-if="panel === 'settings'" @close="panel = null" /><HtmlWorkspace v-if="panel === 'html'" @close="panel = null" /><AiDecomposition v-if="panel === 'decomposition'" @close="panel = null" /><SliceSettings v-if="settingsAsset" :asset="settingsAsset" :repair-preview="overlap.preview.value?.id === settingsAsset.id" @repair="id => attempt(() => overlap.repair(id))" @close="settingsId = ''; overlap.clear()" />
  <SliceImagePreview v-if="previewAsset" ref="imagePreview" :asset="previewAsset" @close="previewId = ''" /><SliceCutoutEditor ref="editor" :backend="backend" :commit="commit" /><SliceRegenerationReview v-if="regeneration.snapshot.value" :snapshot="regeneration.snapshot.value" @action="regeneration.action" />
</main>
</template>
