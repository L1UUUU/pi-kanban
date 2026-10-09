import { RuntimeError } from './types.ts';
import type { LaunchRequest, Observation, ProcessIdentity, RunRecord, RuntimeDriver } from './types.ts';

export interface WindowsRuntimeProfile {
  id:string;executionEnabled:boolean;verified:boolean;osBuild:string|null;nodeSha256:string|null;
  helperSha256:string|null;policySha256:string|null;privateChannelEvidence:string|null;
  filesystemEvidence:string|null;processTreeEvidence:string|null;networkEvidence:string|null;
}
export function profileGaps(profile:WindowsRuntimeProfile|null):string[]{
  if(!profile)return ['Windows runtime profile is missing'];
  const gaps:string[]=[];
  if(!profile.executionEnabled)gaps.push('Execution is disabled');
  if(!profile.verified)gaps.push('Isolation profile is unverified');
  for(const key of ['osBuild','privateChannelEvidence','filesystemEvidence','processTreeEvidence','networkEvidence'] as const)
    if(!profile[key])gaps.push(`${key} is missing`);
  for(const key of ['nodeSha256','helperSha256','policySha256'] as const)
    if(!/^[a-f0-9]{64}$/.test(profile[key]??''))gaps.push(`${key} is not locked`);
  return gaps;
}
/** Deliberately non-executable until native bridge and real Windows evidence are available.
 * A JSON verified=true flag alone is not security evidence. No POSIX/unrestricted fallback. */
export class WindowsCandidateDriver implements RuntimeDriver {
  readonly id='windows-appcontainer-job-candidate';
  readonly isolation='unverified-windows-candidate' as const;
  private profile:WindowsRuntimeProfile|null;
  constructor(profile:WindowsRuntimeProfile|null=null){this.profile=profile;}
  preflight(request:LaunchRequest){
    const gaps=profileGaps(this.profile);
    if(process.platform!=='win32')gaps.unshift('Native Windows 11 execution is unavailable on this host');
    if(this.profile&&request.profileId!==this.profile.id)gaps.push('Launch profile identity mismatch');
    gaps.push('Native launcher IPC/evidence verifier is not integrated; candidate execution remains disabled');
    throw new RuntimeError('ISOLATION_UNVERIFIED',gaps.join('; '));
  }
  async launch(run:RunRecord):Promise<ProcessIdentity>{this.preflight(run);throw new RuntimeError('ISOLATION_UNVERIFIED','No native launch');}
  async stop(run:RunRecord):Promise<Observation>{return this.observe(run);}
  async observe(run:RunRecord):Promise<Observation>{return {state:'unknown',generation:run.generation,activePids:[],proof:'No connected native control handle; PID absence is insufficient'};}
}
