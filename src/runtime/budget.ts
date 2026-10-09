import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { RuntimeError } from './types.ts';

export interface ModelGrant {
  id: string; demandId: string; decisionId: string; provider: string; modelId: string;
  destination: string; credentialRef: string; data: { id: string; sha256: string }[];
  allowedRoles: string[]; maxRequests: number; maxTokens: number; maxCostMicros: number;
  currency: string; expiresAt: string; meteringPolicy: string;
  contextPolicy?: 'exact-materials-only' | 'approved-run-derived-v1';
}
export interface ReservationRequest {
  id: string; grantId: string; runId: string; role: string; purpose: 'prompt' | 'retry' | 'compaction' | 'auxiliary';
  provider: string; modelId: string; destination: string; data: {id:string;sha256:string}[];
  reserveTokens: number; reserveCostMicros: number;
}
export interface UsageReport {
  reportId: string; requestId: string; tokens: number; costMicros: number;
  final: boolean; source: string;
}
function hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function integer(value: number, label: string, positive = false) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new RuntimeError('FINITE_BUDGET_REQUIRED',`${label} must be a finite safe integer`);
}
function target(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new RuntimeError('DESTINATION_DENIED','Invalid destination'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.href !== value)
    throw new RuntimeError('DESTINATION_DENIED','Exact canonical HTTPS endpoint required; no credentials, query, or fragment');
}
export class ModelBudgetLedger {
  private db: DatabaseSync;
  private authorizeGrant: (grant: ModelGrant) => void;
  constructor(db: DatabaseSync, authorizeGrant: (grant: ModelGrant) => void) {
    this.db=db; this.authorizeGrant=authorizeGrant;
    db.exec(`CREATE TABLE IF NOT EXISTS model_grants(id TEXT PRIMARY KEY,demand_id TEXT NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL,blocked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS model_material_permissions(grant_id TEXT NOT NULL,material_id TEXT NOT NULL,sha256 TEXT NOT NULL,decision_id TEXT NOT NULL,PRIMARY KEY(grant_id,material_id,sha256));
      CREATE TABLE IF NOT EXISTS model_reservations(id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL,status TEXT NOT NULL,
        reserved_tokens INTEGER NOT NULL,reserved_cost INTEGER NOT NULL,observed_tokens INTEGER NOT NULL DEFAULT 0,observed_cost INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS model_usage_reports(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_budget_additions(id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,decision_id TEXT NOT NULL,requests INTEGER NOT NULL,tokens INTEGER NOT NULL,cost INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_retry_counts(operation_id TEXT PRIMARY KEY,attempts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_progress(demand_id TEXT NOT NULL,issue_id TEXT NOT NULL,cycles INTEGER NOT NULL,evidence TEXT,PRIMARY KEY(demand_id,issue_id));`);
  }
  private tx<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=work();this.db.exec('COMMIT');return result; }
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  grant(grant: ModelGrant): ModelGrant {
    this.authorizeGrant(grant);
    for (const key of ['id','demandId','decisionId','provider','modelId','credentialRef','meteringPolicy'] as const)
      if (typeof grant[key] !== 'string' || !grant[key].trim()) throw new RuntimeError('MODEL_CONFIG_MISSING',`${key} is required`);
    target(grant.destination);
    integer(grant.maxRequests,'requests',true);integer(grant.maxTokens,'tokens',true);integer(grant.maxCostMicros,'cost',true);
    if (!/^[A-Z]{3}$/.test(grant.currency) || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now())
      throw new RuntimeError('FINITE_BUDGET_REQUIRED','Currency and future expiration required');
    if (!Array.isArray(grant.allowedRoles) || !grant.allowedRoles.length || !grant.data.length || grant.data.some(x=>!x.id || !/^[a-f0-9]{64}$/.test(x.sha256)))
      throw new RuntimeError('DATA_PERMISSION_MISSING','Explicit role and immutable data allowlist required');
    const duplicate=this.db.prepare('SELECT digest FROM model_grants WHERE id=?').get(grant.id) as {digest:string}|undefined;
    if(duplicate){if(duplicate.digest!==hash(grant))throw new RuntimeError('IDEMPOTENCY_CONFLICT','Grant ID reused for different content');return this.getGrant(grant.id);}
    this.db.prepare('INSERT INTO model_grants(id,demand_id,body,digest) VALUES(?,?,?,?)').run(grant.id,grant.demandId,JSON.stringify(grant),hash(grant));
    return this.getGrant(grant.id);
  }
  getGrant(id:string):ModelGrant {
    const row=this.db.prepare('SELECT body FROM model_grants WHERE id=?').get(id) as {body:string}|undefined;
    if(!row)throw new RuntimeError('NO_MODEL_AUTHORIZATION','No model authorization');
    const grant=JSON.parse(row.body) as ModelGrant;
    const extra=this.db.prepare('SELECT material_id,sha256 FROM model_material_permissions WHERE grant_id=?').all(id) as {material_id:string;sha256:string}[];
    grant.data.push(...extra.filter(x=>!grant.data.some(d=>d.id===x.material_id&&d.sha256===x.sha256)).map(x=>({id:x.material_id,sha256:x.sha256})));
    return grant;
  }
  /** Host-only registration under existing bounded data permission. It never creates spending authority. */
  authorizeData(input:{grantId:string;decisionId:string;material:{id:string;sha256:string}}, authorize:(value:typeof input)=>void) {
    authorize(input);const grant=this.getGrant(input.grantId);
    if(grant.contextPolicy!=='approved-run-derived-v1'&&!grant.data.some(x=>x.id===input.material.id&&x.sha256===input.material.sha256))throw new RuntimeError('DERIVED_CONTEXT_DENIED','Grant permits exact materials only; derived session/tool context is not authorized');
    if(!input.decisionId||!input.material.id||!/^[a-f0-9]{64}$/.test(input.material.sha256))throw new RuntimeError('DATA_PERMISSION_MISSING','Immutable material and authorization evidence required');
    this.db.prepare('INSERT OR IGNORE INTO model_material_permissions VALUES(?,?,?,?)').run(input.grantId,input.material.id,input.material.sha256,input.decisionId);
  }
  snapshot(id:string) {
    const grant=this.getGrant(id);
    const used=this.db.prepare(`SELECT COUNT(*) AS requests,COALESCE(SUM(CASE WHEN status='settled' THEN observed_tokens ELSE MAX(reserved_tokens,observed_tokens) END),0) AS tokens,
      COALESCE(SUM(CASE WHEN status='settled' THEN observed_cost ELSE MAX(reserved_cost,observed_cost) END),0) AS cost,
      SUM(CASE WHEN status='unknown' THEN 1 ELSE 0 END) AS unknown,
      SUM(CASE WHEN status='reserved' THEN 1 ELSE 0 END) AS in_flight FROM model_reservations WHERE grant_id=?`).get(id) as Record<string,number>;
    const extra=this.db.prepare('SELECT COALESCE(SUM(requests),0) AS requests,COALESCE(SUM(tokens),0) AS tokens,COALESCE(SUM(cost),0) AS cost FROM model_budget_additions WHERE grant_id=?').get(id) as Record<string,number>;
    const blocked=Boolean((this.db.prepare('SELECT blocked FROM model_grants WHERE id=?').get(id) as {blocked:number}).blocked);
    return {grantId:id,requests:used.requests,tokens:used.tokens,costMicros:used.cost,unknown:used.unknown??0,inFlight:used.in_flight??0,
      limits:{requests:grant.maxRequests+extra.requests,tokens:grant.maxTokens+extra.tokens,costMicros:grant.maxCostMicros+extra.cost},blocked};
  }
  reserve(request:ReservationRequest) {
    integer(request.reserveTokens,'reservation tokens',true);integer(request.reserveCostMicros,'reservation cost',true);
    for(const value of [request.id,request.runId,request.role]) if(!value)throw new RuntimeError('INVALID_REQUEST','Request identity required');
    return this.tx(()=>{
      const exists=this.db.prepare('SELECT digest FROM model_reservations WHERE id=?').get(request.id) as {digest:string}|undefined;
      if(exists)throw new RuntimeError(exists.digest===hash(request)?'REQUEST_ALREADY_RESERVED':'IDEMPOTENCY_CONFLICT','A request reservation may never authorize a second provider call');
      const grant=this.getGrant(request.grantId),state=this.snapshot(request.grantId);
      if(state.blocked || Date.parse(grant.expiresAt)<=Date.now())throw new RuntimeError('MODEL_BLOCKED','Authorization blocked or expired');
      if(request.provider!==grant.provider || request.modelId!==grant.modelId || request.destination!==grant.destination || !grant.allowedRoles.includes(request.role))
        throw new RuntimeError('MODEL_SCOPE_DENIED','Provider, model, destination and role must match the grant exactly');
      if(!request.data.length || request.data.some(x=>!grant.data.some(g=>g.id===x.id&&g.sha256===x.sha256)))
        throw new RuntimeError('DATA_SCOPE_DENIED','Input contains unapproved material or revision');
      if(state.requests+1>state.limits.requests || state.tokens+request.reserveTokens>state.limits.tokens || state.costMicros+request.reserveCostMicros>state.limits.costMicros)
        throw new RuntimeError('BUDGET_EXHAUSTED','Requests, tokens or cost would exceed finite remaining authorization');
      this.db.prepare('INSERT INTO model_reservations(id,grant_id,body,digest,status,reserved_tokens,reserved_cost) VALUES(?,?,?,?,?,?,?)')
        .run(request.id,request.grantId,JSON.stringify(request),hash(request),'reserved',request.reserveTokens,request.reserveCostMicros);
      return this.snapshot(request.grantId);
    });
  }
  markUnknown(requestId:string) {
    const row=this.db.prepare('SELECT status FROM model_reservations WHERE id=?').get(requestId) as {status:string}|undefined;
    if(!row)throw new RuntimeError('REQUEST_NOT_FOUND','Unknown request');
    if(row.status!=='settled')this.db.prepare("UPDATE model_reservations SET status='unknown' WHERE id=?").run(requestId);
  }
  report(report:UsageReport) {
    integer(report.tokens,'usage tokens');integer(report.costMicros,'usage cost');
    if(!report.reportId || !report.source)throw new RuntimeError('USAGE_SOURCE_MISSING','Usage report identity and source required');
    return this.tx(()=>{
      const duplicate=this.db.prepare('SELECT digest FROM model_usage_reports WHERE id=?').get(report.reportId) as {digest:string}|undefined;
      if(duplicate){if(duplicate.digest!==hash(report))throw new RuntimeError('IDEMPOTENCY_CONFLICT','Usage report ID changed content');return;}
      const row=this.db.prepare('SELECT * FROM model_reservations WHERE id=?').get(report.requestId) as Record<string,string|number>|undefined;
      if(!row)throw new RuntimeError('REQUEST_NOT_FOUND','Usage has no reservation');
      if(report.tokens<Number(row.observed_tokens)||report.costMicros<Number(row.observed_cost))
        throw new RuntimeError('NONMONOTONIC_USAGE','Cumulative usage cannot decrease');
      this.db.prepare('INSERT INTO model_usage_reports VALUES(?,?,?,?)').run(report.reportId,report.requestId,hash(report),JSON.stringify(report));
      this.db.prepare('UPDATE model_reservations SET observed_tokens=?,observed_cost=?,status=? WHERE id=?')
        .run(report.tokens,report.costMicros,report.final?'settled':row.status,report.requestId);
      // Provider observations can exceed an estimate. Preserve actual usage and fail closed.
      if(report.tokens>Number(row.reserved_tokens)||report.costMicros>Number(row.reserved_cost))
        this.db.prepare('UPDATE model_grants SET blocked=1 WHERE id=?').run(row.grant_id);
    });
  }
  /** Explicit additional authorization only. Continuing, restarting, or switching sessions does nothing. */
  addBudget(add:{id:string;grantId:string;decisionId:string;requests:number;tokens:number;costMicros:number}, authorize:(value:typeof add)=>void) {
    authorize(add);integer(add.requests,'extra requests');integer(add.tokens,'extra tokens');integer(add.costMicros,'extra cost');
    if(!add.id||!add.decisionId||add.requests+add.tokens+add.costMicros===0)throw new RuntimeError('EXPLICIT_ADDITION_REQUIRED','Addition must reference an explicit new decision');
    this.getGrant(add.grantId);
    this.tx(()=>{
      const prev=this.db.prepare('SELECT * FROM model_budget_additions WHERE id=?').get(add.id) as Record<string,string|number>|undefined;
      if(prev){if(prev.grant_id===add.grantId&&prev.decision_id===add.decisionId&&prev.requests===add.requests&&prev.tokens===add.tokens&&prev.cost===add.costMicros)return;
        throw new RuntimeError('IDEMPOTENCY_CONFLICT','Budget addition ID changed');}
      const current=this.snapshot(add.grantId);integer(current.limits.requests+add.requests,'combined request budget');integer(current.limits.tokens+add.tokens,'combined token budget');integer(current.limits.costMicros+add.costMicros,'combined cost budget');
      this.db.prepare('INSERT INTO model_budget_additions VALUES(?,?,?,?,?,?)').run(add.id,add.grantId,add.decisionId,add.requests,add.tokens,add.costMicros);
    });
  }
  stopGrant(id:string){this.getGrant(id);this.db.prepare('UPDATE model_grants SET blocked=1 WHERE id=?').run(id);}
  recoverInFlight(){this.db.prepare("UPDATE model_reservations SET status='unknown' WHERE status='reserved'").run();}
  chargeSafeAttempt(operationId:string,sideEffect:'not-started'|'known-safe'|'unknown') {
    if(sideEffect==='unknown')throw new RuntimeError('SIDE_EFFECT_UNKNOWN','Reconcile external effects before retrying');
    return this.tx(()=>{
      const row=this.db.prepare('SELECT attempts FROM runtime_retry_counts WHERE operation_id=?').get(operationId) as {attempts:number}|undefined;
      if((row?.attempts??0)>=3)throw new RuntimeError('RETRY_LIMIT','At most two additional safe retries');
      this.db.prepare('INSERT INTO runtime_retry_counts VALUES(?,1) ON CONFLICT(operation_id) DO UPDATE SET attempts=attempts+1').run(operationId);
      return (row?.attempts??0)+1;
    });
  }
  recordCycle(demandId:string,issueId:string,kind:'no-progress'|'verified-progress'|'resource-wait',evidence?:string) {
    if(kind==='resource-wait')return;
    if(kind==='verified-progress'&&!evidence)throw new RuntimeError('PROGRESS_EVIDENCE_REQUIRED','A log line or renamed session is not verified progress');
    this.tx(()=>{
      this.db.prepare('INSERT INTO runtime_progress VALUES(?,?,?,?) ON CONFLICT(demand_id,issue_id) DO UPDATE SET cycles=CASE WHEN excluded.cycles=0 THEN 0 ELSE runtime_progress.cycles+1 END,evidence=excluded.evidence')
        .run(demandId,issueId,kind==='verified-progress'?0:1,evidence??null);
    });
    const row=this.db.prepare('SELECT cycles FROM runtime_progress WHERE demand_id=? AND issue_id=?').get(demandId,issueId) as {cycles:number};
    if(row.cycles>=3)throw new RuntimeError('NO_PROGRESS_LIMIT','Three complete no-progress cycles require intervention');
  }
}
