import type { Finding, Stage } from '../../domain/types.ts';
import type { Command, ConfigurationSummary, Demand, ViewState } from './types.ts';

export type DecisionReview =
  | { kind: 'revise-plan' | 'resolve-blocker'; demand: Demand }
  | { kind: 'decide-finding'; demand: Demand; findingId: string; contentId: string }
  | { kind: 'switch-method'; demand: Demand; configuration: ConfigurationSummary };
export interface DecisionInput { reason: string; stage?: Stage; impactReviewed?: boolean }
export const STAGE_NAMES: Record<Stage, string> = { planning: '规划', implementation: '实施', review: '独立 Review' };
export const DECISION_LABELS = { 'revise-plan': '修订当前方案', 'decide-finding': '记录此项决定', 'resolve-blocker': '核对并解除阻塞', 'switch-method': '切换冻结方法' };
export function currentDecisions(demand: Demand): Finding[] {
  return (demand.findings ?? []).filter(finding => finding.contentId === demand.activeContentId && finding.severity === 'decision' && finding.status !== 'closed');
}
/** Display guards only: the Host verifies identities and prerequisites again at commit. */
export function decisionUnavailable(review: DecisionReview, state: ViewState): string | null {
  const target = review.demand, latest = state.demands.find(item => item.id === target.id);
  if (state.runtime.connection === 'disconnected') return '与本地 Host 的连接已断开。';
  if (!latest || latest.version !== target.version) return '对象版本已变化，请关闭此窗口并核对最新内容。';
  if (latest.control === 'cancelled' || latest.phase === 'accepted') return '此需求已取消或已验收，不能更改此轮决定。';
  if (latest.result) return '请先退回当前稳定成果，再更改方案、方法或阻塞。';
  if (!['idle', 'stopped'].includes(latest.runState ?? 'unknown')) return '请先暂停并核验旧执行已经停止。';
  if (review.kind === 'revise-plan') {
    if (latest.planningFlow) return '请使用分阶段规划中的需求或设计修订，保留仍有效的确认。';
    if (!target.plan || latest.plan?.id !== target.plan.id) return '当前方案已变化，请重新核对。';
  }
  if (review.kind === 'decide-finding') {
    if (latest.activeContentId !== review.contentId || !currentDecisions(latest).some(finding => finding.id === review.findingId && finding.contentId === review.contentId)) return '该决定项已关闭或不属于当前内容版本。';
  }
  if (review.kind === 'resolve-blocker') {
    if (!latest.workflowBlockers?.length) return '没有可解除的需求级阻塞。运行配置问题请在诊断中处理。';
    if (currentDecisions(latest).length) return '请先逐项记录用户决定，不能用解除阻塞代替。';
    if (latest.plan?.unresolvedQuestions?.length) return '方案仍有待明确的问题，请提交修订说明重新规划。';
  }
  if (review.kind === 'switch-method') {
    if (state.configuration?.configurationDigest !== review.configuration.configurationDigest) return '运行配置版本已变化，请重新审阅方法。';
    if (review.configuration.sourceStatus !== 'configured' || !review.configuration.methods.some(method => method.status === 'configured' && method.snapshot)) return '请先在运行诊断中导入并核验方法来源。';
  }
  return null;
}
export function makeDecisionCommand(review: DecisionReview, input: DecisionInput, requestId: string): Command {
  const text = input.reason.trim();
  if (!text || text.length > 20000) throw new Error('请填写具体决定与原因（不超过 20000 字）。');
  const target = review.demand;
  const command: Command = { kind: review.kind, demandId: target.id, expectedVersion: target.version, requestId, text };
  if (review.kind === 'revise-plan') {
    if (target.planningFlow) throw new Error('分阶段规划需要限定范围修订。');
    if (!target.plan) throw new Error('没有可修订的当前方案。');
    command.previousPlanId = target.plan.id;
  } else if (review.kind === 'decide-finding') {
    if (target.activeContentId !== review.contentId || !currentDecisions(target).some(finding => finding.id === review.findingId && finding.contentId === review.contentId)) throw new Error('必须选择当前内容版本的未关闭决定项。');
    command.findingId = review.findingId; command.contentId = review.contentId;
  } else if (review.kind === 'switch-method') {
    const method = review.configuration.methods.find(method => method.stage === input.stage && method.status === 'configured')?.snapshot;
    if (!method || !input.stage) throw new Error('请选择已核验的阶段方法。');
    if (input.impactReviewed !== true) throw new Error('请明确确认已经审阅方法变更的影响。');
    Object.assign(command, { stage: input.stage, methodId: method.id, methodVersion: method.version, methodDigest: method.digest, configurationDigest: review.configuration.configurationDigest, impactReviewed: true });
  }
  return command;
}
