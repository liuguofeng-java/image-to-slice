import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from './api';
import { useEditor } from './store';
import type { Document, LayerRegenerationJob } from './types';

/** 单图重生成是服务端事务：生成完成前不修改本地项目，成功后只接收一次快照。 */
export function useLayerRegeneration() {
  const store = useEditor(),
    job = ref<LayerRegenerationJob | null>(null),
    message = ref(''),
    busy = ref(false),
    imageModel = ref('未配置');
  let serial = 0,
    timer: ReturnType<typeof setTimeout> | undefined,
    releaseTimer: (() => void) | undefined,
    before: Document | null = null,
    selectedLayerId = '';

  const layer = computed(() => store.single),
    image = computed(() => (layer.value?.type === 'image' ? layer.value : undefined)),
    asset = computed(() => (image.value ? store.assets[image.value.assetId] : undefined)),
    eligible = computed(
      () => !!image.value && !image.value.hidden && !image.value.locked && !store.exclusive,
    ),
    localEligible = computed(() => eligible.value && !!image.value?.source),
    failed = computed(() => job.value?.status === 'failed'),
    progress = computed(() => job.value?.generation.completed || 0);

  async function loadModel() {
    const token = ++serial;
    try {
      const config = (await api.config()).config;
      if (token === serial) imageModel.value = config?.imageModel || '未配置';
    } catch (error) {
      if (token === serial) message.value = (error as Error).message;
    }
  }

  function refreshModel() {
    if (!busy.value) void loadModel();
  }

  async function pause(milliseconds: number) {
    await new Promise<void>((resolve) => {
      releaseTimer = resolve;
      timer = setTimeout(() => {
        releaseTimer = undefined;
        resolve();
      }, milliseconds);
    });
  }

  async function poll(token: number) {
    while (token === serial && job.value) {
      const current = await api.layerRegenerationJob(job.value.id);
      if (token !== serial) return;
      job.value = current;
      message.value = current.message;
      if (current.status !== 'generating') break;
      await pause(700);
    }
    if (token !== serial || job.value?.status !== 'applied') return;
    const project = await api.open(store.project!.id);
    if (token !== serial || !before) return;
    await store.accept(project, before);
    store.selected = [selectedLayerId];
    message.value = '图片已重新生成';
    before = null;
    busy.value = false;
    store.exclusive = false;
  }

  async function start() {
    if (!eligible.value || busy.value || imageModel.value === '未配置') return;
    const targetLayerId = image.value!.id;
    try {
      await ElMessageBox.confirm(
        `将调用远程图片生成模型「${imageModel.value}」1 次。叶子图片会完整重绘；含子节点的图片只补全子节点区域并保留其余原像素。可能产生费用且不会自动重试。`,
        '确认单图 AI 重生成',
        {
          confirmButtonText: '开始 1 次生成',
          cancelButtonText: '取消',
        },
      );
    } catch {
      return;
    }
    const token = ++serial;
    busy.value = true;
    message.value = '正在提交…';
    job.value = null;
    try {
      await store.flush();
      if (token !== serial) return;
      const target = store.layers.find((item) => item.id === targetLayerId);
      if (
        store.single?.id !== targetLayerId ||
        !target ||
        target.type !== 'image' ||
        target.hidden ||
        target.locked
      )
        throw new Error('所选图片已改变，请重新发起生成。');
      store.exclusive = true;
      before = store.doc();
      selectedLayerId = targetLayerId;
      const result = await api.regenerateLayer({
        projectId: store.project!.id,
        sceneId: store.scene!.id,
        layerId: selectedLayerId,
        revision: store.project!.revision,
        operationId: crypto.randomUUID(),
      });
      if (token !== serial) {
        void api.cancelLayerRegeneration(result.id);
        return;
      }
      job.value = {
        ...result,
        message: '正在重新生成 0 / 1',
        generation: { completed: 0, total: 1, failed: 0, targets: [] },
      };
      await poll(token);
    } catch (error) {
      if (token === serial) message.value = (error as Error).message;
    } finally {
      if (token === serial && job.value?.status !== 'generating') {
        busy.value = false;
        store.exclusive = false;
      }
    }
  }

  async function retry() {
    if (!job.value || job.value.status !== 'failed' || busy.value) return;
    const calls = job.value.generation.failed;
    try {
      await ElMessageBox.confirm(
        calls
          ? `将重试 1 次远程图片生成，模型为「${imageModel.value}」。可能产生费用且不会自动重试。`
          : '图片已生成，本次只重试项目提交，不会再次调用远程模型。',
        '确认重试',
        {
          confirmButtonText: calls ? '重试生成' : '重试提交',
          cancelButtonText: '取消',
        },
      );
    } catch {
      return;
    }
    const token = ++serial;
    busy.value = true;
    store.exclusive = true;
    try {
      await api.retryLayerRegeneration(job.value.id);
      job.value.status = 'generating';
      message.value = calls ? '正在重新生成 0 / 1' : '正在重新提交项目';
      await poll(token);
    } catch (error) {
      if (token === serial) message.value = (error as Error).message;
    } finally {
      if (token === serial && job.value?.status !== 'generating') {
        busy.value = false;
        store.exclusive = false;
      }
    }
  }

  async function startLocal() {
    if (!localEligible.value || busy.value) return;
    const targetLayerId = image.value!.id,
      token = ++serial;
    busy.value = true;
    message.value = '正在按调整后的框重新裁切…';
    try {
      await store.flush();
      if (token !== serial) return;
      const target = store.layers.find((item) => item.id === targetLayerId);
      if (
        store.single?.id !== targetLayerId ||
        !target ||
        target.type !== 'image' ||
        target.hidden ||
        target.locked ||
        !target.source
      )
        throw new Error('所选图片已改变，无法按新框重新裁切。');
      store.exclusive = true;
      before = store.doc();
      selectedLayerId = targetLayerId;
      const project = await api.localRegenerateLayer({
        projectId: store.project!.id,
        sceneId: store.scene!.id,
        layerId: targetLayerId,
        revision: store.project!.revision,
        operationId: crypto.randomUUID(),
      });
      if (token !== serial) return;
      await store.accept(project, before);
      store.selected = [selectedLayerId];
      message.value = '已按新框重新生成图片';
      ElMessage.success(message.value);
      before = null;
    } catch (error) {
      if (token === serial) {
        message.value = (error as Error).message;
        ElMessage.error(`重新生成失败：${message.value}`);
      }
    } finally {
      if (token === serial) {
        busy.value = false;
        store.exclusive = false;
        before = null;
      }
    }
  }

  async function cancel() {
    if (!busy.value || (job.value && job.value.status !== 'generating')) return;
    serial++;
    clearTimeout(timer);
    releaseTimer?.();
    releaseTimer = undefined;
    try {
      if (job.value) {
        const result = await api.cancelLayerRegeneration(job.value.id);
        job.value.status = result.status;
        if (result.status === 'applied' && before) {
          await store.accept(await api.open(store.project!.id), before);
          store.selected = [selectedLayerId];
          message.value = '取消时图片已经完成，已应用生成结果。';
        } else message.value = '已取消；项目未发生变化。';
      } else message.value = '已取消；未发送图片生成请求。';
    } catch (error) {
      message.value = (error as Error).message;
    } finally {
      busy.value = false;
      store.exclusive = false;
      before = null;
    }
  }

  watch(
    () => [store.epoch, store.project?.activeSceneId, store.selected.join(',')],
    () => {
      if (!busy.value) {
        job.value = null;
        message.value = '';
        before = null;
        void loadModel();
      }
    },
    // 同步观察可确保 accept() 替换项目时仍处于 busy，避免队列尾部误清除成功状态。
    { immediate: true, flush: 'sync' },
  );
  onBeforeUnmount(() => {
    clearTimeout(timer);
    releaseTimer?.();
    if (job.value?.status === 'generating') void api.cancelLayerRegeneration(job.value.id);
  });
  return {
    job,
    message,
    busy,
    imageModel,
    image,
    asset,
    eligible,
    localEligible,
    failed,
    progress,
    start,
    startLocal,
    retry,
    cancel,
    refreshModel,
  };
}

export type LayerRegenerationController = ReturnType<typeof useLayerRegeneration>;
