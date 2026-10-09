import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { planningProductionFixture, git } from './helpers/planning-production.ts';
import type { Launch, Script, SyntheticPlanningNativePort } from './helpers/planning-production.ts';
import { hash } from '../src/host/evidence.ts';
import { bundledPlanningMethod } from '../src/host/configuration.ts';
import { WorkflowService } from '../src/domain/index.ts';
import type { ArtifactRef, PlanningUserCommand, PlanningWorkerReport, PlanningWorkStep } from '../src/domain/types.ts';
import type { ProviderResponse } from '../src/runtime/model-broker.ts';

// This fixture selects real, pinned upstream resources through the production
// loader. Its entry method is synthetic; private user-supplied method bytes are
// never copied into the repository or test output.
function fixture(t: test.TestContext) {
  return planningProductionFixture(t, root => {
    const id = 'selected-planning-method', path = join(root, 'planning.md');
    const content = '---\nname: design-feature\ndescription: Synthetic explicitly selected staged planning fixture.\ndisable-model-invocation: true\n---\nUse the Host-selected planning stages and local artifacts.\n';
    writeFileSync(path, content);
    const vendor = fileURLToPath(new URL('../vendor/mattpocock-skills', import.meta.url));
    return bundledPlanningMethod({ id, path, sha256: hash(content) }, vendor);
  });
}
type Fixture = ReturnType<typeof fixture>;
type Report = PlanningWorkerReport & { artifactBodies?: { id: string; kind: 'plan' | 'check-evidence'; text: string }[] };
const pendingRef = (id: string): ArtifactRef => ({ id, digest: 'pending', location: 'host-artifact' });
const flow = (f: Fixture) => f.store.getDemand('demand').planningFlow!;
const bound = (f: Fixture) => ({ flowId: flow(f).id, flowRevision: flow(f).revision });
function command(f: Fixture, input: PlanningUserCommand) {
  return f.workflow.execute({ ...input, requestId: randomUUID(), demandId: 'demand', expectedRevision: f.store.getDemand('demand').revision }, f.user);
}
function body(id: string, text: string, kind: 'plan' | 'check-evidence' = 'plan') { return { id, kind, text }; }
function modelReport(report: Report) { const { flowId, flowRevision, ...input } = report; return JSON.parse(JSON.stringify(input)); }
function question(f: Fixture): Report {
  return { ...bound(f), type: 'planning-questions', scope: 'requirements', questions: [{ id: 'scope-question', scope: 'requirements', question: 'Should the existing empty input behavior remain unchanged?', basis: 'The requested scope does not define an empty input change.' }] };
}
function facts(f: Fixture): Report {
  return { ...bound(f), type: 'planning-facts', evidence: pendingRef('facts'), summary: 'Existing behavior is owned by code.txt; no implementation was started.', artifactBodies: [body('facts', 'Read code.txt: existing source behavior. Existing callers retain their behavior. SYNTHETIC-PLANNING-ARTIFACT-DATA', 'check-evidence')] };
}
function understanding(f: Fixture): Report {
  return { ...bound(f), type: 'planning-clarification', understanding: { id: 'understanding', scope: 'Add the requested behavior while preserving current empty input behavior.', acceptanceCriteria: ['The requested behavior is observable.', 'Empty input behavior remains unchanged.'], nonGoals: ['No unrelated source changes.'], constraints: ['Planning produces local documents and tickets only.'], evidence: pendingRef('requirements') }, questions: [], artifactBodies: [body('requirements', 'R1: requested behavior. R2: empty input behavior remains unchanged, as explicitly answered.')] };
}
function design(f: Fixture): Report {
  return { ...bound(f), type: 'planning-design', design: { id: 'design', understandingDigest: flow(f).understanding!.digest, summary: 'Keep rule ownership with the current entry point and expose one observable behavior seam.', testingSeams: ['Call the existing entry point with empty input and the requested input.'], constraints: ['No new abstraction is required.'], evidence: pendingRef('design') }, artifactBodies: [body('design', 'The existing entry point owns validation and behavior. Verify R1 and R2 at its current caller seam.')] };
}
function review(f: Fixture): Report {
  return { ...bound(f), type: 'planning-design-review', review: { id: 'design-review', designDigest: flow(f).design!.digest, evidence: pendingRef('review'), findings: [
    { id: 'repeat', severity: 'blocking', trigger: 'The same input is submitted twice.', expectedOutcome: 'The already specified result is returned consistently.', basis: 'R1 requested behavior must remain deterministic.', verification: 'Exercise two calls at the existing entry point.' },
    { id: 'compatibility', severity: 'decision', trigger: 'A caller relies on the existing empty input behavior.', expectedOutcome: 'Confirm whether that behavior is retained in this release.', basis: 'The requested behavior has an existing caller compatibility consequence.', verification: 'Retain an explicit owner answer and test the selected compatibility behavior.' },
  ] }, artifactBodies: [body('review', 'Derived scenarios from R1 and R2 before comparing the draft: duplicate calls need coverage; compatibility must be explicitly resolved.', 'check-evidence')] };
}
function resolution(f: Fixture, ask: boolean): Report {
  return { ...bound(f), type: 'planning-design-resolution', resolution: { id: ask ? 'resolution-question' : 'resolution', reviewId: flow(f).review!.id, designDigest: flow(f).design!.digest, evidence: pendingRef(ask ? 'resolution-question' : 'resolution'), dispositions: ask ? [] : [
    { findingId: 'repeat', outcome: 'adopted', rationale: 'The final test seam now covers repeated calls.' },
    { findingId: 'compatibility', outcome: 'user-resolved', rationale: 'The owner explicitly retains the existing empty input behavior.', answerQuestionId: 'compatibility-question' },
  ] }, questions: ask ? [{ id: 'compatibility-question', scope: 'design', findingId: 'compatibility', question: 'Keep the current empty input behavior for existing callers in this release?', basis: 'Independent review identified the compatibility decision.' }] : [], artifactBodies: [body(ask ? 'resolution-question' : 'resolution', ask ? 'Compatibility answer is required before final design confirmation.' : 'Final design: preserve current caller behavior. Verify requested, empty and repeated inputs at the existing entry point.')] };
}
function spec(f: Fixture): Report {
  return { ...bound(f), type: 'planning-spec', spec: { id: 'spec', kind: 'spec', designDigest: flow(f).design!.digest, evidence: pendingRef('spec'), requiredChecks: [{ id: 'behavior', name: 'Requested, empty and repeated input behavior at the existing entry point', source: 'demand' }] }, artifactBodies: [body('spec', '# Feature spec\nR1: requested behavior.\nR2: existing empty input behavior stays unchanged.\nTesting Decisions: check requested, empty and repeated inputs at the existing entry point.')] };
}
function tickets(f: Fixture): Report {
  return { ...bound(f), type: 'planning-tickets', planId: 'ready-plan', tickets: [
    { id: 'ticket-one', kind: 'ticket', title: 'Deliver requested behavior through its caller', specId: 'spec', specClauses: ['R1'], evidence: pendingRef('ticket-one'), blockedBy: [] },
    { id: 'ticket-two', kind: 'ticket', title: 'Verify compatibility and repeated inputs', specId: 'spec', specClauses: ['R1', 'R2'], evidence: pendingRef('ticket-two'), blockedBy: ['ticket-one'] },
  ], ticketIndex: pendingRef('ticket-index'), artifactBodies: [body('ticket-one', 'Implement R1 through the existing caller and verify the vertical behavior.'), body('ticket-two', 'Depends on ticket-one. Verify R1 and R2 including empty and repeated input behavior.'), body('ticket-index', 'Local executable tickets: ticket-one; ticket-two depends on ticket-one. Actual specification: spec.')] };
}

async function launch(f: Fixture, step: PlanningWorkStep) {
  assert.equal(flow(f).step, step); await f.production.tick();
  const candidates = f.drivers.flatMap(driver => driver.launches.map(launch => ({ driver, launch }))).filter(item => f.store.getRun(item.launch.init.domainRunId).status !== 'stopped');
  assert.equal(candidates.length, 1, JSON.stringify(f.production.diagnostics('demand')));
  const current = candidates[0]!; assert.equal(f.store.getRun(current.launch.init.domainRunId).planningStep, step);
  assert.equal(current.launch.run.writes, false); assert.equal(current.launch.init.planningSkills!.stage, step);
  return current;
}
function workerScript(launch: Launch, report: Report, inspect?: (context: Record<string, unknown>, turn: number) => void): Script {
  const skill = launch.init.planningSkills!.active;
  return (request, turn) => {
    const context = JSON.parse(request.materials[0]!.text) as Record<string, unknown>; inspect?.(context, turn);
    const readReference = launch.init.planningSkills!.stage === 'design', reportTurn = readReference ? 3 : 2;
    const toolCalls: NonNullable<ProviderResponse['toolCalls']> = turn === 1 ? [{ id: 'load-active-skill', name: 'controlled_skill', arguments: { name: skill.name } }] : readReference && turn === 2 ? [{ id: 'read-selected-design-reference', name: 'controlled_skill_resource', arguments: { from: skill.entry.path, path: 'DEEPENING.md' } }] : turn === reportTurn ? [{ id: 'submit-stage-handoff', name: 'controlled_report', arguments: { report: modelReport(report) } }] : [];
    return { text: turn === 1 && launch.init.planningSkills!.stage === 'design' ? 'SYNTHETIC-PLANNER-CHAT-SECRET' : turn > reportTurn ? 'Synthetic stage handoff complete.' : '', ...(toolCalls.length ? { toolCalls } : {}) };
  };
}
async function run(f: Fixture, step: PlanningWorkStep, make: (f: Fixture) => Report) {
  const current = await launch(f, step), before = structuredClone(flow(f));
  current.driver.beforeSettled = () => assert.deepEqual(flow(f), before, 'A live native process cannot advance planning or establish independent evidence.');
  f.setScript(workerScript(current.launch, make(f), (context, turn) => {
    const messages = context.messages as { role?: string; content?: unknown; toolsAdded?: { name: string }[] }[];
    if (turn === 1) {
      const names = messages.flatMap(message => message.toolsAdded ?? []).map(tool => tool.name);
      assert.ok(names.includes('controlled_skill')); assert.ok(names.includes('controlled_skill_resource'));
      assert.ok(!names.includes('controlled_write') && !names.includes('controlled_delete'));
      assert.ok(!JSON.stringify(context).includes('SYNTHETIC-PLANNER-CHAT-SECRET'));
      assert.ok(!JSON.stringify(context).includes(JSON.stringify(current.launch.init.planningSkills!.active.entry.content).slice(1, -1)), 'The active skill body is absent from initial model context until its scoped read.');
      if (current.launch.init.materials.some(material => material.content.includes('SYNTHETIC-PLANNING-ARTIFACT-DATA'))) {
        assert.ok(!JSON.stringify(messages.filter(message => message.role === 'system')).includes('SYNTHETIC-PLANNING-ARTIFACT-DATA'), 'Generated planning evidence cannot be promoted into system instructions.');
        assert.ok(!String(context.systemPrompt ?? '').includes('SYNTHETIC-PLANNING-ARTIFACT-DATA'));
        assert.ok(JSON.stringify(messages.filter(message => message.role === 'user')).includes('SYNTHETIC-PLANNING-ARTIFACT-DATA'), 'Approved evidence remains available in the explicit data context.');
      }
    }
    if (turn === 2) assert.match(JSON.stringify(messages.filter(message => message.role === 'toolResult')), new RegExp(current.launch.init.planningSkills!.active.name));
  }));
  await current.driver.drive(current.launch); current.driver.beforeSettled = undefined;
  if (f.scriptErrors.length) throw f.scriptErrors[0];
  assert.equal(current.driver.stopped.has(current.launch.run.runId), true, JSON.stringify({ replies: current.driver.replies.slice(-3), frames: current.driver.frames.slice(-2), blockers: f.store.getDemand('demand').blockedReasons }));
  assert.equal(f.store.getDemand('demand').grant, undefined);
  assert.ok(current.driver.frames.some(frame => frame.type === 'worker.skill-request' && frame.runId === current.launch.run.runId), 'Every stage must produce its own Host-observed scoped skill read.');
  await f.coordinator.observeCompletedRuns();
  return current;
}
function answer(f: Fixture, answer: string) {
  const question = flow(f).questions[0]!;
  command(f, { ...bound(f), type: 'answer-planning-question', questionId: question.id, questionDigest: question.digest, answer });
}
async function approveChangedHumanInputs(f: Fixture) {
  const launches = f.drivers.flatMap(driver => driver.launches).length, calls = f.calls.length;
  await f.production.tick();
  assert.equal(f.drivers.flatMap(driver => driver.launches).length, launches, 'A human answer or confirmation cannot silently expand old model-data approval.');
  assert.equal(f.calls.length, calls);
  f.authorize();
}
async function confirmedRequirements(f: Fixture) {
  f.authorize();
  const factsRun = await run(f, 'facts', facts);
  await run(f, 'clarification', question);
  const waiting = f.drivers.flatMap(driver => driver.launches).length; await f.production.tick(); assert.equal(f.drivers.flatMap(driver => driver.launches).length, waiting);
  answer(f, 'Keep the existing empty input behavior unchanged.');
  await approveChangedHumanInputs(f);
  await run(f, 'clarification', understanding);
  assert.equal(flow(f).step, 'awaiting-understanding-confirmation');
  command(f, { ...bound(f), type: 'confirm-understanding', understandingId: flow(f).understanding!.id, digest: flow(f).understanding!.digest });
  await approveChangedHumanInputs(f);
  return factsRun;
}

async function consumeActive(driver: SyntheticPlanningNativePort, launch: Launch) {
  await driver.emit(launch, { type: 'model.request', sessionId: launch.init.sessionId, sequence: 2, purpose: 'prompt', context: { messages: [{ role: 'toolResult', toolCallId: 'manual-active-skill', toolName: 'controlled_skill', content: [{ type: 'text', text: launch.init.planningSkills!.active.entry.content }], isError: false, timestamp: 2 }] } });
  assert.equal(driver.replies.at(-1)?.ok, true, JSON.stringify(driver.replies.at(-1)));
}
async function loadActive(f: Fixture, driver: SyntheticPlanningNativePort, launch: Launch, changes: Record<string, unknown> = {}, consume = true) {
  const active = launch.init.planningSkills!.active, resource = { id: active.entry.id, sha256: active.entry.sha256, skillName: active.name, path: active.entry.path, ...changes };
  await driver.emit(launch, { type: 'worker.skill-request', requestId: randomUUID(), resource });
  const receipt = driver.replies.at(-1)!;
  if (receipt.ok === true && consume) await consumeActive(driver, launch);
  return receipt;
}

test('actual Pi Worker and production Host complete the connected staged planning journey without implementation authority', async t => {
  const f = fixture(t), head = git(f.binding.worktreePath, 'rev-parse', 'HEAD');
  const factsRun = await confirmedRequirements(f), designer = await run(f, 'design', design);
  assert.ok(f.calls.some(request => request.materials[0]!.text.includes('SYNTHETIC-PLANNER-CHAT-SECRET')), 'The designer really had private chat history to exclude from its fresh reviewer.');
  const reviewed = await run(f, 'design-review', review);
  assert.equal(factsRun.launch.init.role, 'boundary-review'); assert.equal(reviewed.launch.init.role, 'boundary-review');
  assert.notEqual(reviewed.launch.init.sessionId, designer.launch.init.sessionId);
  assert.notEqual(reviewed.launch.init.planning!.contextId, designer.launch.init.planning!.contextId);
  const independent = JSON.stringify(reviewed.launch.init.materials);
  assert.ok(independent.includes('requirements') && independent.includes('design'));
  assert.ok(!reviewed.launch.init.materials.some(material => /session|summary|user-decisions|facts/.test(material.id)), 'Fresh review receives only its explicit requirement/design/source inputs.');
  const activeResources = new Set([reviewed.launch.init.planningSkills!.entry.id, reviewed.launch.init.planningSkills!.active.entry.id]);
  assert.ok(reviewed.launch.init.materials.filter(material => material.kind === 'method').every(material => activeResources.has(material.id)), 'A fresh reviewer never receives the planner method closure or an unrelated stage skill.');
  assert.deepEqual(reviewed.launch.init.planningSkills!.active.references, []);
  await run(f, 'design-resolution', candidate => resolution(candidate, true));
  assert.equal(flow(f).resolution, undefined); answer(f, 'Yes. Preserve the current empty input behavior for existing callers.'); await approveChangedHumanInputs(f);
  await run(f, 'design-resolution', candidate => resolution(candidate, false));
  assert.equal(flow(f).step, 'awaiting-final-design-confirmation');
  assert.equal(flow(f).finalDesignConfirmation, undefined, 'Requirements confirmation cannot substitute for final design and seam confirmation.');
  command(f, { ...bound(f), type: 'confirm-final-design', designId: flow(f).design!.id, digest: flow(f).resolution!.digest });
  await approveChangedHumanInputs(f);
  await run(f, 'spec', spec); await run(f, 'tickets', tickets);
  const demand = f.store.getDemand('demand'), plan = demand.plans[0]!;
  assert.equal(flow(f).step, 'complete'); assert.equal(demand.phase, 'awaiting-authorization'); assert.equal(plan.ready, true);
  assert.equal(demand.plans.length, 1); assert.equal(demand.confirmedPlanId, plan.id); assert.equal(demand.grant, undefined);
  assert.equal(flow(f).spec!.kind, 'spec'); assert.deepEqual(flow(f).tickets.map(ticket => [ticket.kind, ticket.blockedBy]), [['ticket', []], ['ticket', ['ticket-one']]]);
  for (const ref of [plan.spec, plan.tickets, ...flow(f).tickets.map(ticket => ticket.evidence)]) assert.match(f.production.evidence.read(demand.id, ref).content, /R1|ticket-one/);
  assert.equal(git(f.binding.worktreePath, 'rev-parse', 'HEAD'), head); assert.equal(git(f.binding.worktreePath, 'status', '--porcelain'), '');
  const launches = f.drivers.flatMap(driver => driver.launches); await f.production.tick(); assert.equal(f.drivers.flatMap(driver => driver.launches).length, launches.length);
  assert.ok(launches.every(launch => !launch.run.writes && launch.init.role !== 'implementation'));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM host_boundary_runs').get()!.n, 0, 'Independent design review occurs before spec and tickets, without a post-hoc legacy reviewer.');
  const grants = f.store.db.prepare('SELECT id FROM model_grants').all(); assert.equal(grants.length, 5, 'Only the initial approval and four exact human-decision data changes create grants.');
  for (const row of grants) { const grant = f.budget.getGrant(String(row.id)); assert.deepEqual(grant.allowedRoles, ['planning', 'boundary-review']); assert.equal(grant.maxRequests, 100); }
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM model_budget_additions').get()!.n, 0, 'Automatic stages cannot replenish finite budgets.');
});

test('staged Host refuses legacy planning bypass and handoffs without an observed scoped skill read', async t => {
  const f = fixture(t); f.authorize(); const { driver, launch: current } = await launch(f, 'facts'); await f.ready(driver, current);
  await assert.rejects(f.report(driver, current, { type: 'plan-draft', plan: { id: 'bypass', scope: 'Bypass final design decisions', spec: pendingRef('bypass-spec'), tickets: pendingRef('bypass-tickets'), requiredChecks: [], unresolvedQuestions: [] } }), /staged|planning|role/i);
  await assert.rejects(f.report(driver, current, { type: 'plan-ready', planId: 'bypass', boundaryReview: { contextId: 'invented', planningContextId: current.init.planning!.contextId, evidence: pendingRef('bypass-evidence'), unresolvedBlockingFindings: [] } }), /staged|planning|role|independent/i);
  assert.equal(f.store.getDemand('demand').plans.length, 0);
  await f.report(driver, current, facts(f));
  assert.equal(driver.replies.at(-1)?.ok, false); assert.equal(driver.replies.at(-1)?.error, 'PLANNING_SKILL_NOT_OBSERVED');
  assert.equal(flow(f).facts, undefined); assert.throws(() => f.production.evidence.reference('demand', 'facts'));
  await f.settled(driver, current);
  assert.equal(flow(f).step, 'facts'); assert.equal(flow(f).facts, undefined);
});

test('actual Worker confines skill and relative-reference reads to the active stage before its handoff', async t => {
  const f = fixture(t); f.authorize(); const { driver, launch: current } = await launch(f, 'facts'); const report = facts(f);
  f.setScript((request, turn) => {
    const context = JSON.parse(request.materials[0]!.text) as { messages: { role: string; toolName?: string; isError?: boolean }[] };
    const results = context.messages.filter(message => message.role === 'toolResult');
    if (turn === 2) assert.equal(results.at(-1)?.isError, true, 'A future stage skill cannot be loaded.');
    if (turn === 3) assert.equal(results.at(-1)?.isError, true, 'An unloaded, cross-stage reference cannot be read.');
    const turns: NonNullable<ProviderResponse['toolCalls']>[] = [
      [{ id: 'denied-future-skill', name: 'controlled_skill', arguments: { name: 'to-spec' } }],
      [{ id: 'denied-reference', name: 'controlled_skill_resource', arguments: { from: current.init.planningSkills!.active.entry.path, path: '../../engineering/codebase-design/DEEPENING.md' } }],
      [{ id: 'allowed-active-skill', name: 'controlled_skill', arguments: { name: 'design-feature' } }],
      [{ id: 'allowed-stage-report', name: 'controlled_report', arguments: { report: modelReport(report) } }],
    ];
    return { text: turn === 5 ? 'Synthetic scope checks complete.' : '', ...(turns[turn - 1] ? { toolCalls: turns[turn - 1] } : {}) };
  });
  await driver.drive(current); if (f.scriptErrors.length) throw f.scriptErrors[0]; assert.equal(flow(f).step, 'clarification');
  const reads = driver.frames.filter(frame => frame.type === 'worker.skill-request'); assert.equal(reads.length, 1, 'Rejected local lookups never request Host bytes.');
  assert.equal((reads[0]!.resource as { id: string }).id, current.init.planningSkills!.active.entry.id);
});

test('actual Worker cannot hand off a batched skill read until another model operation consumes its exact body', async t => {
  const f = fixture(t); f.authorize(); const { driver, launch: current } = await launch(f, 'facts'), report = modelReport(facts(f));
  f.setScript((request, turn): ProviderResponse => {
    if (turn === 1) return { text: '', toolCalls: [
      { id: 'batched-skill', name: 'controlled_skill', arguments: { name: current.init.planningSkills!.active.name } },
      { id: 'premature-report', name: 'controlled_report', arguments: { report } },
    ] };
    if (turn === 2) {
      const context = JSON.parse(request.materials[0]!.text) as { messages: { role: string; toolName?: string; toolCallId?: string; content?: { type: string; text?: string }[]; isError?: boolean }[] };
      const results = context.messages.filter(message => message.role === 'toolResult');
      assert.equal(results.find(message => message.toolCallId === 'premature-report')?.isError, true, 'The first batched report must be rejected before the model consumes its skill.');
      assert.ok(results.some(message => message.toolName === 'controlled_skill' && message.content?.some(part => part.type === 'text' && part.text === current.init.planningSkills!.active.entry.content)));
      assert.equal(flow(f).step, 'facts'); assert.equal(flow(f).facts, undefined);
      assert.ok(!driver.frames.some(frame => frame.type === 'worker.report') || driver.replies.some(reply => reply.type === 'worker.receipt' && reply.ok === false && reply.error === 'PLANNING_SKILL_NOT_OBSERVED'), 'Concurrent tools reject locally before the read settles, or the Host rejects the premature handoff.');
      assert.throws(() => f.production.evidence.reference('demand', 'facts'), 'Premature evidence never enters the artifact registry.');
      return { text: '', toolCalls: [{ id: 'report-after-consumption', name: 'controlled_report', arguments: { report } }] };
    }
    assert.equal(turn, 3); assert.equal(flow(f).facts, undefined, 'The retry still waits for stopped native evidence.'); return { text: 'Synthetic stage handoff after observed skill consumption.' };
  });
  await driver.drive(current); await f.coordinator.observeCompletedRuns();
  if (f.scriptErrors.length) throw f.scriptErrors[0];
  assert.equal(flow(f).step, 'clarification'); assert.ok(flow(f).facts);
  assert.equal(driver.frames.filter(frame => frame.type === 'worker.skill-request').length, 1, 'Retry reuses the same already verified skill body.');
  assert.equal(driver.frames.filter(frame => frame.type === 'model.request').length, 3);
});

test('Host binds skill receipts and pending reports to exact hashes, flow versions and native stop', async t => {
  const f = fixture(t); f.authorize(); const { driver, launch: current } = await launch(f, 'facts'); await f.ready(driver, current);
  const denied = await loadActive(f, driver, current, { sha256: 'b'.repeat(64) }); assert.equal(denied.ok, false);
  const accepted = await loadActive(f, driver, current, {}, false); assert.equal(accepted.ok, true);
  const before = structuredClone(flow(f));
  await f.report(driver, current, facts(f)); assert.equal(driver.replies.at(-1)?.error, 'PLANNING_SKILL_NOT_OBSERVED');
  assert.equal(driver.replies.at(-1)?.ok, false); assert.deepEqual(flow(f), before); assert.throws(() => f.production.evidence.reference('demand', 'facts'));
  await consumeActive(driver, current);
  await assert.rejects(f.report(driver, current, { ...facts(f), flowRevision: flow(f).revision + 1 }), /flow|version|stale|binding/i);
  await f.report(driver, current, facts(f)); assert.deepEqual(flow(f), before);
  await f.report(driver, current, facts(f)); assert.equal(driver.replies.at(-1)?.ok, false); assert.equal(driver.replies.at(-1)?.error, 'REPORT_PENDING');
  await f.settled(driver, current); assert.equal(flow(f).step, 'clarification');
  await assert.rejects(f.report(driver, current, facts(f)), { code: 'FRAME_TYPE_DENIED' });
  assert.equal(flow(f).revision, before.revision + 1, 'Stale and repeated reports cannot advance a second stage.');
});

test('a live staged context cannot switch its skill or model operations onto a replacement grant', async t => {
  const f = fixture(t); f.authorize('original-grant'); const { driver, launch: current } = await launch(f, 'facts'); await f.ready(driver, current);
  const calls = f.calls.length; f.authorize('replacement-grant');
  const denied = await loadActive(f, driver, current); assert.equal(denied.ok, false); assert.equal(denied.error, 'MODEL_GRANT_CHANGED');
  await driver.emit(current, { type: 'model.request', sessionId: current.init.sessionId, sequence: 2, purpose: 'prompt', context: { messages: [{ role: 'user', content: 'This original session cannot acquire the replacement grant.', timestamp: 2 }] } });
  assert.equal(driver.replies.at(-1)?.ok, false); assert.equal(driver.replies.at(-1)?.error, 'MODEL_GRANT_CHANGED'); assert.equal(f.calls.length, calls);
  assert.equal(f.budget.snapshot('replacement-grant').requests, 0); assert.equal(flow(f).step, 'facts'); assert.equal(flow(f).facts, undefined);
  await f.settled(driver, current);
});

for (const control of ['pause', 'cancel'] as const) test(`${control} discards live staged handoff authority before it can advance`, async t => {
  const f = fixture(t); f.authorize(); const { driver, launch: current } = await launch(f, 'facts'); await f.ready(driver, current); assert.equal((await loadActive(f, driver, current)).ok, true);
  await f.report(driver, current, facts(f));
  f.workflow.execute({ type: control, requestId: randomUUID(), demandId: 'demand', expectedRevision: f.store.getDemand('demand').revision }, f.user); await f.production.tick();
  assert.equal(driver.stopped.has(current.run.runId), true); assert.equal(flow(f).step, 'facts'); assert.equal(flow(f).facts, undefined);
  await assert.rejects(f.settled(driver, current), { code: 'PLANNING_AUTHORITY_CHANGED' });
  assert.equal(flow(f).step, 'facts'); assert.equal(flow(f).facts, undefined, 'A late terminal frame cannot restore discarded planning authority.');
  assert.equal(f.store.getDemand('demand').control, control === 'pause' ? 'paused' : 'cancelled'); assert.equal(f.store.getDemand('demand').grant, undefined);
});

test('source drift after a scoped report invalidates facts before durable stage advancement', async t => {
  const f = fixture(t); f.authorize(); const { driver, launch: current } = await launch(f, 'facts'); await f.ready(driver, current); assert.equal((await loadActive(f, driver, current)).ok, true);
  await f.report(driver, current, facts(f)); writeFileSync(join(f.binding.worktreePath, 'code.txt'), 'Unapproved external source change.\n');
  await assert.rejects(f.settled(driver, current), /source|input/i);
  assert.equal(flow(f).step, 'facts'); assert.equal(flow(f).facts, undefined); assert.equal(f.store.getDemand('demand').plans.length, 0);
});

test('source change between stages invalidates confirmed design and requires newly approved facts', async t => {
  const f = fixture(t); await confirmedRequirements(f); await run(f, 'design', design);
  const previous = structuredClone(flow(f)), launches = f.drivers.flatMap(driver => driver.launches).length, calls = f.calls.length;
  writeFileSync(join(f.binding.worktreePath, 'code.txt'), 'Externally revised source behavior.\n');
  await f.production.tick();
  assert.equal(flow(f).step, 'facts'); assert.equal(flow(f).facts, undefined); assert.equal(flow(f).understandingConfirmation, undefined); assert.equal(flow(f).design, undefined);
  assert.ok(flow(f).revision > previous.revision); assert.equal(f.store.getDemand('demand').grant, undefined);
  assert.equal(f.drivers.flatMap(driver => driver.launches).length, launches, 'Old data approval cannot authorize the externally changed source.'); assert.equal(f.calls.length, calls);
  assert.throws(() => command(f, { flowId: previous.id, flowRevision: previous.revision, type: 'confirm-understanding', understandingId: previous.understanding!.id, digest: previous.understanding!.digest }), /exact|stale|version/i);
  f.authorize();
  await run(f, 'facts', current => ({ ...bound(current), type: 'planning-facts', evidence: pendingRef('facts-new-source'), summary: 'The entry point now contains externally revised behavior; clarify affected requirements.', artifactBodies: [body('facts-new-source', 'Read the newly approved source bytes before reusing any prior design.', 'check-evidence')] }));
  assert.equal(flow(f).step, 'clarification'); assert.notEqual(flow(f).facts!.runId, previous.facts!.runId); assert.equal(flow(f).understandingConfirmation, undefined);
});

test('restart and pause preserve confirmed requirements while scoped revision invalidates their old authority', async t => {
  const f = fixture(t); await confirmedRequirements(f);
  const confirmed = structuredClone(flow(f).understandingConfirmation), oldBinding = bound(f), questions = structuredClone(flow(f).answers);
  f.workflow.execute({ type: 'pause', requestId: randomUUID(), demandId: 'demand', expectedRevision: f.store.getDemand('demand').revision }, f.user); await f.production.tick(); f.restart();
  assert.deepEqual(flow(f).understandingConfirmation, confirmed); assert.deepEqual(flow(f).answers, questions);
  const stopped = f.drivers.flatMap(driver => driver.launches).length; await f.production.tick(); assert.equal(f.drivers.flatMap(driver => driver.launches).length, stopped);
  f.workflow.execute({ type: 'resume', requestId: randomUUID(), demandId: 'demand', expectedRevision: f.store.getDemand('demand').revision }, f.user); await run(f, 'design', design);
  assert.deepEqual(flow(f).understandingConfirmation, confirmed); assert.equal(f.store.listRuns().filter(run => run.planningStep === 'facts').length, 1, 'Restart does not repeat still-valid fact discovery.');
  command(f, { ...bound(f), type: 'revise-planning', scope: 'requirements', reason: 'The owner reopens the requested behavior.' });
  assert.equal(flow(f).understandingConfirmation, undefined); assert.equal(flow(f).design, undefined);
  assert.throws(() => command(f, { ...oldBinding, type: 'confirm-understanding', understandingId: flow(f).understanding!.id, digest: confirmed!.digest }), /exact|stale|version/i);
  assert.equal(f.store.getDemand('demand').grant, undefined);
  const reopened = new WorkflowService(f.store); assert.equal(reopened.store.getDemand('demand').planningFlow!.step, 'clarification');
});
