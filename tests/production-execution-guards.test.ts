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
