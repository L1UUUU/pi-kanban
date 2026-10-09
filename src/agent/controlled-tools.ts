import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { lstatSync,realpathSync,readFileSync,writeFileSync,mkdirSync,readdirSync } from 'node:fs';
import { resolve,relative,isAbsolute,dirname } from 'node:path';
import type { RuntimeRole } from '../runtime/types.ts';
import { RuntimeError } from '../runtime/types.ts';
/** Defense-in-depth tool paths; the external AppContainer/Job is the security boundary. */
export function controlledTools(options:{workspace:string;scratch:string;role:RuntimeRole;maxFileBytes:number;commandTimeoutMs:number;maxOutputBytes:number;
  report:(body:Record<string,unknown>)=>Promise<unknown>;stopRequired:(reason:string)=>void;
  check?:(toolCallId:string,args:string[],signal:AbortSignal|undefined)=>Promise<{output:string;exitCode:number|null;[key:string]:unknown}>}):ToolDefinition[]{
  const root=realpathSync(options.workspace);
  function path(input:string,write=false){
    if(typeof input!=='string'||!input||isAbsolute(input)||input.split(/[\\/]/).some(x=>x==='..'||x==='.git'||x==='.local'))throw new RuntimeError('TOOL_PATH_DENIED','Only approved relative source paths are allowed');
    const target=resolve(root,input),rel=relative(root,target);if(rel.startsWith('..')||isAbsolute(rel))throw new RuntimeError('TOOL_PATH_DENIED','Outside source workspace');
    let cursor=target;while(cursor!==root){try{if(lstatSync(cursor).isSymbolicLink())throw new RuntimeError('TOOL_PATH_DENIED','Links and junctions are not followed');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}cursor=dirname(cursor);}
    if(write&&options.role!=='implementation')throw new RuntimeError('READ_ONLY_ROLE','This role cannot modify source');return target;
  }
  function fields(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new RuntimeError('TOOL_INPUT','Tool object required');return value as Record<string,unknown>;}
  function string(value:unknown):string{if(typeof value!=='string')throw new RuntimeError('TOOL_INPUT','Tool string required');return value;}
  const result=(text:string,details:unknown={})=>({content:[{type:'text' as const,text}],details});
  const tools:ToolDefinition[]=[
    {name:'controlled_read',label:'Read approved source',description:'Read a relative file in this demand; no shared Git or local knowledge directories.',parameters:Type.Object({path:Type.String()}),async execute(_id,params){const file=path(string(fields(params).path));if(lstatSync(file).size>options.maxFileBytes)throw new RuntimeError('FILE_TOO_LARGE','Read exceeds bounded size');return result(readFileSync(file,'utf8'));}},
    {name:'controlled_list',label:'List approved source',description:'List source entries, excluding restricted internal paths.',parameters:Type.Object({path:Type.Optional(Type.String())}),async execute(_id,params){const folder=fields(params).path?path(string(fields(params).path)):root;const names=readdirSync(folder).filter(name=>name!=='.git'&&name!=='.local');return result(JSON.stringify(names));}},
    {name:'controlled_report',label:'Report evidence to Host',description:'Submit a typed report. A report cannot approve work, accept a result or prove its own authenticity.',parameters:Type.Object({report:Type.Record(Type.String(),Type.Unknown())}),async execute(_id,params){return result(JSON.stringify(await options.report(fields(fields(params).report))));}},
    {name:'controlled_node',label:'Run a bounded Node check',description:'Execute Node arguments inside this externally isolated Job. No shell or inherited user environment.',parameters:Type.Object({args:Type.Array(Type.String(),{maxItems:64})}),
      async execute(toolCallId,params,signal){
        const args=fields(params).args;if(!Array.isArray(args)||!args.length||args.length>64||args.some(x=>typeof x!=='string'))throw new RuntimeError('TOOL_INPUT','Bounded string arguments required');
        if(!options.check)throw new RuntimeError('NATIVE_CHECK_UNAVAILABLE','Only the independently supervised native command channel may execute checks');
        const checked=await options.check(toolCallId,args as string[],signal);return result(checked.output,{...checked});
      }},
  ];
  if(options.role==='implementation')tools.push({name:'controlled_write',label:'Write this demand source',description:'Write a bounded UTF-8 source file within this demand only.',parameters:Type.Object({path:Type.String(),content:Type.String()}),async execute(_id,params){
    if(Buffer.byteLength(string(fields(params).content))>options.maxFileBytes)throw new RuntimeError('FILE_TOO_LARGE','Write exceeds bounded size');const file=path(string(fields(params).path),true);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,string(fields(params).content),'utf8');return result('Saved source bytes; Host must snapshot and verify the result.');}});
  return tools;
}
