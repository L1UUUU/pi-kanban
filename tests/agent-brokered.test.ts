import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes,createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { Type } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createBrokeredPiSession } from '../src/agent/brokered-pi.ts';
import { ModelBudgetLedger } from '../src/runtime/budget.ts';
import { ModelBroker } from '../src/runtime/model-broker.ts';
import type { ProviderResponse,BoundedTransportRequest } from '../src/runtime/model-broker.ts';
import { HostPiBrokerEndpoint,FramedPiModelChannel,parsePiModelFrame } from '../src/runtime/pi-channel.ts';
import { PrivateFrameDecoder,encodePrivateFrame,PrivateModelPipeServer,PrivateModelPipeClient } from '../src/runtime/pipe-frames.ts';

function harness(send:(request:BoundedTransportRequest)=>Promise<ProviderResponse>){
  const db=new DatabaseSync(':memory:'),ledger=new ModelBudgetLedger(db,()=>{}),cwd=mkdtempSync(join(tmpdir(),'pi-brokered-'));
  const sessionManager=SessionManager.inMemory(cwd),binding={runId:'A-run',generation:'generation-1',sessionId:sessionManager.getSessionId(),capability:randomBytes(32).toString('hex'),grantId:'g',role:'implementation',reserveTokens:10000,reserveCostMicros:1000};
  ledger.grant({id:'g',demandId:'A',decisionId:'explicit-synthetic-derived-transcripts',provider:'bounded-test',modelId:'one-model',destination:'https://provider.invalid/v1/messages',credentialRef:'HOST-ONLY-FAKE-REFERENCE',
    data:[{id:'initial-synthetic-scope',sha256:createHash('sha256').update('synthetic fixture').digest('hex')}],allowedRoles:['implementation'],maxRequests:10,maxTokens:100000,maxCostMicros:10000,currency:'USD',expiresAt:new Date(Date.now()+60000).toISOString(),meteringPolicy:'finite-synthetic'});
  let endpoint:HostPiBrokerEndpoint;const purposes:string[]=[];let calls=0;let allowed=true;
  const broker=new ModelBroker({ledger,transport:{provider:'bounded-test',modelId:'one-model',destination:'https://provider.invalid/v1/messages',mode:'synthetic-no-network',send:async request=>{calls++;return send(request);}},
    readMaterial:async id=>endpoint.readMaterial(id),authorizeRun:()=>{if(!allowed)throw new Error('paused');}});
  endpoint=new HostPiBrokerEndpoint({db,ledger,broker,binding,authorizeRun:()=>{if(!allowed)throw new Error('paused');},authorizeContext:async(material,request)=>{
    // Explicit fixture-only Host authority. Production must check the already-approved
    // source scope and verified OS boundary; never trust a Worker self-attestation.
    assert.doesNotMatch(material.text,/HOST-ONLY-FAKE-REFERENCE/);purposes.push(request.purpose);return {decisionId:'explicit-synthetic-derived-transcripts'};
  }});
  const channel=new FramedPiModelChannel(binding,(frame,signal)=>endpoint.handle(frame,signal));
  return {db,ledger,cwd,sessionManager,binding,endpoint,channel,purposes,get calls(){return calls;},pause(){allowed=false;}};
}
const model={provider:'bounded-test',id:'one-model',contextWindow:32768,maxTokens:256};
const compaction={enabled:false,reserveTokens:1024,keepRecentTokens:32};
const retry={enabled:false,maxRetries:0,baseDelayMs:1};

test('actual SDK tool loop routes every call through Host broker and persisted finite budget',async()=>{
  let count=0,tools=0;const h=harness(async request=>{
    assert.equal(request.credentialRef,'HOST-ONLY-FAKE-REFERENCE');assert.equal(request.destination,'https://provider.invalid/v1/messages');count++;
    return count===1?{text:'',toolCalls:[{id:'call-1',name:'controlled_read_fixture',arguments:{}}],usage:{tokens:100,costMicros:10,source:'synthetic-provider'}}:
      {text:'Genuine SDK loop with deterministic provider transport',usage:{tokens:150,costMicros:20,source:'synthetic-provider'}};
  });
  const run=await createBrokeredPiSession({cwd:h.cwd,agentDir:h.cwd,role:'implementation',materials:[],sessionManager:h.sessionManager,channel:h.channel,model,compaction,retry,
    tools:[{name:'controlled_read_fixture',label:'Read synthetic fixture',description:'Read only a named fixture through the controlled bridge',parameters:Type.Object({}),
      async execute(){tools++;return {content:[{type:'text',text:'SYNTHETIC-AUTHORIZED-TOOL-CONTENT'}],details:{}};}}]});
  try{await run.session.prompt('Read the synthetic fixture.');assert.equal(tools,1);assert.equal(h.calls,2);assert.equal(h.ledger.snapshot('g').requests,2);
    assert.equal(h.ledger.snapshot('g').costMicros,30);assert.equal(run.lifecycle.settled,true);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM pi_authorized_contexts').get()!.n,2);
  }finally{run.dispose();h.db.close();}
});
test('actual SDK automatic retry is a separately reserved broker request; failed usage stays held',async()=>{
  let count=0;const h=harness(async()=>{count++;if(count===1)throw new Error('429 rate limit exceeded');return {text:'retry succeeded',usage:{tokens:10,costMicros:10,source:'synthetic-provider'}};});
  const run=await createBrokeredPiSession({cwd:h.cwd,agentDir:h.cwd,role:'implementation',materials:[],sessionManager:h.sessionManager,channel:h.channel,model,compaction,retry:{enabled:true,maxRetries:2,baseDelayMs:1},tools:[]});
  try{await run.session.prompt('A request with one transient failure');assert.equal(h.calls,2);assert.deepEqual(h.purposes,['prompt','retry']);
    assert.equal(h.ledger.snapshot('g').requests,2);assert.equal(h.ledger.snapshot('g').unknown,1);assert.equal(h.ledger.snapshot('g').costMicros,1010);
  }finally{run.dispose();h.db.close();}
});
test('actual SDK manual compaction also uses Host channel and does not reset usage',async()=>{
  const h=harness(async()=>({text:'Synthetic bounded summary or answer.',usage:{tokens:40,costMicros:10,source:'synthetic-provider'}}));
  const run=await createBrokeredPiSession({cwd:h.cwd,agentDir:h.cwd,role:'implementation',materials:[],sessionManager:h.sessionManager,channel:h.channel,model,compaction,retry,tools:[]});
  try{
    await run.session.prompt('Synthetic context '.repeat(600));await run.session.prompt('A second synthetic turn '.repeat(100));
    const before=h.ledger.snapshot('g').requests;await run.session.compact('Summarize only synthetic fixture context.');
    assert.ok(h.ledger.snapshot('g').requests>before);assert.ok(h.purposes.includes('compaction'));assert.ok(h.sessionManager.getBranch().some(x=>x.type==='compaction'));
  }finally{run.dispose();h.db.close();}
});
test('model-only frame rejects forged generation, destinations, oversized payload and replay before dispatch',async()=>{
  const h=harness(async()=>({text:'ok',usage:{tokens:1,costMicros:1,source:'test'}}));
  // grant/role/reservation are Host binding only and MUST NOT appear in the wire frame.
  const wire={version:1,type:'model.request',capability:h.binding.capability,runId:h.binding.runId,generation:h.binding.generation,sessionId:h.binding.sessionId,sequence:1,purpose:'prompt',context:{messages:[]}};
  assert.throws(()=>parsePiModelFrame(Buffer.from(JSON.stringify({...wire,destination:'https://attacker.invalid/'}))),{code:'FRAME_FIELDS'});
  assert.throws(()=>parsePiModelFrame(Buffer.alloc(1024*1024+1)),{code:'FRAME_SIZE'});
  await assert.rejects(h.endpoint.handle(Buffer.from(JSON.stringify({...wire,generation:'wrong'})),new AbortController().signal),{code:'CHANNEL_IDENTITY_DENIED'});
  await h.endpoint.handle(Buffer.from(JSON.stringify(wire)),new AbortController().signal);
  await assert.rejects(h.endpoint.handle(Buffer.from(JSON.stringify(wire)),new AbortController().signal),{code:'CHANNEL_REPLAY'});
  assert.equal(h.calls,1);h.db.close();
});
test('private inherited-pipe codec handles split frames and rejects length/truncation',()=>{
  const decoder=new PrivateFrameDecoder(),encoded=encodePrivateFrame(Buffer.from('hello'));
  assert.equal(decoder.push(encoded.subarray(0,2)).length,0);assert.equal(decoder.push(encoded.subarray(2,5)).length,0);
  assert.equal(Buffer.from(decoder.push(encoded.subarray(5))[0]).toString(),'hello');decoder.finish();
  assert.throws(()=>new PrivateFrameDecoder().push(Buffer.from([255,255,255,255])),{code:'FRAME_SIZE'});
  const incomplete=new PrivateFrameDecoder();incomplete.push(encoded.subarray(0,5));assert.throws(()=>incomplete.finish(),{code:'FRAME_TRUNCATED'});
});
test('actual model pipe server/client correlates response sequence and cancellation aborts pending request',async()=>{
  const toHost=new PassThrough(),toWorker=new PassThrough();let cancelled=false;
  const server=new PrivateModelPipeServer(toHost,toWorker,async(frame,signal)=>{
    const req=parsePiModelFrame(frame);if(req.sequence===1)return {text:'bounded pipe response'};
    return await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{cancelled=true;reject(signal.reason);},{once:true});});
  });
  const client=new PrivateModelPipeClient(toWorker,toHost),binding={runId:'run',generation:'generation',sessionId:'session',capability:'a'.repeat(64)};
  const wire=(sequence:number)=>Buffer.from(JSON.stringify({version:1,type:'model.request',...binding,sequence,purpose:'prompt',context:{messages:[]}}));
  const value=await client.send(wire(1),new AbortController().signal);assert.deepEqual(value,{text:'bounded pipe response'});
  const abort=new AbortController();const pending=client.send(wire(2),abort.signal);abort.abort();await assert.rejects(pending,{code:'MODEL_ABORTED'});
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(cancelled,true);server.close();client.close();
});
