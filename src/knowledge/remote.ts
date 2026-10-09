import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../workspace/objects.ts';
import { id, insist, sourcePath } from '../workspace/paths.ts';

export interface GitHubBinding { projectId:string; demandId:string; owner:string; repository:string; pullRequest:number; target:string }
export interface RemoteObservation {
  observationId:string; projectId:string; demandId:string; observedAt:string; provenance:'github-live'|'controlled-response';
  owner:string; repository:string; pullRequest:number; target:string; state:'unknown'|'open'|'closed-unmerged'|'wrong-target'|'merged';
  formalCommit:string|null; targetCommit:string|null; submittedCommit:string|null; url:string; problem?:string;
}
export interface ReadResponse { status:number; body:unknown }
export type ReadOnlyTransport=(request:{method:'GET';url:string;signal:AbortSignal})=>Promise<ReadResponse>;
export interface ContentVerification {
  verificationId:string; observationId:string; formalCommit:string; acceptedCommit:string; submittedCommit:string;
  contentCorresponds:boolean; capabilitiesVerified:boolean; acceptanceCoverage:'covered'|'gap'|'unknown';
  revisionIds:string[]; checkedPaths:string[]; evidenceRefs:string[]; reviewerId:string;
}
/** Fixed GitHub repository/PR/target only. No credentials, arbitrary URLs, or write methods in this API. */
export class GitHubReadOnlyAdapter {
  readonly binding:GitHubBinding;private db:DatabaseSync;private transport:ReadOnlyTransport;private provenance:'github-live'|'controlled-response';private timeoutMs:number;
  constructor(options:{db:DatabaseSync;binding:GitHubBinding;transport?:ReadOnlyTransport;timeoutMs?:number}) {
    const b=options.binding;id(b.projectId);id(b.demandId);
    insist(/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(b.owner) && /^[A-Za-z0-9_.-]{1,100}$/.test(b.repository) && !['.','..'].includes(b.repository),'INVALID_REMOTE','A concrete GitHub owner and repository are required.');
    insist(Number.isSafeInteger(b.pullRequest) && b.pullRequest>0 && /^[A-Za-z0-9][A-Za-z0-9/_-]{0,150}$/.test(b.target),'INVALID_REMOTE','Pin a pull request and formal target.');
    this.binding=Object.freeze({...b});this.db=options.db;this.timeoutMs=options.timeoutMs??10000;
    insist(this.timeoutMs>0 && this.timeoutMs<=30000,'INVALID_LIMIT','Remote reads require a bounded timeout.');
    this.provenance=options.transport?'controlled-response':'github-live';
    this.transport=options.transport??(async request=>{
      const response=await fetch(request.url,{method:'GET',headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},redirect:'error',signal:request.signal});
      // Bounded streaming read prevents an unexpectedly large response from being loaded first.
      const reader=response.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
      if(reader)while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;insist(size<=2*1024*1024,'REMOTE_TOO_LARGE','Remote response exceeds 2 MiB.');chunks.push(chunk.value);}
      const body=Buffer.concat(chunks).toString();return {status:response.status,body:body?JSON.parse(body):null};
    });
    this.db.exec(`CREATE TABLE IF NOT EXISTS workspace_remote_observations(observation_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,demand_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_content_verifications(verification_id TEXT PRIMARY KEY,observation_id TEXT NOT NULL,data TEXT NOT NULL);`);
  }
  private async get(suffix:string):Promise<any> {
    const b=this.binding;const url=`https://api.github.com/repos/${encodeURIComponent(b.owner)}/${encodeURIComponent(b.repository)}${suffix}`;
    const response=await this.transport({method:'GET',url,signal:AbortSignal.timeout(this.timeoutMs)});
    insist(response.status===200,'REMOTE_UNAVAILABLE',`Read-only remote returned HTTP ${response.status}.`);return response.body;
  }
  async observe():Promise<RemoteObservation> {
    const b=this.binding;const observation:RemoteObservation={...b,observationId:randomUUID(),observedAt:new Date().toISOString(),provenance:this.provenance,state:'unknown',formalCommit:null,targetCommit:null,submittedCommit:null,url:`https://github.com/${b.owner}/${b.repository}/pull/${b.pullRequest}`};
    try {
      const pr=await this.get(`/pulls/${b.pullRequest}`);const repository=`${b.owner}/${b.repository}`.toLowerCase();
      insist(pr.number===b.pullRequest && pr.base?.repo?.full_name?.toLowerCase()===repository && pr.html_url?.toLowerCase()===observation.url.toLowerCase(),'REMOTE_IDENTITY','Remote response identity does not match the pinned pull request.');
      if(pr.base?.ref!==b.target){observation.state='wrong-target';observation.problem='Pull request targets another branch.';}
      else if(pr.merged===true) {
        insist(pr.state==='closed' && typeof pr.merged_at==='string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(pr.merge_commit_sha),'REMOTE_INCOMPLETE','Merged response lacks a verifiable final commit.');
        const formal=await this.get(`/commits/${pr.merge_commit_sha}`);
        insist(formal.sha===pr.merge_commit_sha,'REMOTE_IDENTITY','Final commit response does not match the observed merge.');
        const target=await this.get(`/commits/${encodeURIComponent(b.target)}`);
        insist(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(target.sha),'REMOTE_INCOMPLETE','Formal target version is missing.');
        const comparison=await this.get(`/compare/${pr.merge_commit_sha}...${target.sha}`);
        insist(['ahead','identical'].includes(comparison.status) && comparison.merge_base_commit?.sha===pr.merge_commit_sha,'REMOTE_CORRESPONDENCE','Observed merge is not verified in the current formal target.');
        observation.state='merged';observation.formalCommit=pr.merge_commit_sha;observation.targetCommit=target.sha;
      } else if(pr.merged===false && pr.state==='closed')observation.state='closed-unmerged';
      else if(pr.merged===false && pr.state==='open')observation.state='open';
      else throw new Error('Unrecognized remote state.');
      if(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(pr.head?.sha??''))observation.submittedCommit=pr.head.sha;
    } catch(error:any){observation.state='unknown';observation.problem=error.code??'REMOTE_UNAVAILABLE';}
    this.db.prepare('INSERT INTO workspace_remote_observations VALUES(?,?,?,?)').run(observation.observationId,b.projectId,b.demandId,canonicalJson(observation));return observation;
  }
  observations():RemoteObservation[] {
    return (this.db.prepare('SELECT data FROM workspace_remote_observations WHERE project_id=? AND demand_id=? ORDER BY rowid').all(this.binding.projectId,this.binding.demandId) as any[]).map(r=>JSON.parse(r.data));
  }
  /** Real immutable Git tree identities establish byte/mode/path correspondence,
   * including squash/rebase commits. Matching ancestry alone is insufficient. */
  async compareTrees(observationId:string,acceptedTree:string):Promise<{contentCorresponds:boolean;formalTree:string;submittedTree:string;evidenceRef:string}> {
    insist(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(acceptedTree),'INVALID_TREE','Use the exact independently reviewed Git tree.');
    const observation=this.observations().find(o=>o.observationId===observationId);
    insist(observation?.state==='merged' && observation.formalCommit && observation.submittedCommit,'MERGE_UNVERIFIED','A matching merged observation is required.');
    const [formal,submitted]=await Promise.all([this.get(`/git/commits/${observation.formalCommit}`),this.get(`/git/commits/${observation.submittedCommit}`)]);
    insist(formal.sha===observation.formalCommit && submitted.sha===observation.submittedCommit,'REMOTE_IDENTITY','Remote content identities differ from the pinned observed commits.');
    for(const response of [formal,submitted])insist(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(response.tree?.sha??''),'REMOTE_INCOMPLETE','Remote commit tree identity is missing.');
    const result={contentCorresponds:formal.tree.sha===acceptedTree && submitted.tree.sha===acceptedTree,formalTree:formal.tree.sha,submittedTree:submitted.tree.sha,evidenceRef:`github-tree:${observationId}:${formal.tree.sha}:${submitted.tree.sha}:${acceptedTree}`};
    this.db.exec('CREATE TABLE IF NOT EXISTS workspace_tree_correspondence(evidence_ref TEXT PRIMARY KEY,observation_id TEXT NOT NULL,data TEXT NOT NULL)');
    this.db.prepare('INSERT OR IGNORE INTO workspace_tree_correspondence VALUES(?,?,?)').run(result.evidenceRef,observationId,canonicalJson({...result,acceptedTree,provenance:this.provenance,observedAt:new Date().toISOString()}));
    return result;
  }
  /** Independent Q evidence; neither merged=true nor matching SHAs supplies semantic correspondence. */
  recordContentVerification(input:ContentVerification):void {
    id(input.verificationId);id(input.reviewerId);
    for(const commit of [input.formalCommit,input.acceptedCommit,input.submittedCommit])insist(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit),'INVALID_COMMIT','Content verification requires exact code identities.');
    const row=this.db.prepare('SELECT data FROM workspace_remote_observations WHERE observation_id=? AND project_id=? AND demand_id=?').get(input.observationId,this.binding.projectId,this.binding.demandId) as any;
    insist(row,'OBSERVATION_MISSING','A matching read-only observation is required.');const o:RemoteObservation=JSON.parse(row.data);
    insist(o.state==='merged' && o.formalCommit===input.formalCommit && o.submittedCommit===input.submittedCommit,'CONTENT_UNVERIFIED','Content verification targets do not match the observed merge and submission.');
    insist(input.evidenceRefs.length>0 && input.checkedPaths.length>0,'EVIDENCE_MISSING','Actual scoped content and capability checks are required.');
    for(const path of input.checkedPaths)sourcePath(path);
    const old=this.db.prepare('SELECT data FROM workspace_content_verifications WHERE verification_id=?').get(input.verificationId) as any;
    if(old){insist(old.data===canonicalJson(input),'VERIFICATION_CONFLICT','Content verification is immutable.');return;}
    this.db.prepare('INSERT INTO workspace_content_verifications VALUES(?,?,?)').run(input.verificationId,input.observationId,canonicalJson(input));
  }
}
