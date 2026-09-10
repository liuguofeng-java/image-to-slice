<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import { usePanelFocus } from '../composables/use-panel-focus';
import type { SliceAsset, Placement } from '../types/workspace';
import { cropImage } from '../services/workspace-image';
import { replaceSliceCrop } from '../services/slice-crop';
import { assetEditSignature } from '../services/asset-edit-signature';
import { hasProcessedSliceResult, isLockedAiCompleteAsset } from '../state/slice-ai-state.js';
import { getSliceRadii, setSliceCornerRadius } from '../services/slice-geometry.js';
import { normalizeSliceAssetName, reserveSliceAssetName } from '../../core/slice-asset-name.js';
import { api, jsonRequest } from '../api/client';
const props = defineProps<{ asset: SliceAsset; repairPreview?: boolean }>();
const emit = defineEmits<{ close: []; repair: [id: string] }>();
const store = useWorkspaceStore(), panel = ref<HTMLElement>(), error = ref(''), busy = ref(false);
const selected = computed(() => store.selected.length ? store.selected : [props.asset]), multi = computed(() => selected.value.length > 1);
const disabled = computed(() => busy.value || store.saving || selected.value.some(a => a.aiProcessing));
const geometryLocked = computed(() => selected.value.some(isLockedAiCompleteAsset));
const text = computed(() => props.asset.text || {});
const geometry = { x: 'X 坐标', y: 'Y 坐标', width: '宽度', height: '高度' };
const corners = { topLeft: '左上', topRight: '右上', bottomRight: '右下', bottomLeft: '左下' };
const textFields = [{ key: 'fontFamily', label: '字体提示', type: 'text' }, { key: 'fontSize', label: '字号', type: 'number' }, { key: 'fontWeight', label: '字重', type: 'number' }, { key: 'lineHeight', label: '行高', type: 'number' }, { key: 'letterSpacing', label: '字间距', type: 'number' }, { key: 'color', label: '文字颜色', type: 'color' }, { key: 'strokeColor', label: '描边颜色', type: 'color' }, { key: 'strokeWidth', label: '描边宽度', type: 'number' }];
let controller: AbortController | null = null;
usePanelFocus(panel, () => emit('close'));
function shared(field: string, corner = false) { const values = selected.value.map(a => corner ? getSliceRadii(a, store.screen)[field] : a.placement[field as keyof Placement]); return values.every(v => v === values[0]) ? values[0] : ''; }
function value(event: Event) { const input = event.target as HTMLInputElement; return input.type === 'number' ? Number(input.value) : input.value; }
async function update(field: string, next: any) {
  if (disabled.value) return;
  const epoch = store.epoch, original = selected.value.map(assetEditSignature), ids = selected.value.map(a => a.id);
  const copies: SliceAsset[] = selected.value.map(a => JSON.parse(JSON.stringify(a)));
  error.value = ''; busy.value = true;
  try {
    if (field === 'name') {
      const name = normalizeSliceAssetName(next); if (!name) throw new Error('切图名称只能使用英文、数字和下划线，且必须包含英文字母。');
      const used = new Set(store.assets.filter(a => !ids.includes(a.id)).map(a => a.name)); copies.forEach(a => { a.name = reserveSliceAssetName(name, used); });
    } else if (field in geometry) {
      if (geometryLocked.value) return;
      if (!Number.isFinite(next) || (['width', 'height'].includes(field) && next <= 0)) throw new Error('请输入有效尺寸或坐标。');
      const resized = ['width', 'height'].includes(field);
      if (resized && copies.some(hasProcessedSliceResult) && !confirm('调整尺寸会重新裁取原设计图，并清除此图的处理结果。继续？')) return;
      for (const a of copies) {
        a.placement[field as keyof Placement] = next;
        if (resized || !hasProcessedSliceResult(a)) replaceSliceCrop(a, await cropImage(store.image!.dataUrl, a.placement, store.screen));
      }
    } else if (field in corners) copies.forEach(a => setSliceCornerRadius(a, field, next, store.screen));
    else if (field.startsWith('text.')) copies.forEach(a => { a.text = { ...a.text, [field.slice(5)]: next }; });
    else if (field.startsWith('shadow.')) copies.forEach(a => { a.text ||= {}; a.text.shadow = { color: '#000000', opacity: .35, x: 0, y: 2, blur: 4, ...a.text.shadow, [field.slice(7)]: next }; });
    else copies.forEach(a => { a[field] = next; if (field === 'contentType' && next !== 'image') a.regenerateMarked = false; });
    await store.transaction(() => {
      if (epoch !== store.epoch || ids.some((id, i) => assetEditSignature(store.assets.find(a => a.id === id)) !== original[i])) throw new Error('切图已被其他操作修改，请重新调整。');
      copies.forEach(a => { const current = store.assets.find(v => v.id === a.id)!; if (['width', 'height'].includes(field)) store.preserveProcessedVariant(current); Object.keys(current).forEach(key => delete current[key]); Object.assign(current, a); });
    });
  } catch (failure) { error.value = (failure as Error).message; }
  finally { busy.value = false; }
}
async function recognize() {
  if (disabled.value || !confirm('使用图片理解 API 识别当前选区的文字与样式，可能计费。继续？')) return;
  controller = new AbortController(); const request = controller, epoch = store.epoch, signature = JSON.stringify(props.asset); busy.value = true; error.value = '';
  try {
    const result = await api('/api/design/recognize-region', jsonRequest({ imageDataUrl: store.image!.dataUrl, width: store.screen.width, height: store.screen.height, region: props.asset.placement, progressId: 'text_' + crypto.randomUUID() }, request.signal));
    if (request.signal.aborted || epoch !== store.epoch) return;
    if (JSON.stringify(props.asset) !== signature) throw new Error('切图已变化，请重新识别。');
    await store.transaction(() => { props.asset.text = result.text; }); error.value = result.warning || '';
  } catch (failure) { if (!request.signal.aborted) error.value = (failure as Error).message; } finally { busy.value = false; }
}
watch(() => props.asset.id, () => { controller?.abort(); error.value = ''; });
onBeforeUnmount(() => controller?.abort());
</script>
<template>
<aside ref="panel" class="slice-settings-drawer open" tabindex="-1" aria-label="切图设置">
  <header class="slice-settings-head"><div><div class="slice-settings-kicker">切图设置</div><strong class="slice-settings-title">{{ multi ? '已选择 ' + selected.length + ' 个切图' : asset.name }}</strong></div><button class="slice-settings-close" aria-label="关闭切图设置" @click="emit('close')">×</button></header>
  <div class="slice-settings-body" :aria-busy="busy">
    <div class="slice-inspector-section-title">属性</div>
    <label class="slice-settings-field"><span>标题</span><input :value="multi ? '' : asset.name" :placeholder="multi ? '输入后应用到全部' : ''" maxlength="80" :disabled="disabled" @change="update('name', value($event))" @keydown.enter.prevent="($event.target as HTMLInputElement).blur()" /></label>
    <template v-if="!multi"><label class="slice-settings-field"><span>图层类型</span><select :value="asset.contentType === 'text' ? 'text' : 'image'" :disabled="disabled" @change="update('contentType', value($event))"><option value="image">图片</option><option value="text">文字</option></select></label>
      <template v-if="asset.contentType === 'text'"><label class="slice-settings-field"><span>文字内容</span><textarea :value="text.characters" :disabled="disabled" @change="update('text.characters', value($event))" /></label><div class="slice-settings-grid">
        <label v-for="field in textFields" :key="field.key" class="slice-settings-field"><span>{{ field.label }}</span><input :type="field.type" :value="text[field.key] ?? (field.type === 'color' ? '#20232a' : '')" :disabled="disabled" step="any" @change="update('text.' + field.key, value($event))" /></label>
        <label class="slice-settings-field"><span>对齐</span><select :value="text.textAlignHorizontal || 'LEFT'" :disabled="disabled" @change="update('text.textAlignHorizontal', value($event))"><option value="LEFT">左对齐</option><option value="CENTER">居中</option><option value="RIGHT">右对齐</option></select></label>
        <label class="slice-settings-field"><span>阴影</span><select :value="text.shadow ? 'on' : 'off'" :disabled="disabled" @change="update('text.shadow', value($event) === 'on' ? { color: '#000000', opacity: .35, x: 0, y: 2, blur: 4 } : null)"><option value="off">关闭</option><option value="on">开启</option></select></label>
        <template v-if="text.shadow"><label v-for="(label, key) in { color: '阴影颜色', opacity: '阴影透明度', x: '阴影 X', y: '阴影 Y', blur: '阴影模糊' }" :key="key" class="slice-settings-field"><span>{{ label }}</span><input :type="key === 'color' ? 'color' : 'number'" :value="text.shadow[key]" :disabled="disabled" step="any" @change="update('shadow.' + key, value($event))" /></label></template>
      </div><button class="slice-settings-recognize" :disabled="disabled" @click="recognize">重新 AI 识别文字</button></template>
    </template>
    <div class="slice-inspector-section-title">布局</div><div class="slice-settings-grid">
      <label v-for="(label, field) in geometry" :key="field" class="slice-settings-field" :title="geometryLocked ? 'AI 完整图保留原位置，拖动时创建原始图副本' : ''"><span>{{ label }}</span><input type="number" :value="shared(field)" :placeholder="multi ? '混合' : ''" :disabled="disabled || geometryLocked" step="any" @change="update(field, value($event))" /></label>
      <label v-for="(label, field) in corners" :key="field" class="slice-settings-field"><span>{{ label }}</span><input type="number" :value="shared(field, true)" :placeholder="multi ? '混合' : ''" :disabled="disabled" min="0" @change="update(field, value($event))" /></label>
      <div v-if="!multi && ['image', 'background'].includes(asset.contentType)" class="slice-ai-complete-action"><span>遮挡补齐</span><button :disabled="disabled" :class="{ confirm: repairPreview }" @click="emit('repair', asset.id)">{{ repairPreview ? '确认补齐红色区域' : 'AI补齐' }}</button></div>
    </div>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <div class="slice-settings-note">{{ multi ? '修改后的值会应用到全部 ' + selected.length + ' 个已选切图。' : 'AI补齐会先将与其他切图重叠的区域标红；确认后只替换红色区域，其他像素保持不变。' }}</div>
    <button class="slice-settings-delete" :disabled="disabled" @click="store.remove(selected.map(a => a.id)); emit('close')">{{ multi ? '删除选中的 ' + selected.length + ' 个切图' : '删除切图' }}</button>
  </div>
</aside>
</template>
