import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { readFileSync,realpathSync,lstatSync } from 'node:fs';
import { release } from 'node:os';
import { resolve } from 'node:path';
import { RuntimeError } from './types.ts';
import type { LaunchRequest,RunRecord,RuntimeDriver,ProcessIdentity,Observation } from './types.ts';
import { VerifiedRuntimeProfile,assertVerifiedProfile } from './profile.ts';
import { PrivateFrameDecoder,encodePrivateFrame } from './pipe-frames.ts';
import { readLockedShellManifest } from './shell-profile.ts';
import { appContainerProfileName } from './appcontainer-name.ts';
import { NativeRecoveryStore } from './native-recovery.ts';
import { validateNativeCheckReceipt } from './native-check.ts';
import type { NativeCheckResult } from './native-check.ts';
export type { NativeCheckResult } from './native-check.ts';

export interface WindowsRunBootstrap {
  profileName:string;scratch:string;aclEvidence:string;privateChannelEvidence:string;
  processLimit:number;memoryLimitBytes:number;diskLimitBytes:number;fileLimit:number;minimumFreeBytes:number;diskPollMs:number;workerInit:Record<string,unknown>;
  resourceAuthorizationId:string;readonlyRuntimeRoots:string[];
}
type PendingCheck={id:string;args:string[];maxOutputBytes:number;resolve:(value:NativeCheckResult)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};
type Control={helper:ChildProcessWithoutNullStreams;run:RunRecord;identity:ProcessIdentity|null;observation:Observation|null;exit:boolean;native:PrivateFrameDecoder;worker:PrivateFrameDecoder;waiters:Set<()=>void>;resources:{provisioned:boolean;revoked:boolean;status:number|null};check:PendingCheck|null;stopping:boolean};
/** Native production path. Construction requires independently verified exact Windows artifacts.
 * createBootstrap must supply per-run pre-provisioned ACLs and an approved model/data context.
 * No ambient shell, user config, credential, arbitrary binary or fallback is exposed. */
export class VerifiedWindowsDriver implements RuntimeDriver {
  readonly id='windows-appcontainer-job-v1';readonly isolation='verified-windows-native' as const;
  private profile:VerifiedRuntimeProfile;private bootstrap:(run:RunRecord)=>WindowsRunBootstrap;
  private recovery:NativeRecoveryStore|null;
  private recovered=new Set<string>();
  private controls=new Map<string,Control>();private stopHandler:((id:string,reason:string)=>Promise<void>)|null=null;
  private workerHandler:((run:RunRecord,frame:Uint8Array)=>Promise<void>)|null=null;
  constructor(profile:VerifiedRuntimeProfile,createBootstrap:(run:RunRecord)=>WindowsRunBootstrap,recoveryDirectory?:string){assertVerifiedProfile(profile);this.profile=profile;this.bootstrap=createBootstrap;this.recovery=recoveryDirectory?new NativeRecoveryStore(recoveryDirectory):null;}
  setStopHandler(handler:(runId:string,reason:string)=>Promise<void>){this.stopHandler=handler;}
  setWorkerFrameHandler(handler:(run:RunRecord,frame:Uint8Array)=>Promise<void>){this.workerHandler=handler;}
  preflight(request:LaunchRequest){
    assertVerifiedProfile(this.profile);const config=this.profile.config;
    if(process.platform!=='win32'||process.arch!=='x64'||release()!==config.osBuild||request.profileId!==config.profileId)throw new RuntimeError('PROFILE_MACHINE_MISMATCH','Runtime/profile changed since verification');
    for(const binary of [config.node,config.helper,config.worker,config.pi])if(createHash('sha256').update(readFileSync(binary.path)).digest('hex')!==binary.sha256)throw new RuntimeError('PROFILE_BINARY_CHANGED','Runtime artifact changed since evidence verification');
    if(lstatSync(request.workspace).isSymbolicLink()||realpathSync(request.workspace).toLowerCase()!==resolve(request.workspace).toLowerCase())throw new RuntimeError('WORKSPACE_PATH_CHANGED','Workspace is no longer canonical');
    if(!this.stopHandler||!this.workerHandler)throw new RuntimeError('NATIVE_CHANNEL_UNBOUND','Trusted stop and Worker dispatch handlers must be bound before launch');
  }
  private command(control:Control,value:unknown){
    if(control.exit||control.helper.stdin.destroyed)throw new RuntimeError('NATIVE_CHANNEL_CLOSED','Native helper control is closed');
    const frame=encodePrivateFrame(Buffer.from(JSON.stringify(value)));
    if(control.helper.stdin.writableLength+frame.length>2*1024*1024)throw new RuntimeError('NATIVE_BACKPRESSURE','Native input pipe queue exceeded bounds');
    control.helper.stdin.write(frame);
  }
  sendWorkerFrame(runId:string,frame:unknown){const control=this.controls.get(runId);if(!control)throw new RuntimeError('RUN_NOT_FOUND','No bound native run');this.command(control,{type:'worker-input',payload:frame});}
  private changed(control:Control){for(const wake of control.waiters)wake();control.waiters.clear();}
  private async wait(control:Control,predicate:()=>boolean,timeout:number){
    const deadline=Date.now()+timeout;while(!predicate()&&!control.exit&&Date.now()<deadline){await new Promise<void>(resolve=>{const timer=setTimeout(()=>{control.waiters.delete(wake);resolve();},Math.min(100,deadline-Date.now()));const wake=()=>{clearTimeout(timer);resolve();};control.waiters.add(wake);});}
  }
  getResourceEvidence(runId:string){const control=this.controls.get(runId);return this.recovered.has(runId)?{provisioned:true,revoked:true,status:0}:control?{...control.resources}:null;}
  private nativeEvent(control:Control,frame:Uint8Array){
    const event=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(frame)) as Record<string,unknown>;
    if(event.type==='native.started'){
      if(event.policyAccessVerified!==true||event.allApplicationPackagesReadable!==(this.profile.config.policyVariant==='appcontainer-no-network-v3')||event.policyVariant!==(this.profile.config.policyVariant??'lpac-strict-v1')||event.generation!==control.run.generation||!Number.isSafeInteger(event.pid)||Number(event.pid)<1||typeof event.birth!=='string'||!/^\d+$/.test(event.birth))throw new RuntimeError('NATIVE_IDENTITY_MISMATCH','Invalid native process identity');
      if(control.identity)throw new RuntimeError('NATIVE_IDENTITY_MISMATCH','Duplicate native launch identity');
      control.identity={pid:Number(event.pid),birth:event.birth,generation:control.run.generation,controlId:control.run.runId,driver:this.id};
      this.recovery?.bind(control.run.runId,control.identity);
    }else if(event.type==='native.observation'){
      if(event.generation!==control.run.generation||event.status!==0||!Array.isArray(event.activePids)||event.activePids.some(x=>!Number.isSafeInteger(x)||Number(x)<1))throw new RuntimeError('NATIVE_OBSERVATION_INVALID','No valid Job census');
      control.observation={state:event.activePids.length?'alive':'stopped',generation:control.run.generation,activePids:event.activePids as number[],proof:JSON.stringify({nativeJobCensus:event,evidence:this.profile.evidenceDigests})};
    }else if(event.type==='native.check-result'){
      const check=control.check;
      if(!check)throw new RuntimeError('NATIVE_CHECK_INVALID','No pending native check matches this receipt');
      const receipt=validateNativeCheckReceipt(event,{requestId:check.id,generation:control.run.generation,args:check.args,maxOutputBytes:check.maxOutputBytes});
      clearTimeout(check.timer);control.check=null;
      check.resolve({...receipt,nativeEvidence:{...receipt.nativeEvidence,profileId:this.profile.config.profileId,osBuild:this.profile.config.osBuild,nodeSha256:this.profile.config.node.sha256,helperSha256:this.profile.config.helper.sha256,workerSha256:this.profile.config.worker.sha256,piSha256:this.profile.config.pi.sha256,policySha256:this.profile.config.policySha256,shellSha256:this.profile.config.shell?.sha256??null,shellManifestSha256:this.profile.config.shell?.manifest.sha256??null}});
    }else if(event.type==='native.resources'){
      if(event.generation!==control.run.generation||!Number.isSafeInteger(event.status)||!['provision','revoke'].includes(String(event.phase)))throw new RuntimeError('NATIVE_RESOURCE_INVALID','Invalid scoped resource evidence');
      control.resources.status=Number(event.status);if(event.phase==='provision')control.resources.provisioned=event.status===0;else control.resources.revoked=event.status===0;
    }else if(event.type==='native.disk-observation'){
      if(event.generation!==control.run.generation||!Number.isSafeInteger(event.status)||event.hardQuota!==false||!Number.isSafeInteger(event.bytes)||!Number.isSafeInteger(event.entries))throw new RuntimeError('NATIVE_DISK_INVALID','Invalid sampled disk observation');
      if(event.status!==0)void this.stopHandler?.(control.run.runId,'native-disk-policy-exceeded').catch(()=>{});
    }else if(event.type==='native.worker-log'){
      if(event.generation!==control.run.generation||typeof event.bytesBase64!=='string'||event.bytesBase64.length>6000)throw new RuntimeError('NATIVE_LOG_INVALID','Invalid bounded Worker diagnostic');
      // Worker logs are deliberately not authority for lifecycle or check status.
    }else if(event.type==='native.recovery'||event.type==='native.finalizing'){
      if(event.generation!==control.run.generation||!Number.isSafeInteger(event.status))throw new RuntimeError('NATIVE_RECOVERY_INVALID','Invalid native receipt status');
    }else if(event.type==='native.limit'){void this.stopHandler?.(control.run.runId,String(event.reason)).catch(()=>{});}
    else if(event.type==='native.launch-failed'||event.type==='native.error'){control.observation={state:'unknown',generation:control.run.generation,activePids:[],proof:JSON.stringify(event)};}
    else throw new RuntimeError('NATIVE_PROTOCOL_INVALID','Unexpected native lifecycle event');
    this.changed(control);
  }
  async launch(run:RunRecord):Promise<ProcessIdentity>{
    this.preflight(run);const config=this.profile.config,boot=this.bootstrap(run);
    if(boot.profileName!==appContainerProfileName(run.demandId,run.role,run.generation)||!boot.aclEvidence||!boot.privateChannelEvidence||!boot.resourceAuthorizationId||!boot.readonlyRuntimeRoots?.length)throw new RuntimeError('RUN_ACL_UNVERIFIED','Per-generation identity and actual ACL/channel evidence required');
    const recovery=this.recovery?.prepare(run,config)??{recoveryReceiptPath:'',recoveryKey:'',recoveryContextSha256:''};
    const shell=config.shell?readLockedShellManifest(config.shell):null;
    const helper=spawn(config.helper.path,[],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:process.env.SystemRoot??'C:\\Windows',SystemDrive:process.env.SystemDrive,USERPROFILE:process.env.USERPROFILE,LOCALAPPDATA:process.env.LOCALAPPDATA,APPDATA:process.env.APPDATA}});
    const control:Control={helper,run,identity:null,observation:null,exit:false,native:new PrivateFrameDecoder(),worker:new PrivateFrameDecoder(),waiters:new Set(),resources:{provisioned:false,revoked:false,status:null},check:null,stopping:false};this.controls.set(run.runId,control);
    helper.on('error',()=>{control.exit=true;this.changed(control);});helper.on('close',()=>{control.exit=true;if(control.check){clearTimeout(control.check.timer);control.check.reject(new RuntimeError('NATIVE_CHECK_UNKNOWN','Native helper exited before command receipt'));control.check=null;}this.changed(control);});
    helper.stdin.on('error',()=>{control.exit=true;this.changed(control);});
    helper.stderr.on('data',(chunk:Buffer)=>{try{for(const frame of control.native.push(chunk))this.nativeEvent(control,frame);}catch(error){control.observation={state:'unknown',generation:run.generation,activePids:[],proof:String(error)};void this.stopHandler?.(run.runId,'native-protocol-failure').catch(()=>{});this.changed(control);}});
    let pending=0;helper.stdout.on('data',(chunk:Buffer)=>{try{for(const frame of control.worker.push(chunk)){if(++pending>4)throw new RuntimeError('WORKER_BACKPRESSURE','Worker request concurrency exceeded');
      void this.workerHandler!(run,frame).catch(()=>this.stopHandler?.(run.runId,'worker-channel-failure')).finally(()=>{pending--;});}}
      catch{void this.stopHandler?.(run.runId,'worker-channel-failure').catch(()=>{});}});
    try{this.command(control,{...recovery,type:'launch',version:1,policyVariant:config.policyVariant??'lpac-strict-v1',demand:run.demandId,role:run.role,generation:run.generation,profileName:boot.profileName,
      nodeExecutable:config.node.path,workerEntry:config.worker.path,workspace:run.workspace,scratch:boot.scratch,nodeSha256:config.node.sha256,workerSha256:config.worker.sha256,
      policyEvidence:config.policySha256,aclEvidence:boot.aclEvidence,privateChannelEvidence:boot.privateChannelEvidence,timeoutMs:run.timeoutMs,processLimit:boot.processLimit,memoryLimitBytes:boot.memoryLimitBytes,outputLimitBytes:run.maxOutputBytes,resourceAuthorizationId:boot.resourceAuthorizationId,readonlyRuntimeRoots:[...new Set([...boot.readonlyRuntimeRoots,...(shell?.files.map(file=>file.path)??[])])],shellExecutable:config.shell?.path??'',shellRootPath:shell?.rootPath??'',shellSha256:config.shell?.sha256??'',shellFiles:shell?.files??[],diskLimitBytes:boot.diskLimitBytes,fileLimit:boot.fileLimit,minimumFreeBytes:boot.minimumFreeBytes,diskPollMs:boot.diskPollMs});
    await this.wait(control,()=>!!control.identity||!!control.observation,10000);
    if(!control.identity||!control.resources.provisioned)throw new RuntimeError('NATIVE_LAUNCH_UNCONFIRMED',control.observation?.proof??'Native launch has no confirmed process identity');
    this.sendWorkerFrame(run.runId,boot.workerInit);return control.identity;
    }catch(error){
      // The exact helper may still finish a delayed launch. Queue stop and close
      // only its authenticated control pipe; native EOF owns zero/revoke proof.
      control.stopping=true;
      try{if(!control.exit)this.command(control,{type:'stop'});}catch{}
      if(!helper.stdin.destroyed)helper.stdin.end();
      await this.wait(control,()=>control.exit||control.observation?.state==='stopped',12000);
      try{const receipt=this.recovery?.observe(run,config);if(receipt)this.recovered.add(run.runId);}catch{}
      throw error;
    }
  }
  async runNodeCheck(runId:string,args:string[],limits:{timeoutMs:number;maxOutputBytes:number},requestId:string=randomUUID()):Promise<NativeCheckResult>{return this.runCheck(runId,args,limits,requestId,'run-node');}
  async runShellCheck(runId:string,args:string[],limits:{timeoutMs:number;maxOutputBytes:number},requestId:string=randomUUID()):Promise<NativeCheckResult>{
    if(!this.profile.config.shell)throw new RuntimeError('SHELL_UNAVAILABLE','No verified locked Git Bash profile');
    if(!Array.isArray(args)||args.length!==1||typeof args[0]!=='string'||!args[0]||args[0].includes('\0')||args[0].length>8192)throw new RuntimeError('SHELL_SCOPE_DENIED','One bounded script is required; startup flags are fixed by the Host');
    readLockedShellManifest(this.profile.config.shell);
    return this.runCheck(runId,['--noprofile','--norc','-c',args[0]],limits,requestId,'run-shell');
  }
  private async runCheck(runId:string,args:string[],limits:{timeoutMs:number;maxOutputBytes:number},requestId:string,type:'run-node'|'run-shell'):Promise<NativeCheckResult>{
    const control=this.controls.get(runId);
    if(!control||control.exit||control.stopping||!control.identity||!control.resources.provisioned||control.resources.revoked)throw new RuntimeError('NATIVE_CHECK_UNAVAILABLE','No matching running native Job');
    if(control.check)throw new RuntimeError('CHECK_CAPACITY','One native check is already running in this Job');
    if(!Array.isArray(args)||!args.length||args.length>64||args.some(x=>typeof x!=='string'||x.includes('\0')||x.length>8192)||args.join('').length>32768||!/^[a-zA-Z0-9-]{1,200}$/.test(requestId))
      throw new RuntimeError('CHECK_SCOPE_DENIED','Bounded Node argument vector required');
    if(!Number.isSafeInteger(limits.timeoutMs)||limits.timeoutMs<1||limits.timeoutMs>120000||limits.timeoutMs>control.run.timeoutMs||!Number.isSafeInteger(limits.maxOutputBytes)||limits.maxOutputBytes<1)
      throw new RuntimeError('FINITE_POLICY_REQUIRED','Finite native check bounds required');
    const maxOutputBytes=Math.min(limits.maxOutputBytes,524288); // Base64 plus metadata must fit the 1 MiB proof frame.
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{control.check=null;void this.stopHandler?.(runId,'native-check-receipt-timeout').catch(()=>{});reject(new RuntimeError('NATIVE_CHECK_UNKNOWN','No native exit receipt before deadline'));},limits.timeoutMs+15000);timer.unref();
      control.check={id:requestId,args:[...args],maxOutputBytes,resolve,reject,timer};
      try{this.command(control,{type,requestId,args,timeoutMs:limits.timeoutMs,maxOutputBytes});}
      catch(error){clearTimeout(timer);control.check=null;reject(error);}
    });
  }
  async recoverUnregistered(run:RunRecord):Promise<Observation>{
    try{const receipt=this.recovery?.observe(run,this.profile.config);if(receipt){this.recovered.add(run.runId);return receipt;}}catch(error){return {state:'unknown',generation:run.generation,activePids:[],proof:`Unregistered native recovery remains unverified: ${String(error)}`};}
    return {state:'unknown',generation:run.generation,activePids:[],proof:'No authenticated native stop/revocation receipt for unregistered generation'};
  }
  async observe(run:RunRecord):Promise<Observation>{
    const control=this.controls.get(run.runId);const unknown={state:'unknown' as const,generation:run.generation,activePids:[],proof:'No matching live native control; PID absence cannot prove Job termination'};
    if(!control||control.exit){try{const receipt=this.recovery?.observe(run,this.profile.config);if(receipt){this.recovered.add(run.runId);return receipt;}}catch(error){return {...unknown,proof:`Recovery remains unverified: ${String(error)}`};}}
    if(!control||!run.identity||JSON.stringify(control.identity)!==JSON.stringify(run.identity))return unknown;
    if(control.observation?.state==='stopped')return control.observation;
    if(control.exit)return unknown;
    control.observation=null;this.command(control,{type:'query'});await this.wait(control,()=>!!control.observation,3000);return control.observation??unknown;
  }
  async stop(run:RunRecord):Promise<Observation>{
    const control=this.controls.get(run.runId);if(!control||control.exit)return this.observe(run);
    if(!run.identity||JSON.stringify(control.identity)!==JSON.stringify(run.identity))return this.observe(run);
    control.stopping=true;control.observation=null;this.command(control,{type:'stop'});await this.wait(control,()=>control.observation?.state==='stopped',12000);
    if(control.exit)return this.observe(run);
    return control.observation??{state:'unknown',generation:run.generation,activePids:[],proof:'Native stop unconfirmed; retain lease'};
  }
}
