import { ref, watch, onScopeDispose } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import { useAiTasksStore } from '../stores/ai-tasks';
import { api, fetchBackend, pollProgress } from '../api/client';
import type { ModelConfigs, SliceAsset, ModelConfig } from '../types/workspace';
import type { RegenerationSnapshot, RegenerationItem, RegenerationAction } from '../types/regeneration';
import { loadBitmap } from '../services/workspace-image';
import { getDirectChildRemovalRegions, getDirectChildRemovalSignature } from '../state/composite-slice-layers.js';
import { regenerationSignature, ensureRegenerationSupported, requestRegeneration, mapRegenerationChildren, applyRegenerationResult } from '../state/slice-regeneration.js';
import { validateRegenerationDimensions } from '../../core/regeneration.js';
export function useRegeneration() {
  const workspace = useWorkspaceStore(), tasks = useAiTasksStore();
  const snapshot = ref<RegenerationSnapshot | null>(null);
  let sessionEpoch = -1, provider: ModelConfig, cancelled = false;
  const signatures = new Map<string, string>();
  function signature(a: SliceAsset) { return regenerationSignature(a, [getDirectChildRemovalSignature(a, workspace.assets), workspace.assets.filter(c => c.parentId === a.id && !c.hidden).map(c => [c.id, c.contentType, c.dataUrl, c.text])]); }
  function check(item: RegenerationItem) { const a = workspace.assets.find(a => a.id === item.id); if (!a || sessionEpoch !== workspace.epoch || signature(a) !== signatures.get(a.id)) throw new Error('图片、切图框、类型或子级已变化，请关闭并重新生成。'); return a; }
  async function open() {
    await workspace.save(); await ensureRegenerationSupported(fetchBackend);
    const config = await api<ModelConfigs>('/api/model-configs');
    const selectedProvider = config.modelConfigs.find(c => c.id === config.taskRouting.generation);
    if (!selectedProvider?.hasApiKey) throw new Error('请先设置图片生成 / 修补 API 和密钥。');
    provider = selectedProvider; sessionEpoch = workspace.epoch; signatures.clear();
    const items: RegenerationItem[] = [];
    for (const row of workspace.list.rows) { const a = workspace.assets.find(a => a.id === row.id)!; if (a.contentType !== 'image' || !a.regenerateMarked) continue;
      signatures.set(a.id, signature(a)); const bitmap = await loadBitmap(a.dataUrl); validateRegenerationDimensions(bitmap.naturalWidth, bitmap.naturalHeight);
      items.push({ id: a.id, name: a.name, dataUrl: a.dataUrl, width: bitmap.naturalWidth, height: bitmap.naturalHeight, childCount: getDirectChildRemovalRegions(a, workspace.assets).length, status: 'pending' }); }
    if (sessionEpoch !== workspace.epoch) return;
    snapshot.value = { items, running: false, saving: false, confirmed: false, provider: `${provider.name} · ${provider.model} · ${provider.baseUrl}` };
  }
  function cancel() {
    cancelled = true;
    for (const item of snapshot.value?.items || []) { const task = tasks.get(item.id); if (task) { task.controller.abort(); void api(`/api/progress/${encodeURIComponent(task.progressId)}/cancel`, { method: 'POST' }).catch(() => {}); } if (item.status === 'pending') item.status = 'cancelled'; }
  }
  async function run(items: RegenerationItem[]) {
    const session = snapshot.value; if (!session || session.running) return;
    session.running = true; session.confirmed = true; cancelled = false;
    try { for (const item of items) {
      if (cancelled || session !== snapshot.value) break;
      if (tasks.get(item.id) || workspace.assets.find(a => a.id === item.id)?.aiProcessing) { item.status = 'failed'; item.error = '该图片有其他任务正在运行，请完成后重试。'; continue; }
      const progressId = `regenerate_${crypto.randomUUID()}`, controller = tasks.begin(item.id, progressId); let a: SliceAsset | undefined;
      const stop = pollProgress(progressId, message => { if (session === snapshot.value && !cancelled) item.progress = message; });
      try { a = check(item); item.status = 'running'; item.error = ''; a.aiProcessing = true;
        const result = await requestRegeneration(fetchBackend, { dataUrl: item.dataUrl, name: item.name, width: item.width, height: item.height,
          excludeRegions: mapRegenerationChildren(a, getDirectChildRemovalRegions(a, workspace.assets), item.width, item.height),
          expectedProvider: { id: provider.id, model: provider.model, baseUrl: provider.baseUrl }, progressId }, controller.signal);
        if (controller.signal.aborted || cancelled || session !== snapshot.value) throw new DOMException('已取消', 'AbortError');
        check(item); const bitmap = await loadBitmap(result.dataUrl); validateRegenerationDimensions(bitmap.naturalWidth, bitmap.naturalHeight, item.width, item.height);
        if (result.width !== bitmap.naturalWidth || result.height !== bitmap.naturalHeight) throw new Error('接口声明尺寸与实际图片不一致，禁止应用。');
        if (controller.signal.aborted || cancelled || session !== snapshot.value) throw new DOMException('已取消', 'AbortError');
        check(item); item.result = result; item.status = 'ready';
      } catch (failure) { item.status = cancelled || (failure as Error).name === 'AbortError' ? 'cancelled' : 'failed'; item.error = (failure as Error).message; }
      finally { stop(); tasks.finish(item.id, controller); if (a) a.aiProcessing = false; }
    } } finally { session.running = false; }
  }
  async function action(event: RegenerationAction) {
    const session = snapshot.value; if (!session || session.saving) return;
    const item = session.items.find(i => i.id === event.id);
    if (event.type === 'close') { if ((session.running || session.items.some(i => i.status === 'ready')) && !confirm('关闭将取消任务并放弃尚未应用的结果，是否继续？')) return; cancel(); snapshot.value = null; }
    if (event.type === 'cancel') cancel();
    if (event.type === 'start' && !session.confirmed) await run(session.items);
    if (event.type === 'retry' && item && ['failed', 'cancelled'].includes(item.status) && confirm('重试会再次调用远程服务，可能计费。是否继续？')) await run([item]);
    if (event.type === 'discard' && item?.status === 'ready') { delete item.result; item.status = 'discarded'; }
    if (event.type === 'apply' && item?.status === 'ready' && !session.running) {
      session.saving = true;
      try { check(item); await workspace.transaction(() => applyRegenerationResult(check(item), item.result, item, item.result!.provider)); item.status = 'applied'; delete item.result; }
      catch (failure) { item.error = (failure as Error).message; } finally { session.saving = false; }
    }
  }
  function dispose() { cancel(); snapshot.value = null; }
  watch(() => workspace.epoch, dispose); onScopeDispose(dispose);
  return { snapshot, open, action };
}
