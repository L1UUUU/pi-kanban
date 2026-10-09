import { createHash } from 'node:crypto';
import { readFileSync,lstatSync,realpathSync,openSync,fstatSync,closeSync } from 'node:fs';
import { isAbsolute,relative,resolve,dirname,parse } from 'node:path';
import { release } from 'node:os';
import { RuntimeError } from './types.ts';
export const REQUIRED_WINDOWS_PROBES=['implementation-own-write','review-source-read-only','cross-demand-denied','shared-git-denied','host-control-denied','private-model-channel','network-denied','descendant-stop','kill-on-helper-close','node-pi-compatibility','reparse-denied','role-transition-clean'] as const;
interface BinaryLock{path:string;version:string;sha256:string}
export interface LockedRuntimeProfile {
  profileId:string;osBuild:string;arch:'x64';node:BinaryLock;helper:BinaryLock;worker:BinaryLock;
  pi:BinaryLock&{package:'@earendil-works/pi-coding-agent'};policySha256:string;
  evidence:{id:string;path:string;sha256:string}[];
}
function freezeDeep<T>(value:T):T{if(value&&typeof value==='object'){for(const item of Object.values(value))freezeDeep(item);Object.freeze(value);}return value;}
const verificationToken=Symbol('verified-runtime-profile');
const verified=new WeakSet<object>();
export class VerifiedRuntimeProfile {
  readonly config:LockedRuntimeProfile;readonly evidenceDigests:readonly string[];
  private constructor(token:symbol,config:LockedRuntimeProfile,digests:string[]){if(token!==verificationToken)throw new RuntimeError('ISOLATION_UNVERIFIED','Profile construction requires the independent verifier');this.config=freezeDeep(structuredClone(config));this.evidenceDigests=Object.freeze([...digests]);verified.add(this);}
  static verify(input:unknown,trustedEvidenceRoot:string):VerifiedRuntimeProfile{return verifyProfile(input,trustedEvidenceRoot,(config,digests)=>new VerifiedRuntimeProfile(verificationToken,config,digests));}
}
export function assertVerifiedProfile(value:VerifiedRuntimeProfile){if(!verified.has(value))throw new RuntimeError('ISOLATION_UNVERIFIED','Only the independent verifier can create an executable profile');}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new RuntimeError('PROFILE_INVALID','Profile object required');return value as Record<string,unknown>;}
function boundedRead(path:string,maxBytes:number):Buffer{
  const before=lstatSync(path);if(!before.isFile()||before.size>maxBytes)throw new RuntimeError('PROFILE_FILE_INVALID','Expected a bounded regular file');
  const fd=openSync(path,'r');try{const opened=fstatSync(fd);if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size>maxBytes)throw new RuntimeError('PROFILE_FILE_CHANGED','Profile source changed before open');
    const bytes=readFileSync(fd);const after=fstatSync(fd);if(after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||bytes.length!==after.size)throw new RuntimeError('PROFILE_FILE_CHANGED','Profile source changed while reading');return bytes;
  }finally{closeSync(fd);}
}
function hash(path:string,maxBytes=256*1024*1024){return createHash('sha256').update(boundedRead(path,maxBytes)).digest('hex');}
function lockedPath(path:string){
  if(typeof path!=='string'||!isAbsolute(path))throw new RuntimeError('PROFILE_PATH','Absolute locked path required');
  let cursor=resolve(path);for(;;){if(lstatSync(cursor).isSymbolicLink())throw new RuntimeError('PROFILE_PATH','Symlink or junction in locked path');const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;}
  const real=realpathSync(path);if(real.toLowerCase()!==resolve(path).toLowerCase())throw new RuntimeError('PROFILE_PATH','Locked path is not canonical');return real;
}
function verifyProfile(input:unknown,trustedEvidenceRoot:string,make:(config:LockedRuntimeProfile,digests:string[])=>VerifiedRuntimeProfile):VerifiedRuntimeProfile{
  const value=object(input);
  if(process.platform!=='win32'||process.arch!=='x64')throw new RuntimeError('WINDOWS_PROFILE_REQUIRED','Native Windows x64 is required; no platform fallback');
  const config=value as unknown as LockedRuntimeProfile;
  if(typeof config.profileId!=='string'||!config.profileId||config.arch!=='x64'||config.osBuild!==release())throw new RuntimeError('PROFILE_MACHINE_MISMATCH','Profile OS build and architecture must match this machine exactly');
  if(Number(release().split('.')[2])<22000)throw new RuntimeError('WINDOWS_11_REQUIRED','Windows 11 build or later required');
  if(!/^[a-f0-9]{64}$/.test(config.policySha256))throw new RuntimeError('POLICY_UNVERIFIED','Policy digest missing');
  for(const key of ['node','helper','worker','pi'] as const){const binary=object(config[key]);if(typeof binary.version!=='string'||!binary.version||typeof binary.sha256!=='string'||!/^[a-f0-9]{64}$/.test(binary.sha256)||typeof binary.path!=='string')throw new RuntimeError('PROFILE_BINARY_MISSING',`${key} exact lock missing`);
    if(hash(lockedPath(binary.path))!==binary.sha256)throw new RuntimeError('PROFILE_BINARY_CHANGED',`${key} digest changed`);}
  if(!/^v?24\./.test(config.node.version)||config.pi.package!=='@earendil-works/pi-coding-agent')throw new RuntimeError('PROFILE_RUNTIME_MISMATCH','Expected Node 24 and the exact official Pi package');
  if(!Array.isArray(config.evidence)||!config.evidence.length)throw new RuntimeError('ISOLATION_UNVERIFIED','No independently captured Windows evidence');
  const root=lockedPath(trustedEvidenceRoot),covered=new Set<string>(),digests:string[]=[];
  const expected={nodeSha256:config.node.sha256,helperSha256:config.helper.sha256,workerSha256:config.worker.sha256,piSha256:config.pi.sha256,policySha256:config.policySha256};
  for(const ref of config.evidence){const path=lockedPath(ref.path),rel=relative(root,path);if(rel.startsWith('..')||isAbsolute(rel)||!rel)throw new RuntimeError('EVIDENCE_SOURCE_DENIED','Evidence must be a file under the Host-owned evidence directory');
    if(!/^[a-f0-9]{64}$/.test(ref.sha256)||hash(path,1024*1024)!==ref.sha256)throw new RuntimeError('EVIDENCE_CHANGED','Evidence digest changed');
    if(lstatSync(path).size>1024*1024)throw new RuntimeError('EVIDENCE_TOO_LARGE','Bounded evidence required');
    const report=object(JSON.parse(boundedRead(path,1024*1024).toString('utf8'))),bindings=object(report.bindings);
    if(report.schemaVersion!==1||report.status!=='passed'||report.synthetic!==false||report.profileId!==config.profileId||report.osBuild!==config.osBuild||report.arch!==config.arch)
      throw new RuntimeError('EVIDENCE_INAPPLICABLE','Evidence is not actual passing evidence for this exact profile');
    for(const [key,digest]of Object.entries(expected))if(bindings[key]!==digest)throw new RuntimeError('EVIDENCE_INAPPLICABLE','Evidence was produced for different artifacts or policy');
    if(!Array.isArray(report.probes))throw new RuntimeError('EVIDENCE_INCOMPLETE','Probe outcomes are missing');
    for(const item of report.probes){const probe=object(item);if(typeof probe.id==='string'&&probe.passed===true&&typeof probe.observation==='string'&&probe.observation.length>0)covered.add(probe.id);}
    digests.push(ref.sha256);
  }
  const missing=REQUIRED_WINDOWS_PROBES.filter(id=>!covered.has(id));if(missing.length)throw new RuntimeError('EVIDENCE_INCOMPLETE',`Unverified probes: ${missing.join(', ')}`);
  return make(config,digests);
}
export function verifyWindowsRuntimeProfile(input:unknown,trustedEvidenceRoot:string):VerifiedRuntimeProfile{return VerifiedRuntimeProfile.verify(input,trustedEvidenceRoot);}
