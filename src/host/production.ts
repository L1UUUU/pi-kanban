import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import type { TranscriptContext, FetchFunction } from '@earendil-works/pi-ai';
import type { AgentMaterial } from '../agent/resources.ts';
import type { WorkerInit } from '../agent/worker-runtime.ts';
import type { WorkbenchStore, WorkflowService } from '../domain/index.ts';
import type { Demand, Methods, RunAttempt, Stage, WorkerReport } from '../domain/types.ts';
import { KnowledgeService } from '../knowledge/index.ts';
import type { KnowledgeRole } from '../knowledge/index.ts';
import { WorkspaceService, canonicalJson } from '../workspace/index.ts';
import { noLinks, canonicalDirectory } from '../workspace/paths.ts';
import { ModelBudgetLedger } from '../runtime/budget.ts';
import type { ModelGrant } from '../runtime/budget.ts';
import { ModelBroker } from '../runtime/model-broker.ts';
import type { BoundedProviderTransport, BoundedTransportRequest, ProviderResponse, BrokerMaterial } from '../runtime/model-broker.ts';
import { HostPiBrokerEndpoint, parsePiModelFrame } from '../runtime/pi-channel.ts';
import { verifyWindowsRuntimeProfile } from '../runtime/profile.ts';
import type { VerifiedRuntimeProfile, LockedRuntimeProfile } from '../runtime/profile.ts';
import { VerifiedWindowsDriver } from '../runtime/verified-windows-driver.ts';
import type { WindowsRunBootstrap, NativeCheckResult } from '../runtime/verified-windows-driver.ts';
import { RuntimeError } from '../runtime/types.ts';
import type { LaunchRequest, RuntimeDriver, RunRecord, Observation, ProcessIdentity } from '../runtime/types.ts';
import { loadMethods, runtimeProfileInput, configurationDigest } from './configuration.ts';
import type { WorkbenchConfiguration, ProviderConfiguration } from './configuration.ts';
import type { ExecutionPrerequisites } from './coordinator.ts';
import { ExecutionCoordinator } from './coordinator.ts';
import { RuntimeSupervisor } from '../runtime/supervisor.ts';
import { ProductionEvidence, hash } from './evidence.ts';

function insist(value: unknown, code: string, message: string): asserts value { if (!value) throw new RuntimeError(code, message); }
function reason(error: unknown): string { return error instanceof RuntimeError ? `${error.code}: ${error.message}` : 'HOST_RESOURCE_UNAVAILABLE: A required local resource could not be verified.'; }
function equal(a: unknown, b: string): boolean { if (typeof a !== 'string') return false; const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses';
const MAX_CONTEXT_BYTES = 512 * 1024;

/** Supported real adapter: the installed official Pi-ai OpenAI Responses adapter.
 * Only the explicitly configured catalog model and canonical endpoint can be used.
 * No automatic retry, redirect, ambient credential discovery, or Worker HTTP proxy.
 * pi-ai-cost-v1 is catalog-based usage accounting, not a guarantee about a future
 * provider invoice; an exceeded reservation is recorded and blocks the grant. */
export class PiOpenAITransport implements BoundedProviderTransport {
  readonly provider = 'openai'; readonly mode = 'real-provider' as const;
  readonly modelId: string; readonly destination = OPENAI_ENDPOINT;
  readonly model: ReturnType<ReturnType<typeof openaiProvider>['getModels']>[number];
  readonly reserveTokens: number; readonly reserveCostMicros: number;
  #resolveCredential: (reference: string) => string;
  #fetch: FetchFunction;
  constructor(configuration: ProviderConfiguration, resolveCredential: (reference: string) => string, fetchImplementation: FetchFunction = globalThis.fetch) {
    insist(configuration.provider === this.provider && configuration.destination === this.destination, 'PROVIDER_ADAPTER_UNSUPPORTED', 'Supported production provider is openai at the exact https://api.openai.com/v1/responses endpoint.');
    insist(configuration.limits?.meteringPolicy === 'pi-ai-cost-v1' && configuration.limits.currency === 'USD', 'METERING_UNSUPPORTED', 'The supported adapter requires explicit pi-ai-cost-v1 catalog usage accounting in USD.');
    const model = openaiProvider().getModels().find(candidate => candidate.id === configuration.modelId);
    insist(model && model.api === 'openai-responses' && model.baseUrl === 'https://api.openai.com/v1', 'MODEL_UNSUPPORTED', 'The exact model must exist in the installed pinned Pi-ai OpenAI Responses catalog.');
    this.model = structuredClone(model); this.modelId = model.id; this.#resolveCredential = resolveCredential; this.#fetch = fetchImplementation;
    const rate = Math.max(model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite);
    insist(Number.isFinite(rate) && rate > 0, 'METERING_UNAVAILABLE', 'A finite nonzero model catalog price is required.');
    this.reserveTokens = Math.min(32_768, model.contextWindow, configuration.limits.maxTokens);
    this.reserveCostMicros = Math.max(1, Math.ceil(this.reserveTokens * rate));
    insist(this.reserveTokens >= 1024 && this.reserveCostMicros <= configuration.limits.maxCostMicros, 'MODEL_BUDGET_TOO_SMALL', 'The configured grant cannot reserve one bounded model operation.');
  }
  async send(request: BoundedTransportRequest): Promise<ProviderResponse> {
    insist(request.provider === this.provider && request.modelId === this.modelId && request.destination === this.destination && request.materials.length === 1, 'TRANSPORT_SCOPE_DENIED', 'The transport accepts one authenticated normalized context for its exact configured model.');
    const material = request.materials[0]!;
    insist(hash(material.text) === material.sha256 && Buffer.byteLength(material.text) <= MAX_CONTEXT_BYTES, 'CONTEXT_INVALID', 'A bounded immutable context is required.');
    const context = JSON.parse(material.text) as TranscriptContext;
    insist(context && Array.isArray(context.messages), 'CONTEXT_INVALID', 'Pi normalized messages are required.');
    // UTF-8 bytes plus conservative framing allowance bound text-only input.
    // Image/audio/remote resource content is unsupported by this controlled path.
    for (const message of context.messages) {
      const content = (message as { content?: unknown }).content;
      if (Array.isArray(content)) insist(content.every(part => part && typeof part === 'object' && ['text', 'thinking', 'toolCall'].includes(String((part as { type?: string }).type))), 'MEDIA_UNSUPPORTED', 'Only local text and controlled tool calls are supported.');
    }
    const inputBound = Buffer.byteLength(material.text) + 4096;
    const outputBound = Math.min(this.model.maxTokens, request.maxTokens - inputBound);
    insist(outputBound >= 1, 'CONTEXT_BUDGET_EXHAUSTED', 'The actual context exceeds the remaining per-request token reservation.');
    const credential = this.#resolveCredential(request.credentialRef);
    insist(typeof credential === 'string' && credential.length > 0 && credential.length < 8192 && !/[\r\n]/.test(credential), 'CREDENTIAL_UNAVAILABLE', 'The explicitly referenced Host credential is unavailable.');
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]); let sent = false;
    const boundedFetch: FetchFunction = async (input, init) => {
      insist(!sent, 'PROVIDER_RETRY_DENIED', 'Each durable reservation authorizes exactly one HTTP attempt.');
      const wire = new Request(input, init); insist(wire.url === this.destination && wire.method === 'POST', 'DESTINATION_DENIED', 'The provider adapter attempted an unexpected endpoint or operation.');
      const body = await wire.text(); insist(Buffer.byteLength(body) <= 1024 * 1024, 'REQUEST_TOO_LARGE', 'Provider request exceeds the payload bound.');
      const payload = JSON.parse(body) as Record<string, unknown>;
      insist(payload.model === this.modelId && payload.max_output_tokens === outputBound && payload.store === false && payload.stream === true, 'PROVIDER_PAYLOAD_DENIED', 'Provider request changed a locked model, storage, stream or output limit.');
      sent = true; signal.throwIfAborted();
      const response = await this.#fetch(this.destination, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${credential}` }, body, redirect: 'error', signal });
      insist(response.status >= 200 && response.status < 300 && response.body, 'PROVIDER_HTTP_ERROR', 'The provider rejected the bounded request. Usage remains reserved until reconciled.');
      let bytes = 0;
      const boundedBody = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { bytes += chunk.byteLength; if (bytes > 2 * 1024 * 1024) { controller.error(new RuntimeError('PROVIDER_OUTPUT_LIMIT', 'Provider output exceeded its finite bound.')); return; } controller.enqueue(chunk); } }));
      return new Response(boundedBody, { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'text/event-stream' } });
    };
    const message = await streamSimple(this.model, context, { apiKey: credential, maxTokens: outputBound, maxRetries: 0, maxRetryDelayMs: 1, timeoutMs: 120_000, signal, fetch: boundedFetch, cacheRetention: 'none', transport: 'sse', env: {}, onPayload(payload) { const body = payload as Record<string, unknown>; body.store = false; body.max_output_tokens = outputBound; return body; } }).result();
    insist(!['error', 'aborted'].includes(message.stopReason), 'PROVIDER_COMPLETION_FAILED', 'The provider operation did not return a verified terminal completion.');
    const tokens = message.usage.totalTokens, costMicros = Math.ceil(message.usage.cost.total * 1_000_000);
    insist(Number.isSafeInteger(tokens) && tokens > 0 && Number.isSafeInteger(costMicros) && costMicros >= 0, 'USAGE_UNKNOWN', 'Provider completion lacks finite usage accounting.');
    return { text: message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'),
      toolCalls: message.content.filter(part => part.type === 'toolCall').map(part => ({ id: part.id, name: part.name, arguments: JSON.parse(JSON.stringify(part.arguments)) as NonNullable<ProviderResponse['toolCalls']>[number]['arguments'] })),
      usage: { tokens, costMicros, source: `pi-ai-1.1.0:${this.provider}:${this.modelId}:catalog-usage-estimate` } };
  }
}

export interface ProductionOptions {
  store: WorkbenchStore; workflow: WorkflowService; configuration: () => WorkbenchConfiguration;
  workspace: () => WorkspaceService; knowledge: KnowledgeService; budget: ModelBudgetLedger;
  /** Host-owned directory, never a configuration/Worker-selected path. */
  stateDirectory: string; trustedEvidenceRoot?: string;
  resolveCredential?: (reference: string) => string;
}
export interface ProductionDiagnostics { executionEnabled: boolean; blockers: string[]; profileVerified: boolean; budgetAvailable: boolean; workspaceVerified: boolean }
interface ActiveChannel { run: RunAttempt; runtime: RunRecord; init: WorkerInit; endpoint: HostPiBrokerEndpoint; abort: AbortController; ready: boolean; settled: boolean; modelObserved: boolean; pending: WorkerReport[]; handoffs: string[]; grantId: string; boundary: boolean; contextId: string; checks: Map<string, { args: unknown; result?: unknown }>; }

/** Executable composition, with an intentionally denied state whenever a real prerequisite
 * is missing. This factory never manufactures an executable profile or model grant. */
type NativeDriverPort = RuntimeDriver & Pick<VerifiedWindowsDriver, 'setStopHandler' | 'setWorkerFrameHandler' | 'sendWorkerFrame' | 'getResourceEvidence' | 'runNodeCheck'>;
export interface SyntheticProductionAdapters {
  profile: LockedRuntimeProfile;
  createDriver: (bootstrap: (run: RunRecord) => WindowsRunBootstrap) => NativeDriverPort;
  transport: BoundedProviderTransport;
}
/** Explicit deterministic harness. It can never select a real provider transport or verified-native driver. */
export function createSyntheticProductionServices(options: ProductionOptions, adapters: SyntheticProductionAdapters) {
  insist(adapters.transport.mode === 'synthetic-no-network', 'SYNTHETIC_TRANSPORT_REQUIRED', 'Synthetic composition cannot dispatch a real model transport.');
  return composeProductionServices(options, adapters);
}
export function createProductionServices(options: ProductionOptions) { return composeProductionServices(options); }
function composeProductionServices(options: ProductionOptions, synthetic?: SyntheticProductionAdapters) {
  const evidence = new ProductionEvidence(options.store.db, options.workspace);
  const channels = new Map<string, ActiveChannel>();
  let coordinator: ExecutionCoordinator | undefined, native: NativeDriverPort | undefined, profile: VerifiedRuntimeProfile | undefined, profileDigest = '';
  options.store.db.exec(`CREATE TABLE IF NOT EXISTS host_boundary_runs(domain_run_id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,context_id TEXT NOT NULL,runtime_run_id TEXT,status TEXT NOT NULL,body TEXT);
    CREATE TABLE IF NOT EXISTS host_native_revocations(run_id TEXT PRIMARY KEY,evidence TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS host_native_check_lease(singleton INTEGER PRIMARY KEY CHECK(singleton=1),runtime_run_id TEXT NOT NULL,request_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS host_native_checks(request_id TEXT PRIMARY KEY,runtime_run_id TEXT NOT NULL,domain_run_id TEXT NOT NULL,artifact_id TEXT NOT NULL,body TEXT NOT NULL);`);
  let boundaryNative: NativeDriverPort | undefined, boundarySupervisor: RuntimeSupervisor | undefined;
  let stopHandler: ((runId: string, reason: string) => Promise<void>) | undefined;
  const stateDirectory = resolve(options.stateDirectory);
  insist(isAbsolute(options.stateDirectory) && stateDirectory === options.stateDirectory, 'HOST_DIRECTORY_REQUIRED', 'An exact Host-owned state directory is required.');
  const trustedEvidenceRoot = options.trustedEvidenceRoot ?? join(stateDirectory, 'runtime-evidence');
  const resolveCredential = options.resolveCredential ?? ((reference: string) => {
    insist(/^env:[A-Z_][A-Z0-9_]{0,127}$/.test(reference), 'CREDENTIAL_REFERENCE_UNSUPPORTED', 'The built-in resolver supports only an explicit env:NAME credential reference.');
    const value = process.env[reference.slice(4)]; insist(value, 'CREDENTIAL_UNAVAILABLE', 'The explicitly named Host environment credential is not present.'); return value;
  });
  const config = () => options.configuration();
  function captureMethods(configuration = config()): Methods {
    const loaded = loadMethods(configuration);
    for (const stage of ['planning', 'implementation', 'review'] as const) if (loaded.methods[stage]) evidence.freezeMethod(loaded.methods[stage]!, loaded.materials[stage]);
    return loaded.methods;
  }
  function makeNative(): NativeDriverPort {
    const candidate = synthetic ? synthetic.createDriver(bootstrap) : new VerifiedWindowsDriver(profile!, bootstrap);
    insist(!synthetic || candidate.isolation === 'synthetic-process-supervision-only', 'SYNTHETIC_DRIVER_REQUIRED', 'Synthetic composition cannot launch a real native driver.'); return candidate;
  }
  function makeTransport(configuration: ProviderConfiguration) {
    insist(options.resolveCredential || /^env:[A-Z_][A-Z0-9_]{0,127}$/.test(configuration.credentialRef ?? ''), 'CREDENTIAL_REFERENCE_UNSUPPORTED', 'The built-in Host resolver requires an explicit env:NAME reference; no ambient credential discovery is performed.');
    const meta = new PiOpenAITransport(configuration, resolveCredential);
    if (!synthetic) return meta;
    insist(synthetic.transport.provider === meta.provider && synthetic.transport.modelId === meta.modelId && synthetic.transport.destination === meta.destination, 'SYNTHETIC_SCOPE_MISMATCH', 'Synthetic provider binding must match the declared production target.');
    return { provider: meta.provider, modelId: meta.modelId, destination: meta.destination, mode: synthetic.transport.mode, model: meta.model, reserveTokens: meta.reserveTokens, reserveCostMicros: meta.reserveCostMicros, send: (request: BoundedTransportRequest) => synthetic.transport.send(request) };
  }
  function refreshNative(): NativeDriverPort {
    const configuration = config(), digest = hash(canonicalJson(configuration.runtime));
    if (native && digest === profileDigest) return native;
    insist(!native || ![...channels.values()].some(channel => !channel.settled), 'RUNTIME_CONFIGURATION_BUSY', 'Stop and verify existing runs before replacing their exact runtime binding.');
    profile = synthetic ? { config: synthetic.profile, evidenceDigests: ['SYNTHETIC-NOT-ISOLATION-EVIDENCE'] } as unknown as VerifiedRuntimeProfile : verifyWindowsRuntimeProfile(runtimeProfileInput(configuration), trustedEvidenceRoot);
    native = makeNative();
    native.setWorkerFrameHandler(handleFrame); if (stopHandler) native.setStopHandler(stopHandler);
    profileDigest = digest; return native;
  }
  const driver: RuntimeDriver = {
    id: synthetic ? 'synthetic-production-composition' : 'windows-appcontainer-job-v1', get isolation() { return synthetic ? 'synthetic-process-supervision-only' : native ? 'verified-windows-native' : 'unverified-windows-candidate'; },
    setStopHandler(handler) { stopHandler = async (id, reason) => { channels.get(id)?.abort.abort(new RuntimeError('RUN_STOPPED', 'Run stopped.')); await handler(id, reason); }; native?.setStopHandler(stopHandler); },
    preflight(request) { refreshNative().preflight(request); },
    async launch(run) { return refreshNative().launch(run); },
    async stop(run) { channels.get(run.runId)?.abort.abort(new RuntimeError('RUN_STOPPED', 'Run stopped.')); const result = native ? await native.stop(run) : unknown(run); retainRevocation(run.runId, native); return result; },
    async observe(run) { const result = run.role === 'boundary-review' ? boundaryNative ? await boundaryNative.observe(run) : unknown(run) : native ? await native.observe(run) : unknown(run); retainRevocation(run.runId, run.role === 'boundary-review' ? boundaryNative : native); return result; },
  };
  function retainRevocation(id: string, driver: NativeDriverPort | undefined): void { const resource = driver?.getResourceEvidence(id); if (resource?.provisioned && resource.revoked && resource.status === 0) { options.store.db.prepare('INSERT OR IGNORE INTO host_native_revocations VALUES(?,?)').run(id, canonicalJson(resource)); options.store.db.prepare('DELETE FROM host_native_check_lease WHERE runtime_run_id=?').run(id); } }
  function unknown(run: RunRecord): Observation { return { state: 'unknown', generation: run.generation, activePids: [], proof: 'No matching verified native controller; absence is not process-tree evidence.' }; }
  function selectGrant(demandId: string, role: string): ModelGrant {
    const provider = config().provider; insist(provider, 'MODEL_CONFIGURATION_MISSING', 'Configure the exact model provider and finite request limits.');
    const rows = options.store.db.prepare('SELECT id FROM model_grants WHERE demand_id=? AND blocked=0 ORDER BY rowid DESC').all(demandId);
    const grant = rows.map(row => options.budget.getGrant(String(row.id))).find(grant => grant.provider === provider.provider && grant.modelId === provider.modelId && grant.destination === provider.destination && grant.credentialRef === provider.credentialRef && grant.meteringPolicy === provider.limits?.meteringPolicy && grant.allowedRoles.includes(role) && Date.parse(grant.expiresAt) > Date.now());
    insist(grant, 'MODEL_AUTHORIZATION_MISSING', 'A live, separate user-approved finite model/data grant matching this demand, role and exact provider is required.');
    const state = options.budget.snapshot(grant.id); insist(!state.blocked && state.requests < state.limits.requests && state.tokens < state.limits.tokens && state.costMicros < state.limits.costMicros, 'MODEL_BUDGET_EXHAUSTED', 'The bounded model authorization is exhausted or blocked.');
    return grant;
  }
  function stageFor(demand: Demand): Stage { const active = options.store.listRuns(demand.id).find(run => run.status !== 'stopped'); const requested = options.workflow.nextRequestedStage(demand.id); insist(requested || active || !demand.planningStarted, 'STAGE_AWAITS_USER', 'No next stage is authorized by the workflow.'); return requested ?? active?.stage ?? 'planning'; }
  function materialSet(demand: Demand, stage: Stage, runId?: string, boundary = false): AgentMaterial[] {
    const method = demand.methodSnapshot[stage]; insist(method, 'METHOD_MISSING', `Configure and explicitly select a ${stage} method for this demand.`);
    insist(method.adapter === 'explicit-text-v1', 'METHOD_ADAPTER_UNSUPPORTED', 'This production assembly supports only the explicit-text-v1 method adapter.');
    const materials = evidence.method(method);
    const input = canonicalJson({ title: demand.title, description: demand.description, messages: demand.messages.map(message => ({ id: message.id, text: message.text, kind: message.kind })) });
    materials.push({ id: `demand-input:${demand.id}`, kind: 'plan', sha256: hash(input), content: input });
    const source = evidence.sourceMaterial(demand.id); materials.push(source);
    const plan = demand.plans.find(plan => plan.id === demand.activePlanId);
    if (plan) materials.push(evidence.read(demand.id, plan.spec), evidence.read(demand.id, plan.tickets));
    if (stage === 'review' && !boundary) {
      const content = demand.contents.find(content => content.id === demand.activeContentId); insist(content && evidence.stable(demand.id, content.code), 'CONTENT_CHANGED', 'Review requires the exact immutable current code snapshot.');
      materials.push(evidence.read(demand.id, content.code), ...content.knowledge.map(ref => evidence.read(demand.id, ref)), ...demand.checks.filter(check => check.contentId === content.id).map(check => evidence.read(demand.id, check.evidence)));
    }
    // K chooses versions and filters permissions before any body is read. Only
    // explicit granted revision IDs can enter the candidate allowlist.
    if (runId) {
      const binding = options.workspace().getBinding(demand.id)!;
      const project = options.workspace().getProject(demand.projectId);
      const grant = selectGrant(demand.id, boundary ? 'boundary-review' : stage);
      const role: KnowledgeRole = stage === 'planning' ? 'planner' : stage === 'review' ? 'reviewer' : 'implementer';
      const manifest = options.knowledge.createContext({ runId, projectId: demand.projectId, demandId: demand.id, role, baseline: binding.currentBaseline, formalTarget: project.formalTarget, environment: config().runtime!.profileId,
        allowedRevisionIds: grant.data.filter(data => data.id.startsWith('knowledge:')).map(data => data.id.slice('knowledge:'.length)), purpose: `Controlled ${stage} context` });
      for (const id of manifest.revisionIds) { const item = options.knowledge.read(manifest.contextId, id); materials.push({ id: `knowledge:${id}`, kind: 'knowledge', sha256: item.object.sha256, content: item.body }); }
    }
    const deduplicated = new Map<string, AgentMaterial>();
    for (const material of materials) { const old = deduplicated.get(material.id); insist(!old || canonicalJson(old) === canonicalJson(material), 'MATERIAL_CONFLICT', 'Context contains conflicting immutable identities.'); deduplicated.set(material.id, material); }
    return [...deduplicated.values()];
  }
  function requiredModelData(demandId: string): { id: string; sha256: string }[] { const demand = options.store.getDemand(demandId), stage = stageFor(demand); const materials = materialSet(demand, stage); if (stage === 'planning') { insist(demand.methodSnapshot.review, 'BOUNDARY_METHOD_MISSING', 'Planning also requires the frozen independent review method.'); materials.push(...evidence.method(demand.methodSnapshot.review)); } return [...new Map(materials.map(({ id, sha256 }) => [id, { id, sha256 }])).values()]; }
  function approvedMaterials(grant: ModelGrant, materials: AgentMaterial[]): void { insist(materials.every(material => grant.data.some(data => data.id === material.id && data.sha256 === material.sha256)), 'MODEL_DATA_APPROVAL_MISSING', 'The current demand text, source scope, frozen method, and selected artifact versions must all be covered by the explicit data approval.'); }
  function diagnostics(demandId?: string): ProductionDiagnostics {
    const blockers: string[] = []; let profileVerified = false, budgetAvailable = false, workspaceVerified = false;
    try { refreshNative(); profileVerified = true; } catch (error) { blockers.push(reason(error)); }
    if (!demandId) return { executionEnabled: false, blockers: [...blockers, 'Select a demand to verify its frozen methods, dedicated worktree, and finite data/model approval.'], profileVerified, budgetAvailable, workspaceVerified };
    try {
      const demand = options.store.getDemand(demandId), stage = stageFor(demand);
      evidence.method(demand.methodSnapshot[stage]!);
      const source = evidence.sourceMaterial(demandId); workspaceVerified = !!source.sha256;
      const provider = config().provider; insist(provider, 'MODEL_CONFIGURATION_MISSING', 'Explicit provider configuration is missing.');
      const transport = makeTransport(provider), grant = selectGrant(demandId, stage);
      const materials = materialSet(demand, stage); approvedMaterials(grant, materials);
      insist((grant as ModelGrant & { contextPolicy?: string }).contextPolicy === 'approved-run-derived-v1', 'CONTEXT_PERMISSION_MISSING', 'Tool-based execution requires explicit approved-run-derived-v1 permission for the verified run inputs and generated history.');
      const state = options.budget.snapshot(grant.id); insist(state.tokens + transport.reserveTokens <= state.limits.tokens && state.costMicros + transport.reserveCostMicros <= state.limits.costMicros, 'MODEL_BUDGET_EXHAUSTED', 'Insufficient remaining reservation for one supported provider operation.');
      const decision = options.store.db.prepare('SELECT runtime_scope FROM host_model_decisions WHERE grant_id=? AND demand_id=? AND decision_id=?').get(grant.id, demandId, grant.decisionId);
      insist(decision?.runtime_scope === 'demand-worktree-private-runtime-v1', 'RUNTIME_ACCESS_APPROVAL_MISSING', 'Explicit bounded worktree/runtime/scratch access approval is missing.');
      if (stage === 'planning') { insist(demand.methodSnapshot.review && grant.allowedRoles.includes('boundary-review'), 'BOUNDARY_REVIEW_PERMISSION_MISSING', 'Planning needs the frozen review method and a finite boundary-review model role grant.'); approvedMaterials(grant, evidence.method(demand.methodSnapshot.review)); }
      const pendingBoundary = options.store.listRuns(demandId).some(run => options.store.db.prepare("SELECT 1 FROM host_boundary_runs WHERE domain_run_id=? AND status NOT IN ('complete','failed')").get(run.id));
      insist(!pendingBoundary, 'BOUNDARY_REVIEW_PENDING', 'Independent boundary review is in progress; no replacement planner will start.');
      budgetAvailable = true;
    } catch (error) { blockers.push(reason(error)); }
    return { executionEnabled: profileVerified && budgetAvailable && workspaceVerified, blockers, profileVerified, budgetAvailable, workspaceVerified };
  }
  function assertRun(channel: ActiveChannel): void {
    const run = options.store.getRun(channel.run.id), demand = options.store.getDemand(run.demandId);
    const runtime = coordinator?.supervisor.get(channel.runtime.runId);
    insist(runtime && ['launch_intent', 'running'].includes(runtime.state) && runtime.stopReason === null, 'RUNTIME_STOPPING', 'Durable runtime stop intent forbids further model requests.');
    insist(!channel.abort.signal.aborted && (channel.boundary ? ['starting', 'running', 'stopped'].includes(run.status) : ['starting', 'running'].includes(run.status)) && demand.control === 'active' && !demand.blockedReasons.length && run.generation === channel.run.generation && run.cycle === demand.cycle && (!run.planId || run.planId === demand.activePlanId) && (!run.contentId || run.contentId === demand.activeContentId), 'RUN_AUTHORITY_CHANGED', 'This model context no longer belongs to the current active authorized generation.');
  }
  function bootstrap(runtime: RunRecord): WindowsRunBootstrap {
    insist(coordinator && profile, 'HOST_CHANNEL_UNBOUND', 'Bind the coordinator before native launch.');
    const run = options.store.getRun(runtime.grantId), demand = options.store.getDemand(run.demandId), boundary = runtime.role === 'boundary-review', grant = selectGrant(run.demandId, runtime.role);
    const boundaryRow = boundary ? options.store.db.prepare('SELECT * FROM host_boundary_runs WHERE domain_run_id=?').get(run.id) : undefined;
    const contextId = boundary ? String(boundaryRow?.context_id ?? '') : run.contextId;
    insist((runtime.role === run.stage || (boundary && run.stage === 'planning' && boundaryRow?.status === 'launching')) && runtime.workspace === options.workspace().getBinding(run.demandId)?.worktreePath && (boundary || run.status === 'starting') && canonicalJson(run.method) === canonicalJson(demand.methodSnapshot[run.stage]), 'RUN_BINDING_CHANGED', 'Native launch does not match the exact current domain run and frozen method.');
    const materials = materialSet(demand, boundary ? 'review' : run.stage, boundary ? `boundary-${runtime.runId}` : run.id, boundary); approvedMaterials(grant, materials);
    const provider = config().provider!, transport = makeTransport(provider);
    const scratch = join(stateDirectory, 'runs', runtime.runId); noLinks(scratch, true); mkdirSync(scratch, { recursive: true, mode: 0o700 }); noLinks(scratch);
    const sessionDir = join(scratch, 'session'); mkdirSync(sessionDir, { mode: 0o700 });
    const init: WorkerInit = { version: 1, type: 'worker.init', runId: runtime.runId, generation: runtime.generation, domainRunId: run.id, domainGeneration: run.generation, demandId: run.demandId, role: runtime.role,
      workspace: runtime.workspace, scratch, sessionDir, sessionId: randomUUID(), capability: randomBytes(32).toString('hex'), materials,
      prompt: `Carry out only the ${runtime.role} task in the supplied frozen method and approved inputs. Use controlled_report for immutable evidence. Artifact bodies may be supplied as artifactBodies:[{id,kind,text}] alongside the report; references can use {id,digest:'pending',location:'host-artifact'} and the Host replaces only registered matching bodies. Check evidence must use the exact evidence reference returned by a completed controlled_node tool. Only native receipts with reason exited and exitCode zero can support passed checks. All existing references use pi-object:<SHA256>:<UTF8 byte count>. For content-ready use code.location="current-worktree" and the Host will capture source only after actual process-tree stop. plan-ready requires an actually observed separate boundary review; never invent its identity or evidence. Report blocked if a required capability or independent review is unavailable. User controls and permissions are Host-owned.`,
      model: { provider: transport.provider, id: transport.modelId, contextWindow: transport.model.contextWindow, maxTokens: Math.min(8192, transport.model.maxTokens) },
      compaction: { enabled: false, reserveTokens: 8192, keepRecentTokens: 4096 }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, limits: { maxFileBytes: 1024 * 1024, commandTimeoutMs: 120_000, maxOutputBytes: 1024 * 1024 } };
    let endpoint!: HostPiBrokerEndpoint, channel!: ActiveChannel;
    const broker = new ModelBroker({ ledger: options.budget, transport, realChannelVerified: !synthetic, readMaterial: async id => endpoint.readMaterial(id), authorizeRun: (id, demandId, role) => { insist(id === runtime.runId && demandId === run.demandId && role === runtime.role, 'CHANNEL_IDENTITY_DENIED', 'Broker run scope mismatch.'); assertRun(channel); } });
    endpoint = new HostPiBrokerEndpoint({ db: options.store.db, ledger: options.budget, broker, binding: { runId: runtime.runId, generation: runtime.generation, sessionId: init.sessionId, capability: init.capability, grantId: grant.id, role: runtime.role, reserveTokens: transport.reserveTokens, reserveCostMicros: transport.reserveCostMicros },
      authorizeRun: () => assertRun(channel), authorizeContext: async (material: BrokerMaterial) => {
        assertRun(channel); insist(channel.ready && profile && (boundary ? boundaryNative : native)?.getResourceEvidence(runtime.runId)?.provisioned === true, 'WORKER_NOT_READY', 'Native private Worker context has not been observed ready.');
        const current = selectGrant(run.demandId, runtime.role); insist(current.id === grant.id, 'MODEL_GRANT_CHANGED', 'The bound grant cannot be silently replaced.'); approvedMaterials(current, materials);
        insist((current as ModelGrant & { contextPolicy?: string }).contextPolicy === 'approved-run-derived-v1', 'CONTEXT_PERMISSION_MISSING', 'Generated run context was not explicitly approved.');
        insist(Buffer.byteLength(material.text) <= MAX_CONTEXT_BYTES, 'CONTEXT_TOO_LARGE', 'Generated context exceeds the bounded data channel.');
        return { decisionId: current.decisionId };
      } });
    if (boundary) init.prompt = `Artifact references may use {id,digest:'pending',location:'host-artifact'} matching artifactBodies. Independently review the exact current plan ${run.planId} against the supplied source, scope and review method. You have a new empty read-only session with context ${contextId}; planning context is ${run.contextId}. No planner conversation or summaries are supplied. Report plan-ready only after checking boundary, tickets, acceptance/check coverage, scope, and unresolved questions, with boundaryReview:{contextId:'${contextId}',planningContextId:'${run.contextId}',evidence:<registered artifact ref>,unresolvedBlockingFindings:[]}. Include artifactBodies:[{id,kind:'check-evidence',text}] with concrete review observations and references. Report blocked if any unresolved blocker exists. Never claim to have run a check without an observed controlled_node result.`;
    channel = { run, runtime, init, endpoint, abort: new AbortController(), ready: false, settled: false, modelObserved: false, pending: [], handoffs: [], grantId: grant.id, boundary, contextId, checks: new Map() }; channels.set(runtime.runId, channel);
    evidence.recordRun(boundary ? { ...run, id: `boundary-${runtime.runId}`, stage: 'review', contextId } : run, { materials, source: materials.find(m => m.id === `source-scope:${run.demandId}`)!, role: runtime.role, sessionId: init.sessionId, runtimeRunId: runtime.runId, generation: runtime.generation });
    if (boundary) options.store.db.prepare('UPDATE host_boundary_runs SET runtime_run_id=?,body=? WHERE domain_run_id=?').run(runtime.runId, canonicalJson({ materials, source: materials.find(m => m.kind === 'source'), sessionId: init.sessionId }), run.id);
    const roots = [...new Set([profile.config.node.path, profile.config.worker.path].map(file => canonicalDirectory(dirname(file))))];
    for (const root of roots) { for (const protectedPath of [stateDirectory, dirname(stateDirectory), ...options.store.listProjects().map(project => project.rootPath)]) { const rel = relative(root, protectedPath); insist(rel.startsWith('..') || isAbsolute(rel), 'RUNTIME_ROOT_UNSAFE', 'A runtime dependency root cannot include Host state, project anchors or private sessions.'); } }
    return { profileName: `pi-kanban-${runtime.demandId}-${runtime.role}-${runtime.generation}`, scratch,
      aclEvidence: profile.evidenceDigests.join(','), privateChannelEvidence: profile.evidenceDigests.join(','), processLimit: 8, memoryLimitBytes: 1024 * 1024 * 1024, workerInit: init as unknown as Record<string, unknown>,
      resourceAuthorizationId: grant.decisionId, readonlyRuntimeRoots: roots } as WindowsRunBootstrap;
  }
  function ingestReport(channel: ActiveChannel, input: unknown): WorkerReport {
    insist(input && typeof input === 'object' && !Array.isArray(input), 'REPORT_INVALID', 'A typed report object is required.');
    const raw = input as Record<string, unknown>, { artifactBodies, ...value } = raw;
    insist(value.runId === channel.run.id && value.demandId === channel.run.demandId && value.generation === channel.run.generation && typeof value.requestId === 'string', 'CHANNEL_IDENTITY_DENIED', 'Report does not match its private native channel.');
    if (artifactBodies !== undefined) {
      insist(Array.isArray(artifactBodies) && artifactBodies.length <= 32, 'ARTIFACT_LIMIT', 'At most 32 bounded artifact bodies may accompany a report.');
      const demand = options.store.getDemand(channel.run.demandId);
      for (const item of artifactBodies) {
        const artifact = item as { id: string; kind: AgentMaterial['kind']; text: string };
        insist(artifact && ['plan', 'knowledge', 'check-evidence'].includes(artifact.kind), 'ARTIFACT_KIND_DENIED', 'Only plan, knowledge and check-evidence bodies are accepted from reports.');
        const ref = evidence.save({ ...artifact, projectId: demand.projectId, demandId: demand.id, runId: channel.run.id });
        const grant = options.budget.getGrant(channel.grantId);
        insist(channel.modelObserved && grant.contextPolicy === 'approved-run-derived-v1', 'DERIVED_ARTIFACT_DENIED', 'Only model-observed artifacts from the explicitly approved generated context can enter later model input.');
        options.budget.authorizeData({ grantId: grant.id, decisionId: grant.decisionId, material: { id: ref.id, sha256: ref.digest } }, () => {});
      }
    }
    const substitute = (item: unknown): unknown => { if (Array.isArray(item)) return item.map(substitute); if (item && typeof item === 'object') { const object = item as Record<string, unknown>; if (object.location === 'host-artifact' && typeof object.id === 'string') return evidence.reference(channel.run.demandId, object.id); return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, substitute(child)])); } return item; };
    return substitute(value) as WorkerReport;
  }
  async function settle(channel: ActiveChannel): Promise<void> {
    insist(coordinator, 'HOST_CHANNEL_UNBOUND', 'Coordinator is unavailable.');
    channel.settled = true; channel.abort.abort();
    const stopped = await (channel.boundary ? boundarySupervisor! : coordinator.supervisor).stop(channel.runtime.runId, 'worker-terminal-handoff');
    if (stopped.state !== 'stopped' || (channel.boundary ? boundaryNative : native)?.getResourceEvidence(channel.runtime.runId)?.revoked !== true) { options.workflow.markInterrupted(channel.run.id, 'Worker handoff has no verified complete native Job stop.'); return; }
    retainRevocation(channel.runtime.runId, channel.boundary ? boundaryNative : native);
    for (const queued of channel.pending) {
      if (queued.type === 'content-ready' && queued.content.code.location === 'current-worktree') {
        const demand = options.store.getDemand(channel.run.demandId);
        queued.content.code = evidence.saveSource(demand.projectId, demand.id, channel.run.id, queued.content.code.id);
        const grant = options.budget.getGrant(channel.grantId); const scope = evidence.sourceMaterial(demand.id);
        for (const material of [{ id: queued.content.code.id, sha256: queued.content.code.digest }, { id: scope.id, sha256: scope.sha256 }]) options.budget.authorizeData({ grantId: grant.id, decisionId: grant.decisionId, material }, () => { insist(channel.modelObserved && grant.contextPolicy === 'approved-run-derived-v1', 'DERIVED_CONTEXT_DENIED', 'Generated source permission requires the original explicit derived-run policy.'); });
      }
      if (channel.boundary && queued.type === 'plan-ready') {
        insist(channel.modelObserved && channel.ready && channel.init.role === 'boundary-review' && channel.contextId !== channel.run.contextId && evidence.sourceMaterial(channel.run.demandId).sha256 === channel.init.materials.find(m => m.id === `source-scope:${channel.run.demandId}`)?.sha256, 'BOUNDARY_REVIEW_UNVERIFIED', 'The independent review did not retain its exact read-only source/context.');
        evidence.read(channel.run.demandId, queued.boundaryReview.evidence);
        options.store.db.prepare("UPDATE host_boundary_runs SET status='observed',body=? WHERE domain_run_id=?").run(canonicalJson({ runId: channel.runtime.runId, contextId: channel.contextId, planningRunId: channel.run.id, planId: queued.planId, evidenceDigest: queued.boundaryReview.evidence.digest, actualReviewObserved: true, isolatedInputsVerified: true }), channel.run.id);
      }
      const receipt = coordinator.report(channel.run.id, queued);
      if (channel.boundary && receipt.status === 'applied') options.store.db.prepare("UPDATE host_boundary_runs SET status='complete' WHERE domain_run_id=?").run(channel.run.id); if (receipt.status === 'applied') channel.handoffs.push(queued.type);
    }
    channel.pending.length = 0;
    if (channel.boundary && !channel.handoffs.includes('plan-ready')) { options.store.db.prepare("UPDATE host_boundary_runs SET status='failed' WHERE domain_run_id=?").run(channel.run.id); const current = options.store.getDemand(channel.run.demandId); if (current.activePlanId === channel.run.planId && current.cycle === channel.run.cycle && current.control === 'active') options.workflow.blockDemand(channel.run.demandId, 'BOUNDARY_REVIEW_FAILED', 'The independent reviewer stopped without a verified ready handoff.'); }
    if (!channel.boundary && channel.run.stage === 'planning' && channel.handoffs.includes('plan-draft')) await launchBoundary(channel);
  }
  async function launchBoundary(planning: ActiveChannel): Promise<void> {
    insist(profile, 'PROFILE_UNVERIFIED', 'Native profile is missing.');
    const run = options.store.getRun(planning.run.id), demand = options.store.getDemand(run.demandId);
    const plan = demand.plans.find(plan => plan.id === run.planId);
    if (demand.control !== 'active' || demand.blockedReasons.length || !plan || plan.unresolvedQuestions.length) { options.store.db.prepare("UPDATE host_boundary_runs SET status='failed' WHERE domain_run_id=?").run(run.id); if (plan?.unresolvedQuestions.length) options.workflow.blockDemand(run.demandId, 'PLAN_QUESTIONS_UNRESOLVED', 'The current plan has unresolved questions before boundary review.'); return; }
    try {
      selectGrant(demand.id, 'boundary-review');
      options.store.db.prepare("UPDATE host_boundary_runs SET status='launching' WHERE domain_run_id=?").run(run.id);
      boundaryNative ??= makeNative(); boundaryNative.setWorkerFrameHandler(handleFrame);
      boundarySupervisor ??= new RuntimeSupervisor(options.store.db, boundaryNative, request => {
        const current = options.store.getRun(request.grantId), currentDemand = options.store.getDemand(current.demandId);
        const pending = options.store.db.prepare("SELECT * FROM host_boundary_runs WHERE domain_run_id=? AND status='launching'").get(current.id);
        insist(request.role === 'boundary-review' && !request.writes && pending && pending.plan_id === currentDemand.activePlanId && currentDemand.control === 'active' && !currentDemand.blockedReasons.length, 'BOUNDARY_SCOPE_DENIED', 'Independent reviewer authorization no longer matches the current plan.');
        selectGrant(currentDemand.id, 'boundary-review');
      });
      boundaryNative.setStopHandler(async (id, why) => { channels.get(id)?.abort.abort(); await boundarySupervisor!.stop(id, why); retainRevocation(id, boundaryNative); });
      await boundarySupervisor.launch({ demandId: run.demandId, grantId: run.id, role: 'boundary-review', writes: false, workspace: planning.runtime.workspace, profileId: profile.config.profileId, timeoutMs: 30 * 60_000, maxOutputBytes: 16 * 1024 * 1024 });
    } catch (error) { options.store.db.prepare("UPDATE host_boundary_runs SET status='failed' WHERE domain_run_id=?").run(run.id); options.workflow.blockDemand(run.demandId, 'BOUNDARY_REVIEW_FAILED', reason(error)); }
  }
  function prepareDemand(demandId: string, baseline: string | null) {
    const demand = options.store.getDemand(demandId), workspace = options.workspace(), project = workspace.getProject(demand.projectId);
    const existing = workspace.getBinding(demandId); if (existing) { workspace.inspectContent({ demandId, expectedCommit: existing.head }); return existing; }
    return workspace.prepare({ operationId: `prepare-${demandId}`, projectId: demand.projectId, demandId, worktreePath: join(project.anchorPath, '.local', 'pi-kanban', 'worktrees', demandId), branch: `pi-kanban/${demandId}`, baseline, prepareAuthorized: true });
  }
  async function handleFrame(runtime: RunRecord, frame: Uint8Array): Promise<void> {
    insist(frame.byteLength <= 1024 * 1024, 'FRAME_SIZE', 'Worker frame exceeds bound.');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)) as Record<string, unknown>;
    const channel = channels.get(runtime.runId); insist(channel && channel.runtime.generation === runtime.generation && (channel.boundary ? boundaryNative : native), 'CHANNEL_IDENTITY_DENIED', 'No exact live private channel binding.');
    const targetDriver = (channel.boundary ? boundaryNative : native)!;
    if (value.type === 'model.request') {
      const request = parsePiModelFrame(frame);
      try { const response = await channel.endpoint.handle(frame, channel.abort.signal); channel.modelObserved = true; targetDriver.sendWorkerFrame(runtime.runId, { sequence: request.sequence, ok: true, value: response }); }
      catch (error) { targetDriver.sendWorkerFrame(runtime.runId, { sequence: request.sequence, ok: false, error: error instanceof RuntimeError ? error.code : 'MODEL_CHANNEL_ERROR' }); }
      return;
    }
    insist(value.generation === runtime.generation && (value.runId === runtime.runId || value.runtimeRunId === runtime.runId), 'CHANNEL_IDENTITY_DENIED', 'Worker event identity mismatch.');
    if (value.type === 'worker.ready') { insist(value.sessionId === channel.init.sessionId && !channel.ready, 'SESSION_IDENTITY_DENIED', 'Worker session identity mismatch or replay.'); channel.ready = true; return; }
    if (value.type === 'worker.event') return; // Worker telemetry never proves subprocess completion.
    if (value.type === 'worker.settled') { insist(value.sessionId === channel.init.sessionId && !channel.settled, 'SESSION_IDENTITY_DENIED', 'Unknown or replayed terminal event.'); await settle(channel); return; }
    insist(equal(value.capability, channel.init.capability), 'CHANNEL_CAPABILITY_DENIED', 'Private capability mismatch.');
    if (value.type === 'worker.check-request') {
      assertRun(channel);
      insist(typeof value.requestId === 'string' && /^[a-zA-Z0-9-]{1,200}$/.test(value.requestId) && typeof value.toolCallId === 'string' && value.toolCallId.length <= 200 && Array.isArray(value.args) && value.args.length > 0 && value.args.length <= 64 && value.args.every(arg => typeof arg === 'string' && !arg.includes('\0') && arg.length <= 8192) && value.args.join('').length <= 32768, 'CHECK_SCOPE_DENIED', 'Only a bounded Node argument vector is accepted.');
      const requestId = value.requestId, args = value.args as string[];
      let leased = false;
      try {
        insist(!options.store.db.prepare('SELECT 1 FROM host_native_check_lease').get(), 'CHECK_CAPACITY', 'Another native check owns the single global check slot; wait for its observed completion.');
        insist(!options.store.db.prepare('SELECT 1 FROM host_native_checks WHERE request_id=?').get(requestId), 'CHECK_REPLAY', 'A native command request ID cannot execute twice.');
        options.store.db.prepare('INSERT INTO host_native_check_lease VALUES(1,?,?)').run(runtime.runId, requestId); leased = true;
        const observation = await targetDriver.runNodeCheck(runtime.runId, args, { timeoutMs: 120_000, maxOutputBytes: 524_288 }, requestId);
        insist(observation.requestId === requestId && ['exited', 'timeout', 'output-limit', 'descendants-survived', 'launch-failed'].includes(observation.reason), 'NATIVE_CHECK_INVALID', 'Native receipt does not match the requested operation.');
        const { outputBase64: _duplicateOutput, ...nativeEvidence } = observation.nativeEvidence;
        const record = { provenance: synthetic ? 'synthetic-native-receipt' : 'native-helper-command-observation', runtimeRunId: runtime.runId, generation: runtime.generation, toolCallId: value.toolCallId, args, requestId, exitCode: observation.exitCode, reason: observation.reason, output: observation.output, nativeEvidence: { ...nativeEvidence, outputSha256: hash(observation.output) } };
        const demand = options.store.getDemand(channel.run.demandId);
        const ref = evidence.save({ id: `native-check-${requestId}`, projectId: demand.projectId, demandId: demand.id, runId: channel.run.id, kind: 'check-evidence', text: canonicalJson(record) });
        options.store.db.prepare('INSERT INTO host_native_checks VALUES(?,?,?,?,?)').run(requestId, runtime.runId, channel.run.id, ref.id, canonicalJson(record));
        const grant = options.budget.getGrant(channel.grantId); options.budget.authorizeData({ grantId: grant.id, decisionId: grant.decisionId, material: { id: ref.id, sha256: ref.digest } }, () => { insist(grant.contextPolicy === 'approved-run-derived-v1', 'DERIVED_CONTEXT_DENIED', 'Native tool-result transmission requires the existing explicit generated-run permission.'); });
        if (observation.reason === 'exited') options.store.db.prepare('DELETE FROM host_native_check_lease WHERE request_id=?').run(requestId);
        else { channel.abort.abort(); await (channel.boundary ? boundarySupervisor! : coordinator!.supervisor).stop(runtime.runId, 'native-check-incomplete'); retainRevocation(runtime.runId, targetDriver); }
        targetDriver.sendWorkerFrame(runtime.runId, { type: 'worker.check-result', requestId, ok: true, value: { requestId, exitCode: observation.exitCode, output: observation.output, reason: observation.reason, evidence: ref } });
      } catch (error) {
        // Once native launch may have started, only an actual native Job stop can
        // release the global slot. No timeout/error is treated as zero effects.
        if (leased) { channel.abort.abort(); await (channel.boundary ? boundarySupervisor! : coordinator!.supervisor).stop(runtime.runId, 'native-check-unverified'); retainRevocation(runtime.runId, targetDriver); }
        targetDriver.sendWorkerFrame(runtime.runId, { type: 'worker.check-result', requestId, ok: false, error: error instanceof RuntimeError ? error.code : 'NATIVE_CHECK_UNVERIFIED' });
      }
      return;
    }
    if (value.type === 'worker.stop-required') { if (channel.boundary) { channel.abort.abort(); await boundarySupervisor!.stop(runtime.runId, 'worker-tool-stop-required'); } else await coordinator!.stopDomainRun(channel.run.id, 'worker-tool-stop-required'); return; }
    insist(value.type === 'worker.report' && channel.ready, 'FRAME_TYPE_DENIED', 'Unknown Worker frame.');
    const report = ingestReport(channel, value.report);
    try {
      if (report.type === 'content-ready' || (channel.boundary && report.type === 'plan-ready')) { insist(channel.pending.length === 0, 'REPORT_PENDING', 'One immutable terminal content report is already queued.'); channel.pending.push(report); targetDriver.sendWorkerFrame(runtime.runId, { type: 'worker.receipt', requestId: report.requestId, ok: true, value: { status: 'pending-stop-verification' } }); }
      else { insist(!channel.boundary || report.type === 'blocked', 'BOUNDARY_REPORT_DENIED', 'A boundary reviewer can only submit its ready evidence or a blocker.'); const receipt = coordinator!.report(channel.run.id, report);
        if (report.type === 'plan-draft') options.store.db.prepare("INSERT INTO host_boundary_runs VALUES(?,?,?,NULL,'pending',NULL) ON CONFLICT(domain_run_id) DO NOTHING").run(channel.run.id, report.plan.id, `boundary-context-${randomUUID()}`); if ((receipt.status === 'applied' || (receipt.status === 'noop' && report.type === 'plan-draft')) && ['plan-draft', 'review', 'check', 'resolve-finding', 'blocked'].includes(report.type)) channel.handoffs.push(report.type); targetDriver.sendWorkerFrame(runtime.runId, { type: 'worker.receipt', requestId: report.requestId, ok: true, value: receipt }); }
    } catch (error) { targetDriver.sendWorkerFrame(runtime.runId, { type: 'worker.receipt', requestId: report.requestId, ok: false, error: error instanceof RuntimeError ? error.code : 'REPORT_REJECTED' }); }
  }
  const prerequisites: ExecutionPrerequisites = {
    inspect: diagnostics,
    launchFor(run) { const facts = diagnostics(run.demandId); insist(facts.executionEnabled && profile, 'EXECUTION_BLOCKED', facts.blockers.join('; ')); return { workspace: options.workspace().getBinding(run.demandId)!.worktreePath, profileId: profile.config.profileId, timeoutMs: 30 * 60_000, maxOutputBytes: 16 * 1024 * 1024 }; },
    verifyWorkspaceAfterStop(demandId) { try { evidence.source(demandId); const runs = coordinator?.supervisor.list().filter(run => run.demandId === demandId && run.state === 'stopped') ?? []; return runs.length > 0 && runs.every(run => !!options.store.db.prepare('SELECT 1 FROM host_native_revocations WHERE run_id=?').get(run.runId) || (run.role === 'boundary-review' ? boundaryNative : native)?.getResourceEvidence(run.runId)?.revoked === true); } catch { return false; } },
    verifyReport(report, run) {
      const runtime = coordinator?.supervisor.list().find(runtime => runtime.grantId === run.id);
      if (report.type === 'plan-ready') {
        const row = options.store.db.prepare("SELECT * FROM host_boundary_runs WHERE domain_run_id=? AND status IN ('observed','complete')").get(run.id);
        insist(row?.body && row.plan_id === report.planId, 'BOUNDARY_REVIEW_UNAVAILABLE', 'No independently observed read-only boundary review covers this exact plan.');
        const demand = options.store.getDemand(run.demandId), plan = demand.plans.find(plan => plan.id === report.planId);
        insist(plan, 'PLAN_MISSING', 'The reviewed plan is unavailable.');
        for (const ref of [plan.spec, plan.tickets, report.boundaryReview.evidence]) evidence.read(run.demandId, ref);
        return { artifactsVerified: true, boundaryReview: JSON.parse(String(row.body)) };
      }
      if (report.type === 'check') {
        const row = options.store.db.prepare('SELECT body FROM host_native_checks WHERE domain_run_id=? AND artifact_id=?').get(run.id, report.check.evidence.id);
        insist(run.stage === 'review' && row, 'CHECK_EXECUTION_UNVERIFIED', 'Check evidence requires an actually observed native subprocess receipt from this independent review run.');
        const observed = JSON.parse(String(row.body)) as { reason: string; exitCode: number | null; generation: string; runtimeRunId: string };
        insist(runtime && observed.runtimeRunId === runtime.runId && observed.generation === runtime.generation, 'CHECK_GENERATION_MISMATCH', 'Native command receipt belongs to another execution generation.');
        insist(report.check.status !== 'passed' || (observed.reason === 'exited' && observed.exitCode === 0), 'CHECK_NOT_PASSED', 'Only an observed clean native exit may support a passed check.');
        const content = options.store.getDemand(run.demandId).contents.find(content => content.id === report.check.contentId);
        insist(content && evidence.stable(run.demandId, content.code), 'CHECK_CONTENT_CHANGED', 'Native check does not cover the current exact source snapshot.');
      }
      return evidence.verification(report, run, runtime?.state === 'stopped');
    },
    classifyExit(run) { const channel = [...channels.values()].find(channel => channel.run.id === run.id);
      return channel?.settled && channel.modelObserved && channel.handoffs.length ? { outcome: 'handoff', evidence: `Authenticated native terminal context ${channel.init.sessionId}; verified reports: ${channel.handoffs.join(', ')}.` } : { outcome: 'unknown', evidence: 'No verified terminal model/tool handoff for this exact native generation.' }; },
  };
  function auxiliaryStatus(): { safe: boolean; blockers: string[] } { const runs = coordinator?.supervisor.list().filter(run => run.role === 'boundary-review') ?? []; const unresolved = runs.filter(run => run.state !== 'stopped' || !options.store.db.prepare('SELECT 1 FROM host_native_revocations WHERE run_id=?').get(run.runId)); return { safe: unresolved.length === 0, blockers: unresolved.map(run => `Independent boundary review ${run.demandId}: ${run.state}; complete native stop/resource revocation is required.`) }; }
  async function stopAllAuxiliary(reason = 'user-stop'): Promise<void> {
    // Durable rows remain authoritative after Host restart. Missing live handles
    // still receive stop intent and remain unknown/occupied, never disappear.
    for (const runtime of coordinator?.supervisor.list().filter(run => run.role === 'boundary-review') ?? []) {
      channels.get(runtime.runId)?.abort.abort();
      if (boundarySupervisor && channels.has(runtime.runId)) await boundarySupervisor.stop(runtime.runId, reason);
      else await coordinator!.supervisor.stop(runtime.runId, reason);
      retainRevocation(runtime.runId, boundaryNative);
    }
  }
  async function tick(): Promise<void> {
    for (const runtime of coordinator?.supervisor.list().filter(run => run.role === 'boundary-review' && run.state !== 'stopped' && !channels.has(run.runId)) ?? []) {
      const demand = options.store.getDemand(runtime.demandId);
      if (demand.control !== 'active' || demand.blockedReasons.length) await coordinator!.supervisor.stop(runtime.runId, 'recovered-workflow-control-changed');
    }
    for (const channel of channels.values()) if (channel.boundary && boundarySupervisor) {
      const demand = options.store.getDemand(channel.run.demandId);
      if (demand.control !== 'active' || demand.blockedReasons.length || channel.run.planId !== demand.activePlanId) { channel.abort.abort(); await boundarySupervisor.stop(channel.runtime.runId, 'workflow-control-changed'); retainRevocation(channel.runtime.runId, boundaryNative); options.store.db.prepare("UPDATE host_boundary_runs SET status='failed' WHERE domain_run_id=? AND status!='complete'").run(channel.run.id); }
      else if (!channel.settled) { const observed = await boundarySupervisor.observe(channel.runtime.runId); if (observed.state === 'stopped') { retainRevocation(channel.runtime.runId, boundaryNative); options.store.db.prepare("UPDATE host_boundary_runs SET status='failed' WHERE domain_run_id=?").run(channel.run.id); options.workflow.blockDemand(channel.run.demandId, 'BOUNDARY_HANDOFF_MISSING', 'Independent boundary reviewer stopped without its terminal evidence handoff.'); } }
    }
    await coordinator?.tick();
  }
  return { synthetic: !!synthetic, driver, prerequisites, evidence, prepareDemand, tick, stopAllAuxiliary, auxiliaryStatus, diagnostics, captureMethods, requiredModelData, bindCoordinator(value: ExecutionCoordinator) { insist(!coordinator || coordinator === value, 'COORDINATOR_CONFLICT', 'Production services are already bound.'); coordinator = value; } };
}
export type ProductionServices = ReturnType<typeof createProductionServices>;
