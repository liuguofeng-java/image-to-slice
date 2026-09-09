export interface RegenerationItem {
  id: string; name: string; dataUrl: string; width: number; height: number; childCount: number;
  status: 'pending' | 'running' | 'ready' | 'failed' | 'cancelled' | 'applied' | 'discarded';
  error?: string; progress?: string;
  result?: { dataUrl: string; width: number; height: number; provider: { model?: string } };
}
export interface RegenerationSnapshot {
  items: RegenerationItem[]; running: boolean; saving: boolean; confirmed: boolean;
  provider: string; error?: string;
}
export interface RegenerationAction { type: 'start' | 'retry' | 'apply' | 'discard' | 'cancel' | 'close'; id?: string }
