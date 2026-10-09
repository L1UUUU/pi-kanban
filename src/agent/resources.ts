import { createHash } from 'node:crypto';
import { createExtensionRuntime } from '@earendil-works/pi-coding-agent';
import type { ResourceLoader } from '@earendil-works/pi-coding-agent';
import type { RuntimeRole } from '../runtime/types.ts';
import { RuntimeError } from '../runtime/types.ts';

export interface AgentMaterial {
  id:string;kind:'method'|'plan'|'source'|'knowledge'|'check-evidence'|'implementation-session'|'implementation-summary';
  sha256:string;content:string;
}
/** Host-resolved immutable data only. No ancestor/global resource discovery, path reads, or extensions. */
export function explicitResourceLoader(role:RuntimeRole,materials:readonly AgentMaterial[]):ResourceLoader {
  for(const item of materials){
    if(createHash('sha256').update(item.content).digest('hex')!==item.sha256)throw new RuntimeError('MATERIAL_CHANGED','Agent material digest mismatch');
    if((role==='review'||role==='boundary-review')&&['implementation-session','implementation-summary'].includes(item.kind))
      throw new RuntimeError('REVIEW_CONTEXT_DENIED','Independent review cannot receive implementation conversation or its summary');
  }
  if(new Set(materials.map(x=>x.id)).size!==materials.length)throw new RuntimeError('MATERIAL_CONFLICT','Duplicate material identity');
  const method=materials.filter(x=>x.kind==='method').map(x=>x.content).join('\n\n');
  const context=materials.filter(x=>x.kind!=='method').map(x=>({path:`controlled-material:${x.id}@${x.sha256}`,content:x.content}));
  const extensionRuntime=createExtensionRuntime();
  return {
    getExtensions:()=>({extensions:[],errors:[],runtime:extensionRuntime}),
    getSkills:()=>({skills:[],diagnostics:[]}),getPrompts:()=>({prompts:[],diagnostics:[]}),getThemes:()=>({themes:[],diagnostics:[]}),
    getAgentsFiles:()=>({agentsFiles:context.map(x=>({...x}))}),
    getSystemPrompt:()=>`You are the ${role} Worker for a controlled local workbench. Report evidence through the Host bridge. You cannot grant authorization or accept results.\n\n${method}`,
    getSystemPromptSource:()=>undefined,getAppendSystemPrompt:()=>[],getAppendSystemPromptSources:()=>[],
    extendResources:()=>{throw new RuntimeError('RESOURCE_DISCOVERY_DENIED','Runtime resource extension is disabled');},
    reload:async()=>{},
  };
}
