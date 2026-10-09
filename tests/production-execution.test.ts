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
