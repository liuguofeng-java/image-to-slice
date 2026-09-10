const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
async function port() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const p = server.address().port; await new Promise(resolve => server.close(resolve)); return p; }
test('development HMR and production preview serve the Vue root and proxy the API', { timeout: 45000 }, async () => {
  for (const preview of [false, true]) {
    const apiPort = await port(), webPort = await port();
    const child = spawn(process.execPath, ['scripts/start-local.js', ...(preview ? ['--preview'] : [])], { cwd: root, env: { ...process.env, PORT: String(apiPort), WEB_PORT: String(webPort) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let logs = ''; child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
    const exit = once(child, 'exit'); let browser;
    try {
      const base = `http://127.0.0.1:${webPort}`; let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) { try { const response = await fetch(base + '/health'); if (response.ok && (await response.json()).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
      assert.equal(ready, true, logs);
      const html = await (await fetch(base)).text(); assert.match(html, /id="app"/); assert.doesNotMatch(html, /figma-sim|ImageToSliceVue|dist\/ui.html/);
      for (const endpoint of ['capture-figma', 'export-fig']) assert.equal((await fetch(base + '/api/design/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
      browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); const consoleMessages = []; page.on('console', m => consoleMessages.push(m.text()));
      // The integration only exercises real /health. Never read or write user history.
      await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ contentType: 'application/json', body: '{}' })); await page.goto(base); await page.locator('.vue-shell').waitFor();
      if (!preview) { const source = await (await fetch(base + '/src/ui/App.vue')).text(); assert.match(source, /import.meta.hot/); await page.waitForFunction(() => document.querySelector('script[src*="/@vite/client"]')); assert.ok(consoleMessages.some(m => m.includes('[vite] connected'))); }
    } finally { if (browser) await browser.close(); if (child.connected) child.disconnect(); await exit; }
  }
});
