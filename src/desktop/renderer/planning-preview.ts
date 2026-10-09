/** Synthetic UI fixtures only. Never import this module from the production renderer. */
import type { ArtifactRef, PlanningFlow, PlanningStep } from '../../domain/types.ts';
import { PLANNING_STEPS } from './planning-model.ts';

const artifact = (id: string, digit: string): ArtifactRef => ({ id: `synthetic-${id}`, digest: digit.repeat(64), location: `synthetic-only://${id}` });
export function syntheticPlanningFlow(step: PlanningStep): PlanningFlow {
  const index = PLANNING_STEPS.indexOf(step), flow: PlanningFlow = { id: 'synthetic-planning-flow', revision: 7, step, history: [], messages: [], questions: [], answers: [], confirmations: [], tickets: [] };
  if (index > 0) flow.facts = { evidence: artifact('facts', '1'), summary: '合成事实：现有日期范围组件和导出入口已经有调用方。没有真实读取代码。', runId: 'synthetic-facts-run', contextId: 'synthetic-facts-context', inputDigest: '1'.repeat(64) };
  if (index > 0) flow.understanding = { id: 'synthetic-understanding', version: 1, digest: '2'.repeat(64), createdByRun: 'synthetic-clarification-run', contextId: 'synthetic-clarification-context', scope: '合成需求：按时间范围导出数据，保留空范围行为。', acceptanceCriteria: ['合成：起止日期使用已确认时区', '合成：开始晚于结束时显示错误'], nonGoals: ['合成：不增加新的导出格式'], constraints: ['合成：复用项目已有日期组件'], evidence: artifact('understanding-evidence', '3') };
  if (step === 'clarification') flow.questions = [{ id: 'synthetic-requirement-question', scope: 'requirements', question: '合成问题：日期边界按 UTC 还是工作区时区？', basis: '合成依据：此行为影响跨时区导出验收。', digest: '4'.repeat(64) }];
  if (index > 2) {
    flow.understandingConfirmation = { kind: 'understanding', targetId: flow.understanding!.id, digest: flow.understanding!.digest, flowRevision: 3, userId: 'synthetic-owner', createdAt: '2026-10-09T08:00:00.000Z' };
    flow.confirmations.push(flow.understandingConfirmation);
  }
  if (index > 3) flow.design = { id: 'synthetic-design', version: 1, digest: '5'.repeat(64), understandingDigest: flow.understanding!.digest, createdByRun: 'synthetic-design-run', contextId: 'synthetic-design-context', summary: '合成设计：复用统一日期边界校验；通过现有导出服务接入。', testingSeams: ['合成：在导出服务入口验证空范围和相等边界', '合成：在日期组件测试非法顺序的错误反馈'], constraints: ['合成：保留现有接口和时区语义'], evidence: artifact('design-evidence', '6') };
  if (index > 4) flow.review = { id: 'synthetic-design-review', designDigest: flow.design!.digest, evidence: artifact('design-review-evidence', '7'), findings: [{ id: 'synthetic-design-finding', severity: step === 'design-resolution' ? 'decision' : 'blocking', trigger: '合成：开始时间等于结束时间', expectedOutcome: step === 'design-resolution' ? '合成：待用户确认是否允许单点范围' : '合成：接受该范围并按既定包含规则导出', basis: '合成依据：已确认的边界行为需要直接覆盖', verification: '合成：tests/export-range.test.ts 中增加相等边界断言' }], runId: 'synthetic-independent-review-run', contextId: 'synthetic-fresh-read-only-review-context', inputDigest: '8'.repeat(64) };
  if (step === 'design-resolution') flow.questions = [{ id: 'synthetic-design-question', findingId: 'synthetic-design-finding', scope: 'design', question: '合成问题：相等边界是否保留为单点范围？', basis: '合成：独立设计审查发现此取舍尚未明确。', digest: '9'.repeat(64) }];
  if (index > 5) flow.resolution = { id: 'synthetic-design-resolution', reviewId: flow.review!.id, designDigest: flow.design!.digest, evidence: artifact('design-resolution-evidence', 'a'), dispositions: [{ findingId: 'synthetic-design-finding', outcome: 'adopted', rationale: '合成：依据已确认行为补充相等边界场景与直接断言。' }], digest: 'b'.repeat(64), createdByRun: 'synthetic-resolution-run' };
  if (index > 6) {
    flow.finalDesignConfirmation = { kind: 'final-design', targetId: flow.design!.id, digest: flow.resolution!.digest, flowRevision: 6, userId: 'synthetic-owner', createdAt: '2026-10-09T08:30:00.000Z' };
    flow.confirmations.push(flow.finalDesignConfirmation);
  }
  if (index > 7) flow.spec = { id: 'synthetic-local-spec', kind: 'spec', designDigest: flow.design!.digest, evidence: artifact('local-spec-evidence', 'c'), requiredChecks: [{ id: 'synthetic-range-check', name: '合成日期范围边界检查', source: 'demand' }], createdByRun: 'synthetic-spec-run' };
  if (index > 8) flow.tickets = [{ id: 'synthetic-local-ticket-1', kind: 'ticket', title: '合成任务：接入日期范围行为', evidence: artifact('local-ticket-1', 'd'), specId: flow.spec!.id, specClauses: ['合成 Spec §1 日期范围'], blockedBy: [] }, { id: 'synthetic-local-ticket-2', kind: 'ticket', title: '合成任务：核验调用方兼容', evidence: artifact('local-ticket-2', 'e'), specId: flow.spec!.id, specClauses: ['合成 Spec §2 兼容验证'], blockedBy: ['synthetic-local-ticket-1'] }];
  return flow;
}
