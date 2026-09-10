import type { SliceContentType } from './slice-list';
export interface Placement { x: number; y: number; width: number; height: number }
// Optional legacy processing metadata is kept intact when loading/saving v1 drafts.
export interface SliceAsset {
  id: string; name: string; dataUrl: string; placement: Placement;
  contentType: SliceContentType; parentId?: string | null; hidden?: boolean; selected?: boolean;
  initialPlacement?: { x: number; y: number }; regenerateMarked?: boolean;
  [metadata: string]: any;
}
export interface ResultImage {
  id: string; dataUrl: string; naturalWidth: number; naturalHeight: number;
  width?: number; height?: number; sliceManifest: { assets: SliceAsset[]; [key: string]: any };
  [metadata: string]: any;
}
export interface WorkspaceDraft {
  version: number; manifest: { screen: { name: string; width: number; height: number }; resultImages: ResultImage[]; [key: string]: any };
  activeResultIndex: number; activeSliceId: string | null; prompt: string; width: number; height: number;
  currentMode: string; currentRatio: string; currentStyle: string; referenceImages: { dataUrl: string; name: string }[];
  htmlPreviewSchemaVersion: number; htmlPreview: any; [legacyField: string]: any;
}
export interface ModelConfig { id: string; name: string; model: string; baseUrl: string; hasApiKey: boolean; tasks: string[]; timeoutMs?: number; timeoutSeconds?: number; testResults?: Record<string, { status: string; error?: string; testedAt?: string; nativeMaskSupported?: boolean }> }
export interface ModelConfigs { modelConfigs: ModelConfig[]; taskRouting: { generation?: string; inpaint?: string; vision?: string } }
