import type { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ControlledGit } from './git.ts';
import type { GitOptions } from './git.ts';
import { ImmutableObjectStore, digest, canonicalJson } from './objects.ts';
import { canonicalDirectory, id, insist, noLinks, readRegular, secureMkdir, sourcePath, canonicalDestination, sameDirectory, sameDestination, destinationsCollide } from './paths.ts';
export { ImmutableObjectStore, digest, canonicalJson } from './objects.ts';
export type { ObjectRef } from './objects.ts';
export { ControlledGit } from './git.ts';
export { WorkspaceError } from './paths.ts';

export interface ProjectBinding { projectId:string; anchorPath:string; formalTarget:string }
export interface WorkspaceBinding { projectId:string; demandId:string; worktreePath:string; branch:string; initialBaseline:string|null; currentBaseline:string|null; head:string|null; preparationOperation:string }
export interface PrepareRequest { operationId:string; projectId:string; demandId:string; worktreePath:string; branch:string; baseline:string|null; prepareAuthorized:boolean }
export interface CommitRequest { operationId:string; demandId:string; expectedHead:string|null; paths:string[]; expectedFiles:Record<string,string|null>; message:string; author:{name:string;email:string}; commitAuthorized:boolean; writerStopped:boolean }
export interface BaselineUpdateRequest { operationId:string; demandId:string; sourceCommit:string; formalTarget:string; updateAuthorized:boolean; writerStopped:boolean; controlState:'active'|'paused'|'cancelled'|'awaiting-acceptance'; author:{name:string;email:string} }
export interface BaselineUpdateResult { operationId:string; sourceCommit:string; head:string|null; state:'conflict'|'integrated-awaiting-verification'|'verified'; conflicts:string[]; capabilityVerified:boolean }
interface Intent { kind:string; status:string; data:any }
export interface WorkspaceOptions extends GitOptions { db:DatabaseSync; fault?:(point:string)=>void }
/** Host service. Authorization booleans are supplied only after F authenticates a user grant. */
export class WorkspaceService {
  readonly git:ControlledGit; private db:DatabaseSync; private fault:(point:string)=>void;
  constructor(options: WorkspaceOptions) {
    this.db = options.db; this.git = new ControlledGit(options); this.fault = options.fault ?? (()=>{});
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_projects(project_id TEXT PRIMARY KEY, anchor_path TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_bindings(demand_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worktree_path TEXT UNIQUE NOT NULL, branch TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(project_id,branch));
      CREATE TABLE IF NOT EXISTS workspace_intents(operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL, demand_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS workspace_pending_demand ON workspace_intents(demand_id) WHERE status='pending';
      CREATE TABLE IF NOT EXISTS workspace_baselines(demand_id TEXT NOT NULL, sequence INTEGER NOT NULL, source TEXT, evidence TEXT NOT NULL, PRIMARY KEY(demand_id,sequence));
    `);
  }
  bindProject(input: ProjectBinding): ProjectBinding {
    id(input.projectId); this.git.validateBranch(input.formalTarget); const anchorPath = canonicalDirectory(input.anchorPath);
    insist(existsSync(join(anchorPath,'.git')) && lstatSync(join(anchorPath,'.git')).isDirectory(), 'ANCHOR_NOT_MAIN', 'Use a persistent main repository anchor, not a disposable worktree.');
    noLinks(join(anchorPath,'.git')); this.git.guard(anchorPath); this.git.guardPrivate(anchorPath);
    const existing = this.db.prepare('SELECT data FROM workspace_projects WHERE project_id=?').get(input.projectId) as any;
    const binding = {...input,anchorPath};
    if (existing) { insist(existing.data === canonicalJson(binding),'PROJECT_IDENTITY','Project binding cannot silently move or change targets.'); return binding; }
    this.git.excludeOwned(anchorPath); ImmutableObjectStore.open(anchorPath,input.projectId);
    this.db.prepare('INSERT INTO workspace_projects VALUES(?,?,?)').run(input.projectId,anchorPath,canonicalJson(binding)); return binding;
  }
  getProject(projectId:string):ProjectBinding {
    const row = this.db.prepare('SELECT data FROM workspace_projects WHERE project_id=?').get(projectId) as any;
    insist(row,'PROJECT_MISSING','Project has not been bound.'); const p = JSON.parse(row.data); canonicalDirectory(p.anchorPath); return p;
  }
  getBinding(demandId:string):WorkspaceBinding|null {
    const row = this.db.prepare('SELECT data FROM workspace_bindings WHERE demand_id=?').get(demandId) as any; return row ? JSON.parse(row.data) : null;
  }
  private intent(operationId:string):Intent|null {
    const row = this.db.prepare('SELECT kind,status,data FROM workspace_intents WHERE operation_id=?').get(operationId) as any;
    return row ? {...row,data:JSON.parse(row.data)} : null;
  }
  private saveIntent(operationId:string,kind:string,demandId:string,data:any):void {
    this.db.prepare('INSERT INTO workspace_intents VALUES(?,?,?,?,?)').run(operationId,kind,demandId,'pending',canonicalJson(data));
  }
  private updateIntent(operationId:string,data:any,status='pending'):void { this.db.prepare('UPDATE workspace_intents SET data=?,status=? WHERE operation_id=?').run(canonicalJson(data),status,operationId); }
  prepare(input:PrepareRequest):WorkspaceBinding {
    id(input.operationId); id(input.demandId); insist(input.prepareAuthorized,'NOT_AUTHORIZED','Workspace preparation requires an effective grant.');
    const p = this.getProject(input.projectId); this.git.validateBranch(input.branch); const worktreePath = canonicalDestination(input.worktreePath);
    insist(input.branch !== p.formalTarget,'FORMAL_BRANCH','A demand requires its own development branch.');
    const request = {...input,worktreePath}; const prior = this.intent(input.operationId);
    if (prior) { insist(prior.kind==='prepare' && sameDestination(prior.data.request.worktreePath,worktreePath) && digest(canonicalJson({...prior.data.request,worktreePath}))===digest(canonicalJson(request)), 'OPERATION_CONFLICT','Operation identifier was reused with different content.'); return this.reconcile(input.operationId) as WorkspaceBinding; }
    const existing = this.getBinding(input.demandId);
    if (existing) {
      insist(existing.projectId===input.projectId && sameDirectory(existing.worktreePath,worktreePath) && existing.branch===input.branch && existing.initialBaseline===input.baseline,'WORKSPACE_CONFLICT','A demand already has a different workspace.');
      this.checkBinding(existing); return existing;
    }
    const reservations=this.db.prepare("SELECT data FROM workspace_intents WHERE kind='prepare' AND status='pending'").all() as any[];
    insist(!reservations.some(row=>{const r=JSON.parse(row.data).request;return destinationsCollide(r.worktreePath,worktreePath) || (r.projectId===input.projectId && r.branch===input.branch);}),'WORKSPACE_RESERVED','Another unfinished preparation reserves this branch or worktree path.');
    insist(!existsSync(worktreePath),'PATH_OCCUPIED','Existing files are preserved; explicit takeover verification is required.');
    insist(!this.git.branchExists(p.anchorPath,input.branch),'BRANCH_OCCUPIED','The branch already exists and cannot be overwritten.');
    this.git.guardPrivate(p.anchorPath);
    const formalHead = this.git.formalHead(p.anchorPath,p.formalTarget);
    if (input.baseline) {
      this.git.resolveCommit(p.anchorPath,input.baseline);
      insist(formalHead && this.git.isAncestor(p.anchorPath,input.baseline,formalHead),'BASELINE_UNVERIFIED','The explicit baseline is not part of the configured formal target.');
    } else insist(!formalHead && !this.git.head(p.anchorPath),'EMPTY_BASE_REQUIRED','An empty baseline is only valid for an unborn project.');
    secureMkdir(dirname(worktreePath));
    this.saveIntent(input.operationId,'prepare',input.demandId,{request,requestHash:digest(canonicalJson(request))}); this.fault('prepare.intent');
    this.git.addWorktree(p.anchorPath,worktreePath,input.branch,input.baseline); this.fault('prepare.created');
    return this.reconcile(input.operationId) as WorkspaceBinding;
  }
  adoptExisting(input:PrepareRequest & {expectedHead:string;takeoverAuthorized:boolean;writerStopped:boolean}):WorkspaceBinding {
    insist(input.prepareAuthorized && input.takeoverAuthorized && input.writerStopped,'NOT_AUTHORIZED','Takeover needs explicit authority and verified stopped writers.');
    id(input.operationId);id(input.demandId);
    const prior=this.intent(input.operationId);if(prior){insist(prior.kind==='takeover' && prior.data.requestHash===digest(canonicalJson(input)),'OPERATION_CONFLICT','Takeover operation identifier was reused with different content.');return this.reconcile(input.operationId) as WorkspaceBinding;}
    const project=this.getProject(input.projectId);const worktreePath=canonicalDirectory(input.worktreePath);this.git.validateBranch(input.branch);this.git.validateOid(input.expectedHead);
    insist(input.branch!==project.formalTarget,'FORMAL_BRANCH','The formal branch cannot become a demand workspace.');
    const otherBindings=this.db.prepare('SELECT data FROM workspace_bindings WHERE demand_id<>?').all(input.demandId) as any[];
    insist(!otherBindings.some(row=>sameDirectory(JSON.parse(row.data).worktreePath,worktreePath)),'WORKSPACE_CONFLICT','This physical directory already belongs to another demand.');
    const existing=this.getBinding(input.demandId);
    if(existing){insist(existing.projectId===input.projectId && sameDirectory(existing.worktreePath,worktreePath) && existing.branch===input.branch,'WORKSPACE_CONFLICT','The demand already owns a different workspace.');this.checkBinding(existing);return existing;}
    insist(sameDirectory(this.git.commonDirectory(worktreePath),this.git.commonDirectory(project.anchorPath)) && this.git.worktrees(project.anchorPath).some(w=>sameDirectory(w.path,worktreePath) && w.branch===input.branch),'WORKSPACE_DRIFT','The selected workspace is not owned by this repository and branch.');
    insist(this.git.head(worktreePath)===input.expectedHead,'CONTENT_DRIFT','Existing work has a different HEAD.');this.git.guardPrivate(worktreePath);
    insist(this.git.status(worktreePath).length===0,'USER_DIRTY','Existing uncommitted or staged work is preserved; takeover requires separate reconciliation.');
    insist(input.baseline && this.git.isAncestor(worktreePath,input.baseline,input.expectedHead),'BASELINE_UNVERIFIED','A verified ancestor baseline is required for takeover.');
    const formal=this.git.formalHead(project.anchorPath,project.formalTarget);insist(formal && this.git.isAncestor(worktreePath,input.baseline,formal),'BASELINE_UNVERIFIED','Takeover baseline is outside the formal target.');
    this.git.verifyTree(worktreePath,input.expectedHead);
    const reservations=this.db.prepare("SELECT data FROM workspace_intents WHERE kind='prepare' AND status='pending'").all() as any[];
    insist(!reservations.some(row=>{const r=JSON.parse(row.data).request;return destinationsCollide(r.worktreePath,worktreePath) || (r.projectId===input.projectId && r.branch===input.branch);}),'WORKSPACE_RESERVED','Another unfinished preparation reserves this workspace.');
    const binding:WorkspaceBinding={projectId:input.projectId,demandId:input.demandId,worktreePath,branch:input.branch,initialBaseline:input.baseline,currentBaseline:input.baseline,head:input.expectedHead,preparationOperation:input.operationId};
    this.db.exec('BEGIN IMMEDIATE');try {
      this.db.prepare('INSERT INTO workspace_bindings VALUES(?,?,?,?,?)').run(input.demandId,input.projectId,worktreePath,input.branch,canonicalJson(binding));
      this.db.prepare('INSERT INTO workspace_baselines VALUES(?,?,?,?)').run(input.demandId,0,input.baseline,canonicalJson({operationId:input.operationId,formalTarget:project.formalTarget,takeover:true}));
      this.db.prepare('INSERT INTO workspace_intents VALUES(?,?,?,?,?)').run(input.operationId,'takeover',input.demandId,'complete',canonicalJson({request:input,requestHash:digest(canonicalJson(input)),binding}));this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}return binding;
  }
  private checkBinding(binding:WorkspaceBinding):void {
    const p = this.getProject(binding.projectId); canonicalDirectory(binding.worktreePath);
    insist(sameDirectory(this.git.commonDirectory(binding.worktreePath),this.git.commonDirectory(p.anchorPath)),'WORKSPACE_DRIFT','Worktree Git administration points outside the bound project.');
    insist(this.git.worktrees(p.anchorPath).some(w=>sameDirectory(w.path,binding.worktreePath) && w.branch===binding.branch),'WORKSPACE_DRIFT','Workspace ownership or branch changed.');
    insist(this.git.branch(binding.worktreePath)===binding.branch,'WORKSPACE_DRIFT','Worktree branch changed.');
  }
  private fileHash(binding:WorkspaceBinding,path:string):string|null {
    const full = join(binding.worktreePath,sourcePath(path)); noLinks(full,true);
    if (!existsSync(full)) return null;
    insist(lstatSync(full).isFile(),'INVALID_FILE','Only ordinary delivery files are supported.'); return digest(readRegular(full));
  }
  private indexHash(path:string):string|null { noLinks(path,true); return existsSync(path) ? digest(readRegular(path)) : null; }
  commit(input:CommitRequest):{commit:string;tree:string;recovered:boolean;noChanges?:boolean} {
    id(input.operationId); insist(input.commitAuthorized && input.writerStopped,'NOT_AUTHORIZED','Saving code needs a commit grant and verified stopped writers.');
    insist(typeof input.message==='string' && input.message.trim().length>0 && input.message.length<=16000,'INVALID_MESSAGE','A bounded commit description is required.');
    const prior = this.intent(input.operationId); const requestHash = digest(canonicalJson(input));
    if (prior) { insist(prior.kind==='commit' && prior.data.requestHash===requestHash,'OPERATION_CONFLICT','Operation identifier was reused with different content.'); return this.reconcile(input.operationId) as any; }
    const binding = this.getBinding(input.demandId); insist(binding,'WORKSPACE_MISSING','Prepare the demand workspace first.'); this.checkBinding(binding);
    const p = this.getProject(binding.projectId); const cwd=binding.worktreePath;
    insist(this.git.head(cwd)===input.expectedHead,'CONTENT_DRIFT','HEAD differs from the approved content.'); this.git.guardPrivate(cwd);
    insist(this.git.staged(cwd).length===0,'USER_STAGED','Existing staged work is preserved; reconcile it explicitly.');
    insist(input.paths.length>0 && new Set(input.paths).size===input.paths.length,'INVALID_FILES','Explicit unique delivery paths are required.');
    for (const path of input.paths) { sourcePath(path); insist(Object.hasOwn(input.expectedFiles,path),'CONTENT_UNVERIFIED','Every delivery path needs an expected digest (or null for deletion).'); insist(this.fileHash(binding,path)===input.expectedFiles[path],'CONTENT_DRIFT','Delivery bytes differ from the approved snapshot.'); }
    const indexPath = this.git.indexPath(cwd); const initialIndexHash = this.indexHash(indexPath);
    const store = ImmutableObjectStore.open(p.anchorPath,p.projectId); const privateIndex=join(store.root,'pending',`index-${input.operationId}`);
    insist(!existsSync(privateIndex),'PENDING_OBJECT','An unregistered staged object exists; preserve and inspect it.');
    const data={request:input,requestHash,tree:null,indexPath,initialIndexHash,privateIndex,timestamp:new Date().toISOString(),createdCommit:null};
    this.saveIntent(input.operationId,'commit',input.demandId,data); this.fault('commit.intent');
    return this.reconcile(input.operationId) as any;
  }
  reconcile(operationId:string):WorkspaceBinding|{commit:string;tree:string;recovered:boolean;noChanges?:boolean} {
    const intent=this.intent(operationId); insist(intent,'INTENT_MISSING','No persisted operation intent exists.'); const d=intent.data;
    if(intent.kind==='takeover') {const binding=this.getBinding(d.request.demandId);insist(binding,'WORKSPACE_MISSING','Takeover binding is missing.');this.checkBinding(binding);return binding;}
    if (intent.kind==='prepare') {
      const r=d.request; const p=this.getProject(r.projectId);
      if(intent.status==='complete') {const complete=this.getBinding(r.demandId);insist(complete,'WORKSPACE_MISSING','Completed workspace binding is missing.');this.checkBinding(complete);return complete;}
      let rows=this.git.worktrees(p.anchorPath);
      if(!rows.some(w=>sameDirectory(w.path,r.worktreePath) || w.branch===r.branch) && !existsSync(r.worktreePath) && !this.git.branchExists(p.anchorPath,r.branch)) {
        this.git.addWorktree(p.anchorPath,r.worktreePath,r.branch,r.baseline);rows=this.git.worktrees(p.anchorPath);
      }
      const found=rows.find(w=>sameDirectory(w.path,r.worktreePath) && w.branch===r.branch);
      insist(found && found.head===r.baseline,'SIDE_EFFECT_UNKNOWN','Workspace creation requires inspection; no second workspace was created.');
      const binding:WorkspaceBinding={projectId:r.projectId,demandId:r.demandId,worktreePath:r.worktreePath,branch:r.branch,initialBaseline:r.baseline,currentBaseline:r.baseline,head:r.baseline,preparationOperation:operationId};
      const existing=this.getBinding(r.demandId); if(existing) {this.checkBinding(existing); return existing;}
      this.db.exec('BEGIN IMMEDIATE'); try {
        this.db.prepare('INSERT INTO workspace_bindings VALUES(?,?,?,?,?)').run(r.demandId,r.projectId,r.worktreePath,r.branch,canonicalJson(binding));
        this.db.prepare('INSERT INTO workspace_baselines VALUES(?,?,?,?)').run(r.demandId,0,r.baseline,canonicalJson({operationId,formalTarget:p.formalTarget}));
        this.updateIntent(operationId,d,'complete'); this.db.exec('COMMIT');
      } catch(e) {this.db.exec('ROLLBACK'); throw e;} return binding;
    }
    if(intent.kind==='baseline') return this.reconcileBaseline(operationId,intent) as any;
    insist(intent.kind==='commit','UNKNOWN_INTENT','Unsupported persisted operation.');
    const r:CommitRequest=d.request; const binding=this.getBinding(r.demandId); insist(binding,'WORKSPACE_MISSING','Demand workspace is missing.'); this.checkBinding(binding); const cwd=binding.worktreePath;
    if(intent.status==='no-change') return {commit:d.createdCommit,tree:d.tree,recovered:true,noChanges:true};
    if(intent.status==='complete') { const info=this.git.commitInfo(cwd,d.createdCommit); insist(info.tree===d.tree,'CONTENT_DRIFT','Recorded commit changed.'); return {commit:d.createdCommit,tree:d.tree,recovered:true}; }
    this.git.guardPrivate(cwd);
    if(!d.tree) {
      insist(this.git.head(cwd)===r.expectedHead && this.indexHash(d.indexPath)===d.initialIndexHash,'CONTENT_DRIFT','Source or staging changed before snapshot recovery.');
      for(const path of r.paths) insist(this.fileHash(binding,path)===r.expectedFiles[path],'CONTENT_DRIFT','Delivery bytes changed before snapshot recovery.');
      d.tree=this.git.makeTree(cwd,r.expectedHead,r.paths,d.privateIndex);this.fault('commit.staged');
      for(const path of r.paths) insist(this.fileHash(binding,path)===r.expectedFiles[path],'CONTENT_DRIFT','Delivery changed while preparing the snapshot.');
      const currentTree=r.expectedHead?this.git.commitInfo(cwd,r.expectedHead).tree:null;
      if(d.tree===currentTree) {d.createdCommit=r.expectedHead;this.updateIntent(operationId,d,'no-change');if(existsSync(d.privateIndex))unlinkSync(d.privateIndex);return {commit:d.createdCommit,tree:d.tree,recovered:false,noChanges:true};}
      this.updateIntent(operationId,d);
    }
    if(!d.createdCommit) {
      insist(this.git.head(cwd)===r.expectedHead,'SIDE_EFFECT_UNKNOWN','HEAD changed before commit creation.');
      d.createdCommit=this.git.commitTree(cwd,d.tree,r.expectedHead,r.message,d.timestamp,r.author); this.fault('commit.object'); this.updateIntent(operationId,d); this.fault('commit.recorded');
    }
    const info=this.git.commitInfo(cwd,d.createdCommit);
    insist(info.tree===d.tree && canonicalJson(info.parents)===canonicalJson(r.expectedHead?[r.expectedHead]:[]),'CONTENT_DRIFT','Commit does not match the recorded tree and parent.');
    const head=this.git.head(cwd); insist(head===r.expectedHead || head===d.createdCommit,'SIDE_EFFECT_UNKNOWN','Branch changed externally; no history rewrite was attempted.');
    insist(this.indexHash(d.indexPath)===d.initialIndexHash || (head===d.createdCommit && this.git.staged(cwd).length===0),'USER_STAGED','Staging changed during the operation; preserve it and reconcile manually.');
    if(head!==d.createdCommit) {this.git.updateBranch(cwd,binding.branch,d.createdCommit,r.expectedHead); this.fault('commit.ref');}
    if(this.indexHash(d.indexPath)===d.initialIndexHash) {this.git.syncIndex(cwd,d.createdCommit); this.fault('commit.index');}
    binding.head=d.createdCommit;
    this.db.exec('BEGIN IMMEDIATE'); try { this.db.prepare('UPDATE workspace_bindings SET data=? WHERE demand_id=?').run(canonicalJson(binding),r.demandId);this.updateIntent(operationId,d,'complete');this.db.exec('COMMIT'); } catch(e) {this.db.exec('ROLLBACK');throw e;}
    if(existsSync(d.privateIndex)) unlinkSync(d.privateIndex);
    return {commit:d.createdCommit,tree:d.tree,recovered:head===d.createdCommit};
  }
  updateBaseline(input:BaselineUpdateRequest):BaselineUpdateResult {
    id(input.operationId);insist(input.updateAuthorized && input.writerStopped && input.controlState==='active','UPDATE_PROTECTED','A specific baseline-update grant, stopped writers, and active demand are required.');
    const prior=this.intent(input.operationId);const requestHash=digest(canonicalJson(input));
    if(prior){insist(prior.kind==='baseline' && prior.data.requestHash===requestHash,'OPERATION_CONFLICT','Baseline operation was reused with different content.');return this.reconcileBaseline(input.operationId,prior);}
    const binding=this.getBinding(input.demandId);insist(binding,'WORKSPACE_MISSING','Demand workspace is missing.');this.checkBinding(binding);
    const p=this.getProject(binding.projectId);insist(input.formalTarget===p.formalTarget,'TARGET_MISMATCH','Baseline update target differs from the pinned project target.');
    this.git.resolveCommit(p.anchorPath,input.sourceCommit);const formalHead=this.git.formalHead(p.anchorPath,p.formalTarget);
    insist(formalHead && this.git.isAncestor(p.anchorPath,input.sourceCommit,formalHead),'BASELINE_UNVERIFIED','Selected source is not verified in the formal target.');
    this.git.verifyTree(p.anchorPath,input.sourceCommit);this.git.guardPrivate(binding.worktreePath);
    insist(this.git.status(binding.worktreePath).length===0 && !this.git.mergeState(binding.worktreePath).mergeHead,'USER_DIRTY','Preserve existing work and resolve staging or merge state before integration.');
    const previousHead=this.git.head(binding.worktreePath);insist(previousHead,'EMPTY_UPDATE','Unborn branch integration requires an explicit initial-delivery workflow.');
    const data={request:input,requestHash,previousHead,timestamp:new Date().toISOString(),message:`Integrate verified formal source (${input.operationId})`,result:null};
    this.saveIntent(input.operationId,'baseline',input.demandId,data);this.fault('baseline.intent');return this.reconcileBaseline(input.operationId,this.intent(input.operationId)!);
  }
  private reconcileBaseline(operationId:string,intent:Intent):BaselineUpdateResult {
    const d=intent.data;const r:BaselineUpdateRequest=d.request;const binding=this.getBinding(r.demandId);insist(binding,'WORKSPACE_MISSING','Demand workspace is missing.');this.checkBinding(binding);const cwd=binding.worktreePath;
    if(intent.status==='complete')return d.result;
    const result=():BaselineUpdateResult=>({operationId,sourceCommit:r.sourceCommit,head:this.git.head(cwd),state:'integrated-awaiting-verification',conflicts:[],capabilityVerified:false});
    let state=this.git.mergeState(cwd);
    if(state.mergeHead) {
      insist(state.mergeHead===r.sourceCommit,'SIDE_EFFECT_UNKNOWN','An unrelated merge is in progress; its files were preserved.');
      const conflict={...result(),state:'conflict' as const,conflicts:state.unmergedPaths};d.result=conflict;this.updateIntent(operationId,d);return conflict;
    }
    let head=this.git.head(cwd);
    if(head===d.previousHead && !this.git.isAncestor(cwd,r.sourceCommit,head!)) {
      insist(this.git.status(cwd).length===0,'USER_DIRTY','Integration has partial or external changes; no reset or retry was attempted.');
      try {this.git.mergeFormal(cwd,r.sourceCommit,d.message,d.timestamp,r.author);}catch(error){
        state=this.git.mergeState(cwd);if(!state.mergeHead)throw error;
        insist(state.mergeHead===r.sourceCommit,'SIDE_EFFECT_UNKNOWN','Unrelated merge state was preserved.');
        const conflict={...result(),state:'conflict' as const,conflicts:state.unmergedPaths};d.result=conflict;this.updateIntent(operationId,d);return conflict;
      }
      this.fault('baseline.integrated');head=this.git.head(cwd);
    }
    insist(head,'SIDE_EFFECT_UNKNOWN','Integration lost its branch identity.');
    if(head!==d.previousHead && head!==r.sourceCommit){
      const info=this.git.commitInfo(cwd,head);
      insist(canonicalJson(info.parents)===canonicalJson([d.previousHead,r.sourceCommit]) && this.git.commitMessage(cwd,head)===d.message,'SIDE_EFFECT_UNKNOWN','Unexpected branch change cannot be treated as this integration.');
    }
    insist(this.git.isAncestor(cwd,r.sourceCommit,head),'SIDE_EFFECT_UNKNOWN','The selected source is not integrated.');
    this.git.guardPrivate(cwd);d.result=result();binding.head=head;
    this.db.exec('BEGIN IMMEDIATE');try {
      const sequence=(this.db.prepare('SELECT COALESCE(MAX(sequence),-1)+1 AS n FROM workspace_baselines WHERE demand_id=?').get(r.demandId) as any).n;
      this.db.prepare('INSERT INTO workspace_baselines VALUES(?,?,?,?)').run(r.demandId,sequence,r.sourceCommit,canonicalJson({operationId,formalTarget:r.formalTarget,state:'integrated-awaiting-verification',head}));
      this.db.prepare('UPDATE workspace_bindings SET data=? WHERE demand_id=?').run(canonicalJson(binding),r.demandId);this.updateIntent(operationId,d,'complete');this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}return d.result;
  }
  /** Q supplies actual capability/environment checks; ancestry alone never unlocks dependencies. */
  verifyBaseline(input:{operationId:string;expectedHead:string;capabilitiesVerified:boolean;evidenceRefs:string[]}):BaselineUpdateResult {
    const intent=this.intent(input.operationId);insist(intent?.kind==='baseline' && intent.status==='complete','UPDATE_INCOMPLETE','Integration has not completed.');const d=intent.data;
    insist(input.capabilitiesVerified && input.evidenceRefs.length>0,'CAPABILITY_UNVERIFIED','Actual code and environment capability evidence is required.');
    const binding=this.getBinding(d.request.demandId)!;this.checkBinding(binding);
    insist(this.git.head(binding.worktreePath)===input.expectedHead && d.result.head===input.expectedHead && this.git.status(binding.worktreePath).length===0,'CONTENT_DRIFT','Integrated content changed before verification.');
    binding.currentBaseline=d.request.sourceCommit;d.result={...d.result,state:'verified',capabilityVerified:true};d.capabilityEvidenceRefs=input.evidenceRefs;
    this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('UPDATE workspace_bindings SET data=? WHERE demand_id=?').run(canonicalJson(binding),binding.demandId);this.updateIntent(input.operationId,d,'complete');this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
    return d.result;
  }
  inspectContent(input:{demandId:string;expectedCommit:string|null}):{head:string|null;expectedCommit:string|null;changed:boolean;changes:string[]} {
    const binding=this.getBinding(input.demandId);insist(binding,'WORKSPACE_MISSING','Demand workspace is missing.');this.checkBinding(binding);
    const head=this.git.head(binding.worktreePath);const changes=this.git.status(binding.worktreePath);
    return {head,expectedCommit:input.expectedCommit,changed:head!==input.expectedCommit || changes.length>0,changes};
  }
  /** Exact-object and exact-path allowlist checked before any Git content lookup. */
  readAuthorizedFile(input:{demandId:string;commit:string;path:string;allowedCommits:string[];allowedPaths:string[]}):Buffer {
    insist(input.allowedCommits.includes(input.commit) && input.allowedPaths.includes(input.path),'NOT_AUTHORIZED','The requested source is outside this run\'s scope.');
    const binding=this.getBinding(input.demandId); insist(binding,'WORKSPACE_MISSING','Demand workspace is missing.');this.checkBinding(binding);
    return this.git.readFile(binding.worktreePath,input.commit,input.path);
  }
}
