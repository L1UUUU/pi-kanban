import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { syntheticPlanningFlow } from '../src/desktop/renderer/planning-preview.ts';
import { EXECUTION_STEP_LABELS, executionAxisEvidence, executionDecisionFindings, executionTicketProgress } from '../src/desktop/renderer/execution-model.ts';
import { methodSelectionDisclosure } from '../src/desktop/renderer/configuration-model.ts';
import { bundledImplementationMethod, emptyConfiguration, inspectConfiguration } from '../src/host/configuration.ts';
import type { ArtifactRef, ExecutionFindingInput, ExecutionReviewRecord, ExecutionStep } from '../src/domain/types.ts';
import type { Demand, ViewState } from '../src/desktop/renderer/types.ts';

const artifact = (id: string): ArtifactRef => ({ id, digest: 'a'.repeat(64), location: `synthetic-only://${id}` });
function fixture(): Demand {
  const planning = syntheticPlanningFlow('complete');
  return { id: 'execution-demand', projectId: 'synthetic-project', title: 'Synthetic execution UI', description: 'No model or runtime execution', version: 12, phase: 'implementing', control: 'active', blockers: [], activities: [], messages: [], runState: 'stopped', activeContentId: 'K-current', planningFlow: planning,
    executionFlow: { id: 'execution-flow', revision: 3, planId: 'plan', planningFlowId: planning.id, approvedInputDigest: 'b'.repeat(64), step: 'ticket-implementation', scope: 'ticket', ticketId: planning.tickets[0].id,
      tickets: planning.tickets.map(ticket => ({ ticketId: ticket.id, status: 'pending', reviewIds: [], resolutionIds: [] })), implementations: [], checkInputIds: [], reviews: [], resolutions: [], repairHistory: [], history: [] } };
}
function finding(id: string, category: ExecutionFindingInput['category'], requiresDesignDecision = false): ExecutionFindingInput {
  return { id, category, severity: requiresDesignDecision ? 'decision' : 'blocking', location: 'src/synthetic.ts:10', basis: `${category} basis`, impact: 'Synthetic behavior differs', verification: 'Observe the seam using the existing test', reference: artifact(`${id}-reference`), clause: category === 'smell' ? undefined : '§4.2', requiresDesignDecision };
}
function review(axis: 'standards' | 'spec', contentId: string, sequence: number, findings: ExecutionFindingInput[] = []): ExecutionReviewRecord {
  return { id: `${axis}-review-${sequence}`, axis, contentId, evidence: artifact(`${axis}-evidence-${sequence}`), knowledgeReviewed: true, findings, sequence, scope: 'whole-spec', runId: `${axis}-run-${sequence}`, contextId: `${axis}-fresh-context-${sequence}`, inputDigest: 'c'.repeat(64), flowRevision: sequence };
}
function state(demand: Demand): ViewState { return { sequence: 1, projects: [], demands: [demand], runtime: { platform: 'synthetic', node: 'synthetic', executionEnabled: false, connection: 'connected', blockers: ['No execution in this fixture'] } }; }

test('execution frontier waits for every persisted dependency and never guesses when planning graph is absent or changed', () => {
  const demand = fixture(), flow = demand.executionFlow!, first = flow.tickets[0].ticketId, second = flow.tickets[1].ticketId;
  let progress = executionTicketProgress(demand);
  assert.deepEqual(progress.frontier, [first]); assert.deepEqual(progress.tickets[1].blockedBy, [first]); assert.equal(progress.completed, 0);
  flow.tickets[0].status = 'done'; flow.tickets[0].completedContentId = 'K-ticket-1';
  progress = executionTicketProgress(demand); assert.deepEqual(progress.frontier, [second]); assert.equal(progress.completed, 1); assert.equal(progress.tickets[0].contentId, 'K-ticket-1');
  demand.planningFlow!.id = 'different-graph';
  progress = executionTicketProgress(demand); assert.deepEqual(progress.frontier, []); assert.ok(progress.tickets.every(ticket => !ticket.graphKnown));
  delete demand.planningFlow; assert.deepEqual(executionTicketProgress(demand).frontier, []);
});

test('axis evidence does not upgrade a historical broad review or a different axis into current K approval', () => {
  const demand = fixture(), flow = demand.executionFlow!;
  flow.reviews = [review('standards', 'K-old', 1), review('spec', 'K-current', 2)];
  let evidence = executionAxisEvidence(flow, 'standards', demand.activeContentId);
  assert.equal(evidence.latestReview!.contentId, 'K-old'); assert.equal(evidence.currentReview, undefined); assert.equal(evidence.currentResolutions.length, 0);
  flow.resolutions.push({ id: 'focused-standards', axis: 'standards', contentId: 'K-current', repairScopeId: 'repair-1', evidence: artifact('focused-evidence'), dispositions: [], sequence: 3, scope: 'whole-spec', runId: 'focused-run', contextId: 'fresh-focused-context', inputDigest: 'd'.repeat(64), flowRevision: 3 });
  evidence = executionAxisEvidence(flow, 'standards', demand.activeContentId);
  assert.equal(evidence.currentReview, undefined); assert.equal(evidence.currentResolutions.length, 1);
  assert.equal(executionAxisEvidence(flow, 'spec', demand.activeContentId).currentReview!.id, 'spec-review-2');
  assert.equal(executionAxisEvidence(flow, 'standards').currentResolutions.length, 0, 'unknown K cannot imply current evidence');
  assert.equal(flow.reviews[0].contentId, 'K-old', 'the original record is preserved');
});

test('design decision display requires a still-open exact-content decision and does not revive historical or closed findings', () => {
  const demand = fixture(), selected = finding('scope-change', 'smell', true);
  demand.executionFlow!.reviews.push(review('standards', 'K-current', 1, [selected]));
  demand.findings = [{ ...selected, contentId: 'K-current', reviewRunId: 'standards-run', status: 'open' }];
  assert.deepEqual(executionDecisionFindings(demand).map(item => item.id), ['scope-change']);
  demand.findings[0].contentId = 'K-old'; assert.equal(executionDecisionFindings(demand).length, 0);
  demand.findings[0].contentId = 'K-current'; demand.findings[0].status = 'closed'; assert.equal(executionDecisionFindings(demand).length, 0);
});

function actualRenderer() {
  const compiled = buildSync({ stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'tsx', contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { ExecutionPanel } from './src/desktop/renderer/Execution.tsx';
    import { ConfigurationPanel } from './src/desktop/renderer/Configuration.tsx';
    export const execution = demand => renderToStaticMarkup(React.createElement(ExecutionPanel,{demand,onArtifact:()=>{},onDecisions:()=>{}}));
    export const configuration = (state,demand) => renderToStaticMarkup(React.createElement(ConfigurationPanel,{state,demand,pending:false,preparing:false,offline:false,onImport:()=>{},onReview:()=>{}}));
  ` }, bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' }).outputFiles[0]!.text;
  const result = { exports: {} as { execution: (demand: Demand) => string; configuration: (state: ViewState, demand: Demand) => string } };
  new Function('require', 'module', 'exports', compiled)(createRequire(import.meta.url), result, result.exports);
  return result.exports;
}

test('actual execution TSX displays every persisted stage without implying execution, grant or acceptance', () => {
  const render = actualRenderer(), demand = fixture();
  for (const step of Object.keys(EXECUTION_STEP_LABELS) as ExecutionStep[]) {
    demand.executionFlow!.step = step;
    const html = render.execution(demand);
    assert.ok(html.includes(`<h2>${EXECUTION_STEP_LABELS[step]}</h2>`));
    assert.match(html, /当前展示已保存的阶段/); assert.match(html, /当前精确内容 K/); assert.match(html, /K-current/);
    assert.match(html, /模型额度、资料传输、实施授权和最终验收分别处理/);
    assert.doesNotMatch(html, /确认授权|接受成果|自动推送成功/);
  }
  demand.control = 'paused'; assert.match(render.execution(demand), /当前已停止推进/);
  demand.control = 'active'; demand.runState = 'running'; assert.match(render.execution(demand), /Host 报告正在运行/);
  delete demand.executionFlow; assert.match(render.execution(demand), /尚未开始实施/);
});

test('actual execution TSX separates documented violations, smells and focused dispositions while preserving history and escaping source text', () => {
  const render = actualRenderer(), demand = fixture(), flow = demand.executionFlow!;
  const violation = finding('documented', 'documented-violation'), smell = finding('scope-change', 'smell', true);
  smell.basis = '<script>changeScope()</script>';
  flow.reviews.push(review('standards', 'K-old', 1, [violation, smell]), review('spec', 'K-current', 2, [finding('spec-gap', 'spec-violation')]));
  flow.repairScope = { id: 'repair-1', scope: 'whole-spec', baseContentId: 'K-old', reviewIds: ['standards-review-1'], findingIds: ['documented', 'scope-change'], checkIds: ['check-a'], reason: '<img src=x onerror=alert(1)>' };
  flow.implementations.push({ contentId: 'K-old', scope: 'ticket', ticketId: flow.tickets[0].ticketId, runId: 'tdd-run', inputDigest: 'd'.repeat(64), flowRevision: 1, tdd: { mode: 'red-green', testingSeams: ['Approved export seam'], red: [artifact('red-test')], green: [artifact('green-test')] } }, { contentId: 'K-current', scope: 'whole-spec', runId: 'repair-run', inputDigest: 'd'.repeat(64), flowRevision: 2, repairScopeId: 'repair-1', tdd: { mode: 'preserve-behavior', rationale: 'Existing observable behavior remains fixed', testingSeams: ['Approved export seam'], red: [], green: [artifact('repair-test')] } });
  flow.resolutions.push({ id: 'focused-1', axis: 'standards', contentId: 'K-current', repairScopeId: 'repair-1', evidence: artifact('resolution'), dispositions: [{ findingId: 'documented', outcome: 'fixed', rationale: 'Direct regression covered', evidence: artifact('fix-evidence') }, { findingId: 'scope-change', outcome: 'unresolved', rationale: 'Needs an explicit design decision', evidence: artifact('scope-evidence') }], sequence: 3, scope: 'whole-spec', runId: 'resolution-run', contextId: 'resolution-fresh-context', inputDigest: 'e'.repeat(64), flowRevision: 3 });
  demand.findings = [{ ...smell, contentId: 'K-current', reviewRunId: 'standards-review-run', status: 'open' }];
  const { history, ...prior } = structuredClone(flow); flow.history.push(prior);
  const html = render.execution(demand);
  for (const label of ['有文档依据的违规', '设计异味', 'Spec 不一致', '定向核验', '原审查继续保留其内容版本', '独立只读上下文', '历史执行与审查', '仍未解决', '查看决定与限定修订', '关闭发现不会授权设计变更', '先失败、后通过 · TDD', '保持既有行为 · 限定修复', 'Approved export seam', '阅读失败测试证据', '阅读通过测试证据']) assert.ok(html.includes(label), label);
  assert.match(html, /&lt;script&gt;changeScope\(\)&lt;\/script&gt;/); assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script|<img|href="synthetic-only/);
  assert.match(html, /阅读明确条款依据/); assert.match(html, /阅读异味观察依据/);
});

test('configuration disclosure names implement-spec for both stages and keeps TDD, read-only review and production prerequisites distinct', () => {
  const vendor = realpathSync.native(fileURLToPath(new URL('../vendor/mattpocock-skills', import.meta.url))), source = bundledImplementationMethod(vendor);
  for (const stage of ['implementation', 'review'] as const) {
    assert.equal(methodSelectionDisclosure(stage).name, 'implement-spec'); assert.equal(methodSelectionDisclosure(stage).stagedSelection, false);
    assert.equal(methodSelectionDisclosure(stage, source).stagedSelection, true);
    assert.equal(methodSelectionDisclosure(stage, { ...source, adapter: 'explicit-text-v1' }).stagedSelection, false);
  }
  assert.match(methodSelectionDisclosure('implementation', source).projection, /TDD/);
  assert.match(methodSelectionDisclosure('review', source).projection, /独立只读 code-review/);
  const demand = fixture(), config = emptyConfiguration(); config.methods.implementation = source; config.methods.review = structuredClone(source);
  const view = { ...state(demand), configuration: inspectConfiguration(config) }, html = actualRenderer().configuration(view, demand);
  assert.match(html, /implement-spec · TDD/); assert.match(html, /implement-spec · 独立只读 code-review/);
  assert.equal((html.match(/14 个明确来源与 SHA-256/g) ?? []).length, 2);
  assert.match(html, /配置选择不增加模型额度、运行权限或调用权/);
  assert.match(html, /Node 原生受控工具/); assert.match(html, /单独授权/);
  assert.equal(view.configuration.executionEnabled, false);
  config.methods.review = { ...source, adapter: 'explicit-text-v1' }; delete config.methods.review.executionBundle;
  const legacy = actualRenderer().configuration({ ...view, configuration: inspectConfiguration(config) }, demand);
  assert.match(legacy, /候选文本方法仅供检查，不能替代生产分阶段执行/);
});
