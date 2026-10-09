import { createAgentSession,ModelRuntime,SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AgentSession,SessionManager,ToolDefinition } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore,InMemoryModelsStore,createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { explicitResourceLoader } from './resources.ts';
import type { AgentMaterial } from './resources.ts';
import { PiLifecycle } from './lifecycle.ts';
import type { PiModelChannel,ModelPurpose } from '../runtime/pi-channel.ts';
import { RuntimeError } from '../runtime/types.ts';
import type { RuntimeRole } from '../runtime/types.ts';

export interface BrokeredPiOptions {
  cwd:string;agentDir:string;role:RuntimeRole;materials:readonly AgentMaterial[];
  sessionManager:SessionManager;channel:PiModelChannel;tools:ToolDefinition[];
  model:{provider:string;id:string;contextWindow:number;maxTokens:number};
  compaction:{enabled:boolean;reserveTokens:number;keepRecentTokens:number};
  retry:{enabled:boolean;maxRetries:number;baseDelayMs:number};
}
/** Production-oriented SDK adapter, usable only inside an externally isolated Worker.
 * Its only model transport is the private Host channel. It holds no provider credentials
 * or provider URL. The Host must authenticate the channel and authorize actual context. */
export async function createBrokeredPiSession(options:BrokeredPiOptions):Promise<{session:AgentSession;lifecycle:PiLifecycle;dispose:()=>void}> {
  if(!options.cwd||!options.agentDir||!options.sessionManager||!options.channel)throw new RuntimeError('EXPLICIT_ASSEMBLY_REQUIRED','Explicit private runtime boundaries are required');
  for(const [name,value] of Object.entries({contextWindow:options.model.contextWindow,maxTokens:options.model.maxTokens,reserveTokens:options.compaction.reserveTokens,keepRecentTokens:options.compaction.keepRecentTokens}))
    if(!Number.isSafeInteger(value)||value<=0)throw new RuntimeError('FINITE_POLICY_REQUIRED',`${name} must be a positive finite integer`);
  if(!Number.isInteger(options.retry.maxRetries)||options.retry.maxRetries<0||options.retry.maxRetries>2||!Number.isFinite(options.retry.baseDelayMs)||options.retry.baseDelayMs<0)
    throw new RuntimeError('RETRY_LIMIT','At most two bounded automatic retries are allowed');
  if(['review','boundary-review'].includes(options.role)&&options.sessionManager.buildSessionContext().messages.length)
    throw new RuntimeError('REVIEW_HISTORY_DENIED','Review requires independent empty native history');
  const resources=explicitResourceLoader(options.role,options.materials);
  const names=options.tools.map(x=>x.name);
  if(new Set(names).size!==names.length||names.some(x=>!/^controlled_[a-z0-9_]+$/.test(x)))
    throw new RuntimeError('TOOL_SCOPE_DENIED','Only explicitly supplied controlled_* bridge tools may be activated');
  let purpose:ModelPurpose='prompt';
  const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,modelsStore:new InMemoryModelsStore(),allowModelNetwork:false,refreshOnCreate:false});
  runtime.registerProvider(options.model.provider,{
    // Public SDK custom transport API requires a compatibility API name/base URL. Neither
    // is sent anywhere; every invocation terminates at streamSimple below.
    api:'openai-completions',baseUrl:'https://host-broker.invalid/v1',apiKey:'HOST-BROKER-NO-PROVIDER-CREDENTIAL',authHeader:false,
    models:[{id:options.model.id,name:options.model.id,reasoning:false,input:['text'],contextWindow:options.model.contextWindow,maxTokens:options.model.maxTokens,
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}], // SDK display estimate is not authoritative; persisted Host metering is.
    streamSimple:(model,context,streamOptions)=>{
      const stream=createAssistantMessageEventStream();
      const base:AssistantMessage={role:'assistant',content:[],provider:model.provider,model:model.id,api:model.api,timestamp:Date.now(),stopReason:'stop',
        usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      queueMicrotask(()=>{void(async()=>{
        try{
          // This callback is reached by ordinary turns, tool loops, automatic retries and
          // SDK compaction/summary model calls through this explicitly registered model.
          const response=await options.channel.complete(context,purpose,streamOptions?.signal);
          const content:AssistantMessage['content']=[];
          if(response.text)content.push({type:'text',text:response.text});
          for(const call of response.toolCalls??[]){if(!names.includes(call.name))throw new RuntimeError('MODEL_TOOL_DENIED','Provider returned a tool outside the explicit capability list');content.push({type:'toolCall',id:call.id,name:call.name,arguments:call.arguments});}
          const message:AssistantMessage={...base,content,stopReason:response.toolCalls?.length?'toolUse':'stop'};
          if(response.usage){message.usage.totalTokens=response.usage.tokens;message.usage.output=response.usage.tokens;message.usage.cost.total=response.usage.costMicros/1_000_000;}
          stream.push({type:'start',partial:{...base}});stream.push({type:'done',reason:message.stopReason as 'stop'|'toolUse',message});stream.end(message);
        }catch(error){const message:AssistantMessage={...base,stopReason:streamOptions?.signal?.aborted?'aborted':'error',errorMessage:String(error)};
          stream.push({type:'error',reason:message.stopReason as 'aborted'|'error',error:message});stream.end(message);}
      })();});return stream;
    },
  });
  const model=runtime.getModel(options.model.provider,options.model.id);if(!model)throw new RuntimeError('SDK_MODEL_MISSING','Bound model was not registered');
  const {session}=await createAgentSession({cwd:options.cwd,agentDir:options.agentDir,modelRuntime:runtime,model,thinkingLevel:'off',scopedModels:[{model,thinkingLevel:'off'}],
    settingsManager:SettingsManager.inMemory({compaction:options.compaction,retry:options.retry,cacheWarming:'off',enableSkillCommands:false,defaultTools:[]}),
    sessionManager:options.sessionManager,resourceLoader:resources,tools:names,noTools:'builtin',customTools:options.tools});
  const lifecycle=new PiLifecycle();const unsubscribe=session.subscribe(event=>{
    lifecycle.accept(event);
    if(event.type==='auto_retry_start')purpose='retry';
    else if(event.type==='compaction_start')purpose='compaction';
    else if(event.type==='compaction_end'||event.type==='agent_settled')purpose='prompt';
  });
  return {session,lifecycle,dispose:()=>{unsubscribe();session.dispose();}};
}
