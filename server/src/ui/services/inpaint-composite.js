import { loadImageElement } from "./image-io.js";
async function createInnerFeatherMaskDataUrl(maskDataUrl, radius) {
  const mask = await loadImageElement(maskDataUrl);
  const width = Math.max(1, mask.naturalWidth || mask.width);
  const height = Math.max(1, mask.naturalHeight || mask.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建 AI 补齐羽化蒙版");
  context.drawImage(mask, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  const distances = new Uint16Array(width * height);
  const maxDistance = 65535;
  for (let index = 0; index < distances.length; index += 1) {
    distances[index] = imageData.data[index * 4] > 0 ? maxDistance : 0;
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (distances[index] === 0) continue;
      if (x > 0) distances[index] = Math.min(distances[index], distances[index - 1] + 1);
      if (y > 0) distances[index] = Math.min(distances[index], distances[index - width] + 1);
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      if (distances[index] === 0) continue;
      if (x + 1 < width) distances[index] = Math.min(distances[index], distances[index + 1] + 1);
      if (y + 1 < height) distances[index] = Math.min(distances[index], distances[index + width] + 1);
    }
  }
  const featherRadius = Math.max(1, Math.round(radius));
  for (let index = 0; index < distances.length; index += 1) {
    const alpha = distances[index] === 0 ? 0 : Math.min(1, distances[index] / featherRadius);
    const smoothAlpha = alpha * alpha * (3 - 2 * alpha);
    const value = Math.round(smoothAlpha * 255);
    imageData.data[index * 4] = value;
    imageData.data[index * 4 + 1] = value;
    imageData.data[index * 4 + 2] = value;
    imageData.data[index * 4 + 3] = 255;
  }
  context.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

async function compositeAiInpaintResult(sourceDataUrl, completedDataUrl, maskDataUrl) {
  const [source, completed, mask] = await Promise.all([
    loadImageElement(sourceDataUrl),
    loadImageElement(completedDataUrl),
    loadImageElement(maskDataUrl)
  ]);
  const width = Math.max(1, source.naturalWidth || source.width);
  const height = Math.max(1, source.naturalHeight || source.height);
  const sourceCanvas = document.createElement("canvas");
  const completedCanvas = document.createElement("canvas");
  const maskCanvas = document.createElement("canvas");
  sourceCanvas.width = completedCanvas.width = maskCanvas.width = width;
  sourceCanvas.height = completedCanvas.height = maskCanvas.height = height;
  const sourceContext = sourceCanvas.getContext("2d");
  const completedContext = completedCanvas.getContext("2d");
  const maskContext = maskCanvas.getContext("2d");
  if (!sourceContext || !completedContext || !maskContext) throw new Error("无法创建 AI 补齐合成画布");
  sourceContext.drawImage(source, 0, 0, width, height);
  completedContext.drawImage(completed, 0, 0, width, height);
  maskContext.drawImage(mask, 0, 0, width, height);
  const sourcePixels = sourceContext.getImageData(0, 0, width, height);
  const completedPixels = completedContext.getImageData(0, 0, width, height).data;
  const maskPixels = maskContext.getImageData(0, 0, width, height).data;
  for (let index = 0; index < sourcePixels.data.length; index += 4) {
    const selectionAlpha = maskPixels[index] / 255;
    if (selectionAlpha === 0) continue;
    for (let channel = 0; channel < 4; channel += 1) {
      sourcePixels.data[index + channel] = Math.round(
        sourcePixels.data[index + channel] * (1 - selectionAlpha)
          + completedPixels[index + channel] * selectionAlpha
      );
    }
  }
  sourceContext.putImageData(sourcePixels, 0, 0);
  return sourceCanvas.toDataURL("image/png");
}

function createAiCompleteRegionsMaskDataUrl(placement, regions) {
  const width = Math.max(1, Math.round(placement.width));
  const height = Math.max(1, Math.round(placement.height));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建 AI 补齐蒙版");
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#fff";
  regions.forEach((region) => {
    const x = Math.max(0, Math.round(region.x - placement.x));
    const y = Math.max(0, Math.round(region.y - placement.y));
    const regionWidth = Math.min(width - x, Math.round(region.width));
    const regionHeight = Math.min(height - y, Math.round(region.height));
    if (regionWidth <= 0 || regionHeight <= 0) return;
    context.fillRect(x, y, regionWidth, regionHeight);
  });
  return canvas.toDataURL("image/png");
}
export { createInnerFeatherMaskDataUrl, compositeAiInpaintResult, createAiCompleteRegionsMaskDataUrl };
