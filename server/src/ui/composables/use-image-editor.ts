import { ref, watch, onScopeDispose } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import { api, jsonRequest, fetchBackend, pollProgress } from '../api/client';
import { sourceSignature, loadBitmap } from '../services/workspace-image';
import { useAiTasksStore } from '../stores/ai-tasks';
import { mapRegenerationChildren } from '../state/slice-regeneration.js';
import { requestAiInpaint } from '../services/ai-inpaint.js';
import { buildCompositeParentCleanupPrompt } from '../services/ai-helpers.js';
import { createAiCompleteRegionsMaskDataUrl, createInnerFeatherMaskDataUrl, compositeAiInpaintResult } from '../services/inpaint-composite';
import type { CutoutEditorBackend, CutoutEditorSnapshot, CutoutEditorMode, ImageEditorSaveResult } from '../types/cutout-editor';
import { getDirectChildRemovalSignature, getDirectChildRemovalRegions, isAiTransparentChildCleanupCurrent } from '../state/composite-slice-layers.js';
import { applySliceTrimResult, applySliceTransparencyResult, applySliceImageProcessingResult, restoreSliceImageProcessingState, restoreSliceTransparencyState, slicePlacementSignature } from '../state/slice-ai-state.js';

export function useImageEditor() {
  const workspace = useWorkspaceStore(), tasks = useAiTasksStore();
  const editor = ref<{ open: (snapshot: CutoutEditorSnapshot) => Promise<void>; close: () => void; dispose: () => void; hasUnsaved: () => boolean }>();
  let context: { epoch: number; assetId: string; signature: string; children: string; cleaned?: boolean } | null = null;
  const activeTasks = new Set<string>();
  const post = (path: string, payload: unknown) => api(path, jsonRequest(payload));
  async function local(path: string, payload: Record<string, any>) {
    const id = String(payload.progressId || ''); activeTasks.add(id);
    try { return await post(path, payload); } finally { activeTasks.delete(id); }
  }
  const backend: CutoutEditorBackend = {
    health: () => api('/api/local-segmentation/health'), localHealth: () => api('/api/local-image-processing/health'),
    createSession: p => post('/api/local-segmentation/session', p), predict: p => post('/api/local-segmentation/predict', p),
    closeSession: async id => { await api(`/api/local-segmentation/session/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
    inpaint: p => local('/api/local-image-processing/inpaint', p), upscale: p => local('/api/local-image-processing/upscale', p),
    cancel: async id => { await api(`/api/progress/${encodeURIComponent(id)}/cancel`, { method: 'POST' }); }
  };
  async function open(id: string, mode: CutoutEditorMode = 'cutout') {
    const a = workspace.assets.find(a => a.id === id);
    if (!a || a.aiProcessing || !['background', 'image'].includes(a.contentType)) return;
    const next = { epoch: workspace.epoch, assetId: a.id, signature: a.dataUrl, children: getDirectChildRemovalSignature(a, workspace.assets), cleaned: false };
    context = next; let dataUrl = a.dataUrl;
    const children = getDirectChildRemovalRegions(a, workspace.assets);
    if (mode === 'cutout' && children.length && !isAiTransparentChildCleanupCurrent(a, workspace.assets)) {
      if (!confirm('此图包含独立子级。先通过图片生成 / 修补 API 清理子级覆盖区再抠图，可能计费。继续？')) return;
      const id = `parent_cleanup_${crypto.randomUUID()}`, controller = tasks.begin(a.id, id), placement = slicePlacementSignature(a.placement);
      const check = () => { if (controller.signal.aborted || context !== next || workspace.epoch !== next.epoch) throw new DOMException('已取消', 'AbortError'); if (a.dataUrl !== next.signature || placement !== slicePlacementSignature(a.placement) || next.children !== getDirectChildRemovalSignature(a, workspace.assets)) throw new Error('图片或子级已变化，请重新打开编辑器。'); };
      a.aiProcessing = true; const stop = pollProgress(id, text => { if (!controller.signal.aborted) a.aiProcessingLabel = text; });
      try {
        const bitmap = await loadBitmap(dataUrl); check();
        const regions = mapRegenerationChildren(a, children, bitmap.naturalWidth, bitmap.naturalHeight);
        const localPlacement = { x: 0, y: 0, width: bitmap.naturalWidth, height: bitmap.naturalHeight };
        const mask = createAiCompleteRegionsMaskDataUrl(localPlacement, regions);
        const result = await requestAiInpaint({ fetchBackend, signal: controller.signal, sourceDataUrl: dataUrl, maskDataUrl: mask, name: a.name, width: bitmap.naturalWidth, height: bitmap.naturalHeight,
          prompt: buildCompositeParentCleanupPrompt({ name: a.name, placement: localPlacement }, regions), completeRegions: regions, progressId: id }); check();
        dataUrl = await compositeAiInpaintResult(dataUrl, result.dataUrl, await createInnerFeatherMaskDataUrl(mask, 6)); check(); next.cleaned = true;
      } finally { stop(); tasks.finish(a.id, controller); a.aiProcessing = false; a.aiProcessingLabel = ''; }
    }
    await editor.value?.open({ assetId: a.id, name: a.name, dataUrl, contentType: a.contentType as 'image' | 'background', openMode: mode,
      maskDataUrl: a.cutoutMaskDataUrl, settings: a.cutoutSettings, childSignature: context.children,
      sourceSignature: sourceSignature(a.dataUrl), placementSignature: slicePlacementSignature(a.placement),
      sourcePixelWidth: a.sourcePixelWidth, sourcePixelHeight: a.sourcePixelHeight, outputPixelWidth: a.outputPixelWidth, outputPixelHeight: a.outputPixelHeight, upscaleScale: a.upscaleScale,
      processingRestore: a.imageProcessingRestoreState?.dataUrl ? { dataUrl: a.imageProcessingRestoreState.dataUrl, scope: 'image-processing' } : a.transparencyRestoreState?.dataUrl ? { dataUrl: a.transparencyRestoreState.dataUrl, scope: 'transparency' } : null });
  }
  async function commit(result: ImageEditorSaveResult) {
    const check = () => {
      const a = workspace.assets.find(a => a.id === result.assetId);
      if (!a || !context || workspace.epoch !== context.epoch || a.dataUrl !== context.signature || (result.placementSignature && result.placementSignature !== slicePlacementSignature(a.placement)) || context.children !== getDirectChildRemovalSignature(a, workspace.assets)) throw new Error('图片、切图框或子级已变化，请关闭后重新打开。');
      return a;
    };
    check();
    await workspace.transaction(() => {
      const target = check(), a = JSON.parse(JSON.stringify(target));
      for (const op of JSON.parse(JSON.stringify(result.operations))) {
        if (op.kind === 'trim') applySliceTrimResult(a, op);
        else if (op.kind === 'restore') { if (op.scope === 'image-processing') restoreSliceImageProcessingState(a); else restoreSliceTransparencyState(a); a.dataUrl = op.dataUrl; }
        else if (op.kind === 'cutout') { applySliceTransparencyResult(a, { dataUrl: op.dataUrl, ai: true }); a.cutoutMethod = 'sam2-local'; a.cutoutMaskDataUrl = op.maskDataUrl; a.cutoutSettings = op.settings; a.aiTransparentChildSignature = op.childSignature || ''; }
        else applySliceImageProcessingResult(a, { ...op, operation: op.kind });
      }
      a.dataUrl = result.dataUrl; if (a.transparent) a.transparentDataUrl = a.dataUrl; if (a.aiTransparent) a.aiTransparentDataUrl = a.dataUrl;
      if (context?.cleaned) { a.compositeCleanupStatus = 'clean'; if (a.contentType === 'background') a.backgroundCleanupStatus = 'clean'; a.aiTransparentChildSignature = context.children; }
      Object.keys(target).forEach(key => delete target[key]); Object.assign(target, a);
    });
  }
  function dispose() { context = null; editor.value?.dispose(); for (const id of activeTasks) void backend.cancel(id).catch(() => {}); }
  watch(() => workspace.epoch, dispose); onScopeDispose(dispose);
  return { editor, backend, open, commit };
}
