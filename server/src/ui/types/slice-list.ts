export type SliceContentType = 'unclassified' | 'background' | 'image' | 'text';

// Presentation data only. Source assets remain in the workspace until its
// migration; this boundary cannot mutate or serialize a source asset by mistake.
export interface SliceListRow {
  id: string;
  parentId: string | null;
  name: string;
  number: number;
  depth: number;
  childCount: number;
  contentType: SliceContentType;
  text: string;
  dataUrl: string;
  radius: string;
  description: string;
  selected: boolean;
  hidden: boolean;
  processing: boolean;
  processingLabel: string;
  auditFailed: boolean;
  hasActiveChildren: boolean;
  localTransparent: boolean;
  aiTransparent: boolean;
  aiTransparencyCurrent: boolean;
  locallyRepaired: boolean;
  upscaled: boolean;
}

export type SliceActionName = 'preview' | 'remove' | 'cancel' | 'visibility' | 'settings'
  | 'transparent' | 'ai-cutout';

export type SliceListEvent =
  | { type: SliceActionName; id: string }
  | { type: 'select'; id: string; shift: boolean; additive: boolean }
  | { type: 'reorder'; sourceId: string; targetId: string; before?: boolean };

export interface SliceListSnapshot {
  imageId: string;
  rows: SliceListRow[];
  animateReorder: boolean;
}
