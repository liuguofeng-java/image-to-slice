import { createApp, defineComponent, h, nextTick, shallowRef } from 'vue';
import { createPinia, disposePinia } from 'pinia';
import SliceAssetList from '../components/SliceAssetList.vue';
import { useSliceListStore } from '../stores/slice-list';
import type { SliceListEvent, SliceListSnapshot } from '../types/slice-list';
import type { CutoutEditorBackend, CutoutEditorSnapshot, ImageEditorSaveResult, LocalImageTaskState } from '../types/cutout-editor';
import SliceCutoutEditor from '../components/SliceCutoutEditor.vue';
import SliceRegenerationReview from '../components/SliceRegenerationReview.vue';
import type { RegenerationSnapshot, RegenerationAction } from '../types/regeneration';
export { createAiTaskRegistry } from '../stores/ai-tasks';

export function mountRegenerationReview(host: HTMLElement, initial: RegenerationSnapshot, onAction: (event: RegenerationAction) => void) {
  const snapshot = shallowRef(initial);
  const app = createApp(defineComponent({ setup: () => () => h(SliceRegenerationReview, { snapshot: snapshot.value, onAction }) }));
  app.mount(host);
  return { update(value: RegenerationSnapshot) { snapshot.value = value; }, dispose() { app.unmount(); } };
}

// Temporary explicit boundary, not a Vue wrapper around legacy app.js.
// The list has one renderer and one set of handlers, owned entirely by Vue.
export function mountSliceList(host: HTMLElement, onAction: (event: SliceListEvent) => void) {
  const pinia = createPinia();
  const store = useSliceListStore(pinia);
  const app = createApp(defineComponent({
    setup: () => () => h(SliceAssetList, { snapshot: store.snapshot, onAction })
  }));
  app.use(pinia);
  app.mount(host);
  let disposed = false;
  let revision = 0;
  return {
    update(snapshot: SliceListSnapshot) {
      if (disposed) return;
      const current = ++revision;
      const scroll = store.snapshot.imageId === snapshot.imageId ? host.scrollTop : 0;
      store.replace(snapshot);
      void nextTick(() => { if (!disposed && current === revision) host.scrollTop = scroll; });
    },
    updateProgress(id: string, label: string) { if (!disposed) store.updateProgress(id, label); },
    dispose() { if (!disposed) { disposed = true; app.unmount(); disposePinia(pinia); } }
  };
}

type BackendRequest = (path: string, init?: RequestInit) => Promise<Response>;

async function readResponse(request: BackendRequest, path: string, init?: RequestInit) {
  const response = await request(path, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `本地请求失败：${response.status}`);
  return payload;
}

export function mountCutoutEditor(
  host: HTMLElement,
  options: {
    request: BackendRequest;
    commit: (result: ImageEditorSaveResult) => Promise<void>;
    onClose?: () => void;
    onTaskState?: (state: LocalImageTaskState) => void;
  }
) {
  const editor = shallowRef<any>();
  function emitTaskState(state: LocalImageTaskState) {
    try {
      options.onTaskState?.(state);
    } catch (failure) {
      console.error('本地图像任务状态同步失败', failure);
    }
  }
  async function runLocalTask(operation: 'inpaint' | 'upscale', path: string, payload: Record<string, any>) {
    const state = {
      assetId: String(payload.assetId || ''),
      progressId: String(payload.progressId || ''),
      operation,
      sourceDataUrl: String(payload.dataUrl || ''),
      ...(operation === 'inpaint' ? { maskDataUrl: String(payload.maskDataUrl || '') } : {})
    };
    emitTaskState({ ...state, status: 'running' });
    try {
      const result = await readResponse(options.request, path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      emitTaskState({ ...state, status: 'completed', result });
      return result;
    } catch (failure: any) {
      emitTaskState({ ...state, status: 'failed', error: failure.message || String(failure) });
      throw failure;
    }
  }
  const backend: CutoutEditorBackend = {
    health: () => readResponse(options.request, '/api/local-segmentation/health'),
    localHealth: () => readResponse(options.request, '/api/local-image-processing/health'),
    createSession: payload => readResponse(options.request, '/api/local-segmentation/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    }),
    predict: payload => readResponse(options.request, '/api/local-segmentation/predict', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    }),
    closeSession: async sessionId => {
      await readResponse(options.request, `/api/local-segmentation/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    },
    inpaint: payload => runLocalTask('inpaint', '/api/local-image-processing/inpaint', payload),
    upscale: payload => runLocalTask('upscale', '/api/local-image-processing/upscale', payload),
    cancel: async progressId => {
      await readResponse(options.request, `/api/progress/${encodeURIComponent(progressId)}/cancel`, { method: 'POST' });
    }
  };
  const app = createApp(defineComponent({
    setup: () => () => h(SliceCutoutEditor, {
      ref: editor,
      backend,
      commit: options.commit,
      onClose: options.onClose
    })
  }));
  app.mount(host);
  let disposed = false;
  return {
    open(snapshot: CutoutEditorSnapshot) { if (!disposed) return editor.value?.open(snapshot); },
    close() { if (!disposed) editor.value?.close(); },
    dispose() { if (!disposed) { disposed = true; app.unmount(); } }
  };
}
