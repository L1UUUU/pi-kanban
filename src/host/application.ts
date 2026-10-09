import { basename, resolve } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { WorkflowService, WorkbenchStore } from '../domain/index.ts';
import type { Demand, UserCommand } from '../domain/types.ts';
import type { ViewState, DemandView } from '../desktop/renderer/types.ts';
import { COMMANDS, ProtocolError, id, record, revision, text } from './protocol.ts';
import { WindowsCandidateDriver } from '../runtime/windows-driver.ts';
import { ModelBudgetLedger } from '../runtime/budget.ts';
import { WorkspaceService, ImmutableObjectStore } from '../workspace/index.ts';
import { KnowledgeService } from '../knowledge/index.ts';
import { ExecutionCoordinator } from './coordinator.ts';

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
  #workspace?: WorkspaceService;
  #closing = false;
  #user;
  constructor(databasePath = ':memory:') {
    this.store = new WorkbenchStore(databasePath);
    this.workflow = new WorkflowService(this.store);
    this.#user = this.workflow.trustedUser('local-desktop-owner');
    this.store.db.exec('CREATE TABLE IF NOT EXISTS host_snapshot_sequence(singleton INTEGER PRIMARY KEY CHECK(singleton=1), value INTEGER NOT NULL); INSERT OR IGNORE INTO host_snapshot_sequence VALUES(1,0)');
    this.knowledge = new KnowledgeService({ db: this.store.db, resolveStore: projectId => {
      const project = this.workspace.getProject(projectId);
      return ImmutableObjectStore.open(project.anchorPath, projectId);
    } });
    this.budget = new ModelBudgetLedger(this.store.db, () => { throw new ProtocolError('MODEL_AUTHORIZATION_MISSING', 'No trusted model/data/spend approval adapter has been configured.'); });
    this.coordinator = new ExecutionCoordinator(this.store, this.workflow, new WindowsCandidateDriver(), {
      inspect: () => ({ profileVerified: false, budgetAvailable: false, workspaceVerified: false, blockers: EXECUTION_BLOCKERS }),
      launchFor: () => { throw new ProtocolError('ISOLATION_UNVERIFIED', 'No verified launch descriptor is available.'); },
      verifyWorkspaceAfterStop: () => false,
      verifyReport: () => { throw new ProtocolError('WORKER_CHANNEL_UNAVAILABLE', 'No verified private Worker channel is connected.'); },
    });
  }
  /** Host-only lazy service: absent Windows Git configuration does not prevent
   * users recording ideas. It blocks only repository preparation/execution. */
  get workspace(): WorkspaceService {
    return this.#workspace ??= new WorkspaceService({ db: this.store.db, gitExecutable: process.env.PI_KANBAN_GIT });
  }
  snapshot(): ViewState {
    this.store.db.prepare('UPDATE host_snapshot_sequence SET value=value+1 WHERE singleton=1').run();
    return {
      sequence: Number(this.store.db.prepare('SELECT value FROM host_snapshot_sequence WHERE singleton=1').get()!.value),
      projects: this.store.listProjects().map(p => ({ id: p.id, name: p.name, rootPath: p.rootPath })),
      demands: this.store.listDemands().map(d => this.#view(d)),
      runtime: { platform: process.platform, node: process.version, executionEnabled: false, blockers: [...EXECUTION_BLOCKERS], connection: 'connected' },
    };
  }
  #view(d: Demand): DemandView {
    const plan = d.plans.find(p => p.id === d.activePlanId);
    const result = d.results.find(r => r.id === d.activeResultId);
    const runs = this.store.listRuns(d.id);
    const run = runs.at(-1);
    return {
      id: d.id, projectId: d.projectId, title: d.title, description: d.description, version: d.revision, phase: d.phase, control: d.control,
      plan: plan ? { id: plan.id, scope: plan.scope, ready: plan.ready, confirmed: d.confirmedPlanId === plan.id, specPath: plan.spec.location, requiredChecks: plan.requiredChecks.map(c => c.name) } : undefined,
      result: result ? { id: result.id, contentId: result.contentId, notes: result.notes, createdAt: result.createdAt, codeRef: result.K.location, knowledgeRefs: result.N.map(n => n.id), accepted: d.acceptances.some(a => a.resultId === result.id && a.decision === 'accepted') } : undefined,
      blockers: [...d.blockedReasons, ...(d.planningStarted && d.control === 'active' && !result ? EXECUTION_BLOCKERS : [])],
      activities: this.store.history(d.id).slice(-200).map((h, index) => ({ id: `${d.id}-${index}`, kind: 'workflow', title: h.kind, timestamp: h.createdAt, status: 'complete' })),
      messages: d.messages.map(m => ({ id: m.id, role: 'user', text: m.text, state: m.state })),
      checks: d.checks.map(c => ({ id: c.id, name: plan?.requiredChecks.find(r => r.id === c.requirementId)?.name ?? c.requirementId, status: c.status, evidence: c.evidence.location, contentId: c.contentId })),
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
        if (this.store.listProjects().some(p => p.rootPath === realPath)) throw new ProtocolError('PROJECT_EXISTS', 'This project is already connected.');
        this.workflow.createProject({ name: basename(realPath), rootPath: realPath });
        break;
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
        if (kind === 'confirm-plan' || kind === 'authorize-implementation') command = { ...common, type: kind, planId: id(params.planId, 'plan version') };
        else if (kind === 'accept-result') command = { ...common, type: kind, resultId: id(params.resultId, 'result version') };
        else if (kind === 'return-result') command = { ...common, type: kind, resultId: id(params.resultId, 'result version'), reason: text(params.text, 'return reason') };
        else command = { ...common, type: kind as 'start-planning' | 'pause' | 'resume' | 'cancel' };
        this.workflow.execute(command, this.#user);
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
    return { safe: remaining.length === 0, blockers: remaining.map(r => `${r.demandId}: ${r.status}`) };
  }
  async requestShutdown(): Promise<{ safe: boolean; blockers: string[] }> {
    this.#closing = true;
    this.shutdown();
    await this.coordinator.flushStops();
    await this.coordinator.observeCompletedRuns();
    return this.shutdown();
  }
  close(): void { this.store.close(); }
}
