/** Isolated synthetic preview entry. Never imported by main.tsx or included in production output. */
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import type { ViewState, WorkbenchBridge } from './types.ts';
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
const params = new URLSearchParams(location.search);
let state: ViewState = params.get('view') === 'empty' ? { ...syntheticPreview, projects: [], demands: [], selected: undefined } : params.get('view') === 'onboarding' ? { ...syntheticPreview, selected: undefined } : structuredClone(syntheticPreview);
const latency = Math.min(1000, Math.max(0, Number(params.get('latency')) || 0));
const waitForSyntheticResponse = () => new Promise<void>(resolve => setTimeout(resolve, latency));
const listeners = new Set<(next: ViewState) => void>();
const publish = () => { state = { ...state, sequence: state.sequence + 1 }; for (const listener of listeners) listener(structuredClone(state)); return structuredClone(state); };
const previewBridge: WorkbenchBridge = {
  snapshot: async () => structuredClone(state),
  subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  createProject: async () => { throw new Error('合成预览不能选择真实项目。请从桌面应用接入本地目录。'); },
  createDemand: async input => { await waitForSyntheticResponse(); state.demands.push({ ...input, id: `synthetic-${crypto.randomUUID()}`, version: 1, phase: 'idea', control: 'active', runState: 'idle', blockers: [], activities: [], messages: [] }); return publish(); },
  command: async input => { window.dispatchEvent(new CustomEvent('pi-kanban:synthetic-command', { detail: structuredClone(input) })); await waitForSyntheticResponse(); throw new Error('合成 UI 预览不执行授权、验收或运行控制。请在真实桌面 Host 中操作。'); },
  sendMessage: async input => { await waitForSyntheticResponse(); const demand = state.demands.find(item => item.id === input.demandId); if (!demand) throw new Error('找不到合成需求。'); demand.messages.push({ id: input.requestId, role: 'user', text: input.text, state: 'saved', timestamp: new Date().toISOString() }); demand.version += 1; return publish(); },
};
const root = document.getElementById('root');
if (!root) throw new Error('Missing preview root.');
createRoot(root).render(<App bridge={previewBridge} />);
