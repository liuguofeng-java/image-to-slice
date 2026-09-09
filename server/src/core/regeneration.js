// Exact rectangle union: unlike bounding-box merging, this never erases gaps.
function unionRegenerationRegions(regions, width, height) {
  const clipped = (regions || []).map(r => ({
    x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)),
    right: Math.min(width, Math.ceil(r.x + r.width)), bottom: Math.min(height, Math.ceil(r.y + r.height))
  })).filter(r => r.right > r.x && r.bottom > r.y);
  const xs = [...new Set(clipped.flatMap(r => [r.x, r.right]))].sort((a, b) => a - b);
  const result = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const intervals = clipped.filter(r => r.x <= xs[i] && r.right >= xs[i + 1]).sort((a, b) => a.y - b.y);
    const merged = [];
    for (const r of intervals) {
      const last = merged.at(-1);
      if (last && r.y <= last.bottom) last.bottom = Math.max(last.bottom, r.bottom);
      else merged.push({ y: r.y, bottom: r.bottom });
    }
    for (const r of merged) result.push({ x: xs[i], y: r.y, width: xs[i + 1] - xs[i], height: r.bottom - r.y });
  }
  return result;
}

function validateRegenerationDimensions(width, height, inputWidth = 1, inputHeight = 1) {
  if (![width, height].every(Number.isInteger) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 32_000_000) {
    throw new Error('图片尺寸超限：单边最多 16384 px，总面积最多 3200 万像素。');
  }
  if (width < inputWidth || height < inputHeight) throw new Error(`未达到清晰度要求：输出 ${width} × ${height}，输入 ${inputWidth} × ${inputHeight}。`);
}

if (typeof module !== 'undefined') module.exports = { unionRegenerationRegions, validateRegenerationDimensions };
