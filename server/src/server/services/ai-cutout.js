const sharp = require("sharp");
const { validateAiImageDimensions } = require("../../core/ai-image-dimensions");

function decodeCutoutImage(dataUrl) {
  const match = /^data:image\/(?:png|jpeg|jpg|webp);base64,(.+)$/s.exec(String(dataUrl || ""));
  if (!match) throw Object.assign(new Error("抠图需要 PNG、JPG 或 WebP 图片"), { statusCode: 400 });
  return Buffer.from(match[1], "base64");
}

async function prepareCutoutReference(dataUrl, size = 1024) {
  const buffer = decodeCutoutImage(dataUrl);
  const metadata = await sharp(buffer).metadata();
  const { width, height } = validateAiImageDimensions(metadata.width, metadata.height);
  // Pad instead of stretching: mask coordinates must map back to source pixels.
  const margin = Math.max(2, Math.round(size / 32));
  const scale = (size - margin * 2) / Math.max(width, height);
  const contentWidth = Math.max(1, Math.round(width * scale));
  const contentHeight = Math.max(1, Math.round(height * scale));
  const box = {
    left: Math.floor((size - contentWidth) / 2),
    top: Math.floor((size - contentHeight) / 2),
    width: contentWidth,
    height: contentHeight
  };
  const reference = await sharp(buffer)
    .flatten({ background: "#808080" })
    .resize(contentWidth, contentHeight)
    .extend({
      left: box.left, top: box.top,
      right: size - box.left - contentWidth,
      bottom: size - box.top - contentHeight,
      background: "#808080"
    }).png().toBuffer();
  return { buffer, reference, width, height, size, box };
}

function buildCutoutMaskPrompt(prepared, { contentType, compositeParent } = {}) {
  const { size, box } = prepared;
  return [
    "Return ONLY a grayscale foreground segmentation mask, not a color image or a redrawn asset.",
    `The supplied reference canvas is ${size}x${size}. Its source content rectangle is ${JSON.stringify(box)}. Everything outside that rectangle must be BLACK.`,
    "Match the reference pixel coordinates exactly. Do not center, enlarge, shrink, rotate, simplify, or move the subject.",
    compositeParent || contentType === "background"
      ? "Select the complete UI button/panel body, including its opaque interior, decorative border, bevel and soft outer glow. Exclude the scenery behind it and neighboring UI. The cleared interior is still foreground."
      : "Select the principal foreground icon/object in this crop. Exclude the UI panel or scene behind the icon, neighboring text, panel borders and other objects.",
    "WHITE (255) means keep the subject. BLACK (0) means remove the background. Gray is allowed only for antialiased silhouette edges and genuinely translucent outer shadows/glow.",
    "The subject's internal colors are irrelevant: white highlights, metallic reflections, dark outlines, embossed stars, internal rings and texture are all solid WHITE mask, never transparent holes.",
    "A solid coin or filled button must have a filled, unbroken interior. Black interior holes are allowed only for actual open spaces through the object, such as a ring's central opening.",
    "Do not output checkerboards, gradients inside opaque surfaces, color, labels, legends, or an alpha channel. Output one opaque black-and-white PNG at the exact reference canvas size."
  ].join("\n");
}

async function applyCutoutMask(prepared, maskDataUrl) {
  const maskBuffer = decodeCutoutImage(maskDataUrl);
  const metadata = await sharp(maskBuffer).metadata();
  if (!metadata.width || !metadata.height || Math.abs(metadata.width / metadata.height - 1) > 0.02) {
    throw new Error("AI 返回的轮廓蒙版比例不正确，请重试 AI 透明");
  }
  // A white silhouette on transparent pixels is equivalent to a white-on-black
  // mask. Composite before resizing so invisible RGB cannot bleed into edges.
  const pixels = await sharp(maskBuffer).toColourspace("srgb").flatten({ background: "#000000" })
    .resize(prepared.size, prepared.size).ensureAlpha().raw().toBuffer();
  let colored = 0;
  let black = 0;
  let white = 0;
  let padding = 0;
  let invalidPadding = 0;
  const count = pixels.length / 4;
  for (let i = 0; i < pixels.length; i += 4) {
    const max = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
    const min = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (max - min > 20) colored++;
    if (max < 24) black++;
    if (min > 231) white++;
    const x = (i / 4) % prepared.size;
    const y = Math.floor(i / 4 / prepared.size);
    const box = prepared.box;
    if (x < box.left || x >= box.left + box.width || y < box.top || y >= box.top + box.height) {
      padding++;
      if (max > 64) invalidPadding++;
    }
  }
  const reasons = [];
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  if (colored / count > 0.01) reasons.push(`返回了彩色内容（${percent(colored / count)}），不是黑白轮廓`);
  if (black === 0) reasons.push("缺少黑色背景，可能黑白反转或未去除背景");
  if (white === 0) reasons.push("缺少白色主体，可能是空白或过暗的蒙版");
  if ((black + white) / count < 0.65) reasons.push(`灰色区域过多（${percent(1 - (black + white) / count)}），主体与背景未明确分离`);
  if (invalidPadding / padding > 0.05) reasons.push(`参考图外留白未清空（${percent(invalidPadding / padding)}），可能轮廓错位或黑白反转`);
  if (reasons.length) {
    throw new Error(`AI 未返回有效的黑白轮廓蒙版：${reasons.join("；")}。已保留原切图。`);
  }
  const alpha = await sharp(pixels, { raw: { width: prepared.size, height: prepared.size, channels: 4 } })
    .extract(prepared.box)
    .resize(prepared.width, prepared.height)
    .removeAlpha().greyscale().raw().toBuffer();
  const source = await sharp(prepared.buffer).toColourspace("srgb").ensureAlpha().raw().toBuffer();
  let kept = 0;
  for (let pixel = 0; pixel < alpha.length; pixel++) {
    // Snap near-white/black noise, leaving a narrow soft edge. Never key source RGB.
    const coverage = Math.max(0, Math.min(1, (alpha[pixel] - 16) / 223));
    source[pixel * 4 + 3] = Math.round(source[pixel * 4 + 3] * coverage);
    if (source[pixel * 4 + 3] > 0) kept++;
  }
  if (!kept) throw new Error("AI 未识别到可保留的主体，已保留原切图");
  const result = await sharp(source, {
    raw: { width: prepared.width, height: prepared.height, channels: 4 }
  }).png().toBuffer();
  return `data:image/png;base64,${result.toString("base64")}`;
}

async function cutoutAsset(payload, requestContext, { normalizeImageResponse, updateProgress = () => {} }) {
  const prepared = await prepareCutoutReference(payload.dataUrl);
  updateProgress(payload.progressId, "正在识别主体轮廓，保留原图高光与纹理");
  const form = new FormData();
  form.set("model", requestContext.config.model);
  form.set("prompt", buildCutoutMaskPrompt(prepared, payload));
  form.set("size", `${prepared.size}x${prepared.size}`);
  form.set("quality", payload.quality || "high");
  form.set("output_format", "png");
  form.set("n", "1");
  form.append("image[]", new Blob([prepared.reference], { type: "image/png" }), "cutout-reference.png");
  const response = await normalizeImageResponse(await requestContext.callForm("/v1/images/edits", form));
  const mask = response.images?.[0]?.dataUrl;
  if (!mask) throw new Error("AI 没有返回主体轮廓蒙版");
  updateProgress(payload.progressId, "正在将轮廓应用到原图，保留原始像素");
  const dataUrl = await applyCutoutMask(prepared, mask);
  return {
    images: [{ dataUrl, width: prepared.width, height: prepared.height }],
    transparent: true,
    cutoutMethod: "source-pixels-with-ai-mask"
  };
}

module.exports = { prepareCutoutReference, buildCutoutMaskPrompt, applyCutoutMask, cutoutAsset };
