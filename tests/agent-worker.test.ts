import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes,createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { runWorkerFromStreams,validateWorkerInit } from '../src/agent/worker-runtime.ts';
import type { WorkerInit } from '../src/agent/worker-runtime.ts';
import { PrivateFrameDecoder,encodePrivateFrame } from '../src/runtime/pipe-frames.ts';
import { ModelBudgetLedger } from '../src/runtime/budget.ts';
import { ModelBroker } from '../src/runtime/model-broker.ts';
import { HostPiBrokerEndpoint } from '../src/runtime/pi-channel.ts';
import { controlledTools } from '../src/agent/controlled-tools.ts';
import { verifyWindowsRuntimeProfile,assertVerifiedProfile,VerifiedRuntimeProfile } from '../src/runtime/profile.ts';

function fixture(){const root=mkdtempSync(join(tmpdir(),'pi-worker-')),workspace=join(root,'source'),scratch=join(root,'scratch'),sessions=join(scratch,'sessions');mkdirSync(workspace);mkdirSync(sessions,{recursive:true});return {root,workspace,scratch,sessions};}
function boot():WorkerInit{const f=fixture();return {version:1,type:'worker.init',runId:'runtime-1',generation:'generation-1',demandId:'A',domainRunId:'domain-1',domainGeneration:1,role:'implementation',workspace:f.workspace,scratch:f.scratch,sessionDir:f.sessions,sessionId:'native-session-1',capability:randomBytes(32).toString('hex'),prompt:'Execute a synthetic controlled report; no paid model.',materials:[],model:{provider:'one',id:'fixture',contextWindow:32768,maxTokens:128},compaction:{enabled:false,reserveTokens:1024,keepRecentTokens:64},retry:{enabled:false,maxRetries:0,baseDelayMs:1},limits:{maxFileBytes:1024,maxOutputBytes:8192,commandTimeoutMs:2000}};}

test('actual production Worker bootstrap + SDK tools + framed Host broker/report receipt executes in synthetic streams',async()=>{
  const init=boot(),db=new DatabaseSync(':memory:'),ledger=new ModelBudgetLedger(db,()=>{});let providerCalls=0,reports=0,checks=0;const events:string[]=[];
  ledger.grant({id:'g',demandId:'A',decisionId:'synthetic-source-and-derived-scope',provider:'one',modelId:'fixture',destination:'https://provider.invalid/v1/messages',credentialRef:'HOST-ONLY',data:[{id:'scope',sha256:createHash('sha256').update('fixture').digest('hex')}],allowedRoles:['implementation'],maxRequests:5,maxTokens:50000,maxCostMicros:5000,currency:'USD',expiresAt:new Date(Date.now()+60000).toISOString(),meteringPolicy:'test',contextPolicy:'approved-run-derived-v1'});
  let endpoint:HostPiBrokerEndpoint;
  const broker=new ModelBroker({ledger,readMaterial:async id=>endpoint.readMaterial(id),authorizeRun:()=>{},transport:{provider:'one',modelId:'fixture',destination:'https://provider.invalid/v1/messages',mode:'synthetic-no-network',async send(){providerCalls++;return providerCalls===1?{text:'',toolCalls:[{id:'node-1',name:'controlled_node',arguments:{args:['--version']}}],usage:{tokens:5,costMicros:5,source:'deterministic'}}:providerCalls===2?{text:'',toolCalls:[{id:'report-1',name:'controlled_report',arguments:{report:{type:'blocked',reason:'synthetic missing input'}}}],usage:{tokens:5,costMicros:5,source:'deterministic'}}:{text:'Reported synthetic blocker through the actual controlled tool.',usage:{tokens:5,costMicros:5,source:'deterministic'}};}}});
  endpoint=new HostPiBrokerEndpoint({db,ledger,broker,binding:{...init,grantId:'g',reserveTokens:10000,reserveCostMicros:1000},authorizeRun:()=>{},authorizeContext:async()=>({decisionId:'synthetic-source-and-derived-scope'})});
  const toWorker=new PassThrough(),fromWorker=new PassThrough(),decoder=new PrivateFrameDecoder();
  const send=(value:unknown)=>toWorker.write(encodePrivateFrame(Buffer.from(JSON.stringify(value))));
  const dispatches:Promise<unknown>[]=[];
  fromWorker.on('data',(chunk:Buffer)=>{for(const frame of decoder.push(chunk)){const value=JSON.parse(Buffer.from(frame).toString()) as Record<string,unknown>;events.push(String(value.type));
    if(value.type==='model.request')dispatches.push(endpoint.handle(frame,new AbortController().signal).then(result=>send({sequence:value.sequence,ok:true,value:result})));
    if(value.type==='worker.check-request'){checks++;assert.equal(value.toolCallId,'node-1');assert.deepEqual(value.args,['--version']);send({type:'worker.check-result',requestId:value.requestId,ok:true,value:{requestId:value.requestId,exitCode:0,output:'synthetic native reply, not a Windows execution',reason:'exited',nativeEvidence:{synthetic:true},evidence:{id:'fixture-check'}}});}
    if(value.type==='worker.report'){const report=value.report as Record<string,unknown>;reports++;assert.equal(report.runId,'domain-1');assert.equal(report.generation,1);assert.equal(report.type,'blocked');send({type:'worker.receipt',requestId:report.requestId,ok:true,value:{status:'applied'}});}
  }});
  const running=runWorkerFromStreams(toWorker,fromWorker,init.generation);send(init);
  await running;await Promise.all(dispatches);assert.equal(providerCalls,3);assert.equal(reports,1);assert.equal(checks,1);assert.ok(events.includes('worker.ready'));assert.ok(events.includes('worker.settled'));assert.equal(ledger.snapshot('g').requests,3);
  toWorker.destroy();fromWorker.destroy();db.close();
});
test('Worker bootstrap rejects generation mismatch and incomplete finite limits',()=>{
  const value=boot();assert.throws(()=>validateWorkerInit(value,'other'),{code:'WORKER_BOOTSTRAP_INVALID'});
  assert.throws(()=>validateWorkerInit({...value,limits:{maxFileBytes:1}},value.generation),{code:'FINITE_POLICY_REQUIRED'});
});
test('controlled tools constrain paths and reviewer writes; no OS containment claimed',async()=>{
  const f=fixture();writeFileSync(join(f.workspace,'hello.txt'),'allowed');mkdirSync(join(f.workspace,'.git'));writeFileSync(join(f.workspace,'.git','secret'),'denied');
  const options={workspace:f.workspace,scratch:f.scratch,role:'review' as const,maxFileBytes:1024,commandTimeoutMs:1000,maxOutputBytes:1024,report:async()=>({}),stopRequired:()=>{}};
  const tools=controlledTools(options),read=tools.find(x=>x.name==='controlled_read')!;assert.equal(tools.some(x=>x.name==='controlled_write'),false);
  const execute=(args:unknown)=>read.execute('test',args,undefined,undefined,{} as never);
  assert.equal((await execute({path:'hello.txt'})).content[0].type,'text');
  for(const path of ['../host.sqlite','.git/secret',join(f.root,'outside')])await assert.rejects(execute({path}),{code:'TOOL_PATH_DENIED'});
  if(process.platform!=='win32'){symlinkSync(f.root,join(f.workspace,'escape'));await assert.rejects(execute({path:'escape/outside'}),{code:'TOOL_PATH_DENIED'});}
  const write=controlledTools({...options,role:'implementation'}).find(x=>x.name==='controlled_write')!;
  await write.execute('test',{path:'new/file.txt',content:'saved'},undefined,undefined,{} as never);assert.equal(readFileSync(join(f.workspace,'new/file.txt'),'utf8'),'saved');
});
test('runtime evidence cannot be enabled by a forged verified object or Linux profile flag',()=>{
  assert.throws(()=>Reflect.construct(VerifiedRuntimeProfile,[{},[]]),{code:'ISOLATION_UNVERIFIED'});
  assert.throws(()=>assertVerifiedProfile({config:{verified:true}} as unknown as VerifiedRuntimeProfile),{code:'ISOLATION_UNVERIFIED'});
  if(process.platform!=='win32')assert.throws(()=>verifyWindowsRuntimeProfile({executionEnabled:true,verified:true},tmpdir()),{code:'WINDOWS_PROFILE_REQUIRED'});
});
test('derived model contexts require an explicit context policy, without increasing budget',()=>{
  const db=new DatabaseSync(':memory:'),ledger=new ModelBudgetLedger(db,()=>{}),sha='a'.repeat(64);
  ledger.grant({id:'g',demandId:'A',decisionId:'exact-only',provider:'test',modelId:'test',destination:'https://provider.invalid/v1',credentialRef:'fake',data:[{id:'one',sha256:sha}],allowedRoles:['review'],maxRequests:1,maxTokens:100,maxCostMicros:100,currency:'USD',expiresAt:new Date(Date.now()+60000).toISOString(),meteringPolicy:'test'});
  assert.throws(()=>ledger.authorizeData({grantId:'g',decisionId:'not-enough-to-expand',material:{id:'derived',sha256:sha}},()=>{}),{code:'DERIVED_CONTEXT_DENIED'});
  assert.equal(ledger.snapshot('g').limits.requests,1);db.close();
});

test('controlled_node has no in-Worker spawn fallback and preserves independent native proof',async()=>{
  const f=fixture(),base={workspace:f.workspace,scratch:f.scratch,role:'review' as const,maxFileBytes:1024,commandTimeoutMs:1000,maxOutputBytes:1024,report:async()=>({}),stopRequired:()=>{}};
  const disabled=controlledTools(base).find(x=>x.name==='controlled_node')!;
  await assert.rejects(disabled.execute('tool-1',{args:['--version']},undefined,undefined,{} as never),{code:'NATIVE_CHECK_UNAVAILABLE'});
  let called=0;const tool=controlledTools({...base,check:async(id:string,args:string[])=>{called++;assert.equal(id,'tool-2');assert.deepEqual(args,['--version']);return {output:'v24.19.0',exitCode:0,reason:'exited',nativeEvidence:{generation:'native-generation',pid:1},evidence:{id:'native-check'}};}}).find(x=>x.name==='controlled_node')!;
  const result=await tool.execute('tool-2',{args:['--version']},undefined,undefined,{} as never);assert.equal(called,1);assert.equal((result.details as {evidence:{id:string}}).evidence.id,'native-check');
});
