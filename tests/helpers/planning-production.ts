import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { WorkbenchStore, WorkflowService } from '../../src/domain/index.ts';
import { WorkspaceService, ImmutableObjectStore } from '../../src/workspace/index.ts';
import { KnowledgeService } from '../../src/knowledge/index.ts';
import { ModelBudgetLedger } from '../../src/runtime/budget.ts';
import { emptyConfiguration, loadMethods } from '../../src/host/configuration.ts';
import type { MethodSourceConfiguration, ProviderConfiguration } from '../../src/host/configuration.ts';
import { hash } from '../../src/host/evidence.ts';
import { createSyntheticProductionServices } from '../../src/host/production.ts';
import { ExecutionCoordinator } from '../../src/host/coordinator.ts';
import { runWorkerFromStreams } from '../../src/agent/worker-runtime.ts';
import type { WorkerInit } from '../../src/agent/worker-runtime.ts';
import { PrivateFrameDecoder, encodePrivateFrame } from '../../src/runtime/pipe-frames.ts';
import type { WindowsRunBootstrap } from '../../src/runtime/verified-windows-driver.ts';
import type { LockedRuntimeProfile } from '../../src/runtime/profile.ts';
import type { RunRecord, ProcessIdentity, Observation } from '../../src/runtime/types.ts';
import type { BoundedProviderTransport, BoundedTransportRequest, ProviderResponse } from '../../src/runtime/model-broker.ts';

// The installed Pi SDK, Worker, framing, Host, SQLite and Git execute for real.
// Provider responses and native process/ACL observations remain synthetic. These
// fixtures do not contact a model endpoint or claim Windows isolation evidence.
const gitExecutable = process.env.PI_KANBAN_TEST_GIT ?? (process.platform === 'win32' ? execFileSync('where.exe', ['git.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]! : '/usr/bin/git');
export function git(cwd: string, ...args: string[]) {
  return execFileSync(gitExecutable, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } }).trim();
}
export type Launch = { run: RunRecord; init: WorkerInit };
export type Script = (request: BoundedTransportRequest, turn: number) => ProviderResponse | Promise<ProviderResponse>;

export class SyntheticPlanningNativePort {
  readonly id = 'synthetic-production-composition';
  readonly isolation = 'synthetic-process-supervision-only' as const;
  launches: Launch[] = [];
  bootstraps: WindowsRunBootstrap[] = [];
  replies: Record<string, unknown>[] = [];
  frames: Record<string, unknown>[] = [];
  stopped = new Set<string>();
  private inputs = new Map<string, PassThrough>();
  private handler!: (run: RunRecord, frame: Uint8Array) => Promise<void>;
  beforeSettled?: (launch: Launch) => void;
  readonly bootstrap: (run: RunRecord) => WindowsRunBootstrap;
  constructor(bootstrap: (run: RunRecord) => WindowsRunBootstrap) { this.bootstrap = bootstrap; }
  setStopHandler(_handler: (id: string, reason: string) => Promise<void>) {}
  setWorkerFrameHandler(handler: (run: RunRecord, frame: Uint8Array) => Promise<void>) { this.handler = handler; }
  preflight() {}
  async launch(run: RunRecord): Promise<ProcessIdentity> {
    const boot = this.bootstrap(run); this.bootstraps.push(boot);
    this.launches.push({ run, init: boot.workerInit as unknown as WorkerInit });
    return { pid: 9000 + this.launches.length, birth: 'SYNTHETIC-BIRTH', generation: run.generation, controlId: run.runId, driver: this.id };
  }
  async runNodeCheck(): Promise<{ requestId: string; exitCode: number; output: string; reason: 'exited'; nativeEvidence: { synthetic: boolean } }> { throw new Error('Planning must not execute implementation checks.'); }
  sendWorkerFrame(id: string, value: unknown) {
    this.replies.push(value as Record<string, unknown>);
    this.inputs.get(id)?.write(encodePrivateFrame(Buffer.from(JSON.stringify(value))));
  }
  getResourceEvidence(id: string) { return { provisioned: this.launches.some(item => item.run.runId === id), revoked: this.stopped.has(id), status: 0 }; }
  async stop(run: RunRecord): Promise<Observation> { this.stopped.add(run.runId); return this.observe(run); }
  async observe(run: RunRecord): Promise<Observation> {
    return { state: this.stopped.has(run.runId) ? 'stopped' : 'alive', generation: run.generation, activePids: this.stopped.has(run.runId) ? [] : [9001], proof: 'SYNTHETIC process/ACL observation; no real isolation.' };
  }
  async emit(launch: Launch, body: Record<string, unknown>) {
    return this.handler(launch.run, Buffer.from(JSON.stringify({ version: 1, runId: launch.run.runId, ...(body.type === 'model.request' ? {} : { runtimeRunId: launch.run.runId }), generation: launch.run.generation, capability: launch.init.capability, ...body })));
  }
  async drive(launch: Launch) {
    const input = new PassThrough(), output = new PassThrough(), decoder = new PrivateFrameDecoder();
    this.inputs.set(launch.run.runId, input);
    let queue = Promise.resolve(), failure: unknown;
    output.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        const value = JSON.parse(Buffer.from(frame).toString()) as Record<string, unknown>; this.frames.push(value);
        queue = queue.then(async () => {
          if (value.type === 'worker.settled') this.beforeSettled?.(launch);
          await this.handler(launch.run, frame);
        }).catch(error => { failure ??= error; input.destroy(error as Error); });
      }
    });
    const running = runWorkerFromStreams(input, output, launch.init.generation);
    input.write(encodePrivateFrame(Buffer.from(JSON.stringify(launch.init))));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([running, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`Actual Worker did not settle: ${JSON.stringify(this.replies.slice(-2))}`)), 15_000); })]);
      await queue;
      if (failure) throw failure;
    } finally {
      if (timeout) clearTimeout(timeout);
      this.inputs.delete(launch.run.runId); input.destroy(); output.destroy();
    }
  }
}

export function planningProductionFixture(t: TestContext, planning: (root: string) => MethodSourceConfiguration) {
  const root = mkdtempSync(join(tmpdir(), 'pi-staged-production-')), repo = join(root, 'repo'); mkdirSync(repo);
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Synthetic Planning Fixture'); git(repo, 'config', 'user.email', 'planning@example.invalid'); git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'code.txt'), 'Existing source behavior.\n'); git(repo, 'add', 'code.txt'); git(repo, 'commit', '-m', 'Synthetic planning baseline');
  const store = new WorkbenchStore(join(root, 'host.sqlite')), workflow = new WorkflowService(store), configuration = emptyConfiguration();
  configuration.methods.planning = planning(root);
  for (const stage of ['implementation', 'review'] as const) {
    const path = join(root, `${stage}.md`), content = `Synthetic explicitly selected ${stage} method.`; writeFileSync(path, content);
    configuration.methods[stage] = { id: `method-${stage}`, path, sha256: hash(content), logicalName: stage, version: '1.0.0', adapter: 'explicit-text-v1', dependencies: [] };
  }
  const methods = loadMethods(configuration); assert.deepEqual(methods.blockers, [], JSON.stringify(methods.summaries));
  const workspace = new WorkspaceService({ db: store.db, gitExecutable }); workspace.bindProject({ projectId: 'project', anchorPath: repo, formalTarget: 'main' });
  workflow.createProject({ id: 'project', name: 'Synthetic Staged Planning', rootPath: repo, methods: methods.methods });
  workflow.createDemand({ id: 'demand', projectId: 'project', title: 'Explain the requested source behavior before implementation' });
  const user = workflow.trustedUser('synthetic-owner'); workflow.execute({ type: 'start-planning', requestId: randomUUID(), demandId: 'demand' }, user);
  const knowledge = new KnowledgeService({ db: store.db, resolveStore: () => ImmutableObjectStore.open(repo, 'project') }), budget = new ModelBudgetLedger(store.db, () => {});
  const provider: ProviderConfiguration = { provider: 'openai', modelId: 'gpt-4.1-mini', destination: 'https://api.openai.com/v1/responses', credentialRef: 'env:SYNTHETIC_TEST_ONLY', data: [], contextPolicy: 'approved-run-derived-v1', allowedRoles: ['planning', 'boundary-review'], limits: { maxRequests: 100, maxTokens: 4_000_000, maxCostMicros: 4_000_000, currency: 'USD', expiresAt: '2099-01-01T00:00:00.000Z', meteringPolicy: 'pi-ai-cost-v1' } };
  configuration.provider = provider;
  const runtimeRoot = join(root, 'runtime'); mkdirSync(runtimeRoot);
  const binary = (name: string) => { const path = join(runtimeRoot, name), bytes = `SYNTHETIC ${name} binary`; writeFileSync(path, bytes); return { path, version: '24.0.0', sha256: hash(bytes) }; };
  const profile: LockedRuntimeProfile = { profileId: 'synthetic-staged-profile', osBuild: '0.0.0', arch: 'x64', node: binary('node.exe'), helper: binary('helper.exe'), worker: binary('worker.mjs'), pi: { ...binary('pi.json'), package: '@earendil-works/pi-coding-agent' }, policySha256: 'a'.repeat(64), evidence: [] };
  configuration.runtime = { profileId: profile.profileId, osBuild: profile.osBuild, arch: 'x64', node: { id: 'node', ...profile.node }, helper: { id: 'helper', ...profile.helper }, worker: { id: 'worker', ...profile.worker }, pi: { id: 'pi', ...profile.pi }, policySha256: profile.policySha256, evidence: { privateChannel: null, filesystem: null, processTree: null, network: null } };
  const drivers: SyntheticPlanningNativePort[] = [], calls: BoundedTransportRequest[] = [], scriptErrors: unknown[] = [];
  let script: Script = () => ({ text: 'Synthetic observed response.' }), turn = 0;
  const transport: BoundedProviderTransport = { mode: 'synthetic-no-network', provider: provider.provider, modelId: provider.modelId, destination: provider.destination, async send(request) { calls.push(request); try { return { ...await script(request, ++turn), usage: { tokens: 25, costMicros: 10, source: 'SYNTHETIC-NO-NETWORK' } }; } catch (error) { scriptErrors.push(error); throw error; } } };
  const createProduction = () => createSyntheticProductionServices({ store, workflow, workspace: () => workspace, knowledge, budget, configuration: () => configuration, stateDirectory: join(root, 'state') }, { profile, transport, createDriver: bootstrap => { const driver = new SyntheticPlanningNativePort(bootstrap); drivers.push(driver); return driver; } });
  let production = createProduction();
  production.captureMethods(); const binding = production.prepareDemand('demand', git(repo, 'rev-parse', 'HEAD'));
  let coordinator = new ExecutionCoordinator(store, workflow, production.driver, production.prerequisites); production.bindCoordinator(coordinator);
  store.db.exec('CREATE TABLE host_model_decisions(grant_id TEXT,demand_id TEXT,decision_id TEXT,runtime_scope TEXT)');
  const authorize = (id: string = randomUUID()) => {
    const data = production.requiredModelData('demand');
    budget.grant({ id, demandId: 'demand', decisionId: `decision-${id}`, provider: provider.provider, modelId: provider.modelId, destination: provider.destination, credentialRef: provider.credentialRef!, data, allowedRoles: ['planning', 'boundary-review'], contextPolicy: 'approved-run-derived-v1', ...provider.limits! });
    store.db.prepare('INSERT INTO host_model_decisions VALUES(?,?,?,?)').run(id, 'demand', `decision-${id}`, 'demand-worktree-private-runtime-v1');
    return id;
  };
  const ready = async (driver: SyntheticPlanningNativePort, launch: Launch) => {
    await driver.emit(launch, { type: 'worker.ready', sessionId: launch.init.sessionId });
    await driver.emit(launch, { type: 'model.request', sessionId: launch.init.sessionId, sequence: 1, purpose: 'prompt', context: { messages: [{ role: 'user', content: 'Synthetic bounded stage context', timestamp: 1 }] } });
    assert.equal(driver.replies.at(-1)?.ok, true, JSON.stringify(driver.replies.at(-1)));
  };
  const report = (driver: SyntheticPlanningNativePort, launch: Launch, body: object, requestId = randomUUID()) => driver.emit(launch, { type: 'worker.report', report: { ...body, requestId, demandId: 'demand', runId: launch.init.domainRunId, generation: launch.init.domainGeneration } });
  const settled = (driver: SyntheticPlanningNativePort, launch: Launch) => driver.emit(launch, { type: 'worker.settled', sessionId: launch.init.sessionId, aborted: false });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, repo, store, workflow, workspace, knowledge, budget, user, profile, configuration, get production() { return production; }, get coordinator() { return coordinator; }, binding, drivers, calls, scriptErrors, authorize, ready, report, settled,
    restart() { production = createProduction(); coordinator = new ExecutionCoordinator(store, workflow, production.driver, production.prerequisites); production.bindCoordinator(coordinator); },
    setScript(value: Script) { script = value; turn = 0; scriptErrors.length = 0; } };
}
