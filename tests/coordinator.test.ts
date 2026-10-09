import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchStore, WorkflowService } from '../src/domain/index.ts';
import type { ArtifactRef, Methods, ReportVerification, RunAttempt, UserCommand, WorkerReport } from '../src/domain/index.ts';
import { HostApplication } from '../src/host/application.ts';
import { ExecutionCoordinator } from '../src/host/coordinator.ts';
import type { ExecutionPrerequisites } from '../src/host/coordinator.ts';
import { SyntheticProcessDriver } from '../src/runtime/synthetic-driver.ts';
import type { Observation, ProcessIdentity, RunRecord, RuntimeDriver } from '../src/runtime/types.ts';

// Except for the separately named Linux fixture, process identities, observations,
// artifacts, authorizations and verification facts are explicitly synthetic. These
// tests exercise real SQLite/domain/runtime integration, not OS isolation or Pi.
const methods: Methods = Object.fromEntries(['planning', 'implementation', 'review'].map(stage => [stage, {
  id: `synthetic-${stage}`, version: '1.0.0', digest: `synthetic-${stage}-v1`, adapter: 'synthetic-test-only',
}]));
const ref = (id: string): ArtifactRef => ({ id, digest: `synthetic-digest-${id}`, location: `fixture://${id}` });
const verified: ReportVerification = { artifactsVerified: true, contentStable: true, reviewInputsVerified: true };
const approved = { profileVerified: true, budgetAvailable: true, workspaceVerified: true, blockers: [] as string[] };
type UserBody = UserCommand extends infer C ? C extends UserCommand ? Omit<C, 'requestId' | 'demandId' | 'expectedRevision'> : never : never;
type ReportBody = WorkerReport extends infer R ? R extends WorkerReport ? Omit<R, 'requestId' | 'demandId' | 'runId' | 'generation'> : never : never;
type ExitClassification = { outcome: 'handoff' | 'safe-retry' | 'unknown'; evidence: string };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

class SyntheticObservedDriver implements RuntimeDriver {
  readonly id = 'synthetic-coordinator-integration-only';
  readonly isolation = 'synthetic-process-supervision-only' as const;
  readonly launches: RunRecord[] = [];
  readonly stops: string[] = [];
  readonly exited = new Set<string>();
  launchBarrier?: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
  preflight() {}
  async launch(run: RunRecord): Promise<ProcessIdentity> {
    this.launches.push(run);
    const barrier = this.launchBarrier;
    if (barrier) { barrier.entered.resolve(); await barrier.release.promise; }
    return { pid: 42000 + this.launches.length, birth: `synthetic-birth-${run.runId}`, generation: run.generation, controlId: run.runId, driver: this.id };
  }
  async observe(run: RunRecord): Promise<Observation> {
    return { state: this.exited.has(run.runId) ? 'stopped' : 'alive', generation: run.generation,
      activePids: this.exited.has(run.runId) ? [] : [run.identity?.pid ?? 42000],
      proof: 'Synthetic controlled observation only; no native process or containment evidence.' };
  }
  async stop(run: RunRecord): Promise<Observation> {
    this.stops.push(run.runId); this.exited.add(run.runId); return this.observe(run);
  }
  naturalExit(domainRunId: string) {
    const runtime = this.launches.find(run => run.grantId === domainRunId);
    assert.ok(runtime, 'The synthetic process must have actually passed the launch adapter');
    this.exited.add(runtime.runId);
  }
}

function fixture(options: { path?: string; driver?: RuntimeDriver; workspace?: string; classifications?: Map<string, ExitClassification> } = {}) {
  const store = new WorkbenchStore(options.path);
  const workflow = new WorkflowService(store);
  const driver = options.driver ?? new SyntheticObservedDriver();
  const classifications = options.classifications ?? new Map<string, ExitClassification>();
  // Only the trusted test harness writes this registry. The report adapter never
  // turns a Worker-supplied "verified" flag into verification authority.
  const attestations = new Map<string, ReportVerification>();
  const facts = { ...approved, blockers: [] as string[] };
  const checks = { workspaceAfterStop: true, reportCalls: 0 };
  const prerequisites: ExecutionPrerequisites = {
    inspect: () => ({ ...facts }),
    launchFor: () => ({ workspace: options.workspace ?? '/synthetic/coordinator', profileId: 'synthetic-trusted-fixtures-only', timeoutMs: 2_147_483_647, maxOutputBytes: 65536 }),
    verifyWorkspaceAfterStop: () => checks.workspaceAfterStop,
    verifyReport: report => { checks.reportCalls++; return attestations.get(report.requestId) ?? {}; },
    classifyExit: run => classifications.get(run.id) ?? { outcome: 'unknown', evidence: 'Synthetic harness has no verified terminal handoff.' },
  };
  const coordinator = new ExecutionCoordinator(store, workflow, driver, prerequisites);
  const user = workflow.trustedUser('synthetic-owner');
  if (!store.listProjects().length) {
    workflow.createProject({ id: 'project', name: 'Coordinator fixture', rootPath: options.workspace ?? '/synthetic/coordinator', methods,
      baseChecks: [{ id: 'base-test', name: 'Synthetic base test', source: 'project' }] });
    workflow.createDemand({ id: 'demand', projectId: 'project', title: 'Synthetic coordinator demand' });
  }
  const command = (body: UserBody) => workflow.execute({ requestId: randomUUID(), demandId: 'demand', expectedRevision: store.getDemand('demand').revision, ...body }, user);
  const payload = (run: RunAttempt, body: ReportBody): WorkerReport => ({ requestId: randomUUID(), demandId: run.demandId, runId: run.id, generation: run.generation, ...body });
  const report = (run: RunAttempt, body: ReportBody, proof: ReportVerification = verified) => {
    const value = payload(run, body); attestations.set(value.requestId, proof); return coordinator.report(run.id, value);
  };
  const draft = (run: RunAttempt) => report(run, { type: 'plan-draft', plan: { id: 'P1', scope: 'Synthetic finite scope', spec: ref('spec'), tickets: ref('tickets'),
    requiredChecks: [{ id: 'feature-test', name: 'Synthetic feature test', source: 'demand' }], unresolvedQuestions: [] } });
  const ready = (run: RunAttempt) => report(run, { type: 'plan-ready', planId: 'P1', boundaryReview: {
    contextId: 'synthetic-independent-boundary', planningContextId: run.contextId, evidence: ref('boundary'), unresolvedBlockingFindings: [],
  } }, { ...verified, boundaryReview: { runId: 'synthetic-independent-reviewer', contextId: 'synthetic-independent-boundary', planningRunId: run.id,
    planId: 'P1', evidenceDigest: ref('boundary').digest, actualReviewObserved: true, isolatedInputsVerified: true } });
  const authorize = () => command({ type: 'authorize-implementation', planId: 'P1', confirmDesign: true });
  const classify = (run: RunAttempt, outcome: ExitClassification['outcome'] = 'handoff') => classifications.set(run.id, { outcome, evidence: `Synthetic trusted ${outcome} classification for ${run.id}` });
  const latest = () => { const run = store.listRuns('demand').at(-1); assert.ok(run); return run; };
  return { store, workflow, coordinator, driver, classifications, facts, checks, prerequisites, command, payload, report, draft, ready, authorize, classify, latest };
}

async function start(f: ReturnType<typeof fixture>) { f.command({ type: 'start-planning' }); await f.coordinator.tick(); return f.latest(); }
async function prepareImplementation(f: ReturnType<typeof fixture>, driver: SyntheticObservedDriver) {
  const planning = await start(f); f.draft(planning); f.ready(planning); f.authorize(); f.classify(planning);
  driver.naturalExit(planning.id); await f.coordinator.tick();
  const implementation = f.latest(); assert.equal(implementation.stage, 'implementation'); return implementation;
}

test('SYNTHETIC coordinator: explicit returns after verified deliveries do not consume one shared retry allowance', async () => {
  const driver = new SyntheticObservedDriver(), f = fixture({ driver });
  try {
    await prepareImplementation(f, driver);
    for (let cycle = 1; cycle <= 3; cycle++) {
      const implementation = f.latest();
      assert.equal(implementation.stage, 'implementation');
      assert.equal(implementation.status, 'running');
      const contentId = `returned-content-${cycle}`;
      f.report(implementation, { type: 'content-ready', content: {
        id: contentId, planId: 'P1', code: ref(`returned-code-${cycle}`), knowledge: [],
        maintenance: 'not-needed', deliveryNotes: `Distinct verified delivery ${cycle}.`,
      } });
      f.classify(implementation); driver.naturalExit(implementation.id); await f.coordinator.tick();
      const reviewer = f.latest();
      assert.equal(reviewer.stage, 'review');
      for (const requirementId of ['base-test', 'feature-test']) f.report(reviewer, { type: 'check', check: {
        id: `returned-check-${cycle}-${requirementId}`, contentId, requirementId, status: 'passed',
        evidence: ref(`returned-evidence-${cycle}-${requirementId}`), environment: 'synthetic-only',
      } });
      f.report(reviewer, { type: 'review', reviewId: `returned-review-${cycle}`, contentId,
        evidence: ref(`returned-review-evidence-${cycle}`), knowledgeReviewed: true, findings: [] });
      f.classify(reviewer); driver.naturalExit(reviewer.id); await f.coordinator.tick();
      const demand = f.store.getDemand('demand');
      assert.equal(demand.phase, 'awaiting-acceptance');
      f.command({ type: 'return-result', resultId: demand.activeResultId!, reason: `Explicit new user revision ${cycle}.` });
      await f.coordinator.tick();
    }
    assert.deepEqual(f.store.getDemand('demand').blockedReasons, []);
    assert.equal(f.latest().stage, 'implementation');
    assert.equal(f.latest().status, 'running', 'A fourth explicitly requested revision has its own bounded cycle.');
    assert.equal(driver.launches.filter(run => run.role === 'implementation').length, 4);
  } finally { await f.coordinator.supervisor.stopAll('synthetic-test-cleanup'); f.store.close(); }
});

// Full handoff path: trusted reports are necessary, but process exit must also be observed.
test('SYNTHETIC coordinator: verified handoffs plus observed exits advance planning, implementation, review and stable acceptance', async () => {
  const driver = new SyntheticObservedDriver(), f = fixture({ driver });
  try {
    const planner = await start(f); assert.equal(planner.status, 'running');
    f.draft(planner); f.ready(planner); f.authorize(); f.classify(planner);
    f.report(planner, { type: 'runtime-ended' }); await f.coordinator.tick();
    assert.equal(f.store.listRuns().length, 1, 'Worker completion text cannot replace a process observation');
    assert.equal(f.coordinator.supervisor.list()[0].state, 'running');
    driver.naturalExit(planner.id); await f.coordinator.tick();
    const implementation = f.latest(); assert.equal(implementation.stage, 'implementation'); assert.equal(implementation.writer, true);
    assert.equal(f.report(planner, { type: 'blocked', reason: 'Late authenticated evidence for a superseded generation.' }).status, 'historical');
    assert.deepEqual(f.store.getDemand('demand').blockedReasons, []);
    f.report(implementation, { type: 'content-ready', content: { id: 'C1', planId: 'P1', code: ref('K1'), knowledge: [ref('N1')], maintenance: 'complete', deliveryNotes: 'Synthetic acceptance instructions.' } });
    f.classify(implementation); await f.coordinator.tick();
    assert.equal(f.store.listRuns().length, 2, 'The writer stays occupied until its tree is observed stopped');
    driver.naturalExit(implementation.id); await f.coordinator.tick();
    const reviewer = f.latest(); assert.equal(reviewer.stage, 'review'); assert.equal(reviewer.writer, false);
    assert.notEqual(reviewer.contextId, implementation.contextId); assert.ok(reviewer.contextSources.includes('N1'));
    for (const requirementId of ['base-test', 'feature-test']) f.report(reviewer, { type: 'check', check: {
      id: `E-${requirementId}`, contentId: 'C1', requirementId, status: 'passed', evidence: ref(`check-${requirementId}`), environment: 'synthetic-only',
    } });
    f.report(reviewer, { type: 'review', reviewId: 'R1', contentId: 'C1', evidence: ref('review'), knowledgeReviewed: true, findings: [] }); f.classify(reviewer);
    await f.coordinator.tick(); assert.equal(f.store.getDemand('demand').activeResultId, undefined);
    driver.naturalExit(reviewer.id); await f.coordinator.tick();
    const demand = f.store.getDemand('demand'); assert.equal(demand.phase, 'awaiting-acceptance'); assert.ok(demand.activeResultId);
    assert.deepEqual(demand.results[0].N.map(item => item.id), ['N1']); assert.equal(demand.results[0].E.length, 2);
    assert.equal(driver.launches.length, 3); assert.ok(f.store.listRuns().every(run => run.status === 'stopped'));
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM host_run_bindings WHERE status='stopped'").get()!.n, 3);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM host_exit_classifications').get()!.n, 3);
    await f.coordinator.tick(); assert.equal(driver.launches.length, 3);
  } finally { await f.coordinator.supervisor.stopAll('synthetic-test-cleanup'); f.store.close(); }
});

test('SYNTHETIC coordinator: pause during asynchronous launch wins over late registration and duplicate ticks', async () => {
  const driver = new SyntheticObservedDriver(), f = fixture({ driver });
  const barrier = { entered: deferred(), release: deferred() }; driver.launchBarrier = barrier;
  f.command({ type: 'start-planning' }); const pending = f.coordinator.tick();
  try {
    await barrier.entered.promise; const run = f.latest(); assert.equal(run.status, 'starting');
    assert.equal(f.store.db.prepare('SELECT status FROM host_run_bindings WHERE domain_run_id=?').get(run.id)!.status, 'launch-intent');
    f.command({ type: 'pause' }); await f.coordinator.flushStops(); await f.coordinator.tick();
    assert.equal(f.coordinator.supervisor.list()[0].state, 'stop_requested'); assert.equal(driver.launches.length, 1);
    barrier.release.resolve(); await pending; await f.coordinator.tick();
    assert.equal(f.store.getDemand('demand').control, 'paused'); assert.equal(f.store.getRun(run.id).status, 'stopped');
    assert.equal(f.coordinator.supervisor.list()[0].state, 'stopped'); assert.equal(driver.stops.length, 1);
    assert.equal(f.store.outbox('pending').filter(item => item.kind === 'stop-run').length, 0);
    assert.equal(f.store.history('demand').filter(item => item.kind === 'run-started').length, 0);
  } finally { barrier.release.resolve(); await pending; await f.coordinator.supervisor.stopAll('synthetic-test-cleanup'); f.store.close(); }
});

test('SYNTHETIC coordinator: an authenticated late report after verified stop is saved without resuming paused dispatch', async () => {
  const driver = new SyntheticObservedDriver(), f = fixture({ driver });
  try {
    const planner = await start(f); f.draft(planner); f.authorize(); f.command({ type: 'pause' }); await f.coordinator.flushStops();
    assert.equal(f.store.getRun(planner.id).status, 'stopped');
    const receipt = f.ready(planner); assert.equal(receipt.status, 'applied');
    assert.equal(f.store.getDemand('demand').plans[0].ready, true); assert.equal(f.store.getDemand('demand').control, 'paused');
    await f.coordinator.tick(); await f.coordinator.tick(); assert.equal(driver.launches.length, 1);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM domain_receipts WHERE key=?').get(`run:${planner.id}:${receipt.requestId}`)!.n, 1);
  } finally { await f.coordinator.supervisor.stopAll('synthetic-test-cleanup'); f.store.close(); }
});

test('SYNTHETIC coordinator: private-channel identity rejects spoofed run, demand, generation and absent launch binding', async () => {
  const f = fixture();
  try {
    const planner = await start(f), valid = f.payload(planner, { type: 'runtime-ended' }), before = f.checks.reportCalls;
    for (const spoof of [{ ...valid, runId: 'another-run' }, { ...valid, demandId: 'another-demand' }, { ...valid, generation: planner.generation + 1 }]) {
      assert.throws(() => f.coordinator.report(planner.id, spoof), /channel identity mismatch/);
    }
    assert.equal(f.checks.reportCalls, before, 'Spoofed messages never reach trusted verification');
    f.store.db.prepare('UPDATE host_run_bindings SET runtime_run_id=NULL WHERE domain_run_id=?').run(planner.id);
    assert.throws(() => f.coordinator.report(planner.id, valid), /no matching launched generation/);
    assert.equal(f.checks.reportCalls, before);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM domain_receipts WHERE key=?').get(`run:${planner.id}:${valid.requestId}`)!.n, 0);
  } finally { await f.coordinator.supervisor.stopAll('synthetic-test-cleanup'); f.store.close(); }
});

test('SYNTHETIC coordinator: Worker payload verification flags cannot replace trusted report attestations', async () => {
  const f = fixture();
  try {
    const planner = await start(f); f.draft(planner);
    const forged = Object.assign(f.payload(planner, { type: 'plan-ready', planId: 'P1', boundaryReview: {
      contextId: 'invented-context', planningContextId: planner.contextId, evidence: ref('invented-boundary'), unresolvedBlockingFindings: [],
    } }), { artifactsVerified: true, actualReviewObserved: true, isolatedInputsVerified: true });
    assert.throws(() => f.coordinator.report(planner.id, forged), { code: 'ARTIFACTS_UNVERIFIED' });
    assert.equal(f.store.getDemand('demand').plans[0].ready, false);
    assert.equal(f.store.listRuns().length, 1);
  } finally { await f.coordinator.supervisor.stopAll('synthetic-test-cleanup'); f.store.close(); }
});

test('SYNTHETIC coordinator: natural exit without a verified terminal handoff blocks instead of silently retrying', async () => {
  const driver = new SyntheticObservedDriver(), f = fixture({ driver });
  try {
    const run = await start(f); f.report(run, { type: 'runtime-ended' }); driver.naturalExit(run.id); await f.coordinator.tick();
    assert.equal(f.store.getRun(run.id).status, 'stopped'); assert.equal(f.store.getDemand('demand').phase, 'blocked');
    assert.match(f.store.getDemand('demand').blockedReasons.join('\n'), /HANDOFF_UNVERIFIED/);
    await f.coordinator.tick(); assert.equal(driver.launches.length, 1);
    assert.equal(f.store.db.prepare('SELECT outcome FROM host_exit_classifications WHERE run_id=?').get(run.id)!.outcome, 'unknown');
  } finally { await f.coordinator.supervisor.stopAll('synthetic-test-cleanup'); f.store.close(); }
});

test('SYNTHETIC coordinator: failed workspace verification retains ownership even after runtime exit', async () => {
  const driver = new SyntheticObservedDriver(), f = fixture({ driver });
  try {
    const implementation = await prepareImplementation(f, driver);
    f.classify(implementation, 'safe-retry'); driver.naturalExit(implementation.id); f.checks.workspaceAfterStop = false;
    await f.coordinator.tick();
    assert.equal(f.coordinator.supervisor.list().find(run => run.grantId === implementation.id)!.state, 'stopped');
    assert.notEqual(f.store.getRun(implementation.id).status, 'stopped'); assert.equal(driver.launches.length, 2);
    f.command({ type: 'pause' }); await f.coordinator.flushStops();
    assert.ok(f.store.outbox('pending').some(item => item.kind === 'stop-run'));
    assert.throws(() => f.command({ type: 'resume' }), { code: 'STOP_UNVERIFIED' });
    f.checks.workspaceAfterStop = true; await f.coordinator.tick(); assert.equal(f.store.getRun(implementation.id).status, 'stopped');
    assert.equal(f.store.getDemand('demand').control, 'paused'); assert.equal(driver.launches.length, 2);
  } finally { await f.coordinator.supervisor.stopAll('synthetic-test-cleanup'); f.store.close(); }
});

test('SYNTHETIC coordinator: three safe no-progress cycles exhaust durable limits and restart or blocker resolution cannot reset them', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-coordinator-limits-')), path = join(directory, 'state.sqlite');
  const driver = new SyntheticObservedDriver(), classifications = new Map<string, ExitClassification>();
  let f = fixture({ path, driver, classifications });
  try {
    f.command({ type: 'start-planning' });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await f.coordinator.tick(); const run = f.latest(); assert.equal(driver.launches.length, attempt);
      f.classify(run, 'safe-retry'); driver.naturalExit(run.id); await f.coordinator.observeCompletedRuns();
      assert.equal(f.store.db.prepare('SELECT attempts FROM runtime_retry_counts').get()!.attempts, attempt);
      assert.equal(f.store.db.prepare('SELECT cycles FROM runtime_progress').get()!.cycles, attempt);
      f.store.close(); f = fixture({ path, driver, classifications }); await f.coordinator.recover();
      assert.equal(f.store.db.prepare('SELECT cycles FROM runtime_progress').get()!.cycles, attempt, 'Recovery must not reset or double-charge an observed cycle');
    }
    assert.equal(f.store.getDemand('demand').phase, 'blocked'); assert.match(f.store.getDemand('demand').blockedReasons.join('\n'), /NO_PROGRESS_LIMIT/);
    await f.coordinator.tick(); assert.equal(driver.launches.length, 3);
    f.command({ type: 'resolve-blocker', reason: 'Synthetic user asks to reconcile again; no new retry budget is granted.' });
    await f.coordinator.tick(); assert.equal(driver.launches.length, 3, 'A fourth launcher invocation is forbidden');
    assert.match(f.store.getDemand('demand').blockedReasons.join('\n'), /RETRY_LIMIT/);
    assert.equal(f.store.db.prepare('SELECT attempts FROM runtime_retry_counts').get()!.attempts, 3);
    assert.equal(f.coordinator.supervisor.list().length, 3); assert.ok(f.store.listRuns().every(run => run.status === 'stopped'));
    f.store.close(); f = fixture({ path, driver, classifications }); await f.coordinator.recover(); await f.coordinator.tick();
    assert.equal(driver.launches.length, 3); assert.equal(f.store.db.prepare('SELECT attempts FROM runtime_retry_counts').get()!.attempts, 3);
  } finally { await f.coordinator.supervisor.stopAll('synthetic-test-cleanup'); f.store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('SYNTHETIC coordinator: recovery of a domain writer with no runtime mapping remains unknown and cannot create a replacement', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-coordinator-unmapped-')), path = join(directory, 'state.sqlite');
  const driver = new SyntheticObservedDriver(); let f = fixture({ path, driver });
  try {
    const planner = await start(f); f.draft(planner); f.ready(planner); f.authorize(); f.classify(planner);
    driver.naturalExit(planner.id); await f.coordinator.observeCompletedRuns();
    const writer = f.workflow.claimNextRun({ ...approved, demandId: 'demand' }); assert.ok(writer); assert.equal(writer.writer, true);
    assert.equal(f.coordinator.supervisor.list().length, 1, 'Crash window is after domain claim and before runtime creation');
    f.store.close(); f = fixture({ path, driver }); await f.coordinator.recover(); await f.coordinator.tick();
    assert.equal(f.store.getRun(writer.id).status, 'unknown'); assert.equal(driver.launches.length, 1);
    assert.equal(f.store.listRuns().filter(run => run.writer && run.status !== 'stopped').length, 1);
    f.command({ type: 'pause' }); await f.coordinator.flushStops();
    assert.ok(f.store.outbox('pending').some(item => item.kind === 'stop-run' && item.payload.runId === writer.id));
    assert.throws(() => f.command({ type: 'resume' }), { code: 'STOP_UNVERIFIED' });
  } finally { await f.coordinator.supervisor.stopAll('synthetic-test-cleanup'); f.store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('SYNTHETIC coordinator: launch exception after possible process creation retains the writer and never automatically retries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-coordinator-launch-crash-')), path = join(directory, 'state.sqlite');
  const driver = new SyntheticObservedDriver(), launch = driver.launch.bind(driver);
  driver.launch = async run => { const identity = await launch(run); if (run.writes) throw new Error('Synthetic crash after creation before registration'); return identity; };
  let f = fixture({ path, driver });
  try {
    const planner = await start(f); f.draft(planner); f.ready(planner); f.authorize(); f.classify(planner);
    driver.naturalExit(planner.id); await f.coordinator.tick(); const writer = f.latest();
    assert.equal(writer.writer, true); assert.equal(writer.status, 'unknown');
    assert.equal(f.coordinator.supervisor.list().find(run => run.grantId === writer.id)!.state, 'unknown');
    assert.equal(f.coordinator.supervisor.list().find(run => run.grantId === writer.id)!.identity, null);
    assert.equal(f.store.db.prepare('SELECT status FROM host_run_bindings WHERE domain_run_id=?').get(writer.id)!.status, 'unresolved');
    await f.coordinator.tick(); assert.equal(driver.launches.length, 2);
    f.store.close(); f = fixture({ path, driver }); await f.coordinator.recover(); await f.coordinator.tick();
    assert.equal(f.store.getRun(writer.id).status, 'unknown'); assert.equal(driver.launches.length, 2);
    assert.equal(f.store.listRuns().filter(run => run.writer && run.status !== 'stopped').length, 1);
  } finally { await f.coordinator.supervisor.stopAll('synthetic-test-cleanup'); f.store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('SYNTHETIC coordinator: restart repairs a lost Host binding from the persisted runtime grant without launching again', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-coordinator-binding-')), path = join(directory, 'state.sqlite');
  const driver = new SyntheticObservedDriver(); let f = fixture({ path, driver });
  try {
    const run = await start(f), runtimeId = f.coordinator.supervisor.list()[0].runId;
    f.store.db.prepare('DELETE FROM host_run_bindings WHERE domain_run_id=?').run(run.id);
    f.store.close(); f = fixture({ path, driver }); await f.coordinator.recover(); await f.coordinator.tick();
    const binding = f.store.db.prepare('SELECT * FROM host_run_bindings WHERE domain_run_id=?').get(run.id)!;
    assert.equal(binding.runtime_run_id, runtimeId); assert.equal(binding.status, 'reconciled');
    assert.equal(f.store.getRun(run.id).status, 'unknown'); assert.equal(driver.launches.length, 1);
  } finally { await f.coordinator.supervisor.stopAll('synthetic-test-cleanup'); f.store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('SYNTHETIC coordinator: crash before observing natural exit still requires terminal-handoff classification on recovery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-coordinator-exit-recovery-')), path = join(directory, 'state.sqlite');
  const driver = new SyntheticObservedDriver(); let f = fixture({ path, driver });
  try {
    const run = await start(f); driver.naturalExit(run.id);
    f.store.close(); f = fixture({ path, driver }); await f.coordinator.recover();
    assert.equal(f.store.getRun(run.id).status, 'stopped');
    assert.equal(f.store.getDemand('demand').phase, 'blocked', 'Recovery must not bypass the natural-exit handoff gate');
    assert.match(f.store.getDemand('demand').blockedReasons.join('\n'), /HANDOFF_UNVERIFIED/);
    await f.coordinator.tick(); assert.equal(driver.launches.length, 1);
  } finally { await f.coordinator.supervisor.stopAll('synthetic-test-cleanup'); f.store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('SYNTHETIC coordinator: a recovered live generation that later exits cannot bypass missing handoff classification', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-coordinator-late-exit-')), path = join(directory, 'state.sqlite');
  const driver = new SyntheticObservedDriver(); let f = fixture({ path, driver });
  try {
    const run = await start(f);
    f.store.close(); f = fixture({ path, driver }); await f.coordinator.recover();
    assert.equal(f.store.getRun(run.id).status, 'unknown'); assert.equal(driver.launches.length, 1);
    driver.naturalExit(run.id); await f.coordinator.tick();
    assert.equal(f.store.getRun(run.id).status, 'stopped');
    assert.equal(f.store.getDemand('demand').phase, 'blocked', 'An interruption reason is not a verified handoff or user stop');
    assert.match(f.store.getDemand('demand').blockedReasons.join('\n'), /HANDOFF_UNVERIFIED/);
    assert.equal(driver.launches.length, 1, 'Recovery must never cause a silent replacement after an unverified exit');
  } finally { await f.coordinator.supervisor.stopAll('synthetic-test-cleanup'); f.store.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const prerequisite of ['profileVerified', 'budgetAvailable', 'workspaceVerified'] as const) {
  test(`SYNTHETIC coordinator: missing ${prerequisite} leaves dispatch pending without claiming or launching`, async () => {
    const driver = new SyntheticObservedDriver(), f = fixture({ driver });
    try {
      f.facts[prerequisite] = false; f.command({ type: 'start-planning' }); await f.coordinator.tick();
      assert.equal(driver.launches.length, 0); assert.equal(f.store.listRuns().length, 0);
      assert.equal(f.store.outbox('pending').filter(item => item.kind === 'start-run').length, 1);
      assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM runtime_retry_counts').get()!.n, 0);
    } finally { f.store.close(); }
  });
}

test('production Host defaults fail closed even with a requested stage and configured synthetic method definitions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-coordinator-default-')), app = new HostApplication();
  try {
    let state = app.handle('createProject', { rootPath: directory });
    app.workflow.updateProjectMethods(state.projects[0].id, methods, app.workflow.trustedUser('synthetic-test-setup-only'));
    state = app.handle('createDemand', { projectId: state.projects[0].id, requestId: 'create-default-gate-demand', title: 'Do not execute without verified prerequisites' });
    state = app.handle('command', { kind: 'start-planning', demandId: state.demands[0].id, expectedVersion: state.demands[0].version, requestId: 'request-planning' });
    assert.ok(app.store.outbox('pending').some(item => item.kind === 'start-run'));
    await app.coordinator.recover(); await app.coordinator.tick(); await app.coordinator.tick();
    assert.equal(app.store.listRuns().length, 0); assert.equal(app.coordinator.supervisor.list().length, 0);
    assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM host_run_bindings').get()!.n, 0);
    assert.equal(app.snapshot().runtime.executionEnabled, false); assert.ok(app.snapshot().runtime.blockers.length >= 3);
  } finally { app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Linux trusted-fixture process supervision ONLY: actual /proc-observed natural exit unlocks a synthetically verified planning handoff', { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-coordinator-process-')), script = join(directory, 'trusted-fixture.cjs');
  writeFileSync(script, "const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(process.argv[2]))clearInterval(timer);},10);");
  let launchCount = 0;
  const driver = new SyntheticProcessDriver(run => { launchCount++; return { executable: process.execPath, args: [script, join(directory, `exit-${run.grantId}`)] }; });
  const f = fixture({ driver, workspace: directory });
  try {
    const planner = await start(f); f.draft(planner); f.ready(planner); f.authorize(); f.classify(planner);
    await f.coordinator.tick(); assert.equal(launchCount, 1); assert.equal(f.store.getRun(planner.id).status, 'running');
    writeFileSync(join(directory, `exit-${planner.id}`), 'Trusted harness asks its own fixture to finish.');
    const deadline = Date.now() + 5000;
    while (f.store.listRuns().length < 2 && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 10)); await f.coordinator.tick(); }
    assert.equal(f.store.getRun(planner.id).status, 'stopped'); assert.equal(f.latest().stage, 'implementation'); assert.equal(launchCount, 2);
    const observed = f.coordinator.supervisor.list().find(run => run.grantId === planner.id)!;
    assert.equal(observed.state, 'stopped'); assert.equal(observed.stopReason, null); assert.match(observed.evidence!, /\/proc process-group census/);
  } finally { f.command({ type: 'pause' }); await f.coordinator.flushStops(); await f.coordinator.supervisor.stopAll('trusted-fixture-cleanup'); f.store.close(); rmSync(directory, { recursive: true, force: true }); }
});
