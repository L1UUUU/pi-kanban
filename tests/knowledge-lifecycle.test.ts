import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchStore, WorkflowService } from '../src/domain/index.ts';
import type { RunAttempt, DeliveryResult } from '../src/domain/types.ts';
import { WorkspaceService, ImmutableObjectStore, canonicalJson } from '../src/workspace/index.ts';
import { KnowledgeService } from '../src/knowledge/index.ts';
import { GitHubReadOnlyAdapter } from '../src/knowledge/remote.ts';
import { ProductionEvidence } from '../src/host/evidence.ts';
import { HostKnowledgeLifecycle } from '../src/host/knowledge-lifecycle.ts';
import type { KnowledgeAction } from '../src/host/knowledge-lifecycle.ts';
const gitExecutable=process.env.PI_KANBAN_TEST_GIT??'/usr/bin/git';
const git=(cwd:string,...args:string[])=>execFileSync(gitExecutable,args,{cwd,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_COMMITTER_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_EMAIL:'fixture@example.invalid'},stdio:['ignore','pipe','pipe']}).trim();
function fixture(t:test.TestContext) {
  const root=mkdtempSync(join(tmpdir(),'pi-lifecycle-')), repo=join(root,'repo');mkdirSync(repo);
  git(repo,'init','-b','main');writeFileSync(join(repo,'code.txt'),'reviewed existing capability\n');git(repo,'add','code.txt');git(repo,'commit','-m','Synthetic fixture');
  const base=git(repo,'rev-parse','HEAD'), store=new WorkbenchStore(), workflow=new WorkflowService(store), workspace=new WorkspaceService({db:store.db,gitExecutable});
  const method={id:'fixture',version:'1',digest:'a'.repeat(64),adapter:'fixture'};
  workflow.createProject({id:'project',name:'Synthetic',rootPath:repo,methods:{planning:method,implementation:method,review:method}});
  workflow.createDemand({id:'demand',projectId:'project',title:'Synthetic lifecycle'});
  workspace.bindProject({projectId:'project',anchorPath:repo,formalTarget:'main'});
  const binding=workspace.prepare({operationId:'prepare',projectId:'project',demandId:'demand',worktreePath:join(root,'work'),branch:'demand/work',baseline:base,prepareAuthorized:true});
  const knowledge=new KnowledgeService({db:store.db,resolveStore:()=>ImmutableObjectStore.open(repo,'project')}), evidence=new ProductionEvidence(store.db,()=>workspace);
  const run=(id:string,stage:'implementation'|'review'):RunAttempt=>({id,demandId:'demand',stage,generation:stage==='implementation'?1:2,contextId:`context-${id}`,planId:'plan',contentId:stage==='review'?'content':undefined,cycle:0,status:'stopped',writer:stage==='implementation',highResource:false,method,contextSources:[],createdAt:new Date().toISOString()});
  const author=run('author','implementation'), reviewer=run('reviewer','review');store.saveRun(author);store.saveRun(reviewer);
  const code=evidence.saveSource('project','demand',author.id,'code'), note=evidence.save({id:'note',projectId:'project',demandId:'demand',runId:author.id,kind:'knowledge',text:'code.txt contains a verified existing capability.'}), review=evidence.save({id:'review',projectId:'project',demandId:'demand',runId:reviewer.id,kind:'check-evidence',text:'Synthetic independent review context.'});
  evidence.recordRun(reviewer,{role:'review',source:evidence.sourceMaterial('demand'),materials:[evidence.read('demand',code),evidence.read('demand',note)],sessionId:'independent-session',runtimeRunId:'native-review',generation:'native-generation'});
  const result:DeliveryResult={id:'result',demandId:'demand',P:'plan',K:code,N:[note],E:[],review:{id:'review-record',contentId:'content',runId:'reviewer',contextId:reviewer.contextId,evidence:review,knowledgeReviewed:true,findings:[]},findingClosures:[],notes:'Synthetic submitted result',contentId:'content',createdAt:new Date().toISOString()};
  const d=store.getDemand('demand');d.contents=[{id:'content',planId:'plan',code,knowledge:[note],maintenance:'complete',deliveryNotes:'Fixture',createdByRun:'author',cycle:0}];d.results=[result];d.activeResultId=result.id;d.activeContentId='content';d.phase='awaiting-acceptance';store.saveDemand(d);
  let stopped=true;
  const remoteCalls:string[]=[];
  const lifecycle=new HostKnowledgeLifecycle({store,workflow,knowledge,workspace:()=>workspace,evidence,stopped:()=>stopped,remoteTransport:async request=>{
    remoteCalls.push(request.url);if(request.url.includes('/pulls/'))return {status:200,body:{number:7,html_url:'https://github.com/fixture/repo/pull/7',base:{ref:'main',repo:{full_name:'fixture/repo'}},head:{sha:base},state:'closed',merged:true,merged_at:'2026-10-08T00:00:00Z',merge_commit_sha:base}};
    if(request.url.includes('/compare/'))return {status:200,body:{status:'identical',merge_base_commit:{sha:base}}};
    return {status:200,body:{sha:base,tree:{sha:git(repo,'rev-parse',`${base}^{tree}`)}}};
  }});
  let counter=0;
  const action=(input:Omit<KnowledgeAction,'demandId'|'expectedVersion'|'requestId'>|Record<string,unknown>)=>lifecycle.handle({demandId:'demand',expectedVersion:store.getDemand('demand').revision,requestId:`decision-${++counter}`,...input});
  const classify=async (sourceKind='existing-fact')=>{await action({action:'save-candidate',resultId:'result',artifactId:'note',title:'Existing capability',sourceKind,statementKind:'fact',roles:['planner','implementer','reviewer'],modulePaths:sourceKind==='environment'?[]:['code.txt'],tags:['capability']});return lifecycle.snapshot('demand').candidates.find(c=>c.statementKind==='fact')!.revisionId;};
  // Controlled Host registry fixture, not an observed Windows execution. Happy-path
  // unit tests exercise attestation consumption, never claim external acceptance.
  function check(provenance='native-helper-command-observation',overrides:Record<string,unknown>={}) {
    store.db.exec('CREATE TABLE IF NOT EXISTS host_native_checks(request_id TEXT PRIMARY KEY,runtime_run_id TEXT NOT NULL,domain_run_id TEXT NOT NULL,artifact_id TEXT NOT NULL,body TEXT NOT NULL)');
    const observed={provenance,requestId:'check-request',runtimeRunId:'native-review',generation:'native-generation',sourceBefore:code.digest,sourceAfter:code.digest,environment:'fixture-native-environment',reason:'exited',exitCode:0,...overrides};
    const ref=evidence.save({id:'check-artifact',projectId:'project',demandId:'demand',runId:'reviewer',kind:'check-evidence',text:canonicalJson(observed)});
    store.db.prepare('INSERT INTO host_native_checks VALUES(?,?,?,?,?)').run('check-request','native-review','reviewer',ref.id,canonicalJson(observed));
    const latest=store.getDemand('demand');latest.results[0]!.E.push({id:'check',contentId:'content',requirementId:'capability',status:'passed',evidence:ref,environment:'fixture-native-environment'});store.saveDemand(latest);
  }
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  return {root,repo,base,store,workflow,workspace,knowledge,evidence,lifecycle,binding,action,classify,check,remoteCalls,setStopped:(v:boolean)=>{stopped=v;}};
}
test('submitted C/N plus independent exact Review saves local immutable hypotheses automatically',t=>{
  const f=fixture(t);f.lifecycle.captureResults();f.lifecycle.captureResults();
  const view=f.lifecycle.snapshot('demand');assert.equal(view.candidates.length,1);assert.equal(view.candidates[0]!.statementKind,'hypothesis');assert.equal(view.candidates[0]!.status,'candidate');
  const context=f.knowledge.createContext({runId:'other',projectId:'project',demandId:'other',role:'planner',formalTarget:'main',baseline:f.base,environment:'fixture-native-environment',allowedRevisionIds:[view.candidates[0]!.revisionId],purpose:'No leakage'});assert.deepEqual(context.revisionIds,[]);
});
test('missing independent Review inputs cannot register candidate, even with knowledgeReviewed true',async t=>{
  const f=fixture(t);f.store.db.prepare('DELETE FROM host_run_evidence WHERE run_id=?').run('reviewer');f.lifecycle.captureResults();assert.equal(f.lifecycle.snapshot('demand').candidates.length,0);
  await assert.rejects(f.classify(),/input evidence is missing/);
});
test('explicit classification preserves original and requires current demand revision and exact artifact',async t=>{
  const f=fixture(t), id=await f.classify();const view=f.lifecycle.snapshot('demand');assert.equal(view.candidates.length,2);assert.ok(view.candidates.some(c=>c.revisionId===id));
  await assert.rejects(f.lifecycle.handle({action:'invalidate',demandId:'demand',expectedVersion:0,requestId:'stale',revisionId:id,reason:'stale'}),/Refresh the demand/);
  await assert.rejects(f.action({action:'save-candidate',resultId:'result',artifactId:'wrong',title:'wrong',sourceKind:'existing-fact',statementKind:'fact',roles:['planner'],modulePaths:[],tags:[]}),/exact N artifact/);
  assert.equal(f.lifecycle.snapshot('demand').candidates.length,2);
});
test('worker booleans and synthetic receipt labels cannot qualify knowledge',async t=>{
  const f=fixture(t), revisionId=await f.classify();
  await assert.rejects(f.action({action:'qualify',revisionId,baseline:f.base,checkIds:['invented'],reviewed:true,independentOfDemand:true,reason:'Reviewed'}),/actual independent native checks/);
  f.check('synthetic-native-receipt');
  await assert.rejects(f.action({action:'qualify',revisionId,baseline:f.base,checkIds:['check'],reviewed:true,independentOfDemand:true,reason:'Reviewed'}),/actual successful native observations/);
  assert.equal(f.lifecycle.snapshot('demand').checks[0]!.usable,false);
});
test('trusted registry composition qualifies only exact independently checked existing baseline/environment',async t=>{
  const f=fixture(t), revisionId=await f.classify();f.check();
  await f.action({action:'qualify',revisionId,baseline:f.base,checkIds:['check'],reviewed:true,independentOfDemand:true,reason:'Existing source, reusable meaning, scope and absence of mixed conclusions reviewed.'});
  assert.equal(f.lifecycle.snapshot('demand').candidates.find(c=>c.revisionId===revisionId)!.status,'verified');
  const context=f.knowledge.createContext({runId:'subsequent',projectId:'project',demandId:'other',role:'planner',formalTarget:'main',baseline:f.base,environment:'fixture-native-environment',allowedRevisionIds:[revisionId],purpose:'Controlled registry fixture'});assert.deepEqual(context.revisionIds,[revisionId]);
  const wrong=f.knowledge.createContext({runId:'wrong-environment',projectId:'project',demandId:'other',role:'planner',formalTarget:'main',baseline:f.base,environment:'other',allowedRevisionIds:[revisionId],purpose:'Reject wrong environment'});assert.deepEqual(wrong.revisionIds,[]);
  await f.action({action:'invalidate',revisionId,reason:'Capability no longer valid'});assert.throws(()=>f.knowledge.read(context.contextId,revisionId),/unavailable/);
});
test('exact-source and native-generation mismatch reject trusted-record fixtures',async t=>{
  const f=fixture(t), revisionId=await f.classify();f.check('native-helper-command-observation',{generation:'wrong-generation'});
  await assert.rejects(f.action({action:'qualify',revisionId,baseline:f.base,checkIds:['check'],reviewed:true,independentOfDemand:true,reason:'Reviewed'}),/execution generation/);
});
test('a later formal capability removal cannot inherit an earlier successful check',async t=>{
  const f=fixture(t), revisionId=await f.classify();f.check();writeFileSync(join(f.repo,'code.txt'),'removed capability');git(f.repo,'add','code.txt');git(f.repo,'commit','-m','Synthetic removal');const later=git(f.repo,'rev-parse','HEAD');
  await assert.rejects(f.action({action:'qualify',revisionId,baseline:later,checkIds:['check'],reviewed:true,independentOfDemand:true,reason:'Reviewed'}),/exact full code tree/);
});
test('implementation requires exact user acceptance and controlled GitHub observations never become live',async t=>{
  const f=fixture(t), revisionId=await f.classify('implementation');f.check();await f.action({action:'bind-remote',owner:'fixture',repository:'repo',pullRequest:7});await f.action({action:'observe-remote'});
  const observationId=f.lifecycle.snapshot('demand').observations[0]!.observationId;
  assert.equal(f.remoteCalls.length,4);assert.ok(f.remoteCalls.every(url=>url.startsWith('https://api.github.com/repos/fixture/repo/')));
  await assert.rejects(f.action({action:'qualify',revisionId,baseline:f.base,observationId,checkIds:['check'],reviewed:true,independentOfDemand:false,reason:'Reviewed'}),/Accept this exact immutable result/);
  const demand=f.store.getDemand('demand');demand.acceptances.push({resultId:'result',decision:'accepted',userId:'owner',createdAt:new Date().toISOString()});f.store.saveDemand(demand);
  await assert.rejects(f.action({action:'qualify',revisionId,baseline:f.base,observationId,checkIds:['check'],reviewed:true,independentOfDemand:false,reason:'Reviewed'}),/genuine read-only GitHub/);
});
test('tree correspondence proves paths/modes/bytes for squash identity and rejects changed final tree',async t=>{
  const f=fixture(t), tree=git(f.repo,'rev-parse',`${f.base}^{tree}`);let changed=false;const submitted='2'.repeat(40);
  const remote=new GitHubReadOnlyAdapter({db:f.store.db,binding:{projectId:'project',demandId:'demand',owner:'fixture',repository:'repo',pullRequest:7,target:'main'},transport:async req=>{
    if(req.url.includes('/pulls/'))return {status:200,body:{number:7,html_url:'https://github.com/fixture/repo/pull/7',base:{ref:'main',repo:{full_name:'fixture/repo'}},head:{sha:submitted},state:'closed',merged:true,merged_at:'2026-10-08T00:00:00Z',merge_commit_sha:f.base}};
    if(req.url.includes('/compare/'))return {status:200,body:{status:'identical',merge_base_commit:{sha:f.base}}};
    return {status:200,body:{sha:req.url.endsWith(submitted)?submitted:f.base,tree:{sha:changed && !req.url.endsWith(submitted)?'3'.repeat(40):tree}}};
  }});
  const observation=await remote.observe();assert.equal((await remote.compareTrees(observation.observationId,tree)).contentCorresponds,true);changed=true;assert.equal((await remote.compareTrees(observation.observationId,tree)).contentCorresponds,false);
});
test('baseline proposal protects accepted results and exact HEAD; integration keeps old eligibility baseline pending checks',async t=>{
  const f=fixture(t);writeFileSync(join(f.repo,'new.txt'),'formal addition');git(f.repo,'add','new.txt');git(f.repo,'commit','-m','Synthetic formal advance');const source=git(f.repo,'rev-parse','HEAD');
  await f.action({action:'propose-baseline',sourceCommit:source});const proposal=f.lifecycle.snapshot('demand').proposals[0]!;
  const apply={action:'apply-baseline',proposalId:proposal.proposalId,author:{name:'Fixture',email:'fixture@example.invalid'}};
  await assert.rejects(f.action(apply),/no protected acceptance result/);
  const demand=f.store.getDemand('demand');demand.activeResultId=undefined;demand.activeContentId=undefined;demand.phase='rework';f.store.saveDemand(demand);
  f.setStopped(false);await assert.rejects(f.action(apply),/verified stopped/);f.setStopped(true);
  await f.action(apply);assert.equal(readFileSync(join(f.binding.worktreePath,'new.txt'),'utf8'),'formal addition');assert.equal(f.workspace.getBinding('demand')!.currentBaseline,f.base);
  assert.equal(f.lifecycle.snapshot('demand').proposals[0]!.result!.state,'integrated-awaiting-verification');assert.ok(f.store.getDemand('demand').blockedReasons.some(reason=>reason.includes('BASELINE_VERIFICATION_REQUIRED')));
  await assert.rejects(f.action({action:'verify-baseline',operationId:proposal.proposalId,resultId:'result',checkIds:[]}),/actual independent native checks/);
});
test('snapshot remains usable without configured Git and without a project binding',t=>{
  const f=fixture(t);const app=new HostKnowledgeLifecycle({store:f.store,workflow:f.workflow,knowledge:f.knowledge,workspace:()=>{throw new Error('Missing Windows Git');},evidence:f.evidence,stopped:()=>true});
  assert.ok(app.snapshot('demand').blockers.some(item=>item.includes('Workspace inspection')));
});
test('same lifecycle decision is idempotent while reused request contents are rejected',async t=>{
  const f=fixture(t), input={action:'bind-remote',demandId:'demand',expectedVersion:f.store.getDemand('demand').revision,requestId:'idempotent',owner:'fixture',repository:'repo',pullRequest:7};
  await f.lifecycle.handle(input);const version=f.store.getDemand('demand').revision;await f.lifecycle.handle(input);assert.equal(f.store.getDemand('demand').revision,version);
  await assert.rejects(f.lifecycle.handle({...input,pullRequest:8}),/reused for different input/);
});
test('baseline apply rejects a stale exact HEAD without overwriting intervening local work',async t=>{
  const f=fixture(t);await f.action({action:'propose-baseline',sourceCommit:f.base});const proposal=f.lifecycle.snapshot('demand').proposals[0]!;
  const demand=f.store.getDemand('demand');demand.activeResultId=undefined;demand.activeContentId=undefined;demand.phase='rework';f.store.saveDemand(demand);
  writeFileSync(join(f.binding.worktreePath,'code.txt'),'intervening local change');git(f.binding.worktreePath,'add','code.txt');git(f.binding.worktreePath,'commit','-m','Intervening synthetic change');
  await assert.rejects(f.action({action:'apply-baseline',proposalId:proposal.proposalId,author:{name:'Fixture',email:'fixture@example.invalid'}}),/proposal HEAD or baseline changed/);
  assert.equal(readFileSync(join(f.binding.worktreePath,'code.txt'),'utf8'),'intervening local change');
});
test('baseline verification consumes a new independent exact integrated result and preserves original baseline',async t=>{
  const f=fixture(t);writeFileSync(join(f.repo,'new.txt'),'formal capability');git(f.repo,'add','new.txt');git(f.repo,'commit','-m','Formal fixture');const source=git(f.repo,'rev-parse','HEAD');
  await f.action({action:'propose-baseline',sourceCommit:source});const proposal=f.lifecycle.snapshot('demand').proposals[0]!;
  const before=f.store.getDemand('demand');before.activeResultId=undefined;before.activeContentId=undefined;before.phase='rework';f.store.saveDemand(before);
  await f.action({action:'apply-baseline',proposalId:proposal.proposalId,author:{name:'Fixture',email:'fixture@example.invalid'}});
  const author={...f.store.getRun('author'),id:'author2',contextId:'author-context-2',generation:3}, reviewer={...f.store.getRun('reviewer'),id:'reviewer2',contextId:'review-context-2',generation:4,contentId:'content2'};f.store.saveRun(author);f.store.saveRun(reviewer);
  const code=f.evidence.saveSource('project','demand',author.id,'code2'), note=f.store.getDemand('demand').results[0]!.N[0]!, review=f.evidence.save({id:'review2',projectId:'project',demandId:'demand',runId:reviewer.id,kind:'check-evidence',text:'Synthetic post-integration independent Review'});
  f.evidence.recordRun(reviewer,{role:'review',source:f.evidence.sourceMaterial('demand'),materials:[f.evidence.read('demand',code),f.evidence.read('demand',note)],sessionId:'session2',runtimeRunId:'native2',generation:'native-generation-2'});
  f.store.db.exec('CREATE TABLE host_native_checks(request_id TEXT PRIMARY KEY,runtime_run_id TEXT NOT NULL,domain_run_id TEXT NOT NULL,artifact_id TEXT NOT NULL,body TEXT NOT NULL)');
  const observed={provenance:'native-helper-command-observation',requestId:'check2',runtimeRunId:'native2',generation:'native-generation-2',sourceBefore:code.digest,sourceAfter:code.digest,environment:'fixture-native-environment',reason:'exited',exitCode:0};
  const check=f.evidence.save({id:'check2',projectId:'project',demandId:'demand',runId:reviewer.id,kind:'check-evidence',text:canonicalJson(observed)});f.store.db.prepare('INSERT INTO host_native_checks VALUES(?,?,?,?,?)').run('check2','native2','reviewer2',check.id,canonicalJson(observed));
  const demand=f.store.getDemand('demand');demand.contents.push({id:'content2',planId:'plan',code,knowledge:[note],maintenance:'complete',deliveryNotes:'Synthetic updated content',createdByRun:author.id,cycle:1});demand.results.push({...demand.results[0]!,id:'result2',K:code,contentId:'content2',review:{id:'review2',contentId:'content2',runId:reviewer.id,contextId:reviewer.contextId,evidence:review,knowledgeReviewed:true,findings:[]},E:[{id:'check2',contentId:'content2',requirementId:'capability',status:'passed',evidence:check,environment:'fixture-native-environment'}]});f.store.saveDemand(demand);
  await f.action({action:'verify-baseline',operationId:proposal.proposalId,resultId:'result2',checkIds:['check2']});
  assert.equal(f.workspace.getBinding('demand')!.currentBaseline,source);assert.equal(f.workspace.getBinding('demand')!.initialBaseline,f.base);assert.equal(f.lifecycle.snapshot('demand').proposals[0]!.result!.state,'verified');
  f.lifecycle.captureResults();assert.ok(f.lifecycle.snapshot('demand').candidates.some(c=>c.resultId==='result2'),'Unchanged N from an earlier author retains exact independent Review and origin.');
});
