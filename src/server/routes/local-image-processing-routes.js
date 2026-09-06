function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function createLocalImageProcessingRoutes({
  client,
  readJson,
  runWithProgress,
  updateProgress,
  sendJson
}) {
  function requestOptions(progressId, signal, runningLabel) {
    return {
      signal,
      onQueue(position) {
        updateProgress(progressId, `本地 CPU 任务排队中（前方 ${Math.max(0, position - 1)} 个）`);
      },
      onStart() {
        updateProgress(progressId, runningLabel);
      }
    };
  }

  return async function handleLocalImageProcessingRoutes(request, response) {
    if (request.method === "GET" && request.url === "/api/local-image-processing/health") {
      sendJson(response, 200, await client.health());
      return true;
    }

    if (request.method === "POST" && request.url === "/api/local-image-processing/inpaint") {
      const payload = await readJson(request, 80 * 1024 * 1024);
      if (!payload.dataUrl || !payload.maskDataUrl) throw badRequest("本地修复需要源图和修复蒙版");
      const result = await runWithProgress(payload, "正在提交本地 LaMa 修复", (signal) => client.inpaint(payload,
        requestOptions(payload.progressId, signal, "LaMa 正在移除选中内容并补齐背景")));
      sendJson(response, 200, result);
      return true;
    }

    if (request.method === "POST" && request.url === "/api/local-image-processing/upscale") {
      const payload = await readJson(request, 80 * 1024 * 1024);
      const scale = Number(payload.scale || 2);
      if (!payload.dataUrl) throw badRequest("本地高清化需要源图");
      if (![2, 4].includes(scale)) throw badRequest("高清化倍率仅支持 2× 或 4×");
      const result = await runWithProgress({ ...payload, scale }, "正在提交本地高清化", (signal) => client.upscale(
        { ...payload, scale }, requestOptions(payload.progressId, signal, `Real-ESRGAN 正在生成 ${scale}× 高清图片`)));
      sendJson(response, 200, result);
      return true;
    }

    return false;
  };
}

module.exports = { createLocalImageProcessingRoutes };
