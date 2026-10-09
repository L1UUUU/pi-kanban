import type { WorkflowService, WorkbenchStore } from '../domain/index.ts';
import type { RunAttempt, WorkerReport, ReportVerification, Receipt } from '../domain/types.ts';
import { RuntimeSupervisor } from '../runtime/supervisor.ts';
import type { RuntimeDriver, LaunchRequest, RuntimeRole } from '../runtime/types.ts';
import { ModelBudgetLedger } from '../runtime/budget.ts';

/** Implementations are trusted Host adapters backed by observed facts. Never map
 * renderer/Worker JSON directly into these prerequisites or verifications. */
export interface ExecutionPrerequisites {
  /** Host-selected read-only planning delegates remain separate domain attempts. */
  runtimeRoleFor?(run: RunAttempt): RuntimeRole;
  inspect(demandId: string): { profileVerified: boolean; budgetAvailable: boolean; workspaceVerified: boolean; blockers: string[] };
  launchFor(run: RunAttempt): Omit<LaunchRequest, 'demandId' | 'grantId' | 'role' | 'writes' | 'highResource'>;
  verifyWorkspaceAfterStop(demandId: string): boolean;
  verifyReport(report: WorkerReport, run: RunAttempt): ReportVerification;
  /** Keep domain ownership until the Host finishes applying a stopped handoff. */
  settlementPending?(run: RunAttempt): boolean;
  classifyExit?(run: RunAttempt): { outcome: 'handoff' | 'safe-retry' | 'unknown'; evidence: string };
}

/** Joins F's durable outbox to R's actual process observations. A runtime row
 * carries the domain run ID as grantId so a crash before binding can be repaired.
 * Default product wiring supplies denied prerequisites; deterministic tests use
 * the same coordinator with explicitly synthetic driver and facts. */
export class ExecutionCoordinator {
  readonly supervisor: RuntimeSupervisor;
  #workflow: WorkflowService;
  #store: WorkbenchStore;
  #prerequisites: ExecutionPrerequisites;
  #ticking = false;
  #limits: ModelBudgetLedger;
  constructor(store: WorkbenchStore, workflow: WorkflowService, driver: RuntimeDriver, prerequisites: ExecutionPrerequisites) {
    this.#store = store; this.#workflow = workflow; this.#prerequisites = prerequisites;
    store.db.exec('CREATE TABLE IF NOT EXISTS host_run_bindings(domain_run_id TEXT PRIMARY KEY, runtime_run_id TEXT UNIQUE, status TEXT NOT NULL)');
    store.db.exec('CREATE TABLE IF NOT EXISTS host_run_operation_keys(run_id TEXT PRIMARY KEY, operation_key TEXT NOT NULL)');
    store.db.exec('CREATE TABLE IF NOT EXISTS host_exit_classifications(run_id TEXT PRIMARY KEY, outcome TEXT NOT NULL, evidence TEXT NOT NULL)');
    this.#limits = new ModelBudgetLedger(store.db, () => { throw new Error('The coordinator cannot grant model spend.'); });
    this.supervisor = new RuntimeSupervisor(store.db, driver, request => {
      const run = store.getRun(request.grantId), demand = store.getDemand(run.demandId);
      if (request.demandId !== run.demandId || request.role !== (prerequisites.runtimeRoleFor?.(run) ?? run.stage) || request.writes !== run.writer || run.status !== 'starting' || demand.control !== 'active') throw new Error('Launch no longer matches the current authorized domain run.');
      const facts = prerequisites.inspect(run.demandId);
      if (!facts.profileVerified || !facts.budgetAvailable || !facts.workspaceVerified) throw new Error(facts.blockers.join('; ') || 'Execution prerequisites changed.');
    });
  }
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      await this.observeCompletedRuns();
      await this.flushStops();
      for (const demand of this.#store.listDemands()) {
        const facts = this.#prerequisites.inspect(demand.id);
        if (!facts.profileVerified || !facts.budgetAvailable || !facts.workspaceVerified || demand.control !== 'active') continue;
        const run = this.#workflow.claimNextRun({ ...facts, demandId: demand.id });
        if (!run) continue;
        try { this.#limits.chargeSafeAttempt(this.operationKey(run), 'not-started'); }
        catch (error) {
          this.#workflow.blockDemand(run.demandId, 'RETRY_LIMIT', String(error));
          // This is known-not-started: no runtime launch invocation has happened.
          this.#workflow.confirmStopped(run.id, { processAbsent: true, descendantsAbsent: true, workspaceVerified: true, evidence: 'Host rejected finite attempt limit before invoking any launcher.' });
          continue;
        }
        this.#store.db.prepare("INSERT INTO host_run_bindings VALUES(?,NULL,'launch-intent')").run(run.id);
        try {
          const launched = await this.supervisor.launch({ ...this.#prerequisites.launchFor(run), demandId: run.demandId, grantId: run.id, role: this.#prerequisites.runtimeRoleFor?.(run) ?? run.stage, writes: run.writer, highResource: run.highResource });
          this.#store.db.prepare("UPDATE host_run_bindings SET runtime_run_id=?,status='bound' WHERE domain_run_id=?").run(launched.runId, run.id);
          // Pause arriving during async creation must win over late registration.
          const current = this.#store.getRun(run.id);
          if (current.status === 'starting' && this.#store.getDemand(run.demandId).control === 'active' && launched.state === 'running') this.#workflow.markRunning(run.id, JSON.stringify(launched.identity));
          else await this.stopDomainRun(run.id, 'control-changed-during-launch');
        } catch (error) {
          const runtime = this.supervisor.list().find(r => r.grantId === run.id);
          if (runtime) this.#store.db.prepare("UPDATE host_run_bindings SET runtime_run_id=?,status='unresolved' WHERE domain_run_id=?").run(runtime.runId, run.id);
          this.#workflow.markInterrupted(run.id, `Launch requires reconciliation: ${String(error)}`);
        }
      }
    } finally { this.#ticking = false; }
  }
  /** Called only for a message received on a launch-bound private Worker channel.
   * The bound run ID comes from that channel, never from the incoming payload. */
  report(boundRunId: string, report: WorkerReport): Receipt {
    const run = this.#store.getRun(boundRunId);
    if (report.runId !== boundRunId || report.demandId !== run.demandId || report.generation !== run.generation) throw new Error('Worker channel identity mismatch.');
    const binding = this.#store.db.prepare('SELECT runtime_run_id FROM host_run_bindings WHERE domain_run_id=?').get(boundRunId);
    if (!binding?.runtime_run_id || this.supervisor.get(String(binding.runtime_run_id)).grantId !== boundRunId) throw new Error('Worker channel has no matching launched generation.');
    // Authenticated late evidence can still be saved. Domain revision/generation
    // rules determine historical applicability; pause still blocks new dispatch.
    return this.#workflow.report(report, this.#workflow.workerContext(boundRunId), this.#prerequisites.verifyReport(report, run));
  }
  async observeCompletedRuns(): Promise<void> {
    for (const run of this.#store.listRuns().filter(run => run.status !== 'stopped')) {
      if (this.#prerequisites.settlementPending?.(run)) continue;
      const runtime = this.supervisor.list().find(candidate => candidate.grantId === run.id);
      if (!runtime) continue;
      const observed = runtime.state === 'stopped' ? runtime : await this.supervisor.observe(runtime.runId);
      if (this.#prerequisites.settlementPending?.(run)) continue;
      if (observed.state === 'stopped' && observed.evidence && this.#prerequisites.verifyWorkspaceAfterStop(run.demandId)) {
        this.classifyStoppedRun(run);
        this.#workflow.confirmStopped(run.id, { processAbsent: true, descendantsAbsent: true, workspaceVerified: true, evidence: observed.evidence });
        this.#store.db.prepare("UPDATE host_run_bindings SET status='stopped' WHERE domain_run_id=?").run(run.id);
      }
    }
  }
  private operationKey(run: RunAttempt): string {
    const saved = this.#store.db.prepare('SELECT operation_key FROM host_run_operation_keys WHERE run_id=?').get(run.id);
    if (saved) return String(saved.operation_key);
    // Explicitly returning a submitted result or revising an exact plan starts
    // a new user-requested operation. Clearing a blocker/resuming never resets
    // the retry budget for an unchanged operation. Freeze this key per run.
    const demand = this.#store.getDemand(run.demandId);
    const returns = demand.acceptances.filter(item => item.decision === 'returned').length;
    const revisions = this.#store.history(run.demandId).filter(item => item.kind === 'user-command' && (item.data as { command?: { type?: string } }).command?.type === 'revise-plan').length;
    const planning = run.planningStep ? `:planning-${run.planningFlowId}:${run.planningRevision}:${run.planningStep}` : '';
    // Distinct execution axes/tickets have distinct operations. Input-only
    // revisions (pause/resume or a blocker clarification) never replenish one.
    const execution = run.executionStep ? `:flow-${run.executionFlowId}:${run.executionStep}:${run.executionScope}:${run.executionTicketId ?? 'whole'}` : '';
    const key = `execution:${run.demandId}:${run.stage}:returns-${returns}:revisions-${revisions}:${run.planId ?? 'initial'}:${run.contentId ?? 'work'}${planning}${execution}`;
    this.#store.db.prepare('INSERT INTO host_run_operation_keys VALUES(?,?)').run(run.id, key);
    return key;
  }
  private classifyStoppedRun(run: RunAttempt): void {
    if (this.#store.db.prepare('SELECT 1 FROM host_exit_classifications WHERE run_id=?').get(run.id)) return;
    const demand = this.#store.getDemand(run.demandId);
    if (demand.control !== 'active' || demand.blockedReasons.length) return; // User stop is not a failed cycle. An interruption explanation is not user intent.
    const result = this.#prerequisites.classifyExit?.(run) ?? { outcome: 'unknown' as const, evidence: 'No trusted terminal-handoff verifier is available.' };
    if (!result.evidence) throw new Error('Terminal outcome needs observed evidence.');
    if (result.outcome === 'unknown') this.#workflow.blockDemand(run.demandId, 'HANDOFF_UNVERIFIED', result.evidence);
    else {
      try { this.#limits.recordCycle(run.demandId, this.operationKey(run), result.outcome === 'handoff' ? 'verified-progress' : 'no-progress', result.evidence); }
      catch (error) { this.#workflow.blockDemand(run.demandId, 'NO_PROGRESS_LIMIT', String(error)); }
    }
    this.#store.db.prepare('INSERT INTO host_exit_classifications VALUES(?,?,?)').run(run.id, result.outcome, result.evidence);
  }
  async flushStops(): Promise<void> {
    for (const item of this.#store.outbox('pending').filter(item => item.kind === 'stop-run')) {
      const runId = typeof item.payload.runId === 'string' ? item.payload.runId : undefined;
      if (!runId) continue;
      if (await this.stopDomainRun(runId, 'durable-user-stop')) this.#workflow.acknowledgeOutbox(item.id);
    }
  }
  async stopDomainRun(domainRunId: string, reason: string): Promise<boolean> {
    const runtime = this.supervisor.list().find(r => r.grantId === domainRunId);
    if (!runtime) return false; // No identity is not proof that creation never happened.
    const result = await this.supervisor.stop(runtime.runId, reason);
    if (result.state !== 'stopped' || !result.evidence || !this.#prerequisites.verifyWorkspaceAfterStop(result.demandId)) return false;
    this.#workflow.confirmStopped(domainRunId, { processAbsent: true, descendantsAbsent: true, workspaceVerified: true, evidence: result.evidence });
    this.#store.db.prepare("UPDATE host_run_bindings SET status='stopped' WHERE domain_run_id=?").run(domainRunId);
    return true;
  }
  async recover(): Promise<void> {
    const runtimeRuns = await this.supervisor.recover();
    for (const run of this.#store.listRuns().filter(run => run.status !== 'stopped')) {
      const runtime = runtimeRuns.find(r => r.grantId === run.id);
      if (!runtime) { this.#workflow.markInterrupted(run.id, 'No matched runtime generation; ownership remains occupied.'); continue; }
      this.#store.db.prepare("INSERT INTO host_run_bindings VALUES(?,?,'reconciled') ON CONFLICT(domain_run_id) DO UPDATE SET runtime_run_id=excluded.runtime_run_id,status=excluded.status").run(run.id, runtime.runId);
      if (runtime.state === 'stopped' && runtime.evidence && this.#prerequisites.verifyWorkspaceAfterStop(run.demandId)) {
        this.classifyStoppedRun(run);
        this.#workflow.confirmStopped(run.id, { processAbsent: true, descendantsAbsent: true, workspaceVerified: true, evidence: runtime.evidence });
      }
      else this.#workflow.markInterrupted(run.id, 'Existing execution requires verified reconnection; no replacement writer launched.');
    }
    await this.flushStops();
  }
}
