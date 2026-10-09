import { useState } from 'react';
import type { ArtifactRef, PlanningArchive } from '../../domain/types.ts';
import type { ArtifactReview } from './artifact-model.ts';
import { PLANNING_LABELS, PLANNING_STEPS, PLANNING_STEP_LABELS, planningUnavailable, unansweredPlanningQuestions } from './planning-model.ts';
import type { PlanningInput, PlanningReview } from './planning-model.ts';
import type { Demand, ViewState } from './types.ts';

const Fact = ({ label, value }: { label: string; value: string }) => <div className="metadata"><span>{label}</span><code>{value}</code></div>;
function List({ label, items }: { label: string; items: string[] }) { return <><h4>{label}</h4>{items.length ? <ul className="planning-list">{items.map((item, index) => <li className="safe-text" key={index}>{item}</li>)}</ul> : <p>未列出额外项目。</p>}</>; }
function Understanding({ flow }: { flow: PlanningArchive }) {
  const understanding = flow.understanding;
  return understanding ? <article className="decision-card"><h3>需求、验收与范围</h3><Fact label="需求理解版本" value={understanding.id} /><Fact label="需求摘要" value={understanding.digest} /><p className="safe-text">{understanding.scope}</p><List label="验收预期" items={understanding.acceptanceCriteria} /><List label="不在本次范围" items={understanding.nonGoals} /><List label="必须保留的约束" items={understanding.constraints} /></article> : null;
}
function Design({ flow }: { flow: PlanningArchive }) {
  const design = flow.design;
  return design ? <article className="decision-card"><h3>设计与测试 seams</h3><Fact label="设计版本" value={design.id} /><Fact label="设计摘要" value={design.digest} /><p className="safe-text">{design.summary}</p><List label="验证位置与行为" items={design.testingSeams} /><List label="设计约束" items={design.constraints} /></article> : null;
}
function Findings({ flow }: { flow: PlanningArchive }) {
  const review = flow.review;
  if (!review) return null;
  return <article className="decision-card"><h3>独立只读审查与处理</h3><Fact label="审查对象" value={review.id} /><Fact label="独立审查上下文" value={review.contextId} /><Fact label="绑定设计摘要" value={review.designDigest} />{!review.findings.length && <p>此审查没有记录发现。</p>}{review.findings.map(finding => {
    const disposition = flow.resolution?.dispositions.find(item => item.findingId === finding.id);
    return <section className="finding-card" key={finding.id} aria-label={`规划发现 ${finding.id}`}><div className="finding-heading"><strong>{finding.severity === 'decision' ? '需要用户决定' : finding.severity === 'blocking' ? '影响正确性或验收' : '建议'}</strong><span>{disposition ? disposition.outcome === 'adopted' ? '已采纳' : disposition.outcome === 'user-resolved' ? '用户已决定' : '未采纳 · 已记录理由' : '尚待处理'}</span></div><Fact label="发现对象" value={finding.id} /><p className="safe-text"><strong>触发条件：</strong>{finding.trigger}</p><p className="safe-text"><strong>预期结果或待确认问题：</strong>{finding.expectedOutcome}</p><p className="safe-text"><strong>依据：</strong>{finding.basis}</p><p className="safe-text"><strong>建议验证位置：</strong>{finding.verification}</p>{disposition && <><p className="safe-text"><strong>处理理由：</strong>{disposition.rationale}</p>{disposition.answerQuestionId && <Fact label="对应用户问题" value={disposition.answerQuestionId} />}</>}</section>;
  })}{flow.resolution && <Fact label="最终设计与审查处理摘要" value={flow.resolution.digest} />}</article>;
}
export function PlanningPanel({ state, demand, offline, pending, onReview, onArtifact }: { state: ViewState; demand: Demand; offline: boolean; pending: boolean; onReview: (review: PlanningReview) => void; onArtifact: (review: ArtifactReview) => void }) {
  const flow = demand.planningFlow;
  if (!flow) return null;
  const activeIndex = PLANNING_STEPS.indexOf(flow.step);
  const unanswered = unansweredPlanningQuestions(flow);
  const action = (review: PlanningReview, label = PLANNING_LABELS[review.kind]) => {
    const unavailable = planningUnavailable(review, state);
    return <div className="planning-action"><button className="button compact" disabled={offline || pending || !!unavailable} onClick={() => onReview(structuredClone(review))}>{label}</button>{unavailable && <p className="decision-unavailable">{unavailable}</p>}</div>;
  };
  const artifact = (ref: ArtifactRef | undefined, label: string) => ref && <button className="button compact" onClick={() => onArtifact({ demandId: demand.id, version: demand.version, title: label, artifact: structuredClone(ref) })}>{label}</button>;
  return <section className="planning-panel" aria-label="分阶段规划">
    <div className="planning-current"><span className="eyebrow">分阶段规划</span><h2>{PLANNING_STEP_LABELS[flow.step]}</h2><p>已有有效确认会继续复用。规划完成后，实施仍需单独授权。</p><Fact label="规划对象" value={flow.id} /><Fact label="规划版本" value={String(flow.revision)} /><details className="planning-progress"><summary>查看全部规划阶段</summary><ol>{PLANNING_STEPS.map((step, index) => <li key={step} aria-current={step === flow.step ? 'step' : undefined} className={index < activeIndex ? 'past' : step === flow.step ? 'current' : ''}><span>{index + 1}</span>{PLANNING_STEP_LABELS[step]}{step === flow.step && <strong>当前</strong>}</li>)}</ol></details></div>
    {(demand.control === 'paused' || demand.control === 'exited') && <p className="planning-notice">当前已停止推进。保存决定不会恢复执行；继续时会复用仍有效的确认。</p>}
    {!!demand.blockers.length && <p className="planning-notice">运行或需求存在阻塞。保存规划决定后，仍需由 Host 核验继续条件。</p>}
    {flow.revisionInstruction && <article className="decision-card"><h3>{flow.revisionInstruction.scope === 'requirements' ? '本轮需求修订要求' : '本轮设计修订要求'}</h3><p className="safe-text">{flow.revisionInstruction.reason}</p></article>}
    <div className="planning-confirmations"><p>需求与验收：<strong>{flow.understandingConfirmation ? '此版本已确认' : '待明确确认'}</strong></p><p>最终设计与测试：<strong>{flow.finalDesignConfirmation ? '此版本已确认' : '待独立确认'}</strong></p></div>
    <div className="artifact-actions">{artifact(flow.facts?.evidence, '阅读代码事实记录')}{artifact(flow.understanding?.evidence, '阅读需求理解记录')}{artifact(flow.design?.evidence, '阅读设计草案')}{artifact(flow.review?.evidence, '阅读独立设计审查')}{artifact(flow.resolution?.evidence, '阅读审查处理记录')}</div>
    {flow.facts && <details className="planning-context"><summary>已调查的代码事实</summary><p className="safe-text">{flow.facts.summary}</p></details>}
    {!!flow.questions.length && <article className="decision-card"><h3>限定范围问题 · {unanswered.length} 项待回答</h3><p>仅回答影响当前行为、验收或设计取舍的问题；普通会话不代替此决定。</p>{flow.questions.map(question => {
      const answer = flow.answers.find(item => item.questionId === question.id && item.questionDigest === question.digest);
      return <section className="finding-card" key={question.id} aria-label={`规划问题 ${question.id}`}><div className="finding-heading"><strong>{question.scope === 'requirements' ? '需求与验收' : '设计取舍'}</strong><span>{answer ? '答案已保存' : '等待回答'}</span></div><Fact label="问题对象" value={question.id} /><p className="safe-text">{question.question}</p><p className="safe-text"><strong>提问依据：</strong>{question.basis}</p>{answer ? <p className="safe-text"><strong>你的答案：</strong>{answer.answer}</p> : action({ kind: 'answer-planning-question', demand, questionId: question.id })}</section>;
    })}</article>}
    <Understanding flow={flow} />
    {!!flow.answers.length && <details className="planning-context"><summary>已保存的问题答案 · {flow.answers.length}</summary>{flow.answers.map((answer, index) => <section className="finding-card" key={`${answer.questionId}:${answer.questionDigest}:${index}`}><strong>{answer.scope === 'requirements' ? '需求与验收' : '设计取舍'}</strong><Fact label="问题对象" value={answer.questionId} /><Fact label="问题摘要" value={answer.questionDigest} /><p className="safe-text">{answer.question}</p><p className="safe-text"><strong>你的答案：</strong>{answer.answer}</p></section>)}</details>}
    {flow.step === 'awaiting-understanding-confirmation' && action({ kind: 'confirm-understanding', demand })}
    <Design flow={flow} /><Findings flow={flow} />
    {flow.step === 'awaiting-final-design-confirmation' && action({ kind: 'confirm-final-design', demand })}
    {flow.spec && <article className="decision-card"><h3>本地 Spec 文档</h3><p>设计与行为的实施依据。此文档不是可执行任务。</p><Fact label="Spec 文档" value={flow.spec.id} />{artifact(flow.spec.evidence, '阅读本地 Spec 文档')}<List label="Spec 要求的检查" items={flow.spec.requiredChecks.map(check => check.name)} /></article>}
    {!!flow.tickets.length && <article className="decision-card"><h3>本地实施任务 · {flow.tickets.length} 项</h3><p>任务拆分沿用已确认的范围、验收与约束；每项依赖和 Spec 条款分别保存。</p>{flow.tickets.map(ticket => <section className="finding-card" key={ticket.id}><h4>{ticket.title}</h4><Fact label="任务对象" value={ticket.id} /><Fact label="所属 Spec" value={ticket.specId} /><List label="对应 Spec 条款" items={ticket.specClauses} /><p>{ticket.blockedBy.length ? `前置任务：${ticket.blockedBy.join('、')}` : '无前置任务，可优先实施'}</p>{artifact(ticket.evidence, `阅读任务 ${ticket.id}`)}</section>)}</article>}
    {flow.step === 'complete' && <p className="planning-notice">本地规划产物已保存。尚需单独取得实施权限，以及模型、资料范围和用量授权。</p>}
    <details className="planning-context"><summary>限定范围修订</summary><p>需求、范围、验收或约束有变化时，重新确认受影响的内容。纯内部任务拆分会沿用有效确认。</p>{action({ kind: 'revise-planning', demand, scope: 'requirements' }, '修订需求与验收')}{flow.understandingConfirmation && action({ kind: 'revise-planning', demand, scope: 'design' }, '修订设计与测试')}</details>
    {!!flow.history.length && <details className="planning-context"><summary>历史规划与审查 · {flow.history.length}</summary><p>历史记录只读，当前阶段不会自动沿用已失效的确认。</p>{flow.history.map((previous, index) => <details className="planning-history" key={`${previous.id}:${previous.revision}:${index}`}><summary>历史版本 {previous.revision} · {PLANNING_STEP_LABELS[previous.step]}</summary><div className="artifact-actions">{artifact(previous.facts?.evidence, '阅读历史事实')}{artifact(previous.understanding?.evidence, '阅读历史需求')}{artifact(previous.design?.evidence, '阅读历史设计')}{artifact(previous.review?.evidence, '阅读历史审查')}{artifact(previous.resolution?.evidence, '阅读历史处理')}{artifact(previous.spec?.evidence, '阅读历史 Spec')}{previous.tickets.map(ticket => <span key={ticket.id}>{artifact(ticket.evidence, `阅读历史任务 ${ticket.id}`)}</span>)}</div><Understanding flow={previous} /><Design flow={previous} /><Findings flow={previous} />{previous.questions.map(question => <section className="finding-card" key={question.id}><p className="safe-text">{question.question}</p><p className="safe-text">{previous.answers.find(answer => answer.questionId === question.id && answer.questionDigest === question.digest)?.answer ?? '此历史版本未保存答案'}</p></section>)}</details>)}</details>}
    {!!flow.confirmations.length && <details className="planning-context"><summary>已保存的确认记录 · {flow.confirmations.length}</summary>{flow.confirmations.map((confirmation, index) => <section key={`${confirmation.kind}:${confirmation.digest}:${index}`} className="finding-card"><strong>{confirmation.kind === 'understanding' ? '需求与验收确认' : '最终设计与测试确认'}</strong><Fact label="确认对象" value={confirmation.targetId} /><Fact label="确认摘要" value={confirmation.digest} /><Fact label="确认时间" value={confirmation.createdAt} /><p>{(confirmation.kind === 'understanding' ? flow.understandingConfirmation?.digest : flow.finalDesignConfirmation?.digest) === confirmation.digest ? '当前仍有效' : '历史确认，当前不使用'}</p></section>)}</details>}
  </section>;
}
export function PlanningForm({ review, state, offline, pending, error, onSubmit, close }: { review: PlanningReview; state: ViewState; offline: boolean; pending: boolean; error: string | null; onSubmit: (input: PlanningInput) => void; close: () => void }) {
  const [text, setText] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const flow = review.demand.planningFlow!;
  const question = review.kind === 'answer-planning-question' ? flow.questions.find(item => item.id === review.questionId) : undefined;
  const confirmation = review.kind === 'confirm-understanding' || review.kind === 'confirm-final-design';
  const unavailable = planningUnavailable(review, state);
  const disabled = offline || pending || !!unavailable || (confirmation ? !reviewed : !text.trim());
  return <form className="planning-form" onSubmit={event => { event.preventDefault(); if (!disabled) onSubmit({ text, reviewed }); }}>
    <div className="dialog-object"><Fact label="需求对象" value={review.demand.id} /><Fact label="需求版本" value={String(review.demand.version)} /><Fact label="规划对象" value={flow.id} /><Fact label="规划版本" value={String(flow.revision)} /><Fact label="当前阶段" value={PLANNING_STEP_LABELS[flow.step]} /></div>
    {review.kind === 'confirm-understanding' && <><p className="dialog-note">确认此版本的目标、范围、验收和约束。保存后进入设计；最终设计与测试另行确认。</p><Understanding flow={flow} /></>}
    {review.kind === 'confirm-final-design' && <><p className="dialog-note">确认已独立审查并处理发现的最终设计、测试 seams 与约束。保存后生成本地 Spec 和任务；实施仍需单独授权。</p><Design flow={flow} /><Findings flow={flow} /></>}
    {question && <article className="decision-card"><h3>{question.scope === 'requirements' ? '需求与验收问题' : '设计取舍问题'}</h3><Fact label="问题对象" value={question.id} /><Fact label="问题摘要" value={question.digest} /><p className="safe-text">{question.question}</p><p className="safe-text">依据：{question.basis}</p></article>}
    {review.kind === 'revise-planning' && <p className="dialog-note">{review.scope === 'requirements' ? '仅重开需求、范围、验收与约束。受影响的需求和后续设计确认将失效，需要重新审阅。' : '保留有效需求确认，重开设计与测试。受影响的设计确认将失效，独立审查后再确认。'}已有记录继续保留；本操作不授予实施权限。</p>}
    {!confirmation && <label className="form-field">{review.kind === 'answer-planning-question' ? '此问题的答案与依据' : review.kind === 'revise-planning' && review.scope === 'requirements' ? '需求与验收修订要求' : '设计与测试修订要求'}<textarea rows={5} required maxLength={20_000} value={text} onChange={event => setText(event.target.value)} /></label>}
    {confirmation && <label className="authorization-consent"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /><span>{review.kind === 'confirm-understanding' ? '我已审阅并确认此精确版本的需求、验收、非目标与约束。' : '我已审阅并确认此精确版本的最终设计、审查处理与测试 seams。'}</span></label>}
    {(review.demand.control === 'paused' || review.demand.control === 'exited') && <p className="planning-notice">当前处于暂停或停止状态；保存决定后仍保持停止。</p>}
    {unavailable && <p className="stale-warning" role="alert">{unavailable}</p>}{error && <p className="stale-warning" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button" onClick={close}>返回</button><button className="button primary" type="submit" disabled={disabled}>{pending ? '正在保存…' : PLANNING_LABELS[review.kind]}</button></div>
  </form>;
}
