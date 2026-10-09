import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { commandUnavailable, demandStatus, errorMessage, makeCommand, MESSAGE_STATES, needsAttention, primaryAction, reconcileSnapshot } from '../src/desktop/renderer/model.ts';
import type { Demand, ViewState } from '../src/desktop/renderer/types.ts';

const demand = (patch: Partial<Demand> = {}): Demand => ({ id: 'synthetic-demand', projectId: 'synthetic-project', title: 'Synthetic demand', description: 'Fixture only', version: 7, phase: 'idea', control: 'active', blockers: [], activities: [], messages: [], ...patch });
const state = (patch: Partial<ViewState> = {}): ViewState => ({ sequence: 1, projects: [{ id: 'synthetic-project', name: 'Synthetic project', rootPath: '/synthetic-only' }], demands: [demand()], runtime: { platform: 'test', node: 'test', executionEnabled: false, blockers: ['No real execution fixture'], connection: 'connected' }, ...patch });

test('renderer: phase alone never claims actual running', () => {
  for (const phase of ['planning', 'implementing', 'checking', 'reviewing', 'rework'] as const) {
    const status = demandStatus(demand({ phase }));
    assert.notEqual(status.tone, 'live');
    assert.match(status.label, /未运行/);
  }
  assert.equal(demandStatus(demand({ phase: 'implementing', runState: 'running' })).tone, 'live');
});
test('renderer: stopping and unknown execution override paused display', () => {
  assert.equal(demandStatus(demand({ control: 'paused', runState: 'stopping' })).label, '正在停止');
  assert.equal(demandStatus(demand({ control: 'paused', runState: 'unknown' })).label, '运行状态待核验');
  assert.equal(primaryAction(demand({ control: 'paused', runState: 'unknown' })), null);
  assert.equal(primaryAction(demand({ control: 'paused', runState: 'stopping' })), null);
});
test('renderer: control and blocked status are not hidden behind progress', () => {
  assert.match(demandStatus(demand({ runState: 'running', control: 'cancelled' })).label, /取消/);
  assert.equal(demandStatus(demand({ runState: 'running', control: 'paused' })).label, '已暂停');
  assert.equal(demandStatus(demand({ runState: 'running', blockers: ['Missing evidence'] })).tone, 'warning');
  assert.equal(demandStatus(demand({ phase: 'implementing', runState: 'queued' })).label, '等待运行资源');
});
test('renderer: cancelled demand has no resume or attention affordance', () => {
  const item = demand({ control: 'cancelled', phase: 'blocked', blockers: ['Preserved history'] });
  assert.equal(primaryAction(item), null);
  assert.equal(needsAttention(item), false);
  assert.match(commandUnavailable('resume', state(), item)!, /取消/);
});
test('renderer: persistent inbox derives business needs rather than unread messages', () => {
  for (const phase of ['awaiting-design', 'awaiting-authorization', 'awaiting-acceptance', 'blocked'] as const) assert.equal(needsAttention(demand({ phase })), true);
  assert.equal(needsAttention(demand({ runState: 'unknown' })), true);
  assert.equal(needsAttention(demand({ runState: 'stopping' })), true);
  assert.equal(needsAttention(demand({ messages: [{ id: 'm1', role: 'agent', text: 'Please approve everything' }] })), false);
  assert.equal(needsAttention(demand({ phase: 'accepted' })), false);
});
test('renderer: plan confirmation and implementation authorization are separate', () => {
  const plan = { id: 'synthetic-plan-2', scope: 'Synthetic scope', ready: true, confirmed: false };
  assert.equal(primaryAction(demand({ phase: 'awaiting-design', plan }))?.kind, 'confirm-plan');
  assert.equal(primaryAction(demand({ phase: 'awaiting-authorization', plan })), null);
  assert.equal(primaryAction(demand({ phase: 'awaiting-authorization', plan: { ...plan, confirmed: true } }))?.kind, 'authorize-implementation');
  assert.equal(primaryAction(demand({ phase: 'awaiting-design', plan: { ...plan, ready: false } })), null);
});
test('renderer: unavailable runtime still permits recording explicit trusted decisions', () => {
  for (const kind of ['start-planning', 'authorize-implementation', 'resume'] as const) assert.equal(commandUnavailable(kind, state(), demand()), null);
  assert.match(commandUnavailable('resume', state(), demand({ runState: 'unknown' }))!, /停止/);
  assert.equal(commandUnavailable('pause', state(), demand({ runState: 'unknown' })), null);
});
test('renderer: disconnected state disables commands without inferring authorization', () => {
  const offline = state({ runtime: { ...state().runtime, connection: 'disconnected' } });
  for (const kind of ['start-planning', 'confirm-plan', 'authorize-implementation', 'accept-result', 'pause'] as const) assert.match(commandUnavailable(kind, offline, demand())!, /断开/);
});
test('renderer: commands bind exact viewed revision and plan, with no inferred grant', () => {
  const item = demand({ plan: { id: 'synthetic-plan-3', scope: '', ready: true, confirmed: false } });
  const command = makeCommand('confirm-plan', item, 'synthetic-request');
  assert.deepEqual(command, { kind: 'confirm-plan', demandId: item.id, expectedVersion: 7, planId: 'synthetic-plan-3', requestId: 'synthetic-request' });
  assert.equal('confirmDesign' in command, false);
  assert.equal('localCommit' in command, false);
  assert.throws(() => makeCommand('confirm-plan', demand(), 'synthetic-request'), /方案/);
});
test('renderer: result acceptance binds stable object; return requires meaningful text', () => {
  const result = { id: 'synthetic-result-2', contentId: 'synthetic-content-8', notes: '', createdAt: '2026-10-08T00:00:00Z' };
  const item = demand({ phase: 'awaiting-acceptance', result });
  assert.equal(primaryAction(item)?.kind, 'accept-result');
  assert.equal(makeCommand('accept-result', item, 'synthetic-request').resultId, result.id);
  assert.equal(makeCommand('return-result', item, 'synthetic-request', '  Fix date boundary  ').text, 'Fix date boundary');
  assert.throws(() => makeCommand('return-result', item, 'synthetic-request', '  '), /说明/);
  assert.throws(() => makeCommand('accept-result', demand(), 'synthetic-request'), /稳定成果/);
  assert.equal(primaryAction(demand({ phase: 'awaiting-acceptance' })), null);
});
test('renderer: an old click object cannot silently reference the newer result', () => {
  const old = demand({ version: 4, result: { id: 'synthetic-old', contentId: 'old-content', notes: '', createdAt: '' } });
  const next = demand({ version: 5, result: { id: 'synthetic-new', contentId: 'new-content', notes: '', createdAt: '' } });
  const command = makeCommand('accept-result', old, 'synthetic-request');
  assert.equal(command.expectedVersion, 4);
  assert.equal(command.resultId, 'synthetic-old');
  assert.notEqual(command.resultId, next.result?.id);
});
test('renderer: whole-state ordering preserves new projects and demands after stale response', () => {
  const current = state({ sequence: 5, projects: [...state().projects, { id: 'new-project', name: 'New synthetic', rootPath: '/synthetic-new' }], demands: [demand(), demand({ id: 'new-demand', version: 1 })] });
  assert.strictEqual(reconcileSnapshot(current, state({ sequence: 4 })), current);
  assert.equal(reconcileSnapshot(current, state({ sequence: 4 })).demands.length, 2);
  assert.equal(reconcileSnapshot(current, state({ sequence: 4 })).projects.length, 2);
});
test('renderer: runtime-only changes are ordered despite identical domain version', () => {
  const stopping = state({ sequence: 12, demands: [demand({ runState: 'stopping' })] });
  const stale = state({ sequence: 11, demands: [demand({ runState: 'running' })] });
  assert.equal(reconcileSnapshot(stopping, stale).demands[0].runState, 'stopping');
  const stopped = state({ sequence: 13, demands: [demand({ runState: 'stopped' })] });
  assert.strictEqual(reconcileSnapshot(stopping, stopped), stopped);
  assert.strictEqual(reconcileSnapshot(null, stopped), stopped);
});
test('renderer: saved, delivered and applied remain distinct factual states', () => {
  assert.equal(MESSAGE_STATES.saved.label, '已保存');
  assert.match(MESSAGE_STATES.saved.explanation, /尚未确认投递/);
  assert.equal(MESSAGE_STATES.delivered.label, '已投递');
  assert.match(MESSAGE_STATES.delivered.explanation, /尚未确认要求已落实/);
  assert.equal(MESSAGE_STATES.applied.label, '已落实');
});
test('renderer: stale conflicts ask for reviewed retry rather than silent retargeting', () => {
  assert.match(errorMessage(new Error('STALE_REVISION expected 4 got 5')), /版本已变化/);
  assert.match(errorMessage('对象已变'), /重新操作/);
  assert.equal(errorMessage(new Error('Host disconnected')), 'Host disconnected');
});
test('renderer: production entry cannot silently fall back to preview or execute agent HTML', () => {
  const source = readFileSync(new URL('../src/desktop/renderer/App.tsx', import.meta.url), 'utf8');
  const production = readFileSync(new URL('../src/desktop/renderer/main.tsx', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../src/desktop/renderer/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|window\.open|<iframe|<a\s[^>]*href=/);
  assert.match(production, /if \(!window\.workbench\) throw new Error/);
  assert.doesNotMatch(production, /syntheticPreview|previewBridge|preview\.tsx/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /script-src 'self'/);
});

// These are display-only tests. Host validation and persistence have independent tests.
import { contextPolicyDisclosure, formatCostMicros, LOCAL_RESOURCE_SCOPE, makeModelAuthorization, modelAuthorizationChanged, modelAuthorizationUnavailable, modelPreparationUnavailable, preparedModelReview } from '../src/desktop/renderer/configuration-model.ts';
import type { ConfigurationSummary } from '../src/desktop/renderer/types.ts';
const configuration = (): ConfigurationSummary => ({
  schemaVersion: 1, revision: 2, configurationDigest: 'a'.repeat(64), sourceStatus: 'configured', executionEnabled: false,
  configuration: { schemaVersion: 1, revision: 2, runtime: null, methods: { planning: null, implementation: null, review: null }, provider: { provider: 'synthetic-provider', modelId: 'synthetic-model', destination: 'https://synthetic.example.invalid/v1/responses', credentialRef: 'host:synthetic-only', contextPolicy: 'exact-materials-only', allowedRoles: ['planning'], data: [{ id: 'synthetic-brief', sha256: 'b'.repeat(64) }], limits: { maxRequests: 4, maxTokens: 8000, maxCostMicros: 1250001, currency: 'USD', expiresAt: '2099-01-01T00:00:00.000Z', meteringPolicy: 'synthetic-exact' } } },
  runtime: { status: 'missing', blockers: ['Synthetic native fixture unavailable'] }, methods: [], planningMethodMissing: true, provider: { status: 'configured-unapproved', blockers: [] }, blockers: ['No real execution'],
});
test('renderer: model approval requires a selected demand and Host-validated finite configuration', () => {
  assert.match(modelAuthorizationUnavailable(state(), demand())!, /导入/);
  assert.match(modelAuthorizationUnavailable(state({ configuration: configuration() }))!, /选择/);
  const loaded = state({ configuration: configuration() });
  assert.equal(modelAuthorizationUnavailable(loaded, demand()), null);
  assert.equal(loaded.runtime.executionEnabled, false);
  assert.match(modelAuthorizationUnavailable(loaded, demand({ control: 'cancelled' }))!, /取消/);
  assert.match(modelAuthorizationUnavailable({ ...loaded, runtime: { ...loaded.runtime, connection: 'disconnected' } }, demand())!, /断开/);
  assert.match(modelAuthorizationUnavailable(state({ configuration: { ...configuration(), provider: { status: 'incomplete', blockers: ['No finite policy'] } } }), demand())!, /不完整/);
});
test('renderer: missing, non-finite, expired or incomplete model scopes never enable approval', () => {
  for (const value of [0, -1, Infinity, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    for (const field of ['maxRequests', 'maxTokens', 'maxCostMicros'] as const) {
      const config = configuration(); config.configuration.provider!.limits![field] = value;
      assert.match(modelAuthorizationUnavailable(state({ configuration: config }), demand())!, /有限/);
    }
  }
  const expires = configuration(); expires.configuration.provider!.limits!.expiresAt = '2000-01-01T00:00:00.000Z';
  assert.match(modelAuthorizationUnavailable(state({ configuration: expires }), demand())!, /到期/);
  const noData = configuration(); noData.configuration.provider!.data = [];
  assert.match(modelAuthorizationUnavailable(state({ configuration: noData }), demand())!, /资料/);
  const changedData = configuration(); changedData.configuration.provider!.data[0].sha256 = 'not-a-digest';
  assert.match(modelAuthorizationUnavailable(state({ configuration: changedData }), demand())!, /资料/);
  const noCredential = configuration(); noCredential.configuration.provider!.credentialRef = null;
  assert.match(modelAuthorizationUnavailable(state({ configuration: noCredential }), demand())!, /凭据/);
  const noLimits = configuration(); noLimits.configuration.provider!.limits = null;
  assert.match(modelAuthorizationUnavailable(state({ configuration: noLimits }), demand())!, /有限/);
  const destination = configuration(); destination.configuration.provider!.destination = 'https://synthetic.example.invalid/v1?credential=not-secret';
  assert.match(modelAuthorizationUnavailable(state({ configuration: destination }), demand())!, /HTTPS/);
});
test('renderer: model authorization binds captured demand revision and exact configuration digest', () => {
  const reviewed = configuration(), target = demand();
  const command = makeModelAuthorization(target, reviewed, 'synthetic-model-decision');
  assert.deepEqual(command, { demandId: target.id, expectedVersion: 7, requestId: 'synthetic-model-decision', configurationDigest: 'a'.repeat(64), resourceScope: 'demand-worktree-private-runtime-v1' });
  assert.equal(modelAuthorizationChanged(state({ configuration: reviewed }), target, reviewed), false);
  assert.equal(modelAuthorizationChanged(state({ configuration: { ...reviewed, configurationDigest: 'c'.repeat(64) } }), target, reviewed), true);
  assert.equal(modelAuthorizationChanged(state({ configuration: reviewed, demands: [demand({ version: 8 })] }), target, reviewed), true);
  assert.equal(modelAuthorizationChanged(state({ configuration: reviewed, demands: [] }), target, reviewed), true);
  assert.equal(modelAuthorizationChanged(state({ configuration: reviewed, demands: [demand({ workspacePath: '/synthetic/new-path' })] }), target, reviewed), true);
  assert.equal(modelAuthorizationChanged(state(), target, reviewed), true);
  assert.equal('provider' in command, false, 'Renderer cannot inject replacement provider or limits into the reviewed decision');
});
test('renderer: cost disclosure preserves every micro-unit exactly', () => {
  assert.equal(formatCostMicros(1, 'USD'), 'USD 0.000001');
  assert.equal(formatCostMicros(1250001, 'USD'), 'USD 1.250001');
  assert.equal(formatCostMicros(Number.MAX_SAFE_INTEGER, 'USD'), 'USD 9007199254.740991');
  assert.match(formatCostMicros(Infinity, 'USD'), /未配置/);
});
test('renderer: configuration is type-only across Host boundary and preview never grants model access', () => {
  const model = readFileSync(new URL('../src/desktop/renderer/configuration-model.ts', import.meta.url), 'utf8');
  const component = readFileSync(new URL('../src/desktop/renderer/Configuration.tsx', import.meta.url), 'utf8');
  const preview = readFileSync(new URL('../src/desktop/renderer/preview.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(`${model}\n${component}`, /from ['"]node:|dangerouslySetInnerHTML|fetch\(/);
  assert.match(component, /type="checkbox"/);
  assert.match(preview, /合成配置仅用于审阅 UI，不会创建真实模型授权/);
});

test('renderer: context policy must be explicit and both scopes are disclosed distinctly', () => {
  const missing = configuration(); missing.configuration.provider!.contextPolicy = null;
  assert.match(modelAuthorizationUnavailable(state({ configuration: missing }), demand())!, /上下文范围/);
  assert.match(contextPolicyDisclosure(null).title, /尚未选择/);
  assert.match(contextPolicyDisclosure('exact-materials-only').detail, /生成的对话、工具结果及其他新增资料不在本次授权内/);
  const derived = configuration(); derived.configuration.provider!.contextPolicy = 'approved-run-derived-v1';
  assert.equal(modelAuthorizationUnavailable(state({ configuration: derived }), demand()), null);
  assert.match(contextPolicyDisclosure('approved-run-derived-v1').detail, /同一已核验隔离运行内生成的对话与工具结果/);
  assert.match(contextPolicyDisclosure('approved-run-derived-v1').detail, /不得据此读取任意新来源、其他项目或其他需求/);
});
test('renderer: decorative shortcut does not alter the new-demand accessible name', () => {
  const source = readFileSync(new URL('../src/desktop/renderer/App.tsx', import.meta.url), 'utf8');
  assert.match(source, /className="new-demand" aria-label=\{state\.projects\.length \? '新建需求' : '接入项目'\}/);
  assert.match(source, /className="shortcut" aria-hidden="true"/);
});

test('renderer: local resource disclosure is demand-specific and never broad filesystem access', () => {
  assert.equal(LOCAL_RESOURCE_SCOPE, 'demand-worktree-private-runtime-v1');
  const source = readFileSync(new URL('../src/desktop/renderer/Configuration.tsx', import.meta.url), 'utf8');
  assert.match(source, /demand\.workspacePath \?\?/);
  for (const text of ['value={LOCAL_RESOURCE_SCOPE}', '规划 / 独立 Review', '实施阶段仍需另外明确授权', '已锁定版本和摘要', '私有 scratch / session 目录', '共享 .git 管理目录、Host 数据库、其他需求', '不包含全磁盘访问或通用系统设置权限', '尚未准备工作区时不执行', '模型额度和此需求的本地资源范围']) assert.ok(source.includes(text), text);
});

test('renderer: Host preparation can populate data without allowing an empty final grant', () => {
  const proposed = configuration();
  proposed.configuration.provider!.data = [];
  proposed.provider = { status: 'incomplete', blockers: ['Exact data list not prepared'] };
  assert.equal(modelPreparationUnavailable(state({ configuration: proposed }), demand()), null);
  assert.match(modelAuthorizationUnavailable(state({ configuration: proposed }), demand())!, /不完整/);
  proposed.configuration.provider!.limits = null;
  assert.match(modelPreparationUnavailable(state({ configuration: proposed }), demand())!, /有限/);
  proposed.configuration.provider!.contextPolicy = null;
  assert.match(modelPreparationUnavailable(state({ configuration: proposed }), demand())!, /上下文范围/);
});
test('renderer: review captures prepared revision, scope and digest instead of imported values', () => {
  const preparedConfiguration = configuration(); preparedConfiguration.configurationDigest = 'd'.repeat(64);
  preparedConfiguration.configuration.provider!.data = [{ id: 'prepared-exact-source', sha256: 'e'.repeat(64) }];
  const prepared = state({ sequence: 10, configuration: preparedConfiguration, demands: [demand({ version: 8, workspacePath: '/prepared/worktree' })] });
  const review = preparedModelReview(prepared, prepared, 'synthetic-demand');
  const command = makeModelAuthorization(review.demand, review.configuration, 'fresh-request');
  assert.equal(command.expectedVersion, 8);
  assert.equal(command.configurationDigest, 'd'.repeat(64));
  assert.equal(review.demand.workspacePath, '/prepared/worktree');
  assert.equal(review.configuration.configuration.provider!.data[0].id, 'prepared-exact-source');
  preparedConfiguration.configuration.provider!.data[0].id = 'later-mutated-input';
  assert.equal(review.configuration.configuration.provider!.data[0].id, 'prepared-exact-source');
});
test('renderer: stale or incomplete preparation cannot open an apparently ready consent', () => {
  const prepared = state({ configuration: configuration() });
  assert.throws(() => preparedModelReview(state({ configuration: configuration(), demands: [demand({ version: 8 })] }), prepared, 'synthetic-demand'), /已变化/);
  assert.throws(() => preparedModelReview(state({ configuration: { ...configuration(), configurationDigest: 'f'.repeat(64) } }), prepared, 'synthetic-demand'), /已变化/);
  assert.throws(() => preparedModelReview(prepared, state(), 'synthetic-demand'), /完整/);
  assert.throws(() => preparedModelReview(prepared, prepared, 'missing-demand'), /完整/);
  const disconnected = { ...prepared, runtime: { ...prepared.runtime, connection: 'disconnected' as const } };
  assert.throws(() => preparedModelReview(disconnected, prepared, 'synthetic-demand'), /断开/);
});
