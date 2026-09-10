function createDesignRoutes({
  getTaskRequestContext,
  readJson,
  runWithAiProgress,
  planBackgroundDecomposition,
  recognizeTextRegion,
  reconstructEditableDesignH5,
  sendJson
}) {
  return async function handleDesignRoutes(request, response) {
    if (request.method === "POST" && request.url === "/api/design/plan-background-decomposition") {
      const payload = await readJson(request, 150 * 1024 * 1024);
      const context = getTaskRequestContext("vision");
      const result = await runWithAiProgress(payload, "正在 AI 拆分普通切图和可还原背景", () => planBackgroundDecomposition(payload, context));
      sendJson(response, 200, result);
      return true;
    }

    if (request.method === "POST" && request.url === "/api/design/recognize-region") {
      const payload = await readJson(request, 150 * 1024 * 1024);
      const context = getTaskRequestContext("vision");
      const result = await runWithAiProgress(payload, "正在识别选区文字和样式", () => recognizeTextRegion(payload, context));
      sendJson(response, 200, result);
      return true;
    }

    if (request.method === "POST" && request.url === "/api/design/reconstruct-h5") {
      const payload = await readJson(request);
      const context = getTaskRequestContext("vision");
      const result = await runWithAiProgress(payload, "正在 AI 识别文字、布局和切图资产", () => reconstructEditableDesignH5(payload, context));
      sendJson(response, 200, result);
      return true;
    }

    return false;
  };
}

module.exports = {
  createDesignRoutes
};
