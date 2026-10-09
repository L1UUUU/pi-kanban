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
