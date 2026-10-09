import { basename, dirname, join, resolve } from 'node:path';
import { lstatSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { WorkflowService, WorkbenchStore } from '../domain/index.ts';
import type { Demand, UserCommand, Stage } from '../domain/types.ts';
import type { ViewState, DemandView } from '../desktop/renderer/types.ts';
import { COMMANDS, PLANNING_COMMANDS, ProtocolError, digest, id, record, revision, text } from './protocol.ts';
import { ModelBudgetLedger } from '../runtime/budget.ts';
import { WorkspaceService, ImmutableObjectStore } from '../workspace/index.ts';
import { KnowledgeService } from '../knowledge/index.ts';
import { ExecutionCoordinator } from './coordinator.ts';
import { ConfigurationStore, configurationDigest, createModelGrant, loadMethods } from './configuration.ts';
import { createProductionServices } from './production.ts';
import { HostKnowledgeLifecycle } from './knowledge-lifecycle.ts';
import { loadInstalledWindowsEvidenceTrust } from '../runtime/profile.ts';
import type { WindowsEvidenceTrustAnchor } from '../runtime/evidence-auth.ts';

export const EXECUTION_BLOCKERS = [
  'Windows AppContainer / Job Objects 运行组合尚未验证；不会在无隔离环境启动 Agent。',
  '请配置并核验真实 design-feature 与依赖，以及独立实施 / Review 方法。',
  '模型、允许出站的资料及有限用量尚未授权；当前不会发送模型请求。',
];

/** Lives only in the separately launched Node 24 Host. No renderer/Worker gets
 * the store, trustedUser factory, filesystem operations, or report capability. */
export class HostApplication {
  readonly store: WorkbenchStore;
  readonly workflow: WorkflowService;
  readonly coordinator: ExecutionCoordinator;
  readonly knowledge: KnowledgeService;
  readonly budget: ModelBudgetLedger;
  readonly configuration: ConfigurationStore;
  readonly production: ReturnType<typeof createProductionServices>;
  readonly knowledgeLifecycle: HostKnowledgeLifecycle;
  #runtimeTrustProblem: string | undefined;
  #temporaryConfiguration: string | undefined;
  #workspace?: WorkspaceService;
  #closing = false;
  #user;
  constructor(databasePath = ':memory:') {
    this.store = new WorkbenchStore(databasePath);
    this.workflow = new WorkflowService(this.store);
    this.#user = this.workflow.trustedUser('local-desktop-owner');
    const configDirectory = databasePath === ':memory:' ? this.#temporaryConfiguration = mkdtempSync(join(tmpdir(), 'pi-config-host-')) : join(dirname(resolve(databasePath)), 'configuration');
    this.configuration = new ConfigurationStore(configDirectory);
    this.store.db.exec('CREATE TABLE IF NOT EXISTS host_snapshot_sequence(singleton INTEGER PRIMARY KEY CHECK(singleton=1), value INTEGER NOT NULL); INSERT OR IGNORE INTO host_snapshot_sequence VALUES(1,0)');
    this.store.db.exec('CREATE TABLE IF NOT EXISTS host_model_decisions(request_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, demand_id TEXT NOT NULL, configuration_digest TEXT NOT NULL, grant_id TEXT NOT NULL, decision_id TEXT NOT NULL, created_at TEXT NOT NULL)');
    this.store.db.exec('CREATE TABLE IF NOT EXISTS host_local_commit_authorities(demand_id TEXT NOT NULL,plan_id TEXT NOT NULL,request_id TEXT NOT NULL,author_json TEXT NOT NULL,PRIMARY KEY(demand_id,plan_id))');
    this.store.db.exec('CREATE TABLE IF NOT EXISTS host_project_baselines(project_id TEXT PRIMARY KEY, baseline TEXT, formal_target TEXT NOT NULL)');
    if (!this.store.db.prepare('PRAGMA table_info(host_model_decisions)').all().some(column => column.name === 'runtime_scope')) this.store.db.exec("ALTER TABLE host_model_decisions ADD COLUMN runtime_scope TEXT NOT NULL DEFAULT 'none'");
    this.knowledge = new KnowledgeService({ db: this.store.db, resolveStore: projectId => {
      const project = this.workspace.getProject(projectId);
      return ImmutableObjectStore.open(project.anchorPath, projectId);
    } });
    this.budget = new ModelBudgetLedger(this.store.db, grant => {
      const decision = this.store.db.prepare('SELECT * FROM host_model_decisions WHERE decision_id=? AND demand_id=? AND grant_id=?').get(grant.decisionId, grant.demandId, grant.id);
      if (!decision) throw new ProtocolError('MODEL_AUTHORIZATION_MISSING', 'No independently recorded trusted model/data/spend approval exists.');
    });
    let evidenceTrustAnchor: WindowsEvidenceTrustAnchor | undefined;
    const trustDirectory = process.env.PI_KANBAN_RUNTIME_TRUST_DIR, trustDigest = process.env.PI_KANBAN_RUNTIME_TRUST_SHA256;
    if (trustDirectory || trustDigest) {
      try {
        if (!trustDirectory || !trustDigest) throw new Error('Both trusted installation directory and its independently pinned digest are required.');
        evidenceTrustAnchor = loadInstalledWindowsEvidenceTrust(trustDirectory, trustDigest);
      } catch (error) { this.#runtimeTrustProblem = error instanceof Error ? error.message : 'Installed runtime recorder trust could not be verified.'; }
    }
    this.production = createProductionServices({ store: this.store, workflow: this.workflow, configuration: () => this.configuration.load(), workspace: () => this.workspace, knowledge: this.knowledge, budget: this.budget, stateDirectory: join(configDirectory, 'runtime'), evidenceTrustAnchor, localCommitAuthor: demandId => { const demand = this.store.getDemand(demandId); if (!demand.grant?.localCommit) return null; const row = this.store.db.prepare('SELECT author_json FROM host_local_commit_authorities WHERE demand_id=? AND plan_id=?').get(demandId, demand.grant.planId); return row ? JSON.parse(String(row.author_json)) : null; } });
    this.coordinator = new ExecutionCoordinator(this.store, this.workflow, this.production.driver, this.production.prerequisites);
    this.production.bindCoordinator(this.coordinator);
    this.knowledgeLifecycle = new HostKnowledgeLifecycle({ store: this.store, workflow: this.workflow, knowledge: this.knowledge, workspace: () => this.workspace, evidence: this.production.evidence, verifyBaselineChecks: request => this.production.verifyBaselineChecks(request),
      stopped: demandId => !this.store.listRuns(demandId).some(run => run.status !== 'stopped') && !this.coordinator.supervisor.list().some(run => run.demandId === demandId && run.state !== 'stopped') && this.production.auxiliaryStatus().safe });
  }
  /** Host-only lazy service: absent Windows Git configuration does not prevent
   * users recording ideas. It blocks only repository preparation/execution. */
  get workspace(): WorkspaceService {
    return this.#workspace ??= new WorkspaceService({ db: this.store.db, gitExecutable: process.env.PI_KANBAN_GIT });
  }
  inspectProject(input: unknown) {
    const params = record(input), rootPath = realpathSync(resolve(text(params.rootPath, 'project directory', 4096)));
    try {
      const formalTarget = this.workspace.git.branch(rootPath), baseline = this.workspace.git.head(rootPath);
      return { rootPath, formalTarget, baseline, blockers: [] as string[] };
    } catch (error) { return { rootPath, formalTarget: null, baseline: null, blockers: [error instanceof Error ? error.message : 'Project Git preparation is unavailable.'] }; }
  }
  snapshot(): ViewState {
    this.store.db.prepare('UPDATE host_snapshot_sequence SET value=value+1 WHERE singleton=1').run();
    const configuration = this.configuration.inspect();
    const runtime = this.production.diagnostics();
    const approval = this.store.db.prepare('SELECT * FROM host_model_decisions WHERE configuration_digest=? ORDER BY rowid DESC LIMIT 1').get(configuration.configurationDigest);
    return {
      sequence: Number(this.store.db.prepare('SELECT value FROM host_snapshot_sequence WHERE singleton=1').get()!.value),
      projects: this.store.listProjects().map(p => ({ id: p.id, name: p.name, rootPath: p.rootPath })),
      demands: this.store.listDemands().map(d => this.#view(d)),
      runtime: { platform: process.platform, node: process.version, executionEnabled: runtime.executionEnabled, blockers: [...new Set([...runtime.blockers, ...(this.#runtimeTrustProblem ? [this.#runtimeTrustProblem] : []), ...configuration.methods.flatMap(method => method.blockers), ...configuration.provider.blockers])], connection: 'connected', model: configuration.configuration.provider?.modelId },
      configuration: { ...configuration, authorization: approval ? { demandId: String(approval.demand_id), grantId: String(approval.grant_id), configurationDigest: String(approval.configuration_digest) } : undefined },
    };
  }
  #view(d: Demand): DemandView {
    const plan = d.plans.find(p => p.id === d.activePlanId);
    const result = d.results.find(r => r.id === d.activeResultId);
    const runs = this.store.listRuns(d.id);
    const run = runs.at(-1);
    let binding: ReturnType<WorkspaceService['getBinding']>;
    try { binding = this.workspace.getBinding(d.id); } catch { binding = null; }
    return {
      id: d.id, projectId: d.projectId, title: d.title, description: d.description, version: d.revision, phase: d.phase, control: d.control,
      planningFlow: d.planningFlow ? structuredClone(d.planningFlow) : undefined,
      executionFlow: d.executionFlow ? structuredClone(d.executionFlow) : undefined,
      plan: plan ? { id: plan.id, scope: plan.scope, ready: plan.ready, confirmed: d.confirmedPlanId === plan.id, specPath: plan.spec.location, spec: structuredClone(plan.spec), tickets: structuredClone(plan.tickets), boundaryReviewEvidence: plan.boundaryReview ? structuredClone(plan.boundaryReview.evidence) : undefined, requiredChecks: plan.requiredChecks.map(c => c.name), unresolvedQuestions: [...plan.unresolvedQuestions] } : undefined,
      result: result ? { id: result.id, contentId: result.contentId, notes: result.notes, createdAt: result.createdAt, codeRef: result.K.location, codeArtifact: structuredClone(result.K), knowledgeArtifacts: structuredClone(result.N), reviewEvidence: structuredClone(result.review.evidence), knowledgeRefs: result.N.map(n => n.id), accepted: d.acceptances.some(a => a.resultId === result.id && a.decision === 'accepted') } : undefined,
      activeContentId: d.activeContentId, methodSnapshot: structuredClone(d.methodSnapshot), findings: structuredClone(d.findings), workflowBlockers: [...d.blockedReasons],
      blockers: [...d.blockedReasons, ...(d.planningStarted && d.control === 'active' && !result ? this.production.diagnostics(d.id).blockers : [])],
      activities: this.store.history(d.id).slice(-200).map((h, index) => ({ id: `${d.id}-${index}`, kind: 'workflow', title: h.kind, timestamp: h.createdAt, status: 'complete' })),
      messages: d.messages.map(m => ({ id: m.id, role: 'user', text: m.text, state: m.state })),
      checks: d.checks.map(c => ({ id: c.id, name: plan?.requiredChecks.find(r => r.id === c.requirementId)?.name ?? c.requirementId, status: c.status, evidence: c.evidence.location, artifact: structuredClone(c.evidence), contentId: c.contentId })),
      workspacePath: binding?.worktreePath, branch: binding?.branch,
      knowledgeLifecycle: this.knowledgeLifecycle.snapshot(d.id),
      knowledge: result?.N.map(n => ({ id: n.id, title: n.id, status: 'candidate', detail: '本轮版本已保存；接受成果与取得跨需求复用资格是不同事实。' })) ?? [],
      runState: run ? run.status === 'starting' ? 'queued' : run.status : this.store.outbox('pending').some(o => o.demandId === d.id && o.kind === 'start-run') ? 'queued' : 'idle',
    };
  }
  handle(method: string, input: unknown): ViewState {
    if (this.#closing && method !== 'snapshot') throw new ProtocolError('APP_STOPPING', 'Application exit is in progress; no new control can restart work.');
    const params = record(input);
    let selected: ViewState['selected'];
    switch (method) {
      case 'snapshot': break;
      case 'createProject': {
        // rootPath comes only from the main process's explicit folder picker.
        const rootPath = resolve(text(params.rootPath, 'project folder', 4096));
        const stat = lstatSync(rootPath);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ProtocolError('INVALID_PROJECT', 'Select a real project directory.');
        const realPath = realpathSync(rootPath);
        const existing = this.store.listProjects().find(p => p.rootPath === realPath);
        const project = existing ?? this.workflow.createProject({ name: basename(realPath), rootPath: realPath, methods: this.production.captureMethods() });
        if (params.formalTarget !== undefined) {
          const observed = this.inspectProject({ rootPath: realPath });
          if (observed.formalTarget !== params.formalTarget || observed.baseline !== params.baseline) throw new ProtocolError('PROJECT_BASE_CHANGED', 'The selected formal branch or exact baseline changed before confirmation.');
          this.workspace.bindProject({ projectId: project.id, anchorPath: realPath, formalTarget: text(params.formalTarget, 'formal target', 150) });
          const old = this.store.db.prepare('SELECT baseline,formal_target FROM host_project_baselines WHERE project_id=?').get(project.id);
          if (old && (old.baseline !== observed.baseline || old.formal_target !== observed.formalTarget)) throw new ProtocolError('BASELINE_CHANGE_REQUIRES_DECISION', 'Existing project baseline is preserved. Use a separately authorized baseline update.');
          if (!old) this.store.db.prepare('INSERT INTO host_project_baselines VALUES(?,?,?)').run(project.id,observed.baseline,observed.formalTarget);
        }
        selected = { projectId: project.id };
        break;
      }
      case 'importConfiguration': {
        if (this.store.listRuns().some(run => run.status !== 'stopped') || this.coordinator.supervisor.list().some(run => run.state !== 'stopped') || !this.production.auxiliaryStatus().safe) throw new ProtocolError('RUN_ACTIVE', 'Stop and verify all execution trees and native resource revocations before importing execution settings.');
        const config = this.configuration.importFromFile(text(params.filePath, 'configuration file', 4096));
        const methods = this.production.captureMethods(config);
        for (const project of this.store.listProjects()) this.workflow.updateProjectMethods(project.id, methods, this.#user);
        for (const demand of this.store.listDemands()) this.workflow.completeMissingMethods(demand.id);
        break;
      }
      case 'prepareModelApproval': {
        const demandId = id(params.demandId), demand = this.store.getDemand(demandId);
        if (demand.revision !== revision(params.expectedVersion)) throw new ProtocolError('STALE_CONTROL', 'Refresh the selected demand before preparing its data scope.');
        const config = this.configuration.load();
        if (!config.provider) throw new ProtocolError('MODEL_CONFIGURATION_MISSING', 'Import the intended provider, model, endpoint, credential reference and finite limits first.');
        const data = this.production.requiredModelData(demandId);
        if (JSON.stringify(config.provider.data) !== JSON.stringify(data)) this.configuration.save({ ...config, provider: { ...config.provider, data } });
        selected = { projectId: demand.projectId, demandId }; break;
      }
      case 'authorizeModel': {
        const requestId = id(params.requestId), demandId = id(params.demandId);
        if (params.resourceScope !== 'demand-worktree-private-runtime-v1') throw new ProtocolError('RUNTIME_SCOPE_UNREVIEWED', 'Review the bounded per-demand local resource scope before authorizing.');
        const digest = text(params.configurationDigest, 'configuration digest', 64);
        const inputHash = createHash('sha256').update(JSON.stringify({ requestId, demandId, expectedVersion: revision(params.expectedVersion), configurationDigest: digest, resourceScope: params.resourceScope })).digest('hex');
        const prior = this.store.db.prepare('SELECT * FROM host_model_decisions WHERE request_id=?').get(requestId);
        if (prior) {
          if (prior.input_hash !== inputHash) throw new ProtocolError('IDEMPOTENCY_CONFLICT', 'The model approval request changed content.');
          selected = { projectId: this.store.getDemand(demandId).projectId, demandId }; break;
        }
        const demand = this.store.getDemand(demandId), config = this.configuration.load();
        if (demand.revision !== params.expectedVersion) throw new ProtocolError('STALE_CONTROL', 'The demand version changed before model approval.');
        if (demand.control === 'cancelled') throw new ProtocolError('CANCELLED', 'Cancelled demands cannot receive new model authority.');
        if (configurationDigest(config) !== digest) throw new ProtocolError('STALE_CONFIGURATION', 'The model/data/spend configuration changed. Review it again.');
        const existing = this.store.db.prepare('SELECT * FROM host_model_decisions WHERE demand_id=? AND configuration_digest=? LIMIT 1').get(demandId, digest);
        if (!existing) {
          const suffix = createHash('sha256').update(`${demandId}:${digest}`).digest('hex').slice(0,32), grantId = `model_${suffix}`, decisionId = `decision_${suffix}`;
          const grant = createModelGrant(config, { id: grantId, demandId, decisionId }, candidate => {
            if (candidate.demandId !== demandId || configurationDigest(config) !== digest) throw new ProtocolError('MODEL_SCOPE_CHANGED', 'Approval scope changed.');
          });
          this.store.transaction(() => {
            this.store.db.prepare('INSERT INTO host_model_decisions(request_id,input_hash,demand_id,configuration_digest,grant_id,decision_id,created_at,runtime_scope) VALUES(?,?,?,?,?,?,?,?)').run(requestId,inputHash,demandId,digest,grantId,decisionId,new Date().toISOString(),'demand-worktree-private-runtime-v1');
            this.budget.grant(grant);
          });
        }
        selected = { projectId: demand.projectId, demandId }; break;
      }
      case 'createDemand': {
        const requestId = id(params.requestId, 'creation request identifier');
        const input = { id: `demand_${createHash('sha256').update(requestId).digest('hex').slice(0,32)}`, projectId: id(params.projectId), title: text(params.title, 'title', 160), description: params.description === undefined ? '' : text(params.description, 'description', 20_000, true) };
        const existing = this.store.listDemands().find(demand => demand.id === input.id);
        if (existing) {
          if (existing.projectId !== input.projectId || existing.title !== input.title || existing.description !== input.description) throw new ProtocolError('IDEMPOTENCY_CONFLICT', 'Creation request identity was reused for different content.');
        } else this.workflow.createDemand(input);
        selected = { projectId: input.projectId, demandId: input.id };
        break;
      }
      case 'command': {
        const kind = text(params.kind, 'command', 60);
        if (!COMMANDS.has(kind)) throw new ProtocolError('UNKNOWN_COMMAND', 'Unsupported desktop control.');
        const common = { requestId: id(params.requestId), demandId: id(params.demandId), expectedRevision: revision(params.expectedVersion) };
        let command: UserCommand;
        let localAuthor: { name: string; email: string } | undefined;
        if (PLANNING_COMMANDS.has(kind)) {
          const binding = { ...common, flowId: id(params.flowId, 'planning flow'), flowRevision: revision(params.flowRevision) };
          if (kind === 'confirm-understanding') command = { ...binding, type: kind, understandingId: id(params.understandingId, 'requirements version'), digest: digest(params.digest, 'requirements digest') };
          else if (kind === 'confirm-final-design') command = { ...binding, type: kind, designId: id(params.designId, 'design version'), digest: digest(params.digest, 'final design and resolution digest') };
          else if (kind === 'answer-planning-question') command = { ...binding, type: kind, questionId: id(params.questionId, 'planning question'), questionDigest: digest(params.questionDigest, 'planning question digest'), answer: text(params.answer, 'planning answer') };
          else {
            if (params.scope !== 'requirements' && params.scope !== 'design') throw new ProtocolError('INVALID_INPUT', 'Select requirements or design as the revision scope.');
            command = { ...binding, type: 'revise-planning', scope: params.scope, reason: text(params.text, 'scoped planning revision') };
          }
        }
        else if (kind === 'authorize-implementation') {
          if (params.localCommit !== undefined && typeof params.localCommit !== 'boolean') throw new ProtocolError('INVALID_INPUT', 'Local commit permission must be explicit.');
          if (params.localCommit === true) {
            localAuthor = { name: text(params.authorName, 'local commit author', 200), email: text(params.authorEmail, 'local commit email', 320) };
            if (/[\r\n<>]/.test(localAuthor.name) || !/^[^\s<>@]+@[^\s<>@]+$/.test(localAuthor.email)) throw new ProtocolError('INVALID_AUTHOR', 'Use an explicit valid local Git author identity.');
          }
          command = { ...common, type: kind, planId: id(params.planId, 'plan version'), localCommit: params.localCommit === true, originalText: localAuthor ? JSON.stringify({ localCommit: true, author: localAuthor }) : undefined };
        }
        else if (kind === 'confirm-plan') command = { ...common, type: kind, planId: id(params.planId, 'plan version') };
        else if (kind === 'accept-result') command = { ...common, type: kind, resultId: id(params.resultId, 'result version') };
        else if (kind === 'return-result') command = { ...common, type: kind, resultId: id(params.resultId, 'result version'), reason: text(params.text, 'return reason') };
        else if (kind === 'revise-plan') command = { ...common, type: kind, previousPlanId: id(params.previousPlanId, 'previous plan version'), reason: text(params.text, 'revision reason') };
        else if (kind === 'resolve-blocker') command = { ...common, type: kind, reason: text(params.text, 'resolution and evidence') };
        else if (kind === 'decide-finding') {
          const demand = this.store.getDemand(common.demandId), findingId = id(params.findingId, 'finding identifier'), contentId = id(params.contentId, 'content version');
          const finding = demand.findings.find(item => item.id === findingId);
          if (demand.activeContentId !== contentId || finding?.contentId !== contentId || finding.severity !== 'decision') throw new ProtocolError('STALE_FINDING', 'Decide only a user-decision finding on the exact current content.');
          command = { ...common, type: kind, findingId, reason: text(params.text, 'decision and reason') };
        } else if (kind === 'switch-method') {
          const stage = text(params.stage, 'method stage', 30) as Stage;
          if (!['planning', 'implementation', 'review'].includes(stage)) throw new ProtocolError('INVALID_STAGE', 'Select a supported stage.');
          const config = this.configuration.load();
          if (params.configurationDigest !== configurationDigest(config)) throw new ProtocolError('STALE_CONFIGURATION', 'Method configuration changed; review the current exact source.');
          const method = this.production.captureMethods(config)[stage];
          if (!method || method.id !== params.methodId || method.version !== params.methodVersion || method.digest !== params.methodDigest) throw new ProtocolError('METHOD_CHANGED', 'The configured method or dependency snapshot changed.');
          if (params.impactReviewed !== true) throw new ProtocolError('IMPACT_UNREVIEWED', 'Review the impact of replacing the frozen stage method.');
          command = { ...common, type: kind, stage, method, impactReviewed: true, reason: text(params.text, 'method change reason') };
        }
        else command = { ...common, type: kind as 'start-planning' | 'pause' | 'resume' | 'cancel' };
        // Replays are checked against the original command hash by WorkflowService.
        // A receipt lookup must not turn a lost response into a new decision or
        // reject it merely because the already-authorized next stage has started.
        const planningReplay = PLANNING_COMMANDS.has(kind) && !!this.store.db.prepare('SELECT 1 FROM domain_receipts WHERE key=?').get(`user:${this.#user.userId}:${common.requestId}`);
        if ((!planningReplay && PLANNING_COMMANDS.has(kind)) || ['revise-plan', 'resolve-blocker', 'switch-method', 'decide-finding'].includes(kind)) {
          if (this.coordinator.supervisor.list().some(run => run.demandId === common.demandId && run.state !== 'stopped')) throw new ProtocolError('RUNTIME_OCCUPIED', 'Verify the complete native execution tree has stopped before this decision.');
          if (this.store.getDemand(common.demandId).activeResultId) throw new ProtocolError('RESULT_PROTECTED', 'Return the exact submitted result before changing its decisions.');
        }
        if (kind === 'accept-result') {
          const demand = this.store.getDemand(common.demandId), result = demand.results.find(result => result.id === params.resultId);
          if (result && (!this.production.evidence.stable(demand.id, result.K) || result.N.some(ref => { try { this.production.evidence.read(demand.id, ref); return false; } catch { return true; } }))) {
            this.workflow.invalidateCurrentContent(demand.id, 'The actual source or local material differs from this immutable result.');
            throw new ProtocolError('RESULT_CHANGED', 'Result content changed after verification. Recheck before acceptance.');
          }
        }
        this.workflow.execute(command, this.#user);
        if (localAuthor && kind === 'authorize-implementation') this.store.db.prepare('INSERT INTO host_local_commit_authorities VALUES(?,?,?,?) ON CONFLICT(demand_id,plan_id) DO UPDATE SET request_id=excluded.request_id,author_json=excluded.author_json').run(common.demandId,String(params.planId),common.requestId,JSON.stringify(localAuthor));
        if (kind === 'start-planning' || kind === 'resume') {
          const demand = this.store.getDemand(common.demandId), base = this.store.db.prepare('SELECT baseline FROM host_project_baselines WHERE project_id=?').get(demand.projectId);
          if (base) this.production.prepareDemand(demand.id, base.baseline === null ? null : String(base.baseline));
        }
        break;
      }
      case 'sendMessage': {
        const demandId = id(params.demandId), requestId = id(params.requestId);
        this.workflow.execute({ type: 'message', requestId, demandId, messageId: requestId, text: text(params.text, 'message'), kind: 'information' }, this.#user);
        break;
      }
      default: throw new ProtocolError('UNKNOWN_METHOD', 'Unsupported desktop method.');
    }
    const snapshot = this.snapshot();
    return selected ? { ...snapshot, selected } : snapshot;
  }
  /** Explicit exit persists stop intent. Do not claim actual stopping here. */
  shutdown(): { safe: boolean; blockers: string[] } {
    for (const d of this.store.listDemands()) {
      if (d.control === 'active' && d.planningStarted && !['accepted', 'awaiting-acceptance'].includes(d.phase)) this.workflow.execute({ type: 'exit', requestId: `exit-${d.id}-${d.revision}`, demandId: d.id, expectedRevision: d.revision }, this.#user);
    }
    const remaining = this.store.listRuns().filter(r => r.status !== 'stopped');
    const actual = this.coordinator.supervisor.list().filter(run => run.state !== 'stopped');
    const auxiliary = this.production.auxiliaryStatus();
    return { safe: remaining.length === 0 && actual.length === 0 && auxiliary.safe, blockers: [...new Set([...remaining.map(r => `${r.demandId}: ${r.status}`), ...actual.map(run => `${run.demandId} / ${run.role}: ${run.state}`), ...auxiliary.blockers])] };
  }
  async requestShutdown(): Promise<{ safe: boolean; blockers: string[] }> {
    this.#closing = true;
    this.shutdown();
    await this.production.stopAllAuxiliary('explicit-exit');
    await this.coordinator.flushStops();
    await this.coordinator.observeCompletedRuns();
    return this.shutdown();
  }
  readArtifact(input: unknown) {
    const params = record(input), demandId = id(params.demandId), artifactId = id(params.artifactId, 'artifact identifier');
    this.store.getDemand(demandId);
    const ref = this.production.evidence.reference(demandId, artifactId);
    if (ref.digest !== text(params.digest, 'artifact digest', 64)) throw new ProtocolError('ARTIFACT_CHANGED', 'Read the exact immutable artifact revision selected on screen.');
    const material = this.production.evidence.read(demandId, ref), offset = params.offset ?? 0;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > material.content.length) throw new ProtocolError('INVALID_OFFSET', 'Artifact page offset is outside the exact content.');
    const start = Number(offset), end = Math.min(start + 16_384, material.content.length);
    return { id: ref.id, digest: ref.digest, kind: material.kind, text: material.content.slice(start, end), totalCharacters: material.content.length, offset: start, nextOffset: end < material.content.length ? end : null };
  }
  async knowledgeAction(input: unknown): Promise<ViewState> {
    if (this.#closing) throw new ProtocolError('APP_STOPPING', 'Application exit is in progress.');
    await this.knowledgeLifecycle.handle(input);
    return this.snapshot();
  }
  async tick(): Promise<void> { await this.production.tick(); this.knowledgeLifecycle.captureResults(); }
  close(): void { this.store.close(); if (this.#temporaryConfiguration) rmSync(this.#temporaryConfiguration, { recursive: true, force: true }); }
}
