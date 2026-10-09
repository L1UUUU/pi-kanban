import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchStore, WorkflowService, DomainError } from '../src/domain/index.ts';
import type { ArtifactRef, FindingInput, RunAttempt, UserCommand, WorkerReport, ReportVerification } from '../src/domain/index.ts';

// All authority, process observations, files, and model activity below are synthetic.
// These tests validate the domain, real SQLite transactions, and restart persistence.
// They do not establish OS isolation, process termination, actual files, or model quality.
const methods = Object.fromEntries(['planning','implementation','review'].map(stage=>[stage,{id:stage,version:'1.0.0',digest:`synthetic-${stage}-v1`,adapter:'test-adapter'}]));
const ref=(id: string): ArtifactRef=>({id,digest:`synthetic-sha256-${id}`,location:`fixture://${id}`});
const proof={processAbsent:true,descendantsAbsent:true,workspaceVerified:true,evidence:'synthetic-observation'};
const dispatch={profileVerified:true,budgetAvailable:true,workspaceVerified:true};
const verified={artifactsVerified:true,contentStable:true,reviewInputsVerified:true};
function fixture(path=':memory:') {
  const store=new WorkbenchStore(path); const service=new WorkflowService(store);const user=service.trustedUser('fixture-owner');
  const project=service.createProject({id:'project-a',name:'Synthetic project',rootPath:'/synthetic/project',methods,baseChecks:[{id:'base-test',name:'Project test',source:'project'}]});
  const demand=service.createDemand({id:'demand-a',projectId:project.id,title:'Synthetic demand'});let seq=0;
  const command=(body:any)=>service.execute({requestId:`u-${++seq}`,demandId:demand.id,expectedRevision:service.getDemand(demand.id).revision,...body} as UserCommand,user);
  const report=(run:RunAttempt,body:any,verification: ReportVerification=verified)=>service.report({requestId:`w-${++seq}`,demandId:demand.id,runId:run.id,generation:run.generation,...body} as WorkerReport,service.workerContext(run.id),verification);
  const claim=()=>{const run=service.claimNextRun({...dispatch,demandId:demand.id});assert.ok(run);return run;};
  const start=()=>{command({type:'start-planning'});return claim();};
  const draft=(run:RunAttempt,planId='P1',unresolved:string[]=[])=>report(run,{type:'plan-draft',plan:{id:planId,scope:'Synthetic finite scope',spec:ref(`${planId}-spec`),tickets:ref(`${planId}-tickets`),requiredChecks:[{id:'feature-test',name:'Feature boundaries',source:'demand'}],unresolvedQuestions:unresolved}});
  const ready=(run:RunAttempt,planId='P1')=>report(run,{type:'plan-ready',planId,boundaryReview:{contextId:`boundary-${planId}`,planningContextId:run.contextId,evidence:ref(`${planId}-boundary`),unresolvedBlockingFindings:[]}},{...verified,boundaryReview:{runId:`synthetic-boundary-run-${planId}`,contextId:`boundary-${planId}`,planningRunId:run.id,planId,evidenceDigest:ref(`${planId}-boundary`).digest,actualReviewObserved:true,isolatedInputsVerified:true}} as any);
  const authorize=(planId='P1')=>command({type:'authorize-implementation',planId,confirmDesign:true,localCommit:true});
  const prepare=()=>{const planner=start();draft(planner);ready(planner);authorize();service.confirmStopped(planner.id,proof);return claim();};
  const content=(run:RunAttempt,contentId='K1N1',knowledgeId='N1')=>report(run,{type:'content-ready',content:{id:contentId,planId:'P1',code:ref(contentId.startsWith('sameK') || contentId==='K1N1'?'K1':contentId),knowledge:[ref(knowledgeId)],maintenance:'complete',deliveryNotes:'Synthetic verification and acceptance instructions.'}});
  const checks=(run:RunAttempt,contentId='K1N1',status='passed')=>{for(const requirementId of ['base-test','feature-test'])report(run,{type:'check',check:{id:`E-${++seq}`,contentId,requirementId,status,evidence:ref(`check-${seq}`),environment:'synthetic'}});};
  const review=(run:RunAttempt,contentId='K1N1',findings:FindingInput[]=[])=>report(run,{type:'review',reviewId:`R-${++seq}`,contentId,evidence:ref(`review-${seq}`),knowledgeReviewed:true,findings});
  const deliver=()=>{const impl=prepare();content(impl);service.confirmStopped(impl.id,proof);const reviewer=claim();checks(reviewer);review(reviewer);service.confirmStopped(reviewer.id,proof);return service.getDemand(demand.id).activeResultId!;};
  return {store,service,user,project,demand,command,report,claim,start,draft,ready,authorize,prepare,content,checks,review,deliver};
}
function code(expected:string) {return (error:unknown)=>error instanceof DomainError && error.code===expected;}
const finding=(id='F1',severity:FindingInput['severity']='blocking'):FindingInput=>({id,severity,location:'src/feature.ts:10',basis:'P1 boundary',impact:'Incorrect boundary outcome',verification:'Exercise boundary case'});

test('AC-001: saving an idea creates no workspace/run intent and grants no authority',()=>{
  const f=fixture();assert.equal(f.service.getDemand('demand-a').phase,'idea');assert.equal(f.store.outbox().length,0);assert.deepEqual(f.service.listRuns(),[]);assert.equal(f.service.getDemand('demand-a').grant,undefined);f.store.close();
});
test('explicit configuration fills only missing method slots before first dispatch and never upgrades a frozen method',()=>{
  const f=fixture();
  f.service.updateProjectMethods(f.project.id,{planning:methods.planning},f.user);
  f.command({type:'start-planning'});
  f.service.updateProjectMethods(f.project.id,{...methods,planning:{...methods.planning,version:'2.0.0'}},f.user);
  const completed=f.service.completeMissingMethods(f.demand.id);
  assert.equal(completed.methodSnapshot.planning?.version,'1.0.0');
  assert.equal(completed.methodSnapshot.review?.version,'1.0.0');
  const before=completed.revision;assert.equal(f.service.completeMissingMethods(f.demand.id).revision,before);
  f.claim();
  f.service.updateProjectMethods(f.project.id,{},f.user);
  assert.deepEqual(f.service.completeMissingMethods(f.demand.id).methodSnapshot,completed.methodSnapshot);
  f.store.close();
});
test('AC-005,006: plan readiness rejects unresolved scope, missing artifacts, non-independent review',()=>{
  const f=fixture();const run=f.start();f.draft(run,'P1',['Required decision']);assert.throws(()=>f.ready(run),code('UNRESOLVED_DESIGN'));assert.equal(f.service.getDemand('demand-a').phase,'planning');f.store.close();
  const g=fixture();const p=g.start();g.draft(p);const body={type:'plan-ready',planId:'P1',boundaryReview:{contextId:p.contextId,planningContextId:p.contextId,evidence:ref('boundary'),unresolvedBlockingFindings:[]}};
  assert.throws(()=>g.report(p,body,{}),code('ARTIFACTS_UNVERIFIED'));assert.throws(()=>g.report(p,body),code('REVIEW_NOT_INDEPENDENT'));g.store.close();
});
test('AC-009: design confirmation and readiness never imply implementation authority',()=>{
  const f=fixture();const p=f.start();f.draft(p);f.ready(p);f.command({type:'confirm-plan',planId:'P1'});f.service.confirmStopped(p.id,proof);assert.equal(f.service.getDemand('demand-a').phase,'awaiting-authorization');assert.equal(f.service.claimNextRun(dispatch),null);f.store.close();
});
for(const order of ['authority-first','handoff-first'])test(`AC-010: ${order}, independent controls start implementation once`,()=>{
  const f=fixture();const p=f.start();f.draft(p);if(order==='authority-first')f.authorize();f.ready(p);if(order==='handoff-first')f.authorize();f.authorize();
  assert.equal(f.service.claimNextRun(dispatch),null,'planner must actually stop');f.service.confirmStopped(p.id,proof);const run=f.claim();assert.equal(run.stage,'implementation');assert.equal(f.service.claimNextRun(dispatch),null);assert.equal(f.service.listRuns().filter(r=>r.stage==='implementation').length,1);f.store.close();
});
test('AC-010 regression: a later combined authorize/confirm saves missing design confirmation',()=>{
  const f=fixture();const p=f.start();f.draft(p);f.ready(p);f.command({type:'authorize-implementation',planId:'P1'});assert.equal(f.service.getDemand('demand-a').confirmedPlanId,undefined);f.authorize();assert.equal(f.service.getDemand('demand-a').confirmedPlanId,'P1');f.store.close();
});
test('AC-011: spoofed user, worker cross-demand, generation, and role controls rejected',()=>{
  const f=fixture();const p=f.start();f.draft(p);
  assert.throws(()=>f.service.execute({type:'authorize-implementation',requestId:'evil',demandId:'demand-a',planId:'P1'},{kind:'trusted-user',userId:'fixture-owner'}),code('UNTRUSTED_USER'));
  const ctx=f.service.workerContext(p.id);
  assert.throws(()=>f.service.report({type:'runtime-ended',requestId:'evil',demandId:'other-demand',runId:p.id,generation:p.generation},ctx),code('DEMAND_SCOPE'));
  assert.throws(()=>f.service.report({type:'runtime-ended',requestId:'evil',demandId:'demand-a',runId:p.id,generation:999},ctx),code('STALE_GENERATION'));
  assert.throws(()=>f.report(p,{type:'content-ready',content:{}}),code('ROLE_FORBIDDEN'));assert.equal(f.service.getDemand('demand-a').grant,undefined);f.store.close();
});
test('AC-012,013 FI-07: committed lost receipt replays once; changed payload is retained as conflict',()=>{
  const f=fixture();let lose=true;const crash=new WorkflowService(f.store,{fault:point=>{if(point==='after-commit'&&lose){lose=false;throw new Error('synthetic lost receipt');}}});const user=crash.trustedUser('owner');const command:UserCommand={requestId:'once',demandId:'demand-a',type:'start-planning'};
  assert.throws(()=>crash.execute(command,user),/lost receipt/);const receipt=crash.execute(command,user);const again=crash.execute(command,user);assert.deepEqual(again,receipt);assert.equal(f.store.outbox().filter(o=>o.kind==='start-run').length,1);
  assert.throws(()=>crash.execute({...command,originalText:'different'},user),code('IDEMPOTENCY_CONFLICT'));assert.equal(f.store.db.prepare('SELECT count(*) n FROM domain_conflicts').get()!.n,1);f.store.close();
});
test('FI-01: transaction failure rolls facts, receipt, audit and outbox back together',()=>{
  const f=fixture();const crash=new WorkflowService(f.store,{fault:point=>{if(point==='before-commit')throw new Error('synthetic disk failure');}});assert.throws(()=>crash.execute({type:'start-planning',requestId:'rollback',demandId:'demand-a'},crash.trustedUser('owner')),/disk failure/);
  assert.equal(f.service.getDemand('demand-a').planningStarted,false);assert.equal(f.store.outbox().length,0);assert.equal(f.store.history('demand-a').length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM domain_receipts').get()!.n,0);f.store.close();
});
test('AC-012: semantic duplicate controls with distinct IDs do not create duplicate intent',()=>{
  const f=fixture();f.command({type:'start-planning'});const duplicate=f.command({type:'start-planning'});assert.equal(duplicate.status,'noop');assert.equal(f.store.outbox().length,1);f.store.close();
});
test('AC-014: old plan commands are rejected, old run reports preserved as historical only',()=>{
  const f=fixture();const p=f.start();f.draft(p);f.ready(p);f.service.confirmStopped(p.id,proof);f.command({type:'revise-plan',previousPlanId:'P1',reason:'Change the agreed scope'});const p2=f.claim();f.draft(p2,'P2');
  assert.throws(()=>f.command({type:'authorize-implementation',planId:'P1'}),code('STALE_PLAN'));const late=f.report(p,{type:'blocked',reason:'old report'});assert.equal(late.status,'historical');assert.equal(f.service.getDemand('demand-a').activePlanId,'P2');assert.deepEqual(f.service.getDemand('demand-a').blockedReasons,[]);f.store.close();
});
test('AC-015,051 FI-02,08: pause wins over pending dispatch and late plan readiness',()=>{
  const f=fixture();const p=f.start();f.draft(p);f.authorize();f.command({type:'pause'});f.ready(p);assert.equal(f.service.getDemand('demand-a').control,'paused');assert.equal(f.service.getRun(p.id).status,'stopping');assert.equal(f.service.claimNextRun(dispatch),null);
  assert.throws(()=>f.command({type:'resume'}),code('STOP_UNVERIFIED'));f.service.confirmStopped(p.id,proof);assert.equal(f.service.claimNextRun(dispatch),null);f.command({type:'resume'});assert.equal(f.claim().stage,'implementation');f.store.close();
});
test('AC-016: saved, delivered, applied messages differ and questions do not authorize changes',()=>{
  const f=fixture();const p=f.start();f.command({type:'message',messageId:'question',kind:'question',text:'Could this use another approach?'});assert.equal(f.service.getDemand('demand-a').messages[0].state,'saved');f.report(p,{type:'message-delivered',messageId:'question'});f.report(p,{type:'message-applied',messageId:'question'});assert.equal(f.service.getDemand('demand-a').messages[0].state,'applied');assert.equal(f.service.getDemand('demand-a').grant,undefined);
  f.command({type:'message',messageId:'change',kind:'change-request',text:'Consider changing scope'});f.report(p,{type:'message-delivered',messageId:'change'});assert.throws(()=>f.report(p,{type:'message-applied',messageId:'change'}),code('CHANGE_REQUIRES_USER_COMMAND'));f.store.close();
});
test('AC-008: method snapshots survive project upgrades; explicit switch preserves confirmed plan',()=>{
  const f=fixture();const p=f.start();f.draft(p);f.ready(p);f.authorize();f.service.confirmStopped(p.id,proof);
  const newer={...methods,implementation:{...methods.implementation,version:'2.0.0'}};f.service.updateProjectMethods('project-a',newer,f.user);assert.equal(f.service.getDemand('demand-a').methodSnapshot.implementation?.version,'1.0.0');
  f.command({type:'switch-method',stage:'implementation',method:newer.implementation,reason:'Validated new adapter',impactReviewed:true});const d=f.service.getDemand('demand-a');assert.equal(d.confirmedPlanId,'P1');assert.equal(d.grant?.planId,'P1');assert.equal(f.claim().method.version,'2.0.0');f.store.close();
});
test('AC-017,018,025,035: required checks plus independent review produce immutable P/K/N/E/C',()=>{
  const f=fixture();const impl=f.prepare();f.content(impl);f.service.confirmStopped(impl.id,proof);const reviewer=f.claim();assert.equal(reviewer.stage,'review');assert.equal(reviewer.writer,false);assert.notEqual(reviewer.contextId,impl.contextId);assert.ok(reviewer.contextSources.includes('N1'));assert.ok(!reviewer.contextSources.some(s=>s.includes(impl.contextId)));
  f.checks(reviewer);assert.equal(f.service.getDemand('demand-a').activeResultId,undefined);f.review(reviewer);assert.equal(f.service.getDemand('demand-a').activeResultId,undefined,'reviewer process has not stopped');f.service.confirmStopped(reviewer.id,proof);
  const d=f.service.getDemand('demand-a');assert.equal(d.phase,'awaiting-acceptance');const result=d.results[0];assert.equal(result.P,'P1');assert.equal(result.N[0].id,'N1');assert.equal(result.E.length,2);assert.equal(result.review.runId,reviewer.id);assert.equal(f.service.claimNextRun(dispatch),null);f.store.close();
});
test('AC-020,021: blocking finding routes to implementation; only independent reviewer closes dispute',()=>{
  const f=fixture();const impl=f.prepare();f.content(impl);f.service.confirmStopped(impl.id,proof);const rev=f.claim();f.checks(rev);f.review(rev,'K1N1',[finding()]);f.service.confirmStopped(rev.id,proof);assert.equal(f.service.getDemand('demand-a').phase,'rework');const fix=f.claim();assert.equal(fix.stage,'implementation');
  f.report(fix,{type:'dispute',findingId:'F1',evidence:ref('dispute')});assert.throws(()=>f.report(fix,{type:'resolve-finding',findingId:'F1',contentId:'K1N1',evidence:ref('resolution'),outcome:'false-positive'}),code('ROLE_FORBIDDEN'));
  f.content(fix,'K2N2','N2');f.service.confirmStopped(fix.id,proof);const rev2=f.claim();f.report(rev2,{type:'resolve-finding',findingId:'F1',contentId:'K2N2',evidence:ref('resolution'),outcome:'false-positive'});f.checks(rev2,'K2N2');f.review(rev2,'K2N2');f.service.confirmStopped(rev2.id,proof);assert.equal(f.service.getDemand('demand-a').phase,'awaiting-acceptance');assert.equal(f.service.getDemand('demand-a').results[0].findingClosures[0].status,'closed');f.store.close();
});
test('AC-022: optional suggestions do not force scope expansion or block acceptance',()=>{
  const f=fixture();const impl=f.prepare();f.content(impl);f.service.confirmStopped(impl.id,proof);const rev=f.claim();f.checks(rev);f.review(rev,'K1N1',[finding('optional','suggestion')]);f.service.confirmStopped(rev.id,proof);assert.equal(f.service.getDemand('demand-a').phase,'awaiting-acceptance');assert.equal(f.service.listDemands().length,1);f.store.close();
});
test('AC-023: unavailable required verification blocks rather than submitting a partial result',()=>{
  const f=fixture();const impl=f.prepare();f.content(impl);f.service.confirmStopped(impl.id,proof);const rev=f.claim();f.checks(rev,'K1N1','unavailable');f.review(rev);f.service.confirmStopped(rev.id,proof);assert.equal(f.service.getDemand('demand-a').phase,'blocked');assert.equal(f.service.getDemand('demand-a').results.length,0);assert.equal(f.service.claimNextRun(dispatch),null);f.store.close();
});
test('AC-024,029,030: N-only revision needs new review/evidence, C1 controls cannot accept C2',()=>{
  const f=fixture();const c1=f.deliver();const original=f.service.getDemand('demand-a').results[0];f.command({type:'return-result',resultId:c1,reason:'Clarify the local knowledge boundary'});const fix=f.claim();f.content(fix,'sameK-newN','N2');f.service.confirmStopped(fix.id,proof);const rev=f.claim();f.review(rev,'sameK-newN');f.service.confirmStopped(rev.id,proof);assert.equal(f.service.getDemand('demand-a').activeResultId,undefined,'old checks must not qualify');const rev2=f.claim();f.checks(rev2,'sameK-newN');f.service.confirmStopped(rev2.id,proof);const d=f.service.getDemand('demand-a');assert.ok(d.activeResultId);assert.notEqual(d.activeResultId,c1);assert.deepEqual(d.results[0].K,d.results[1].K);assert.notDeepEqual(d.results[0].N,d.results[1].N);assert.deepEqual(d.results[0],original);assert.throws(()=>f.command({type:'accept-result',resultId:c1}),code('STALE_RESULT'));f.command({type:'accept-result',resultId:d.activeResultId});assert.equal(f.service.getDemand('demand-a').phase,'accepted');f.store.close();
});
test('AC-027,028 FI-09: external content change invalidates quality and cannot be cleared into old acceptance',()=>{
  const f=fixture();const result=f.deliver();const immutable=f.service.getDemand('demand-a').results[0];f.service.invalidateCurrentContent('demand-a','User edited file after submission');assert.throws(()=>f.command({type:'accept-result',resultId:result}),code('QUALITY_GATE'));f.command({type:'resolve-blocker',reason:'Observed edit'});assert.equal(f.service.getDemand('demand-a').phase,'blocked');assert.deepEqual(f.service.getDemand('demand-a').results[0],immutable);assert.equal(f.service.claimNextRun(dispatch),null);f.store.close();
});
test('AC-030: stale display revision rejects controls; repeated acceptance is idempotent',()=>{
  const f=fixture();const old=f.service.getDemand('demand-a').revision;f.command({type:'message',messageId:'m',text:'hello',kind:'information'});assert.throws(()=>f.command({type:'start-planning',expectedRevision:old}),code('STALE_CONTROL'));const c=f.deliver();f.command({type:'accept-result',resultId:c});assert.equal(f.command({type:'accept-result',resultId:c}).status,'noop');assert.equal(f.service.getDemand('demand-a').acceptances.length,1);f.store.close();
});
test('AC-031: accepting creates no remote operation or knowledge eligibility',()=>{
  const f=fixture();const c=f.deliver();f.command({type:'accept-result',resultId:c});assert.equal(f.service.getDemand('demand-a').phase,'accepted');assert.ok(f.store.outbox().every(o=>['start-run','stop-run','notification'].includes(o.kind)));assert.equal((f.service.getDemand('demand-a') as any).merged,undefined);f.store.close();
});
test('AC-047,048: at most two concurrent demands and one high-resource activity',()=>{
  const f=fixture();for(const demandId of ['demand-b','demand-c']){f.service.createDemand({id:demandId,projectId:'project-a',title:demandId});f.service.execute({type:'start-planning',requestId:demandId,demandId},f.user);}f.command({type:'start-planning'});
  const a=f.service.claimNextRun({...dispatch,demandId:'demand-a',highResource:true});assert.ok(a);assert.equal(f.service.claimNextRun({...dispatch,demandId:'demand-b',highResource:true}),null);const b=f.service.claimNextRun({...dispatch,demandId:'demand-b'});assert.ok(b);assert.equal(f.service.claimNextRun({...dispatch,demandId:'demand-c'}),null);
  f.command({type:'pause'});assert.equal(f.service.claimNextRun({...dispatch,demandId:'demand-c'}),null,'stop request does not release resource');f.service.confirmStopped(a.id,proof);assert.ok(f.service.claimNextRun({...dispatch,demandId:'demand-c'}));f.store.close();
});
test('AC-050,052,054 FI-03,16: restart persists exit, unresolved writers and exact process identity',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pi-domain-'));const path=join(dir,'state.sqlite');const f=fixture(path);const p=f.start();f.service.markRunning(p.id,'process-identity-A');f.command({type:'exit'});f.store.close();
  const store=new WorkbenchStore(path);const s=new WorkflowService(store);assert.equal(s.getDemand('demand-a').control,'exited');assert.equal(s.claimNextRun(dispatch),null);assert.throws(()=>s.reconnectRun(p.id,'reused-pid-other-process',p.generation),code('PROCESS_IDENTITY_MISMATCH'));assert.equal(s.reconnectRun(p.id,'process-identity-A',p.generation).status,'stopping');s.recoverRun(p.id,{...proof,...dispatch});assert.equal(s.getDemand('demand-a').control,'exited');assert.equal(s.claimNextRun(dispatch),null);store.close();rmSync(dir,{recursive:true});
});
test('AC-051,052: cancellation cannot recover; unexpected interruption requires verified absence before restart',()=>{
  const f=fixture();const p=f.start();f.service.markInterrupted(p.id,'synthetic host loss');assert.equal(f.service.claimNextRun(dispatch),null);assert.throws(()=>f.service.recoverRun(p.id,{...proof,...dispatch,descendantsAbsent:false}),code('STOP_UNVERIFIED'));f.service.recoverRun(p.id,{...proof,...dispatch});const resumed=f.claim();assert.equal(resumed.stage,'planning');assert.notEqual(resumed.id,p.id);f.command({type:'cancel'});f.service.confirmStopped(resumed.id,proof);assert.throws(()=>f.command({type:'resume'}),code('CANCELLED'));assert.equal(f.service.claimNextRun(dispatch),null);f.store.close();
});
test('AC-056: notifications survive acknowledgement, clicking/reading creates no control authority',()=>{
  const f=fixture();const c=f.deliver();const notices=f.service.notifications();assert.ok(notices.length);const before=f.service.getDemand('demand-a');f.service.acknowledgeOutbox(notices[0].id);assert.equal(f.service.notifications()[0].status,'done');assert.deepEqual(f.service.getDemand('demand-a'),before);assert.equal(before.acceptances.length,0);assert.equal(before.activeResultId,c);f.store.close();
});
test('FI-10: low-level runtime-ended does not complete business work or release writer ownership',()=>{
  const f=fixture();const impl=f.prepare();f.report(impl,{type:'runtime-ended'});assert.equal(f.service.getRun(impl.id).status,'starting');assert.equal(f.service.getDemand('demand-a').phase,'implementing');assert.equal(f.service.claimNextRun(dispatch),null);assert.throws(()=>f.service.confirmStopped(impl.id,{...proof,processAbsent:false}),code('STOP_UNVERIFIED'));f.store.close();
});
test('AC-064: missing methods, runtime profile, finite budget or workspace verification fail closed',()=>{
  const f=fixture();f.service.updateProjectMethods('project-a',{},f.user);f.command({type:'start-planning'});assert.equal(f.service.getDemand('demand-a').phase,'blocked');assert.equal(f.service.claimNextRun(dispatch),null);
  assert.throws(()=>f.service.claimNextRun({...dispatch,profileVerified:false}),code('PROFILE_UNVERIFIED'));assert.throws(()=>f.service.claimNextRun({...dispatch,budgetAvailable:false}),code('BUDGET_UNAVAILABLE'));assert.throws(()=>f.service.claimNextRun({...dispatch,workspaceVerified:false}),code('WORKSPACE_UNVERIFIED'));f.store.close();
});


test('AC-006 regression: fabricated boundary context IDs cannot establish independent review',()=>{
  const f=fixture();const p=f.start();f.draft(p);const body={type:'plan-ready',planId:'P1',boundaryReview:{contextId:'made-up-reviewer',planningContextId:p.contextId,evidence:ref('boundary'),unresolvedBlockingFindings:[]}};
  assert.throws(()=>f.report(p,body),code('BOUNDARY_REVIEW_UNVERIFIED'));
  assert.throws(()=>f.report(p,body,{...verified,boundaryReview:{runId:'observed-reviewer',contextId:'different-context',planningRunId:p.id,planId:'P1',evidenceDigest:ref('boundary').digest,actualReviewObserved:true,isolatedInputsVerified:true}} as any),code('BOUNDARY_REVIEW_UNVERIFIED'));
  assert.equal(f.service.getDemand('demand-a').plans[0].ready,false);f.ready(p);assert.equal(f.service.getDemand('demand-a').plans[0].ready,true);f.store.close();
});
test('AC-014,024 regression: late old writer cannot replace content after a reviewer is dispatched',()=>{
  const f=fixture();const impl=f.prepare();f.content(impl);f.service.confirmStopped(impl.id,proof);const rev=f.claim();const late=f.content(impl,'K-unrequested','N-unrequested');assert.equal(late.status,'historical');assert.equal(f.service.getDemand('demand-a').activeContentId,'K1N1');assert.equal(f.service.getRun(rev.id).contentId,'K1N1');f.store.close();
});


test('AC-013 regression: same review ID with changed full finding content is a conflict',()=>{
  const f=fixture();const impl=f.prepare();f.content(impl);f.service.confirmStopped(impl.id,proof);const reviewer=f.claim();
  const review={type:'review',reviewId:'immutable-review',contentId:'K1N1',evidence:ref('review'),knowledgeReviewed:true,findings:[finding('F1','suggestion')]};
  f.report(reviewer,review);assert.throws(()=>f.report(reviewer,{...review,findings:[{...review.findings[0],severity:'blocking'}]}),code('CONTENT_CONFLICT'));
  for(const field of ['location','basis','impact','verification'])assert.throws(()=>f.report(reviewer,{...review,findings:[{...review.findings[0],[field]:'altered'}]}),code('CONTENT_CONFLICT'));
  assert.equal(f.service.getDemand('demand-a').findings[0].severity,'suggestion');f.store.close();
});
test('Stale resume cannot overrule a newer pause; unversioned control fails closed',()=>{
  const f=fixture();const p=f.start();f.command({type:'pause'});f.service.confirmStopped(p.id,proof);const revision=f.service.getDemand('demand-a').revision;
  f.command({type:'message',messageId:'newer',kind:'information',text:'New context'});
  assert.throws(()=>f.command({type:'resume',expectedRevision:revision}),code('STALE_CONTROL'));
  assert.throws(()=>f.service.execute({type:'resume',requestId:'unversioned',demandId:'demand-a'},f.user),code('VERSION_REQUIRED'));assert.equal(f.service.getDemand('demand-a').control,'paused');f.store.close();
});
test('Observed run status changes advance persisted view revision',()=>{
  const f=fixture();const p=f.start();let revision=f.service.getDemand('demand-a').revision;
  f.service.markRunning(p.id,'synthetic-process');assert.ok(f.service.getDemand('demand-a').revision>revision);revision=f.service.getDemand('demand-a').revision;
  f.service.markInterrupted(p.id,'lost channel');assert.ok(f.service.getDemand('demand-a').revision>revision);revision=f.service.getDemand('demand-a').revision;
  f.service.reconnectRun(p.id,'synthetic-process',p.generation);assert.ok(f.service.getDemand('demand-a').revision>revision);f.store.close();
});


test('FI-02,03,08: process-start observation after pause records identity without revoking stop',()=>{
  const f=fixture();const p=f.start();f.command({type:'pause'});const observed=f.service.markRunning(p.id,'late-started-process');assert.equal(observed.status,'stopping');assert.equal(observed.processIdentity,'late-started-process');assert.equal(f.service.getDemand('demand-a').control,'paused');assert.equal(f.service.claimNextRun(dispatch),null);assert.throws(()=>f.service.markRunning(p.id,'different-process'),code('PROCESS_IDENTITY_MISMATCH'));f.service.confirmStopped(p.id,proof);f.store.close();
});


test('AC-023,055: persisted Host blocker stops dispatch; duplicate observations and resume do not erase it',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pi-domain-blocker-'));const path=join(dir,'state.sqlite');const f=fixture(path);const run=f.start();
  const blocked=f.service.blockDemand('demand-a','RETRY_EXHAUSTED','Three starts produced no valid handoff');
  assert.equal(blocked.phase,'blocked');assert.equal(blocked.control,'active');assert.equal(f.service.getRun(run.id).status,'stopping');assert.equal(f.service.claimNextRun(dispatch),null);
  const noticeCount=f.service.notifications().length;const historyCount=f.store.history('demand-a').length;
  assert.equal(f.service.blockDemand('demand-a','RETRY_EXHAUSTED','Three starts produced no valid handoff').revision,blocked.revision);
  assert.equal(f.service.notifications().length,noticeCount);assert.equal(f.store.history('demand-a').length,historyCount);f.service.confirmStopped(run.id,proof);f.store.close();
  const store=new WorkbenchStore(path);const service=new WorkflowService(store);const current=service.getDemand('demand-a');
  service.execute({type:'resume',requestId:'resume-blocked',demandId:'demand-a',expectedRevision:current.revision},service.trustedUser('fixture-owner'));
  assert.equal(service.getDemand('demand-a').phase,'blocked');assert.deepEqual(service.getDemand('demand-a').blockedReasons,['RETRY_EXHAUSTED: Three starts produced no valid handoff']);assert.equal(service.claimNextRun(dispatch),null);store.close();rmSync(dir,{recursive:true});
});
