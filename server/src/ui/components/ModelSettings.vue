<script setup lang="ts">
import { onMounted, ref, reactive, computed, nextTick, onBeforeUnmount, watch } from 'vue';
import ModelTestStatus from './ModelTestStatus.vue';
import AppModal from './AppModal.vue';
import { api, jsonRequest } from '../api/client';
import type { ModelConfigs, ModelConfig } from '../types/workspace';
const emit = defineEmits<{ close: [] }>();
const confirm = window.confirm.bind(window);
const state = ref<ModelConfigs>({ modelConfigs: [], taskRouting: {} }), error = ref(''), busy = ref(false), editing = ref(false), models = ref<string[]>([]), visible = ref(false);
const form = reactive({ id: '', name: '', baseUrl: '', model: '', apiKey: '', timeoutMs: 500000, purpose: 'vision' });
const routeMenu = ref(''), modelMenu = ref(false), modelInput = ref<HTMLInputElement>();
type TestReport = { results?: ModelConfig['testResults']; message?: string };
const reports = ref<Record<string, TestReport>>({}), testingId = ref(''), elapsed = ref(0);
const locked = computed(() => busy.value || !!testingId.value);
let testController: AbortController | null = null, testTimer: ReturnType<typeof setInterval> | undefined;
function stopTimer() { clearInterval(testTimer); testTimer = undefined; }
function cancelTest() {
  if (!testController) return;
  testController.abort(); testController = null; stopTimer();
  reports.value[testingId.value] = { message: '已取消测试。已发送的上游请求仍可能产生费用。' };
  testingId.value = '';
}
async function runTest(id: string, path: string, tasks: string[], body?: ReturnType<typeof previewPayload>) {
  if (locked.value || !confirm('测试可能调用远程模型并计费。是否继续？')) return;
  const request = new AbortController(), started = Date.now();
  testController = request; testingId.value = id; elapsed.value = 0; error.value = ''; delete reports.value[id];
  testTimer = setInterval(() => { elapsed.value = Math.floor((Date.now() - started) / 1000); }, 1000);
  try {
    const result = await api<{ config: ModelConfig }>(path, body ? jsonRequest(body, request.signal) : { method: 'POST', signal: request.signal });
    if (testController !== request || request.signal.aborted) return;
    const results = result.config?.testResults;
    if (!tasks.length || !results || tasks.some(task => !['success', 'failed'].includes(results[task]?.status || ''))) throw new Error('接口未返回完整测试结果，请检查服务版本后重试。');
    reports.value[id] = { results };
  } catch (failure) {
    if (testController === request && !request.signal.aborted) reports.value[id] = { message: '测试失败：' + (failure as Error).message };
  } finally {
    if (testController === request) { testController = null; testingId.value = ''; stopTimer(); }
  }
}
function closeEditor() { if (testingId.value === 'preview') cancelTest(); editing.value = false; visible.value = false; form.apiKey = ''; }
function previewPayload() { const { id, ...data } = payload(); return { ...data, configId: id }; }
watch(() => JSON.stringify(form), () => { delete reports.value.preview; });
onBeforeUnmount(() => { testController?.abort(); testController = null; stopTimer(); });
const groups = computed(() => [
  { title: '图片理解', configs: state.value.modelConfigs.filter(c => !c.tasks.includes('generation') && !c.tasks.includes('inpaint')) },
  { title: '图片生成 / 图片修补', configs: state.value.modelConfigs.filter(c => c.tasks.includes('generation') || c.tasks.includes('inpaint')) }
].filter(g => g.configs.length));
function selectedConfig(task: string) {
  const routes = state.value.taskRouting;
  const id = task === 'vision' ? routes.vision : routes.generation === routes.inpaint ? routes.generation : undefined;
  return state.value.modelConfigs.find(c => c.id === id);
}
function testState(c: ModelConfig) {
  const results = reports.value[c.id]?.results || c.testResults || {}, values = c.tasks.map(t => results[t]);
  if (values.some(r => r?.status === 'failed')) return { text: '测试失败', tone: 'failure' };
  if (!values.length || !values.every(r => r?.status === 'success')) return { text: '测试', tone: 'neutral' };
  return c.tasks.includes('inpaint') ? { text: results.inpaint?.nativeMaskSupported ? '支持 Mask' : '不支持 Mask', tone: results.inpaint?.nativeMaskSupported ? 'success' : 'failure' } : { text: '测试通过', tone: 'success' };
}
async function testSaved(c: ModelConfig) {
  await runTest(c.id, '/api/model-configs/' + c.id + '/test', c.tasks);
}
function closePicker(event: FocusEvent) { if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) { routeMenu.value = ''; modelMenu.value = false; } }
function pickerKey(event: KeyboardEvent) {
  const root = event.currentTarget as HTMLElement;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); routeMenu.value = ''; modelMenu.value = false; root.querySelector<HTMLElement>('button,input')?.focus(); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const options = [...root.querySelectorAll<HTMLButtonElement>('[role=option]')]; if (!options.length) return;
  event.preventDefault(); const index = options.indexOf(document.activeElement as HTMLButtonElement), next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
  options[next]?.focus();
}
async function attempt(fn: () => Promise<void>) { busy.value = true; error.value = ''; try { await fn(); } catch (failure) { error.value = (failure as Error).message; } finally { busy.value = false; } }
async function load() { state.value = await api('/api/model-configs'); }
async function toggleKey() { if (visible.value) { visible.value = false; return; } await attempt(async () => { if (!form.apiKey && form.id) form.apiKey = (await api(`/api/model-configs/${form.id}/reveal-key`, { method: 'POST' })).apiKey; visible.value = true; }); }
function edit(c?: ModelConfig) { if (locked.value) return; delete reports.value.preview; Object.assign(form, { id: '', name: '', baseUrl: '', model: '', apiKey: '', timeoutMs: 500000, purpose: 'vision' }, c || {}, { apiKey: '', timeoutMs: c?.timeoutMs || (c?.timeoutSeconds || 500) * 1000, purpose: c?.tasks.includes('vision') ? 'vision' : c ? 'image' : 'vision' }); models.value = []; visible.value = false; editing.value = true; }
function payload() { return { id: form.id || undefined, name: form.name, baseUrl: form.baseUrl, model: form.model, timeoutMs: form.timeoutMs, tasks: form.purpose === 'image' ? ['generation', 'inpaint'] : ['vision'], ...(form.apiKey || !form.id ? { apiKey: form.apiKey } : {}) }; }
async function save() { if (locked.value) return; await attempt(async () => { const result = await api(form.id ? `/api/model-configs/${form.id}` : '/api/model-configs', jsonRequest(payload(), undefined, form.id ? 'PUT' : 'POST')); await api(`/api/task-routing/${form.purpose}`, jsonRequest({ configId: result.config.id }, undefined, 'PUT')); delete reports.value[form.id]; await load(); closeEditor(); }); }
async function route(task: string, configId: string) { await attempt(async () => { await api(`/api/task-routing/${task}`, jsonRequest({ configId: configId }, undefined, 'PUT')); await load(); }); }
onMounted(() => attempt(load));
</script>
<template>
<AppModal title="设置模型" class="model-settings-panel settings-panel open" @close="emit('close')">
  <template #header><div><span>设置模型</span><p v-if="error" class="config-status field-error" role="status">{{ error }}</p></div><div class="settings-head-actions"><button id="newModelConfig" :disabled="locked" @click="edit()">＋ 新建 API</button><button class="settings-close" aria-label="关闭" @click="emit('close')">×</button></div></template>
  <div class="model-settings-content">
    <section class="model-settings-section"><div class="model-settings-section-head"><div><strong>当前使用</strong><small>切换后立即保存并生效</small></div></div>
      <div class="task-routing-view"><div v-for="task in [{ key: 'vision', label: '图片理解', field: 'vision' }, { key: 'image', label: '图片生成 / 修补', field: 'generation' }]" :key="task.key" class="task-route-row">
        <div class="task-route-copy"><strong>{{ task.label }}</strong><small>{{ task.key === 'vision' ? '识别图片、文字与布局' : '生图、修补和重新生成' }}</small></div>
        <div class="model-route-picker" @focusout="closePicker" @keydown="pickerKey">
          <button class="model-route-picker-trigger" :aria-label="task.label" aria-haspopup="listbox" :aria-expanded="routeMenu === task.key" :aria-controls="'route-' + task.key" :disabled="locked" @click="routeMenu = routeMenu === task.key ? '' : task.key">
            <span><strong>{{ selectedConfig(task.key) ? (selectedConfig(task.key)?.name?.trim() || selectedConfig(task.key)?.model || '未命名 API') : '请选择配置' }}</strong><small>{{ selectedConfig(task.key)?.baseUrl || '尚未配置' }}</small></span><span class="model-route-picker-chevron" aria-hidden="true">⌄</span>
          </button>
          <div v-if="routeMenu === task.key" :id="'route-' + task.key" class="model-route-picker-menu" role="listbox" :aria-label="task.label">
            <button v-for="c in state.modelConfigs.filter(c => c.tasks.includes(task.field))" :key="c.id" role="option" :aria-selected="selectedConfig(task.key)?.id === c.id" :class="{ selected: selectedConfig(task.key)?.id === c.id }" @click="route(task.key, c.id); routeMenu = ''"><strong>{{ c.name || '未命名 API' }}</strong><small>{{ c.baseUrl }}</small></button>
            <div v-if="!state.modelConfigs.some(c => c.tasks.includes(task.field))" class="model-route-picker-empty">暂无可用 API</div>
          </div>
        </div>
      </div></div>
    </section>
    <section class="model-settings-section"><div class="model-settings-section-head"><div><strong>模型 API</strong><small>可创建多个连接并按用途选择</small></div></div><div class="model-config-list">
      <div v-if="!state.modelConfigs.length" class="model-config-empty">还没有模型 API，点击“新建 API”添加。</div>
      <section v-for="group in groups" :key="group.title" class="model-config-group"><div class="model-config-group-title">{{ group.title }}</div><div class="model-config-group-list">
        <article v-for="c in group.configs" :key="c.id" class="model-config-card" :class="{ active: Object.values(state.taskRouting).includes(c.id) }"><div class="model-config-card-main"><div class="model-config-card-title">{{ c.name || '未命名 API' }}</div><div class="model-config-detail">{{ c.baseUrl }} · {{ c.model }} · {{ c.timeoutSeconds || (c.timeoutMs || 500000) / 1000 }} 秒</div><div v-if="Object.values(state.taskRouting).includes(c.id)" class="model-config-active-use">正在用于{{ c.id === state.taskRouting.vision ? '图片理解' : '图片生成 / 修补' }}</div><ModelTestStatus v-if="testingId === c.id || reports[c.id]" :running="testingId === c.id" :elapsed="elapsed" :results="reports[c.id]?.results" :message="reports[c.id]?.message" @cancel="cancelTest" /></div><div class="model-config-actions"><button class="model-config-test" :class="testState(c).tone" :disabled="locked" :title="testingId && testingId !== c.id ? '请先等待或取消当前测试' : '测试可能调用远程模型并计费'" @click="testSaved(c)">{{ testingId === c.id ? '测试中…' : testState(c).text }}</button><button :disabled="locked" @click="edit(c)">编辑</button></div></article>
      </div></section>
    </div></section>
  </div>
</AppModal>
<AppModal v-if="editing" :title="form.id ? '编辑模型 API' : '新建模型 API'" class="model-api-modal" @close="closeEditor">
  <form class="model-config-form" @submit.prevent="save"><fieldset class="model-config-form-grid" :disabled="locked">
    <label>备注（选填）<input v-model="form.name" placeholder="例如：官方 OpenAI" /></label><label>Base URL<input v-model="form.baseUrl" type="url" placeholder="https://api.openai.com" required /></label>
    <label>模型<div class="model-config-model-row" @focusout="closePicker" @keydown="pickerKey"><input ref="modelInput" v-model="form.model" required aria-controls="provider-models" :aria-expanded="modelMenu" @focus="modelMenu = !!models.length" /><button type="button" :disabled="locked" @click="attempt(async () => { const result = await api('/api/model-configs/preview/models', jsonRequest(previewPayload())); models = (result.models || result.data || []).map((m: any) => typeof m === 'string' ? m : m.id); modelMenu = true; await nextTick(); modelInput?.focus(); })">获取模型</button><div v-if="modelMenu" id="provider-models" class="model-config-model-menu" role="listbox" aria-label="可用模型"><button v-for="m in models.filter(m => m.toLowerCase().includes(form.model.toLowerCase()))" :key="m" type="button" role="option" :aria-selected="m === form.model" @click="form.model = m; modelInput?.focus(); modelMenu = false">{{ m }}</button><span v-if="!models.length">未获取到可用模型，可直接输入模型名称</span></div></div></label>
    <label>超时时间（秒）<input :value="form.timeoutMs / 1000" type="number" min="30" max="1800" step="1" @input="form.timeoutMs = Number(($event.target as HTMLInputElement).value) * 1000" /></label>
    <label>API Key<div class="model-config-key-row"><input v-model="form.apiKey" :type="visible ? 'text' : 'password'" autocomplete="off" :placeholder="form.id ? '留空保留已保存的密钥' : 'sk-...'" /><button type="button" @click="toggleKey">{{ visible ? '隐藏' : '显示' }}</button></div></label>
  </fieldset><fieldset class="model-config-tasks" :disabled="locked"><legend>用于</legend><label><input v-model="form.purpose" type="radio" value="vision" />图片理解</label><label><input v-model="form.purpose" type="radio" value="image" />图片生成 / 修补</label></fieldset>
  <p v-if="error" class="field-error" role="alert">{{ error }}</p><div class="model-config-form-actions">
    <button v-if="form.id" type="button" :disabled="locked" @click="attempt(async () => { if (confirm('删除此 API 配置？')) { await api('/api/model-configs/' + form.id, { method: 'DELETE' }); editing = false; await load(); } })">删除</button>
    <button type="button" :disabled="locked" @click="runTest('preview', '/api/model-configs/preview/test', payload().tasks, previewPayload())">{{ testingId === 'preview' ? '测试中…' : '测试' }}</button><span></span><button class="confirm" :disabled="locked" type="submit">保存并生效</button>
  </div><ModelTestStatus v-if="testingId === 'preview' || reports.preview" :running="testingId === 'preview'" :elapsed="elapsed" :results="reports.preview?.results" :message="reports.preview?.message" @cancel="cancelTest" /></form>
</AppModal>
</template>
