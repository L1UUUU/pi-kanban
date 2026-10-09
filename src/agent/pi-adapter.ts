import { createAgentSession,ModelRuntime,SessionManager,SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AgentSession,AgentSessionEvent,ToolDefinition } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore,InMemoryModelsStore,createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AssistantMessage,TranscriptContext } from '@earendil-works/pi-ai';
import { explicitResourceLoader } from './resources.ts';
import type { AgentMaterial } from './resources.ts';
import { RuntimeError } from '../runtime/types.ts';
import type { RuntimeRole } from '../runtime/types.ts';

export const PI_SDK_VERSION='1.1.0';
export const PI_SDK_PACKAGE='@earendil-works/pi-coding-agent';

import { PiLifecycle } from './lifecycle.ts';
export { PiLifecycle };
export interface SyntheticSessionOptions {
  cwd:string;agentDir:string;role:RuntimeRole;materials:readonly AgentMaterial[];
  /** The native Pi manager is the sole model history. Review must use a fresh empty manager. */
  sessionManager:SessionManager;
  reply:(context:TranscriptContext,signal:AbortSignal|undefined)=>Promise<string>;
  tools?:ToolDefinition[];
  retry?:{enabled:boolean;maxRetries:number;baseDelayMs:number};
}
/** Actual installed Pi SDK deterministic assembly. This never contacts a model provider.
 * It is a test harness, not a substitute for independent model review or an OS sandbox.
 * Real Worker assembly remains blocked at WindowsCandidateDriver until G1 evidence exists. */
export async function createSyntheticPiSession(options:SyntheticSessionOptions):Promise<{session:AgentSession;lifecycle:PiLifecycle;dispose:()=>void}> {
  if(!options.cwd||!options.agentDir||!options.sessionManager)throw new RuntimeError('EXPLICIT_ASSEMBLY_REQUIRED','cwd, private agentDir, and native session manager are mandatory');
  if((options.role==='review'||options.role==='boundary-review')&&options.sessionManager.buildSessionContext().messages.length)
    throw new RuntimeError('REVIEW_HISTORY_DENIED','Review starts from an independent empty native history');
  if(options.retry&&(!Number.isInteger(options.retry.maxRetries)||options.retry.maxRetries<0||options.retry.maxRetries>2))
    throw new RuntimeError('RETRY_LIMIT','Only two additional safe retries are permitted');
  const resources=explicitResourceLoader(options.role,options.materials);
  const modelRuntime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,
    modelsStore:new InMemoryModelsStore(),allowModelNetwork:false,refreshOnCreate:false});
  const provider='pi-kanban-synthetic',modelId='no-model-test';
  modelRuntime.registerProvider(provider,{
    api:'openai-completions',baseUrl:'https://synthetic.invalid/v1',apiKey:'SYNTHETIC-NOT-A-CREDENTIAL',authHeader:false,
    models:[{id:modelId,name:'Synthetic no-model transport',reasoning:false,input:['text'],contextWindow:32768,maxTokens:256,
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
    streamSimple:(model,context,streamOptions)=>{
      const stream=createAssistantMessageEventStream();
      const base:AssistantMessage={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,
        usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
        stopReason:'stop',timestamp:Date.now()};
      queueMicrotask(()=>{void(async()=>{
        try{
          const text=await options.reply(context,streamOptions?.signal);
          const message:AssistantMessage={...base,content:[{type:'text',text}]};
          stream.push({type:'start',partial:{...base}});stream.push({type:'done',reason:'stop',message});stream.end(message);
        }catch(error){
          const message:AssistantMessage={...base,stopReason:streamOptions?.signal?.aborted?'aborted':'error',errorMessage:String(error)};
          stream.push({type:'error',reason:message.stopReason as 'aborted'|'error',error:message});stream.end(message);
        }
      })();});
      return stream;
    },
  });
  const model=modelRuntime.getModel(provider,modelId);
  if(!model)throw new RuntimeError('SDK_MODEL_MISSING','Synthetic model registration failed');
  const names=(options.tools??[]).map(x=>x.name);
  if(names.some(x=>['read','write','edit','bash','powershell','ls','grep','find'].includes(x)))
    throw new RuntimeError('TOOL_SCOPE_DENIED','Use capability-specific controlled tool names, never implicit built-ins');
  const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:options.retry??{enabled:false,maxRetries:0},
    cacheWarming:'off',enableSkillCommands:false,defaultTools:[]});
  const {session}=await createAgentSession({cwd:options.cwd,agentDir:options.agentDir,modelRuntime,model,scopedModels:[{model,thinkingLevel:'off'}],
    thinkingLevel:'off',settingsManager:settings,sessionManager:options.sessionManager,resourceLoader:resources,
    tools:names,noTools:'builtin',customTools:options.tools??[]});
  const lifecycle=new PiLifecycle();const unsubscribe=session.subscribe(event=>lifecycle.accept(event));
  return {session,lifecycle,dispose:()=>{unsubscribe();session.dispose();}};
}
export { SessionManager };
