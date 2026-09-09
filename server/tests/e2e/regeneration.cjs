const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { chromium } = require('playwright');

test('marked remote regeneration: review, partial failure, rollback, undo, stale result and cancellation', async () => {
  const root = path.resolve(__dirname, '../..');
  const url = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
  const source = url(await sharp({ create: { width: 80, height: 40, channels: 4, background: '#dfc48b' } }).png().toBuffer());
  const output = url(await sharp({ create: { width: 160, height: 80, channels: 4, background: '#d7b971' } }).png().toBuffer());
  const backdrop = url(await sharp({ create: { width: 400, height: 300, channels: 4, background: '#fff' } }).png().toBuffer());
  const parent = { id: 'parent', name: '探索民宿', contentType: 'image', dataUrl: source, placement: { x: 100.5, y: 100.25, width: 40, height: 20 }, initialPlacement: { x: 100.5, y: 100.25 }, regenerateMarked: false };
  const child = { id: 'child', name: '标题文字', contentType: 'text', text: { characters: '标题' }, parentId: 'parent', placement: { x: 105.5, y: 105.25, width: 10, height: 5 } };
  const hidden = { ...parent, id: 'hidden', name: '隐藏图片', hidden: true, regenerateMarked: true, placement: { x: 200, y: 100, width: 40, height: 20 } };
  let draft = { version: 1, width: 400, height: 300, activeResultIndex: 0, activeSliceId: 'parent', manifest: { screen: { width: 400, height: 300 }, assets: [], resultImages: [{ id: 'fixture', dataUrl: backdrop, width: 400, height: 300, sliceManifest: { assets: [hidden, parent, child] } }] } };
  const server = http.createServer((request, response) => {
    const file = path.resolve(root, decodeURIComponent(request.url.slice(1).split('?')[0] || 'figma-sim.html'));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return response.writeHead(404).end();
    response.setHeader('content-type', path.extname(file) === '.html' ? 'text/html' : 'text/javascript');
    response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('dialog', dialog => dialog.accept());
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    let calls = [], localCalls = 0, failSave = false, hold = false, release, oldBackend = true;
    await page.route('http://127.0.0.1:18787/**', async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      let body = { ok: true, capabilities: { regenerate: 1 } }, status = 200;
      if (pathname === '/health' && oldBackend) body = { ok: true };
      if (pathname.startsWith('/api/local-')) localCalls++;
      if (pathname === '/api/workspace-drafts') body = { drafts: [{ id: 'fixture', note: '测试记录' }], activeDraftId: 'fixture' };
      if (pathname === '/api/model-configs') body = { modelConfigs: [{ id: 'remote', name: '测试图片 API', model: 'mock-image', baseUrl: 'https://example.test', hasApiKey: true, tasks: ['generation', 'inpaint'] }], taskRouting: { generation: 'remote', inpaint: 'remote' } };
      if (pathname === '/api/workspace-draft') {
        if (request.method() === 'POST') {
          const incoming = request.postDataJSON().draft;
          if (failSave && incoming.manifest.resultImages[0].sliceManifest.assets.find(a => a.id === 'parent').dataUrl === output) { status = 500; body = { error: '模拟保存失败' }; }
          else { draft = incoming; body = { ok: true, draftId: 'fixture' }; }
        } else body = { draft, draftId: 'fixture', restorePreference: 'restore', recordCount: 1 };
      }
      if (pathname === '/api/assets/ai-redraw') {
        const payload = request.postDataJSON(); calls.push(payload);
        if (hold) await new Promise(resolve => { release = resolve; });
        if (calls.length === 2) { status = 500; body = { error: '模拟远程单项失败' }; }
        else body = { operation: 'regenerate', images: [{ dataUrl: output, width: 160, height: 80, transparent: false }], provider: { model: 'mock-image' } };
      }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/figma-sim.html`);
    const frame = page.frames().find(f => f !== page.mainFrame());
    const assets = () => frame.evaluate(() => getActiveResultImage().sliceManifest.assets);
    await frame.locator('[data-slice-toolbar-action="mark-regenerate"]').waitFor();
    await frame.locator('[data-slice-toolbar-action="mark-regenerate"]').click();
    assert.match(await frame.locator('#regenerateSlices').innerText(), /2/);
    assert.equal(await frame.locator('.cut-regeneration-badge').count(), 2);
    const markButton = frame.locator('[data-slice-toolbar-action="mark-regenerate"]');
    assert.equal(await markButton.getAttribute('data-tooltip'), '取消重新生成标记');
    const iconStyle = await markButton.evaluate(button => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height, fontSize: getComputedStyle(button).fontSize, display: getComputedStyle(button, '::before').display, mask: getComputedStyle(button, '::before').maskImage }));
    assert.equal(iconStyle.width, iconStyle.height, 'mark uses the same square icon button as other tools');
    assert.equal(iconStyle.fontSize, '0px'); assert.notEqual(iconStyle.display, 'none'); assert.match(iconStyle.mask, /svg/);
    fs.mkdirSync(path.join(root, 'test-results', 'regeneration'), { recursive: true });
    await frame.locator('.resource-toolbar').screenshot({ path: path.join(root, 'test-results', 'regeneration', 'toolbar-icon.png') });
    await frame.locator('[data-slice-toolbar-action="mark-regenerate"]').click();
    assert.match(await frame.locator('#regenerateSlices').innerText(), /1/);
    await frame.locator('[data-slice-toolbar-action="mark-regenerate"]').click();
    // The same mixed-selection rule is used by the real toolbar event.
    await frame.evaluate(() => { selectedSliceIds.clear(); selectedSliceIds.add('child'); activeSliceId = 'child'; renderSelectedSliceActions(); });
    assert.equal(await frame.locator('[data-slice-toolbar-action="mark-regenerate"]').isDisabled(), true);
    await frame.evaluate(() => { selectOnlySlice('parent'); renderSelectedSliceActions(); });
    await page.setViewportSize({ width: 390, height: 844 });
    await frame.locator('#regenerateSlices').scrollIntoViewIfNeeded();
    const entrance = await frame.locator('#regenerateSlices').boundingBox();
    assert.ok(entrance.x >= 0 && entrance.x + entrance.width <= 390, 'narrow-screen entry remains reachable');
    await page.setViewportSize({ width: 1280, height: 800 });
    await frame.locator('#regenerateSlices').click();
    await frame.waitForFunction(() => !regenerationOpening);
    assert.equal(await frame.locator('.regeneration-review').count(), 0, 'old server blocked before preflight');
    assert.equal(calls.length, 0, 'old server never receives billable redraw');
    assert.match(await frame.locator('body').textContent(), /本地后端尚未加载 AI 重新生成功能/);
    oldBackend = false;
    await frame.locator('#regenerateSlices').click();
    const review = frame.locator('.regeneration-review');
    await review.waitFor();
    assert.equal(calls.length, 0, 'preflight does not call paid API');
    assert.match(await review.innerText(), /排除 1 个子级/);
    assert.match(await review.innerText(), /mock-image/);
    const screenshots = path.join(root, 'test-results', 'regeneration'); fs.mkdirSync(screenshots, { recursive: true });
    for (const [width, height] of [[1920, 1080], [1280, 800], [800, 600], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: path.join(screenshots, `preflight-${width}.png`) });
      const box = await review.boundingBox(); assert.ok(box.width <= width && box.height <= height);
      const footer = await review.locator('footer').boundingBox(); assert.ok(footer.y + footer.height <= height);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await review.getByRole('button', { name: '确认并开始生成' }).click();
    await frame.waitForFunction(() => regenerationSession?.running === false && regenerationSession.confirmed);
    assert.equal(calls.length, 2); assert.equal(localCalls, 0);
    assert.equal(calls[0].operation, 'regenerate'); assert.equal(calls[0].quality, 'high');
    assert.deepEqual(calls[0].excludeRegions, [{ x: 10, y: 10, width: 20, height: 10 }]);
    assert.equal(calls[0].width, 80); assert.equal(calls[0].expectedProvider.model, 'mock-image');
    assert.equal((await assets()).find(a => a.id === 'parent').dataUrl, source, 'generation never auto-applies');
    await page.screenshot({ path: path.join(screenshots, 'result-1280.png') });
    await review.getByRole('button', { name: '100%', exact: true }).click();
    const canvas = review.locator('.regeneration-canvas'); const c = await canvas.boundingBox();
    await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2); await page.mouse.down(); await page.mouse.move(c.x + c.width / 2 + 25, c.y + c.height / 2 + 15); await page.mouse.up();
    assert.match(await canvas.locator('img').getAttribute('style'), /translate\(25px, 15px\)/);
    failSave = true;
    await review.getByRole('button', { name: '应用此图' }).click();
    await frame.waitForFunction(() => !regenerationSession.saving);
    assert.match(await review.innerText(), /模拟保存失败/, JSON.stringify(await frame.evaluate(() => ({ error: regenerationSession.items[0].error, status: regenerationSession.items[0].status, sameManifest: regenerationSession.manifest === currentManifest, sameImage: regenerationSession.image === getActiveResultImage(), draftId: activeWorkspaceDraftId, sessionDraft: regenerationSession.draftId }))));
    await review.getByRole('alert').filter({ hasText: '模拟保存失败' }).waitFor();
    assert.equal((await assets()).find(a => a.id === 'parent').dataUrl, source);
    assert.equal((await assets()).find(a => a.id === 'parent').regenerateMarked, true);
    failSave = false;
    await review.getByRole('button', { name: '应用此图' }).click();
    await frame.waitForFunction(() => regenerationSession.items[0].status === 'applied');
    assert.deepEqual((await assets()).find(a => a.id === 'parent').placement, parent.placement);
    assert.equal((await assets()).find(a => a.id === 'parent').outputPixelWidth, 160);
    const exported = await frame.evaluate(() => buildSliceExportManifest({ manifest: currentManifest, activeImage: getActiveResultImage(), getSliceRadius: () => 0 }));
    assert.equal(exported.assets.find(a => a.id === 'parent').outputPixelWidth, 160);
    assert.deepEqual(exported.assets.find(a => a.id === 'parent').placement, parent.placement);
    await review.locator('nav button').nth(1).click();
    await review.getByRole('button', { name: '重试失败项' }).click();
    await frame.waitForFunction(() => regenerationSession.items[1].status === 'ready');
    assert.equal(calls.length, 3);
    await review.getByRole('button', { name: '放弃此结果' }).click();
    await review.getByRole('button', { name: '关闭重新生成' }).click();
    assert.equal(await frame.evaluate(() => document.activeElement.id), 'regenerateSlices', 'modal restores opener focus');
    await frame.evaluate(() => undoSliceChange());
    assert.equal((await assets()).find(a => a.id === 'parent').dataUrl, source);
    assert.equal((await assets()).find(a => a.id === 'parent').regenerateMarked, true);
    assert.equal((await assets()).find(a => a.id === 'hidden').hidden, true);
    // Generate another candidate, then emulate an external edit before application.
    await frame.locator('#regenerateSlices').click();
    await review.getByRole('button', { name: '确认并开始生成' }).click();
    await frame.waitForFunction(() => regenerationSession.confirmed && !regenerationSession.running);
    await frame.evaluate(() => { getActiveSliceAsset('parent').placement.x += 1; });
    await review.getByRole('button', { name: '应用此图' }).click();
    await review.getByRole('alert').filter({ hasText: '已变化' }).waitFor();
    assert.equal((await assets()).find(a => a.id === 'parent').dataUrl, source);
    await review.getByRole('button', { name: '关闭重新生成' }).click();
    hold = true;
    await frame.locator('#regenerateSlices').click();
    await review.getByRole('button', { name: '确认并开始生成' }).click();
    await frame.waitForFunction(() => regenerationSession?.request);
    await review.getByRole('button', { name: '取消剩余任务' }).click();
    release?.();
    await frame.waitForFunction(() => regenerationSession?.running === false);
    assert.equal(await review.getByRole('button', { name: '应用此图' }).count(), 0);
    assert.equal((await assets()).find(a => a.id === 'parent').dataUrl, source);
    await review.getByRole('button', { name: '关闭重新生成' }).click();
    await frame.evaluate(() => flushWorkspaceDraftChanges());
    // A workspace switch must tear down the session and reject even a late success.
    hold = true; release = null;
    await frame.locator('#regenerateSlices').click();
    await review.getByRole('button', { name: '确认并开始生成' }).click();
    await frame.waitForFunction(() => regenerationSession?.request);
    await frame.evaluate(() => { currentManifest = structuredClone(currentManifest); renderCutModules(currentManifest); });
    release?.();
    assert.equal(await review.count(), 0);
    await page.reload();
    const reloaded = page.frames().find(f => f !== page.mainFrame());
    await reloaded.locator('.cut-regeneration-badge').first().waitFor();
    assert.equal(await reloaded.locator('.cut-regeneration-badge').count(), 2);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
