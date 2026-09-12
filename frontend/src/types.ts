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
  text?: TextStyle;
}
export interface Job {
  id: string;
  status: 'running' | 'ready' | 'failed' | 'cancelled' | 'applied';
  message: string;
  region: Rect;
  candidates: Candidate[];
}
export interface ModelConfig {
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  hasApiKey?: boolean;
  apiKey?: string;
}
