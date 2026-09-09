const regenerationCore = typeof require === 'function' ? require('../../core/regeneration') : { unionRegenerationRegions, validateRegenerationDimensions };
function canMarkRegeneration(asset) { return asset?.contentType === 'image' && !asset.aiProcessing; }
function mapRegenerationChildren(parent, children, width, height) {
  const p = parent.placement;
  if (!p || !(p.width > 0 && p.height > 0)) throw new Error('切图设计尺寸无效。');
  return regenerationCore.unionRegenerationRegions(children.map(r => ({
    x: (r.x - p.x) * width / p.width, y: (r.y - p.y) * height / p.height,
    width: r.width * width / p.width, height: r.height * height / p.height
  })), width, height);
}
function regenerationSignature(asset, childSignature) {
  return JSON.stringify([asset?.dataUrl, asset?.placement, asset?.contentType, asset?.parentId, childSignature]);
}
function applyRegenerationResult(asset, result, input, provider) {
  regenerationCore.validateRegenerationDimensions(result.width, result.height, input.width, input.height);
  if (!result.dataUrl || asset.contentType !== 'image') throw new Error('只有图片类型可以应用重新生成结果。');
  // Workspace history owns the full pre-generation snapshot. Old processing caches
  // must not later replace this new raster through preview or restore shortcuts.
  for (const key of Object.keys(asset)) {
    if (/^(cutout|localInpaint|upscale|aiTransparent|aiComplete|transparencyRestore|imageProcessingRestore|svgRestore)/.test(key)) delete asset[key];
  }
  asset.dataUrl = result.dataUrl; asset.svgData = null;
  asset.transparent = Boolean(result.transparent);
  asset.transparentDataUrl = result.transparent ? result.dataUrl : null;
  asset.aiRedrawn = true; asset.aiRedrawnPlacement = { ...asset.placement };
  asset.sourcePixelWidth = input.width; asset.sourcePixelHeight = input.height;
  asset.outputPixelWidth = result.width; asset.outputPixelHeight = result.height;
  asset.regenerateMarked = false;
  asset.regeneration = { model: provider.model, generatedAt: new Date().toISOString(), inputWidth: input.width, inputHeight: input.height, outputWidth: result.width, outputHeight: result.height };
  asset.lastAiOperation = 'regenerate';
}
async function ensureRegenerationSupported(fetchBackend, signal) {
  const response = await fetchBackend('/health', { signal, cache: 'no-store' });
  const health = await response.json().catch(() => ({}));
  if (!response.ok || !health.ok) throw new Error('本地后端不可用，请检查服务是否正常启动。');
  if (health.capabilities?.regenerate !== 1) {
    throw new Error('本地后端尚未加载 AI 重新生成功能。请在 server 目录停止并重新运行 npm run dev，然后刷新页面。本次未发送生成请求，不会产生模型费用。');
  }
}
async function requestRegeneration(fetchBackend, payload, signal) {
  // Recheck on every explicit attempt: the server can restart after preflight.
  await ensureRegenerationSupported(fetchBackend, signal);
  const response = await fetchBackend('/api/assets/ai-redraw', { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, operation: 'regenerate', quality: 'high' }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `重新生成失败：${response.status}`);
  if (result.operation !== 'regenerate') throw new Error('后端返回了旧版重绘结果，未完成重新生成所需的子级排除与尺寸映射。请重启本地后端并刷新页面，不要直接应用此结果。');
  if (!result.images?.[0]?.dataUrl) throw new Error('远程模型未返回图片。');
  if (![result.images[0].width, result.images[0].height].every(value => Number.isInteger(value) && value > 0)) {
    throw new Error('重新生成响应缺少有效的像素尺寸。请重启本地后端；若仍报错，请检查接口版本。');
  }
  return { ...result.images[0], provider: result.provider || {} };
}
if (typeof module !== 'undefined') module.exports = { canMarkRegeneration, mapRegenerationChildren, regenerationSignature, applyRegenerationResult, requestRegeneration, ensureRegenerationSupported };
