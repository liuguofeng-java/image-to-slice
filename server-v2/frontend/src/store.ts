import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from './api';
import { bounds } from './geometry';
import type { Project, Document, Asset, Layer } from './types';
/** 仅克隆可持久化 DTO；不得传入 DOM、图片实例、控制器或日期对象。 */
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** 编辑状态单一入口：图像修改必须经 mutate，视图状态由画布组件自行管理。 */
export const useEditor = defineStore('editor', () => {
  const project = ref<Project | null>(null),
    assets = ref<Record<string, Asset>>({}),
    selected = ref<string[]>([]),
    undoStack = ref<Document[]>([]),
    redoStack = ref<Document[]>([]),
    dirty = ref(false),
    saving = ref(false),
    error = ref(''),
    epoch = ref(0),
    generation = ref(0),
    exclusive = ref(false);
  const scene = computed(() =>
      project.value?.scenes.find((s) => s.id === project.value?.activeSceneId),
    ),
    layers = computed(() => scene.value?.layers || []),
    selection = computed(() => layers.value.filter((l) => selected.value.includes(l.id))),
    single = computed(() => (selection.value.length === 1 ? selection.value[0] : undefined));
  // 项目版本号不进入撤销快照：撤销内容后仍须基于最新服务端 revision 保存。
  const doc = (): Document => {
    const p = project.value!;
    return clone({ name: p.name, activeSceneId: p.activeSceneId, scenes: p.scenes });
  };
  let timer: ReturnType<typeof setTimeout> | undefined,
    flight: Promise<void> | null = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void save().catch(() => {});
    }, 600);
  }
  function touch() {
    generation.value++;
    dirty.value = true;
    error.value = '';
    schedule();
  }
  /** 同步事务：校验失败恢复内容；成功且确实有变化才记录一个撤销步骤。 */
  function mutate(fn: () => void) {
    if (!project.value || exclusive.value) return;
    const before = doc();
    try {
      fn();
      for (const s of project.value.scenes) {
        if (s.width * s.height > 32e6) throw new Error('场景面积不能超过 3200 万像素');
        for (const l of s.layers)
          if (l.width > 16384 || l.height > 16384 || l.width * l.height > 32e6)
            throw new Error('图层尺寸超过限制');
      }
    } catch (e) {
      Object.assign(project.value, before);
      throw e;
    }
    if (JSON.stringify(before) === JSON.stringify(doc())) return;
    undoStack.value.push(before);
    if (undoStack.value.length > 100) undoStack.value.shift();
    redoStack.value = [];
    touch();
  }
  /** 串行保存，避免自动保存与 Ctrl+S 竞争同一个服务端版本号。 */
  async function save() {
    clearTimeout(timer);
    if (flight) await flight;
    if (!project.value || !dirty.value) return;
    const currentProject = project.value;
    const projectEpoch = epoch.value;
    const editGeneration = generation.value;
    const body = doc();
    saving.value = true;
    const current = (async () => {
      try {
        const result = await api.save(currentProject.id, currentProject.revision, body);
        // epoch 隔离不同项目；generation 区分请求发出后是否又发生了编辑。
        if (epoch.value !== projectEpoch) return;
        currentProject.revision = result.revision;
        currentProject.updatedAt = result.updatedAt;
        dirty.value = generation.value !== editGeneration;
        error.value = '';
        if (dirty.value) schedule();
      } catch (err) {
        if (epoch.value === projectEpoch) {
          error.value = (err as Error).message;
          dirty.value = true;
        }
        throw err;
      } finally {
        if (epoch.value === projectEpoch) saving.value = false;
      }
    })();
    flight = current;
    try {
      await current;
    } finally {
      if (flight === current) flight = null;
    }
  }
  /** 提交任务、导出或切换项目之前，把已有编辑保存到同一份服务端快照。 */
  async function flush() {
    do {
      await save();
    } while (dirty.value);
  }
  async function loadAssets(p: Project) {
    const list = [...new Set(p.scenes.flatMap((s) => s.layers.map((l) => l.assetId)))];
    const metas = await Promise.all(list.map((id) => api.asset(id)));
    for (const a of metas) assets.value[a.id] = a;
  }
  async function open(p: Project) {
    await loadAssets(p);
    clearTimeout(timer);
    epoch.value++;
    project.value = p;
    selected.value = [];
    undoStack.value = [];
    redoStack.value = [];
    dirty.value = false;
    error.value = '';
    localStorage.setItem('slice-studio-project', p.id);
  }
  /** 接收已落盘的整批裁切结果。资源加载成功后才更新内存和撤销栈。 */
  async function accept(p: Project, before: Document) {
    await loadAssets(p);
    project.value = p;
    undoStack.value.push(before);
    redoStack.value = [];
    dirty.value = false;
    generation.value++;
  }
  function select(id: string, add = false) {
    selected.value = add
      ? selected.value.includes(id)
        ? selected.value.filter((i) => i !== id)
        : [...selected.value, id]
      : [id];
  }
  function patch(id: string, values: Partial<Layer>) {
    mutate(() => {
      const l = layers.value.find((l) => l.id === id);
      if (l && !l.locked) Object.assign(l, values);
    });
  }
  function undo(back = true) {
    if (exclusive.value || !project.value) return;
    const from = back ? undoStack : redoStack,
      to = back ? redoStack : undoStack;
    if (!from.value.length) return;
    to.value.push(doc());
    Object.assign(project.value, from.value.pop());
    selected.value = selected.value.filter((id) => layers.value.some((l) => l.id === id));
    touch();
  }
  function remove() {
    mutate(() => {
      scene.value!.layers = layers.value.filter((l) => !selected.value.includes(l.id) || l.locked);
      selected.value = [];
    });
  }
  function duplicate() {
    mutate(() => {
      const copies = selection.value
        .filter((l) => !l.locked)
        .map((l) => ({
          ...clone(l),
          id: crypto.randomUUID(),
          name: l.name + ' 副本',
          x: l.x + 20,
          y: l.y + 20,
        }));
      layers.value.push(...copies);
      selected.value = copies.map((l) => l.id);
    });
  }
  // 对齐旋转后的可见包围框，不是旋转前的 width/height，避免视觉错位。
  function align(kind: string) {
    const ls = selection.value.filter((l) => !l.locked);
    if (ls.length < 2) return;
    mutate(() => {
      const boxes = ls.map((l) => ({ l, b: bounds(l) })),
        left = Math.min(...boxes.map((x) => x.b.x)),
        top = Math.min(...boxes.map((x) => x.b.y)),
        right = Math.max(...boxes.map((x) => x.b.x + x.b.width)),
        bottom = Math.max(...boxes.map((x) => x.b.y + x.b.height));
      if (kind === 'spaceX' || kind === 'spaceY') {
        if (ls.length < 3) return;
        const axis = kind === 'spaceX' ? 'x' : 'y',
          size = axis === 'x' ? 'width' : 'height',
          sorted = boxes.sort((a, b) => a.b[axis] - b.b[axis]);
        let pos = sorted[0].b[axis];
        const last = sorted.at(-1)!,
          gap =
            (last.b[axis] + last.b[size] - pos - sorted.reduce((n, x) => n + x.b[size], 0)) /
            (ls.length - 1);
        for (const x of sorted) {
          x.l[axis] += pos - x.b[axis];
          pos += x.b[size] + gap;
        }
      } else
        for (const { l, b } of boxes) {
          if (kind === 'left') l.x += left - b.x;
          if (kind === 'centerX') l.x += (left + right - b.width) / 2 - b.x;
          if (kind === 'right') l.x += right - b.x - b.width;
          if (kind === 'top') l.y += top - b.y;
          if (kind === 'centerY') l.y += (top + bottom - b.height) / 2 - b.y;
          if (kind === 'bottom') l.y += bottom - b.y - b.height;
        }
    });
  }
  /** 先上传全部不可变资源，再一次加入图层；上传中断不会留下半批图层。 */
  async function importFiles(files: File[]) {
    if (exclusive.value) return;
    exclusive.value = true;
    const e = epoch.value;
    try {
      const list: Asset[] = [];
      for (const f of files) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type))
          throw new Error('仅支持 PNG、JPEG、WebP');
        list.push(await api.upload(f));
      }
      if (e !== epoch.value) return;
      exclusive.value = false;
      mutate(() => {
        const fresh = layers.value.length === 0;
        for (const [aIndex, a] of list.entries()) {
          assets.value[a.id] = a;
          const l: Layer = {
            id: crypto.randomUUID(),
            assetId: a.id,
            name: a.name.replace(/\.[^.]+$/, ''),
            x: aIndex * 24,
            y: aIndex * 24,
            width: a.width,
            height: a.height,
            rotation: 0,
            flipX: false,
            flipY: false,
            opacity: 1,
            radius: 0,
            hidden: false,
            locked: false,
          };
          layers.value.push(l);
          selected.value = [l.id];
        }
        if (fresh && list[0]) {
          scene.value!.width = list[0].width;
          scene.value!.height = list[0].height;
        }
      });
    } finally {
      exclusive.value = false;
    }
  }
  return {
    project,
    assets,
    selected,
    undoStack,
    redoStack,
    dirty,
    saving,
    error,
    epoch,
    generation,
    exclusive,
    scene,
    layers,
    selection,
    single,
    doc,
    mutate,
    touch,
    save,
    flush,
    open,
    accept,
    select,
    patch,
    undo,
    remove,
    duplicate,
    align,
    importFiles,
  };
});
