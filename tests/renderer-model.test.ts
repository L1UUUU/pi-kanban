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

import { currentDecisions, decisionUnavailable, makeDecisionCommand } from '../src/desktop/renderer/decision-model.ts';
import type { Finding } from '../src/domain/types.ts';
const decisionFinding = (patch: Partial<Finding> = {}): Finding => ({ id: 'synthetic-f1', contentId: 'synthetic-c1', reviewRunId: 'synthetic-r1', severity: 'decision', status: 'open', location: 'synthetic://location', basis: 'Synthetic choice', impact: 'Synthetic impact', verification: 'Synthetic verification', ...patch });
test('renderer: actionable decisions bind exact plan, finding and content without inferred authority', () => {
  const target = demand({ runState: 'stopped', activeContentId: 'synthetic-c1', findings: [decisionFinding()], plan: { id: 'synthetic-p1', scope: '', ready: false, confirmed: false, unresolvedQuestions: ['Synthetic question'] } });
  const revise = makeDecisionCommand({ kind: 'revise-plan', demand: target }, { reason: '  Synthetic answer  ' }, 'request');
  assert.deepEqual(revise, { kind: 'revise-plan', demandId: target.id, expectedVersion: 7, requestId: 'request', text: 'Synthetic answer', previousPlanId: 'synthetic-p1' });
  const decide = makeDecisionCommand({ kind: 'decide-finding', demand: target, findingId: 'synthetic-f1', contentId: 'synthetic-c1' }, { reason: 'Keep specified behavior' }, 'request');
  assert.equal(decide.findingId, 'synthetic-f1'); assert.equal(decide.contentId, 'synthetic-c1');
  assert.equal('confirmDesign' in decide, false); assert.equal('localCommit' in revise, false);
  assert.throws(() => makeDecisionCommand({ kind: 'revise-plan', demand: target }, { reason: ' ' }, 'request'), /填写/);
  assert.throws(() => makeCommand('revise-plan', target, 'request'), /专用表单/);
});
test('renderer: historical, closed and blocking findings never gain user-decision controls', () => {
  const target = demand({ activeContentId: 'synthetic-c1', findings: [decisionFinding(), decisionFinding({ id: 'old', contentId: 'old' }), decisionFinding({ id: 'closed', status: 'closed' }), decisionFinding({ id: 'blocking', severity: 'blocking' })] });
  assert.deepEqual(currentDecisions(target).map(finding => finding.id), ['synthetic-f1']);
  for (const findingId of ['old', 'closed', 'blocking']) assert.throws(() => makeDecisionCommand({ kind: 'decide-finding', demand: target, findingId, contentId: 'synthetic-c1' }, { reason: 'Synthetic reason' }, 'request'), /未关闭决定项/);
});
test('renderer: blocker resolution cannot substitute for missing configuration or unresolved decisions', () => {
  const target = demand({ runState: 'stopped', blockers: ['Runtime diagnostic'] });
  assert.match(decisionUnavailable({ kind: 'resolve-blocker', demand: target }, state({ demands: [target] }))!, /没有可解除/);
  const decisions = { ...target, workflowBlockers: ['User decision required'], activeContentId: 'synthetic-c1', findings: [decisionFinding()] };
  assert.match(decisionUnavailable({ kind: 'resolve-blocker', demand: decisions }, state({ demands: [decisions] }))!, /逐项记录/);
  const questions = { ...target, workflowBlockers: ['Question'], plan: { id: 'p1', scope: '', ready: false, confirmed: false, unresolvedQuestions: ['Question'] } };
  assert.match(decisionUnavailable({ kind: 'resolve-blocker', demand: questions }, state({ demands: [questions] }))!, /重新规划/);
  const ready = { ...target, workflowBlockers: ['Synthetic environment repaired'] };
  assert.equal(decisionUnavailable({ kind: 'resolve-blocker', demand: ready }, state({ demands: [ready] })), null);
});
test('renderer: decision guard rejects stale revision, protected result, active or unknown execution', () => {
  const target = demand({ runState: 'stopped', plan: { id: 'p1', scope: '', ready: true, confirmed: true } });
  const review = { kind: 'revise-plan' as const, demand: target };
  assert.match(decisionUnavailable(review, state({ demands: [{ ...target, version: 8 }] }))!, /版本已变化/);
  for (const runState of ['running', 'stopping', 'unknown', 'queued', undefined] as const) assert.match(decisionUnavailable(review, state({ demands: [{ ...target, runState }] }))!, /停止/);
  assert.match(decisionUnavailable(review, state({ demands: [{ ...target, result: { id: 'result', contentId: 'c1', notes: '', createdAt: '' } }] }))!, /退回/);
});
test('renderer: method switch binds only an imported exact snapshot, requires reviewed impact and rejects configuration races', () => {
  const config = configuration(); config.methods = [{ stage: 'planning', logicalName: 'Synthetic planning', status: 'configured', source: { id: 'method', path: '/synthetic/method.md', sha256: 'c'.repeat(64) }, snapshot: { id: 'method', version: 'v2', digest: 'd'.repeat(64), adapter: 'synthetic-only' }, dependencyCount: 0, blockers: [] }];
  const target = demand({ runState: 'stopped' }); const review = { kind: 'switch-method' as const, demand: target, configuration: config };
  assert.throws(() => makeDecisionCommand(review, { reason: 'Need boundary review', stage: 'planning' }, 'request'), /审阅/);
  assert.throws(() => makeDecisionCommand(review, { reason: 'Need boundary review', stage: 'review', impactReviewed: true }, 'request'), /已核验/);
  assert.deepEqual(makeDecisionCommand(review, { reason: 'Need boundary review', stage: 'planning', impactReviewed: true }, 'request'), { kind: 'switch-method', demandId: target.id, expectedVersion: 7, requestId: 'request', text: 'Need boundary review', stage: 'planning', methodId: 'method', methodVersion: 'v2', methodDigest: 'd'.repeat(64), configurationDigest: config.configurationDigest, impactReviewed: true });
  assert.equal(decisionUnavailable(review, state({ demands: [target], configuration: config })), null);
  assert.match(decisionUnavailable(review, state({ demands: [target], configuration: { ...config, configurationDigest: 'e'.repeat(64) } }))!, /配置版本已变化/);
});

import { knowledgeUnavailable, makeKnowledgeAction } from '../src/desktop/renderer/knowledge-model.ts';
import { implementationUnavailable, makeImplementationAuthorization } from '../src/desktop/renderer/implementation-model.ts';
import type { KnowledgeLifecycleView } from '../src/host/knowledge-lifecycle.ts';
const lifecycle = (): KnowledgeLifecycleView => ({ candidates: [{ revisionId: 'synthetic-kr1', resultId: 'synthetic-r1', artifactId: 'synthetic-n1', title: 'Synthetic fact', sourceKind: 'implementation', statementKind: 'fact', status: 'candidate', body: 'Synthetic exact candidate body', roles: ['planner'], modulePaths: ['src/synthetic.ts'] }], resultMaterials: [{ resultId: 'synthetic-r1', artifactId: 'synthetic-n1', title: 'Synthetic candidate', accepted: true }], checks: [{ id: 'synthetic-check1', resultId: 'synthetic-r1', name: 'Synthetic renderer fixture', environment: 'synthetic-environment', usable: true }], observations: [{ observationId: 'synthetic-observation', projectId: 'synthetic-project', demandId: 'synthetic-demand', observedAt: '2026-10-08T00:00:00Z', provenance: 'github-live', owner: 'synthetic', repository: 'fixture', pullRequest: 1, target: 'main', state: 'merged', formalCommit: 'a'.repeat(40), targetCommit: 'a'.repeat(40), submittedCommit: 'b'.repeat(40), url: 'https://github.com/synthetic/fixture/pull/1' }], baseline: { initial: 'a'.repeat(40), current: 'a'.repeat(40), head: 'b'.repeat(40), formalTarget: 'main' }, proposals: [{ proposalId: 'synthetic-proposal', demandId: 'synthetic-demand', formalTarget: 'main', sourceCommit: 'c'.repeat(40), expectedHead: 'b'.repeat(40), expectedBaseline: 'a'.repeat(40), createdAt: '' }], blockers: [] });
test('renderer: knowledge candidate saves exact artifact with explicit classification and role scope only', () => {
  const target = demand({ knowledgeLifecycle: lifecycle() }); const review = { action: 'save-candidate' as const, demand: target, resultId: 'synthetic-r1', artifactId: 'synthetic-n1' };
  assert.throws(() => makeKnowledgeAction(review, { title: 'Synthetic' }, 'request'), /明确选择/);
  const action = makeKnowledgeAction(review, { title: '  Synthetic fact  ', sourceKind: 'implementation', statementKind: 'fact', roles: ['planner'], modulePaths: 'src/a.ts\nsrc/a.ts\nsrc/b.ts', tags: 'dates' }, 'request');
  assert.deepEqual(action, { action: 'save-candidate', demandId: target.id, expectedVersion: 7, requestId: 'request', resultId: 'synthetic-r1', artifactId: 'synthetic-n1', title: 'Synthetic fact', sourceKind: 'implementation', statementKind: 'fact', roles: ['planner'], modulePaths: ['src/a.ts','src/b.ts'], tags: ['dates'] });
  assert.equal('body' in action, false); assert.equal('verified' in action, false);
});
test('renderer: qualification cannot treat hypothesis, fake merge, unavailable or other-result checks as proof', () => {
  const target = demand({ knowledgeLifecycle: lifecycle() }); const review = { action: 'qualify' as const, demand: target, revisionId: 'synthetic-kr1' };
  const input = { baseline: 'a'.repeat(40), checkIds: ['synthetic-check1'], observationId: 'synthetic-observation', reviewed: true, reason: 'Synthetic semantic review' };
  assert.throws(() => makeKnowledgeAction(review, { ...input, reviewed: false }, 'request'), /审阅/);
  const action = makeKnowledgeAction(review, input, 'request'); assert.equal(action.action, 'qualify'); assert.equal('sourceVerified' in action, false);
  for (const mutate of [(view: KnowledgeLifecycleView) => { view.candidates[0]!.statementKind = 'hypothesis'; }, (view: KnowledgeLifecycleView) => { view.observations[0]!.provenance = 'controlled-response'; }, (view: KnowledgeLifecycleView) => { view.checks[0]!.usable = false; }, (view: KnowledgeLifecycleView) => { view.checks[0]!.resultId = 'other-result'; }]) {
    const view = lifecycle(); mutate(view); assert.throws(() => makeKnowledgeAction({ ...review, demand: { ...target, knowledgeLifecycle: view } }, input, 'request'));
  }
  const independent = lifecycle(); independent.candidates[0]!.sourceKind = 'existing-fact';
  assert.throws(() => makeKnowledgeAction({ ...review, demand: { ...target, knowledgeLifecycle: independent } }, input, 'request'), /独立/);
});
test('renderer: baseline proposal has no integration authority; integration requires exact proposal and explicit author', () => {
  const target = demand({ runState: 'stopped', knowledgeLifecycle: lifecycle() });
  const proposal = makeKnowledgeAction({ action: 'propose-baseline', demand: target }, { sourceCommit: 'c'.repeat(40) }, 'request');
  assert.equal(proposal.action, 'propose-baseline'); assert.equal('author' in proposal, false); assert.equal('updateAuthorized' in proposal, false);
  assert.throws(() => makeKnowledgeAction({ action: 'propose-baseline', demand: target }, { sourceCommit: 'main' }, 'request'), /完整/);
  const review = { action: 'apply-baseline' as const, demand: target, proposalId: 'synthetic-proposal' };
  assert.throws(() => makeKnowledgeAction(review, { authorName: 'Synthetic', authorEmail: 'synthetic@example.invalid' }, 'request'), /授权/);
  assert.deepEqual(makeKnowledgeAction(review, { reviewed: true, authorName: 'Synthetic', authorEmail: 'synthetic@example.invalid' }, 'request'), { action: 'apply-baseline', demandId: target.id, expectedVersion: 7, requestId: 'request', proposalId: 'synthetic-proposal', author: { name: 'Synthetic', email: 'synthetic@example.invalid' } });
  assert.equal(knowledgeUnavailable(review, state({ demands: [target] })), null);
  assert.match(knowledgeUnavailable(review, state({ demands: [{ ...target, runState: 'running' }] }))!, /停止/);
  const drift = structuredClone(target); drift.knowledgeLifecycle!.baseline!.head = 'f'.repeat(40);
  assert.match(knowledgeUnavailable(review, state({ demands: [drift] }))!, /记录已变化/);
});
test('renderer: knowledge stale version and changed exact lifecycle record close eligibility decisions', () => {
  const target = demand({ knowledgeLifecycle: lifecycle() }), review = { action: 'invalidate' as const, demand: target, revisionId: 'synthetic-kr1' };
  assert.match(knowledgeUnavailable(review, state({ demands: [{ ...target, version: 8 }] }))!, /重新审阅/);
  assert.throws(() => makeKnowledgeAction(review, { reason: ' ' }, 'request'), /撤销原因/);
  assert.equal(makeKnowledgeAction(review, { reason: 'Synthetic invalid source' }, 'request').action, 'invalidate');
});
test('renderer: implementation author consent is default-off and never confirms design or grants remote rights', () => {
  const target = demand({ phase: 'awaiting-authorization', plan: { id: 'synthetic-plan', scope: 'Synthetic scope', ready: true, confirmed: true } });
  const noCommit = makeImplementationAuthorization(target, { localCommit: false, authorName: 'Ignored', authorEmail: 'ignored@example.invalid' }, 'request');
  assert.deepEqual(noCommit, { kind: 'authorize-implementation', demandId: target.id, expectedVersion: 7, requestId: 'request', planId: 'synthetic-plan', localCommit: false });
  assert.throws(() => makeImplementationAuthorization(target, { localCommit: true, authorName: '', authorEmail: '' }, 'request'), /作者/);
  const withCommit = makeImplementationAuthorization(target, { localCommit: true, authorName: 'Synthetic User', authorEmail: 'synthetic@example.invalid' }, 'request');
  assert.equal(withCommit.localCommit, true); assert.equal(withCommit.authorName, 'Synthetic User');
  assert.equal('confirmDesign' in withCommit, false); assert.equal('push' in withCommit, false);
  assert.match(implementationUnavailable(target, state({ demands: [{ ...target, version: 8 }] }))!, /版本已变化/);
  assert.throws(() => makeImplementationAuthorization({ ...target, plan: { ...target.plan!, confirmed: false } }, { localCommit: false, authorName: '', authorEmail: '' }, 'request'), /单独确认/);
});
