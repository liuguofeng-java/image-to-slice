<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  Plus,
  Search,
  Picture,
  Document as TextIcon,
  ArrowRight,
  ArrowDown,
  Expand,
  Fold,
  View,
  Hide,
  Lock,
  Unlock,
  Delete,
  EditPen,
} from '@element-plus/icons-vue';
import { ElMessageBox } from 'element-plus';
import { useEditor } from '../store';
import { buildLayerTree, type LayerTreeNode } from '../layerTree';
import IconButton from './IconButton.vue';
const store = useEditor(),
  search = ref(''),
  dragged = ref(''),
  focused = ref(''),
  collapsedByScene = ref<Record<string, string[]>>({});
const emit = defineEmits<{ focus: [id: string] }>();

interface TreeRow {
  node: LayerTreeNode;
  depth: number;
  position: number;
  setSize: number;
}

const tree = computed(() => buildLayerTree(store.layers));
const branchIds = computed(() =>
  [...tree.value.nodesById.values()]
    .filter((node) => node.children.length > 0)
    .map((node) => node.layer.id),
);
const allCollapsed = computed(
  () => branchIds.value.length > 0 && branchIds.value.every((id) => isCollapsed(id)),
);
const filteredRoots = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  if (!query) return tree.value.roots;
  const filter = (node: LayerTreeNode): LayerTreeNode | undefined => {
    const children = node.children.map(filter).filter(Boolean) as LayerTreeNode[];
    const label =
      node.layer.type === 'text' ? `${node.layer.name} ${node.layer.content}` : node.layer.name;
    return label.toLocaleLowerCase().includes(query) || children.length
      ? { layer: node.layer, children }
      : undefined;
  };
  return tree.value.roots.map(filter).filter(Boolean) as LayerTreeNode[];
});
function sceneCollapsed() {
  const id = store.scene?.id;
  return id ? collapsedByScene.value[id] || [] : [];
}
function isCollapsed(id: string) {
  return sceneCollapsed().includes(id);
}
function isExpanded(id: string) {
  return !!search.value.trim() || !isCollapsed(id);
}
function setCollapsed(id: string, value: boolean) {
  const sceneId = store.scene?.id;
  if (!sceneId) return;
  const current = sceneCollapsed(),
    next = value ? [...new Set([...current, id])] : current.filter((item) => item !== id);
  collapsedByScene.value = { ...collapsedByScene.value, [sceneId]: next };
}
function toggle(id: string) {
  if (!search.value.trim()) setCollapsed(id, !isCollapsed(id));
}
function toggleAll() {
  const sceneId = store.scene?.id;
  if (!sceneId || search.value.trim()) return;
  collapsedByScene.value = {
    ...collapsedByScene.value,
    [sceneId]: allCollapsed.value ? [] : [...branchIds.value],
  };
}
const rows = computed(() => {
  const result: TreeRow[] = [];
  const visit = (nodes: LayerTreeNode[], depth: number) => {
    nodes.forEach((node, index) => {
      result.push({ node, depth, position: index + 1, setSize: nodes.length });
      if (node.children.length && isExpanded(node.layer.id)) visit(node.children, depth + 1);
    });
  };
  visit(filteredRoots.value, 0);
  return result;
});
const tabStopId = computed(() => {
  const ids = new Set(rows.value.map((row) => row.node.layer.id));
  if (ids.has(focused.value)) return focused.value;
  return store.selected.find((id) => ids.has(id)) || rows.value[0]?.node.layer.id || '';
});

function expandAncestors(ids: string[]) {
  const sceneId = store.scene?.id;
  if (!sceneId) return;
  const expanded = new Set<string>();
  for (const id of ids) {
    let parent = tree.value.parentById.get(id);
    while (parent) {
      expanded.add(parent);
      parent = tree.value.parentById.get(parent);
    }
  }
  if (!expanded.size) return;
  const next = sceneCollapsed().filter((id) => !expanded.has(id));
  if (next.length !== sceneCollapsed().length)
    collapsedByScene.value = { ...collapsedByScene.value, [sceneId]: next };
}
watch(
  () => ({
    sceneId: store.scene?.id,
    selected: [...store.selected],
    parents: tree.value.parentById,
  }),
  ({ sceneId, selected }) => {
    if (!sceneId) return;
    expandAncestors(selected);
    if (!tree.value.nodesById.has(focused.value)) focused.value = '';
  },
);

function focusRow(id: string) {
  focused.value = id;
  void nextTick(() => document.getElementById(`layer-tree-${id}`)?.focus());
}
function selectLayer(id: string, event: MouseEvent | KeyboardEvent) {
  store.select(id, event.shiftKey || event.ctrlKey || event.metaKey);
  focused.value = id;
  emit('focus', id);
}
function navigate(event: KeyboardEvent, row: TreeRow) {
  const index = rows.value.findIndex((item) => item.node.layer.id === row.node.layer.id),
    node = tree.value.nodesById.get(row.node.layer.id),
    parentId = tree.value.parentById.get(row.node.layer.id);
  let destination = '';
  if (event.key === 'ArrowDown') destination = rows.value[index + 1]?.node.layer.id || '';
  else if (event.key === 'ArrowUp') destination = rows.value[index - 1]?.node.layer.id || '';
  else if (event.key === 'Home') destination = rows.value[0]?.node.layer.id || '';
  else if (event.key === 'End') destination = rows.value.at(-1)?.node.layer.id || '';
  else if (event.key === 'ArrowRight' && node?.children.length) {
    if (!isExpanded(node.layer.id)) setCollapsed(node.layer.id, false);
    else destination = rows.value[index + 1]?.node.layer.id || '';
  } else if (event.key === 'ArrowLeft') {
    if (node?.children.length && isExpanded(node.layer.id) && !search.value.trim())
      setCollapsed(node.layer.id, true);
    else destination = parentId || '';
  } else if (event.key === 'Enter' || event.key === ' ') {
    selectLayer(row.node.layer.id, event);
  } else return;
  event.preventDefault();
  event.stopPropagation();
  if (destination) focusRow(destination);
}
async function rename(id: string) {
  const s = store.project!.scenes.find((s) => s.id === id)!;
  try {
    const { value } = await ElMessageBox.prompt('输入场景名称', '重命名场景', {
      inputValue: s.name,
      inputValidator: (v) => !!v.trim() && v.length <= 200,
      confirmButtonText: '保存',
      cancelButtonText: '取消',
    });
    store.mutate(() => (s.name = value.trim()));
  } catch {}
}
function add() {
  store.mutate(() => {
    const id = crypto.randomUUID();
    store.project!.scenes.push({
      id,
      name: `Page ${store.project!.scenes.length + 1}`,
      width: 1440,
      height: 900,
      layers: [],
    });
    store.project!.activeSceneId = id;
    store.selected = [];
  });
}
async function remove(id: string) {
  if (store.project!.scenes.length <= 1) return;
  try {
    await ElMessageBox.confirm('场景内图层也会移除，可通过撤销恢复。', '删除场景', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
    store.mutate(() => {
      store.project!.scenes = store.project!.scenes.filter((s) => s.id !== id);
      if (store.project!.activeSceneId === id)
        store.project!.activeSceneId = store.project!.scenes[0].id;
      store.selected = [];
    });
  } catch {}
}
function reorder(id: string) {
  if (!dragged.value || dragged.value === id) return;
  store.mutate(() => {
    const from = store.layers.findIndex((l) => l.id === dragged.value),
      to = store.layers.findIndex((l) => l.id === id);
    if (from >= 0 && to >= 0) store.layers.splice(to, 0, store.layers.splice(from, 1)[0]);
  });
  dragged.value = '';
}
</script>
<template>
  <div class="layer-panel">
    <section class="scene-section">
      <div class="section-heading">
        <h2>
          场景 <span class="count">{{ store.project?.scenes.length || 0 }}</span>
        </h2>
        <IconButton label="新建场景" :icon="Plus" :disabled="store.exclusive" @click="add" />
      </div>
      <div class="scene-list">
        <div
          v-for="s in store.project?.scenes"
          :key="s.id"
          class="scene-row"
          :class="{ selected: s.id === store.scene?.id }"
        >
          <button
            class="scene-select"
            @click="
              store.mutate(() => {
                store.project!.activeSceneId = s.id;
                store.selected = [];
              })
            "
            @dblclick="rename(s.id)"
          >
            <span class="scene-symbol">▧</span>{{ s.name }}</button
          ><IconButton
            :label="'重命名 ' + s.name"
            :icon="EditPen"
            @click="rename(s.id)"
          /><IconButton
            :label="'删除 ' + s.name"
            :icon="Delete"
            :disabled="store.project!.scenes.length === 1 || store.exclusive"
            @click="remove(s.id)"
          />
        </div>
      </div>
    </section>
    <div class="layer-search">
      <el-input
        v-model="search"
        placeholder="搜索图层"
        aria-label="搜索图层"
        :prefix-icon="Search"
        clearable
      />
      <IconButton
        :label="allCollapsed ? '全部展开图层树' : '全部收起图层树'"
        :title="allCollapsed ? '全部展开' : '全部收起'"
        :icon="allCollapsed ? Expand : Fold"
        :disabled="!branchIds.length || !!search.trim()"
        @click="toggleAll"
      />
    </div>
    <div class="layer-list" role="tree" aria-label="图层列表" aria-multiselectable="true">
      <div
        v-for="row in rows"
        :key="row.node.layer.id"
        role="none"
        class="layer-row layer-tree-row"
        :class="{
          selected: store.selected.includes(row.node.layer.id),
          hidden: row.node.layer.hidden,
        }"
        :style="{ '--tree-depth': row.depth }"
        :draggable="!store.exclusive && !row.node.layer.locked"
        @dragstart="dragged = row.node.layer.id"
        @dragend="dragged = ''"
        @dragover.prevent
        @drop.prevent="reorder(row.node.layer.id)"
      >
        <button
          v-if="row.node.children.length"
          type="button"
          class="tree-toggle"
          :aria-label="(isExpanded(row.node.layer.id) ? '收起 ' : '展开 ') + row.node.layer.name"
          :title="search.trim() ? '搜索时自动展开' : undefined"
          :disabled="!!search.trim()"
          tabindex="-1"
          @click="toggle(row.node.layer.id)"
        >
          <el-icon><ArrowDown v-if="isExpanded(row.node.layer.id)" /><ArrowRight v-else /></el-icon>
        </button>
        <span v-else class="tree-toggle-placeholder" aria-hidden="true" />
        <button
          :id="`layer-tree-${row.node.layer.id}`"
          class="layer-select"
          role="treeitem"
          :aria-level="row.depth + 1"
          :aria-posinset="row.position"
          :aria-setsize="row.setSize"
          :aria-expanded="row.node.children.length ? isExpanded(row.node.layer.id) : undefined"
          :aria-selected="store.selected.includes(row.node.layer.id)"
          :tabindex="row.node.layer.id === tabStopId ? 0 : -1"
          @focus="focused = row.node.layer.id"
          @keydown="navigate($event, row)"
          @click="selectLayer(row.node.layer.id, $event)"
        >
          <el-icon><TextIcon v-if="row.node.layer.type === 'text'" /><Picture v-else /></el-icon
          ><span>{{ row.node.layer.name }}</span>
        </button>
        <IconButton
          :label="(row.node.layer.hidden ? '显示 ' : '隐藏 ') + row.node.layer.name"
          :icon="row.node.layer.hidden ? Hide : View"
          @click="store.mutate(() => (row.node.layer.hidden = !row.node.layer.hidden))"
        /><IconButton
          :label="(row.node.layer.locked ? '解锁 ' : '锁定 ') + row.node.layer.name"
          :icon="row.node.layer.locked ? Lock : Unlock"
          @click="store.mutate(() => (row.node.layer.locked = !row.node.layer.locked))"
        />
      </div>
      <p v-if="!rows.length" class="empty-panel">
        {{ search ? '没有匹配的图层' : '导入图片后，图层会显示在这里。' }}
      </p>
    </div>
    <footer class="panel-caption">
      {{ store.layers.length }} 个图层<span>拖动调整叠放 · 层级由位置决定</span>
    </footer>
  </div>
</template>
