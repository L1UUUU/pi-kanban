import { useEffect, useState } from 'react';
import { Icon } from './icons.tsx';
import { contextPolicyDisclosure, formatCostMicros, LOCAL_RESOURCE_SCOPE, modelAuthorizationChanged, modelAuthorizationUnavailable, modelPreparationUnavailable, runtimePolicyDisclosure } from './configuration-model.ts';
import type { ConfigurationSummary, Demand, ProviderConfiguration, ViewState } from './types.ts';

const stageNames = { planning: '规划方法', implementation: '实施方法', review: '独立 Review 方法' };
const roleNames: Record<string, string> = { planning: '规划', implementation: '实施', review: '独立 Review', 'boundary-review': '独立事实调查 / 设计审查', check: '检查' };
function Fact({ label, value }: { label: string; value: string }) { return <div className="metadata"><span>{label}</span><code>{value}</code></div>; }
function Gaps({ items }: { items: string[] }) { return items.length ? <ul className="configuration-gaps">{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : null; }

export function ConfigurationPanel({ state, demand, pending, preparing, offline, onImport, onReview }: { state: ViewState; demand?: Demand; pending: boolean; preparing: boolean; offline: boolean; onImport: () => void; onReview: (demand: Demand) => void }) {
  const summary = state.configuration;
  const runtime = summary?.configuration.runtime;
  const policy = runtimePolicyDisclosure(runtime?.policyVariant);
  const reason = modelPreparationUnavailable(state, demand);
  const authorization = summary?.authorization;
  const alreadyRecorded = !!demand && authorization?.demandId === demand.id && authorization.configurationDigest === summary?.configurationDigest;
  return <section className="configuration-panel" aria-label="方法与模型配置">
    <section className="runtime-support" aria-label="首版运行支持范围">
      <div className="configuration-section-heading"><span className="configuration-step">首版支持范围</span><span className="tiny-pill">执行前须核验</span></div>
      <h3>Node 原生受控工具</h3>
      <p>支持范围：受控读写、删除、搜索；Node 测试须显式使用 --test-isolation=none 进程内模式。测试、依赖与 JavaScript CLI 不得新建子进程管道或 IPC 命名管道。</p>
      <p>默认进程隔离的 Node 测试不受支持；必需检查的语义不能静默改写。写入和删除仍受阶段授权与需求工作区限制。</p>
      <p>不支持 Bash / POSIX shell、shell 脚本及依赖 shell 的 CLI。运行配置中的 shell 必须为空。</p>
      <p>Windows 目标机的隔离、文件系统、进程树与网络证据仍须由 Host 核验。导入成功不代表执行已启用。</p>
      {runtime?.shell && <div className="runtime-unsupported" role="alert"><strong>已导入不受支持的 shell，执行受阻</strong><Fact label="遗留 shell 来源 · 仅用于排查" value={`${runtime.shell.kind} · ${runtime.shell.path}`} /><p>请将运行配置中的 shell 设为 null 或省略，再重新导入。清除后仍须核验其余运行条件。</p></div>}
    </section>
    <div className="configuration-import"><div><span className="configuration-step">01 · 本地来源</span><h3>导入方法与模型配置</h3><p>选择本地 JSON 文件。有效的既有方法快照会保留，缺失方法可在首次派发前补齐。Host 校验来源与摘要后保存；导入本身不授权费用、资料传输或执行。</p></div><button className="button compact" onClick={onImport} disabled={pending || preparing || offline}><Icon name="folder" size={14} />{pending ? '正在导入…' : '导入运行配置'}</button></div>
    <div className="configuration-source"><span className={`status-dot ${summary?.sourceStatus === 'configured' ? 'success' : 'warning'}`} /><span>{summary?.sourceStatus === 'configured' ? `已载入配置 · 版本 ${summary.revision}` : summary?.sourceStatus === 'invalid' ? '配置未通过校验' : '尚未导入运行配置'}</span>{state.preview && <span className="tiny-pill">合成示例</span>}</div>
    {summary?.sourceStatus === 'configured' && <details className="configuration-reference"><summary>查看配置指纹</summary><Fact label="SHA-256 · 授权将绑定此摘要" value={summary.configurationDigest} /></details>}
    <div className="configuration-methods">{(['planning', 'implementation', 'review'] as const).map(stage => {
      const method = summary?.methods.find(item => item.stage === stage);
      const source = summary?.configuration.methods[stage];
      return <details className={`configuration-method ${method?.status === 'configured' ? 'ready' : ''}`} key={stage}>
        <summary><Icon name={stage === 'review' ? 'shield' : 'file'} size={15} /><span><strong>{stageNames[stage]}</strong><small>{method?.logicalName ?? (stage === 'planning' ? 'design-feature' : '待提供明确来源')}</small></span><span className={`tiny-pill ${method?.status === 'configured' ? 'success' : ''}`}>{method?.status === 'configured' ? '已核验来源' : method?.status === 'invalid' ? '校验未通过' : '未配置'}</span><Icon name="chevron" size={12} /></summary>
        <div>{method?.source && <><Fact label="本地文件" value={method.source.path} /><Fact label="来源 SHA-256" value={method.source.sha256} /></>}{source && <><Fact label="方法版本 / 适配器" value={`${source.version} / ${source.adapter}`} /><Fact label="依赖文件数" value={String(method?.dependencyCount ?? source.dependencies.length)} /></>}{method?.snapshot && <Fact label="冻结方法摘要" value={method.snapshot.digest} />}<Gaps items={method?.blockers ?? ['导入配置时提供实际方法文件及准确摘要。']} />{stage === 'planning' && <div className="planning-method-hint"><p className="detail-muted">分阶段规划要求实际 design-feature 来源、design-feature-staged-v1 适配器，以及来源与摘要全部锁定的完整 skillBundle。Host 按当前阶段调用 grilling、codebase-design、to-spec、to-tickets；缺失依赖会停在对应阶段。</p>{source?.skillBundle && <><Fact label="已锁定的规划技能" value={source.skillBundle.skills.map(skill => skill.name).join(' → ')} /><Fact label="资源闭包" value={`${source.skillBundle.resources.length} 个明确来源与 SHA-256`} /></>}<p className="detail-muted">代码事实调查与独立设计审查使用各自全新的只读上下文，需要模型角色 boundary-review。需求与最终设计分别确认，模型、资料范围、用量和实施权限仍单独处理。</p>{(!source?.skillBundle || source.adapter !== 'design-feature-staged-v1') && <p className="configuration-gaps">当前配置尚未提供可用于生产执行的完整分阶段规划资源。</p>}</div>}</div>
      </details>;
    })}</div>
    <div className="configuration-section-heading"><span className="configuration-step">02 · 模型与资料范围</span><span className="tiny-pill">单独授权</span></div>
    {summary?.configuration.provider ? <ProviderDetails provider={summary.configuration.provider} /> : <p className="configuration-empty">尚未配置服务商、模型、接收地址与有限额度。凭据只填写 Host 引用，不在这里输入密钥。</p>}
    <Gaps items={summary?.provider.blockers ?? []} />
    <div className="configuration-grant"><div><strong>{demand ? `授权对象：${demand.title}` : '先选择一条需求'}</strong><p>{alreadyRecorded ? `已记录模型授权 ${authorization.grantId}。Host 会继续核验实际剩余额度、有效期与资料范围。` : 'Host 会先计算实际源文件、冻结方法与产物的 ID 和摘要，再交给你审阅。准备清单不授予模型、资料传输或执行权限。'}</p></div><button className="button primary compact" disabled={pending || preparing || offline || !!reason || alreadyRecorded} onClick={() => { if (demand && summary) onReview(demand); }}><Icon name="shield" size={14} />{preparing ? '正在准备资料清单…' : alreadyRecorded ? '此配置授权已记录' : '审阅模型与资源授权'}</button>{reason && !alreadyRecorded && <p className="configuration-disabled-reason">{reason}</p>}</div>
    <div className="configuration-section-heading"><span className="configuration-step">03 · 原生运行核验</span><span className="tiny-pill">由 Host 判定</span></div>
    {runtime && <><Fact label="运行组合" value={runtime.profileId} /><Fact label="已选择的隔离策略" value={policy.label} /><Fact label="策略版本" value={policy.id} /><p className="detail-muted">{policy.detail}</p></>}
    <p className="detail-muted">文件存在、方法已加载或额度已批准，都不代表隔离与真实模型通道已经通过。</p>
    <Gaps items={summary?.runtime.blockers ?? ['尚无已验证的原生运行组合。']} />
  </section>;
}

export function ProviderDetails({ provider }: { provider: ProviderConfiguration }) {
  const limits = provider.limits;
  const contextScope = contextPolicyDisclosure(provider.contextPolicy);
  return <div className="provider-details">
    <div className="diagnostic-facts"><Fact label="服务商" value={provider.provider} /><Fact label="模型 ID" value={provider.modelId} /></div>
    <Fact label="资料接收地址 · 精确 HTTPS 端点" value={provider.destination} />
    <Fact label="Host 凭据引用 · 仅引用名称" value={provider.credentialRef ?? '未配置'} />
    <Fact label="允许使用模型的角色" value={provider.allowedRoles.length ? provider.allowedRoles.map(role => `${roleNames[role] ?? role} (${role})`).join('、') : '未提供明确角色'} />
    <div className="configuration-context-scope"><span>资料与上下文范围</span><strong>{contextScope.title}</strong><p>{contextScope.detail}</p><code>{provider.contextPolicy ?? '未选择'}</code></div><div className="configuration-data"><h4>允许发送的初始资料 · {provider.data.length} 项</h4><p>以下 ID 与 SHA-256 绑定确切的初始资料；后续上下文严格遵循上述选择。</p>{provider.data.length ? <ol>{provider.data.map(item => <li key={item.id}><strong>{item.id}</strong><code>{item.sha256}</code></li>)}</ol> : <p className="configuration-empty">尚未准备资料清单。点击审阅后由 Host 计算实际 ID 与摘要，不需要手工填写；完整清单就绪后才能批准。</p>}</div>
    {limits ? <><div className="configuration-limits"><div><span>请求上限</span><strong>{limits.maxRequests.toLocaleString('en-US')}</strong><small>次 · 含重试等模型请求</small></div><div><span>Token 总上限</span><strong>{limits.maxTokens.toLocaleString('en-US')}</strong><small>累计受限</small></div><div><span>费用总上限</span><strong>{formatCostMicros(limits.maxCostMicros, limits.currency)}</strong><small>{limits.maxCostMicros} 微货币单位</small></div></div><Fact label="额度截止时间 · UTC" value={limits.expiresAt} /><Fact label="计量策略" value={limits.meteringPolicy} /></> : <p className="configuration-empty">缺少有限请求数、Token、费用或截止时间，不能批准模型使用。</p>}
  </div>;
}

export function ModelAuthorizationReview({ state, target, configuration, error, pending, offline, onBack, onConfirm }: { state: ViewState; target: Demand; configuration: ConfigurationSummary; error: string | null; pending: boolean; offline: boolean; onBack: () => void; onConfirm: () => void }) {
  const [checked, setChecked] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const stale = modelAuthorizationChanged(state, target, configuration);
  const reason = modelAuthorizationUnavailable({ ...state, configuration }, target, now);
  const provider = configuration.configuration.provider;
  return <>
    <div className="authorization-intro"><Icon name="shield" size={21} /><p>请核对本需求的模型费用、资料传输与本地资源访问范围。以下授权仅在明确确认后记录，实际执行仍需满足 Host 核验与阶段授权。</p></div>
    <div className="dialog-object"><Fact label="需求 / 版本" value={`${target.title}\n${target.id} · v${target.version}`} /><Fact label="配置 SHA-256" value={configuration.configurationDigest} /></div>
    {provider && <ProviderDetails provider={provider} />}
    <LocalResourceScope demand={target} />
    <div className="dialog-note"><Icon name="alert" size={15} />批准后，在其他执行条件满足时，Host 可为这条需求调用以上模型并产生上限内的费用。它不会超出上述资料与上下文范围或增加额度，也不替代方案确认与实施授权。</div>
    <label className="authorization-consent"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} disabled={stale || !!reason || pending || offline} /><span>我已核对接收方、资料与上下文范围、模型额度和此需求的本地资源范围，同意在上述限制内授权。</span></label>
    {stale && <p className="stale-warning" role="alert">需求或配置已变化。请返回诊断并重新审阅，当前确认不会自动绑定新版本。</p>}
    {reason && <p className="stale-warning" role="alert">{reason}</p>}
    {error && <p className="stale-warning" role="alert">{error}</p>}
    <div className="modal-actions"><button className="button" onClick={onBack}>返回运行诊断</button><button className="button primary" disabled={!checked || stale || !!reason || pending || offline} onClick={onConfirm}>{pending ? '正在记录授权…' : '确认此范围与额度'}</button></div>
  </>;
}

function LocalResourceScope({ demand }: { demand: Demand }) {
  return <section className="local-resource-scope" aria-label="本需求的本地资源访问范围">
    <div className="configuration-section-heading"><span className="configuration-step">本需求的本地资源访问</span><span className="tiny-pill">受限授权</span></div>
    <Fact label="需求工作区" value={demand.workspacePath ?? '为此需求准备的独立工作区（路径尚待 Host 准备与核验）'} />
    {!demand.workspacePath && <p className="resource-preflight">尚未准备工作区时不执行。Host 必须在派发前准备并核验属于此需求的准确路径，不能使用其他目录代替。</p>}
    <ul>
      <li><strong>规划 / 独立 Review</strong><span>只读访问此需求的工作区。</span></li>
      <li><strong>实施</strong><span>仅可在此需求的工作区内写入；实施阶段仍需另外明确授权。</span></li>
      <li><strong>固定运行依赖</strong><span>只读访问已锁定版本和摘要的运行时与依赖。</span></li>
      <li><strong>私有临时区与会话</strong><span>仅可读写为此需求新建的私有 scratch / session 目录。</span></li>
      <li className="resource-denied"><strong>明确拒绝</strong><span>共享 .git 管理目录、Host 数据库、其他需求及未列出的目录。此授权不包含全磁盘访问或通用系统设置权限。</span></li>
    </ul>
    <Fact label="本地资源授权范围标识" value={LOCAL_RESOURCE_SCOPE} />
    <p className="detail-muted">本地读取不代表允许向模型传输。资料发送继续受上方接收地址、资料清单与上下文策略约束。</p>
  </section>;
}
