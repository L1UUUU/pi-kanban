/** Isolated synthetic preview entry. Never imported by main.tsx or included in production output. */
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import type { ConfigurationSummary, ViewState, WorkbenchBridge } from './types.ts';
import './styles.css';

const now = '2026-10-08T14:30:00Z';
export const syntheticPreview: ViewState = {
  sequence: 1,
  preview: true,
  projects: [{ id: 'synthetic-project', name: 'atlas-console', rootPath: '/synthetic/projects/atlas-console' }],
  runtime: {
    platform: 'synthetic-preview', node: 'synthetic', connection: 'connected', executionEnabled: false,
    blockers: ['这是合成界面预览，未连接真实桌面 Host。', '真实执行需要已核验的隔离运行组合、模型与资料范围、阶段方法和有限额度。'],
  },
  selected: { projectId: 'synthetic-project', demandId: 'synthetic-export' },
  demands: [{
    id: 'synthetic-export', projectId: 'synthetic-project', title: '为数据导出增加时间范围筛选',
    description: '让运营同事可以按时间范围导出数据。沿用项目现有的日期组件，支持常用时间范围，并明确处理开始时间晚于结束时间的情况。',
    version: 12, phase: 'awaiting-acceptance', control: 'active', runState: 'stopped',
    branch: 'demand/export-date-range', workspacePath: '/synthetic/worktrees/export-date-range',
    plan: { id: 'synthetic-plan-v2', scope: '复用现有日期范围组件与校验能力。增加近 7 天、近 30 天、自定义范围三个入口；请求与导出服务采用相同时间语义。异常输入展示清晰反馈。', ready: true, confirmed: true, specPath: 'synthetic://spec/export-date-range-v2', requiredChecks: ['时间范围边界单元测试', '导出请求集成测试', '独立代码与本地经验 Review'] },
    result: { id: 'synthetic-result-r1', contentId: 'synthetic-content-k3', notes: '合成示例：导出入口已加入时间范围选择，复用了现有组件与统一校验。请重点体验自定义范围与非法输入的反馈。', codeRef: 'synthetic-code-reference', createdAt: now, knowledgeRefs: ['synthetic-note-n1'] },
    blockers: [],
    messages: [
      { id: 'synthetic-m1', role: 'agent', stage: '规划', text: '合成示例：我会先确认项目已有的日期组件和时间语义，避免增加另一套范围校验。方案与实施会分别交给你确认。', timestamp: '2026-10-08T14:00:00Z' },
      { id: 'synthetic-m2', role: 'user', text: '保留现有导出流程，空范围沿用目前的行为。', state: 'applied', timestamp: '2026-10-08T14:05:00Z' },
      { id: 'synthetic-m3', role: 'agent', stage: '交付', text: '合成示例：这一轮稳定成果已经整理好。\n\n• 时间范围选择与导出入口保持一致\n• 空范围、边界时间和无效顺序有对应检查\n• 独立 Review 的证据与适用内容保存在右侧\n\n你可以查看成果说明，然后接受这一轮或给出返工意见。', timestamp: '2026-10-08T14:29:00Z' },
    ],
    activities: [
      { id: 'synthetic-a1', kind: 'tool', title: '读取日期组件与导出请求接口', detail: '合成工具活动；没有实际读取业务文件。\nsrc/components/date-range.tsx\nsrc/exports/request.ts', status: 'complete', timestamp: '2026-10-08T14:01:00Z' },
      { id: 'synthetic-a2', kind: 'workflow', title: '当前方案已保存 · synthetic-plan-v2', detail: '合成方案事件；不代表真实规划或实施授权。', status: 'complete', timestamp: '2026-10-08T14:07:00Z' },
      { id: 'synthetic-a3', kind: 'tool', title: '必要检查与独立 Review 记录', detail: '合成 UI 示例，不代表已经运行实际测试或 Review。', status: 'complete', timestamp: '2026-10-08T14:25:00Z' },
    ],
    checks: [
      { id: 'synthetic-c1', name: '日期范围边界', status: 'passed', contentId: 'synthetic-content-k3', evidence: '合成检查展示；未执行实际测试。' },
      { id: 'synthetic-c2', name: '导出请求集成', status: 'passed', contentId: 'synthetic-content-k3', evidence: '合成检查展示；未执行实际测试。' },
      { id: 'synthetic-c3', name: '独立正式 Review', status: 'passed', contentId: 'synthetic-content-k3', evidence: '合成检查展示；未执行实际 Review。' },
    ],
    knowledge: [{ id: 'synthetic-note-n1', title: '时间范围校验的统一入口', status: 'candidate', detail: '合成示例：保留来源与适用版本，在代码正式合入并核验前，不能作为新增能力向后续需求提供。', source: 'synthetic-content-k3' }],
  }, {
    id: 'synthetic-audit', projectId: 'synthetic-project', title: '梳理审计日志的查询体验', description: '整理筛选条件与分页行为，减少排查时的重复操作。',
    version: 2, phase: 'awaiting-authorization', control: 'active', runState: 'idle', blockers: [], activities: [], messages: [],
    plan: { id: 'synthetic-audit-plan', scope: '合成示例：统一审计日志列表筛选和分页行为。', ready: true, confirmed: true },
  }, {
    id: 'synthetic-idea', projectId: 'synthetic-project', title: '让空状态更有帮助', description: '让第一次进入项目的用户更清楚下一步可以做什么。',
    version: 1, phase: 'idea', control: 'active', runState: 'idle', blockers: [], activities: [], messages: [],
  }],
};
const syntheticConfiguration = (): ConfigurationSummary => {
  const sha256 = 'a'.repeat(64);
  const method = (stage: 'planning' | 'implementation' | 'review') => ({ id: `synthetic-${stage}`, path: `/synthetic/methods/${stage}.md`, sha256, logicalName: stage === 'planning' ? 'design-feature' : `synthetic-${stage}`, version: 'synthetic-v1', adapter: 'synthetic-only', dependencies: [] });
  const methods = { planning: method('planning'), implementation: method('implementation'), review: method('review') };
  const legacyShell = params.get('runtime') === 'unsupported-shell';
  const runtime: ConfigurationSummary['configuration']['runtime'] = legacyShell || params.get('runtime') === 'node' ? {
    profileId: 'synthetic-node-runtime', osBuild: null, arch: 'x64', node: null, helper: null, worker: null, pi: null,
    shell: legacyShell ? { id: 'synthetic-legacy-shell', kind: 'git-bash', path: '/synthetic/legacy/bin/bash.exe', sha256, version: 'synthetic-only', manifest: { id: 'synthetic-legacy-manifest', path: '/synthetic/legacy/manifest.json', sha256 } } : null,
    policySha256: null, evidence: { privateChannel: null, filesystem: null, processTree: null, network: null },
  } : null;
  return {
    schemaVersion: 1, revision: 1, configurationDigest: 'b'.repeat(64), sourceStatus: 'configured', executionEnabled: false,
    configuration: { schemaVersion: 1, revision: 1, runtime, methods, provider: { provider: 'synthetic-provider', modelId: 'synthetic-model', destination: 'https://synthetic-model.example.invalid/v1/responses', credentialRef: 'host:synthetic-only', contextPolicy: params.get('contextPolicy') === 'derived' ? 'approved-run-derived-v1' : 'exact-materials-only', data: [{ id: 'synthetic-demand-brief', sha256 }, { id: 'synthetic-method-material', sha256: 'c'.repeat(64) }], allowedRoles: ['planning', 'review'], limits: { maxRequests: 6, maxTokens: 12000, maxCostMicros: 1250000, currency: 'USD', expiresAt: '2099-01-01T00:00:00.000Z', meteringPolicy: 'synthetic-exact-usage' } } },
    methods: (['planning', 'implementation', 'review'] as const).map(stage => ({ stage, logicalName: methods[stage]!.logicalName, status: 'configured', source: methods[stage], snapshot: { id: methods[stage]!.id, version: 'synthetic-v1', digest: sha256, adapter: 'synthetic-only' }, dependencyCount: 0, blockers: [] })),
    planningMethodMissing: false, provider: { status: 'configured-unapproved', blockers: [] }, runtime: { status: legacyShell ? 'invalid' : 'missing', blockers: [...(legacyShell ? ['合成诊断：首版 Node 运行组合不支持 shell；请清除遗留 shell 配置。'] : []), '合成样例未验证原生隔离、受控进程与真实模型通道。'] }, blockers: ['合成样例不会启用实际执行。'],
  };
};
const params = new URLSearchParams(location.search);
let state: ViewState = params.get('view') === 'empty' ? { ...syntheticPreview, projects: [], demands: [], selected: undefined } : params.get('view') === 'onboarding' ? { ...syntheticPreview, selected: undefined } : structuredClone(syntheticPreview);
// Isolated synthetic control fixtures; no production entry imports this module.
if (params.has('decisions')) {
  const target = state.demands[0]!;
  target.result = undefined; target.phase = 'blocked'; target.runState = 'stopped';
  target.activeContentId = 'synthetic-current-content'; target.workflowBlockers = [];
  target.methodSnapshot = { planning: { id: 'synthetic-old-planning', version: 'synthetic-v0', digest: 'f'.repeat(64), adapter: 'synthetic-only' } };
  if (params.get('decisions') === 'plan') {
    target.plan = { id: 'synthetic-unresolved-plan', scope: '合成待明确方案', ready: false, confirmed: false, unresolvedQuestions: ['合成问题：日期边界使用哪个时区？'] };
    target.workflowBlockers = ['合成阻塞：需要明确时区'];
  } else if (params.get('decisions') === 'finding') {
    target.findings = [
      { id: 'synthetic-decision-f1', severity: 'decision', status: 'open', contentId: target.activeContentId, reviewRunId: 'synthetic-review-1', location: 'synthetic://export/date', basis: '合成：请选择日期边界行为。', impact: '合成：影响跨时区导出。', verification: '合成：核对边界测试。' },
      { id: 'synthetic-blocking-f2', severity: 'blocking', status: 'open', contentId: target.activeContentId, reviewRunId: 'synthetic-review-1', location: 'synthetic://export/date', basis: '合成：必要边界检查未通过。', impact: '合成：错误范围。', verification: '合成：修复后重跑检查。' },
      { id: 'synthetic-historical-f3', severity: 'decision', status: 'open', contentId: 'synthetic-old-content', reviewRunId: 'synthetic-review-old', location: 'synthetic://old', basis: '合成历史决定。', impact: '历史内容。', verification: '不适用于当前内容。' },
    ];
    target.workflowBlockers = ['User decision required: synthetic-decision-f1'];
  } else if (params.get('decisions') === 'blocker') target.workflowBlockers = ['合成：等待补齐检查环境'];
  else if (params.get('decisions') === 'method') state.configuration = syntheticConfiguration();
  target.blockers = [...target.workflowBlockers];
}
if (params.has('knowledge')) {
  const target = state.demands[0]!;
  target.knowledgeLifecycle = {
    candidates: [{ revisionId: 'synthetic-knowledge-revision', resultId: 'synthetic-result-r1', artifactId: 'synthetic-note-n1', title: '合成：时间范围经验', sourceKind: 'implementation', statementKind: 'fact', status: 'candidate', body: '合成精确正文：UTC 边界行为需要独立核对。', roles: ['planner'], modulePaths: ['src/synthetic.ts'] }],
    resultMaterials: [{ resultId: 'synthetic-result-r1', artifactId: 'synthetic-note-n1', title: '合成：时间范围经验', accepted: true }],
    checks: [{ id: 'synthetic-native-check', resultId: 'synthetic-result-r1', name: '合成原生检查展示', environment: 'synthetic-environment', usable: params.get('knowledge') !== 'blocked' }],
    remote: { owner: 'synthetic-owner', repository: 'synthetic-repo', pullRequest: 42, projectId: target.projectId, demandId: target.id, target: 'main' },
    observations: [{ observationId: 'synthetic-merge-observation', projectId: target.projectId, demandId: target.id, observedAt: '2026-10-08T00:00:00Z', provenance: params.get('knowledge') === 'blocked' ? 'controlled-response' : 'github-live', owner: 'synthetic-owner', repository: 'synthetic-repo', pullRequest: 42, target: 'main', state: 'merged', formalCommit: 'a'.repeat(40), targetCommit: 'a'.repeat(40), submittedCommit: 'b'.repeat(40), url: 'https://github.com/synthetic-owner/synthetic-repo/pull/42' }],
    baseline: { initial: 'a'.repeat(40), current: 'a'.repeat(40), head: 'b'.repeat(40), formalTarget: 'main' },
    proposals: [{ proposalId: 'synthetic-baseline-proposal', demandId: target.id, formalTarget: 'main', sourceCommit: 'c'.repeat(40), expectedHead: 'b'.repeat(40), expectedBaseline: 'a'.repeat(40), createdAt: '2026-10-08T00:00:00Z' }], blockers: [],
  };
  if (params.get('knowledge') === 'unbound') { target.knowledgeLifecycle.remote = undefined; target.knowledgeLifecycle.observations = []; }
  if (params.get('knowledge') === 'baseline' || params.get('knowledge') === 'integrated' || params.get('knowledge') === 'conflict') { target.result = undefined; target.phase = 'blocked'; target.runState = 'stopped'; }
  if (params.get('knowledge') === 'conflict') target.knowledgeLifecycle.proposals[0]!.author = { name: 'Synthetic Original', email: 'original@example.invalid' };
  if (params.get('knowledge') === 'conflict') target.knowledgeLifecycle.proposals[0]!.result = { operationId: 'synthetic-baseline-proposal', sourceCommit: 'c'.repeat(40), head: 'b'.repeat(40), state: 'conflict', conflicts: ['src/synthetic.ts'], capabilityVerified: false };
  if (params.get('knowledge') === 'integrated') target.knowledgeLifecycle.proposals[0]!.result = { operationId: 'synthetic-baseline-proposal', sourceCommit: 'c'.repeat(40), head: 'd'.repeat(40), state: 'integrated-awaiting-verification', conflicts: [], capabilityVerified: false };
}
if (params.has('artifacts')) {
  const target = state.demands[0]!;
  target.plan!.spec = { id: 'synthetic-spec-artifact', digest: '1'.repeat(64), location: 'synthetic-only' };
  target.plan!.tickets = { id: 'synthetic-tickets-artifact', digest: '2'.repeat(64), location: 'synthetic-only' };
  target.plan!.boundaryReviewEvidence = { id: 'synthetic-boundary-artifact', digest: '3'.repeat(64), location: 'synthetic-only' };
  target.result!.reviewEvidence = { id: 'synthetic-review-artifact', digest: '4'.repeat(64), location: 'synthetic-only' };
  target.result!.codeArtifact = { id: 'synthetic-source-artifact', digest: '5'.repeat(64), location: 'synthetic-only' };
  target.result!.knowledgeArtifacts = [{ id: 'synthetic-knowledge-artifact', digest: '6'.repeat(64), location: 'synthetic-only' }];
  target.checks![0]!.artifact = { id: 'synthetic-check-artifact', digest: '7'.repeat(64), location: 'synthetic-only' };
}
const latency = Math.min(1000, Math.max(0, Number(params.get('latency')) || 0));
const waitForSyntheticResponse = () => new Promise<void>(resolve => setTimeout(resolve, latency));
const listeners = new Set<(next: ViewState) => void>();
const publish = () => { state = { ...state, sequence: state.sequence + 1 }; for (const listener of listeners) listener(structuredClone(state)); return structuredClone(state); };
window.addEventListener('pi-kanban:synthetic-change-version', () => { state.demands[0]!.version += 1; publish(); });
window.addEventListener('pi-kanban:synthetic-change-configuration', () => { if (state.configuration) state.configuration.configurationDigest = '9'.repeat(64); publish(); });
const previewBridge: WorkbenchBridge = {
  snapshot: async () => structuredClone(state),
  subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  importConfiguration: async () => { await waitForSyntheticResponse(); state.configuration = syntheticConfiguration(); return publish(); },
  prepareModelApproval: async input => {
    await waitForSyntheticResponse();
    const demand = state.demands.find(item => item.id === input.demandId);
    if (!demand || demand.version !== input.expectedVersion) throw new Error('合成需求版本已变化。');
    if (params.get('prepare') === 'blocked') throw new Error('合成准备失败：缺少此需求的已准备工作区或冻结方法。');
    if (params.get('prepare') === 'changed' && state.configuration?.configuration.provider) {
      state.configuration.configurationDigest = 'd'.repeat(64);
      state.configuration.configuration.provider.data = [{ id: 'synthetic-prepared-exact-source', sha256: 'e'.repeat(64) }];
    }
    window.dispatchEvent(new CustomEvent('pi-kanban:synthetic-prepared', { detail: structuredClone(input) }));
    return publish();
  },
  authorizeModel: async input => { window.dispatchEvent(new CustomEvent('pi-kanban:synthetic-command', { detail: { kind: 'authorize-model', ...structuredClone(input) } })); await waitForSyntheticResponse(); throw new Error('合成配置仅用于审阅 UI，不会创建真实模型授权、发送资料或产生费用。'); },
  knowledgeAction: async input => { window.dispatchEvent(new CustomEvent('pi-kanban:synthetic-command', { detail: { kind: 'knowledge-action', ...structuredClone(input) } })); await waitForSyntheticResponse(); throw new Error('合成知识预览不会改变真实复用资格、访问远端或整合基线。'); },
  readArtifact: async input => { await waitForSyntheticResponse(); const text = `合成产物 ${input.artifactId}\n` + '合成正文：核对实际方案、任务与独立证据。\n'.repeat(850); const offset = input.offset ?? 0; const page = text.slice(offset, offset + 16_384); window.dispatchEvent(new CustomEvent('pi-kanban:synthetic-artifact-read', { detail: structuredClone(input) })); return { id: input.artifactId, digest: input.digest, kind: 'synthetic-artifact', text: page, offset, totalCharacters: text.length, nextOffset: offset + page.length < text.length ? offset + page.length : null }; },
  createProject: async () => { throw new Error('合成预览不能选择真实项目。请从桌面应用接入本地目录。'); },
  createDemand: async input => { await waitForSyntheticResponse(); state.demands.push({ ...input, id: `synthetic-${crypto.randomUUID()}`, version: 1, phase: 'idea', control: 'active', runState: 'idle', blockers: [], activities: [], messages: [] }); return publish(); },
  command: async input => { window.dispatchEvent(new CustomEvent('pi-kanban:synthetic-command', { detail: structuredClone(input) })); await waitForSyntheticResponse(); throw new Error('合成 UI 预览不执行授权、验收或运行控制。请在真实桌面 Host 中操作。'); },
  sendMessage: async input => { await waitForSyntheticResponse(); const demand = state.demands.find(item => item.id === input.demandId); if (!demand) throw new Error('找不到合成需求。'); demand.messages.push({ id: input.requestId, role: 'user', text: input.text, state: 'saved', timestamp: new Date().toISOString() }); demand.version += 1; return publish(); },
};
const root = document.getElementById('root');
if (!root) throw new Error('Missing preview root.');
createRoot(root).render(<App bridge={previewBridge} />);
