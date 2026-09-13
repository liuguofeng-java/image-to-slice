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
  await expect(page.getByRole('button', { name: /画布回归/ })).toBeVisible();
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
  await expect(page.getByLabel('画布缩放')).toContainText('100%');
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
  await page.getByRole('treeitem', { name: 'sample', exact: true }).click();
  await expect(page.getByLabel('X 位置')).toHaveValue('0.00');
  const xInput = page.getByLabel('X 位置'),
    box = await xInput.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 40, box!.y + box!.height / 2, { steps: 5 });
  await expect(xInput).toHaveValue('10.00');
  expect(await page.evaluate(() => !!document.pointerLockElement)).toBe(true);
  // 指针尚未松开时，真实项目状态已经变化并触发画布更新/自动保存，而非仅预览输入值。
  expect(await page.locator('.save-button').textContent()).not.toContain('已保存');
  await page.mouse.up();
  await page.getByRole('button', { name: '撤销 (Ctrl+Z)', exact: true }).click();
  await expect(xInput).toHaveValue('0.00');
});
test('middle mouse pans from an object without moving or selecting it', async ({ page }) => {
  await fixture(page);
  await oneHundred(page);
  const zeroTick = page
      .locator('.ruler-top > span:not(.selection-ruler-marker)')
      .filter({ hasText: /^0$/ }),
    before = await zeroTick.boundingBox();
  await page.mouse.move(640, 400);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(700, 440, { steps: 5 });
  await page.mouse.up({ button: 'middle' });
  const after = await zeroTick.boundingBox();
  expect(after!.x - before!.x).toBeGreaterThan(50);
  await expect(page.getByLabel('X 位置')).toHaveValue('0.00');
  await expect(page.getByLabel('Y 位置')).toHaveValue('0.00');
});
test('text tool creates editable text with one-step history and persists its properties', async ({
  page,
}, info) => {
  const project = await fixture(page);
  await oneHundred(page);
  await page.getByRole('button', { name: '文本 (T)', exact: true }).click();
  await page.getByTestId('canvas').click({ position: { x: 600, y: 360 } });
  const blankEditor = page.getByLabel('编辑画布文字');
  await expect(blankEditor).toBeFocused();
  await blankEditor.fill('   ');
  await blankEditor.press('Escape');
  await expect(page.getByRole('treeitem')).toHaveCount(1);
  await page.getByTestId('canvas').click({ position: { x: 530, y: 330 } });
  const editor = page.getByLabel('编辑画布文字');
  await expect(editor).toBeFocused();
  await editor.fill('开始游戏');
  await editor.press('Control+Enter');
  const textItem = page.getByRole('treeitem', { name: '开始游戏', exact: true });
  await expect(textItem).toHaveAttribute('aria-level', '2');

  await page.getByRole('button', { name: '撤销 (Ctrl+Z)', exact: true }).click();
  await expect(page.getByRole('treeitem')).toHaveCount(1);
  await page.getByRole('button', { name: '重做 (Ctrl+Shift+Z)', exact: true }).click();
  await expect(textItem).toBeVisible();

  await page.getByRole('button', { name: '选择 (V)', exact: true }).click();
  await page.getByTestId('canvas').dblclick({ position: { x: 530, y: 330 } });
  await expect(editor).toHaveValue('开始游戏');
  await editor.fill('背包\n物品');
  await page.screenshot({ path: info.outputPath('text-editing-1280.png') });
  await editor.press('Escape');
  await expect(page.getByRole('treeitem', { name: '背包', exact: true })).toBeVisible();
  await page.getByLabel('字号').fill('30');
  await page.getByLabel('字号').press('Enter');
  await page.getByRole('combobox', { name: '字重', exact: true }).press('ArrowDown');
  await page.getByRole('option', { name: '700', exact: true }).click();
  await page.getByRole('combobox', { name: '文本框模式', exact: true }).press('ArrowDown');
  await page.getByRole('option', { name: '固定尺寸', exact: true }).click();
  await page.getByLabel('文字内容').fill('背包物品');
  await page.getByLabel('文字内容').blur();
  await expect(page.getByRole('treeitem', { name: '背包物品', exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const current = (await (
        await page.request.get(`${backend}/api/v1/projects/${project.id}`)
      ).json()) as Project;
      const layer = current.scenes[0].layers.find((item) => item.type === 'text');
      return layer?.type === 'text' ? layer.content : '';
    })
    .toBe('背包物品');

  await page.reload();
  await page.getByRole('treeitem', { name: '背包物品', exact: true }).click();
  await expect(page.getByLabel('文字内容')).toHaveValue('背包物品');
  await expect(page.getByLabel('字号')).toHaveValue('30.0');
  const saved = (await (
    await page.request.get(`${backend}/api/v1/projects/${project.id}`)
  ).json()) as Project;
  const text = saved.scenes[0].layers.find((layer) => layer.type === 'text');
  expect(text?.type).toBe('text');
  if (text?.type === 'text') {
    expect(text.fontWeight).toBe(700);
    expect(text.resizeMode).toBe('fixed');
  }
});
test('nested child stays directly draggable and parent drag moves its complete subtree', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('button', { name: '复制', exact: true }).click();
  await page.getByLabel('图层宽度').fill('50');
  await page.getByLabel('图层宽度').press('Enter');
  await expect(page.getByRole('treeitem', { name: 'sample 副本', exact: true })).toHaveAttribute(
    'aria-level',
    '2',
  );
  const child = page.getByRole('treeitem', { name: 'sample 副本', exact: true }),
    parent = page.getByRole('treeitem', { name: 'sample', exact: true });
  // 即使把父层放到原始数组上方，更深的子层仍应优先命中并可独立拖动。
  await child.dragTo(parent);
  await oneHundred(page);
  await page.getByTestId('canvas').click({ position: { x: 800, y: 650 } });
  await page.getByTestId('canvas').click({ position: { x: 525, y: 330 } });
  await expect(child).toHaveAttribute('aria-selected', 'true');
  await page.mouse.move(525, 330);
  await page.mouse.down();
  await page.mouse.move(535, 340, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByLabel('X 位置')).toHaveValue('30.00');
  await expect(page.getByLabel('Y 位置')).toHaveValue('30.00');
  await page.getByRole('button', { name: '撤销 (Ctrl+Z)', exact: true }).click();
  await expect(page.getByLabel('X 位置')).toHaveValue('20.00');
  await expect(page.getByLabel('Y 位置')).toHaveValue('20.00');

  // 通过父节点的 X 数值框移动时，子节点也应保持相对位置并随之更新。
  await parent.click();
  const parentX = page.getByLabel('X 位置'),
    parentXBox = await parentX.boundingBox();
  await page.mouse.move(
    parentXBox!.x + parentXBox!.width / 2,
    parentXBox!.y + parentXBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    parentXBox!.x + parentXBox!.width / 2 + 40,
    parentXBox!.y + parentXBox!.height / 2,
    { steps: 5 },
  );
  await expect(parentX).toHaveValue('10.00');
  await page.mouse.up();
  await child.click();
  await expect(page.getByLabel('X 位置')).toHaveValue('30.00');
  await page.getByRole('button', { name: '撤销 (Ctrl+Z)', exact: true }).click();
  await expect(page.getByLabel('X 位置')).toHaveValue('20.00');

  await page.getByRole('button', { name: '隐藏图层', exact: true }).click();
  await page.getByRole('button', { name: '锁定图层', exact: true }).click();
  await parent.click();

  await page.mouse.move(640, 400);
  await page.mouse.down();
  await page.mouse.move(680, 420, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByLabel('X 位置')).toHaveValue('40.00');
  await expect(page.getByLabel('Y 位置')).toHaveValue('20.00');

  await child.click();
  await expect(page.getByLabel('X 位置')).toHaveValue('60.00');
  await expect(page.getByLabel('Y 位置')).toHaveValue('40.00');
  await page.getByRole('button', { name: '撤销 (Ctrl+Z)', exact: true }).click();
  await expect(page.getByLabel('X 位置')).toHaveValue('20.00');
  await expect(page.getByLabel('Y 位置')).toHaveValue('20.00');
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
  await expect(page.getByRole('button', { name: /生成并创建 1 个图层/ })).toHaveCount(0);
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
  await expect(page.getByRole('treeitem')).toHaveCount(2);
  await page
    .getByRole('treeitem', { name: 'sample 副本', exact: true })
    .dragTo(page.getByRole('treeitem', { name: 'sample', exact: true }));
  await expect(page.getByRole('treeitem').first()).toHaveText('sample');
  await page.getByRole('button', { name: '隐藏 sample', exact: true }).click();
  await expect(page.getByRole('button', { name: '显示 sample', exact: true })).toBeAttached();
  await page.getByRole('button', { name: '新建场景', exact: true }).click();
  await expect(page.getByRole('treeitem')).toHaveCount(0);
  await page.getByRole('button', { name: '▧ Page 1', exact: true }).click();
  await expect(page.getByRole('treeitem')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  const disk = (await (
    await page.request.get(backend + '/api/v1/projects/' + p.id)
  ).json()) as Project;
  await page.request.put(backend + '/api/v1/projects/' + p.id, {
    data: { revision: disk.revision, document: { ...disk, name: '来自另一个标签' } },
  });
  await page.getByRole('treeitem', { name: 'sample 副本', exact: true }).click();
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
    const before = await page.getByRole('treeitem').count();
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
    await expect(page.getByRole('treeitem')).toHaveCount(before + 1);
    await expect(page.getByLabel('图层名称')).toHaveValue(kind);
  }
});
