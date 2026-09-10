const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { chromium } = require('playwright');
require('./launch.cjs');
const root = path.resolve(__dirname, '../..');
const url = bytes => 'data:image/png;base64,' + bytes.toString('base64');
const bytes = data => Buffer.from(data.split(',')[1], 'base64');
async function fixture() {
  const rgba = Buffer.alloc(220 * 80 * 4);
  for (let y = 10; y < 60; y++) for (let x = 20; x < 180; x++) rgba.set([40, 100, 65, 255], (y * 220 + x) * 4);
  const source = url(await sharp(rgba, { raw: { width: 220, height: 80, channels: 4 } }).png().toBuffer());
  const background = url(await sharp({ create: { width: 400, height: 300, channels: 4, background: '#fafafa' } }).png().toBuffer());
  return { source, background, draft: { version: 1, width: 400, height: 300, activeResultIndex: 0, activeSliceId: 'subject', prompt: '', referenceImages: [],
    manifest: { screen: { name: '测试设计图', width: 400, height: 300 }, assets: [], resultImages: [{ id: 'fixture', dataUrl: background, naturalWidth: 400, naturalHeight: 300,
      sliceManifest: { assets: [{ id: 'subject', name: '探索民宿', contentType: 'image', dataUrl: source, placement: { x: 40.5, y: 50.25, width: 220, height: 80 }, initialPlacement: { x: 40.5, y: 50.25 }, selected: true }] } }] } } };
}
async function withApp(run, options = {}) {
  const f = await fixture(), state = { ...f, calls: [], failSave: false, hold: false, release: null, draft: options.empty ? null : f.draft };
  if (options.children) state.draft.manifest.resultImages[0].sliceManifest.assets.push(
    { id: 'child', name: '子级文字', contentType: 'text', dataUrl: '', parentId: 'subject', text: { characters: '标题' }, placement: { x: 50.5, y: 55.25, width: 20, height: 10 } },
    { id: 'hidden-child', name: '隐藏子级', contentType: 'text', dataUrl: '', parentId: 'subject', hidden: true, text: { characters: '隐藏' }, placement: { x: 90.5, y: 55.25, width: 20, height: 10 } });
  const server = http.createServer((req, res) => {
    const base = path.join(root, 'dist'), file = path.resolve(base, decodeURIComponent(req.url.split('?')[0].slice(1) || 'index.html'));
    if (!file.startsWith(base + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }), errors = [];
  page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.route('**/*', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith('/api/') && pathname !== '/health') return route.continue();
    let body = { ok: true }, status = 200; const payload = request.postData() ? request.postDataJSON() : {};
    if (pathname === '/health') body.capabilities = { regenerate: 1 };
    else if (pathname === '/api/model-configs') body = { modelConfigs: [{ id: 'remote', name: '模拟 API', model: 'mock', baseUrl: 'https://example.test', hasApiKey: true, timeoutSeconds: 90, tasks: ['generation', 'inpaint', 'vision'] }], taskRouting: { generation: 'remote', inpaint: 'remote', vision: 'remote' } };
    else if (pathname === '/api/model-configs/preview/models') body = { models: ['mock-high', 'mock-fast'] };
    else if (pathname === '/api/model-configs/remote' && request.method() === 'PUT') { state.calls.push({ pathname, payload }); body = { config: { id: 'remote' } }; }
    else if (pathname.startsWith('/api/task-routing/')) { state.calls.push({ pathname, payload }); body = { ok: true }; }
    else if (pathname === '/api/workspace-draft') {
      if (request.method() === 'POST') {
        if (state.failSave) { status = 500; body = { error: '模拟保存失败' }; }
        else { state.draft = payload.draft; body = { ok: true, draftId: 'fixture' }; }
      } else body = { draft: state.draft, draftId: 'fixture', restorePreference: 'restore', recordCount: state.draft ? 1 : 0 };
    } else if (pathname === '/api/workspace-drafts') body = { drafts: [{ id: 'fixture', title: '测试记录', sliceCount: state.draft?.manifest.resultImages[0]?.sliceManifest.assets.length || 0, updatedAt: 1, thumbnail: state.background }] };
    else if (pathname.startsWith('/api/workspace-drafts/')) { state.calls.push({ pathname, payload }); body = { item: { id: pathname.endsWith('/duplicate') ? 'fixture_copy' : 'fixture', draft: state.draft } }; }
    else if (pathname.startsWith('/api/progress/')) body = { status: 'running', message: '模拟处理中' };
    else if (pathname.endsWith('/health')) body = { ok: true, checkpointFound: true, iopaintRootFound: true, lamaModelFound: true, realesrganRootFound: true, realesrganModelFound: true, pythonDependenciesFound: true, device: 'cpu' };
    else if (pathname.endsWith('/session')) body = { sessionId: 'mock-session' };
    else if (pathname.includes('/session/')) body = { ok: true };
    else if (pathname.endsWith('/predict')) { const mask = url(await sharp({ create: { width: 220, height: 80, channels: 4, background: '#fff' } }).png().toBuffer()); body = { requestRevision: payload.requestRevision, candidates: [0, 1, 2].map(index => ({ index, score: .9, maskDataUrl: mask })) }; }
    else if (pathname.endsWith('/inpaint')) { state.calls.push({ pathname, payload }); body = { dataUrl: payload.dataUrl, inferenceMs: 1 }; }
    else if (pathname.endsWith('/upscale')) { state.calls.push({ pathname, payload }); const meta = await sharp(bytes(payload.dataUrl)).metadata(), w = meta.width * payload.scale, h = meta.height * payload.scale; body = { dataUrl: url(await sharp(bytes(payload.dataUrl)).resize(w, h).png().toBuffer()), sourcePixelWidth: meta.width, sourcePixelHeight: meta.height, outputPixelWidth: w, outputPixelHeight: h }; }
    else if (pathname === '/api/assets/ai-redraw') {
      state.calls.push({ pathname, payload }); if (state.hold) await new Promise(resolve => { state.release = resolve; });
      const width = payload.width * 2, height = payload.height * 2; body = { operation: 'regenerate', images: [{ dataUrl: url(await sharp(bytes(payload.dataUrl)).resize(width, height).png().toBuffer()), width, height, transparent: true }], provider: { model: 'mock' } };
    } else if (pathname === '/api/design/reconstruct-h5') { state.calls.push({ pathname, payload }); body = { mode: 'h5-fast-direct', html: '<html><head></head><body><main class="screen"><h1>测试标题</h1><script>window.__unsafe=true</script><img data-reference-asset="subject" src="asset:subject"></main></body></html>' }; }
    else if (pathname === '/api/design/plan-background-decomposition') { state.calls.push({ pathname, payload }); body = { assets: [{ name: '新切图', bbox: { x: 0, y: 0, width: 20, height: 20 } }], texts: [], backgrounds: options.backgrounds || [] }; }
    else if (pathname === '/api/images/generate' || pathname === '/api/images/edit') { state.calls.push({ pathname, payload }); body = { images: [{ dataUrl: state.background }] }; }
    else { status = 501; body = { error: '未模拟的 API：' + pathname }; }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
  });
  try { await page.goto('http://127.0.0.1:' + server.address().port + '/'); await page.locator('.startup-gate').waitFor({ state: 'hidden' }); await run(page, state); assert.deepEqual(errors, []); }
  catch (failure) { console.error('Browser errors:', errors); console.error((await page.locator('body').innerText()).slice(-2400)); fs.mkdirSync(path.join(root, 'test-results/vue-app'), { recursive: true }); await page.screenshot({ path: path.join(root, 'test-results/vue-app', 'failure-' + Date.now() + '.png') }); throw failure; }
  finally { state.release?.(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
const button = (page, name) => page.getByRole('button', { name, exact: true });
async function captureState(page, name) {
  const original = page.viewportSize(), folder = path.join(root, 'test-results/vue-parity'); fs.mkdirSync(folder, { recursive: true });
  for (const [width,height] of [[1920,1080],[1280,800],[800,600],[390,844]]) { await page.setViewportSize({width,height}); await page.screenshot({path:path.join(folder,name+'-'+width+'.png')}); }
  await page.setViewportSize(original);
}
const asset = state => state.draft.manifest.resultImages[0].sliceManifest.assets.find(a => a.id === 'subject');

test('model tests show waiting, failures and retry without clearing results', async () => withApp(async page => {
  let listCalls = 0, testCalls = 0, release;
  const config = { id: 'remote', name: '', model: 'mock-high', baseUrl: 'https://example.test', hasApiKey: true, tasks: ['generation', 'inpaint'] };
  await page.route('**/api/model-configs', route => {
    listCalls++;
    return route.fulfill({ json: { modelConfigs: [config], taskRouting: { generation: 'remote', inpaint: 'remote' } } });
  });
  await page.route('**/api/model-configs/remote/test', async route => {
    testCalls++; const first = testCalls === 1;
    if (first) await new Promise(resolve => { release = resolve; });
    await route.fulfill({ json: { config: { ...config, testResults: {
      generation: { status: 'success' }, inpaint: first ? { status: 'failed', error: 'No available compatible accounts — 模拟上游暂时没有支持当前模型的可用账号，请检查账号与模型配置。' } : { status: 'success', nativeMaskSupported: true }
    } } } }).catch(() => {});
  });
  await button(page, '设置').click(); const settings = page.locator('.model-settings-panel');
  assert.match(await button(settings, '图片生成 / 修补').innerText(), /mock-high/);
  try {
    await button(settings, '测试').click();
    await settings.getByText(/测试中… 已等待 [1-9]/).waitFor();
    assert.equal(await button(settings, '编辑').isDisabled(), true);
    assert.equal(await button(settings, '取消测试').isEnabled(), true);
    await captureState(page, 'model-test-waiting'); release();
    await settings.getByText(/No available compatible accounts/).waitFor();
    assert.match(await settings.locator('.model-test-status').innerText(), /图片生成：通过/);
    assert.equal(listCalls, 1, 'do not erase transient results by reloading');
    await captureState(page, 'model-test-failure');
    for (const [width, height] of [[1280,800],[390,844]]) {
      await page.setViewportSize({width,height});
      assert.equal(await settings.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    }
    await button(settings, '测试失败').click(); await button(settings, '支持 Mask').waitFor();
    assert.match(await settings.locator('.model-test-status').innerText(), /图片修补：通过（支持独立 Mask）/);
    assert.equal(testCalls, 2); assert.equal(listCalls, 1);
  } finally { release?.(); }
}));

test('model cancellation permits retry and ignores late results', async () => withApp(async page => {
  let release, calls = 0;
  await page.route('**/api/model-configs/remote/test', async route => {
    calls++; const first = calls === 1;
    if (first) await new Promise(resolve => { release = resolve; });
    await route.fulfill({ json: { config: { testResults: Object.fromEntries(['generation','inpaint','vision'].map(task => [task, first ? { status: 'failed', error: '不应出现的迟到结果' } : { status: 'success', nativeMaskSupported: true }])) } } }).catch(() => {});
  });
  await button(page, '设置').click(); const settings = page.locator('.model-settings-panel');
  try {
    const sent = page.waitForRequest('**/api/model-configs/remote/test');
    await button(settings, '测试').click(); await sent;
    await button(settings, '取消测试').click(); await settings.getByText(/已取消测试/).waitFor();
    assert.equal(await button(settings, '编辑').isEnabled(), true);
    await button(settings, '测试').click(); await button(settings, '支持 Mask').waitFor(); release();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await settings.getByText(/不应出现的迟到结果/).count(), 0); assert.equal(calls, 2);
  } finally { release?.(); }
}));

test('preview test reuses key, reports HTTP errors and cancels on editor close', async () => withApp(async page => {
  const payloads = []; let hold = false, release;
  await page.route('**/api/model-configs/preview/test', async route => {
    payloads.push(route.request().postDataJSON());
    if (hold) await new Promise(resolve => { release = resolve; });
    await route.fulfill({ status: 502, json: { error: '模拟上游连接失败' } }).catch(() => {});
  });
  await button(page, '设置').click(); const settings = page.locator('.model-settings-panel');
  await button(settings, '编辑').click(); const form = page.locator('.model-api-modal');
  await button(form, '测试').click(); await form.getByText('测试失败：模拟上游连接失败').waitFor();
  assert.equal(payloads[0].configId, 'remote'); assert.equal('apiKey' in payloads[0], false); assert.equal('id' in payloads[0], false);
  await form.getByLabel('备注（选填）').fill('新备注');
  await form.getByText('测试失败：模拟上游连接失败').waitFor({state:'hidden'}); hold = true;
  try {
    const sent = page.waitForRequest('**/api/model-configs/preview/test');
    await button(form, '测试').click(); await sent;
    assert.equal(await form.getByLabel('备注（选填）').isDisabled(), true);
    await page.keyboard.press('Escape'); await form.waitFor({state:'hidden'});
    assert.equal(await button(settings, '编辑').isEnabled(), true); release();
    await button(settings, '编辑').click(); assert.equal(await form.locator('.model-test-status').count(), 0);
    await captureState(page, 'model-test-editor');
  } finally { release?.(); }
}));
test('hierarchical reorder and historical copy/restore retain marks and hidden child metadata', async () => withApp(async (page, state) => {
  const parent = page.locator('.cut-item[data-slice-id="subject"]'), child = page.locator('.cut-item[data-slice-id="child"]'), hidden = page.locator('.cut-item[data-slice-id="hidden-child"]');
  assert.equal(await child.getAttribute('data-slice-parent-id'), 'subject');
  assert.deepEqual(await page.locator('.cut-item').evaluateAll(rows => rows.map(el => el.dataset.sliceId)), ['subject','hidden-child','child']);
  await child.dragTo(hidden); await settle(page);
  assert.deepEqual(await page.locator('.cut-item').evaluateAll(rows => rows.map(el => el.dataset.sliceId)), ['subject','child','hidden-child']);
  await parent.click(); await button(page, '标记重新生成').click(); await settle(page);
  const saved = JSON.parse(JSON.stringify(asset(state)));
  await button(page, '切图记录').click(); await button(page.locator('.drafts-panel'), '创建副本').click(); await page.locator('.drafts-panel').waitFor({state:'hidden'});
  await button(page, '切图记录').click(); await button(page.locator('.drafts-panel'), '恢复 测试记录').click(); await page.locator('.drafts-panel').waitFor({state:'hidden'});
  assert.equal(await button(page, 'AI重新生成 (1)').isDisabled(), false);
  await page.reload(); await page.locator('.startup-gate').waitFor({state:'hidden'});
  assert.equal(await page.locator('.cut-regeneration-badge').count(), 1);
  assert.equal(state.draft.manifest.resultImages[0].sliceManifest.assets.find(a => a.id === 'hidden-child').hidden,true);
  assert.equal(asset(state).dataUrl,saved.dataUrl); assert.deepEqual(asset(state).placement,saved.placement);
}, {children:true}));
test('canvas parity: drag, eight handles, radii, nudge, pan, visibility and restore', async () => withApp(async (page, state) => {
  await button(page, '恢复到 100%').click();
  const slice = page.locator('.canvas-slice[data-asset-id="subject"]');
  assert.equal(await slice.locator('.slice-handle').count(), 8); assert.equal(await slice.locator('.slice-radius-handle').count(), 4);
  let bounds = await slice.boundingBox();
  await page.mouse.move(bounds.x + 100, bounds.y + 40); await page.mouse.down(); await page.mouse.move(bounds.x + 110, bounds.y + 45, {steps:4}); await page.mouse.up(); await settle(page);
  assert.equal(asset(state).placement.x, 50.5); assert.equal(asset(state).placement.y, 55.25);
  await button(page, '还原位置').click(); await settle(page); assert.equal(asset(state).placement.x,40.5);
  const handle = await slice.locator('[data-slice-handle="e"]').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2,handle.y + handle.height / 2); await page.mouse.down(); await page.mouse.move(handle.x + handle.width / 2 + 20,handle.y + handle.height / 2, {steps:4}); await page.mouse.up(); await settle(page); assert.equal(asset(state).placement.width,240);
  await page.locator('.canvas-scroll').focus(); await page.keyboard.press('Control+z'); await settle(page); assert.equal(asset(state).placement.width,220);
  const radius = await slice.locator('[data-slice-radius-handle="nw"]').boundingBox();
  await page.mouse.move(radius.x + radius.width/2,radius.y + radius.height/2); await page.mouse.down(); await page.mouse.move(radius.x + radius.width/2+12,radius.y + radius.height/2+12,{steps:4}); await page.mouse.up(); await settle(page); assert.equal(asset(state).radii.topLeft,12);
  await page.locator('.canvas-scroll').focus(); await page.keyboard.press('Shift+ArrowRight'); await settle(page); assert.equal(asset(state).placement.x,50.5);
  await page.keyboard.press('Control+z'); await settle(page); assert.equal(asset(state).placement.x,40.5);
  const board = await page.locator('.design-board').boundingBox(); await page.keyboard.down('Space'); await page.mouse.move(board.x+200,board.y+200); await page.mouse.down(); await page.mouse.move(board.x+220,board.y+210,{steps:4}); await page.mouse.up(); await page.keyboard.up('Space'); assert.equal(Math.round((await page.locator('.design-board').boundingBox()).x-board.x),20);
  await button(page, '隐藏图层').click(); await settle(page); assert.equal(await slice.count(),0); await button(page,'显示图层').click(); await slice.waitFor();
}));
test('model picker keyboard, persisted seconds and narrow slice panel focus', async () => withApp(async (page, state) => {
  await button(page, '设置').click(); const settings = page.locator('.model-settings-panel');
  await button(settings, '图片理解').click(); await settings.getByRole('option').waitFor();
  await button(settings, '图片理解').press('ArrowDown'); assert.equal(await settings.getByRole('option').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape'); assert.equal(await button(settings, '图片理解').evaluate(el => el === document.activeElement), true);
  await button(settings, '编辑').click(); const form = page.locator('.model-api-modal');
  assert.equal(await form.getByLabel('超时时间（秒）').inputValue(), '90');
  await button(form, '获取模型').click(); await form.getByRole('option', {name:'mock-high',exact:true}).click();
  await form.getByLabel('超时时间（秒）').fill('60'); await button(form, '保存并生效').click(); await form.waitFor({state:'hidden'});
  assert.equal(state.calls.find(c => c.pathname === '/api/model-configs/remote').payload.timeoutMs, 60000);
  assert.equal(state.calls.find(c => c.pathname === '/api/model-configs/remote').payload.model, 'mock-high');
  await button(settings, '关闭').click();
  for (const [width,height] of [[800,600],[390,844]]) {
    await page.setViewportSize({width,height}); assert.equal(await page.locator('.vue-slice-list').isVisible(), false);
    await button(page, '图片与切图').click(); await page.locator('.vue-slice-list').waitFor();
    assert.equal(await page.locator('.vue-slice-list').evaluate(el => el === document.activeElement), true);
    if (width < 640) assert.ok((await page.locator('.vue-slice-list').boundingBox()).height <= height * .6 + 1);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('.vue-slice-list').isVisible(), false);
    assert.equal(await button(page, '图片与切图').evaluate(el => el === document.activeElement), true);
  }
}));
const settle = async page => { await page.waitForFunction(() => document.querySelector('.vue-shell')?.dataset.saveState === 'saved' && document.querySelector('.slice-settings-body')?.getAttribute('aria-busy') !== 'true' && document.querySelector('.canvas-scroll')?.getAttribute('aria-busy') !== 'true'); };
test('overlap repair: preview before paid request, pixel mask, rollback retry and undo', async () => withApp(async (page, state) => {
  await page.locator('.cut-item').first().click({ button: 'right' }); const drawer = page.locator('.slice-settings-drawer');
  await button(drawer, 'AI补齐').click(); await page.locator('.slice-overlap-preview').waitFor();
  assert.equal(state.calls.length, 0, 'preview must not call a remote model');
  state.failSave = true; await button(drawer, '确认补齐红色区域').click();
  await page.locator('.workspace-status').filter({ hasText: '模拟保存失败' }).waitFor();
  assert.equal(asset(state).dataUrl, state.source);
  state.failSave = false; await button(drawer, '确认补齐红色区域').click();
  await page.locator('.slice-overlap-preview').waitFor({ state: 'hidden' }); await settle(page);
  assert.deepEqual(state.calls[0].payload.completeRegions, [{ x: 10, y: 5, width: 20, height: 10 }]);
  assert.equal(state.calls[0].payload.quality, 'high'); assert.ok(state.calls[0].payload.maskDataUrl);
  const output = await sharp(bytes(asset(state).dataUrl)).raw().toBuffer(), source = await sharp(bytes(state.source)).raw().toBuffer();
  assert.deepEqual(output.subarray((30 * 220 + 80) * 4, (30 * 220 + 81) * 4), source.subarray((30 * 220 + 80) * 4, (30 * 220 + 81) * 4), 'pixels outside mask stay unchanged');
  assert.equal(asset(state).placement.x, 40.5);
  assert.equal(await drawer.getByLabel('X 坐标', {exact:true}).isDisabled(), true, 'completed AI images lock geometry in the property drawer');
  assert.ok(await page.locator('.slice-cutout.processed img').count() > 0, 'completed pixels must appear in the canvas');
  await button(drawer, '关闭切图设置').click(); await page.locator('.canvas-scroll').focus(); await page.keyboard.press('ArrowRight'); await settle(page);
  assert.equal(asset(state).placement.x, 40.5, 'moving a completed result preserves its original position');
  const copy = state.draft.manifest.resultImages[0].sliceManifest.assets.find(a => a.aiCompleteSourceAssetId === 'subject');
  assert.equal(copy.placement.x, 41.5); assert.equal(copy.aiCompleted, undefined);
  await page.keyboard.press('Control+z'); await settle(page);
  await page.keyboard.press('Control+z'); await settle(page);
  assert.equal(asset(state).dataUrl, state.source);
}, { children: true }));

test('background review: valid geometry, round corners, undo and viewport layouts', async () => withApp(async (page, state) => {
  await button(page, 'AI拆图').click(); const modal = page.locator('.decomposition-modal');
  await modal.getByLabel('圆角', { exact: true }).fill('12'); await modal.getByLabel('圆角', { exact: true }).press('Tab'); await settle(page);
  assert.equal(state.draft.manifest.resultImages[0].backgroundDecompositionCache.review.backgrounds[0].radius, 12);
  const width = modal.getByLabel('width', { exact: true }).first(); await width.fill('-2'); await width.press('Tab'); await settle(page); assert.equal(await width.inputValue(), '1');
  await modal.press('Control+z'); await settle(page); assert.equal(await width.inputValue(), '300');
  const folder = path.join(root, 'test-results/vue-parity'); fs.mkdirSync(folder, { recursive: true });
  for (const [w,h] of [[1920,1080],[1280,800],[800,600],[390,844]]) {
    await page.setViewportSize({ width:w, height:h }); await page.screenshot({ path:path.join(folder, 'decomposition-' + w + '.png') });
    assert.equal(await modal.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    const action = await button(modal, '生成完整背景').boundingBox(); assert.ok(action.y + action.height <= h);
  }
  await button(modal, '关闭').click();
}, { backgrounds: [{ id:'bg', name:'完整背景', bbox:{x:10,y:10,width:300,height:200}, radius:0, overlays:[{id:'overlay', name:'按钮', kind:'code-overlay', bbox:{x:50,y:40,width:60,height:20}}] }] }));

test('Vue root: upload, continuous selection, settings, multi-select, history and export', async () => withApp(async (page, state) => {
  assert.equal(await page.locator('iframe').count(), 0); assert.equal(await page.evaluate(() => typeof window.ImageToSliceVue), 'undefined'); assert.doesNotMatch(await page.locator('body').innerText(), /Figma|AI 图层导入/);
  await page.getByTestId('local-image').setInputFiles({ name: 'design.png', mimeType: 'image/png', buffer: bytes(state.background) });
  await page.locator('.design-board').waitFor(); await button(page, '连续框选').click();
  const box = await page.locator('.design-board').boundingBox();
  for (const offset of [350, 450]) { await page.mouse.move(box.x + offset, box.y + 120); await page.mouse.down(); await page.mouse.move(box.x + offset + 60, box.y + 165, { steps: 5 }); await page.mouse.up(); }
  await page.waitForFunction(() => document.querySelectorAll('.cut-item').length === 2); await settle(page);
  await page.locator('.cut-item').last().click({ button: 'right' }); const modal = page.locator('.slice-settings-drawer'); await modal.getByLabel('标题', { exact: true }).fill('small_image'); await modal.getByLabel('标题', { exact: true }).press('Tab'); await settle(page); await modal.getByRole('combobox').first().selectOption('text'); await settle(page); await button(modal, '关闭切图设置').click();
  assert.equal(await button(page, '标记重新生成').isDisabled(), true);
  await page.locator('.cut-item').first().click(); await page.locator('.cut-item').last().click({ modifiers: ['Control'] }); await page.locator('.canvas-scroll').focus(); await page.keyboard.press('Delete'); await page.waitForFunction(() => document.querySelectorAll('.cut-item').length === 0);
  await page.locator('.canvas-scroll').focus(); await page.keyboard.press('Control+z'); await page.waitForFunction(() => document.querySelectorAll('.cut-item').length === 2);
  const download = page.waitForEvent('download'); await button(page, '导出切图包').click(); assert.equal((await download).suggestedFilename(), 'slices.zip');
  await button(page, '切图记录').click(); await page.getByText('测试记录', { exact: true }).waitFor(); await button(page, '关闭切图记录').click();
}, { empty: true }));

test('direct editor: trim geometry, save rollback, undo, upscale and responsive layouts', async () => withApp(async (page, state) => {
  await page.locator('.cut-item').waitFor(); await button(page, 'AI 抠图').click(); const editor = page.locator('.cutout-editor'); await editor.waitFor();
  assert.equal(await button(editor, '结果').count(), 1);
  await editor.locator('.cutout-trim-details summary').click(); await editor.getByRole('checkbox', { name: '裁掉多余透明留白' }).check();
  for (const [side, value] of [['上', '3'], ['左', '5'], ['右', '7'], ['下', '9']]) { const field = editor.getByRole('spinbutton', { name: side + '保留间距' }); await field.fill(value); await field.press('Tab'); }
  await button(editor, '结果').click(); state.failSave = true; await button(editor, '保存到切图').click(); await editor.getByRole('alert').filter({ hasText: '模拟保存失败' }).waitFor();
  assert.equal(asset(state).dataUrl, state.source); state.failSave = false; await button(editor, '保存到切图').click(); await editor.waitFor({ state: 'hidden' });
  assert.deepEqual(asset(state).placement, { x: 55.5, y: 57.25, width: 172, height: 62 });
  assert.deepEqual(asset(state).initialPlacement, { x: 55.5, y: 57.25 });
  await button(page, 'AI 抠图').click(); await editor.waitFor(); await button(editor, '高清化').click(); await editor.getByRole('button', { name: /^2×/ }).click(); await button(editor, '开始高清化').click(); await button(editor, '保存到切图').click(); await editor.waitFor({ state: 'hidden' });
  assert.equal(asset(state).outputPixelWidth, 344); assert.equal(asset(state).placement.width, 172);
  await page.locator('.canvas-scroll').focus(); await page.keyboard.press('Control+z'); await settle(page); assert.equal(asset(state).outputPixelWidth, 172);
  await button(page, 'AI 抠图').click(); await editor.waitFor();
  fs.mkdirSync(path.join(root, 'test-results/vue-app'), { recursive: true });
  for (const [width, height] of [[1920,1080], [1280,800], [800,600], [390,844]]) {
    await page.setViewportSize({ width, height }); await page.screenshot({ path: path.join(root, 'test-results/vue-app', 'editor-' + width + '.png') });
    assert.equal(await editor.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    const save = await button(editor, '保存到切图').boundingBox(); assert.ok(save.x >= 0 && save.y + save.height <= height);
  }
  await page.setViewportSize({ width: 1280, height: 800 }); await editor.getByRole('button', { name: '关闭图像处理', exact: true }).click();
  for (const [width, height] of [[1920,1080], [1280,800], [800,600], [390,844]]) { await page.setViewportSize({ width, height }); await page.screenshot({ path: path.join(root, 'test-results/vue-app', 'workspace-' + width + '.png') }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
}));

test('remote regeneration: child pixel mapping, review, rollback, undo and cancel', async () => withApp(async (page, state) => {
  await page.locator('.cut-item').first().waitFor(); await button(page, '标记重新生成').click(); await settle(page);
  await button(page, 'AI重新生成 (1)').click(); const review = page.locator('.regeneration-review'); await review.waitFor(); assert.equal(state.calls.length, 0);
  await button(review, '确认并开始生成').click(); await button(review, '应用此图').waitFor(); state.failSave = true; await button(review, '应用此图').click(); await review.getByRole('alert').filter({ hasText: '模拟保存失败' }).waitFor(); assert.equal(asset(state).dataUrl, state.source); await captureState(page, 'regeneration-save-error');
  state.failSave = false; await button(review, '应用此图').click(); await page.waitForFunction(() => document.querySelector('.regeneration-review')?.textContent.includes('已应用'));
  assert.equal(asset(state).regenerateMarked, false); assert.equal(asset(state).outputPixelWidth, 440); assert.equal(asset(state).placement.width, 220);
  await button(review, '关闭重新生成').click(); await page.locator('.canvas-scroll').focus(); await page.keyboard.press('Control+z'); await settle(page); assert.equal(asset(state).regenerateMarked, true);
  state.hold = true; await button(page, 'AI重新生成 (1)').click(); await button(review, '确认并开始生成').click();
  for (let i = 0; i < 100 && !state.release; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(state.release, 'request is in flight before cancelling'); await captureState(page, 'regeneration-progress');
  await button(review, '取消剩余任务').click(); state.release(); await button(review, '关闭重新生成').click(); assert.equal(asset(state).dataUrl, state.source);
  assert.equal(state.calls.filter(c => c.pathname.startsWith('/api/local-')).length, 0); assert.equal(state.calls[0].payload.operation, 'regenerate'); assert.equal(state.calls[0].payload.quality, 'high');
  assert.deepEqual(state.calls[0].payload.excludeRegions, [{ x: 10, y: 5, width: 20, height: 10 }]);
}, { children: true }));

test('HTML runs only in isolated iframe, editing and standalone download; AI decomposition preserved', async () => withApp(async (page, state) => {
  await page.locator('.cut-item').waitFor(); await button(page, '生成 HTML').click(); const modal = page.locator('.html-workspace'); await modal.locator('iframe').waitFor();
  const frame = page.frameLocator('iframe'); await frame.getByText('测试标题', { exact: true }).waitFor(); assert.equal(await page.evaluate(() => window.__unsafe), undefined);
  assert.equal(await modal.locator('iframe').getAttribute('sandbox'), 'allow-same-origin'); assert.equal(await frame.locator('script').count(), 0);
  assert.equal(await button(modal, '检查与编辑').getAttribute('aria-pressed'), 'true'); await frame.getByText('测试标题', { exact: true }).click(); await modal.getByText('编辑属性', {exact:true}).click(); await modal.getByLabel('文字', { exact: true }).fill('修改标题'); await button(modal, '应用编辑').click(); await frame.getByText('修改标题', { exact: true }).waitFor();
  const rows = modal.locator('.html-preview-inspector-tree-row'), count = await rows.count();
  await button(modal, '收起 body').click(); assert.equal(await rows.count(), 1); await button(modal, '展开 body').click(); assert.equal(await rows.count(), count);
  fs.mkdirSync(path.join(root, 'test-results/vue-parity'), { recursive: true });
  for (const [width, height] of [[1920,1080],[1280,800],[800,600],[390,844]]) { await page.setViewportSize({width,height}); await page.screenshot({path:path.join(root, 'test-results/vue-parity', 'html-' + width + '.png')}); assert.equal(await modal.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true); }
  await page.setViewportSize({width:1280,height:800});
  const download = page.waitForEvent('download'); await button(modal, '下载 HTML').click(); assert.equal((await download).suggestedFilename(), 'design-html.zip');
  await button(modal, '关闭').click(); const calls = state.calls.length; await button(page, '生成 HTML').click(); await page.frameLocator('iframe').getByText('修改标题', { exact: true }).waitFor(); assert.equal(state.calls.length, calls, 'cache does not silently call a paid model');
  await button(page.locator('.html-workspace'), '关闭').click(); await button(page, 'AI拆图').click(); await page.getByText('未发现需要还原的完整背景。').waitFor(); await button(page.locator('.decomposition-modal'), '关闭').click(); await page.waitForFunction(() => document.querySelectorAll('.cut-item').length === 2);
}));

test('smart candidates and local repair share the editor without leaking shortcuts into workspace undo', async () => withApp(async (page, state) => {
  await page.locator('.cut-item').waitFor();
  await button(page, '标记重新生成').click(); await settle(page);
  await button(page, 'AI 抠图').click(); const editor = page.locator('.cutout-editor'); await editor.waitFor();
  await button(editor, '智能选择').click(); await editor.locator('.cutout-editor-stage canvas').last().click({ position: { x: 60, y: 30 } });
  await editor.locator('.cutout-candidate-grid img').first().waitFor(); assert.equal(await editor.locator('.cutout-candidate-grid img').count(), 3);
  await editor.getByRole('button', { name: '结果 2', exact: true }).click(); await button(editor, '结果').click(); assert.equal(await editor.locator('.cutout-point').count(), 0);
  await editor.press('Control+z'); assert.equal(await page.locator('[data-slice-toolbar-action="mark-regenerate"]').getAttribute('aria-pressed'), 'true', 'editor undo must not undo the workspace mark');
  await button(editor, '重做').click();
  await button(editor, '局部修复').click();
  const canvas = await editor.locator('.cutout-editor-stage canvas').last().boundingBox();
  await page.mouse.move(canvas.x + 30, canvas.y + 20); await page.mouse.down(); await page.mouse.move(canvas.x + 60, canvas.y + 40, { steps: 4 }); await page.mouse.up();
  await button(editor, '保存到切图').click(); await editor.getByRole('alertdialog').waitFor(); await button(editor, '返回修复').click();
  await button(editor, '开始修复').click(); await button(editor, '保存到切图').click(); await editor.waitFor({ state: 'hidden' });
  assert.equal(asset(state).localInpaintMethod, 'iopaint-lama'); assert.equal(asset(state).cutoutMethod, 'sam2-local');
  assert.ok(state.calls.some(call => call.pathname === '/api/local-image-processing/inpaint'));
}));
test('original source controls: ratios, custom commit/cancel, count, paste/drop and high-quality request', async () => withApp(async (page, state) => {
  const folder = path.join(root, 'test-results/vue-parity'); fs.mkdirSync(folder, { recursive: true });
  assert.equal(await page.locator('.ratio-grid .choice').count(), 6);
  assert.equal(await page.locator('.choice.active').innerText(), '9:16\n手机屏\n750px × 1334px');
  await page.getByLabel('1. 输入描述词').fill('生成测试'); assert.equal(await page.locator('.char-count').innerText(), '4 / 1000');
  for (const [width, height] of [[1920,1080], [1280,800], [800,600], [390,844]]) { await page.setViewportSize({ width, height }); await page.screenshot({ path: path.join(folder, 'source-' + width + '.png') }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: /自定义/ }).click(); const modal = page.locator('.custom-size-modal');
  await modal.getByLabel('宽度', { exact: true }).fill('804'); await modal.getByLabel('高度', { exact: true }).fill('2230'); await button(modal, '取消').click(); assert.equal(await page.locator('.choice.active .choice-main').innerText(), '9:16');
  await page.getByRole('button', { name: /自定义/ }).click(); await modal.getByLabel('宽度', { exact: true }).fill('804'); await modal.getByLabel('高度', { exact: true }).fill('2230'); await button(modal, '确定').click();
  await button(page, '图生图').click();
  await page.locator('#prompt').evaluate((el, dataUrl) => { const payload = Uint8Array.from(atob(dataUrl.split(',')[1]), c => c.charCodeAt(0)); const transfer = new DataTransfer(); transfer.items.add(new File([payload], 'pasted.png', { type: 'image/png' })); el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })); }, state.source);
  await page.locator('.reference-chip').waitFor();
  await page.locator('.prompt-box').evaluate((el, dataUrl) => { const payload = Uint8Array.from(atob(dataUrl.split(',')[1]), c => c.charCodeAt(0)); const transfer = new DataTransfer(); transfer.items.add(new File([payload], 'dropped.png', { type: 'image/png' })); el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })); }, state.source);
  await page.waitForFunction(() => document.querySelectorAll('.reference-chip').length === 2);
  await button(page, '预览参考图 1').click(); await page.locator('.app-modal .asset-full-preview').waitFor(); await button(page.locator('.app-modal'), '关闭').click();
  await page.screenshot({ path: path.join(folder, 'references-1280.png') });
  await button(page, 'AI生图').click(); await page.locator('.design-board').waitFor(); assert.equal(await page.locator('.source-controls').isVisible(), false);
  const request = state.calls.find(c => c.pathname === '/api/images/edit'); assert.equal(request.payload.images.length, 2); assert.equal(request.payload.width, 804); assert.equal(request.payload.height, 2230); assert.equal(request.payload.quality, 'high');
}, { empty: true }));

test('floating panels: original model seconds, right-click live properties, corner radius and keyboard undo', async () => withApp(async (page, state) => {
  const folder = path.join(root, 'test-results/vue-parity'); fs.mkdirSync(folder, { recursive: true });
  await page.locator('.cut-item').waitFor(); await button(page, '设置').click(); const settings = page.locator('.model-settings-panel'); await settings.waitFor();
  assert.equal(Math.round((await settings.boundingBox()).width), 520);
  await page.screenshot({ path: path.join(folder, 'settings-1280.png') });
  await button(settings, '＋ 新建 API').click(); const form = page.locator('.model-api-modal'); assert.equal(await form.getByLabel('超时时间（秒）').inputValue(), '500'); await form.getByLabel('超时时间（秒）').fill('60');
  await page.screenshot({ path: path.join(folder, 'model-api-1280.png') }); await button(form, '关闭').click(); await button(settings, '关闭').click();
  await page.locator('.cut-item').click({ button: 'right' }); const drawer = page.locator('.slice-settings-drawer'); await drawer.waitFor();
  await drawer.getByLabel('X 坐标', { exact: true }).fill('70.5'); await drawer.getByLabel('X 坐标', { exact: true }).press('Tab'); await settle(page); assert.equal(asset(state).placement.x, 70.5);
  await drawer.getByLabel('左上', { exact: true }).fill('12'); await drawer.getByLabel('左上', { exact: true }).press('Tab'); await settle(page); assert.equal(asset(state).radii.topLeft, 12);
  await page.screenshot({ path: path.join(folder, 'slice-settings-1280.png') });
  await button(drawer, '关闭切图设置').click(); await page.locator('.canvas-scroll').focus(); await page.keyboard.press('Control+z'); await settle(page); assert.equal(asset(state).radii, undefined);
  await button(page, '还原位置').click(); await settle(page); assert.equal(asset(state).placement.x, 40.5);
  await button(page, '切图记录').click(); await page.locator('.drafts-panel').waitFor(); await page.screenshot({ path: path.join(folder, 'history-1280.png') }); await button(page, '修改备注').click(); await page.locator('.record-note-input').fill('回归测试'); await button(page.locator('.record-note-modal'), '取消').click(); await button(page, '关闭切图记录').click();
}));

test('image preview restores eraser, mask and close/save rollback without a local model call', async () => withApp(async (page, state) => {
  await button(page, '图片预览').click(); const preview = page.locator('.slice-preview-dialog'); await preview.waitFor();
  assert.equal(await button(preview, 'AI补齐').isDisabled(), true); await button(preview, '橡皮擦').click();
  await preview.locator('#sliceImageEditorMask').click({ position: { x: 140, y: 80 } }); await button(preview, '关闭').click(); await preview.getByRole('alertdialog').waitFor(); await button(preview, '取消').click();
  state.failSave = true; await button(preview, '保存到切图').click(); await preview.getByRole('alert').waitFor(); assert.equal(asset(state).dataUrl, state.source);
  state.failSave = false; await button(preview, '保存到切图').click(); await preview.waitFor({ state: 'hidden' }); assert.notEqual(asset(state).dataUrl, state.source); assert.deepEqual(asset(state).placement, { x: 40.5, y: 50.25, width: 220, height: 80 });
  await page.locator('.canvas-scroll').focus(); await page.keyboard.press('Control+z'); await settle(page); assert.equal(asset(state).dataUrl, state.source); assert.equal(state.calls.length, 0);
}));

test('e9685a1 static layout reference: source controls, long design and four viewport screenshots', async () => withApp(async (page, state) => {
  const { execFileSync } = require('node:child_process');
  const originalCss = execFileSync('git', ['show', 'e9685a1:server/src/ui/styles.css'], { cwd: root, encoding: 'utf8' });
  const originalTemplate = execFileSync('git', ['show', 'e9685a1:server/src/ui/ui.template.html'], { cwd: root, encoding: 'utf8' }).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace('/* __UI_STYLES__ */', originalCss);
  const reference = await page.context().browser().newPage(); await reference.route('**/*', route => route.abort());
  const folder = path.join(root, 'test-results/vue-parity'); fs.mkdirSync(folder, { recursive: true });
  const rectangles = [{ input: { create: { width: 744, height: 350, channels: 4, background: '#38664d' } }, left: 30, top: 160 }, ...[650, 1050, 1450, 1850].map(top => ({ input: { create: { width: 744, height: 280, channels: 4, background: '#e5efe7' } }, left: 30, top }))];
  const long = await sharp({ create: { width: 804, height: 2230, channels: 4, background: '#ffffff' } }).composite(await Promise.all(rectangles.map(async r => ({ ...r, input: await sharp(r.input).png().toBuffer() })))).png().toBuffer();
  const rect = async (p, selector) => p.locator(selector).first().boundingBox();
  try {
    for (const [width, height] of [[1920,1080], [1280,800], [800,600], [390,844]]) {
      await page.setViewportSize({ width, height }); await reference.setViewportSize({ width, height });
      await reference.setContent(originalTemplate);
      await reference.evaluate(() => {
        document.querySelector('#startupGate').remove();
        document.querySelector('#placeSource').closest('.import-action-group').remove();
        document.querySelector('#placeAiLayers').textContent = '生成 HTML';
        document.querySelector('#exportFigmaFrameHtml').remove();
        document.querySelector('#draftsTrigger').hidden = false;
      });
      if (width >= 960) for (const selector of ['.tabs', '.prompt-box', '.ratio-grid', '.generate-actions']) {
        const a = await rect(page, selector), b = await rect(reference, selector);
        for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(a[key] - b[key]) <= 2, selector + ' ' + key + ': ' + a[key] + ' vs ' + b[key]);
      }
      await reference.screenshot({ path: path.join(folder, 'baseline-source-' + width + '.png') }); await page.screenshot({ path: path.join(folder, 'restored-source-' + width + '.png') });
    }
    await page.getByTestId('local-image').setInputFiles({ name: 'long-design.png', mimeType: 'image/png', buffer: long }); await page.locator('.design-board').waitFor();
    for (const [width, height] of [[1920,1080], [1280,800], [800,600], [390,844]]) {
      await page.setViewportSize({ width, height }); await reference.setViewportSize({ width, height }); await reference.setContent(originalTemplate);
      await reference.evaluate(({ dataUrl, width, height }) => {
        document.querySelector('#startupGate').remove(); document.querySelector('.sidebar').classList.add('has-result'); document.querySelector('#cutSection').classList.add('open'); document.querySelector('#cutGrid').innerHTML = '<div class="cut-empty">还没有切图区域</div>';
        document.querySelector('#placeSource').closest('.import-action-group').remove(); document.querySelector('#placeAiLayers').textContent = '生成 HTML'; document.querySelector('#exportFigmaFrameHtml').remove(); document.querySelector('#draftsTrigger').hidden = false; document.querySelector('#previewZoomControls').hidden = false;
        const zoom = Math.min(4, Math.max(.1, Math.min((width - 24) / 804, (height - 24) / 2230)));
        document.querySelector('.preview-zoom-value').textContent = Math.round(zoom * 100) + '%';
        const result = document.querySelector('#resultGrid'); result.innerHTML = '<div class="result-card slice-mode"><div class="result-frame"><div class="result-sizer"><div class="result-canvas"><img alt="当前生成结果"></div></div></div></div>';
        const canvas = result.querySelector('.result-canvas'); Object.assign(canvas.style, { width: 804 * zoom + 'px', height: 2230 * zoom + 'px', left: Math.max(0, (width - 804 * zoom) / 2) + 'px', top: Math.max(0, (height - 2230 * zoom) / 2) + 'px' });
        const img = canvas.querySelector('img'); img.src = dataUrl; Object.assign(img.style, { width: Math.round(804 * zoom) + 'px', height: Math.round(2230 * zoom) + 'px', maxWidth: 'none', maxHeight: 'none' });
      }, { dataUrl: url(long), width, height });
      await page.screenshot({ path: path.join(folder, 'restored-long-' + width + '.png') }); await reference.screenshot({ path: path.join(folder, 'baseline-long-' + width + '.png') });
      if (width >= 960) { const a = await rect(page, '.cut-section'), b = await rect(reference, '.cut-section'); assert.deepEqual(a, b); }
      const board = await rect(page, '.design-board'), expected = Math.min(4, Math.max(.1, Math.min((width - 24) / 804, (height - 24) / 2230)));
      assert.ok(Math.abs(board.height - 2230 * expected) < 1); assert.equal(await page.locator('.source-controls').isVisible(), false);
      assert.equal(await page.locator('.selected-slice-actions').count(), 0);
      assert.ok((await rect(page, '.resource-toolbar')).y + (await rect(page, '.resource-toolbar')).height <= height);
    }
  } finally { await reference.close(); }
}, { empty: true }));
