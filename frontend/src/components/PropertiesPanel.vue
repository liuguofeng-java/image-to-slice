<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  View,
  Hide,
  Lock,
  Unlock,
  CopyDocument,
  Delete,
  RefreshLeft,
  Sort,
  Switch,
  Download,
} from '@element-plus/icons-vue';
import { useEditor } from '../store';
import { imageUrl } from '../api';
import { availableSystemFonts, fitTextLayer } from '../text';
import { numberScrub } from '../directives/numberScrub';
import { buildLayerTree } from '../layerTree';
import IconButton from './IconButton.vue';
import type { Document, TextLayer } from '../types';
import type { LayerTree } from '../layerTree';

const emit = defineEmits<{ export: [kind: 'png' | 'zip' | 'scene']; split: [] }>();
const vNumberScrub = numberScrub;
const store = useEditor(),
  ratio = ref(true),
  fonts = availableSystemFonts();
const textLayer = computed(() => (store.single?.type === 'text' ? store.single : undefined)),
  contentDraft = ref(''),
  missingFont = computed(
    () =>
      !!textLayer.value && !fonts.includes(textLayer.value.fontFamily as (typeof fonts)[number]),
  );
watch(
  () => [textLayer.value?.id, textLayer.value?.content] as const,
  ([, content]) => (contentDraft.value = content || ''),
  { immediate: true },
);

type NumericKey = 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity' | 'radius';
let scrubBefore: Document | undefined;
let scrubTree: LayerTree | undefined;
let scrubWasDirty = false;
function beginScrub() {
  if (store.project && !scrubBefore) {
    scrubBefore = store.doc();
    scrubTree = buildLayerTree(store.layers);
    scrubWasDirty = store.dirty;
  }
}
function endScrub() {
  if (scrubBefore && !store.commitPreview(scrubBefore)) store.dirty = scrubWasDirty;
  scrubBefore = undefined;
  scrubTree = undefined;
}
function number(key: NumericKey, value: number | undefined, live = false) {
  if (value === undefined || !Number.isFinite(value) || !store.single) return;
  const layer = store.single;
  const apply = () => {
    if (key === 'radius' && layer.type !== 'image') return;
    if (layer.type === 'image' && key === 'width' && ratio.value)
      layer.height = (layer.height * value) / layer.width;
    if (layer.type === 'image' && key === 'height' && ratio.value)
      layer.width = (layer.width * value) / layer.height;
    const tree = scrubTree || buildLayerTree(store.layers),
      delta = key === 'x' || key === 'y' ? value - layer[key] : 0;
    (layer as unknown as Record<string, number>)[key] = value;
    if (delta) {
      const moveDescendants = (id: string) => {
        for (const child of tree.nodesById.get(id)?.children || []) {
          (child.layer as unknown as Record<string, number>)[key] += delta;
          moveDescendants(child.layer.id);
        }
      };
      moveDescendants(layer.id);
    }
    if (layer.type === 'text' && (key === 'width' || key === 'height')) {
      if (key === 'width' && layer.resizeMode === 'auto-width') layer.resizeMode = 'auto-height';
      if (key === 'height') layer.resizeMode = 'fixed';
      fitTextLayer(layer);
    }
  };
  if (live) store.preview(apply);
  else store.mutate(apply);
}
function previewNumber(key: NumericKey, value: number | undefined) {
  if (scrubBefore) number(key, value, true);
}
function scrubInput(event: CustomEvent<number>) {
  const target = event.target as HTMLElement,
    value = event.detail,
    key = target.dataset.scrubKey;
  if (!key || !Number.isFinite(value)) return;
  if (target.dataset.scrubScope === 'text') {
    if (key === 'fontSize') previewText({ fontSize: value });
    if (key === 'lineHeight') previewText({ lineHeight: value });
    if (key === 'letterSpacing') previewText({ letterSpacing: value });
  } else if (target.dataset.scrubScope === 'scene') {
    if (key === 'width' || key === 'height') previewSceneNumber(key, value);
  } else previewNumber(key as NumericKey, value);
}
function updateText(values: Partial<TextLayer>, live = false) {
  const layer = textLayer.value;
  if (!layer || layer.locked) return;
  const apply = () => {
    Object.assign(layer, values);
    fitTextLayer(layer);
    if (values.content !== undefined)
      layer.name = values.content.trim().split(/\r?\n/)[0]?.slice(0, 200) || '文字';
  };
  if (live) store.preview(apply);
  else store.mutate(apply);
}
function previewText(values: Partial<TextLayer>) {
  if (scrubBefore) updateText(values, true);
}
function sceneNumber(key: 'width' | 'height', value: number | undefined, live = false) {
  if (value === undefined || !Number.isFinite(value) || !store.scene) return;
  const apply = () => (store.scene![key] = value || 1);
  if (live) store.preview(apply);
  else store.mutate(apply);
}
function previewSceneNumber(key: 'width' | 'height', value: number | undefined) {
  if (scrubBefore) sceneNumber(key, value, true);
}
function commitContent() {
  if (textLayer.value && contentDraft.value !== textLayer.value.content)
    updateText({ content: contentDraft.value });
}
const alignments = [
  ['left', '左对齐', '⇤'],
  ['centerX', '水平居中', '↔'],
  ['right', '右对齐', '⇥'],
  ['top', '顶对齐', '↥'],
  ['centerY', '垂直居中', '↕'],
  ['bottom', '底对齐', '↧'],
  ['spaceX', '水平等距', '⋯'],
  ['spaceY', '垂直等距', '⋮'],
];
</script>

<template>
  <div
    class="properties-panel"
    @numberscrubstart="beginScrub"
    @numberscrubinput="scrubInput"
    @numberscrubend="endScrub"
  >
    <section class="property-section">
      <div class="section-heading">
        <h2>
          {{
            store.selection.length > 1
              ? `已选择 ${store.selection.length} 个图层`
              : store.single
                ? store.single.type === 'text'
                  ? '文字'
                  : '图片'
                : '场景'
          }}
        </h2>
        <div class="inline-actions" v-if="store.single">
          <IconButton
            :label="store.single.hidden ? '显示图层' : '隐藏图层'"
            :icon="store.single.hidden ? Hide : View"
            @click="store.mutate(() => (store.single!.hidden = !store.single!.hidden))"
          /><IconButton
            :label="store.single.locked ? '解锁图层' : '锁定图层'"
            :icon="store.single.locked ? Lock : Unlock"
            @click="store.mutate(() => (store.single!.locked = !store.single!.locked))"
          />
        </div>
      </div>
      <div class="alignment-row">
        <IconButton
          v-for="[kind, label, icon] in alignments"
          :key="kind"
          :label="label"
          :disabled="
            store.selection.filter((layer) => !layer.locked).length <
              (kind.startsWith('space') ? 3 : 2) || store.exclusive
          "
          @click="store.align(kind)"
          >{{ icon }}</IconButton
        >
      </div>
    </section>

    <template v-if="store.single">
      <section class="property-section">
        <el-input
          :model-value="store.single.name"
          aria-label="图层名称"
          :disabled="store.single.locked || store.exclusive"
          @change="
            (value: any) =>
              store.patch(store.single!.id, {
                name: String(value).trim() || (store.single!.type === 'text' ? '文字' : '图片'),
              })
          "
        />
        <div class="field-grid">
          <label v-for="key in ['x', 'y'] as const" :key="key"
            ><span>{{ key.toUpperCase() }}</span
            ><el-input-number
              v-number-scrub="{ step: 1, precision: 2, min: -1000000, max: 1000000 }"
              data-scrub-scope="layer"
              :data-scrub-key="key"
              :model-value="store.single[key]"
              :precision="2"
              :controls="false"
              :min="-1000000"
              :max="1000000"
              :aria-label="key.toUpperCase() + ' 位置'"
              :disabled="store.single.locked || store.exclusive"
              @change="(value: any) => number(key, value)"
          /></label>
        </div>
        <div class="field-grid">
          <label
            ><span>角度</span
            ><el-input-number
              v-number-scrub="{ step: 1, precision: 1, min: -36000, max: 36000 }"
              data-scrub-scope="layer"
              data-scrub-key="rotation"
              :model-value="store.single.rotation"
              :precision="1"
              :controls="false"
              :min="-36000"
              :max="36000"
              aria-label="旋转角度"
              :disabled="store.single.locked || store.exclusive"
              @change="(value: any) => number('rotation', value)"
          /></label>
          <div class="inline-actions">
            <IconButton
              label="水平翻转"
              :icon="Switch"
              :active="store.single.flipX"
              :disabled="store.single.locked || store.exclusive"
              @click="store.patch(store.single!.id, { flipX: !store.single!.flipX })"
            /><IconButton
              label="垂直翻转"
              :icon="Sort"
              :active="store.single.flipY"
              :disabled="store.single.locked || store.exclusive"
              @click="store.patch(store.single!.id, { flipY: !store.single!.flipY })"
            />
          </div>
        </div>
      </section>

      <section v-if="textLayer" class="property-section text-properties">
        <h2>文字</h2>
        <el-input
          v-model="contentDraft"
          type="textarea"
          :rows="3"
          resize="none"
          aria-label="文字内容"
          :disabled="textLayer.locked || store.exclusive"
          @blur="commitContent"
        />
        <label class="stacked-field">
          <span>字体</span>
          <el-select
            :model-value="textLayer.fontFamily"
            filterable
            aria-label="字体"
            :disabled="textLayer.locked || store.exclusive"
            @change="(value: any) => updateText({ fontFamily: String(value) })"
          >
            <el-option
              v-if="missingFont"
              :label="`${textLayer.fontFamily}（不可用）`"
              :value="textLayer.fontFamily"
            />
            <el-option v-for="font in fonts" :key="font" :label="font" :value="font" />
          </el-select>
        </label>
        <p v-if="missingFont" class="hint warning-hint">
          当前设备缺少该字体，画布和导出将回退为无衬线字体。
        </p>
        <div class="field-grid">
          <label
            ><span>字号</span
            ><el-input-number
              v-number-scrub="{ step: 1, precision: 1, min: 1, max: 2048 }"
              data-scrub-scope="text"
              data-scrub-key="fontSize"
              :model-value="textLayer.fontSize"
              :controls="false"
              :min="1"
              :max="2048"
              :precision="1"
              aria-label="字号"
              :disabled="textLayer.locked || store.exclusive"
              @change="(value: any) => updateText({ fontSize: value || 1 })"
          /></label>
          <label
            ><span>字重</span
            ><el-select
              :model-value="textLayer.fontWeight"
              aria-label="字重"
              :disabled="textLayer.locked || store.exclusive"
              @change="(value: any) => updateText({ fontWeight: Number(value) })"
            >
              <el-option
                v-for="weight in [100, 200, 300, 400, 500, 600, 700, 800, 900]"
                :key="weight"
                :label="weight"
                :value="weight"
              />
            </el-select>
          </label>
        </div>
        <div class="field-grid">
          <label
            ><span>行高</span
            ><el-input-number
              v-number-scrub="{ step: 0.05, precision: 2, min: 0.5, max: 5 }"
              data-scrub-scope="text"
              data-scrub-key="lineHeight"
              :model-value="textLayer.lineHeight"
              :controls="false"
              :min="0.5"
              :max="5"
              :step="0.1"
              :precision="2"
              aria-label="行高"
              :disabled="textLayer.locked || store.exclusive"
              @change="(value: any) => updateText({ lineHeight: value || 1.2 })"
          /></label>
          <label
            ><span>字距</span
            ><el-input-number
              v-number-scrub="{ step: 0.1, precision: 1, min: -1000, max: 1000 }"
              data-scrub-scope="text"
              data-scrub-key="letterSpacing"
              :model-value="textLayer.letterSpacing"
              :controls="false"
              :min="-1000"
              :max="1000"
              :precision="1"
              aria-label="字距"
              :disabled="textLayer.locked || store.exclusive"
              @change="(value: any) => updateText({ letterSpacing: value || 0 })"
          /></label>
        </div>
        <div class="text-control-row">
          <el-select
            :model-value="textLayer.resizeMode"
            aria-label="文本框模式"
            :disabled="textLayer.locked || store.exclusive"
            @change="(value: any) => updateText({ resizeMode: value })"
          >
            <el-option label="自动宽度" value="auto-width" />
            <el-option label="自动高度" value="auto-height" />
            <el-option label="固定尺寸" value="fixed" />
          </el-select>
          <IconButton
            label="斜体"
            :icon="RefreshLeft"
            :active="textLayer.fontStyle === 'italic'"
            :disabled="textLayer.locked || store.exclusive"
            @click="
              updateText({ fontStyle: textLayer.fontStyle === 'italic' ? 'normal' : 'italic' })
            "
          />
          <el-color-picker
            :model-value="textLayer.fill"
            show-alpha
            color-format="hex"
            aria-label="文字颜色"
            :disabled="textLayer.locked || store.exclusive"
            @change="(value: any) => value && updateText({ fill: value })"
          />
        </div>
        <div class="text-control-row segmented-controls" aria-label="文字对齐">
          <el-radio-group
            :model-value="textLayer.align"
            size="small"
            :disabled="textLayer.locked || store.exclusive"
            @change="(value: any) => updateText({ align: value })"
          >
            <el-radio-button value="left">左</el-radio-button>
            <el-radio-button value="center">中</el-radio-button>
            <el-radio-button value="right">右</el-radio-button>
          </el-radio-group>
          <el-select
            :model-value="textLayer.verticalAlign"
            aria-label="垂直对齐"
            :disabled="textLayer.locked || store.exclusive"
            @change="(value: any) => updateText({ verticalAlign: value })"
          >
            <el-option label="顶部" value="top" />
            <el-option label="居中" value="middle" />
            <el-option label="底部" value="bottom" />
          </el-select>
        </div>
      </section>

      <section class="property-section">
        <div class="section-heading">
          <h2>尺寸</h2>
          <IconButton
            v-if="store.single.type === 'image'"
            label="锁定宽高比"
            :icon="ratio ? Lock : Unlock"
            :active="ratio"
            @click="ratio = !ratio"
          />
        </div>
        <div class="field-grid">
          <label v-for="key in ['width', 'height'] as const" :key="key"
            ><span>{{ key === 'width' ? 'W' : 'H' }}</span
            ><el-input-number
              v-number-scrub="{ step: 1, precision: 2, min: 0.01, max: 16384 }"
              data-scrub-scope="layer"
              :data-scrub-key="key"
              :model-value="store.single[key]"
              :controls="false"
              :precision="2"
              :min="0.01"
              :max="16384"
              :aria-label="key === 'width' ? '图层宽度' : '图层高度'"
              :disabled="store.single.locked || store.exclusive"
              @change="(value: any) => number(key, value)"
          /></label>
        </div>
        <div v-if="store.single.type === 'image'" class="field-grid">
          <label
            ><span>圆角</span
            ><el-input-number
              v-number-scrub="{ step: 1, precision: 0, min: 0, max: 8192 }"
              data-scrub-scope="layer"
              data-scrub-key="radius"
              :model-value="store.single.radius"
              :controls="false"
              :min="0"
              :max="8192"
              aria-label="圆角"
              :disabled="store.single.locked || store.exclusive"
              @change="(value: any) => number('radius', value)"
          /></label>
        </div>
      </section>

      <section v-if="store.single.type === 'image'" class="property-section">
        <h2>图片</h2>
        <div class="asset-preview">
          <img :src="imageUrl(store.single.assetId)" alt="所选图层原图" />
          <div>
            <strong>{{ store.single.name }}</strong>
            <small
              >{{ store.assets[store.single.assetId]?.width }} ×
              {{ store.assets[store.single.assetId]?.height }} px</small
            >
          </div>
        </div>
        <el-button
          class="full-button"
          :disabled="store.single.hidden || store.single.locked || store.exclusive"
          @click="emit('split')"
          >AI 框选拆图</el-button
        >
        <p class="hint" v-if="store.single.hidden || store.single.locked">
          先显示并解锁图片，才能框选拆图。
        </p>
      </section>

      <section class="property-section">
        <label class="opacity-label"
          >不透明度 <span>{{ Math.round(store.single.opacity * 100) }}%</span></label
        >
        <el-slider
          :model-value="store.single.opacity * 100"
          :disabled="store.single.locked || store.exclusive"
          aria-label="不透明度"
          @change="(value: any) => number('opacity', Number(value) / 100)"
        />
      </section>
    </template>

    <section v-else-if="!store.selection.length && store.scene" class="property-section">
      <h2>{{ store.scene.name }}</h2>
      <div class="field-grid">
        <label v-for="key in ['width', 'height'] as const" :key="key"
          ><span>{{ key === 'width' ? 'W' : 'H' }}</span
          ><el-input-number
            v-number-scrub="{ step: 1, precision: 0, min: 1, max: 16384 }"
            data-scrub-scope="scene"
            :data-scrub-key="key"
            :model-value="store.scene[key]"
            :min="1"
            :max="16384"
            :precision="0"
            :controls="false"
            :aria-label="key === 'width' ? '场景宽度' : '场景高度'"
            @change="(value: any) => sceneNumber(key, value)"
        /></label>
      </div>
      <p class="hint">选择图层以编辑属性。按住空格拖动画布，滚轮缩放。</p>
    </section>

    <section v-if="store.selection.length" class="property-section">
      <div class="secondary-actions">
        <el-button :icon="CopyDocument" :disabled="store.exclusive" @click="store.duplicate"
          >复制</el-button
        >
        <el-button :icon="Delete" :disabled="store.exclusive" @click="store.remove">删除</el-button>
      </div>
    </section>
    <section class="property-section export-section">
      <h2>导出</h2>
      <el-button
        :icon="Download"
        class="full-button"
        :disabled="store.selection.length !== 1 || store.exclusive"
        @click="emit('export', 'png')"
        >导出所选 PNG</el-button
      >
      <el-button
        class="full-button"
        :disabled="!store.selection.length || store.exclusive"
        @click="emit('export', 'zip')"
        >所选图层 ZIP</el-button
      >
      <el-button
        class="full-button"
        :disabled="!store.layers.length || store.exclusive"
        @click="emit('export', 'scene')"
        >导出当前场景</el-button
      >
      <p class="hint">图片保留原始像素密度；文字按设计像素导出。</p>
    </section>
  </div>
</template>
