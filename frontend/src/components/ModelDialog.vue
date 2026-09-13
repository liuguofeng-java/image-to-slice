<script setup lang="ts">
import { reactive, ref, watch, onBeforeUnmount } from 'vue';
import { ElMessageBox } from 'element-plus';
import { api } from '../api';
import type { ModelConfig } from '../types';
const open = defineModel<boolean>({ required: true });
const form = reactive<ModelConfig>({
    baseUrl: 'http://localhost:8080',
    model: '',
    imageModel: '',
    imageQuality: 'max',
    timeoutSeconds: 120,
    apiKey: '',
  }),
  models = ref<string[]>([]),
  busy = ref(''),
  message = ref(''),
  hasKey = ref(false);
let controller: AbortController | undefined,
  epoch = 0;
watch(open, async (value) => {
  if (!value) {
    epoch++;
    controller?.abort();
    busy.value = '';
    return;
  }
  const token = ++epoch;
  message.value = '';
  Object.assign(form, {
    baseUrl: 'http://localhost:8080',
    model: '',
    imageModel: '',
    imageQuality: 'max',
    timeoutSeconds: 120,
    apiKey: '',
  });
  hasKey.value = false;
  try {
    const result = await api.config();
    if (token !== epoch) return;
    if (result.config) {
      Object.assign(form, result.config, { apiKey: '' });
      hasKey.value = !!result.config.hasApiKey;
    }
  } catch (e) {
    message.value = (e as Error).message;
  }
});
async function save() {
  const c = {
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim() || '待选择',
    imageModel: form.imageModel?.trim() || undefined,
    imageQuality: form.imageQuality || 'max',
    timeoutSeconds: form.timeoutSeconds,
    ...(form.apiKey ? { apiKey: form.apiKey } : {}),
  };
  const r = await api.saveConfig(c);
  hasKey.value = !!r.config.hasApiKey;
  form.apiKey = '';
}
async function action(kind: string) {
  if (busy.value) return;
  if (kind === 'test' || kind === 'test-image') {
    try {
      await ElMessageBox.confirm(
        kind === 'test'
          ? '发送一张测试图片到远程图片理解 API，可能产生费用。'
          : `调用图片生成模型「${form.imageModel}」生成一张测试图，可能产生费用且不会自动重试。`,
        kind === 'test' ? '测试图片理解' : '测试图片生成',
        { confirmButtonText: '发送测试', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
  }
  busy.value = kind;
  message.value = '';
  const token = epoch;
  controller = new AbortController();
  try {
    await save();
    if (token !== epoch) return;
    if (kind === 'models') {
      models.value = (await api.models(controller.signal)).models;
      message.value = `获取到 ${models.value.length} 个模型，请选择支持图片理解的模型。`;
    } else if (kind === 'test') {
      await api.test(controller.signal);
      message.value = '测试成功，模型可以接收图片并返回内容。';
    } else if (kind === 'test-image') {
      await api.testImage(controller.signal);
      message.value = '测试成功，图片生成模型可以完成遮罩编辑。';
    } else message.value = '设置已保存。';
  } catch (e) {
    if (token === epoch)
      message.value = (e as Error).name === 'AbortError' ? '已取消' : (e as Error).message;
  } finally {
    if (token === epoch) busy.value = '';
  }
}
onBeforeUnmount(() => controller?.abort());
</script>
<template>
  <el-dialog
    v-model="open"
    title="AI 模型设置"
    width="480px"
    align-center
    :close-on-click-modal="false"
    ><p class="hint">独立保存于 Slice Studio 后端，不读取旧项目的密钥。</p>
    <el-form label-position="top"
      ><el-form-item label="Base URL"
        ><el-input
          v-model="form.baseUrl"
          placeholder="http://localhost:8080"
          :disabled="!!busy" /></el-form-item
      ><el-form-item :label="hasKey ? 'API Key（已保存，留空保留）' : 'API Key'"
        ><el-input
          v-model="form.apiKey"
          type="password"
          show-password
          autocomplete="new-password"
          :disabled="!!busy" /></el-form-item
      ><el-form-item label="图片理解模型"
        ><el-select
          v-model="form.model"
          filterable
          allow-create
          default-first-option
          placeholder="输入或获取模型"
          :disabled="!!busy"
          ><el-option
            v-for="m in models"
            :key="m"
            :label="m"
            :value="m" /></el-select></el-form-item
      ><el-form-item label="图片生成模型"
        ><el-select
          v-model="form.imageModel"
          filterable
          allow-create
          default-first-option
          placeholder="输入或从模型列表选择，例如 gpt-image-2.5"
          :disabled="!!busy"
          ><el-option
            v-for="m in models"
            :key="'image-' + m"
            :label="m"
            :value="m" /></el-select></el-form-item
      ><el-form-item label="图片生成质量"
        ><el-select v-model="form.imageQuality" aria-label="图片生成质量" :disabled="!!busy">
          <el-option label="自动" value="auto" />
          <el-option label="低" value="low" />
          <el-option label="中" value="medium" />
          <el-option label="高" value="high" />
          <el-option label="超高" value="xhigh" />
          <el-option label="最高" value="max" />
        </el-select>
        <p class="hint">
          质量越高，透明边缘和材质细节通常越好，费用和等待时间也会增加。
        </p></el-form-item
      ><el-form-item label="请求超时（秒）"
        ><el-input-number
          v-model="form.timeoutSeconds"
          :min="10"
          :max="1800"
          :disabled="!!busy" /></el-form-item
    ></el-form>
    <div class="secondary-actions">
      <el-button :loading="busy === 'models'" :disabled="!!busy" @click="action('models')"
        >获取模型</el-button
      ><el-button
        :loading="busy === 'test'"
        :disabled="!!busy || !form.model"
        @click="action('test')"
        >测试图片理解</el-button
      ><el-button
        :loading="busy === 'test-image'"
        :disabled="!!busy || !form.imageModel"
        @click="action('test-image')"
        >测试图片生成</el-button
      >
    </div>
    <p v-if="message" class="inline-message" role="status">{{ message }}</p>
    <template #footer
      ><el-button v-if="busy" @click="controller?.abort()">取消请求</el-button
      ><el-button @click="open = false">关闭</el-button
      ><el-button
        type="primary"
        :loading="busy === 'save'"
        :disabled="!!busy || !form.model"
        @click="action('save')"
        >保存设置</el-button
      ></template
    ></el-dialog
  >
</template>
