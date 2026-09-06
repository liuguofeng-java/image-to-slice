export type CutoutEditorMode = 'cutout' | 'repair' | 'upscale';
export type CutoutTool = 'smart' | 'smart-background' | 'rect' | 'wand' | 'brush-add' | 'brush-subtract' | 'pan';
export type CutoutCombineMode = 'replace' | 'add' | 'subtract';
export type CutoutPreviewBackground = 'checker' | 'white' | 'black';
export type SamPointLabel = 'foreground' | 'background';

export interface SamPoint { x: number; y: number; label: SamPointLabel; automatic?: boolean }
export interface SamCandidate { index: number; score: number; maskDataUrl: string }
export interface CutoutSettings {
  tolerance: number;
  contiguous: boolean;
  fillHoles: boolean;
  expand: number;
  feather: number;
  decontaminate: number;
  brushSize: number;
  brushHardness: number;
  repairExpand: number;
  repairFeather: number;
}
export interface CutoutEditorSnapshot {
  assetId: string;
  name: string;
  dataUrl: string;
  contentType: 'background' | 'image';
  maskDataUrl?: string | null;
  settings?: Partial<CutoutSettings> | null;
  childSignature?: string;
  openMode?: CutoutEditorMode;
  sourcePixelWidth?: number | null;
  sourcePixelHeight?: number | null;
  outputPixelWidth?: number | null;
  outputPixelHeight?: number | null;
  upscaleScale?: number | null;
  sourceSignature?: string;
  processingRestore?: {
    dataUrl: string;
    scope: 'image-processing' | 'transparency';
  } | null;
}

export type ImageEditorOperation =
  | {
      kind: 'cutout';
      dataUrl: string;
      maskDataUrl: string;
      settings: CutoutSettings;
      childSignature?: string;
    }
  | {
      kind: 'inpaint';
      dataUrl: string;
      maskDataUrl: string;
      sourceSignature: string;
      inferenceMs?: number;
    }
  | {
      kind: 'upscale';
      dataUrl: string;
      scale: 2 | 4;
      sourcePixelWidth?: number;
      sourcePixelHeight?: number;
      outputPixelWidth?: number;
      outputPixelHeight?: number;
      inferenceMs?: number;
    }
  | {
      kind: 'restore';
      dataUrl: string;
      scope: 'image-processing' | 'transparency';
    };

export interface ImageEditorSaveResult {
  assetId: string;
  dataUrl: string;
  sourceSignature?: string;
  operations: ImageEditorOperation[];
  maskDataUrl?: string;
  settings: CutoutSettings;
  childSignature?: string;
}

/** @deprecated Use ImageEditorSaveResult. */
export type CutoutSaveResult = ImageEditorSaveResult;
export interface CutoutEditorBackend {
  health(): Promise<Record<string, unknown>>;
  localHealth(): Promise<Record<string, unknown>>;
  createSession(payload: Record<string, unknown>): Promise<Record<string, any>>;
  predict(payload: Record<string, unknown>): Promise<Record<string, any>>;
  closeSession(sessionId: string): Promise<void>;
  inpaint(payload: Record<string, unknown>): Promise<Record<string, any>>;
  upscale(payload: Record<string, unknown>): Promise<Record<string, any>>;
  cancel(progressId: string): Promise<void>;
}

export interface LocalImageTaskState {
  assetId: string;
  progressId: string;
  operation: 'inpaint' | 'upscale';
  status: 'running' | 'completed' | 'failed';
  sourceDataUrl: string;
  maskDataUrl?: string;
  result?: Record<string, any>;
  error?: string;
}
