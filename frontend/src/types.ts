export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Asset {
  id: string;
  width: number;
  height: number;
  name: string;
}
export type AlphaMode = 'opaque' | 'cutout' | 'translucent';
export interface RenderIntent {
  alphaMode: AlphaMode;
  visualDescription: string;
}
export type TextResizeMode = 'auto-width' | 'auto-height' | 'fixed';
export interface LayerBase extends Rect {
  id: string;
  name: string;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  opacity: number;
  hidden: boolean;
  locked: boolean;
  source?: { layerId: string; rect: Rect };
}
export interface ImageLayer extends LayerBase {
  type: 'image';
  assetId: string;
  radius: number;
  renderIntent?: RenderIntent;
}
export interface TextStyle {
  content: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  fill: string;
  align: 'left' | 'center' | 'right';
  verticalAlign: 'top' | 'middle' | 'bottom';
  lineHeight: number;
  letterSpacing: number;
  resizeMode: TextResizeMode;
}
export interface TextLayer extends LayerBase, TextStyle {
  type: 'text';
}
export type Layer = ImageLayer | TextLayer;
export interface Scene {
  id: string;
  name: string;
  width: number;
  height: number;
  layers: Layer[];
}
export interface Document {
  name: string;
  activeSceneId: string;
  scenes: Scene[];
}
export interface Project extends Document {
  id: string;
  revision: number;
  updatedAt: string;
}
export interface Candidate extends Rect {
  id: string;
  name: string;
  category: 'image' | 'icon' | 'text' | 'background';
  enabled: boolean;
  generate?: boolean;
  text?: TextStyle;
  renderIntent?: RenderIntent;
}
export interface Job {
  id: string;
  status: 'running' | 'ready' | 'generating' | 'failed' | 'cancelled' | 'applied';
  message: string;
  region: Rect;
  candidates: Candidate[];
  generation?: {
    completed: number;
    total: number;
    failed: number;
    targets: {
      id: string;
      name: string;
      status: 'pending' | 'running' | 'ready' | 'failed';
      message: string;
    }[];
  };
  resultRevision?: number;
}
export interface LayerRegenerationJob {
  id: string;
  status: 'generating' | 'failed' | 'cancelled' | 'applied';
  message: string;
  generation: {
    completed: number;
    total: 1;
    failed: number;
    targets: {
      id: string;
      name: string;
      status: 'pending' | 'running' | 'ready' | 'failed';
      message: string;
    }[];
  };
  resultRevision?: number;
}
export interface ModelConfig {
  baseUrl: string;
  model: string;
  imageModel?: string;
  imageQuality?: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeoutSeconds: number;
  hasApiKey?: boolean;
  apiKey?: string;
}
