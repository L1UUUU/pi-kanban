import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executionProductionFixture, implementTickets, drive, reviewScript, writerScript, call, context, pending, seam, git, deferred, uncheckedContent, boundReport, loadSkill, consumeSkills } from './helpers/execution-production.ts';
import type { ExecutionFixture, Launch, SyntheticPlanningNativePort } from './helpers/execution-production.ts';
import type { ExecutionFindingInput } from '../src/domain/types.ts';
import { HostApplication } from '../src/host/application.ts';

// Installed Pi SDK + actual Worker framing + production Host/SQLite/Git.
// Native ownership/ACL observations and provider responses are explicitly
// synthetic. Local Node checks execute for real; no network model call occurs.
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
