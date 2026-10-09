import { expect, test, type Page } from '@playwright/test';

/** Display and interaction checks against synthetic persisted records, never a real Agent run. */
async function openExecution(page: Page, step = 'ticket-implementation', extra = '') {
  await page.goto(`/?execution=${step}${extra}`);
  await expect(page.getByText('合成 UI 预览 · 示例内容不代表实际运行、检查通过或产品验收', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '执行', exact: true }).click();
  await page.evaluate(() => {
    const target = window as unknown as { executionCommands: unknown[] }; target.executionCommands = [];
    window.addEventListener('pi-kanban:synthetic-command', event => target.executionCommands.push((event as CustomEvent).detail));
  });
}
const commands = (page: Page) => page.evaluate(() => (window as unknown as { executionCommands: Record<string, unknown>[] }).executionCommands);

for (const width of [1024, 1440]) test(`execution ticket frontier remains readable and never auto-starts at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 1000 });
  await openExecution(page);
  await expect(page.getByRole('heading', { name: '按依赖实施任务 · TDD', exact: true })).toBeVisible();
  await expect(page.getByRole('tabpanel')).toContainText('当前可实施任务：synthetic-local-ticket-1');
  await expect(page.getByRole('tabpanel')).toContainText('等待前置任务：synthetic-local-ticket-1');
  await expect(page.getByRole('tabpanel')).toContainText('当前展示已保存的阶段；不表示执行正在运行');
  await expect(page.locator('.live-count')).toHaveCount(0);
  expect(await commands(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`synthetic-execution-frontier-${width}.png`), fullPage: true });
});

test('whole-spec axes preserve original K and open exact TDD and focused evidence without issuing decisions', async ({ page }, testInfo) => {
  await openExecution(page, 'resolution-spec');
  await page.getByText('TDD 与行为保持证据 · 2', { exact: true }).click();
  await page.getByRole('button', { name: '阅读失败测试证据', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.artifact-text')).toContainText('synthetic-red-test-1');
  await page.keyboard.press('Escape');
  const standards = page.getByRole('article', { name: '项目标准审查', exact: true }).first();
  await expect(standards).toContainText('原审查继续保留其内容版本');
  await standards.locator('.execution-review > summary').click();
  await expect(standards).toContainText('有文档依据的违规'); await expect(standards).toContainText('设计异味');
  await expect(standards).toContainText('synthetic-execution-K-original');
  await standards.locator('.execution-resolution > summary').click();
  await expect(standards).toContainText('synthetic-execution-K-current'); await expect(standards).toContainText('仍未解决');
  await standards.getByRole('button', { name: '阅读定向核验记录', exact: true }).click();
  await expect(dialog.locator('.artifact-text')).toContainText('synthetic-focused-resolution');
  await page.keyboard.press('Escape');
  expect(await commands(page)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('synthetic-execution-focused-review.png'), fullPage: true });
});

test('scope or seam findings lead to explicit decisions and keep design revision separate', async ({ page }) => {
  await openExecution(page, 'ticket-fix');
  await expect(page.locator('.execution-decision-notice')).toContainText('关闭发现不会授权设计变更');
  await page.getByRole('button', { name: '查看决定与限定修订', exact: true }).click();
  await expect(page.getByRole('tab', { name: '决定', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(await commands(page)).toEqual([]);
  await page.getByRole('button', { name: '记录此项决定', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('synthetic-execution-seam-decision');
  await expect(dialog.getByRole('button', { name: '记录此项决定', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByText('限定范围修订', { exact: true }).click();
  await page.getByRole('button', { name: '修订设计与测试', exact: true }).click();
  await expect(dialog).toContainText('保留有效需求确认');
  await dialog.getByLabel('设计与测试修订要求', { exact: true }).fill('合成：重新审阅已指出的 seam 变更。');
  await dialog.getByRole('button', { name: '提交限定范围修订', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('合成 UI 预览不执行');
  expect((await commands(page)).map(command => command.kind)).toEqual(['revise-planning']);
});

test('paused execution keeps read-only evidence available and repeated tab navigation sends no controls', async ({ page }) => {
  await openExecution(page, 'review-spec', '&executionState=paused');
  await expect(page.locator('.execution-runtime')).toContainText('当前已停止推进');
  await page.getByRole('tab', { name: '方案', exact: true }).click();
  await page.getByRole('tab', { name: '执行', exact: true }).click();
  await page.getByText('历史执行与审查 · 1', { exact: true }).click();
  await page.getByText('版本 2 · 整个 Spec · Spec 一致性审查', { exact: true }).click();
  const history = page.locator('.execution-history').filter({ has: page.getByText('历史执行与审查 · 1', { exact: true }) });
  await history.locator('.execution-review > summary').first().click();
  await history.getByRole('button', { name: '阅读完整审查依据', exact: true }).first().click();
  await expect(page.getByRole('dialog').locator('.artifact-text')).toContainText('synthetic-standards-review');
  await page.keyboard.press('Escape');
  await expect(page.locator('.execution-runtime')).toContainText('当前已停止推进');
  expect(await commands(page)).toEqual([]);
});
