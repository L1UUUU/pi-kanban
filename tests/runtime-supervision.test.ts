import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,readFileSync,writeFileSync,statSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeSupervisor } from '../src/runtime/supervisor.ts';
import { WindowsCandidateDriver } from '../src/runtime/windows-driver.ts';
import { SyntheticProcessDriver } from '../src/runtime/synthetic-driver.ts';
import type { LaunchRequest,RunRecord,RuntimeDriver } from '../src/runtime/types.ts';
const root=()=>mkdtempSync(join(tmpdir(),'pi-runtime-'));
const request=(demandId='A'):LaunchRequest=>({demandId,role:'implementation',writes:true,grantId:'authorized-fixture',workspace:root(),profileId:'synthetic-trusted-fixtures-only',timeoutMs:10000,maxOutputBytes:65536});
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate:()=>boolean){for(let i=0;i<200;i++){if(predicate())return;await delay(10);}throw new Error('Condition did not occur');}
function inert():RuntimeDriver{return {id:'test',isolation:'synthetic-process-supervision-only',preflight(){},
  async launch(run){return {pid:42,birth:'test-birth',generation:run.generation,controlId:run.runId,driver:'test'};},
  async stop(run){return {state:'stopped',generation:run.generation,activePids:[],proof:'trusted deterministic fixture'};},
  async observe(run){return {state:'unknown',generation:run.generation,activePids:[],proof:'No native evidence'};}};}

test('production driver rejects unverified isolation and never falls back',async()=>{
  const db=new DatabaseSync(':memory:');const runtime=new RuntimeSupervisor(db,new WindowsCandidateDriver(),()=>{});
  await assert.rejects(runtime.launch(request()),{code:'ISOLATION_UNVERIFIED'});assert.equal(runtime.list().length,0);db.close();
});
test('same Host authorizer, one writer, two demands and one high resource check',async()=>{
  const db=new DatabaseSync(':memory:');const runtime=new RuntimeSupervisor(db,inert(),x=>{if(x.demandId==='C')throw new Error('unapproved idea');});
  const a=await runtime.launch(request()),u=await runtime.launch(request('U'));
  await assert.rejects(runtime.launch(request()),{code:'WRITER_OCCUPIED'});
  await assert.rejects(runtime.launch(request('B')),{code:'DEMAND_CAPACITY'});
  await assert.rejects(runtime.launch(request('C')),/unapproved idea/);
  await runtime.stop(a.runId);await runtime.stop(u.runId);
  const first=await runtime.launch({...request(),writes:false,role:'check',highResource:true});
  await assert.rejects(runtime.launch({...request('U'),writes:false,role:'check',highResource:true}),{code:'CHECK_CAPACITY'});
  await runtime.stop(first.runId);db.close();
});
test('launch intention precedes side effect and pause racing launch is honored',async()=>{
  const db=new DatabaseSync(':memory:');const driver=inert();let release!:()=>void;
  const pending=new Promise<void>(r=>{release=r;});
  driver.launch=async run=>{assert.equal(runtime.get(run.runId).state,'launch_intent');await pending;return {pid:42,birth:'birth',generation:run.generation,controlId:run.runId,driver:'test'};};
  const runtime=new RuntimeSupervisor(db,driver,()=>{});const launch=runtime.launch(request());
  const run=runtime.list()[0];assert.equal((await runtime.stop(run.runId,'paused-during-launch')).state,'stop_requested');
  release();const result=await launch;assert.equal(result.state,'stopped');assert.equal(result.stopReason,'paused-during-launch');db.close();
});
test('FI-03 launch failure after side effect stays unknown and retains writer',async()=>{
  const directory=root(),path=join(directory,'runtime.sqlite');let db=new DatabaseSync(path);let calls=0;const driver=inert();
  driver.launch=async()=>{calls++;throw new Error('crash after spawn before registration');};
  let runtime=new RuntimeSupervisor(db,driver,()=>{});
  await assert.rejects(runtime.launch(request()),/crash after spawn/);assert.equal(runtime.list()[0].state,'unknown');db.close();
  db=new DatabaseSync(path);runtime=new RuntimeSupervisor(db,inert(),()=>{});await runtime.recover();
  await assert.rejects(runtime.launch(request()),{code:'WRITER_OCCUPIED'});assert.equal(calls,1);db.close();
});
test('mismatched generation, PID absence and surviving child do not prove stopped',async()=>{
  const db=new DatabaseSync(':memory:');const driver=inert();const runtime=new RuntimeSupervisor(db,driver,()=>{});const run=await runtime.launch(request());
  driver.stop=async r=>({state:'stopped',generation:'reused-generation',activePids:[],proof:'wrong identity'});
  assert.equal((await runtime.stop(run.runId)).state,'unknown');
  driver.observe=async r=>({state:'stopped',generation:r.generation,activePids:[99],proof:'parent missing, child alive'});
  await runtime.recover();assert.equal(runtime.get(run.runId).state,'unknown');db.close();
});
test('runtime timeout persists stop reason and does not wait for UI',async()=>{
  const db=new DatabaseSync(':memory:');const runtime=new RuntimeSupervisor(db,inert(),()=>{});
  const run=await runtime.launch({...request(),timeoutMs:20});await until(()=>runtime.get(run.runId).state==='stopped');
  assert.equal(runtime.get(run.runId).stopReason,'active-time-limit');db.close();
});
test('Linux SYNTHETIC process supervision: A descendants stop writing while U continues; no isolation claim',{skip:process.platform!=='linux'},async()=>{
  const directory=root();const fixture=join(directory,'trusted-fixture.cjs');
  writeFileSync(fixture,`const fs=require('node:fs');const cp=require('node:child_process');const p=require('node:path');
    process.on('SIGTERM',()=>{});const out=process.argv[2];
    if(process.argv[3]!=='child')cp.spawn(process.execPath,[__filename,out,'child'],{stdio:'ignore'});
    setInterval(()=>fs.appendFileSync(out,process.pid+'\\n'),10);`);
  const driver=new SyntheticProcessDriver(run=>({executable:process.execPath,args:[fixture,join(run.workspace,'writes.log')]}));
  const db=new DatabaseSync(join(directory,'state.sqlite'));const runtime=new RuntimeSupervisor(db,driver,()=>{});
  const a=await runtime.launch(request()),u=await runtime.launch(request('U'));
  try{
    await until(()=>{try{return new Set(readFileSync(join(a.workspace,'writes.log'),'utf8').trim().split('\n')).size===2;}catch{return false;}});
    await until(()=>{try{return statSync(join(u.workspace,'writes.log')).size>0;}catch{return false;}});
    assert.equal((await runtime.stop(a.runId,'pause A')).state,'stopped');
    const aBytes=statSync(join(a.workspace,'writes.log')).size,uBytes=statSync(join(u.workspace,'writes.log')).size;
    await delay(120);assert.equal(statSync(join(a.workspace,'writes.log')).size,aBytes);assert.ok(statSync(join(u.workspace,'writes.log')).size>uBytes);
    assert.equal(runtime.get(u.runId).state,'running');
  }finally{await runtime.stopAll('fixture-cleanup');db.close();}
});
test('Linux SYNTHETIC restart cannot adopt an unknown PID or create a duplicate writer',{skip:process.platform!=='linux'},async()=>{
  const dir=root();const driver=new SyntheticProcessDriver(()=>({executable:process.execPath,args:['-e','setInterval(()=>{},1000)']}));
  const db=new DatabaseSync(join(dir,'state.sqlite'));const first=new RuntimeSupervisor(db,driver,()=>{});const run=await first.launch(request());
  const second=new RuntimeSupervisor(db,new SyntheticProcessDriver(()=>{throw new Error('Must not spawn');}),()=>{});
  await second.recover();assert.equal(second.get(run.runId).state,'unknown');
  await assert.rejects(second.launch(request()),{code:'WRITER_OCCUPIED'});
  await first.stop(run.runId,'cleanup with original control');db.close();
});
test('output overflow records durable stop intent and immediately denies dispatch',{skip:process.platform!=='linux'},async()=>{
  const db=new DatabaseSync(':memory:');const driver=new SyntheticProcessDriver(()=>({executable:process.execPath,args:['-e',`process.on('SIGTERM',()=>{});setInterval(()=>process.stdout.write('x'.repeat(1024)),10)`]}));
  const runtime=new RuntimeSupervisor(db,driver,()=>{});const run=await runtime.launch({...request(),maxOutputBytes:10});
  try{await until(()=>runtime.get(run.runId).stopReason==='output-limit');assert.equal(runtime.isDispatchAllowed(run.runId),false);
    assert.equal(runtime.get(run.runId).stopReason,'output-limit');await until(()=>runtime.get(run.runId).state==='stopped');}
  finally{await runtime.stopAll('cleanup');db.close();}
});
test('normal observation preserves live state and proves natural fixture exit without assuming agent completion',{skip:process.platform!=='linux'},async()=>{
  const db=new DatabaseSync(':memory:');const driver=new SyntheticProcessDriver(()=>({executable:process.execPath,args:['-e','setTimeout(()=>{},150)']}));
  const runtime=new RuntimeSupervisor(db,driver,()=>{});const run=await runtime.launch(request());
  assert.equal((await runtime.observe(run.runId)).state,'running');
  for(let i=0;i<100&&runtime.get(run.runId).state!=='stopped';i++){await delay(10);await runtime.observe(run.runId);}
  assert.equal(runtime.get(run.runId).state,'stopped');assert.equal(runtime.get(run.runId).stopReason,null);db.close();
});
