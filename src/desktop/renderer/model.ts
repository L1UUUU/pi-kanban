import type { Command, CommandKind, Demand, Message, Phase, ViewState } from './types.ts';

export const PHASE_LABELS: Record<Phase, string> = {
  idea: '想法', planning: '规划中', 'awaiting-design': '待确认方案', 'awaiting-authorization': '待实施授权',
  implementing: '实施中', checking: '检查中', reviewing: '独立 Review', rework: '修复中',
  'awaiting-acceptance': '待验收', accepted: '已验收', blocked: '有阻塞',
};
export const MESSAGE_STATES: Record<NonNullable<Message['state']>, { label: string; explanation: string }> = {
  saved: { label: '已保存', explanation: '已保存到需求记录，尚未确认投递给 Agent。' },
  delivered: { label: '已投递', explanation: '已投递给对应会话，尚未确认要求已落实。' },
  applied: { label: '已落实', explanation: '应用已记录要求落实的回执。' },
};
export function needsAttention(demand: Demand): boolean {
  return demand.control !== 'cancelled' && (demand.blockers.length > 0 || demand.phase === 'blocked' ||
    ['awaiting-design', 'awaiting-authorization', 'awaiting-acceptance'].includes(demand.phase) ||
    demand.runState === 'unknown' || demand.runState === 'stopping');
}
export function demandStatus(demand: Demand): { label: string; tone: 'neutral' | 'live' | 'warning' | 'success' } {
  if (demand.runState === 'stopping') return { label: '正在停止', tone: 'warning' };
  if (demand.runState === 'unknown') return { label: '运行状态待核验', tone: 'warning' };
  if (demand.control === 'cancelled') return { label: '已取消 · 内容保留', tone: 'neutral' };
  if (demand.control === 'paused') return { label: '已暂停', tone: 'neutral' };
  if (demand.control === 'exited') return { label: '已停止 · 待继续', tone: 'neutral' };
  if (demand.blockers.length || demand.phase === 'blocked') return { label: '等待解除阻塞', tone: 'warning' };
  if (demand.runState === 'running') return { label: PHASE_LABELS[demand.phase], tone: 'live' };
  if (demand.runState === 'queued') return { label: '等待运行资源', tone: 'neutral' };
  if (demand.phase === 'accepted') return { label: '已验收', tone: 'success' };
  if (['planning', 'implementing', 'checking', 'reviewing', 'rework'].includes(demand.phase)) return { label: `${PHASE_LABELS[demand.phase]} · 未运行`, tone: 'neutral' };
  return { label: PHASE_LABELS[demand.phase], tone: needsAttention(demand) ? 'warning' : 'neutral' };
}
/** Visibility only. Host must independently check every command and all prerequisites. */
export function primaryAction(demand: Demand): { kind: CommandKind; label: string; description: string } | null {
  if (demand.control === 'cancelled' || demand.runState === 'stopping' || demand.runState === 'unknown') return null;
  if (demand.control === 'paused' || demand.control === 'exited') return { kind: 'resume', label: '继续这条需求', description: '核对现有授权、运行条件与剩余额度后继续。' };
  if (demand.phase === 'idea') return { kind: 'start-planning', label: '开始规划', description: '准备独立工作区并调查需求。实施需要另外授权。' };
  if (demand.plan?.ready && !demand.plan.confirmed && demand.phase === 'awaiting-design') return { kind: 'confirm-plan', label: '确认当前方案', description: '确认此版本的范围与设计，实施授权单独处理。' };
  if (demand.plan?.ready && demand.plan.confirmed && demand.phase === 'awaiting-authorization') return { kind: 'authorize-implementation', label: '授权按此方案实施', description: '仅针对当前方案，在有效能力与有限额度内实施。' };
  if (demand.phase === 'awaiting-acceptance' && demand.result) return { kind: 'accept-result', label: '接受这轮成果', description: '验收仅绑定下方成果版本，后续变更需重新检查。' };
  return null;
}
export function makeCommand(kind: CommandKind, demand: Demand, requestId: string, text?: string): Command {
  const command: Command = { kind, demandId: demand.id, expectedVersion: demand.version, requestId };
  if (kind === 'confirm-plan' || kind === 'authorize-implementation') {
    if (!demand.plan) throw new Error('方案尚未就绪，请刷新后重试。');
    command.planId = demand.plan.id;
  }
  if (kind === 'accept-result' || kind === 'return-result') {
    if (!demand.result) throw new Error('没有可操作的稳定成果。');
    command.resultId = demand.result.id;
  }
  if (kind === 'return-result' && !text?.trim()) throw new Error('请说明需要返工的内容。');
  if (text?.trim()) command.text = text.trim();
  return command;
}
export function commandUnavailable(kind: CommandKind, state: ViewState, demand: Demand): string | null {
  if (state.runtime.connection === 'disconnected') return '与本地 Host 的连接已断开。';
  if (demand.control === 'cancelled') return '已取消的需求不能恢复执行。';
  if (['start-planning', 'authorize-implementation', 'resume'].includes(kind) && (demand.runState === 'unknown' || demand.runState === 'stopping')) return '请先核验旧执行已经停止。';
  return null;
}
export function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : typeof error === 'string' ? error : '发生未知错误，请重新读取状态。';
  if (/stale|version|revision|版本|对象已变/i.test(value)) return '内容版本已变化。已尝试读取最新状态，请核对当前方案或成果后重新操作。';
  return value;
}
/** Keep a late command response from replacing a newer subscription event. */
export function reconcileSnapshot(current: ViewState | null, incoming: ViewState): ViewState {
  if (!current) return incoming;
  // Whole-state ordering protects newly created projects/demands and runtime-only updates too.
  return incoming.sequence < current.sequence ? current : incoming;
}
export function shortId(value: string): string { return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value; }
