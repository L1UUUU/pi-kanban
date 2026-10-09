import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchStore, WorkflowService, DomainError, planningInputDigest, planningInputs, STAGED_PLANNING_ADAPTER } from '../src/domain/index.ts';
import type { ArtifactRef, DesignInput, PlanningQuestionInput, PlanningWorkStep, ReportVerification, RunAttempt, UnderstandingInput, UserCommand, WorkerReport } from '../src/domain/types.ts';

// Synthetic trusted observations exercise domain authority and real SQLite
// persistence; they do not establish actual process isolation or model quality.
const ref = (id: string): ArtifactRef => ({ id, digest: `sha256-${id}`, location: `fixture://${id}` });
const methods = Object.fromEntries(['planning', 'implementation', 'review'].map(stage => [stage, { id: stage, version: '1', digest: `${stage}-digest`, adapter: stage === 'planning' ? STAGED_PLANNING_ADAPTER : 'synthetic' }]));
const dispatch = { profileVerified: true, budgetAvailable: true, workspaceVerified: true };
const stopProof = { processAbsent: true, descendantsAbsent: true, workspaceVerified: true, evidence: 'synthetic actual-stop observation' };
const question: PlanningQuestionInput = { id: 'Q1', scope: 'requirements', question: 'Should retries preserve completed decisions?', basis: 'Acceptance behavior is unspecified.' };
const understanding = (id = 'U1'): UnderstandingInput => ({ id, scope: 'Persist staged planning locally.', acceptanceCriteria: ['Restart preserves valid user confirmation.'], constraints: ['No implementation grant.'], nonGoals: ['Remote publication'], evidence: ref(id) });
const error = (expected: string) => (value: unknown) => value instanceof DomainError && value.code === expected;
function fixture(path = ':memory:') {
  let store = new WorkbenchStore(path), service = new WorkflowService(store), user = service.trustedUser('owner'), seq = 0;
  service.createProject({ id: 'p', name: 'Synthetic', rootPath: '/synthetic', methods }); service.createDemand({ id: 'd', projectId: 'p', title: 'Staged planning' });
  const demand = () => service.getDemand('d'), flow = () => demand().planningFlow!;
  const command = (input: any) => service.execute({ requestId: `u${++seq}`, demandId: 'd', expectedRevision: demand().revision, ...(flow() ? { flowId: flow().id, flowRevision: flow().revision } : {}), ...input } as UserCommand, user);
  const claim = (step: PlanningWorkStep) => { const run = service.claimNextRun({ ...dispatch, demandId: 'd' }); assert.ok(run); assert.equal(run.planningStep, step); return run; };
  const verification = (run: RunAttempt, body: any): ReportVerification => ({ artifactsVerified: true, planningStage: { runId: run.id, planningStep: run.planningStep!, flowId: flow().id, flowRevision: flow().revision, inputDigest: planningInputDigest(demand(), run.planningStep!), sourceVerified: true, requiredSkillVerified: true, actualRunObserved: true, actualStopVerified: true }, ...(['facts', 'design-review'].includes(run.planningStep!) ? { planningIndependent: { kind: run.planningStep as 'facts' | 'design-review', runId: run.id, contextId: run.contextId, flowId: flow().id, flowRevision: flow().revision, inputDigest: planningInputDigest(demand(), run.planningStep!), evidenceDigest: (body.evidence ?? body.review?.evidence ?? ref('missing')).digest, actualRunObserved: true, isolatedInputsVerified: true, readOnlyVerified: true } } : {}) });
  const report = (run: RunAttempt, body: any, observed?: ReportVerification) => service.report({ requestId: `w${++seq}`, demandId: 'd', runId: run.id, generation: run.generation, flowId: flow().id, flowRevision: flow().revision, ...body } as WorkerReport, service.workerContext(run.id), observed ?? verification(run, body));
  const stop = (run: RunAttempt) => service.confirmStopped(run.id, stopProof);
  const handoff = (step: PlanningWorkStep, body: any) => { const run = claim(step); report(run, body); stop(run); return run; };
  const start = () => { command({ type: 'start-planning' }); return handoff('facts', { type: 'planning-facts', evidence: ref('facts'), summary: 'Observed the current source and project rules.' }); };
  const clarify = (questions: PlanningQuestionInput[] = []) => handoff('clarification', { type: 'planning-clarification', understanding: understanding(), questions });
  const confirmUnderstanding = () => command({ type: 'confirm-understanding', understandingId: flow().understanding!.id, digest: flow().understanding!.digest });
  const design = (): DesignInput => ({ id: 'D1', understandingDigest: flow().understanding!.digest, summary: 'Persistent stage transitions with versioned decisions.', testingSeams: ['Interrupt between receipt and next run.'], constraints: ['Fresh read-only review.'], evidence: ref('D1') });
  const draft = () => handoff('design', { type: 'planning-design', design: design() });
  const review = (findings: any[] = []) => handoff('design-review', { type: 'planning-design-review', review: { id: 'R1', designDigest: flow().design!.digest, evidence: ref('R1'), findings } });
  const resolution = (dispositions: any[] = [], questions: PlanningQuestionInput[] = []) => ({ type: 'planning-design-resolution', resolution: { id: `Z${seq}`, reviewId: flow().review!.id, designDigest: flow().design!.digest, evidence: ref(`Z${seq}`), dispositions }, questions });
  const resolve = () => handoff('design-resolution', resolution());
  const confirmFinal = () => command({ type: 'confirm-final-design', designId: flow().design!.id, digest: flow().resolution!.digest });
  const prepare = () => { start(); clarify(); confirmUnderstanding(); draft(); review(); resolve(); };
  const spec = () => handoff('spec', { type: 'planning-spec', spec: { id: 'S1', kind: 'spec', designDigest: flow().design!.digest, evidence: ref('S1'), requiredChecks: [{ id: 'restart', name: 'Persistent gate resume', source: 'demand' }] } });
  const tickets = () => ({ type: 'planning-tickets', planId: 'P1', ticketIndex: ref('index'), tickets: [{ id: 'T1', kind: 'ticket', title: 'Persist confirmed requirements', evidence: ref('T1'), specId: 'S1', specClauses: ['Acceptance 1'], blockedBy: [] }, { id: 'T2', kind: 'ticket', title: 'Preserve resumed stage', evidence: ref('T2'), specId: 'S1', specClauses: ['Acceptance 1'], blockedBy: ['T1'] }] });
  const restart = () => { store.close(); store = new WorkbenchStore(path); service = new WorkflowService(store); user = service.trustedUser('owner'); };
  return { get store() { return store; }, get service() { return service; }, get user() { return user; }, demand, flow, command, claim, verification, report, stop, handoff, start, clarify, confirmUnderstanding, design, draft, review, resolution, resolve, confirmFinal, prepare, spec, tickets, restart };
}

test('staged planning requires two distinct human decisions before spec/tickets and completion grants no implementation', () => {
  const f = fixture(); f.start(); f.clarify();
  assert.equal(f.flow().step, 'awaiting-understanding-confirmation'); assert.equal(f.service.claimNextRun(dispatch), null);
  assert.throws(() => f.command({ type: 'confirm-understanding', understandingId: 'U1', digest: 'stale' }), error('STALE_UNDERSTANDING'));
  f.confirmUnderstanding(); f.draft(); f.review(); f.resolve();
  assert.equal(f.flow().step, 'awaiting-final-design-confirmation'); assert.equal(f.service.claimNextRun(dispatch), null); assert.equal(f.flow().spec, undefined);
  assert.throws(() => f.command({ type: 'confirm-final-design', designId: 'D1', digest: f.flow().design!.digest }), error('STALE_DESIGN'));
  f.confirmFinal(); f.spec(); f.handoff('tickets', f.tickets());
  assert.equal(f.flow().step, 'complete'); assert.equal(f.flow().spec!.kind, 'spec'); assert.ok(f.flow().tickets.every(ticket => ticket.kind === 'ticket'));
  assert.equal(f.demand().plans[0].ready, true); assert.equal(f.demand().confirmedPlanId, 'P1'); assert.equal(f.demand().grant, undefined); assert.equal(f.demand().phase, 'awaiting-authorization'); assert.equal(f.service.claimNextRun(dispatch), null);
  assert.equal(f.demand().plans[0].boundaryReview!.planningContextId, f.flow().design!.contextId);
  f.command({ type: 'authorize-implementation', planId: 'P1' }); assert.equal(f.service.claimNextRun(dispatch)!.stage, 'implementation'); f.store.close();
});

test('staged adapter rejects legacy handoffs, forged independent facts, wrong skill/stop/input evidence, and early spec', () => {
  const f = fixture(); f.command({ type: 'start-planning' }); const run = f.claim('facts'); const body = { type: 'planning-facts', evidence: ref('facts'), summary: 'Observed facts.' };
  assert.throws(() => f.report(run, { type: 'plan-draft', plan: {} }), error('STAGED_REPORT_REQUIRED'));
  assert.throws(() => f.report(run, { type: 'plan-ready', planId: 'P1', boundaryReview: {} }), error('STAGED_REPORT_REQUIRED'));
  for (const key of ['requiredSkillVerified', 'sourceVerified', 'actualRunObserved', 'actualStopVerified'] as const) { const observed = f.verification(run, body); observed.planningStage![key] = false; assert.throws(() => f.report(run, body, observed), error('PLANNING_STAGE_UNVERIFIED')); }
  const forged = f.verification(run, body); forged.planningIndependent!.contextId = 'self-attested-context'; assert.throws(() => f.report(run, body, forged), error('PLANNING_INDEPENDENCE_UNVERIFIED'));
  const edited = f.verification(run, body); edited.planningStage!.inputDigest = 'other-inputs'; assert.throws(() => f.report(run, body, edited), error('PLANNING_STAGE_UNVERIFIED'));
  assert.throws(() => f.report(run, { type: 'planning-spec', spec: {} }), error('PLANNING_STEP_MISMATCH'));
  assert.equal(f.flow().step, 'facts'); f.store.close();
});

test('bound questions stop dispatch, human answers do not implicitly confirm understanding, and explicit revisions allow changed answers', () => {
  const f = fixture(); f.start(); f.clarify([question]); assert.equal(f.service.claimNextRun(dispatch), null);
  assert.throws(() => f.command({ type: 'confirm-understanding', understandingId: 'U1', digest: f.flow().understanding!.digest }), error('UNDERSTANDING_NOT_READY'));
  assert.throws(() => f.command({ type: 'answer-planning-question', questionId: 'Q1', questionDigest: 'other', answer: 'Yes' }), error('STALE_QUESTION'));
  f.command({ type: 'answer-planning-question', questionId: 'Q1', questionDigest: f.flow().questions[0].digest, answer: 'Yes' }); f.clarify(); assert.equal(f.flow().understandingConfirmation, undefined); f.confirmUnderstanding();
  f.command({ type: 'revise-planning', scope: 'requirements', reason: 'Reconsider persistence behavior.' }); assert.equal(f.flow().answers.length, 0); assert.equal(f.flow().history[0].answers[0].answer, 'Yes');
  f.clarify([question]); f.command({ type: 'answer-planning-question', questionId: 'Q1', questionDigest: f.flow().questions[0].digest, answer: 'No, refresh only changed source facts.' }); assert.equal(f.flow().answers[0].answer, 'No, refresh only changed source facts.'); f.store.close();
});

test('review behavior decisions cannot be adopted or dismissed by a worker and exact human disposition survives follow-up rounds', () => {
  const f = fixture(); f.start(); f.clarify(); f.confirmUnderstanding(); f.draft(); f.review([{ id: 'F1', severity: 'decision', trigger: 'Resume after source drift.', expectedOutcome: 'User must select retry behavior.', basis: 'Requirement leaves drift handling open.', verification: 'Restart with changed source.' }]);
  const run = f.claim('design-resolution');
  for (const outcome of ['adopted', 'not-applicable']) assert.throws(() => f.report(run, f.resolution([{ findingId: 'F1', outcome, rationale: 'Worker selected behavior.' }])), error('USER_DECISION_REQUIRED'));
  f.report(run, f.resolution([], [{ id: 'Q-review', scope: 'design', question: 'Recheck the changed source before retry?', basis: 'F1', findingId: 'F1' }])); f.stop(run);
  f.command({ type: 'answer-planning-question', questionId: 'Q-review', questionDigest: f.flow().questions[0].digest, answer: 'Recheck changed inputs; keep other confirmations.' });
  f.handoff('design-resolution', f.resolution([], [{ id: 'Q-second', scope: 'design', question: 'Keep the same isolated review seam?', basis: 'Verification location' }]));
  f.command({ type: 'answer-planning-question', questionId: 'Q-second', questionDigest: f.flow().questions[0].digest, answer: 'Yes.' });
  f.handoff('design-resolution', f.resolution([{ findingId: 'F1', outcome: 'user-resolved', rationale: 'Use the explicit recheck decision.', answerQuestionId: 'Q-review' }]));
  assert.equal(f.flow().step, 'awaiting-final-design-confirmation'); f.store.close();
});

test('scope revision keeps requirement consent only for design changes, archives review evidence, and revokes downstream plans/grants', () => {
  const f = fixture(); f.prepare(); f.confirmFinal(); f.spec(); f.handoff('tickets', f.tickets()); f.command({ type: 'authorize-implementation', planId: 'P1' });
  const original = f.flow().understandingConfirmation; f.command({ type: 'revise-planning', scope: 'design', reason: 'Change the interface seam.' });
  assert.deepEqual(f.flow().understandingConfirmation, original); assert.equal(f.flow().step, 'design'); assert.equal(f.flow().finalDesignConfirmation, undefined); assert.equal(f.flow().review, undefined); assert.equal(f.flow().spec, undefined); assert.equal(f.demand().grant, undefined); assert.equal(f.demand().activePlanId, undefined); assert.equal(f.flow().history[0].review!.id, 'R1');
  f.command({ type: 'revise-planning', scope: 'requirements', reason: 'Change acceptance behavior.' }); assert.equal(f.flow().step, 'clarification'); assert.equal(f.flow().understandingConfirmation, undefined); assert.equal(f.flow().history.length, 2); f.store.close();
});

test('fresh independent review inputs exclude conversation, prior answers, and planner session state', () => {
  const f = fixture(); f.start(); f.clarify([question]); f.command({ type: 'answer-planning-question', questionId: 'Q1', questionDigest: f.flow().questions[0].digest, answer: 'Sensitive free-form background.' }); f.clarify(); f.confirmUnderstanding(); f.draft();
  f.command({ type: 'message', messageId: 'private', kind: 'information', text: 'Planner-only conversation history.' });
  const inputs = planningInputs(f.demand(), 'design-review'); assert.deepEqual(Object.keys(inputs).sort(), ['design', 'flowId', 'flowRevision', 'methodDigest', 'step', 'understanding', 'understandingConfirmation'].sort()); assert.ok(!JSON.stringify(inputs).includes('Sensitive free-form')); assert.ok(!JSON.stringify(inputs).includes('Planner-only')); f.store.close();
});

test('restart preserves confirmed design and immutable receipt replay; pause and stale generations cannot dispatch next work', () => {
  const directory = mkdtempSync(join(tmpdir(), 'staged-domain-')); const f = fixture(join(directory, 'state.db'));
  try {
    f.prepare(); const decision: UserCommand = { type: 'confirm-final-design', requestId: 'confirm-once', demandId: 'd', expectedRevision: f.demand().revision, flowId: f.flow().id, flowRevision: f.flow().revision, designId: f.flow().design!.id, digest: f.flow().resolution!.digest };
    const receipt = f.service.execute(decision, f.user), confirmed = f.flow().finalDesignConfirmation; f.restart(); assert.deepEqual(f.service.execute(decision, f.user), receipt); assert.deepEqual(f.flow().finalDesignConfirmation, confirmed); assert.equal(f.flow().step, 'spec');
    const run = f.claim('spec'); f.command({ type: 'pause' }); const body = { type: 'planning-spec', spec: { id: 'S1', kind: 'spec', designDigest: f.flow().design!.digest, evidence: ref('S1'), requiredChecks: [] } }; f.report(run, body); f.stop(run); assert.equal(f.demand().control, 'paused'); assert.equal(f.service.claimNextRun(dispatch), null);
    const late = f.report(run, { type: 'blocked', reason: 'Obsolete step report.' }); assert.equal(late.status, 'historical'); assert.deepEqual(f.demand().blockedReasons, []);
    f.command({ type: 'resume' }); assert.equal(f.claim('tickets').planningStep, 'tickets');
  } finally { f.store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('stage report replay and wrong-body retry cannot duplicate immutable artifacts or stage transitions', () => {
  const f = fixture(); f.command({ type: 'start-planning' }); const run = f.claim('facts');
  const report: WorkerReport = { type: 'planning-facts', requestId: 'facts-once', demandId: 'd', runId: run.id, generation: run.generation, flowId: f.flow().id, flowRevision: f.flow().revision, evidence: ref('facts'), summary: 'Observed facts.' };
  const observed = f.verification(run, report), capability = f.service.workerContext(run.id), receipt = f.service.report(report, capability, observed);
  assert.deepEqual(f.service.report(report, capability, observed), receipt); assert.equal(f.flow().revision, 2); assert.throws(() => f.service.report({ ...report, summary: 'Changed evidence.' }, capability, observed), error('IDEMPOTENCY_CONFLICT')); assert.equal(f.flow().step, 'clarification'); f.store.close();
});

test('method downgrade and malformed/cyclic/spec-shaped tickets cannot bypass human or executable-record boundaries', () => {
  const f = fixture(); f.prepare();
  assert.throws(() => f.command({ type: 'switch-method', stage: 'planning', method: { ...methods.planning, adapter: 'explicit-text-v1' }, reason: 'Skip current gates.', impactReviewed: true }), error('STAGED_METHOD_DOWNGRADE'));
  assert.throws(() => f.command({ type: 'confirm-plan', planId: 'P1' }), error('STAGED_CONFIRMATION_REQUIRED'));
  f.confirmFinal(); f.spec(); const run = f.claim('tickets'), invalid = f.tickets(); invalid.tickets[0].blockedBy = ['T2']; assert.throws(() => f.report(run, invalid), error('INVALID_TICKETS'));
  const specAsTicket = f.tickets(); specAsTicket.tickets[0].kind = 'spec'; assert.throws(() => f.report(run, specAsTicket), error('INVALID_TICKETS')); assert.equal(f.flow().step, 'tickets'); f.store.close();
});

test('questions cannot skip requirement confirmation and user decisions require stopped contexts', () => {
  const f = fixture(); f.start(); const run = f.claim('clarification');
  assert.throws(() => f.report(run, { type: 'planning-questions', scope: 'design', questions: [{ id: 'Q', scope: 'design', question: 'Choose an interface.', basis: 'Unconfirmed requirement' }] }), error('UNDERSTANDING_UNCONFIRMED'));
  f.report(run, { type: 'planning-clarification', understanding: understanding(), questions: [] }); assert.throws(() => f.confirmUnderstanding(), error('RUN_ACTIVE')); f.stop(run); f.command({ type: 'pause' }); f.confirmUnderstanding(); assert.equal(f.demand().control, 'paused'); assert.equal(f.service.claimNextRun(dispatch), null); f.command({ type: 'cancel' }); assert.throws(() => f.command({ type: 'revise-planning', scope: 'requirements', reason: 'Restart cancelled work.' }), error('CANCELLED')); f.store.close();
});

test('additional question rounds preserve earlier exact answers and reject ambiguous question ID reuse', () => {
  const f = fixture(); f.start();
  f.handoff('clarification', { type: 'planning-questions', scope: 'requirements', questions: [question] });
  f.command({ type: 'answer-planning-question', questionId: 'Q1', questionDigest: f.flow().questions[0].digest, answer: 'Yes, preserve confirmed conclusions.' });
  f.handoff('clarification', { type: 'planning-questions', scope: 'requirements', questions: [{ ...question, id: 'Q2', question: 'Keep outputs local?' }] });
  assert.equal(f.flow().answers[0].question, question.question); assert.equal(f.flow().answers[0].answer, 'Yes, preserve confirmed conclusions.');
  f.command({ type: 'answer-planning-question', questionId: 'Q2', questionDigest: f.flow().questions[0].digest, answer: 'Yes.' });
  const run = f.claim('clarification');
  assert.throws(() => f.report(run, { type: 'planning-questions', scope: 'requirements', questions: [{ ...question, question: 'Discard all confirmed conclusions?' }] }), error('QUESTION_ID_CONFLICT'));
  assert.equal(f.flow().answers.length, 2); assert.ok(JSON.stringify(planningInputs(f.demand(), 'clarification')).includes(question.question)); f.store.close();
});

test('the explicit revision reason reaches only ordinary planning contexts and changed methods restart independent facts', () => {
  const f = fixture(); f.prepare(); f.command({ type: 'revise-planning', scope: 'design', reason: 'Keep the existing interface and revise only retry verification.' });
  assert.equal(f.flow().revisionInstruction!.reason, 'Keep the existing interface and revise only retry verification.');
  assert.ok(JSON.stringify(planningInputs(f.demand(), 'design')).includes('revise only retry verification'));
  assert.ok(!JSON.stringify(planningInputs(f.demand(), 'design-review')).includes('revise only retry verification'));
  f.command({ type: 'switch-method', stage: 'planning', method: { ...methods.planning, digest: 'new-method-digest', version: '2' }, reason: 'Use updated explicit orchestration.', impactReviewed: true });
  assert.equal(f.flow().step, 'facts'); assert.equal(f.flow().facts, undefined); assert.equal(f.flow().understandingConfirmation, undefined); assert.equal(f.claim('facts').method.digest, 'new-method-digest'); f.store.close();
});

test('explicit change-request messages revoke old consent and stop stale work while ordinary information only refreshes bounded inputs', () => {
  const f = fixture(); f.prepare(); f.confirmFinal(); const confirmation = f.flow().finalDesignConfirmation, run = f.claim('spec');
  const before = planningInputDigest(f.demand(), 'spec');
  f.command({ type: 'message', messageId: 'information', kind: 'information', text: 'The existing tests are in tests/restart.test.ts.' });
  assert.equal(f.service.getRun(run.id).status, 'stopping'); assert.deepEqual(f.flow().finalDesignConfirmation, confirmation); assert.notEqual(planningInputDigest(f.demand(), 'spec'), before); assert.ok(JSON.stringify(planningInputs(f.demand(), 'spec')).includes('tests/restart.test.ts'));
  assert.ok(!JSON.stringify(planningInputs(f.demand(), 'design-review')).includes('tests/restart.test.ts'));
  assert.equal(f.report(run, { type: 'blocked', reason: 'Old context must not affect new inputs.' }).status, 'historical'); f.stop(run);
  f.command({ type: 'message', messageId: 'scope-change', kind: 'change-request', text: 'Also require recovery after an unclean process exit.' });
  assert.equal(f.flow().step, 'clarification'); assert.equal(f.flow().understandingConfirmation, undefined); assert.equal(f.flow().finalDesignConfirmation, undefined); assert.equal(f.flow().revisionInstruction!.reason, 'Also require recovery after an unclean process exit.'); assert.equal(f.demand().grant, undefined); assert.equal(f.flow().history.at(-1)!.finalDesignConfirmation!.digest, confirmation!.digest); f.store.close();
});

test('pre-planning information reaches ordinary stage inputs and oversized messages cannot silently expand context', () => {
  const f = fixture(); f.command({ type: 'message', messageId: 'before', kind: 'information', text: 'Reuse the current local tracker.' }); f.start();
  assert.equal(f.flow().messages[0].text, 'Reuse the current local tracker.'); assert.ok(JSON.stringify(planningInputs(f.demand(), 'clarification')).includes('Reuse the current local tracker.'));
  assert.throws(() => f.command({ type: 'message', messageId: 'oversized', kind: 'information', text: 'x'.repeat(16_001) }), error('PLANNING_CONTEXT_LIMIT')); assert.equal(f.flow().messages.length, 1); f.store.close();
});

test('trusted cross-stage source drift resets exact old facts and consent atomically while stale observations preserve new progress', () => {
  const f = fixture(); f.prepare(); f.confirmFinal(); const oldFacts = f.flow().facts!, confirmation = f.flow().finalDesignConfirmation, run = f.claim('spec');
  const changed = f.service.invalidatePlanningSource('d', oldFacts.runId, 'Tracked source commitment changed after independent discovery.');
  assert.equal(changed.planningFlow!.step, 'facts'); assert.equal(changed.planningFlow!.facts, undefined); assert.equal(changed.planningFlow!.understanding, undefined); assert.equal(changed.planningFlow!.understandingConfirmation, undefined); assert.equal(changed.planningFlow!.finalDesignConfirmation, undefined); assert.equal(changed.grant, undefined); assert.equal(f.service.getRun(run.id).status, 'stopping');
  assert.deepEqual(changed.planningFlow!.history.at(-1)!.facts, oldFacts); assert.deepEqual(changed.planningFlow!.history.at(-1)!.finalDesignConfirmation, confirmation);
  assert.equal(f.service.invalidatePlanningSource('d', oldFacts.runId, 'Duplicate observation').revision, changed.revision);
  assert.equal(f.report(run, { type: 'blocked', reason: 'Old source context.' }).status, 'historical'); f.stop(run);
  f.handoff('facts', { type: 'planning-facts', evidence: ref('new-facts'), summary: 'Observed the changed source.' }); const current = f.flow().facts!;
  assert.equal(f.service.invalidatePlanningSource('d', oldFacts.runId, 'Late old observation').planningFlow!.facts!.runId, current.runId); f.store.close();
});

test('source invalidation blocks a submitted result without rewriting its plan or human confirmations', () => {
  const f = fixture(); f.prepare(); f.confirmFinal(); f.spec(); f.handoff('tickets', f.tickets()); f.command({ type: 'authorize-implementation', planId: 'P1' });
  const implementation = f.service.claimNextRun(dispatch)!;
  f.report(implementation, { type: 'content-ready', content: { id: 'K1', planId: 'P1', code: ref('K1'), knowledge: [], maintenance: 'not-needed', deliveryNotes: 'Synthetic completed content.' } }, { artifactsVerified: true, contentStable: true }); f.stop(implementation);
  const reviewer = f.service.claimNextRun(dispatch)!;
  f.report(reviewer, { type: 'check', check: { id: 'E1', contentId: 'K1', requirementId: 'restart', status: 'passed', evidence: ref('E1'), environment: 'synthetic' } }, { artifactsVerified: true });
  f.report(reviewer, { type: 'review', reviewId: 'C-review', contentId: 'K1', evidence: ref('C-review'), knowledgeReviewed: true, findings: [] }, { artifactsVerified: true, reviewInputsVerified: true }); f.stop(reviewer);
  assert.ok(f.demand().activeResultId); const before = f.demand(); const after = f.service.invalidatePlanningSource('d', f.flow().facts!.runId, 'Source changed after submitted content.');
  assert.deepEqual(after.planningFlow, before.planningFlow); assert.deepEqual(after.results, before.results); assert.deepEqual(after.plans, before.plans); assert.equal(after.activeResultId, before.activeResultId); assert.equal(after.phase, 'blocked'); assert.match(after.blockedReasons[0], /Planning source changed/); assert.equal(f.service.claimNextRun(dispatch), null); f.store.close();
});

test('requirement revisions before independent facts preserve the facts gate', () => {
  for (const change of [{ type: 'revise-planning', scope: 'requirements', reason: 'Changed the target behavior before investigation.' }, { type: 'message', messageId: 'early-change', kind: 'change-request', text: 'Investigate the changed target behavior first.' }]) {
    const f = fixture(); f.command({ type: 'start-planning' }); const pending = change.type === 'message' ? f.claim('facts') : null;
    f.command(change); assert.equal(f.flow().step, 'facts'); assert.equal(f.flow().facts, undefined); assert.equal(f.flow().understandingConfirmation, undefined);
    if (pending) { assert.equal(f.service.getRun(pending.id).status, 'stopping'); f.stop(pending); } assert.equal(f.claim('facts').planningStep, 'facts'); f.store.close();
  }
});
