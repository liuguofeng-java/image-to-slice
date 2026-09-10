import type { Placement } from "../types/workspace";
export function createInnerFeatherMaskDataUrl(mask: string, radius: number): Promise<string>;
export function compositeAiInpaintResult(source: string, result: string, mask: string): Promise<string>;
export function createAiCompleteRegionsMaskDataUrl(placement: Placement, regions: Placement[]): string;
