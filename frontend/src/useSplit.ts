import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { ElMessageBox } from 'element-plus';
import { useEditor, clone } from './store';
import { api } from './api';
import { normalizeRect } from './geometry';
import { defaultTextStyle } from './text';
import type { Candidate, Rect, Job, Document } from './types';

/** 管理一次框选会话；候选是临时草稿，仅 apply 成功才改变项目。 */
export function useSplit() {
  const store = useEditor(),
    active = ref(false),
    region = ref<Rect | null>(null),
    candidates = ref<Candidate[]>([]),
    job = ref<Job | null>(null),
    message = ref(''),
    busy = ref(false),
    applying = ref(false),
    model = ref('未配置'),
    sourceId = ref('');
  // serial 是本地会话令牌。取消 HTTP 不保证远端立即停止，所以每次 await 后也检查它。
  let serial = 0,
    timer: ReturnType<typeof setTimeout> | undefined,
    signature = '',
    operationId = '',
    applyBefore: Document | null = null;
  const source = computed(() => {
      const layer = store.layers.find((l) => l.id === sourceId.value);
      return layer?.type === 'image' ? layer : undefined;
    }),
    asset = computed(() => (source.value ? store.assets[source.value.assetId] : undefined));
  const valid = computed(() => !!source.value && !source.value.hidden && !source.value.locked),
    ready = computed(() => job.value?.status === 'ready');
  /** 应用期间禁止中途退出；force 仅供成功提交后的内部清理使用。 */
  async function cancel(force = false) {
    if (applying.value && !force) return;
    serial++;
    clearTimeout(timer);
    const id = job.value?.id;
    job.value = null;
    busy.value = false;
    if (id) void api.cancel(id).catch(() => {});
  }
  async function close(force = false) {
    if (applying.value && !force) return;
    await cancel(force);
    active.value = false;
    region.value = null;
    candidates.value = [];
    sourceId.value = '';
    message.value = '';
  }
  async function enter() {
    const l = store.single;
    if (!l || l.hidden || l.locked || store.exclusive || applying.value) return;
    await close();
    sourceId.value = l.id;
    signature = JSON.stringify(l);
    active.value = true;
    const token = serial;
    try {
      const value = (await api.config()).config?.model || '未配置';
      if (token === serial) model.value = value;
    } catch (e) {
      if (token === serial) message.value = (e as Error).message;
    }
  }
  function whole() {
    if (asset.value)
      void setRegion({ x: 0, y: 0, width: asset.value.width, height: asset.value.height });
  }
  async function setRegion(r: Rect) {
    if (!asset.value || busy.value || applying.value) return;
    await cancel();
    candidates.value = [];
    try {
      region.value = normalizeRect(r, asset.value.width, asset.value.height);
      message.value = '';
    } catch (e) {
      message.value = (e as Error).message;
    }
  }
  async function start(manual = false) {
    if (!valid.value || !region.value || busy.value || applying.value) return;
    if (!manual) {
      try {
        await ElMessageBox.confirm(
          `将所选 ${region.value.width} × ${region.value.height} px 范围发送到图片理解模型「${model.value}」。远程服务可能计费，不会自动重试。`,
          '确认 AI 框选拆图',
          { confirmButtonText: '发送并分析', cancelButtonText: '取消' },
        );
      } catch {
        return;
      }
    }
    await cancel();
    const token = serial;
    busy.value = true;
    message.value = '正在提交…';
    candidates.value = [];
    operationId = crypto.randomUUID();
    applyBefore = null;
    try {
      await store.flush();
      if (token !== serial) return;
      const result = await api.split({
        projectId: store.project!.id,
        sceneId: store.scene!.id,
        layerId: sourceId.value,
        region: region.value,
        manual,
      });
      if (token !== serial) {
        void api.cancel(result.id);
        return;
      }
      job.value = {
        ...result,
        status: result.status as Job['status'],
        message: '',
        region: region.value,
        candidates: [],
      };
      // 轮询固定任务，不重发分析请求；模型失败不会产生隐式计费重试。
      const poll = async () => {
        try {
          const result = await api.job(job.value!.id);
          if (token !== serial) return;
          job.value = result;
          message.value = result.message;
          if (result.status === 'running') timer = setTimeout(() => void poll(), 700);
          else {
            busy.value = false;
            candidates.value = clone(result.candidates);
            if (manual) add();
          }
        } catch (e) {
          if (token === serial) {
            busy.value = false;
            message.value = (e as Error).message;
          }
        }
      };
      await poll();
    } catch (e) {
      if (token === serial) {
        message.value = (e as Error).message;
        busy.value = false;
      }
    }
  }
  function add() {
    if (!region.value || candidates.value.length >= 200 || !ready.value || applying.value) return;
    const r = region.value;
    candidates.value.push({
      id: crypto.randomUUID(),
      name: `切图 ${candidates.value.length + 1}`,
      category: 'image',
      enabled: true,
      x: r.x,
      y: r.y,
      width: Math.max(1, Math.floor(r.width / 2)),
      height: Math.max(1, Math.floor(r.height / 2)),
    });
  }
  function edit(id: string, patch: Partial<Candidate>) {
    if (applying.value || !region.value) return;
    const c = candidates.value.find((c) => c.id === id);
    if (!c) return;
    const r = region.value,
      next = { ...c, ...patch };
    if (next.category === 'text' && !next.text)
      next.text = defaultTextStyle(next.name === '切图' ? '' : next.name);
    if (next.category !== 'text') delete next.text;
    next.x = Math.max(r.x, Math.min(r.x + r.width - 1, next.x));
    next.y = Math.max(r.y, Math.min(r.y + r.height - 1, next.y));
    next.width = Math.max(1, Math.min(next.width, r.x + r.width - next.x));
    next.height = Math.max(1, Math.min(next.height, r.y + r.height - next.y));
    Object.assign(c, next, normalizeRect(next, asset.value!.width, asset.value!.height));
    // 内容修改后使用新的幂等键；原样重试 apply 则保留同一键。
    operationId = crypto.randomUUID();
  }
  async function apply() {
    if (!ready.value || !valid.value || applying.value || !candidates.value.some((c) => c.enabled))
      return;
    if (
      candidates.value.some(
        (candidate) =>
          candidate.enabled && candidate.category === 'text' && !candidate.text?.content.trim(),
      )
    ) {
      message.value = '文字候选必须填写文字内容。';
      return;
    }
    applying.value = true;
    store.exclusive = true;
    const token = serial;
    try {
      await store.flush();
      // 首次提交前保留快照，网络失败重试也不能覆盖它，否则撤销会丢失生成前状态。
      applyBefore ||= store.doc();
      const p = await api.apply(
        job.value!.id,
        store.project!.revision,
        operationId,
        candidates.value,
      );
      if (token !== serial) return;
      await store.accept(p, applyBefore);
      const previousScene = applyBefore.scenes.find((scene) => scene.id === p.activeSceneId)!;
      const previousIds = new Set(previousScene.layers.map((layer) => layer.id));
      const updatedScene = p.scenes.find((scene) => scene.id === p.activeSceneId)!;
      store.selected = updatedScene.layers
        .filter((layer) => !previousIds.has(layer.id))
        .map((layer) => layer.id);
      await close(true);
    } catch (e) {
      message.value = (e as Error).message;
    } finally {
      applying.value = false;
      store.exclusive = false;
    }
  }
  watch(
    () => [store.epoch, store.project?.activeSceneId],
    () => void close(),
  );
  watch(
    () => JSON.stringify(source.value),
    (value) => {
      if (active.value && value !== signature) {
        void cancel();
        candidates.value = [];
        message.value = '来源图片已修改或删除，请重新进入框选。';
        active.value = false;
      }
    },
  );
  onBeforeUnmount(() => {
    void cancel();
  });
  return {
    active,
    region,
    candidates,
    job,
    message,
    busy,
    applying,
    model,
    source,
    asset,
    valid,
    ready,
    enter,
    close,
    whole,
    setRegion,
    start,
    cancel,
    add,
    edit,
    apply,
  };
}
export type SplitController = ReturnType<typeof useSplit>;
