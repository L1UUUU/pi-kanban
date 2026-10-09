import type { ConfigurationSummary, Demand, ModelAuthorizationCommand, ProviderConfiguration, ViewState } from './types.ts';

export const LOCAL_RESOURCE_SCOPE = 'demand-worktree-private-runtime-v1' as const;

/** Configuration disclosure only; selection is never evidence of verified isolation. */
export function runtimePolicyDisclosure(value?: unknown): { id: string; label: string; detail: string } {
  const id = value === undefined ? 'lpac-strict-v1' : typeof value === 'string' ? value : '未识别策略';
  const detail = '仅显示当前配置选择。能否运行仍须针对本策略、实际系统和锁定程序核验原生证据。';
  if (id === 'lpac-strict-v1') return { id, label: '严格 LPAC · 网络禁止', detail };
  if (id === 'lpac-registry-read-no-network-v2') return { id, label: 'LPAC · 系统注册表读取 · 网络仍禁止', detail };
  return { id, label: '未知隔离策略 · 尚不可判定', detail: '未识别的策略不能用作隔离或网络限制已核验的依据。请核对 Host 配置。' };
}


/** Display guard only. Host independently validates the file, finite grant and exact decision. */
export function modelAuthorizationUnavailable(state: ViewState, demand?: Demand, now = Date.now()): string | null {
  return modelConfigurationUnavailable(state, demand, now, false);
}
/** Host may calculate the exact source allowlist before the user reviews or approves it. */
export function modelPreparationUnavailable(state: ViewState, demand?: Demand, now = Date.now()): string | null {
  return modelConfigurationUnavailable(state, demand, now, true);
}
function modelConfigurationUnavailable(state: ViewState, demand: Demand | undefined, now: number, preparing: boolean): string | null {
  if (state.runtime.connection === 'disconnected') return '本地 Host 已断开，请重新连接后审阅。';
  if (!demand) return '请先在工作区选择需要授权的需求。';
  if (demand.control === 'cancelled') return '此需求已取消，不能添加模型授权。';
  const summary = state.configuration;
  if (!summary || summary.sourceStatus !== 'configured') return '请先导入有效的运行配置文件。';
  if (!/^[a-f0-9]{64}$/.test(summary.configurationDigest)) return '配置摘要不完整，请重新读取配置。';
  const provider = summary.configuration.provider;
  if (!provider || (!preparing && summary.provider.status !== 'configured-unapproved')) return '模型配置尚不完整，请先处理模型配置中的缺口。';
  if (provider.contextPolicy !== 'exact-materials-only' && provider.contextPolicy !== 'approved-run-derived-v1') return '请明确选择资料与派生上下文范围后再授权。';
  const limits = provider.limits;
  if (!limits || ![limits.maxRequests, limits.maxTokens, limits.maxCostMicros].every(value => Number.isSafeInteger(value) && value > 0) || !/^[A-Z]{3}$/.test(limits.currency) || !limits.meteringPolicy.trim()) return '模型授权必须包含明确、有限的请求数、Token 和费用上限。';
  if (!Number.isFinite(Date.parse(limits.expiresAt)) || Date.parse(limits.expiresAt) <= now) return '模型额度已到期，请更新配置中的截止时间。';
  if (!provider.provider.trim() || !provider.modelId.trim() || !provider.credentialRef || !provider.allowedRoles.length || (!preparing && (!provider.data.length || provider.data.some(item => !item.id || !/^[a-f0-9]{64}$/.test(item.sha256))))) return '缺少模型、凭据引用、角色或明确的资料摘要清单。';
  try {
    const endpoint = new URL(provider.destination);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.search || endpoint.href !== provider.destination) return '模型接收地址必须是精确的 HTTPS 地址。';
  } catch { return '模型接收地址尚未配置。'; }
  return null;
}

export function modelAuthorizationChanged(state: ViewState, demand: Demand, reviewed: ConfigurationSummary): boolean {
  const current = state.demands.find(item => item.id === demand.id);
  return state.configuration?.configurationDigest !== reviewed.configurationDigest || current?.version !== demand.version || current?.workspacePath !== demand.workspacePath;
}

export function makeModelAuthorization(demand: Demand, configuration: ConfigurationSummary, requestId: string): ModelAuthorizationCommand {
  return { demandId: demand.id, expectedVersion: demand.version, requestId, configurationDigest: configuration.configurationDigest, resourceScope: LOCAL_RESOURCE_SCOPE };
}

/** Integer arithmetic preserves the exact micro-unit cap without floating point rounding. */
export function formatCostMicros(micros: number, currency: string): string {
  if (!Number.isSafeInteger(micros) || micros < 0) return '未配置有限费用';
  const amount = BigInt(micros);
  return `${currency} ${amount / 1_000_000n}.${String(amount % 1_000_000n).padStart(6, '0')}`;
}

export function contextPolicyDisclosure(policy: ProviderConfiguration['contextPolicy']): { title: string; detail: string } {
  if (policy === 'exact-materials-only') return { title: '仅精确资料清单', detail: '只允许发送下列 ID 和 SHA-256 对应的确切内容。生成的对话、工具结果及其他新增资料不在本次授权内。' };
  if (policy === 'approved-run-derived-v1') return { title: '精确资料 + 同一受控运行内的派生上下文', detail: '除下列初始资料外，还允许发送此需求同一已核验隔离运行内生成的对话与工具结果。不得据此读取任意新来源、其他项目或其他需求的资料。' };
  return { title: '上下文范围尚未选择', detail: '必须明确选择精确资料模式，或同一受控运行内的派生上下文模式，才能授予模型额度。' };
}

/** Review the actual preparation response, never silently retarget to a newer snapshot. */
export function preparedModelReview(current: ViewState, prepared: ViewState, demandId: string): { demand: Demand; configuration: ConfigurationSummary } {
  const demand = prepared.demands.find(item => item.id === demandId);
  const configuration = prepared.configuration;
  if (!demand || !configuration) throw new Error('Host 尚未提供完整的需求与资料审阅清单，请重新准备。');
  if (modelAuthorizationChanged(current, demand, configuration)) throw new Error('准备期间需求或资料范围已变化，请重新审阅。');
  const reason = modelAuthorizationUnavailable(current, demand);
  if (reason) throw new Error(reason);
  return { demand: structuredClone(demand), configuration: structuredClone(configuration) };
}
