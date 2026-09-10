import { describe, it, expect } from 'vitest';
import { replaceSliceEditedImage } from '../../src/ui/services/slice-edited-image';
import { assetEditSignature } from '../../src/ui/services/asset-edit-signature';
import type { SliceAsset } from '../../src/ui/types/workspace';

describe('same-resolution pixel editing', () => {
  const fixture = (): SliceAsset => ({ id: 'a', name: 'subject', contentType: 'image', dataUrl: 'hd', originalDataUrl: 'original', placement: { x: -3.5, y: 4.25, width: 50, height: 20 }, initialPlacement: { x: -3.5, y: 4.25 }, outputPixelWidth: 200, outputPixelHeight: 80, upscaleScale: 4, trimApplied: true, transparent: true, transparentDataUrl: 'hd', cutoutMaskDataUrl: 'old-mask', localInpaintDataUrl: 'old-repair' });
  it('preserves design geometry, source, HD density and trim metadata while clearing old masks', () => {
    const asset = fixture(), before = structuredClone(asset);
    replaceSliceEditedImage(asset, 'edited');
    expect(asset.dataUrl).toBe('edited'); expect(asset.transparentDataUrl).toBe('edited');
    for (const key of ['placement', 'initialPlacement', 'originalDataUrl', 'outputPixelWidth', 'outputPixelHeight', 'upscaleScale', 'trimApplied']) expect(asset[key]).toEqual(before[key]);
    expect(asset.cutoutMaskDataUrl).toBeUndefined(); expect(asset.localInpaintDataUrl).toBeUndefined();
    expect(asset.imageProcessingRestoreState.dataUrl).toBe('hd');
  });
  it('ignores transient selection/task properties but detects external image and geometry edits', () => {
    const asset = fixture(), signature = assetEditSignature(asset);
    asset.selected = true; asset.aiProcessing = false; asset.aiProcessingLabel = ''; asset.aiProgressLogs = [];
    expect(assetEditSignature(asset)).toBe(signature);
    asset.placement.x++; expect(assetEditSignature(asset)).not.toBe(signature);
    asset.placement.x--; asset.dataUrl = 'external'; expect(assetEditSignature(asset)).not.toBe(signature);
  });
});
