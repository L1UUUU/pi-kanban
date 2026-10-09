import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ModelBudgetLedger } from '../src/runtime/budget.ts';
import type { ModelGrant,ReservationRequest } from '../src/runtime/budget.ts';
import { ModelBroker } from '../src/runtime/model-broker.ts';
const text='synthetic fixture only';const data=[{id:'fixture',sha256:createHash('sha256').update(text).digest('hex')}];
const grant=():ModelGrant=>({id:'g',demandId:'A',decisionId:'user-explicit-budget',provider:'synthetic',modelId:'fixture',destination:'https://synthetic.invalid/v1/messages',credentialRef:'host:test-only',data,allowedRoles:['implementation','review'],maxRequests:3,maxTokens:300,maxCostMicros:300,currency:'USD',expiresAt:new Date(Date.now()+600000).toISOString(),meteringPolicy:'synthetic-v1'});
const request=(id='r'):ReservationRequest=>({id,grantId:'g',runId:'run',role:'implementation',purpose:'prompt',provider:'synthetic',modelId:'fixture',destination:'https://synthetic.invalid/v1/messages',data,reserveTokens:100,reserveCostMicros:100});
function setup(){const db=new DatabaseSync(':memory:');const ledger=new ModelBudgetLedger(db,()=>{});ledger.grant(grant());return {db,ledger};}
test('finite explicit authorization and exact data/provider/model/destination required',()=>{
  const {db,ledger}=setup();
  assert.throws(()=>ledger.grant({...grant(),id:'bad',maxTokens:Infinity}),{code:'FINITE_BUDGET_REQUIRED'});
  for(const change of [{provider:'other'},{modelId:'other'},{destination:'https://synthetic.invalid/v1/other'},{role:'forged'}])assert.throws(()=>ledger.reserve({...request(),...change}),{code:'MODEL_SCOPE_DENIED'});
  assert.throws(()=>ledger.reserve({...request(),data:[{id:'private',sha256:data[0].sha256}]}),{code:'DATA_SCOPE_DENIED'});db.close();
});
test('concurrent in-flight reservations consume all three finite limits atomically',()=>{
  const {db,ledger}=setup();for(let i=0;i<3;i++)ledger.reserve(request(String(i)));
  assert.throws(()=>ledger.reserve(request('fourth')),{code:'BUDGET_EXHAUSTED'});
  assert.equal(ledger.snapshot('g').inFlight,3);assert.throws(()=>ledger.reserve(request('0')),{code:'REQUEST_ALREADY_RESERVED'});db.close();
});
test('unknown/abort is held, cumulative partial usage deduplicates, delayed final releases only known remainder',()=>{
  const {db,ledger}=setup();ledger.reserve(request());ledger.markUnknown('r');assert.equal(ledger.snapshot('g').costMicros,100);
  const partial={reportId:'p1',requestId:'r',tokens:20,costMicros:30,final:false,source:'test'};ledger.report(partial);ledger.report(partial);
  assert.equal(ledger.snapshot('g').tokens,100);assert.equal(ledger.snapshot('g').unknown,1);
  ledger.report({reportId:'p2',requestId:'r',tokens:40,costMicros:50,final:true,source:'delayed-billing'});
  assert.equal(ledger.snapshot('g').tokens,40);assert.equal(ledger.snapshot('g').costMicros,50);assert.equal(ledger.snapshot('g').requests,1);
  assert.throws(()=>ledger.report({...partial,tokens:30}),{code:'IDEMPOTENCY_CONFLICT'});
  assert.throws(()=>ledger.report({...partial,reportId:'down',tokens:1}),{code:'NONMONOTONIC_USAGE'});db.close();
});
test('provider exceeding reserved estimate records actual cost and blocks new calls',()=>{
  const {db,ledger}=setup();ledger.reserve(request());ledger.report({reportId:'over',requestId:'r',tokens:150,costMicros:180,final:true,source:'actual-provider-observation'});
  assert.equal(ledger.snapshot('g').costMicros,180);assert.equal(ledger.snapshot('g').blocked,true);
  assert.throws(()=>ledger.reserve(request('next')),{code:'MODEL_BLOCKED'});db.close();
});
test('restart retains reservations, safe retries and no-progress counts; ordinary continue adds nothing',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'pi-budget-')),'state.sqlite');let db=new DatabaseSync(path);let ledger=new ModelBudgetLedger(db,()=>{});
  ledger.grant(grant());ledger.reserve(request());ledger.chargeSafeAttempt('operation','not-started');ledger.recordCycle('A','issue','no-progress');db.close();
  db=new DatabaseSync(path);ledger=new ModelBudgetLedger(db,()=>{});ledger.recoverInFlight();
  assert.equal(ledger.snapshot('g').unknown,1);assert.equal(ledger.snapshot('g').tokens,100);
  assert.equal(ledger.chargeSafeAttempt('operation','known-safe'),2);assert.equal(ledger.chargeSafeAttempt('operation','known-safe'),3);
  assert.throws(()=>ledger.chargeSafeAttempt('operation','known-safe'),{code:'RETRY_LIMIT'});
  assert.throws(()=>ledger.chargeSafeAttempt('new','unknown'),{code:'SIDE_EFFECT_UNKNOWN'});
  ledger.recordCycle('A','issue','resource-wait');ledger.recordCycle('A','issue','no-progress');
  assert.throws(()=>ledger.recordCycle('A','issue','no-progress'),{code:'NO_PROGRESS_LIMIT'});
  assert.equal(ledger.snapshot('g').limits.requests,3);db.close();
});
test('explicit budget addition is authorized, persistent and idempotent',()=>{
  const {db,ledger}=setup();const addition={id:'new-budget',grantId:'g',decisionId:'user-addition',requests:1,tokens:50,costMicros:50};
  assert.throws(()=>ledger.addBudget(addition,()=>{throw new Error('not approved');}),/not approved/);
  ledger.addBudget(addition,()=>{});ledger.addBudget(addition,()=>{});assert.equal(ledger.snapshot('g').limits.requests,4);
  assert.throws(()=>ledger.addBudget({...addition,tokens:100},()=>{}),{code:'IDEMPOTENCY_CONFLICT'});db.close();
});
test('broker rechecks run after immutable reads, never forwards arbitrary URL/headers or modified material',async()=>{
  const {db,ledger}=setup();let sends=0,allowed=true;
  const transport={provider:'synthetic',modelId:'fixture',destination:grant().destination,mode:'synthetic-no-network' as const,
    async send(){sends++;return {text:'done',usage:{tokens:10,costMicros:20,source:'synthetic'}};}};
  const broker=new ModelBroker({ledger,transport,readMaterial:async id=>({id,sha256:data[0].sha256,text}),authorizeRun:()=>{if(!allowed)throw new Error('paused');}});
  await broker.request(request(),new AbortController().signal);assert.equal(sends,1);assert.equal(ledger.snapshot('g').costMicros,20);
  await assert.rejects(broker.request({...request('escape'),destination:'https://attacker.invalid/'},new AbortController().signal),{code:'TRANSPORT_SCOPE_DENIED'});
  const changed=new ModelBroker({ledger,transport,readMaterial:async id=>({id,sha256:data[0].sha256,text:'SECRET CHANGED'}),authorizeRun:()=>{}});
  await assert.rejects(changed.request(request('changed'),new AbortController().signal),{code:'MATERIAL_CHANGED'});
  const paused=new ModelBroker({ledger,transport,readMaterial:async id=>{allowed=false;return {id,sha256:data[0].sha256,text};},authorizeRun:()=>{if(!allowed)throw new Error('paused');}});
  await assert.rejects(paused.request(request('paused'),new AbortController().signal),/paused/);assert.equal(sends,1);db.close();
});
test('broker disconnect/abort retains unknown reservation and real unverified transport is denied',async()=>{
  const {db,ledger}=setup();const transport={provider:'synthetic',modelId:'fixture',destination:grant().destination,mode:'synthetic-no-network' as const,
    async send(){throw new Error('stream interrupted');}};
  const options={ledger,transport,readMaterial:async(id:string)=>({id,sha256:data[0].sha256,text}),authorizeRun:()=>{}};
  await assert.rejects(new ModelBroker(options).request(request(),new AbortController().signal),/stream interrupted/);
  assert.equal(ledger.snapshot('g').unknown,1);assert.equal(ledger.snapshot('g').costMicros,100);
  await assert.rejects(new ModelBroker({...options,transport:{...transport,mode:'real-provider'}}).request(request('real'),new AbortController().signal),{code:'CHANNEL_UNVERIFIED'});db.close();
});
