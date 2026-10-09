import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
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
import { noLinks, sourcePath } from '../workspace/paths.ts';
import { ModelBudgetLedger } from '../runtime/budget.ts';
import type { ModelGrant } from '../runtime/budget.ts';
import { ModelBroker } from '../runtime/model-broker.ts';
import type { BoundedProviderTransport, BoundedTransportRequest, ProviderResponse, BrokerMaterial } from '../runtime/model-broker.ts';
import { HostPiBrokerEndpoint, parsePiModelFrame } from '../runtime/pi-channel.ts';
import { verifyWindowsRuntimeProfile } from '../runtime/profile.ts';
import type { VerifiedRuntimeProfile, LockedRuntimeProfile, WindowsEvidenceTrustAnchor } from '../runtime/profile.ts';
import { VerifiedWindowsDriver } from '../runtime/verified-windows-driver.ts';
import { appContainerProfileName } from '../runtime/appcontainer-name.ts';
import type { WindowsRunBootstrap, NativeCheckResult } from '../runtime/verified-windows-driver.ts';
import { readLockedShellManifest } from '../runtime/shell-profile.ts';
import { RuntimeError } from '../runtime/types.ts';
import type { RuntimeDriver, RunRecord, Observation } from '../runtime/types.ts';
import { loadMethods, runtimeProfileInput } from './configuration.ts';
import type { WorkbenchConfiguration, ProviderConfiguration } from './configuration.ts';
import type { ExecutionPrerequisites } from './coordinator.ts';
import type { BaselineCheckRequest, BaselineCheckVerification } from './knowledge-lifecycle.ts';
import { ExecutionCoordinator } from './coordinator.ts';
import { RuntimeSupervisor } from '../runtime/supervisor.ts';
import { ProductionEvidence, hash, planMaterial } from './evidence.ts';
import type { SourceSnapshot } from './evidence.ts';

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
  /** Separately provisioned installation trust, never a renderer/configuration value. */
  evidenceTrustAnchor?: WindowsEvidenceTrustAnchor;
  /** Explicit Host-owned local-commit identity for this demand's user grant. */
  localCommitAuthor?: (demandId: string) => { name: string; email: string } | null;
  resolveCredential?: (reference: string) => string;
}
export interface ProductionDiagnostics { executionEnabled: boolean; blockers: string[]; profileVerified: boolean; budgetAvailable: boolean; workspaceVerified: boolean }
interface ActiveChannel { run: RunAttempt; runtime: RunRecord; init: WorkerInit; sourceScope: AgentMaterial; pendingWrite?: { requestId: string; action: 'write'|'delete'; path: string; sha256: string|null; bytes: number; before: SourceSnapshot }; endpoint: HostPiBrokerEndpoint; abort: AbortController; ready: boolean; settled: boolean; modelObserved: boolean; pending: WorkerReport[]; handoffs: string[]; grantId: string; boundary: boolean; contextId: string; }

/** Executable composition, with an intentionally denied state whenever a real prerequisite
 * is missing. This factory never manufactures an executable profile or model grant. */
type NativeDriverPort = RuntimeDriver & Pick<VerifiedWindowsDriver, 'setStopHandler' | 'setWorkerFrameHandler' | 'sendWorkerFrame' | 'getResourceEvidence' | 'runNodeCheck'> & { runShellCheck?: (runId: string, args: string[], limits: { timeoutMs: number; maxOutputBytes: number }, requestId?: string) => Promise<NativeCheckResult> };
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
  const checkLanes = new Map<string, { driver: NativeDriverPort; supervisor: RuntimeSupervisor; authorize: () => void }>();
  let coordinator: ExecutionCoordinator | undefined, native: NativeDriverPort | undefined, profile: VerifiedRuntimeProfile | undefined, profileDigest = '';
  options.store.db.exec(`CREATE TABLE IF NOT EXISTS host_boundary_runs(domain_run_id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,context_id TEXT NOT NULL,runtime_run_id TEXT,status TEXT NOT NULL,body TEXT);
    CREATE TABLE IF NOT EXISTS host_native_revocations(run_id TEXT PRIMARY KEY,evidence TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS host_native_check_lease(singleton INTEGER PRIMARY KEY CHECK(singleton=1),runtime_run_id TEXT NOT NULL,request_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS host_native_checks(request_id TEXT PRIMARY KEY,runtime_run_id TEXT NOT NULL,domain_run_id TEXT NOT NULL,artifact_id TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS host_generated_writes(request_id TEXT PRIMARY KEY,runtime_run_id TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS host_baseline_checks(operation_key TEXT PRIMARY KEY,runtime_run_id TEXT,body TEXT NOT NULL,status TEXT NOT NULL);`);
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
  function makeNative(bootstrapper: (run: RunRecord) => WindowsRunBootstrap = bootstrap): NativeDriverPort {
    const candidate = synthetic ? synthetic.createDriver(bootstrapper) : new VerifiedWindowsDriver(profile!, bootstrapper, join(stateDirectory, 'native-recovery'));
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
    insist(!native || ((coordinator?.supervisor.list() ?? []).every(run => run.state === 'stopped' && !!options.store.db.prepare('SELECT 1 FROM host_native_revocations WHERE run_id=?').get(run.runId)) && options.store.listRuns().every(run => run.status === 'stopped')), 'RUNTIME_CONFIGURATION_BUSY', 'Stop and verify every durable primary and boundary run before replacing their exact runtime binding.');
    profile = synthetic ? { config: synthetic.profile, evidenceDigests: ['SYNTHETIC-NOT-ISOLATION-EVIDENCE'] } as unknown as VerifiedRuntimeProfile : verifyWindowsRuntimeProfile(runtimeProfileInput(configuration), trustedEvidenceRoot, options.evidenceTrustAnchor);
    // Auxiliary drivers lock the same exact profile as the primary driver. They
    // may be replaced only after durable Job stop and ACL revocation above.
    boundaryNative = undefined; boundarySupervisor = undefined;
    native = makeNative();
    native.setWorkerFrameHandler(handleFrame); if (stopHandler) native.setStopHandler(stopHandler);
    profileDigest = digest; return native;
  }
  const driver: RuntimeDriver = {
    id: synthetic ? 'synthetic-production-composition' : 'windows-appcontainer-job-v1', get isolation() { return synthetic ? 'synthetic-process-supervision-only' : native ? 'verified-windows-native' : 'unverified-windows-candidate'; },
    setStopHandler(handler) { stopHandler = async (id, reason) => { channels.get(id)?.abort.abort(new RuntimeError('RUN_STOPPED', 'Run stopped.')); await handler(id, reason); }; native?.setStopHandler(stopHandler); },
    preflight(request) { refreshNative().preflight(request); },
    async launch(run) { return refreshNative().launch(run); },
    async stop(run) { channels.get(run.runId)?.abort.abort(new RuntimeError('RUN_STOPPED', 'Run stopped.')); const target = recoveryDriver(run); const result = target ? await target.stop(run) : unknown(run); retainRevocation(run.runId, target); return result; },
    async observe(run) { const target = recoveryDriver(run), result = target ? await target.observe(run) : unknown(run); retainRevocation(run.runId, target); return result; },
    async recoverUnregistered(run) { const target = recoveryDriver(run), result = target?.recoverUnregistered ? await target.recoverUnregistered(run) : unknown(run); retainRevocation(run.runId, target); return result; },
  };
  function recoveryDriver(run: RunRecord): NativeDriverPort | undefined { try { return (run.role === 'check' ? checkLanes.get(run.runId)?.driver : run.role === 'boundary-review' ? boundaryNative : native) ?? refreshNative(); } catch { return undefined; } }
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
  function contentMaterial(content: Demand['contents'][number]): AgentMaterial {
    const body = canonicalJson({ id: content.id, planId: content.planId, code: content.code, knowledge: content.knowledge, maintenance: content.maintenance, deliveryNotes: content.deliveryNotes, cycle: content.cycle });
    return { id: `content-scope:${content.id}`, kind: 'plan', sha256: hash(body), content: body };
  }
  function reworkMaterial(demand: Demand): AgentMaterial {
    const body = canonicalJson({ demandId: demand.id, planId: demand.activePlanId ?? null, contentId: demand.activeContentId ?? null, cycle: demand.cycle,
      findings: demand.findings, checks: demand.checks.filter(check => check.contentId === demand.activeContentId),
      returns: demand.acceptances.filter(acceptance => acceptance.decision === 'returned').map(({ resultId, reason }) => ({ resultId, reason })) });
    return { id: `rework-scope:${demand.id}:${demand.cycle}`, kind: 'plan', sha256: hash(body), content: body };
  }
  function decisionMaterials(demand: Demand): AgentMaterial[] {
    const commands = options.store.history(demand.id).filter(event => event.kind === 'user-command').map(event => (event.data as { command: Record<string, unknown> }).command)
      .filter(command => ['revise-plan', 'decide-finding', 'resolve-blocker', 'switch-method', 'return-result'].includes(String(command.type)))
      .map(command => Object.fromEntries(['type', 'requestId', 'reason', 'previousPlanId', 'findingId', 'stage', 'method', 'resultId'].filter(key => command[key] !== undefined).map(key => [key, command[key]])));
    if (!commands.length) return [];
    const body = canonicalJson({ demandId: demand.id, decisions: commands }), materials: AgentMaterial[] = [{ id: `user-decisions:${demand.id}`, kind: 'plan', sha256: hash(body), content: body }];
    const lastRevision = commands.findLast(command => command.type === 'revise-plan'), previous = demand.plans.find(plan => plan.id === lastRevision?.previousPlanId);
    if (!demand.activePlanId && previous) materials.push(planMaterial(previous), evidence.read(demand.id, previous.spec), evidence.read(demand.id, previous.tickets));
    const lastReturn = commands.findLast(command => command.type === 'return-result'), result = demand.results.find(result => result.id === lastReturn?.resultId);
    if (!demand.activeContentId && result) materials.push(evidence.read(demand.id, result.K), ...result.N.map(ref => evidence.read(demand.id, ref)), ...result.E.map(check => evidence.read(demand.id, check.evidence)), evidence.read(demand.id, result.review.evidence));
    return materials;
  }
  function authorizeDerived(channel: ActiveChannel, materials: AgentMaterial[]): void {
    const grant = options.budget.getGrant(channel.grantId);
    insist(channel.modelObserved && grant.contextPolicy === 'approved-run-derived-v1', 'DERIVED_CONTEXT_DENIED', 'Only observed generated work covered by explicit derived-run permission may enter a later session.');
    for (const material of materials) options.budget.authorizeData({ grantId: grant.id, decisionId: grant.decisionId, material: { id: material.id, sha256: material.sha256 } }, () => {});
  }
  function materialSet(demand: Demand, stage: Stage, runId?: string, boundary = false): AgentMaterial[] {
    const method = demand.methodSnapshot[stage]; insist(method, 'METHOD_MISSING', `Configure and explicitly select a ${stage} method for this demand.`);
    insist(method.adapter === 'explicit-text-v1', 'METHOD_ADAPTER_UNSUPPORTED', 'This production assembly supports only the explicit-text-v1 method adapter.');
    const materials = evidence.method(method);
    const input = canonicalJson({ title: demand.title, description: demand.description, messages: demand.messages.map(message => ({ id: message.id, text: message.text, kind: message.kind })) });
    materials.push({ id: `demand-input:${demand.id}`, kind: 'plan', sha256: hash(input), content: input });
    const projectChecks = canonicalJson({ projectId: demand.projectId, requiredChecks: options.store.getProject(demand.projectId).baseChecks });
    materials.push({ id: `project-checks:${demand.projectId}`, kind: 'plan', sha256: hash(projectChecks), content: projectChecks });
    materials.push(...decisionMaterials(demand));
    const source = evidence.sourceMaterial(demand.id); materials.push(source);
    const plan = demand.plans.find(plan => plan.id === demand.activePlanId);
    if (plan) materials.push(planMaterial(plan), evidence.read(demand.id, plan.spec), evidence.read(demand.id, plan.tickets));
    if (stage !== 'planning' && !boundary) {
      const content = demand.contents.find(content => content.id === demand.activeContentId);
      if (stage === 'review') insist(content && evidence.stable(demand.id, content.code), 'CONTENT_CHANGED', 'Review requires the exact immutable current code snapshot.');
      if (content) materials.push(contentMaterial(content), evidence.read(demand.id, content.code), ...content.knowledge.map(ref => evidence.read(demand.id, ref)), ...demand.checks.filter(check => check.contentId === content.id).map(check => evidence.read(demand.id, check.evidence)));
      if (demand.findings.length || demand.checks.length || demand.acceptances.some(item => item.decision === 'returned')) {
        materials.push(reworkMaterial(demand));
        for (const finding of demand.findings) for (const ref of [finding.dispute, finding.resolution]) if (ref && !ref.location.startsWith('user-command:')) materials.push(evidence.read(demand.id, ref));
        for (const review of demand.reviews.filter(review => review.contentId === content?.id || demand.findings.some(finding => finding.reviewRunId === review.runId))) materials.push(evidence.read(demand.id, review.evidence));
      }
    }
    // K chooses versions and filters permissions before any body is read. Only
    // explicit granted revision IDs can enter the candidate allowlist.
    if (runId) {
      const binding = options.workspace().getBinding(demand.id)!;
      const project = options.workspace().getProject(demand.projectId);
      const grant = selectGrant(demand.id, boundary ? 'boundary-review' : stage);
      const role: KnowledgeRole = stage === 'planning' ? 'planner' : stage === 'review' ? 'reviewer' : 'implementer';
      const manifest = options.knowledge.createContext({ runId, projectId: demand.projectId, demandId: demand.id, role, baseline: binding.currentBaseline, formalTarget: project.formalTarget, environment: currentKnowledgeEnvironment(),
        allowedRevisionIds: grant.data.filter(data => data.id.startsWith('knowledge:')).map(data => data.id.slice('knowledge:'.length)), purpose: `Controlled ${stage} context` });
      for (const id of manifest.revisionIds) { const item = options.knowledge.read(manifest.contextId, id); materials.push({ id: `knowledge:${id}`, kind: 'knowledge', sha256: item.object.sha256, content: item.body }); }
    }
    const deduplicated = new Map<string, AgentMaterial>();
    for (const material of materials) { const old = deduplicated.get(material.id); insist(!old || canonicalJson(old) === canonicalJson(material), 'MATERIAL_CONFLICT', 'Context contains conflicting immutable identities.'); deduplicated.set(material.id, material); }
    return [...deduplicated.values()];
  }
  function requiredModelData(demandId: string): { id: string; sha256: string }[] {
    const demand = options.store.getDemand(demandId), stage = stageFor(demand), configuration = config(), materials = materialSet(demand, stage);
    if (stage !== 'review') { insist(demand.methodSnapshot.review, 'BOUNDARY_METHOD_MISSING', 'The next independent review also requires the frozen review method.'); materials.push(...evidence.method(demand.methodSnapshot.review)); }
    // Preserve only explicitly selected revisions after K has filtered project,
    // role, baseline, target, environment and invalidation, before any body read.
    const selected = (configuration.provider?.data ?? []).filter(material => material.id.startsWith('knowledge:')).map(material => material.id.slice('knowledge:'.length));
    if (selected.length) {
      const binding = options.workspace().getBinding(demandId)!, project = options.workspace().getProject(demand.projectId);
      insist(configuration.runtime, 'RUNTIME_CONFIGURATION_MISSING', 'Knowledge applicability requires the exact runtime profile.');
      const roles: KnowledgeRole[] = stage === 'planning' ? ['planner', 'reviewer'] : stage === 'implementation' ? ['implementer', 'reviewer'] : ['reviewer'];
      for (const role of roles) {
        const manifest = options.knowledge.createContext({ runId: `approval-${randomUUID()}`, projectId: demand.projectId, demandId, role, baseline: binding.currentBaseline, formalTarget: project.formalTarget, environment: currentKnowledgeEnvironment(), allowedRevisionIds: selected, purpose: 'Prepare exact user-selected knowledge data approval' });
        for (const id of manifest.revisionIds) { const item = options.knowledge.read(manifest.contextId, id); materials.push({ id: `knowledge:${id}`, kind: 'knowledge', sha256: item.object.sha256, content: item.body }); }
      }
    }
    return [...new Map(materials.map(({ id, sha256 }) => [id, { id, sha256 }])).values()];
  }
  function approvedMaterials(grant: ModelGrant, materials: AgentMaterial[]): void { insist(materials.every(material => grant.data.some(data => data.id === material.id && data.sha256 === material.sha256)), 'MODEL_DATA_APPROVAL_MISSING', 'The current demand text, source scope, frozen method, and selected artifact versions must all be covered by the explicit data approval.'); }
  function diagnostics(demandId?: string): ProductionDiagnostics {
    const blockers: string[] = []; let profileVerified = false, budgetAvailable = false, workspaceVerified = false;
    try { refreshNative(); profileVerified = true; } catch (error) { blockers.push(reason(error)); }
    if (!demandId) return { executionEnabled: false, blockers: [...blockers, 'Select a demand to verify its frozen methods, dedicated worktree, and finite data/model approval.'], profileVerified, budgetAvailable, workspaceVerified };
    try {
      const demand = options.store.getDemand(demandId), stage = stageFor(demand);
      insist(!(coordinator?.supervisor.list() ?? []).some(run => run.demandId === demandId && run.role === 'check' && run.state !== 'stopped'), 'LOCAL_CHECK_PENDING', 'Fresh baseline capability checks occupy this exact source; no Agent session may start concurrently.');
      if (stage === 'implementation' && demand.grant?.localCommit) commitAuthor(demand.id);
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
  function verifyLiveInputs(channel: ActiveChannel): void {
    insist(!channel.pendingWrite, 'SOURCE_WRITE_PENDING', 'A source mutation has not yet received independent Host verification.');
    const source = evidence.sourceMaterial(channel.run.demandId);
    insist(source.sha256 === channel.sourceScope.sha256, channel.runtime.writes ? 'UNPROVEN_SOURCE_MUTATION' : 'READ_ONLY_SOURCE_CHANGED', 'Source differs from approved inputs or Host-observed controlled writes. Stop and explicitly review external or command-generated changes before further model transmission.');
    const selected = channel.init.materials.filter(material => material.id.startsWith('knowledge:'));
    if (!selected.length) return;
    const demand = options.store.getDemand(channel.run.demandId), binding = options.workspace().getBinding(demand.id)!, project = options.workspace().getProject(demand.projectId);
    const role: KnowledgeRole = channel.boundary || channel.run.stage === 'review' ? 'reviewer' : channel.run.stage === 'planning' ? 'planner' : 'implementer';
    const manifest = options.knowledge.createContext({ runId: `revalidate-${randomUUID()}`, projectId: demand.projectId, demandId: demand.id, role, baseline: binding.currentBaseline, formalTarget: project.formalTarget, environment: nativeEnvironment(channel.runtime), allowedRevisionIds: selected.map(material => material.id.slice('knowledge:'.length)), purpose: 'Revalidate exact selected knowledge before outbound model operation' });
    insist(manifest.revisionIds.length === selected.length, 'KNOWLEDGE_CONTEXT_REVOKED', 'Selected knowledge was invalidated or lost its exact role/baseline/environment eligibility. Rebuild the session before further transmission.');
    for (const material of selected) { const item = options.knowledge.read(manifest.contextId, material.id.slice('knowledge:'.length)); insist(item.object.sha256 === material.sha256 && hash(item.body) === material.sha256, 'KNOWLEDGE_CONTEXT_CHANGED', 'Selected knowledge changed since this session was approved.'); }
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
      workspace: runtime.workspace, scratch, sessionDir, sessionId: randomUUID(), capability: randomBytes(32).toString('hex'), materials, shellEnabled: !!profile.config.shell,
      prompt: `Carry out only the ${runtime.role} task in the supplied frozen method and approved inputs. Use controlled_report for immutable evidence. Artifact bodies may be supplied as artifactBodies:[{id,kind,text}] alongside the report; references can use {id,digest:'pending',location:'host-artifact'} and the Host replaces only registered matching bodies. Check evidence must use the exact evidence reference returned by a completed controlled_node tool. Only native receipts with reason exited and exitCode zero can support passed checks. All existing references use pi-object:<SHA256>:<UTF8 byte count>. For content-ready use code.location="current-worktree" and the Host will capture source only after actual process-tree stop. plan-ready requires an actually observed separate boundary review; never invent its identity or evidence. Report blocked if a required capability or independent review is unavailable. User controls and permissions are Host-owned.`,
      model: { provider: transport.provider, id: transport.modelId, contextWindow: transport.model.contextWindow, maxTokens: Math.min(8192, transport.model.maxTokens) },
      compaction: { enabled: false, reserveTokens: 8192, keepRecentTokens: 4096 }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, limits: { maxFileBytes: 1024 * 1024, commandTimeoutMs: 120_000, maxOutputBytes: 1024 * 1024 } };
    let endpoint!: HostPiBrokerEndpoint, channel!: ActiveChannel;
    const broker = new ModelBroker({ ledger: options.budget, transport, realChannelVerified: !synthetic, readMaterial: async id => endpoint.readMaterial(id), authorizeRun: (id, demandId, role) => { insist(id === runtime.runId && demandId === run.demandId && role === runtime.role, 'CHANNEL_IDENTITY_DENIED', 'Broker run scope mismatch.'); assertRun(channel); verifyLiveInputs(channel); } });
    endpoint = new HostPiBrokerEndpoint({ db: options.store.db, ledger: options.budget, broker, binding: { runId: runtime.runId, generation: runtime.generation, sessionId: init.sessionId, capability: init.capability, grantId: grant.id, role: runtime.role, reserveTokens: transport.reserveTokens, reserveCostMicros: transport.reserveCostMicros },
      authorizeRun: () => assertRun(channel), authorizeContext: async (material: BrokerMaterial) => {
        assertRun(channel); insist(channel.ready && profile && (boundary ? boundaryNative : native)?.getResourceEvidence(runtime.runId)?.provisioned === true, 'WORKER_NOT_READY', 'Native private Worker context has not been observed ready.');
        const current = selectGrant(run.demandId, runtime.role); insist(current.id === grant.id, 'MODEL_GRANT_CHANGED', 'The bound grant cannot be silently replaced.'); approvedMaterials(current, materials);
        insist((current as ModelGrant & { contextPolicy?: string }).contextPolicy === 'approved-run-derived-v1', 'CONTEXT_PERMISSION_MISSING', 'Generated run context was not explicitly approved.');
        verifyLiveInputs(channel);
        insist(Buffer.byteLength(material.text) <= MAX_CONTEXT_BYTES, 'CONTEXT_TOO_LARGE', 'Generated context exceeds the bounded data channel.');
        return { decisionId: current.decisionId };
      } });
    if (boundary) init.prompt = `Artifact references may use {id,digest:'pending',location:'host-artifact'} matching artifactBodies. Independently review the exact current plan ${run.planId} against the supplied source, scope and review method. You have a new empty read-only session with context ${contextId}; planning context is ${run.contextId}. No planner conversation or summaries are supplied. Report plan-ready only after checking boundary, tickets, acceptance/check coverage, scope, and unresolved questions, with boundaryReview:{contextId:'${contextId}',planningContextId:'${run.contextId}',evidence:<registered artifact ref>,unresolvedBlockingFindings:[]}. Include artifactBodies:[{id,kind:'check-evidence',text}] with concrete review observations and references. Report blocked if any unresolved blocker exists. Never claim to have run a check without an observed controlled_node result.`;
    channel = { run, runtime, init, sourceScope: materials.find(material => material.id === `source-scope:${run.demandId}`)!, endpoint, abort: new AbortController(), ready: false, settled: false, modelObserved: false, pending: [], handoffs: [], grantId: grant.id, boundary, contextId }; channels.set(runtime.runId, channel);
    evidence.recordRun(boundary ? { ...run, id: `boundary-${runtime.runId}`, stage: 'review', contextId } : run, { materials, source: materials.find(m => m.id === `source-scope:${run.demandId}`)!, role: runtime.role, sessionId: init.sessionId, runtimeRunId: runtime.runId, generation: runtime.generation });
    if (boundary) options.store.db.prepare('UPDATE host_boundary_runs SET runtime_run_id=?,body=? WHERE domain_run_id=?').run(runtime.runId, canonicalJson({ materials, source: materials.find(m => m.kind === 'source'), sessionId: init.sessionId }), run.id);
    // Compatibility field name: these are exact pinned files, never parent
    // directories. Native ACLs grant only these files and ancestor traversal.
    const roots = [...new Set([profile.config.node.path, profile.config.worker.path, ...(profile.config.shell ? readLockedShellManifest(profile.config.shell).files.map(file => file.path) : [])])];
    for (const file of roots) { noLinks(file); for (const protectedPath of [stateDirectory, ...options.store.listProjects().map(project => project.rootPath)]) { const rel = relative(protectedPath, file); insist(rel.startsWith('..') || isAbsolute(rel), 'RUNTIME_ROOT_UNSAFE', 'Pinned runtime files must remain outside mutable project source and Host state.'); } }
    return { profileName: appContainerProfileName(runtime.demandId, runtime.role, runtime.generation), scratch,
      aclEvidence: profile.evidenceDigests.join(','), privateChannelEvidence: profile.evidenceDigests.join(','), processLimit: 8, memoryLimitBytes: 1024 * 1024 * 1024, diskLimitBytes: 1024 * 1024 * 1024, fileLimit: 100_000, minimumFreeBytes: 256 * 1024 * 1024, diskPollMs: 250, workerInit: init as unknown as Record<string, unknown>,
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
        const ref = evidence.save({ ...artifact, projectId: demand.projectId, demandId: demand.id, runId: channel.boundary ? `boundary-${channel.runtime.runId}` : channel.run.id });
        const grant = options.budget.getGrant(channel.grantId);
        insist(channel.modelObserved && grant.contextPolicy === 'approved-run-derived-v1', 'DERIVED_ARTIFACT_DENIED', 'Only model-observed artifacts from the explicitly approved generated context can enter later model input.');
        options.budget.authorizeData({ grantId: grant.id, decisionId: grant.decisionId, material: { id: ref.id, sha256: ref.digest } }, () => {});
      }
    }
    const substitute = (item: unknown): unknown => { if (Array.isArray(item)) return item.map(substitute); if (item && typeof item === 'object') { const object = item as Record<string, unknown>; if (object.location === 'host-artifact' && typeof object.id === 'string') return evidence.reference(channel.run.demandId, object.id); return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, substitute(child)])); } return item; };
    const report = substitute(value) as WorkerReport;
    if (report.type === 'check') report.check.environment = nativeEnvironment(channel.runtime);
    return report;
  }
  function nativeEnvironment(runtime: RunRecord): string { return canonicalJson({ profileId: runtime.profileId, profileDigest, evidenceDigests: profile?.evidenceDigests, synthetic: !!synthetic }); }
  function currentKnowledgeEnvironment(): string { refreshNative(); return nativeEnvironment({ profileId: profile!.config.profileId } as RunRecord); }
  function commitAuthor(demandId: string): { name: string; email: string } {
    const author = options.localCommitAuthor?.(demandId);
    insist(author && typeof author.name === 'string' && author.name.trim().length > 0 && author.name.length <= 200 && typeof author.email === 'string' && author.email.length <= 320 && /^[^\s<>@]+@[^\s<>@]+$/.test(author.email) && !/[\r\n<>\0]/.test(author.name + author.email), 'LOCAL_COMMIT_AUTHOR_REQUIRED', 'The local-commit grant requires an explicitly approved Host author name and email; no identity is inferred.');
    return { name: author.name, email: author.email };
  }
  function commitStoppedContent(channel: ActiveChannel, demand: Demand): void {
    if (!demand.grant?.localCommit) return;
    insist(channel.run.stage === 'implementation' && channel.runtime.writes && channel.modelObserved && demand.control === 'active' && demand.grant.planId === channel.run.planId && demand.activePlanId === channel.run.planId && demand.cycle === channel.run.cycle, 'LOCAL_COMMIT_AUTHORITY_CHANGED', 'A local commit requires the still-current explicit implementation grant and verified stopped writer.');
    const author = commitAuthor(demand.id), workspace = options.workspace(), binding = workspace.getBinding(demand.id)!;
    insist(workspace.git.staged(binding.worktreePath).length === 0, 'USER_STAGED', 'Existing staged work is preserved; reconcile it explicitly before a controlled local commit.');
    const source = evidence.source(demand.id), files = new Map(source.files.map(file => [file.path, file.sha256]));
    const changes = workspace.git.status(binding.worktreePath);
    // A clean index excludes staged rename/copy multi-record porcelain entries.
    // Refuse any other format instead of treating an arbitrary record as a path.
    insist(changes.every(change => /^(?: [MDT]|\?\?) /.test(change)), 'LOCAL_COMMIT_SCOPE_UNSUPPORTED', 'Changed paths require a supported clean-index source status.');
    const paths = changes.map(change => change.slice(3)).sort();
    insist(paths.length <= 1024 && paths.join('').length <= 24_000, 'LOCAL_COMMIT_SCOPE_TOO_LARGE', 'The exact local-commit path list exceeds its finite command bound.');
    if (!paths.length) return; // No invented empty commit or new baseline.
    const generated = new Set(options.store.db.prepare('SELECT body FROM host_generated_writes WHERE runtime_run_id=?').all(channel.runtime.runId).map(row => JSON.parse(String(row.body)) as { status: string; path: string }).filter(write => write.status === 'verified').map(write => write.path));
    insist(paths.every(path => generated.has(path)), 'LOCAL_COMMIT_UNRELATED_DIRTY', 'Unrelated preexisting dirty files are preserved. Reading approved source does not grant permission to commit it; only this run\'s verified generated-write paths may enter the local commit.');
    const expectedFiles = Object.fromEntries(paths.map(path => [path, files.get(path) ?? null]));
    const operationId = `content-${hash(`${channel.run.id}:${channel.run.generation}`).slice(0, 40)}`;
    workspace.commit({ operationId, demandId: demand.id, expectedHead: binding.head, paths, expectedFiles, message: `Save verified demand implementation (${demand.id})`, author, commitAuthorized: true, writerStopped: true });
    insist(workspace.git.status(binding.worktreePath).length === 0, 'LOCAL_COMMIT_CONTENT_CHANGED', 'Source changed during local commit; no immutable delivery handoff was recorded.');
  }
  async function settle(channel: ActiveChannel, aborted = false): Promise<void> {
    insist(coordinator, 'HOST_CHANNEL_UNBOUND', 'Coordinator is unavailable.');
    channel.settled = true; channel.abort.abort();
    const stopped = await (channel.boundary ? boundarySupervisor! : coordinator.supervisor).stop(channel.runtime.runId, 'worker-terminal-handoff');
    if (stopped.state !== 'stopped' || (channel.boundary ? boundaryNative : native)?.getResourceEvidence(channel.runtime.runId)?.revoked !== true) { options.workflow.markInterrupted(channel.run.id, 'Worker handoff has no verified complete native Job stop.'); return; }
    retainRevocation(channel.runtime.runId, channel.boundary ? boundaryNative : native);
    insist(options.store.db.prepare('SELECT 1 FROM host_native_revocations WHERE run_id=?').get(channel.runtime.runId), 'NATIVE_REVOCATION_UNVERIFIED', 'Terminal artifacts require durable successful native resource revocation.');
    if (aborted) { channel.pending.length = 0; channel.handoffs.length = 0; options.workflow.blockDemand(channel.run.demandId, 'WORKER_ABORTED', 'An aborted session cannot establish a completed stage handoff.'); return; }
    try { verifyLiveInputs(channel); }
    catch (error) {
      options.workflow.blockDemand(channel.run.demandId, 'TERMINAL_INPUTS_CHANGED', error instanceof Error ? error.message : 'Terminal inputs could not be verified.');
      if (channel.run.stage === 'planning') options.store.db.prepare("UPDATE host_boundary_runs SET status='failed' WHERE domain_run_id=? AND status!='complete'").run(channel.run.id);
      throw error;
    }
    for (const queued of channel.pending) {
      if (queued.type === 'content-ready' && options.store.getDemand(channel.run.demandId).grant?.localCommit) {
        try {
          insist(queued.content.planId === channel.run.planId, 'LOCAL_COMMIT_AUTHORITY_CHANGED', 'The content report must target the exact locally authorized plan before any commit.');
          insist(queued.content.code.location === 'current-worktree', 'LOCAL_COMMIT_SNAPSHOT_REQUIRED', 'An authorized local commit requires a fresh stopped-worktree snapshot, never a substituted older artifact.');
          commitStoppedContent(channel, options.store.getDemand(channel.run.demandId));
        } catch (error) { options.workflow.blockDemand(channel.run.demandId, 'LOCAL_COMMIT_FAILED', error instanceof Error ? error.message : 'The exact local commit could not be verified.'); throw error; }
      }
      if (queued.type === 'content-ready' && queued.content.code.location === 'current-worktree') {
        const demand = options.store.getDemand(channel.run.demandId);
        queued.content.code = evidence.saveSource(demand.projectId, demand.id, channel.run.id, queued.content.code.id);
        const grant = options.budget.getGrant(channel.grantId); const scope = evidence.sourceMaterial(demand.id);
        for (const material of [{ id: queued.content.code.id, sha256: queued.content.code.digest }, { id: scope.id, sha256: scope.sha256 }]) options.budget.authorizeData({ grantId: grant.id, decisionId: grant.decisionId, material }, () => { insist(channel.modelObserved && grant.contextPolicy === 'approved-run-derived-v1', 'DERIVED_CONTEXT_DENIED', 'Generated source permission requires the original explicit derived-run policy.'); });
      }
      if (channel.boundary && queued.type === 'plan-ready') {
        insist(channel.modelObserved && channel.ready && channel.init.role === 'boundary-review' && channel.contextId !== channel.run.contextId && evidence.sourceMaterial(channel.run.demandId).sha256 === channel.init.materials.find(m => m.id === `source-scope:${channel.run.demandId}`)?.sha256, 'BOUNDARY_REVIEW_UNVERIFIED', 'The independent review did not retain its exact read-only source/context.');
        const demand = options.store.getDemand(channel.run.demandId), plan = demand.plans.find(plan => plan.id === queued.planId);
        insist(plan && channel.init.materials.some(material => canonicalJson(material) === canonicalJson(planMaterial(plan))), 'BOUNDARY_PLAN_CHANGED', 'Boundary review must cover the exact immutable scope and required checks.');
        evidence.requireOrigin(channel.run.demandId, queued.boundaryReview.evidence, `boundary-${channel.runtime.runId}`);
        options.store.db.prepare("UPDATE host_boundary_runs SET status='observed',body=? WHERE domain_run_id=?").run(canonicalJson({ runId: channel.runtime.runId, contextId: channel.contextId, planningRunId: channel.run.id, planId: queued.planId, evidenceDigest: queued.boundaryReview.evidence.digest, actualReviewObserved: true, isolatedInputsVerified: true }), channel.run.id);
      }
      const receipt = coordinator.report(channel.run.id, queued);
      if (channel.boundary && receipt.status === 'applied') options.store.db.prepare("UPDATE host_boundary_runs SET status='complete' WHERE domain_run_id=?").run(channel.run.id); if (receipt.status === 'applied') channel.handoffs.push(queued.type);
    }
    channel.pending.length = 0;
    if (channel.modelObserved && !channel.boundary) {
      const demand = options.store.getDemand(channel.run.demandId), content = demand.contents.find(content => content.id === demand.activeContentId);
      authorizeDerived(channel, [...(content ? [contentMaterial(content)] : []), reworkMaterial(demand)]);
    }
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
      catch (error) { targetDriver.sendWorkerFrame(runtime.runId, { sequence: request.sequence, ok: false, error: error instanceof RuntimeError ? error.code : 'MODEL_CHANNEL_ERROR' });
        if (error instanceof RuntimeError && ['UNPROVEN_SOURCE_MUTATION', 'READ_ONLY_SOURCE_CHANGED', 'KNOWLEDGE_CONTEXT_REVOKED', 'KNOWLEDGE_CONTEXT_CHANGED', 'SOURCE_WRITE_PENDING'].includes(error.code)) { channel.abort.abort(); options.workflow.blockDemand(channel.run.demandId, error.code, error.message); if (channel.run.stage === 'planning') options.store.db.prepare("UPDATE host_boundary_runs SET status='failed' WHERE domain_run_id=? AND status!='complete'").run(channel.run.id); await (channel.boundary ? boundarySupervisor! : coordinator!.supervisor).stop(runtime.runId, error.code); retainRevocation(runtime.runId, targetDriver); }
      }
      return;
    }
    insist(value.generation === runtime.generation && (value.runId === runtime.runId || value.runtimeRunId === runtime.runId), 'CHANNEL_IDENTITY_DENIED', 'Worker event identity mismatch.');
    if (value.type === 'worker.ready') { insist(value.sessionId === channel.init.sessionId && !channel.ready, 'SESSION_IDENTITY_DENIED', 'Worker session identity mismatch or replay.'); channel.ready = true; return; }
    if (value.type === 'worker.event') return; // Worker telemetry never proves subprocess completion.
    if (value.type === 'worker.settled') { insist(value.sessionId === channel.init.sessionId && !channel.settled && typeof value.aborted === 'boolean', 'SESSION_IDENTITY_DENIED', 'Unknown or replayed terminal event.'); await settle(channel, value.aborted); return; }
    insist(equal(value.capability, channel.init.capability), 'CHANNEL_CAPABILITY_DENIED', 'Private capability mismatch.');
    if (value.type === 'worker.write-request' || value.type === 'worker.write-complete') {
      const requestId = value.requestId;
      try {
        assertRun(channel); insist(channel.ready && channel.modelObserved && runtime.writes && runtime.role === 'implementation' && typeof requestId === 'string' && /^[a-zA-Z0-9-]{1,200}$/.test(requestId), 'SOURCE_WRITE_DENIED', 'A bounded generated write requires the current observed implementation session.');
        if (value.type === 'worker.write-request') {
          verifyLiveInputs(channel);
          const action = value.action ?? 'write'; insist(action === 'write' || action === 'delete', 'SOURCE_WRITE_DENIED', 'Only single-file write or delete is supported.');
          insist(typeof value.path === 'string' && !value.path.split('/').some(part => ['.git', '.local'].includes(part.toLowerCase())) && (action === 'delete' ? value.sha256 === null && value.bytes === 0 : typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)) && Number.isSafeInteger(value.bytes) && Number(value.bytes) >= 0 && Number(value.bytes) <= channel.init.limits.maxFileBytes, 'SOURCE_WRITE_DENIED', 'Only an exact bounded relative source mutation may be authorized.');
          const path = sourcePath(value.path), before = evidence.source(channel.run.demandId);
          insist(action !== 'delete' || before.files.some(file => file.path === path), 'SOURCE_DELETE_DENIED', 'Only one exact existing ordinary source file may be deleted; recursive deletion is not supported.');
          insist(!options.store.db.prepare('SELECT 1 FROM host_generated_writes WHERE request_id=?').get(requestId), 'SOURCE_WRITE_REPLAY', 'A generated mutation request cannot be repeated.');
          channel.pendingWrite = { requestId, action, path, sha256: value.sha256 as string|null, bytes: Number(value.bytes), before };
          options.store.db.prepare('INSERT INTO host_generated_writes VALUES(?,?,?)').run(requestId, runtime.runId, canonicalJson({ status: 'authorized', action, generation: runtime.generation, before: channel.sourceScope.sha256, path, sha256: value.sha256, bytes: value.bytes }));
          targetDriver.sendWorkerFrame(runtime.runId, { type: 'worker.write-result', requestId, ok: true, value: { status: 'authorized' } });
        } else {
          const pending = channel.pendingWrite; insist(pending && pending.requestId === requestId, 'SOURCE_WRITE_REPLAY', 'No exact pending generated mutation exists.');
          const after = evidence.source(channel.run.demandId), changed = after.files.find(file => file.path === pending.path), previous = pending.before.files.find(file => file.path === pending.path);
          const exactTarget = pending.action === 'delete' ? !changed && !!previous : changed?.sha256 === pending.sha256 && changed.bytes === pending.bytes && changed.executable === (previous?.executable ?? false);
          insist(after.head === pending.before.head && exactTarget && canonicalJson(after.files.filter(file => file.path !== pending.path)) === canonicalJson(pending.before.files.filter(file => file.path !== pending.path)) && canonicalJson(after.changes.filter(change => change.slice(3) !== pending.path)) === canonicalJson(pending.before.changes.filter(change => change.slice(3) !== pending.path)), 'UNPROVEN_SOURCE_MUTATION', 'Source differs from the single exact authorized generated mutation.');
          const next = evidence.sourceMaterial(channel.run.demandId); insist(next.content === canonicalJson(after), 'UNPROVEN_SOURCE_MUTATION', 'Source changed during mutation verification.');
          options.store.db.prepare('UPDATE host_generated_writes SET body=? WHERE request_id=? AND runtime_run_id=?').run(canonicalJson({ status: 'verified', action: pending.action, generation: runtime.generation, before: channel.sourceScope.sha256, after: next.sha256, path: pending.path, sha256: pending.sha256, bytes: pending.bytes }), requestId, runtime.runId);
          channel.sourceScope = next; channel.pendingWrite = undefined;
          targetDriver.sendWorkerFrame(runtime.runId, { type: 'worker.write-result', requestId, ok: true, value: { status: 'verified', sourceDigest: next.sha256 } });
        }
      } catch (error) { targetDriver.sendWorkerFrame(runtime.runId, { type: 'worker.write-result', requestId, ok: false, error: error instanceof RuntimeError ? error.code : 'SOURCE_WRITE_UNVERIFIED' }); channel.abort.abort(); options.workflow.blockDemand(channel.run.demandId, 'SOURCE_WRITE_UNVERIFIED', 'Generated source mutation could not be independently verified; explicitly review current source before restarting.'); await coordinator!.supervisor.stop(runtime.runId, 'source-write-unverified'); retainRevocation(runtime.runId, targetDriver); }
      return;
    }
    if (value.type === 'worker.check-request' || value.type === 'worker.shell-request') {
      assertRun(channel);
      verifyLiveInputs(channel);
      insist(channel.ready && channel.modelObserved, 'MODEL_OBSERVATION_REQUIRED', 'Native tools require an observed model operation in this exact session.');
      insist(typeof value.requestId === 'string' && /^[a-zA-Z0-9-]{1,200}$/.test(value.requestId) && typeof value.toolCallId === 'string' && value.toolCallId.length <= 200 && Array.isArray(value.args) && value.args.length > 0 && value.args.length <= 64 && value.args.every(arg => typeof arg === 'string' && !arg.includes('\0') && arg.length <= 8192) && value.args.join('').length <= 32768, 'CHECK_SCOPE_DENIED', 'Only a bounded Node argument vector is accepted.');
      const requestId = value.requestId, args = value.args as string[];
      const shell = value.type === 'worker.shell-request';
      insist(!shell || (channel.init.shellEnabled && targetDriver.runShellCheck && args.length === 1 && args[0]!.length > 0), 'SHELL_UNAVAILABLE', 'Only one bounded script in the exact configured locked Git Bash may execute.');
      let leased = false;
      try {
        insist(!options.store.db.prepare('SELECT 1 FROM host_native_check_lease').get(), 'CHECK_CAPACITY', 'Another native check owns the single global check slot; wait for its observed completion.');
        insist(!options.store.db.prepare('SELECT 1 FROM host_native_checks WHERE request_id=?').get(requestId), 'CHECK_REPLAY', 'A native command request ID cannot execute twice.');
        const sourceBefore = evidence.sourceMaterial(channel.run.demandId);
        if (!runtime.writes) insist(channel.init.materials.some(material => material.id === sourceBefore.id && material.sha256 === sourceBefore.sha256), 'CHECK_CONTENT_CHANGED', 'Read-only checks require the exact initial source scope.');
        options.store.db.prepare('INSERT INTO host_native_check_lease VALUES(1,?,?)').run(runtime.runId, requestId); leased = true;
        const observation = shell ? await targetDriver.runShellCheck!(runtime.runId, args, { timeoutMs: 120_000, maxOutputBytes: 524_288 }, requestId) : await targetDriver.runNodeCheck(runtime.runId, args, { timeoutMs: 120_000, maxOutputBytes: 524_288 }, requestId);
        insist(observation.requestId === requestId && ['exited', 'timeout', 'output-limit', 'descendants-survived', 'launch-failed'].includes(observation.reason), 'NATIVE_CHECK_INVALID', 'Native receipt does not match the requested operation.');
        const { outputBase64: _duplicateOutput, ...nativeEvidence } = observation.nativeEvidence;
        const sourceAfter = evidence.sourceMaterial(channel.run.demandId);
        insist(sourceBefore.sha256 === sourceAfter.sha256, 'UNPROVEN_SOURCE_MUTATION', 'Command-generated source changes need explicit user review; they cannot silently enter model context.');
        const record = { provenance: synthetic ? 'synthetic-native-receipt' : 'native-helper-command-observation', executable: shell ? 'git-bash' : 'node', runtimeRunId: runtime.runId, generation: runtime.generation, environment: nativeEnvironment(runtime), sourceBefore: sourceBefore.sha256, sourceAfter: sourceAfter.sha256, toolCallId: value.toolCallId, args, requestId, exitCode: observation.exitCode, reason: observation.reason, output: observation.output, nativeEvidence: { ...nativeEvidence, outputSha256: hash(observation.output) } };
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
    insist(value.type === 'worker.report' && channel.ready && !channel.settled, 'FRAME_TYPE_DENIED', 'Unknown Worker frame or already settled session.');
    if ((value.report as { type?: string } | undefined)?.type !== 'blocked') verifyLiveInputs(channel);
    const reportType = (value.report as { type?: string } | undefined)?.type;
    insist(channel.modelObserved || reportType === 'blocked', 'MODEL_OBSERVATION_REQUIRED', 'Artifacts and Worker self-report alone cannot establish stage progress.');
    const report = ingestReport(channel, value.report);
    try {
      if (report.type === 'content-ready' || ['check', 'review', 'resolve-finding'].includes(report.type) || (channel.boundary && report.type === 'plan-ready')) { insist(channel.pending.length < 128 && (!(report.type === 'content-ready' || report.type === 'plan-ready') || channel.pending.length === 0), 'REPORT_PENDING', 'Terminal evidence exceeds the bounded pending-report scope.'); channel.pending.push(report); targetDriver.sendWorkerFrame(runtime.runId, { type: 'worker.receipt', requestId: report.requestId, ok: true, value: { status: 'pending-stop-verification' } }); }
      else { insist(!channel.boundary || report.type === 'blocked', 'BOUNDARY_REPORT_DENIED', 'A boundary reviewer can only submit its ready evidence or a blocker.'); const receipt = coordinator!.report(channel.run.id, report);
        if (report.type === 'plan-draft' && ['applied', 'noop'].includes(receipt.status)) { options.store.db.prepare("INSERT INTO host_boundary_runs VALUES(?,?,?,NULL,'pending',NULL) ON CONFLICT(domain_run_id) DO NOTHING").run(channel.run.id, report.plan.id, `boundary-context-${randomUUID()}`); authorizeDerived(channel, [planMaterial(report.plan)]); } if ((receipt.status === 'applied' || (receipt.status === 'noop' && report.type === 'plan-draft')) && ['plan-draft', 'review', 'check', 'resolve-finding', 'blocked'].includes(report.type)) channel.handoffs.push(report.type); targetDriver.sendWorkerFrame(runtime.runId, { type: 'worker.receipt', requestId: report.requestId, ok: true, value: receipt }); }
    } catch (error) { targetDriver.sendWorkerFrame(runtime.runId, { type: 'worker.receipt', requestId: report.requestId, ok: false, error: error instanceof RuntimeError ? error.code : 'REPORT_REJECTED' }); }
  }
  const prerequisites: ExecutionPrerequisites = {
    inspect: diagnostics,
    launchFor(run) { const facts = diagnostics(run.demandId); insist(facts.executionEnabled && profile, 'EXECUTION_BLOCKED', facts.blockers.join('; ')); return { workspace: options.workspace().getBinding(run.demandId)!.worktreePath, profileId: profile.config.profileId, timeoutMs: 30 * 60_000, maxOutputBytes: 16 * 1024 * 1024 }; },
    verifyWorkspaceAfterStop(demandId) { try { evidence.source(demandId); const demand = options.store.getDemand(demandId), latest = options.store.listRuns(demandId).sort((a, b) => b.generation - a.generation)[0];
      if (latest?.stage === 'review') { const content = demand.contents.find(content => content.id === latest.contentId); if (!content || !evidence.stable(demandId, content.code)) return false; for (const ref of content.knowledge) evidence.read(demandId, ref); }
      const runs = coordinator?.supervisor.list().filter(run => run.demandId === demandId && run.state === 'stopped') ?? []; return runs.length > 0 && runs.every(run => !!options.store.db.prepare('SELECT 1 FROM host_native_revocations WHERE run_id=?').get(run.runId) || (run.role === 'boundary-review' ? boundaryNative : native)?.getResourceEvidence(run.runId)?.revoked === true); } catch { return false; } },
    verifyReport(report, run) {
      const runtime = coordinator?.supervisor.list().find(runtime => runtime.grantId === run.id && runtime.role === run.stage);
      if (report.type === 'plan-ready') {
        const row = options.store.db.prepare("SELECT * FROM host_boundary_runs WHERE domain_run_id=? AND status IN ('observed','complete')").get(run.id);
        insist(row?.body && row.plan_id === report.planId, 'BOUNDARY_REVIEW_UNAVAILABLE', 'No independently observed read-only boundary review covers this exact plan.');
        const demand = options.store.getDemand(run.demandId), plan = demand.plans.find(plan => plan.id === report.planId);
        insist(plan, 'PLAN_MISSING', 'The reviewed plan is unavailable.');
        const boundary = coordinator?.supervisor.list().find(candidate => candidate.runId === row.runtime_run_id && candidate.role === 'boundary-review');
        const boundEvidence = options.store.db.prepare('SELECT body FROM host_run_evidence WHERE run_id=?').get(`boundary-${row.runtime_run_id}`);
        insist(boundary?.state === 'stopped' && !!options.store.db.prepare('SELECT 1 FROM host_native_revocations WHERE run_id=?').get(boundary.runId) && boundEvidence, 'BOUNDARY_STOP_UNVERIFIED', 'Independent review requires durable complete native stop and exact input evidence.');
        const context = JSON.parse(String(boundEvidence.body)) as { materials: AgentMaterial[]; source: AgentMaterial };
        insist(context.source.sha256 === evidence.sourceMaterial(run.demandId).sha256 && context.materials.some(material => canonicalJson(material) === canonicalJson(planMaterial(plan))) && evidence.method(demand.methodSnapshot.review!).every(method => context.materials.some(material => canonicalJson(material) === canonicalJson(method))), 'BOUNDARY_INPUTS_CHANGED', 'The exact source, scope and frozen review method must match the independent session.');
        evidence.requireOrigin(run.demandId, report.boundaryReview.evidence, `boundary-${boundary.runId}`);
        for (const ref of [plan.spec, plan.tickets, report.boundaryReview.evidence]) evidence.read(run.demandId, ref);
        return { artifactsVerified: true, boundaryReview: JSON.parse(String(row.body)) };
      }
      if (report.type === 'check') {
        const row = options.store.db.prepare('SELECT body FROM host_native_checks WHERE domain_run_id=? AND artifact_id=?').get(run.id, report.check.evidence.id);
        insist(run.stage === 'review' && row, 'CHECK_EXECUTION_UNVERIFIED', 'Check evidence requires an actually observed native subprocess receipt from this independent review run.');
        const observed = JSON.parse(String(row.body)) as { reason: string; exitCode: number | null; generation: string; runtimeRunId: string; sourceBefore: string; sourceAfter: string; environment: string };
        insist(runtime && observed.runtimeRunId === runtime.runId && observed.generation === runtime.generation, 'CHECK_GENERATION_MISMATCH', 'Native command receipt belongs to another execution generation.');
        insist(report.check.status !== 'passed' || (observed.reason === 'exited' && observed.exitCode === 0), 'CHECK_NOT_PASSED', 'Only an observed clean native exit may support a passed check.');
        const content = options.store.getDemand(run.demandId).contents.find(content => content.id === report.check.contentId);
        insist(content && evidence.stable(run.demandId, content.code) && observed.sourceBefore === content.code.digest && observed.sourceAfter === content.code.digest, 'CHECK_CONTENT_CHANGED', 'Native check does not cover the current exact source snapshot.');
        insist(report.check.environment === observed.environment && observed.environment === nativeEnvironment(runtime), 'CHECK_ENVIRONMENT_CHANGED', 'Only the exact Host-observed native environment can label a check.');
      }
      if (!['blocked', 'runtime-ended', 'message-delivered', 'message-applied'].includes(report.type)) {
        const channel = runtime ? channels.get(runtime.runId) : undefined;
        insist(channel?.ready && channel.modelObserved, 'MODEL_OBSERVATION_REQUIRED', 'An observed model session is required for a stage evidence handoff.');
      }
      if (report.type === 'review' || report.type === 'resolve-finding') {
        const demand = options.store.getDemand(run.demandId), content = demand.contents.find(content => content.id === report.contentId), plan = demand.plans.find(plan => plan.id === run.planId), channel = channels.get(runtime!.runId)!;
        insist(plan && content && [...evidence.method(run.method), planMaterial(plan), contentMaterial(content), evidence.read(demand.id, content.code), ...content.knowledge.map(ref => evidence.read(demand.id, ref))].every(expected => channel.init.materials.some(material => canonicalJson(material) === canonicalJson(expected))), 'REVIEW_INPUTS_CHANGED', 'Review must bind the exact frozen method, plan, code and local knowledge versions.');
        evidence.requireOrigin(run.demandId, report.evidence, run.id);
      }
      return evidence.verification(report, run, runtime?.state === 'stopped');
    },
    classifyExit(run) { const channel = [...channels.values()].find(channel => channel.run.id === run.id);
      return channel?.settled && channel.modelObserved && channel.handoffs.length ? { outcome: 'handoff', evidence: `Authenticated native terminal context ${channel.init.sessionId}; verified reports: ${channel.handoffs.join(', ')}.` } : { outcome: 'unknown', evidence: 'No verified terminal model/tool handoff for this exact native generation.' }; },
  };
  async function verifyBaselineChecks(input: BaselineCheckRequest): Promise<BaselineCheckVerification> {
    insist(coordinator, 'HOST_CHANNEL_UNBOUND', 'The native check lane requires the Host coordinator.'); refreshNative();
    const demand = options.store.getDemand(input.demandId), workspace = options.workspace(), binding = workspace.getBinding(demand.id);
    insist(binding && demand.control === 'active' && options.store.listRuns(demand.id).every(run => run.status === 'stopped') && coordinator.supervisor.list().filter(run => run.demandId === demand.id).every(run => run.state === 'stopped'), 'BASELINE_CHECK_BUSY', 'Fresh baseline checks require active user control and all previous demand execution stopped.');
    const intent = options.store.db.prepare("SELECT data FROM workspace_intents WHERE operation_id=? AND kind='baseline' AND status='complete'").get(input.operationId);
    const baseline = intent ? JSON.parse(String(intent.data)) as { request: { demandId: string }; result: { head: string } } : undefined;
    insist(baseline?.request.demandId === demand.id && baseline.result.head === input.expectedHead && binding.head === input.expectedHead, 'BASELINE_CHECK_SCOPE', 'The exact committed integration operation must match this demand and HEAD.');
    insist(Array.isArray(input.checkIds) && input.checkIds.length > 0 && input.checkIds.length <= 16 && new Set(input.checkIds).size === input.checkIds.length, 'BASELINE_CHECK_SCOPE', 'Select one to sixteen exact prior check recipes.');
    const result = demand.results.find(result => result.id === input.templateResultId); insist(result, 'BASELINE_CHECK_SCOPE', 'The selected historical result is unavailable.');
    const recipes = input.checkIds.map(id => {
      const check = result.E.find(check => check.id === id); insist(check?.status === 'passed', 'BASELINE_CHECK_SCOPE', 'Each selected passed check must belong to the exact historical result.');
      const rows = options.store.db.prepare('SELECT body,domain_run_id FROM host_native_checks WHERE artifact_id=?').all(check.evidence.id).filter(row => options.store.listRuns(demand.id).some(run => run.id === row.domain_run_id && run.stage === 'review' && run.contentId === result.contentId));
      insist(rows.length === 1, 'CHECK_EXECUTION_UNVERIFIED', 'The recipe must originate in one exact native review run for this demand content.'); const row = rows[0]!;
      const observed = JSON.parse(String(row.body)) as { provenance: string; executable?: string; args: string[]; reason: string; exitCode: number|null; sourceBefore: string; sourceAfter: string };
      insist(evidence.read(demand.id, check.evidence).content === row.body && observed.provenance === (synthetic ? 'synthetic-native-receipt' : 'native-helper-command-observation') && observed.reason === 'exited' && observed.exitCode === 0 && observed.sourceBefore === result.K.digest && observed.sourceAfter === result.K.digest && Array.isArray(observed.args), 'CHECK_EXECUTION_UNVERIFIED', 'A bounded immutable successful native recipe for the old exact source is required.');
      insist(observed.executable === undefined || ['node', 'git-bash'].includes(observed.executable), 'BASELINE_CHECK_SCOPE', 'Recipe executable kind is not supported.');
      insist(observed.executable !== 'git-bash' || profile!.config.shell, 'SHELL_UNAVAILABLE', 'The selected shell recipe requires an exact locked Git Bash profile.');
      return { check, args: observed.args, executable: observed.executable ?? 'node' };
    });
    const source = evidence.sourceMaterial(demand.id); insist(JSON.parse(source.content).head === input.expectedHead && workspace.git.status(binding.worktreePath).length === 0, 'BASELINE_CHECK_CONTENT_CHANGED', 'The freshly integrated source must be the exact clean committed HEAD.');
    const environment = currentKnowledgeEnvironment(), key = `baseline-${hash(canonicalJson({ input, source: source.sha256, environment })).slice(0, 40)}`;
    const prior = options.store.db.prepare('SELECT * FROM host_baseline_checks WHERE operation_key=?').get(key);
    if (prior) { insist(prior.status === 'complete' && !!options.store.db.prepare('SELECT 1 FROM host_native_revocations WHERE run_id=?').get(String(prior.runtime_run_id)), 'BASELINE_CHECK_UNRESOLVED', 'A prior check attempt is unresolved; verify its native stop before retrying.'); return JSON.parse(String(prior.body)) as BaselineCheckVerification; }
    insist(!options.store.db.prepare('SELECT 1 FROM host_native_check_lease').get(), 'CHECK_CAPACITY', 'Another command owns the finite native check slot.');
    options.store.db.prepare('INSERT INTO host_baseline_checks VALUES(?,NULL,?,?)').run(key, canonicalJson(input), 'launching');
    let ready = false, runtime: RunRecord | undefined, laneSupervisor!: RuntimeSupervisor;
    const authorizeCurrent = () => { const current = options.store.getDemand(demand.id); insist(current.control === 'active' && current.revision === demand.revision && evidence.sourceMaterial(demand.id).sha256 === source.sha256 && options.workspace().getBinding(demand.id)?.head === input.expectedHead && currentKnowledgeEnvironment() === environment, 'BASELINE_CHECK_AUTHORITY_CHANGED', 'Baseline control, exact source or environment changed during local checks.'); };
    const laneDriver = makeNative(run => {
      authorizeCurrent(); const scratch = join(stateDirectory, 'runs', run.runId); noLinks(scratch, true); mkdirSync(scratch, { recursive: true, mode: 0o700 }); noLinks(scratch); const sessionDir = join(scratch, 'session'); mkdirSync(sessionDir, { mode: 0o700 });
      const init: WorkerInit = { version: 1, type: 'worker.init', runId: run.runId, generation: run.generation, demandId: demand.id, domainRunId: key, domainGeneration: 1, role: 'check', checkOnly: true, workspace: binding.worktreePath, scratch, sessionDir, sessionId: randomUUID(), capability: randomBytes(32).toString('hex'), prompt: 'Host-authorized native checks only. No model operation.', materials: [source], model: { provider: 'disabled', id: 'no-model', contextWindow: 1024, maxTokens: 1 }, compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, limits: { maxFileBytes: 1024 * 1024, commandTimeoutMs: 120_000, maxOutputBytes: 524_288 } };
      checkLanes.set(run.runId, { driver: laneDriver, supervisor: laneSupervisor, authorize: authorizeCurrent });
      options.store.db.prepare('UPDATE host_baseline_checks SET runtime_run_id=? WHERE operation_key=?').run(run.runId, key);
      laneDriver.setWorkerFrameHandler(async (bound, frame) => { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)) as Record<string, unknown>; insist(!ready && value.type === 'worker.ready' && value.runId === bound.runId && value.generation === bound.generation && value.sessionId === init.sessionId, 'BASELINE_WORKER_CHANNEL_DENIED', 'The check-only Worker may report its exact ready identity once; model and report frames are forbidden.'); ready = true; });
      return { profileName: appContainerProfileName(run.demandId, run.role, run.generation), scratch, aclEvidence: profile!.evidenceDigests.join(','), privateChannelEvidence: profile!.evidenceDigests.join(','), processLimit: 8, memoryLimitBytes: 1024 * 1024 * 1024, diskLimitBytes: 1024 * 1024 * 1024, fileLimit: 100_000, minimumFreeBytes: 256 * 1024 * 1024, diskPollMs: 250, workerInit: init as unknown as Record<string, unknown>, resourceAuthorizationId: input.operationId, readonlyRuntimeRoots: [...new Set([profile!.config.node.path, profile!.config.worker.path, ...(profile!.config.shell ? readLockedShellManifest(profile!.config.shell).files.map(file => file.path) : [])])] };
    });
    laneDriver.setWorkerFrameHandler(async () => { throw new RuntimeError('BASELINE_WORKER_CHANNEL_DENIED', 'No bound check-only Worker exists.'); });
    laneSupervisor = new RuntimeSupervisor(options.store.db, laneDriver, request => { authorizeCurrent(); insist(request.role === 'check' && !request.writes && request.highResource && request.grantId === key, 'BASELINE_CHECK_SCOPE', 'Only this explicitly requested readonly local check lane is authorized.'); });
    laneDriver.setStopHandler(async (id, why) => { await laneSupervisor.stop(id, why); retainRevocation(id, laneDriver); });
    const evidenceRefs: string[] = [];
    try {
      runtime = await laneSupervisor.launch({ demandId: demand.id, grantId: key, role: 'check', writes: false, highResource: true, workspace: binding.worktreePath, profileId: profile!.config.profileId, timeoutMs: Math.min(30 * 60_000, recipes.length * 135_000 + 15_000), maxOutputBytes: 16 * 1024 * 1024 });
      const deadline = Date.now() + 10_000;
      while (!ready && Date.now() < deadline) { authorizeCurrent(); await new Promise(resolve => setTimeout(resolve, 20)); }
      insist(ready, 'BASELINE_WORKER_NOT_READY', 'The bounded check-only Worker never became ready.');
      for (const { check, args, executable } of recipes) {
        authorizeCurrent(); insist(laneSupervisor.isDispatchAllowed(runtime.runId) && !options.store.db.prepare('SELECT 1 FROM host_native_check_lease').get(), 'CHECK_CAPACITY', 'The native command lane is stopped or already occupied.');
        const requestId = randomUUID(); options.store.db.prepare('INSERT INTO host_native_check_lease VALUES(1,?,?)').run(runtime.runId, requestId);
        insist(executable !== 'git-bash' || laneDriver.runShellCheck, 'SHELL_UNAVAILABLE', 'Locked Git Bash command adapter is unavailable.');
        const observed = executable === 'git-bash' ? await laneDriver.runShellCheck!(runtime.runId, args, { timeoutMs: 120_000, maxOutputBytes: 524_288 }, requestId) : await laneDriver.runNodeCheck(runtime.runId, args, { timeoutMs: 120_000, maxOutputBytes: 524_288 }, requestId);
        authorizeCurrent(); insist(observed.requestId === requestId && observed.reason === 'exited' && observed.exitCode === 0, 'BASELINE_CHECK_FAILED', 'A freshly executed baseline capability check did not pass.');
        const { outputBase64: _duplicate, ...nativeEvidence } = observed.nativeEvidence;
        const body = canonicalJson({ provenance: synthetic ? 'synthetic-native-receipt' : 'native-helper-command-observation', executable, runtimeRunId: runtime.runId, generation: runtime.generation, requestId, args, templateCheckId: check.id, operationId: input.operationId, head: input.expectedHead, sourceBefore: source.sha256, sourceAfter: source.sha256, environment, reason: observed.reason, exitCode: observed.exitCode, output: observed.output, nativeEvidence: { ...nativeEvidence, outputSha256: hash(observed.output) } });
        const ref = evidence.save({ id: `native-check-${requestId}`, projectId: demand.projectId, demandId: demand.id, runId: key, kind: 'check-evidence', text: body });
        options.store.db.prepare('INSERT INTO host_native_checks VALUES(?,?,?,?,?)').run(requestId, runtime.runId, key, ref.id, body); evidenceRefs.push(ref.id);
        options.store.db.prepare('DELETE FROM host_native_check_lease WHERE request_id=?').run(requestId);
      }
      const stopped = await laneSupervisor.stop(runtime.runId, 'baseline-checks-complete'); retainRevocation(runtime.runId, laneDriver);
      insist(stopped.state === 'stopped' && !!options.store.db.prepare('SELECT 1 FROM host_native_revocations WHERE run_id=?').get(runtime.runId), 'BASELINE_CHECK_STOP_UNVERIFIED', 'Check results require complete native stop and revoked resources.'); authorizeCurrent();
      const verification: BaselineCheckVerification = { head: input.expectedHead, sourceDigest: source.sha256, environment, evidenceRefs, provenance: synthetic ? 'synthetic-native-receipt' : 'native-helper-command-observation', stopped: true };
      options.store.db.prepare("UPDATE host_baseline_checks SET body=?,status='complete' WHERE operation_key=?").run(canonicalJson(verification), key); return verification;
    } catch (error) {
      runtime ??= laneSupervisor.list().find(run => run.grantId === key);
      if (runtime) { await laneSupervisor.stop(runtime.runId, 'baseline-check-failed'); retainRevocation(runtime.runId, laneDriver); }
      options.store.db.prepare("UPDATE host_baseline_checks SET status='failed' WHERE operation_key=?").run(key); throw error;
    }
  }
  function auxiliaryStatus(): { safe: boolean; blockers: string[] } { const runs = coordinator?.supervisor.list().filter(run => ['boundary-review', 'check'].includes(run.role)) ?? []; const unresolved = runs.filter(run => run.state !== 'stopped' || !options.store.db.prepare('SELECT 1 FROM host_native_revocations WHERE run_id=?').get(run.runId)); return { safe: unresolved.length === 0, blockers: unresolved.map(run => `Independent ${run.role} ${run.demandId}: ${run.state}; complete native stop/resource revocation is required.`) }; }
  async function stopAllAuxiliary(reason = 'user-stop'): Promise<void> {
    // Durable rows remain authoritative after Host restart. Missing live handles
    // still receive stop intent and remain unknown/occupied, never disappear.
    for (const runtime of coordinator?.supervisor.list().filter(run => ['boundary-review', 'check'].includes(run.role)) ?? []) {
      channels.get(runtime.runId)?.abort.abort();
      if (checkLanes.has(runtime.runId)) await checkLanes.get(runtime.runId)!.supervisor.stop(runtime.runId, reason);
      else if (boundarySupervisor && channels.has(runtime.runId)) await boundarySupervisor.stop(runtime.runId, reason);
      else await coordinator!.supervisor.stop(runtime.runId, reason);
      retainRevocation(runtime.runId, recoveryDriver(runtime));
    }
  }
  async function tick(): Promise<void> {
    for (const runtime of coordinator?.supervisor.list().filter(run => ['boundary-review', 'check'].includes(run.role) && run.state !== 'stopped' && !channels.has(run.runId)) ?? []) {
      const demand = options.store.getDemand(runtime.demandId);
      if (runtime.role === 'check') {
        const lane = checkLanes.get(runtime.runId);
        if (!lane) await coordinator!.supervisor.stop(runtime.runId, 'recovered-check-requires-stop');
        else try { lane.authorize(); } catch { await lane.supervisor.stop(runtime.runId, 'baseline-check-authority-changed'); retainRevocation(runtime.runId, lane.driver); }
      } else if (demand.control !== 'active' || demand.blockedReasons.length) await coordinator!.supervisor.stop(runtime.runId, 'recovered-workflow-control-changed');
    }
    for (const channel of channels.values()) if (channel.boundary && boundarySupervisor) {
      const demand = options.store.getDemand(channel.run.demandId);
      if (demand.control !== 'active' || demand.blockedReasons.length || channel.run.planId !== demand.activePlanId) { channel.abort.abort(); await boundarySupervisor.stop(channel.runtime.runId, 'workflow-control-changed'); retainRevocation(channel.runtime.runId, boundaryNative); options.store.db.prepare("UPDATE host_boundary_runs SET status='failed' WHERE domain_run_id=? AND status!='complete'").run(channel.run.id); }
      else if (!channel.settled) { const observed = await boundarySupervisor.observe(channel.runtime.runId); if (observed.state === 'stopped') { retainRevocation(channel.runtime.runId, boundaryNative); options.store.db.prepare("UPDATE host_boundary_runs SET status='failed' WHERE domain_run_id=?").run(channel.run.id); options.workflow.blockDemand(channel.run.demandId, 'BOUNDARY_HANDOFF_MISSING', 'Independent boundary reviewer stopped without its terminal evidence handoff.'); } }
    }
    await coordinator?.tick();
  }
  return { synthetic: !!synthetic, driver, prerequisites, evidence, prepareDemand, tick, stopAllAuxiliary, auxiliaryStatus, diagnostics, captureMethods, requiredModelData, currentKnowledgeEnvironment, verifyBaselineChecks, bindCoordinator(value: ExecutionCoordinator) { insist(!coordinator || coordinator === value, 'COORDINATOR_CONFLICT', 'Production services are already bound.'); coordinator = value; } };
}
export type ProductionServices = ReturnType<typeof createProductionServices>;
