/** Synthetic UI records only; no production entry imports this module. */
import type { ArtifactRef, ExecutionFindingInput, ExecutionFlow, ExecutionStep } from '../../domain/types.ts';
import { syntheticPlanningFlow } from './planning-preview.ts';
import type { Demand } from './types.ts';

const artifact = (id: string): ArtifactRef => ({ id: `synthetic-${id}`, digest: 'a'.repeat(64), location: `synthetic-only://${id}` });
export function applySyntheticExecution(target: Demand, step: ExecutionStep, condition: string | null) {
  const planning = syntheticPlanningFlow('complete'); target.planningFlow = planning;
  target.plan = { id: 'synthetic-execution-plan', scope: planning.understanding!.scope, ready: true, confirmed: true, spec: planning.spec!.evidence };
  target.result = undefined; target.messages = []; target.activities = []; target.checks = []; target.blockers = []; target.workflowBlockers = [];
  target.activeContentId = 'synthetic-execution-K-current'; target.runState = 'stopped'; target.phase = step === 'ticket-implementation' || step === 'ticket-fix' ? 'implementing' : step === 'complete' ? 'awaiting-acceptance' : 'reviewing';
  const flow: ExecutionFlow = { id: 'synthetic-execution-flow', revision: 6, planId: target.plan.id, planningFlowId: planning.id, approvedInputDigest: 'b'.repeat(64), step, scope: step === 'ticket-implementation' ? 'ticket' : 'whole-spec', ticketId: step === 'ticket-implementation' ? planning.tickets[0].id : undefined,
    tickets: planning.tickets.map((ticket, index) => ({ ticketId: ticket.id, status: step === 'ticket-implementation' ? index === 0 ? 'implementing' : 'pending' : 'done', completedContentId: step === 'ticket-implementation' ? undefined : `synthetic-ticket-K-${index + 1}`, reviewIds: [], resolutionIds: [] })), implementations: [], checkInputIds: [], reviews: [], resolutions: [], repairHistory: [], history: [] };
  target.executionFlow = flow;
  if (step !== 'ticket-implementation') {
    flow.implementations = planning.tickets.map((ticket, index) => ({ contentId: `synthetic-ticket-K-${index + 1}`, scope: 'ticket', ticketId: ticket.id, runId: `synthetic-tdd-run-${index + 1}`, inputDigest: 'c'.repeat(64), flowRevision: index + 1, tdd: { mode: 'red-green', testingSeams: planning.design!.testingSeams, red: [artifact(`red-test-${index + 1}`)], green: [artifact(`green-test-${index + 1}`)] } }));
    const selected: ExecutionFindingInput = { id: 'synthetic-execution-seam-decision', category: 'smell', severity: 'decision', location: 'synthetic/export.ts:10', basis: '合成异味：此建议会改变既有测试 seam，需要明确决定。', impact: '合成：影响接口与验证位置。', verification: '合成：修订设计后核对对应测试。', requiresDesignDecision: true, reference: artifact('seam-observation') };
    flow.reviews = [
      { id: 'synthetic-standards-review', axis: 'standards', contentId: 'synthetic-execution-K-original', evidence: artifact('standards-review'), knowledgeReviewed: true, findings: [{ ...selected, id: 'synthetic-documented-violation', category: 'documented-violation', severity: 'blocking', basis: '合成：违反已记录的错误处理约定。', clause: '合成标准 §2', requiresDesignDecision: false, reference: artifact('documented-standard') }, selected], sequence: 1, scope: 'whole-spec', runId: 'synthetic-standards-run', contextId: 'synthetic-fresh-standards-context', inputDigest: 'd'.repeat(64), flowRevision: 3 },
      { id: 'synthetic-spec-review', axis: 'spec', contentId: 'synthetic-execution-K-original', evidence: artifact('spec-review'), knowledgeReviewed: true, findings: [{ ...selected, id: 'synthetic-spec-violation', category: 'spec-violation', severity: 'blocking', basis: '合成：边界行为与 Spec 不一致。', clause: '合成 Spec §1', requiresDesignDecision: false, reference: artifact('spec-clause') }], sequence: 2, scope: 'whole-spec', runId: 'synthetic-spec-run', contextId: 'synthetic-fresh-spec-context', inputDigest: 'e'.repeat(64), flowRevision: 4 },
    ];
    flow.repairScope = { id: 'synthetic-focused-repair', scope: 'whole-spec', baseContentId: 'synthetic-execution-K-original', reviewIds: flow.reviews.map(review => review.id), findingIds: flow.reviews.flatMap(review => review.findings.map(finding => finding.id)), checkIds: ['synthetic-related-check'], reason: '合成：统一修复已记录的标准和 Spec 发现，仅重跑相关检查。' };
    target.findings = [{ ...selected, contentId: target.activeContentId, reviewRunId: 'synthetic-standards-run', status: 'open' }];
    if (step === 'resolution-standards' || step === 'resolution-spec' || step === 'complete') {
      flow.resolutions.push({ id: 'synthetic-focused-standards-resolution', axis: 'standards', contentId: target.activeContentId, repairScopeId: flow.repairScope.id, evidence: artifact('focused-resolution'), dispositions: [{ findingId: 'synthetic-documented-violation', outcome: 'fixed', rationale: '合成：已补齐直接回归检查。', evidence: artifact('focused-regression') }, { findingId: selected.id, outcome: 'unresolved', rationale: '合成：待明确设计决定。', evidence: artifact('focused-decision') }], sequence: 3, scope: 'whole-spec', runId: 'synthetic-focused-run', contextId: 'synthetic-fresh-focused-context', inputDigest: 'f'.repeat(64), flowRevision: 5 });
    }
    if (step === 'complete') {
      target.findings = [];
      flow.resolutions[0].dispositions[1] = { findingId: selected.id, outcome: 'not-applicable', rationale: '合成：明确保留已确认的 seam，不采用扩大范围的建议。', evidence: artifact('seam-preserved') };
      flow.resolutions.push({ id: 'synthetic-focused-spec-resolution', axis: 'spec', contentId: target.activeContentId, repairScopeId: flow.repairScope.id, evidence: artifact('focused-spec-resolution'), dispositions: [{ findingId: 'synthetic-spec-violation', outcome: 'fixed', rationale: '合成：边界回归检查通过。', evidence: artifact('focused-spec-regression') }], sequence: 4, scope: 'whole-spec', runId: 'synthetic-focused-spec-run', contextId: 'synthetic-fresh-focused-spec-context', inputDigest: 'f'.repeat(64), flowRevision: 6 });
      flow.repairHistory.push(flow.repairScope); flow.repairScope = undefined;
    }
    const { history, ...prior } = structuredClone(flow); prior.revision = 2; flow.history.push(prior);
  }
  if (condition === 'paused' || condition === 'exited' || condition === 'cancelled') target.control = condition;
  if (condition === 'running' || condition === 'stopping' || condition === 'unknown') target.runState = condition;
}
