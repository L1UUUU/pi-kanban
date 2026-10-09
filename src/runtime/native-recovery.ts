import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync, existsSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import type { RunRecord, Observation, ProcessIdentity } from './types.ts';
import type { LockedRuntimeProfile } from './profile.ts';
import { RuntimeError } from './types.ts';

export interface NativeRecoveryDescriptor { recoveryReceiptPath:string; recoveryKey:string; recoveryContextSha256:string }
interface RecoveryRecord extends NativeRecoveryDescriptor { version:1; runId:string; generation:string; identity:ProcessIdentity|null }
const domain = 'pi-kanban.native-stop-receipt.v1\0';
function canonical(value:unknown):string { if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;if(value&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;return JSON.stringify(value); }
export function nativeRecoveryContext(run:RunRecord,profile:LockedRuntimeProfile):string {
  return createHash('sha256').update(canonical({runId:run.runId,generation:run.generation,demandId:run.demandId,role:run.role,workspace:run.workspace,profile})).digest('hex');
}
function noLinks(path:string) { if(!isAbsolute(path))throw new RuntimeError('RECOVERY_PATH_DENIED','Absolute Host recovery root required');for(let current=resolve(path);;current=dirname(current)){if(lstatSync(current).isSymbolicLink())throw new RuntimeError('RECOVERY_PATH_DENIED','Recovery state must not traverse links');if(current===dirname(current))break;} }
function identifier(value:string){if(!/^[a-zA-Z0-9-]{1,100}$/.test(value))throw new RuntimeError('RECOVERY_ID_INVALID','Bound native run ID required');return value;}
/** Host-only durable state. The secret is never sent to the Worker; possession of
 * arbitrary JSON or observing a PID disappearing cannot release a run lease. */
export class NativeRecoveryStore {
  readonly directory:string;
  constructor(directory:string){this.directory=resolve(directory);mkdirSync(this.directory,{recursive:true,mode:0o700});noLinks(this.directory);}
  private path(runId:string){return join(this.directory,`${identifier(runId)}.state.json`);}
  private save(record:RecoveryRecord){noLinks(this.directory);const path=this.path(record.runId),temporary=`${path}.${randomBytes(8).toString('hex')}.tmp`;writeFileSync(temporary,JSON.stringify(record),{flag:'wx',mode:0o600,flush:true});renameSync(temporary,path);}
  private read(runId:string):RecoveryRecord|null { const path=this.path(runId);if(!existsSync(path))return null;noLinks(path);if(lstatSync(path).size>16384)throw new RuntimeError('RECOVERY_STATE_INVALID','Native recovery state exceeded bound');const record=JSON.parse(readFileSync(path,'utf8')) as RecoveryRecord;
    if(record.version!==1||record.runId!==runId||!/^[a-f0-9]{64}$/.test(record.recoveryKey)||!/^[a-f0-9]{64}$/.test(record.recoveryContextSha256)||record.recoveryReceiptPath!==join(this.directory,`${runId}.receipt.json`))throw new RuntimeError('RECOVERY_STATE_INVALID','Invalid Host recovery state');return record; }
  prepare(run:RunRecord,profile:LockedRuntimeProfile):NativeRecoveryDescriptor { if(existsSync(this.path(run.runId)))throw new RuntimeError('RECOVERY_REPLAY','A native generation cannot reuse prior recovery state');const record:RecoveryRecord={version:1,runId:run.runId,generation:run.generation,identity:null,recoveryReceiptPath:join(this.directory,`${identifier(run.runId)}.receipt.json`),recoveryKey:randomBytes(32).toString('hex'),recoveryContextSha256:nativeRecoveryContext(run,profile)};this.save(record);return {recoveryReceiptPath:record.recoveryReceiptPath,recoveryKey:record.recoveryKey,recoveryContextSha256:record.recoveryContextSha256}; }
  bind(runId:string,identity:ProcessIdentity){const record=this.read(runId);if(!record||record.generation!==identity.generation||record.identity)throw new RuntimeError('RECOVERY_IDENTITY_INVALID','Recovery process identity cannot be replaced');record.identity=identity;this.save(record);}
  observe(run:RunRecord,profile:LockedRuntimeProfile):Observation|null {
    const record=this.read(run.runId);if(!record)return null;
    if(record.generation!==run.generation||record.recoveryContextSha256!==nativeRecoveryContext(run,profile))throw new RuntimeError('RECOVERY_CONTEXT_CHANGED','Stop receipt belongs to another exact native run/profile');
    if(!existsSync(record.recoveryReceiptPath))return null;noLinks(record.recoveryReceiptPath);if(lstatSync(record.recoveryReceiptPath).size>16384)throw new RuntimeError('RECOVERY_RECEIPT_INVALID','Bounded native receipt required');
    const envelope=JSON.parse(readFileSync(record.recoveryReceiptPath,'utf8')) as {payload?:unknown;mac?:unknown};
    if(typeof envelope.payload!=='string'||typeof envelope.mac!=='string'||!/^[a-f0-9]{64}$/.test(envelope.mac))throw new RuntimeError('RECOVERY_RECEIPT_INVALID','Authenticated native receipt required');
    const expected=createHmac('sha256',Buffer.from(record.recoveryKey,'hex')).update(domain).update(envelope.payload).digest();
    if(!timingSafeEqual(expected,Buffer.from(envelope.mac,'hex')))throw new RuntimeError('RECOVERY_RECEIPT_INVALID','Native receipt authentication failed');
    const receipt=JSON.parse(envelope.payload) as Record<string,unknown>,identity=run.identity??record.identity;
    const neverCreated=receipt.neverCreated===true;
    const validIdentity=neverCreated?receipt.pid===null&&receipt.birth===null&&!identity:Number.isSafeInteger(receipt.pid)&&Number(receipt.pid)>0&&typeof receipt.birth==='string'&&/^\d+$/.test(receipt.birth)&&(!identity||(identity.pid===receipt.pid&&identity.birth===receipt.birth&&identity.generation===receipt.generation));
    if(receipt.version!==1||receipt.generation!==run.generation||receipt.contextSha256!==record.recoveryContextSha256||receipt.stopConfirmed!==true||receipt.resourcesRevoked!==true||receipt.activeProcesses!==0||!validIdentity)
      throw new RuntimeError('RECOVERY_RECEIPT_INVALID','Receipt lacks exact native creation/identity, zero Job census, or revoked resources');
    return {state:'stopped',generation:run.generation,activePids:[],proof:JSON.stringify({kind:'authenticated-native-stop-receipt',receipt,receiptSha256:createHash('sha256').update(envelope.payload).digest('hex')})};
  }
}
