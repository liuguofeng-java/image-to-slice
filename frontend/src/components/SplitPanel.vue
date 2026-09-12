<script setup lang="ts">
import { computed } from 'vue';
import { Plus, Delete } from '@element-plus/icons-vue';
import { imageUrl } from '../api';
import { availableSystemFonts } from '../text';
import { numberScrub } from '../directives/numberScrub';
import type { SplitController } from '../useSplit';
import type { Candidate, TextStyle } from '../types';
import IconButton from './IconButton.vue';
const props = defineProps<{ controller: SplitController }>();
const vNumberScrub = numberScrub;
const c = props.controller;
const enabled = computed(() => c.candidates.value.filter((x) => x.enabled).length),
  invalidText = computed(() =>
    c.candidates.value.some(
      (row) => row.enabled && row.category === 'text' && !row.text?.content.trim(),
    ),
  ),
  fonts = availableSystemFonts();
let scrubbing = false;
function beginScrub() {
  scrubbing = true;
}
function endScrub() {
  scrubbing = false;
}
function previewCandidate(row: Candidate, patch: Partial<Candidate>) {
  if (scrubbing) c.edit(row.id, patch);
}
function editText(row: Candidate, patch: Partial<TextStyle>) {
  if (row.text) c.edit(row.id, { text: { ...row.text, ...patch } });
}
function previewText(row: Candidate, patch: Partial<TextStyle>) {
  if (scrubbing) editText(row, patch);
}
function scrubInput(event: CustomEvent<number>) {
  const target = event.target as HTMLElement,
    value = event.detail,
    key = target.dataset.scrubKey,
    id = target.dataset.scrubId;
  if (!id || !key || !Number.isFinite(value)) return;
  const row = c.candidates.value.find((candidate) => candidate.id === id);
  if (!row) return;
  if (target.dataset.scrubScope === 'candidate') previewCandidate(row, { [key]: value });
  else if (target.dataset.scrubScope === 'candidate-text') {
    if (key === 'fontSize') previewText(row, { fontSize: value });
    if (key === 'lineHeight') previewText(row, { lineHeight: value });
    if (key === 'letterSpacing') previewText(row, { letterSpacing: value });
  }
}
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
  <div
    class="split-panel"
    @numberscrubstart="beginScrub"
    @numberscrubinput="scrubInput"
    @numberscrubend="endScrub"
  >
    <section class="property-section">
      <div class="section-heading">
        <h2>AI 框选拆图</h2>
        <span class="badge">原像素</span>
      </div>
      <p class="hint">识别矩形元素；文字会创建为可编辑文字图层，其他候选仍裁成图片。</p>
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
        <el-select
          :model-value="row.category"
          :aria-label="'候选 ' + (i + 1) + ' 类型'"
          :disabled="c.applying.value"
          @change="(value: any) => c.edit(row.id, { category: value })"
        >
          <el-option label="图片" value="image" />
          <el-option label="图标" value="icon" />
          <el-option label="文字" value="text" />
          <el-option label="背景" value="background" />
        </el-select>
        <div class="field-grid">
          <label v-for="key in ['x', 'y', 'width', 'height'] as const" :key="key"
            ><span>{{ { x: 'X', y: 'Y', width: 'W', height: 'H' }[key] }}</span
            ><el-input-number
              v-number-scrub="{ step: 1, precision: 0, min: 0, max: 16384 }"
              data-scrub-scope="candidate"
              :data-scrub-id="row.id"
              :data-scrub-key="key"
              :model-value="row[key]"
              :precision="0"
              :controls="false"
              :min="key === 'x' || key === 'y' ? 0 : 1"
              :aria-label="'候选 ' + (i + 1) + ' ' + key"
              :disabled="c.applying.value"
              @change="(v: any) => c.edit(row.id, { [key]: v || 0 })"
          /></label>
        </div>
        <div v-if="row.category === 'text' && row.text" class="candidate-text-fields">
          <el-input
            :model-value="row.text.content"
            type="textarea"
            :rows="2"
            resize="none"
            :aria-label="'候选 ' + (i + 1) + ' 文字内容'"
            placeholder="输入识别到的文字"
            @input="(value: any) => editText(row, { content: String(value) })"
          />
          <div class="field-grid">
            <label
              ><span>字号</span
              ><el-input-number
                v-number-scrub="{ step: 1, precision: 1, min: 1, max: 2048 }"
                data-scrub-scope="candidate-text"
                :data-scrub-id="row.id"
                data-scrub-key="fontSize"
                :model-value="row.text.fontSize"
                :controls="false"
                :min="1"
                :max="2048"
                aria-label="文字字号"
                @change="(value: any) => editText(row, { fontSize: value || 1 })"
            /></label>
            <label
              ><span>字重</span
              ><el-select
                :model-value="row.text.fontWeight"
                aria-label="文字字重"
                @change="(value: any) => editText(row, { fontWeight: Number(value) })"
              >
                <el-option
                  v-for="weight in [300, 400, 500, 600, 700, 800, 900]"
                  :key="weight"
                  :label="weight"
                  :value="weight"
                />
              </el-select>
            </label>
          </div>
          <label class="stacked-field">
            <span>字体</span>
            <el-select
              :model-value="row.text.fontFamily"
              filterable
              aria-label="文字字体"
              @change="(value: any) => editText(row, { fontFamily: String(value) })"
            >
              <el-option v-for="font in fonts" :key="font" :label="font" :value="font" />
            </el-select>
          </label>
          <div class="field-grid">
            <label
              ><span>行高</span
              ><el-input-number
                v-number-scrub="{ step: 0.05, precision: 2, min: 0.5, max: 5 }"
                data-scrub-scope="candidate-text"
                :data-scrub-id="row.id"
                data-scrub-key="lineHeight"
                :model-value="row.text.lineHeight"
                :controls="false"
                :min="0.5"
                :max="5"
                :step="0.1"
                aria-label="文字行高"
                @change="(value: any) => editText(row, { lineHeight: value || 1.2 })"
            /></label>
            <label
              ><span>字距</span
              ><el-input-number
                v-number-scrub="{ step: 0.1, precision: 1, min: -1000, max: 1000 }"
                data-scrub-scope="candidate-text"
                :data-scrub-id="row.id"
                data-scrub-key="letterSpacing"
                :model-value="row.text.letterSpacing"
                :controls="false"
                :min="-1000"
                :max="1000"
                aria-label="文字字距"
                @change="(value: any) => editText(row, { letterSpacing: value || 0 })"
            /></label>
          </div>
          <div class="candidate-text-controls">
            <el-select
              :model-value="row.text.resizeMode"
              aria-label="文字框模式"
              @change="(value: any) => editText(row, { resizeMode: value })"
            >
              <el-option label="自动宽度" value="auto-width" />
              <el-option label="自动高度" value="auto-height" />
              <el-option label="固定尺寸" value="fixed" />
            </el-select>
            <el-select
              :model-value="row.text.align"
              aria-label="文字对齐"
              @change="(value: any) => editText(row, { align: value })"
            >
              <el-option label="左对齐" value="left" />
              <el-option label="居中" value="center" />
              <el-option label="右对齐" value="right" />
            </el-select>
            <el-select
              :model-value="row.text.verticalAlign"
              aria-label="文字垂直对齐"
              @change="(value: any) => editText(row, { verticalAlign: value })"
            >
              <el-option label="顶部" value="top" />
              <el-option label="居中" value="middle" />
              <el-option label="底部" value="bottom" />
            </el-select>
            <el-color-picker
              :model-value="row.text.fill"
              show-alpha
              color-format="hex"
              aria-label="文字颜色"
              @change="(value: any) => value && editText(row, { fill: value })"
            />
          </div>
          <el-checkbox
            :model-value="row.text.fontStyle === 'italic'"
            @change="(value: any) => editText(row, { fontStyle: value ? 'italic' : 'normal' })"
            >斜体</el-checkbox
          >
          <p v-if="!row.text.content.trim()" class="hint error">请输入文字内容后再创建。</p>
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
        :disabled="!c.ready.value || !enabled || invalidText"
        @click="c.apply"
        >创建 {{ enabled }} 个图层</el-button
      ><el-button class="full-button" :disabled="c.applying.value" @click="c.close"
        >退出框选</el-button
      >
    </div>
  </div>
</template>
