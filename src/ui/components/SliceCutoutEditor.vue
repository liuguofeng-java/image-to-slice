<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import {
  applyAlphaMatte,
  combineMasks,
  createAlphaMatte,
  createLabPixels,
  createWandMask,
  fillMaskHoles,
  invertMask,
  packMask,
  unpackMask
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
const status = ref('点击主体开始智能选择；Alt+单击添加背景排除点。');
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
const openingCheckpoint = ref<EditorCheckpoint>();
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
let drawing = false;
let drawingAdds = true;
let lastPoint: { x: number; y: number } | null = null;
let panning: { x: number; y: number; left: number; top: number } | null = null;
let rectangleStart: { x: number; y: number } | null = null;
let rectangleBase: Uint8Array | null = null;
let march = 0;
let marchTimer: ReturnType<typeof setInterval> | undefined;
let initializing = false;
let restoringCheckpoint = false;
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
const stageStyle = computed(() => ({
  width: `${dimensions.value.width * zoom.value}px`,
  height: `${dimensions.value.height * zoom.value}px`
}));
const canUndo = computed(() => history.value.length > 0);
const canRedo = computed(() => future.value.length > 0);
const canSave = computed(() => dirty.value && operations.value.length > 0
  && !localBusy.value && !samBusy.value && !saving.value);
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
  if (!settings.fillHoles) return selection.value;
  return fillMaskHoles(selection.value, dimensions.value.width, dimensions.value.height);
}

function render() {
  if (!source.value || !baseCanvas.value || !resultCanvas.value || !overlayCanvas.value) return;
  const { width, height } = dimensions.value;
  for (const canvas of [baseCanvas.value, resultCanvas.value, overlayCanvas.value]) {
    canvas.width = width; canvas.height = height;
  }
  baseCanvas.value.getContext('2d')?.putImageData(source.value, 0, 0);
  const result = mode.value === 'cutout' && hasSelection.value
    ? applyAlphaMatte(
        source.value,
        createAlphaMatte(selection.value, width, height, settings),
        width,
        height,
        settings.decontaminate
      )
    : new ImageData(new Uint8ClampedArray(source.value.data), width, height);
  const resultContext = resultCanvas.value.getContext('2d');
  if (compareOriginal.value && originalImage.value && resultContext) {
    resultContext.clearRect(0, 0, width, height);
    resultContext.drawImage(originalImage.value, 0, 0, width, height);
  } else {
    resultContext?.putImageData(result, 0, 0);
  }
  const context = overlayCanvas.value.getContext('2d');
  if (!context) return;
  const output = context.createImageData(width, height);
  const mask = effectiveSelection();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    if (!compareOriginal.value && mode.value !== 'upscale' && (mask[index] ?? 0) > 0) {
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

async function replaceWorkingImage(dataUrl: string) {
  const element = await loadHtmlImage(dataUrl);
  image.value = element;
  const canvas = document.createElement('canvas');
  canvas.width = element.naturalWidth; canvas.height = element.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('无法读取本地图像处理结果');
  context.drawImage(element, 0, 0);
  source.value = context.getImageData(0, 0, canvas.width, canvas.height);
  labs.value = createLabPixels(source.value);
  selection.value = new Uint8Array(canvas.width * canvas.height);
  maskRevision.value++;
  const previousSessionId = sessionId.value;
  requestRevision.value++;
  sessionId.value = '';
  candidates.value = [];
  candidateMasks.value = [];
  points.value = [];
  if (previousSessionId) void props.backend.closeSession(previousSessionId).catch(() => {});
  await nextTick(); fit(); render();
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
    source: source.value,
    selection: packMask(selection.value),
    settings: { ...settings },
    operations: operations.value.map(cloneOperation),
    stateId: currentStateId
  };
}

async function restoreCheckpoint(checkpoint: EditorCheckpoint) {
  restoringCheckpoint = true;
  source.value = checkpoint.source;
  labs.value = createLabPixels(checkpoint.source);
  selection.value = unpackMask(checkpoint.selection, checkpoint.source.width * checkpoint.source.height);
  operations.value = checkpoint.operations.map(cloneOperation);
  Object.assign(settings, checkpoint.settings);
  currentStateId = checkpoint.stateId;
  dirty.value = currentStateId !== 0;
  maskRevision.value++;
  compareOriginal.value = false;
  await nextTick();
  fit();
  render();
  restoringCheckpoint = false;
}

function markChanged() {
  currentStateId = nextStateId++;
  dirty.value = true;
}

function createProgressId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function runLocalRepair() {
  if (!snapshot.value || !source.value || !hasSelection.value || localBusy.value) return;
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
    await replaceWorkingImage(resultDataUrl);
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
  if (!snapshot.value || !source.value || localBusy.value) return;
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
    await replaceWorkingImage(resultDataUrl);
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
  await props.backend.cancel(localProgressId.value).catch(() => {});
  status.value = '已请求取消本地图像处理。';
}

function fit() {
  if (!viewport.value || !source.value) return;
  zoom.value = Math.min(8, Math.max(0.05,
    Math.min((viewport.value.clientWidth - 48) / source.value.width, (viewport.value.clientHeight - 48) / source.value.height)));
}

function pushHistory(checkpoint = captureCheckpoint()) {
  if (!checkpoint) return;
  const packedBytes = checkpoint.selection.byteLength;
  const maxItems = Math.max(1, Math.min(20, Math.floor((32 * 1024 * 1024) / Math.max(1, packedBytes))));
  history.value = [...history.value.slice(-(maxItems - 1)), checkpoint];
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
  if (!sessionId.value) {
    samBusy.value = true; status.value = '正在加载图片特征…'; error.value = '';
    try {
      const session = await props.backend.createSession({
        assetId: snapshot.value.assetId,
        dataUrl: currentSourceDataUrl(),
        width: dimensions.value.width,
        height: dimensions.value.height
      });
      sessionId.value = String(session.sessionId);
      status.value = `特征计算完成（${session.embeddingMs}ms）`;
    } catch (failure: any) {
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
    error.value = failure.message || String(failure);
  } finally {
    if (revision === requestRevision.value) samBusy.value = false;
  }
}

function selectCandidate(index: number) {
  const mask = candidateMasks.value[index];
  if (!mask) return;
  pushHistory(); selectedCandidate.value = index; selection.value = new Uint8Array(mask); maskRevision.value++; markChanged(); render();
}

function removePoint(index: number) {
  points.value = points.value.filter((_, current) => current !== index);
  candidates.value = []; candidateMasks.value = [];
  status.value = '提示点已修改，请再次点击主体继续智能选择。';
}

async function pointerDown(event: PointerEvent) {
  if (!source.value || event.button !== 0 || localBusy.value || compareOriginal.value || mode.value === 'upscale') return;
  const point = canvasPoint(event);
  if (tool.value === 'pan') {
    panning = { x: event.clientX, y: event.clientY, left: viewport.value!.scrollLeft, top: viewport.value!.scrollTop };
  } else if (tool.value === 'smart' || tool.value === 'smart-background') {
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

function invert() { pushHistory(); selection.value = invertMask(selection.value); maskRevision.value++; markChanged(); render(); }
function clearSelection() { pushHistory(); selection.value = new Uint8Array(selection.value.length); maskRevision.value++; markChanged(); render(); }

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

async function resetSession() {
  if (!openingCheckpoint.value || localBusy.value || samBusy.value || saving.value) return;
  const current = captureCheckpoint();
  if (!current || current.stateId === openingCheckpoint.value.stateId) return;
  pushHistory(current);
  await restoreCheckpoint(openingCheckpoint.value);
  markChanged();
  status.value = '已重置到本次打开编辑器时的状态，可撤销恢复。';
}

async function restoreProcessedImage() {
  const restore = snapshot.value?.processingRestore;
  if (!restore || localBusy.value || samBusy.value || saving.value) return;
  const before = captureCheckpoint();
  if (!before) return;
  await replaceWorkingImage(restore.dataUrl);
  pushHistory(before);
  operations.value = [...operations.value, { kind: 'restore', dataUrl: restore.dataUrl, scope: restore.scope }];
  markChanged();
  status.value = '已恢复处理前图片，点击保存后正式应用。';
}

async function save() {
  if (!snapshot.value || !source.value || !canSave.value) return;
  const lastCutout = [...operations.value].reverse().find(operation => operation.kind === 'cutout');
  saving.value = true;
  error.value = '';
  status.value = '正在保存全部图像处理结果…';
  try {
    await props.commit({
      assetId: snapshot.value.assetId,
      dataUrl: currentSourceDataUrl(),
      sourceSignature: snapshot.value.sourceSignature,
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
  requestRevision.value++;
  if (localProgressId.value) await props.backend.cancel(localProgressId.value).catch(() => {});
  if (sessionId.value) await props.backend.closeSession(sessionId.value).catch(() => {});
  sessionId.value = ''; visible.value = false; showUnsaved.value = false;
  localBusy.value = false;
  localProgressId.value = '';
  emit('close');
}

function requestClose() {
  if (saving.value) return;
  if (dirty.value || localBusy.value || samBusy.value) showUnsaved.value = true;
  else void closeNow();
}

function keydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement;
  if (target.matches('input, select, textarea')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); return; }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'i') { event.preventDefault(); invert(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
  const keys: Record<string, CutoutTool> = { w: 'wand', s: mode.value === 'cutout' ? 'smart' : 'rect', r: 'rect', b: 'brush-add', e: 'brush-subtract' };
  const nextTool = keys[event.key.toLowerCase()];
  if (nextTool) tool.value = nextTool;
  else if (event.key === '[') settings.brushSize = Math.max(1, settings.brushSize - 2);
  else if (event.key === ']') settings.brushSize = Math.min(200, settings.brushSize + 2);
  else if (event.key === 'Escape') {
    drawing = false; lastPoint = null; panning = null; rectangleStart = null; rectangleBase = null; showUnsaved.value = false;
    status.value = '已取消当前动作。';
  }
}

async function open(next: CutoutEditorSnapshot) {
  initializing = true;
  snapshot.value = next; visible.value = true; dirty.value = false; showUnsaved.value = false;
  mode.value = 'cutout';
  tool.value = 'smart';
  error.value = '';
  status.value = mode.value === 'cutout'
    ? '点击主体开始智能选择；Alt+单击添加背景排除点。'
    : mode.value === 'repair'
      ? '框选或涂抹需要删除的文字/杂物，红色区域将由本地 LaMa 补齐。'
      : '选择 2× 或 4×，设计尺寸保持不变，只提高图片像素密度。';
  candidates.value = []; candidateMasks.value = []; points.value = []; history.value = []; future.value = []; operations.value = [];
  openingCheckpoint.value = undefined;
  nextStateId = 1;
  currentStateId = 0;
  saving.value = false;
  localHealthChecked.value = false;
  localHealthState.value = {};
  sessionId.value = ''; requestRevision.value++;
  try {
    const element = await loadHtmlImage(next.dataUrl);
    image.value = element;
    originalImage.value = element;
    const canvas = document.createElement('canvas'); canvas.width = element.naturalWidth; canvas.height = element.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('无法初始化智能抠图画布');
    context.drawImage(element, 0, 0);
    source.value = context.getImageData(0, 0, canvas.width, canvas.height);
    labs.value = createLabPixels(source.value);
    selection.value = next.maskDataUrl ? await maskFromDataUrl(next.maskDataUrl) : new Uint8Array(canvas.width * canvas.height);
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
    openingCheckpoint.value = captureCheckpoint();
    await nextTick(); fit(); render(); dialog.value?.focus();
    props.backend.health().then(health => {
      samAvailable.value = Boolean(health.ok && health.checkpointFound);
      if (!samAvailable.value) error.value = String(health.error || '本机 SAM 2 不可用；仍可使用魔棒和画笔。');
    }).catch(failure => { samAvailable.value = false; error.value = failure.message || String(failure); });
    props.backend.localHealth().then(health => {
      localHealthState.value = health;
      localHealthChecked.value = true;
      const unavailable = localModeError();
      if (mode.value !== 'cutout' && unavailable) error.value = unavailable;
      else if (mode.value !== 'cutout'
        && /(?:IOPaint|LaMa|Real-ESRGAN).*(?:不存在|不可用)/.test(error.value)) error.value = '';
    }).catch(failure => {
      localHealthState.value = {};
      localHealthChecked.value = true;
      if (mode.value !== 'cutout') error.value = failure.message || String(failure);
    });
  } catch (failure) {
    visible.value = false;
    snapshot.value = undefined;
    throw failure;
  } finally {
    initializing = false;
  }
}

watch(settings, () => {
  render();
  if (visible.value && !initializing && !restoringCheckpoint) markChanged();
}, { deep: true });
watch(previewBackground, render);
watch([mode, compareOriginal], () => {
  if (mode.value === 'cutout') status.value = '点击主体开始智能选择；Alt+单击添加背景排除点。';
  else if (mode.value === 'repair') status.value = '框选或涂抹需要删除的文字/杂物，红色区域将由本地 LaMa 补齐。';
  else status.value = '选择 2× 或 4×，设计尺寸保持不变，只提高图片像素密度。';
  tool.value = mode.value === 'cutout' ? 'smart' : mode.value === 'repair' ? 'rect' : 'pan';
  const unavailable = localModeError();
  if (mode.value !== 'cutout' && unavailable) error.value = unavailable;
  else if (mode.value !== 'cutout' && localAvailable.value && /(?:IOPaint|LaMa|Real-ESRGAN).*(?:不存在|不可用)/.test(error.value)) error.value = '';
  render();
});
marchTimer = setInterval(() => { if (visible.value) { march = (march + 1) % 8; render(); } }, 160);
onBeforeUnmount(() => { if (marchTimer) clearInterval(marchTimer); if (sessionId.value) void props.backend.closeSession(sessionId.value); });
defineExpose({ open, close: requestClose });
</script>

<template>
  <div v-if="visible" class="cutout-editor-overlay">
    <section ref="dialog" class="cutout-editor" role="dialog" aria-modal="true" aria-label="图像处理编辑器" tabindex="-1" @keydown="keydown">
      <header class="cutout-editor-header">
        <div><strong>图像处理</strong><span>{{ snapshot?.name }}</span></div>
        <nav class="cutout-mode-tabs" aria-label="图像处理模式">
          <button type="button" :class="{ active: mode === 'cutout' }" :aria-pressed="mode === 'cutout'" :disabled="localBusy || samBusy || saving" @click="mode = 'cutout'">智能抠图</button>
          <button type="button" :class="{ active: mode === 'repair' }" :aria-pressed="mode === 'repair'" :disabled="localBusy || samBusy || saving" @click="mode = 'repair'">局部修复</button>
          <button type="button" :class="{ active: mode === 'upscale' }" :aria-pressed="mode === 'upscale'" :disabled="localBusy || samBusy || saving" @click="mode = 'upscale'">高清化</button>
        </nav>
        <div class="cutout-editor-header-actions">
          <button type="button" :disabled="!canUndo || localBusy || samBusy || saving" aria-label="撤销" title="撤销 Ctrl+Z" @click="undo">撤销</button>
          <button type="button" :disabled="!canRedo || localBusy || samBusy || saving" aria-label="重做" title="重做 Ctrl+Y" @click="redo">重做</button>
          <button type="button" aria-label="关闭图像处理" @click="requestClose">×</button>
        </div>
      </header>
      <div class="cutout-editor-body">
        <aside class="cutout-editor-tools" aria-label="选区工具">
          <button v-if="mode === 'cutout'" :class="{ active: tool === 'smart' }" type="button" :disabled="samBusy || !samAvailable" title="智能选择 S" @click="tool = 'smart'">智能选择</button>
          <button v-if="mode === 'cutout'" :class="{ active: tool === 'smart-background' }" type="button" :disabled="samBusy || !samAvailable" title="背景排除点" @click="tool = 'smart-background'">排除点</button>
          <button v-if="mode === 'repair'" :class="{ active: tool === 'rect' }" type="button" :disabled="localBusy" title="矩形框选 R" @click="tool = 'rect'">矩形框选</button>
          <button v-if="mode !== 'upscale'" :class="{ active: tool === 'wand' }" type="button" :disabled="localBusy" title="色域魔棒 W" @click="tool = 'wand'">魔棒</button>
          <button v-if="mode !== 'upscale'" :class="{ active: tool === 'brush-add' }" type="button" :disabled="localBusy" :title="mode === 'repair' ? '修复画笔 B' : '保留画笔 B'" @click="tool = 'brush-add'">{{ mode === 'repair' ? '修复画笔' : '保留画笔' }}</button>
          <button v-if="mode !== 'upscale'" :class="{ active: tool === 'brush-subtract' }" type="button" :disabled="localBusy" title="排除画笔 E" @click="tool = 'brush-subtract'">排除画笔</button>
          <button :class="{ active: tool === 'pan' }" type="button" title="平移" @click="tool = 'pan'">平移</button>
        </aside>
        <main ref="viewport" class="cutout-editor-viewport" :class="`preview-${previewBackground}`">
          <div class="cutout-editor-stage" :style="stageStyle">
            <canvas ref="baseCanvas" aria-hidden="true" />
            <canvas ref="resultCanvas" aria-hidden="true" />
            <canvas ref="overlayCanvas" :aria-label="mode === 'repair' ? '局部修复选区画布' : '智能抠图选区画布'" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp" @pointercancel="pointerUp" />
            <button v-for="(point, index) in (mode === 'cutout' ? points : [])" :key="`${index}-${point.x}-${point.y}`" class="cutout-point" :class="point.label"
              type="button" :style="{ left: `${point.x / dimensions.width * 100}%`, top: `${point.y / dimensions.height * 100}%` }"
              :title="`${point.label === 'foreground' ? '保留点' : '排除点'}，单击删除`" @click.stop="removePoint(index)" />
          </div>
        </main>
        <aside class="cutout-editor-settings">
          <div v-if="samBusy || localBusy || saving" class="cutout-inline-status" role="status" aria-live="polite"><span aria-hidden="true" />{{ status }}<button v-if="localBusy" type="button" @click="cancelLocalTask">取消</button></div>
          <p v-else class="cutout-help">{{ status }}</p>
          <p v-if="error" class="cutout-error" role="alert">{{ error }}</p>
          <fieldset v-if="mode === 'cutout' && candidates.length" class="cutout-candidates"><legend>SAM 候选</legend>
            <button v-for="(candidate, index) in candidates" :key="candidate.index" type="button" :class="{ active: selectedCandidate === index }" @click="selectCandidate(index)">
              候选 {{ index + 1 }} <span>{{ Math.round(candidate.score * 100) }}%</span>
            </button>
          </fieldset>
          <fieldset v-if="mode !== 'upscale'"><legend>选区方式</legend>
            <div class="cutout-segmented">
              <button v-for="mode in (['replace', 'add', 'subtract'] as CutoutCombineMode[])" :key="mode" type="button" :class="{ active: combine === mode }" @click="combine = mode">{{ { replace: '替换', add: '添加', subtract: '减去' }[mode] }}</button>
            </div>
            <label>魔棒容差 <output>{{ settings.tolerance }}</output><input v-model.number="settings.tolerance" type="range" min="0" max="100" /></label>
            <label class="cutout-check"><input v-model="settings.contiguous" type="checkbox" />仅选择连续区域</label>
          </fieldset>
          <fieldset v-if="mode !== 'upscale'"><legend>画笔</legend>
            <label>大小 <output>{{ settings.brushSize }}px</output><input v-model.number="settings.brushSize" type="range" min="1" max="200" /></label>
            <label>硬度 <output>{{ settings.brushHardness }}%</output><input v-model.number="settings.brushHardness" type="range" min="0" max="100" /></label>
          </fieldset>
          <fieldset v-if="mode === 'cutout'"><legend>透明边缘</legend>
            <label class="cutout-check"><input v-model="settings.fillHoles" type="checkbox" />填充内部孔洞</label>
            <label>扩展/收缩 <output>{{ settings.expand }}px</output><input v-model.number="settings.expand" type="range" min="-10" max="10" /></label>
            <label>羽化 <output>{{ settings.feather }}px</output><input v-model.number="settings.feather" type="range" min="0" max="12" /></label>
            <label>去杂色 <output>{{ settings.decontaminate }}%</output><input v-model.number="settings.decontaminate" type="range" min="0" max="100" /></label>
          </fieldset>
          <fieldset v-if="mode === 'repair'"><legend>修复边缘</legend>
            <label>蒙版扩展 <output>{{ settings.repairExpand }}px</output><input v-model.number="settings.repairExpand" type="range" min="0" max="16" /></label>
            <label>合成羽化 <output>{{ settings.repairFeather }}px</output><input v-model.number="settings.repairFeather" type="range" min="0" max="12" /></label>
            <p class="cutout-field-note">扩展用于覆盖文字抗锯齿残边；蒙版以外像素保持原样。</p>
          </fieldset>
          <fieldset v-if="mode === 'upscale'"><legend>高清设置</legend>
            <div class="cutout-segmented">
              <button type="button" :class="{ active: upscaleScale === 2 }" :aria-pressed="upscaleScale === 2" @click="upscaleScale = 2">2×{{ recommendedUpscaleScale === 2 ? ' 推荐' : '' }}</button>
              <button type="button" :class="{ active: upscaleScale === 4 }" :aria-pressed="upscaleScale === 4" @click="upscaleScale = 4">4×{{ recommendedUpscaleScale === 4 ? ' 推荐' : '' }}</button>
            </div>
            <dl class="cutout-dimensions"><div><dt>当前像素</dt><dd>{{ dimensions.width }} × {{ dimensions.height }}</dd></div><div><dt>输出像素</dt><dd>{{ dimensions.width * upscaleScale }} × {{ dimensions.height * upscaleScale }}</dd></div><div><dt>Figma 尺寸</dt><dd>保持不变</dd></div></dl>
            <p class="cutout-field-note">使用 RealESRGAN_x4plus_anime_6B。小于 128px 的图标建议 4×；画布放大预览仍会放大像素，请用 100% 检查最终清晰度。</p>
          </fieldset>
          <div v-if="mode !== 'upscale'" class="cutout-small-actions"><button type="button" :disabled="localBusy" @click="invert">反选</button><button type="button" :disabled="localBusy" @click="clearSelection">清空选区</button></div>
        </aside>
      </div>
      <footer class="cutout-editor-footer">
        <div class="cutout-preview-controls">
          <label>预览背景<select v-model="previewBackground"><option value="checker">棋盘格</option><option value="white">白色</option><option value="black">黑色</option></select></label>
          <button type="button" @click="fit">适应</button><button type="button" @click="zoom = 1">100%</button>
          <button type="button" aria-label="缩小" @click="zoom = Math.max(.05, zoom / 1.25)">−</button><output>{{ Math.round(zoom * 100) }}%</output><button type="button" aria-label="放大" @click="zoom = Math.min(16, zoom * 1.25)">＋</button>
        </div>
        <div class="cutout-save-actions">
          <button v-if="mode !== 'cutout'" type="button" :aria-pressed="compareOriginal" :disabled="localBusy || saving" @click="compareOriginal = !compareOriginal">{{ compareOriginal ? '查看结果' : '对比原图' }}</button>
          <button v-if="snapshot?.processingRestore" type="button" :disabled="localBusy || samBusy || saving" @click="restoreProcessedImage">恢复处理前图片</button>
          <button type="button" :disabled="localBusy || samBusy || saving || !dirty" @click="resetSession">重置本次修改</button>
          <button type="button" :disabled="saving" @click="requestClose">关闭</button>
          <button v-if="mode === 'cutout'" class="primary" type="button" :disabled="!hasSelection || samBusy || localBusy || saving" @click="applyCutoutToWorkingImage">保留选区并透明背景</button>
          <button v-else-if="mode === 'repair'" class="primary repair" type="button" :disabled="!hasSelection || localBusy || samBusy || saving || !localAvailable" @click="runLocalRepair">移除选中内容并补齐</button>
          <button v-else class="primary" type="button" :disabled="localBusy || samBusy || saving || !localAvailable" @click="runUpscale">开始 {{ upscaleScale }}× 高清化</button>
          <button class="primary save-all" type="button" :disabled="!canSave" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </footer>
      <div v-if="showUnsaved" class="cutout-unsaved"><div><strong>{{ localBusy || samBusy ? '取消任务并放弃修改？' : '放弃未保存的修改？' }}</strong><p>{{ localBusy || samBusy ? '当前 AI 任务将被取消，迟到的处理结果不会写入切图。' : '智能抠图、局部修复和高清化的本次结果都不会应用。' }}</p><div><button type="button" @click="showUnsaved = false">继续编辑</button><button type="button" class="danger" @click="closeNow">放弃并关闭</button></div></div></div>
    </section>
  </div>
</template>
