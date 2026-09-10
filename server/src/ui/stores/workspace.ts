import { computed, ref, toRaw } from 'vue';
import { defineStore } from 'pinia';
import type { WorkspaceDraft, SliceAsset, ResultImage, Placement } from '../types/workspace';
import type { SliceListSnapshot } from '../types/slice-list';
import { api, jsonRequest } from '../api/client';
import { loadBitmap, cropImage, decodePixels } from '../services/workspace-image';
import { normalizeCompositeSliceLayers, buildCompositeSliceDisplayTree, inferSmallestContainingBackgroundId, isValidSliceParent } from '../state/composite-slice-layers.js';
import { recoverLegacySliceTrimPosition, restoreSliceInitialPosition, shouldRefreshSliceCropAfterPositionRestore } from '../state/slice-ai-state.js';
import { hasProcessedSliceResult, isLockedAiCompleteAsset } from '../state/slice-ai-state.js';
import { createAiCompleteEditableCopy } from '../services/ai-inpaint-results.js';
import { reserveSliceAssetName } from '../../core/slice-asset-name.js';
import { assetEditSignature } from '../services/asset-edit-signature';
import { replaceSliceCrop } from '../services/slice-crop';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function emptyDraft(): WorkspaceDraft {
  return { version: 1, manifest: { screen: { name: '设计图', width: 390, height: 844 }, resultImages: [], assets: [] }, activeResultIndex: 0, activeSliceId: null,
    prompt: '', width: 750, height: 1334, currentMode: 'text-to-image', currentRatio: '9:16', currentStyle: '', referenceImages: [], htmlPreviewSchemaVersion: 2, htmlPreview: null };
}
export const useWorkspaceStore = defineStore('workspace', () => {
  const draft = ref<WorkspaceDraft>(emptyDraft()), draftId = ref<string | null>(null);
  const selectedIds = ref<string[]>([]), undoStack = ref<WorkspaceDraft[]>([]), redoStack = ref<WorkspaceDraft[]>([]);
  const epoch = ref(0), dirty = ref(false), saving = ref(false), error = ref(''), revision = ref(0);
  let writeQueue: Promise<unknown> = Promise.resolve();
  const image = computed(() => draft.value.manifest.resultImages[draft.value.activeResultIndex]);
  const assets = computed(() => image.value?.sliceManifest.assets || []);
  const active = computed(() => assets.value.find(a => a.id === draft.value.activeSliceId));
  const selected = computed(() => assets.value.filter(a => selectedIds.value.includes(a.id)));
  const screen = computed(() => draft.value.manifest.screen);
  const markedCount = computed(() => assets.value.filter(a => a.contentType === 'image' && a.regenerateMarked).length);
  const list = computed<SliceListSnapshot>(() => ({ imageId: image.value?.id || '', animateReorder: true,
    rows: buildCompositeSliceDisplayTree(assets.value).map(({ layer: a, depth, childCount }: { layer: SliceAsset; depth: number; childCount: number }, index: number) => ({
      id: a.id, parentId: a.parentId || null, name: a.name, number: index + 1, depth, childCount,
      contentType: a.contentType, text: a.text?.characters || a.text?.text || '', dataUrl: a.dataUrl,
      radius: `${a.radius || 0}px`, description: `${a.placement.width} × ${a.placement.height}`, selected: selectedIds.value.includes(a.id),
      hidden: !!a.hidden, processing: !!a.aiProcessing, processingLabel: a.aiProcessingLabel || '', auditFailed: false,
      aiTransparent: !!a.aiTransparent, aiTransparencyCurrent: true, locallyRepaired: !!a.localInpaintMethod, upscaled: !!a.upscaleMethod, regenerateMarked: !!a.regenerateMarked
    })) }));
  function snapshot() {
    const copy = clone(toRaw(draft.value));
    for (const result of copy.manifest.resultImages) for (const a of result.sliceManifest.assets) {
      a.aiProcessing = false; a.aiProcessingLabel = ''; a.aiProgressLogs = []; a.selected = selectedIds.value.includes(a.id);
    }
    return copy;
  }
  function touch() { revision.value++; dirty.value = true; error.value = ''; }
  function checkpoint() { if (saving.value) throw new Error('正在保存，请稍候'); undoStack.value.push(snapshot()); if (undoStack.value.length > 40) undoStack.value.shift(); redoStack.value = []; }
  function select(id: string, additive = false, shift = false) {
    if (shift && draft.value.activeSliceId) {
      const ids = list.value.rows.map(a => a.id), a = ids.indexOf(draft.value.activeSliceId), b = ids.indexOf(id);
      selectedIds.value = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
    } else selectedIds.value = additive ? (selectedIds.value.includes(id) ? selectedIds.value.filter(x => x !== id) : [...selectedIds.value, id]) : [id];
    draft.value.activeSliceId = id;
    touch();
  }
  function reconcile() {
    normalizeCompositeSliceLayers(assets.value);
    for (const a of assets.value) {
      if (a.parentId && !isValidSliceParent(a, a.parentId, assets.value)) a.parentId = null;
      if (a.parentAssignment !== 'manual') a.parentId = inferSmallestContainingBackgroundId(a, assets.value);
    }
  }
  function mutate(change: () => void) { checkpoint(); change(); reconcile(); touch(); }
  function undo() { if (saving.value || !undoStack.value.length) return; redoStack.value.push(snapshot()); draft.value = undoStack.value.pop()!; selectedIds.value = assets.value.filter(a => a.selected).map(a => a.id); touch(); }
  function redo() { if (saving.value || !redoStack.value.length) return; undoStack.value.push(snapshot()); draft.value = redoStack.value.pop()!; selectedIds.value = assets.value.filter(a => a.selected).map(a => a.id); touch(); }
  async function save() {
    const generation = epoch.value;
    const operation = writeQueue.catch(() => {}).then(async () => {
      if (generation !== epoch.value || !image.value) return;
      const copy = snapshot(), version = revision.value, id = draftId.value;
      try { const result = await api('/api/workspace-draft', jsonRequest({ draft: copy, draftId: id }));
        if (generation === epoch.value) { draftId.value = result.draftId || id; if (revision.value === version) dirty.value = false; error.value = ''; }
      } catch (failure) { if (generation === epoch.value) error.value = String((failure as Error).message); throw failure; }
    });
    writeQueue = operation; return operation;
  }
  async function transaction(change: () => void) {
    await writeQueue.catch(() => {});
    const before = snapshot(), undo = clone(undoStack.value), redo = clone(redoStack.value), priorDirty = dirty.value, generation = epoch.value;
    checkpoint(); saving.value = true;
    try { change(); reconcile(); touch(); await save(); }
    catch (failure) { if (generation === epoch.value) { draft.value = before; undoStack.value = undo; redoStack.value = redo; dirty.value = priorDirty; } throw failure; }
    finally { saving.value = false; }
  }
  async function restore(value: WorkspaceDraft, id: string | null) {
    if (saving.value) throw new Error('正在保存，请稍候');
    epoch.value++; const generation = epoch.value; draft.value = { ...emptyDraft(), ...clone(value) }; draftId.value = id;
    for (const result of draft.value.manifest.resultImages) {
      result.sliceManifest ||= { assets: [] }; normalizeCompositeSliceLayers(result.sliceManifest.assets);
      for (const a of result.sliceManifest.assets) { a.aiProcessing = false; a.aiProcessingLabel = ''; await recoverLegacySliceTrimPosition(a, decodePixels); }
    }
    if (generation !== epoch.value) return;
    selectedIds.value = assets.value.filter(a => a.selected).map(a => a.id);
    if (!selectedIds.value.length && draft.value.activeSliceId && assets.value.some(a => a.id === draft.value.activeSliceId)) selectedIds.value = [draft.value.activeSliceId];
    undoStack.value = []; redoStack.value = []; dirty.value = false; error.value = '';
  }
  async function addImages(items: { dataUrl: string; name?: string }[]) {
    const generation = epoch.value;
    const added: ResultImage[] = [];
    for (const item of items) { const bitmap = await loadBitmap(item.dataUrl); added.push({ id: crypto.randomUUID(), name: item.name || '设计图', dataUrl: item.dataUrl, naturalWidth: bitmap.naturalWidth, naturalHeight: bitmap.naturalHeight, sliceManifest: { assets: [] } }); }
    if (generation !== epoch.value) return;
    mutate(() => { draft.value.manifest.resultImages.push(...added); activate(draft.value.manifest.resultImages.length - added.length); });
  }
  function activate(index: number) {
    if (saving.value) return;
    epoch.value++; draft.value.activeResultIndex = index; selectedIds.value = []; draft.value.activeSliceId = null;
    const img = image.value; if (img) draft.value.manifest.screen = { name: img.name || '设计图', width: img.naturalWidth || img.width!, height: img.naturalHeight || img.height! };
    touch();
  }
  async function createSlice(placement: Placement) {
    if (!image.value || saving.value || placement.width < 2 || placement.height < 2) return;
    const generation = epoch.value, url = await cropImage(image.value.dataUrl, placement, screen.value);
    if (generation !== epoch.value) return;
    const id = crypto.randomUUID(); mutate(() => { assets.value.push({ id, name: `slice_${String(assets.value.length + 1).padStart(2, '0')}`, contentType: 'image', dataUrl: url, originalDataUrl: url,
      placement, initialPlacement: { x: placement.x, y: placement.y }, selected: true }); }); select(id);
  }
  async function restorePosition() {
    const list = selected.value.filter(a => !a.aiProcessing && a.initialPlacement && (a.placement.x !== a.initialPlacement.x || a.placement.y !== a.initialPlacement.y)), generation = epoch.value;
    if (!list.length) return;
    const changes = await Promise.all(list.map(async a => { const copy = clone(a); restoreSliceInitialPosition(copy, (p: Placement) => p); if (shouldRefreshSliceCropAfterPositionRestore(copy)) copy.dataUrl = await cropImage(image.value!.dataUrl, copy.placement, screen.value); return copy; }));
    if (generation === epoch.value) mutate(() => { for (const a of changes) Object.assign(assets.value.find(x => x.id === a.id)!, a); });
  }
  function toggleMark() { const eligible = selected.value.filter(a => a.contentType === 'image' && !a.aiProcessing); const on = !eligible.every(a => a.regenerateMarked); if (eligible.length) mutate(() => eligible.forEach(a => { a.regenerateMarked = on; })); }
  function preserveProcessedVariant(source: SliceAsset) {
    if (source.isAiProcessedVariant) return;
    const operation = source.lastAiOperation || (source.aiRedrawn && source.svgData ? 'redrawSvg' : source.aiTransparent && source.aiTransparentDataUrl ? 'transparent' : '');
    const suffix = operation === 'transparent' && source.aiTransparentDataUrl ? 'ai_transparent' : operation === 'redrawSvg' && source.svgData ? 'ai_redraw_svg' : '';
    if (!suffix) return;
    const dataUrl = suffix === 'ai_transparent' ? source.aiTransparentDataUrl : source.dataUrl;
    const placement = (suffix === 'ai_transparent' ? source.aiTransparentPlacement : source.aiRedrawnPlacement) || source.placement;
    const name = reserveSliceAssetName(source.name.replace(new RegExp('(?:_' + suffix + ')+$'), '') + '_' + suffix, new Set(assets.value.map(a => a.name)));
    const variant: SliceAsset = { ...clone(source), id: crypto.randomUUID(), name, placement: { ...placement }, selected: false, aiCompleteSourceAssetId: null, isAiProcessedVariant: true, processedResetConfirmed: false, aiProcessing: false, aiProcessingLabel: '', originalDataUrl: dataUrl, dataUrl };
    delete variant.transparencyRestoreState; delete variant.transparencyRestoreDataUrl; delete variant.svgRestoreState;
    assets.value.splice(Math.max(0, assets.value.indexOf(source)), 0, variant);
  }
  // Called inside a checkpointed edit: preserve completed AI results and move an original copy.
  function editableMovementTarget(source: SliceAsset): SliceAsset {
    if (!isLockedAiCompleteAsset(source)) return source;
    let copy = assets.value.find(a => a.aiCompleteSourceAssetId === source.id);
    if (!copy) {
      const name = reserveSliceAssetName(source.name.replace(/_(?:ai_original|local_composite|AI原图|AI完整图|局部合成)$/, '') + '_original_copy', new Set(assets.value.map(a => a.name)));
      copy = createAiCompleteEditableCopy({ sourceAsset: source, id: crypto.randomUUID(), name }) as SliceAsset;
      replaceSliceCrop(copy, copy.dataUrl);
      assets.value.splice(assets.value.indexOf(source) + 1, 0, copy);
    }
    selectedIds.value = selectedIds.value.map(id => id === source.id ? copy!.id : id);
    if (draft.value.activeSliceId === source.id) draft.value.activeSliceId = copy.id;
    return copy;
  }
  async function nudge(dx: number, dy: number, repeat = false) {
    let a = active.value; if (!a || a.aiProcessing || saving.value) return;
    const generation = epoch.value;
    if (isLockedAiCompleteAsset(a)) { if (!repeat) checkpoint(); a = editableMovementTarget(a); repeat = true; }
    const placement = { ...a.placement, x: Math.max(0, Math.min(screen.value.width - a.placement.width, a.placement.x + dx)), y: Math.max(0, Math.min(screen.value.height - a.placement.height, a.placement.y + dy)) };
    if (placement.x === a.placement.x && placement.y === a.placement.y) return;
    if (!repeat) checkpoint(); a.placement = placement; reconcile(); touch();
    const signature = assetEditSignature(a);
    if (!hasProcessedSliceResult(a)) {
      const dataUrl = await cropImage(image.value!.dataUrl, placement, screen.value);
      const current = assets.value.find(item => item.id === a.id);
      if (generation === epoch.value && current && assetEditSignature(current) === signature) { replaceSliceCrop(current, dataUrl); touch(); }
    }
  }
  function remove(ids = selectedIds.value) { mutate(() => { image.value!.sliceManifest.assets = assets.value.filter(a => !ids.includes(a.id)); selectedIds.value = selectedIds.value.filter(id => !ids.includes(id)); }); }
  return { draft, draftId, selectedIds, undoStack, redoStack, epoch, dirty, saving, error, revision, image, assets, active, selected, screen, markedCount, list,
    snapshot, touch, checkpoint, select, reconcile, mutate, undo, redo, save, transaction, restore, addImages, activate, createSlice, restorePosition, toggleMark, preserveProcessedVariant, editableMovementTarget, nudge, remove };
});
