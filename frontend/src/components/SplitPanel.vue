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
  imageCalls = computed(
    () =>
      (c.generateSource.value ? 1 : 0) +
      c.candidates.value.filter(
        (row) => row.enabled && row.category !== 'text' && row.generate !== false,
      ).length,
  ),
  generationOptions = computed(
    () => 1 + c.candidates.value.filter((row) => row.enabled && row.category !== 'text').length,
  ),
  allGeneration = computed(() => imageCalls.value === generationOptions.value),
  someGeneration = computed(() => imageCalls.value > 0 && !allGeneration.value),
  reviewable = computed(() => c.ready.value || !!c.job.value?.generation),
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
    <section v-if="reviewable" class="property-section">
      <div class="section-heading">
        <h2>
          候选结果 <span class="count">{{ c.candidates.value.length }}</span>
        </h2>
        <IconButton
          label="添加候选框"
          :icon="Plus"
          :disabled="c.applying.value || c.generationLocked.value"
          @click="c.add"
        />
      </div>
      <p class="hint">确认每项是程序字体还是图片；提交前仍可调整原图像素范围。</p>
      <el-checkbox
        class="generation-select-all"
        :model-value="allGeneration"
        :indeterminate="someGeneration"
        :disabled="c.applying.value || c.generationLocked.value"
        @change="(value: any) => c.setAllGeneration(!!value)"
        >AI 生成全选 / 取消</el-checkbox
      >
      <div class="candidate-card source-target-card">
        <div class="candidate-heading">
          <el-checkbox
            :model-value="c.generateSource.value"
            aria-label="原始父图参与 AI 生成"
            :disabled="c.applying.value || c.generationLocked.value"
            @change="(value: any) => c.setGenerateSource(!!value)"
          />
          <span class="candidate-thumb source-target-thumb" />
          <strong>{{ c.source.value?.name }}</strong>
          <span class="badge">{{ c.generateSource.value ? 'AI 生成' : '保留原图' }}</span>
        </div>
        <small>勾选后补全移除子节点后的背景；取消后直接保留原始父图。</small>
      </div>
      <div
        v-for="(row, i) in c.candidates.value"
        :key="row.id"
        class="candidate-card"
        :class="{ 'is-selected': c.selectedCandidateId.value === row.id }"
        @click="c.selectCandidate(row.id)"
      >
        <div class="candidate-heading">
          <el-checkbox
            :model-value="row.enabled"
            :aria-label="'选择候选 ' + (i + 1)"
            :disabled="c.applying.value || c.generationLocked.value"
            @change="(v: any) => c.edit(row.id, { enabled: !!v })"
          /><span class="candidate-thumb" :style="thumbnail(row)" /><el-input
            :model-value="row.name"
            :aria-label="'候选 ' + (i + 1) + ' 名称'"
            :disabled="c.applying.value || c.generationLocked.value"
            @change="(v: any) => c.edit(row.id, { name: String(v).trim() || '切图' })"
          /><IconButton
            :label="'删除候选 ' + (i + 1)"
            :icon="Delete"
            :disabled="c.applying.value || c.generationLocked.value"
            @click="c.remove(row.id)"
          />
        </div>
        <el-select
          :model-value="row.category === 'text' ? 'text' : 'image'"
          :aria-label="'候选 ' + (i + 1) + ' 类型'"
          :disabled="c.applying.value || c.generationLocked.value"
          @change="
            (value: any) => c.edit(row.id, { category: value === 'text' ? 'text' : 'image' })
          "
        >
          <el-option label="图片" value="image" />
          <el-option label="程序字体（可编辑）" value="text" />
        </el-select>
        <el-checkbox
          v-if="row.category !== 'text'"
          class="candidate-generation-choice"
          :model-value="row.generate !== false"
          :disabled="!row.enabled || c.applying.value || c.generationLocked.value"
          @change="(value: any) => c.edit(row.id, { generate: !!value })"
          >参与 AI 生成；取消则本地裁切</el-checkbox
        >
        <label v-if="row.category !== 'text'" class="stacked-field">
          <span>透明材质</span>
          <el-select
            :model-value="row.renderIntent?.alphaMode || 'cutout'"
            :aria-label="'候选 ' + (i + 1) + ' 透明材质'"
            :disabled="c.applying.value || c.generationLocked.value"
            @change="
              (value: any) =>
                c.edit(row.id, {
                  renderIntent: {
                    alphaMode: value,
                    visualDescription: row.renderIntent?.visualDescription || '',
                  },
                })
            "
          >
            <el-option label="不透明背景" value="opaque" />
            <el-option label="透明抠图" value="cutout" />
            <el-option label="半透明材质" value="translucent" />
          </el-select>
        </label>
        <p
          v-if="row.category !== 'text' && row.renderIntent?.visualDescription"
          class="hint candidate-render-intent"
        >
          AI 材质判断：{{ row.renderIntent.visualDescription }}
        </p>
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
              :disabled="c.applying.value || c.generationLocked.value"
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
            :disabled="c.applying.value || c.generationLocked.value"
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
                :disabled="c.applying.value || c.generationLocked.value"
                @change="(value: any) => editText(row, { fontSize: value || 1 })"
            /></label>
            <label
              ><span>字重</span
              ><el-select
                :model-value="row.text.fontWeight"
                aria-label="文字字重"
                :disabled="c.applying.value || c.generationLocked.value"
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
              :disabled="c.applying.value || c.generationLocked.value"
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
                :disabled="c.applying.value || c.generationLocked.value"
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
                :disabled="c.applying.value || c.generationLocked.value"
                @change="(value: any) => editText(row, { letterSpacing: value || 0 })"
            /></label>
          </div>
          <div class="candidate-text-controls">
            <el-select
              :model-value="row.text.resizeMode"
              aria-label="文字框模式"
              :disabled="c.applying.value || c.generationLocked.value"
              @change="(value: any) => editText(row, { resizeMode: value })"
            >
              <el-option label="自动宽度" value="auto-width" />
              <el-option label="自动高度" value="auto-height" />
              <el-option label="固定尺寸" value="fixed" />
            </el-select>
            <el-select
              :model-value="row.text.align"
              aria-label="文字对齐"
              :disabled="c.applying.value || c.generationLocked.value"
              @change="(value: any) => editText(row, { align: value })"
            >
              <el-option label="左对齐" value="left" />
              <el-option label="居中" value="center" />
              <el-option label="右对齐" value="right" />
            </el-select>
            <el-select
              :model-value="row.text.verticalAlign"
              aria-label="文字垂直对齐"
              :disabled="c.applying.value || c.generationLocked.value"
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
              :disabled="c.applying.value || c.generationLocked.value"
              @change="(value: any) => value && editText(row, { fill: value })"
            />
          </div>
          <el-checkbox
            :model-value="row.text.fontStyle === 'italic'"
            :disabled="c.applying.value || c.generationLocked.value"
            @change="(value: any) => editText(row, { fontStyle: value ? 'italic' : 'normal' })"
            >斜体</el-checkbox
          >
          <p v-if="!row.text.content.trim()" class="hint error">请输入文字内容后再创建。</p>
        </div>
        <small>{{ i + 1 }} · {{ row.category === 'text' ? '程序字体' : '图片' }}</small>
      </div>
      <div class="generation-summary">
        <div>
          <span>图片生成模型</span><strong>{{ c.imageModel.value }}</strong>
        </div>
        <div>
          <span>预计远程调用</span><strong>{{ imageCalls }} 次</strong>
        </div>
        <p class="hint">已勾选的父图和图片各 1 次；未勾选图片本地裁切；程序字体本地创建。</p>
      </div>
      <div v-if="c.job.value?.generation" class="generation-progress" aria-live="polite">
        <div class="generation-progress-heading">
          <strong>生成进度</strong>
          <span>{{ c.job.value.generation.completed }} / {{ c.job.value.generation.total }}</span>
        </div>
        <el-progress
          :percentage="
            c.job.value.generation.total
              ? Math.round((c.job.value.generation.completed / c.job.value.generation.total) * 100)
              : 100
          "
          :stroke-width="8"
          :show-text="false"
        />
        <div
          v-for="target in c.job.value.generation.targets"
          :key="target.id"
          class="generation-target"
          :data-status="target.status"
        >
          <span class="generation-dot" />
          <span>{{ target.name }}</span>
          <small>{{ target.message }}</small>
        </div>
      </div>
    </section>
    <div v-if="c.message.value" class="inline-message" role="status">{{ c.message.value }}</div>
    <div v-if="c.active.value" class="split-footer">
      <el-button
        type="primary"
        class="full-button"
        :loading="c.applying.value"
        :disabled="
          !c.canGenerate.value ||
          !enabled ||
          invalidText ||
          (imageCalls > 0 && c.imageModel.value === '未配置')
        "
        @click="c.apply"
        >{{
          c.job.value?.generation
            ? c.job.value.generation.failed
              ? `重试 ${c.job.value.generation.failed} 个失败项`
              : '重试提交（0 次调用）'
            : imageCalls
              ? `生成并创建 ${enabled} 个图层（${imageCalls} 次调用）`
              : `本地创建 ${enabled} 个图层（0 次调用）`
        }}</el-button
      ><el-button v-if="c.applying.value" class="full-button" @click="c.cancelGeneration"
        >取消生成</el-button
      ><el-button class="full-button" :disabled="c.applying.value" @click="c.close"
        >退出框选</el-button
      >
    </div>
  </div>
</template>
