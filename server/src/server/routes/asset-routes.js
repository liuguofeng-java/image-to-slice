function createAssetRoutes({
  getTaskRequestContext,
  readJson,
  runWithAiProgress,
  generateTransparentAsset,
  redrawAsset,
  sendJson
}) {
  return async function handleAssetRoutes(request, response) {
    if (request.method === "POST" && request.url === "/api/assets/generate-transparent") {
      const payload = await readJson(request);
      const context = getTaskRequestContext("generation");
      const result = await runWithAiProgress(payload, "透明图片请求已发送，正在等待上游返回", () => generateTransparentAsset(payload, context));
      sendJson(response, 200, result);
      return true;
    }

    if (request.method === "POST" && request.url === "/api/assets/ai-redraw") {
      const payload = await readJson(request);
      const task = payload.preserveBackground === true && payload.maskDataUrl
        ? "inpaint"
        : "generation";
      const context = getTaskRequestContext(task);
      const result = await runWithAiProgress(payload, "AI 图片处理请求已发送，正在等待上游返回", () => redrawAsset(payload, context));
      sendJson(response, 200, result);
      return true;
    }

    return false;
  };
}

module.exports = {
  createAssetRoutes
};
