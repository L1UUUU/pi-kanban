import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeRecoveryStore } from '../src/runtime/native-recovery.ts';
import type { RunRecord } from '../src/runtime/types.ts';
import type { LockedRuntimeProfile } from '../src/runtime/profile.ts';
const binary={path:'/synthetic/not-executed',sha256:'a'.repeat(64),version:'fixture'};
const profile:LockedRuntimeProfile={profileId:'synthetic-no-native-execution',osBuild:'synthetic',arch:'x64',node:binary,helper:binary,worker:binary,pi:{...binary,package:'@earendil-works/pi-coding-agent'},policySha256:'b'.repeat(64),evidence:[]};
function fixture(){const directory=mkdtempSync(join(tmpdir(),'native-recovery-test-')),store=new NativeRecoveryStore(directory);const run:RunRecord={runId:'synthetic-run',generation:'synthetic-generation',demandId:'A',role:'implementation',writes:true,grantId:'g',workspace:'/synthetic/source',profileId:profile.profileId,timeoutMs:1000,maxOutputBytes:1000,state:'running',identity:{pid:123,birth:'456',generation:'synthetic-generation',controlId:'synthetic-run',driver:'windows-appcontainer-job-v1'},stopReason:null,evidence:null,createdAt:'',updatedAt:''};const descriptor=store.prepare(run,profile);store.bind(run.runId,run.identity!);return {directory,store,run,descriptor};}
function receipt(f:ReturnType<typeof fixture>,patch:Record<string,unknown>={}){const payload=JSON.stringify({version:1,generation:f.run.generation,pid:123,birth:'456',contextSha256:f.descriptor.recoveryContextSha256,stopConfirmed:true,resourcesRevoked:true,activeProcesses:0,...patch});const mac=createHmac('sha256',Buffer.from(f.descriptor.recoveryKey,'hex')).update('pi-kanban.native-stop-receipt.v1\0').update(payload).digest('hex');writeFileSync(f.descriptor.recoveryReceiptPath,JSON.stringify({payload,mac}));}
test('synthetic receipt authentication survives a new Host store; no PID-only recovery',()=>{const f=fixture();assert.equal(f.store.observe(f.run,profile),null);receipt(f);const restarted=new NativeRecoveryStore(f.directory);assert.equal(restarted.observe(f.run,profile)?.state,'stopped');assert.equal(restarted.observe({...f.run,identity:null},profile)?.state,'stopped');assert.throws(()=>restarted.prepare(f.run,profile),{code:'RECOVERY_REPLAY'});});
test('synthetic receipt rejects tampering, different generation, process birth and revoked=false',()=>{for(const patch of [{generation:'another'},{birth:'789'},{pid:999},{resourcesRevoked:false},{activeProcesses:1},{stopConfirmed:false}]){const f=fixture();receipt(f,patch);assert.throws(()=>f.store.observe(f.run,profile),{code:'RECOVERY_RECEIPT_INVALID'});}const f=fixture();receipt(f);const envelope=JSON.parse(readFileSync(f.descriptor.recoveryReceiptPath,'utf8'));envelope.payload=envelope.payload.replace('456','457');writeFileSync(f.descriptor.recoveryReceiptPath,JSON.stringify(envelope));assert.throws(()=>f.store.observe(f.run,profile),{code:'RECOVERY_RECEIPT_INVALID'});});
test('native recovery binds exact runtime policy/artifacts and workspace',()=>{const f=fixture();receipt(f);assert.throws(()=>f.store.observe(f.run,{...profile,policySha256:'c'.repeat(64)}),{code:'RECOVERY_CONTEXT_CHANGED'});assert.throws(()=>f.store.observe({...f.run,workspace:'/different'},profile),{code:'RECOVERY_CONTEXT_CHANGED'});});

test('pre-registration crash recovery requires the explicit authenticated driver capability',async()=>{
  const { DatabaseSync }=await import('node:sqlite');const { RuntimeSupervisor }=await import('../src/runtime/supervisor.ts');
  const database=new DatabaseSync(':memory:'),directory=mkdtempSync(join(tmpdir(),'native-unregistered-')),store=new NativeRecoveryStore(directory);let captured:RunRecord|undefined;let descriptor:ReturnType<NativeRecoveryStore['prepare']>|undefined;
  const driver={id:'synthetic-recovery-test',isolation:'synthetic-process-supervision-only' as const,preflight:()=>{},launch:async(run:RunRecord)=>{captured=run;descriptor=store.prepare(run,profile);throw new Error('Synthetic crash after fixture launch before DB registration');},observe:async(run:RunRecord)=>({state:'stopped' as const,generation:run.generation,activePids:[],proof:'Generic PID absence must not recover an unregistered run'}),stop:async(run:RunRecord)=>({state:'unknown' as const,generation:run.generation,activePids:[],proof:'No fixture stop'})};
  const first=new RuntimeSupervisor(database,driver,()=>{});const f=fixture();await assert.rejects(first.launch({...f.run,demandId:'pre-registration'}));assert.ok(captured&&descriptor);assert.equal(first.get(captured.runId).identity,null);
  const generic=new RuntimeSupervisor(database,driver,()=>{});await generic.recover();assert.equal(generic.get(captured.runId).state,'unknown');
  const recovered=new RuntimeSupervisor(database,{...driver,recoverUnregistered:async(run:RunRecord)=>store.observe(run,profile)??{state:'unknown' as const,generation:run.generation,activePids:[],proof:'No authenticated fixture receipt'}},()=>{});
  await recovered.recover();assert.equal(recovered.get(captured.runId).state,'unknown');
  const payload=JSON.stringify({version:1,generation:captured.generation,pid:123,birth:'456',contextSha256:descriptor.recoveryContextSha256,stopConfirmed:true,resourcesRevoked:true,activeProcesses:0});const mac=createHmac('sha256',Buffer.from(descriptor.recoveryKey,'hex')).update('pi-kanban.native-stop-receipt.v1\0').update(payload).digest('hex');writeFileSync(descriptor.recoveryReceiptPath,JSON.stringify({payload,mac}));
  await recovered.recover();assert.equal(recovered.get(captured.runId).state,'stopped');database.close();
});

test('authenticated never-created cleanup is distinct from missing PID inference',()=>{
  const directory=mkdtempSync(join(tmpdir(),'native-never-created-')),store=new NativeRecoveryStore(directory),base=fixture(),run={...base.run,runId:'never-created-run',identity:null};const descriptor=store.prepare(run,profile);
  const payload=JSON.stringify({version:1,generation:run.generation,pid:null,birth:null,contextSha256:descriptor.recoveryContextSha256,stopConfirmed:true,resourcesRevoked:true,activeProcesses:0,neverCreated:true,terminationStatus:5});const mac=createHmac('sha256',Buffer.from(descriptor.recoveryKey,'hex')).update('pi-kanban.native-stop-receipt.v1\0').update(payload).digest('hex');
  assert.equal(store.observe(run,profile),null);writeFileSync(descriptor.recoveryReceiptPath,JSON.stringify({payload,mac}));assert.equal(store.observe(run,profile)?.state,'stopped');
  assert.throws(()=>store.observe({...run,identity:base.run.identity},profile),{code:'RECOVERY_RECEIPT_INVALID'});
});
