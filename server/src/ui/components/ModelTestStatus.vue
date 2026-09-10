<script setup lang="ts">
import type { ModelConfig } from '../types/workspace';
defineProps<{ running: boolean; elapsed: number; message?: string; results?: ModelConfig['testResults'] }>();
const emit = defineEmits<{ cancel: [] }>();
const labels: Record<string, string> = { vision: '图片理解', generation: '图片生成', inpaint: '图片修补' };
</script>
<template>
  <div class="model-test-status" :aria-busy="running">
    <div v-if="running" class="model-test-running"><span role="status">测试中… 已等待 {{ elapsed }} 秒</span><button type="button" @click="emit('cancel')">取消测试</button></div>
    <p v-if="running" class="model-test-hint">正在等待模型响应；图片生成和修补会依次测试。</p>
    <p v-if="message" role="status">{{ message }}</p>
    <div v-if="!running && results" aria-live="polite">
      <p v-for="(result, task) in results" :key="task" :class="{ 'field-error': result.status === 'failed' }">
        {{ labels[task] || task }}：{{ result.status === 'success' ? '通过' : '失败' }}<template v-if="result.error"> — {{ result.error }}</template><template v-else-if="task === 'inpaint' && result.status === 'success'">（{{ result.nativeMaskSupported ? '支持独立 Mask' : '语义参考图模式，不支持独立 Mask' }}）</template>
      </p>
    </div>
  </div>
</template>
<style scoped>
.model-test-status { margin-top: 8px; color: var(--ink); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
.model-test-status p { margin: 4px 0; }
.model-test-running { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-variant-numeric: tabular-nums; }
.model-test-running button { padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--ink); }
.model-test-hint { color: var(--muted); }
</style>
