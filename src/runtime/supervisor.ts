import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { RuntimeError } from './types.ts';
import type { LaunchRequest, Observation, RunRecord, RuntimeDriver } from './types.ts';

const active = "state <> 'stopped'";
const roles = new Set(['planning', 'implementation', 'review', 'boundary-review', 'check']);
function now() { return new Date().toISOString(); }
export class RuntimeSupervisor {
  private db: DatabaseSync;
  private driver: RuntimeDriver;
  private authorize: (request: LaunchRequest) => void;
  private stopping = new Map<string, Promise<RunRecord>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(db: DatabaseSync, driver: RuntimeDriver, authorize: (request: LaunchRequest) => void) {
    this.db = db; this.driver = driver; this.authorize = authorize;
    driver.setStopHandler?.(async (runId, reason) => { await this.stop(runId, reason); });
    db.exec(`CREATE TABLE IF NOT EXISTS runtime_runs (
      run_id TEXT PRIMARY KEY, demand_id TEXT NOT NULL, generation TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL, writes INTEGER NOT NULL, high_resource INTEGER NOT NULL,
      request_json TEXT NOT NULL, identity_json TEXT, stop_reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, evidence TEXT
    ); CREATE UNIQUE INDEX IF NOT EXISTS runtime_single_writer ON runtime_runs(demand_id)
      WHERE writes = 1 AND state <> 'stopped';
    CREATE TABLE IF NOT EXISTS runtime_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
      event TEXT NOT NULL, detail TEXT NOT NULL, occurred_at TEXT NOT NULL
    );`);
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private event(runId: string, event: string, detail: string) {
    this.db.prepare('INSERT INTO runtime_events(run_id,event,detail,occurred_at) VALUES(?,?,?,?)').run(runId,event,detail,now());
  }
  get(runId: string): RunRecord {
    const row = this.db.prepare('SELECT * FROM runtime_runs WHERE run_id=?').get(runId) as Record<string, string> | undefined;
    if (!row) throw new RuntimeError('RUN_NOT_FOUND', 'Unknown run');
    return { ...JSON.parse(row.request_json), runId: row.run_id, generation: row.generation,
      state: row.state, identity: row.identity_json ? JSON.parse(row.identity_json) : null,
      stopReason: row.stop_reason, createdAt: row.created_at, updatedAt: row.updated_at, evidence: row.evidence };
  }
  list(): RunRecord[] {
    return (this.db.prepare('SELECT run_id FROM runtime_runs ORDER BY created_at,run_id').all() as {run_id:string}[]).map(x => this.get(x.run_id));
  }
  private setState(runId: string, state: string, evidence: string | null = null) {
    this.db.prepare('UPDATE runtime_runs SET state=?,updated_at=?,evidence=? WHERE run_id=?').run(state,now(),evidence,runId);
    this.event(runId,state,evidence ?? '');
  }
  async launch(request: LaunchRequest): Promise<RunRecord> {
    if (!roles.has(request.role) || (request.writes && request.role !== 'implementation'))
      throw new RuntimeError('ROLE_DENIED', 'Only implementation may hold a source writer lease');
    for (const value of [request.demandId,request.grantId,request.workspace,request.profileId])
      if (typeof value !== 'string' || !value.trim()) throw new RuntimeError('INVALID_LAUNCH', 'Missing launch identity');
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 2_147_483_647 ||
        !Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1)
      throw new RuntimeError('FINITE_POLICY_REQUIRED', 'Finite process timeout and output limit are required');
    this.authorize(request); // Same Host policy used by the UI; never a Worker supplied approval.
    this.driver.preflight(request);
    const runId = randomUUID(), generation = randomUUID(), date = now();
    this.transaction(() => {
      const demands = this.db.prepare(`SELECT DISTINCT demand_id FROM runtime_runs WHERE ${active}`).all() as {demand_id:string}[];
      if (!demands.some(x => x.demand_id === request.demandId) && demands.length >= 2)
        throw new RuntimeError('DEMAND_CAPACITY', 'Two demands already occupy the runtime');
      if (request.writes && this.db.prepare(`SELECT 1 FROM runtime_runs WHERE demand_id=? AND writes=1 AND ${active}`).get(request.demandId))
        throw new RuntimeError('WRITER_OCCUPIED', 'The previous writer has not been proven stopped');
      if (request.highResource && this.db.prepare(`SELECT 1 FROM runtime_runs WHERE high_resource=1 AND ${active}`).get())
        throw new RuntimeError('CHECK_CAPACITY', 'A high-resource check already occupies the runtime');
      this.db.prepare('INSERT INTO runtime_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(runId,request.demandId,generation,'launch_intent',request.writes?1:0,request.highResource?1:0,JSON.stringify(request),null,null,date,date,null);
      this.event(runId,'launch_intent','Recorded before process creation');
    });
    try {
      const identity = await this.driver.launch(this.get(runId));
      if (identity.generation !== generation || identity.driver !== this.driver.id || !Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !identity.birth || !identity.controlId)
        throw new RuntimeError('IDENTITY_MISMATCH','Launcher returned a mismatched process generation');
      this.transaction(() => {
        this.db.prepare('UPDATE runtime_runs SET identity_json=? WHERE run_id=?').run(JSON.stringify(identity),runId);
        if (this.get(runId).stopReason === null) this.setState(runId,'running');
      });
      if (this.get(runId).stopReason !== null) return await this.stop(runId,this.get(runId).stopReason!);
      const timer = setTimeout(() => { void this.stop(runId,'active-time-limit').catch(() => {}); },request.timeoutMs);
      timer.unref(); this.timers.set(runId,timer);
      return this.get(runId);
    } catch (error) {
      // Even a launch exception may happen after creation; never release the writer by guessing.
      this.transaction(() => this.setState(runId,'unknown',String(error)));
      throw error;
    }
  }
  async stop(runId: string, reason = 'user-stop'): Promise<RunRecord> {
    const before = this.get(runId);
    if (before.state === 'stopped') return before;
    this.transaction(() => {
      this.db.prepare('UPDATE runtime_runs SET stop_reason=COALESCE(stop_reason,?) WHERE run_id=?').run(reason,runId);
      this.setState(runId,'stop_requested','Dispatch and future model requests must consult this durable intention');
    });
    if (this.stopping.has(runId)) return this.stopping.get(runId)!;
    if (!this.get(runId).identity) return this.get(runId); // In-flight launch will finish the stop; recovery treats it as unknown.
    const pending = (async () => {
      this.transaction(() => this.setState(runId,'stopping'));
      try { this.applyObservation(runId,await this.driver.stop(this.get(runId))); }
      catch (error) { this.transaction(() => this.setState(runId,'unknown',String(error))); }
      return this.get(runId);
    })();
    this.stopping.set(runId,pending);
    try { return await pending; } finally { this.stopping.delete(runId); }
  }
  private applyObservation(runId: string, observation: Observation) {
    const run = this.get(runId);
    const proven = observation.generation === run.generation && observation.state === 'stopped' &&
      observation.activePids.length === 0 && observation.proof.trim().length > 0;
    this.transaction(() => this.setState(runId,proven?'stopped':'unknown',JSON.stringify(observation)));
    if (proven) { clearTimeout(this.timers.get(runId)); this.timers.delete(runId); }
  }
  /** Normal observation preserves a matching live generation; restart recovery is stricter. */
  async observe(runId: string): Promise<RunRecord> {
    const run = this.get(runId);
    if (run.state === 'stopped') return run;
    if (!run.identity) return run;
    try {
      const observation = await this.driver.observe(run);
      if (observation.state === 'stopped') this.applyObservation(runId, observation);
      else if (observation.state !== 'alive' || observation.generation !== run.generation)
        this.transaction(() => this.setState(runId, 'unknown', JSON.stringify(observation)));
    } catch (error) { this.transaction(() => this.setState(runId, 'unknown', String(error))); }
    return this.get(runId);
  }
  /** Observation only. Recovery never starts/resumes work or clears usage. */
  async recover(): Promise<RunRecord[]> {
    for (const run of this.list().filter(x => x.state !== 'stopped')) {
      if (!run.identity) { this.transaction(() => this.setState(run.runId,'unknown','Launch may have occurred before registration')); continue; }
      try {
        const observation = await this.driver.observe(run);
        if (observation.state === 'stopped') this.applyObservation(run.runId,observation);
        else if (observation.state === 'alive' && observation.generation === run.generation && run.stopReason)
          await this.stop(run.runId,run.stopReason);
        else this.transaction(() => this.setState(run.runId,'unknown','Recovery requires explicit reconciliation; no automatic resume. '+JSON.stringify(observation)));
      } catch (error) { this.transaction(() => this.setState(run.runId,'unknown',String(error))); }
    }
    return this.list();
  }
  isDispatchAllowed(runId: string): boolean {
    const run = this.get(runId); return run.state === 'running' && run.stopReason === null;
  }
  async stopAll(reason = 'explicit-exit'): Promise<RunRecord[]> {
    const ids = this.list().filter(x => x.state !== 'stopped').map(x => x.runId);
    // stop() persists synchronously before its first await; all intentions precede waiting.
    return Promise.all(ids.map(id => this.stop(id,reason)));
  }
}
