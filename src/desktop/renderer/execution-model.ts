import type { ExecutionArchive, ExecutionAxis, ExecutionFindingInput, ExecutionStep, ExecutionTicketState } from '../../domain/types.ts';
import type { Demand } from './types.ts';

export const EXECUTION_STEP_LABELS: Record<ExecutionStep, string> = {
  'ticket-implementation': '按依赖实施任务 · TDD', 'ticket-fix': '限定范围修复',
  'review-standards': '整个 Spec · 项目标准审查', 'review-spec': '整个 Spec · Spec 一致性审查',
  'resolution-standards': '项目标准发现 · 定向核验', 'resolution-spec': 'Spec 发现 · 定向核验',
  complete: '实施与独立审查已完成',
};
export const EXECUTION_AXIS_LABELS: Record<ExecutionAxis, string> = { standards: '项目标准', spec: 'Spec 一致性' };
export const EXECUTION_FINDING_LABELS: Record<ExecutionFindingInput['category'], string> = {
  'documented-violation': '有文档依据的违规', smell: '设计异味', 'spec-violation': 'Spec 不一致',
};
export const EXECUTION_TICKET_LABELS: Record<ExecutionTicketState['status'], string> = {
  pending: '待实施', implementing: '实施中', reviewing: '审查中', repairing: '修复中', done: '已完成',
};

/** Display derived eligibility only. This never schedules a run or changes the persisted graph. */
export function executionTicketProgress(demand: Demand) {
  const flow = demand.executionFlow;
  if (!flow) return { total: 0, completed: 0, frontier: [] as string[], tickets: [] as { ticketId: string; title: string; status: ExecutionTicketState['status']; blockedBy: string[]; graphKnown: boolean; eligible: boolean; contentId?: string }[] };
  const graph = demand.planningFlow?.id === flow.planningFlowId ? demand.planningFlow.tickets : [];
  const done = new Set(flow.tickets.filter(ticket => ticket.status === 'done').map(ticket => ticket.ticketId));
  const tickets = flow.tickets.map(ticket => {
    const definition = graph.find(item => item.id === ticket.ticketId);
    const blockedBy = definition?.blockedBy.filter(id => !done.has(id)) ?? [];
    const eligible = !!definition && (ticket.status === 'pending' || ticket.status === 'implementing') && !blockedBy.length;
    return { ticketId: ticket.ticketId, title: definition?.title ?? ticket.ticketId, status: ticket.status, blockedBy, graphKnown: !!definition, eligible, contentId: ticket.completedContentId ?? ticket.contentId };
  });
  return { total: tickets.length, completed: done.size, frontier: tickets.filter(ticket => ticket.eligible).map(ticket => ticket.ticketId), tickets };
}

/** Original reviews and focused resolutions remain distinct and bind the exact content they observed. */
export function executionAxisEvidence(flow: ExecutionArchive, axis: ExecutionAxis, contentId?: string) {
  const reviews = flow.reviews.filter(review => review.axis === axis && review.scope === 'whole-spec').sort((a, b) => b.sequence - a.sequence);
  const resolutions = flow.resolutions.filter(resolution => resolution.axis === axis && resolution.scope === 'whole-spec').sort((a, b) => b.sequence - a.sequence);
  return { latestReview: reviews[0], currentReview: contentId ? reviews.find(review => review.contentId === contentId) : undefined,
    currentResolutions: contentId ? resolutions.filter(resolution => resolution.contentId === contentId) : [], reviews, resolutions };
}

export function executionDecisionFindings(demand: Demand) {
  const decisionIds = new Set((demand.findings ?? []).filter(finding => finding.status !== 'closed' && finding.contentId === demand.activeContentId && finding.severity === 'decision').map(finding => finding.id));
  return demand.executionFlow?.reviews.flatMap(review => review.findings.filter(finding => finding.requiresDesignDecision && decisionIds.has(finding.id))) ?? [];
}
