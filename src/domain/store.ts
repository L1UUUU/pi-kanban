import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { Demand, OutboxItem, Project, RunAttempt } from './types.ts';

export class DomainError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = 'DomainError'; this.code = code; }
}
export function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new DomainError(code, message);
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value as object).sort().filter(k => (value as any)[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical((value as any)[k])).join(',') + '}';
}
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }

/** Single-host SQLite store. Exposes db for trusted adapter tables and atomic work.
 * Worker processes must never receive this handle or database file access.
 * WAL + FULL improve local durability; they do not prove power-loss or file/Git atomicity. */
export class WorkbenchStore {
  readonly db: DatabaseSync;
  #inTransaction = false;
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS domain_projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS domain_demands (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES domain_projects(id), revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS domain_runs (id TEXT PRIMARY KEY, demand_id TEXT NOT NULL REFERENCES domain_demands(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS domain_receipts (key TEXT PRIMARY KEY, hash TEXT NOT NULL, receipt TEXT NOT NULL, request TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS domain_conflicts (id INTEGER PRIMARY KEY, key TEXT NOT NULL, original_hash TEXT NOT NULL, incoming_hash TEXT NOT NULL, request TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS domain_history (id INTEGER PRIMARY KEY, demand_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS domain_outbox (id INTEGER PRIMARY KEY, business_key TEXT UNIQUE NOT NULL, demand_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL);
    `);
  }
  transaction<T>(work: () => T): T {
    invariant(!this.#inTransaction, 'NESTED_TRANSACTION', 'Use the existing transaction; nested domain transactions are unsupported.');
    this.db.exec('BEGIN IMMEDIATE'); this.#inTransaction = true;
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.#inTransaction = false; }
  }
  close(): void { this.db.close(); }
  getProject(id: string): Project {
    const row = this.db.prepare('SELECT data FROM domain_projects WHERE id = ?').get(id);
    invariant(row, 'NOT_FOUND', `Project ${id} does not exist.`); return JSON.parse(row.data as string);
  }
  listProjects(): Project[] { return this.db.prepare('SELECT data FROM domain_projects ORDER BY rowid').all().map(r => JSON.parse(r.data as string)); }
  saveProject(project: Project): void { this.db.prepare('INSERT INTO domain_projects(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(project.id, JSON.stringify(project)); }
  getDemand(id: string): Demand {
    const row = this.db.prepare('SELECT data FROM domain_demands WHERE id = ?').get(id);
    invariant(row, 'NOT_FOUND', `Demand ${id} does not exist.`); return JSON.parse(row.data as string);
  }
  listDemands(projectId?: string): Demand[] {
    const rows = projectId ? this.db.prepare('SELECT data FROM domain_demands WHERE project_id = ? ORDER BY rowid').all(projectId) : this.db.prepare('SELECT data FROM domain_demands ORDER BY rowid').all();
    return rows.map(r => JSON.parse(r.data as string));
  }
  saveDemand(demand: Demand): void { this.db.prepare('INSERT INTO domain_demands(id,project_id,revision,data) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data').run(demand.id, demand.projectId, demand.revision, JSON.stringify(demand)); }
  getRun(id: string): RunAttempt {
    const row = this.db.prepare('SELECT data FROM domain_runs WHERE id = ?').get(id);
    invariant(row, 'NOT_FOUND', `Run ${id} does not exist.`); return JSON.parse(row.data as string);
  }
  listRuns(demandId?: string): RunAttempt[] {
    const rows = demandId ? this.db.prepare('SELECT data FROM domain_runs WHERE demand_id = ? ORDER BY rowid').all(demandId) : this.db.prepare('SELECT data FROM domain_runs ORDER BY rowid').all();
    return rows.map(r => JSON.parse(r.data as string));
  }
  saveRun(run: RunAttempt): void { this.db.prepare('INSERT INTO domain_runs(id,demand_id,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(run.id,run.demandId,JSON.stringify(run)); }
  outbox(status?: 'pending' | 'done'): OutboxItem[] {
    const rows = status ? this.db.prepare('SELECT * FROM domain_outbox WHERE status = ? ORDER BY id').all(status) : this.db.prepare('SELECT * FROM domain_outbox ORDER BY id').all();
    return rows.map(r => ({ id: Number(r.id), businessKey: r.business_key as string, demandId: r.demand_id as string, kind: r.kind as OutboxItem['kind'], payload: JSON.parse(r.payload as string), status: r.status as OutboxItem['status'], createdAt: r.created_at as string }));
  }
  history(demandId: string): { kind: string; data: unknown; createdAt: string }[] { return this.db.prepare('SELECT * FROM domain_history WHERE demand_id = ? ORDER BY id').all(demandId).map(r => ({kind:r.kind as string,data:JSON.parse(r.data as string),createdAt:r.created_at as string})); }
}
