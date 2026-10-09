import { createHash } from 'node:crypto';
import { createExtensionRuntime } from '@earendil-works/pi-coding-agent';
import type { ResourceLoader } from '@earendil-works/pi-coding-agent';
import type { RuntimeRole } from '../runtime/types.ts';
import { RuntimeError } from '../runtime/types.ts';
import { reportAdapterInstructions } from './report-contract.ts';
import type { PlanningSkillSession } from './planning-skills.ts';

export interface AgentMaterial {
  id:string;kind:'method'|'plan'|'source'|'knowledge'|'check-evidence'|'implementation-session'|'implementation-summary';
  sha256:string;content:string;
}
/** Host-resolved immutable data only. No ancestor/global resource discovery, path reads, or extensions. */
export function explicitResourceLoader(role:RuntimeRole,materials:readonly AgentMaterial[],options:{planningSkills?:PlanningSkillSession}={}):ResourceLoader {
  for(const item of materials){
    if(createHash('sha256').update(item.content).digest('hex')!==item.sha256)throw new RuntimeError('MATERIAL_CHANGED','Agent material digest mismatch');
    if((role==='review'||role==='boundary-review')&&['implementation-session','implementation-summary'].includes(item.kind))
      throw new RuntimeError('REVIEW_CONTEXT_DENIED','Independent review cannot receive implementation conversation or its summary');
  }
  if(new Set(materials.map(x=>x.id)).size!==materials.length)throw new RuntimeError('MATERIAL_CONFLICT','Duplicate material identity');
  if(!options.planningSkills&&materials.some(item=>item.kind==='method'&&item.id.endsWith(':skill-bundle')))throw new RuntimeError('PLANNING_RESOURCE_INVALID','A frozen staged bundle requires the explicit active-stage skill adapter');
  if(options.planningSkills&&role!=='planning'&&role!=='boundary-review')throw new RuntimeError('PLANNING_RESOURCE_INVALID','Staged planning resources cannot enter another runtime role');
  // Complete method closures remain in Host evidence. Staged model context receives
  // metadata only; exact active bodies are released by the audited skill tools.
  const method=options.planningSkills?'':materials.filter(x=>x.kind==='method').map(x=>x.content).join('\n\n');
  const context=materials.filter(x=>x.kind!=='method').map(x=>({path:`controlled-material:${x.id}@${x.sha256}`,content:x.content}));
  const extensionRuntime=createExtensionRuntime();
  return {
    getExtensions:()=>({extensions:[],errors:[],runtime:extensionRuntime}),
    getSkills:()=>({skills:structuredClone(options.planningSkills?.skills??[]),diagnostics:[]}),getPrompts:()=>({prompts:[],diagnostics:[]}),getThemes:()=>({themes:[],diagnostics:[]}),
    // Pi renders AGENTS files as system instructions. Staged source/artifact
    // data is supplied by the Worker in its labeled user-data lane instead.
    getAgentsFiles:()=>({agentsFiles:options.planningSkills?[]:context.map(x=>({...x}))}),
    getSystemPrompt:()=>`You are the ${role} Worker for a controlled local workbench. Report evidence through the Host bridge. You cannot grant authorization or accept results.\n\n${reportAdapterInstructions(role,options.planningSkills?.stage)}\n\n${options.planningSkills?.systemInstructions??`Selected frozen method:\n${method}`}`,
    getSystemPromptSource:()=>undefined,getAppendSystemPrompt:()=>[],getAppendSystemPromptSources:()=>[],
    extendResources:()=>{throw new RuntimeError('RESOURCE_DISCOVERY_DENIED','Runtime resource extension is disabled');},
    reload:async()=>{},
  };
}
