<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import {
  Menu,
  FolderOpened,
  Plus,
  Download,
  Setting,
  Back,
  Right,
  Pointer,
  Rank,
  Picture,
  ScaleToOriginal,
  ZoomIn,
  ZoomOut,
  Crop,
  Close,
  Operation,
  Files,
  Check,
} from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useEditor } from './store';
import { api, download } from './api';
import { useSplit } from './useSplit';
import EditorCanvas from './components/EditorCanvas.vue';
import LayerPanel from './components/LayerPanel.vue';
import PropertiesPanel from './components/PropertiesPanel.vue';
import SplitPanel from './components/SplitPanel.vue';
import ModelDialog from './components/ModelDialog.vue';
import IconButton from './components/IconButton.vue';
import type { Project } from './types';
const store = useEditor(),
  split = useSplit(),
  canvas = ref<InstanceType<typeof EditorCanvas>>(),
  input = ref<HTMLInputElement>(),
  tool = ref<'select' | 'hand'>('select'),
  tab = ref('design'),
  zoom = ref(1),
  modelOpen = ref(false),
  projectsOpen = ref(false),
  projects = ref<Pick<Project, 'id' | 'name' | 'revision' | 'updatedAt'>[]>([]),
  loading = ref(true),
  fatal = ref(''),
  exporting = ref(false),
  drawer = ref<'left' | 'right' | null>(null),
  narrow = ref(window.innerWidth < 960),
  leftTrigger = ref<HTMLButtonElement>(),
  rightTrigger = ref<HTMLButtonElement>();
const currentTool = computed(() => (split.active.value ? 'split' : tool.value)),
  saveLabel = computed(() =>
    store.error ? '保存失败' : store.saving ? '保存中…' : store.dirty ? '未保存' : '已保存',
  );
let focusReturn: HTMLElement | null = null;
function report(e: unknown) {
  ElMessage.error(e instanceof Error ? e.message : String(e));
}
async function initialize() {
  loading.value = true;
  fatal.value = '';
  try {
    await api.health();
    const list = await api.list();
    projects.value = list.projects;
    const last = localStorage.getItem('slice-studio-project');
    const p = list.projects.find((p) => p.id === last) || list.projects[0];
    await store.open(p ? await api.open(p.id) : await api.create('Untitled'));
  } catch (e) {
    fatal.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
async function showProjects() {
  try {
    projects.value = (await api.list()).projects;
    projectsOpen.value = true;
  } catch (e) {
    report(e);
  }
}
async function openProject(id: string) {
  try {
    if (store.error) {
      await ElMessageBox.confirm(
        '当前内容尚未保存。重新打开会放弃本地修改并读取磁盘版本。',
        '打开项目',
        { confirmButtonText: '重新打开', cancelButtonText: '取消' },
      );
    } else await store.flush();
    await split.close();
    await store.open(await api.open(id));
    projectsOpen.value = false;
  } catch (e) {
    if (e !== 'cancel') report(e);
  }
}
async function createProject() {
  try {
    const { value } = await ElMessageBox.prompt('项目名称', '新建项目', {
      inputValue: 'Untitled',
      inputValidator: (v) => !!v.trim() && v.length <= 200,
      confirmButtonText: '创建',
      cancelButtonText: '取消',
    });
    await store.flush();
    await split.close();
    await store.open(await api.create(value.trim()));
    projectsOpen.value = false;
  } catch (e) {
    if (e !== 'cancel') report(e);
  }
}
async function renameProject() {
  try {
    const { value } = await ElMessageBox.prompt('项目名称', '重命名项目', {
      inputValue: store.project?.name,
      inputValidator: (v) => !!v.trim() && v.length <= 200,
      confirmButtonText: '保存',
      cancelButtonText: '取消',
    });
    store.mutate(() => (store.project!.name = value.trim()));
  } catch {}
}
async function importFiles(files: File[]) {
  if (!files.length || !store.project) return;
  try {
    await split.close();
    await store.importFiles(files);
  } catch (e) {
    report(e);
  }
}
async function exportImages(kind: 'png' | 'zip' | 'scene') {
  if (exporting.value) return;
  exporting.value = true;
  try {
    await store.flush();
    await download({
      projectId: store.project!.id,
      sceneId: store.scene!.id,
      kind,
      layerIds: store.selected,
    });
  } catch (e) {
    report(e);
  } finally {
    exporting.value = false;
  }
}
async function startSplit() {
  await split.enter();
  if (split.active.value) {
    tab.value = 'ai';
    if (narrow.value) openDrawer('right');
  }
}
function chooseTool(next: 'select' | 'hand') {
  void split.close();
  tool.value = next;
}
function openDrawer(side: 'left' | 'right') {
  focusReturn = document.activeElement as HTMLElement;
  drawer.value = drawer.value === side ? null : side;
  void nextTick(() => {
    document.querySelector<HTMLElement>('.side-panel.drawer-open button')?.focus();
  });
}
function closeDrawer() {
  drawer.value = null;
  focusReturn?.focus();
}
function resize() {
  narrow.value = window.innerWidth < 960;
  if (!narrow.value) drawer.value = null;
}
function key(e: KeyboardEvent) {
  if (document.querySelector('.el-overlay:not([style*="display: none"])')) return;
  const editing = (e.target as HTMLElement)?.closest('input,textarea,[contenteditable=true]');
  if (editing) return;
  if (e.key === 'Escape') {
    if (drawer.value) closeDrawer();
    else if (split.active.value) void split.close();
    else store.selected = [];
    return;
  }
  if (drawer.value && e.key === 'Tab') {
    const panel = document.querySelector('.side-panel.drawer-open'),
      items = Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),[tabindex="0"]',
        ) || [],
      ).filter((el) => el.offsetParent !== null);
    const first = items[0],
      last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    void store.save().catch(report);
  } else if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    store.undo(!e.shiftKey);
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    store.undo(false);
  } else if (mod && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    store.duplicate();
  } else if (mod && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    store.selected = store.layers.filter((l) => !l.locked && !l.hidden).map((l) => l.id);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    store.remove();
  } else if (e.key.toLowerCase() === 'v') chooseTool('select');
  else if (e.key.toLowerCase() === 'h') chooseTool('hand');
  else if (e.key === '0') canvas.value?.fit();
  else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    e.preventDefault();
    store.mutate(() => {
      for (const l of store.selection.filter((l) => !l.locked)) {
        const d = e.shiftKey ? 10 : 1;
        if (e.key === 'ArrowLeft') l.x -= d;
        if (e.key === 'ArrowRight') l.x += d;
        if (e.key === 'ArrowUp') l.y -= d;
        if (e.key === 'ArrowDown') l.y += d;
      }
    });
  }
}
function paste(e: ClipboardEvent) {
  if ((e.target as HTMLElement).closest('input,textarea,[contenteditable=true],.el-overlay'))
    return;
  const files = Array.from(e.clipboardData?.files || []);
  if (files.length) {
    e.preventDefault();
    void importFiles(files);
  }
}
function unload(e: BeforeUnloadEvent) {
  if (store.dirty || store.saving || split.applying.value) {
    e.preventDefault();
    e.returnValue = '';
  }
}
watch(
  () => split.active.value,
  (active) => {
    if (!active) tool.value = 'select';
  },
);
onMounted(() => {
  void initialize();
  window.addEventListener('keydown', key);
  window.addEventListener('paste', paste);
  window.addEventListener('resize', resize);
  window.addEventListener('beforeunload', unload);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', key);
  window.removeEventListener('paste', paste);
  window.removeEventListener('resize', resize);
  window.removeEventListener('beforeunload', unload);
});
</script>
<template>
  <main
    class="studio"
    @dragover.prevent
    @drop.prevent="importFiles(Array.from($event.dataTransfer?.files || []))"
  >
    <EditorCanvas
      v-if="store.project"
      ref="canvas"
      :tool="currentTool"
      :source="split.source.value"
      :region="split.region.value"
      :candidates="split.candidates.value"
      :busy="split.busy.value || split.applying.value"
      @region="split.setRegion"
      @candidate="split.edit"
      @zoom="zoom = $event"
      @error="report"
    />
    <header class="topbar">
      <div class="topbar-project floating-bar">
        <span class="brand-mark" title="Slice Studio" aria-label="Slice Studio"
          ><svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 3h15l-4 6H2Zm1 12h15l-4 6H3Z" fill="currentColor" /></svg></span
        ><IconButton
          label="打开项目"
          :icon="Menu"
          :disabled="store.exclusive"
          @click="showProjects"
        /><button
          class="project-name"
          :disabled="!store.project || store.exclusive"
          title="重命名项目"
          @click="renameProject"
        >
          {{ store.project?.name || 'Slice Studio' }}</button
        ><span class="bar-divider" /><el-dropdown trigger="click"
          ><button class="zoom-menu" aria-label="画布缩放">{{ Math.round(zoom * 100) }}%⌄</button
          ><template #dropdown
            ><el-dropdown-menu
              ><el-dropdown-item @click="canvas?.fit()">适应画布</el-dropdown-item
              ><el-dropdown-item
                v-for="factor in [0.25, 0.5, 1, 2]"
                :key="factor"
                @click="canvas?.zoom(factor, true)"
                >{{ factor * 100 }}%</el-dropdown-item
              ></el-dropdown-menu
            ></template
          ></el-dropdown
        >
      </div>
      <div class="topbar-actions floating-bar">
        <IconButton
          label="撤销 (Ctrl+Z)"
          :icon="Back"
          :disabled="!store.undoStack.length || store.exclusive"
          @click="store.undo()"
        /><IconButton
          label="重做 (Ctrl+Shift+Z)"
          :icon="Right"
          :disabled="!store.redoStack.length || store.exclusive"
          @click="store.undo(false)"
        /><span class="bar-divider" /><IconButton
          label="模型设置"
          :icon="Setting"
          @click="modelOpen = true"
        /><button
          class="save-button"
          :class="{ error: store.error }"
          :disabled="!store.project || store.saving"
          :title="store.error || '手动保存 (Ctrl+S)'"
          @click="store.save().catch(report)"
        >
          <el-icon v-if="!store.dirty && !store.saving"><Check /></el-icon>{{ saveLabel }}
        </button>
      </div>
    </header>
    <template v-if="store.project"
      ><button
        v-if="narrow && drawer"
        class="drawer-backdrop"
        aria-label="关闭面板"
        @click="closeDrawer"
      />
      <aside
        class="side-panel left-panel"
        :class="{ 'drawer-open': drawer === 'left' }"
        :aria-modal="narrow && drawer === 'left' ? true : undefined"
        :role="narrow ? 'dialog' : 'complementary'"
        aria-label="场景和图层"
      >
        <div class="panel-header">
          <strong>图层</strong
          ><IconButton v-if="narrow" label="关闭图层面板" :icon="Close" @click="closeDrawer" /><span
            v-else
            class="panel-pin"
            >⌖</span
          >
        </div>
        <LayerPanel />
      </aside>
      <aside
        class="side-panel right-panel"
        :class="{ 'drawer-open': drawer === 'right' }"
        :aria-modal="narrow && drawer === 'right' ? true : undefined"
        :role="narrow ? 'dialog' : 'complementary'"
        aria-label="属性面板"
      >
        <div class="panel-header">
          <div class="panel-tabs" role="tablist">
            <button
              role="tab"
              :aria-selected="tab === 'design'"
              :class="{ active: tab === 'design' }"
              @click="tab = 'design'"
            >
              设计</button
            ><button
              role="tab"
              :aria-selected="tab === 'ai'"
              :class="{ active: tab === 'ai' }"
              @click="tab = 'ai'"
            >
              AI
            </button>
          </div>
          <IconButton v-if="narrow" label="关闭属性面板" :icon="Close" @click="closeDrawer" />
        </div>
        <div class="panel-scroll">
          <PropertiesPanel
            v-if="tab === 'design'"
            @split="startSplit"
            @export="exportImages"
          /><template v-else
            ><div v-if="!split.active.value" class="property-section">
              <h2>AI 框选拆图</h2>
              <p class="hint">选中一张可见、未锁定的图片，识别并裁切独立图层。</p>
              <el-button
                type="primary"
                class="full-button"
                :disabled="!store.single || store.single.hidden || store.single.locked"
                @click="startSplit"
                >进入框选</el-button
              >
              <p v-if="split.message.value" class="inline-message">{{ split.message.value }}</p>
            </div>
            <SplitPanel v-else :controller="split"
          /></template>
        </div>
      </aside>
      <footer class="bottom-toolbar floating-bar">
        <button
          v-if="narrow"
          ref="leftTrigger"
          class="icon-button"
          aria-label="打开图层面板"
          @click="openDrawer('left')"
        >
          <el-icon><Files /></el-icon></button
        ><IconButton
          label="选择 (V)"
          :icon="Pointer"
          :active="currentTool === 'select'"
          @click="chooseTool('select')"
        /><IconButton
          label="移动画布 (H / 空格)"
          :icon="Rank"
          :active="currentTool === 'hand'"
          @click="chooseTool('hand')"
        /><span class="bar-divider" /><IconButton
          label="导入图片"
          :icon="Picture"
          :disabled="store.exclusive"
          @click="input?.click()"
        /><IconButton
          label="AI 框选拆图"
          :icon="Crop"
          :active="currentTool === 'split'"
          :disabled="!store.single || store.single.hidden || store.single.locked || store.exclusive"
          @click="startSplit"
        /><span class="bar-divider" /><IconButton
          label="适应画布 (0)"
          :icon="ScaleToOriginal"
          @click="canvas?.fit()"
        /><button
          v-if="narrow"
          ref="rightTrigger"
          class="icon-button"
          aria-label="打开属性面板"
          @click="openDrawer('right')"
        >
          <el-icon><Operation /></el-icon>
        </button>
      </footer>
      <div class="workspace-status" :class="{ error: store.error }" role="status">
        {{
          store.error ||
          (exporting ? '正在导出…' : store.exclusive ? '正在处理…' : store.scene?.name)
        }}<button v-if="store.error" @click="showProjects">重新打开项目</button>
      </div>
    </template>
    <div v-if="loading || fatal" class="startup-overlay">
      <strong>Slice Studio</strong>
      <p>{{ fatal || '正在连接本地工作区…' }}</p>
      <template v-if="fatal"
        ><p class="hint">请确认独立后端正在 127.0.0.1:3002 运行。</p>
        <el-button type="primary" @click="initialize">重新连接</el-button></template
      >
    </div>
    <input
      ref="input"
      class="file-input"
      type="file"
      accept="image/png,image/jpeg,image/webp"
      multiple
      aria-label="选择导入图片"
      @change="
        importFiles(Array.from(input?.files || []));
        if (input) input.value = '';
      "
    />
    <ModelDialog v-model="modelOpen" />
    <el-dialog v-model="projectsOpen" title="本地项目" width="540px" align-center
      ><div class="project-list">
        <button
          v-for="p in projects"
          :key="p.id"
          :disabled="store.exclusive"
          @click="openProject(p.id)"
        >
          <el-icon><FolderOpened /></el-icon
          ><span
            ><strong>{{ p.name }}</strong
            ><small>{{ new Date(p.updatedAt).toLocaleString() }}</small></span
          ><span v-if="p.id === store.project?.id" class="badge">当前</span>
        </button>
      </div>
      <template #footer
        ><el-button @click="projectsOpen = false">关闭</el-button
        ><el-button type="primary" :icon="Plus" :disabled="store.exclusive" @click="createProject"
          >新建项目</el-button
        ></template
      ></el-dialog
    >
  </main>
</template>
