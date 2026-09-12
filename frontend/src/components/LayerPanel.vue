<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  Plus,
  Search,
  Picture,
  View,
  Hide,
  Lock,
  Unlock,
  Delete,
  EditPen,
} from '@element-plus/icons-vue';
import { ElMessageBox } from 'element-plus';
import { useEditor } from '../store';
import IconButton from './IconButton.vue';
const store = useEditor(),
  search = ref(''),
  dragged = ref('');
const rows = computed(() =>
  [...store.layers]
    .reverse()
    .filter((l) => l.name.toLowerCase().includes(search.value.toLowerCase())),
);
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
    </div>
    <div class="layer-list" role="listbox" aria-label="图层列表" aria-multiselectable="true">
      <div
        v-for="l in rows"
        :key="l.id"
        class="layer-row"
        :class="{ selected: store.selected.includes(l.id), hidden: l.hidden }"
        :draggable="!store.exclusive && !l.locked"
        @dragstart="dragged = l.id"
        @dragover.prevent
        @drop.prevent="reorder(l.id)"
      >
        <button
          class="layer-select"
          role="option"
          :aria-selected="store.selected.includes(l.id)"
          @click="store.select(l.id, $event.shiftKey || $event.ctrlKey || $event.metaKey)"
        >
          <el-icon><Picture /></el-icon><span>{{ l.name }}</span>
        </button>
        <IconButton
          :label="(l.hidden ? '显示 ' : '隐藏 ') + l.name"
          :icon="l.hidden ? Hide : View"
          @click="store.mutate(() => (l.hidden = !l.hidden))"
        /><IconButton
          :label="(l.locked ? '解锁 ' : '锁定 ') + l.name"
          :icon="l.locked ? Lock : Unlock"
          @click="store.mutate(() => (l.locked = !l.locked))"
        />
      </div>
      <p v-if="!rows.length" class="empty-panel">
        {{ search ? '没有匹配的图层' : '导入图片后，图层会显示在这里。' }}
      </p>
    </div>
    <footer class="panel-caption">
      {{ store.layers.length }} 个图层<span>Shift 多选 · 拖动排序</span>
    </footer>
  </div>
</template>
