import { ref, watch, onScopeDispose } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import { useAiTasksStore } from '../stores/ai-tasks';
import type { Placement } from '../types/workspace';
import { api, fetchBackend, pollProgress } from '../api/client';
import { loadBitmap } from '../services/workspace-image';
import { requestAiInpaint } from '../services/ai-inpaint.js';
import { buildAiCompletePrompt } from '../services/ai-helpers.js';
import { createAiCompleteRegionsMaskDataUrl, createInnerFeatherMaskDataUrl, compositeAiInpaintResult } from '../services/inpaint-composite';
import { createAiInpaintResultPair } from '../services/ai-inpaint-results.js';
import { getDirectChildRemovalRegions } from '../state/composite-slice-layers.js';
import { mapRegenerationChildren } from '../state/slice-regeneration.js';
import { replaceSliceEditedImage } from '../services/slice-edited-image';

export function useOverlapRepair() {
  const store = useWorkspaceStore(), tasks = useAiTasksStore();
  const preview = ref<{ id: string; regions: Placement[]; signature: string; epoch: number } | null>(null);
  function signature() { return JSON.stringify(store.assets.map(({ id, dataUrl, placement, contentType, parentId, hidden }) => ({ id, dataUrl, placement, contentType, parentId, hidden }))); }
  function clear() { preview.value = null; }
  async function repair(id: string) {
    const asset = store.assets.find(a => a.id === id);
    if (!asset || asset.aiProcessing || store.saving) return;
    if (preview.value?.id !== id) {
      const p = asset.placement;
      const regions = asset.contentType === 'background' ? getDirectChildRemovalRegions(asset, store.assets) : store.assets.flatMap(a => {
        if (a.id === id || a.hidden) return [];
        const x = Math.max(p.x, a.placement.x), y = Math.max(p.y, a.placement.y);
        const right = Math.min(p.x + p.width, a.placement.x + a.placement.width), bottom = Math.min(p.y + p.height, a.placement.y + a.placement.height);
        return right > x && bottom > y ? [{ x, y, width: right - x, height: bottom - y }] : [];
      });
      if (!regions.length) throw new Error('没有需要补齐的重叠区域。');
      preview.value = { id, regions, signature: signature(), epoch: store.epoch }; return;
    }
    const context = preview.value;
    if (context.signature !== signature()) { clear(); throw new Error('切图或遮挡区域已变化，请重新预览。'); }
    if (!confirm('确认补齐红色区域？将调用图片生成 / 修补 API，可能计费。')) return;
    const progressId = 'complete_' + crypto.randomUUID(), controller = tasks.begin(id, progressId);
    const original = JSON.parse(JSON.stringify(asset));
    const check = () => {
      if (controller.signal.aborted || context.epoch !== store.epoch) throw new DOMException('已取消', 'AbortError');
      if (signature() !== context.signature) throw new Error('切图或遮挡区域已变化，未覆盖现有图片。');
    };
    asset.aiProcessing = true;
    const stop = pollProgress(progressId, text => { if (!controller.signal.aborted) asset.aiProcessingLabel = text; });
    try {
      const bitmap = await loadBitmap(asset.dataUrl); check();
      const regions = mapRegenerationChildren(asset, context.regions, bitmap.naturalWidth, bitmap.naturalHeight);
      const local = { x: 0, y: 0, width: bitmap.naturalWidth, height: bitmap.naturalHeight };
      const mask = createAiCompleteRegionsMaskDataUrl(local, regions);
      const generated = await requestAiInpaint({ fetchBackend, signal: controller.signal, sourceDataUrl: asset.dataUrl, maskDataUrl: mask, name: asset.name, width: local.width, height: local.height, prompt: buildAiCompletePrompt({ ...asset, placement: local }, regions), completeRegions: regions, progressId });
      check();
      const dataUrl = await compositeAiInpaintResult(asset.dataUrl, generated.dataUrl, await createInnerFeatherMaskDataUrl(mask, 6)); check();
      const next = JSON.parse(JSON.stringify(original));
      replaceSliceEditedImage(next, dataUrl);
      Object.assign(next, { aiCompleted: true, aiCompletedDataUrl: dataUrl, aiCompletedPlacement: { ...next.placement }, lastAiOperation: 'complete' });
      if (next.contentType === 'background') next.backgroundCleanupStatus = 'clean';
      const pair = createAiInpaintResultPair({ compositeAsset: next, compositeDataUrl: dataUrl, rawFullDataUrl: generated.dataUrl, groupId: crypto.randomUUID(), rawFullId: crypto.randomUUID() });
      await store.transaction(() => { check(); const target = store.assets.find(a => a.id === id)!; Object.keys(target).forEach(key => delete target[key]); Object.assign(target, pair.composite); store.assets.push(pair.rawFull); });
      clear();
    } finally { stop(); tasks.finish(id, controller); asset.aiProcessing = false; asset.aiProcessingLabel = ''; }
  }
  function cancel() { const id = preview.value?.id, task = id ? tasks.get(id) : null; task?.controller.abort(); if (task) void api('/api/progress/' + task.progressId + '/cancel', { method: 'POST' }).catch(() => {}); clear(); }
  watch(() => store.epoch, cancel); onScopeDispose(cancel);
  return { preview, repair, clear, cancel };
}
