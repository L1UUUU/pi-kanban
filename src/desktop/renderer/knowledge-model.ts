import type { KnowledgeAction } from '../../host/knowledge-lifecycle.ts';
import type { KnowledgeRole, SourceKind } from '../../knowledge/index.ts';
import type { Demand, ViewState } from './types.ts';
export type KnowledgeReview = { demand: Demand } & (
  | { action: 'save-candidate'; resultId: string; artifactId: string }
  | { action: 'qualify' | 'invalidate'; revisionId: string }
  | { action: 'apply-baseline' | 'verify-baseline'; proposalId: string }
  | { action: 'bind-remote' | 'observe-remote' | 'propose-baseline' }
);
export interface KnowledgeInput {
  title?: string; sourceKind?: SourceKind; statementKind?: 'fact'|'constraint'|'recommendation'|'hypothesis'; roles?: KnowledgeRole[]; modulePaths?: string; tags?: string;
  owner?: string; repository?: string; pullRequest?: string; reason?: string; baseline?: string; observationId?: string; checkIds?: string[];
  reviewed?: boolean; independentOfDemand?: boolean; sourceCommit?: string; authorName?: string; authorEmail?: string; resultId?: string;
}
export const KNOWLEDGE_LABELS: Record<KnowledgeAction['action'], string> = { 'save-candidate': '分类并保存候选', 'bind-remote': '绑定 GitHub PR', 'observe-remote': '只读核验远端', qualify: '审阅并申请复用', invalidate: '撤销复用资格', 'propose-baseline': '准备基线方案', 'apply-baseline': '授权整合此基线', 'verify-baseline': '核验整合后能力' };
export function knowledgeUnavailable(review: KnowledgeReview, state: ViewState): string | null {
  const target = review.demand, latest = state.demands.find(item => item.id === target.id);
  if (state.runtime.connection === 'disconnected') return '与本地 Host 的连接已断开。';
  if (!latest || latest.version !== target.version || JSON.stringify(latest.knowledgeLifecycle) !== JSON.stringify(target.knowledgeLifecycle)) return '需求或知识记录已变化，请关闭并重新审阅。';
  if (!target.knowledgeLifecycle) return 'Host 尚未提供知识生命周期记录。';
  if (review.action === 'observe-remote' && !target.knowledgeLifecycle.remote) return '请先绑定精确的 GitHub 仓库与 PR。';
  if (review.action === 'qualify') {
    const candidate = target.knowledgeLifecycle.candidates.find(item => item.revisionId === review.revisionId);
    if (!candidate || candidate.status === 'ineligible' || candidate.statementKind === 'hypothesis') return '请先分类候选材料；无效材料或假设不能成为共享事实。';
    if (!candidate.body.trim()) return '精确候选正文不可用，不能完成语义审阅。';
    if (!target.knowledgeLifecycle.checks.some(check => check.resultId === candidate.resultId && check.usable)) return '缺少覆盖此成果的真实原生检查，不能授予复用资格。';
    if (candidate.sourceKind === 'implementation' && !target.knowledgeLifecycle.resultMaterials.some(item => item.resultId === candidate.resultId && item.artifactId === candidate.artifactId && item.accepted)) return '请先接受此精确成果，再申请新增实现的复用资格。';
    if (candidate.sourceKind === 'implementation' && !target.knowledgeLifecycle.observations.some(item => item.state === 'merged' && item.provenance === 'github-live')) return '新增实现需要真实远端合入记录和独立最终内容核验。';
  }
  if (review.action === 'apply-baseline' || review.action === 'verify-baseline') {
    if (!['idle', 'stopped'].includes(latest.runState ?? 'unknown')) return '请先核验该需求全部执行已经停止。';
    const proposal = target.knowledgeLifecycle.proposals.find(item => item.proposalId === review.proposalId);
    if (!proposal) return '基线方案已不存在。';
    if (review.action === 'apply-baseline') {
      if (latest.control !== 'active' || latest.result || latest.phase === 'accepted') return '基线整合需要活动需求且没有受保护的待验收成果。';
      if (proposal.result?.state === 'verified' || proposal.result?.state === 'integrated-awaiting-verification') return '该方案已整合，请核验整合后的实际能力。';
      if (!proposal.result && (target.knowledgeLifecycle.baseline?.head !== proposal.expectedHead || target.knowledgeLifecycle.baseline?.current !== proposal.expectedBaseline)) return '工作区 HEAD 或基线已经变化，请重新准备方案。';
    } else if (proposal.result?.state !== 'integrated-awaiting-verification') return '请先完成整合，再选择对应实际提交的检查证据。';
  }
  return null;
}
const required = (value: string | undefined, name: string) => { if (!value?.trim()) throw new Error(`请填写${name}。`); return value.trim(); };
const commit = (value: string | undefined) => { const result = required(value, '精确提交 ID'); if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result)) throw new Error('请使用完整的 40 或 64 位提交 ID。'); return result; };
const lines = (value = '') => [...new Set(value.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
export function makeKnowledgeAction(review: KnowledgeReview, input: KnowledgeInput, requestId: string): KnowledgeAction {
  const target = review.demand, view = target.knowledgeLifecycle;
  if (!view) throw new Error('缺少 Host 知识记录。');
  const base = { demandId: target.id, expectedVersion: target.version, requestId };
  switch (review.action) {
    case 'save-candidate':
      if (!view.resultMaterials.some(item => item.resultId === review.resultId && item.artifactId === review.artifactId)) throw new Error('必须选择当前展示的精确成果材料。');
      if (!input.sourceKind || !input.statementKind || !input.roles?.length) throw new Error('请明确选择来源、陈述类型与适用角色。');
      return { ...base, action: review.action, resultId: review.resultId, artifactId: review.artifactId, title: required(input.title, '候选标题'), sourceKind: input.sourceKind, statementKind: input.statementKind, roles: [...input.roles], modulePaths: lines(input.modulePaths), tags: lines(input.tags) };
    case 'bind-remote': {
      const owner = required(input.owner, 'GitHub 所有者'), repository = required(input.repository, '仓库名称'), pullRequest = Number(input.pullRequest);
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repository) || ['.', '..'].includes(repository) || !Number.isSafeInteger(pullRequest) || pullRequest < 1) throw new Error('请提供准确的 GitHub 所有者、仓库名和正整数 PR 编号。');
      return { ...base, action: review.action, owner, repository, pullRequest };
    }
    case 'observe-remote': return { ...base, action: review.action };
    case 'qualify': {
      const candidate = view.candidates.find(item => item.revisionId === review.revisionId);
      if (!candidate || !candidate.body.trim() || candidate.status === 'ineligible' || candidate.statementKind === 'hypothesis' || !input.reviewed) throw new Error('请审阅有效候选的来源、复用价值、适用性和正文。');
      const checkIds = input.checkIds ?? [];
      if (!checkIds.length || checkIds.some(id => !view.checks.some(check => check.id === id && check.resultId === candidate.resultId && check.usable))) throw new Error('请选择覆盖此成果的真实原生检查。');
      if (candidate.sourceKind === 'implementation' && !view.observations.some(item => item.observationId === input.observationId && item.state === 'merged' && item.provenance === 'github-live')) throw new Error('请选择真实 GitHub 合入观察。');
      if (candidate.sourceKind !== 'implementation' && !input.independentOfDemand) throw new Error('请明确核对来源独立于本需求。');
      return { ...base, action: review.action, revisionId: review.revisionId, baseline: commit(input.baseline), ...(candidate.sourceKind === 'implementation' ? { observationId: input.observationId } : {}), checkIds: [...checkIds], reviewed: true, independentOfDemand: input.independentOfDemand === true, reason: required(input.reason, '核验理由与依据') };
    }
    case 'invalidate':
      if (!view.candidates.some(item => item.revisionId === review.revisionId)) throw new Error('候选版本不存在。');
      return { ...base, action: review.action, revisionId: review.revisionId, reason: required(input.reason, '撤销原因') };
    case 'propose-baseline': return { ...base, action: review.action, sourceCommit: commit(input.sourceCommit) };
    case 'apply-baseline': {
      const proposal = view.proposals.find(item => item.proposalId === review.proposalId);
      if (!input.reviewed || !proposal) throw new Error('请审阅精确基线方案并明确授权整合。');
      const author = { name: required(input.authorName, '本地提交作者姓名'), email: required(input.authorEmail, '本地提交作者邮箱') };
      if (proposal.author && (proposal.author.name !== author.name || proposal.author.email !== author.email)) throw new Error('继续整合必须使用原操作的精确作者身份。');
      return { ...base, action: review.action, proposalId: review.proposalId, author };
    }
    case 'verify-baseline': {
      const checkIds = input.checkIds ?? [], proposal = view.proposals.find(item => item.proposalId === review.proposalId);
      if (proposal?.result?.state !== 'integrated-awaiting-verification') throw new Error('该整合尚未进入待核验状态。');
      if (!input.resultId || !checkIds.length || checkIds.some(id => !view.checks.some(check => check.id === id && check.resultId === input.resultId && check.usable))) throw new Error('请选择来源成果及其真实原生检查模板。');
      return { ...base, action: review.action, operationId: review.proposalId, resultId: input.resultId, checkIds: [...checkIds] };
    }
  }
}
