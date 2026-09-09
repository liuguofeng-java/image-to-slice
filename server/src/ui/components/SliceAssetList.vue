<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import SliceIcon from './SliceIcon.vue';
import type { SliceActionName, SliceListEvent, SliceListRow, SliceListSnapshot } from '../types/slice-list';

const props = defineProps<{ snapshot: SliceListSnapshot }>();
const emit = defineEmits<{ action: [event: SliceListEvent] }>();
const labels = { unclassified: '图片', background: '图片', image: '图片', text: '文字' };
const dragId = ref('');
const overId = ref('');
const indicatorTop = ref<number | null>(null);
const rows = computed(() => props.snapshot.rows);
function action(type: SliceActionName, row: SliceListRow) {
  if (!row.processing || type === 'cancel') emit('action', { type, id: row.id });
}
function select(event: MouseEvent, row: SliceListRow) {
  if (!row.processing) emit('action', { type: 'select', id: row.id, shift: event.shiftKey, additive: event.ctrlKey || event.metaKey });
}
function selectFromKeyboard(event: KeyboardEvent, row: SliceListRow) {
  if (!row.processing) emit('action', { type: 'select', id: row.id, shift: event.shiftKey, additive: event.ctrlKey || event.metaKey });
}
function startDrag(event: DragEvent, row: SliceListRow) {
  if (row.processing || !event.dataTransfer) { event.preventDefault(); return; }
  stopPointerDrag();
  dragId.value = row.id;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', row.id);
}
function drop(event: DragEvent, row: SliceListRow) {
  const sourceId = event.dataTransfer?.getData('text/plain');
  if (sourceId && !row.processing) emit('action', { type: 'reorder', sourceId, targetId: row.id });
  dragId.value = overId.value = '';
}
let cleanupPointer: (() => void) | undefined;
function stopPointerDrag() { cleanupPointer?.(); cleanupPointer = undefined; }
function pointerDown(event: PointerEvent, row: SliceListRow) {
  if (row.processing || event.button !== 0 || (event.target as Element).closest('button, input, textarea, select, details, .cut-thumb')) return;
  stopPointerDrag();
  const host = (event.currentTarget as HTMLElement).parentElement;
  const pointerId = event.pointerId;
  let targetId = row.id;
  let before = true;
  let moved = false;
  const move = (current: PointerEvent) => {
    if (current.pointerId !== pointerId || Math.hypot(current.clientX - event.clientX, current.clientY - event.clientY) < 5) return;
    const target = document.elementFromPoint(current.clientX, current.clientY)?.closest<HTMLElement>('.cut-item');
    if (!target || target.parentElement !== host) return;
    targetId = target.dataset.sliceId || row.id;
    if (rows.value.find(item => item.id === targetId)?.processing) return;
    moved = true;
    overId.value = targetId;
    before = current.clientY < target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2;
    indicatorTop.value = Math.max(0, before ? target.offsetTop - 5 : target.offsetTop + target.offsetHeight + 5);
    current.preventDefault();
  };
  const end = (current: PointerEvent) => {
    if (current.pointerId !== pointerId) return;
    stopPointerDrag();
    if (moved && current.type !== 'pointercancel') emit('action', { type: 'reorder', sourceId: row.id, targetId, before });
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
  cleanupPointer = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', end);
    document.removeEventListener('pointercancel', end);
    overId.value = '';
    indicatorTop.value = null;
  };
}
onBeforeUnmount(stopPointerDrag);
</script>

<template>
  <div v-if="!rows.length" class="cut-empty">还没有切图区域</div>
  <div v-for="row in rows" :key="`${snapshot.imageId}:${row.id}`" class="cut-item"
    :class="{ 'slice-tree-child': row.depth > 0, 'slice-tree-parent': row.childCount > 0, active: row.selected, 'ai-processing': row.processing, 'audit-failed': row.auditFailed, dragging: dragId === row.id, 'drag-over': overId === row.id, reordered: snapshot.animateReorder }"
    :data-slice-id="row.id" :data-slice-parent-id="row.parentId || ''" :data-slice-depth="row.depth"
    role="button" :tabindex="row.processing ? -1 : 0" :aria-pressed="row.selected" :aria-label="`选择资源 ${row.name}`"
    :style="{ '--slice-tree-indent': `${Math.min(row.depth, 6) * 16}px` }" :draggable="!row.processing"
    @pointerdown="pointerDown($event, row)" @dragstart="startDrag($event, row)" @dragend="dragId = overId = ''"
    @dragover.prevent="overId = row.id" @dragleave="overId = ''" @drop.prevent.stop="drop($event, row)"
    @click="select($event, row)" @keydown.enter.prevent="selectFromKeyboard($event, row)"
    @keydown.space.prevent="selectFromKeyboard($event, row)" @contextmenu.prevent="action('settings', row)">
    <div v-if="row.contentType === 'text'" class="cut-thumb cut-thumb-text" :title="row.text || '空文字'">{{ row.text || 'T' }}</div>
    <img v-else class="cut-thumb" :src="row.dataUrl" :alt="row.name" :draggable="false" :style="{ borderRadius: row.radius }" />
    <div class="cut-meta">
      <span class="cut-name">{{ row.number }}. {{ row.name }}<span class="cut-type-badge" :class="row.contentType">{{ labels[row.contentType] }}</span><span v-if="row.childCount" class="cut-parent-badge">父级 · {{ row.childCount }}</span></span>
      <span v-if="row.regenerateMarked" class="cut-regeneration-badge">待重新生成</span>
      <span class="cut-size">{{ row.description }}</span>
    </div>
    <div v-if="row.processing" class="cut-ai-status" role="status" aria-live="polite">
      <span class="cut-ai-status-spinner" aria-hidden="true" /><span class="cut-ai-status-label">{{ row.processingLabel || '正在请求 AI 处理切图 · 0s' }}</span>
      <button class="cut-ai-cancel" type="button" :aria-label="`取消 ${row.name} 的 AI 任务`" title="取消 AI 任务" @click.stop="action('cancel', row)"><SliceIcon kind="cancel" /></button>
    </div>
  </div>
  <div v-if="indicatorTop !== null" class="cut-drop-indicator" :style="{ top: `${indicatorTop}px` }" />
</template>
