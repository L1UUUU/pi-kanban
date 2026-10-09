import type { Readable,Writable } from 'node:stream';
import { PassThrough } from 'node:stream';
import { createHash,randomUUID } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createBrokeredPiSession } from './brokered-pi.ts';
import type { BrokeredPiOptions } from './brokered-pi.ts';
import type { AgentMaterial } from './resources.ts';
import type { RuntimeRole } from '../runtime/types.ts';
import { RuntimeError } from '../runtime/types.ts';
import { FramedPiModelChannel } from '../runtime/pi-channel.ts';
import { PrivateModelPipeClient,PrivateFrameDecoder,encodePrivateFrame } from '../runtime/pipe-frames.ts';
import type { ProviderResponse } from '../runtime/model-broker.ts';
import { controlledTools } from './controlled-tools.ts';
import type { NativePinnedWorkspace } from './controlled-tools.ts';

export interface WorkerInit {
  version:1;type:'worker.init';runId:string;generation:string;demandId:string;domainRunId:string;domainGeneration:number;
  role:RuntimeRole;workspace:string;scratch:string;sessionDir:string;sessionId:string;capability:string;prompt:string;
  materials:AgentMaterial[];model:BrokeredPiOptions['model'];compaction:BrokeredPiOptions['compaction'];retry:BrokeredPiOptions['retry'];
  limits:{maxFileBytes:number;commandTimeoutMs:number;maxOutputBytes:number};
  /** Host-only local validation lane. No Agent session or model operation exists. */
  checkOnly?:true;
  shellEnabled?:boolean;
  /** Private Host assertion delivered only after verified native launch, not model data. */
  workspaceCapability?:NativePinnedWorkspace;
}
const reportTypes=new Set(['plan-draft','plan-ready','content-ready','check','review','dispute','resolve-finding','blocked','message-delivered','message-applied','runtime-ended']);
export function validateWorkerInit(input:unknown,generation:string):WorkerInit{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new RuntimeError('WORKER_BOOTSTRAP_INVALID','Object bootstrap required');const value=input as WorkerInit;
  if(value.version!==1||value.type!=='worker.init'||value.generation!==generation||!['planning','implementation','review','boundary-review','check'].includes(value.role)||!Number.isSafeInteger(value.domainGeneration)||value.domainGeneration<1)
    throw new RuntimeError('WORKER_BOOTSTRAP_INVALID','Invalid bound run identity');
  for(const field of ['runId','demandId','domainRunId','workspace','scratch','sessionDir','sessionId','prompt'] as const)if(typeof value[field]!=='string'||!value[field]||value[field].length>100000)throw new RuntimeError('WORKER_BOOTSTRAP_INVALID','Explicit run/context fields required');
  if(!/^[a-f0-9]{64}$/.test(value.capability)||!Array.isArray(value.materials)||!value.limits)throw new RuntimeError('WORKER_BOOTSTRAP_INVALID','Private capability and limits required');
  if(value.checkOnly!==undefined&&(value.checkOnly!==true||value.role!=='check'))throw new RuntimeError('WORKER_BOOTSTRAP_INVALID','Check-only bootstrap requires the bounded check role');
  if(value.shellEnabled!==undefined&&typeof value.shellEnabled!=='boolean')throw new RuntimeError('WORKER_BOOTSTRAP_INVALID','Invalid locked shell capability');
  if(value.workspaceCapability!==undefined){const cap=value.workspaceCapability;if(!cap||typeof cap!=='object'||cap.version!==1||cap.kind!=='native-pinned-workspace'||cap.path!==value.workspace||cap.generation!==generation||Object.keys(cap).sort().join(',')!=='generation,kind,path,version')throw new RuntimeError('WORKER_BOOTSTRAP_INVALID','Native workspace capability does not match the private run');}
  for(const key of ['maxFileBytes','commandTimeoutMs','maxOutputBytes'] as const){const limit=value.limits[key];if(!Number.isSafeInteger(limit)||limit<1)throw new RuntimeError('FINITE_POLICY_REQUIRED','Worker limits must be finite');}return value;
}
/** Actual Worker bootstrap. The executable wrapper only invokes this on native Windows.
 * In-process tests may supply synthetic streams; that is not OS isolation evidence. */
export async function runWorkerFromStreams(input:Readable,output:Writable,expectedGeneration:string):Promise<void>{
  const decoder=new PrivateFrameDecoder(),modelResponses=new PassThrough(),modelRequests=new PassThrough();
  const client=new PrivateModelPipeClient(modelResponses,modelRequests);const pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
  let init:WorkerInit|null=null,resolveInit!:(value:WorkerInit)=>void,rejectInit!:(error:Error)=>void,session:Awaited<ReturnType<typeof createBrokeredPiSession>>|null=null;
  const ready=new Promise<WorkerInit>((resolve,reject)=>{resolveInit=resolve;rejectInit=reject;});
  let closed=false;
  const send=(value:unknown)=>{if(closed)throw new RuntimeError('CHANNEL_CLOSED','Worker control pipe closed');const bytes=encodePrivateFrame(Buffer.from(JSON.stringify(value)));if(output.writableLength+bytes.length>2*1024*1024)throw new RuntimeError('WORKER_BACKPRESSURE','Worker output queue full');output.write(bytes);};
  const close=(error:Error)=>{if(closed)return;closed=true;rejectInit(error);client.close(error);for(const wait of pending.values())wait.reject(error);pending.clear();void session?.session.abort();};
  modelRequests.on('data',(chunk:Buffer)=>{if(output.writableLength+chunk.length>2*1024*1024)close(new RuntimeError('WORKER_BACKPRESSURE','Model output queue full'));else output.write(chunk);});
  input.on('data',(chunk:Buffer)=>{try{for(const frame of decoder.push(chunk)){const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(frame)) as Record<string,unknown>;
    if(!init){init=validateWorkerInit(value,expectedGeneration);resolveInit(init);continue;}
    if((value.type==='worker.receipt'||value.type==='worker.check-result'||value.type==='worker.write-result')&&typeof value.requestId==='string'){const wait=pending.get(value.requestId);if(!wait)throw new RuntimeError('REPORT_REPLAY','Unexpected report receipt');pending.delete(value.requestId);if(value.ok===true)wait.resolve(value.value);else wait.reject(new RuntimeError('REPORT_REJECTED','Host rejected report'));}
    else if(value.type==='worker.abort'){void session?.session.abort();}
    else if(typeof value.sequence==='number'&&typeof value.ok==='boolean')modelResponses.write(encodePrivateFrame(frame));
    else throw new RuntimeError('WORKER_CONTROL_DENIED','Unknown Worker control frame');
  }}catch(error){close(error as Error);}});
  input.on('end',()=>close(new RuntimeError('CHANNEL_CLOSED','Host disconnected')));input.on('error',error=>close(error));output.on('error',error=>close(error));
  try{
    const boot=await ready;
    if(boot.checkOnly){send({version:1,type:'worker.ready',runId:boot.runId,generation:boot.generation,sessionId:boot.sessionId});if(!closed)await new Promise<void>(resolve=>{input.once('end',resolve);input.once('error',resolve);output.once('error',resolve);});return;}
    const manager=SessionManager.create(boot.workspace,boot.sessionDir,{id:boot.sessionId});
    const channel=new FramedPiModelChannel(boot,(frame,signal)=>client.send(frame,signal) as Promise<ProviderResponse>);
    const report=async(body:Record<string,unknown>)=>{
      if(!reportTypes.has(String(body.type)))throw new RuntimeError('REPORT_TYPE_DENIED','Unknown business report');
      const requestId=randomUUID();const bound={...body,requestId,demandId:boot.demandId,runId:boot.domainRunId,generation:boot.domainGeneration};
      const reply=new Promise((resolve,reject)=>{pending.set(requestId,{resolve,reject});});
      send({version:1,type:'worker.report',runtimeRunId:boot.runId,generation:boot.generation,capability:boot.capability,report:bound});return reply;
    };
    const tools=controlledTools({workspace:boot.workspace,scratch:boot.scratch,role:boot.role,generation:boot.generation,workspaceCapability:boot.workspaceCapability,...boot.limits,report,
      shell:boot.shellEnabled?async(toolCallId,command,signal)=>{
        signal?.throwIfAborted();const requestId=randomUUID(),reply=new Promise<unknown>((resolve,reject)=>{pending.set(requestId,{resolve,reject});});
        const abort=()=>{pending.get(requestId)?.reject(new RuntimeError('CHECK_ABORTED','Shell check canceled; Host retains its actual receipt and lease'));pending.delete(requestId);send({version:1,type:'worker.stop-required',runId:boot.runId,generation:boot.generation,capability:boot.capability,reason:'shell-check-aborted'});};signal?.addEventListener('abort',abort,{once:true});
        send({version:1,type:'worker.shell-request',runId:boot.runId,generation:boot.generation,capability:boot.capability,requestId,toolCallId,args:[command]});
        try{const value=await reply;if(!value||typeof value!=='object'||typeof(value as Record<string,unknown>).output!=='string')throw new RuntimeError('NATIVE_CHECK_INVALID','Host shell result is malformed');return value as {output:string;exitCode:number|null;[key:string]:unknown};}finally{signal?.removeEventListener('abort',abort);}
      }:undefined,
      write:async(toolCallId,path,content,perform)=>{
        const requestId=randomUUID();const exchange=(type:string,body:Record<string,unknown>)=>{const response=new Promise<unknown>((resolve,reject)=>pending.set(requestId,{resolve,reject}));send({version:1,type,runId:boot.runId,generation:boot.generation,capability:boot.capability,requestId,...body});return response;};
        try{await exchange('worker.write-request',{action:'write',toolCallId,path,sha256:createHash('sha256').update(content).digest('hex'),bytes:Buffer.byteLength(content)});perform();await exchange('worker.write-complete',{});}
        catch(error){send({version:1,type:'worker.stop-required',runId:boot.runId,generation:boot.generation,capability:boot.capability,reason:'source-write-unverified'});throw error;}
      },
      delete:async(toolCallId,path,perform)=>{
        const requestId=randomUUID();const exchange=(type:string,body:Record<string,unknown>)=>{const response=new Promise<unknown>((resolve,reject)=>pending.set(requestId,{resolve,reject}));send({version:1,type,runId:boot.runId,generation:boot.generation,capability:boot.capability,requestId,...body});return response;};
        try{await exchange('worker.write-request',{action:'delete',toolCallId,path,sha256:null,bytes:0});perform();await exchange('worker.write-complete',{});}
        catch(error){send({version:1,type:'worker.stop-required',runId:boot.runId,generation:boot.generation,capability:boot.capability,reason:'source-delete-unverified'});throw error;}
      },
      check:async(toolCallId,args,signal)=>{
        signal?.throwIfAborted();const requestId=randomUUID();
        const reply=new Promise<unknown>((resolve,reject)=>{pending.set(requestId,{resolve,reject});});
        const abort=()=>{pending.get(requestId)?.reject(new RuntimeError('CHECK_ABORTED','Native check canceled; Host retains its actual receipt/lease'));pending.delete(requestId);send({version:1,type:'worker.stop-required',runId:boot.runId,generation:boot.generation,capability:boot.capability,reason:'check-aborted'});};
        signal?.addEventListener('abort',abort,{once:true});
        send({version:1,type:'worker.check-request',runId:boot.runId,generation:boot.generation,capability:boot.capability,requestId,toolCallId,args,limits:{timeoutMs:Math.min(boot.limits.commandTimeoutMs,120000),maxOutputBytes:Math.min(boot.limits.maxOutputBytes,524288)}});
        try{const value=await reply;if(!value||typeof value!=='object'||typeof(value as Record<string,unknown>).output!=='string')throw new RuntimeError('NATIVE_CHECK_INVALID','Host check result is malformed');return value as {output:string;exitCode:number|null;[key:string]:unknown};}
        finally{signal?.removeEventListener('abort',abort);}
      },
      stopRequired:reason=>send({version:1,type:'worker.stop-required',runId:boot.runId,generation:boot.generation,capability:boot.capability,reason})});
    session=await createBrokeredPiSession({cwd:boot.workspace,agentDir:boot.sessionDir,role:boot.role,materials:boot.materials,sessionManager:manager,channel,tools,model:boot.model,compaction:boot.compaction,retry:boot.retry});
    send({version:1,type:'worker.ready',runId:boot.runId,generation:boot.generation,sessionId:manager.getSessionId()});
    session.session.subscribe(event=>{if(event.type==='agent_settled'||event.type==='agent_end'||event.type==='tool_execution_start'||event.type==='tool_execution_end')
      send({version:1,type:'worker.event',runId:boot.runId,generation:boot.generation,event});});
    await session.session.prompt(boot.prompt);await session.session.waitForIdle();
    send({version:1,type:'worker.settled',runId:boot.runId,generation:boot.generation,sessionId:manager.getSessionId(),aborted:session.lifecycle.aborted});
  }finally{session?.dispose();client.close();closed=true;for(const wait of pending.values())wait.reject(new RuntimeError('WORKER_ENDED','Worker ended before receipt'));}
}
