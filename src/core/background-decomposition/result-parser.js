const {
  ALLOWED_BACKGROUND_OVERLAY_KINDS,
  MAX_BACKGROUND_CANDIDATES,
  MAX_BACKGROUND_OVERLAYS,
  MIN_BACKGROUND_SIZE,
  MIN_OVERLAY_SIZE
} = require("./constants");
const { normalizeSliceAssetName } = require("../slice-asset-name");

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  const withoutFence = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回 JSON 对象");
  try {
    return JSON.parse(withoutFence.slice(start, end + 1));
  } catch (error) {
    throw new Error(`JSON 解析失败：${error.message || String(error)}`);
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeBox(bbox, bounds, minimumSize) {
  const values = [bbox?.x, bbox?.y, bbox?.width, bbox?.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  const [x, y, width, height] = values;
  const rawLeft = Math.min(x, x + width);
  const rawTop = Math.min(y, y + height);
  const rawRight = Math.max(x, x + width);
  const rawBottom = Math.max(y, y + height);
  const left = Math.round(clamp(rawLeft, bounds.x, bounds.x + bounds.width));
  const top = Math.round(clamp(rawTop, bounds.y, bounds.y + bounds.height));
  const right = Math.round(clamp(rawRight, bounds.x, bounds.x + bounds.width));
  const bottom = Math.round(clamp(rawBottom, bounds.y, bounds.y + bounds.height));
  if (right - left < minimumSize || bottom - top < minimumSize) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function normalizeConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, 0, 1) : null;
}

function normalizeTextCandidate(entry, background, index) {
  if (!background) return null;
  const rawBox = entry?.bbox;
  const values = [rawBox?.x, rawBox?.y, rawBox?.width, rawBox?.height].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [x, y, width, height] = values;
  if (
    x < background.bbox.x
    || y < background.bbox.y
    || x + width > background.bbox.x + background.bbox.width
    || y + height > background.bbox.y + background.bbox.height
  ) return null;
  const bbox = normalizeBox(rawBox, background.bbox, MIN_OVERLAY_SIZE);
  const characters = String(entry?.text?.characters ?? entry?.characters ?? "").trim().slice(0, 2000);
  if (!bbox || !characters) return null;
  const text = entry?.text && typeof entry.text === "object" ? entry.text : entry;
  const shadow = text.shadow && typeof text.shadow === "object" ? text.shadow : null;
  return {
    id: String(entry?.id || "").trim().slice(0, 120) || `text_${String(index + 1).padStart(2, "0")}`,
    name: normalizeSliceAssetName(entry?.name) || `text_${String(index + 1).padStart(2, "0")}`,
    parentBackgroundId: background.id,
    bbox,
    confidence: normalizeConfidence(entry?.confidence),
    reason: String(entry?.reason || "").trim().slice(0, 300),
    text: {
      characters,
      fontSize: clamp(Number(text.fontSize) || 16, 1, 512),
      fontWeight: clamp(Number(text.fontWeight) || 400, 100, 900),
      fontFamily: String(text.fontFamily || "").trim().slice(0, 120),
      lineHeight: clamp(
        Number(text.lineHeight) > 5 ? Number(text.lineHeight) : (Number(text.lineHeight) || 1.2) * (Number(text.fontSize) || 16),
        Number(text.fontSize) || 16,
        240
      ),
      letterSpacing: clamp(Number(text.letterSpacing) || 0, -20, 100),
      color: String(text.color || "#000000").trim().slice(0, 32),
      textAlignHorizontal: ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"].includes(String(text.textAlignHorizontal || "").toUpperCase())
        ? String(text.textAlignHorizontal).toUpperCase()
        : "CENTER",
      strokeColor: String(text.strokeColor || "").trim().slice(0, 32),
      strokeWidth: clamp(Number(text.strokeWidth) || 0, 0, 50),
      shadow: shadow ? {
        color: String(shadow.color || "#000000").trim().slice(0, 32),
        opacity: clamp(Number(shadow.opacity) || 0, 0, 1),
        x: clamp(Number(shadow.x) || 0, -100, 100),
        y: clamp(Number(shadow.y) || 0, -100, 100),
        blur: clamp(Number(shadow.blur) || 0, 0, 200)
      } : null
    }
  };
}

function parseBackgroundDecompositionText(text, { width, height }) {
  const sourceWidth = Math.round(Number(width));
  const sourceHeight = Math.round(Number(height));
  if (!Number.isFinite(sourceWidth) || sourceWidth < 1 || !Number.isFinite(sourceHeight) || sourceHeight < 1) {
    throw new Error("原图尺寸无效");
  }
  const value = extractJsonObject(text);
  const canvasBounds = { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  const backgrounds = [];
  (Array.isArray(value?.backgrounds) ? value.backgrounds : [])
    .slice(0, MAX_BACKGROUND_CANDIDATES)
    .forEach((background, backgroundIndex) => {
      const bbox = normalizeBox(background?.bbox, canvasBounds, MIN_BACKGROUND_SIZE);
      if (!bbox) return;
      const overlays = [];
      (Array.isArray(background?.overlays) ? background.overlays : [])
        .slice(0, MAX_BACKGROUND_OVERLAYS)
        .forEach((overlay, overlayIndex) => {
          const kind = String(overlay?.kind || "").trim();
          if (!ALLOWED_BACKGROUND_OVERLAY_KINDS.has(kind)) return;
          const overlayBox = normalizeBox(overlay?.bbox, bbox, MIN_OVERLAY_SIZE);
          if (!overlayBox) return;
          overlays.push({
            id: String(overlay?.id || "").trim().slice(0, 120) || `overlay_${String(overlayIndex + 1).padStart(2, "0")}`,
            name: String(overlay?.name || "").trim().slice(0, 120) || `覆盖层 ${overlayIndex + 1}`,
            kind,
            bbox: overlayBox,
            confidence: normalizeConfidence(overlay?.confidence),
            reason: String(overlay?.reason || "").trim().slice(0, 300)
          });
        });
      backgrounds.push({
        id: String(background?.id || "").trim().slice(0, 120) || `background_${String(backgroundIndex + 1).padStart(2, "0")}`,
        name: normalizeSliceAssetName(background?.name) || `slice_${String(backgroundIndex + 1).padStart(2, "0")}`,
        bbox,
        confidence: normalizeConfidence(background?.confidence),
        reason: String(background?.reason || "").trim().slice(0, 300),
        bakedVisuals: (Array.isArray(background?.bakedVisuals) ? background.bakedVisuals : [])
          .map((entry) => String(entry || "").trim().slice(0, 120))
          .filter(Boolean)
          .slice(0, 24),
        overlays
      });
    });
  const backgroundById = new Map(backgrounds.map((background) => [background.id, background]));
  const texts = (Array.isArray(value?.texts) ? value.texts : [])
    .map((entry, index) => normalizeTextCandidate(
      entry,
      backgroundById.get(String(entry?.parentBackgroundId || "").trim()),
      index
    ))
    .filter(Boolean);
  return { backgrounds, texts };
}

module.exports = {
  parseBackgroundDecompositionText
};
