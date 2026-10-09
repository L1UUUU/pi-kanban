import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ArtifactViewer } from './ArtifactViewer.tsx';
import { PlanningPanel, PlanningForm } from './Planning.tsx';
import { PLANNING_LABELS, PLANNING_STEP_LABELS, planningAttention, planningUnavailable, makePlanningCommand } from './planning-model.ts';
import type { PlanningInput, PlanningReview } from './planning-model.ts';
import type { ArtifactReview } from './artifact-model.ts';
import type { ArtifactRef } from '../../domain/types.ts';
import { ImplementationAuthorization } from './ImplementationAuthorization.tsx';
import { implementationUnavailable, makeImplementationAuthorization } from './implementation-model.ts';
import type { ImplementationInput } from './implementation-model.ts';
import { KnowledgePanel, KnowledgeForm } from './Knowledge.tsx';
import { KNOWLEDGE_LABELS, knowledgeUnavailable, makeKnowledgeAction } from './knowledge-model.ts';
import type { KnowledgeInput, KnowledgeReview } from './knowledge-model.ts';
import { DecisionsPanel, DecisionForm } from './Decisions.tsx';
import { DECISION_LABELS, decisionUnavailable, makeDecisionCommand } from './decision-model.ts';
import type { DecisionInput, DecisionReview } from './decision-model.ts';
import { Icon } from './icons.tsx';
import { ConfigurationPanel, ModelAuthorizationReview } from './Configuration.tsx';
import { LOCAL_RESOURCE_SCOPE, makeModelAuthorization, modelAuthorizationChanged, modelAuthorizationUnavailable, preparedModelReview } from './configuration-model.ts';
import { commandUnavailable, demandStatus, errorMessage, makeCommand, MESSAGE_STATES, needsAttention, PHASE_LABELS, primaryAction, reconcileSnapshot, shortId } from './model.ts';
import type { CommandKind, ConfigurationSummary, Demand, ViewState, WorkbenchBridge } from './types.ts';

type Nav = 'workspace' | 'attention' | 'ideas';
type DetailTab = 'result' | 'plan' | 'checks' | 'knowledge' | 'decisions';
type Dialog = { kind: 'planning'; review: PlanningReview } | { kind: 'artifact'; review: ArtifactReview } | { kind: 'implementation-authorization'; demand: Demand } | { kind: 'knowledge'; review: KnowledgeReview } | { kind: 'decision'; review: DecisionReview } | { kind: 'new' } | { kind: 'return'; demand: Demand } | { kind: 'cancel'; demand: Demand } | { kind: 'diagnostics' } | { kind: 'model-authorization'; demand: Demand; configuration: ConfigurationSummary } | null;
const requestId = () => crypto.randomUUID();
const timeLabel = (value?: string) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';

export function App({ bridge }: { bridge: WorkbenchBridge }) {
  const [state, setState] = useState<ViewState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<string>();
  const selectionRef = useRef(selection); selectionRef.current = selection;
  const [projectId, setProjectId] = useState<string>();
  const [nav, setNav] = useState<Nav>('workspace');
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<DetailTab>('result');
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const dialogRef = useRef<Dialog>(null); dialogRef.current = dialog;
  const [loaded, setLoaded] = useState(false);
  const [offline, setOffline] = useState(false);
  const inFlight = useRef(new Set<string>());
  const operationIds = useRef(new Map<string, string>());
  const hostSelection = useRef<string | undefined>(undefined);
  const stableRequestId = (key: string) => { let id = operationIds.current.get(key); if (!id) { id = requestId(); operationIds.current.set(key, id); } return id; };
  const stateRef = useRef<ViewState | null>(null);
  const apply = useCallback((next: ViewState) => {
    const merged = reconcileSnapshot(stateRef.current, next);
    stateRef.current = merged;
    setState(merged);
    setLoaded(true); setOffline(merged.runtime.connection === 'disconnected');
  }, []);
  const refresh = useCallback(async () => {
    try { apply(await bridge.snapshot()); setError(null); }
    catch (failure) { setError(errorMessage(failure)); setOffline(true); setLoaded(true); }
  }, [apply, bridge]);
  useEffect(() => {
    let active = true;
    let queued: ViewState | null = null;
    let frame: number | undefined;
    const unsubscribe = bridge.subscribe(next => {
      queued = reconcileSnapshot(queued, next);
      // Coalesce high-frequency display events; command controls stay outside the scroll stream.
      if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; if (active && queued) { apply(queued); queued = null; } });
    });
    void bridge.snapshot().then(next => { if (active) apply(next); }).catch(failure => { if (active) { setError(errorMessage(failure)); setOffline(true); setLoaded(true); } });
    return () => { active = false; unsubscribe(); if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [bridge, apply]);
  useEffect(() => {
    if (!state) return;
    if (selection && !state.demands.some(item => item.id === selection)) setSelection(undefined);
    if (!projectId || !state.projects.some(item => item.id === projectId)) setProjectId(state.selected?.projectId ?? state.projects[0]?.id);
    // Host notification routing may locate a demand; it must never imply a command.
    if (state.selected?.demandId && hostSelection.current !== state.selected.demandId && state.demands.some(item => item.id === state.selected?.demandId)) { hostSelection.current = state.selected.demandId; setSelection(state.selected.demandId); }
  }, [state, projectId, selection]);
  const run = useCallback(async (key: string, action: () => Promise<ViewState>, reportFailure: () => boolean = () => true): Promise<boolean> => {
    if (inFlight.current.has(key)) return false;
    inFlight.current.add(key); setPending(new Set(inFlight.current)); setError(null);
    try { apply(await action()); return true; }
    catch (failure) {
      const message = errorMessage(failure);
      // Read-only recovery only: a lost receipt never triggers an automatic repeat of a mutation.
      try { apply(await bridge.snapshot()); } catch { setOffline(true); }
      if (reportFailure()) setError(message); return false;
    } finally { inFlight.current.delete(key); setPending(new Set(inFlight.current)); }
  }, [bridge, apply]);
  const demand = state?.demands.find(item => item.id === selection);
  const selectedProject = state?.projects.find(item => item.id === (demand?.projectId ?? projectId));
  const choose = (item: Demand) => { setSelection(item.id); setProjectId(item.projectId); setError(null); };
  const execute = useCallback(async (kind: CommandKind, target: Demand, text?: string) => {
    if (offline) { setError('本地连接已断开。请重新连接后操作。'); return false; }
    const latestState = stateRef.current;
    if (latestState) { const reason = commandUnavailable(kind, latestState, target); if (reason) { setError(reason); return false; } }
    const key = kind === 'pause' || kind === 'cancel' ? `control:${target.id}` : `command:${target.id}`;
    const fingerprint = JSON.stringify([kind, target.id, target.version, target.plan?.id, target.result?.id, text]);
    const ok = await run(key, () => bridge.command(makeCommand(kind, target, stableRequestId(fingerprint), text)));
    if (ok) operationIds.current.delete(fingerprint);
    return ok;
  }, [bridge, run, offline]);
  const executeDecision = async (review: DecisionReview, input: DecisionInput) => {
    const latest = stateRef.current;
    if (!latest || offline) { setError('本地连接已断开。请重新连接后操作。'); return false; }
    const unavailable = decisionUnavailable(review, latest);
    if (unavailable) { setError(unavailable); return false; }
    const submittedDialog = dialogRef.current;
    try {
      const payload = makeDecisionCommand(review, input, '');
      const fingerprint = JSON.stringify(payload);
      payload.requestId = stableRequestId(fingerprint);
      const ok = await run(`command:${review.demand.id}`, () => bridge.command(payload), () => dialogRef.current === submittedDialog);
      if (ok) operationIds.current.delete(fingerprint);
      return ok;
    } catch (failure) { setError(errorMessage(failure)); return false; }
  };
  const reviewDecision = (review: DecisionReview) => { setError(null); setDialog({ kind: 'decision', review: structuredClone(review) }); };
  const reviewPlanning = (review: PlanningReview) => { setError(null); setDialog({ kind: 'planning', review: structuredClone(review) }); };
  const executePlanning = async (review: PlanningReview, input: PlanningInput) => {
    const latest = stateRef.current;
    if (!latest || offline) { setError('本地连接已断开。请重新连接后操作。'); return false; }
    const unavailable = planningUnavailable(review, latest);
    if (unavailable) { setError(unavailable); return false; }
    const submittedDialog = dialogRef.current;
    try {
      const payload = makePlanningCommand(review, input, '');
      const fingerprint = JSON.stringify(payload); payload.requestId = stableRequestId(fingerprint);
      const ok = await run(`command:${review.demand.id}`, () => bridge.command(payload), () => dialogRef.current === submittedDialog);
      if (ok) operationIds.current.delete(fingerprint);
      return ok;
    } catch (failure) { setError(errorMessage(failure)); return false; }
  };
  const authorizeImplementation = async (target: Demand, input: ImplementationInput) => {
    const latest = stateRef.current;
    if (!latest || offline) { setError('本地连接已断开。请重新连接后操作。'); return false; }
    const unavailable = implementationUnavailable(target, latest);
    if (unavailable) { setError(unavailable); return false; }
    const submittedDialog = dialogRef.current;
    try {
      const payload = makeImplementationAuthorization(target, input, '');
      const fingerprint = JSON.stringify(payload); payload.requestId = stableRequestId(fingerprint);
      const ok = await run(`command:${target.id}`, () => bridge.command(payload), () => dialogRef.current === submittedDialog);
      if (ok) operationIds.current.delete(fingerprint);
      return ok;
    } catch (failure) { setError(errorMessage(failure)); return false; }
  };
  const executeKnowledge = async (review: KnowledgeReview, input: KnowledgeInput) => {
    const latest = stateRef.current;
    if (!latest || offline) { setError('本地连接已断开。请重新连接后操作。'); return false; }
    const unavailable = knowledgeUnavailable(review, latest);
    if (unavailable) { setError(unavailable); return false; }
    const submittedDialog = dialogRef.current;
    try {
      const payload = makeKnowledgeAction(review, input, '');
      const fingerprint = JSON.stringify(payload); payload.requestId = stableRequestId(fingerprint);
      const ok = await run(`knowledge:${review.demand.id}`, () => bridge.knowledgeAction(payload), () => dialogRef.current === submittedDialog);
      if (ok) operationIds.current.delete(fingerprint);
      return ok;
    } catch (failure) { setError(errorMessage(failure)); return false; }
  };
  const reviewKnowledge = (review: KnowledgeReview) => { setError(null); setDialog({ kind: 'knowledge', review: structuredClone(review) }); };
  const prepareModelReview = async (target: Demand) => {
    if (offline) { setError('本地连接已断开。请重新连接后操作。'); return; }
    const submittedDialog = dialogRef.current;
    if (submittedDialog?.kind !== 'diagnostics') return;
    const prepared: { snapshot?: ViewState } = {};
    const ok = await run(`prepare-model:${target.id}`, async () => {
      prepared.snapshot = await bridge.prepareModelApproval({ demandId: target.id, expectedVersion: target.version });
      return prepared.snapshot;
    });
    if (!ok || !prepared.snapshot || dialogRef.current !== submittedDialog || selectionRef.current !== target.id) return;
    try {
      const review = preparedModelReview(stateRef.current!, prepared.snapshot, target.id);
      setDialog(current => current === submittedDialog ? { kind: 'model-authorization', ...review } : current);
    } catch (failure) { setError(errorMessage(failure)); }
  };
  const authorizeModel = async (target: Demand, configuration: ConfigurationSummary) => {
    const latest = stateRef.current;
    if (!latest || offline) { setError('本地连接已断开。请重新连接后操作。'); return false; }
    if (modelAuthorizationChanged(latest, target, configuration)) { setError('需求或配置已变化，请重新审阅模型授权。'); return false; }
    const reason = modelAuthorizationUnavailable(latest, target);
    if (reason) { setError(reason); return false; }
    const fingerprint = JSON.stringify(['authorize-model', target.id, target.version, configuration.configurationDigest, LOCAL_RESOURCE_SCOPE]);
    const ok = await run(`model:${target.id}`, () => bridge.authorizeModel(makeModelAuthorization(target, configuration, stableRequestId(fingerprint))));
    if (ok) operationIds.current.delete(fingerprint);
    return ok;
  };
  const selectProject = () => run('project', () => bridge.createProject());
  const attention = state?.demands.filter(needsAttention) ?? [];
  const ideas = state?.demands.filter(item => item.phase === 'idea' && item.control !== 'cancelled') ?? [];
  const visible = state?.demands.filter(item => {
    if (nav === 'attention' && !needsAttention(item)) return false;
    if (nav === 'ideas' && (item.phase !== 'idea' || item.control === 'cancelled')) return false;
    if (nav === 'workspace' && projectId && item.projectId !== projectId) return false;
    return !search || `${item.title} ${item.description}`.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  }) ?? [];
  const running = state?.demands.filter(item => item.runState === 'running').length ?? 0;
  const bridgeOffline = offline || state?.runtime.connection === 'disconnected';

  if (!state) return <div className="boot"><Brand large /><div className="boot-card">{!loaded ? <><div className="spinner" /><h1>正在连接本地工作区</h1><p>读取项目、需求与持久记录…</p></> : <><Icon name="alert" size={30} /><h1>暂时无法连接本地 Host</h1><p>{error}</p><button className="button primary" onClick={() => void refresh()}><Icon name="refresh" />重新连接</button></>}</div><p className="boot-note">本地优先 · 每一次执行都有明确边界</p></div>;

  return <div className={`app-shell ${detailsOpen ? '' : 'details-hidden'}`}>
    {state.preview && <div className="preview-ribbon">合成 UI 预览 · 示例内容不代表实际运行、检查通过或产品验收</div>}
    <aside className="sidebar" aria-label="项目与需求导航">
      <Brand />
      <button className="new-demand" aria-label={state.projects.length ? '新建需求' : '接入项目'} onClick={() => state.projects.length ? setDialog({ kind: 'new' }) : void selectProject()} disabled={pending.has('project') || bridgeOffline}><Icon name="plus" size={17} />{state.projects.length ? '新建需求' : '接入项目'}<span className="shortcut" aria-hidden="true">＋</span></button>
      <nav className="primary-nav" aria-label="工作区导航">
        <NavButton icon="layers" label="工作区" active={nav === 'workspace'} onClick={() => setNav('workspace')} />
        <NavButton icon="inbox" label="待处理" active={nav === 'attention'} count={attention.length} onClick={() => { setNav('attention'); setSelection(undefined); }} />
        <NavButton icon="bulb" label="想法" active={nav === 'ideas'} count={ideas.length} onClick={() => { setNav('ideas'); setSelection(undefined); }} />
      </nav>
      <div className="sidebar-divider" />
      <div className="section-label">项目<button className="icon-button" aria-label="接入另一个项目" onClick={() => void selectProject()} disabled={pending.has('project') || bridgeOffline}><Icon name="plus" size={15} /></button></div>
      <div className="project-list">
        {state.projects.map(project => <button key={project.id} className={`project-button ${projectId === project.id && nav === 'workspace' ? 'selected' : ''}`} onClick={() => { setProjectId(project.id); setNav('workspace'); if (demand?.projectId !== project.id) setSelection(undefined); }} title={project.rootPath}><span className="project-glyph">{project.name.slice(0, 1).toUpperCase()}</span><span>{project.name}</span><Icon name="chevron" size={13} /></button>)}
        {!state.projects.length && <p className="sidebar-hint">选择一个本地代码项目，<br />在这里开始新的需求。</p>}
      </div>
      <div className="section-label demand-list-title">{nav === 'attention' ? '需要你处理' : nav === 'ideas' ? '保存的想法' : '需求'}<span>{visible.length}</span></div>
      <label className="search-box"><Icon name="search" size={14} /><input aria-label="搜索需求" placeholder="搜索需求" value={search} onChange={event => setSearch(event.target.value)} />{search && <button className="icon-button" aria-label="清除搜索" onClick={() => setSearch('')}><Icon name="close" size={12} /></button>}</label>
      <div className="demand-list">
        {visible.map(item => { const status = demandStatus(item); return <button key={item.id} className={`demand-item ${selection === item.id ? 'selected' : ''}`} onClick={() => choose(item)}><span className={`status-dot ${status.tone}`} /><span className="demand-item-copy"><span>{item.title}</span><small>{status.label}</small></span>{needsAttention(item) && <span className="attention-mark" aria-label="需要处理" />}</button>; })}
        {!visible.length && <div className="list-empty">{search ? '没有找到匹配的需求' : nav === 'attention' ? '暂时没有待处理事项' : nav === 'ideas' ? '灵感先放在这里' : '还没有需求'}</div>}
      </div>
      <div className="sidebar-footer"><button className="runtime-button" onClick={() => setDialog({ kind: 'diagnostics' })}><span className={`status-dot ${bridgeOffline ? 'warning' : 'success'}`} /><span><strong>{bridgeOffline ? '本地 Host 已断开' : '本地 Host 已连接'}</strong><small>{state.runtime.executionEnabled ? `${running} 条需求实际运行中` : '自主执行尚未启用'}</small></span><Icon name="settings" size={16} /></button><div className="sidebar-footnote"><span>PI KANBAN</span><span>LOCAL FIRST</span></div></div>
    </aside>
    <section className="workspace">
      <header className="workspace-header"><div className="breadcrumb"><Icon name="folder" size={15} /><span>{selectedProject?.name ?? '你的工作区'}</span><Icon name="chevron" size={12} /><span className="breadcrumb-current">{demand ? '需求工作区' : nav === 'attention' ? '待处理' : nav === 'ideas' ? '想法' : '开始'}</span></div><div className="header-tools">{running > 0 && <span className="live-count"><span className="status-dot live" />{running} 条运行中</span>}<button className="icon-button" title="重新读取状态" aria-label="重新读取状态" onClick={() => void refresh()}><Icon name="refresh" size={16} /></button><button className={`icon-button ${detailsOpen ? 'is-active' : ''}`} title="切换详情面板" aria-label="切换详情面板" aria-pressed={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}><Icon name="panel" size={17} /></button></div></header>
      {bridgeOffline && <div className="connection-banner" role="status"><Icon name="alert" size={16} /><span>连接已中断。当前展示最近读取的记录，执行状态可能已变化。</span><button onClick={() => void refresh()}>重新连接</button></div>}
      {error && <div className="error-banner" role="alert"><Icon name="alert" size={17} /><span>{error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={() => setError(null)}><Icon name="close" size={15} /></button></div>}
      {demand ? <>
        <DemandHeader decisions={() => { setTab('decisions'); setDetailsOpen(true); }} demand={demand} pending={pending} offline={!!bridgeOffline} execute={execute} cancel={() => setDialog({ kind: 'cancel', demand })} />
        <ActionBar readPlan={() => { setTab('plan'); setDetailsOpen(true); }} authorize={() => { setError(null); setDialog({ kind: 'implementation-authorization', demand: structuredClone(demand) }); }} state={state} demand={demand} pending={pending} offline={!!bridgeOffline} execute={execute} returnResult={() => setDialog({ kind: 'return', demand })} diagnostics={() => setDialog({ kind: 'diagnostics' })} />
        <Conversation demand={demand} />
        <Composer key={demand.id} demand={demand} disabled={!!bridgeOffline} pending={pending.has(`message:${demand.id}`)} model={state.runtime.model} onSend={async text => { const fingerprint = JSON.stringify(['message', demand.id, text]); const ok = await run(`message:${demand.id}`, () => bridge.sendMessage({ demandId: demand.id, text, requestId: stableRequestId(fingerprint) })); if (ok) operationIds.current.delete(fingerprint); return ok; }} />
      </> : <Welcome state={state} nav={nav} attention={attention} choose={choose} newDemand={() => setDialog({ kind: 'new' })} chooseProject={() => void selectProject()} pending={pending.has('project')} diagnostics={() => setDialog({ kind: 'diagnostics' })} />}
      <footer className="workspace-status"><span><Icon name="shield" size={12} />{state.preview ? '合成预览 · 无真实执行' : '用户控制与 Agent 输出分离'}</span><span>{demand ? `需求版本 ${demand.version}` : `${state.projects.length} 个本地项目`}<span className="status-separator">·</span>{state.runtime.platform}</span></footer>
    </section>
    {detailsOpen && <Inspector onPlanning={reviewPlanning} onArtifact={review => { setError(null); setDialog({ kind: 'artifact', review: structuredClone(review) }); }} onKnowledge={reviewKnowledge} knowledgePending={!!demand && pending.has(`knowledge:${demand.id}`)} offline={!!bridgeOffline} pending={!!demand && (pending.has(`command:${demand.id}`) || pending.has(`control:${demand.id}`))} onReview={reviewDecision} state={state} demand={demand} tab={tab} setTab={setTab} diagnostics={() => setDialog({ kind: 'diagnostics' })} />}
    {dialog && <DialogView onPlanning={async (review, input) => { const submittedDialog = dialog; if (await executePlanning(review, input)) setDialog(current => current === submittedDialog ? null : current); }} bridge={bridge} onImplementation={async (target, input) => { const submittedDialog = dialog; if (await authorizeImplementation(target, input)) setDialog(current => current === submittedDialog ? null : current); }} onKnowledge={async (review, input) => { const submittedDialog = dialog; if (await executeKnowledge(review, input)) setDialog(current => current === submittedDialog ? null : current); }} key={dialog.kind === 'planning' ? JSON.stringify(['planning', dialog.review.kind, dialog.review.demand.id, dialog.review.demand.version, dialog.review.demand.planningFlow?.revision, 'questionId' in dialog.review ? dialog.review.questionId : '', 'scope' in dialog.review ? dialog.review.scope : '']) : dialog.kind === 'knowledge' ? JSON.stringify(['knowledge', dialog.review.action, dialog.review.demand.id, dialog.review.demand.version, 'revisionId' in dialog.review ? dialog.review.revisionId : '', 'proposalId' in dialog.review ? dialog.review.proposalId : '', 'artifactId' in dialog.review ? [dialog.review.resultId, dialog.review.artifactId] : []]) : dialog.kind === 'implementation-authorization' ? `implementation:${dialog.demand.id}:${dialog.demand.version}:${dialog.demand.plan?.id}` : dialog.kind === 'artifact' ? `artifact:${dialog.review.demandId}:${dialog.review.artifact.id}:${dialog.review.artifact.digest}` : dialog.kind === 'decision' ? `${dialog.kind}:${dialog.review.kind}:${dialog.review.demand.id}:${dialog.review.demand.version}:${dialog.review.kind === 'decide-finding' ? dialog.review.findingId : ''}` : dialog.kind} onDecision={async (review, input) => { const submittedDialog = dialog; if (await executeDecision(review, input)) setDialog(current => current === submittedDialog ? null : current); }} dialog={dialog} error={error} state={state} projectId={projectId} selectedDemand={demand} offline={!!bridgeOffline} pending={pending} onImport={() => { void run('import-configuration', () => bridge.importConfiguration()); }} onReviewModel={target => { void prepareModelReview(target); }} onBackToDiagnostics={() => { setError(null); setDialog({ kind: 'diagnostics' }); }} onAuthorizeModel={async (target, configuration) => { const submittedDialog = dialog; if (await authorizeModel(target, configuration)) setDialog(current => current === submittedDialog ? { kind: 'diagnostics' } : current); }} close={() => setDialog(null)} onCreate={async input => { const submittedDialog = dialog; const before = new Set(state.demands.map(item => item.id)); const ok = await run('create-demand', () => bridge.createDemand(input)); if (ok && dialogRef.current === submittedDialog) { const created = stateRef.current?.demands.find(item => item.id === stateRef.current?.selected?.demandId || !before.has(item.id)); if (created) { choose(created); setNav('workspace'); } setDialog(current => current === submittedDialog ? null : current); } }} onControl={async (kind, target, text) => { const submittedDialog = dialog; if (await execute(kind, target, text)) setDialog(current => current === submittedDialog ? null : current); }} refresh={refresh} />}
  </div>;
}

function Brand({ large = false }: { large?: boolean }) { return <div className={`brand ${large ? 'large' : ''}`}><span className="brand-symbol" aria-hidden="true"><i /><i /><i /></span><span>pi<span className="brand-light"> kanban</span></span><span className="brand-tag">WORKSPACE</span></div>; }
function NavButton({ icon, label, active, count, onClick }: { icon: Parameters<typeof Icon>[0]['name']; label: string; active: boolean; count?: number; onClick: () => void }) { return <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick} aria-current={active ? 'page' : undefined}><Icon name={icon} size={17} /><span>{label}</span>{count !== undefined && count > 0 && <span className="nav-count">{count}</span>}</button>; }
function StatusPill({ demand }: { demand: Demand }) { const status = demandStatus(demand); return <span className={`status-pill ${status.tone}`}><span className={`status-dot ${status.tone}`} />{status.label}</span>; }
function DemandHeader({ demand, pending, offline, execute, cancel, decisions }: { demand: Demand; pending: Set<string>; offline: boolean; execute: (kind: CommandKind, demand: Demand) => Promise<boolean>; cancel: () => void; decisions: () => void }) {
  const stoppable = demand.control === 'active' && demand.phase !== 'idea' && demand.phase !== 'accepted';
  return <div className="demand-header"><div className="demand-eyebrow"><span>需求</span><span className="mono">{shortId(demand.id)}</span></div><div className="demand-title-row"><h1>{demand.title}</h1><div className="demand-controls"><button className="button compact" onClick={decisions}>方案与决定</button>{stoppable && <button className="button compact" disabled={offline || pending.has(`control:${demand.id}`) || demand.runState === 'stopping'} onClick={() => void execute('pause', demand)}><Icon name="pause" size={13} />{demand.runState === 'stopping' ? '正在停止' : '暂停'}</button>}{demand.control !== 'cancelled' && demand.phase !== 'accepted' && <button className="icon-button subdued" aria-label="取消这条需求" title="取消这条需求（保留内容）" onClick={cancel} disabled={offline || pending.has(`control:${demand.id}`)}><Icon name="stop" size={14} /></button>}</div></div><div className="demand-meta"><StatusPill demand={demand} /><span className="meta-divider" /><span><Icon name="branch" size={13} />{demand.branch ?? '独立工作区待准备'}</span><span className="phase-label">当前阶段：{demand.planningFlow && demand.planningFlow.step !== 'complete' ? PLANNING_STEP_LABELS[demand.planningFlow.step] : PHASE_LABELS[demand.phase]}</span></div></div>;
}
function ActionBar({ state, demand, pending, offline, execute, returnResult, diagnostics, authorize, readPlan }: { readPlan: () => void; authorize: () => void; state: ViewState; demand: Demand; pending: Set<string>; offline: boolean; execute: (kind: CommandKind, demand: Demand) => Promise<boolean>; returnResult: () => void; diagnostics: () => void }) {
  const action = primaryAction(demand);
  const unavailable = action && commandUnavailable(action.kind, state, demand);
  const executionBlocked = !!action && !state.runtime.executionEnabled && ['start-planning', 'authorize-implementation', 'resume'].includes(action.kind);
  const actionLabel = executionBlocked ? action?.kind === 'start-planning' ? '记录规划请求' : action?.kind === 'authorize-implementation' ? '保存实施授权' : '记录继续请求' : action?.label;
  const busy = pending.has(`command:${demand.id}`) || pending.has(`control:${demand.id}`);
  if (demand.control === 'cancelled') return <div className="action-bar muted"><Icon name="stop" size={18} /><div><strong>这条需求已取消</strong><p>代码、会话和已有成果继续保留。</p></div></div>;
  if (demand.runState === 'stopping' || demand.runState === 'unknown') return <div className="action-bar warning"><Icon name="alert" size={19} /><div><strong>{demand.runState === 'stopping' ? '停止请求已保存，正在等待实际停写' : '旧执行状态尚未核实'}</strong><p>在确认受控进程已经停止前，工作区不可接管。</p></div><button className="button compact" onClick={diagnostics}>查看诊断</button></div>;
  const planningDecision = planningAttention(demand);
  if (planningDecision && (!action || action.kind !== 'resume')) return <div className="action-bar actionable"><Icon name="file" size={19} /><div className="action-copy"><strong>{planningDecision}</strong><p>请审阅当前阶段的记录并保存明确决定。有效确认会保留，实施授权单独处理。</p><span className="object-binding">绑定规划 <span className="mono">{demand.planningFlow!.id} · {demand.planningFlow!.revision}</span></span></div><button className="button primary compact" onClick={readPlan}>查看规划与决定</button></div>;
  if (!action && !demand.blockers.length && demand.phase !== 'blocked') return null;
  return <div className={`action-bar ${demand.blockers.length || unavailable || executionBlocked ? 'warning' : 'actionable'}`}><Icon name={demand.phase === 'awaiting-acceptance' ? 'shield' : demand.blockers.length || unavailable ? 'alert' : 'spark'} size={19} /><div className="action-copy"><strong>{demand.blockers.length ? '此需求需要处理' : action?.label ?? '当前工作被阻塞'}</strong><p>{demand.blockers[0] ?? action?.description ?? '查看诊断，核实继续所需条件。'}</p>{(action?.kind === 'confirm-plan' || action?.kind === 'authorize-implementation') && <span className="object-binding">绑定方案 <span className="mono">{demand.plan?.id}</span></span>}{action?.kind === 'accept-result' && <span className="object-binding">绑定成果 <span className="mono">{demand.result?.id}</span></span>}{unavailable && <span className="action-reason">{unavailable}</span>}{executionBlocked && <span className="action-reason">运行条件尚未通过。此操作只保存明确决定，不会立即启动执行。</span>}</div><div className="action-buttons">{(action?.kind === 'confirm-plan' || action?.kind === 'authorize-implementation') && <button className="button compact" onClick={readPlan}>阅读方案与任务</button>}{action && !unavailable && <button className="button primary compact" disabled={offline || busy} onClick={() => action.kind === 'authorize-implementation' ? authorize() : void execute(action.kind, demand)}>{busy ? '正在保存…' : actionLabel}{!busy && <Icon name="arrow" size={14} />}</button>}{demand.phase === 'awaiting-acceptance' && demand.result && <button className="button compact" disabled={offline || busy} onClick={returnResult}>退回返工</button>}{(unavailable || executionBlocked || demand.blockers.length > 0 || !action) && <button className="button compact" onClick={diagnostics}>运行诊断</button>}</div></div>;
}

function Conversation({ demand }: { demand: Demand }) {
  const [showAll, setShowAll] = useState(false);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  useEffect(() => { setShowAll(false); followLatest.current = true; setAwayFromLatest(false); }, [demand.id]);
  useEffect(() => { if (followLatest.current) { const node = scrollRef.current; if (node) node.scrollTop = node.scrollHeight; } }, [demand.id, demand.messages.length, demand.activities.length]);
  const entries = [
    ...demand.messages.map((message, index) => ({ type: 'message' as const, value: message, order: message.timestamp ? Date.parse(message.timestamp) : index })),
    ...demand.activities.map((activity, index) => ({ type: 'activity' as const, value: activity, order: activity.timestamp ? Date.parse(activity.timestamp) : demand.messages.length + index })),
  ].sort((a, b) => (Number.isFinite(a.order) ? a.order : 0) - (Number.isFinite(b.order) ? b.order : 0));
  const visible = showAll ? entries : entries.slice(-120);
  return <div className="conversation" ref={scrollRef} onScroll={() => { const node = scrollRef.current; if (node) { followLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 90; setAwayFromLatest(!followLatest.current); } }} aria-label="Agent 会话与工具活动"><div className="conversation-inner"><div className="stream-divider"><span>需求上下文</span><span>原始目标</span></div><article className="context-message"><span className="avatar user-avatar">你</span><div><div className="message-label">需求描述<span>已记录</span></div><p className="safe-text">{demand.description || '尚未补充具体描述。可以在下方添加目标、约束和验收要求。'}</p></div></article><div className="stream-divider"><span><Icon name="spark" size={13} />Agent 工作流</span><span>{entries.length ? `${demand.activities.length} 条活动` : '等待开始'}</span></div>
    {!entries.length && <div className="session-empty"><div className="session-empty-icon"><Icon name="spark" size={25} /></div><h2>{demand.phase === 'idea' ? '想法已经有了自己的位置' : '还没有 Agent 会话记录'}</h2><p>{demand.phase === 'idea' ? '准备好后开始规划。Agent 会调查代码、明确设计，并把需要你决定的问题留在这里。' : '只有真实接入的运行消息与工具事件会显示在这里。'}</p><div className="session-guidance"><span><Icon name="file" size={15} />先规划并确认方案</span><span><Icon name="shield" size={15} />实施需要明确授权</span><span><Icon name="check" size={15} />每轮成果由你验收</span></div></div>}
    {!showAll && entries.length > 120 && <button className="older-button" onClick={() => setShowAll(true)}>查看更早的 {entries.length - 120} 条记录</button>}
    {visible.map(entry => entry.type === 'message' ? <article key={`message:${entry.value.id}`} className={`message ${entry.value.role}`}><span className={`avatar ${entry.value.role === 'user' ? 'user-avatar' : 'agent-avatar'}`}>{entry.value.role === 'user' ? '你' : <Icon name={entry.value.role === 'agent' ? 'spark' : 'shield'} size={16} />}</span><div className="message-content"><div className="message-label">{entry.value.role === 'user' ? '你' : entry.value.role === 'agent' ? 'Agent' : '平台记录'}{entry.value.stage && <span>{entry.value.stage}</span>}<time>{timeLabel(entry.value.timestamp)}</time></div><p className="safe-text">{entry.value.text}</p>{entry.value.state && <span className={`message-receipt ${entry.value.state}`} title={MESSAGE_STATES[entry.value.state].explanation}><Icon name={entry.value.state === 'applied' ? 'check' : entry.value.state === 'delivered' ? 'arrow' : 'clock'} size={11} />{MESSAGE_STATES[entry.value.state].label}</span>}</div></article> : <details key={`activity:${entry.value.id}`} className={`activity ${entry.value.status ?? ''}`}><summary><span className="activity-symbol"><Icon name={entry.value.kind === 'tool' ? 'terminal' : entry.value.kind === 'workflow' ? 'layers' : entry.value.kind === 'notice' ? 'alert' : 'clock'} size={14} /></span><span className="activity-title">{entry.value.title}</span><span className="activity-state">{entry.value.status === 'running' ? '运行中' : entry.value.status === 'complete' ? '已记录' : entry.value.status === 'failed' ? '失败' : entry.value.status === 'waiting' ? '等待' : '事件'}</span><time>{timeLabel(entry.value.timestamp)}</time><Icon name="chevron" size={12} /></summary><div className="activity-detail"><span className="activity-origin">{entry.value.kind === 'tool' ? '工具输出' : entry.value.kind === 'runtime' ? '运行事件' : '平台事件'}</span><pre>{entry.value.detail ?? '此事件未附加详细输出。'}</pre></div></details>)}
    {demand.runState === 'running' && demand.control === 'active' && <div className="live-line"><span className="status-dot live" />受控执行正在运行<span>以实际交接记录判断阶段成果</span></div>}
  </div>{awayFromLatest && entries.length > 3 && <button className="jump-latest" onClick={() => { const node = scrollRef.current; if (node) { node.scrollTop = node.scrollHeight; followLatest.current = true; setAwayFromLatest(false); } }}>回到最新记录<Icon name="arrow" size={12} /></button>}</div>;
}
function Composer({ demand, disabled, pending, model, onSend }: { demand: Demand; disabled: boolean; pending: boolean; model?: string; onSend: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(false);
  const submit = async (event?: FormEvent) => { event?.preventDefault(); if (!text.trim() || pending || disabled) return; const sent = text.trim(); if (await onSend(sent)) { setText(current => current.trim() === sent ? '' : current); setSaved(true); } };
  return <div className="composer-wrap"><form className={`composer ${disabled ? 'disabled' : ''}`} onSubmit={event => void submit(event)}><textarea aria-label="给这条需求补充消息" value={text} onChange={event => { setText(event.target.value); setSaved(false); }} placeholder={disabled ? '连接恢复后可继续发送消息' : '补充背景、询问进展，或讨论下一步…'} rows={2} maxLength={20000} disabled={disabled} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} /><div className="composer-toolbar"><span><Icon name="spark" size={13} />{model ?? '模型尚未启用'}</span><span className="composer-draft">{pending ? '正在保存…' : saved ? '已保存到本需求' : text.length ? '未发送' : ''}</span><button className="send-button" type="submit" aria-label="发送消息" title="发送消息（Ctrl / ⌘ + Enter）" disabled={!text.trim() || pending || disabled}><Icon name="send" size={17} /></button></div></form><div className="composer-caption"><span>消息与此需求关联。确认、授权和验收使用上方明确操作。</span><span>Ctrl / ⌘ ↵ 发送</span></div></div>;
}

function Welcome({ state, nav, attention, choose, newDemand, chooseProject, pending, diagnostics }: { state: ViewState; nav: Nav; attention: Demand[]; choose: (demand: Demand) => void; newDemand: () => void; chooseProject: () => void; pending: boolean; diagnostics: () => void }) {
  if (nav === 'attention') return <div className="overview"><div className="overview-eyebrow">保持每个决定清晰可见</div><h1>待处理</h1><p className="overview-description">需要你确认的方案、授权、稳定成果和阻塞事项。</p>{!attention.length ? <div className="overview-empty"><Icon name="inbox" size={35} /><h2>暂时没有需要处理的事</h2><p>需要你决定时，它会留在这里。系统通知被关闭也不会丢失。</p></div> : <div className="attention-list">{attention.map(item => <button key={item.id} onClick={() => choose(item)}><span className="attention-list-icon"><Icon name={item.result ? 'shield' : 'alert'} size={19} /></span><span><strong>{item.title}</strong><small>{item.blockers[0] ?? demandStatus(item).label}</small></span><Icon name="arrow" size={17} /></button>)}</div>}</div>;
  return <div className="welcome"><div className="welcome-topline"><span className="welcome-line" /><span>从一个值得实现的想法开始</span></div><div className="welcome-mark"><Icon name="spark" size={38} /></div><h1>{nav === 'ideas' ? '先记下来，准备好再开始。' : state.projects.length ? '给下一件事，一个专注的工作区。' : '想法到成果，始终有迹可循。'}</h1><p>在同一处规划、协作、检查和验收。<br />Agent 负责推进，你掌握每个关键决定。</p><button className="button primary welcome-action" disabled={pending || state.runtime.connection === 'disconnected'} onClick={state.projects.length ? newDemand : chooseProject}><Icon name={state.projects.length ? 'plus' : 'folder'} size={17} />{pending ? '正在打开目录选择器…' : state.projects.length ? '记录一条新需求' : '选择本地项目'}<Icon name="arrow" size={16} /></button><span className="welcome-note">{state.projects.length ? '先保存为想法，准备好后再开始规划。' : '接入项目只建立本地记录，不会自动启动开发。'}</span><div className="welcome-steps"><div><span>01</span><Icon name="bulb" size={19} /><strong>明确需求</strong><p>把目标、约束和想法<br />放进独立工作区</p></div><div><span>02</span><Icon name="terminal" size={19} /><strong>有边界地推进</strong><p>方案与实施分别确认<br />实际过程随时可查</p></div><div><span>03</span><Icon name="shield" size={19} /><strong>带着证据交付</strong><p>稳定成果、检查与经验<br />为每一次验收准备好</p></div></div>{!state.runtime.executionEnabled && <button className="welcome-prerequisite" onClick={diagnostics}><Icon name="alert" size={15} /><span>可以先记录想法。自主执行前，还有运行条件需要准备。</span><Icon name="chevron" size={13} /></button>}</div>;
}

function Inspector({ state, demand, tab, setTab, diagnostics, offline, pending, onReview, onKnowledge, knowledgePending, onArtifact, onPlanning }: { onPlanning: (review: PlanningReview) => void; onArtifact: (review: ArtifactReview) => void; onKnowledge: (review: KnowledgeReview) => void; knowledgePending: boolean; offline: boolean; pending: boolean; onReview: (review: DecisionReview) => void; state: ViewState; demand?: Demand; tab: DetailTab; setTab: (tab: DetailTab) => void; diagnostics: () => void }) {
  const tabs: { id: DetailTab; label: string }[] = [{ id: 'result', label: '成果' }, { id: 'plan', label: '方案' }, { id: 'checks', label: '检查' }, { id: 'knowledge', label: '经验' }, { id: 'decisions', label: '决定' }];
  return <aside className="inspector" aria-label="需求详情"><div className="inspector-heading"><span>工作详情</span><Icon name="layers" size={15} /></div><div className="detail-tabs" role="tablist" aria-label="详情分类">{tabs.map(item => <button key={item.id} role="tab" id={`tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`panel-${item.id}`} onClick={() => setTab(item.id)}>{item.label}{item.id === 'checks' && demand?.checks?.length ? <span>{demand.checks.length}</span> : null}</button>)}</div><div className="inspector-body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
    {!demand ? <><div className="detail-placeholder"><span className="detail-placeholder-icon"><Icon name="file" size={27} /></span><h2>重要的内容，随时在手边</h2><p>选中一条需求，就能查看它的有效方案、稳定成果、检查证据和本地经验。</p></div><div className="principle-card"><span className="eyebrow">你的工作方式</span><h3>每个阶段，都有明确依据。</h3><ul><li><Icon name="check" size={13} />规划与实施分别授权</li><li><Icon name="check" size={13} />检查绑定稳定的内容版本</li><li><Icon name="check" size={13} />成果由你最终接受</li></ul></div></> : tab === 'decisions' ? <><PlanningPanel state={state} demand={demand} offline={offline} pending={pending} onReview={onPlanning} onArtifact={onArtifact} /><DecisionsPanel state={state} demand={demand} offline={offline} pending={pending} onReview={onReview} diagnostics={diagnostics} /></> : tab === 'result' ? <><SectionTitle icon="layers" title="稳定成果" caption="每一轮，都有独立的版本" />{demand.result ? <><div className="result-card"><div className="result-card-top"><Icon name="shield" size={20} /><span className={`tiny-pill ${demand.result.accepted ? 'success' : ''}`}>{demand.result.accepted ? '已接受此成果' : demand.phase === 'awaiting-acceptance' ? '待人工验收' : '已保存的成果'}</span></div><h3>{demand.result.accepted ? '这一轮成果已接受' : '当前成果记录'}</h3><p className="safe-text">{demand.result.notes || '未附交付说明。'}</p><div className="artifact-actions"><ArtifactButton demand={demand} artifact={demand.result.reviewEvidence} label="阅读独立 Review 证据" onRead={onArtifact} /><ArtifactButton demand={demand} artifact={demand.result.codeArtifact} label="阅读精确代码快照" onRead={onArtifact} />{demand.result.knowledgeArtifacts?.map(artifact => <ArtifactButton key={artifact.id} demand={demand} artifact={artifact} label={`阅读经验材料 ${artifact.id}`} onRead={onArtifact} />)}</div><Metadata label="成果对象" value={demand.result.id} /><Metadata label="内容版本" value={demand.result.contentId} />{demand.result.codeRef && <Metadata label="代码引用" value={demand.result.codeRef} />}</div><div className="info-note"><Icon name="link" size={14} /><p>验收绑定此轮成果。远端推送、MR 和合入状态需分别核验。</p></div></> : <DetailEmpty icon="layers" title="还没有稳定成果" text="实施、必要检查和独立 Review 完成后，可验收的成果会出现在这里。" />}<SectionTitle icon="folder" title="需求工作区" />{demand.workspacePath ? <><Metadata label="路径" value={demand.workspacePath} />{demand.branch && <Metadata label="分支" value={demand.branch} />}</> : <p className="detail-muted">尚未提供已核验的需求工作区。</p>}<SectionTitle icon="alert" title="限制与待处理" />{demand.blockers.length ? <ul className="blocker-list">{demand.blockers.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="detail-muted">当前没有记录的需求级阻塞。</p>}</> : tab === 'plan' ? <><PlanningPanel state={state} demand={demand} offline={offline} pending={pending} onReview={onPlanning} onArtifact={onArtifact} /><SectionTitle icon="file" title="有效方案" caption="实施遵循当前已确认的范围" />{demand.plan ? <><div className="plan-state"><span className={`status-dot ${demand.plan.confirmed ? 'success' : 'warning'}`} />{demand.plan.confirmed ? '此版本已确认' : demand.plan.ready ? '等待确认此版本' : '规划产物尚未就绪'}</div><Metadata label="方案对象" value={demand.plan.id} /><div className="artifact-actions"><ArtifactButton demand={demand} artifact={demand.plan.spec} label="阅读完整 Spec" onRead={onArtifact} /><ArtifactButton demand={demand} artifact={demand.plan.tickets} label="阅读完整任务清单" onRead={onArtifact} /><ArtifactButton demand={demand} artifact={demand.plan.boundaryReviewEvidence} label="阅读边界审查证据" onRead={onArtifact} /></div><p className="plan-scope safe-text">{demand.plan.scope}</p>{demand.plan.specPath && <Metadata label="Spec 引用" value={demand.plan.specPath} />}<SectionTitle icon="check" title="方案要求的检查" />{demand.plan.requiredChecks?.length ? <ul className="plain-list">{demand.plan.requiredChecks.map((item, index) => <li key={index}><Icon name="check" size={12} />{item}</li>)}</ul> : <p className="detail-muted">尚未提供检查要求清单。</p>}</> : !demand.planningFlow && <DetailEmpty icon="file" title="方案还未就绪" text="开始规划后，Agent 会调查代码、组织边界审查，形成可确认的方案。" />}</> : tab === 'checks' ? <><SectionTitle icon="shield" title="必要检查与 Review" caption="检查依据必须对应实际内容" />{demand.checks?.length ? <div className="check-list">{demand.checks.map(check => <details key={check.id} className={`check-card ${check.status}`}><summary><span className="check-icon"><Icon name={check.status === 'passed' ? 'check' : check.status === 'failed' ? 'close' : 'clock'} size={14} /></span><span>{check.name}</span><small>{check.status === 'passed' ? '通过' : check.status === 'failed' ? '失败' : check.status === 'unavailable' ? '无法验证' : '待检查'}</small></summary><div>{check.contentId && <Metadata label="内容版本" value={check.contentId} />}<p className="safe-text">{check.evidence ?? '未附可展示的证据。'}</p><ArtifactButton demand={demand} artifact={check.artifact} label="阅读完整检查证据" onRead={onArtifact} /></div></details>)}</div> : <DetailEmpty icon="shield" title="尚无检查证据" text="没有记录不等于已通过。必要检查会按项目规则与当前方案执行。" />}<div className="info-note"><Icon name="shield" size={15} /><p>模型停止输出、工具退出或提交成功，都不能单独证明质量检查已完成。</p></div></> : demand.knowledgeLifecycle ? <KnowledgePanel state={state} demand={demand} offline={offline} pending={pending || knowledgePending} onReview={onKnowledge} /> : <><SectionTitle icon="book" title="本地项目经验" caption="来源、证据与适用条件清楚可查" />{demand.knowledge?.length ? <div className="knowledge-list">{demand.knowledge.map(item => <article className="knowledge-card" key={item.id}><span className={`tiny-pill ${item.status === 'verified' ? 'success' : ''}`}>{item.status === 'verified' ? '已核验' : item.status === 'candidate' ? '本轮候选' : '暂不可复用'}</span><h3>{item.title}</h3><p className="safe-text">{item.detail}</p>{item.source && <Metadata label="来源" value={item.source} />}</article>)}</div> : <DetailEmpty icon="book" title="还没有关联经验" text="只保留值得复用的内容。零新增、零命中也是正常结果。" />}<div className="info-note"><Icon name="book" size={15} /><p>候选经验不会自动成为共享事实。可复用资格和当前代码的适用性分别核验。</p></div></>}
  </div><button className="inspector-runtime" onClick={diagnostics}><span className={`status-dot ${state.runtime.executionEnabled ? 'success' : 'warning'}`} /><span>{state.runtime.executionEnabled ? '运行前置条件已通过' : '运行前置条件待准备'}</span><Icon name="chevron" size={14} /></button></aside>;
}
function ArtifactButton({ demand, artifact, label, onRead }: { demand: Demand; artifact?: ArtifactRef; label: string; onRead: (review: ArtifactReview) => void }) { return artifact ? <button className="button compact" onClick={() => onRead({ demandId: demand.id, version: demand.version, title: label, artifact })}><Icon name="file" size={13} />{label}</button> : null; }
function SectionTitle({ icon, title, caption }: { icon: Parameters<typeof Icon>[0]['name']; title: string; caption?: string }) { return <div className="detail-section-title"><h2><Icon name={icon} size={15} />{title}</h2>{caption && <p>{caption}</p>}</div>; }
function DetailEmpty({ icon, title, text }: { icon: Parameters<typeof Icon>[0]['name']; title: string; text: string }) { return <div className="detail-empty"><Icon name={icon} size={24} /><h3>{title}</h3><p>{text}</p></div>; }
function Metadata({ label, value }: { label: string; value: string }) { return <div className="metadata"><span>{label}</span><code>{value}</code></div>; }

function Modal({ title, subtitle, children, close, wide = false }: { title: string; subtitle?: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusable = () => Array.from(node?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? []);
    if (!node?.contains(document.activeElement)) focusable()[0]?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
      if (event.key === 'Tab') { const items = focusable(); const first = items[0]; const last = items.at(-1); if (!first) return; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
    };
    document.addEventListener('keydown', handle); return () => { document.removeEventListener('keydown', handle); previous?.focus(); };
  }, [close]);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><div className={`modal ${wide ? 'modal-wide' : ''}`} ref={ref} role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header><div><h2 id="dialog-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="关闭对话框" onClick={close}><Icon name="close" size={18} /></button></header>{children}</div></div>;
}
function DialogView({ dialog, error, state, projectId, selectedDemand, offline, pending, close, onCreate, onControl, onImport, onReviewModel, onAuthorizeModel, onBackToDiagnostics, refresh, onDecision, onKnowledge, onImplementation, bridge, onPlanning }: { onPlanning: (review: PlanningReview, input: PlanningInput) => Promise<void>; bridge: WorkbenchBridge; onImplementation: (target: Demand, input: ImplementationInput) => Promise<void>; onKnowledge: (review: KnowledgeReview, input: KnowledgeInput) => Promise<void>; onDecision: (review: DecisionReview, input: DecisionInput) => Promise<void>; dialog: NonNullable<Dialog>; error: string | null; state: ViewState; projectId?: string; selectedDemand?: Demand; offline: boolean; pending: Set<string>; onImport: () => void; onReviewModel: (target: Demand) => void; onAuthorizeModel: (target: Demand, configuration: ConfigurationSummary) => Promise<void>; onBackToDiagnostics: () => void; close: () => void; onCreate: (input: { projectId: string; title: string; description: string; requestId: string }) => Promise<void>; onControl: (kind: CommandKind, demand: Demand, text?: string) => Promise<void>; refresh: () => Promise<void> }) {
  const projectSelectId = useId();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [project, setProject] = useState(projectId ?? state.projects[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const createRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  const createId = () => { const fingerprint = JSON.stringify([project, title.trim(), description.trim()]); if (createRequest.current?.fingerprint !== fingerprint) createRequest.current = { fingerprint, id: requestId() }; return createRequest.current.id; };
  const closeRef = useRef(close); closeRef.current = close;
  const stableClose = useCallback(() => closeRef.current(), []);
  if (dialog.kind === 'planning') return <Modal wide title={PLANNING_LABELS[dialog.review.kind]} subtitle={dialog.review.demand.title} close={stableClose}><PlanningForm review={dialog.review} state={state} offline={offline} pending={pending.has(`command:${dialog.review.demand.id}`) || pending.has(`control:${dialog.review.demand.id}`)} error={error} onSubmit={input => void onPlanning(dialog.review, input)} close={stableClose} /></Modal>;
  if (dialog.kind === 'artifact') return <Modal wide title={dialog.review.title} subtitle="只读审阅精确产物" close={stableClose}><ArtifactViewer review={dialog.review} bridge={bridge} close={stableClose} /></Modal>;
  if (dialog.kind === 'implementation-authorization') return <Modal wide title="确认实施授权" subtitle={dialog.demand.title} close={stableClose}><ImplementationAuthorization target={dialog.demand} state={state} offline={offline} pending={pending.has(`command:${dialog.demand.id}`) || pending.has(`control:${dialog.demand.id}`)} error={error} close={stableClose} onSubmit={input => void onImplementation(dialog.demand, input)} /></Modal>;
  if (dialog.kind === 'knowledge') return <Modal wide title={KNOWLEDGE_LABELS[dialog.review.action]} subtitle={dialog.review.demand.title} close={stableClose}><KnowledgeForm review={dialog.review} state={state} offline={offline} pending={pending.has(`knowledge:${dialog.review.demand.id}`) || pending.has(`command:${dialog.review.demand.id}`) || pending.has(`control:${dialog.review.demand.id}`)} error={error} onSubmit={input => void onKnowledge(dialog.review, input)} close={stableClose} /></Modal>;
  if (dialog.kind === 'decision') return <Modal wide title={DECISION_LABELS[dialog.review.kind]} subtitle={dialog.review.demand.title} close={stableClose}><DecisionForm review={dialog.review} state={state} offline={offline} pending={pending.has(`command:${dialog.review.demand.id}`) || pending.has(`control:${dialog.review.demand.id}`)} error={error} onSubmit={input => void onDecision(dialog.review, input)} close={stableClose} /></Modal>;
  if (dialog.kind === 'model-authorization') return <Modal wide title="确认有限模型与资源授权" subtitle="仅批准此需求的模型额度、资料范围与下述本地资源访问。" close={stableClose}><ModelAuthorizationReview key={`${dialog.demand.id}:${dialog.demand.version}:${dialog.configuration.configurationDigest}`} state={state} target={dialog.demand} configuration={dialog.configuration} error={error} pending={pending.has(`model:${dialog.demand.id}`)} offline={offline} onBack={onBackToDiagnostics} onConfirm={() => void onAuthorizeModel(dialog.demand, dialog.configuration)} /></Modal>;
  if (dialog.kind === 'diagnostics') return <Modal wide title="运行诊断" subtitle="只有已验证的前置条件，才能启用自主执行。" close={stableClose}><div className="diagnostics-summary"><Icon name={state.runtime.executionEnabled ? 'shield' : 'alert'} size={23} /><div><strong>{state.runtime.executionEnabled ? '当前运行组合已启用' : '自主执行尚未启用'}</strong><p>{state.runtime.executionEnabled ? '每次派发仍由 Host 核验授权、版本、工作区和额度。' : '你可以接入项目、保存需求并查看已有记录。'}</p></div></div><div className="diagnostic-facts"><Metadata label="平台" value={state.runtime.platform} /><Metadata label="Node.js" value={state.runtime.node} /><Metadata label="模型" value={state.runtime.model ?? '未配置 / 未启用'} /><Metadata label="连接" value={state.runtime.connection === 'disconnected' ? '已断开' : '本地 Host'} /></div><ConfigurationPanel state={state} demand={selectedDemand} pending={pending.has('import-configuration')} preparing={!!selectedDemand && pending.has(`prepare-model:${selectedDemand.id}`)} offline={offline} onImport={onImport} onReview={onReviewModel} />{error && <p className="stale-warning" role="alert">{error}</p>}<h3 className="dialog-section-label">Host 报告的运行条件</h3>{state.runtime.blockers.length ? <ul className="diagnostic-blockers">{state.runtime.blockers.map((blocker, index) => <li key={index}><Icon name="alert" size={16} /><span>{blocker}</span></li>)}</ul> : <p className="detail-muted">Host 未报告全局配置阻塞。需求级授权与检查仍分别核验。</p>}<div className="dialog-note">运行配置包括方法、模型与资料范围、实际隔离、有限额度和恢复能力。未配置不会被视为无限制。</div><div className="modal-actions"><button className="button" onClick={stableClose}>关闭</button><button className="button primary" onClick={() => void refresh()}><Icon name="refresh" size={14} />重新检查</button></div></Modal>;
  if (dialog.kind === 'new') return <Modal title="记录一条新需求" subtitle="先把想法保存下来，再决定何时开始规划。" close={stableClose}><form onSubmit={event => { event.preventDefault(); if (title.trim() && project && !pending.has('create-demand')) void onCreate({ projectId: project, title: title.trim(), description: description.trim(), requestId: createId() }); }}><div className="form-field"><label htmlFor={projectSelectId}>所属项目</label><select id={projectSelectId} value={project} onChange={event => setProject(event.target.value)} required>{state.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><label className="form-field">需求标题<input autoFocus required maxLength={160} placeholder="例如：为导出功能增加时间范围筛选" value={title} onChange={event => setTitle(event.target.value)} /></label><label className="form-field">目标与背景<span className="field-optional">可稍后补充</span><textarea rows={5} maxLength={20000} placeholder="希望解决什么问题？有哪些约束、参考或验收要求？" value={description} onChange={event => setDescription(event.target.value)} /></label><div className="dialog-note"><Icon name="bulb" size={15} />保存想法不会启动 Agent，也不会创建实施授权。</div>{error && <p className="stale-warning" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button" onClick={stableClose}>取消</button><button className="button primary" type="submit" disabled={!title.trim() || !project || pending.has('create-demand')}>{pending.has('create-demand') ? '正在保存…' : '保存想法'}<Icon name="arrow" size={14} /></button></div></form></Modal>;
  const target = dialog.demand;
  const stale = state.demands.find(item => item.id === target.id)?.version !== target.version;
  const busy = pending.has(`command:${target.id}`) || pending.has(`control:${target.id}`);
  return <Modal title={dialog.kind === 'return' ? '退回这一轮成果' : '取消这条需求？'} subtitle={target.title} close={stableClose}><div className="dialog-object"><Metadata label="需求版本" value={String(target.version)} />{dialog.kind === 'return' && target.result && <Metadata label="成果对象" value={target.result.id} />}</div>{dialog.kind === 'return' ? <label className="form-field">需要返工的内容<textarea rows={4} placeholder="说明哪些行为与预期不符，以及希望如何调整。" value={reason} maxLength={20000} onChange={event => setReason(event.target.value)} /></label> : <div className="dialog-note">将保存停止意图并停止这条需求继续推进。已有代码、分支、会话、验证记录与本地经验继续保留；其他需求不受影响。</div>}{error && <p className="stale-warning" role="alert">{error}</p>}{stale && <p className="stale-warning" role="alert">对象版本已变化，请关闭此窗口并核对最新内容。</p>}<div className="modal-actions"><button className="button" onClick={stableClose}>返回</button><button className={`button ${dialog.kind === 'cancel' ? 'danger' : 'primary'}`} disabled={busy || stale || (dialog.kind === 'return' && !reason.trim())} onClick={() => void onControl(dialog.kind === 'return' ? 'return-result' : 'cancel', target, reason)}>{busy ? '正在保存…' : dialog.kind === 'return' ? '退回此成果并记录原因' : '取消此需求'}</button></div></Modal>;
}
