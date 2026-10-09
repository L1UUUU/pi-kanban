import { randomUUID } from 'node:crypto';
import { digest, invariant } from './store.ts';
import type { ArtifactRef, Demand, DemandMessage, PlanningBinding, PlanningFlow, PlanningQuestionInput, PlanningUserCommand, PlanningWorkStep, PlanningWorkerReport, ReportVerification, RunAttempt } from './types.ts';

export const STAGED_PLANNING_ADAPTER = 'design-feature-staged-v1';
export function isStagedPlanning(demand: Demand): boolean { return demand.methodSnapshot.planning?.adapter === STAGED_PLANNING_ADAPTER; }
function nonempty(value: unknown, name: string): asserts value is string { invariant(typeof value === 'string' && !!value.trim(), 'INVALID_PLANNING', `${name} must be nonempty.`); }
function strings(value: unknown, name: string, required = false): asserts value is string[] { invariant(Array.isArray(value) && (!required || value.length > 0), 'INVALID_PLANNING', `${name} must be an explicit array.`); value.forEach(item => nonempty(item, name)); }
function artifact(value: ArtifactRef): void { invariant(value && typeof value === 'object', 'INVALID_ARTIFACT', 'Planning evidence is required.'); nonempty(value.id, 'evidence.id'); nonempty(value.digest, 'evidence.digest'); nonempty(value.location, 'evidence.location'); }
export function ensurePlanningFlow(demand: Demand): PlanningFlow | undefined {
  if (!isStagedPlanning(demand) || !demand.planningStarted) return undefined;
  if (demand.planningFlow) return demand.planningFlow;
  const messages = demand.messages.map(({ id, text, kind }) => ({ id, text, kind }));
  validateMessages(messages);
  return demand.planningFlow = { id: `planning_${randomUUID()}`, revision: 1, step: 'facts', history: [], messages, questions: [], answers: [], confirmations: [], tickets: [] };
}
function flowFor(demand: Demand, binding: PlanningBinding): PlanningFlow {
  invariant(isStagedPlanning(demand) && demand.planningFlow, 'STAGED_PLANNING_REQUIRED', 'This command/report requires the staged planning adapter.');
  const flow = demand.planningFlow;
  invariant(binding.flowId === flow.id && binding.flowRevision === flow.revision, 'STALE_PLANNING', 'The exact displayed planning version is required.');
  return flow;
}
export function unansweredPlanningQuestions(flow: PlanningFlow) {
  return flow.questions.filter(question => !flow.answers.some(answer => answer.questionId === question.id && answer.questionDigest === question.digest));
}
export function nextPlanningStep(demand: Demand): PlanningWorkStep | null {
  const flow = demand.planningFlow;
  if (!isStagedPlanning(demand) || !flow || unansweredPlanningQuestions(flow).length) return null;
  return ['awaiting-understanding-confirmation', 'awaiting-final-design-confirmation', 'complete'].includes(flow.step) ? null : flow.step as PlanningWorkStep;
}
/** The only domain material allowed into a fresh step context. Host additionally
 * verifies exact source bytes, role isolation, and the current named skill. */
export function planningInputs(demand: Demand, step: PlanningWorkStep): Record<string, unknown> {
  const flow = demand.planningFlow;
  invariant(flow, 'STAGED_PLANNING_REQUIRED', 'Planning flow is missing.');
  const common = { flowId: flow.id, flowRevision: flow.revision, step, methodDigest: demand.methodSnapshot.planning?.digest };
  if (step === 'facts') return { ...common, title: demand.title, description: demand.description };
  if (step === 'clarification') return { ...common, messages: flow.messages, title: demand.title, description: demand.description, facts: flow.facts, revisionInstruction: flow.revisionInstruction, understanding: flow.understanding, questions: flow.questions, answers: flow.answers };
  const messages = flow.messages;
  const confirmed = { understanding: flow.understanding, understandingConfirmation: flow.understandingConfirmation };
  if (step === 'design') return { ...common, messages, ...confirmed, facts: flow.facts, revisionInstruction: flow.revisionInstruction, questions: flow.questions, answers: flow.answers };
  if (step === 'design-review') return { ...common, ...confirmed, design: flow.design };
  if (step === 'design-resolution') return { ...common, messages, ...confirmed, design: flow.design, review: flow.review, revisionInstruction: flow.revisionInstruction, questions: flow.questions, answers: flow.answers };
  const final = { ...confirmed, design: flow.design, review: flow.review, resolution: flow.resolution, finalDesignConfirmation: flow.finalDesignConfirmation };
  if (step === 'spec') return { ...common, messages, ...final };
  return { ...common, messages, ...final, spec: flow.spec };
}
export const planningInput = planningInputs;
export function planningInputDigest(demand: Demand, step: PlanningWorkStep): string { return digest(planningInputs(demand, step)); }
export function planningArtifactRefs(demand: Demand, step: PlanningWorkStep): ArtifactRef[] {
  const inputs = planningInputs(demand, step), refs: ArtifactRef[] = [];
  for (const name of ['facts', 'understanding', 'design', 'review', 'resolution', 'spec']) {
    const evidence = (inputs[name] as { evidence?: ArtifactRef } | undefined)?.evidence;
    if (evidence && !refs.some(ref => ref.id === evidence.id)) refs.push(evidence);
  }
  return refs;
}
function questions(flow: PlanningFlow, inputs: PlanningQuestionInput[], scope?: PlanningQuestionInput['scope']): void {
  invariant(Array.isArray(inputs), 'INVALID_PLANNING', 'Questions must be an explicit array.');
  const ids = new Set<string>();
  flow.questions = inputs.map(input => {
    nonempty(input.id, 'question.id'); nonempty(input.question, 'question'); nonempty(input.basis, 'question.basis');
    invariant(!ids.has(input.id), 'INVALID_PLANNING', 'Question IDs must be unique in a round.'); ids.add(input.id);
    invariant(['requirements', 'design'].includes(input.scope) && (!scope || scope === input.scope), 'INVALID_PLANNING', 'Question scope must match the affected decision.');
    if (input.findingId) invariant(flow.review?.findings.some(finding => finding.id === input.findingId), 'INVALID_PLANNING', 'A question must reference a finding in the current review.');
    const questionDigest = digest(input);
    invariant(!flow.answers.some(answer => answer.questionId === input.id && answer.questionDigest !== questionDigest), 'QUESTION_ID_CONFLICT', 'A question ID cannot change within an active decision scope; use a new question or explicitly revise the affected scope.');
    return { ...structuredClone(input), digest: questionDigest };
  });
}
function invalidateDownstream(demand: Demand, scope: 'requirements' | 'design'): void {
  const flow = demand.planningFlow!;
  invariant(!demand.activeResultId, 'RESULT_PROTECTED', 'Return the current result before changing planning decisions.');
  const { history, ...previous } = flow; flow.history.push(structuredClone(previous));
  flow.answers = scope === 'requirements' ? [] : flow.answers.filter(answer => answer.scope === 'requirements');
  if (scope === 'requirements') { flow.understandingConfirmation = undefined; flow.step = flow.facts ? 'clarification' : 'facts'; }
  else flow.step = 'design';
  flow.design = undefined; flow.review = undefined; flow.resolution = undefined; flow.finalDesignConfirmation = undefined; flow.spec = undefined; flow.tickets = []; flow.questions = [];
  demand.activePlanId = undefined; demand.confirmedPlanId = undefined; demand.grant = undefined; demand.activeContentId = undefined;
}
export function resetPlanning(demand: Demand, scope: 'requirements' | 'design'): void {
  invariant(scope === 'requirements' || scope === 'design', 'INVALID_PLANNING', 'Select the affected requirement or design scope.');
  invariant(scope !== 'design' || demand.planningFlow?.understandingConfirmation, 'UNDERSTANDING_UNCONFIRMED', 'Confirm requirements before revising a design.');
  invalidateDownstream(demand, scope); demand.planningFlow!.revision++;
}
function validateMessages(messages: Pick<DemandMessage, 'id' | 'text' | 'kind'>[]): void {
  invariant(messages.length <= 100 && messages.every(message => message.text.length <= 16_000) && messages.reduce((sum, item) => sum + item.text.length, 0) <= 64_000, 'PLANNING_CONTEXT_LIMIT', 'Planning context is bounded; use a focused question or revision instead of adding more conversation.');
}
export function applyPlanningMessage(demand: Demand, message: Pick<DemandMessage, 'id' | 'text' | 'kind'>, userId: string, createdAt: string): void {
  const flow = demand.planningFlow!;
  validateMessages([...flow.messages, message]);
  if (message.kind === 'change-request') {
    invariant(demand.control !== 'cancelled', 'CANCELLED', 'Cancelled planning cannot be revised.');
    resetPlanning(demand, 'requirements');
    flow.revisionInstruction = { scope: 'requirements', reason: message.text, userId, createdAt };
  } else flow.revision++;
  flow.messages.push(structuredClone(message));
}
export function applyPlanningCommand(demand: Demand, command: PlanningUserCommand, userId: string, createdAt: string): 'applied' | 'noop' {
  const flow = flowFor(demand, command);
  invariant(demand.control !== 'cancelled', 'CANCELLED', 'Cancelled planning cannot be changed.');
  switch (command.type) {
    case 'answer-planning-question': {
      const question = flow.questions.find(question => question.id === command.questionId && question.digest === command.questionDigest);
      invariant(question, 'STALE_QUESTION', 'Answer the exact currently displayed question.'); nonempty(command.answer, 'answer');
      const prior = flow.answers.find(answer => answer.questionId === question.id && answer.questionDigest === question.digest);
      if (prior) { invariant(prior.answer === command.answer, 'ANSWER_REQUIRES_REVISION', 'Reopen the affected planning decision before changing a saved answer.'); return 'noop'; }
      flow.answers.push({ scope: question.scope, questionId: question.id, question: question.question, questionDigest: question.digest, ...(question.findingId ? {findingId: question.findingId, reviewId: flow.review!.id} : {}), answer: command.answer, userId, createdAt }); break;
    }
    case 'confirm-understanding': {
      invariant(flow.understanding?.id === command.understandingId && flow.understanding.digest === command.digest, 'STALE_UNDERSTANDING', 'Confirmation must bind the displayed requirement version and digest.');
      if (flow.understandingConfirmation?.digest === command.digest) return 'noop';
      invariant(flow.step === 'awaiting-understanding-confirmation' && !unansweredPlanningQuestions(flow).length, 'UNDERSTANDING_NOT_READY', 'Resolve requirement questions before confirming understanding.');
      const confirmation = { kind: 'understanding' as const, targetId: command.understandingId, digest: command.digest, flowRevision: flow.revision, userId, createdAt };
      flow.confirmations.push(confirmation); flow.understandingConfirmation = confirmation; flow.step = 'design'; break;
    }
    case 'confirm-final-design': {
      invariant(flow.design?.id === command.designId && flow.resolution?.digest === command.digest, 'STALE_DESIGN', 'Confirm the exact reviewed design, resolutions, and testing seams.');
      if (flow.finalDesignConfirmation?.digest === command.digest) return 'noop';
      invariant(flow.step === 'awaiting-final-design-confirmation' && !unansweredPlanningQuestions(flow).length && flow.review && flow.understandingConfirmation?.digest === flow.understanding?.digest, 'DESIGN_NOT_READY', 'Independent review and its decisions must be resolved before final confirmation.');
      const confirmation = { kind: 'final-design' as const, targetId: command.designId, digest: command.digest, flowRevision: flow.revision, userId, createdAt };
      flow.confirmations.push(confirmation); flow.finalDesignConfirmation = confirmation; flow.step = 'spec'; break;
    }
    case 'revise-planning': nonempty(command.reason, 'revision reason'); invariant(command.reason.length <= 16_000, 'PLANNING_CONTEXT_LIMIT', 'Provide a bounded revision instruction.'); resetPlanning(demand, command.scope); flow.revisionInstruction = { scope: command.scope, reason: command.reason, userId, createdAt }; return 'applied';
  }
  flow.revision++; return 'applied';
}
function stageVerification(demand: Demand, run: RunAttempt, verification: ReportVerification): void {
  const flow = demand.planningFlow!, observed = verification.planningStage;
  invariant(run.stage === 'planning' && run.planningStep && run.planningStep === flow.step && run.planningFlowId === flow.id && run.planningRevision === flow.revision, 'PLANNING_STEP_MISMATCH', 'Only the exact claimed planning step can submit this handoff.');
  invariant(observed && observed.runId === run.id && observed.planningStep === run.planningStep && observed.flowId === flow.id && observed.flowRevision === flow.revision && observed.inputDigest === planningInputDigest(demand, run.planningStep) && observed.sourceVerified && observed.requiredSkillVerified && observed.actualRunObserved && observed.actualStopVerified, 'PLANNING_STAGE_UNVERIFIED', 'Host must verify exact step inputs, source, observed model run, and required skill invocation.');
}
function independent(demand: Demand, run: RunAttempt, evidence: ArtifactRef, verification: ReportVerification, kind: 'facts' | 'design-review') {
  const flow = demand.planningFlow!, observed = verification.planningIndependent;
  invariant(observed && observed.kind === kind && observed.runId === run.id && observed.contextId === run.contextId && observed.flowId === flow.id && observed.flowRevision === flow.revision && observed.inputDigest === planningInputDigest(demand, kind) && observed.evidenceDigest === evidence.digest && observed.actualRunObserved && observed.isolatedInputsVerified && observed.readOnlyVerified, 'PLANNING_INDEPENDENCE_UNVERIFIED', 'Host must observe a fresh isolated read-only context and exact inputs/evidence.');
  invariant(kind !== 'design-review' || (flow.design && flow.design.createdByRun !== run.id && flow.understanding?.createdByRun !== run.id && flow.design.contextId !== run.contextId && flow.understanding?.contextId !== run.contextId), 'REVIEW_NOT_INDEPENDENT', 'The reviewer cannot be a designer or clarifier run.');
  return observed;
}
function requireFinal(flow: PlanningFlow): void {
  invariant(flow.understanding && flow.understandingConfirmation?.digest === flow.understanding.digest && flow.design?.understandingDigest === flow.understanding.digest && flow.review?.designDigest === flow.design.digest && flow.resolution?.designDigest === flow.design.digest && flow.resolution.reviewId === flow.review.id && flow.finalDesignConfirmation?.digest === flow.resolution.digest, 'DESIGN_UNCONFIRMED', 'Current requirements and independently reviewed final design must both be explicitly confirmed.');
}
/** Called inside WorkflowService's single SQLite transaction. It never launches
 * work, supplies an execution grant, or publishes to an external tracker. */
export function applyPlanningReport(demand: Demand, run: RunAttempt, report: PlanningWorkerReport, verification: ReportVerification): void {
  const flow = flowFor(demand, report); stageVerification(demand, run, verification);
  invariant(verification.artifactsVerified || report.type === 'planning-questions', 'ARTIFACTS_UNVERIFIED', 'Host must verify every exact planning artifact.');
  if (report.type === 'planning-questions') {
    invariant(!['facts', 'design-review'].includes(run.planningStep!), 'ROLE_FORBIDDEN', 'Independent contexts only report their bounded evidence.');
    invariant(report.questions.length > 0, 'INVALID_PLANNING', 'Reopening a decision requires explicit questions.');
    invariant(report.scope === 'requirements' || report.scope === 'design', 'INVALID_PLANNING', 'Question scope is invalid.');
    invariant(report.scope !== 'design' || flow.understandingConfirmation, 'UNDERSTANDING_UNCONFIRMED', 'Requirements must be confirmed before reopening design.');
    const additionalRound = (report.scope === 'requirements' && flow.step === 'clarification' && !flow.understandingConfirmation) || (report.scope === 'design' && flow.step === 'design' && !flow.design);
    if (!additionalRound) invalidateDownstream(demand, report.scope);
    // General reopening questions are not disposition claims about an old review.
    invariant(report.questions.every(question => !question.findingId), 'INVALID_PLANNING', 'Reopened decisions must not resolve a superseded finding.');
    questions(flow, report.questions, report.scope);
    flow.revision++; return;
  }
  const required: Record<Exclude<PlanningWorkerReport['type'], 'planning-questions'>, PlanningWorkStep> = { 'planning-facts': 'facts', 'planning-clarification': 'clarification', 'planning-design': 'design', 'planning-design-review': 'design-review', 'planning-design-resolution': 'design-resolution', 'planning-spec': 'spec', 'planning-tickets': 'tickets' };
  invariant(run.planningStep === required[report.type], 'PLANNING_STEP_MISMATCH', 'A report cannot skip a planning step.');
  switch (report.type) {
    case 'planning-facts': {
      artifact(report.evidence); nonempty(report.summary, 'facts summary'); const observed = independent(demand, run, report.evidence, verification, 'facts');
      flow.facts = { evidence: structuredClone(report.evidence), summary: report.summary, runId: run.id, contextId: run.contextId, inputDigest: observed.inputDigest }; flow.step = 'clarification'; break;
    }
    case 'planning-clarification': {
      const understanding = report.understanding;
      nonempty(understanding.id, 'understanding.id'); nonempty(understanding.scope, 'scope'); strings(understanding.acceptanceCriteria, 'acceptance criteria', true); strings(understanding.nonGoals, 'non-goals'); strings(understanding.constraints, 'constraints'); artifact(understanding.evidence);
      invariant(flow.facts, 'FACTS_MISSING', 'Independent discoverable facts must precede clarification.');
      const hash = digest(understanding);
      if (flow.understanding?.id === understanding.id) invariant(flow.understanding.digest === hash, 'CONTENT_CONFLICT', 'An understanding ID cannot be reused for changed content.');
      flow.understanding = { ...structuredClone(understanding), digest: hash, version: flow.revision, createdByRun: run.id, contextId: run.contextId }; flow.understandingConfirmation = undefined;
      questions(flow, report.questions, 'requirements'); flow.step = unansweredPlanningQuestions(flow).length ? 'clarification' : 'awaiting-understanding-confirmation'; break;
    }
    case 'planning-design': {
      const design = report.design; nonempty(design.id, 'design.id'); nonempty(design.summary, 'design summary'); strings(design.testingSeams, 'testing seams', true); strings(design.constraints, 'design constraints'); artifact(design.evidence);
      invariant(flow.understanding && flow.understandingConfirmation?.digest === flow.understanding.digest && design.understandingDigest === flow.understanding.digest, 'UNDERSTANDING_UNCONFIRMED', 'Design must use the exact confirmed requirements.');
      flow.design = { ...structuredClone(design), version: flow.revision, digest: digest(design), createdByRun: run.id, contextId: run.contextId }; flow.questions = []; flow.step = 'design-review'; break;
    }
    case 'planning-design-review': {
      const review = report.review; nonempty(review.id, 'review.id'); artifact(review.evidence);
      invariant(flow.design?.digest === review.designDigest, 'STALE_DESIGN', 'Review must bind the exact design draft.');
      const observed = independent(demand, run, review.evidence, verification, 'design-review');
      invariant(Array.isArray(review.findings), 'INVALID_PLANNING', 'Review findings must be explicit.'); const ids = new Set<string>();
      for (const finding of review.findings) { nonempty(finding.id, 'finding.id'); invariant(!ids.has(finding.id), 'INVALID_PLANNING', 'Review finding IDs must be unique.'); ids.add(finding.id); invariant(['blocking', 'decision', 'suggestion'].includes(finding.severity), 'INVALID_PLANNING', 'Invalid finding severity.'); for (const field of ['trigger', 'expectedOutcome', 'basis', 'verification'] as const) nonempty(finding[field], field); }
      flow.review = { ...structuredClone(review), runId: run.id, contextId: run.contextId, inputDigest: observed.inputDigest }; flow.step = 'design-resolution'; break;
    }
    case 'planning-design-resolution': {
      const resolution = report.resolution; nonempty(resolution.id, 'resolution.id'); artifact(resolution.evidence);
      invariant(flow.review?.id === resolution.reviewId && flow.design?.digest === resolution.designDigest, 'STALE_DESIGN', 'Resolution must bind the current reviewed draft.');
      invariant(Array.isArray(resolution.dispositions), 'INVALID_PLANNING', 'Review dispositions must be explicit.');
      const ids = new Set<string>();
      for (const disposition of resolution.dispositions) { invariant(flow.review.findings.some(finding => finding.id === disposition.findingId) && !ids.has(disposition.findingId), 'INVALID_PLANNING', 'Disposition must refer once to a current review finding.'); ids.add(disposition.findingId); invariant(['adopted', 'not-applicable', 'user-resolved'].includes(disposition.outcome), 'INVALID_PLANNING', 'Invalid disposition outcome.'); nonempty(disposition.rationale, 'disposition rationale'); }
      // Keep previously answered exact questions available to prove user decisions.
      questions(flow, report.questions, 'design');
      if (unansweredPlanningQuestions(flow).length) { flow.resolution = undefined; break; }
      for (const finding of flow.review.findings) {
        const disposition = resolution.dispositions.find(item => item.findingId === finding.id);
        invariant(disposition, 'REVIEW_UNRESOLVED', 'Every review finding requires an explicit disposition.');
        if (finding.severity === 'decision' || disposition.outcome === 'user-resolved') {
          const answer = flow.answers.find(answer => answer.questionId === disposition.answerQuestionId && answer.findingId === finding.id && answer.reviewId === flow.review!.id);
          invariant(answer, 'USER_DECISION_REQUIRED', 'The exact affected review question requires a recorded human answer.');
          invariant(disposition.outcome === 'user-resolved', 'USER_DECISION_REQUIRED', 'A worker cannot decide an unresolved human tradeoff.');
        }
      }
      flow.resolution = { ...structuredClone(resolution), digest: digest({ design: flow.design, review: flow.review, resolution, answers: flow.answers.filter(answer => answer.reviewId === flow.review!.id && resolution.dispositions.some(disposition => disposition.answerQuestionId === answer.questionId && disposition.findingId === answer.findingId)) }), createdByRun: run.id }; flow.questions = []; flow.step = 'awaiting-final-design-confirmation'; break;
    }
    case 'planning-spec': {
      requireFinal(flow); const spec = report.spec; nonempty(spec.id, 'spec.id'); artifact(spec.evidence);
      invariant(spec.kind === 'spec' && spec.designDigest === flow.design!.digest, 'INVALID_SPEC', 'A spec is a document bound to the confirmed design, not an executable ticket.');
      invariant(Array.isArray(spec.requiredChecks), 'INVALID_CHECK', 'Spec checks must be explicit.'); const ids = new Set<string>();
      for (const check of spec.requiredChecks) { nonempty(check.id, 'check.id'); nonempty(check.name, 'check.name'); invariant(!ids.has(check.id) && ['project', 'demand'].includes(check.source), 'INVALID_CHECK', 'Check IDs must be unique and sources valid.'); ids.add(check.id); }
      flow.spec = { ...structuredClone(spec), createdByRun: run.id }; flow.step = 'tickets'; break;
    }
    case 'planning-tickets': {
      requireFinal(flow); invariant(flow.spec, 'SPEC_REQUIRED', 'Tickets require the actual retained spec document.'); nonempty(report.planId, 'planId'); artifact(report.ticketIndex);
      invariant(Array.isArray(report.tickets) && report.tickets.length > 0, 'INVALID_TICKETS', 'At least one executable local ticket is required.'); const ids = new Set<string>();
      for (const ticket of report.tickets) { nonempty(ticket.id, 'ticket.id'); nonempty(ticket.title, 'ticket.title'); artifact(ticket.evidence); strings(ticket.specClauses, 'spec clauses', true); strings(ticket.blockedBy, 'ticket dependencies'); invariant(ticket.kind === 'ticket' && ticket.specId === flow.spec.id && ticket.id !== flow.spec.id && !ids.has(ticket.id), 'INVALID_TICKETS', 'Tickets must be distinct executable records traceable to the current spec.'); invariant(new Set(ticket.blockedBy).size === ticket.blockedBy.length && ticket.blockedBy.every(id => ids.has(id)), 'INVALID_TICKETS', 'Tickets must be in dependency order with no cycle, self-reference, or missing dependency.'); ids.add(ticket.id); }
      invariant(!demand.activePlanId && !demand.plans.some(plan => plan.id === report.planId), 'CONTENT_CONFLICT', 'A completed plan ID is immutable.');
      flow.tickets = structuredClone(report.tickets); flow.step = 'complete';
      demand.plans.push({ id: report.planId, scope: flow.understanding!.scope, spec: structuredClone(flow.spec.evidence), tickets: structuredClone(report.ticketIndex), requiredChecks: structuredClone(flow.spec.requiredChecks), unresolvedQuestions: [], ready: true, createdByRun: run.id, designBinding: { flowId: flow.id, understandingDigest: flow.understanding!.digest, designDigest: flow.design!.digest, finalConfirmationDigest: flow.finalDesignConfirmation!.digest }, boundaryReview: { contextId: flow.review!.contextId, planningContextId: flow.design!.contextId, evidence: structuredClone(flow.review!.evidence), unresolvedBlockingFindings: [] } });
      demand.activePlanId = report.planId; demand.confirmedPlanId = report.planId;
      // Planning and its confirmations never issue or carry over execution authority.
      demand.grant = undefined; break;
    }
  }
  flow.revision++;
}
