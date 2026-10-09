import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WorkbenchStore, WorkflowService } from '../src/domain/index.ts';
import type { RunAttempt, WorkerReport } from '../src/domain/types.ts';
import { WorkspaceService, ImmutableObjectStore } from '../src/workspace/index.ts';
import { KnowledgeService } from '../src/knowledge/index.ts';
import { ModelBudgetLedger } from '../src/runtime/budget.ts';
import { emptyConfiguration, loadMethods } from '../src/host/configuration.ts';
import type { ProviderConfiguration, WorkbenchConfiguration } from '../src/host/configuration.ts';
import { ProductionEvidence, hash } from '../src/host/evidence.ts';
import { PiOpenAITransport, createProductionServices } from '../src/host/production.ts';
import type { ProductionOptions } from '../src/host/production.ts';
import { ExecutionCoordinator } from '../src/host/coordinator.ts';

// Every provider reply, credential, approval and process identity in this file is
// synthetic. These tests make no model/HTTP calls and do not claim Windows isolation.
const gitExecutable = process.env.PI_KANBAN_TEST_GIT ?? (process.platform === 'win32' ? execFileSync('where.exe', ['git.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]! : '/usr/bin/git');
function git(cwd: string, ...args: string[]) { return execFileSync(gitExecutable, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } }).trim(); }
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pi-production-')), repo = join(root, 'repo'); mkdirSync(repo);
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Synthetic'); git(repo, 'config', 'user.email', 'synthetic@example.invalid');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'code.txt'), 'source v1\n'); git(repo, 'add', 'code.txt'); git(repo, 'commit', '-m', 'Synthetic baseline');
  const store = new WorkbenchStore(join(root, 'host.sqlite')); const workflow = new WorkflowService(store);
  const workspace = new WorkspaceService({ db: store.db, gitExecutable }); workspace.bindProject({ projectId: 'project', anchorPath: repo, formalTarget: 'main' });
  let configuration = emptyConfiguration();
  for (const stage of ['planning', 'implementation', 'review'] as const) {
    const path = join(root, `${stage}.md`), content = `Synthetic explicitly selected ${stage} method v1.`; writeFileSync(path, content);
    configuration.methods[stage] = { id: `method-${stage}`, path, sha256: hash(content), logicalName: stage === 'planning' ? 'design-feature' : stage, version: '1.0.0', adapter: 'explicit-text-v1', dependencies: [] };
  }
  const methods = loadMethods(configuration).methods;
  workflow.createProject({ id: 'project', name: 'Synthetic', rootPath: repo, methods }); workflow.createDemand({ id: 'demand', projectId: 'project', title: 'Synthetic source task' });
  const user = workflow.trustedUser('synthetic-owner'); workflow.execute({ type: 'start-planning', requestId: randomUUID(), demandId: 'demand' }, user);
  const knowledge = new KnowledgeService({ db: store.db, resolveStore: () => ImmutableObjectStore.open(repo, 'project') });
  const budget = new ModelBudgetLedger(store.db, () => {});
  const production = createProductionServices({ store, workflow, workspace: () => workspace, knowledge, budget, configuration: () => configuration, stateDirectory: join(root, 'host-state') });
  production.captureMethods(); const binding = production.prepareDemand('demand', git(repo, 'rev-parse', 'HEAD'));
  const coordinator = new ExecutionCoordinator(store, workflow, production.driver, production.prerequisites); production.bindCoordinator(coordinator);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, repo, store, workflow, user, workspace, knowledge, budget, production, coordinator, binding, get configuration() { return configuration; }, set configuration(value: WorkbenchConfiguration) { configuration = value; } };
}
function provider(): ProviderConfiguration { return { provider: 'openai', modelId: 'gpt-4.1-mini', destination: 'https://api.openai.com/v1/responses', credentialRef: 'env:SYNTHETIC_TEST_ONLY', data: [{ id: 'fixture', sha256: 'a'.repeat(64) }], contextPolicy: 'approved-run-derived-v1', allowedRoles: ['planning', 'implementation', 'review', 'boundary-review'], limits: { maxRequests: 10, maxTokens: 500_000, maxCostMicros: 2_000_000, currency: 'USD', expiresAt: '2099-01-01T00:00:00.000Z', meteringPolicy: 'pi-ai-cost-v1' } }; }
function modelRequest(text = JSON.stringify({ messages: [{ role: 'user', content: 'Synthetic text-only request', timestamp: 1 }] })) { return { requestId: 'synthetic-request', provider: 'openai', modelId: 'gpt-4.1-mini', destination: 'https://api.openai.com/v1/responses', credentialRef: 'env:SYNTHETIC_TEST_ONLY', materials: [{ id: 'fixture', sha256: hash(text), text }], maxTokens: 32_768, signal: new AbortController().signal }; }
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function syntheticResponse() { return new Response([
  event({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_synthetic', role: 'assistant', content: [], status: 'in_progress' } }),
  event({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }),
  event({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Synthetic controlled response.' }),
  event({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_synthetic', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic controlled response.', annotations: [] }], status: 'completed' } }),
  event({ type: 'response.completed', response: { id: 'resp_synthetic', status: 'completed', output: [], usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 } } }),
].join(''), { headers: { 'content-type': 'text/event-stream' } }); }

test('production captures demand-frozen method bytes, not later settings/files', t => {
  const f = fixture(t), demand = f.store.getDemand('demand');
  const before = f.production.evidence.method(demand.methodSnapshot.planning!);
  writeFileSync(f.configuration.methods.planning!.path, 'changed unapproved source');
  assert.deepEqual(f.production.evidence.method(demand.methodSnapshot.planning!), before);
  assert.throws(() => f.production.evidence.freezeMethod(demand.methodSnapshot.planning!, [{ ...before[0]!, content: 'different' }]));
  const data = f.production.requiredModelData('demand'); assert.ok(data.some(item => item.id === 'method-review')); assert.ok(data.some(item => item.id === 'source-scope:demand'));
  assert.equal(f.production.prepareDemand('demand', f.binding.initialBaseline).worktreePath, f.binding.worktreePath);
});
test('production rejects unsupported real runtime while keeping source/demand state', async t => {
  const f = fixture(t); const facts = f.production.diagnostics('demand');
  assert.equal(facts.executionEnabled, false); assert.equal(facts.profileVerified, false); assert.ok(facts.blockers.some(item => /RUNTIME_CONFIGURATION_MISSING/.test(item)));
  await f.production.tick(); assert.equal(f.store.listRuns().length, 0); assert.equal(f.store.getDemand('demand').planningStarted, true);
  assert.equal(f.production.prerequisites.verifyWorkspaceAfterStop('demand'), false, 'No process observations means no stop proof.');
});
test('artifact registry verifies hash, ownership, location and immutable source stability', t => {
  const f = fixture(t), e = f.production.evidence;
  const ref = e.save({ id: 'spec', projectId: 'project', demandId: 'demand', runId: 'synthetic-run', kind: 'plan', text: 'Immutable plan.' });
  assert.equal(e.read('demand', ref).content, 'Immutable plan.');
  assert.throws(() => e.read('other-demand', ref)); assert.throws(() => e.read('demand', { ...ref, location: 'file:///untrusted/path' }));
  assert.throws(() => e.save({ id: 'spec', projectId: 'project', demandId: 'demand', runId: 'synthetic-run', kind: 'plan', text: 'changed' }));
  const code = e.saveSource('project', 'demand', 'synthetic-run', 'code-v1'); assert.equal(e.stable('demand', code), true);
  writeFileSync(join(f.binding.worktreePath, 'code.txt'), 'changed source'); assert.equal(e.stable('demand', code), false);
  assert.ok(e.read('demand', code).content.includes(hash('source v1\n')));
});
test('credential-sensitive tracked paths and links block the whole source scope', t => {
  const f = fixture(t); writeFileSync(join(f.binding.worktreePath, '.env'), 'SYNTHETIC_ONLY=fixture');
  assert.throws(() => f.production.evidence.source('demand'), /credential-sensitive/);
  rmSync(join(f.binding.worktreePath, '.env'));
  if (process.platform !== 'win32') { symlinkSync(join(f.root, 'planning.md'), join(f.binding.worktreePath, 'linked')); assert.throws(() => f.production.evidence.source('demand')); }
});
test('content-stable attestation requires observed stop as well as exact saved bytes', t => {
  const f = fixture(t), code = f.production.evidence.saveSource('project', 'demand', 'synthetic-run', 'code-v1');
  const run = { id: 'synthetic-run', demandId: 'demand', stage: 'implementation' } as RunAttempt;
  const report = { type: 'content-ready', content: { code, knowledge: [] } } as unknown as WorkerReport;
  assert.equal(f.production.evidence.verification(report, run, false).contentStable, false);
  assert.equal(f.production.evidence.verification(report, run, true).contentStable, true);
});
test('planner cannot manufacture independent boundary or subprocess evidence', t => {
  const f = fixture(t), run = { id: 'synthetic-run', demandId: 'demand', stage: 'planning' } as RunAttempt;
  assert.throws(() => f.production.prerequisites.verifyReport({ type: 'plan-ready', planId: 'fake', boundaryReview: { contextId: 'invented', evidence: { id: 'x', digest: 'a'.repeat(64), location: 'fake' } } } as WorkerReport, run), /independently observed/);
  assert.throws(() => f.production.prerequisites.verifyReport({ type: 'check', check: { evidence: { id: 'made-up' }, status: 'passed' } } as WorkerReport, { ...run, stage: 'review' }), /actually observed/);
});
test('official Pi-ai real-provider adapter is exercised with synthetic bounded fetch only', async () => {
  let calls = 0; let resolved = 0;
  const transport = new PiOpenAITransport(provider(), reference => { assert.equal(reference, 'env:SYNTHETIC_TEST_ONLY'); resolved++; return 'SYNTHETIC-NOT-A-CREDENTIAL'; }, async (input, init) => {
    calls++; assert.equal(input, 'https://api.openai.com/v1/responses'); assert.equal(init?.redirect, 'error'); assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, 'gpt-4.1-mini'); assert.equal(body.store, false); assert.ok(body.max_output_tokens > 0 && body.max_output_tokens < 32_768);
    return syntheticResponse();
  });
  assert.equal(calls, 0); assert.equal(resolved, 0, 'Construction does not discover or read credentials.');
  const response = await transport.send(modelRequest()); assert.equal(calls, 1); assert.equal(response.text, 'Synthetic controlled response.'); assert.equal(response.usage?.tokens, 16); assert.match(response.usage?.source ?? '', /catalog-usage-estimate/);
});
test('provider config, media, oversized context and failure reject without alternate route/retry', async () => {
  assert.throws(() => new PiOpenAITransport({ ...provider(), destination: 'https://attacker.invalid/' }, () => 'never'));
  assert.throws(() => new PiOpenAITransport({ ...provider(), modelId: 'invented-model' }, () => 'never'));
  let calls = 0; const transport = new PiOpenAITransport(provider(), () => 'SYNTHETIC', async () => { calls++; return new Response('synthetic failure', { status: 503 }); });
  await assert.rejects(transport.send(modelRequest(JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'image', data: 'x' }] }] })))); assert.equal(calls, 0);
  await assert.rejects(transport.send(modelRequest(JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(40_000) }] })))); assert.equal(calls, 0);
  await assert.rejects(transport.send(modelRequest())); assert.equal(calls, 1);
});

import { createSyntheticProductionServices } from '../src/host/production.ts';
import type { WindowsRunBootstrap } from '../src/runtime/verified-windows-driver.ts';
import type { LockedRuntimeProfile } from '../src/runtime/profile.ts';
import type { RunRecord, ProcessIdentity, Observation } from '../src/runtime/types.ts';
import type { WorkerInit } from '../src/agent/worker-runtime.ts';
import type { BoundedProviderTransport } from '../src/runtime/model-broker.ts';

class SyntheticNativePort {
  readonly id = 'synthetic-production-composition'; readonly isolation = 'synthetic-process-supervision-only' as const;
  nativeCalls = 0; shellCalls = 0; onShellCheck?: () => void; launches: { run: RunRecord; init: WorkerInit }[] = []; bootstraps: WindowsRunBootstrap[] = []; replies: unknown[] = []; stopped = new Set<string>();
  handler!: (run: RunRecord, frame: Uint8Array) => Promise<void>;
  bootstrap: (run: RunRecord) => WindowsRunBootstrap;
  constructor(bootstrap: (run: RunRecord) => WindowsRunBootstrap) { this.bootstrap = bootstrap; }
  setStopHandler(_handler: (id: string, reason: string) => Promise<void>) {}
  setWorkerFrameHandler(handler: (run: RunRecord, frame: Uint8Array) => Promise<void>) { this.handler = handler; }
  preflight() {}
  async launch(run: RunRecord): Promise<ProcessIdentity> { const bootstrap = this.bootstrap(run); this.bootstraps.push(bootstrap); const init = bootstrap.workerInit as unknown as WorkerInit; const launch = { run, init }; this.launches.push(launch); if (init.checkOnly) await this.emit(launch, { type: 'worker.ready', sessionId: init.sessionId }); return { pid: 7000 + this.launches.length, birth: 'SYNTHETIC-BIRTH', generation: run.generation, controlId: run.runId, driver: this.id }; }
  async runNodeCheck(_runId: string, _args: string[], _limits: { timeoutMs: number; maxOutputBytes: number }, requestId: string = randomUUID()) { this.nativeCalls++; return { requestId, exitCode: 0, output: 'Synthetic native check output.', reason: 'exited' as const, nativeEvidence: { synthetic: true } }; }
  async runShellCheck(_runId: string, args: string[], _limits: { timeoutMs: number; maxOutputBytes: number }, requestId: string = randomUUID()) { assert.equal(args.length, 1); this.shellCalls++; this.onShellCheck?.(); return { requestId, exitCode: 0, output: 'Synthetic locked Git Bash output.', reason: 'exited' as const, nativeEvidence: { synthetic: true, arguments: ['--noprofile', '--norc', '-c', args[0]] } }; }
  sendWorkerFrame(_id: string, value: unknown) { this.replies.push(value); }
  getResourceEvidence(id: string) { return { provisioned: this.launches.some(item => item.run.runId === id), revoked: this.stopped.has(id), status: 0 }; }
  async stop(run: RunRecord): Promise<Observation> { this.stopped.add(run.runId); return this.observe(run); }
  async observe(run: RunRecord): Promise<Observation> { return { state: this.stopped.has(run.runId) ? 'stopped' : 'alive', generation: run.generation, activePids: this.stopped.has(run.runId) ? [] : [7001], proof: 'SYNTHETIC process and ACL observation; no real isolation.' }; }
  async emit(launch: { run: RunRecord; init: WorkerInit }, body: Record<string, unknown>) { return this.handler(launch.run, Buffer.from(JSON.stringify({ version: 1, runId: launch.run.runId, ...(body.type === 'model.request' ? {} : { runtimeRunId: launch.run.runId }), generation: launch.run.generation, capability: launch.init.capability, ...body }))); }
}
function syntheticComposition(t: test.TestContext, localCommitAuthor?: ProductionOptions['localCommitAuthor'], shell = false) {
  const f = fixture(t); const configuration = f.configuration; configuration.provider = provider();
  const runtimeRoot = join(f.root, 'runtime-files'); mkdirSync(runtimeRoot);
  const nodeRoot = join(runtimeRoot, 'node'), workerRoot = join(runtimeRoot, 'worker'); mkdirSync(nodeRoot); mkdirSync(workerRoot);
  const binary = (path: string) => { writeFileSync(path, 'SYNTHETIC binary bytes'); return { path, version: '24.0.0', sha256: hash('SYNTHETIC binary bytes') }; };
  const profile: LockedRuntimeProfile = { profileId: 'synthetic-profile', osBuild: 'SYNTHETIC-OS', arch: 'x64', node: binary(join(nodeRoot, 'node.exe')), helper: binary(join(runtimeRoot, 'helper.exe')), worker: binary(join(workerRoot, 'main.mjs')), pi: { ...binary(join(runtimeRoot, 'pi.json')), package: '@earendil-works/pi-coding-agent' }, policySha256: 'a'.repeat(64), evidence: [] };
  if (shell) { const root = join(runtimeRoot, 'git-bash'); mkdirSync(root); const executable = binary(join(root, 'bash.exe')), library = binary(join(root, 'runtime.dll')), path = join(runtimeRoot, 'shell-manifest.json'), content = JSON.stringify({ schemaVersion: 1, rootPath: root, files: [executable, library].map(({ path, sha256 }) => ({ path, sha256 })) }); writeFileSync(path, content); profile.shell = { ...executable, version: '5.2.37', kind: 'git-bash', manifest: { path, sha256: hash(content) } }; }
  configuration.runtime = { profileId: profile.profileId, osBuild: profile.osBuild, arch: 'x64', node: { id: 'node', ...profile.node }, helper: { id: 'helper', ...profile.helper }, worker: { id: 'worker', ...profile.worker }, pi: { id: 'pi', ...profile.pi }, policySha256: profile.policySha256, evidence: { privateChannel: null, filesystem: null, processTree: null, network: null } };
  if (profile.shell) configuration.runtime.shell = { id: 'shell', ...profile.shell, manifest: { id: 'shell-manifest', ...profile.shell.manifest } };
  f.configuration = configuration;
  const drivers: SyntheticNativePort[] = []; const calls: string[] = [];
  const transport: BoundedProviderTransport = { mode: 'synthetic-no-network', provider: 'openai', modelId: 'gpt-4.1-mini', destination: 'https://api.openai.com/v1/responses', async send(request) { calls.push(request.requestId); return { text: 'Synthetic planner/reviewer observation.', usage: { tokens: 20, costMicros: 10, source: 'SYNTHETIC-NO-NETWORK' } }; } };
  const production = createSyntheticProductionServices({ store: f.store, workflow: f.workflow, workspace: () => f.workspace, knowledge: f.knowledge, budget: f.budget, configuration: () => f.configuration, stateDirectory: join(f.root, 'test-state'), localCommitAuthor }, { profile, transport, createDriver: bootstrap => { const driver = new SyntheticNativePort(bootstrap); drivers.push(driver); return driver; } });
  const coordinator = new ExecutionCoordinator(f.store, f.workflow, production.driver, production.prerequisites); production.bindCoordinator(coordinator);
  f.store.db.exec('CREATE TABLE host_model_decisions(grant_id TEXT,demand_id TEXT,decision_id TEXT,runtime_scope TEXT)');
  const authorize = (id: string) => {
    const data = [...production.requiredModelData('demand'), ...Object.values(f.store.getDemand('demand').methodSnapshot).flatMap(method => production.evidence.method(method!)).map(({ id, sha256 }) => ({ id, sha256 }))];
    f.budget.grant({ id, demandId: 'demand', decisionId: `decision-${id}`, provider: 'openai', modelId: 'gpt-4.1-mini', destination: 'https://api.openai.com/v1/responses', credentialRef: 'env:SYNTHETIC_TEST_ONLY', data, allowedRoles: ['planning', 'implementation', 'review', 'boundary-review'], contextPolicy: 'approved-run-derived-v1', ...provider().limits! });
    f.store.db.prepare('INSERT INTO host_model_decisions VALUES(?,?,?,?)').run(id, 'demand', `decision-${id}`, 'demand-worktree-private-runtime-v1');
  };
  authorize('grant1');
  const ready = async (driver: SyntheticNativePort, launch: { run: RunRecord; init: WorkerInit }) => {
    await driver.emit(launch, { type: 'worker.ready', sessionId: launch.init.sessionId });
    await driver.emit(launch, { type: 'model.request', sessionId: launch.init.sessionId, sequence: 1, purpose: 'prompt', context: { messages: [{ role: 'user', content: 'Synthetic bounded context', timestamp: 1 }] } });
  };
  const report = (driver: SyntheticNativePort, launch: { run: RunRecord; init: WorkerInit }, body: Record<string, unknown>) => driver.emit(launch, { type: 'worker.report', report: { ...body, requestId: randomUUID(), runId: launch.init.domainRunId, demandId: 'demand', generation: launch.init.domainGeneration } });
  const settled = (driver: SyntheticNativePort, launch: { run: RunRecord; init: WorkerInit }) => driver.emit(launch, { type: 'worker.settled', sessionId: launch.init.sessionId, aborted: false });
  return { ...f, production, coordinator, drivers, calls, authorize, ready, report, settled };
}
const pendingRef = (id: string) => ({ id, digest: 'pending', location: 'host-artifact' });
test('synthetic composition: actual orchestration launches separate boundary context and gates readiness', async t => {
  const f = syntheticComposition(t); assert.equal(f.production.synthetic, true);
  await f.production.tick(); const primary = f.drivers[0]!, planning = primary.launches[0]!; assert.ok(planning); await f.ready(primary, planning);
  await f.report(primary, planning, { type: 'plan-draft', plan: { id: 'plan1', scope: 'Bounded synthetic scope', spec: pendingRef('spec1'), tickets: pendingRef('tickets1'), requiredChecks: [], unresolvedQuestions: [] }, artifactBodies: [{ id: 'spec1', kind: 'plan', text: 'Synthetic immutable spec' }, { id: 'tickets1', kind: 'plan', text: 'Synthetic immutable tickets' }] });
  assert.equal(f.store.getDemand('demand').plans[0]!.ready, false);
  await f.settled(primary, planning);
  const boundaryDriver = f.drivers[1]!, boundary = boundaryDriver?.launches[0]!; assert.ok(boundary, JSON.stringify(f.store.getDemand('demand').blockedReasons));
  assert.equal(boundary.init.role, 'boundary-review'); assert.notEqual(boundary.init.sessionId, planning.init.sessionId);
  assert.ok(boundary.init.materials.some(m => m.id === 'method-review')); assert.ok(!boundary.init.materials.some(m => m.id === 'method-planning' || m.kind === 'implementation-session'));
  assert.deepEqual(primary.bootstraps[0]!.readonlyRuntimeRoots, [f.configuration.runtime!.node!.path, f.configuration.runtime!.worker!.path], 'Runtime ACL scope contains only exact pinned files, never readable sibling directories.');
  assert.ok(boundary.init.materials.some(m => m.id === 'plan-scope:plan1' && JSON.parse(m.content).scope === 'Bounded synthetic scope'));
  await f.production.tick(); assert.equal(primary.launches.length, 1, 'Pending boundary prevents replacement primary planner.');
  await f.ready(boundaryDriver, boundary);
  const row = f.store.db.prepare('SELECT context_id FROM host_boundary_runs WHERE domain_run_id=?').get(planning.init.domainRunId)!;
  const original = f.store.getRun(planning.init.domainRunId);
  await f.report(boundaryDriver, boundary, { type: 'plan-ready', planId: 'plan1', boundaryReview: { contextId: String(row.context_id), planningContextId: original.contextId, evidence: pendingRef('boundary1'), unresolvedBlockingFindings: [] }, artifactBodies: [{ id: 'boundary1', kind: 'check-evidence', text: 'Synthetic separate reviewer inspected exact plan and source.' }] });
  assert.equal(f.store.getDemand('demand').plans[0]!.ready, false, 'Report is held until separate native stop proof.');
  await f.settled(boundaryDriver, boundary); await f.production.tick();
  assert.equal(f.store.getDemand('demand').plans[0]!.ready, true);
  assert.equal(f.store.getDemand('demand').phase, 'awaiting-design'); assert.equal(f.calls.length, 2);
  assert.equal(f.store.listRuns()[0]!.status, 'stopped');
});
test('synthetic harness refuses real transports and pause stops independent boundary', async t => {
  const f = syntheticComposition(t); await f.production.tick(); const driver = f.drivers[0]!, launch = driver.launches[0]!; await f.ready(driver, launch);
  await f.report(driver, launch, { type: 'plan-draft', plan: { id: 'plan1', scope: 'Synthetic', spec: pendingRef('s'), tickets: pendingRef('t'), requiredChecks: [], unresolvedQuestions: [] }, artifactBodies: [{ id: 's', kind: 'plan', text: 'spec' }, { id: 't', kind: 'plan', text: 'tickets' }] });
  await f.settled(driver, launch); const boundaryDriver = f.drivers[1]!, boundary = boundaryDriver.launches[0]!;
  f.workflow.execute({ type: 'pause', requestId: randomUUID(), demandId: 'demand', expectedRevision: f.store.getDemand('demand').revision }, f.user); await f.production.tick();
  assert.equal(boundaryDriver.stopped.has(boundary.run.runId), true); assert.equal(f.store.getDemand('demand').control, 'paused'); assert.equal(f.calls.length, 1);
});

test('synthetic composition: stopped source handoff starts isolated review and freezes acceptance result', async t => {
  const f = syntheticComposition(t); await f.production.tick(); const primary = f.drivers[0]!, planning = primary.launches[0]!; await f.ready(primary, planning);
  await f.report(primary, planning, { type: 'plan-draft', plan: { id: 'plan1', scope: 'Synthetic end-to-end scope', spec: pendingRef('spec'), tickets: pendingRef('tickets'), requiredChecks: [{ id: 'native-test', name: 'Native bounded Node check', source: 'demand', highResource: true }], unresolvedQuestions: [] }, artifactBodies: [{ id: 'spec', kind: 'plan', text: 'Synthetic spec.' }, { id: 'tickets', kind: 'plan', text: 'Synthetic tickets.' }] });
  await f.settled(primary, planning); const reviewer = f.drivers[1]!, boundary = reviewer.launches[0]!; await f.ready(reviewer, boundary);
  const row = f.store.db.prepare('SELECT context_id FROM host_boundary_runs WHERE domain_run_id=?').get(planning.init.domainRunId)!;
  await f.report(reviewer, boundary, { type: 'plan-ready', planId: 'plan1', boundaryReview: { contextId: String(row.context_id), planningContextId: f.store.getRun(planning.init.domainRunId).contextId, evidence: pendingRef('boundary'), unresolvedBlockingFindings: [] }, artifactBodies: [{ id: 'boundary', kind: 'check-evidence', text: 'Synthetic independently observed boundary.' }] });
  await f.settled(reviewer, boundary); await f.production.tick();
  f.workflow.execute({ type: 'authorize-implementation', requestId: randomUUID(), demandId: 'demand', expectedRevision: f.store.getDemand('demand').revision, planId: 'plan1', confirmDesign: true }, f.user); f.authorize('grant2');
  await f.production.tick(); const implementation = primary.launches[1]!; assert.ok(implementation, JSON.stringify(f.production.diagnostics('demand'))); assert.equal(implementation.init.role, 'implementation'); await f.ready(primary, implementation);
  await generatedWrite(f, primary, implementation, 'code.txt', 'Synthetic generated implementation.');
  await f.report(primary, implementation, { type: 'content-ready', content: { id: 'content1', planId: 'plan1', code: { id: 'code1', digest: 'pending', location: 'current-worktree' }, knowledge: [], maintenance: 'not-needed', deliveryNotes: 'Synthetic immutable result.' } });
  assert.equal(f.store.getDemand('demand').activeContentId, undefined, 'A live writer cannot establish stable content.');
  await f.settled(primary, implementation); assert.equal(f.store.getDemand('demand').activeContentId, 'content1');
  await f.production.tick(); const review = primary.launches[2]!; assert.ok(review, JSON.stringify(f.production.diagnostics('demand'))); assert.equal(review.init.role, 'review'); assert.notEqual(review.init.sessionId, implementation.init.sessionId); await f.ready(primary, review);
  assert.ok(review.init.materials.some(m => m.id === 'code1')); assert.ok(!review.init.materials.some(m => m.kind === 'implementation-session' || m.kind === 'implementation-summary'));
  const checkRequest = randomUUID();
  f.store.db.prepare('INSERT INTO host_native_check_lease VALUES(1,?,?)').run('synthetic-other-runtime', 'unresolved-check');
  await primary.emit(review, { type: 'worker.check-request', requestId: checkRequest, toolCallId: 'tool-native', args: ['-e', 'console.log("synthetic")'], limits: { timeoutMs: 999999999, maxOutputBytes: 999999999 } });
  assert.equal(primary.nativeCalls, 0, 'A second check cannot bypass an occupied global lease.');
  assert.equal((primary.replies.at(-1) as { error: string }).error, 'CHECK_CAPACITY');
  f.store.db.prepare('DELETE FROM host_native_check_lease WHERE runtime_run_id=?').run('synthetic-other-runtime');
  await primary.emit(review, { type: 'worker.check-request', requestId: checkRequest, toolCallId: 'tool-native', args: ['-e', 'console.log("synthetic")'], limits: { timeoutMs: 999999999, maxOutputBytes: 999999999 } });
  assert.equal(primary.nativeCalls, 1);
  const checkReply = primary.replies.at(-1) as { ok: boolean; value: { evidence: { id: string; digest: string; location: string } } }; assert.equal(checkReply.ok, true);
  await f.report(primary, review, { type: 'check', check: { id: 'check1', contentId: 'content1', requirementId: 'native-test', status: 'passed', evidence: checkReply.value.evidence, environment: 'synthetic-native-profile' } });
  assert.equal(f.store.getDemand('demand').checks.length, 0, 'A live review cannot finalize check evidence before exact native stop.');
  await primary.emit(review, { type: 'worker.check-request', requestId: checkRequest, toolCallId: 'tool-native', args: ['-e', 'console.log("synthetic")'] });
  assert.equal(primary.nativeCalls, 1, 'A persisted native command ID cannot be replayed.');
  await f.report(primary, review, { type: 'review', reviewId: 'review1', contentId: 'content1', evidence: pendingRef('review-evidence'), knowledgeReviewed: true, findings: [], artifactBodies: [{ id: 'review-evidence', kind: 'check-evidence', text: 'Synthetic separate reviewer verified source, exact spec and no knowledge maintenance needed.' }] });
  await f.settled(primary, review); await f.production.tick();
  const demand = f.store.getDemand('demand'); assert.equal(demand.checks[0]!.status, 'passed'); assert.equal(demand.phase, 'awaiting-acceptance', JSON.stringify(demand.blockedReasons)); assert.equal(demand.results.length, 1); assert.equal(demand.acceptances.length, 0); assert.equal(f.calls.length, 4);
  const result = demand.results[0]!; assert.equal(f.production.evidence.stable('demand', result.K), true); writeFileSync(join(f.binding.worktreePath, 'code.txt'), 'external drift'); assert.equal(f.production.evidence.stable('demand', result.K), false);
});

test('nested private trees are denied before source approval or any synthetic launch', async t => {
  const f = syntheticComposition(t); mkdirSync(join(f.binding.worktreePath, 'src', '.local'), { recursive: true });
  writeFileSync(join(f.binding.worktreePath, 'src', '.local', 'sentinel'), 'SYNTHETIC PRIVATE SENTINEL MUST NOT ENTER CONTEXT');
  assert.throws(() => f.production.requiredModelData('demand'), /Nested .git\/.local/);
  await f.production.tick(); assert.equal(f.drivers.flatMap(driver => driver.launches).length, 0); assert.equal(f.calls.length, 0);
  assert.equal(f.production.diagnostics('demand').workspaceVerified, false);
});
test('restart records stop intent for durable boundary rows without pretending absent handles prove stop', async t => {
  const f = syntheticComposition(t); await f.production.tick(); const primary = f.drivers[0]!, planning = primary.launches[0]!; await f.ready(primary, planning);
  await f.report(primary, planning, { type: 'plan-draft', plan: { id: 'p', scope: 'Synthetic restart', spec: pendingRef('s'), tickets: pendingRef('t'), requiredChecks: [], unresolvedQuestions: [] }, artifactBodies: [{ id: 's', kind: 'plan', text: 'spec' }, { id: 't', kind: 'plan', text: 'tickets' }] });
  await f.settled(primary, planning); const boundary = f.drivers[1]!.launches[0]!;
  const restarted = createProductionServices({ store: f.store, workflow: f.workflow, workspace: () => f.workspace, knowledge: f.knowledge, budget: f.budget, configuration: () => f.configuration, stateDirectory: join(f.root, 'test-state') });
  const recoveredCoordinator = new ExecutionCoordinator(f.store, f.workflow, restarted.driver, restarted.prerequisites); restarted.bindCoordinator(recoveredCoordinator);
  await restarted.stopAllAuxiliary('explicit-exit-after-restart');
  const persisted = recoveredCoordinator.supervisor.get(boundary.run.runId); assert.equal(persisted.stopReason, 'explicit-exit-after-restart'); assert.equal(persisted.state, 'unknown');
  assert.equal(restarted.auxiliaryStatus().safe, false); assert.equal(f.store.getDemand('demand').plans[0]!.ready, false);
});

async function enterReview(f: ReturnType<typeof syntheticComposition>, options: { localCommit?: boolean; beforeImplementation?: () => void; beforeHandoff?: (primary: SyntheticNativePort, implementation: { run: RunRecord; init: WorkerInit }) => void | Promise<void> } = {}) {
  await f.production.tick(); const primary = f.drivers[0]!, planning = primary.launches[0]!; await f.ready(primary, planning);
  await f.report(primary, planning, { type: 'plan-draft', plan: { id: 'p', scope: 'Only this requested feature', spec: pendingRef('s'), tickets: pendingRef('t'), requiredChecks: [{ id: 'test', name: 'Check requested feature', source: 'demand' }], unresolvedQuestions: [] }, artifactBodies: [{ id: 's', kind: 'plan', text: 'Exact requested behavior.' }, { id: 't', kind: 'plan', text: 'Bounded tickets.' }] });
  await f.settled(primary, planning); const boundaryDriver = f.drivers[1]!, boundary = boundaryDriver.launches[0]!; await f.ready(boundaryDriver, boundary);
  const context = String(f.store.db.prepare('SELECT context_id FROM host_boundary_runs WHERE domain_run_id=?').get(planning.init.domainRunId)!.context_id);
  await f.report(boundaryDriver, boundary, { type: 'plan-ready', planId: 'p', boundaryReview: { contextId: context, planningContextId: f.store.getRun(planning.init.domainRunId).contextId, evidence: pendingRef('b'), unresolvedBlockingFindings: [] }, artifactBodies: [{ id: 'b', kind: 'check-evidence', text: 'Independent boundary observations.' }] });
  await f.settled(boundaryDriver, boundary); await f.production.tick();
  f.workflow.execute({ expectedRevision: f.store.getDemand('demand').revision, type: 'authorize-implementation', requestId: randomUUID(), demandId: 'demand', planId: 'p', confirmDesign: true, localCommit: options.localCommit }, f.user); options.beforeImplementation?.(); f.authorize('grant2');
  await f.production.tick(); const implementation = primary.launches[1]!; assert.ok(implementation, JSON.stringify(f.production.diagnostics('demand'))); await f.ready(primary, implementation);
  await generatedWrite(f, primary, implementation, 'code.txt', 'Synthetic feature implementation.');
  await options.beforeHandoff?.(primary, implementation);
  await f.report(primary, implementation, { type: 'content-ready', content: { id: 'c', planId: 'p', code: { id: 'code', digest: 'pending', location: 'current-worktree' }, knowledge: [], maintenance: 'not-needed', deliveryNotes: 'Feature implemented.' } });
  await f.settled(primary, implementation); await f.production.tick();
  const review = primary.launches[2]!; assert.ok(review, JSON.stringify(f.production.diagnostics('demand'))); await f.ready(primary, review); return { primary, review };
}
async function nativeCheck(f: ReturnType<typeof syntheticComposition>, primary: SyntheticNativePort, review: { run: RunRecord; init: WorkerInit }) {
  await primary.emit(review, { type: 'worker.check-request', requestId: randomUUID(), toolCallId: 'native-tool', args: ['-e', 'console.log("synthetic")'] });
  const reply = primary.replies.at(-1) as { ok: boolean; value: { evidence: { id: string; digest: string; location: string } } }; assert.equal(reply.ok, true); return reply.value.evidence;
}

test('registered artifacts cannot advance an unobserved model session', async t => {
  const f = syntheticComposition(t); await f.production.tick(); const primary = f.drivers[0]!, planning = primary.launches[0]!;
  await primary.emit(planning, { type: 'worker.ready', sessionId: planning.init.sessionId });
  const spec = f.production.evidence.save({ id: 'prepared-spec', demandId: 'demand', projectId: 'project', runId: 'some-old-run', kind: 'plan', text: 'Preexisting artifact is not proof of planning.' });
  await assert.rejects(f.report(primary, planning, { type: 'plan-draft', plan: { id: 'fake', scope: 'unobserved', spec, tickets: spec, requiredChecks: [], unresolvedQuestions: [] } }), /Artifacts and Worker self-report/);
  assert.equal(f.store.getDemand('demand').plans.length, 0); assert.equal(f.calls.length, 0);
});

test('late source drift invalidates queued native checks and review before a result freezes', async t => {
  const f = syntheticComposition(t), { primary, review } = await enterReview(f), check = await nativeCheck(f, primary, review);
  await f.report(primary, review, { type: 'check', check: { id: 'check', contentId: 'c', requirementId: 'test', status: 'passed', evidence: check, environment: 'Worker cannot select this' } });
  await f.report(primary, review, { type: 'review', reviewId: 'r', contentId: 'c', evidence: pendingRef('r-evidence'), knowledgeReviewed: true, findings: [], artifactBodies: [{ id: 'r-evidence', kind: 'check-evidence', text: 'Observed exact source before external drift.' }] });
  writeFileSync(join(f.binding.worktreePath, 'code.txt'), 'External change after reports.');
  await assert.rejects(f.settled(primary, review), /Source differs/); await f.production.tick();
  assert.equal(f.store.getDemand('demand').results.length, 0); assert.equal(f.store.getDemand('demand').checks.length, 0); assert.equal(f.production.prerequisites.verifyWorkspaceAfterStop('demand'), false);
});

test('fresh rework session gets exact findings and evidence without expanding the confirmed scope', async t => {
  const f = syntheticComposition(t), { primary, review } = await enterReview(f), check = await nativeCheck(f, primary, review);
  await f.report(primary, review, { type: 'check', check: { id: 'failed', contentId: 'c', requirementId: 'test', status: 'failed', evidence: check, environment: 'ignored-worker-label' } });
  await f.report(primary, review, { type: 'review', reviewId: 'r', contentId: 'c', evidence: pendingRef('r-evidence'), knowledgeReviewed: true, findings: [{ id: 'fix-1', severity: 'blocking', location: 'code.txt', basis: 'Confirmed requested feature', impact: 'Required behavior is wrong', verification: 'Run the scoped native check again' }], artifactBodies: [{ id: 'r-evidence', kind: 'check-evidence', text: 'Concrete correction needed for fix-1.' }] });
  await f.settled(primary, review); await f.production.tick();
  const rework = primary.launches[3]!; assert.ok(rework, JSON.stringify(f.production.diagnostics('demand'))); assert.equal(rework.init.role, 'implementation');
  const material = rework.init.materials.find(item => item.id.startsWith('rework-scope:'))!, body = JSON.parse(material.content);
  assert.equal(body.planId, 'p'); assert.equal(body.findings[0].id, 'fix-1'); assert.equal(body.checks[0].status, 'failed');
  assert.ok(rework.init.materials.some(item => item.id === check.id && item.content.includes('Synthetic native check output')));
  assert.ok(rework.init.materials.some(item => item.id === 'r-evidence' && item.content.includes('fix-1')));
  assert.equal(JSON.parse(rework.init.materials.find(item => item.id === 'plan-scope:p')!.content).scope, 'Only this requested feature');
});

test('model data preparation preserves only role-authorized explicitly selected knowledge revisions', t => {
  const f = syntheticComposition(t);
  const selected = f.knowledge.saveCandidate({ revisionId: 'selected', knowledgeId: 'item', projectId: 'project', demandId: 'demand', createdBy: 'owner', title: 'Approved local fact', tags: [], body: 'Exact selected knowledge body.', sourceKind: 'existing-fact', materialKind: 'knowledge', statementKind: 'fact', formalTarget: 'main', roles: ['planner', 'reviewer'], modulePaths: [] });
  f.knowledge.saveCandidate({ revisionId: 'foreign', knowledgeId: 'secret', projectId: 'project', demandId: 'foreign-demand', createdBy: 'owner', title: 'Ineligible private fact', tags: [], body: 'Must not enter approval or Worker input.', sourceKind: 'implementation', materialKind: 'knowledge', statementKind: 'fact', formalTarget: 'main', roles: ['planner'], modulePaths: [] });
  f.configuration.provider!.data = [{ id: 'knowledge:selected', sha256: selected.object.sha256 }, { id: 'knowledge:foreign', sha256: 'a'.repeat(64) }];
  const approved = f.production.requiredModelData('demand');
  assert.ok(approved.some(item => item.id === 'knowledge:selected' && item.sha256 === selected.object.sha256)); assert.ok(!approved.some(item => item.id === 'knowledge:foreign'));
  const readIds = f.store.db.prepare('SELECT revision_id FROM knowledge_reads').all().map(row => row.revision_id); assert.ok(readIds.includes('selected')); assert.ok(!readIds.includes('foreign'));
});

async function completeReview(f: ReturnType<typeof syntheticComposition>, primary: SyntheticNativePort, review: { run: RunRecord; init: WorkerInit }, shell = false) {
  let check: { id: string; digest: string; location: string };
  if (shell) { await primary.emit(review, { type: 'worker.shell-request', requestId: randomUUID(), toolCallId: 'shell-template', args: ['printf synthetic-baseline'] }); const reply = primary.replies.at(-1) as { ok: boolean; value: { evidence: typeof check } }; assert.equal(reply.ok, true); check = reply.value.evidence; }
  else check = await nativeCheck(f, primary, review);
  await f.report(primary, review, { type: 'check', check: { id: 'pass', contentId: 'c', requirementId: 'test', status: 'passed', evidence: check, environment: 'ignored' } });
  await f.report(primary, review, { type: 'review', reviewId: 'r', contentId: 'c', evidence: pendingRef('r-evidence'), knowledgeReviewed: true, findings: [], artifactBodies: [{ id: 'r-evidence', kind: 'check-evidence', text: 'Independent verified result.' }] });
  await f.settled(primary, review); await f.production.tick();
  assert.equal(f.store.getDemand('demand').phase, 'awaiting-acceptance');
}

test('return reasons are explicitly approved and carried with the exact returned result into fresh rework', async t => {
  const f = syntheticComposition(t), { primary, review } = await enterReview(f); await completeReview(f, primary, review);
  const result = f.store.getDemand('demand').activeResultId!;
  f.workflow.execute({ expectedRevision: f.store.getDemand('demand').revision, type: 'return-result', requestId: randomUUID(), demandId: 'demand', resultId: result, reason: 'Keep the approved scope; correct the specified edge case.' }, f.user);
  const proposed = f.production.requiredModelData('demand'); assert.ok(proposed.some(item => item.id === 'user-decisions:demand')); assert.ok(proposed.some(item => item.id === 'code'));
  await f.production.tick(); assert.equal(primary.launches.length, 3, 'New user reasons are not automatically covered by old generated-context permission.');
  f.authorize('grant3'); await f.production.tick(); const rework = primary.launches[3]!; assert.ok(rework, JSON.stringify(f.production.diagnostics('demand')));
  const body = JSON.parse(rework.init.materials.find(item => item.id.startsWith('rework-scope:'))!.content);
  assert.equal(body.returns[0].resultId, result); assert.match(body.returns[0].reason, /specified edge case/);
  assert.ok(rework.init.materials.some(item => item.id === 'r-evidence')); assert.ok(rework.init.materials.some(item => item.id === 'code'));
});

test('stopped profile changes replace both native drivers and retain bounded revision instructions', async t => {
  const f = syntheticComposition(t), { primary, review } = await enterReview(f); await completeReview(f, primary, review);
  const result = f.store.getDemand('demand').activeResultId!;
  f.workflow.execute({ expectedRevision: f.store.getDemand('demand').revision, type: 'return-result', requestId: randomUUID(), demandId: 'demand', resultId: result, reason: 'Return before revising the plan.' }, f.user);
  f.workflow.execute({ expectedRevision: f.store.getDemand('demand').revision, type: 'revise-plan', requestId: randomUUID(), demandId: 'demand', previousPlanId: 'p', reason: 'Only adjust the requested edge case.' }, f.user);
  f.configuration.runtime!.policySha256 = 'b'.repeat(64); f.authorize('grant3'); await f.production.tick();
  const replacement = f.drivers[2]!, planning = replacement?.launches[0]!; assert.ok(planning, JSON.stringify(f.production.diagnostics('demand'))); assert.equal(planning.init.role, 'planning');
  assert.match(planning.init.materials.find(item => item.id === 'user-decisions:demand')!.content, /Only adjust the requested edge case/);
  assert.ok(planning.init.materials.some(item => item.id === 'plan-scope:p'), 'Revision sees the previous exact scope without silently retaining its authority.');
  await f.ready(replacement, planning);
  await f.report(replacement, planning, { type: 'plan-draft', plan: { id: 'p2', scope: 'Only adjusted requested edge case', spec: pendingRef('s2'), tickets: pendingRef('t2'), requiredChecks: [], unresolvedQuestions: [] }, artifactBodies: [{ id: 's2', kind: 'plan', text: 'Revised exact spec.' }, { id: 't2', kind: 'plan', text: 'Revised exact tickets.' }] });
  await f.settled(replacement, planning);
  assert.equal(f.drivers.length, 4); assert.equal(f.drivers[1]!.launches.length, 1, 'Old boundary driver is never reused with a new profile binding.'); assert.equal(f.drivers[3]!.launches[0]!.init.role, 'boundary-review');
});

test('explicit local commit uses approved author only after native writer stop and before immutable source capture', async t => {
  const author = { name: 'Explicit Synthetic Author', email: 'explicit@example.invalid' }, f = syntheticComposition(t, demandId => { assert.equal(demandId, 'demand'); return author; });
  await enterReview(f, { localCommit: true, beforeHandoff(primary, implementation) {
    assert.equal(primary.stopped.has(implementation.run.runId), false); assert.equal(git(f.binding.worktreePath, 'rev-parse', 'HEAD'), f.binding.head, 'A live writer cannot create a commit.');
  } });
  const demand = f.store.getDemand('demand'), content = demand.contents[0]!, snapshot = JSON.parse(f.production.evidence.read(demand.id, content.code).content), head = git(f.binding.worktreePath, 'rev-parse', 'HEAD');
  assert.notEqual(head, f.binding.head); assert.equal(snapshot.head, head); assert.equal(f.workspace.getBinding('demand')!.head, head);
  assert.equal(git(f.binding.worktreePath, 'log', '-1', '--format=%an <%ae>'), 'Explicit Synthetic Author <explicit@example.invalid>');
  assert.equal(git(f.binding.worktreePath, 'status', '--porcelain'), ''); assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.binding.head);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM workspace_intents WHERE kind='commit' AND status='complete'").get()!.n, 1);
});

test('local commit author absence fails before implementation without guessing repository identity', async t => {
  const f = syntheticComposition(t);
  await assert.rejects(enterReview(f, { localCommit: true }), /LOCAL_COMMIT_AUTHOR_REQUIRED/);
  assert.equal(f.drivers[0]!.launches.length, 1); assert.equal(git(f.binding.worktreePath, 'rev-parse', 'HEAD'), f.binding.head);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM workspace_intents WHERE kind='commit'").get()!.n, 0);
});

test('requested local commit preserves user-staged data and does not freeze partial delivery', async t => {
  const f = syntheticComposition(t, () => ({ name: 'Explicit Synthetic Author', email: 'explicit@example.invalid' }));
  await assert.rejects(enterReview(f, { localCommit: true, beforeHandoff() {
    writeFileSync(join(f.binding.worktreePath, 'user.txt'), 'Preexisting user staging must survive.'); git(f.binding.worktreePath, 'add', 'user.txt');
  } }), /Source differs|staged work is preserved/);
  assert.equal(git(f.binding.worktreePath, 'diff', '--cached', '--name-only'), 'user.txt'); assert.equal(git(f.binding.worktreePath, 'rev-parse', 'HEAD'), f.binding.head);
  assert.equal(f.store.getDemand('demand').contents.length, 0); assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM workspace_intents WHERE kind='commit'").get()!.n, 0);
});

test('unrequested local commit never reads an author and remains honestly uncommitted', async t => {
  let authorReads = 0; const f = syntheticComposition(t, () => { authorReads++; return { name: 'Unused', email: 'unused@example.invalid' }; });
  await enterReview(f); assert.equal(authorReads, 0); assert.equal(git(f.binding.worktreePath, 'rev-parse', 'HEAD'), f.binding.head); assert.ok(git(f.binding.worktreePath, 'status', '--porcelain').includes('code.txt'));
});

async function generatedWrite(f: ReturnType<typeof syntheticComposition>, driver: SyntheticNativePort, launch: { run: RunRecord; init: WorkerInit }, path: string, content: string) {
  const requestId = randomUUID(); await driver.emit(launch, { type: 'worker.write-request', requestId, toolCallId: 'write-tool', path, sha256: hash(content), bytes: Buffer.byteLength(content) });
  assert.equal((driver.replies.at(-1) as { ok: boolean }).ok, true, JSON.stringify(driver.replies.at(-1)));
  writeFileSync(join(f.binding.worktreePath, path), content);
  await driver.emit(launch, { type: 'worker.write-complete', requestId });
  assert.equal((driver.replies.at(-1) as { ok: boolean }).ok, true, JSON.stringify(driver.replies.at(-1)));
}

test('invalidated selected knowledge stops the existing model session before another provider operation', async t => {
  const f = syntheticComposition(t), revision = f.knowledge.saveCandidate({ revisionId: 'revoked', knowledgeId: 'revoked-item', projectId: 'project', demandId: 'demand', createdBy: 'prior-author', title: 'Revoked fact', tags: [], body: 'No longer eligible', sourceKind: 'existing-fact', materialKind: 'knowledge', statementKind: 'fact', formalTarget: 'main', roles: ['planner'], modulePaths: [] });
  f.configuration.provider!.data.push({ id: 'knowledge:revoked', sha256: revision.object.sha256 }); f.authorize('knowledge-grant'); await f.production.tick();
  const driver = f.drivers[0]!, planning = driver.launches[0]!; await f.ready(driver, planning); assert.equal(f.calls.length, 1);
  f.knowledge.invalidate({ revisionId: 'revoked', reason: 'Fact is wrong', evidenceRef: 'explicit-revocation' });
  await driver.emit(planning, { type: 'model.request', sessionId: planning.init.sessionId, sequence: 2, purpose: 'prompt', context: { messages: [{ role: 'user', content: 'No longer eligible', timestamp: 2 }] } });
  assert.equal(f.calls.length, 1); assert.equal((driver.replies.at(-1) as { error: string }).error, 'KNOWLEDGE_CONTEXT_REVOKED'); assert.equal(driver.stopped.has(planning.run.runId), true);
});

test('read-only external source changes never acquire generated-context transmission authority', async t => {
  const f = syntheticComposition(t); await f.production.tick(); const driver = f.drivers[0]!, planning = driver.launches[0]!;
  writeFileSync(join(f.binding.worktreePath, 'code.txt'), 'Unapproved external edit'); await f.ready(driver, planning);
  assert.equal(f.calls.length, 0); assert.equal((driver.replies.at(-1) as { error: string }).error, 'READ_ONLY_SOURCE_CHANGED'); assert.equal(driver.stopped.has(planning.run.runId), true);
});

test('unproven implementation mutations stop egress even after a legitimate controlled write', async t => {
  const f = syntheticComposition(t);
  await assert.rejects(enterReview(f, { async beforeHandoff(primary, implementation) {
    writeFileSync(join(f.binding.worktreePath, 'external.txt'), 'UNAPPROVED external data');
    await primary.emit(implementation, { type: 'model.request', sessionId: implementation.init.sessionId, sequence: 2, purpose: 'prompt', context: { messages: [{ role: 'user', content: 'UNAPPROVED external data', timestamp: 2 }] } });
  } }), /Source differs/);
  assert.equal(f.calls.length, 3); assert.equal(f.store.getDemand('demand').contents.length, 0);
});

async function integrateNewBaseline(f: ReturnType<typeof syntheticComposition>, shell = false) {
  const { primary, review } = await enterReview(f, { localCommit: true }); await completeReview(f, primary, review, shell);
  const result = f.store.getDemand('demand').activeResultId!;
  writeFileSync(join(f.repo, 'new-baseline.txt'), 'New formal capability input.'); git(f.repo, 'add', 'new-baseline.txt'); git(f.repo, 'commit', '-m', 'Synthetic formal advance');
  const sourceCommit = git(f.repo, 'rev-parse', 'HEAD'), operationId = 'baseline-integration';
  const integrated = f.workspace.updateBaseline({ operationId, demandId: 'demand', sourceCommit, formalTarget: 'main', updateAuthorized: true, writerStopped: true, controlState: 'active', author: { name: 'Explicit Integration Author', email: 'integration@example.invalid' } });
  f.workflow.invalidateCurrentContent('demand', 'Baseline source needs fresh verification.');
  return { demandId: 'demand', operationId, expectedHead: integrated.head!, templateResultId: result, checkIds: ['pass'] };
}

test('baseline check-only lane reexecutes native recipes at integrated HEAD without model traffic and retains synthetic provenance', async t => {
  const f = syntheticComposition(t, () => ({ name: 'Explicit Synthetic Author', email: 'explicit@example.invalid' })), input = await integrateNewBaseline(f), calls = f.calls.length;
  const result = await f.production.verifyBaselineChecks(input);
  assert.equal(f.calls.length, calls); assert.equal(result.head, input.expectedHead); assert.equal(result.sourceDigest, f.production.evidence.sourceMaterial('demand').sha256); assert.equal(result.provenance, 'synthetic-native-receipt'); assert.equal(result.stopped, true); assert.equal(result.evidenceRefs.length, 1);
  const lane = f.drivers.at(-1)!, launch = lane.launches[0]!; assert.equal(launch.init.checkOnly, true); assert.equal(launch.init.role, 'check'); assert.equal(launch.run.writes, false); assert.equal(launch.run.highResource, true); assert.equal(lane.nativeCalls, 1); assert.equal(lane.stopped.has(launch.run.runId), true); assert.equal(f.production.auxiliaryStatus().safe, true);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM host_native_check_lease').get()!.n, 0);
  assert.deepEqual(await f.production.verifyBaselineChecks(input), result); assert.equal(lane.nativeCalls, 1, 'Exact completed local verification is idempotent.');
});

test('paused baseline checks stop promptly without being killed by expected baseline-verification blockers', async t => {
  const f = syntheticComposition(t, () => ({ name: 'Explicit Synthetic Author', email: 'explicit@example.invalid' })), input = await integrateNewBaseline(f), original = SyntheticNativePort.prototype.runNodeCheck;
  let release!: () => void, started!: () => void; const runningCheck = new Promise<void>(resolve => { started = resolve; });
  SyntheticNativePort.prototype.runNodeCheck = async function (...args) { if (this.launches[0]?.init.checkOnly) { started(); await new Promise<void>(resolve => { release = resolve; }); } return original.apply(this, args); };
  t.after(() => { SyntheticNativePort.prototype.runNodeCheck = original; });
  const pending = f.production.verifyBaselineChecks(input); const rejection = assert.rejects(pending, /Baseline control/); await runningCheck;
  const lane = f.drivers.at(-1)!, launch = lane.launches[0]!;
  await f.production.tick(); assert.equal(lane.stopped.has(launch.run.runId), false, 'Expected source-verification blockers do not cancel the authorized check-only lane.');
  f.workflow.execute({ expectedRevision: f.store.getDemand('demand').revision, type: 'pause', requestId: randomUUID(), demandId: 'demand' }, f.user); await f.production.tick(); assert.equal(lane.stopped.has(launch.run.runId), true);
  release(); await rejection; assert.equal(f.production.auxiliaryStatus().safe, true); assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM host_baseline_checks WHERE status='complete'").get()!.n, 0);
});

test('exact controlled deletion is observed under the Worker token and supports later model context', async t => {
  const f = syntheticComposition(t);
  await enterReview(f, { async beforeHandoff(primary, implementation) {
    await generatedWrite(f, primary, implementation, 'remove.txt', 'Exact generated file to remove.');
    const requestId = randomUUID(); await primary.emit(implementation, { type: 'worker.write-request', action: 'delete', requestId, toolCallId: 'delete-tool', path: 'remove.txt', sha256: null, bytes: 0 }); assert.equal((primary.replies.at(-1) as { ok: boolean }).ok, true);
    rmSync(join(f.binding.worktreePath, 'remove.txt')); await primary.emit(implementation, { type: 'worker.write-complete', requestId }); assert.equal((primary.replies.at(-1) as { ok: boolean }).ok, true);
    await primary.emit(implementation, { type: 'model.request', sessionId: implementation.init.sessionId, sequence: 2, purpose: 'prompt', context: { messages: [{ role: 'user', content: 'Exact generated file was removed.', timestamp: 2 }] } }); assert.equal((primary.replies.at(-1) as { ok: boolean }).ok, true);
    const receipt = JSON.parse(String(f.store.db.prepare('SELECT body FROM host_generated_writes WHERE request_id=?').get(requestId)!.body)); assert.equal(receipt.action, 'delete'); assert.equal(receipt.status, 'verified');
  } });
  assert.equal(f.calls.length, 5);
});

test('locked Git Bash uses the native receipt lane and exact dependency files without granting runtime directories', async t => {
  const f = syntheticComposition(t, undefined, true), { primary, review } = await enterReview(f); assert.equal(review.init.shellEnabled, true);
  const requestId = randomUUID(); await primary.emit(review, { type: 'worker.shell-request', requestId, toolCallId: 'shell-tool', args: ['printf synthetic'] });
  const reply = primary.replies.at(-1) as { ok: boolean; value: { evidence: { id: string; digest: string; location: string } } }; assert.equal(reply.ok, true); assert.equal(primary.shellCalls, 1);
  const receipt = JSON.parse(f.production.evidence.read('demand', reply.value.evidence).content); assert.equal(receipt.executable, 'git-bash'); assert.deepEqual(receipt.args, ['printf synthetic']); assert.deepEqual(receipt.nativeEvidence.arguments, ['--noprofile', '--norc', '-c', 'printf synthetic']);
  assert.ok(primary.bootstraps[0]!.readonlyRuntimeRoots.some(path => path.endsWith('runtime.dll'))); assert.ok(primary.bootstraps[0]!.readonlyRuntimeRoots.every(path => !path.endsWith('git-bash')));
});

test('shell-generated source mutation stops model transmission instead of becoming an approved write', async t => {
  const f = syntheticComposition(t, undefined, true);
  await assert.rejects(enterReview(f, { async beforeHandoff(primary, implementation) {
    primary.onShellCheck = () => writeFileSync(join(f.binding.worktreePath, 'code.txt'), 'Unproven shell-generated source');
    await primary.emit(implementation, { type: 'worker.shell-request', requestId: randomUUID(), toolCallId: 'shell-write', args: ['attempt synthetic mutation'] });
    assert.equal((primary.replies.at(-1) as { error: string }).error, 'UNPROVEN_SOURCE_MUTATION'); assert.equal(primary.stopped.has(implementation.run.runId), true);
  } }), /Source differs/);
  assert.equal(f.calls.length, 3); assert.equal(f.store.getDemand('demand').contents.length, 0);
});

test('read-approved preexisting user files never become local commit authority', async t => {
  const f = syntheticComposition(t, () => ({ name: 'Explicit Synthetic Author', email: 'explicit@example.invalid' }));
  await assert.rejects(enterReview(f, { localCommit: true, beforeImplementation() { writeFileSync(join(f.binding.worktreePath, 'user-owned.txt'), 'Existing user work approved for reading only.'); } }), /Unrelated preexisting dirty files/);
  assert.equal(git(f.binding.worktreePath, 'rev-parse', 'HEAD'), f.binding.head); assert.equal(readFileSync(join(f.binding.worktreePath, 'user-owned.txt'), 'utf8'), 'Existing user work approved for reading only.');
  assert.equal(f.store.getDemand('demand').contents.length, 0); assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM workspace_intents WHERE kind='commit'").get()!.n, 0);
});

test('fresh baseline replay preserves the locked Git Bash recipe instead of substituting Node', async t => {
  const f = syntheticComposition(t, () => ({ name: 'Explicit Synthetic Author', email: 'explicit@example.invalid' }), true), input = await integrateNewBaseline(f, true), calls = f.calls.length;
  const verified = await f.production.verifyBaselineChecks(input), lane = f.drivers.at(-1)!;
  assert.equal(lane.shellCalls, 1); assert.equal(lane.nativeCalls, 0); assert.equal(f.calls.length, calls);
  const ref = f.production.evidence.reference('demand', verified.evidenceRefs[0]!), receipt = JSON.parse(f.production.evidence.read('demand', ref).content);
  assert.equal(receipt.executable, 'git-bash'); assert.deepEqual(receipt.args, ['printf synthetic-baseline']); assert.equal(receipt.head, input.expectedHead); assert.equal(verified.stopped, true);
});
