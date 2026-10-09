import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executionProductionFixture, implementTickets, drive, reviewScript, writerScript, call, context, pending, seam, git } from './helpers/execution-production.ts';
import type { ExecutionFixture, Launch, SyntheticPlanningNativePort } from './helpers/execution-production.ts';
import type { ExecutionFindingInput } from '../src/domain/types.ts';
import { HostApplication } from '../src/host/application.ts';

// Installed Pi SDK + actual Worker framing + production Host/SQLite/Git.
// Native ownership/ACL observations and provider responses are explicitly
// synthetic. Local Node checks execute for real; no network model call occurs.
test('production implement-spec executes the serial frontier, fresh Standards then Spec on the same uncommitted K, and gates user acceptance', async t => {
  const f = executionProductionFixture(t), head = git(f.binding.worktreePath, 'rev-parse', 'HEAD');
  assert.equal(f.demand().phase, 'awaiting-authorization'); assert.equal(f.demand().executionFlow, undefined);
  await f.production.tick(); assert.equal(f.drivers.flatMap(driver => driver.launches).length, 0);
  f.authorizeImplementation(); await f.production.tick(); assert.equal(f.drivers.flatMap(driver => driver.launches).length, 0, 'Implementation consent grants neither model spend nor runtime/data scope.');
  const missingRuntime = f.authorizeModel(false); await f.production.tick(); assert.equal(f.drivers.flatMap(driver => driver.launches).length, 0, 'Model data consent alone grants no native runtime scope.');
  f.store.db.prepare('UPDATE host_model_decisions SET runtime_scope=? WHERE grant_id=?').run('demand-worktree-private-runtime-v1', missingRuntime);
  const { first, second } = await implementTickets(f);
  assert.equal(first.launch.init.execution!.ticketId, 'ticket-one'); assert.equal(second.launch.init.execution!.ticketId, 'ticket-two');
  assert.equal(first.launch.run.writes, true); assert.equal(second.launch.run.writes, true);
  assert.deepEqual(f.nativeChecks.map(check => check.exitCode), [1, 0, 1, 0]);
  assert.equal(f.demand().activeResultId, undefined);
  const standards = await f.launch('review-standards');
  assert.throws(() => f.command({ type: 'accept-result', resultId: 'not-yet-a-result' }));
  await drive(f, standards, reviewScript(f, standards.launch, [], (request, turn) => {
    if (turn !== 1) return;
    const model = JSON.stringify(context(request));
    assert.ok(!model.includes('WRITER-PRIVATE-CHAT')); assert.ok(!model.includes('WRITER-PRIVATE-DELIVERY-NOTES'));
    assert.ok(!model.includes(JSON.stringify(standards.launch.init.executionSkills!.entry.content).slice(1, -1)), 'Root skill bytes must enter only through the explicit scoped read.');
  }));
  assert.equal(f.demand().activeResultId, undefined, 'A Standards pass alone cannot establish completion.');
  const spec = await f.launch('review-spec');
  assert.notEqual(spec.launch.init.sessionId, standards.launch.init.sessionId); assert.notEqual(spec.launch.init.execution!.contextId, standards.launch.init.execution!.contextId);
  assert.equal(spec.launch.init.execution!.contentId, 'K2'); assert.equal(standards.launch.init.execution!.contentId, 'K2');
  for (const review of [standards, spec]) {
    assert.equal(review.launch.run.writes, false);
    const material = JSON.stringify(review.launch.init.materials);
    assert.ok(!material.includes('WRITER-PRIVATE')); assert.ok(!material.includes('STANDARDS-PRIVATE')); assert.ok(!material.includes('SPEC-PRIVATE'));
    assert.ok(review.launch.init.materials.some(item => item.id.startsWith('execution-diff:') && item.content.includes('behavior.mjs')), 'Review inspects base-to-frozen-source including uncommitted source.');
  }
  const specScript = reviewScript(f, spec.launch);
  await drive(f, spec, (request, turn) => {
    assert.equal(spec.launch.init.executionSkills!.codebaseDesign, null, 'Independent reviewers receive no conditional writer vocabulary.');
    if (turn === 3) return { text: '', toolCalls: [call('controlled_skill', { name: 'codebase-design' })] };
    if (turn === 4) assert.match(JSON.stringify(context(request).messages.filter(message => message.role === 'toolResult' && message.isError)), /Only the Host-selected root and stage skills/);
    return specScript(request, turn > 3 ? turn - 1 : turn);
  });
  assert.equal(f.demand().executionFlow!.step, 'complete'); assert.equal(f.demand().phase, 'awaiting-acceptance');
  assert.equal(f.demand().executionFlow!.reviews.length, 2); assert.equal(f.demand().results.length, 1); assert.equal(f.demand().acceptances.length, 0);
  assert.deepEqual(f.demand().results[0]!.E.map(check => [check.requirementId, check.contentId, check.status]), [['behavior', 'K2', 'passed']]);
  assert.equal(f.demand().results[0]!.review.runId, spec.launch.init.domainRunId);
  assert.equal(f.demand().executionFlow!.baseCommit, head); assert.equal(git(f.binding.worktreePath, 'rev-parse', 'HEAD'), head); assert.match(git(f.binding.worktreePath, 'status', '--porcelain'), /behavior/);
  assert.ok(f.store.listRuns('demand').every(run => run.status === 'stopped'));
  f.command({ type: 'accept-result', resultId: f.demand().activeResultId! }); assert.equal(f.demand().acceptances[0]!.decision, 'accepted');
  const launches = f.drivers.flatMap(driver => driver.launches); assert.deepEqual(launches.map(item => item.init.execution!.step), ['ticket-implementation', 'ticket-implementation', 'review-standards', 'review-spec']);
  assert.equal(new Set(launches.map(item => item.init.sessionId)).size, 4);
  const keys = launches.map(item => String(f.store.db.prepare('SELECT operation_key FROM host_run_operation_keys WHERE run_id=?').get(item.init.domainRunId)!.operation_key));
  assert.equal(new Set(keys).size, 4, 'Tickets and both broad axes retain independent finite retry operations.');
  for (const current of launches) assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM host_planning_skill_reads WHERE runtime_run_id=?').get(current.run.runId)!.n, 2);
});

test('production findings enter one serial fix and focused axis resolutions without restarting broad review', async t => {
  const f = executionProductionFixture(t); f.authorizeImplementation(); f.authorizeModel(); await implementTickets(f, true);
  const standards = await f.launch('review-standards');
  const standardRef = f.production.evidence.reference('demand', standards.launch.init.materials.find(material => material.id.startsWith('execution-standards:'))!.id);
  const finding = (id: string, category: ExecutionFindingInput['category']): ExecutionFindingInput => ({ id, category, severity: 'blocking', location: 'behavior.mjs:1', basis: category === 'spec-violation' ? 'R2 specifies the undefined fallback.' : 'CONTRIBUTING.md requires explicit undefined handling at the entry point.', impact: 'The exact documented obligation is not implemented.', verification: seam, reference: category === 'spec-violation' ? f.demand().planningFlow!.spec!.evidence : standardRef, ...(category === 'spec-violation' ? { clause: 'R2' } : {}), requiresDesignDecision: false });
  await drive(f, standards, reviewScript(f, standards.launch, [finding('standards-entry', 'documented-violation')]));
  assert.equal(f.demand().executionFlow!.step, 'review-spec', 'Standards findings are collected before launching a single combined repair.');
  const spec = await f.launch('review-spec'); await drive(f, spec, reviewScript(f, spec.launch, [finding('spec-fallback', 'spec-violation')]));
  const repair = f.demand().executionFlow!.repairScope!; assert.deepEqual(repair.findingIds.sort(), ['spec-fallback', 'standards-entry']); assert.equal(f.demand().activeResultId, undefined);
  const fix = await f.launch('ticket-fix'); assert.equal(fix.launch.run.writes, true);
  await drive(f, fix, writerScript(f, fix.launch, { id: 'K3', tests: "assert.equal(behavior(undefined), 'fallback'); assert.equal(behavior(''), ''); assert.equal(behavior('requested'), 'requested');", source: "export function behavior(value) { return value === undefined ? 'fallback' : value; }\n" }));
  const standardsResolution = await f.launch('resolution-standards');
  const inputs = JSON.parse(standardsResolution.launch.init.materials.find(item => item.id.startsWith('execution-input:'))!.content);
  assert.deepEqual(inputs.repairScope.findingIds, ['standards-entry']); assert.ok(!JSON.stringify(inputs).includes('spec-fallback'));
  await drive(f, standardsResolution, reviewScript(f, standardsResolution.launch));
  const specResolution = await f.launch('resolution-spec');
  const specInputs = JSON.parse(specResolution.launch.init.materials.find(item => item.id.startsWith('execution-input:'))!.content);
  assert.deepEqual(specInputs.repairScope.findingIds, ['spec-fallback']); assert.ok(!JSON.stringify(specInputs).includes('standards-entry'));
  await drive(f, specResolution, reviewScript(f, specResolution.launch));
  assert.equal(f.demand().executionFlow!.step, 'complete'); assert.equal(f.demand().executionFlow!.reviews.length, 2); assert.equal(f.demand().executionFlow!.resolutions.length, 2);
  assert.ok(f.demand().findings.every(item => item.status === 'closed')); assert.equal(f.demand().activeContentId, 'K3'); assert.equal(f.demand().results.length, 1);
  // Reopen the persisted production database through the desktop Host facade.
  f.store.db.exec('ALTER TABLE host_model_decisions ADD COLUMN configuration_digest TEXT');
  const app = new HostApplication(join(f.root, 'host.sqlite'));
  try {
    const view = app.snapshot().demands.find(demand => demand.id === 'demand')!;
    assert.deepEqual(view.executionFlow, f.demand().executionFlow);
    assert.deepEqual(view.executionFlow!.tickets.map(ticket => ticket.status), ['done', 'done']);
    assert.equal(view.executionFlow!.reviews.length, 2); assert.equal(view.executionFlow!.resolutions.length, 2);
  } finally { app.close(); }
  assert.deepEqual(f.drivers.flatMap(driver => driver.launches).map(item => item.init.execution!.step), ['ticket-implementation', 'ticket-implementation', 'review-standards', 'review-spec', 'ticket-fix', 'resolution-standards', 'resolution-spec']);
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function uncheckedContent() {
  return { type: 'execution-content', content: { id: 'unverified', planId: 'ready-plan', code: { id: 'unverified-code', digest: 'pending', location: 'current-worktree' }, knowledge: [], maintenance: 'not-needed', deliveryNotes: 'A report alone cannot establish execution.' }, tdd: { mode: 'red-green', testingSeams: [seam], red: [pending('invented-red')], green: [pending('invented-green')] } };
}
function boundReport(launch: Launch, body: Record<string, unknown>) {
  const { step, contextId: _contextId, ...binding } = launch.init.execution!;
  return { ...body, ...binding, executionStep: step };
}
async function loadSkill(driver: SyntheticPlanningNativePort, launch: Launch, name: 'implement-spec' | 'active') {
  const projection = launch.init.executionSkills!, resource = name === 'implement-spec' ? projection.entry : projection.active.entry;
  await driver.emit(launch, { type: 'worker.skill-request', requestId: randomUUID(), resource: { id: resource.id, sha256: resource.sha256, path: resource.path, skillName: name === 'implement-spec' ? name : projection.active.name } });
  return driver.replies.at(-1)!;
}
async function consumeSkills(driver: SyntheticPlanningNativePort, launch: Launch) {
  await driver.emit(launch, { type: 'model.request', sessionId: launch.init.sessionId, sequence: 2, purpose: 'prompt', context: { messages: [launch.init.executionSkills!.entry, launch.init.executionSkills!.active.entry].map((resource, index) => ({ role: 'toolResult', toolCallId: `manual-skill-${index}`, toolName: 'controlled_skill', content: [{ type: 'text', text: resource.content }], isError: false, timestamp: index + 2 })) } });
  assert.equal(driver.replies.at(-1)?.ok, true, JSON.stringify(driver.replies.at(-1)));
}

test('actual Worker rejects missing root, missing active dependency and same-batch load/report before any terminal frame reaches Host', async t => {
  const f = executionProductionFixture(t); f.authorizeImplementation(); f.authorizeModel(); const current = await f.launch('ticket-implementation');
  let errors = '';
  await drive(f, current, (request, turn) => {
    errors = JSON.stringify(context(request).messages.filter(message => message.role === 'toolResult' && message.isError));
    const toolCalls = turn === 1 ? [call('controlled_skill', { name: current.launch.init.executionSkills!.active.name })]
      : turn === 2 ? [call('controlled_report', { report: uncheckedContent() })]
      : turn === 3 ? [call('controlled_skill', { name: 'implement-spec' })]
      : turn === 4 ? [call('controlled_report', { report: uncheckedContent() })]
      : turn === 5 ? [call('controlled_skill', { name: current.launch.init.executionSkills!.active.name }), call('controlled_report', { report: uncheckedContent() })] : [];
    return { text: '', ...(toolCalls.length ? { toolCalls } : {}) };
  });
  assert.match(errors, /implement-spec/); assert.match(errors, /subsequent model turn/);
  assert.equal(current.driver.frames.filter(frame => frame.type === 'worker.report').length, 0);
  assert.equal(f.demand().executionFlow!.step, 'ticket-implementation'); assert.equal(f.demand().contents.length, 0);
  assert.equal(f.nativeChecks.length, 0); assert.equal(git(f.binding.worktreePath, 'status', '--porcelain'), '');
});

test('Host independently rejects unaudited, unconsumed and stale-scope execution frames', async t => {
  const f = executionProductionFixture(t); f.authorizeImplementation(); f.authorizeModel(); const { driver, launch } = await f.launch('ticket-implementation'); await f.ready(driver, launch);
  assert.equal((await loadSkill(driver, launch, 'active')).error, 'EXECUTION_SKILL_ORDER');
  await f.report(driver, launch, boundReport(launch, uncheckedContent())); assert.equal(driver.replies.at(-1)!.error, 'EXECUTION_SKILL_NOT_OBSERVED');
  assert.equal((await loadSkill(driver, launch, 'implement-spec')).ok, true);
  await f.report(driver, launch, boundReport(launch, uncheckedContent())); assert.equal(driver.replies.at(-1)!.error, 'EXECUTION_SKILL_NOT_OBSERVED');
  assert.equal((await loadSkill(driver, launch, 'active')).ok, true);
  await f.report(driver, launch, boundReport(launch, uncheckedContent())); assert.equal(driver.replies.at(-1)!.error, 'EXECUTION_SKILL_NOT_OBSERVED', 'Scoped reads without a later successful model context cannot establish skill consumption.');
  await consumeSkills(driver, launch);
  for (const changes of [{ inputDigest: 'f'.repeat(64) }, { ticketId: 'ticket-two' }, { scope: 'whole-spec' }, { flowRevision: launch.init.execution!.flowRevision + 1 }]) {
    await assert.rejects(f.report(driver, launch, { ...boundReport(launch, uncheckedContent()), ...changes }), /exact Host-selected step/);
  }
  await assert.rejects(f.report(driver, launch, { ...boundReport(launch, uncheckedContent()), type: 'content-ready' }), /legacy handoffs/);
  await f.settled(driver, launch); await f.coordinator.observeCompletedRuns(); assert.equal(f.demand().contents.length, 0);
});

test('Host denies fabricated, duplicated, reversed and nonpassing TDD receipts despite real successful source writes and native checks', async t => {
  const f = executionProductionFixture(t); f.authorizeImplementation(); f.authorizeModel(); const current = await f.launch('ticket-implementation');
  const script = writerScript(f, current.launch, { id: 'K-invalid', tests: "assert.equal(behavior('requested'), 'requested');", source: "export function behavior(value) { return 'requested'; }\n", alter: report => { const tdd = report.tdd as { red: unknown[]; green: unknown[] }; [tdd.red, tdd.green] = [tdd.green, tdd.red]; } });
  f.setScript(script); await assert.rejects(current.driver.drive(current.launch), /green receipt|exit successfully/);
  assert.equal(f.demand().contents.length, 0); assert.deepEqual(f.nativeChecks.map(check => check.exitCode), [1, 0]);
  const reportFrame = current.driver.frames.find(frame => frame.type === 'worker.report')!;
  const original = structuredClone(reportFrame.report) as import('../src/domain/types.ts').WorkerReport & { type: 'execution-content' };
  original.content.code = f.production.evidence.reference('demand', 'code-K-invalid');
  [original.tdd.red, original.tdd.green] = [original.tdd.green, original.tdd.red];
  const run = f.store.getRun(current.launch.init.domainRunId);
  assert.equal(f.production.prerequisites.verifyReport(original, run).executionStage!.tddVerified, true, 'The captured real receipts are valid before adversarial substitutions.');
  const mutations = [
    (report: typeof original) => { report.tdd.red = [pending('fabricated-red')]; },
    (report: typeof original) => { report.tdd.green = [...report.tdd.red]; },
    (report: typeof original) => { report.tdd.red = [...report.tdd.green]; },
    (report: typeof original) => { report.tdd.green.push(report.tdd.green[0]!); },
    (report: typeof original) => { [report.tdd.red, report.tdd.green] = [report.tdd.green, report.tdd.red]; },
    (report: typeof original) => { report.tdd.mode = 'preserve-behavior'; report.tdd.red = []; report.tdd.rationale = 'Unapproved implementation exception.'; },
  ];
  for (const mutate of mutations) { const report = structuredClone(original); mutate(report); assert.throws(() => f.production.prerequisites.verifyReport(report, run), /artifact|receipt|green|Preserved-behavior/i); }
  assert.equal(f.demand().executionFlow!.ticketId, 'ticket-one'); assert.equal(f.demand().activeResultId, undefined);
});

test('paused Worker handoff cannot establish content or advance the frontier after its pending receipt', async t => {
  const f = executionProductionFixture(t); f.authorizeImplementation(); f.authorizeModel(); const current = await f.launch('ticket-implementation');
  const before = structuredClone(f.demand().executionFlow);
  current.driver.beforeSettled = () => { assert.ok(current.driver.replies.some(reply => (reply.value as { status?: string })?.status === 'pending-stop-verification')); f.command({ type: 'pause' }); };
  f.setScript(writerScript(f, current.launch, { id: 'K-paused', tests: "assert.equal(behavior('requested'), 'requested');", source: "export function behavior(value) { return 'requested'; }\n" }));
  await assert.rejects(current.driver.drive(current.launch), /Stopped or changed user control|late planning handoff/);
  assert.deepEqual(f.demand().executionFlow, { ...before, revision: before!.revision + 1 }); assert.equal(f.demand().contents.length, 0); assert.equal(f.demand().control, 'paused'); assert.equal(current.driver.stopped.has(current.launch.run.runId), true);
  const count = f.drivers.flatMap(driver => driver.launches).length; await f.production.tick(); assert.equal(f.drivers.flatMap(driver => driver.launches).length, count);
});

test('source drift after queued execution report fails the stopped source gate and cannot become K', async t => {
  const f = executionProductionFixture(t); f.authorizeImplementation(); f.authorizeModel(); const current = await f.launch('ticket-implementation');
  current.driver.beforeSettled = () => writeFileSync(join(f.binding.worktreePath, 'code.txt'), 'Unapproved external source change.\n');
  f.setScript(writerScript(f, current.launch, { id: 'K-drift', tests: "assert.equal(behavior('requested'), 'requested');", source: "export function behavior(value) { return 'requested'; }\n" }));
  await assert.rejects(current.driver.drive(current.launch), /source|mutation/i);
  assert.equal(f.demand().contents.length, 0); assert.equal(f.demand().executionFlow!.ticketId, 'ticket-one'); assert.ok(f.demand().blockedReasons.some(reason => /TERMINAL_INPUTS_CHANGED/.test(reason)));
});

test('missing approved seams, changed approved scope and missing baseline fail before any execution/model launch', async t => {
  const f = executionProductionFixture(t); f.authorizeImplementation();
  const original = f.demand();
  const withoutSeams = structuredClone(original); withoutSeams.planningFlow!.design!.testingSeams = []; f.store.saveDemand(withoutSeams);
  assert.throws(() => f.production.requiredModelData('demand'), /approved testing seams/);
  const changedScope = structuredClone(original); changedScope.planningFlow!.design!.constraints.push('A later unapproved scope change.'); f.store.saveDemand(changedScope);
  assert.throws(() => f.production.requiredModelData('demand'), /approved execution inputs/);
  f.store.saveDemand(original);
  const binding = f.workspace.getBinding('demand')!;
  f.store.db.prepare('UPDATE workspace_bindings SET data=? WHERE demand_id=?').run(JSON.stringify({ ...binding, currentBaseline: null }), 'demand');
  assert.throws(() => f.production.requiredModelData('demand'), /baseline commit/);
  assert.equal(f.calls.length, 0); assert.equal(f.drivers.flatMap(driver => driver.launches).length, 0); assert.equal(f.demand().activeResultId, undefined);
});


test('coordinator observer waits for the native stop and terminal report to settle before classifying the execution run', async t => {
  const f = executionProductionFixture(t); f.authorizeImplementation(); f.authorizeModel(); const current = await f.launch('ticket-implementation');
  const entered = deferred(), release = deferred(), stop = current.driver.stop.bind(current.driver);
  current.driver.stop = async run => { const observed = await stop(run); entered.resolve(); await release.promise; return observed; };
  f.setScript(writerScript(f, current.launch, { id: 'K-race', tests: "assert.equal(behavior('requested'), 'requested');", source: "export function behavior(value) { return 'requested'; }\n" }));
  const running = current.driver.drive(current.launch);
  try {
    await Promise.race([entered.promise, running.then(() => { throw new Error('Worker completed before reaching the held synthetic stop.'); })]); await f.coordinator.observeCompletedRuns();
    assert.equal(f.store.getRun(current.launch.init.domainRunId).status, 'running');
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM host_exit_classifications WHERE run_id=?').get(current.launch.init.domainRunId)!.n, 0);
    assert.deepEqual(f.demand().blockedReasons, []); assert.equal(f.demand().activeContentId, undefined);
  } finally { release.resolve(); }
  await running; await f.coordinator.observeCompletedRuns();
  assert.equal(f.demand().activeContentId, 'K-race'); assert.equal(f.demand().executionFlow!.ticketId, 'ticket-two');
  assert.equal(f.store.db.prepare('SELECT outcome FROM host_exit_classifications WHERE run_id=?').get(current.launch.init.domainRunId)!.outcome, 'handoff');
});

test('pause and resume keep one ticket operation retry budget across execution input revisions', async t => {
  const f = executionProductionFixture(t); f.authorizeImplementation(); f.authorizeModel(); const first = await f.launch('ticket-implementation');
  const originalRevision = first.launch.init.execution!.flowRevision;
  const key = String(f.store.db.prepare('SELECT operation_key FROM host_run_operation_keys WHERE run_id=?').get(first.launch.init.domainRunId)!.operation_key);
  f.command({ type: 'pause' }); await f.coordinator.flushStops(); f.command({ type: 'resume' }); f.authorizeModel();
  const second = await f.launch('ticket-implementation');
  assert.ok(second.launch.init.execution!.flowRevision > originalRevision);
  assert.equal(f.store.db.prepare('SELECT operation_key FROM host_run_operation_keys WHERE run_id=?').get(second.launch.init.domainRunId)!.operation_key, key);
  assert.equal(f.store.db.prepare('SELECT attempts FROM runtime_retry_counts WHERE operation_id=?').get(key)!.attempts, 2);
  f.command({ type: 'pause' }); await f.coordinator.flushStops();
});

test('interrupted second writer can resume retained partial source only after fresh data approval, while review still rejects source drift', async t => {
  const f = executionProductionFixture(t); f.authorizeImplementation(); const grant = f.authorizeModel();
  const first = await f.launch('ticket-implementation');
  await drive(f, first, writerScript(f, first.launch, { id: 'K1', tests: "assert.equal(behavior('requested'), 'requested');", source: "export function behavior(value) { return 'requested'; }\n" }));
  const second = await f.launch('ticket-implementation');
  const script = writerScript(f, second.launch, { id: 'K-interrupted', tests: "assert.equal(behavior(''), '');", source: 'export function behavior(value) { return value; }\n' });
  f.setScript((request, turn) => { if (turn === 4) { f.command({ type: 'pause' }); return { text: 'Stopped after the controlled partial test write.' }; } return script(request, turn); });
  await assert.rejects(second.driver.drive(second.launch), /Stopped or changed user control|late planning handoff/);
  await f.coordinator.flushStops(); f.command({ type: 'resume' });
  assert.equal(f.demand().activeContentId, 'K1'); assert.equal(f.demand().executionFlow!.ticketId, 'ticket-two');
  const nextData = f.production.requiredModelData('demand'); assert.ok(nextData.some(item => item.id === 'source-scope:demand'));
  const calls = f.calls.length, launches = f.drivers.flatMap(driver => driver.launches).length;
  await f.production.tick(); assert.equal(f.drivers.flatMap(driver => driver.launches).length, launches); assert.equal(f.calls.length, calls, 'A paused writer cannot silently approve its new input revision for model transmission.');
  const fresh = f.authorizeModel(); assert.notEqual(fresh, grant);
  const resumed = await f.launch('ticket-implementation');
  await drive(f, resumed, writerScript(f, resumed.launch, { id: 'K2', tests: "assert.equal(behavior(''), ''); assert.equal(behavior(undefined), 'fallback');", source: "export function behavior(value) { return value === undefined ? 'fallback' : value; }\n" }));
  assert.equal(f.demand().activeContentId, 'K2'); assert.equal(f.demand().executionFlow!.step, 'review-standards');
  const review = await f.launch('review-standards');
  writeFileSync(join(f.binding.worktreePath, 'code.txt'), 'External change after immutable reviewer launch.\n');
  await review.driver.emit(review.launch, { type: 'worker.ready', sessionId: review.launch.init.sessionId });
  await review.driver.emit(review.launch, { type: 'model.request', sessionId: review.launch.init.sessionId, sequence: 1, purpose: 'prompt', context: { messages: [{ role: 'user', content: 'Read-only review request.', timestamp: 1 }] } });
  assert.equal(review.driver.replies.at(-1)!.ok, false); assert.equal(review.driver.replies.at(-1)!.error, 'READ_ONLY_SOURCE_CHANGED');
  assert.equal(f.demand().executionFlow!.reviews.length, 0); assert.equal(f.demand().activeContentId, 'K2'); assert.equal(f.demand().activeResultId, undefined);
});


test('mandatory Standards findings reject design references and empty repository standards evidence', async t => {
  for (const scenario of ['design-reference', 'no-repository-standards'] as const) await t.test(scenario, async t => {
    const f = executionProductionFixture(t, { standards: scenario !== 'no-repository-standards' }); f.authorizeImplementation(); f.authorizeModel(); await implementTickets(f, true);
    const current = await f.launch('review-standards');
    const reference = scenario === 'design-reference' ? f.demand().planningFlow!.design!.evidence : f.production.evidence.reference('demand', current.launch.init.materials.find(material => material.id.startsWith('execution-standards:'))!.id);
    const finding: ExecutionFindingInput = { id: 'undocumented-rule', category: 'documented-violation', severity: 'blocking', location: 'behavior.mjs:1', basis: 'A proposed preference must not become a mandatory repository rule.', impact: 'Would force an unapproved change.', verification: seam, reference, requiresDesignDecision: false };
    f.setScript(reviewScript(f, current.launch, [finding]));
    await assert.rejects(current.driver.drive(current.launch), /mandatory documented-standard violation.*actual nonempty text source/);
    assert.equal(f.demand().executionFlow!.reviews.length, 0); assert.equal(f.demand().findings.length, 0); assert.equal(f.demand().activeResultId, undefined);
  });
});


test('actual Worker consults writer-only design vocabulary after root and TDD, with every released reference audited by Host', async t => {
  const f = executionProductionFixture(t); f.authorizeImplementation(); const grant = f.authorizeModel();
  const current = await f.launch('ticket-implementation'), selection = current.launch.init.executionSkills!.codebaseDesign!;
  assert.deepEqual(selection.selection, { purpose: 'reference-only' });
  const before = structuredClone(f.demand().planningFlow!.finalDesignConfirmation), design = selection.skill;
  let errors = '', received = '';
  await drive(f, current, (request, turn) => {
    const messages = context(request).messages;
    errors = JSON.stringify(messages.filter(message => message.role === 'toolResult' && message.isError));
    received = JSON.stringify(messages.filter(message => message.role === 'toolResult' && !message.isError));
    const toolCalls = turn === 1 ? [call('controlled_skill', { name: 'codebase-design' })]
      : turn === 2 ? [call('controlled_skill', { name: 'implement-spec' })]
      : turn === 3 ? [call('controlled_skill', { name: 'codebase-design' })]
      : turn === 4 ? [call('controlled_skill', { name: 'tdd' })]
      : turn === 5 ? [call('controlled_skill_resource', { from: design.entry.path, path: 'DEEPENING.md' })]
      : turn === 6 ? [call('controlled_skill', { name: 'codebase-design' })]
      : turn === 7 ? [call('controlled_skill_resource', { from: design.entry.path, path: 'DEEPENING.md' })] : [];
    return { text: '', ...(toolCalls.length ? { toolCalls } : {}) };
  });
  assert.match(errors, /Read implement-spec/); assert.match(errors, /active TDD/); assert.match(errors, /owning skill/);
  const reference = design.references.find(resource => resource.path.endsWith('/DEEPENING.md'))!;
  assert.ok(received.includes(JSON.stringify(reference.content).slice(1, -1)));
  const reads = f.store.db.prepare('SELECT resource_id FROM host_planning_skill_reads WHERE runtime_run_id=? ORDER BY rowid').all(current.launch.run.runId).map(row => row.resource_id);
  assert.deepEqual(reads, [current.launch.init.executionSkills!.entry.id, current.launch.init.executionSkills!.active.entry.id, design.entry.id, reference.id]);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM model_grants').get()!.n, 1); assert.equal(f.budget.getGrant(grant).id, grant);
  assert.deepEqual(f.demand().planningFlow!.finalDesignConfirmation, before); assert.equal(f.demand().executionFlow!.implementations.length, 0); assert.equal(f.nativeChecks.length, 0);
});
