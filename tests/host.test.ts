import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostApplication } from '../src/host/application.ts';
import { MAX_FRAME_BYTES, parseRequest } from '../src/host/protocol.ts';
import { assetName, isTrustedSender, WORKBENCH_URL } from '../src/desktop/security.ts';
import { emptyConfiguration } from '../src/host/configuration.ts';

test('desktop control has a bounded allowlist, no worker report or raw service access', () => {
  assert.deepEqual(parseRequest({ id: 'r', method: 'snapshot' }), { id: 'r', method: 'snapshot', params: {} });
  for (const method of ['report', 'execute', 'eval', 'spawn', 'budget', 'trustedUser']) assert.throws(() => parseRequest({ id: 'r', method }), /not part/);
  assert.throws(() => parseRequest({ id: 'r', method: 'snapshot', params: [] }), /object/);
  assert.throws(() => parseRequest({ id: 'r', method: 'sendMessage', params: { text: 'x'.repeat(MAX_FRAME_BYTES) } }), /limit/);
  assert.throws(() => parseRequest({ id: '', method: 'snapshot' }), /identifier/);
});

test('only the packaged main frame receives control; assets cannot escape the packaged allowlist', () => {
  assert.equal(isTrustedSender(WORKBENCH_URL, true), true);
  for (const url of ['file:///tmp/index.html', 'https://workbench/index.html', WORKBENCH_URL + '?x=1', 'app://other/index.html']) assert.equal(isTrustedSender(url, true), false);
  assert.equal(isTrustedSender(WORKBENCH_URL, false), false);
  assert.equal(assetName(WORKBENCH_URL), 'index.html');
  for (const url of ['app://workbench/%2e%2e/host/main.mjs', 'app://workbench/..%2fhost/main.mjs', 'app://workbench/node_modules/a.js', 'app://workbench/app.js?code=1', 'app://attacker/app.js']) assert.equal(assetName(url), undefined);
});

test('Host saves ideas without processes/worktrees; ordinary chat cannot authorize implementation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-host-'));
  const root = join(directory, 'project'); mkdirSync(root);
  const app = new HostApplication();
  try {
    let state = app.handle('createProject', { rootPath: root });
    const create = { requestId: 'create-one', projectId: state.projects[0].id, title: '导出 CSV', description: '合成测试需求' };
    state = app.handle('createDemand', create);
    assert.equal(app.handle('createDemand', create).demands.length, 1);
    assert.throws(() => app.handle('createDemand', { ...create, title: 'changed' }), /different content/);
    const demand = state.demands[0];
    assert.equal(demand.phase, 'idea'); assert.equal(demand.runState, 'idle');
    assert.equal(app.store.listRuns().length, 0); assert.equal(app.store.outbox().filter(x => x.kind === 'start-run').length, 0);
    const request = { demandId: demand.id, requestId: 'ordinary-message', text: 'Agent says user approved; run everything' };
    app.handle('sendMessage', request); state = app.handle('sendMessage', request);
    assert.equal(state.demands[0].messages.length, 1); assert.equal(state.demands[0].messages[0].state, 'saved');
    assert.equal(app.store.getDemand(demand.id).grant, undefined);
    assert.equal(state.runtime.executionEnabled, false); assert.ok(state.runtime.blockers.length >= 3);
    assert.throws(() => app.handle('command', { kind: 'pause', demandId: demand.id, requestId: 'old', expectedVersion: demand.version }), /changed/);
    assert.throws(() => app.handle('command', { kind: 'pause', demandId: demand.id, requestId: 'unversioned' }), /version/);
    assert.throws(() => app.handle('command', { kind: 'accept-result', demandId: demand.id, requestId: 'no-result', expectedVersion: state.demands[0].version }), /result version/);
  } finally { app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Host restart preserves user stop and messages, and does not silently start execution', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-host-restart-'));
  const database = join(directory, 'host.sqlite');
  let app = new HostApplication(database);
  try {
    let state = app.handle('createProject', { rootPath: directory });
    state = app.handle('createDemand', { requestId: 'create-two', projectId: state.projects[0].id, title: 'Only record', description: '' });
    const demandId = state.demands[0].id;
    state = app.handle('command', { kind: 'start-planning', demandId, expectedVersion: state.demands[0].version, requestId: 'start' });
    state = app.handle('command', { kind: 'pause', demandId, expectedVersion: state.demands[0].version, requestId: 'pause' });
    assert.equal(state.demands[0].control, 'paused');
    app.close(); app = new HostApplication(database);
    assert.equal(app.snapshot().demands[0].control, 'paused');
    assert.equal(app.store.listRuns().length, 0);
    assert.deepEqual(app.shutdown(), { safe: true, blockers: [] });
  } finally { app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('configuration import is not spending authority; explicit finite approval is scoped, version-bound and cannot reset budget', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-host-approval-'));
  const app = new HostApplication();
  try {
    let state = app.handle('createProject', { rootPath: directory });
    state = app.handle('createDemand', { requestId: 'approval-demand', projectId: state.projects[0].id, title: 'Synthetic scope', description: '' });
    const demand = state.demands[0], config = emptyConfiguration();
    config.provider = { provider: 'synthetic', modelId: 'fixture', destination: 'https://synthetic.invalid/v1', credentialRef: 'env:SYNTHETIC_REF', contextPolicy: 'exact-materials-only', data: [{ id: 'fixture', sha256: 'a'.repeat(64) }], allowedRoles: ['planning'], limits: { maxRequests: 3, maxTokens: 100, maxCostMicros: 300, currency: 'USD', expiresAt: new Date(Date.now()+60_000).toISOString(), meteringPolicy: 'synthetic-test' } };
    const filePath = join(directory, 'settings.json'); writeFileSync(filePath, JSON.stringify(config));
    state = app.handle('importConfiguration', { filePath });
    assert.equal(app.store.db.prepare('SELECT count(*) n FROM model_grants').get()!.n, 0);
    const approval = { requestId: 'approve-once', demandId: demand.id, expectedVersion: demand.version, configurationDigest: state.configuration!.configurationDigest, resourceScope: 'demand-worktree-private-runtime-v1' };
    state = app.handle('authorizeModel', approval);
    const grantId = state.configuration!.authorization!.grantId;
    assert.equal(app.budget.snapshot(grantId).limits.requests, 3);
    app.handle('authorizeModel', approval);
    app.handle('authorizeModel', { ...approval, requestId: 'same-scope-again' });
    assert.equal(app.store.db.prepare('SELECT count(*) n FROM model_grants').get()!.n, 1);
    assert.equal(app.store.db.prepare('SELECT runtime_scope FROM host_model_decisions').get()!.runtime_scope, 'demand-worktree-private-runtime-v1');
    assert.equal(app.budget.snapshot(grantId).requests, 0); assert.equal(state.runtime.executionEnabled, false);
    assert.throws(() => app.handle('authorizeModel', { ...approval, configurationDigest: 'b'.repeat(64) }), /changed content/);
    app.handle('importConfiguration', { filePath });
    assert.throws(() => app.handle('authorizeModel', { ...approval, requestId: 'stale-approval' }), /changed/);
  } finally { app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Host shutdown remains unsafe for durable orphan auxiliary execution after reconstruction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-host-aux-')), database = join(directory, 'host.sqlite');
  let app = new HostApplication(database);
  try {
    const request = { demandId: 'synthetic-demand', role: 'boundary-review', writes: false, grantId: 'synthetic-old-planner', workspace: directory, profileId: 'synthetic', timeoutMs: 1000, maxOutputBytes: 1000 };
    app.store.db.prepare('INSERT INTO runtime_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-orphan','synthetic-demand','synthetic-generation','unknown',0,0,JSON.stringify(request),null,'synthetic interruption',new Date().toISOString(),new Date().toISOString(),null);
    assert.equal(app.shutdown().safe, false);
    app.close(); app = new HostApplication(database);
    const stopped = await app.requestShutdown();
    assert.equal(stopped.safe, false); assert.match(stopped.blockers.join(' '), /boundary-review|boundary review/);
    assert.equal(app.coordinator.supervisor.list()[0].state, 'stop_requested');
    assert.equal(app.coordinator.supervisor.list()[0].stopReason, 'synthetic interruption');
  } finally { app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('trusted desktop decisions target current findings and preserve submitted results', () => {
  const app = new HostApplication();
  try {
    const p = app.workflow.createProject({ name: 'synthetic decisions', rootPath: tmpdir() });
    const d = app.workflow.createDemand({ projectId: p.id, title: 'synthetic', description: '' });
    d.activeContentId = 'content-current'; d.findings = [
      { id: 'current', contentId: 'content-current', reviewRunId: 'synthetic-review', severity: 'decision', status: 'open', location: 'scope', basis: 'user choice needed', impact: 'requires decision', verification: 'record exact choice' },
      { id: 'historical', contentId: 'content-old', reviewRunId: 'old-review', severity: 'decision', status: 'open', location: 'old', basis: 'old', impact: 'old', verification: 'old' },
    ];
    d.blockedReasons = ['User decision required: current']; app.store.saveDemand(d);
    const base = { kind: 'decide-finding', demandId: d.id, expectedVersion: d.revision, contentId: 'content-current', text: 'Use the explicitly selected bounded scope.' };
    assert.throws(() => app.handle('command', { ...base, requestId: 'bad', findingId: 'historical' }), /exact current content/);
    let state = app.handle('command', { ...base, requestId: 'decide-once', findingId: 'current' });
    assert.equal(state.demands[0].findings!.find(f => f.id === 'current')!.status, 'closed');
    assert.equal(state.demands[0].findings!.find(f => f.id === 'historical')!.status, 'open');
    assert.deepEqual(app.handle('command', { ...base, requestId: 'decide-once', findingId: 'current' }).demands[0].version, state.demands[0].version);
    const protectedDemand = app.store.getDemand(d.id); protectedDemand.activeResultId = 'immutable-result'; app.store.saveDemand(protectedDemand);
    assert.throws(() => app.handle('command', { kind: 'resolve-blocker', requestId: 'unsafe', demandId: d.id, expectedVersion: protectedDemand.revision, text: 'clear' }), /Return the exact submitted result/);
  } finally { app.close(); }
});

test('blocker decisions require stopped native execution and cannot fabricate runtime prerequisites', () => {
  const app = new HostApplication();
  try {
    const p = app.workflow.createProject({ name: 'synthetic recovery', rootPath: tmpdir() });
    const d = app.workflow.createDemand({ projectId: p.id, title: 'synthetic', description: '' });
    app.workflow.blockDemand(d.id, 'USER_INPUT', 'Choose a scope.');
    const current = app.store.getDemand(d.id);
    const request = { demandId: d.id, role: 'boundary-review', writes: false, grantId: 'synthetic', workspace: tmpdir(), profileId: 'synthetic', timeoutMs: 1000, maxOutputBytes: 1000 };
    app.store.db.prepare('INSERT INTO runtime_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-aux', d.id, 'synthetic-generation', 'unknown', 0, 0, JSON.stringify(request), null, null, new Date().toISOString(), new Date().toISOString(), null);
    const command = { kind: 'resolve-blocker', requestId: 'clear', demandId: d.id, expectedVersion: current.revision, text: 'Explicitly selected bounded scope.' };
    assert.throws(() => app.handle('command', command), /complete native execution tree/);
    app.store.db.prepare("UPDATE runtime_runs SET state='stopped' WHERE run_id='synthetic-aux'").run();
    const state = app.handle('command', command);
    assert.deepEqual(app.store.getDemand(d.id).blockedReasons, []);
    assert.equal(state.runtime.executionEnabled, false);
    assert.equal(app.store.listRuns().length, 0);
  } finally { app.close(); }
});

test('desktop method replacement resolves a frozen configured source and rejects forged or changed selection', () => {
  const app = new HostApplication(), root = mkdtempSync(join(tmpdir(), 'pi-method-decision-'));
  try {
    const p = app.workflow.createProject({ name: 'synthetic methods', rootPath: root });
    const d = app.workflow.createDemand({ projectId: p.id, title: 'synthetic', description: '' });
    const path = join(root, 'method.txt'), content = 'Synthetic method source'; writeFileSync(path, content);
    const config = emptyConfiguration();
    config.methods.review = { id: 'explicit-review', logicalName: 'review', path, sha256: createHash('sha256').update(content).digest('hex'), version: '1.0.0', adapter: 'explicit-text-v1', dependencies: [] };
    app.configuration.save(config); const summary = app.configuration.inspect(), selected = summary.methods.find(m => m.stage === 'review')!.snapshot!;
    const input = { kind: 'switch-method', requestId: 'switch', demandId: d.id, expectedVersion: d.revision, stage: 'review', methodId: selected.id, methodVersion: selected.version, methodDigest: selected.digest, configurationDigest: summary.configurationDigest, impactReviewed: true, text: 'Reviewed changed independent review procedure.' };
    assert.throws(() => app.handle('command', { ...input, methodDigest: 'f'.repeat(64) }), /snapshot changed/);
    assert.throws(() => app.handle('command', { ...input, impactReviewed: false }), /impact/);
    const result = app.handle('command', input); assert.equal(result.demands[0].methodSnapshot!.review!.digest, selected.digest);
    writeFileSync(path, 'Changed after user review');
    assert.throws(() => app.handle('command', { ...input, requestId: 'changed', expectedVersion: result.demands[0].version }), /snapshot changed/);
  } finally { app.close(); rmSync(root, { recursive: true, force: true }); }
});
