import type { Command, Demand, ViewState } from './types.ts';
import { commandUnavailable, makeCommand } from './model.ts';
export interface ImplementationInput { localCommit: boolean; authorName: string; authorEmail: string }
export function implementationUnavailable(target: Demand, state: ViewState): string | null {
  const current = state.demands.find(item => item.id === target.id);
  if (!current || current.version !== target.version || current.plan?.id !== target.plan?.id) return '需求或方案版本已变化，请关闭并重新审阅。';
  if (!target.plan?.ready || !target.plan.confirmed || current.phase !== 'awaiting-authorization') return '请先单独确认当前已就绪方案。';
  return commandUnavailable('authorize-implementation', state, current);
}
export function makeImplementationAuthorization(target: Demand, input: ImplementationInput, requestId: string): Command {
  if (!target.plan?.ready || !target.plan.confirmed) throw new Error('请先单独确认当前已就绪方案。');
  const command = makeCommand('authorize-implementation', target, requestId);
  command.localCommit = input.localCommit === true;
  if (input.localCommit) {
    const authorName = input.authorName.trim(), authorEmail = input.authorEmail.trim();
    if (!authorName || authorName.length > 200 || /[\r\n<>\0]/.test(authorName) || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(authorEmail) || authorEmail.length > 320) throw new Error('请填写有效的本地提交作者姓名与邮箱。');
    command.authorName = authorName; command.authorEmail = authorEmail;
  }
  return command;
}
