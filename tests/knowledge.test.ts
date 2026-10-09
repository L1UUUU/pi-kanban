import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService } from '../src/knowledge/index.ts';
import type { CandidateInput, ContextInput, SourceEvidence } from '../src/knowledge/index.ts';
import { ImmutableObjectStore } from '../src/workspace/index.ts';
import { GitHubReadOnlyAdapter } from '../src/knowledge/remote.ts';
import type { ReadOnlyTransport } from '../src/knowledge/remote.ts';
const formal='1'.repeat(40),submitted='2'.repeat(40),target='3'.repeat(40);
function setup(t:any) {
 const root=mkdtempSync(join(tmpdir(),'pi-knowledge-'));const db=new DatabaseSync(join(root,'control.sqlite'));const stores=new Map<string,ImmutableObjectStore>();
 for(const p of ['p','q']){mkdirSync(join(root,p));stores.set(p,ImmutableObjectStore.open(join(root,p),p));}
 const reads:string[]=[];const resolveStore=(p:string)=>{const s=stores.get(p);assert.ok(s);return s;};const k=new KnowledgeService({db,resolveStore,onBodyRead:r=>reads.push(r)});
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});return {root,db,stores,reads,k,resolveStore};
}
function candidate(overrides:Partial<CandidateInput>={}):CandidateInput{return {revisionId:'n1',knowledgeId:'range',projectId:'p',demandId:'a',createdBy:'implementer-a',title:'Time range',tags:['range'],body:'Existing normalizeRange uses [from,to).',sourceKind:'existing-fact',materialKind:'knowledge',statementKind:'fact',formalTarget:'main',roles:['planner','implementer','reviewer'],modulePaths:['src/range.ts'],...overrides};}
function context(overrides:Partial<ContextInput>={}):ContextInput{return {runId:'run-b',projectId:'p',demandId:'b',role:'planner',baseline:formal,formalTarget:'main',environment:'node24-linux',allowedRevisionIds:['n1'],purpose:'Investigate export reuse',...overrides};}
function evidence(overrides:Partial<SourceEvidence>={}):SourceEvidence{return {evidenceId:'e1',revisionId:'n1',reviewerId:'reviewer-a',sourceKind:'existing-fact',sourceVerified:true,contentConsistent:true,worthReusing:true,applicabilityClear:true,mixedPrivateConclusions:false,evidenceRefs:['synthetic-git-read-and-review'],formalTarget:'main',formalCommit:formal,independentOfDemand:true,...overrides};}
function qualify(k:KnowledgeService,overrides:any={}){k.recordEvidence(evidence(overrides.evidence));k.registerEligibility({eligibilityId:'eligible1',revisionId:'n1',evidenceId:'e1',formalTarget:'main',baseline:formal,environment:'node24-linux',capabilityEvidenceRefs:['synthetic-capability-check'],...overrides.eligibility});}
function adapter(db:DatabaseSync,transport:ReadOnlyTransport,binding:any={}){return new GitHubReadOnlyAdapter({db,binding:{projectId:'p',demandId:'a',owner:'fixture-owner',repository:'fixture-repo',pullRequest:7,target:'main',...binding},transport});}
function remoteResponse(url:string,overrides:any={}):any {
 if(url.includes('/pulls/'))return {number:7,html_url:'https://github.com/fixture-owner/fixture-repo/pull/7',base:{ref:'main',repo:{full_name:'fixture-owner/fixture-repo'}},head:{sha:submitted},state:'closed',merged:true,merged_at:'2026-10-08T00:00:00Z',merge_commit_sha:formal,...overrides};
 if(url.includes('/compare/'))return {status:'ahead',merge_base_commit:{sha:formal}};
 return {sha:url.endsWith('/main')?target:formal};
}

test('AC-036/041: foreign candidate title/body never reaches search before eligibility',t=>{
 const f=setup(t);f.k.saveCandidate(candidate({sourceKind:'implementation',title:'PRIVATE_TITLE_MARKER',body:'PRIVATE_BODY_MARKER'}));
 const c=f.k.createContext(context());assert.deepEqual(c.revisionIds,[]);assert.deepEqual(f.k.search(c.contextId,'PRIVATE'),[]);assert.deepEqual(f.reads,[]);
 assert.throws(()=>f.k.read(c.contextId,'n1'),/unavailable/);assert.deepEqual(f.reads,[]);
 // Knowledge labels, accepted delivery, and existence alone do not grant reads.
 assert.throws(()=>f.k.registerEligibility({eligibilityId:'bad',revisionId:'n1',evidenceId:'missing',formalTarget:'main',baseline:formal,environment:'node24-linux',capabilityEvidenceRefs:['test']}),/independent evidence/);
});
test('AC-037/046: independently verified existing facts cross demand only on exact baseline/target/environment/allowlist',t=>{
 const f=setup(t);f.k.saveCandidate(candidate());qualify(f.k);const c=f.k.createContext(context());assert.deepEqual(c.revisionIds,['n1']);assert.equal(f.k.search(c.contextId,'normalizeRange')[0].revisionId,'n1');
 for(const [i,override] of [{baseline:submitted},{formalTarget:'release'},{environment:'node24-windows'},{projectId:'q'},{allowedRevisionIds:[]}].entries()) {
  const before=f.reads.length;const other=f.k.createContext(context({runId:`variant-${i}`,...override}));assert.deepEqual(other.revisionIds,[]);assert.deepEqual(f.k.search(other.contextId,'range'),[]);assert.equal(f.reads.length,before);
 }
 assert.throws(()=>f.k.createContext(context({allowedRevisionIds:['n1','n2']})),/cannot widen/);
});
test('AC-038/039: environment independence and mixed conclusions cannot be relabelled into eligibility',t=>{
 const f=setup(t);f.k.saveCandidate(candidate({sourceKind:'environment'}));
 f.k.recordEvidence(evidence({sourceKind:'environment',environment:'node24-linux',mixedPrivateConclusions:true}));
 assert.throws(()=>f.k.registerEligibility({eligibilityId:'bad',revisionId:'n1',evidenceId:'e1',formalTarget:'main',baseline:formal,environment:'node24-linux',capabilityEvidenceRefs:['environment-check']}),/unresolved/);
 f.k.recordEvidence(evidence({evidenceId:'e2',sourceKind:'environment',environment:'node24-linux'}));f.k.registerEligibility({eligibilityId:'good',revisionId:'n1',evidenceId:'e2',formalTarget:'main',baseline:formal,environment:'node24-linux',capabilityEvidenceRefs:['environment-check']});
 assert.deepEqual(f.k.createContext(context()).revisionIds,['n1']);
});
test('AC-042: reviewer gets exact candidate but neither implementation session nor equivalent summary',t=>{
 const f=setup(t);f.k.saveCandidate(candidate());f.k.saveCandidate(candidate({revisionId:'chat',materialKind:'session',body:'PRIVATE_CHAT'}));f.k.saveCandidate(candidate({revisionId:'summary',materialKind:'session-summary',body:'PRIVATE_EQUIVALENT_SUMMARY'}));
 const c=f.k.createContext(context({demandId:'a',role:'reviewer',allowedRevisionIds:['n1','chat','summary']}));assert.deepEqual(c.revisionIds,['n1']);assert.equal(f.k.search(c.contextId,'PRIVATE').length,0);assert.deepEqual(f.reads,['n1']);
 assert.throws(()=>f.k.read(c.contextId,'summary'),/unavailable/);
});
test('FI-15/AC-043: sibling candidate revisions preserve N1 and frozen contexts',t=>{
 const f=setup(t);const n1=f.k.saveCandidate(candidate());qualify(f.k);const c=f.k.createContext(context());
 const n2=f.k.saveCandidate(candidate({revisionId:'n2',parentRevisionId:'n1',body:'New candidate A'}));const n3=f.k.saveCandidate(candidate({revisionId:'n3',demandId:'c',parentRevisionId:'n1',body:'Independent candidate C'}));
 assert.notEqual(n1.object.sha256,n2.object.sha256);assert.notEqual(n2.object.sha256,n3.object.sha256);assert.equal(f.k.read(c.contextId,'n1').body,candidate().body);
 assert.throws(()=>f.k.saveCandidate(candidate({body:'overwrite shared N1'})),/cannot be overwritten/);assert.throws(()=>f.k.read(c.contextId,'n2'),/unavailable/);
});
test('FI-05/06: orphan object is not registered or shared; corrupt references never fall back to latest',t=>{
 const f=setup(t);const crashed=new KnowledgeService({db:f.db,resolveStore:f.resolveStore,fault:point=>{if(point==='knowledge.object')throw new Error('crash');}});
 assert.throws(()=>crashed.saveCandidate(candidate()),/crash/);assert.equal((f.db.prepare('SELECT count(*) AS count FROM knowledge_revisions').get() as any).count,0);
 const n=f.k.saveCandidate(candidate());qualify(f.k);const c=f.k.createContext(context());writeFileSync(f.stores.get('p')!.objectPath(n.object),'corrupt');
 assert.throws(()=>f.k.read(c.contextId,'n1'),/corrupt/);assert.equal(f.k.verifyReferences('p')[0].valid,false);unlinkSync(f.stores.get('p')!.objectPath(n.object));assert.equal(f.k.verifyReferences('p')[0].valid,false);
});
test('AC-044: invalidation preserves immutable history and revokes reads without rewriting rules',t=>{
 const f=setup(t);f.k.saveCandidate(candidate({statementKind:'constraint'}));qualify(f.k);const c=f.k.createContext(context());f.k.invalidate({revisionId:'n1',reason:'Scope requires review, not a rule change',evidenceRef:'conflict-review'});
 assert.throws(()=>f.k.read(c.contextId,'n1'),/unavailable/);assert.deepEqual(f.k.search(c.contextId,'range'),[]);assert.equal((f.db.prepare('SELECT count(*) AS count FROM knowledge_revisions').get() as any).count,1);
});
test('AC-057/058: controlled GitHub response adapter pins identity and GET; merge, acceptance and eligibility separate',async t=>{
 const f=setup(t);const calls:any[]=[];const remote=adapter(f.db,async request=>{calls.push(request);return {status:200,body:remoteResponse(request.url)};});
 const o=await remote.observe();assert.equal(o.state,'merged');assert.equal(o.provenance,'controlled-response');assert.equal(o.formalCommit,formal);assert.equal(calls.length,4);assert.ok(calls.every(c=>c.method==='GET' && c.url.startsWith('https://api.github.com/repos/fixture-owner/fixture-repo/')));
 remote.recordContentVerification({verificationId:'v1',observationId:o.observationId,formalCommit:formal,acceptedCommit:'4'.repeat(40),submittedCommit:submitted,contentCorresponds:true,capabilitiesVerified:true,acceptanceCoverage:'gap',revisionIds:['n1'],checkedPaths:['src/range.ts'],evidenceRefs:['controlled-response-only'],reviewerId:'reviewer-a'});
 f.k.saveCandidate(candidate({sourceKind:'implementation'}));f.k.recordEvidence(evidence({sourceKind:'implementation',mergeObservationId:o.observationId,finalContentVerificationId:'v1'}));
 assert.throws(()=>f.k.registerEligibility({eligibilityId:'e',revisionId:'n1',evidenceId:'e1',formalTarget:'main',baseline:formal,environment:'node24-linux',capabilityEvidenceRefs:['fixture']}),/Mock remote evidence/);
 assert.deepEqual(f.k.createContext(context()).revisionIds,[]);
});
test('remote unknown, wrong target, closed-unmerged and identity mismatch preserve separate observations',async t=>{
 const f=setup(t);let mode='closed';const remote=adapter(f.db,async r=>{
  if(mode==='failure')return {status:401,body:null};
  const overrides=mode==='closed'?{merged:false}:mode==='wrong'?{base:{ref:'release',repo:{full_name:'fixture-owner/fixture-repo'}}}:{number:999};
  return {status:200,body:remoteResponse(r.url,overrides)};
 });
 assert.equal((await remote.observe()).state,'closed-unmerged');mode='wrong';assert.equal((await remote.observe()).state,'wrong-target');mode='identity';assert.equal((await remote.observe()).state,'unknown');mode='failure';assert.equal((await remote.observe()).state,'unknown');assert.equal(remote.observations().length,4);assert.equal(remote.observations()[0].state,'closed-unmerged');
});
test('cross-project/demand remote proof cannot authorize knowledge even with matching target and commit',async t=>{
 const f=setup(t);const remote=adapter(f.db,async r=>({status:200,body:remoteResponse(r.url)}),{projectId:'q',demandId:'a'});const o=await remote.observe();f.k.saveCandidate(candidate({sourceKind:'implementation'}));
 f.k.recordEvidence(evidence({sourceKind:'implementation',mergeObservationId:o.observationId,finalContentVerificationId:'unrelated'}));
 assert.throws(()=>f.k.registerEligibility({eligibilityId:'e',revisionId:'n1',evidenceId:'e1',formalTarget:'main',baseline:formal,environment:'node24-linux',capabilityEvidenceRefs:['fixture']}),/another project or demand/);
});
