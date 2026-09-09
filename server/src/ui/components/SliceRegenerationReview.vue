<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import type { RegenerationSnapshot, RegenerationAction } from '../types/regeneration';
const props = defineProps<{ snapshot: RegenerationSnapshot }>();
const emit = defineEmits<{ action: [event: RegenerationAction] }>();
const dialog = ref<HTMLDialogElement>();
const viewport = ref<HTMLElement>();
const selected = ref(props.snapshot.items[0]?.id || '');
const item = computed(() => props.snapshot.items.find(i => i.id === selected.value));
const resultView = ref(true);
const zoom = ref(1); const pan = ref({ x: 0, y: 0 });
const shown = computed(() => resultView.value && item.value?.result ? item.value.result : item.value);
const labels = { pending: '待生成', running: '生成中', ready: '待确认', failed: '失败', cancelled: '已取消', applied: '已应用', discarded: '已放弃' };
const settled = computed(() => props.snapshot.items.filter(i => !['pending', 'running'].includes(i.status)).length);
const canApply = computed(() => item.value?.status === 'ready' && !props.snapshot.running && !props.snapshot.saving);
const previousFocus = document.activeElement as HTMLElement | null;
function send(type: RegenerationAction['type']) { emit('action', { type, id: item.value?.id }); }
function fit() {
  if (!shown.value || !viewport.value) return;
  zoom.value = Math.min(2, (viewport.value.clientWidth - 40) / shown.value.width, (viewport.value.clientHeight - 40) / shown.value.height);
  pan.value = { x: 0, y: 0 };
}
function scale(factor: number) { zoom.value = Math.max(.05, Math.min(8, zoom.value * factor)); }
let drag: { id: number; x: number; y: number; px: number; py: number } | null = null;
function startPan(event: PointerEvent) {
  if (event.button !== 0) return;
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, px: pan.value.x, py: pan.value.y };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function movePan(event: PointerEvent) {
  if (drag?.id === event.pointerId) pan.value = { x: drag.px + event.clientX - drag.x, y: drag.py + event.clientY - drag.y };
}
function keydown(event: KeyboardEvent) {
  event.stopPropagation();
  if (event.key !== 'Tab') return;
  const buttons = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') || [])];
  const first = buttons[0], last = buttons.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
watch(() => [selected.value, shown.value?.dataUrl], () => nextTick(fit));
let observer: ResizeObserver;
onMounted(() => { dialog.value?.showModal(); observer = new ResizeObserver(fit); if (viewport.value) observer.observe(viewport.value); nextTick(fit); });
onBeforeUnmount(() => { observer?.disconnect(); dialog.value?.close(); previousFocus?.focus(); });
</script>

<template>
  <dialog ref="dialog" class="regeneration-review" aria-labelledby="regeneration-title" @cancel.prevent="send('close')" @keydown="keydown">
    <header><div><h2 id="regeneration-title">AI重新生成</h2><p>{{ snapshot.provider }}</p></div><button type="button" :disabled="snapshot.saving" aria-label="关闭重新生成" @click="send('close')">关闭</button></header>
    <p v-if="!snapshot.confirmed" class="regeneration-notice">图片将发送至以上远程服务，可能产生费用。AI 会参考原图重绘，细节可能不同；子级覆盖区会补全父图，不复制子级内容。确认前不会替换切图。</p>
    <div class="regeneration-body">
      <nav aria-label="待重新生成图片"><button v-for="entry in snapshot.items" :key="entry.id" type="button" :aria-pressed="entry.id === selected" @click="selected = entry.id">
        <img :src="entry.dataUrl" alt="" /><span><strong>{{ entry.name }}</strong><small>{{ entry.width }} × {{ entry.height }} px · 排除 {{ entry.childCount }} 个子级</small><small>{{ labels[entry.status] }}</small></span>
      </button></nav>
      <section class="regeneration-preview" aria-label="生成结果审阅">
        <div class="regeneration-view-controls"><div><button type="button" :aria-pressed="!resultView || !item?.result" @click="resultView = false">处理前</button><button type="button" :aria-pressed="resultView && !!item?.result" :disabled="!item?.result" @click="resultView = true">生成结果</button></div><span v-if="shown">{{ shown.width }} × {{ shown.height }} px</span></div>
        <div ref="viewport" class="regeneration-canvas" tabindex="0" aria-label="图片预览，可拖动平移" @pointerdown="startPan" @pointermove="movePan" @pointerup="drag = null" @pointercancel="drag = null" @wheel.prevent="scale($event.deltaY < 0 ? 1.1 : 1 / 1.1)">
          <img v-if="shown" :src="shown.dataUrl" :alt="resultView && item?.result ? '生成结果' : '处理前'" draggable="false" :style="{ width: `${shown.width}px`, height: `${shown.height}px`, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }" />
        </div>
        <div class="regeneration-view-controls"><div><button type="button" aria-label="缩小预览" @click="scale(1 / 1.25)">−</button><span>{{ Math.round(zoom * 100) }}%</span><button type="button" aria-label="放大预览" @click="scale(1.25)">+</button><button type="button" @click="fit">适应</button><button type="button" @click="zoom = 1; pan = { x: 0, y: 0 }">100%</button></div><small>拖动画面平移</small></div>
        <p v-if="item?.error" role="alert" class="regeneration-error">{{ item.error }}</p>
        <p v-if="item?.result" class="regeneration-dimensions">输入 {{ item.width }} × {{ item.height }} → 输出 {{ item.result.width }} × {{ item.result.height }} px · {{ item.result.provider.model }}</p>
      </section>
    </div>
    <footer><span role="status">{{ snapshot.saving ? '正在保存…' : snapshot.running ? `正在生成 ${settled + 1} / ${snapshot.items.length}` : snapshot.confirmed ? `已处理 ${settled} / ${snapshot.items.length}` : `共 ${snapshot.items.length} 张图片，等待确认` }}<small v-if="snapshot.running">{{ snapshot.items.find(i => i.status === 'running')?.progress }}</small><small v-if="snapshot.error" role="alert" class="regeneration-error">{{ snapshot.error }}</small></span>
      <div><button v-if="snapshot.running" type="button" @click="send('cancel')">取消剩余任务</button>
        <button v-if="!snapshot.confirmed" class="primary" type="button" :disabled="snapshot.running" @click="send('start')">确认并开始生成</button>
        <button v-if="item && ['failed', 'cancelled'].includes(item.status)" type="button" :disabled="snapshot.running || snapshot.saving" @click="send('retry')">重试失败项</button>
        <button v-if="item?.status === 'ready'" type="button" :disabled="snapshot.saving" @click="send('discard')">放弃此结果</button>
        <button v-if="item?.status === 'ready'" class="primary" type="button" :disabled="!canApply" :title="snapshot.running ? '请等待当前批次完成后应用' : ''" @click="send('apply')">应用此图</button>
      </div>
    </footer>
  </dialog>
</template>
