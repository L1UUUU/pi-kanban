import type { WorkbenchStore } from '../domain/store.ts';
import type { WorkflowService } from '../domain/workflow.ts';
import type { DeliveryResult, Demand, ArtifactRef } from '../domain/types.ts';
import type { KnowledgeService, KnowledgeRole, SourceKind, KnowledgeRevision } from '../knowledge/index.ts';
import { GitHubReadOnlyAdapter } from '../knowledge/remote.ts';
import type { GitHubBinding, ReadOnlyTransport, RemoteObservation } from '../knowledge/remote.ts';
import type { WorkspaceService, BaselineUpdateResult } from '../workspace/index.ts';
import { canonicalJson, digest } from '../workspace/objects.ts';
import { insist, sourcePath } from '../workspace/paths.ts';
import { record, text, revision } from './protocol.ts';
import type { ProductionEvidence, SourceSnapshot } from './evidence.ts';

export interface LifecycleControl { demandId: string; expectedVersion: number; requestId: string }
export type KnowledgeAction = LifecycleControl & (
  | { action: 'save-candidate'; resultId: string; artifactId: string; title: string; sourceKind: SourceKind; statementKind: 'fact'|'constraint'|'recommendation'|'hypothesis'; roles: KnowledgeRole[]; modulePaths: string[]; tags: string[] }
  | { action: 'bind-remote'; owner: string; repository: string; pullRequest: number }
  | { action: 'observe-remote' }
  | { action: 'qualify'; revisionId: string; baseline: string; observationId?: string; checkIds: string[]; reviewed: true; independentOfDemand: boolean; reason: string }
  | { action: 'invalidate'; revisionId: string; reason: string }
  | { action: 'propose-baseline'; sourceCommit: string }
  | { action: 'apply-baseline'; proposalId: string; author: { name: string; email: string } }
  | { action: 'verify-baseline'; operationId: string; resultId: string; checkIds: string[] }
);
export interface BaselineProposal {
  proposalId: string; demandId: string; formalTarget: string; sourceCommit: string; expectedHead: string;
  expectedBaseline: string|null; createdAt: string; result?: BaselineUpdateResult;
}
export interface KnowledgeLifecycleView {
  candidates: { revisionId: string; artifactId: string; resultId: string; title: string; sourceKind: SourceKind; statementKind: string; status: 'candidate'|'verified'|'ineligible'; body: string; roles: KnowledgeRole[]; modulePaths: string[] }[];
  resultMaterials: { resultId: string; artifactId: string; title: string; accepted: boolean }[];
  checks: { id: string; resultId: string; name: string; environment: string; usable: boolean }[];
  remote?: GitHubBinding;
  observations: RemoteObservation[];
  baseline?: { initial: string|null; current: string|null; head: string|null; formalTarget: string };
  proposals: BaselineProposal[];
  blockers: string[];
}
interface CandidateOrigin { revisionId: string; resultId: string; artifactId: string; sourceRevisionId?: string }
interface NativeCheck { provenance: string; requestId: string; runtimeRunId: string; generation: string; sourceBefore: string; sourceAfter: string; environment: string; reason: string; exitCode: number|null }
export interface KnowledgeLifecycleOptions {
  store: WorkbenchStore; workflow: WorkflowService; knowledge: KnowledgeService; workspace: () => WorkspaceService;
  evidence: ProductionEvidence; stopped: (demandId: string) => boolean;
  /** Tests can inject GET responses, which are permanently marked non-production. */
  remoteTransport?: ReadOnlyTransport;
}
const key = (prefix: string, value: unknown): string => `${prefix}-${digest(canonicalJson(value)).slice(0,40)}`;
const oid = (value: unknown): string => { const s=text(value,'exact commit',64); insist(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(s),'INVALID_COMMIT','Use an exact commit identity.'); return s; };
const strings = (value: unknown, name: string, max: number): string[] => { insist(Array.isArray(value) && value.length<=max,'INVALID_INPUT',`Invalid ${name}.`); const output=value.map(v=>text(v,name,4096)); insist(new Set(output).size===output.length,'INVALID_INPUT',`Duplicate ${name}.`); return output; };
/** Trusted local orchestration. No Worker receives this service or its decision API.
 * User judgments classify meaning; they never manufacture merge/command observations. */
export class HostKnowledgeLifecycle {
  readonly options: KnowledgeLifecycleOptions;
  constructor(options: KnowledgeLifecycleOptions) {
    this.options=options;
    options.store.db.exec(`CREATE TABLE IF NOT EXISTS host_knowledge_origins(revision_id TEXT PRIMARY KEY,demand_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_knowledge_decisions(request_id TEXT PRIMARY KEY,demand_id TEXT NOT NULL,input_hash TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_remote_bindings(demand_id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_baseline_proposals(proposal_id TEXT PRIMARY KEY,demand_id TEXT NOT NULL,body TEXT NOT NULL);`);
  }
  private get db() { return this.options.store.db; }
  private current(input: LifecycleControl): Demand {
    const demand=this.options.store.getDemand(text(input.demandId,'demand',160));
    insist(demand.revision===revision(input.expectedVersion),'STALE_CONTROL','Refresh the demand before this knowledge or baseline decision.');
    return demand;
  }
  private table(name: string): boolean { return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
  private remote(demandId: string): GitHubReadOnlyAdapter {
    const row=this.db.prepare('SELECT body FROM host_remote_bindings WHERE demand_id=?').get(demandId);
    insist(row,'REMOTE_UNBOUND','Bind an exact GitHub pull request first.');
    return new GitHubReadOnlyAdapter({db:this.db,binding:JSON.parse(String(row.body)),transport:this.options.remoteTransport});
  }
  private artifactAuthor(demand: Demand, ref: ArtifactRef): string {
    this.options.evidence.read(demand.id,ref);
    const row=this.db.prepare('SELECT body FROM host_artifacts WHERE id=? AND demand_id=?').get(ref.id,demand.id);
    insist(row,'ARTIFACT_ORIGIN_MISSING','The exact artifact has no trusted origin.');
    const author=this.options.store.getRun(JSON.parse(String(row.body)).runId);
    insist(author.demandId===demand.id && author.stage==='implementation','ARTIFACT_ORIGIN_MISMATCH','Candidate origin must be an implementation run in this demand.');
    return author.id;
  }
  /** Source/Review identity comes from durable Host registries, never model booleans. */
  private result(demand: Demand, resultId: string): DeliveryResult {
    const result=demand.results.find(r=>r.id===resultId);
    insist(result && !demand.invalidatedContentIds.includes(result.contentId),'RESULT_UNAVAILABLE','This exact result is unavailable or invalidated.');
    const content=demand.contents.find(c=>c.id===result.contentId);
    insist(content && canonicalJson(content.code)===canonicalJson(result.K) && canonicalJson(content.knowledge)===canonicalJson(result.N),'RESULT_CHANGED','Result C/N differs from its immutable content.');
    const implementation=this.options.store.getRun(content.createdByRun), review=this.options.store.getRun(result.review.runId);
    insist(implementation.stage==='implementation' && review.stage==='review' && implementation.id!==review.id && implementation.contextId!==review.contextId && review.status==='stopped' && review.demandId===demand.id && review.contentId===content.id && result.review.contextId===review.contextId,'REVIEW_INDEPENDENCE_REQUIRED','An independently stopped Review must cover the exact submitted content.');
    this.options.evidence.requireOrigin(demand.id,result.K,implementation.id);
    this.options.evidence.requireOrigin(demand.id,result.review.evidence,review.id);
    const row=this.db.prepare('SELECT body FROM host_run_evidence WHERE run_id=?').get(review.id);
    insist(row,'REVIEW_INPUTS_MISSING','Independent Review input evidence is missing.');
    const context=JSON.parse(String(row.body));
    insist(context.role==='review' && context.contextId===review.contextId && context.source?.sha256===result.K.digest && Array.isArray(context.materials) && context.materials.every((m:any)=>!['implementation-session','implementation-summary'].includes(m.kind) && digest(m.content)===m.sha256),'REVIEW_INPUTS_CHANGED','Review source identity or isolated materials are unverified.');
    for(const ref of [result.K,...result.N]) {
      const material=this.options.evidence.read(demand.id,ref);
      if(ref!==result.K) {
        const author=this.options.store.getRun(this.artifactAuthor(demand,ref));
        insist(author.id!==review.id && author.contextId!==review.contextId,'REVIEW_INDEPENDENCE_REQUIRED','Review cannot independently verify its own candidate origin.');
      }
      insist(context.materials.some((m:any)=>canonicalJson(m)===canonicalJson(material)),'REVIEW_INPUTS_CHANGED','Review did not receive every exact C/N artifact.');
    }
    return result;
  }
  /** Called after production ticks; hypotheses remain local until a user classifies and verifies them. */
  captureResults(): void {
    for(const demand of this.options.store.listDemands()) for(const result of demand.results) {
      try { this.capture(demand,this.result(demand,result.id)); } catch { /* Display inspection reports missing trusted evidence; never promote it. */ }
    }
  }
  private capture(demand: Demand, result: DeliveryResult): void {
    for(const ref of result.N) {
      const revisionId=key('candidate',[demand.id,result.id,ref]);
      if(this.db.prepare('SELECT 1 FROM host_knowledge_origins WHERE revision_id=?').get(revisionId))continue;
      const material=this.options.evidence.read(demand.id,ref);
      insist(material.kind==='knowledge','INVALID_MATERIAL','Only the result’s knowledge artifacts become candidates.');
      this.options.knowledge.saveCandidate({revisionId,knowledgeId:key('knowledge',[demand.id,ref.id]),projectId:demand.projectId,demandId:demand.id,createdBy:this.artifactAuthor(demand,ref),title:ref.id,tags:[],body:material.content,sourceKind:'implementation',materialKind:'knowledge',statementKind:'hypothesis',formalTarget:this.options.workspace().getProject(demand.projectId).formalTarget,roles:['planner','implementer','reviewer'],modulePaths:[]});
      this.db.prepare('INSERT INTO host_knowledge_origins VALUES(?,?,?)').run(revisionId,demand.id,canonicalJson({revisionId,resultId:result.id,artifactId:ref.id}));
    }
  }
  private origin(demand: Demand, revisionId: string): { origin: CandidateOrigin; candidate: KnowledgeRevision; result: DeliveryResult } {
    const row=this.db.prepare('SELECT body FROM host_knowledge_origins WHERE revision_id=? AND demand_id=?').get(revisionId,demand.id);
    insist(row,'CANDIDATE_UNAVAILABLE','This demand does not own that candidate revision.');
    const origin:CandidateOrigin=JSON.parse(String(row.body));
    const revision=this.db.prepare('SELECT data FROM knowledge_revisions WHERE revision_id=? AND demand_id=?').get(revisionId,demand.id);
    insist(revision,'CANDIDATE_UNAVAILABLE','Candidate content is missing.');
    return {origin,candidate:JSON.parse(String(revision.data)),result:this.result(demand,origin.resultId)};
  }
  private source(demand: Demand, result: DeliveryResult): SourceSnapshot {
    const material=this.options.evidence.read(demand.id,result.K);
    insist(material.kind==='source','SOURCE_MISSING','The result has no trusted source snapshot.');
    const source=JSON.parse(material.content) as SourceSnapshot;
    insist(source.schemaVersion===1 && source.demandId===demand.id && source.head && Array.isArray(source.files),'SOURCE_UNCOMMITTED','Knowledge correspondence requires a committed immutable source snapshot.');
    return source;
  }
  private sourceTree(demand: Demand, result: DeliveryResult): string {
    const source=this.source(demand,result), workspace=this.options.workspace(), project=workspace.getProject(demand.projectId);
    const files=workspace.git.filesAt(project.anchorPath,source.head!);
    insist(canonicalJson(files.map(f=>f.path).sort())===canonicalJson(source.files.map(f=>f.path).sort()),'CONTENT_UNCOMMITTED','The reviewed source includes uncommitted or ignored files absent from its commit.');
    for(const file of source.files) insist(digest(workspace.git.readFile(project.anchorPath,source.head!,file.path))===file.sha256,'CONTENT_UNCOMMITTED','The reviewed bytes differ from the committed source.');
    return workspace.git.commitInfo(project.anchorPath,source.head!).tree;
  }
  private checks(demand: Demand, result: DeliveryResult, ids: string[]): { environment: string; refs: string[] } {
    insist(ids.length>0 && this.table('host_native_checks'),'CAPABILITY_UNVERIFIED','Select actual independent native checks for this exact result.');
    const environments=new Set<string>(), refs:string[]=[];
    for(const checkId of ids) {
      const check=result.E.find(c=>c.id===checkId);
      insist(check && check.status==='passed' && check.contentId===result.contentId,'CAPABILITY_UNVERIFIED','A selected check did not pass on this exact content.');
      const eligibleRuns=new Set(this.options.store.listRuns(demand.id).filter(run=>run.stage==='review' && run.contentId===result.contentId).map(run=>run.id));
      const row=this.db.prepare('SELECT body,domain_run_id FROM host_native_checks WHERE artifact_id=?').all(check.evidence.id).find(row=>eligibleRuns.has(String(row.domain_run_id)));
      insist(row,'CAPABILITY_UNVERIFIED','No native process observation supports the selected check.');
      const native=JSON.parse(String(row.body)) as NativeCheck;
      insist(native.provenance==='native-helper-command-observation' && native.reason==='exited' && native.exitCode===0,'MOCK_EVIDENCE','Only actual successful native observations can support production eligibility.');
      const run=this.options.store.getRun(String(row.domain_run_id));
      insist(run.stage==='review' && run.status==='stopped' && run.demandId===demand.id && run.contentId===result.contentId && run.id!==demand.contents.find(c=>c.id===result.contentId)!.createdByRun,'CHECK_INDEPENDENCE_REQUIRED','The capability check must come from an independently stopped Review.');
      const material=this.options.evidence.read(demand.id,check.evidence);
      this.options.evidence.requireOrigin(demand.id,check.evidence,run.id);
      insist(material.content===String(row.body) && native.sourceBefore===result.K.digest && native.sourceAfter===result.K.digest && native.environment===check.environment,'CHECK_CONTENT_CHANGED','The observed check source or environment differs from the immutable result.');
      const contextRow=this.db.prepare('SELECT body FROM host_run_evidence WHERE run_id=?').get(run.id);insist(contextRow,'CHECK_CONTEXT_MISSING','Check execution context is missing.');
      const context=JSON.parse(String(contextRow.body));
      insist(context.runtimeRunId===native.runtimeRunId && context.generation===native.generation && context.source.sha256===result.K.digest,'CHECK_GENERATION_MISMATCH','Check receipt belongs to a different execution generation.');
      environments.add(native.environment); refs.push(check.evidence.location);
    }
    insist(environments.size===1,'ENVIRONMENT_MISMATCH','Selected checks must use one exact observed environment.');
    return {environment:[...environments][0]!,refs};
  }
  async handle(raw: unknown): Promise<void> {
    const input=record(raw) as unknown as KnowledgeAction, requestId=text(input.requestId,'request',160), hash=digest(canonicalJson(input));
    const previous=this.db.prepare('SELECT input_hash FROM host_knowledge_decisions WHERE request_id=?').get(requestId);
    if(previous) { insist(previous.input_hash===hash,'IDEMPOTENCY_CONFLICT','Decision ID was reused for different input.'); return; }
    let demand=this.current(input);
    const workspace=this.options.workspace(), project=workspace.getProject(demand.projectId);
    if(input.action==='save-candidate') {
      const result=this.result(demand,text(input.resultId,'result',160));this.capture(demand,result);
      const artifact=result.N.find(n=>n.id===input.artifactId);insist(artifact,'MATERIAL_UNAVAILABLE','Select an exact N artifact from this result.');
      const roles=strings(input.roles,'roles',3) as KnowledgeRole[];insist(roles.length>0 && roles.every(r=>['planner','implementer','reviewer'].includes(r)),'INVALID_ROLE','Choose at least one explicit role.');
      const paths=strings(input.modulePaths,'module paths',128);paths.forEach(sourcePath);
      insist(['implementation','existing-fact','environment'].includes(input.sourceKind),'INVALID_SOURCE','Choose a supported source classification.');
      const parent=key('candidate',[demand.id,result.id,artifact]), revisionId=key('revision',[requestId,hash]);
      this.options.knowledge.saveCandidate({revisionId,knowledgeId:key('knowledge',[demand.id,artifact.id]),parentRevisionId:parent,projectId:demand.projectId,demandId:demand.id,createdBy:this.artifactAuthor(demand,artifact),title:text(input.title,'title',512),tags:strings(input.tags,'tags',64),body:this.options.evidence.read(demand.id,artifact).content,sourceKind:input.sourceKind,materialKind:'knowledge',statementKind:input.statementKind,formalTarget:project.formalTarget,roles,modulePaths:paths});
      this.db.prepare('INSERT OR IGNORE INTO host_knowledge_origins VALUES(?,?,?)').run(revisionId,demand.id,canonicalJson({revisionId,resultId:result.id,artifactId:artifact.id,sourceRevisionId:parent}));
    } else if(input.action==='bind-remote') {
      const binding:GitHubBinding={projectId:demand.projectId,demandId:demand.id,owner:text(input.owner,'GitHub owner',100),repository:text(input.repository,'GitHub repository',100),pullRequest:input.pullRequest,target:project.formalTarget};
      new GitHubReadOnlyAdapter({db:this.db,binding,transport:this.options.remoteTransport});
      const prior=this.db.prepare('SELECT body FROM host_remote_bindings WHERE demand_id=?').get(demand.id);
      insist(!prior || prior.body===canonicalJson(binding),'REMOTE_BINDING_CONFLICT','A demand’s pinned repository, pull request and target cannot silently change.');
      this.db.prepare('INSERT OR IGNORE INTO host_remote_bindings VALUES(?,?)').run(demand.id,canonicalJson(binding));
    } else if(input.action==='observe-remote') {
      await this.remote(demand.id).observe();demand=this.current(input);
    } else if(input.action==='qualify') {
      const {candidate,result}=this.origin(demand,text(input.revisionId,'revision',160)), baseline=oid(input.baseline);
      insist(input.reviewed===true && text(input.reason,'review decision',8000).length>0,'REVIEW_REQUIRED','Explicitly review source, reusable value, applicability, and absence of mixed private conclusions.');
      insist(candidate.statementKind!=='hypothesis','NOT_REUSABLE','Classify verified reusable material before eligibility review.');
      const actual=this.checks(demand,result,strings(input.checkIds,'checks',128)), source=this.source(demand,result), tree=this.sourceTree(demand,result);
      const formalHead=workspace.git.formalHead(project.anchorPath,project.formalTarget);
      insist(formalHead && workspace.git.isAncestor(project.anchorPath,baseline,formalHead),'BASELINE_UNVERIFIED','The selected baseline is not present in the bound local formal target.');
      insist(workspace.git.commitInfo(project.anchorPath,baseline).tree===tree,'CAPABILITY_UNVERIFIED','Capability checks must cover the exact full code tree of the selected reuse baseline. Recheck changed formal content independently.');
      let mergeObservationId:string|undefined, finalContentVerificationId:string|undefined;
      if(candidate.sourceKind==='implementation') {
        insist(demand.acceptances.filter(acceptance=>acceptance.resultId===result.id).at(-1)?.decision==='accepted','ACCEPTANCE_UNVERIFIED','Accept this exact immutable result before reviewing remote implementation correspondence.');
        const remote=this.remote(demand.id), observation=remote.observations().find(o=>o.observationId===input.observationId);
        insist(observation?.state==='merged' && observation.provenance==='github-live' && observation.formalCommit && observation.submittedCommit,'MERGE_UNVERIFIED','A genuine read-only GitHub merge observation is required.');
        insist(workspace.git.isAncestor(project.anchorPath,observation.formalCommit,baseline),'BASELINE_UNVERIFIED','The reuse baseline does not contain the observed formal result.');
        const correspondence=await remote.compareTrees(observation.observationId,tree);demand=this.current(input);
        insist(correspondence.contentCorresponds,'CONTENT_UNVERIFIED','Final and submitted remote trees differ from the independently reviewed accepted tree.');
        mergeObservationId=observation.observationId;finalContentVerificationId=key('verification',[requestId,hash]);
        remote.recordContentVerification({verificationId:finalContentVerificationId,observationId:observation.observationId,formalCommit:observation.formalCommit,acceptedCommit:source.head!,submittedCommit:observation.submittedCommit,contentCorresponds:true,capabilitiesVerified:true,acceptanceCoverage:'covered',revisionIds:[candidate.revisionId],checkedPaths:candidate.modulePaths.length?candidate.modulePaths:source.files.map(f=>f.path),evidenceRefs:[...actual.refs,correspondence.evidenceRef],reviewerId:result.review.runId});
      } else {
        insist(input.independentOfDemand===true,'SOURCE_UNVERIFIED','Existing or environment facts need an explicit independent-source review decision.');
        const binding=workspace.getBinding(demand.id);
        if(candidate.sourceKind==='existing-fact') insist(binding?.initialBaseline && workspace.git.isAncestor(project.anchorPath,baseline,binding.initialBaseline),'SOURCE_UNVERIFIED','Existing facts must be present in the verified formal baseline preceding this demand.');
        else insist(candidate.modulePaths.length===0,'ENVIRONMENT_UNVERIFIED','Code-dependent material must be classified as an implementation or existing fact.');
      }
      const evidenceId=key('source-evidence',[requestId,hash]), formalCommit=mergeObservationId?this.remote(demand.id).observations().find(o=>o.observationId===mergeObservationId)!.formalCommit!:baseline;
      this.options.knowledge.recordEvidence({evidenceId,revisionId:candidate.revisionId,reviewerId:result.review.runId,sourceKind:candidate.sourceKind,formalTarget:project.formalTarget,formalCommit,environment:actual.environment,sourceVerified:true,contentConsistent:true,worthReusing:true,applicabilityClear:true,mixedPrivateConclusions:false,independentOfDemand:input.independentOfDemand===true,evidenceRefs:[result.review.evidence.location,...actual.refs,`local-decision:${requestId}`],mergeObservationId,finalContentVerificationId});
      this.options.knowledge.registerEligibility({eligibilityId:key('eligibility',[requestId,hash]),revisionId:candidate.revisionId,evidenceId,formalTarget:project.formalTarget,baseline,environment:actual.environment,capabilityEvidenceRefs:actual.refs});
    } else if(input.action==='invalidate') {
      const {candidate}=this.origin(demand,text(input.revisionId,'revision',160));
      this.options.knowledge.invalidate({revisionId:candidate.revisionId,reason:text(input.reason,'invalidation reason',8000),evidenceRef:`local-decision:${requestId}`});
    } else if(input.action==='propose-baseline') {
      const sourceCommit=oid(input.sourceCommit), binding=workspace.getBinding(demand.id);
      insist(binding?.head,'WORKSPACE_MISSING','Prepare a committed demand worktree first.');
      const formal=workspace.git.formalHead(project.anchorPath,project.formalTarget);
      insist(formal && workspace.git.isAncestor(project.anchorPath,sourceCommit,formal),'BASELINE_UNVERIFIED','The proposal source must already be present in the bound local formal target.');
      const proposal:BaselineProposal={proposalId:key('baseline',[requestId,hash]),demandId:demand.id,formalTarget:project.formalTarget,sourceCommit,expectedHead:workspace.git.head(binding.worktreePath)!,expectedBaseline:binding.currentBaseline,createdAt:new Date().toISOString()};
      this.db.prepare('INSERT OR IGNORE INTO host_baseline_proposals VALUES(?,?,?)').run(proposal.proposalId,demand.id,canonicalJson(proposal));
    } else if(input.action==='apply-baseline') {
      const row=this.db.prepare('SELECT body FROM host_baseline_proposals WHERE proposal_id=? AND demand_id=?').get(text(input.proposalId,'proposal',160),demand.id);
      insist(row,'PROPOSAL_MISSING','Review an exact baseline proposal before authorizing integration.');
      const proposal=JSON.parse(String(row.body)) as BaselineProposal, binding=workspace.getBinding(demand.id);
      insist(demand.control==='active' && !demand.activeResultId && !['accepted','awaiting-acceptance'].includes(demand.phase) && this.options.stopped(demand.id),'UPDATE_PROTECTED','Baseline integration requires an active demand, no protected acceptance result, and verified stopped processes.');
      const recovering=this.db.prepare('SELECT 1 FROM workspace_intents WHERE operation_id=? AND kind=?').get(proposal.proposalId,'baseline');
      if(!recovering) insist(binding && workspace.git.head(binding.worktreePath)===proposal.expectedHead && binding.currentBaseline===proposal.expectedBaseline,'STALE_BASELINE','The proposal HEAD or baseline changed; prepare a new proposal.');
      const author=record(input.author), identity={name:text(author.name,'commit author',200),email:text(author.email,'commit email',320)};
      // Persist a workflow blocker before Git side effects so no queued run can start on unchecked integration.
      demand=this.options.workflow.blockDemand(demand.id,'BASELINE_VERIFICATION_REQUIRED',`Baseline operation ${proposal.proposalId} needs exact post-integration checks.`);
      if(demand.activeContentId && !demand.invalidatedContentIds.includes(demand.activeContentId))demand=this.options.workflow.invalidateCurrentContent(demand.id,`Explicit baseline integration ${proposal.proposalId} changes the prior reviewed content; revise the plan or produce a new authorized result before capability verification.`);
      proposal.result=workspace.updateBaseline({operationId:proposal.proposalId,demandId:demand.id,sourceCommit:proposal.sourceCommit,formalTarget:proposal.formalTarget,expectedHead:proposal.expectedHead,expectedBaseline:proposal.expectedBaseline,updateAuthorized:true,writerStopped:true,controlState:'active',author:identity});
      this.db.prepare('UPDATE host_baseline_proposals SET body=? WHERE proposal_id=?').run(canonicalJson(proposal),proposal.proposalId);
    } else if(input.action==='verify-baseline') {
      const row=this.db.prepare('SELECT body FROM host_baseline_proposals WHERE proposal_id=? AND demand_id=?').get(text(input.operationId,'operation',160),demand.id);
      insist(row,'PROPOSAL_MISSING','Baseline operation is unavailable.');const proposal=JSON.parse(String(row.body)) as BaselineProposal;
      insist(proposal.result?.state==='integrated-awaiting-verification' && proposal.result.head && this.options.stopped(demand.id),'UPDATE_INCOMPLETE','Complete integration and stop all processes before final verification.');
      const result=this.result(demand,text(input.resultId,'result',160)), source=this.source(demand,result), actual=this.checks(demand,result,strings(input.checkIds,'checks',128));
      insist(source.head===proposal.result.head,'CAPABILITY_UNVERIFIED','Post-integration checks must cover the actual integrated commit.');this.sourceTree(demand,result);
      proposal.result=workspace.verifyBaseline({operationId:proposal.proposalId,expectedHead:proposal.result.head,capabilitiesVerified:true,evidenceRefs:actual.refs});
      this.db.prepare('UPDATE host_baseline_proposals SET body=? WHERE proposal_id=?').run(canonicalJson(proposal),proposal.proposalId);
    } else throw new Error('Unsupported knowledge lifecycle action.');
    this.options.store.transaction(()=>{
      const latest=this.options.store.getDemand(demand.id);
      insist(latest.revision===demand.revision,'STALE_CONTROL','Demand changed while this decision was being verified.');
      this.db.prepare('INSERT INTO host_knowledge_decisions VALUES(?,?,?,?)').run(requestId,demand.id,hash,canonicalJson({...input,decisionBy:'local-desktop-owner',createdAt:new Date().toISOString()}));
      latest.revision++;this.options.store.saveDemand(latest);
    });
  }
  snapshot(demandId: string): KnowledgeLifecycleView {
    const demand=this.options.store.getDemand(demandId), blockers:string[]=[];
    const output:KnowledgeLifecycleView={candidates:[],resultMaterials:[],checks:[],observations:[],proposals:[],blockers};
    for(const result of demand.results) {
      for(const artifact of result.N)output.resultMaterials.push({resultId:result.id,artifactId:artifact.id,title:artifact.id,accepted:demand.acceptances.some(a=>a.resultId===result.id && a.decision==='accepted')});
      for(const check of result.E) {let usable=false;try {this.checks(demand,result,[check.id]);usable=true;} catch {}output.checks.push({id:check.id,resultId:result.id,name:demand.plans.find(p=>p.id===result.P)?.requiredChecks.find(r=>r.id===check.requirementId)?.name??check.requirementId,environment:check.environment,usable});}
    }
    for(const row of this.db.prepare('SELECT k.data,o.body FROM knowledge_revisions k JOIN host_knowledge_origins o ON o.revision_id=k.revision_id WHERE o.demand_id=?').all(demandId)) {
      const candidate=JSON.parse(String(row.data)) as KnowledgeRevision, origin=JSON.parse(String(row.body)) as CandidateOrigin;
      const invalid=!!this.db.prepare('SELECT 1 FROM knowledge_invalidations WHERE revision_id=?').get(candidate.revisionId), eligible=!!this.db.prepare('SELECT 1 FROM knowledge_eligibility WHERE revision_id=? AND active=1').get(candidate.revisionId);
      let body='';try {body=this.options.evidence.read(demand.id,demand.results.find(r=>r.id===origin.resultId)!.N.find(n=>n.id===origin.artifactId)!).content;}catch{blockers.push(`Candidate ${candidate.revisionId} content is unavailable.`);}
      output.candidates.push({revisionId:candidate.revisionId,artifactId:origin.artifactId,resultId:origin.resultId,title:candidate.title,sourceKind:candidate.sourceKind,statementKind:candidate.statementKind,status:invalid?'ineligible':eligible?'verified':'candidate',body,roles:candidate.roles,modulePaths:candidate.modulePaths});
    }
    const remote=this.db.prepare('SELECT body FROM host_remote_bindings WHERE demand_id=?').get(demandId);
    if(remote) {output.remote=JSON.parse(String(remote.body));output.observations=this.remote(demandId).observations();}
    try {
      const workspace=this.options.workspace(), binding=workspace.getBinding(demandId);
      if(binding) output.baseline={initial:binding.initialBaseline,current:binding.currentBaseline,head:binding.head,formalTarget:workspace.getProject(demand.projectId).formalTarget};
    } catch { blockers.push('Workspace inspection is unavailable; ideas and saved local decisions remain accessible.'); }
    output.proposals=this.db.prepare('SELECT body FROM host_baseline_proposals WHERE demand_id=?').all(demandId).map(row=>JSON.parse(String(row.body)));
    if(output.candidates.length && !output.checks.some(check=>check.usable))blockers.push('No genuine native capability check has been verified. Candidate material remains local.');
    return output;
  }
}
