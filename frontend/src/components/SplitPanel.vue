<script setup lang="ts">
import { computed } from 'vue';
import { Plus, Delete } from '@element-plus/icons-vue';
import { imageUrl } from '../api';
import type { SplitController } from '../useSplit';
import type { Candidate } from '../types';
import IconButton from './IconButton.vue';
const props = defineProps<{ controller: SplitController }>();
const c = props.controller;
const enabled = computed(() => c.candidates.value.filter((x) => x.enabled).length);
function thumbnail(row: Candidate) {
  const a = c.asset.value;
  if (!a) return {};
  return {
    backgroundImage: `url("${imageUrl(a.id)}")`,
    backgroundSize: `${(a.width * 28) / row.width}px ${(a.height * 28) / row.height}px`,
    backgroundPosition: `${(-row.x * 28) / row.width}px ${(-row.y * 28) / row.height}px`,
  };
}
</script>
<template>
  <div class="split-panel">
    <section class="property-section">
      <div class="section-heading">
        <h2>AI 框选拆图</h2>
        <span class="badge">原像素</span>
      </div>
      <p class="hint">识别矩形元素，裁成独立图片图层。不会抠图、补全背景或重绘。</p>
      <el-button
        v-if="!c.active.value"
        class="full-button"
        :disabled="!c.valid.value"
        @click="c.enter"
        >选择图片后进入框选</el-button
      >
      <template v-else
        ><div class="source-name">{{ c.source.value?.name }}</div>
        <el-button class="full-button" :disabled="c.busy.value || c.applying.value" @click="c.whole"
          >选择整张图片</el-button
        >
        <p class="hint">也可以直接在画布上拖动，框选局部范围。</p>
        <div class="range-summary" v-if="c.region.value">
          <span>发送范围</span
          ><strong>{{ c.region.value.width }} × {{ c.region.value.height }} px</strong
          ><small>X {{ c.region.value.x }} · Y {{ c.region.value.y }}</small>
        </div>
        <div class="model-summary">
          <span>图片理解模型</span><strong>{{ c.model.value }}</strong>
        </div>
        <p class="hint">将向远程 API 发送选区图片，可能产生费用。</p>
        <el-button
          type="primary"
          class="full-button"
          :loading="c.busy.value"
          :disabled="!c.region.value || c.applying.value || c.model.value === '未配置'"
          @click="c.start(false)"
          >开始 AI 分析</el-button
        ><el-button
          class="full-button"
          :disabled="!c.region.value || c.busy.value || c.applying.value"
          @click="c.start(true)"
          >手动框选拆图</el-button
        ><el-button v-if="c.busy.value" class="full-button" @click="c.cancel"
          >取消任务</el-button
        ></template
      >
    </section>
    <section v-if="c.ready.value" class="property-section">
      <div class="section-heading">
        <h2>
          候选结果 <span class="count">{{ c.candidates.value.length }}</span>
        </h2>
        <IconButton
          label="添加候选框"
          :icon="Plus"
          :disabled="c.candidates.value.length >= 200 || c.applying.value"
          @click="c.add"
        />
      </div>
      <p class="hint">拖动候选框调整位置，下面的数值控制原图像素范围。</p>
      <div v-for="(row, i) in c.candidates.value" :key="row.id" class="candidate-card">
        <div class="candidate-heading">
          <el-checkbox
            :model-value="row.enabled"
            :aria-label="'选择候选 ' + (i + 1)"
            :disabled="c.applying.value"
            @change="(v: any) => c.edit(row.id, { enabled: !!v })"
          /><span class="candidate-thumb" :style="thumbnail(row)" /><el-input
            :model-value="row.name"
            :aria-label="'候选 ' + (i + 1) + ' 名称'"
            :disabled="c.applying.value"
            @change="(v: any) => c.edit(row.id, { name: String(v).trim() || '切图' })"
          /><IconButton
            :label="'删除候选 ' + (i + 1)"
            :icon="Delete"
            :disabled="c.applying.value"
            @click="c.candidates.value = c.candidates.value.filter((x) => x.id !== row.id)"
          />
        </div>
        <div class="field-grid">
          <label v-for="key in ['x', 'y', 'width', 'height'] as const" :key="key"
            ><span>{{ { x: 'X', y: 'Y', width: 'W', height: 'H' }[key] }}</span
            ><el-input-number
              :model-value="row[key]"
              :precision="0"
              :controls="false"
              :min="key === 'x' || key === 'y' ? 0 : 1"
              :aria-label="'候选 ' + (i + 1) + ' ' + key"
              :disabled="c.applying.value"
              @change="(v: any) => c.edit(row.id, { [key]: v || 0 })"
          /></label>
        </div>
        <small
          >{{ i + 1 }} ·
          {{
            { text: '文字', image: '图片', icon: '图标', background: '背景' }[row.category]
          }}</small
        >
      </div>
    </section>
    <div v-if="c.message.value" class="inline-message" role="status">{{ c.message.value }}</div>
    <div v-if="c.active.value" class="split-footer">
      <el-button
        type="primary"
        class="full-button"
        :loading="c.applying.value"
        :disabled="!c.ready.value || !enabled"
        @click="c.apply"
        >创建 {{ enabled }} 个图层</el-button
      ><el-button class="full-button" :disabled="c.applying.value" @click="c.close"
        >退出框选</el-button
      >
    </div>
  </div>
</template>
