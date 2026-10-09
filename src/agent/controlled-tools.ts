import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { lstatSync,realpathSync,writeFileSync,mkdirSync,unlinkSync,opendirSync,openSync,fstatSync,readSync,closeSync,constants } from 'node:fs';
import { resolve,relative,isAbsolute,dirname,join } from 'node:path';
import type { RuntimeRole } from '../runtime/types.ts';
import { RuntimeError } from '../runtime/types.ts';
import { controlledReportParameters } from './report-contract.ts';
export interface NativePinnedWorkspace { version:1;kind:'native-pinned-workspace';path:string;generation:string }
/** Defense-in-depth tool paths; the external AppContainer/Job is the security boundary. */
export function controlledTools(options:{workspace:string;scratch:string;role:RuntimeRole;maxFileBytes:number;commandTimeoutMs:number;maxOutputBytes:number;
  generation?:string;workspaceCapability?:NativePinnedWorkspace;
  report:(body:Record<string,unknown>)=>Promise<unknown>;stopRequired:(reason:string)=>void;
  write?:(toolCallId:string,path:string,content:string,perform:()=>void)=>Promise<void>;
  delete?:(toolCallId:string,path:string,perform:()=>void)=>Promise<void>;
  check?:(toolCallId:string,args:string[],signal:AbortSignal|undefined)=>Promise<{output:string;exitCode:number|null;[key:string]:unknown}>}):ToolDefinition[]{
  if('shell' in options&&options.shell!=null)throw new RuntimeError('SHELL_NOT_SUPPORTED','The Node-only product cannot register a shell tool');
  // The private Host may provide this only after native exact-path pinning and
  // launch proof. It is an explicit alternative contract, never an error fallback.
  const capability=options.workspaceCapability;
  if(capability!==undefined&&(!capability||typeof capability!=='object'||Array.isArray(capability)||typeof options.generation!=='string'||!options.generation||capability.version!==1||capability.kind!=='native-pinned-workspace'||capability.path!==options.workspace||capability.generation!==options.generation||!isAbsolute(capability.path)||resolve(capability.path)!==capability.path||Object.keys(capability).sort().join(',')!=='generation,kind,path,version'))
    throw new RuntimeError('WORKSPACE_CAPABILITY_INVALID','Exact native-pinned workspace and generation are required');
  const root=capability?capability.path:realpathSync.native(options.workspace);
  const rootStat=lstatSync(root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new RuntimeError('TOOL_PATH_DENIED','Selected workspace must remain the pinned ordinary directory');
  function path(input:string,write=false){
    if(typeof input!=='string'||!input||isAbsolute(input)||input.split(/[\\/]/).some(x=>x==='..'||['.git','.local'].includes(x.toLowerCase())))throw new RuntimeError('TOOL_PATH_DENIED','Only approved relative source paths are allowed');
    const target=resolve(root,input),rel=relative(root,target);if(rel.startsWith('..')||isAbsolute(rel))throw new RuntimeError('TOOL_PATH_DENIED','Outside source workspace');
    let cursor=target;while(cursor!==root){try{if(lstatSync(cursor).isSymbolicLink())throw new RuntimeError('TOOL_PATH_DENIED','Links and junctions are not followed');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}cursor=dirname(cursor);}
    if(write&&options.role!=='implementation')throw new RuntimeError('READ_ONLY_ROLE','This role cannot modify source');return target;
  }
  /** Bound each read independently of mutable file size and never open a FIFO as a stream. */
  function readSourceFile(file:string,before=lstatSync(file)):{text:string;bytes:number}{
    if(!before.isFile()||before.isSymbolicLink())throw new RuntimeError('FILE_REQUIRED','An ordinary source file is required');
    if(before.size>Math.min(options.maxFileBytes,1024*1024))throw new RuntimeError('FILE_TOO_LARGE','Read exceeds the bounded source-file size');
    const fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    try{
      const opened=fstatSync(fd);
      if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)throw new RuntimeError('SOURCE_CHANGED','Source file changed before reading');
      const buffer=Buffer.alloc(opened.size+1);let count=0;
      while(count<buffer.length){const size=readSync(fd,buffer,count,buffer.length-count,count);if(!size)break;count+=size;}
      const after=fstatSync(fd);
      if(count!==opened.size||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs)throw new RuntimeError('SOURCE_CHANGED','Source file changed while reading');
      let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,count));}catch{throw new RuntimeError('FILE_ENCODING_INVALID','Source files must be valid UTF-8');}
      return {text,bytes:count};
    }finally{closeSync(fd);}
  }
  function fields(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new RuntimeError('TOOL_INPUT','Tool object required');return value as Record<string,unknown>;}
  function string(value:unknown):string{if(typeof value!=='string')throw new RuntimeError('TOOL_INPUT','Tool string required');return value;}
  const result=(text:string,details:unknown={})=>({content:[{type:'text' as const,text}],details});
  const checkResult=(checked:{output:string;exitCode:number|null;[key:string]:unknown})=>result(`${checked.output}\n\nHost check receipt: ${JSON.stringify({requestId:checked.requestId,exitCode:checked.exitCode,reason:checked.reason,evidence:checked.evidence})}`,checked);
  const tools:ToolDefinition[]=[
    {name:'controlled_read',label:'Read approved source',description:'Read one bounded ordinary UTF-8 source file; excludes shared Git and local knowledge paths.',parameters:Type.Object({path:Type.String()}),async execute(_id,params){const content=readSourceFile(path(string(fields(params).path)));if(content.bytes>options.maxOutputBytes)throw new RuntimeError('TOOL_OUTPUT_LIMIT','Source file exceeds the output bound');return result(content.text);}},
    {name:'controlled_list',label:'List approved source',description:'List at most 1,000 source entries within the output bound, excluding metadata and links. Narrow the path if the directory is too large.',parameters:Type.Object({path:Type.Optional(Type.String())}),async execute(_id,params,signal){
      const input=fields(params),folder=input.path===undefined?root:path(string(input.path));
      if(!lstatSync(folder).isDirectory())throw new RuntimeError('DIRECTORY_REQUIRED','An ordinary source directory is required');
      const directory=opendirSync(folder),names:string[]=[];let bytes=2,entries=0;
      try{for(let entry=directory.readSync();entry;entry=directory.readSync()){
        signal?.throwIfAborted();if(++entries>10_000)throw new RuntimeError('TOOL_OUTPUT_LIMIT','Directory scan exceeds its bound; select a narrower directory');
        if(['.git','.local'].includes(entry.name.toLowerCase())||entry.isSymbolicLink())continue;
        bytes+=Buffer.byteLength(JSON.stringify(entry.name))+(names.length?1:0);
        if(names.length>=1000||bytes>options.maxOutputBytes)throw new RuntimeError('TOOL_OUTPUT_LIMIT','Directory listing exceeds its bound; select a narrower directory');
        names.push(entry.name);
      }}finally{directory.closeSync();}
      return result(JSON.stringify(names.sort()));
    }},
    {name:'controlled_search',label:'Search approved source',description:'Search for literal text in bounded UTF-8 source files. Excludes Git/local metadata, links and binary/oversized files. Returns relative paths, line numbers and snippets, with explicit truncation and skipped-file counts.',parameters:Type.Object({query:Type.String({minLength:1,maxLength:256}),path:Type.Optional(Type.String()),maxResults:Type.Optional(Type.Integer({minimum:1,maximum:100}))}),async execute(_id,params,signal){
      const input=fields(params),query=string(input.query),maxResults=input.maxResults??25;
      if(!query||query.length>256||query.includes('\0')||query.includes('\n')||query.includes('\r')||!Number.isSafeInteger(maxResults)||Number(maxResults)<1||Number(maxResults)>100)throw new RuntimeError('TOOL_INPUT','A bounded single-line literal query and 1 to 100 results are required');
      const selected=input.path===undefined?root:path(string(input.path));
      const matches:{path:string;line:number;text:string}[]=[];let visited=0,entries=0,bytes=0,skippedFiles=0,truncated=false;
      const outputLimit=Math.min(options.maxOutputBytes,256*1024),byteLimit=16*1024*1024;
      if(outputLimit<128)throw new RuntimeError('TOOL_OUTPUT_LIMIT','Search needs at least 128 output bytes');
      const pending=[selected];
      while(pending.length&&!truncated){
        signal?.throwIfAborted();if(++visited>10_000){truncated=true;break;}
        const target=pending.pop()!,checked=target===root?root:path(relative(root,target)),stat=lstatSync(checked);
        if(stat.isSymbolicLink()){skippedFiles++;continue;}
        if(stat.isDirectory()){
          const directory=opendirSync(checked);
          try{for(let entry=directory.readSync();entry;entry=directory.readSync()){
            signal?.throwIfAborted();if(++entries>10_000){truncated=true;break;}
            if(['.git','.local'].includes(entry.name.toLowerCase()))continue;
            if(entry.isSymbolicLink()){skippedFiles++;continue;}
            if(pending.length+visited>=10_000){truncated=true;break;}
            pending.push(join(checked,entry.name));
          }}finally{directory.closeSync();}
          continue;
        }
        if(!stat.isFile()||stat.size>Math.min(options.maxFileBytes,1024*1024)){skippedFiles++;continue;}
        if(bytes+stat.size>byteLimit){truncated=true;break;}
        bytes+=stat.size;let content:string;
        try{content=readSourceFile(checked,stat).text;}
        catch(error){if(error instanceof RuntimeError&&error.code==='FILE_ENCODING_INVALID'){skippedFiles++;continue;}throw error;}
        if(content.includes('\0')){skippedFiles++;continue;}
        const lines=content.split(/\r?\n/);
        for(let index=0;index<lines.length;index++){
          const offset=lines[index]!.indexOf(query);if(offset<0)continue;
          const match={path:relative(root,checked).split('\\').join('/'),line:index+1,text:lines[index]!.slice(Math.max(0,offset-80),Math.max(0,offset-80)+512)};
          if(Buffer.byteLength(JSON.stringify({matches:[...matches,match],truncated:false,skippedFiles}))+64>outputLimit){truncated=true;break;}
          matches.push(match);if(matches.length>=Number(maxResults)){truncated=true;break;}
        }
      }
      const found={matches,truncated,skippedFiles};return result(JSON.stringify(found),found);
    }},
    {name:'controlled_report',label:'Report evidence to Host',description:'Submit one role-specific report using the complete schema and Host report adapter instructions. Exact P/C/check/finding IDs and artifact references come from approved materials or visible tool receipts. Omit Host-bound identity fields. Reports never approve work, accept results, or prove their own authenticity.',parameters:controlledReportParameters(options.role),async execute(_id,params){return result(JSON.stringify(await options.report(fields(fields(params).report))));}},
    {name:'controlled_node',label:'Run a bounded Node check',description:'Execute source-preserving Node arguments inside this externally isolated Job, with private scratch. No shell or inherited user environment. On the pinned Windows runtime, use --test --test-isolation=none for in-process Node tests; child-process stdio/IPC pipe creation is unsupported. Do not silently change required check semantics; report blocked if a check requires unsupported process isolation or tools.',parameters:Type.Object({args:Type.Array(Type.String(),{maxItems:64})}),
      async execute(toolCallId,params,signal){
        const args=fields(params).args;if(!Array.isArray(args)||!args.length||args.length>64||args.some(x=>typeof x!=='string'||x.includes('\0')||x.length>8192)||args.join('').length>32768)throw new RuntimeError('TOOL_INPUT','Bounded string arguments required');
        if(!options.check)throw new RuntimeError('NATIVE_CHECK_UNAVAILABLE','Only the independently supervised native command channel may execute checks');
        const checked=await options.check(toolCallId,args as string[],signal);return checkResult(checked);
      }},
  ];
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
