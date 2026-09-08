<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { calculateTrimBounds, defaultTrimSettings, trimImage, type TrimSettings } from '../services/trim-image';
import {
  applyAlphaMatte,
  combineMasks,
  createAlphaMatte,
  createLabPixels,
  createWandMask,
  fillMaskHoles,
  invertMask
} from '../services/cutout-mask';
import type {
  CutoutCombineMode,
  CutoutEditorMode,
  CutoutEditorBackend,
  CutoutEditorSnapshot,
  CutoutPreviewBackground,
  CutoutSettings,
  CutoutTool,
  ImageEditorOperation,
  ImageEditorSaveResult,
  SamCandidate,
  SamPoint
} from '../types/cutout-editor';

const props = defineProps<{
  backend: CutoutEditorBackend;
  commit: (result: ImageEditorSaveResult) => Promise<void>;
}>();
const emit = defineEmits<{ close: [] }>();

interface EditorCheckpoint {
  trim: TrimSettings;
  mode: CutoutEditorMode;
  cutoutDraft: Uint8Array;
  repairDraft: Uint8Array;
  source: ImageData;
  selection: Uint8Array;
  settings: CutoutSettings;
  operations: ImageEditorOperation[];
  stateId: number;
}
const visible = ref(false);
const dialog = ref<HTMLElement>();
const viewport = ref<HTMLElement>();
const baseCanvas = ref<HTMLCanvasElement>();
const resultCanvas = ref<HTMLCanvasElement>();
const overlayCanvas = ref<HTMLCanvasElement>();
const image = ref<HTMLImageElement>();
const source = ref<ImageData>();
const labs = ref<Float32Array>();
const selection = ref(new Uint8Array());
const candidates = ref<SamCandidate[]>([]);
const candidateMasks = ref<Uint8Array[]>([]);
const selectedCandidate = ref(0);
const points = ref<SamPoint[]>([]);
const tool = ref<CutoutTool>('smart');
const combine = ref<CutoutCombineMode>('replace');
const previewBackground = ref<CutoutPreviewBackground>('checker');
const zoom = ref(1);
const status = ref('');
const error = ref('');
const samBusy = ref(false);
const samAvailable = ref(false);
const sessionId = ref('');
const requestRevision = ref(0);
const dirty = ref(false);
const showUnsaved = ref(false);
const snapshot = ref<CutoutEditorSnapshot>();
const history = ref<EditorCheckpoint[]>([]);
const future = ref<EditorCheckpoint[]>([]);
const operations = ref<ImageEditorOperation[]>([]);
const trim = reactive(defaultTrimSettings());
let trimBefore: EditorCheckpoint | undefined;
const maskRevision = ref(0);
const mode = ref<CutoutEditorMode>('cutout');
const localBusy = ref(false);
const localHealthState = ref<Record<string, any>>({});
const localHealthChecked = ref(false);
const localProgressId = ref('');
const upscaleScale = ref<2 | 4>(2);
const compareOriginal = ref(false);
const originalImage = ref<HTMLImageElement>();
const saving = ref(false);
const applying = ref(false);
const previewResult = ref(false);
const panelOpen = ref(false);
const pendingRepairSave = ref(false);
const cutoutDraft = ref(new Uint8Array());
const repairDraft = ref(new Uint8Array());
const spaceHeld = ref(false);
const zoomStrategy = ref<'initial' | 'fit' | 'manual'>('initial');
const busy = computed(() => localBusy.value || samBusy.value || saving.value || applying.value);
const isBrush = computed(() => tool.value === 'brush-add' || tool.value === 'brush-subtract');
const hasRepairDraft = computed(() => mode.value === 'repair' ? hasSelection.value : repairDraft.value.some(Boolean));
const toolHint = computed(() => mode.value === 'upscale' ? '提高图片像素，设计尺寸保持不变。'
  : tool.value === 'wand' ? '点击颜色区域；Shift 添加，Alt 减去。'
  : isBrush.value ? (mode.value === 'repair' ? '涂红需要移除的内容，擦除误选区域。' : '涂抹保留主体，擦除多余选区。')
  : tool.value === 'rect' ? '拖动框选需要移除的内容；Shift 添加，Alt 减去。'
  : '点击保留主体，添加排除点修正背景。');
let edgeBefore: EditorCheckpoint | undefined;
let resizeObserver: ResizeObserver | undefined;
let previousFocus: HTMLElement | null = null;
let editorGeneration = 0;
let drawing = false;
let drawingAdds = true;
let lastPoint: { x: number; y: number } | null = null;
let panning: { x: number; y: number; left: number; top: number } | null = null;
let rectangleStart: { x: number; y: number } | null = null;
let rectangleBase: Uint8Array | null = null;
let march = 0;
let marchTimer: ReturnType<typeof setInterval> | undefined;
let nextStateId = 1;
let currentStateId = 0;

const settings = reactive<CutoutSettings>({
  tolerance: 20,
  contiguous: true,
  fillHoles: true,
  expand: 0,
  feather: 1,
  decontaminate: 0,
  brushSize: 24,
  brushHardness: 80,
  repairExpand: 3,
  repairFeather: 2
});
const dimensions = computed(() => ({ width: source.value?.width || 1, height: source.value?.height || 1 }));
const cutoutPixels = computed(() => {
  maskRevision.value;
  if (!source.value) return undefined;
  return mode.value === 'cutout' && hasSelection.value
    ? applyAlphaMatte(source.value, createAlphaMatte(selection.value, dimensions.value.width, dimensions.value.height, settings), dimensions.value.width, dimensions.value.height, settings.decontaminate)
    : source.value;
});
const trimPlan = computed(() => {
  if (mode.value !== 'cutout' || !trim.enabled || !cutoutPixels.value) return { bounds: undefined, error: '' };
  try { return { bounds: calculateTrimBounds(cutoutPixels.value, trim), error: '' }; }
  catch (failure) { return { bounds: undefined, error: (failure as Error).message }; }
});
const trimmedPixels = computed(() => trimPlan.value.bounds && cutoutPixels.value ? trimImage(cutoutPixels.value, trimPlan.value.bounds) : undefined);
const displayDimensions = computed(() => previewResult.value && !compareOriginal.value && trimPlan.value.bounds
  ? trimPlan.value.bounds : dimensions.value);
const trimFrameStyle = computed(() => {
  const bounds = trimPlan.value.bounds;
  return bounds ? { left: `${bounds.left * zoom.value}px`, top: `${bounds.top * zoom.value}px`, width: `${bounds.width * zoom.value}px`, height: `${bounds.height * zoom.value}px` } : {};
});
const stageStyle = computed(() => ({
  width: `${displayDimensions.value.width * zoom.value}px`,
  height: `${displayDimensions.value.height * zoom.value}px`
}));
const canUndo = computed(() => history.value.length > 0);
const canRedo = computed(() => future.value.length > 0);
const canSave = computed(() => !trimPlan.value.error && (operations.value.length > 0 || (mode.value === 'cutout' && (hasSelection.value || trim.enabled)))
  && !busy.value);
const hasSelection = computed(() => {
  maskRevision.value;
  return selection.value.some(Boolean);
});
const recommendedUpscaleScale = computed<2 | 4>(() => (
  Math.min(dimensions.value.width, dimensions.value.height) < 128 ? 4 : 2
));
const localAvailable = computed(() => {
  if (!localHealthChecked.value) return false;
  if (mode.value === 'repair') {
    return Boolean(localHealthState.value.iopaintRootFound
      && localHealthState.value.lamaModelFound
      && localHealthState.value.pythonDependenciesFound !== false);
  }
  if (mode.value === 'upscale') {
    return Boolean(localHealthState.value.realesrganRootFound
      && localHealthState.value.realesrganModelFound
      && localHealthState.value.pythonDependenciesFound !== false);
  }
  return true;
});

function localModeError() {
  if (!localHealthChecked.value) return '';
  const health = localHealthState.value;
  if (health.pythonDependenciesFound === false) return String(health.error || '本地图像处理 Python 依赖不可用。');
  if (mode.value === 'repair') {
    if (!health.iopaintRootFound) return `IOPaint 目录不存在：${health.iopaintRoot || '请配置 IOPAINT_ROOT'}`;
    if (!health.lamaModelFound) return `LaMa 权重不存在：${health.lamaModelPath || '请配置 LAMA_MODEL_PATH'}`;
  }
  if (mode.value === 'upscale') {
    if (!health.realesrganRootFound) return `Real-ESRGAN 目录不存在：${health.realesrganRoot || '请配置 REALESRGAN_ROOT'}`;
    if (!health.realesrganModelFound) return `Real-ESRGAN 权重不存在：${health.realesrganModelPath || '请配置 REALESRGAN_MODEL_PATH'}`;
  }
  return '';
}

function loadHtmlImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error('无法读取切图图片'));
    element.src = dataUrl;
  });
}

async function maskFromDataUrl(dataUrl: string) {
  const element = await loadHtmlImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = dimensions.value.width; canvas.height = dimensions.value.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('无法读取选区蒙版');
  context.drawImage(element, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const mask = new Uint8Array(canvas.width * canvas.height);
  for (let index = 0; index < mask.length; index++) mask[index] = pixels[index * 4] ?? 0;
  return mask;
}

function maskToDataUrl(mask: Uint8Array) {
  const canvas = document.createElement('canvas');
  canvas.width = dimensions.value.width; canvas.height = dimensions.value.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法保存选区蒙版');
  const pixels = context.createImageData(canvas.width, canvas.height);
  for (let index = 0; index < mask.length; index++) {
    pixels.data.fill(mask[index] ?? 0, index * 4, index * 4 + 3);
    pixels.data[index * 4 + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/png');
}

function effectiveSelection() {
  if (mode.value !== 'cutout' || !settings.fillHoles) return selection.value;
  return fillMaskHoles(selection.value, dimensions.value.width, dimensions.value.height);
}

function render(overlayOnly = false) {
  if (!source.value || !baseCanvas.value || !resultCanvas.value || !overlayCanvas.value) return;
  const { width, height } = displayDimensions.value;
  for (const canvas of [baseCanvas.value, resultCanvas.value, overlayCanvas.value]) {
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  }
  if (!overlayOnly) {
  baseCanvas.value.getContext('2d')?.putImageData(source.value, 0, 0);
  const result = mode.value === 'cutout' && previewResult.value
    ? trimmedPixels.value || cutoutPixels.value || source.value : source.value;
  const resultContext = resultCanvas.value.getContext('2d');
  if (compareOriginal.value && originalImage.value && resultContext) {
    resultContext.clearRect(0, 0, width, height);
    resultContext.drawImage(originalImage.value, 0, 0, width, height);
  } else {
    resultContext?.putImageData(result, 0, 0);
  }
  }
  const context = overlayCanvas.value.getContext('2d');
  if (!context) return;
  const output = context.createImageData(width, height);
  const mask = effectiveSelection();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    if (!compareOriginal.value && !previewResult.value && mode.value !== 'upscale' && (mask[index] ?? 0) > 0) {
      const offset = index * 4;
      if (mode.value === 'repair') {
        output.data[offset] = 239; output.data[offset + 1] = 68; output.data[offset + 2] = 68;
      } else {
        output.data[offset] = 20; output.data[offset + 1] = 115; output.data[offset + 2] = 255;
      }
      output.data[offset + 3] = 64;
      const boundary = x === 0 || y === 0 || x + 1 === width || y + 1 === height
        || !(mask[index - 1] ?? 0) || !(mask[index + 1] ?? 0)
        || !(mask[index - width] ?? 0) || !(mask[index + width] ?? 0);
      if (boundary) {
        const light = (x + y + march) % 8 < 4;
        output.data[offset] = output.data[offset + 1] = output.data[offset + 2] = light ? 255 : 15;
        output.data[offset + 3] = 255;
      }
    }
  }
  context.putImageData(output, 0, 0);
}

function currentSourceDataUrl() {
  if (!source.value) return '';
  const canvas = document.createElement('canvas');
  canvas.width = source.value.width; canvas.height = source.value.height;
  canvas.getContext('2d')?.putImageData(source.value, 0, 0);
  return canvas.toDataURL('image/png');
}

async function replaceWorkingImage(dataUrl: string, isCurrent: () => boolean = () => true) {
  const element = await loadHtmlImage(dataUrl);
  if (!isCurrent()) return false;
  image.value = element;
  const canvas = document.createElement('canvas');
  canvas.width = element.naturalWidth; canvas.height = element.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('无法读取本地图像处理结果');
  context.drawImage(element, 0, 0);
  source.value = context.getImageData(0, 0, canvas.width, canvas.height);
  labs.value = createLabPixels(source.value);
  selection.value = new Uint8Array(canvas.width * canvas.height);
  cutoutDraft.value = new Uint8Array(); repairDraft.value = new Uint8Array();
  maskRevision.value++;
  const previousSessionId = sessionId.value;
  requestRevision.value++;
  sessionId.value = '';
  candidates.value = [];
  candidateMasks.value = [];
  points.value = [];
  if (previousSessionId) void props.backend.closeSession(previousSessionId).catch(() => {});
  await nextTick(); refreshFit(); render();
  return true;
}

function cloneOperation(operation: ImageEditorOperation): ImageEditorOperation {
  if (operation.kind === 'cutout') {
    return { ...operation, settings: { ...operation.settings } };
  }
  return { ...operation };
}

function captureCheckpoint(): EditorCheckpoint | undefined {
  if (!source.value) return undefined;
  return {
    trim: { ...trim },
    mode: mode.value,
    cutoutDraft: new Uint8Array(mode.value === 'cutout' ? selection.value : cutoutDraft.value),
    repairDraft: new Uint8Array(mode.value === 'repair' ? selection.value : repairDraft.value),
    source: source.value,
    selection: new Uint8Array(selection.value),
    settings: { ...settings },
    operations: operations.value.map(cloneOperation),
    stateId: currentStateId
  };
}

async function restoreCheckpoint(checkpoint: EditorCheckpoint) {
  invalidateSam();
  Object.assign(trim, checkpoint.trim);
  mode.value = checkpoint.mode;
  tool.value = mode.value === 'cutout' ? (samAvailable.value ? 'smart' : 'wand') : mode.value === 'repair' ? 'rect' : 'pan';
  cutoutDraft.value = new Uint8Array(checkpoint.cutoutDraft);
  repairDraft.value = new Uint8Array(checkpoint.repairDraft);
  source.value = checkpoint.source;
  labs.value = createLabPixels(checkpoint.source);
  selection.value = new Uint8Array(checkpoint.selection);
  operations.value = checkpoint.operations.map(cloneOperation);
  Object.assign(settings, checkpoint.settings);
  currentStateId = checkpoint.stateId;
  dirty.value = currentStateId !== 0;
  maskRevision.value++;
  compareOriginal.value = false;
  previewResult.value = false;
  await nextTick();
  refreshFit();
  render();
}

function markChanged() {
  currentStateId = nextStateId++;
  dirty.value = true;
}

function createProgressId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function runLocalRepair() {
  if (!snapshot.value || !source.value || !hasSelection.value || busy.value || !localAvailable.value) return;
  const assetId = snapshot.value.assetId;
  const sourceDataUrl = currentSourceDataUrl();
  const repairMaskDataUrl = maskToDataUrl(effectiveSelection());
  const progressId = createProgressId('local_inpaint');
  const before = captureCheckpoint();
  localProgressId.value = progressId;
  localBusy.value = true;
  error.value = '';
  status.value = '本地 LaMa 修复已提交，正在等待 CPU 队列…';
  try {
    const result = await props.backend.inpaint({
      assetId,
      dataUrl: sourceDataUrl,
      maskDataUrl: repairMaskDataUrl,
      maskExpand: settings.repairExpand,
      maskFeather: settings.repairFeather,
      progressId
    });
    if (snapshot.value?.assetId !== assetId || localProgressId.value !== progressId) return;
    const resultDataUrl = String(result.dataUrl || '');
    if (!await replaceWorkingImage(resultDataUrl, () => visible.value && localProgressId.value === progressId)) return;
    if (before) pushHistory(before);
    operations.value = [...operations.value, {
      kind: 'inpaint',
      dataUrl: resultDataUrl,
      maskDataUrl: repairMaskDataUrl,
      sourceSignature: `${sourceDataUrl.length}:${sourceDataUrl.slice(-48)}`,
      inferenceMs: Number(result.inferenceMs) || undefined
    }];
    markChanged();
    status.value = `局部修复完成（${Number(result.inferenceMs) || 0}ms），可切换原图对比或继续高清化。`;
  } catch (failure: any) {
    if (snapshot.value?.assetId === assetId && localProgressId.value === progressId
      && failure?.name !== 'AbortError' && !/取消/.test(String(failure?.message || ''))) {
      error.value = failure.message || String(failure);
    }
  } finally {
    if (localProgressId.value === progressId) {
      localBusy.value = false;
      localProgressId.value = '';
    }
  }
}

async function runUpscale() {
  if (!snapshot.value || !source.value || busy.value || !localAvailable.value) return;
  const assetId = snapshot.value.assetId;
  const sourceDataUrl = currentSourceDataUrl();
  const progressId = createProgressId('local_upscale');
  const before = captureCheckpoint();
  localProgressId.value = progressId;
  localBusy.value = true;
  error.value = '';
  status.value = `${upscaleScale.value}× 高清化已提交，正在等待 CPU 队列…`;
  try {
    const result = await props.backend.upscale({
      assetId,
      dataUrl: sourceDataUrl,
      scale: upscaleScale.value,
      progressId
    });
    if (snapshot.value?.assetId !== assetId || localProgressId.value !== progressId) return;
    const resultDataUrl = String(result.dataUrl || '');
    if (!await replaceWorkingImage(resultDataUrl, () => visible.value && localProgressId.value === progressId)) return;
    if (before) pushHistory(before);
    operations.value = [...operations.value, {
      kind: 'upscale',
      dataUrl: resultDataUrl,
      scale: upscaleScale.value,
      sourcePixelWidth: Number(result.sourcePixelWidth) || undefined,
      sourcePixelHeight: Number(result.sourcePixelHeight) || undefined,
      outputPixelWidth: Number(result.outputPixelWidth) || undefined,
      outputPixelHeight: Number(result.outputPixelHeight) || undefined,
      inferenceMs: Number(result.inferenceMs) || undefined
    }];
    markChanged();
    status.value = `高清化完成：${result.sourcePixelWidth}×${result.sourcePixelHeight} → ${result.outputPixelWidth}×${result.outputPixelHeight}。`;
  } catch (failure: any) {
    if (snapshot.value?.assetId === assetId && localProgressId.value === progressId
      && failure?.name !== 'AbortError' && !/取消/.test(String(failure?.message || ''))) {
      error.value = failure.message || String(failure);
    }
  } finally {
    if (localProgressId.value === progressId) {
      localBusy.value = false;
      localProgressId.value = '';
    }
  }
}

async function cancelLocalTask() {
  if (!localProgressId.value) return;
  const id = localProgressId.value;
  localProgressId.value = ''; localBusy.value = false;
  status.value = '已取消处理，当前编辑结果已保留。';
  await props.backend.cancel(id).catch(() => {});
}

function fit(limit = 8) {
  if (!viewport.value || !source.value) return;
  zoom.value = Math.min(limit, Math.max(0.05,
    Math.min((viewport.value.clientWidth - 48) / displayDimensions.value.width, (viewport.value.clientHeight - 48) / displayDimensions.value.height)));
}
function refreshFit() { if (zoomStrategy.value !== 'manual') fit(zoomStrategy.value === 'initial' ? 2 : 8); }
function fitWindow() { zoomStrategy.value = 'fit'; fit(); }
function setZoom(value: number) { zoomStrategy.value = 'manual'; zoom.value = Math.max(.05, Math.min(16, value)); }

function invalidateSam() {
  requestRevision.value++;
  const id = sessionId.value; sessionId.value = ''; samBusy.value = false;
  candidates.value = []; candidateMasks.value = []; points.value = [];
  if (id) void props.backend.closeSession(id).catch(() => {});
}

async function changeMode(next: CutoutEditorMode) {
  if (next === mode.value || busy.value) return;
  if (trimPlan.value.error) { error.value = trimPlan.value.error; return; }
  applying.value = true;
  try {
  if (mode.value === 'cutout' && hasSelection.value) await applyCutoutToWorkingImage();
  if (mode.value === 'cutout' && trim.enabled) await applyTrimToWorkingImage();
  if (mode.value === 'cutout') cutoutDraft.value = new Uint8Array(selection.value);
  if (mode.value === 'repair') repairDraft.value = new Uint8Array(selection.value);
  mode.value = next;
  const draft = next === 'cutout' ? cutoutDraft.value : next === 'repair' ? repairDraft.value : new Uint8Array();
  selection.value = draft.length === dimensions.value.width * dimensions.value.height
    ? new Uint8Array(draft) : new Uint8Array(dimensions.value.width * dimensions.value.height);
  maskRevision.value++;
  compareOriginal.value = false; previewResult.value = false;
  tool.value = next === 'cutout' ? (samAvailable.value ? 'smart' : 'wand') : next === 'repair' ? 'rect' : 'pan';
  error.value = next === 'cutout' ? '' : localModeError();
  status.value = ''; render();
  } catch (failure) { error.value = (failure as Error).message; }
  finally { applying.value = false; }
}

function beginEdgeChange() { if (!edgeBefore) edgeBefore = captureCheckpoint(); }
function endEdgeChange() {
  if (edgeBefore && JSON.stringify(edgeBefore.settings) !== JSON.stringify(settings)
    && hasSelection.value) { pushHistory(edgeBefore); markChanged(); }
  edgeBefore = undefined;
}

function beginTrimChange() { if (!trimBefore) trimBefore = captureCheckpoint(); }
function endTrimChange() {
  if (trimBefore && JSON.stringify(trimBefore.trim) !== JSON.stringify(trim)) { pushHistory(trimBefore); markChanged(); }
  trimBefore = undefined;
}
function changeTrimMargin(side: 'top' | 'right' | 'bottom' | 'left', event: Event) {
  beginTrimChange();
  const raw = (event.target as HTMLInputElement).value;
  const value = raw === '' ? NaN : Number(raw);
  if (trim.linked) { trim.top = value; trim.right = value; trim.bottom = value; trim.left = value; }
  else trim[side] = value;
}
function linkTrim() { if (trim.linked) trim.right = trim.bottom = trim.left = trim.top; }

async function applyTrimToWorkingImage() {
  if (!trim.enabled || !source.value || !trimPlan.value.bounds) return;
  const bounds = trimPlan.value.bounds;
  const before = captureCheckpoint();
  const input = source.value;
  const output = trimImage(input, bounds);
  const canvas = document.createElement('canvas'); canvas.width = output.width; canvas.height = output.height;
  canvas.getContext('2d')!.putImageData(output, 0, 0);
  const dataUrl = canvas.toDataURL('image/png');
  source.value = output; labs.value = createLabPixels(output);
  selection.value = new Uint8Array(output.width * output.height);
  cutoutDraft.value = new Uint8Array(); repairDraft.value = new Uint8Array(); maskRevision.value++;
  invalidateSam();
  if (before) pushHistory(before);
  operations.value = [...operations.value, { kind: 'trim', dataUrl, left: bounds.left, top: bounds.top,
    sourcePixelWidth: input.width, sourcePixelHeight: input.height, outputPixelWidth: output.width, outputPixelHeight: output.height }];
  Object.assign(trim, defaultTrimSettings()); trimBefore = undefined;
  markChanged(); status.value = '已裁掉多余留白，主体位置和大小保持不变。';
  await nextTick(); refreshFit(); render();
}

function pushHistory(checkpoint = captureCheckpoint()) {
  if (!checkpoint) return;
  const packedBytes = checkpoint.source.data.byteLength + checkpoint.selection.byteLength + checkpoint.cutoutDraft.byteLength + checkpoint.repairDraft.byteLength;
  const maxItems = Math.max(1, Math.min(20, Math.floor((32 * 1024 * 1024) / Math.max(1, packedBytes))));
  history.value = [...(maxItems > 1 ? history.value.slice(-(maxItems - 1)) : []), checkpoint];
  future.value = [];
}

async function undo() {
  if (localBusy.value || samBusy.value || saving.value) return;
  const previous = history.value.at(-1);
  if (!previous) return;
  const current = captureCheckpoint();
  if (current) future.value = [...future.value, current];
  history.value = history.value.slice(0, -1);
  await restoreCheckpoint(previous);
}

async function redo() {
  if (localBusy.value || samBusy.value || saving.value) return;
  const next = future.value.at(-1);
  if (!next) return;
  const current = captureCheckpoint();
  if (current) history.value = [...history.value, current];
  future.value = future.value.slice(0, -1);
  await restoreCheckpoint(next);
}

function canvasPoint(event: PointerEvent | MouseEvent) {
  const rect = overlayCanvas.value!.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(dimensions.value.width - 1, (event.clientX - rect.left) * dimensions.value.width / rect.width)),
    y: Math.max(0, Math.min(dimensions.value.height - 1, (event.clientY - rect.top) * dimensions.value.height / rect.height))
  };
}

function paintAt(point: { x: number; y: number }, add: boolean) {
  const { width, height } = dimensions.value;
  const radius = settings.brushSize / 2;
  const inner = radius * settings.brushHardness / 100;
  const minX = Math.max(0, Math.floor(point.x - radius)); const maxX = Math.min(width - 1, Math.ceil(point.x + radius));
  const minY = Math.max(0, Math.floor(point.y - radius)); const maxY = Math.min(height - 1, Math.ceil(point.y + radius));
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const distance = Math.hypot(x - point.x, y - point.y);
    if (distance > radius) continue;
    const opacity = distance <= inner || radius === inner ? 255 : Math.round(255 * (radius - distance) / (radius - inner));
    const index = y * width + x;
    const current = selection.value[index] ?? 0;
    selection.value[index] = add ? Math.max(current, opacity) : Math.round(current * (255 - opacity) / 255);
  }
}

function scoreCandidate(mask: Uint8Array, score: number) {
  let selected = 0;
  let borderSelected = 0;
  const { width, height } = dimensions.value;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if ((mask[y * width + x] ?? 0) < 128) continue;
    selected++;
    if (x === 0 || y === 0 || x + 1 === width || y + 1 === height) borderSelected++;
  }
  let pointPenalty = 0;
  for (const point of points.value) {
    const index = Math.max(0, Math.min(mask.length - 1, Math.round(point.y) * width + Math.round(point.x)));
    const inside = (mask[index] ?? 0) >= 128;
    if ((point.label === 'foreground') !== inside) pointPenalty += point.automatic ? 0.25 : 1;
  }
  const fraction = selected / Math.max(1, mask.length);
  const borderFraction = borderSelected / Math.max(1, width * 2 + height * 2 - 4);
  const implausiblePenalty = fraction < 0.001 || fraction > 0.98 ? 2 : 0;
  return score - pointPenalty - implausiblePenalty - borderFraction * 0.35;
}

function paintSegment(from: { x: number; y: number } | null, to: { x: number; y: number }, add: boolean) {
  const distance = from ? Math.hypot(to.x - from.x, to.y - from.y) : 0;
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, settings.brushSize / 5)));
  for (let step = 0; step <= steps; step++) {
    const amount = step / steps;
    paintAt(from ? { x: from.x + (to.x - from.x) * amount, y: from.y + (to.y - from.y) * amount } : to, add);
  }
}

async function runSmartSelection(point: { x: number; y: number }, label: 'foreground' | 'background') {
  if (!samAvailable.value || samBusy.value || !snapshot.value) return;
  const generation = editorGeneration;
  if (!sessionId.value) {
    samBusy.value = true; status.value = '正在加载图片特征…'; error.value = '';
    try {
      const session = await props.backend.createSession({
        assetId: snapshot.value.assetId,
        dataUrl: currentSourceDataUrl(),
        width: dimensions.value.width,
        height: dimensions.value.height
      });
      if (!visible.value || generation !== editorGeneration) {
        void props.backend.closeSession(String(session.sessionId)).catch(() => {}); return;
      }
      sessionId.value = String(session.sessionId);
      status.value = `特征计算完成（${session.embeddingMs}ms）`;
    } catch (failure: any) {
      if (generation !== editorGeneration || !visible.value) return;
      error.value = failure.message || String(failure); samAvailable.value = false; samBusy.value = false; return;
    }
    samBusy.value = false;
  }
  if (!points.value.length) {
    const { width, height } = dimensions.value;
    points.value = [
      { x: 1, y: 1, label: 'background', automatic: true },
      { x: width - 2, y: 1, label: 'background', automatic: true },
      { x: 1, y: height - 2, label: 'background', automatic: true },
      { x: width - 2, y: height - 2, label: 'background', automatic: true }
    ];
  }
  points.value = [...points.value, { ...point, label }];
  const revision = ++requestRevision.value;
  samBusy.value = true; status.value = 'SAM 2 正在分析主体…'; error.value = '';
  try {
    const response = await props.backend.predict({
      sessionId: sessionId.value,
      points: points.value.map(({ x, y, label }) => ({ x, y, label })),
      box: { x1: 1, y1: 1, x2: dimensions.value.width - 1, y2: dimensions.value.height - 1 },
      candidateIndex: candidates.value.length ? candidates.value[selectedCandidate.value]?.index : null,
      requestRevision: revision
    });
    if (revision !== requestRevision.value || response.requestRevision !== revision) return;
    const nextCandidates = (response.candidates || []) as SamCandidate[];
    const nextMasks = await Promise.all(nextCandidates.map(item => maskFromDataUrl(item.maskDataUrl)));
    if (revision !== requestRevision.value) return;
    pushHistory();
    candidates.value = nextCandidates;
    candidateMasks.value = nextMasks;
    let best = 0;
    nextCandidates.forEach((item, index) => {
      const candidate = nextMasks[index];
      const current = nextMasks[best];
      if (candidate && current
        && scoreCandidate(candidate, item.score) > scoreCandidate(current, nextCandidates[best]?.score ?? -1)) best = index;
    });
    selectedCandidate.value = best;
    const bestMask = nextMasks[best];
    if (!bestMask) throw new Error('SAM 2 未返回有效候选蒙版');
    selection.value = new Uint8Array(bestMask);
    maskRevision.value++;
    markChanged();
    status.value = `分割完成（${response.inferenceMs}ms），可切换候选或继续添加提示点。`;
    render();
  } catch (failure: any) {
    if (revision === requestRevision.value) error.value = failure.message || String(failure);
  } finally {
    if (revision === requestRevision.value) samBusy.value = false;
  }
}

function selectCandidate(index: number) {
  if (busy.value) return;
  const mask = candidateMasks.value[index];
  if (!mask) return;
  pushHistory(); selectedCandidate.value = index; selection.value = new Uint8Array(mask); maskRevision.value++; markChanged(); render();
}

function removePoint(index: number) {
  if (busy.value) return;
  points.value = points.value.filter((_, current) => current !== index);
  candidates.value = []; candidateMasks.value = [];
  status.value = '提示点已修改，请再次点击主体继续智能选择。';
}

async function pointerDown(event: PointerEvent) {
  if (!source.value || event.button !== 0) return;
  if (tool.value === 'pan' || spaceHeld.value || compareOriginal.value || mode.value === 'upscale' || previewResult.value) {
    panning = { x: event.clientX, y: event.clientY, left: viewport.value!.scrollLeft, top: viewport.value!.scrollTop };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); return;
  }
  if (busy.value || pendingRepairSave.value || showUnsaved.value) return;
  if (event.target === viewport.value) return;
  const point = canvasPoint(event);
  if (tool.value === 'smart' || tool.value === 'smart-background') {
    await runSmartSelection(point, event.altKey || tool.value === 'smart-background' ? 'background' : 'foreground');
    return;
  } else if (tool.value === 'wand' && source.value && labs.value) {
    pushHistory();
    const incoming = createWandMask(source.value, labs.value, dimensions.value.width, dimensions.value.height, point.x, point.y, settings.tolerance, settings.contiguous);
    const mode = event.altKey ? 'subtract' : event.shiftKey ? 'add' : combine.value;
    selection.value = combineMasks(selection.value, incoming, mode);
    maskRevision.value++;
    markChanged(); render(); return;
  } else if (tool.value === 'rect') {
    pushHistory();
    drawing = true;
    rectangleStart = point;
    const rectangleMode = event.altKey ? 'subtract' : event.shiftKey ? 'add' : combine.value;
    rectangleBase = rectangleMode === 'replace'
      ? new Uint8Array(selection.value.length)
      : new Uint8Array(selection.value);
    drawingAdds = rectangleMode !== 'subtract';
  } else {
    pushHistory(); drawing = true; lastPoint = null;
    drawingAdds = event.altKey ? false : event.shiftKey ? true : tool.value === 'brush-add';
    paintSegment(null, point, drawingAdds); maskRevision.value++; lastPoint = point; markChanged(); render();
  }
  overlayCanvas.value?.setPointerCapture(event.pointerId);
}

function pointerMove(event: PointerEvent) {
  if (panning && viewport.value) {
    viewport.value.scrollLeft = panning.left - (event.clientX - panning.x);
    viewport.value.scrollTop = panning.top - (event.clientY - panning.y);
    return;
  }
  if (!drawing) return;
  const point = canvasPoint(event);
  if (rectangleStart && rectangleBase) {
    const { width, height } = dimensions.value;
    const incoming = new Uint8Array(width * height);
    const left = Math.max(0, Math.floor(Math.min(rectangleStart.x, point.x)));
    const right = Math.min(width - 1, Math.ceil(Math.max(rectangleStart.x, point.x)));
    const top = Math.max(0, Math.floor(Math.min(rectangleStart.y, point.y)));
    const bottom = Math.min(height - 1, Math.ceil(Math.max(rectangleStart.y, point.y)));
    for (let y = top; y <= bottom; y++) incoming.fill(255, y * width + left, y * width + right + 1);
    selection.value = combineMasks(rectangleBase, incoming, drawingAdds ? 'add' : 'subtract');
    maskRevision.value++;
    markChanged();
    render();
    return;
  }
  paintSegment(lastPoint, point, drawingAdds); maskRevision.value++; lastPoint = point; render();
}

function pointerUp() { drawing = false; lastPoint = null; panning = null; rectangleStart = null; rectangleBase = null; }

function invert() { if (busy.value || mode.value === 'upscale') return; pushHistory(); selection.value = invertMask(selection.value); maskRevision.value++; markChanged(); render(); }
function clearSelection() { if (busy.value) return; pushHistory(); selection.value = new Uint8Array(selection.value.length); invalidateSam(); maskRevision.value++; markChanged(); render(); }

async function applyCutoutToWorkingImage() {
  if (!snapshot.value || !source.value || !hasSelection.value || samBusy.value || localBusy.value) return;
  const before = captureCheckpoint();
  if (!before) return;
  const { width, height } = dimensions.value;
  const rawMask = new Uint8Array(selection.value);
  const maskDataUrl = maskToDataUrl(rawMask);
  const result = applyAlphaMatte(
    source.value,
    createAlphaMatte(rawMask, width, height, settings),
    width,
    height,
    settings.decontaminate
  );
  pushHistory(before);
  source.value = result;
  labs.value = createLabPixels(result);
  selection.value = new Uint8Array(width * height);
  cutoutDraft.value = new Uint8Array(); repairDraft.value = new Uint8Array();
  invalidateSam();
  maskRevision.value++;
  const dataUrl = currentSourceDataUrl();
  operations.value = [...operations.value, {
    kind: 'cutout',
    dataUrl,
    maskDataUrl,
    settings: { ...settings },
    childSignature: snapshot.value.childSignature
  }];
  markChanged();
  compareOriginal.value = false;
  status.value = '透明背景已应用到当前工作图，可继续修复、高清化或点击保存。';
  render();
}

async function save(discardRepair = false) {
  if (!snapshot.value || !source.value || !canSave.value) return;
  if (hasRepairDraft.value && !discardRepair) { pendingRepairSave.value = true; return; }
  pendingRepairSave.value = false;
  saving.value = true;
  error.value = '';
  try {
  if (discardRepair) {
    repairDraft.value = new Uint8Array();
    if (mode.value === 'repair') { selection.value = new Uint8Array(selection.value.length); maskRevision.value++; render(); }
  }
  if (mode.value === 'cutout' && hasSelection.value) await applyCutoutToWorkingImage();
  if (mode.value === 'cutout' && trim.enabled) await applyTrimToWorkingImage();
  const lastCutout = [...operations.value].reverse().find(operation => operation.kind === 'cutout');
  status.value = '正在保存全部图像处理结果…';
    await props.commit({
      assetId: snapshot.value.assetId,
      dataUrl: currentSourceDataUrl(),
      sourceSignature: snapshot.value.sourceSignature,
      placementSignature: snapshot.value.placementSignature,
      operations: operations.value.map(cloneOperation),
      maskDataUrl: lastCutout?.kind === 'cutout' ? lastCutout.maskDataUrl : undefined,
      settings: lastCutout?.kind === 'cutout' ? { ...lastCutout.settings } : { ...settings },
      childSignature: snapshot.value.childSignature
    });
    dirty.value = false;
    await closeNow();
  } catch (failure: any) {
    error.value = failure?.message || String(failure);
    status.value = '保存失败，当前编辑结果仍保留在窗口中。';
  } finally {
    saving.value = false;
  }
}

async function closeNow() {
  editorGeneration++;
  const progressId = localProgressId.value;
  invalidateSam();
  if (progressId) void props.backend.cancel(progressId).catch(() => {});
  sessionId.value = ''; visible.value = false; showUnsaved.value = false;
  localBusy.value = false;
  localProgressId.value = '';
  pendingRepairSave.value = false; spaceHeld.value = false; pointerUp();
  resizeObserver?.disconnect(); previousFocus?.focus();
  emit('close');
}

function requestClose() {
  if (saving.value || applying.value) return;
  if (dirty.value || localBusy.value || samBusy.value) showUnsaved.value = true;
  else void closeNow();
}

function keydown(event: KeyboardEvent) {
  if (event.key === 'Tab' && dialog.value) {
    const scope = dialog.value.querySelector('.cutout-unsaved') || dialog.value;
    const elements = Array.from(scope.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), summary, [tabindex="0"]')).filter(item => item.getClientRects().length);
    const first = elements[0], last = elements.at(-1);
    if (event.shiftKey && (document.activeElement === first || !scope.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !scope.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault(); spaceHeld.value = false; pointerUp();
    if (pendingRepairSave.value) pendingRepairSave.value = false;
    else if (showUnsaved.value) showUnsaved.value = false;
    else if (panelOpen.value) panelOpen.value = false;
    else requestClose();
    return;
  }
  if (pendingRepairSave.value || showUnsaved.value) return;
  const target = event.target as HTMLElement;
  if (target.matches('input, select, textarea')) return;
  if (event.code === 'Space') { event.preventDefault(); spaceHeld.value = true; return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); return; }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'i') { event.preventDefault(); invert(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
  if (busy.value || mode.value === 'upscale') return;
  const keys: Record<string, CutoutTool> = { w: 'wand', s: mode.value === 'cutout' ? (samAvailable.value ? 'smart' : 'wand') : 'rect', r: mode.value === 'repair' ? 'rect' : 'wand', b: 'brush-add', e: 'brush-subtract' };
  const nextTool = keys[event.key.toLowerCase()];
  if (nextTool) { tool.value = nextTool; previewResult.value = false; }
  else if (event.key === '[') settings.brushSize = Math.max(1, settings.brushSize - 2);
  else if (event.key === ']') settings.brushSize = Math.min(200, settings.brushSize + 2);
}

async function open(next: CutoutEditorSnapshot) {
  Object.assign(trim, defaultTrimSettings()); trimBefore = undefined;
  previousFocus = document.activeElement as HTMLElement;
  const generation = ++editorGeneration;
  snapshot.value = next; visible.value = true; dirty.value = false; showUnsaved.value = false;
  mode.value = next.openMode || 'cutout';
  tool.value = mode.value === 'cutout' ? 'smart' : mode.value === 'repair' ? 'rect' : 'pan';
  zoomStrategy.value = 'initial'; previewResult.value = false; panelOpen.value = false;
  pendingRepairSave.value = false; localBusy.value = false; samBusy.value = false; samAvailable.value = false;
  cutoutDraft.value = new Uint8Array(); repairDraft.value = new Uint8Array();
  error.value = '';
  status.value = '';
  candidates.value = []; candidateMasks.value = []; points.value = []; history.value = []; future.value = []; operations.value = [];
  nextStateId = 1;
  currentStateId = 0;
  saving.value = false;
  localHealthChecked.value = false;
  localHealthState.value = {};
  sessionId.value = ''; requestRevision.value++;
  try {
    const element = await loadHtmlImage(next.dataUrl);
    if (generation !== editorGeneration || !visible.value) return;
    image.value = element;
    originalImage.value = element;
    const canvas = document.createElement('canvas'); canvas.width = element.naturalWidth; canvas.height = element.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('无法初始化智能抠图画布');
    context.drawImage(element, 0, 0);
    source.value = context.getImageData(0, 0, canvas.width, canvas.height);
    labs.value = createLabPixels(source.value);
    const initialMask = next.maskDataUrl ? await maskFromDataUrl(next.maskDataUrl) : new Uint8Array(canvas.width * canvas.height);
    if (generation !== editorGeneration || !visible.value) return;
    cutoutDraft.value = initialMask;
    selection.value = mode.value === 'cutout' ? new Uint8Array(cutoutDraft.value) : new Uint8Array(canvas.width * canvas.height);
    maskRevision.value++;
    Object.assign(settings, {
      tolerance: 20, contiguous: true, fillHoles: true, expand: 0,
      feather: Math.max(1, Math.min(3, Math.round(Math.min(canvas.width, canvas.height) * 0.015))),
      decontaminate: 0, brushSize: Math.max(2, Math.min(200, Math.round(Math.min(canvas.width, canvas.height) * 0.08))),
      brushHardness: 80, repairExpand: 3, repairFeather: 2,
      ...(next.settings || {})
    });
    upscaleScale.value = next.upscaleScale === 4 ? 4 : next.upscaleScale === 2 ? 2 : recommendedUpscaleScale.value;
    compareOriginal.value = false;
    await nextTick(); refreshFit(); render(); dialog.value?.focus();
    resizeObserver?.disconnect(); resizeObserver = new ResizeObserver(refreshFit);
    if (viewport.value) resizeObserver.observe(viewport.value);
    props.backend.health().then(health => {
      if (generation !== editorGeneration || !visible.value) return;
      samAvailable.value = Boolean(health.ok && health.checkpointFound);
      if (!samAvailable.value && mode.value === 'cutout') { tool.value = 'wand'; status.value = '智能选择暂不可用，可使用魔棒或画笔。'; }
    }).catch(() => { if (generation !== editorGeneration) return; samAvailable.value = false; if (mode.value === 'cutout') tool.value = 'wand'; });
    props.backend.localHealth().then(health => {
      if (generation !== editorGeneration || !visible.value) return;
      localHealthState.value = health;
      localHealthChecked.value = true;
      const unavailable = localModeError();
      if (mode.value !== 'cutout' && unavailable) error.value = unavailable;
      else if (mode.value !== 'cutout'
        && /(?:IOPaint|LaMa|Real-ESRGAN).*(?:不存在|不可用)/.test(error.value)) error.value = '';
    }).catch(failure => {
      if (generation !== editorGeneration || !visible.value) return;
      localHealthState.value = {};
      localHealthChecked.value = true;
      if (mode.value !== 'cutout') error.value = failure.message || String(failure);
    });
  } catch (failure) {
    if (generation !== editorGeneration || !visible.value) return;
    visible.value = false;
    snapshot.value = undefined;
    throw failure;
  }
}

watch(settings, () => {
  render();
}, { deep: true });
watch([compareOriginal, previewResult], () => render());
watch(trim, () => render(), { deep: true });
watch(() => trimPlan.value.error, (_next, previous) => {
  if (previous && error.value === previous) error.value = '';
});
watch(displayDimensions, async () => { await nextTick(); refreshFit(); });
watch([showUnsaved, pendingRepairSave], async ([unsaved, pending]) => {
  await nextTick();
  if (unsaved || pending) dialog.value?.querySelector<HTMLElement>('.cutout-unsaved button')?.focus();
  else if (visible.value) dialog.value?.focus();
});
marchTimer = setInterval(() => { if (visible.value && hasSelection.value && !previewResult.value && !compareOriginal.value && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) { march = (march + 1) % 8; render(true); } }, 160);
onBeforeUnmount(() => { editorGeneration++; resizeObserver?.disconnect(); if (marchTimer) clearInterval(marchTimer); invalidateSam(); if (localProgressId.value) void props.backend.cancel(localProgressId.value).catch(() => {}); });
defineExpose({ open, close: requestClose });
</script>

<template>
  <div v-if="visible" class="cutout-editor-overlay">
    <section ref="dialog" class="cutout-editor" role="dialog" aria-modal="true" aria-label="图像处理编辑器" tabindex="-1"
      @keydown="keydown" @keyup.space="spaceHeld = false" @focusout="spaceHeld = false">
      <header class="cutout-editor-header" :inert="showUnsaved || pendingRepairSave">
        <div class="cutout-title"><strong>图像处理</strong><span :title="snapshot?.name">{{ snapshot?.name }}</span></div>
        <nav class="cutout-mode-tabs" aria-label="图像处理模式">
          <button v-for="item in (['cutout', 'repair', 'upscale'] as CutoutEditorMode[])" :key="item" type="button"
            :class="{ active: mode === item }" :aria-pressed="mode === item" :disabled="busy" @click="changeMode(item)">
            {{ { cutout: '智能抠图', repair: '局部修复', upscale: '高清化' }[item] }}
          </button>
        </nav>
        <div class="cutout-editor-header-actions">
          <button type="button" :disabled="!canUndo || busy" title="撤销 Ctrl/Cmd+Z" @click="undo">撤销</button>
          <button type="button" :disabled="!canRedo || busy" title="重做 Ctrl/Cmd+Shift+Z" @click="redo">重做</button>
          <button type="button" aria-label="关闭图像处理" :disabled="saving" @click="requestClose">×</button>
        </div>
      </header>
      <div class="cutout-editor-body" :inert="showUnsaved || pendingRepairSave">
        <div class="cutout-workspace">
          <div class="cutout-viewbar">
            <div class="cutout-segmented" v-if="mode !== 'upscale'">
              <button type="button" :aria-pressed="!previewResult" :class="{ active: !previewResult }" @click="previewResult = false">选区</button>
              <button type="button" :aria-pressed="previewResult" :class="{ active: previewResult }" @click="previewResult = true">结果</button>
            </div>
            <span v-else>高清预览</span>
            <button type="button" :aria-pressed="compareOriginal" :class="{ active: compareOriginal }" @click="compareOriginal = !compareOriginal">{{ compareOriginal ? '返回当前图' : '对比原图' }}</button>
            <button class="cutout-panel-toggle" type="button" :aria-expanded="panelOpen" aria-controls="cutout-settings" @click="panelOpen = !panelOpen">工具与参数</button>
          </div>
          <main ref="viewport" class="cutout-editor-viewport" :class="[`preview-${previewBackground}`, { 'is-panning': spaceHeld || mode === 'upscale' || compareOriginal || previewResult }]"
            aria-label="图像画布" @pointerdown.self="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp" @pointercancel="pointerUp">
            <div class="cutout-editor-stage" :class="`preview-${previewBackground}`" :style="stageStyle">
              <canvas ref="baseCanvas" aria-hidden="true" />
              <canvas ref="resultCanvas" aria-hidden="true" />
              <canvas ref="overlayCanvas" :aria-label="mode === 'repair' ? '局部修复选区画布' : '图像编辑画布'" @pointerdown.stop="pointerDown" />
              <div v-if="trimPlan.bounds && !previewResult && !compareOriginal" class="cutout-trim-frame" :style="trimFrameStyle" aria-label="裁剪范围"><span>裁剪范围</span></div>
              <template v-if="mode === 'cutout' && !previewResult && !compareOriginal">
                <button v-for="(point, index) in points" :key="`${index}-${point.x}-${point.y}`" class="cutout-point" :class="point.label"
                  type="button" :disabled="busy" :style="{ left: `${point.x / dimensions.width * 100}%`, top: `${point.y / dimensions.height * 100}%` }"
                  :aria-label="`${point.label === 'foreground' ? '保留点' : '排除点'} ${index + 1}`"
                  title="点击移除提示点" @click.stop="removePoint(index)" />
              </template>
            </div>
          </main>
          <div class="cutout-canvas-footer">
            <span class="cutout-pixel-size">{{ displayDimensions.width }} × {{ displayDimensions.height }} px</span>
            <div class="cutout-preview-controls">
              <button type="button" @click="fitWindow">适应</button>
              <button type="button" @click="setZoom(1)">100%</button>
              <button type="button" aria-label="缩小" @click="setZoom(zoom / 1.25)">−</button>
              <output aria-label="缩放比例">{{ Math.round(zoom * 100) }}%</output>
              <button type="button" aria-label="放大" @click="setZoom(zoom * 1.25)">＋</button>
            </div>
            <label class="cutout-background-label" title="仅改变画布预览背景，不会修改图片或去除图片自身的白色背景">预览背景<select v-model="previewBackground"><option value="checker">棋盘格</option><option value="white">白色</option><option value="black">黑色</option></select></label>
            <span class="cutout-zoom-hint">{{ zoom > 1 ? '预览放大 · 不改变像素' : '空格 + 拖动平移' }}</span>
          </div>
        </div>
        <button v-if="panelOpen" class="cutout-panel-scrim" type="button" aria-label="收起工具面板" @click="panelOpen = false" />
        <aside id="cutout-settings" class="cutout-editor-settings" :class="{ 'is-open': panelOpen }" aria-label="工具与参数">
          <div class="cutout-panel-heading"><strong>{{ { cutout: '保留主体，去除背景', repair: '移除内容，补齐画面', upscale: '提升图片清晰度' }[mode] }}</strong><button class="cutout-panel-toggle" type="button" @click="panelOpen = false">收起</button></div>
          <div class="cutout-panel-scroll">
            <p class="cutout-help">{{ toolHint }}</p>
            <fieldset v-if="mode !== 'upscale'" :disabled="busy" class="cutout-tool-section"><legend>选择工具</legend>
              <div class="cutout-tool-grid">
                <button v-if="mode === 'cutout'" type="button" :class="{ active: tool === 'smart' || tool === 'smart-background' }" :aria-pressed="tool === 'smart' || tool === 'smart-background'" :disabled="!samAvailable" :title="samAvailable ? '智能选择 S' : '智能选择暂不可用，请使用魔棒或画笔'" @click="tool = 'smart'; previewResult = false">智能选择</button>
                <button v-else type="button" :class="{ active: tool === 'rect' }" :aria-pressed="tool === 'rect'" @click="tool = 'rect'; previewResult = false">矩形</button>
                <button type="button" :class="{ active: tool === 'wand' }" :aria-pressed="tool === 'wand'" title="魔棒 W" @click="tool = 'wand'; previewResult = false">魔棒</button>
                <button type="button" :class="{ active: isBrush }" :aria-pressed="isBrush" title="画笔 B" @click="tool = 'brush-add'; previewResult = false">画笔</button>
              </div>
              <div v-if="tool === 'smart' || tool === 'smart-background'" class="cutout-segmented">
                <button type="button" :class="{ active: tool === 'smart' }" :aria-pressed="tool === 'smart'" @click="tool = 'smart'">保留点</button>
                <button type="button" :class="{ active: tool === 'smart-background' }" :aria-pressed="tool === 'smart-background'" @click="tool = 'smart-background'">排除点</button>
              </div>
              <div v-if="isBrush" class="cutout-segmented">
                <button type="button" :class="{ active: tool === 'brush-add' }" :aria-pressed="tool === 'brush-add'" @click="tool = 'brush-add'">增加选区</button>
                <button type="button" :class="{ active: tool === 'brush-subtract' }" :aria-pressed="tool === 'brush-subtract'" @click="tool = 'brush-subtract'">擦除选区</button>
              </div>
              <div v-if="tool === 'wand' || tool === 'rect'" class="cutout-segmented">
                <button v-for="item in (['replace', 'add', 'subtract'] as CutoutCombineMode[])" :key="item" type="button" :class="{ active: combine === item }" :aria-pressed="combine === item" @click="combine = item">{{ { replace: '替换', add: '添加', subtract: '减去' }[item] }}</button>
              </div>
              <template v-if="tool === 'wand'">
                <label>颜色容差 <output>{{ settings.tolerance }}</output><input aria-label="颜色容差" v-model.number="settings.tolerance" type="range" min="0" max="100" /></label>
                <label class="cutout-check"><input v-model="settings.contiguous" type="checkbox" />仅选择连续区域</label>
              </template>
              <template v-if="isBrush">
                <label>画笔大小 <output>{{ settings.brushSize }} px</output><input aria-label="画笔大小" v-model.number="settings.brushSize" type="range" min="1" max="200" /></label>
                <label>画笔硬度 <output>{{ settings.brushHardness }}%</output><input aria-label="画笔硬度" v-model.number="settings.brushHardness" type="range" min="0" max="100" /></label>
              </template>
            </fieldset>
            <fieldset v-if="mode === 'cutout' && candidates.length" :disabled="busy" class="cutout-candidates"><legend>选择分割结果</legend>
              <div class="cutout-candidate-grid"><button v-for="(candidate, index) in candidates" :key="candidate.index" type="button" :class="{ active: selectedCandidate === index }" :aria-pressed="selectedCandidate === index" :title="`模型评分 ${Math.round(candidate.score * 100)}%`" @click="selectCandidate(index)">
                <img :src="candidate.maskDataUrl" alt="" /><span>结果 {{ index + 1 }}</span>
              </button></div>
            </fieldset>
            <div v-if="mode !== 'upscale'" class="cutout-small-actions">
              <button type="button" :disabled="busy" @click="invert">反选</button><button type="button" :disabled="busy || !hasSelection" @click="clearSelection">清空选区</button>
            </div>
            <details v-if="mode !== 'upscale'" class="cutout-edge-details"><summary>{{ mode === 'cutout' ? '边缘优化' : '修复边缘' }}</summary>
              <fieldset :disabled="busy" @pointerdown="beginEdgeChange" @keydown="beginEdgeChange" @change="endEdgeChange" @focusout="endEdgeChange">
                <template v-if="mode === 'cutout'">
                  <label class="cutout-check"><input v-model="settings.fillHoles" type="checkbox" />填充内部孔洞</label>
                  <label>扩展 / 收缩 <output>{{ settings.expand }} px</output><input aria-label="扩展 / 收缩" v-model.number="settings.expand" type="range" min="-10" max="10" /></label>
                  <label>羽化 <output>{{ settings.feather }} px</output><input aria-label="羽化" v-model.number="settings.feather" type="range" min="0" max="12" /></label>
                  <label>去杂色 <output>{{ settings.decontaminate }}%</output><input aria-label="去杂色" v-model.number="settings.decontaminate" type="range" min="0" max="100" /></label>
                </template>
                <template v-else>
                  <label>蒙版扩展 <output>{{ settings.repairExpand }} px</output><input aria-label="蒙版扩展" v-model.number="settings.repairExpand" type="range" min="0" max="16" /></label>
                  <label>合成羽化 <output>{{ settings.repairFeather }} px</output><input aria-label="合成羽化" v-model.number="settings.repairFeather" type="range" min="0" max="12" /></label>
                  <p class="cutout-field-note">扩展覆盖文字边缘，蒙版以外保持原样。</p>
                </template>
              </fieldset>
            </details>
            <details v-if="mode === 'cutout'" class="cutout-edge-details cutout-trim-details"><summary>边缘切除</summary>
              <fieldset :disabled="busy" @pointerdown="beginTrimChange" @keydown="beginTrimChange" @change="endTrimChange" @focusout="endTrimChange">
                <label class="cutout-check"><input v-model="trim.enabled" type="checkbox" />裁掉多余透明留白</label>
                <template v-if="trim.enabled">
                  <label class="cutout-check"><input v-model="trim.linked" type="checkbox" @change="linkTrim" />同步四边</label>
                  <div class="cutout-trim-inputs">
                    <label v-for="side in (['top', 'bottom', 'left', 'right'] as const)" :key="side">{{ { top: '上', bottom: '下', left: '左', right: '右' }[side] }}<span><input :aria-label="`${{ top: '上', bottom: '下', left: '左', right: '右' }[side]}保留间距`" :value="Number.isFinite(trim[side]) ? trim[side] : ''" type="number" min="0" max="4096" step="1" @input="changeTrimMargin(side, $event)" /> px</span></label>
                  </div>
                  <p class="cutout-field-note">主体四周保留透明间距，不恢复原背景。主体在设计图中的位置和大小不变。</p>
                  <dl class="cutout-dimensions"><div><dt>裁剪前</dt><dd>{{ dimensions.width }} × {{ dimensions.height }}</dd></div><div><dt>裁剪后</dt><dd>{{ trimPlan.bounds ? `${trimPlan.bounds.width} × ${trimPlan.bounds.height}` : '—' }}</dd></div></dl>
                  <p v-if="trimPlan.error" class="cutout-error" role="alert">{{ trimPlan.error }}</p>
                </template>
              </fieldset>
            </details>
            <fieldset v-if="mode === 'upscale'" :disabled="busy"><legend>放大倍率</legend>
              <div class="cutout-scale-options">
                <button v-for="scale in ([2, 4] as const)" :key="scale" type="button" :class="{ active: upscaleScale === scale }" :aria-pressed="upscaleScale === scale" @click="upscaleScale = scale">{{ scale }}× <span>{{ recommendedUpscaleScale === scale ? '推荐' : '更大尺寸' }}</span></button>
              </div>
              <dl class="cutout-dimensions"><div><dt>当前像素</dt><dd>{{ dimensions.width }} × {{ dimensions.height }}</dd></div><div><dt>输出像素</dt><dd>{{ dimensions.width * upscaleScale }} × {{ dimensions.height * upscaleScale }}</dd></div><div><dt>设计尺寸</dt><dd>保持不变</dd></div></dl>
              <p class="cutout-field-note">适合图标和插画。使用本机 CPU 处理，大图需要更长时间；完成后可在 100% 下检查细节。</p>
            </fieldset>
            <p v-if="error" class="cutout-error" role="alert">{{ error }}</p>
            <p v-if="status && !busy" class="cutout-help" role="status">{{ status }}</p>
          </div>
          <div class="cutout-mode-action">
            <div v-if="busy" class="cutout-inline-status" role="status" aria-live="polite"><span class="cutout-spinner" aria-hidden="true" />{{ status || '正在处理…' }}<button v-if="localBusy" type="button" @click="cancelLocalTask">取消处理</button></div>
            <template v-else-if="mode === 'cutout'"><strong>{{ trim.enabled ? '边缘切除预览' : hasSelection ? '选区已就绪' : '先选择要保留的主体' }}</strong><p>{{ hasSelection || trim.enabled ? '可直接保存，或切换功能继续处理。' : '使用上方工具在图片上建立选区。' }}</p><button type="button" :disabled="(!hasSelection && !trim.enabled) || !!trimPlan.error" @click="previewResult = !previewResult">{{ previewResult ? '继续调整选区' : '预览抠图结果' }}</button></template>
            <template v-else><p>{{ !localHealthChecked ? '正在检查本地模型…' : !localAvailable ? '本地模型不可用，请检查安装环境。' : mode === 'repair' && !hasSelection ? '先框选或涂抹要移除的区域。' : '处理后可继续编辑，最后统一保存。' }}</p><button class="primary" type="button" :disabled="!localAvailable || (mode === 'repair' && !hasSelection)" @click="mode === 'repair' ? runLocalRepair() : runUpscale()">{{ mode === 'repair' ? '开始修复' : '开始高清化' }}</button></template>
          </div>
        </aside>
      </div>
      <footer class="cutout-editor-footer" :inert="showUnsaved || pendingRepairSave">
        <span class="cutout-save-state" role="status">{{ busy ? (saving ? '正在保存…' : '正在处理，可打开工具面板查看状态') : operations.length ? `已有 ${operations.length} 项处理 · 未保存` : mode === 'cutout' && trim.enabled ? '边缘切除预览 · 未保存' : mode === 'cutout' && hasSelection ? '抠图预览 · 未保存' : hasRepairDraft ? '修复选区待处理' : '尚未修改图片' }}</span>
        <div class="cutout-save-actions">
          <button class="primary" type="button" :disabled="!canSave" :title="canSave ? '保存所有处理结果并关闭' : busy ? '请等待当前处理完成' : '完成抠图选区或图像处理后即可保存'" @click="save()">{{ saving ? '保存中…' : '保存到切图' }}</button>
        </div>
      </footer>
      <div v-if="showUnsaved || pendingRepairSave" class="cutout-unsaved">
        <div role="alertdialog" aria-modal="true" :aria-label="pendingRepairSave ? '修复选区尚未处理' : '放弃未保存的修改'">
          <strong>{{ pendingRepairSave ? '修复选区尚未处理' : busy ? '取消任务并放弃修改？' : '放弃未保存的修改？' }}</strong>
          <p>{{ pendingRepairSave ? '红色选区尚未执行修复。你可以返回继续修复，或仅保存已经完成的图像处理。' : busy ? '当前任务会被取消，本次编辑不会写入切图。' : '本次抠图、修复和高清化结果都不会写入切图。' }}</p>
          <div v-if="pendingRepairSave"><button type="button" @click="pendingRepairSave = false; changeMode('repair')">返回修复</button><button class="primary" type="button" @click="save(true)">放弃待修复选区并保存已有结果</button></div>
          <div v-else><button type="button" @click="showUnsaved = false">继续编辑</button><button class="danger" type="button" @click="closeNow">放弃并关闭</button></div>
        </div>
      </div>
    </section>
  </div>
</template>
