import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { ObjectRef } from '../workspace/objects.ts';
import { ImmutableObjectStore, digest, canonicalJson } from '../workspace/objects.ts';
import { id, insist } from '../workspace/paths.ts';

export type KnowledgeRole='planner'|'implementer'|'reviewer';
export type SourceKind='implementation'|'existing-fact'|'environment';
export type MaterialKind='knowledge'|'plan'|'evidence'|'session'|'session-summary';
export interface CandidateInput {
  revisionId:string; knowledgeId:string; projectId:string; demandId:string; createdBy:string;
  parentRevisionId?:string; title:string; tags:string[]; body:string; sourceKind:SourceKind;
  materialKind:MaterialKind; statementKind:'fact'|'constraint'|'recommendation'|'hypothesis';
  formalTarget:string; roles:KnowledgeRole[]; modulePaths:string[];
}
export interface KnowledgeRevision extends Omit<CandidateInput,'body'> { object:ObjectRef; createdAt:string }
export interface SourceEvidence {
  evidenceId:string; revisionId:string; reviewerId:string; sourceKind:SourceKind;
  sourceVerified:boolean; contentConsistent:boolean; worthReusing:boolean; applicabilityClear:boolean;
  mixedPrivateConclusions:boolean; evidenceRefs:string[];
  formalTarget:string; formalCommit?:string; environment?:string;
  independentOfDemand?:boolean; mergeObservationId?:string; finalContentVerificationId?:string;
}
export interface EligibilityInput { eligibilityId:string; revisionId:string; evidenceId:string; formalTarget:string; baseline:string|null; environment:string; capabilityEvidenceRefs:string[] }
export interface ContextInput { runId:string; projectId:string; demandId:string; role:KnowledgeRole; baseline:string|null; formalTarget:string; environment:string; allowedRevisionIds:string[]; purpose:string }
export interface ContextManifest { contextId:string; runId:string; projectId:string; demandId:string; role:KnowledgeRole; revisionIds:string[]; createdAt:string }
export interface KnowledgeOptions { db:DatabaseSync; resolveStore:(projectId:string)=>ImmutableObjectStore; onBodyRead?:(revisionId:string)=>void; fault?:(point:string)=>void }
/** Trusted Host APIs. Workers receive only a context capability's read/search methods. */
export class KnowledgeService {
  private db:DatabaseSync; private resolveStore:(projectId:string)=>ImmutableObjectStore; private onBodyRead:(id:string)=>void; private fault:(point:string)=>void;
  constructor(options:KnowledgeOptions) {
    this.db=options.db;this.resolveStore=options.resolveStore;this.onBodyRead=options.onBodyRead??(()=>{});this.fault=options.fault??(()=>{});
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_revisions(revision_id TEXT PRIMARY KEY,knowledge_id TEXT NOT NULL,project_id TEXT NOT NULL,demand_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_evidence(evidence_id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_eligibility(eligibility_id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,evidence_id TEXT NOT NULL,active INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_contexts(context_id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_reads(read_id TEXT PRIMARY KEY,context_id TEXT NOT NULL,revision_id TEXT NOT NULL,purpose TEXT NOT NULL,read_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_invalidations(invalidation_id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,reason TEXT NOT NULL,evidence_ref TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS knowledge_project_scope ON knowledge_revisions(project_id,demand_id);
    `);
  }
  private revision(revisionId:string):KnowledgeRevision {
    const row=this.db.prepare('SELECT data FROM knowledge_revisions WHERE revision_id=?').get(revisionId) as any;
    insist(row,'MATERIAL_UNAVAILABLE','Requested material is unavailable.'); return JSON.parse(row.data);
  }
  saveCandidate(input:CandidateInput):KnowledgeRevision {
    for(const value of [input.revisionId,input.knowledgeId,input.projectId,input.demandId,input.createdBy]) id(value);
    insist(['implementation','existing-fact','environment'].includes(input.sourceKind),'INVALID_SOURCE','Unknown source classification.');
    insist(['knowledge','plan','evidence','session','session-summary'].includes(input.materialKind),'INVALID_MATERIAL','Unknown material classification.');
    insist(['fact','constraint','recommendation','hypothesis'].includes(input.statementKind),'INVALID_STATEMENT','Unknown statement classification.');
    insist(input.roles.length>0 && input.roles.every(r=>['planner','implementer','reviewer'].includes(r)),'INVALID_ROLE','Explicit role scope is required.');
    insist(input.title.length<=512 && input.tags.length<=64 && input.modulePaths.length<=128,'INVALID_METADATA','Material metadata exceeds limits.');
    const store=this.resolveStore(input.projectId); const object=store.put(input.body); this.fault('knowledge.object');
    const {body,...metadata}=input; const prior=this.db.prepare('SELECT data FROM knowledge_revisions WHERE revision_id=?').get(input.revisionId) as any;
    if(prior) {const previous=JSON.parse(prior.data);const {createdAt,...rest}=previous;insist(canonicalJson(rest)===canonicalJson({...metadata,object}),'REVISION_CONFLICT','An immutable revision cannot be overwritten.');return previous;}
    if(input.parentRevisionId) { const parent=this.revision(input.parentRevisionId);insist(parent.projectId===input.projectId && parent.knowledgeId===input.knowledgeId,'PARENT_MISMATCH','Revision parent belongs to another knowledge item or project.'); }
    const result:KnowledgeRevision={...metadata,object,createdAt:new Date().toISOString()};
    this.db.prepare('INSERT INTO knowledge_revisions VALUES(?,?,?,?,?)').run(input.revisionId,input.knowledgeId,input.projectId,input.demandId,canonicalJson(result));return result;
  }
  /** Called by a trusted independent verifier, never accepted from a Worker completion boolean. */
  recordEvidence(input:SourceEvidence):void {
    id(input.evidenceId);const revision=this.revision(input.revisionId);id(input.reviewerId);
    insist(input.reviewerId!==revision.createdBy,'INDEPENDENCE_REQUIRED','The author cannot independently verify their own reusable knowledge.');
    insist(input.sourceKind===revision.sourceKind && input.formalTarget===revision.formalTarget,'SOURCE_MISMATCH','Source evidence must identify this exact provenance and target.');
    insist(input.evidenceRefs.length>0 && input.evidenceRefs.every(r=>typeof r==='string' && r.length>0),'EVIDENCE_MISSING','Concrete source evidence references are required.');
    this.resolveStore(revision.projectId).verify(revision.object);
    const old=this.db.prepare('SELECT data FROM knowledge_evidence WHERE evidence_id=?').get(input.evidenceId) as any;
    if(old) {insist(old.data===canonicalJson(input),'EVIDENCE_CONFLICT','Evidence is immutable.');return;}
    this.db.prepare('INSERT INTO knowledge_evidence VALUES(?,?,?)').run(input.evidenceId,input.revisionId,canonicalJson(input));
  }
  registerEligibility(input:EligibilityInput):void {
    id(input.eligibilityId);const revision=this.revision(input.revisionId);
    insist(revision.materialKind==='knowledge' && revision.statementKind!=='hypothesis','NOT_REUSABLE','Sessions, plans, and unverified hypotheses do not become shared knowledge.');
    const row=this.db.prepare('SELECT data FROM knowledge_evidence WHERE evidence_id=? AND revision_id=?').get(input.evidenceId,input.revisionId) as any;
    insist(row,'EVIDENCE_MISSING','Matching independent evidence is required.');const e:SourceEvidence=JSON.parse(row.data);
    insist(e.sourceVerified && e.contentConsistent && e.worthReusing && e.applicabilityClear && !e.mixedPrivateConclusions,'ELIGIBILITY_UNVERIFIED','One or more source, content, reuse, or applicability checks remain unresolved.');
    insist(input.formalTarget===revision.formalTarget && input.formalTarget===e.formalTarget,'TARGET_MISMATCH','The verified formal target differs.');
    insist(input.environment.length>0 && input.capabilityEvidenceRefs.length>0,'APPLICABILITY_MISSING','An exact environment and actual capability evidence are required.');
    if(revision.sourceKind==='implementation') {
      insist(e.mergeObservationId && e.finalContentVerificationId && e.formalCommit,'MERGE_UNVERIFIED','New implementation knowledge needs actual merge observation and separate final-content verification.');
      const table=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_remote_observations'").get();
      insist(table,'MERGE_UNVERIFIED','No trusted remote observations are available.');
      const observation=this.db.prepare('SELECT data FROM workspace_remote_observations WHERE observation_id=?').get(e.mergeObservationId) as any;
      insist(observation,'MERGE_UNVERIFIED','Remote observation is unavailable.');const o=JSON.parse(observation.data);
      insist(o.projectId===revision.projectId && o.demandId===revision.demandId,'SOURCE_MISMATCH','Merge observation belongs to another project or demand.');
      insist(o.state==='merged' && o.target===e.formalTarget && o.formalCommit===e.formalCommit,'MERGE_UNVERIFIED','Remote observation does not identify the verified merged formal content.');
      // Test adapters must remain visible as test evidence, and cannot grant production eligibility.
      insist(o.provenance==='github-live','MOCK_EVIDENCE','Mock remote evidence cannot grant implementation knowledge production eligibility.');
      const verification=this.db.prepare('SELECT data FROM workspace_content_verifications WHERE verification_id=?').get(e.finalContentVerificationId) as any;
      insist(verification,'CONTENT_UNVERIFIED','Final content verification is missing.');const v=JSON.parse(verification.data);
      insist(v.observationId===e.mergeObservationId && v.formalCommit===e.formalCommit && v.contentCorresponds && v.capabilitiesVerified && v.revisionIds.includes(input.revisionId),'CONTENT_UNVERIFIED','Final verification does not cover this exact knowledge revision.');
    } else if(revision.sourceKind==='existing-fact') {
      insist(e.formalCommit && e.independentOfDemand,'SOURCE_UNVERIFIED','Existing facts require an independently verified formal version.');
    } else {
      insist(e.environment===input.environment && e.independentOfDemand,'ENVIRONMENT_UNVERIFIED','Environment experience requires matching independent environment evidence.');
    }
    this.resolveStore(revision.projectId).verify(revision.object);
    const previous=this.db.prepare('SELECT data FROM knowledge_eligibility WHERE eligibility_id=?').get(input.eligibilityId) as any;
    if(previous) {insist(previous.data===canonicalJson(input),'ELIGIBILITY_CONFLICT','Eligibility records are immutable.');return;}
    this.db.prepare('INSERT INTO knowledge_eligibility VALUES(?,?,?,?,?)').run(input.eligibilityId,input.revisionId,input.evidenceId,1,canonicalJson(input));
  }
  /** Preserve history, revoke future/current reads, never rewrite old content or decisions. */
  invalidate(input:{revisionId:string;reason:string;evidenceRef:string}):void {
    this.revision(input.revisionId);insist(input.reason.length>0 && input.evidenceRef.length>0,'EVIDENCE_MISSING','Invalidation requires an explicit reason and evidence.');
    this.db.exec('BEGIN IMMEDIATE');try {
      this.db.prepare('INSERT INTO knowledge_invalidations VALUES(?,?,?,?,?)').run(randomUUID(),input.revisionId,input.reason,input.evidenceRef,new Date().toISOString());
      this.db.prepare('UPDATE knowledge_eligibility SET active=0 WHERE revision_id=?').run(input.revisionId);this.db.exec('COMMIT');
    } catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  private invalidated(revisionId:string):boolean {return !!this.db.prepare('SELECT 1 FROM knowledge_invalidations WHERE revision_id=? LIMIT 1').get(revisionId);}
  createContext(input:ContextInput):ContextManifest {
    for(const value of [input.runId,input.projectId,input.demandId])id(value);
    insist(['planner','implementer','reviewer'].includes(input.role),'INVALID_ROLE','Unknown context role.');
    const previous=this.db.prepare('SELECT data FROM knowledge_contexts WHERE run_id=?').get(input.runId) as any;
    if(previous){const p=JSON.parse(previous.data);insist(p.requestHash===digest(canonicalJson(input)),'CONTEXT_CONFLICT','An existing run cannot widen or silently replace its context.');return p.manifest;}
    // Metadata query is project-restricted. NO body is read or indexed before all scope checks.
    const rows=this.db.prepare('SELECT data FROM knowledge_revisions WHERE project_id=?').all(input.projectId) as any[];
    const allowed=new Set(input.allowedRevisionIds);const selected:string[]=[];
    for(const row of rows) {
      const r:KnowledgeRevision=JSON.parse(row.data);
      if(!allowed.has(r.revisionId) || !r.roles.includes(input.role) || r.formalTarget!==input.formalTarget || this.invalidated(r.revisionId))continue;
      if(input.role==='reviewer' && ['session','session-summary'].includes(r.materialKind))continue;
      if(r.demandId===input.demandId) {selected.push(r.revisionId);continue;}
      if(r.materialKind!=='knowledge')continue;
      const eligibilities=this.db.prepare('SELECT data FROM knowledge_eligibility WHERE revision_id=? AND active=1').all(r.revisionId) as any[];
      if(eligibilities.some(row=>{const e:EligibilityInput=JSON.parse(row.data);return e.baseline===input.baseline && e.formalTarget===input.formalTarget && e.environment===input.environment;}))selected.push(r.revisionId);
    }
    const manifest:ContextManifest={contextId:randomUUID(),runId:input.runId,projectId:input.projectId,demandId:input.demandId,role:input.role,revisionIds:selected.sort(),createdAt:new Date().toISOString()};
    this.db.prepare('INSERT INTO knowledge_contexts VALUES(?,?,?)').run(manifest.contextId,input.runId,canonicalJson({manifest,requestHash:digest(canonicalJson(input)),purpose:input.purpose}));return manifest;
  }
  private context(contextId:string):{manifest:ContextManifest;purpose:string} {
    const row=this.db.prepare('SELECT data FROM knowledge_contexts WHERE context_id=?').get(contextId) as any;
    insist(row,'MATERIAL_UNAVAILABLE','Requested material is unavailable.');return JSON.parse(row.data);
  }
  read(contextId:string,revisionId:string,purpose?:string):{revisionId:string;title:string;body:string;object:ObjectRef} {
    const context=this.context(contextId);
    // The deny path does not load foreign revision metadata, title, or body.
    insist(context.manifest.revisionIds.includes(revisionId) && !this.invalidated(revisionId),'MATERIAL_UNAVAILABLE','Requested material is unavailable.');
    const revision=this.revision(revisionId);this.onBodyRead(revisionId);
    const body=this.resolveStore(revision.projectId).read(revision.object).toString();
    this.db.prepare('INSERT INTO knowledge_reads VALUES(?,?,?,?,?)').run(randomUUID(),contextId,revisionId,purpose??context.purpose,new Date().toISOString());
    return {revisionId,title:revision.title,body,object:revision.object};
  }
  search(contextId:string,query:string,limit=10):Array<{revisionId:string;title:string;excerpt:string;score:number}> {
    insist(query.length<=1024 && Number.isSafeInteger(limit) && limit>=1 && limit<=50,'INVALID_SEARCH','Search must be bounded.');
    const context=this.context(contextId);const terms=query.toLowerCase().split(/\s+/).filter(Boolean);
    if(!terms.length)return [];
    const result:Array<{revisionId:string;title:string;excerpt:string;score:number}>=[];
    for(const revisionId of context.manifest.revisionIds) {
      if(this.invalidated(revisionId))continue;
      const r=this.revision(revisionId);const data=this.read(contextId,revisionId,`search:${query}`);
      const searchable=[r.title,...r.tags,...r.modulePaths,data.body].join('\n').toLowerCase();
      const score=terms.reduce((n,t)=>n+(searchable.includes(t)?1:0),0);
      if(score>0)result.push({revisionId,title:data.title,excerpt:data.body.slice(0,300),score});
    }
    return result.sort((a,b)=>b.score-a.score || a.revisionId.localeCompare(b.revisionId)).slice(0,limit);
  }
  verifyReferences(projectId:string):Array<{revisionId:string;valid:boolean;error?:string}> {
    const rows=this.db.prepare('SELECT data FROM knowledge_revisions WHERE project_id=?').all(projectId) as any[];
    return rows.map(row=>{const r:KnowledgeRevision=JSON.parse(row.data);try {this.resolveStore(projectId).verify(r.object);return {revisionId:r.revisionId,valid:true};}catch(e:any){return {revisionId:r.revisionId,valid:false,error:e.code??'OBJECT_UNAVAILABLE'};}});
  }
}
