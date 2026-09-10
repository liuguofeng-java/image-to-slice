import type { SliceAsset } from '../types/workspace';

// Selection and transient progress are not image edits. Rollback snapshots normalize
// these fields, so including them would incorrectly block a failed save's retry.
export function assetEditSignature(asset: SliceAsset | undefined) {
  if (!asset) return '';
  const ignored = new Set(['selected', 'aiProcessing', 'aiProcessingLabel', 'aiProgressLogs']);
  return JSON.stringify(Object.fromEntries(Object.keys(asset).filter(key => !ignored.has(key)).sort().map(key => [key, asset[key]])));
}
