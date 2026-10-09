import type { Readable,Writable } from 'node:stream';
import { PassThrough } from 'node:stream';
import { createHash,randomUUID } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { validateToolArguments } from '@earendil-works/pi-ai';
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
import { createPlanningSkillSession } from './planning-skills.ts';
import type { PlanningSkillProjection } from './planning-skills.ts';
import { createImplementationSkillSession } from './implementation-skills.ts';
import type { ImplementationSkillProjection } from './implementation-skills.ts';
import { executionReportParameters } from './execution-report-contract.ts';
import type { PlanningWorkStep,ExecutionWorkStep,ExecutionScope } from '../domain/types.ts';

export interface WorkerInit {
  version:1;type:'worker.init';runId:string;generation:string;demandId:string;domainRunId:string;domainGeneration:number;
  role:RuntimeRole;workspace:string;scratch:string;sessionDir:string;sessionId:string;capability:string;prompt:string;
  materials:AgentMaterial[];model:BrokeredPiOptions['model'];compaction:BrokeredPiOptions['compaction'];retry:BrokeredPiOptions['retry'];
  limits:{maxFileBytes:number;commandTimeoutMs:number;maxOutputBytes:number};
  /** Host-only local validation lane. No Agent session or model operation exists. */
  checkOnly?:true;
  /** Legacy false is accepted; a shell-enabled bootstrap is always rejected. */
  shellEnabled?:false;
  /** Private Host assertion delivered only after verified native launch, not model data. */
  workspaceCapability?:NativePinnedWorkspace;
  planning?:{flowId:string;flowRevision:number;inputDigest:string;step:PlanningWorkStep;contextId:string};
  planningSkills?:PlanningSkillProjection;
  execution?:{flowId:string;flowRevision:number;inputDigest:string;step:ExecutionWorkStep;contextId:string;scope:ExecutionScope;ticketId?:string;contentId?:string};
  executionSkills?:ImplementationSkillProjection;
}
const reportTypes=new Set(['plan-draft','plan-ready','content-ready','check','review','dispute','resolve-finding','blocked','message-delivered','message-applied','runtime-ended','planning-facts','planning-questions','planning-clarification','planning-design','planning-design-review','planning-design-resolution','planning-spec','planning-tickets','execution-content','execution-review','execution-resolution']);
export function validateWorkerInit(input:unknown,generation:string):WorkerInit{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new RuntimeError('WORKER_BOOTSTRAP_INVALID','Object bootstrap required');const value=input as WorkerInit;
  if(value.version!==1||value.type!=='worker.init'||value.generation!==generation||!['planning','implementation','review','boundary-review','check'].includes(value.role)||!Number.isSafeInteger(value.domainGeneration)||value.domainGeneration<1)
    throw new RuntimeError('WORKER_BOOTSTRAP_INVALID','Invalid bound run identity');
  for(const field of ['runId','demandId','domainRunId','workspace','scratch','sessionDir','sessionId','prompt'] as const)if(typeof value[field]!=='string'||!value[field]||value[field].length>100000)throw new RuntimeError('WORKER_BOOTSTRAP_INVALID','Explicit run/context fields required');
  if(!/^[a-f0-9]{64}$/.test(value.capability)||!Array.isArray(value.materials)||!value.limits)throw new RuntimeError('WORKER_BOOTSTRAP_INVALID','Private capability and limits required');
  if(value.checkOnly!==undefined&&(value.checkOnly!==true||value.role!=='check'))throw new RuntimeError('WORKER_BOOTSTRAP_INVALID','Check-only bootstrap requires the bounded check role');
  if(value.shellEnabled!==undefined&&value.shellEnabled!==false)throw new RuntimeError('SHELL_NOT_SUPPORTED','The Node-only Worker cannot enable a shell tool');
  if(value.planning!==undefined||value.planningSkills!==undefined){
    const p=value.planning;
    if(!p||!value.planningSkills||value.checkOnly||typeof p.flowId!=='string'||!p.flowId||!Number.isSafeInteger(p.flowRevision)||p.flowRevision<1||!(/^[a-f0-9]{64}$/).test(p.inputDigest)||typeof p.contextId!=='string'||!p.contextId||p.step!==value.planningSkills.stage||value.role!==(['facts','design-review'].includes(p.step)?'boundary-review':'planning'))throw new RuntimeError('WORKER_BOOTSTRAP_INVALID','Planning projection must match its private stage, flow and read-only role');
    createPlanningSkillSession(value.planningSkills);
  }
  if(value.execution!==undefined||value.executionSkills!==undefined){
    const e=value.execution;
    if(!e||!value.executionSkills||value.planning!==undefined||value.planningSkills!==undefined||value.checkOnly||typeof e.flowId!=='string'||!e.flowId||e.flowId.length>200||!Number.isSafeInteger(e.flowRevision)||e.flowRevision<1||!(/^[a-f0-9]{64}$/).test(e.inputDigest)||typeof e.contextId!=='string'||!e.contextId||e.contextId.length>200||e.step!==value.executionSkills.stage||!['ticket-implementation','ticket-fix','review-standards','review-spec','resolution-standards','resolution-spec'].includes(e.step)||value.role!==(['ticket-implementation','ticket-fix'].includes(e.step)?'implementation':'review')||!['ticket','whole-spec'].includes(e.scope)||Object.keys(e).some(key=>!['flowId','flowRevision','inputDigest','step','contextId','scope','ticketId','contentId'].includes(key)))throw new RuntimeError('WORKER_BOOTSTRAP_INVALID','Execution projection must match its private stage, flow and writer or independent review role');
    if((e.scope==='ticket'&&(typeof e.ticketId!=='string'||!e.ticketId||e.ticketId.length>200))||(e.scope==='whole-spec'&&e.ticketId!==undefined)||(e.step==='ticket-implementation'&&e.scope!=='ticket')||(e.contentId!==undefined&&(typeof e.contentId!=='string'||!e.contentId||e.contentId.length>200))||(e.step!=='ticket-implementation'&&e.contentId===undefined))throw new RuntimeError('WORKER_BOOTSTRAP_INVALID','Execution scope and current content must match the bound stage');
    createImplementationSkillSession(value.executionSkills);
  }
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
    if((value.type==='worker.receipt'||value.type==='worker.check-result'||value.type==='worker.write-result'||value.type==='worker.skill-result')&&typeof value.requestId==='string'){const wait=pending.get(value.requestId);if(!wait)throw new RuntimeError('REPORT_REPLAY','Unexpected report receipt');pending.delete(value.requestId);if(value.ok===true)wait.resolve(value.value);else wait.reject(new RuntimeError('REPORT_REJECTED','Host rejected report'));}
    else if(value.type==='worker.abort'){void session?.session.abort();}
    else if(typeof value.sequence==='number'&&typeof value.ok==='boolean')modelResponses.write(encodePrivateFrame(frame));
    else throw new RuntimeError('WORKER_CONTROL_DENIED','Unknown Worker control frame');
  }}catch(error){close(error as Error);}});
  input.on('end',()=>close(new RuntimeError('CHANNEL_CLOSED','Host disconnected')));input.on('error',error=>close(error));output.on('error',error=>close(error));
  try{
    const boot=await ready;
    if(boot.checkOnly){send({version:1,type:'worker.ready',runId:boot.runId,generation:boot.generation,sessionId:boot.sessionId});if(!closed)await new Promise<void>(resolve=>{input.once('end',resolve);input.once('error',resolve);output.once('error',resolve);});return;}
    const manager=SessionManager.create(boot.workspace,boot.sessionDir,{id:boot.sessionId});
    const transport=new FramedPiModelChannel(boot,(frame,signal)=>client.send(frame,signal) as Promise<ProviderResponse>),receivedExecutionSkills=new Set<string>();
    const channel:BrokeredPiOptions['channel']={complete:async(context,purpose,signal)=>{
      const response=await transport.complete(context,purpose,signal);
      // Loading bytes is not proof that a model received them. Mark only exact
      // successful controlled_skill results in a completed transport operation.
      // A same-response load/report batch therefore cannot satisfy this gate.
      if(boot.executionSkills&&context&&typeof context==='object'){
        const messages=(context as {messages?:unknown}).messages;
        if(Array.isArray(messages))for(const message of messages){
          if(!message||typeof message!=='object')continue;
          const result=message as {role?:unknown;toolName?:unknown;isError?:unknown;content?:unknown};
          if(result.role!=='toolResult'||result.toolName!=='controlled_skill'||result.isError!==false||!Array.isArray(result.content))continue;
          for(const resource of [boot.executionSkills.entry,boot.executionSkills.active.entry])if(result.content.some(part=>part&&typeof part==='object'&&(part as {type?:unknown}).type==='text'&&(part as {text?:unknown}).text===resource.content))receivedExecutionSkills.add(resource.id);
        }
      }
      return response;
    }};
    const report=async(body:Record<string,unknown>)=>{
      if(!reportTypes.has(String(body.type)))throw new RuntimeError('REPORT_TYPE_DENIED','Unknown business report');
      if(boot.planning&&body.type!=='blocked'&&!planningSkills?.hasLoadedPrimary())throw new RuntimeError('PLANNING_SKILL_NOT_LOADED','Load the exact active stage skill before reporting.');
      if(boot.execution){
        validateToolArguments({name:'controlled_report',description:'The bound execution stage report',parameters:executionReportParameters(boot.execution.step)},{type:'toolCall',id:'private-report-validation',name:'controlled_report',arguments:{report:body} as never});
        if(body.type!=='blocked'&&(!implementationSkills?.hasLoadedPrimary()||![boot.executionSkills!.entry.id,boot.executionSkills!.active.entry.id].every(id=>receivedExecutionSkills.has(id))))throw new RuntimeError('EXECUTION_SKILL_NOT_LOADED','Load both implement-spec and the exact active stage skill, and receive them in a subsequent model turn before reporting.');
      }
      const executionBinding=boot.execution?{flowId:boot.execution.flowId,flowRevision:boot.execution.flowRevision,inputDigest:boot.execution.inputDigest,executionStep:boot.execution.step,scope:boot.execution.scope,...(boot.execution.ticketId?{ticketId:boot.execution.ticketId}:{}),...(boot.execution.contentId?{contentId:boot.execution.contentId}:{})}:{};
      const requestId=randomUUID();const bound={...body,...(boot.planning?{flowId:boot.planning.flowId,flowRevision:boot.planning.flowRevision}:{}),...executionBinding,requestId,demandId:boot.demandId,runId:boot.domainRunId,generation:boot.domainGeneration};
      const reply=new Promise((resolve,reject)=>{pending.set(requestId,{resolve,reject});});
      send({version:1,type:'worker.report',runtimeRunId:boot.runId,generation:boot.generation,capability:boot.capability,report:bound});return reply;
    };
    const planningSkills=boot.planningSkills?createPlanningSkillSession(boot.planningSkills,{onRead:async(resource)=>{
      const requestId=randomUUID();const reply=new Promise<unknown>((resolve,reject)=>pending.set(requestId,{resolve,reject}));
      send({version:1,type:'worker.skill-request',runId:boot.runId,generation:boot.generation,capability:boot.capability,requestId,resource});await reply;
    }}):undefined;
    const implementationSkills=boot.executionSkills?createImplementationSkillSession(boot.executionSkills,{onRead:async(resource)=>{
      const requestId=randomUUID();const reply=new Promise<unknown>((resolve,reject)=>pending.set(requestId,{resolve,reject}));
      send({version:1,type:'worker.skill-request',runId:boot.runId,generation:boot.generation,capability:boot.capability,requestId,resource});await reply;
    }}):undefined;
    const tools=controlledTools({workspace:boot.workspace,scratch:boot.scratch,role:boot.role,generation:boot.generation,workspaceCapability:boot.workspaceCapability,planningStep:boot.planning?.step,executionStep:boot.execution?.step,...boot.limits,report,
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
    tools.push(...(planningSkills?.tools??[]),...(implementationSkills?.tools??[]));
    session=await createBrokeredPiSession({cwd:boot.workspace,agentDir:boot.sessionDir,role:boot.role,materials:boot.materials,sessionManager:manager,channel,tools,planningSkills,implementationSkills,model:boot.model,compaction:boot.compaction,retry:boot.retry});
    send({version:1,type:'worker.ready',runId:boot.runId,generation:boot.generation,sessionId:manager.getSessionId()});
    session.session.subscribe(event=>{if(event.type==='agent_settled'||event.type==='agent_end'||event.type==='tool_execution_start'||event.type==='tool_execution_end')
      send({version:1,type:'worker.event',runId:boot.runId,generation:boot.generation,event});});
    await session.session.prompt(boot.prompt);await session.session.waitForIdle();
    send({version:1,type:'worker.settled',runId:boot.runId,generation:boot.generation,sessionId:manager.getSessionId(),aborted:session.lifecycle.aborted});
  }finally{session?.dispose();client.close();closed=true;for(const wait of pending.values())wait.reject(new RuntimeError('WORKER_ENDED','Worker ended before receipt'));}
}
