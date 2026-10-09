import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { syntheticPlanningFlow } from '../src/desktop/renderer/planning-preview.ts';
import { PLANNING_STEPS, PLANNING_STEP_LABELS, makePlanningCommand, planningAttention, planningUnavailable, unansweredPlanningQuestions } from '../src/desktop/renderer/planning-model.ts';
import { demandStatus, makeCommand, needsAttention, primaryAction } from '../src/desktop/renderer/model.ts';
import { decisionUnavailable, makeDecisionCommand } from '../src/desktop/renderer/decision-model.ts';
import type { PlanningReview } from '../src/desktop/renderer/planning-model.ts';
import type { Demand, ViewState } from '../src/desktop/renderer/types.ts';

const demand = (step: Parameters<typeof syntheticPlanningFlow>[0] = 'awaiting-understanding-confirmation'): Demand => ({ id: 'synthetic-demand', projectId: 'synthetic-project', title: 'Synthetic staged planning', description: 'Fixture only', version: 12, phase: 'planning', control: 'active', runState: 'stopped', blockers: [], activities: [], messages: [], planningFlow: syntheticPlanningFlow(step) });
const state = (target: Demand): ViewState => ({ sequence: 1, projects: [], demands: [target], runtime: { platform: 'synthetic', node: 'synthetic', executionEnabled: false, connection: 'connected', blockers: ['Synthetic runtime unavailable'] } });

test('planning renderer: requirement confirmation and final design confirmation bind different exact objects', () => {
  const requirements = demand(), review: PlanningReview = { kind: 'confirm-understanding', demand: requirements };
  assert.equal(planningUnavailable(review, state(requirements)), null);
  assert.throws(() => makePlanningCommand(review, {}, 'request'), /明确审阅/);
  const first = makePlanningCommand(review, { reviewed: true }, 'request');
  assert.deepEqual(first, { kind: 'confirm-understanding', demandId: requirements.id, expectedVersion: 12, requestId: 'request', flowId: 'synthetic-planning-flow', flowRevision: 7, understandingId: 'synthetic-understanding', digest: '2'.repeat(64) });
  const design = demand('awaiting-final-design-confirmation'), final = makePlanningCommand({ kind: 'confirm-final-design', demand: design }, { reviewed: true }, 'request-final');
  assert.equal(final.designId, 'synthetic-design'); assert.equal(final.digest, design.planningFlow!.resolution!.digest);
  assert.notEqual(final.digest, design.planningFlow!.design!.digest);
  for (const command of [first, final]) for (const permission of ['planId', 'localCommit', 'authorEmail', 'confirmDesign', 'configurationDigest']) assert.equal(permission in command, false);
  assert.throws(() => makeCommand('confirm-understanding', requirements, 'raw'), /专用表单/);
});

test('planning renderer: answers target only the exact open question and never imply confirmation', () => {
  const target = demand('clarification'), flow = target.planningFlow!, question = flow.questions[0];
  const review: PlanningReview = { kind: 'answer-planning-question', demand: target, questionId: question.id };
  assert.equal(planningUnavailable(review, state(target)), null);
  assert.equal(unansweredPlanningQuestions(flow).length, 1); assert.equal(needsAttention(target), true);
  const command = makePlanningCommand(review, { text: '  Use UTC.  ' }, 'answer');
  assert.equal(command.answer, 'Use UTC.'); assert.equal(command.questionDigest, question.digest); assert.equal(command.questionId, question.id);
  assert.equal(command.kind, 'answer-planning-question'); assert.equal('digest' in command, false);
  const answered = structuredClone(target); answered.planningFlow!.answers.push({ scope: question.scope, question: question.question, questionId: question.id, questionDigest: question.digest, answer: 'UTC', userId: 'synthetic-owner', createdAt: '2026-10-09T00:00:00Z' });
  assert.match(planningUnavailable(review, state(answered))!, /已回答/);
  assert.equal(unansweredPlanningQuestions(answered.planningFlow!).length, 0);
  assert.throws(() => makePlanningCommand({ ...review, questionId: 'historical' }, { text: 'unrelated answer' }, 'other'), /未回答/);
});

test('planning renderer: stale revision, flow, stage, digest and reviewed design resolution all close controls', () => {
  const original = demand('awaiting-final-design-confirmation'), review: PlanningReview = { kind: 'confirm-final-design', demand: original };
  for (const mutate of [
    (target: Demand) => target.version++, (target: Demand) => target.planningFlow!.revision++,
    (target: Demand) => { target.planningFlow!.id = 'other-flow'; }, (target: Demand) => { target.planningFlow!.step = 'design'; },
    (target: Demand) => { target.planningFlow!.design!.digest = 'c'.repeat(64); }, (target: Demand) => { target.planningFlow!.resolution!.digest = 'd'.repeat(64); },
    (target: Demand) => { target.planningFlow!.review!.id = 'other-review'; },
  ]) { const latest = structuredClone(original); mutate(latest); assert.ok(planningUnavailable(review, state(latest))); }
  const requirements = demand(), changed = structuredClone(requirements); changed.planningFlow!.understanding!.digest = 'e'.repeat(64);
  assert.match(planningUnavailable({ kind: 'confirm-understanding', demand: requirements }, state(changed))!, /已变化/);
});

test('planning renderer: paused and runtime-blocked decisions save without resume, while unsafe contexts and offline reject', () => {
  for (const control of ['paused', 'exited', 'active'] as const) {
    const target = demand(); target.control = control; target.blockers = ['Synthetic runtime or scope blocker'];
    assert.equal(planningUnavailable({ kind: 'confirm-understanding', demand: target }, state(target)), null);
    if (control !== 'active') assert.equal(primaryAction(target)?.kind, 'resume');
  }
  for (const runState of ['running', 'queued', 'unknown', 'stopping'] as const) {
    const target = demand(); target.runState = runState;
    assert.match(planningUnavailable({ kind: 'confirm-understanding', demand: target }, state(target))!, /停止/);
  }
  const target = demand(), offline = state(target); offline.runtime.connection = 'disconnected';
  assert.match(planningUnavailable({ kind: 'confirm-understanding', demand: target }, offline)!, /断开/);
  target.control = 'cancelled'; assert.equal(planningAttention(target), null); assert.equal(needsAttention(target), false);
});

test('planning renderer: scope revisions preserve distinct intent and cannot use legacy blanket controls', () => {
  const target = demand('complete'); target.plan = { id: 'synthetic-plan', scope: 'Synthetic', ready: true, confirmed: true };
  for (const scope of ['requirements', 'design'] as const) {
    const review: PlanningReview = { kind: 'revise-planning', demand: target, scope };
    const command = makePlanningCommand(review, { text: 'Affected scope only' }, `revise-${scope}`);
    assert.equal(command.scope, scope); assert.equal(command.text, 'Affected scope only'); assert.equal(command.flowRevision, 7);
  }
  assert.match(decisionUnavailable({ kind: 'revise-plan', demand: target }, state(target))!, /分阶段规划/);
  assert.throws(() => makeDecisionCommand({ kind: 'revise-plan', demand: target }, { reason: 'bypass' }, 'bypass'), /限定范围/);
  const unconfirmed = demand('clarification'); assert.match(planningUnavailable({ kind: 'revise-planning', demand: unconfirmed, scope: 'design' }, state(unconfirmed))!, /先确认需求/);
  target.phase = 'awaiting-authorization'; assert.equal(primaryAction(target)?.kind, 'authorize-implementation');
});

test('planning renderer: staged status and completed documents retain exact roles without extra split approval', () => {
  const target = demand('tickets'); assert.match(demandStatus(target).label, /拆分本地任务.*未运行/);
  assert.equal(target.planningFlow!.spec!.kind, 'spec'); assert.equal(primaryAction(target), null);
  const complete = demand('complete'); assert.equal(complete.planningFlow!.tickets[0].kind, 'ticket');
  assert.equal(complete.planningFlow!.tickets[0].blockedBy.length, 0);
  assert.deepEqual(complete.planningFlow!.tickets[1].blockedBy, ['synthetic-local-ticket-1']);
  assert.equal(complete.planningFlow!.confirmations.length, 2); assert.equal(planningAttention(complete), null);
  for (const kind of ['confirm-understanding', 'confirm-final-design'] as const) assert.ok(planningUnavailable({ kind, demand: complete }, state(complete)));
});

function actualPlanningRenderer() {
  const compiled = buildSync({ stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'tsx', contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { PlanningPanel, PlanningForm } from './src/desktop/renderer/Planning.tsx';
    const handlers = {onReview:()=>{},onArtifact:()=>{},onSubmit:()=>{},close:()=>{}};
    export const panel = (demand,state,flags={}) => renderToStaticMarkup(React.createElement(PlanningPanel,{demand,state,offline:false,pending:false,...handlers,...flags}));
    export const form = (review,state,flags={}) => renderToStaticMarkup(React.createElement(PlanningForm,{review,state,offline:false,pending:false,error:null,...handlers,...flags}));
  ` }, bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' }).outputFiles[0]!.text;
  const compiledModule = { exports: {} as { panel: (target: Demand, state: ViewState, flags?: Record<string, unknown>) => string; form: (review: PlanningReview, state: ViewState, flags?: Record<string, unknown>) => string } };
  new Function('require', 'module', 'exports', compiled)(createRequire(import.meta.url), compiledModule, compiledModule.exports);
  return compiledModule.exports;
}

test('planning actual TSX: every persisted stage renders exact progress, separate controls and local document roles', () => {
  const render = actualPlanningRenderer();
  for (const step of PLANNING_STEPS) {
    const target = demand(step), html = render.panel(target, state(target));
    assert.ok(html.includes(`<h2>${PLANNING_STEP_LABELS[step]}</h2>`));
    assert.ok(html.includes('aria-current="step"'));
    const confirmations = html.match(/<button[^>]*>确认[^<]+<\/button>/g) ?? [];
    if (step === 'awaiting-understanding-confirmation') assert.equal(confirmations.length, 1);
    else if (step === 'awaiting-final-design-confirmation') assert.equal(confirmations.length, 1);
    else assert.equal(confirmations.length, 0, `${step} must not ask for another confirmation`);
    if (step === 'complete') { assert.match(html, /本地 Spec 文档/); assert.match(html, /此文档不是可执行任务/); assert.match(html, /前置任务：synthetic-local-ticket-1/); assert.match(html, /无前置任务，可优先实施/); }
    if (step === 'awaiting-final-design-confirmation') { assert.match(html, /独立只读审查与处理/); assert.match(html, /触发条件/); assert.match(html, /建议验证位置/); assert.match(html, /已采纳/); }
  }
  const target = demand(), html = render.panel(target, state(target), { pending: true });
  assert.match(html, /<button[^>]*disabled=""[^>]*>确认需求与验收<\/button>/);
});

test('planning actual TSX: consent starts unchecked, read-only history remains accessible and stage content is escaped', () => {
  const render = actualPlanningRenderer(), target = demand('awaiting-final-design-confirmation'), flow = target.planningFlow!;
  flow.design!.testingSeams[0] = '<img src=x onerror=alert(1)>';
  flow.review!.findings[0].expectedOutcome = '<script>approveEverything()</script>';
  flow.answers.push({ scope: 'requirements', questionId: 'synthetic-prior-question', question: 'Synthetic earlier-round timezone question', questionDigest: 'a'.repeat(64), answer: 'Synthetic retained UTC choice', userId: 'synthetic-owner', createdAt: '2026-10-09T00:00:00Z' });
  const { history, ...previous } = syntheticPlanningFlow('complete'); flow.history.push(previous);
  const html = render.panel(target, state(target));
  assert.match(html, /历史规划与审查/); assert.match(html, /阅读历史审查/); assert.match(html, /阅读历史任务 synthetic-local-ticket-1/);
  assert.match(html, /已保存的问题答案/); assert.match(html, /Synthetic earlier-round timezone question/); assert.match(html, /Synthetic retained UTC choice/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.match(html, /&lt;script&gt;approveEverything\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img|<script|href="synthetic-only/);
  const form = render.form({ kind: 'confirm-final-design', demand: target }, state(target));
  assert.match(form, /type="checkbox"/); assert.doesNotMatch(form, /checked=""/);
  assert.match(form, /<button[^>]*disabled=""[^>]*>确认最终设计与测试<\/button>/);
  assert.match(form, /最终设计与审查处理摘要/);
  const paused = structuredClone(target); paused.control = 'paused';
  assert.match(render.form({ kind: 'confirm-final-design', demand: paused }, state(paused)), /保存决定后仍保持停止/);
});
