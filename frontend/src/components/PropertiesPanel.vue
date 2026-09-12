<script setup lang="ts">
import { ref } from 'vue';
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
import IconButton from './IconButton.vue';
import type { Layer } from '../types';
const emit = defineEmits<{ export: [kind: 'png' | 'zip' | 'scene']; split: [] }>();
const store = useEditor(),
  ratio = ref(true);
function number(key: keyof Layer, value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || !store.single) return;
  const l = store.single,
    patch: Partial<Layer> = { [key]: value };
  if (ratio.value && key === 'width') patch.height = (l.height * value) / l.width;
  if (ratio.value && key === 'height') patch.width = (l.width * value) / l.height;
  store.patch(l.id, patch);
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
  <div class="properties-panel">
    <section class="property-section">
      <div class="section-heading">
        <h2>
          {{
            store.selection.length > 1
              ? `已选择 ${store.selection.length} 个图层`
              : store.single
                ? '图片'
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
            store.selection.filter((l) => !l.locked).length < (kind.startsWith('space') ? 3 : 2) ||
            store.exclusive
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
          @change="(v: any) => store.patch(store.single!.id, { name: String(v).trim() || '图片' })"
        />
        <div class="field-grid">
          <label v-for="key in ['x', 'y'] as const" :key="key"
            ><span>{{ key.toUpperCase() }}</span
            ><el-input-number
              :model-value="store.single[key]"
              :precision="2"
              :controls="false"
              :min="-1000000"
              :max="1000000"
              :aria-label="key.toUpperCase() + ' 位置'"
              :disabled="store.single.locked || store.exclusive"
              @change="(v: any) => number(key, v)"
          /></label>
        </div>
        <div class="field-grid">
          <label
            ><span>角度</span
            ><el-input-number
              :model-value="store.single.rotation"
              :precision="1"
              :controls="false"
              :min="-36000"
              :max="36000"
              aria-label="旋转角度"
              :disabled="store.single.locked || store.exclusive"
              @change="(v: any) => number('rotation', v)"
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
      <section class="property-section">
        <div class="section-heading">
          <h2>尺寸</h2>
          <IconButton
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
              :model-value="store.single[key]"
              :controls="false"
              :precision="2"
              :min="0.01"
              :max="16384"
              :aria-label="key === 'width' ? '图层宽度' : '图层高度'"
              :disabled="store.single.locked || store.exclusive"
              @change="(v: any) => number(key, v)"
          /></label>
        </div>
        <div class="field-grid">
          <label
            ><span>圆角</span
            ><el-input-number
              :model-value="store.single.radius"
              :controls="false"
              :min="0"
              :max="8192"
              aria-label="圆角"
              :disabled="store.single.locked || store.exclusive"
              @change="(v: any) => number('radius', v)"
          /></label>
        </div>
      </section>
      <section class="property-section">
        <h2>图片</h2>
        <div class="asset-preview">
          <img :src="imageUrl(store.single.assetId)" alt="所选图层原图" />
          <div>
            <strong>{{ store.single.name }}</strong
            ><small
              >{{ store.assets[store.single.assetId]?.width }} ×
              {{ store.assets[store.single.assetId]?.height }} px</small
            >
          </div>
        </div>
        <label class="opacity-label"
          >不透明度 <span>{{ Math.round(store.single.opacity * 100) }}%</span></label
        ><el-slider
          :model-value="store.single.opacity * 100"
          :disabled="store.single.locked || store.exclusive"
          aria-label="不透明度"
          @change="(v: any) => number('opacity', Number(v) / 100)"
        />
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
    </template>
    <section v-else-if="!store.selection.length && store.scene" class="property-section">
      <h2>{{ store.scene.name }}</h2>
      <div class="field-grid">
        <label v-for="key in ['width', 'height'] as const" :key="key"
          ><span>{{ key === 'width' ? 'W' : 'H' }}</span
          ><el-input-number
            :model-value="store.scene[key]"
            :min="1"
            :max="16384"
            :precision="0"
            :controls="false"
            :aria-label="key === 'width' ? '场景宽度' : '场景高度'"
            @change="(v: any) => store.mutate(() => (store.scene![key] = v || 1))"
        /></label>
      </div>
      <p class="hint">选择图片以编辑属性。按住空格拖动画布，滚轮缩放。</p>
    </section>
    <section v-if="store.selection.length" class="property-section">
      <div class="secondary-actions">
        <el-button :icon="CopyDocument" :disabled="store.exclusive" @click="store.duplicate"
          >复制</el-button
        ><el-button :icon="Delete" :disabled="store.exclusive" @click="store.remove"
          >删除</el-button
        >
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
      ><el-button
        class="full-button"
        :disabled="!store.selection.length || store.exclusive"
        @click="emit('export', 'zip')"
        >所选图层 ZIP</el-button
      ><el-button
        class="full-button"
        :disabled="!store.layers.length || store.exclusive"
        @click="emit('export', 'scene')"
        >导出当前场景</el-button
      >
      <p class="hint">单图保留原始像素密度，不受画布缩放影响。</p>
    </section>
  </div>
</template>
