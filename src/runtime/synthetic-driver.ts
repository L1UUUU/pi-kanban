/** TRUSTED SYNTHETIC FIXTURES ONLY. POSIX process groups are NOT an isolation backend.
 * Never use for a Pi Worker, project hooks, generated code, or untrusted repositories.
 * setsid/session escape and Host-crash kill-on-close are deliberately not claimed. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFileSync,readdirSync } from 'node:fs';
import { once } from 'node:events';
import { RuntimeError } from './types.ts';
import type { LaunchRequest,Observation,ProcessIdentity,RunRecord,RuntimeDriver } from './types.ts';

type LinuxProcess={pid:number;state:string;group:number;session:number;birth:string};
function inspect(pid:number):LinuxProcess|null{
  try{const text=readFileSync(`/proc/${pid}/stat`,'utf8');const fields=text.slice(text.lastIndexOf(')')+2).split(' ');
    return {pid,state:fields[0],group:Number(fields[2]),session:Number(fields[3]),birth:fields[19]};}
  catch{return null;}
}
function members(group:number):LinuxProcess[]{
  return readdirSync('/proc').filter(x=>/^\d+$/.test(x)).map(x=>inspect(Number(x))).filter((x):x is LinuxProcess=>!!x&&x.group===group&&x.state!=='Z');
}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
export class SyntheticProcessDriver implements RuntimeDriver {
  readonly id='linux-trusted-fixture-process-groups';
  readonly isolation='synthetic-process-supervision-only' as const;
  private stopHandler: ((runId:string,reason:string)=>Promise<void>) | null = null;
  setStopHandler(handler:(runId:string,reason:string)=>Promise<void>){this.stopHandler=handler;}
  private command:(run:RunRecord)=>{executable:string;args:string[]};
  private controls=new Map<string,{child:ChildProcess;identity:ProcessIdentity;exited:boolean}>();
  constructor(command:(run:RunRecord)=>{executable:string;args:string[]}){this.command=command;}
  preflight(request:LaunchRequest){
    if(!this.stopHandler)throw new RuntimeError('SUPERVISOR_REQUIRED','Fixture output limits need a durable supervisor stop handler');
    if(process.platform!=='linux'||request.profileId!=='synthetic-trusted-fixtures-only')
      throw new RuntimeError('SYNTHETIC_ONLY','This test driver accepts only explicit trusted Linux fixtures');
  }
  async launch(run:RunRecord):Promise<ProcessIdentity>{
    this.preflight(run);
    const command=this.command(run);
    // Caller is the trusted test harness. Nothing from Worker messages reaches this callback.
    const child=spawn(command.executable,command.args,{cwd:run.workspace,detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C',PI_KANBAN_SYNTHETIC_RUN:run.runId}});
    await once(child,'spawn');
    const processInfo=inspect(child.pid!);
    if(!processInfo)throw new RuntimeError('PROCESS_IDENTITY_UNKNOWN','Cannot obtain Linux process birth identity');
    const identity={pid:child.pid!,birth:processInfo.birth,generation:run.generation,controlId:run.runId,driver:this.id};
    const control={child,identity,exited:false};this.controls.set(run.runId,control);
    child.once('exit',()=>{control.exited=true;});
    let output=0,overflow=false;
    const consume=(chunk:Buffer)=>{output+=chunk.length;if(output>run.maxOutputBytes&&!overflow){overflow=true;
      if(this.stopHandler)void this.stopHandler(run.runId,'output-limit').catch(()=>{});
    }};
    child.stdout!.on('data',consume);child.stderr!.on('data',consume);
    return identity;
  }
  private control(run:RunRecord){
    const control=this.controls.get(run.runId);
    if(!control || !run.identity || JSON.stringify(control.identity)!==JSON.stringify(run.identity)||run.generation!==control.identity.generation)return null;
    const current=inspect(run.identity.pid);
    if(current&&current.birth!==run.identity.birth)return null;
    return control;
  }
  async observe(run:RunRecord):Promise<Observation>{
    const control=this.control(run);
    if(!control)return {state:'unknown',generation:run.generation,activePids:[],proof:'No same-generation in-memory fixture control; cannot adopt PID after restart'};
    const active=members(control.identity.pid).map(x=>x.pid);
    return {state:active.length?'alive':'stopped',generation:run.generation,activePids:active,
      proof:`Synthetic Linux /proc process-group census; generation ${run.generation}; no containment claim`};
  }
  async stop(run:RunRecord):Promise<Observation>{
    const control=this.control(run);
    if(!control)return this.observe(run);
    const signal=(value:NodeJS.Signals)=>{const group=members(control.identity.pid);if(!group.length)return;
      // Recheck birth before every signal. Never use process name, arbitrary PID, or recovered unknown handles.
      if(!this.control(run))throw new RuntimeError('PROCESS_IDENTITY_UNKNOWN','Birth identity changed before signal');
      try{process.kill(-control.identity.pid,value);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}};
    signal('SIGTERM');
    for(let count=0;count<15;count++){if(!(await this.observe(run)).activePids.length)return this.observe(run);await delay(10);}
    signal('SIGKILL');
    for(let count=0;count<100;count++){if(!(await this.observe(run)).activePids.length)return this.observe(run);await delay(10);}
    return {state:'unknown',generation:run.generation,activePids:members(control.identity.pid).map(x=>x.pid),proof:'Termination deadline exceeded; writer lease retained'};
  }
}
