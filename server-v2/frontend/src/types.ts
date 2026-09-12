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
export interface Layer extends Rect {
  id: string;
  assetId: string;
  name: string;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  opacity: number;
  radius: number;
  hidden: boolean;
  locked: boolean;
  source?: { layerId: string; rect: Rect };
}
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
