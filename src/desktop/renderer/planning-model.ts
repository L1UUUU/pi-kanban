import type { PlanningFlow, PlanningQuestion, PlanningStep } from '../../domain/types.ts';
import type { Command, Demand, ViewState } from './types.ts';

export const PLANNING_STEPS: PlanningStep[] = ['facts', 'clarification', 'awaiting-understanding-confirmation', 'design', 'design-review', 'design-resolution', 'awaiting-final-design-confirmation', 'spec', 'tickets', 'complete'];
export const PLANNING_STEP_LABELS: Record<PlanningStep, string> = {
  facts: '调查代码事实', clarification: '澄清需求', 'awaiting-understanding-confirmation': '待确认需求与验收',
  design: '形成设计草案', 'design-review': '独立只读设计审查', 'design-resolution': '处理审查发现',
  'awaiting-final-design-confirmation': '待确认最终设计与测试', spec: '生成本地 Spec', tickets: '拆分本地任务', complete: '规划完成',
};
export const PLANNING_LABELS = {
  'answer-planning-question': '回答此规划问题', 'confirm-understanding': '确认需求与验收',
  'confirm-final-design': '确认最终设计与测试', 'revise-planning': '提交限定范围修订',
};
export type PlanningReview =
  | { kind: 'confirm-understanding'; demand: Demand }
  | { kind: 'confirm-final-design'; demand: Demand }
  | { kind: 'answer-planning-question'; demand: Demand; questionId: string }
  | { kind: 'revise-planning'; demand: Demand; scope: 'requirements' | 'design' };
export interface PlanningInput { text?: string; reviewed?: boolean }
export function unansweredPlanningQuestions(flow: PlanningFlow): PlanningQuestion[] {
  return flow.questions.filter(question => !flow.answers.some(answer => answer.questionId === question.id && answer.questionDigest === question.digest));
}
export function planningAttention(demand: Demand): string | null {
  const flow = demand.planningFlow;
  if (!flow || demand.control === 'cancelled') return null;
  if (unansweredPlanningQuestions(flow).length) return '请回答当前范围内的规划问题';
  if (flow.step === 'awaiting-understanding-confirmation' || flow.step === 'awaiting-final-design-confirmation') return PLANNING_STEP_LABELS[flow.step];
  return null;
}
/** Display-only guards. The Host checks persisted authority and immutable bindings again. */
export function planningUnavailable(review: PlanningReview, state: ViewState): string | null {
  const target = review.demand, flow = target.planningFlow;
  const latest = state.demands.find(item => item.id === target.id), current = latest?.planningFlow;
  if (state.runtime.connection === 'disconnected') return '与本地 Host 的连接已断开。';
  if (!latest || latest.version !== target.version || !flow || !current || current.id !== flow.id || current.revision !== flow.revision || current.step !== flow.step) return '规划版本或阶段已变化，请关闭此窗口并核对最新内容。';
  if (latest.control === 'cancelled' || latest.phase === 'accepted') return '此需求已取消或已验收，不能更改规划决定。';
  if (latest.result) return '请先退回当前稳定成果，再更改规划决定。';
  if (!['idle', 'stopped'].includes(latest.runState ?? 'unknown')) return '请先暂停并核验旧执行已经停止。';
  if (review.kind === 'answer-planning-question') {
    const question = flow.questions.find(item => item.id === review.questionId);
    if (!question || !unansweredPlanningQuestions(current).some(item => item.id === question.id && item.digest === question.digest)) return '此问题已回答或已变化，请核对当前问题。';
  }
  if (review.kind === 'confirm-understanding') {
    if (flow.step !== 'awaiting-understanding-confirmation' || !flow.understanding || current.understanding?.id !== flow.understanding.id || current.understanding.digest !== flow.understanding.digest || current.understandingConfirmation) return '当前需求理解已变化或已有有效确认。';
    if (unansweredPlanningQuestions(current).length) return '请先回答尚未明确的规划问题。';
  }
  if (review.kind === 'confirm-final-design') {
    if (flow.step !== 'awaiting-final-design-confirmation' || !flow.design || !flow.resolution || !flow.review || current.design?.id !== flow.design.id || current.design.digest !== flow.design.digest || current.resolution?.digest !== flow.resolution.digest || current.review?.id !== flow.review.id || current.finalDesignConfirmation) return '最终设计或审查处理已变化，或已有有效确认。';
    if (!current.understandingConfirmation || unansweredPlanningQuestions(current).length) return '请先完成需求确认与相关问题的决定。';
  }
  if (review.kind === 'revise-planning' && review.scope === 'design' && !current.understandingConfirmation) return '请先确认需求；需求与验收变化请使用需求修订。';
  return null;
}
export function makePlanningCommand(review: PlanningReview, input: PlanningInput, requestId: string): Command {
  const demand = review.demand, flow = demand.planningFlow;
  if (!flow) throw new Error('当前没有分阶段规划记录。');
  const command: Command = { kind: review.kind, demandId: demand.id, expectedVersion: demand.version, requestId, flowId: flow.id, flowRevision: flow.revision };
  if (review.kind === 'confirm-understanding') {
    if (!flow.understanding || flow.step !== 'awaiting-understanding-confirmation' || input.reviewed !== true) throw new Error('请明确审阅并确认此版本的需求与验收。');
    return { ...command, understandingId: flow.understanding.id, digest: flow.understanding.digest };
  }
  if (review.kind === 'confirm-final-design') {
    if (!flow.design || !flow.review || !flow.resolution || flow.step !== 'awaiting-final-design-confirmation' || input.reviewed !== true) throw new Error('请明确审阅并确认最终设计、审查处理与测试 seams。');
    return { ...command, designId: flow.design.id, digest: flow.resolution.digest };
  }
  const text = input.text?.trim();
  if (!text || text.length > 20_000) throw new Error('请填写具体答案或修订要求（不超过 20000 字）。');
  if (review.kind === 'answer-planning-question') {
    const question = unansweredPlanningQuestions(flow).find(item => item.id === review.questionId);
    if (!question) throw new Error('请选择当前未回答的规划问题。');
    return { ...command, questionId: question.id, questionDigest: question.digest, answer: text };
  }
  return { ...command, scope: review.scope, text };
}
