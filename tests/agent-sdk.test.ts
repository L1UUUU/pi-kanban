import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSyntheticPiSession,SessionManager,PiLifecycle,PI_SDK_VERSION } from '../src/agent/pi-adapter.ts';
import { explicitResourceLoader } from '../src/agent/resources.ts';
import type { AgentMaterial } from '../src/agent/resources.ts';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
const material=(id:string,content:string,kind:AgentMaterial['kind']='plan'):AgentMaterial=>({id,kind,content,sha256:createHash('sha256').update(content).digest('hex')});
function fixture(){
  const parent=mkdtempSync(join(tmpdir(),'pi-sdk-')),cwd=join(parent,'workspace'),agentDir=join(parent,'forbidden-global');mkdirSync(cwd);mkdirSync(agentDir);
  writeFileSync(join(parent,'AGENTS.md'),'FORBIDDEN-ANCESTOR-INSTRUCTIONS');writeFileSync(join(agentDir,'AGENTS.md'),'FORBIDDEN-GLOBAL-INSTRUCTIONS');
  writeFileSync(join(agentDir,'settings.json'),JSON.stringify({defaultProvider:'unapproved',defaultModel:'unapproved',appendSystemPrompt:'FORBIDDEN-SETTINGS'}));
  mkdirSync(join(agentDir,'extensions'));writeFileSync(join(agentDir,'extensions','trap.ts'),'throw new Error("FORBIDDEN-EXTENSION-LOADED")');
  return {cwd,agentDir,parent};
}

test('actual installed Pi 1.1.0: explicit assembly excludes parent/global settings/extensions and tools',async()=>{
  const {cwd,agentDir}=fixture();let received='';let calls=0;
  const run=await createSyntheticPiSession({cwd,agentDir,role:'planning',sessionManager:SessionManager.inMemory(cwd),materials:[material('plan','ALLOWED-PLAN')],
    reply:async context=>{calls++;received=JSON.stringify(context);return 'deterministic transport fixture';}});
  try{
    assert.equal(PI_SDK_VERSION,'1.1.0');assert.deepEqual(run.session.getActiveToolNames(),[]);
    const events:string[]=[];run.session.subscribe(event=>events.push(event.type));
    await run.session.prompt('Describe the explicitly supplied plan.');
    assert.equal(calls,1);assert.match(received,/ALLOWED-PLAN/);assert.doesNotMatch(received,/FORBIDDEN/);
    assert.equal(run.session.getLastAssistantText(),'deterministic transport fixture');
    assert.ok(events.includes('agent_end'));assert.ok(events.includes('agent_settled'));
    assert.ok(events.lastIndexOf('agent_settled')>events.lastIndexOf('agent_end'));assert.equal(run.lifecycle.settled,true);
    assert.equal(readdirSync(agentDir).sort().join(','),'AGENTS.md,extensions,settings.json');
  }finally{run.dispose();}
});
test('actual Pi native session persists/reopens; Host does not forge native history',async()=>{
  const {cwd,agentDir,parent}=fixture();const sessions=join(parent,'controlled-sessions');mkdirSync(sessions);
  const manager=SessionManager.create(cwd,sessions);
  const run=await createSyntheticPiSession({cwd,agentDir,role:'implementation',sessionManager:manager,materials:[],reply:async()=> 'SYNTHETIC-PERSISTED-REPLY'});
  await run.session.prompt('SYNTHETIC-PERSISTED-QUESTION');const sessionPath=manager.getSessionFile();assert.ok(sessionPath);run.dispose();
  assert.match(readFileSync(sessionPath,'utf8'),/SYNTHETIC-PERSISTED-REPLY/);
  const reopened=SessionManager.open(sessionPath,sessions,cwd);
  assert.equal(reopened.getSessionId(),manager.getSessionId());assert.ok(reopened.buildSessionContext().messages.length>=2);
  await assert.rejects(createSyntheticPiSession({cwd,agentDir,role:'review',sessionManager:reopened,materials:[],reply:async()=>''}),{code:'REVIEW_HISTORY_DENIED'});
});
test('independent Reviewer rejects implementation chat/summary and gets only explicit materials',async()=>{
  const {cwd,agentDir}=fixture();
  for(const kind of ['implementation-session','implementation-summary'] as const)
    assert.throws(()=>explicitResourceLoader('review',[material('private','SECRET-IMPLEMENTATION',kind)]),{code:'REVIEW_CONTEXT_DENIED'});
  let captured='';const run=await createSyntheticPiSession({cwd,agentDir,role:'review',sessionManager:SessionManager.inMemory(cwd),
    materials:[material('code','IMMUTABLE-REVIEW-SOURCE','source'),material('checks','CHECK-RESULT','check-evidence')],reply:async context=>{captured=JSON.stringify(context);return 'fixture review';}});
  try{await run.session.prompt('Inspect supplied evidence.');assert.match(captured,/IMMUTABLE-REVIEW-SOURCE/);assert.doesNotMatch(captured,/SECRET-IMPLEMENTATION|FORBIDDEN/);}finally{run.dispose();}
});
test('material hashes and resource extension are enforced before SDK assembly',()=>{
  assert.throws(()=>explicitResourceLoader('planning',[{...material('x','expected'),content:'modified'}]),{code:'MATERIAL_CHANGED'});
  const resources=explicitResourceLoader('planning',[]);assert.throws(()=>resources.extendResources({skillPaths:[]}),{code:'RESOURCE_DISCOVERY_DENIED'});
});
test('agent_end is never a settled runtime or business-completion signal',()=>{
  const state=new PiLifecycle();state.accept({type:'agent_start'} as AgentSessionEvent);assert.equal(state.settled,false);
  state.accept({type:'agent_end',messages:[],willRetry:true});assert.equal(state.settled,false);
  state.accept({type:'agent_settled',aborted:false});assert.equal(state.settled,true);assert.equal(state.lowLevelEnds,1);
  assert.equal('businessComplete' in state,false);
});
test('actual Pi queued follow-up runs before final settled event',async()=>{
  const {cwd,agentDir}=fixture();let calls=0,release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});
  const run=await createSyntheticPiSession({cwd,agentDir,role:'planning',sessionManager:SessionManager.inMemory(cwd),materials:[],reply:async()=>{calls++;if(calls===1)await hold;return `fixture response ${calls}`;}});
  try{
    const prompt=run.session.prompt('first');
    for(let n=0;n<200&&calls===0;n++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(calls,1);await run.session.followUp('second');assert.equal(run.lifecycle.settled,false);release();await prompt;await run.session.waitForIdle();
    assert.equal(calls,2);assert.equal(run.lifecycle.settled,true);
  }finally{release();run.dispose();}
});
