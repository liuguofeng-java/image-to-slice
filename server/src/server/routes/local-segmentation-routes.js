function createLocalSegmentationRoutes({ client, readJson, sendJson }) {
  return async function handleLocalSegmentationRoutes(request, response) {
    if (request.method === "GET" && request.url === "/api/local-segmentation/health") {
      sendJson(response, 200, await client.health());
      return true;
    }
    if (request.method === "POST" && request.url === "/api/local-segmentation/session") {
      const payload = await readJson(request, 150 * 1024 * 1024);
      sendJson(response, 200, await client.request("create_session", payload));
      return true;
    }
    if (request.method === "POST" && request.url === "/api/local-segmentation/predict") {
      const payload = await readJson(request, 4 * 1024 * 1024);
      sendJson(response, 200, await client.request("predict", payload));
      return true;
    }
    const closeMatch = request.method === "DELETE"
      && request.url.match(/^\/api\/local-segmentation\/session\/([A-Za-z0-9_-]+)$/);
    if (closeMatch) {
      sendJson(response, 200, await client.request("close_session", { sessionId: closeMatch[1] }, 10000));
      return true;
    }
    return false;
  };
}

module.exports = { createLocalSegmentationRoutes };
