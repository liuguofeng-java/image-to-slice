import { test, expect, type Page } from '@playwright/test';
import type { Project, Asset } from '../../src/types';
const backend = 'http://127.0.0.1:3003';
async function fresh(page: Page) {
  const p = (await (
    await page.request.post(backend + '/api/v1/projects', { data: { name: '交互验收' } })
  ).json()) as Project;
  await page.goto('/editor');
  await page.evaluate((id) => localStorage.setItem('slice-studio-project', id), p.id);
  await page.reload();
  await expect(page.getByRole('button', { name: '交互验收', exact: true })).toBeVisible();
  return p;
}
async function image(page: Page, width = 804, height = 2230) {
  const data = await page.evaluate(
    ({ width, height }) => {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      const x = c.getContext('2d')!;
      x.fillStyle = '#f3f3ef';
      x.fillRect(0, 0, width, height);
      x.fillStyle = '#234836';
      x.fillRect(24, 24, width - 48, Math.min(height - 48, 280));
      x.fillStyle = '#e6eed8';
      x.font = 'bold 42px sans-serif';
      x.fillText('探索自然', 48, 96);
      x.font = '20px sans-serif';
      x.fillText('A quieter place to stay', 48, 140);
      for (let y = 340; y < height; y += 300) {
        x.fillStyle = y % 600 === 340 ? '#b9c9b2' : '#d0c4ae';
        x.fillRect(24, y, width - 48, 240);
        x.fillStyle = '#425448';
        x.fillRect(44, y + 24, (width - 100) / 2, 150);
      }
      return c.toDataURL().split(',')[1];
    },
    { width, height },
  );
  await page.getByLabel('选择导入图片').setInputFiles({
    name: '探索民宿.png',
    mimeType: 'image/png',
    buffer: Buffer.from(data, 'base64'),
  });
  await expect(page.getByRole('option', { name: '探索民宿', exact: true })).toBeVisible();
  await expect(page.getByLabel('图层名称')).toHaveValue('探索民宿');
  await expect(page.getByRole('button', { name: '已保存', exact: true })).toBeVisible();
}
test('import, properties, undo, lock, multi-select, export, and refresh', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const p = await fresh(page);
  await image(page);
  await page.getByLabel('X 位置').fill('123.5');
  await page.getByLabel('X 位置').press('Enter');
  await expect(page.getByLabel('X 位置')).toHaveValue('123.50');
  await page.getByRole('button', { name: '撤销 (Ctrl+Z)', exact: true }).click();
  await expect(page.getByLabel('X 位置')).toHaveValue('0.00');
  await page.getByRole('button', { name: '重做 (Ctrl+Shift+Z)', exact: true }).click();
  await expect(page.getByLabel('X 位置')).toHaveValue('123.50');
  await page.getByRole('button', { name: '复制', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(2);
  await page.getByRole('button', { name: '锁定图层', exact: true }).click();
  await expect(page.getByLabel('X 位置')).toBeDisabled();
  await page.getByRole('button', { name: '解锁图层', exact: true }).click();
  await page.getByRole('option', { name: '探索民宿', exact: true }).click({ modifiers: ['Shift'] });
  await expect(page.getByRole('button', { name: '左对齐', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '左对齐', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '所选图层 ZIP', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('slices.zip');
  await expect(page.getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('option')).toHaveCount(2);
  const saved = (await (
    await page.request.get(backend + '/api/v1/projects/' + p.id)
  ).json()) as Project;
  expect(saved.scenes[0].layers[0].x).toBe(123.5);
  expect(saved.scenes[0].layers[1].x).toBe(123.5);
  expect(errors).toEqual([]);
});
test('AI confirm, candidate editing, transactional apply, undo and original retained', async ({
  page,
}, info) => {
  const p = await fresh(page);
  await image(page, 320, 200);
  await page.getByLabel('旋转角度').fill('37');
  await page.getByLabel('旋转角度').press('Enter');
  await page.getByRole('button', { name: '水平翻转', exact: true }).click();
  await page
    .locator('.bottom-toolbar')
    .getByRole('button', { name: 'AI 框选拆图', exact: true })
    .click();
  await page.getByRole('button', { name: '选择整张图片', exact: true }).click();
  await expect(page.getByText('320 × 200 px', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '开始 AI 分析', exact: true }).click();
  await expect(page.getByText(/远程服务可能计费/)).toBeVisible();
  await page.getByRole('button', { name: '发送并分析', exact: true }).click();
  await expect(page.getByLabel('候选 1 名称')).toHaveValue('标题区域');
  await page.getByLabel('候选 1 名称').fill('标题切片');
  await page.getByLabel('候选 1 名称').press('Enter');
  await page.screenshot({ path: info.outputPath('ai-candidates.png') });
  await page.getByRole('button', { name: '创建 1 个图层', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(2);
  await expect(page.getByRole('option', { name: '探索民宿', exact: true })).toBeVisible();
  const result = (await (
    await page.request.get(backend + '/api/v1/projects/' + p.id)
  ).json()) as Project;
  expect(result.scenes[0].layers[1].source?.rect).toEqual({ x: 0, y: 0, width: 160, height: 66 });
  expect(result.scenes[0].layers[1].rotation).toBe(37);
  expect(result.scenes[0].layers[1].flipX).toBe(true);
  await page.getByRole('button', { name: '撤销 (Ctrl+Z)', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(1);
});
test('manual candidates and save failure retain content for retry', async ({ page }) => {
  await fresh(page);
  await image(page, 360, 180);
  await page
    .locator('.bottom-toolbar')
    .getByRole('button', { name: 'AI 框选拆图', exact: true })
    .click();
  await page.getByRole('button', { name: '选择整张图片' }).click();
  await page.getByRole('button', { name: '手动框选拆图', exact: true }).click();
  await expect(page.getByLabel('候选 1 名称')).toBeVisible();
  await page.getByRole('button', { name: '添加候选框' }).click();
  await expect(page.getByLabel('候选 2 名称')).toBeVisible();
  await page.getByRole('button', { name: '创建 2 个图层', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(3);
  await page.getByRole('tab', { name: '设计', exact: true }).click();
  await page.getByRole('option', { name: '探索民宿', exact: true }).click();
  await page.route('**/api/v1/projects/*', (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: '{"error":"模拟保存失败"}',
        })
      : route.continue(),
  );
  await page.getByLabel('X 位置').fill('64');
  await page.getByLabel('X 位置').press('Enter');
  await expect(page.getByRole('button', { name: '保存失败', exact: true })).toBeVisible();
  await expect(page.getByLabel('X 位置')).toHaveValue('64.00');
  await page.unroute('**/api/v1/projects/*');
  await page.getByRole('button', { name: '保存失败', exact: true }).click();
  await expect(page.getByRole('button', { name: '已保存', exact: true })).toBeVisible();
});
test('model config uses standalone contract and never returns API key', async ({ page }) => {
  await fresh(page);
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByRole('button', { name: '获取模型', exact: true }).click();
  await expect(page.getByText('获取到 1 个模型，请选择支持图片理解的模型。')).toBeVisible();
  const c = await (await page.request.get(backend + '/api/v1/model-configs')).json();
  expect(c.config.model).toBe('mock-vision');
  expect(c.config.hasApiKey).toBe(true);
  expect(c.config.apiKey).toBeUndefined();
  await page.getByRole('button', { name: '测试图片理解', exact: true }).click();
  await page.getByRole('button', { name: '发送测试', exact: true }).click();
  await expect(page.getByText('测试成功，模型可以接收图片并返回内容。')).toBeVisible();
});
for (const [width, height] of [
  [1920, 1080],
  [1280, 800],
  [800, 600],
  [390, 844],
])
  test(`visual and drawers ${width}x${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await fresh(page);
    if (width < 960) {
      await page.getByRole('button', { name: '打开图层面板' }).click();
      await expect(page.getByRole('dialog', { name: '场景和图层' })).toBeVisible();
      await page.getByRole('button', { name: '关闭图层面板' }).click();
      await expect(page.getByRole('button', { name: '打开图层面板' })).toBeFocused();
      await page.getByRole('button', { name: '打开属性面板' }).click();
      await expect(page.getByRole('dialog', { name: '属性面板' })).toBeVisible();
      await page.getByRole('button', { name: '关闭属性面板' }).click();
    }
    await page.screenshot({ path: info.outputPath(`empty-${width}.png`) });
    if (width < 960) await page.getByRole('button', { name: '打开图层面板' }).click();
    const data = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
      'base64',
    );
    // Use the same local synthetic long-design fixture for all viewport checks.
    if (width < 960) await page.getByRole('button', { name: '关闭图层面板' }).click();
    const source = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 804;
      c.height = 2230;
      const x = c.getContext('2d')!;
      x.fillStyle = '#f4f3ef';
      x.fillRect(0, 0, 804, 2230);
      x.fillStyle = '#254b37';
      x.fillRect(30, 30, 744, 310);
      x.fillStyle = '#f3f4e5';
      x.font = 'bold 50px sans-serif';
      x.fillText('探索民宿', 70, 140);
      x.font = '25px sans-serif';
      x.fillText('在山林之间，寻找安静', 70, 220);
      for (let y = 390; y < 2180; y += 340) {
        x.fillStyle = '#bfd0b7';
        x.fillRect(30, y, 350, 290);
        x.fillStyle = '#d6cbb9';
        x.fillRect(408, y, 366, 290);
      }
      return c.toDataURL().split(',')[1];
    });
    await page.getByLabel('选择导入图片').setInputFiles({
      name: '长设计图.png',
      mimeType: 'image/png',
      buffer: Buffer.from(source, 'base64'),
    });
    await expect(page.getByRole('button', { name: '已保存', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '适应画布 (0)', exact: true }).click();
    await page.screenshot({ path: info.outputPath(`editor-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(page.getByRole('button', { name: '导入图片', exact: true })).toBeVisible();
    if (width < 960) {
      await page.getByRole('button', { name: '打开属性面板' }).click();
      await page.screenshot({ path: info.outputPath(`drawer-${width}.png`) });
      await expect(page.getByLabel('图层名称')).toBeVisible();
    }
  });
