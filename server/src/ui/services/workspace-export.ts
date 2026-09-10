import { useWorkspaceStore } from '../stores/workspace';
import { buildSliceExportManifest } from './export-manifest.js';
import { createZipBlob, dataUrlToUint8Array, textToUint8Array } from './zip.js';
import { downloadBlob } from './workspace-image';
import { getSliceRadius, getSliceRadii } from './slice-geometry.js';
export function exportSlices() {
  const store = useWorkspaceStore(); if (!store.image) return;
  const manifest = buildSliceExportManifest({ manifest: store.draft.manifest, activeImage: store.image, imageIndex: store.draft.activeResultIndex + 1, getSliceRadius: (a: any) => getSliceRadius(a, store.screen), getSliceRadii: (a: any) => getSliceRadii(a, store.screen) });
  const files: { name: string; data: Uint8Array }[] = [{ name: 'manifest.json', data: textToUint8Array(JSON.stringify(manifest, null, 2)) }];
  for (const entry of manifest.assets) { const a = store.assets.find(a => a.id === entry.id)!; if (entry.filename) files.push({ name: entry.filename, data: dataUrlToUint8Array(a.dataUrl) }); if (entry.svgFilename) files.push({ name: entry.svgFilename, data: textToUint8Array(a.svgData) }); }
  downloadBlob(createZipBlob(files), 'slices.zip');
}
