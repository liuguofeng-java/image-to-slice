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
          request: async (url, options) => new Response(JSON.stringify(window.__editorRequest ? await window.__editorRequest(url, options) : { ok: false, checkpointFound: false, error: "test fallback" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          }),
          commit: async result => { if (window.__failSave) throw new Error('模拟保存失败'); window.__cutoutCommits = [...(window.__cutoutCommits || []), result]; }
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
    const background = frame.getByRole('combobox', { name: '预览背景' });
    for (const [value, color] of [['black', 'rgb(17, 19, 24)'], ['white', 'rgb(255, 255, 255)'], ['checker', 'rgb(255, 255, 255)']]) {
      await background.selectOption(value);
      for (const selector of ['.cutout-editor-viewport', '.cutout-editor-stage']) {
        const style = await frame.locator(selector).evaluate(el => ({ color: getComputedStyle(el).backgroundColor, image: getComputedStyle(el).backgroundImage }));
        assert.equal(style.color, color);
        assert.equal(style.image.includes('linear-gradient'), value === 'checker');
      }
      const pixels = await frame.locator('.cutout-editor-stage canvas').nth(1).evaluate(canvas => Array.from(canvas.getContext('2d').getImageData(0, 0, 1, 1).data));
      assert.deepEqual(pixels, initialPixels[1], '预览背景切换不能修改图片像素');
      assert.equal(await frame.getByRole('button', { name: '保存到切图', exact: true }).isDisabled(), true);
    }
    await frame.getByRole("button", { name: "魔棒" }).click();
    await frame.locator(".cutout-editor-stage canvas").last().click({ position: { x: 1, y: 1 } });
    await frame.getByRole("button", { name: "高清化", exact: true }).click();
    assert.equal(await frame.locator(".cutout-editor").isVisible(), true, "应用透明背景后编辑器应继续保持打开");
    assert.equal(await frame.evaluate(() => window.__cutoutCommits?.length || 0), 0, "应用操作不应提前写回资产");
    await frame.getByRole("button", { name: "撤销" }).click();
    assert.equal(await frame.getByRole("button", { name: "保存到切图", exact: true }).isEnabled(), true, "撤销应用步骤后应恢复可直接保存的抠图选区");
    await frame.getByRole("button", { name: "重做" }).click();
    await frame.getByRole("button", { name: "保存到切图", exact: true }).click();
    await frame.locator(".cutout-editor").waitFor({ state: "hidden" });
    const commits = await frame.evaluate(() => window.__cutoutCommits || []);
    assert.equal(commits.length, 1, "最终保存应只提交一次");
    assert.equal(commits[0].operations[0].kind, "cutout");
    await frame.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 220; canvas.height = 80;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 220, 80);
      ctx.fillStyle = '#306227'; ctx.font = '24px sans-serif'; ctx.fillText('探索民宿 ›', 24, 50);
      window.__testImage = canvas.toDataURL();
      window.__calls = [];
      window.__editorRequest = async (url, options) => {
        if (url.endsWith('/health')) return { ok: true, checkpointFound: true, iopaintRootFound: true, lamaModelFound: true, realesrganRootFound: true, realesrganModelFound: true, pythonDependenciesFound: true };
        const payload = JSON.parse(options?.body || '{}');
        if (url.endsWith('/session')) return { sessionId: 'test-session', embeddingMs: 1 };
        if (url.endsWith('/predict')) return { requestRevision: payload.requestRevision, candidates: [{ index: 0, score: .9, maskDataUrl: window.__testImage }], inferenceMs: 1 };
        if (url.includes('/cancel')) return {};
        if (url.endsWith('/inpaint') || url.endsWith('/upscale')) {
          window.__calls.push({ url, payload });
          if (window.__deferModel) await new Promise(resolve => { window.__finishModel = resolve; });
          if (window.__failModel) throw new Error('模拟处理失败');
          if (url.endsWith('/inpaint')) return { dataUrl: payload.dataUrl, inferenceMs: 1 };
          const input = new Image(); input.src = payload.dataUrl; await input.decode();
          const output = document.createElement('canvas'); output.width = input.width * payload.scale; output.height = input.height * payload.scale;
          output.getContext('2d').drawImage(input, 0, 0, output.width, output.height);
          return { dataUrl: output.toDataURL(), sourcePixelWidth: input.width, sourcePixelHeight: input.height, outputPixelWidth: output.width, outputPixelHeight: output.height, inferenceMs: 1 };
        }
        return {};
      };
      window.__openEditor = mode => window.__cutoutE2e.open({ assetId: 'asset-2', name: '探索民宿 · slice_01', contentType: 'image', dataUrl: window.__testImage, openMode: mode });
    });
    const button = name => frame.getByRole('button', { name, exact: true });
    const draw = async () => {
      const box = await frame.locator('.cutout-editor-stage canvas').last().boundingBox();
      await page.mouse.move(box.x + 25, box.y + 25); await page.mouse.down();
      await page.mouse.move(box.x + 80, box.y + 60, { steps: 4 }); await page.mouse.up();
    };
    await frame.evaluate(() => window.__openEditor('cutout'));
    await button('智能选择').waitFor();
    assert.equal(await frame.getByText('颜色容差', { exact: false }).count(), 0);
    await button('画笔').click();
    await frame.getByRole('slider', { name: /^画笔大小/ }).fill('35');
    assert.equal(await button('保存到切图').isDisabled(), true, '工具参数不产生图像修改');
    await button('对比原图').click(); await button('返回当前图').click();
    assert.equal(await button('画笔').getAttribute('aria-pressed'), 'true', '对比不重置工具');
    await button('魔棒').click();
    await frame.locator('.cutout-editor-stage canvas').last().click({ position: { x: 10, y: 10 } });
    await button('反选').click();
    await button('预览抠图结果').click();
    assert.equal(await frame.locator('.cutout-point').count(), 0);
    await frame.evaluate(() => { window.__failSave = true; });
    await button('保存到切图').click();
    await frame.getByRole('alert').filter({ hasText: '模拟保存失败' }).waitFor();
    assert.equal(await frame.locator('.cutout-editor').isVisible(), true);
    await frame.evaluate(() => { window.__failSave = false; });
    await button('局部修复').click(); await draw();
    await button('高清化').click();
    await button('保存到切图').click();
    await frame.getByRole('alertdialog').waitFor();
    await button('返回修复').click();
    assert.equal(await button('开始修复').isEnabled(), true, '跨功能保留修复草稿');
    await button('开始修复').click();
    await frame.getByText('局部修复完成', { exact: false }).waitFor();
    await button('高清化').click(); await button('开始高清化').click();
    await frame.getByText('高清化完成：', { exact: false }).waitFor();
    await button('保存到切图').click();
    const chain = await frame.evaluate(() => window.__cutoutCommits.at(-1));
    assert.deepEqual(chain.operations.map(op => op.kind), ['cutout', 'inpaint', 'upscale']);
    assert.equal(chain.operations.at(-1).outputPixelWidth, 880);
    // Cancellation must ignore even successful responses that arrive later.
    await frame.evaluate(() => { window.__deferModel = true; return window.__openEditor('repair'); });
    assert.equal(await button('局部修复').getAttribute('aria-pressed'), 'true');
    await draw(); await button('开始修复').click(); await button('取消处理').click();
    await frame.evaluate(() => { window.__deferModel = false; window.__finishModel(); });
    await frame.waitForTimeout(100);
    assert.equal(await button('保存到切图').isDisabled(), true, '取消后成功响应不能生成可保存结果');
    await button('关闭图像处理').click(); await button('放弃并关闭').click();
    // Model failure leaves the draft available for retry; discard only the pending draft.
    await frame.evaluate(() => { window.__failModel = true; return window.__openEditor('repair'); });
    await draw(); await button('开始修复').click();
    await frame.getByRole('alert').filter({ hasText: '模拟处理失败' }).waitFor();
    assert.equal(await button('开始修复').isEnabled(), true);
    await frame.evaluate(() => { window.__failModel = false; });
    await button('开始修复').click(); await frame.getByText('局部修复完成', { exact: false }).waitFor();
    await draw(); await button('保存到切图').click();
    await button('放弃待修复选区并保存已有结果').click();
    assert.deepEqual(await frame.evaluate(() => window.__cutoutCommits.at(-1).operations.map(op => op.kind)), ['inpaint']);
    // Each edge change is one undo step; softness survives undo/redo.
    await frame.evaluate(() => window.__openEditor('cutout'));
    await button('画笔').click(); await draw();
    await frame.locator('.cutout-edge-details summary').click();
    const feather = frame.getByRole('slider', { name: '羽化', exact: true });
    await feather.focus(); await feather.press('ArrowRight');
    assert.equal(await feather.inputValue(), '2');
    await button('撤销').click(); assert.equal(await feather.inputValue(), '1');
    await button('重做').click(); assert.equal(await feather.inputValue(), '2');
    await button('保存到切图').click();
    assert.equal(await frame.evaluate(() => window.__cutoutCommits.at(-1).settings.feather), 2);
    // Upscale and compare views support panning; close confirmation traps focus.
    await frame.evaluate(() => window.__openEditor('upscale'));
    assert.equal(await button('高清化').getAttribute('aria-pressed'), 'true');
    for (let i = 0; i < 9; i++) await button('放大').click();
    const viewport = frame.locator('.cutout-editor-viewport');
    await viewport.evaluate(el => { el.scrollLeft = 0; });
    const viewportBox = await viewport.boundingBox();
    await page.mouse.move(viewportBox.x + 200, viewportBox.y + 100); await page.mouse.down();
    await page.mouse.move(viewportBox.x + 80, viewportBox.y + 100, { steps: 4 }); await page.mouse.up();
    assert.ok(await viewport.evaluate(el => el.scrollLeft) > 0, '高清化画布可以拖动');
    await button('对比原图').click();
    await button('局部修复').click(); await button('适应').click(); await draw();
    await button('关闭图像处理').click();
    await button('继续编辑').focus(); await page.keyboard.press('Shift+Tab');
    assert.equal(await button('放弃并关闭').evaluate(el => document.activeElement === el), true);
    await button('放弃并关闭').click();
    // Verify layout and keep screenshots outside the repository.
    for (const [width, height] of [[1920,1080], [1280,800], [800,600], [390,844]]) {
      await page.setViewportSize({ width, height });
      await frame.evaluate(() => window.__openEditor('cutout'));
      assert.equal(await frame.locator('.cutout-editor').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
      const bounds = await frame.locator('.cutout-editor').boundingBox();
      assert.ok(bounds.width <= width && bounds.height <= height);
      assert.equal(await frame.locator('.cutout-editor').evaluate(el => el.scrollWidth <= el.clientWidth), true);
      assert.ok(Number((await frame.getByLabel('缩放比例').innerText()).replace('%','')) <= 200);
      assert.equal(await button('保存到切图').isVisible(), true);
      if (width < 960) {
        assert.equal(await frame.locator('.cutout-editor-settings').isVisible(), false);
        await button('工具与参数').click(); assert.equal(await button('魔棒').isVisible(), true);
        await page.screenshot({ path: path.join(process.env.TEMP || '/tmp', `image-editor-${width}-tools.png`) });
        await button('收起').click();
      }
      await page.screenshot({ path: path.join(process.env.TEMP || '/tmp', `image-editor-${width}.png`) });
      await button('关闭图像处理').click();
    }
    await frame.evaluate(() => window.__cutoutE2e.dispose());
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
