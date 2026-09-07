import type { CutoutCombineMode, CutoutSettings } from '../types/cutout-editor';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function srgbToLinear(value: number) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export function createLabPixels(image: ImageData) {
  const output = new Float32Array((image.data.length / 4) * 3);
  for (let source = 0, target = 0; source < image.data.length; source += 4, target += 3) {
    const r = srgbToLinear(image.data[source] ?? 0);
    const g = srgbToLinear(image.data[source + 1] ?? 0);
    const b = srgbToLinear(image.data[source + 2] ?? 0);
    const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
    const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
    const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
    const f = (v: number) => v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
    const fx = f(x); const fy = f(y); const fz = f(z);
    output[target] = 116 * fy - 16;
    output[target + 1] = 500 * (fx - fy);
    output[target + 2] = 200 * (fy - fz);
  }
  return output;
}

export function createWandMask(
  image: ImageData,
  labs: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  tolerance: number,
  contiguous: boolean
) {
  const count = width * height;
  const mask = new Uint8Array(count);
  const seed = clamp(Math.floor(y), 0, height - 1) * width + clamp(Math.floor(x), 0, width - 1);
  const target = seed * 3;
  const threshold = clamp(tolerance, 0, 100) ** 2;
  const matches = (index: number) => {
    if ((image.data[index * 4 + 3] ?? 0) === 0) return false;
    const offset = index * 3;
    const dl = (labs[offset] ?? 0) - (labs[target] ?? 0);
    const da = (labs[offset + 1] ?? 0) - (labs[target + 1] ?? 0);
    const db = (labs[offset + 2] ?? 0) - (labs[target + 2] ?? 0);
    return dl * dl + da * da + db * db <= threshold;
  };
  if (!contiguous) {
    for (let index = 0; index < count; index++) if (matches(index)) mask[index] = 255;
    return mask;
  }
  if (!matches(seed)) return mask;
  const visited = new Uint8Array(count);
  const queue = new Int32Array(count);
  let read = 0; let write = 0;
  queue[write++] = seed;
  visited[seed] = 1;
  while (read < write) {
    const index = queue[read++] ?? 0;
    mask[index] = 255;
    const px = index % width;
    const py = Math.floor(index / width);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || px + dx < 0 || px + dx >= width || py + dy < 0 || py + dy >= height) continue;
      const next = (py + dy) * width + px + dx;
      if (!visited[next]) {
        visited[next] = 1;
        if (matches(next)) queue[write++] = next;
      }
    }
  }
  return mask;
}

export function combineMasks(base: Uint8Array, incoming: Uint8Array, mode: CutoutCombineMode) {
  const output = new Uint8Array(base.length);
  for (let index = 0; index < output.length; index++) {
    const before = base[index] ?? 0;
    const incomingValue = incoming[index] ?? 0;
    if (mode === 'replace') output[index] = incomingValue;
    else if (mode === 'add') output[index] = Math.max(before, incomingValue);
    else output[index] = Math.round(before * (255 - incomingValue) / 255);
  }
  return output;
}

export function invertMask(mask: Uint8Array) {
  const output = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index++) output[index] = 255 - (mask[index] ?? 0);
  return output;
}

export function fillMaskHoles(mask: Uint8Array, width: number, height: number) {
  const outside = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let read = 0; let write = 0;
  const enqueue = (index: number) => {
    if ((mask[index] ?? 0) < 128 && !(outside[index] ?? 0)) { outside[index] = 1; queue[write++] = index; }
  };
  for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { enqueue(y * width); enqueue(y * width + width - 1); }
  while (read < write) {
    const index = queue[read++] ?? 0;
    const x = index % width; const y = Math.floor(index / width);
    if (x) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (y) enqueue(index - width);
    if (y + 1 < height) enqueue(index + width);
  }
  const output = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index++) output[index] = (mask[index] ?? 0) >= 128 || !(outside[index] ?? 0) ? 255 : 0;
  return output;
}

export function morphMask(mask: Uint8Array, width: number, height: number, amount: number) {
  let output = new Uint8Array(mask);
  const grow = amount > 0;
  for (let step = 0; step < Math.abs(Math.round(amount)); step++) {
    const next = new Uint8Array(output);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if ((grow && (output[index] ?? 0) >= 128) || (!grow && (output[index] ?? 0) < 128)) continue;
      let neighbor = grow ? 0 : 255;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx; const ny = y + dy;
        const value = nx >= 0 && nx < width && ny >= 0 && ny < height ? (output[ny * width + nx] ?? 0) : 0;
        neighbor = grow ? Math.max(neighbor, value) : Math.min(neighbor, value);
      }
      next[index] = neighbor;
    }
    output = next;
  }
  return output;
}

function boxBlur(values: Float32Array, width: number, height: number, radius: number) {
  if (!radius) return values;
  const horizontal = new Float32Array(values.length);
  const output = new Float32Array(values.length);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += values[y * width + clamp(x, 0, width - 1)] ?? 0;
    for (let x = 0; x < width; x++) {
      horizontal[y * width + x] = sum / (radius * 2 + 1);
      sum -= values[y * width + clamp(x - radius, 0, width - 1)] ?? 0;
      sum += values[y * width + clamp(x + radius + 1, 0, width - 1)] ?? 0;
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += horizontal[clamp(y, 0, height - 1) * width + x] ?? 0;
    for (let y = 0; y < height; y++) {
      output[y * width + x] = sum / (radius * 2 + 1);
      sum -= horizontal[clamp(y - radius, 0, height - 1) * width + x] ?? 0;
      sum += horizontal[clamp(y + radius + 1, 0, height - 1) * width + x] ?? 0;
    }
  }
  return output;
}

export function createAlphaMatte(mask: Uint8Array, width: number, height: number, settings: Pick<CutoutSettings, 'fillHoles' | 'expand' | 'feather'>) {
  let selected = settings.fillHoles ? fillMaskHoles(mask, width, height) : new Uint8Array(mask);
  selected = morphMask(selected, width, height, settings.expand);
  let values: Float32Array<ArrayBufferLike> = Float32Array.from(selected);
  const radius = Math.round(clamp(settings.feather, 0, 12));
  if (radius) values = boxBlur(boxBlur(values, width, height, radius), width, height, radius);
  const output = new Uint8ClampedArray(values.length);
  for (let index = 0; index < values.length; index++) output[index] = Math.round(clamp(values[index] ?? 0, 0, 255));
  return output;
}

export function applyAlphaMatte(source: ImageData, matte: Uint8ClampedArray, width: number, height: number, decontaminate: number) {
  const output = new ImageData(new Uint8ClampedArray(source.data), width, height);
  const strength = clamp(decontaminate, 0, 100) / 100;
  for (let pixel = 0; pixel < matte.length; pixel++) {
    const offset = pixel * 4;
    const alpha = source.data[offset + 3] ?? 0;
    const matteAlpha = matte[pixel] ?? 0;
    output.data[offset + 3] = Math.round(alpha * matteAlpha / 255);
    if (!strength || matteAlpha === 0 || matteAlpha === 255) continue;
    const x = pixel % width; const y = Math.floor(pixel / width);
    let found = -1;
    for (let radius = 1; radius <= 3 && found < 0; radius++) {
      for (let dy = -radius; dy <= radius && found < 0; dy++) for (let dx = -radius; dx <= radius; dx++) {
        const nx = x + dx; const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const candidate = ny * width + nx;
        if ((matte[candidate] ?? 0) === 255) { found = candidate * 4; break; }
      }
    }
    if (found >= 0) for (let channel = 0; channel < 3; channel++) {
      output.data[offset + channel] = Math.round((source.data[offset + channel] ?? 0) * (1 - strength) + (source.data[found + channel] ?? 0) * strength);
    }
  }
  return output;
}

export function packMask(mask: Uint8Array) {
  const packed = new Uint8Array(Math.ceil(mask.length / 8));
  for (let index = 0; index < mask.length; index++) if ((mask[index] ?? 0) >= 128) packed[index >> 3] = (packed[index >> 3] ?? 0) | (1 << (index & 7));
  return packed;
}

export function unpackMask(packed: Uint8Array, length: number) {
  const mask = new Uint8Array(length);
  for (let index = 0; index < length; index++) mask[index] = (((packed[index >> 3] ?? 0) >> (index & 7)) & 1) * 255;
  return mask;
}
