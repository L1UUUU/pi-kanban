import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { lstatSync,realpathSync,readFileSync,writeFileSync,mkdirSync,readdirSync,unlinkSync } from 'node:fs';
import { resolve,relative,isAbsolute,dirname } from 'node:path';
import type { RuntimeRole } from '../runtime/types.ts';
import { RuntimeError } from '../runtime/types.ts';
import { controlledReportParameters } from './report-contract.ts';
/** Defense-in-depth tool paths; the external AppContainer/Job is the security boundary. */
export function controlledTools(options:{workspace:string;scratch:string;role:RuntimeRole;maxFileBytes:number;commandTimeoutMs:number;maxOutputBytes:number;
  report:(body:Record<string,unknown>)=>Promise<unknown>;stopRequired:(reason:string)=>void;
  write?:(toolCallId:string,path:string,content:string,perform:()=>void)=>Promise<void>;
  delete?:(toolCallId:string,path:string,perform:()=>void)=>Promise<void>;
  shell?:(toolCallId:string,command:string,signal:AbortSignal|undefined)=>Promise<{output:string;exitCode:number|null;[key:string]:unknown}>;
  check?:(toolCallId:string,args:string[],signal:AbortSignal|undefined)=>Promise<{output:string;exitCode:number|null;[key:string]:unknown}>}):ToolDefinition[]{
  // Native canonicalization opens the selected path directly on Windows rather
  // than requiring metadata permission on every volume-root ancestor. No fallback.
  const root=realpathSync.native(options.workspace);
  function path(input:string,write=false){
    if(typeof input!=='string'||!input||isAbsolute(input)||input.split(/[\\/]/).some(x=>x==='..'||x==='.git'||x==='.local'))throw new RuntimeError('TOOL_PATH_DENIED','Only approved relative source paths are allowed');
    const target=resolve(root,input),rel=relative(root,target);if(rel.startsWith('..')||isAbsolute(rel))throw new RuntimeError('TOOL_PATH_DENIED','Outside source workspace');
    let cursor=target;while(cursor!==root){try{if(lstatSync(cursor).isSymbolicLink())throw new RuntimeError('TOOL_PATH_DENIED','Links and junctions are not followed');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}cursor=dirname(cursor);}
    if(write&&options.role!=='implementation')throw new RuntimeError('READ_ONLY_ROLE','This role cannot modify source');return target;
  }
  function fields(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new RuntimeError('TOOL_INPUT','Tool object required');return value as Record<string,unknown>;}
  function string(value:unknown):string{if(typeof value!=='string')throw new RuntimeError('TOOL_INPUT','Tool string required');return value;}
  const result=(text:string,details:unknown={})=>({content:[{type:'text' as const,text}],details});
  const checkResult=(checked:{output:string;exitCode:number|null;[key:string]:unknown})=>result(`${checked.output}\n\nHost check receipt: ${JSON.stringify({requestId:checked.requestId,exitCode:checked.exitCode,reason:checked.reason,evidence:checked.evidence})}`,checked);
  const tools:ToolDefinition[]=[
    {name:'controlled_read',label:'Read approved source',description:'Read a relative file in this demand; no shared Git or local knowledge directories.',parameters:Type.Object({path:Type.String()}),async execute(_id,params){const file=path(string(fields(params).path));if(lstatSync(file).size>options.maxFileBytes)throw new RuntimeError('FILE_TOO_LARGE','Read exceeds bounded size');return result(readFileSync(file,'utf8'));}},
    {name:'controlled_list',label:'List approved source',description:'List source entries, excluding restricted internal paths.',parameters:Type.Object({path:Type.Optional(Type.String())}),async execute(_id,params){const folder=fields(params).path?path(string(fields(params).path)):root;const names=readdirSync(folder).filter(name=>name!=='.git'&&name!=='.local');return result(JSON.stringify(names));}},
    {name:'controlled_report',label:'Report evidence to Host',description:'Submit one role-specific report using the complete schema and Host report adapter instructions. Exact P/C/check/finding IDs and artifact references come from approved materials or visible tool receipts. Omit Host-bound identity fields. Reports never approve work, accept results, or prove their own authenticity.',parameters:controlledReportParameters(options.role),async execute(_id,params){return result(JSON.stringify(await options.report(fields(fields(params).report))));}},
    {name:'controlled_node',label:'Run a bounded Node check',description:'Execute Node arguments inside this externally isolated Job. No shell or inherited user environment.',parameters:Type.Object({args:Type.Array(Type.String(),{maxItems:64})}),
      async execute(toolCallId,params,signal){
        const args=fields(params).args;if(!Array.isArray(args)||!args.length||args.length>64||args.some(x=>typeof x!=='string'))throw new RuntimeError('TOOL_INPUT','Bounded string arguments required');
        if(!options.check)throw new RuntimeError('NATIVE_CHECK_UNAVAILABLE','Only the independently supervised native command channel may execute checks');
        const checked=await options.check(toolCallId,args as string[],signal);return checkResult(checked);
      }},
  ];
  if(options.shell)tools.push({name:'controlled_shell',label:'Run locked Git Bash check',description:'Execute one bounded command script using the exact configured Git Bash with no profiles or user environment. Source changes are not approved by this tool and stop further model transmission.',parameters:Type.Object({command:Type.String({maxLength:8192})}),async execute(toolCallId,params,signal){const command=string(fields(params).command);if(!command||command.length>8192||command.includes('\0'))throw new RuntimeError('TOOL_INPUT','A bounded command script is required');const checked=await options.shell!(toolCallId,command,signal);return checkResult(checked);}});
  if(options.role==='implementation')tools.push({name:'controlled_write',label:'Write this demand source',description:'Write one exact bounded UTF-8 file after Host authorization; Host independently verifies the resulting source before later model transmission.',parameters:Type.Object({path:Type.String(),content:Type.String()}),async execute(toolCallId,params){
    const content=string(fields(params).content),relativePath=string(fields(params).path);if(Buffer.byteLength(content)>options.maxFileBytes)throw new RuntimeError('FILE_TOO_LARGE','Write exceeds bounded size');
    if(!options.write)throw new RuntimeError('SOURCE_WRITE_UNAVAILABLE','Source writes require the Host mutation-verification channel');
    path(relativePath,true);await options.write(toolCallId,relativePath,content,()=>{const file=path(relativePath,true);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,content,'utf8');});return result('Saved exact source bytes; Host independently verified the generated mutation.');}});
  if(options.role==='implementation')tools.push({name:'controlled_delete',label:'Delete one demand source file',description:'Delete one exact existing ordinary source file after Host authorization and independent verification. No recursive deletion.',parameters:Type.Object({path:Type.String()}),async execute(toolCallId,params){
    const relativePath=string(fields(params).path),file=path(relativePath,true);if(!lstatSync(file).isFile())throw new RuntimeError('SOURCE_DELETE_DENIED','Only one ordinary existing source file may be deleted');
    if(!options.delete)throw new RuntimeError('SOURCE_WRITE_UNAVAILABLE','Deletion requires the Host mutation-verification channel');
    await options.delete(toolCallId,relativePath,()=>{const target=path(relativePath,true);if(!lstatSync(target).isFile())throw new RuntimeError('SOURCE_DELETE_DENIED','Deletion target changed');unlinkSync(target);});return result('Deleted the exact file; Host independently verified the mutation.');}});
  return tools;
}
