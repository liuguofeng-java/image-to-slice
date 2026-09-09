const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
require('./regeneration.cjs');

const root = path.resolve(__dirname, "../..");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

test('legacy trimmed workspace restores the subject position through the real toolbar and reload', async () => {
  const sharp = require('sharp');
  const rgba = Buffer.alloc(221 * 78 * 4);
  for (let y = 10; y < 67; y++) for (let x = 11; x < 195; x++) rgba.set([20, 80, 30, 255], (y * 221 + x) * 4);
  const original = await sharp(rgba, { raw: { width: 221, height: 78, channels: 4 } }).png().toBuffer();
  const cropped = await sharp(original).extract({ left: 5, top: 4, width: 196, height: 69 }).png().toBuffer();
  const background = await sharp({ create: { width: 1024, height: 1536, channels: 4, background: '#fff' } }).composite([{ input: original, left: 453, top: 1146 }]).png().toBuffer();
  const url = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
  const asset = { id: 'legacy-trim', name: 'slice_01', contentType: 'image', dataUrl: url(cropped), trimmed: true,
    transparent: true, aiTransparent: true, aiTransparentDataUrl: url(cropped),
    initialPlacement: { x: 453, y: 1146 }, placement: { x: 453, y: 1146, width: 196, height: 69 },
    imageProcessingRestoreState: { dataUrl: url(original), geometryState: { placement: { x: 453, y: 1146, width: 221, height: 78 } } } };
  let draft = { version: 1, width: 1024, height: 1536, activeResultIndex: 0, activeSliceId: asset.id,
    manifest: { screen: { width: 1024, height: 1536 }, assets: [], resultImages: [{ id: 'fixture', dataUrl: url(background), width: 1024, height: 1536, sliceManifest: { assets: [asset] } }] } };
  const server = http.createServer((request, response) => {
    const relative = request.url === '/' ? 'figma-sim.html' : decodeURIComponent(request.url.slice(1).split('?')[0]);
    const file = path.resolve(root, relative);
    if (!file.startsWith(root) || !fs.existsSync(file)) { response.writeHead(404).end(); return; }
    response.setHeader('content-type', mime[path.extname(file)] || 'application/octet-stream');
    response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let saved;
    await page.route('http://127.0.0.1:18787/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      let body = { ok: true };
      if (pathname === '/api/workspace-draft') {
        if (route.request().method() === 'POST') {
          saved = route.request().postDataJSON().draft; draft = saved; body = { ok: true, draftId: 'fixture' };
        } else body = { draft, draftId: 'fixture', restorePreference: 'restore', recordCount: 1 };
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/figma-sim.html`);
    let frame = page.frames().find(item => item !== page.mainFrame());
    const restore = () => frame.locator('[data-slice-toolbar-action="restore-position"]');
    await restore().waitFor();
    assert.equal(await frame.locator('#transparentAll, [data-slice-toolbar-action="transparent"]').count(), 0, '旧边缘透明及批量入口已移除');
    assert.equal(await frame.locator('[data-slice-toolbar-action="ai-cutout"]').count(), 1, 'AI 抠图入口保留');
    assert.equal(await restore().isEnabled(), true, 'old restored coordinates must be recognized as displaced');
    await restore().click();
    await frame.waitForFunction(() => document.querySelector('[data-slice-toolbar-action="restore-position"]')?.disabled === true);
    await page.waitForResponse(response => response.url().endsWith('/api/workspace-draft') && response.request().method() === 'POST');
    assert.deepEqual(saved.manifest.resultImages[0].sliceManifest.assets[0].placement, { x: 458, y: 1150, width: 196, height: 69 });
    assert.equal(saved.manifest.resultImages[0].sliceManifest.assets[0].dataUrl, asset.dataUrl);
    const geometry = await frame.locator('.slice-cutout.processed').evaluate(el => {
      const base = document.querySelector('.result-canvas > img').getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return { x: (box.left - base.left) * 1024 / base.width, y: (box.top - base.top) * 1536 / base.height };
    });
    assert.ok(Math.abs(geometry.x - 458) < .1 && Math.abs(geometry.y - 1150) < .1);
    await page.reload(); frame = page.frames().find(item => item !== page.mainFrame());
    await restore().waitFor();
    assert.equal(await restore().isDisabled(), true, 'reloading must not apply the offset twice');
  } finally {
    await browser.close(); await new Promise(resolve => server.close(resolve));
  }
});

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
        assert.equal(style.color, selector.endsWith('-viewport') ? 'rgb(246, 247, 251)' : color);
        assert.equal(style.image.includes('linear-gradient'), selector.endsWith('-stage') && value === 'checker');
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
        if (url.endsWith('/predict')) return { requestRevision: payload.requestRevision, candidates: Array.from({ length: window.__multipleCandidates ? 3 : 1 }, (_, index) => ({ index, score: .9 - index * .1, maskDataUrl: window.__testImage })), inferenceMs: 1 };
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
    assert.equal(await button('预览抠图结果').count(), 0, '结果切换只保留画布上方一个入口');
    const undoInitiallyDisabled = await button('撤销').isDisabled();
    const edgeSummary = frame.locator('.cutout-edge-details summary').filter({ hasText: '边缘优化' });
    await edgeSummary.focus(); await edgeSummary.press('Space');
    assert.equal(await edgeSummary.evaluate(el => el.parentElement.open), true, '折叠区可用空格键展开');
    await frame.locator('.cutout-edge-details summary').filter({ hasText: '边缘优化' }).click();
    await button('结果').click(); await button('选区').click();
    assert.equal(await button('撤销').isDisabled(), undoInitiallyDisabled, '展开面板和预览切换不记录撤销');
    assert.equal(await frame.getByText('颜色容差', { exact: false }).count(), 0);
    await button('画笔').click();
    await frame.getByRole('slider', { name: /^画笔大小/ }).fill('35');
    assert.equal(await button('保存到切图').isDisabled(), true, '工具参数不产生图像修改');
    await button('对比原图').click(); await button('返回当前图').click();
    assert.equal(await button('画笔').getAttribute('aria-pressed'), 'true', '对比不重置工具');
    await button('魔棒').click();
    await frame.locator('.cutout-editor-stage canvas').last().click({ position: { x: 10, y: 10 } });
    await button('反选').click();
    await button('结果').click();
    assert.equal(await frame.locator('.cutout-point').count(), 0);
    await frame.evaluate(() => { window.__failSave = true; });
    await button('保存到切图').click();
    await frame.getByRole('alert').filter({ hasText: '模拟保存失败' }).waitFor();
    assert.equal(await frame.locator('.cutout-editor-footer [role="alert"]').count(), 1);
    assert.equal(await frame.locator('.cutout-editor-settings [role="alert"]').count(), 0);
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
    await draw(); await button('开始修复').click();
    assert.equal(await frame.locator('.cutout-editor-footer .cutout-spinner').count(), 1);
    assert.equal(await frame.locator('.cutout-editor-settings [role="status"]').count(), 0);
    await page.screenshot({ path: path.join(process.env.TEMP || '/tmp', 'image-editor-processing.png') });
    await button('取消处理').click();
    await frame.evaluate(() => { window.__deferModel = false; window.__finishModel(); });
    await frame.waitForTimeout(100);
    assert.equal(await button('保存到切图').isDisabled(), true, '取消后成功响应不能生成可保存结果');
    await button('关闭图像处理').click(); await button('放弃并关闭').click();
    // Model failure leaves the draft available for retry; discard only the pending draft.
    await frame.evaluate(() => { window.__failModel = true; return window.__openEditor('repair'); });
    await draw(); await button('开始修复').click();
    await frame.getByRole('alert').filter({ hasText: '模拟处理失败' }).waitFor();
    await page.screenshot({ path: path.join(process.env.TEMP || '/tmp', 'image-editor-error.png') });
    assert.equal(await button('开始修复').isEnabled(), true);
    await frame.evaluate(() => { window.__failModel = false; });
    await button('开始修复').click(); await frame.getByText('局部修复完成', { exact: false }).waitFor();
    await draw(); await button('保存到切图').click();
    await button('放弃待修复选区并保存已有结果').click();
    assert.deepEqual(await frame.evaluate(() => window.__cutoutCommits.at(-1).operations.map(op => op.kind)), ['inpaint']);
    // Each edge change is one undo step; softness survives undo/redo.
    await frame.evaluate(() => window.__openEditor('cutout'));
    await button('画笔').click(); await draw();
    await frame.locator('.cutout-edge-details summary').filter({ hasText: '边缘优化' }).click();
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
    // Trim existing alpha content without requiring a fresh selection.
    await frame.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 60;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#276329'; ctx.fillRect(20, 10, 50, 30);
      window.__trimFixture = canvas.toDataURL();
      window.__openTrim = () => window.__cutoutE2e.open({ assetId: 'trim-test', name: '边缘切除测试', contentType: 'image', dataUrl: window.__trimFixture, openMode: 'cutout' });
    });
    await frame.evaluate(() => window.__openTrim());
    await frame.locator('.cutout-trim-details summary').click();
    await frame.getByRole('checkbox', { name: '裁掉多余透明留白' }).check();
    for (const [side, value] of [['上', '1'], ['下', '2'], ['左', '3'], ['右', '4']]) {
      await frame.getByRole('spinbutton', { name: side + '保留间距' }).fill(value);
      await frame.getByRole('spinbutton', { name: side + '保留间距' }).press('Tab');
    }
    await button('结果').click();
    const trimPreview = await frame.locator('.cutout-editor-stage canvas').nth(1).evaluate(canvas => ({ width: canvas.width, height: canvas.height, url: canvas.toDataURL() }));
    assert.equal(trimPreview.width, 57); assert.equal(trimPreview.height, 33);
    await button('撤销').click();
    assert.equal(await frame.getByRole('spinbutton', { name: '右保留间距' }).inputValue(), '0');
    await button('重做').click();
    await button('保存到切图').click();
    await frame.locator('.cutout-editor').waitFor({ state: 'hidden' });
    const trimCommit = await frame.evaluate(() => window.__cutoutCommits.at(-1));
    assert.deepEqual(trimCommit.operations.map(op => op.kind), ['trim']);
    assert.equal(trimCommit.operations[0].left, 17); assert.equal(trimCommit.operations[0].top, 9);
    assert.equal(trimCommit.dataUrl, trimPreview.url, '预览和实际裁剪输出一致');
    await frame.evaluate(() => window.__openTrim());
    await frame.locator('.cutout-trim-details summary').click();
    assert.equal(await frame.getByRole('checkbox', { name: '裁掉多余透明留白' }).isChecked(), false);
    await frame.getByRole('checkbox', { name: '裁掉多余透明留白' }).check();
    await frame.getByRole('spinbutton', { name: '上保留间距' }).fill('25');
    await frame.getByRole('checkbox', { name: '同步四边' }).check();
    assert.equal(await frame.getByRole('spinbutton', { name: '右保留间距' }).inputValue(), '25');
    await frame.getByRole('spinbutton', { name: '左保留间距' }).fill('4096');
    await frame.getByRole('alert').filter({ hasText: '输出尺寸过大' }).waitFor();
    assert.equal(await button('保存到切图').isDisabled(), true);
    await button('高清化').click(); assert.equal(await button('智能抠图').getAttribute('aria-pressed'), 'true');
    await frame.getByRole('spinbutton', { name: '左保留间距' }).fill('25');
    await button('高清化').click(); await button('开始高清化').click();
    await frame.getByText('高清化完成：', { exact: false }).waitFor();
    await button('保存到切图').click();
    await frame.locator('.cutout-editor').waitFor({ state: 'hidden' });
    assert.deepEqual(await frame.evaluate(() => window.__cutoutCommits.at(-1).operations.map(op => op.kind)), ['trim', 'upscale']);
    await frame.evaluate(() => window.__openTrim());
    await button('魔棒').click();
    await frame.locator('.cutout-editor-stage canvas').last().click({ position: { x: 65, y: 45 } });
    await frame.locator('.cutout-trim-details summary').click();
    await frame.getByRole('checkbox', { name: '裁掉多余透明留白' }).check();
    await button('结果').click();
    const combinedPreview = await frame.locator('.cutout-editor-stage canvas').nth(1).evaluate(canvas => canvas.toDataURL());
    await frame.evaluate(() => { window.__failSave = true; });
    await button('保存到切图').click(); await frame.getByRole('alert').filter({ hasText: '模拟保存失败' }).waitFor();
    assert.equal(await frame.getByRole('checkbox', { name: '裁掉多余透明留白' }).isChecked(), false);
    await frame.evaluate(() => { window.__failSave = false; });
    await button('保存到切图').click(); await frame.locator('.cutout-editor').waitFor({ state: 'hidden' });
    const combined = await frame.evaluate(() => window.__cutoutCommits.at(-1));
    assert.deepEqual(combined.operations.map(op => op.kind), ['cutout', 'trim']);
    assert.equal(combined.dataUrl, combinedPreview);
    // Candidate cards use composited subject pixels, only when there is a choice.
    await frame.evaluate(() => window.__openEditor('cutout'));
    await button('智能选择').click();
    await frame.locator('.cutout-editor-stage canvas').last().click({ position: { x: 20, y: 20 } });
    await frame.getByText('分割完成', { exact: false }).waitFor();
    assert.equal(await frame.locator('.cutout-candidates').count(), 0);
    await frame.evaluate(() => { window.__multipleCandidates = true; });
    await frame.locator('.cutout-editor-stage canvas').last().click({ position: { x: 45, y: 30 } });
    await frame.locator('.cutout-candidate-grid img').first().waitFor();
    assert.equal(await frame.locator('.cutout-candidate-grid img').count(), 3);
    const thumb = await frame.locator('.cutout-candidate-grid img').first().evaluate(async img => {
      await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let hasGreen = false; for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] && pixels[i + 1] > pixels[i] + 10) hasGreen = true;
      return { hasGreen, width: canvas.width, height: canvas.height };
    });
    assert.equal(thumb.hasGreen, true, '缩略图必须包含主体颜色，不能只是灰度蒙版');
    assert.ok(thumb.width <= 144 && thumb.height <= 96);
    await button('结果 2').click();
    assert.equal(await button('结果 2').getAttribute('aria-pressed'), 'true');
    assert.equal(await button('结果 2').locator('.cutout-candidate-check').count(), 1);
    await page.screenshot({ path: path.join(process.env.TEMP || '/tmp', 'image-editor-candidates.png') });
    await button('关闭图像处理').click(); await button('放弃并关闭').click();
    await frame.evaluate(() => { window.__multipleCandidates = false; });
    // Trim controls remain usable in the compact tool drawer.
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await frame.evaluate(() => window.__openTrim());
      if (width < 960) await button('工具与参数').click();
      await frame.locator('.cutout-trim-details summary').click();
      await frame.getByRole('checkbox', { name: '裁掉多余透明留白' }).check();
      await frame.getByRole('spinbutton', { name: '上保留间距' }).fill('4');
      await frame.getByRole('checkbox', { name: '同步四边' }).check();
      await frame.locator('.cutout-trim-details').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(process.env.TEMP || '/tmp', `image-editor-trim-${width}.png`) });
      const controls = frame.locator('.cutout-trim-inputs');
      assert.equal(await controls.evaluate(el => el.scrollWidth <= el.clientWidth), true);
      const positions = await controls.evaluate(el => Object.fromEntries(['top', 'left', 'right', 'bottom'].map(side => {
        const box = el.querySelector(`.trim-${side}`).getBoundingClientRect(); return [side, { x: box.x, y: box.y }];
      })));
      assert.ok(positions.top.y < positions.left.y && positions.left.y === positions.right.y && positions.bottom.y > positions.left.y);
      assert.ok(positions.left.x < positions.top.x && positions.right.x > positions.top.x);
      await button('关闭图像处理').click(); await button('放弃并关闭').click();
    }
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
      if (width >= 640) {
        const header = await frame.locator('.cutout-editor-header').boundingBox();
        const tabs = await frame.locator('.cutout-mode-tabs').boundingBox();
        assert.ok(Math.abs((tabs.x + tabs.width / 2) - (header.x + header.width / 2)) < 1, '功能标签必须独立居中');
      }
      if (width < 960) {
        assert.equal(await frame.locator('.cutout-editor-settings').isVisible(), false);
        await button('工具与参数').click(); assert.equal(await button('魔棒').isVisible(), true);
        await page.screenshot({ path: path.join(process.env.TEMP || '/tmp', `image-editor-${width}-tools.png`) });
        if (width < 640) {
          const panel = await frame.locator('.cutout-editor-settings').boundingBox();
          const body = await frame.locator('.cutout-editor-body').boundingBox();
          assert.ok(panel.height <= body.height * .6 + 1);
          const stage = await frame.locator('.cutout-editor-stage').boundingBox();
          assert.ok(stage.width > 0 && stage.height > 0);
          assert.ok(stage.y + stage.height <= panel.y, '小素材应位于工具抽屉上方，不被遮挡');
          assert.equal(await frame.locator('.cutout-panel-scrim').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(32, 35, 42, 0.18)', '悬停遮罩不能覆盖成不透明背景');
        }
        await button('收起').click();
        assert.equal(await button('工具与参数').evaluate(el => el === document.activeElement), true);
        await button('工具与参数').click(); await button('收起').press('Escape');
        assert.equal(await button('工具与参数').evaluate(el => el === document.activeElement), true);
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
