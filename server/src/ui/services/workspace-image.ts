import type { Placement } from '../types/workspace';
export function loadBitmap(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('图片解码失败')); img.src = dataUrl; });
}
export function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('读取图片失败')); reader.readAsDataURL(file); });
}
export async function cropImage(dataUrl: string, placement: Placement, screen: { width: number; height: number }) {
  const image = await loadBitmap(dataUrl);
  const sx = image.naturalWidth / screen.width, sy = image.naturalHeight / screen.height;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(placement.width * sx)); canvas.height = Math.max(1, Math.round(placement.height * sy));
  const context = canvas.getContext('2d')!;
  context.drawImage(image, placement.x * sx, placement.y * sy, placement.width * sx, placement.height * sy, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}
export async function decodePixels(dataUrl: string) {
  const image = await loadBitmap(dataUrl), canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const sourceSignature = (dataUrl: string) => `${dataUrl.length}:${dataUrl.slice(-48)}`;
