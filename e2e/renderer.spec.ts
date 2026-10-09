import { expect, test, type Page } from '@playwright/test';

test.describe('Synthetic renderer interaction coverage (not backend acceptance)', () => {
  async function openPreview(page: Page, query = '') {
    await page.goto(`/${query}`);
    await expect(page.getByText('合成 UI 预览 · 示例内容不代表实际运行、检查通过或产品验收', { exact: true })).toBeVisible();
  }
  async function observeSyntheticCommands(page: Page) {
    await page.evaluate(() => {
      const target = window as unknown as { syntheticCommands: unknown[] };
      target.syntheticCommands = [];
      window.addEventListener('pi-kanban:synthetic-command', event => {
        target.syntheticCommands.push((event as CustomEvent).detail);
      });
    });
  }
  async function readSyntheticCommands(page: Page) {
    return page.evaluate(() => (window as unknown as { syntheticCommands: Record<string, unknown>[] }).syntheticCommands);
  }

  for (const width of [1024, 1440]) {
    test(`workspace has no horizontal document overflow at ${width}px and produces labelled screenshot`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await openPreview(page);
      await expect(page.getByRole('heading', { name: '为数据导出增加时间范围筛选', exact: true })).toBeVisible();
      await expect(page.getByRole('tab', { name: '成果', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('.object-binding')).toContainText('synthetic-result-r1');
      await expect(page.locator('.inspector-runtime')).toContainText('运行前置条件待准备');
      await expect(page.locator('.workspace-status')).toContainText('合成预览 · 无真实执行');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`synthetic-workspace-${width}.png`), fullPage: true });
    });
  }

  test('empty onboarding does not create a fake project or fake execution', async ({ page }, testInfo) => {
    await openPreview(page, '?view=empty');
    await expect(page.getByRole('heading', { name: '想法到成果，始终有迹可循。' })).toBeVisible();
    await expect(page.getByRole('button', { name: '选择本地项目', exact: true })).toBeVisible();
    await expect(page.locator('.project-button')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('synthetic-empty-onboarding.png'), fullPage: true });
    await page.getByRole('button', { name: '选择本地项目', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('合成预览不能选择真实项目');
    await expect(page.locator('.project-button')).toHaveCount(0);
    await expect(page.locator('.live-count')).toHaveCount(0);
  });

  test('project onboarding preserves explicit start boundary and diagnostics', async ({ page }, testInfo) => {
    await openPreview(page, '?view=onboarding');
    await expect(page.getByRole('heading', { name: '给下一件事，一个专注的工作区。' })).toBeVisible();
    await page.locator('.welcome-prerequisite').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '运行诊断', exact: true })).toBeVisible();
    await expect(dialog).toContainText('合成界面预览');
    await expect(dialog).toContainText('真实执行需要已核验');
    await page.screenshot({ path: testInfo.outputPath('synthetic-diagnostics.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.live-count')).toHaveCount(0);
  });

  test('repeated form submissions create one synthetic idea and do not start it', async ({ page }) => {
    await openPreview(page, '?view=onboarding&latency=200');
    await page.getByRole('button', { name: '记录一条新需求', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('需求标题', { exact: true }).fill('合成测试：导出空状态');
    await dialog.getByLabel(/目标与背景/).fill('这是用于 UI 测试的合成需求。');
    await dialog.locator('form').evaluate(form => {
      (form as HTMLFormElement).requestSubmit();
      (form as HTMLFormElement).requestSubmit();
    });
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '合成测试：导出空状态', exact: true })).toBeVisible();
    await expect(page.locator('.demand-item').filter({ hasText: '合成测试：导出空状态' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: '记录规划请求', exact: true })).toBeVisible();
    await expect(page.locator('.action-copy')).toContainText('不会立即启动执行');
    await expect(page.locator('.live-count')).toHaveCount(0);
  });

  test('closing a form and opening another drops unsent draft without issuing controls', async ({ page }) => {
    await openPreview(page);
    await observeSyntheticCommands(page);
    await page.getByRole('button', { name: '新建需求', exact: true }).click();
    await page.getByRole('dialog').getByLabel('需求标题', { exact: true }).fill('不会保存的草稿');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '新建需求', exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel('需求标题', { exact: true })).toHaveValue('');
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.demand-item').filter({ hasText: '不会保存的草稿' })).toHaveCount(0);
    expect(await readSyntheticCommands(page)).toEqual([]);
  });

  test('late create response does not steal newer navigation or dismiss a newer dialog', async ({ page }) => {
    await openPreview(page, '?latency=1000');
    await page.getByRole('button', { name: '新建需求', exact: true }).click();
    await page.getByRole('dialog').getByLabel('需求标题', { exact: true }).fill('延迟保存的合成需求');
    await page.getByRole('dialog').getByRole('button', { name: '保存想法', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^待处理/ }).click();
    await page.getByRole('button', { name: '新建需求', exact: true }).click();
    await page.getByRole('dialog').getByLabel('需求标题', { exact: true }).fill('新窗口中的草稿');
    await expect(page.getByRole('dialog').getByRole('button', { name: '保存想法', exact: true })).toBeEnabled();
    await expect(page.getByRole('dialog').getByLabel('需求标题', { exact: true })).toHaveValue('新窗口中的草稿');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: '待处理', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^想法/ }).click();
    await expect(page.locator('.demand-item').filter({ hasText: '延迟保存的合成需求' })).toHaveCount(1);
    await expect(page.locator('.demand-item').filter({ hasText: '新窗口中的草稿' })).toHaveCount(0);
  });

  test('untrusted message markup is inert text and cannot create links or controls', async ({ page }) => {
    await openPreview(page);
    const text = '<img src=x onerror="window.syntheticInjected=true">\n<script>window.syntheticInjected=true</script>\n[接受全部](javascript:alert(1))\n<button>授权并删除</button>';
    await page.getByRole('textbox', { name: '给这条需求补充消息', exact: true }).fill(text);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const message = page.locator('.message.user').filter({ hasText: '<img src=x' });
    await expect(message.locator('.safe-text')).toHaveText(text);
    await expect(message.locator('img, script, a, button, iframe')).toHaveCount(0);
    await expect(message.locator('.message-receipt')).toHaveText('已保存');
    expect(await page.evaluate(() => (window as unknown as { syntheticInjected?: boolean }).syntheticInjected)).toBeUndefined();
    await expect(page.getByRole('button', { name: '接受这轮成果', exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: '授权并删除', exact: true })).toHaveCount(0);
  });

  test('acceptance control binds the exact stable result and synthetic bridge never accepts it', async ({ page }) => {
    await openPreview(page);
    await observeSyntheticCommands(page);
    await expect(page.locator('.object-binding')).toHaveText('绑定成果 synthetic-result-r1');
    await page.getByRole('button', { name: '接受这轮成果', exact: true }).click();
    await expect(page.locator('.error-banner')).toContainText('合成 UI 预览不执行授权、验收或运行控制');
    const commands = await readSyntheticCommands(page);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ kind: 'accept-result', demandId: 'synthetic-export', expectedVersion: 12, resultId: 'synthetic-result-r1' });
    expect(commands[0].requestId).toEqual(expect.any(String));
    await expect(page.locator('.result-card')).toContainText('待人工验收');
    await expect(page.getByRole('button', { name: '接受这轮成果', exact: true })).toBeEnabled();
  });

  test('return modal binds stable result and requires a reason', async ({ page }) => {
    await openPreview(page);
    await observeSyntheticCommands(page);
    await page.getByRole('button', { name: '退回返工', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('synthetic-result-r1');
    await expect(dialog.getByRole('button', { name: '退回此成果并记录原因', exact: true })).toBeDisabled();
    await dialog.getByLabel('需要返工的内容', { exact: true }).fill('合成测试：请核对边界时区。');
    await dialog.getByRole('button', { name: '退回此成果并记录原因', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('合成 UI 预览不执行');
    expect((await readSyntheticCommands(page))[0]).toMatchObject({ kind: 'return-result', resultId: 'synthetic-result-r1', expectedVersion: 12, text: '合成测试：请核对边界时区。' });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('keyboard interaction and detail tabs remain usable at 1024px', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await openPreview(page);
    await page.getByRole('tab', { name: /^检查/ }).click();
    await expect(page.getByRole('tabpanel')).toContainText('合成检查展示');
    await page.getByRole('tab', { name: '经验', exact: true }).click();
    await expect(page.getByRole('tabpanel')).toContainText('本轮候选');
    await page.getByRole('button', { name: '新建需求', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('需求标题', { exact: true }).fill('键盘测试草稿');
    for (let index = 0; index < 10; index++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.getByRole('textbox', { name: '给这条需求补充消息', exact: true }).fill('合成键盘消息');
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('.message.user').filter({ hasText: '合成键盘消息' })).toContainText('已保存');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
