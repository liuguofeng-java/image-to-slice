import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { emptyDraft, useWorkspaceStore } from '../../src/ui/stores/workspace';
import { applySliceTrimResult } from '../../src/ui/state/slice-ai-state.js';
describe('independent workspace store', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, draftId: 'd' }), { status: 200 }))); });
  afterEach(() => vi.unstubAllGlobals());
  async function setup() {
    const store = useWorkspaceStore(), draft = emptyDraft();
    draft.manifest.resultImages = [{ id: 'image', dataUrl: 'source', naturalWidth: 400, naturalHeight: 300, sliceManifest: { assets: [{ id: 'a', name: 'subject', dataUrl: 'source', contentType: 'image', placement: { x: -.5, y: 20.25, width: 100, height: 50 }, regenerateMarked: true, outputPixelWidth: 400, outputPixelHeight: 200, selected: true }] } }];
    draft.activeSliceId = 'a'; draft.legacyFigmaIgnored = { id: 1 }; await store.restore(draft, 'd'); return store;
  }
  it('keeps old metadata and geometry; type changes clear marks and undo restores', async () => {
    const store = await setup(); store.mutate(() => { store.active!.contentType = 'text'; }); expect(store.active!.regenerateMarked).toBeUndefined(); store.undo(); expect(store.active!.regenerateMarked).toBe(true);
    await store.save(); const payload = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string).draft;
    expect(payload.legacyFigmaIgnored).toEqual({ id: 1 }); expect(payload.manifest.resultImages[0].sliceManifest.assets[0].placement.x).toBe(-.5); expect(payload.manifest.resultImages[0].sliceManifest.assets[0].outputPixelWidth).toBe(400);
  });
  it('rolls back pixels, geometry and undo/redo on save failure; retry succeeds', async () => {
    const store = await setup(), before = store.snapshot(); vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: '保存失败' }), { status: 500 }));
    const change = () => { const value = JSON.parse(JSON.stringify(store.active)); applySliceTrimResult(value, { dataUrl: 'cropped', sourcePixelWidth: 400, sourcePixelHeight: 200, left: -10, top: 20, outputPixelWidth: 100, outputPixelHeight: 80 }); Object.assign(store.active!, value); };
    await expect(store.transaction(change)).rejects.toThrow('保存失败'); expect(store.snapshot()).toEqual(before); expect(store.undoStack).toHaveLength(0); expect(store.saving).toBe(false);
    await store.transaction(change); expect(store.active!.placement).toEqual({ x: -3, y: 25.25, width: 25, height: 20 }); store.undo(); expect(store.active!.dataUrl).toBe('source'); store.redo(); expect(store.active!.dataUrl).toBe('cropped');
  });
  it('infers direct parents and preserves hidden image marks', async () => {
    const store = await setup(); store.mutate(() => { store.assets.push({ id: 'child', name: 'child', dataUrl: 'child', contentType: 'image', placement: { x: 5, y: 25, width: 10, height: 10 } }); store.active!.hidden = true; });
    expect(store.assets[1]!.parentId).toBe('a'); expect(store.markedCount).toBe(1); expect(store.list.rows[1]!.depth).toBe(1);
  });
  it('keeps an independent processed variant before recropping, and undo removes the extra copy', async () => {
    const store = await setup(); Object.assign(store.active!, { aiTransparent: true, aiTransparentDataUrl: 'transparent-hd', aiTransparentPlacement: { ...store.active!.placement }, lastAiOperation: 'transparent' });
    const before = structuredClone(JSON.parse(JSON.stringify(store.active)));
    await store.transaction(() => store.preserveProcessedVariant(store.active!));
    const variant = store.assets.find(a => a.isAiProcessedVariant)!;
    expect(variant.dataUrl).toBe('transparent-hd'); expect(variant.outputPixelWidth).toBe(400); expect(variant.placement).toEqual(before.placement); expect(variant.id).not.toBe(before.id);
    store.undo(); expect(store.assets).toHaveLength(1); expect(store.active!.dataUrl).toBe('source');
  });
});
