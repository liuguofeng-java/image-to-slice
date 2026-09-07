function buildRegionTextRecognitionPrompt({ width, height, region }) {
  return [
    "Read and visually inspect only the marked rectangular region of this UI screenshot.",
    `Screenshot size: ${width}x${height}px. Region: x=${region.x}, y=${region.y}, width=${region.width}, height=${region.height}.`,
    "Return the visible text as editable text, preserving its exact characters and line breaks.",
    "Estimate the text style from the screenshot. Do not include text outside the region.",
    "Return one JSON object with this exact shape:",
    '{"text":"","fontFamily":"","fontWeight":600,"fontSize":16,"lineHeight":20,"letterSpacing":0,"color":"#FFFFFF","textAlignHorizontal":"CENTER","strokeColor":"#000000","strokeWidth":0,"shadow":{"color":"#000000","opacity":0.35,"x":0,"y":2,"blur":4},"confidence":0.0,"warning":""}',
    "Use null for shadow when no shadow is visible. Colors must be six-digit hex values. Return JSON only."
  ].join("\n");
}

function parseRegionTextRecognitionText(rawText, { region }) {
  const value = extractJsonObject(rawText);
  const text = String(value?.text || "").trim().slice(0, 4000);
  if (!text) throw new Error("没有识别到文字内容");
  const fontSize = clampNumber(value?.fontSize, 8, 160, Math.max(12, Math.round(Number(region?.height) * 0.7) || 16));
  return {
    text: {
      characters: text,
      fontFamily: String(value?.fontFamily || "").trim().slice(0, 120),
      fontWeight: clampNumber(value?.fontWeight, 100, 900, 600),
      fontSize,
      lineHeight: clampNumber(value?.lineHeight, fontSize, 240, Math.round(fontSize * 1.2)),
      letterSpacing: clampNumber(value?.letterSpacing, -20, 100, 0),
      color: normalizeHex(value?.color, "#FFFFFF"),
      textAlignHorizontal: normalizeTextAlign(value?.textAlignHorizontal),
      strokeColor: normalizeHex(value?.strokeColor, "#000000"),
      strokeWidth: clampNumber(value?.strokeWidth, 0, 24, 0),
      shadow: normalizeShadow(value?.shadow)
    },
    confidence: clampNumber(value?.confidence, 0, 1, null),
    warning: String(value?.warning || "").trim().slice(0, 300)
  };
}

function extractJsonObject(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("文字识别模型没有返回 JSON 对象");
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    throw new Error(`文字识别 JSON 解析失败：${error.message || String(error)}`);
  }
}

function normalizeShadow(value) {
  if (!value || typeof value !== "object") return null;
  return {
    color: normalizeHex(value.color, "#000000"),
    opacity: clampNumber(value.opacity, 0, 1, 0.35),
    x: clampNumber(value.x, -100, 100, 0),
    y: clampNumber(value.y, -100, 100, 2),
    blur: clampNumber(value.blur, 0, 100, 4)
  };
}

function normalizeTextAlign(value) {
  const normalized = String(value || "").toUpperCase();
  return ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"].includes(normalized) ? normalized : "CENTER";
}

function normalizeHex(value, fallback) {
  const color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

module.exports = {
  buildRegionTextRecognitionPrompt,
  parseRegionTextRecognitionText
};
