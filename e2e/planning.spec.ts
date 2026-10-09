import { expect, test, type Page } from '@playwright/test';

/** Browser interaction fixtures are synthetic. These checks do not establish
 * real method invocation, model effects, independent review, or isolation. */
async function openPlanning(page: Page, step = 'awaiting-understanding-confirmation', extra = '') {
  await page.goto(`/?planning=${step}${extra}`);
  await expect(page.getByText('合成 UI 预览 · 示例内容不代表实际运行、检查通过或产品验收', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '方案', exact: true }).click();
  await page.evaluate(() => {
    const target = window as unknown as { planningCommands: unknown[] }; target.planningCommands = [];
    window.addEventListener('pi-kanban:synthetic-command', event => target.planningCommands.push((event as CustomEvent).detail));
  });
}
const commands = (page: Page) => page.evaluate(() => (window as unknown as { planningCommands: Record<string, unknown>[] }).planningCommands);

test.describe('Synthetic staged planning controls', () => {
  test('requirement consent is exact, initially unchecked and resistant to repeated submit', async ({ page }) => {
    await openPlanning(page, 'awaiting-understanding-confirmation', '&latency=200');
    await expect(page.locator('.phase-label')).toContainText('待确认需求与验收');
    await expect(page.getByRole('button', { name: '确认当前方案', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '确认需求与验收', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('synthetic-understanding');
    await expect(dialog).toContainText('合成：开始晚于结束时显示错误');
    await expect(dialog.getByRole('button', { name: '确认需求与验收', exact: true })).toBeDisabled();
    await dialog.getByRole('checkbox').check();
    await dialog.locator('form').evaluate(form => { (form as HTMLFormElement).requestSubmit(); (form as HTMLFormElement).requestSubmit(); });
    await expect(dialog.getByRole('button', { name: '正在保存…', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('alert')).toContainText('合成 UI 预览不执行');
    expect(await commands(page)).toHaveLength(1);
    expect((await commands(page))[0]).toMatchObject({ kind: 'confirm-understanding', expectedVersion: 12, flowId: 'synthetic-planning-flow', flowRevision: 7, understandingId: 'synthetic-understanding', digest: '2'.repeat(64) });
    expect((await commands(page))[0]).not.toHaveProperty('planId');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '确认需求与验收', exact: true }).click();
    await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  });

  test('final design consent shows independent findings, resolution and testing seams together', async ({ page }, testInfo) => {
    await openPlanning(page, 'awaiting-final-design-confirmation');
    await expect(page.locator('.planning-confirmations')).toContainText('需求与验收：此版本已确认');
    await expect(page.getByRole('button', { name: '确认需求与验收', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '确认最终设计与测试', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('synthetic-fresh-read-only-review-context');
    await expect(dialog).toContainText('合成：在导出服务入口验证空范围和相等边界');
    await expect(dialog).toContainText('已采纳');
    await expect(dialog).toContainText('合成：依据已确认行为补充相等边界场景与直接断言。');
    await expect(dialog.getByRole('button', { name: '确认最终设计与测试', exact: true })).toBeDisabled();
    await dialog.getByRole('checkbox').check();
    await page.screenshot({ path: testInfo.outputPath('synthetic-staged-final-design-consent.png'), fullPage: true });
    await dialog.getByRole('button', { name: '确认最终设计与测试', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('合成 UI 预览不执行');
    expect((await commands(page))[0]).toMatchObject({ kind: 'confirm-final-design', designId: 'synthetic-design', digest: 'b'.repeat(64), expectedVersion: 12, flowRevision: 7 });
    expect((await commands(page))[0]).not.toHaveProperty('localCommit');
    expect((await commands(page))[0]).not.toHaveProperty('configurationDigest');
  });

  test('questions only submit the chosen scope and exact question digest', async ({ page }) => {
    await openPlanning(page, 'design-resolution');
    await expect(page.getByRole('tabpanel')).toContainText('合成问题：相等边界是否保留为单点范围？');
    await expect(page.getByRole('button', { name: '确认最终设计与测试', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '回答此规划问题', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('此问题的答案与依据', { exact: true }).fill('合成答案：保留原有相等边界行为。');
    await dialog.getByRole('button', { name: '回答此规划问题', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('合成 UI 预览不执行');
    expect((await commands(page))[0]).toMatchObject({ kind: 'answer-planning-question', questionId: 'synthetic-design-question', questionDigest: '9'.repeat(64), answer: '合成答案：保留原有相等边界行为。' });
    expect((await commands(page))[0]).not.toHaveProperty('designId');
    expect((await commands(page))[0]).not.toHaveProperty('planId');
  });

  test('a newer planning stage invalidates an open checked consent without silently retargeting', async ({ page }) => {
    await openPlanning(page);
    await page.getByRole('button', { name: '确认需求与验收', exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.getByRole('checkbox').check();
    await page.evaluate(() => window.dispatchEvent(new Event('pi-kanban:synthetic-change-planning')));
    await expect(dialog.getByRole('alert')).toContainText('规划版本或阶段已变化');
    await expect(dialog.getByRole('button', { name: '确认需求与验收', exact: true })).toBeDisabled();
    expect(await commands(page)).toEqual([]);
  });

  test('paused decisions preserve the explicit resume boundary and runtime blockers do not erase decisions', async ({ page }) => {
    await openPlanning(page, 'awaiting-understanding-confirmation', '&planningState=paused');
    await expect(page.getByRole('tabpanel')).toContainText('保存决定不会恢复执行');
    await page.getByRole('button', { name: '确认需求与验收', exact: true }).click();
    const dialog = page.getByRole('dialog'); await expect(dialog).toContainText('保存决定后仍保持停止');
    await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: '确认需求与验收', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('合成 UI 预览不执行');
    expect((await commands(page)).map(command => command.kind)).toEqual(['confirm-understanding']);
    await openPlanning(page, 'awaiting-understanding-confirmation', '&planningState=blocked');
    await expect(page.getByRole('button', { name: '确认需求与验收', exact: true })).toBeEnabled();
    await expect(page.getByRole('tabpanel')).toContainText('仍需由 Host 核验继续条件');
  });

  for (const condition of ['offline', 'running', 'queued', 'stopping', 'unknown', 'cancelled']) {
    test(`${condition} prevents sending a new planning decision`, async ({ page }) => {
      await openPlanning(page, 'awaiting-understanding-confirmation', `&planningState=${condition}`);
      await expect(page.getByRole('button', { name: '确认需求与验收', exact: true })).toBeDisabled();
      expect(await commands(page)).toEqual([]);
    });
  }

  test('completed planning separates the local spec document, dependent tickets and implementation consent', async ({ page }, testInfo) => {
    await openPlanning(page, 'complete');
    await expect(page.getByRole('heading', { name: '规划完成', exact: true })).toBeVisible();
    await expect(page.getByRole('tabpanel')).toContainText('本地 Spec 文档');
    await expect(page.getByRole('tabpanel')).toContainText('此文档不是可执行任务');
    await expect(page.getByRole('tabpanel')).toContainText('前置任务：synthetic-local-ticket-1');
    await expect(page.getByRole('button', { name: '确认需求与验收', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '确认最终设计与测试', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '保存实施授权', exact: true })).toBeVisible();
    expect(await commands(page)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('synthetic-staged-complete.png'), fullPage: true });
  });

  test('scoped revisions preserve reusable decisions and expose earlier review evidence read-only', async ({ page }) => {
    await openPlanning(page, 'awaiting-final-design-confirmation', '&planningHistory=1');
    await page.getByText('限定范围修订', { exact: true }).click();
    await page.getByRole('button', { name: '修订设计与测试', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('保留有效需求确认');
    await dialog.getByLabel('设计与测试修订要求', { exact: true }).fill('合成：只调整验证位置。');
    await dialog.getByRole('button', { name: '提交限定范围修订', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('合成 UI 预览不执行');
    expect((await commands(page))[0]).toMatchObject({ kind: 'revise-planning', scope: 'design', text: '合成：只调整验证位置。' });
    await page.keyboard.press('Escape');
    await page.getByText('历史规划与审查 · 1', { exact: true }).click();
    await page.getByText('历史版本 3 · 规划完成', { exact: true }).click();
    await page.getByRole('button', { name: '阅读历史审查', exact: true }).click();
    await expect(dialog.locator('.artifact-text')).toContainText('synthetic-design-review-evidence');
    expect(await commands(page)).toHaveLength(1);
  });

  test('closing an in-flight planning consent keeps a newer form and draft intact', async ({ page }) => {
    await openPlanning(page, 'awaiting-understanding-confirmation', '&latency=1000');
    await page.getByRole('button', { name: '确认需求与验收', exact: true }).click();
    await page.getByRole('dialog').getByRole('checkbox').check();
    await page.getByRole('dialog').getByRole('button', { name: '确认需求与验收', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '新建需求', exact: true }).click();
    await page.getByRole('dialog').getByLabel('需求标题', { exact: true }).fill('新窗口保留的合成草稿');
    await expect(page.getByRole('button', { name: '确认需求与验收', exact: true }).first()).toBeEnabled();
    await expect(page.getByRole('dialog').getByLabel('需求标题', { exact: true })).toHaveValue('新窗口保留的合成草稿');
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0);
    expect(await commands(page)).toHaveLength(1);
  });
});
