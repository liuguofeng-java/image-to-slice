import { test, expect, type Page } from '@playwright/test';
import type { Project } from '../../src/types';
const backend = 'http://127.0.0.1:3003';
async function fixture(page: Page) {
  const p = (await (
    await page.request.post(backend + '/api/v1/projects', { data: { name: '画布回归' } })
  ).json()) as Project;
  await page.goto('/editor');
  await page.evaluate((id) => localStorage.setItem('slice-studio-project', id), p.id);
  await page.reload();
  await expect(page.getByRole('button', { name: '画布回归', exact: true })).toBeVisible();
  const data = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 200;
    const x = c.getContext('2d')!;
    x.fillStyle = '#dcba8a';
    x.fillRect(0, 0, 320, 200);
    return c.toDataURL().split(',')[1];
  });
  await page.getByLabel('选择导入图片').setInputFiles({
    name: 'sample.png',
    mimeType: 'image/png',
    buffer: Buffer.from(data, 'base64'),
  });
  await expect(page.getByLabel('图层名称')).toHaveValue('sample');
  await expect(page.getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  return p;
}
async function oneHundred(page: Page) {
  await page.getByLabel('画布缩放').click();
  await page.getByRole('menuitem', { name: '100%', exact: true }).click();
  await expect(page.getByLabel('画布缩放')).toHaveText('100%⌄');
}
test('canvas drag, eight-anchor resize, pan and zoom have correct history', async ({ page }) => {
  await fixture(page);
  await oneHundred(page);
  await page.mouse.move(640, 400);
  await page.mouse.down();
  await page.mouse.move(680, 420, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByLabel('X 位置')).toHaveValue('40.00');
  await expect(page.getByLabel('Y 位置')).toHaveValue('20.00');
  await page.getByRole('button', { name: '撤销 (Ctrl+Z)', exact: true }).click();
  await expect(page.getByLabel('X 位置')).toHaveValue('0.00');
  await page.mouse.move(800, 500);
  await page.mouse.down();
  await page.mouse.move(820, 510, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByLabel('图层宽度')).toHaveValue('340.00');
  await expect(page.getByLabel('图层高度')).toHaveValue('210.00');
  await page.getByRole('button', { name: '撤销 (Ctrl+Z)', exact: true }).click();
  await expect(page.getByLabel('图层宽度')).toHaveValue('320.00');
  await page.keyboard.press('Escape');
  await page.keyboard.down('Space');
  await page.mouse.move(600, 400);
  await page.mouse.down();
  await page.mouse.move(660, 450, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await page.mouse.wheel(0, -120);
  await expect(
    page.getByRole('button', { name: '重做 (Ctrl+Shift+Z)', exact: true }),
  ).toBeEnabled();
  await page.getByRole('option', { name: 'sample', exact: true }).click();
  await expect(page.getByLabel('X 位置')).toHaveValue('0.00');
});
test('rotated/flipped local ROI uses inverse source coordinates and stale source is rejected', async ({
  page,
}) => {
  await fixture(page);
  await page.getByLabel('旋转角度').fill('37');
  await page.getByLabel('旋转角度').press('Enter');
  await page.getByRole('button', { name: '水平翻转', exact: true }).click();
  await page.getByRole('button', { name: '适应画布 (0)', exact: true }).click();
  await oneHundred(page);
  await page
    .locator('.bottom-toolbar')
    .getByRole('button', { name: 'AI 框选拆图', exact: true })
    .click();
  const point = (x: number, y: number) => {
    const r = (37 * Math.PI) / 180,
      dx = -(x - 160),
      dy = y - 100;
    return {
      x: 640 + dx * Math.cos(r) - dy * Math.sin(r),
      y: 400 + dx * Math.sin(r) + dy * Math.cos(r),
    };
  };
  const a = point(80, 50),
    b = point(240, 150);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: '手动框选拆图', exact: true })).toBeEnabled();
  const request = page.waitForRequest(
    (r) => r.url().endsWith('/split-jobs') && r.method() === 'POST',
  );
  await page.getByRole('button', { name: '手动框选拆图', exact: true }).click();
  const region = (await request).postDataJSON().region;
  expect(region.x).toBeGreaterThanOrEqual(79);
  expect(region.x).toBeLessThanOrEqual(80);
  expect(region.y).toBeGreaterThanOrEqual(49);
  expect(region.width).toBeLessThanOrEqual(162);
  expect(region.height).toBeLessThanOrEqual(102);
  await expect(page.getByLabel('候选 1 名称')).toBeVisible();
  await page.getByRole('tab', { name: '设计', exact: true }).click();
  await page.getByLabel('X 位置').fill('90');
  await page.getByLabel('X 位置').press('Enter');
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  await expect(page.getByText('来源图片已修改或删除，请重新进入框选。')).toBeVisible();
  await expect(page.getByRole('button', { name: '创建 1 个图层', exact: true })).toHaveCount(0);
});
test('cancel ignores delayed poll; failure retry is explicit', async ({ page }) => {
  await fixture(page);
  await page
    .locator('.bottom-toolbar')
    .getByRole('button', { name: 'AI 框选拆图', exact: true })
    .click();
  await page.getByRole('button', { name: '选择整张图片' }).click();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route('**/api/v1/split-jobs/*', async (route) => {
    if (route.request().method() === 'GET') {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page.getByRole('button', { name: '开始 AI 分析', exact: true }).click();
  await page.getByRole('button', { name: '发送并分析', exact: true }).click();
  await page.getByRole('button', { name: '取消任务', exact: true }).click();
  release();
  await expect(page.getByRole('button', { name: '开始 AI 分析', exact: true })).toBeEnabled();
  await expect(page.getByLabel('候选 1 名称')).toHaveCount(0);
  await page.unroute('**/api/v1/split-jobs/*');
  await page.getByRole('button', { name: '开始 AI 分析', exact: true }).click();
  await page.getByRole('button', { name: '发送并分析', exact: true }).click();
  await expect(page.getByLabel('候选 1 名称')).toBeVisible();
});
test('scenes, visibility, reorder and multi-tab conflict', async ({ page }) => {
  const p = await fixture(page);
  await page.getByRole('button', { name: '复制', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(2);
  await page
    .getByRole('option', { name: 'sample 副本', exact: true })
    .dragTo(page.getByRole('option', { name: 'sample', exact: true }));
  await expect(page.getByRole('option').first()).toHaveText('sample');
  await page.getByRole('button', { name: '隐藏 sample', exact: true }).click();
  await expect(page.getByRole('button', { name: '显示 sample', exact: true })).toBeAttached();
  await page.getByRole('button', { name: '新建场景', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(0);
  await page.getByRole('button', { name: '▧ Page 1', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  const disk = (await (
    await page.request.get(backend + '/api/v1/projects/' + p.id)
  ).json()) as Project;
  await page.request.put(backend + '/api/v1/projects/' + p.id, {
    data: { revision: disk.revision, document: { ...disk, name: '来自另一个标签' } },
  });
  await page.getByRole('option', { name: 'sample 副本', exact: true }).click();
  await page.getByLabel('X 位置').fill('70');
  await page.getByLabel('X 位置').press('Enter');
  await expect(page.getByRole('button', { name: '保存失败', exact: true })).toBeVisible();
  await expect(page.getByText(/项目已被其他窗口修改/)).toBeVisible();
  await expect(page.getByLabel('X 位置')).toHaveValue('70.00');
  const after = (await (
    await page.request.get(backend + '/api/v1/projects/' + p.id)
  ).json()) as Project;
  expect(after.name).toBe('来自另一个标签');
  expect(after.scenes[0].layers.find((l) => l.name === 'sample 副本')?.x).toBe(20);
});
test('paste and drop import files through the same validated asset endpoint', async ({ page }) => {
  await fixture(page);
  for (const kind of ['paste', 'drop']) {
    const before = await page.getByRole('option').count();
    await page.evaluate(async (kind) => {
      const c = document.createElement('canvas');
      c.width = 80;
      c.height = 30;
      const x = c.getContext('2d')!;
      x.fillStyle = '#81bb41';
      x.fillRect(0, 0, 80, 30);
      const blob = await new Promise<Blob>((resolve) => c.toBlob((b) => resolve(b!), 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], kind + '.png', { type: 'image/png' }));
      if (kind === 'paste')
        document.body.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
        );
      else
        document
          .querySelector('main')!
          .dispatchEvent(
            new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
          );
    }, kind);
    await expect(page.getByRole('option')).toHaveCount(before + 1);
    await expect(page.getByLabel('图层名称')).toHaveValue(kind);
  }
});
