import type { ArtifactRef, ExecutionArchive, ExecutionReviewRecord } from '../../domain/types.ts';
import type { ArtifactReview } from './artifact-model.ts';
import { EXECUTION_AXIS_LABELS, EXECUTION_FINDING_LABELS, EXECUTION_STEP_LABELS, EXECUTION_TICKET_LABELS, executionAxisEvidence, executionDecisionFindings, executionTicketProgress } from './execution-model.ts';
import type { Demand } from './types.ts';

const Fact = ({ label, value }: { label: string; value: string }) => <div className="metadata"><span>{label}</span><code>{value}</code></div>;
type ReadArtifact = (ref: ArtifactRef, label: string) => React.ReactNode;
function TddHistory({ flow, read }: { flow: ExecutionArchive; read: ReadArtifact }) {
  return flow.implementations.length ? <details className="execution-history"><summary>TDD 与行为保持证据 · {flow.implementations.length}</summary>{flow.implementations.map((record, index) => <section className="finding-card" key={`${record.runId}:${record.contentId}:${index}`}><h4>{record.tdd.mode === 'red-green' ? '先失败、后通过 · TDD' : '保持既有行为 · 限定修复'}</h4><Fact label="范围 / 精确内容 K" value={`${record.scope === 'ticket' ? record.ticketId : '整个 Spec'}\n${record.contentId}`} /><Fact label="已批准的测试 seams" value={record.tdd.testingSeams.join('\n')} />{record.repairScopeId && <Fact label="限定修复对象" value={record.repairScopeId} />}{record.tdd.rationale && <p className="safe-text">{record.tdd.rationale}</p>}<div className="artifact-actions">{record.tdd.red.map(ref => <span key={ref.id}>{read(ref, '阅读失败测试证据')}</span>)}{record.tdd.green.map(ref => <span key={ref.id}>{read(ref, '阅读通过测试证据')}</span>)}</div></section>)}</details> : null;
}
function ReviewRecord({ review, contentId, read }: { review: ExecutionReviewRecord; contentId?: string; read: ReadArtifact }) {
  return <details className="execution-review"><summary>{EXECUTION_AXIS_LABELS[review.axis]} · {review.contentId === contentId ? '当前内容 K' : '历史内容 K'} · {review.findings.length} 项发现</summary>
    <Fact label="审查对象 / 精确内容 K" value={`${review.id}\n${review.contentId}`} /><Fact label="独立只读上下文" value={review.contextId} />{read(review.evidence, '阅读完整审查依据')}
    {!review.findings.length && <p>此审查未记录发现；最终状态仍以 Host 核验为准。</p>}
    {review.findings.map(finding => <section className={`finding-card execution-finding ${finding.category}`} key={finding.id} aria-label={`${EXECUTION_FINDING_LABELS[finding.category]} ${finding.id}`}>
      <div className="finding-heading"><strong>{EXECUTION_FINDING_LABELS[finding.category]}</strong><span>{finding.requiresDesignDecision ? '需要明确决定' : finding.severity === 'blocking' ? '阻塞' : finding.severity === 'decision' ? '用户决定' : '建议'}</span></div>
      <Fact label="发现对象 / 位置" value={`${finding.id}\n${finding.location}`} />{finding.clause && <Fact label="对应条款" value={finding.clause} />}
      <p className="safe-text"><strong>依据：</strong>{finding.basis}</p><p className="safe-text"><strong>影响：</strong>{finding.impact}</p><p className="safe-text"><strong>验证方式：</strong>{finding.verification}</p>{read(finding.reference, finding.category === 'smell' ? '阅读异味观察依据' : '阅读明确条款依据')}
    </section>)}
  </details>;
}
function ReviewHistory({ flow, contentId, read }: { flow: ExecutionArchive; contentId?: string; read: ReadArtifact }) {
  const dispositionLabels = { fixed: '已修复', 'false-positive': '误报', 'not-applicable': '不适用', unresolved: '仍未解决' };
  return <>{(['standards', 'spec'] as const).map(axis => {
    const evidence = executionAxisEvidence(flow, axis, contentId);
    return <article className="decision-card execution-axis" key={axis} aria-label={`${EXECUTION_AXIS_LABELS[axis]}审查`}>
      <h3>{EXECUTION_AXIS_LABELS[axis]} · 独立只读</h3><p>{evidence.currentReview ? '已有绑定当前内容 K 的整体验证记录。' : evidence.currentResolutions.length ? '已有绑定当前内容 K 的定向核验；原审查继续保留其内容版本。' : evidence.latestReview ? '已有历史内容审查；当前内容 K 尚无此轴的核验记录。' : '尚无此轴的独立审查记录。'}</p>
      {evidence.reviews.map(review => <ReviewRecord key={review.id} review={review} contentId={contentId} read={read} />)}
      {evidence.resolutions.map(resolution => <details className="execution-resolution" key={resolution.id}><summary>定向核验 · {resolution.contentId === contentId ? '当前内容 K' : '历史内容 K'}</summary><Fact label="核验对象 / 精确内容 K" value={`${resolution.id}\n${resolution.contentId}`} /><Fact label="限定修复范围" value={resolution.repairScopeId} /><Fact label="独立只读上下文" value={resolution.contextId} />{read(resolution.evidence, '阅读定向核验记录')}{resolution.dispositions.map(disposition => <section className="finding-card" key={disposition.findingId}><div className="finding-heading"><strong>{dispositionLabels[disposition.outcome]}</strong><span>{disposition.findingId}</span></div><p className="safe-text">{disposition.rationale}</p>{read(disposition.evidence, '阅读此项处理证据')}</section>)}</details>)}
    </article>;
  })}</>;
}
export function ExecutionPanel({ demand, onArtifact, onDecisions }: { demand: Demand; onArtifact: (review: ArtifactReview) => void; onDecisions: () => void }) {
  const flow = demand.executionFlow;
  if (!flow) return <section className="execution-panel" aria-label="实施与 Review"><div className="execution-current"><span className="eyebrow">implement-spec</span><h2>尚未开始实施</h2><p>方案确认并单独授权实施后，任务依赖、TDD 进度与独立 Review 记录会显示在这里。</p></div></section>;
  const progress = executionTicketProgress(demand), decisions = executionDecisionFindings(demand);
  const read: ReadArtifact = (artifact, title) => <button className="button compact" onClick={() => onArtifact({ demandId: demand.id, version: demand.version, title, artifact: structuredClone(artifact) })}>{title}</button>;
  return <section className="execution-panel" aria-label="实施与 Review">
    <div className="execution-current"><span className="eyebrow">implement-spec · 实施与独立 Review</span><h2>{EXECUTION_STEP_LABELS[flow.step]}</h2><p>先按依赖逐项实施并保留 TDD 证据，再审查整个 Spec。修复后只核验对应发现与相关检查。</p><Fact label="执行对象 / 版本" value={`${flow.id} · ${flow.revision}`} /><Fact label="当前精确内容 K" value={demand.activeContentId ?? '尚未形成稳定内容'} /><Fact label="当前范围" value={flow.scope === 'whole-spec' ? '整个 Spec' : `当前任务 · ${flow.ticketId ?? '尚未选择'}`} /><p className="execution-runtime">{demand.control === 'paused' || demand.control === 'exited' ? '当前已停止推进；记录继续保留。' : demand.control === 'cancelled' ? '此需求已取消；以下为保存的记录。' : demand.runState === 'running' ? 'Host 报告正在运行。' : '当前展示已保存的阶段；不表示执行正在运行。'}</p></div>
    <article className="decision-card execution-tickets"><h3>任务依赖与 TDD 进度 · {progress.completed} / {progress.total}</h3><p>当前可实施任务：{progress.frontier.length ? progress.frontier.join('、') : '暂无可实施任务'}</p><p>可实施仅表示前置任务已完成；派发仍须通过运行与授权核验。</p>{progress.tickets.map(ticket => <section className="finding-card" key={ticket.ticketId} aria-label={`执行任务 ${ticket.ticketId}`}><div className="finding-heading"><strong>{ticket.title}</strong><span>{EXECUTION_TICKET_LABELS[ticket.status]}</span></div><Fact label="任务对象" value={ticket.ticketId} />{ticket.contentId && <Fact label="任务内容 K" value={ticket.contentId} />}<p>{!ticket.graphKnown ? '任务依赖资料不可用，不能推断可实施状态。' : ticket.status === 'done' ? '此任务的完成状态由 Host 保存。' : ticket.blockedBy.length ? `等待前置任务：${ticket.blockedBy.join('、')}` : '前置依赖已满足。'}</p></section>)}</article>
    {decisions.length > 0 && <div className="execution-decision-notice"><h3>需要明确决定 · {decisions.length} 项</h3><p>涉及范围、接口边界或测试 seams 的改变须先修订并确认受影响的设计。关闭发现不会授权设计变更。</p><button className="button compact" onClick={onDecisions}>查看决定与限定修订</button></div>}
    {flow.repairScope && <article className="decision-card execution-repair"><h3>当前限定修复范围</h3><Fact label="修复对象 / 原内容 K" value={`${flow.repairScope.id}\n${flow.repairScope.baseContentId}`} /><p className="safe-text">{flow.repairScope.reason}</p><Fact label="绑定的原审查" value={flow.repairScope.reviewIds.join('、') || '无'} /><Fact label="仅处理这些发现" value={flow.repairScope.findingIds.join('、') || '无'} /><Fact label="相关检查" value={flow.repairScope.checkIds.join('、') || '无'} /><p>由单个实施上下文统一修复，再分别定向核验。未记录的范围变化需要明确决定。</p></article>}
    <TddHistory flow={flow} read={read} />
    <ReviewHistory flow={flow} contentId={demand.activeContentId} read={read} />
    {!!flow.repairHistory.length && <details className="execution-history"><summary>已保存的修复范围 · {flow.repairHistory.length}</summary>{flow.repairHistory.map(scope => <section className="finding-card" key={scope.id}><Fact label="修复对象 / 原内容 K" value={`${scope.id}\n${scope.baseContentId}`} /><Fact label="发现 / 检查" value={[...scope.findingIds, ...scope.checkIds].join('、') || '无'} /><p className="safe-text">{scope.reason}</p></section>)}</details>}
    {!!flow.history.length && <details className="execution-history"><summary>历史执行与审查 · {flow.history.length}</summary>{flow.history.map((previous, index) => <details key={`${previous.id}:${previous.revision}:${index}`}><summary>版本 {previous.revision} · {EXECUTION_STEP_LABELS[previous.step]}</summary><TddHistory flow={previous} read={read} /><ReviewHistory flow={previous} read={read} /></details>)}</details>}
    <p className="execution-notice">这里只记录本地实施、证据与审查。模型额度、资料传输、实施授权和最终验收分别处理；不自动推送、创建 PR 或声明可发布。</p>
  </section>;
}
