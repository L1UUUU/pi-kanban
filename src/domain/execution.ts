import { randomUUID } from 'node:crypto';
import { canonical, digest, invariant } from './store.ts';
import type { ArtifactRef, Demand, ExecutionAxis, ExecutionBinding, ExecutionFlow, ExecutionRepairScope, ExecutionWorkStep, ExecutionWorkerReport, ExecutionUserDecision, ReportVerification, RunAttempt } from './types.ts';

export const STAGED_EXECUTION_ADAPTER = 'implement-spec-staged-v1';
/** Either selected slot opts into fail-closed paired-adapter validation. */
export function isStagedExecution(demand: Demand): boolean { return ['implementation', 'review'].some(stage => demand.methodSnapshot[stage as 'implementation' | 'review']?.adapter === STAGED_EXECUTION_ADAPTER); }
export function requireExecutionMethods(demand: Demand): void { invariant(demand.methodSnapshot.implementation?.adapter === STAGED_EXECUTION_ADAPTER && demand.methodSnapshot.review?.adapter === STAGED_EXECUTION_ADAPTER, 'EXECUTION_METHOD_PAIR_REQUIRED', 'Implementation and review must both select the frozen implement-spec adapter.'); }
function nonempty(value: unknown, name: string): asserts value is string { invariant(typeof value === 'string' && !!value.trim(), 'INVALID_EXECUTION', `${name} must be nonempty.`); }
function artifact(value: ArtifactRef): void { invariant(value && typeof value === 'object', 'INVALID_ARTIFACT', 'Exact execution evidence is required.'); for (const key of ['id', 'digest', 'location'] as const) nonempty(value[key], `evidence.${key}`); }
function approvedInputs(demand: Demand) {
  const planning = demand.planningFlow, plan = demand.plans.find(item => item.id === demand.activePlanId);
  invariant(plan?.ready && demand.confirmedPlanId === plan.id && demand.grant?.planId === plan.id, 'EXECUTION_PLAN_UNAPPROVED', 'Execution requires the exact ready, confirmed and authorized plan.');
  invariant(planning?.step === 'complete' && planning.spec && planning.design && planning.understanding && planning.tickets.length && planning.understandingConfirmation?.digest === planning.understanding.digest && planning.design.understandingDigest === planning.understanding.digest && planning.finalDesignConfirmation?.digest === plan.designBinding?.finalConfirmationDigest && planning.resolution?.digest === planning.finalDesignConfirmation?.digest && planning.resolution?.designDigest === planning.design.digest && plan.designBinding?.flowId === planning.id && plan.designBinding.designDigest === planning.design.digest && plan.designBinding.understandingDigest === planning.understanding.digest, 'EXECUTION_PLANNING_REQUIRED', 'Execution requires the retained approved spec, ticket graph, design and testing seams.');
  invariant(canonical(plan.spec) === canonical(planning.spec.evidence) && planning.spec.designDigest === planning.design.digest, 'EXECUTION_SPEC_MISMATCH', 'Execution must use the exact retained approved spec.');
  artifact(plan.spec); artifact(plan.tickets); artifact(planning.design.evidence);
  const ids = new Set<string>();
  for (const ticket of planning.tickets) {
    artifact(ticket.evidence); nonempty(ticket.id, 'ticket.id'); nonempty(ticket.title, 'ticket.title');
    invariant(ticket.kind === 'ticket' && ticket.specId === planning.spec.id && ticket.specClauses.length > 0 && ticket.specClauses.every(clause => typeof clause === 'string' && !!clause.trim()) && !ids.has(ticket.id) && Array.isArray(ticket.blockedBy) && new Set(ticket.blockedBy).size === ticket.blockedBy.length, 'INVALID_TICKETS', 'Only the approved acyclic local ticket graph may execute.'); ids.add(ticket.id);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => { invariant(!visiting.has(id), 'INVALID_TICKETS', 'Ticket dependencies cannot form a cycle.'); if (visited.has(id)) return; const ticket = planning.tickets.find(item => item.id === id)!; visiting.add(id); for (const dependency of ticket.blockedBy) { invariant(ids.has(dependency) && dependency !== id, 'INVALID_TICKETS', 'Ticket dependencies must name other retained tickets.'); visit(dependency); } visiting.delete(id); visited.add(id); };
  planning.tickets.forEach(ticket => visit(ticket.id));
  invariant(planning.design.testingSeams.length > 0, 'EXECUTION_SEAMS_REQUIRED', 'Retain the approved testing seams before execution.');
  return { planId: plan.id, planningFlowId: planning.id, spec: planning.spec, ticketIndex: plan.tickets, tickets: planning.tickets, design: { id: planning.design.id, digest: planning.design.digest, summary: planning.design.summary, constraints: planning.design.constraints, testingSeams: planning.design.testingSeams, evidence: planning.design.evidence }, understandingConfirmation: planning.understandingConfirmation, finalDesignConfirmation: planning.finalDesignConfirmation, requiredChecks: plan.requiredChecks };
}
export function ensureExecutionFlow(demand: Demand): ExecutionFlow | undefined {
  if (!isStagedExecution(demand) || !demand.activePlanId || demand.confirmedPlanId !== demand.activePlanId || demand.grant?.planId !== demand.activePlanId) return undefined;
  requireExecutionMethods(demand); const approved = approvedInputs(demand), approvedInputDigest = digest(approved), previous = demand.executionFlow;
  if (previous?.planId === approved.planId) { invariant(previous.approvedInputDigest === approvedInputDigest, 'EXECUTION_APPROVAL_CHANGED', 'Approved execution inputs changed; explicitly revise the affected planning scope.'); return previous; }
  const history = previous ? [...previous.history, executionArchive(previous)] : [];
  return demand.executionFlow = { id: `execution_${randomUUID()}`, revision: 1, planId: approved.planId, planningFlowId: approved.planningFlowId, approvedInputDigest, userDecisions: [], step: 'ticket-implementation', scope: 'ticket', ticketId: approved.tickets.find(ticket => !ticket.blockedBy.length)!.id, tickets: approved.tickets.map(ticket => ({ ticketId: ticket.id, status: 'pending', reviewIds: [], resolutionIds: [] })), implementations: [], checkInputIds: [], reviews: [], resolutions: [], repairHistory: [], history };
}
function executionArchive(flow: ExecutionFlow) { const { history: _history, ...archive } = flow; return structuredClone(archive); }
/** Freeze both axes and their focused closures into the immutable delivery C. */
export function executionResultEvidence(demand: Demand) { invariant(demand.executionFlow?.step === 'complete', 'EXECUTION_INCOMPLETE', 'Complete the whole-spec flow before freezing result evidence.'); return executionArchive(demand.executionFlow); }
/** Exact human clarification is writer context, never implicit scope authority. */
export function recordExecutionDecision(demand: Demand, decision: Pick<ExecutionUserDecision, 'id' | 'kind' | 'reason' | 'userId' | 'createdAt' | 'findingId'>): void {
  const flow = demand.executionFlow; if (!flow || flow.planId !== demand.activePlanId) return;
  nonempty(decision.reason, 'execution decision reason'); invariant(decision.reason.length <= 16_000 && (flow.userDecisions?.length ?? 0) < 100, 'EXECUTION_CONTEXT_LIMIT', 'Keep execution clarification within its bounded context.');
  if (decision.findingId) invariant(flow.reviews.some(review => review.findings.some(finding => finding.id === decision.findingId)), 'STALE_EXECUTION_FINDING', 'An execution decision must target a finding in this active result round.');
  (flow.userDecisions ??= []).push({ ...structuredClone(decision), scope: flow.scope, ticketId: flow.ticketId, approvedInputDigest: flow.approvedInputDigest, permitsScopeChange: false }); flow.revision++;
}
/** Keep all prior observations while reopening the whole approved frontier. */
export function reopenExecution(demand: Demand, reason: string): void {
  const flow = demand.executionFlow; if (!flow) return;
  nonempty(reason, 'execution reopen reason'); invariant(reason.length <= 16_000, 'EXECUTION_CONTEXT_LIMIT', 'Keep the exact return instruction within the bounded execution context.');
  const decision = [...demand.acceptances].reverse().find(item => item.decision === 'returned'), rejected = demand.results.find(item => item.id === decision?.resultId);
  invariant(decision && rejected && decision.reason === reason, 'EXECUTION_RETURN_UNBOUND', 'Reopening execution must retain the exact user return and rejected result.');
  flow.history.push(executionArchive(flow)); flow.revision++; flow.step = 'ticket-implementation'; flow.scope = 'ticket'; flow.ticketId = demand.planningFlow!.tickets.find(ticket => !ticket.blockedBy.length)!.id; flow.repairScope = undefined; flow.checkInputIds = [];
  flow.tickets = flow.tickets.map(ticket => ({ ticketId: ticket.ticketId, status: 'pending', reviewIds: [], resolutionIds: [] }));
  // Historical findings retain their truthful dispositions. A new explicit
  // result round owns new records and cannot silently call old findings fixed.
  flow.returnInstruction = { resultId: rejected.id, contentId: rejected.contentId, code: structuredClone(rejected.K), knowledge: structuredClone(rejected.N), reason, userId: decision.userId, createdAt: decision.createdAt };
  flow.reviews = []; flow.resolutions = []; flow.implementations = []; flow.repairHistory = [];
}
/** Serial ticket writers precede whole-spec broad review; repairs receive only focused resolution. */
export function nextExecutionStep(demand: Demand): ExecutionWorkStep | null { const flow = demand.executionFlow; if (!isStagedExecution(demand) || !flow || flow.planId !== demand.activePlanId || flow.step === 'complete') return null; const ids = new Set(flow.reviews.flatMap(review => review.findings.map(finding => finding.id))); if (demand.findings.some(finding => ids.has(finding.id) && finding.severity === 'decision' && finding.status !== 'closed')) return null; return flow.step; }
function currentContent(demand: Demand) { const value = demand.contents.find(item => item.id === demand.activeContentId); return value ? { id: value.id, planId: value.planId, code: value.code, knowledge: value.knowledge, maintenance: value.maintenance } : undefined; }
function axisFor(step: ExecutionWorkStep): ExecutionAxis { return step.endsWith('standards') ? 'standards' : 'spec'; }
/** Deliberately excludes chat, writer summaries and other-axis review output.
 * Fresh broad reviewers receive the same K and approved factual inputs. */
export function executionInputs(demand: Demand, step: ExecutionWorkStep) {
  const flow = demand.executionFlow; invariant(flow && flow.planId === demand.activePlanId, 'EXECUTION_FLOW_REQUIRED', 'The current persisted execution flow is required.');
  const approved = approvedInputs(demand); invariant(digest(approved) === flow.approvedInputDigest, 'EXECUTION_APPROVAL_CHANGED', 'The exact approved execution inputs must remain unchanged.');
  const content = currentContent(demand), ticket = flow.scope === 'ticket' ? approved.tickets.find(item => item.id === flow.ticketId) : undefined;
  invariant(flow.scope !== 'ticket' || ticket, 'EXECUTION_TICKET_REQUIRED', 'The current ticket must exist in the retained approved graph.');
  invariant(step === 'ticket-implementation' || content, 'EXECUTION_CONTENT_REQUIRED', 'Review and repair require the exact retained current content.');
  const focused = step.startsWith('resolution-'), fixing = step === 'ticket-fix', repair = flow.repairScope;
  invariant(!(focused || fixing) || repair, 'EXECUTION_REPAIR_REQUIRED', 'A repair must bind its explicit retained scope.');
  const findingIds = repair?.findingIds ?? [], axis = axisFor(step);
  const targetedReviews = focused || fixing ? flow.reviews.filter(review => repair!.reviewIds.includes(review.id) && (!focused || review.axis === axis)).map(review => ({ id: review.id, axis: review.axis, contentId: review.contentId, findings: review.findings.filter(finding => findingIds.includes(finding.id)) })) : undefined;
  const repairBase = repair ? demand.contents.find(item => item.id === repair.baseContentId) : undefined;
  const repairContent = focused ? flow.implementations.find(item => item.contentId === content?.id && item.repairScopeId === repair?.id) : undefined;
  const priorDispositions = fixing ? flow.resolutions.flatMap(resolution => resolution.dispositions.filter(disposition => findingIds.includes(disposition.findingId)).map(disposition => ({ resolutionId: resolution.id, axis: resolution.axis, contentId: resolution.contentId, ...disposition }))) : undefined;
  return { flowId: flow.id, flowRevision: flow.revision, step, scope: flow.scope, ticketId: flow.ticketId, approved, baseCommit: flow.baseCommit, content, ...(step === 'ticket-implementation' || fixing ? { returnInstruction: flow.returnInstruction, userDecisions: (flow.userDecisions ?? []).filter(decision => decision.approvedInputDigest === flow.approvedInputDigest && (decision.scope === 'whole-spec' || decision.ticketId === flow.ticketId)) } : {}), ...(focused || fixing ? { repairScope: { ...repair!, findingIds: focused ? targetedReviews!.flatMap(review => review.findings.map(finding => finding.id)) : findingIds, reviewIds: targetedReviews!.map(review => review.id) }, targetedReviews, ...(fixing ? { priorDispositions } : {}), ...(repairContent ? { repairEvidence: { contentId: repairContent.contentId, mode: repairContent.tdd.mode, testingSeams: repairContent.tdd.testingSeams, red: repairContent.tdd.red, green: repairContent.tdd.green } } : {}), repairBase: repairBase ? { id: repairBase.id, code: repairBase.code, knowledge: repairBase.knowledge } : undefined } : {}), ...(step.startsWith('review-') || focused ? { checks: demand.checks.filter(check => flow.checkInputIds.includes(check.id) && check.contentId === content?.id) } : {}) };
}
export function executionInputDigest(demand: Demand, step: ExecutionWorkStep): string { return digest(executionInputs(demand, step)); }
export function executionArtifactRefs(demand: Demand, step: ExecutionWorkStep): ArtifactRef[] {
  const inputs = executionInputs(demand, step), refs: ArtifactRef[] = [];
  const walk = (value: unknown): void => { if (!value || typeof value !== 'object') return; if ('id' in value && 'digest' in value && 'location' in value && typeof value.id === 'string' && typeof value.digest === 'string' && typeof value.location === 'string') { refs.push(value as ArtifactRef); return; } for (const child of Object.values(value)) walk(child); };
  walk(inputs); return [...new Map(refs.map(ref => [`${ref.id}:${ref.digest}:${ref.location}`, ref])).values()];
}
export function assertExecutionBinding(demand: Demand, run: RunAttempt, binding: Partial<Omit<ExecutionBinding, 'scope'>> & { scope?: unknown }): void {
  const flow = demand.executionFlow;
  invariant(flow && isStagedExecution(demand), 'EXECUTION_FLOW_REQUIRED', 'Staged execution requires its persisted flow.'); requireExecutionMethods(demand);
  invariant(run.executionStep && run.stage !== 'planning', 'EXECUTION_STEP_MISMATCH', 'An exact claimed execution step is required.');
  invariant(binding.flowId === flow.id && binding.flowRevision === flow.revision && binding.executionStep === flow.step && binding.scope === flow.scope && binding.ticketId === flow.ticketId && binding.contentId === demand.activeContentId && binding.inputDigest === executionInputDigest(demand, run.executionStep!), 'STALE_EXECUTION', 'Report must bind the exact execution flow, revision, step, ticket, approved inputs and current K.');
  invariant(run.executionFlowId === flow.id && run.executionRevision === flow.revision && run.executionStep === flow.step && run.executionScope === flow.scope && run.executionTicketId === flow.ticketId && run.planId === flow.planId, 'EXECUTION_STEP_MISMATCH', 'Only the exact claimed execution context can advance this step.');
}
function verifyStage(demand: Demand, run: RunAttempt, binding: ExecutionBinding, verification: ReportVerification): void {
  assertExecutionBinding(demand, run, binding); const flow = demand.executionFlow!, observed = verification.executionStage;
  invariant(observed && observed.runId === run.id && observed.flowId === flow.id && observed.flowRevision === flow.revision && observed.executionStep === run.executionStep && observed.inputDigest === binding.inputDigest && observed.sourceVerified && observed.requiredSkillVerified && observed.actualRunObserved && observed.actualStopVerified, 'EXECUTION_STAGE_UNVERIFIED', 'Host must verify exact inputs, frozen required skills, source, model run and actual stop.');
  nonempty(observed.baseCommit, 'base commit'); invariant(!flow.baseCommit || flow.baseCommit === observed.baseCommit, 'EXECUTION_BASE_CHANGED', 'The Host-owned base commit is immutable throughout the execution flow.');
  invariant(verification.artifactsVerified, 'ARTIFACTS_UNVERIFIED', 'Host must verify every exact execution artifact.');
}
function independent(demand: Demand, run: RunAttempt, axis: ExecutionAxis, evidence: ArtifactRef, verification: ReportVerification): void {
  const flow = demand.executionFlow!, observed = verification.executionIndependent;
  invariant(run.stage === 'review' && !run.writer && observed && observed.axis === axis && observed.runId === run.id && observed.contextId === run.contextId && observed.flowId === flow.id && observed.flowRevision === flow.revision && observed.contentId === demand.activeContentId && observed.inputDigest === executionInputDigest(demand, run.executionStep!) && observed.evidenceDigest === evidence.digest && observed.actualRunObserved && observed.isolatedInputsVerified && observed.readOnlyVerified && verification.reviewInputsVerified && verification.contentStable, 'EXECUTION_INDEPENDENCE_UNVERIFIED', 'Host must verify a fresh isolated read-only reviewer on the identical frozen K and exact bounded inputs.');
}
function scopeReviews(flow: ExecutionFlow) { return flow.reviews.filter(review => review.scope === flow.scope && review.ticketId === flow.ticketId); }
function openScopeFindings(demand: Demand) { const flow = demand.executionFlow!, ids = new Set(scopeReviews(flow).flatMap(review => review.findings.map(finding => finding.id))); return demand.findings.filter(finding => ids.has(finding.id) && finding.severity !== 'suggestion' && finding.status !== 'closed'); }
function repairHasAxis(flow: ExecutionFlow, axis: ExecutionAxis): boolean { return flow.reviews.filter(review => flow.repairScope!.reviewIds.includes(review.id) && review.axis === axis).some(review => review.findings.some(finding => flow.repairScope!.findingIds.includes(finding.id))); }
function makeRepair(demand: Demand, checkIds: string[] = []): void {
  const flow = demand.executionFlow!, previous = flow.repairScope;
  const repair: ExecutionRepairScope = { id: `repair_${randomUUID()}`, scope: flow.scope, ticketId: flow.ticketId, baseContentId: demand.activeContentId!, reviewIds: previous?.reviewIds ?? scopeReviews(flow).filter(review => review.contentId === demand.activeContentId).map(review => review.id), findingIds: openScopeFindings(demand).map(finding => finding.id), checkIds, reason: checkIds.length ? 'Verified required checks failed.' : 'Resolve the exact recorded review findings without changing approved scope or testing seams.' };
  flow.repairScope = repair; flow.repairHistory.push(structuredClone(repair)); flow.step = 'ticket-fix'; const ticket = flow.tickets.find(item => item.ticketId === flow.ticketId); if (ticket) ticket.status = 'repairing';
}
function finishScope(demand: Demand): void {
  const flow = demand.executionFlow!;
  if (flow.scope === 'whole-spec') { flow.step = 'complete'; flow.repairScope = undefined; return; }
  const ticket = flow.tickets.find(item => item.ticketId === flow.ticketId)!; ticket.status = 'done'; ticket.completedContentId = demand.activeContentId;
  const approved = demand.planningFlow!.tickets, next = flow.tickets.find(item => item.status !== 'done' && approved.find(source => source.id === item.ticketId)!.blockedBy.every(id => flow.tickets.some(prior => prior.ticketId === id && prior.status === 'done')));
  flow.repairScope = undefined;
  if (next) { flow.ticketId = next.ticketId; flow.step = 'ticket-implementation'; }
  else { invariant(flow.tickets.every(item => item.status === 'done'), 'EXECUTION_FRONTIER_BLOCKED', 'No eligible ticket exists in the incomplete graph.'); flow.scope = 'whole-spec'; flow.ticketId = undefined; flow.step = 'review-standards'; }
}
/** Existing actual checks still gate terminal whole-spec review. Missing evidence
 * leaves the terminal report unapplied; it never creates speculative repair. */
function finishOrRepair(demand: Demand, requiredCheckIds: string[]): void {
  const openFindings = openScopeFindings(demand);
  if (demand.executionFlow!.scope === 'whole-spec') {
    const checks = requiredCheckIds.map(id => [...demand.checks].reverse().find(check => check.requirementId === id && check.contentId === demand.activeContentId));
    const failed = checks.filter(check => check?.status === 'failed').map(check => check!.requirementId);
    if (openFindings.length) { makeRepair(demand, failed); return; }
    invariant(checks.every(check => check && check.status !== 'unavailable'), 'EXECUTION_CHECKS_MISSING', 'Actual required check evidence must be present before completing whole-spec review.');
    if (failed.length) { makeRepair(demand, failed); return; }
  }
  if (openFindings.length) { makeRepair(demand); return; }
  finishScope(demand);
}
export function applyExecutionReport(demand: Demand, run: RunAttempt, report: ExecutionWorkerReport, verification: ReportVerification, requiredCheckIds: string[] = []): void {
  verifyStage(demand, run, report, verification); const flow = demand.executionFlow!;
  const ticket = flow.tickets.find(item => item.ticketId === flow.ticketId);
  if (report.type === 'execution-content') {
    invariant(run.stage === 'implementation' && run.writer && ['ticket-implementation', 'ticket-fix'].includes(flow.step), 'EXECUTION_STEP_MISMATCH', 'Only the serial writer may submit implementation or scoped repair content.');
    invariant(flow.step !== 'ticket-implementation' || (ticket && demand.planningFlow!.tickets.find(item => item.id === ticket.ticketId)!.blockedBy.every(id => flow.tickets.some(item => item.ticketId === id && item.status === 'done'))), 'EXECUTION_FRONTIER_BLOCKED', 'Only an eligible frontier ticket may execute.');
    invariant(flow.step !== 'ticket-fix' || (flow.repairScope && report.repairScopeId === flow.repairScope.id), 'EXECUTION_REPAIR_REQUIRED', 'Repair output must bind the exact Host-owned repair scope.');
    invariant(flow.step !== 'ticket-implementation' || !report.repairScopeId, 'EXECUTION_REPAIR_MISMATCH', 'An implementation cannot claim a repair scope.');
    const content = report.content; nonempty(content.id, 'content.id'); nonempty(content.deliveryNotes, 'delivery notes'); artifact(content.code); invariant(Array.isArray(content.knowledge), 'INVALID_EXECUTION', 'Local material references must be explicit.'); content.knowledge.forEach(artifact);
    invariant(content.planId === flow.planId && verification.contentStable && ['complete', 'not-needed'].includes(content.maintenance), 'CONTENT_UNVERIFIED', 'Content must preserve the exact plan and verified stable code and local material maintenance.');
    invariant(!demand.contents.some(item => item.id === content.id), 'CONTENT_CONFLICT', 'Execution content IDs are immutable and cannot be reused.');
    invariant(report.tdd && Array.isArray(report.tdd.testingSeams) && report.tdd.testingSeams.length > 0 && new Set(report.tdd.testingSeams).size === report.tdd.testingSeams.length && report.tdd.testingSeams.every(seam => demand.planningFlow!.design!.testingSeams.includes(seam)), 'EXECUTION_TDD_SEAMS_UNBOUND', 'TDD must use explicit exact approved testing seams; changed seams require revising the design.');
    invariant(report.tdd.mode === 'red-green' || report.tdd.mode === 'preserve-behavior', 'EXECUTION_TDD_REQUIRED', 'An explicit verified testing mode is required.');
    if (report.tdd.mode === 'preserve-behavior') {
      nonempty(report.tdd.rationale, 'behavior-preserving repair rationale');
      invariant(flow.step === 'ticket-fix' && flow.repairScope && flow.repairScope.checkIds.length === 0 && flow.repairScope.findingIds.length > 0 && flow.reviews.filter(review => flow.repairScope!.reviewIds.includes(review.id)).flatMap(review => review.findings).filter(finding => flow.repairScope!.findingIds.includes(finding.id)).every(finding => finding.category === 'documented-violation' && !finding.requiresDesignDecision), 'EXECUTION_TDD_BEHAVIOR_REQUIRED', 'Only scoped behavior-preserving Standards repairs may omit red evidence. Spec or check repairs require red and green.');
    }
    for (const kind of ['red', 'green'] as const) { invariant(Array.isArray(report.tdd[kind]) && (kind === 'red' && report.tdd.mode === 'preserve-behavior' ? report.tdd[kind].length === 0 : report.tdd[kind].length > 0), 'EXECUTION_TDD_REQUIRED', 'Actual observed testing evidence must match the selected testing mode.'); report.tdd[kind].forEach(artifact); }
    invariant(verification.executionStage?.tddVerified, 'EXECUTION_TDD_UNVERIFIED', 'Host must verify actual failed and passing test receipts against the ticket, approved seams and current content.');
    demand.contents.push({ ...structuredClone(content), cycle: demand.cycle, createdByRun: run.id }); demand.activeContentId = content.id;
    flow.implementations.push({ contentId: content.id, scope: flow.scope, ticketId: flow.ticketId, runId: run.id, inputDigest: report.inputDigest, flowRevision: flow.revision, tdd: structuredClone(report.tdd), ...(report.repairScopeId ? { repairScopeId: report.repairScopeId } : {}) });
    if (ticket) { ticket.contentId = content.id; ticket.status = flow.step === 'ticket-fix' ? 'repairing' : 'reviewing'; }
    if (flow.step === 'ticket-fix') flow.step = repairHasAxis(flow, 'standards') ? 'resolution-standards' : 'resolution-spec'; else finishScope(demand);
  } else if (report.type === 'execution-review') {
    const review = report.review; nonempty(review.id, 'review.id'); artifact(review.evidence);
    invariant(flow.scope === 'whole-spec' && flow.tickets.every(item => item.status === 'done') && flow.step === `review-${review.axis}` && review.contentId === demand.activeContentId && review.knowledgeReviewed && Array.isArray(review.findings), 'EXECUTION_STEP_MISMATCH', 'The review must cover the selected axis and exact current K and local materials.');
    independent(demand, run, review.axis, review.evidence, verification);
    invariant(!flow.reviews.some(item => item.id === review.id) && !demand.reviews.some(item => item.id === review.id), 'CONTENT_CONFLICT', 'Review records are immutable.');
    if (review.axis === 'spec') invariant(scopeReviews(flow).some(item => item.axis === 'standards' && item.contentId === review.contentId), 'EXECUTION_AXIS_ORDER', 'The independent Standards pass on the identical K must precede the Spec pass.');
    for (const finding of review.findings) {
      for (const key of ['id', 'location', 'basis', 'impact', 'verification'] as const) nonempty(finding[key], `finding.${key}`); artifact(finding.reference);
      invariant(!demand.findings.some(item => item.id === finding.id), 'CONTENT_CONFLICT', 'Finding IDs cannot be reused.');
      invariant(['blocking', 'suggestion', 'decision'].includes(finding.severity) && typeof finding.requiresDesignDecision === 'boolean', 'INVALID_EXECUTION_FINDING', 'Finding severity and design-decision classification are required.');
      invariant(review.axis === 'standards' ? ['documented-violation', 'smell'].includes(finding.category) : finding.category === 'spec-violation', 'EXECUTION_FINDING_AXIS', 'Standards violations and smells are distinct from spec violations.');
      invariant(finding.category !== 'smell' || finding.severity === 'suggestion', 'EXECUTION_SMELL_NOT_VIOLATION', 'An undocumented smell is advisory, not a mandatory violation.');
      invariant(!finding.requiresDesignDecision || finding.severity === 'decision', 'USER_DECISION_REQUIRED', 'Behavior, design or testing-seam changes require a recorded user decision.');
      if (finding.category === 'spec-violation') { nonempty(finding.clause, 'spec clause'); invariant(canonical(finding.reference) === canonical(demand.planningFlow!.spec!.evidence) && (flow.scope === 'whole-spec' || demand.planningFlow!.tickets.find(item => item.id === flow.ticketId)!.specClauses.includes(finding.clause)), 'EXECUTION_SPEC_FINDING_UNBOUND', 'Spec findings must cite the exact approved spec and an in-scope clause.'); }
      demand.findings.push({ ...structuredClone(finding), contentId: review.contentId, reviewRunId: run.id, status: 'open' });
      if (finding.severity === 'decision') demand.blockedReasons.push(`User decision required: ${finding.id}`);
    }
    flow.reviews.push({ ...structuredClone(review), sequence: flow.reviews.length + flow.resolutions.length + 1, scope: flow.scope, ticketId: flow.ticketId, runId: run.id, contextId: run.contextId, inputDigest: report.inputDigest, flowRevision: flow.revision }); ticket?.reviewIds.push(review.id);
    demand.reviews.push({ id: review.id, contentId: review.contentId, runId: run.id, contextId: run.contextId, evidence: structuredClone(review.evidence), knowledgeReviewed: true, findings: review.findings.map(finding => finding.id) });
    if (review.axis === 'standards') flow.step = 'review-spec'; else finishOrRepair(demand, requiredCheckIds);
  } else {
    const resolution = report.resolution; nonempty(resolution.id, 'resolution.id'); artifact(resolution.evidence);
    invariant(flow.step === `resolution-${resolution.axis}` && resolution.contentId === demand.activeContentId && flow.repairScope?.id === resolution.repairScopeId && Array.isArray(resolution.dispositions), 'EXECUTION_STEP_MISMATCH', 'Focused resolution must bind the selected axis, repaired K and exact prior repair scope.');
    independent(demand, run, resolution.axis, resolution.evidence, verification);
    invariant(!flow.resolutions.some(item => item.id === resolution.id) && !demand.reviews.some(item => item.id === resolution.id), 'CONTENT_CONFLICT', 'Resolution records are immutable.');
    const selected = flow.reviews.filter(review => flow.repairScope!.reviewIds.includes(review.id) && review.axis === resolution.axis).flatMap(review => review.findings).filter(finding => flow.repairScope!.findingIds.includes(finding.id));
    invariant(resolution.dispositions.length === selected.length && new Set(resolution.dispositions.map(item => item.findingId)).size === selected.length, 'EXECUTION_RESOLUTION_SCOPE', 'Focused resolution must address every exact selected finding once and cannot add broad new findings.');
    for (const disposition of resolution.dispositions) {
      const original = selected.find(item => item.id === disposition.findingId), finding = demand.findings.find(item => item.id === disposition.findingId); invariant(original && finding, 'EXECUTION_RESOLUTION_SCOPE', 'Resolution references a finding outside its focused scope.'); nonempty(disposition.rationale, 'resolution rationale'); artifact(disposition.evidence);
      invariant(['fixed', 'false-positive', 'not-applicable', 'unresolved'].includes(disposition.outcome), 'INVALID_EXECUTION', 'Unknown focused resolution outcome.');
      invariant(finding.severity !== 'decision' || finding.status === 'closed', 'USER_DECISION_REQUIRED', 'Independent resolution cannot decide a human scope or design tradeoff.');
      if (disposition.outcome !== 'unresolved' && finding.status !== 'closed') { finding.status = 'closed'; finding.resolution = structuredClone(disposition.evidence); }
    }
    flow.resolutions.push({ ...structuredClone(resolution), sequence: flow.reviews.length + flow.resolutions.length + 1, scope: flow.scope, ticketId: flow.ticketId, runId: run.id, contextId: run.contextId, inputDigest: report.inputDigest, flowRevision: flow.revision }); ticket?.resolutionIds.push(resolution.id);
    demand.reviews.push({ id: resolution.id, contentId: resolution.contentId, runId: run.id, contextId: run.contextId, evidence: structuredClone(resolution.evidence), knowledgeReviewed: true, findings: selected.map(finding => finding.id) });
    if (resolution.axis === 'standards' && (repairHasAxis(flow, 'spec') || flow.repairScope!.checkIds.length > 0)) flow.step = 'resolution-spec'; else finishOrRepair(demand, requiredCheckIds);
  }
  flow.baseCommit ??= verification.executionStage!.baseCommit; flow.checkInputIds = demand.checks.filter(check => check.contentId === demand.activeContentId).map(check => check.id); flow.revision++;
}
