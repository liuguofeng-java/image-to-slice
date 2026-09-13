import Konva from 'konva';
import type { TextLayer, TextStyle } from './types';

export const SYSTEM_FONTS = [
  'Microsoft YaHei',
  'Segoe UI',
  'Arial',
  'SimSun',
  'SimHei',
  'KaiTi',
  'PingFang SC',
  'Hiragino Sans GB',
  'Noto Sans CJK SC',
  'Noto Sans SC',
  'Helvetica Neue',
  'Times New Roman',
  'Georgia',
  'Consolas',
  'Courier New',
  'sans-serif',
  'serif',
  'monospace',
] as const;

export const defaultTextStyle = (content = ''): TextStyle => ({
  content,
  fontFamily: 'Microsoft YaHei',
  fontSize: 24,
  fontWeight: 400,
  fontStyle: 'normal',
  // 画布是深色背景，默认使用高对比浅色；用户仍可通过颜色选择器改成其他颜色。
  fill: '#ededed',
  align: 'left',
  verticalAlign: 'top',
  lineHeight: 1.2,
  letterSpacing: 0,
  resizeMode: 'auto-width',
});

export const konvaFontStyle = (style: Pick<TextStyle, 'fontStyle' | 'fontWeight'>) =>
  `${style.fontStyle} ${style.fontWeight}`;

export const effectiveFontFamily = (font: string) =>
  typeof document !== 'undefined' &&
  document.fonts &&
  !font.includes('serif') &&
  !font.includes('monospace') &&
  !document.fonts.check(`12px "${font}"`)
    ? 'sans-serif'
    : font;

export function textConfig(layer: TextLayer) {
  return {
    text: layer.content,
    fontFamily: effectiveFontFamily(layer.fontFamily),
    fontSize: layer.fontSize,
    fontStyle: konvaFontStyle(layer),
    fill: layer.fill,
    align: layer.align,
    verticalAlign: layer.verticalAlign,
    lineHeight: layer.lineHeight,
    letterSpacing: layer.letterSpacing,
    wrap: 'word',
    ellipsis: false,
  } as const;
}

/** 用和画布相同的 Konva 字体度量更新自动尺寸。 */
export function fitTextLayer(layer: TextLayer) {
  if (layer.resizeMode === 'fixed') return;
  const node = new Konva.Text({
    ...textConfig(layer),
    ...(layer.resizeMode === 'auto-height' ? { width: Math.max(1, layer.width) } : {}),
  });
  if (layer.resizeMode === 'auto-width') layer.width = Math.max(1, node.width());
  layer.height = Math.max(1, node.height());
  node.destroy();
}

export function availableSystemFonts() {
  if (typeof document === 'undefined' || !document.fonts) return [...SYSTEM_FONTS];
  return SYSTEM_FONTS.filter(
    (font) =>
      font.includes('serif') ||
      font.includes('monospace') ||
      document.fonts.check(`12px "${font}"`),
  );
}
