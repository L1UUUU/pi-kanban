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

  test('configuration import shows source hashes and bounded scope without authorizing or enabling runtime', async ({ page }, testInfo) => {
    await openPreview(page);
    await observeSyntheticCommands(page);
    await page.locator('.runtime-button').click();
    const dialog = page.getByRole('dialog');
    const support = dialog.getByRole('region', { name: '首版运行支持范围', exact: true });
    await expect(support).toContainText('Node 原生受控工具');
    await expect(support).toContainText('Node 测试须显式使用 --test-isolation=none 进程内模式');
    await expect(support).toContainText('测试、依赖与 JavaScript CLI 不得新建子进程管道或 IPC 命名管道');
    await expect(support).toContainText('默认进程隔离的 Node 测试不受支持');
    await expect(support).toContainText('不支持 Bash / POSIX shell、shell 脚本及依赖 shell 的 CLI');
    await expect(support).toContainText('Windows 目标机的隔离、文件系统、进程树与网络证据仍须由 Host 核验');
    await expect(support).toContainText('导入成功不代表执行已启用');
    await expect(dialog.getByRole('button', { name: '审阅模型与资源授权', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: '导入运行配置', exact: true }).click();
    await expect(dialog).toContainText('已载入配置 · 版本 1');
    await expect(dialog.getByRole('button', { name: '审阅模型与资源授权', exact: true })).toBeEnabled();
    await dialog.locator('.configuration-method').first().locator('summary').click();
    await expect(dialog).toContainText('/synthetic/methods/planning.md');
    await expect(dialog).toContainText('a'.repeat(64));
    await expect(dialog).toContainText('synthetic-provider');
    await expect(dialog).toContainText('https://synthetic-model.example.invalid/v1/responses');
    await expect(dialog).toContainText('synthetic-demand-brief');
    await expect(dialog).toContainText('USD 1.250000');
    await expect(dialog).toContainText('2099-01-01T00:00:00.000Z');
    await expect(dialog.locator('.diagnostics-summary')).toContainText('自主执行尚未启用');
    expect(await readSyntheticCommands(page)).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('synthetic-runtime-configuration.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.live-count')).toHaveCount(0);
  });

  test('Node-only imported metadata still requires target Windows evidence and never enables the synthetic runtime', async ({ page }) => {
    await openPreview(page, '?runtime=node');
    await observeSyntheticCommands(page);
    await page.locator('.runtime-button').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '导入运行配置', exact: true }).click();
    await expect(dialog).toContainText('synthetic-node-runtime');
    const support = dialog.getByRole('region', { name: '首版运行支持范围', exact: true });
    await expect(support).toContainText('运行配置中的 shell 必须为空');
    await expect(support.getByRole('alert')).toHaveCount(0);
    await expect(dialog).toContainText('合成样例未验证原生隔离、受控进程与真实模型通道');
    await expect(dialog.locator('.diagnostics-summary')).toContainText('自主执行尚未启用');
    await expect(dialog.getByText('当前运行组合已启用', { exact: true })).toHaveCount(0);
    expect(await readSyntheticCommands(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.locator('.inspector-runtime')).toContainText('运行前置条件待准备');
  });

  test('legacy shell import stays visibly unsupported through repeated import and reopening diagnostics', async ({ page }, testInfo) => {
    await openPreview(page, '?runtime=unsupported-shell');
    await observeSyntheticCommands(page);
    await page.locator('.runtime-button').click();
    const dialog = page.getByRole('dialog');
    for (let attempt = 0; attempt < 2; attempt++) {
      await dialog.getByRole('button', { name: '导入运行配置', exact: true }).click();
      await expect(dialog).toContainText('已载入配置 · 版本 1');
      const warning = dialog.getByRole('region', { name: '首版运行支持范围', exact: true }).getByRole('alert');
      await expect(warning).toContainText('已导入不受支持的 shell，执行受阻');
      await expect(warning).toContainText('git-bash · /synthetic/legacy/bin/bash.exe');
      await expect(warning).toContainText('shell 设为 null 或省略，再重新导入');
      await expect(dialog).toContainText('合成诊断：首版 Node 运行组合不支持 shell');
      await expect(dialog.locator('.diagnostics-summary')).toContainText('自主执行尚未启用');
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('.inspector-runtime')).toContainText('运行前置条件待准备');
    await page.locator('.runtime-button').click();
    await expect(dialog.getByRole('alert')).toContainText('已导入不受支持的 shell，执行受阻');
    await expect(dialog.getByText('当前运行组合已启用', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('synthetic-unsupported-shell-diagnostics.png'), fullPage: true });
    expect(await readSyntheticCommands(page)).toEqual([]);
    await expect(page.locator('.live-count')).toHaveCount(0);
  });

  test('model approval requires review, explicit consent and exact captured binding; preview denies actual grant', async ({ page }, testInfo) => {
    await openPreview(page, '?latency=200');
    await observeSyntheticCommands(page);
    await page.locator('.runtime-button').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '导入运行配置', exact: true }).click();
    await dialog.getByRole('button', { name: '审阅模型与资源授权', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: '确认有限模型与资源授权', exact: true })).toBeVisible();
    await expect(dialog).toContainText('synthetic-export · v12');
    await expect(dialog).toContainText('b'.repeat(64));
    await expect(dialog).toContainText('host:synthetic-only');
    await expect(dialog.getByRole('region', { name: '本需求的本地资源访问范围' })).toContainText('/synthetic/worktrees/export-date-range');
    await expect(dialog.getByRole('region', { name: '本需求的本地资源访问范围' })).toContainText('demand-worktree-private-runtime-v1');
    await expect(dialog.getByRole('region', { name: '本需求的本地资源访问范围' })).toContainText('共享 .git 管理目录、Host 数据库、其他需求');
    await expect(dialog.getByRole('region', { name: '本需求的本地资源访问范围' })).toContainText('只读访问此需求的工作区');
    await expect(dialog).toContainText('synthetic-method-material');
    await expect(dialog.locator('.configuration-context-scope')).toContainText('仅精确资料清单');
    await expect(dialog.locator('.configuration-context-scope')).toContainText('生成的对话、工具结果及其他新增资料不在本次授权内');
    await expect(dialog.getByRole('button', { name: '确认此范围与额度', exact: true })).toBeDisabled();
    expect(await readSyntheticCommands(page)).toEqual([]);
    await dialog.getByRole('checkbox').check();
    await dialog.evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath('synthetic-model-authorization-review.png'), fullPage: true });
    await dialog.getByRole('button', { name: '确认此范围与额度', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await expect(dialog.getByRole('alert')).toContainText('不会创建真实模型授权');
    const commands = await readSyntheticCommands(page);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ kind: 'authorize-model', demandId: 'synthetic-export', expectedVersion: 12, configurationDigest: 'b'.repeat(64), resourceScope: 'demand-worktree-private-runtime-v1', requestId: expect.any(String) });
    await dialog.getByRole('button', { name: '返回运行诊断', exact: true }).click();
    await dialog.getByRole('button', { name: '审阅模型与资源授权', exact: true }).click();
    await expect(dialog.getByRole('checkbox')).not.toBeChecked();
    await expect(dialog.getByRole('button', { name: '确认此范围与额度', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(await readSyntheticCommands(page)).toHaveLength(1);
    await expect(page.locator('.live-count')).toHaveCount(0);
  });

  test('configuration without selected demand cannot grant a model budget', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await openPreview(page, '?view=onboarding');
    await observeSyntheticCommands(page);
    await page.locator('.runtime-button').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '导入运行配置', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '审阅模型与资源授权', exact: true })).toBeDisabled();
    await expect(dialog).toContainText('请先在工作区选择需要授权的需求');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await readSyntheticCommands(page)).toEqual([]);
  });

  test('derived-context scope is explicitly displayed before consent and does not grant on view', async ({ page }) => {
    await openPreview(page, '?contextPolicy=derived');
    await observeSyntheticCommands(page);
    await page.locator('.runtime-button').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '导入运行配置', exact: true }).click();
    await dialog.getByRole('button', { name: '审阅模型与资源授权', exact: true }).click();
    await expect(dialog.locator('.configuration-context-scope')).toContainText('精确资料 + 同一受控运行内的派生上下文');
    await expect(dialog.locator('.configuration-context-scope')).toContainText('同一已核验隔离运行内生成的对话与工具结果');
    await expect(dialog.locator('.configuration-context-scope')).toContainText('不得据此读取任意新来源、其他项目或其他需求');
    await expect(dialog.getByRole('checkbox')).not.toBeChecked();
    await expect(dialog.getByRole('button', { name: '确认此范围与额度', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    expect(await readSyntheticCommands(page)).toEqual([]);
  });

  test('unprepared workspace scope is disclosed and consent remains explicit', async ({ page }) => {
    await openPreview(page);
    await observeSyntheticCommands(page);
    await page.locator('.demand-item').filter({ hasText: '让空状态更有帮助' }).click();
    await page.locator('.runtime-button').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '导入运行配置', exact: true }).click();
    await dialog.getByRole('button', { name: '审阅模型与资源授权', exact: true }).click();
    const scope = dialog.getByRole('region', { name: '本需求的本地资源访问范围' });
    await expect(scope).toContainText('为此需求准备的独立工作区');
    await expect(scope).toContainText('尚未准备工作区时不执行');
    await expect(scope).toContainText('固定运行依赖');
    await expect(scope).toContainText('私有 scratch / session 目录');
    await expect(scope).toContainText('不包含全磁盘访问或通用系统设置权限');
    await expect(dialog.getByRole('checkbox')).not.toBeChecked();
    await expect(dialog.getByRole('button', { name: '确认此范围与额度', exact: true })).toBeDisabled();
    expect(await readSyntheticCommands(page)).toEqual([]);
  });

  test('preparation failure stays in diagnostics with no misleading consent or grant', async ({ page }) => {
    await openPreview(page, '?prepare=blocked');
    await observeSyntheticCommands(page);
    await page.locator('.runtime-button').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '导入运行配置', exact: true }).click();
    await dialog.getByRole('button', { name: '审阅模型与资源授权', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('缺少此需求的已准备工作区或冻结方法');
    await expect(dialog.getByRole('heading', { name: '运行诊断', exact: true })).toBeVisible();
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    expect(await readSyntheticCommands(page)).toEqual([]);
  });

  test('consent uses exact newly prepared material list and fresh configuration digest', async ({ page }) => {
    await openPreview(page, '?prepare=changed');
    await observeSyntheticCommands(page);
    await page.locator('.runtime-button').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '导入运行配置', exact: true }).click();
    await dialog.getByRole('button', { name: '审阅模型与资源授权', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: '确认有限模型与资源授权', exact: true })).toBeVisible();
    await expect(dialog).toContainText('synthetic-prepared-exact-source');
    await expect(dialog).toContainText('d'.repeat(64));
    await expect(dialog).not.toContainText('synthetic-demand-brief');
    expect(await readSyntheticCommands(page)).toEqual([]);
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: '确认此范围与额度', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('不会创建真实模型授权');
    expect((await readSyntheticCommands(page))[0]).toMatchObject({ configurationDigest: 'd'.repeat(64), expectedVersion: 12 });
  });

  test('late preparation cannot reopen consent over a newer dialog or navigation', async ({ page }) => {
    await openPreview(page, '?latency=1000');
    await observeSyntheticCommands(page);
    await page.evaluate(() => {
      const target = window as unknown as { syntheticPreparationCount: number };
      target.syntheticPreparationCount = 0;
      window.addEventListener('pi-kanban:synthetic-prepared', () => { target.syntheticPreparationCount += 1; });
    });
    await page.locator('.runtime-button').click();
    await page.getByRole('dialog').getByRole('button', { name: '导入运行配置', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '审阅模型与资源授权', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^待处理/ }).click();
    await page.getByRole('button', { name: '新建需求', exact: true }).click();
    await page.getByRole('dialog').getByLabel('需求标题', { exact: true }).fill('保留此新草稿');
    await expect.poll(() => page.evaluate(() => (window as unknown as { syntheticPreparationCount: number }).syntheticPreparationCount)).toBe(1);
    await expect(page.getByRole('dialog').getByRole('heading', { name: '记录一条新需求', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByLabel('需求标题', { exact: true })).toHaveValue('保留此新草稿');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: '待处理', exact: true })).toBeVisible();
    expect(await readSyntheticCommands(page)).toEqual([]);
  });
  test('unresolved planner answers use explicit exact-plan revision, never resume or implicit authority', async ({ page }) => {
    await openPreview(page, '?decisions=plan&latency=200'); await observeSyntheticCommands(page);
    await page.getByRole('button', { name: '方案与决定', exact: true }).click();
    await expect(page.getByRole('tabpanel')).toContainText('合成问题：日期边界使用哪个时区？');
    await page.getByRole('button', { name: '修订当前方案', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('synthetic-unresolved-plan');
    await expect(dialog).toContainText('撤销该方案的确认和实施授权');
    await expect(dialog.getByRole('button', { name: '修订当前方案', exact: true })).toBeDisabled();
    await dialog.getByLabel('问题答案与修订要求', { exact: true }).fill('合成答案：使用 UTC，重新规划。');
    await dialog.locator('form').evaluate(form => { (form as HTMLFormElement).requestSubmit(); (form as HTMLFormElement).requestSubmit(); });
    await expect(dialog.getByRole('alert')).toContainText('合成 UI 预览不执行');
    const commands = await readSyntheticCommands(page); expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ kind: 'revise-plan', previousPlanId: 'synthetic-unresolved-plan', expectedVersion: 12, text: '合成答案：使用 UTC，重新规划。' });
    expect(commands[0]).not.toHaveProperty('confirmDesign'); expect(commands[0]).not.toHaveProperty('localCommit');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '修订当前方案', exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel('问题答案与修订要求', { exact: true })).toHaveValue('');
  });

  test('decision finding action targets current immutable finding only and generic resolution cannot bypass it', async ({ page }, testInfo) => {
    await openPreview(page, '?decisions=finding'); await observeSyntheticCommands(page);
    await page.getByRole('tab', { name: '决定', exact: true }).click();
    await expect(page.getByRole('button', { name: '记录此项决定', exact: true })).toHaveCount(1);
    await expect(page.getByRole('region', { name: '发现 synthetic-blocking-f2', exact: true }).getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('region', { name: '发现 synthetic-historical-f3', exact: true })).toContainText('历史内容');
    await expect(page.getByRole('button', { name: '核对并解除阻塞', exact: true })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('synthetic-current-review-decisions.png'), fullPage: true });
    await page.getByRole('button', { name: '记录此项决定', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('synthetic-decision-f1'); await expect(dialog).toContainText('synthetic-current-content');
    await dialog.getByLabel('决定与理由', { exact: true }).fill('合成决定：维持明确的 UTC 时间语义。');
    await dialog.getByRole('button', { name: '记录此项决定', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('合成 UI 预览不执行');
    expect((await readSyntheticCommands(page))[0]).toMatchObject({ kind: 'decide-finding', findingId: 'synthetic-decision-f1', contentId: 'synthetic-current-content', expectedVersion: 12 });
  });

  test('blocker resolution requires evidence and a stale open form cannot target newer state', async ({ page }) => {
    await openPreview(page, '?decisions=blocker'); await observeSyntheticCommands(page);
    await page.getByRole('tab', { name: '决定', exact: true }).click();
    await page.getByRole('button', { name: '核对并解除阻塞', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('不会关闭 Review 发现');
    await dialog.getByLabel('阻塞处理情况与证据', { exact: true }).fill('合成证据：环境现已可用。');
    await page.evaluate(() => window.dispatchEvent(new Event('pi-kanban:synthetic-change-version')));
    await expect(dialog.getByRole('alert')).toContainText('对象版本已变化');
    await expect(dialog.getByRole('button', { name: '核对并解除阻塞', exact: true })).toBeDisabled();
    expect(await readSyntheticCommands(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '核对并解除阻塞', exact: true }).click();
    await expect(dialog.getByLabel('阻塞处理情况与证据', { exact: true })).toHaveValue('');
    await dialog.getByLabel('阻塞处理情况与证据', { exact: true }).fill('已重新核对全部阻塞。');
    await dialog.getByRole('button', { name: '核对并解除阻塞', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('合成 UI 预览不执行');
    expect((await readSyntheticCommands(page))[0]).toMatchObject({ kind: 'resolve-blocker', expectedVersion: 13, text: '已重新核对全部阻塞。' });
  });

  test('method switch requires exact source review and resets consent on stage change or dismiss', async ({ page }) => {
    await openPreview(page, '?decisions=method'); await observeSyntheticCommands(page);
    await page.getByRole('tab', { name: '决定', exact: true }).click();
    await page.getByRole('button', { name: '切换冻结方法', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: '切换冻结方法', exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('切换阶段', { exact: true })).toHaveAccessibleName('切换阶段');
    await dialog.getByLabel('切换阶段', { exact: true }).selectOption('planning');
    await expect(dialog).toContainText('synthetic-old-planning');
    await expect(dialog).toContainText('a'.repeat(64));
    await dialog.getByLabel('切换原因与影响', { exact: true }).fill('合成说明：使用已核验的规划方法。');
    await dialog.getByRole('checkbox').check();
    await dialog.getByLabel('切换阶段', { exact: true }).selectOption('review');
    await expect(dialog.getByRole('checkbox')).not.toBeChecked();
    await dialog.getByLabel('切换阶段', { exact: true }).selectOption('planning');
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: '切换冻结方法', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('合成 UI 预览不执行');
    expect((await readSyntheticCommands(page))[0]).toMatchObject({ kind: 'switch-method', stage: 'planning', methodId: 'synthetic-planning', methodVersion: 'synthetic-v1', methodDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64), impactReviewed: true, expectedVersion: 12 });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '切换冻结方法', exact: true }).click();
    await expect(dialog.getByRole('checkbox')).not.toBeChecked();
    await dialog.getByLabel('切换阶段', { exact: true }).selectOption('planning');
    await dialog.getByLabel('切换原因与影响', { exact: true }).fill('再次核对');
    await dialog.getByRole('checkbox').check();
    await page.evaluate(() => window.dispatchEvent(new Event('pi-kanban:synthetic-change-configuration')));
    await expect(dialog.getByRole('alert')).toContainText('配置版本已变化');
    await expect(dialog.getByRole('button', { name: '切换冻结方法', exact: true })).toBeDisabled();
    expect(await readSyntheticCommands(page)).toHaveLength(1);
  });

  test('late decision rejection cannot contaminate a newer form after dismissal', async ({ page }) => {
    await openPreview(page, '?decisions=plan&latency=1000'); await observeSyntheticCommands(page);
    await page.getByRole('tab', { name: '决定', exact: true }).click();
    await page.getByRole('button', { name: '修订当前方案', exact: true }).click();
    await page.getByRole('dialog').getByLabel('问题答案与修订要求', { exact: true }).fill('合成：提交旧窗口决定。');
    await page.getByRole('dialog').getByRole('button', { name: '修订当前方案', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '新建需求', exact: true }).click();
    await page.getByRole('dialog').getByLabel('需求标题', { exact: true }).fill('保留新窗口草稿');
    await expect(page.getByRole('button', { name: '修订当前方案', exact: true }).first()).toBeEnabled();
    await expect(page.getByRole('dialog').getByRole('heading', { name: '记录一条新需求', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByLabel('需求标题', { exact: true })).toHaveValue('保留新窗口草稿');
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0);
    expect(await readSyntheticCommands(page)).toHaveLength(1);
  });

  test('implementation consent keeps local commits optional, exact-plan-bound and separate from design', async ({ page }) => {
    await openPreview(page); await observeSyntheticCommands(page);
    await page.locator('.demand-item').filter({ hasText: '梳理审计日志的查询体验' }).click();
    await page.getByRole('button', { name: '保存实施授权', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('synthetic-audit-plan');
    await expect(dialog.getByRole('checkbox')).not.toBeChecked();
    expect(await readSyntheticCommands(page)).toEqual([]);
    await dialog.getByRole('button', { name: '确认此方案的实施授权', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('合成 UI 预览不执行');
    expect((await readSyntheticCommands(page))[0]).toMatchObject({ kind: 'authorize-implementation', demandId: 'synthetic-audit', expectedVersion: 2, planId: 'synthetic-audit-plan', localCommit: false });
    expect((await readSyntheticCommands(page))[0]).not.toHaveProperty('confirmDesign');
    await dialog.getByRole('checkbox').check();
    await expect(dialog.getByRole('button', { name: '确认此方案的实施授权', exact: true })).toBeDisabled();
    await dialog.getByLabel('本地提交作者姓名', { exact: true }).fill('Synthetic Owner');
    await dialog.getByLabel('本地提交作者邮箱', { exact: true }).fill('synthetic@example.invalid');
    await dialog.getByRole('button', { name: '确认此方案的实施授权', exact: true }).click();
    await expect.poll(async () => (await readSyntheticCommands(page)).length).toBe(2);
    expect((await readSyntheticCommands(page))[1]).toMatchObject({ localCommit: true, authorName: 'Synthetic Owner', authorEmail: 'synthetic@example.invalid', planId: 'synthetic-audit-plan' });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '保存实施授权', exact: true }).click();
    await expect(dialog.getByRole('checkbox')).not.toBeChecked();
    await expect(dialog.getByLabel('本地提交作者姓名', { exact: true })).toHaveCount(0);
  });

  test('knowledge classification selects explicit roles and saves only exact result material', async ({ page }) => {
    await openPreview(page, '?knowledge=ready'); await observeSyntheticCommands(page);
    await page.getByRole('tab', { name: '经验', exact: true }).click();
    await page.getByRole('button', { name: '分类并保存候选', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('synthetic-note-n1');
    await expect(dialog.getByRole('button', { name: '分类并保存候选', exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('来源分类', { exact: true })).toHaveAccessibleName('来源分类');
    await dialog.getByLabel('来源分类', { exact: true }).selectOption('implementation');
    await expect(dialog.getByLabel('陈述类型', { exact: true })).toHaveAccessibleName('陈述类型');
    await dialog.getByLabel('陈述类型', { exact: true }).selectOption('fact');
    await dialog.getByRole('checkbox', { name: '规划', exact: true }).check();
    await dialog.getByLabel('模块路径（每行一个，可留空）', { exact: true }).fill('src/synthetic.ts');
    await dialog.getByRole('button', { name: '分类并保存候选', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('合成知识预览不会改变');
    const action = (await readSyntheticCommands(page))[0];
    expect(action).toMatchObject({ kind: 'knowledge-action', action: 'save-candidate', demandId: 'synthetic-export', expectedVersion: 12, resultId: 'synthetic-result-r1', artifactId: 'synthetic-note-n1', sourceKind: 'implementation', statementKind: 'fact', roles: ['planner'], modulePaths: ['src/synthetic.ts'] });
    expect(action).not.toHaveProperty('body'); expect(action).not.toHaveProperty('verified');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '分类并保存候选', exact: true }).click();
    await expect(dialog.getByRole('checkbox', { name: '规划', exact: true })).not.toBeChecked();
  });

  test('knowledge review requires actual-observation choice, exact check and semantic consent', async ({ page }, testInfo) => {
    await openPreview(page, '?knowledge=ready'); await observeSyntheticCommands(page);
    await page.getByRole('tab', { name: '经验', exact: true }).click();
    await page.getByRole('button', { name: '审阅并申请复用', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('合成精确正文：UTC 边界行为需要独立核对。');
    await expect(dialog.getByRole('button', { name: '审阅并申请复用', exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('真实合入观察', { exact: true })).toHaveAccessibleName('真实合入观察');
    await dialog.getByLabel('真实合入观察', { exact: true }).selectOption('synthetic-merge-observation');
    await dialog.getByLabel('核验理由与依据', { exact: true }).fill('合成：已审阅来源、范围与正文。');
    await dialog.getByRole('checkbox', { name: /合成原生检查展示/ }).check();
    await dialog.getByRole('checkbox', { name: /我已审阅精确正文/ }).check();
    await page.screenshot({ path: testInfo.outputPath('synthetic-knowledge-review.png'), fullPage: true });
    await dialog.getByRole('button', { name: '审阅并申请复用', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('合成知识预览不会改变');
    expect((await readSyntheticCommands(page))[0]).toMatchObject({ action: 'qualify', revisionId: 'synthetic-knowledge-revision', baseline: 'a'.repeat(40), observationId: 'synthetic-merge-observation', checkIds: ['synthetic-native-check'], reviewed: true, independentOfDemand: false });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '审阅并申请复用', exact: true }).click();
    await expect(dialog.getByRole('checkbox', { name: /我已审阅精确正文/ })).not.toBeChecked();
    await page.evaluate(() => window.dispatchEvent(new Event('pi-kanban:synthetic-change-version')));
    await expect(dialog.getByRole('alert')).toContainText('需求或知识记录已变化');
  });

  test('synthetic or unavailable knowledge evidence never enables eligibility review', async ({ page }) => {
    await openPreview(page, '?knowledge=blocked'); await observeSyntheticCommands(page);
    await page.getByRole('tab', { name: '经验', exact: true }).click();
    await expect(page.getByRole('button', { name: '审阅并申请复用', exact: true })).toBeDisabled();
    await expect(page.getByRole('tabpanel')).toContainText('受控测试响应，不可证明真实合入');
    expect(await readSyntheticCommands(page)).toEqual([]);
  });

  test('remote binding pins named repository and PR without accepting merge text as evidence', async ({ page }) => {
    await openPreview(page, '?knowledge=unbound'); await observeSyntheticCommands(page);
    await page.getByRole('tab', { name: '经验', exact: true }).click();
    await page.getByRole('button', { name: '绑定 GitHub PR', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('GitHub 所有者', { exact: true }).fill('synthetic-owner');
    await dialog.getByLabel('GitHub 仓库名称', { exact: true }).fill('synthetic-repo');
    await dialog.getByLabel('Pull Request 编号', { exact: true }).fill('42');
    await expect(dialog).toContainText('之后不能静默替换');
    await dialog.getByRole('button', { name: '绑定 GitHub PR', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('合成知识预览不会改变');
    expect((await readSyntheticCommands(page))[0]).toMatchObject({ action: 'bind-remote', owner: 'synthetic-owner', repository: 'synthetic-repo', pullRequest: 42, expectedVersion: 12 });
  });

  test('baseline proposal review cannot integrate before explicit author and version-bound consent', async ({ page }) => {
    await openPreview(page, '?knowledge=baseline'); await observeSyntheticCommands(page);
    await page.getByRole('tab', { name: '经验', exact: true }).click();
    await page.getByRole('button', { name: '准备基线方案', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('拟整合的精确提交', { exact: true }).fill('c'.repeat(40));
    await dialog.getByRole('button', { name: '准备基线方案', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('合成知识预览不会改变');
    expect((await readSyntheticCommands(page))[0]).toMatchObject({ action: 'propose-baseline', sourceCommit: 'c'.repeat(40) });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '授权整合此基线', exact: true }).click();
    await expect(dialog).toContainText('synthetic-baseline-proposal');
    await expect(dialog).toContainText('b'.repeat(40));
    await expect(dialog.getByRole('button', { name: '授权整合此基线', exact: true })).toBeDisabled();
    await dialog.getByLabel('本地提交作者姓名', { exact: true }).fill('Synthetic Owner');
    await dialog.getByLabel('本地提交作者邮箱', { exact: true }).fill('synthetic@example.invalid');
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: '授权整合此基线', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('合成知识预览不会改变');
    expect((await readSyntheticCommands(page))[1]).toMatchObject({ action: 'apply-baseline', proposalId: 'synthetic-baseline-proposal', author: { name: 'Synthetic Owner', email: 'synthetic@example.invalid' } });
  });

  test('post-integration verification binds operation and real prior recipes for fresh native checks', async ({ page }) => {
    await openPreview(page, '?knowledge=integrated'); await observeSyntheticCommands(page);
    await page.getByRole('tab', { name: '经验', exact: true }).click();
    await page.getByRole('button', { name: '核验整合后能力', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('d'.repeat(40));
    await expect(dialog).toContainText('不调用模型');
    await expect(dialog).toContainText('旧检查通过不代表新 HEAD 已通过');
    await expect(dialog.getByLabel('先前检查的来源成果', { exact: true })).toHaveAccessibleName('先前检查的来源成果');
    await dialog.getByLabel('先前检查的来源成果', { exact: true }).selectOption('synthetic-result-r1');
    await dialog.getByRole('checkbox', { name: /合成原生检查展示/ }).check();
    await dialog.getByRole('button', { name: '核验整合后能力', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('合成知识预览不会改变');
    expect((await readSyntheticCommands(page))[0]).toMatchObject({ action: 'verify-baseline', operationId: 'synthetic-baseline-proposal', resultId: 'synthetic-result-r1', checkIds: ['synthetic-native-check'] });
  });

  test('baseline conflict keeps exact proposal and original author for explicit reconciliation', async ({ page }) => {
    await openPreview(page, '?knowledge=conflict'); await observeSyntheticCommands(page);
    await page.getByRole('tab', { name: '经验', exact: true }).click();
    await expect(page.getByRole('tabpanel')).toContainText('存在整合冲突，尚未放行');
    await page.getByRole('button', { name: '核对并继续此整合', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('同一基线整合');
    await expect(dialog).toContainText('不会自动 reset 或 abort');
    await expect(dialog.getByLabel('本地提交作者姓名', { exact: true })).toHaveValue('Synthetic Original');
    await expect(dialog.getByLabel('本地提交作者姓名', { exact: true })).toHaveAttribute('readonly', '');
    await expect(dialog.getByRole('checkbox')).not.toBeChecked();
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: '授权整合此基线', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('合成知识预览不会改变');
    expect((await readSyntheticCommands(page))[0]).toMatchObject({ action: 'apply-baseline', proposalId: 'synthetic-baseline-proposal', author: { name: 'Synthetic Original', email: 'original@example.invalid' } });
  });

  test('plan and ticket artifacts expose full bounded immutable text without issuing approvals', async ({ page }, testInfo) => {
    await openPreview(page, '?artifacts=1'); await observeSyntheticCommands(page);
    await page.evaluate(() => {
      const target = window as unknown as { syntheticArtifactReads: unknown[] }; target.syntheticArtifactReads = [];
      window.addEventListener('pi-kanban:synthetic-artifact-read', event => target.syntheticArtifactReads.push((event as CustomEvent).detail));
    });
    await page.getByRole('tab', { name: '方案', exact: true }).click();
    await page.getByRole('button', { name: '阅读完整 Spec', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.artifact-text')).toContainText('合成产物 synthetic-spec-artifact');
    await expect(dialog.getByRole('status')).toContainText('尚有未载入内容');
    await expect(dialog).toContainText('1'.repeat(64));
    await dialog.getByRole('button', { name: '载入下一段正文', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('完整正文');
    await expect(dialog.getByRole('button', { name: '载入下一段正文', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('synthetic-full-spec-artifact.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '阅读完整任务清单', exact: true }).click();
    await expect(dialog.locator('.artifact-text')).toContainText('合成产物 synthetic-tickets-artifact');
    const reads = await page.evaluate(() => (window as unknown as { syntheticArtifactReads: unknown[] }).syntheticArtifactReads);
    expect(reads).toEqual([
      { demandId: 'synthetic-export', artifactId: 'synthetic-spec-artifact', digest: '1'.repeat(64), offset: 0 },
      { demandId: 'synthetic-export', artifactId: 'synthetic-spec-artifact', digest: '1'.repeat(64), offset: 16_384 },
      { demandId: 'synthetic-export', artifactId: 'synthetic-tickets-artifact', digest: '2'.repeat(64), offset: 0 },
    ]);
    expect(await readSyntheticCommands(page)).toEqual([]);
  });

  test('closing a slow artifact read preserves a newer dialog and unsubmitted draft', async ({ page }) => {
    await openPreview(page, '?artifacts=1&latency=1000'); await observeSyntheticCommands(page);
    await page.evaluate(() => {
      const target = window as unknown as { syntheticArtifactReadCount: number }; target.syntheticArtifactReadCount = 0;
      window.addEventListener('pi-kanban:synthetic-artifact-read', () => { target.syntheticArtifactReadCount += 1; });
    });
    await page.getByRole('tab', { name: '方案', exact: true }).click();
    await page.getByRole('button', { name: '阅读完整 Spec', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '新建需求', exact: true }).click();
    await page.getByRole('dialog').getByLabel('需求标题', { exact: true }).fill('读取关闭后保留的草稿');
    await expect.poll(() => page.evaluate(() => (window as unknown as { syntheticArtifactReadCount: number }).syntheticArtifactReadCount)).toBe(1);
    await expect(page.getByRole('dialog').getByRole('heading', { name: '记录一条新需求', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByLabel('需求标题', { exact: true })).toHaveValue('读取关闭后保留的草稿');
    await expect(page.locator('.artifact-viewer')).toHaveCount(0);
    expect(await readSyntheticCommands(page)).toEqual([]);
  });

});
