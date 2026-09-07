const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "../..");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

test("built plugin exposes the Vue smart cutout editor bridge", async () => {
  const server = http.createServer((request, response) => {
    const relative = request.url === "/" ? "figma-sim.html" : decodeURIComponent(request.url.slice(1).split("?")[0]);
    const file = path.resolve(root, relative);
    if (!file.startsWith(root) || !fs.existsSync(file)) { response.writeHead(404).end(); return; }
    response.setHeader("content-type", mime[path.extname(file)] || "application/octet-stream");
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const port = server.address().port;
    const page = await browser.newPage();
    await page.route("http://127.0.0.1:18787/**", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: route.request().url().endsWith("/health") ? '{"ok":true}' : '{}'
    }));
    await page.goto(`http://127.0.0.1:${port}/figma-sim.html`);
    const frame = page.frames().find(item => item !== page.mainFrame());
    assert.ok(frame);
    await frame.waitForSelector("#sliceCutoutEditorRoot", { state: "attached" });
    assert.equal(await frame.evaluate(() => typeof window.ImageToSliceVue?.mountCutoutEditor), "function");
    assert.equal(await frame.locator("#sliceCutoutEditorRoot").count(), 1);
    await frame.evaluate(async () => {
      window.__cutoutE2e = window.ImageToSliceVue.mountCutoutEditor(
        document.getElementById("sliceCutoutEditorRoot"),
        {
          request: async () => new Response(JSON.stringify({ ok: false, checkpointFound: false, error: "test fallback" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          }),
          commit: async result => { window.__cutoutCommits = [...(window.__cutoutCommits || []), result]; }
        }
      );
      await window.__cutoutE2e.open({
        assetId: "asset-1",
        name: "金币",
        contentType: "image",
        dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
      });
    });
    await frame.locator(".cutout-editor").waitFor({ state: "visible" });
    assert.match(await frame.locator(".cutout-editor-header").innerText(), /智能抠图/);
    assert.equal(await frame.getByRole("button", { name: "魔棒" }).count(), 1);
    const initialPixels = await frame.locator(".cutout-editor-stage").evaluate(stage => {
      const canvases = stage.querySelectorAll("canvas");
      return Array.from(canvases, canvas => Array.from(canvas.getContext("2d").getImageData(0, 0, 1, 1).data));
    });
    assert.deepEqual(initialPixels[1], initialPixels[0], "首次进入应显示原图，而不是应用空选区后变为全透明");
    await frame.getByRole("button", { name: "魔棒" }).click();
    await frame.locator(".cutout-editor-stage canvas").last().click({ position: { x: 1, y: 1 } });
    const applyButton = frame.getByRole("button", { name: "保留选区并透明背景" });
    await applyButton.click();
    assert.equal(await frame.locator(".cutout-editor").isVisible(), true, "应用透明背景后编辑器应继续保持打开");
    assert.equal(await frame.evaluate(() => window.__cutoutCommits?.length || 0), 0, "应用操作不应提前写回资产");
    await frame.getByRole("button", { name: "撤销" }).click();
    assert.equal(await frame.getByRole("button", { name: "保存", exact: true }).isDisabled(), true, "撤销图像步骤后不应残留可保存结果");
    await frame.getByRole("button", { name: "重做" }).click();
    await frame.getByRole("button", { name: "保存", exact: true }).click();
    await frame.locator(".cutout-editor").waitFor({ state: "hidden" });
    const commits = await frame.evaluate(() => window.__cutoutCommits || []);
    assert.equal(commits.length, 1, "最终保存应只提交一次");
    assert.equal(commits[0].operations[0].kind, "cutout");
    await frame.evaluate(() => window.__cutoutE2e.dispose());
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
