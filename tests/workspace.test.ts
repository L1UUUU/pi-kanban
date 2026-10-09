import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, unlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorkspaceService, ImmutableObjectStore, digest } from '../src/workspace/index.ts';
const gitExecutable=process.env.PI_KANBAN_TEST_GIT ?? (process.platform==='win32' ? execFileSync('where.exe',['git.exe'],{encoding:'utf8'}).trim().split(/\r?\n/)[0] : existsSync('/usr/local/bin/git')?'/usr/local/bin/git':'/usr/bin/git');
function git(cwd:string,...args:string[]):string{return execFileSync(gitExecutable,args,{cwd,encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'}}).trim();}
function fixture(t:any, empty=false) {
  const root=mkdtempSync(join(tmpdir(),'pi-workspace-')); const repo=join(root,'repo');mkdirSync(repo);
  git(repo,'init','-b','main');git(repo,'config','user.name','Fixture');git(repo,'config','user.email','fixture@example.invalid');
  if(!empty){writeFileSync(join(repo,'code.txt'),'baseline\n');git(repo,'add','code.txt');git(repo,'commit','-m','synthetic baseline');}
  const db=new DatabaseSync(join(root,'control.sqlite'));const service=new WorkspaceService({db,gitExecutable});service.bindProject({projectId:'p',anchorPath:repo,formalTarget:'main'});
  const base=empty?null:git(repo,'rev-parse','HEAD'); const req={operationId:'prepare-a',projectId:'p',demandId:'a',worktreePath:join(root,'a'),branch:'demand/a',baseline:base,prepareAuthorized:true};
  t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});return {root,repo,db,service,base,req};
}
function saveRequest(worktree:string,base:string|null){return {operationId:'save-a',demandId:'a',expectedHead:base,paths:['code.txt'],expectedFiles:{'code.txt':digest(readFileSync(join(worktree,'code.txt')))},message:'Save synthetic demand',author:{name:'Fixture',email:'fixture@example.invalid'},commitAuthorized:true,writerStopped:true};}

test('AC-002/025: unique explicit worktree; immutable private notes excluded from real commit objects',t=>{
 const f=fixture(t);const w=f.service.prepare(f.req);assert.equal(f.service.prepare(f.req).worktreePath,w.worktreePath);
 assert.equal(f.service.git.worktrees(f.repo).length,2);assert.equal(w.initialBaseline,f.base);
 const store=ImmutableObjectStore.open(f.repo,'p');const n=store.put('PRIVATE_SYNTHETIC_MARKER');assert.equal(store.read(n).toString(),'PRIVATE_SYNTHETIC_MARKER');
 writeFileSync(join(w.worktreePath,'code.txt'),'implementation\n');const result=f.service.commit(saveRequest(w.worktreePath,f.base));
 assert.equal(git(w.worktreePath,'status','--porcelain'),'');assert.equal(git(w.worktreePath,'ls-tree','-r','--name-only',result.commit),'code.txt');
 assert.equal(f.service.prepare(f.req).worktreePath,w.worktreePath);assert.equal(git(f.repo,'rev-parse','HEAD'),f.base);
 assert.throws(()=>f.service.prepare({...f.req,operationId:'another',worktreePath:join(f.root,'second')}),/already has/);
});
test('AC-003: unborn repository planning does not fabricate a commit',t=>{
 const f=fixture(t,true);const w=f.service.prepare(f.req);assert.equal(w.head,null);assert.equal(f.service.git.head(w.worktreePath),null);
 assert.equal(git(f.repo,'rev-list','--all','--count'),'0');
 writeFileSync(join(w.worktreePath,'code.txt'),'first actual implementation');const c=f.service.commit(saveRequest(w.worktreePath,null));assert.equal(f.service.git.commitInfo(w.worktreePath,c.commit).parents.length,0);
});
test('AC-004: occupied worktree and staged user work are preserved',t=>{
 const f=fixture(t);mkdirSync(f.req.worktreePath);writeFileSync(join(f.req.worktreePath,'user.txt'),'do not touch');
 assert.throws(()=>f.service.prepare(f.req),/Existing files/);assert.equal(readFileSync(join(f.req.worktreePath,'user.txt'),'utf8'),'do not touch');
 const w=f.service.prepare({...f.req,worktreePath:join(f.root,'free')});writeFileSync(join(w.worktreePath,'user.txt'),'user stage');git(w.worktreePath,'add','user.txt');writeFileSync(join(w.worktreePath,'code.txt'),'new');
 assert.throws(()=>f.service.commit(saveRequest(w.worktreePath,f.base)),/staged work/);assert.equal(git(w.worktreePath,'diff','--cached','--name-only'),'user.txt');
});
test('AC-026: tracked or forcibly staged private materials block commits, even with ignores',t=>{
 const f=fixture(t);const w=f.service.prepare(f.req);mkdirSync(join(w.worktreePath,'.local','pi-kanban'),{recursive:true});writeFileSync(join(w.worktreePath,'.local','pi-kanban','private'),'private');git(w.worktreePath,'add','-f','.local/pi-kanban/private');
 writeFileSync(join(w.worktreePath,'code.txt'),'new');assert.throws(()=>f.service.commit(saveRequest(w.worktreePath,f.base)),/tracked or staged/);
 assert.equal(f.service.git.head(w.worktreePath),f.base);
});
for(const point of ['prepare.intent','prepare.created'])test(`FI-04/AC-053: recover ${point} without duplicate worktrees`,t=>{
 const f=fixture(t);const crash=new WorkspaceService({db:f.db,gitExecutable,fault:p=>{if(p===point)throw new Error('injected crash');}});
 assert.throws(()=>crash.prepare(f.req),/injected crash/);const w=f.service.reconcile(f.req.operationId) as any;assert.equal(w.worktreePath,f.req.worktreePath);assert.equal(f.service.git.worktrees(f.repo).length,2);
});
for(const point of ['commit.intent','commit.staged','commit.object','commit.recorded','commit.ref','commit.index'])test(`FI-04/AC-032: recover ${point} with one ordinary commit`,t=>{
 const f=fixture(t);const w=f.service.prepare(f.req);writeFileSync(join(w.worktreePath,'code.txt'),'new');const input=saveRequest(w.worktreePath,f.base);
 const crash=new WorkspaceService({db:f.db,gitExecutable,fault:p=>{if(p===point)throw new Error('injected crash');}});assert.throws(()=>crash.commit(input),/injected crash/);
 const recovered=f.service.commit(input);assert.equal(git(w.worktreePath,'rev-list','--count','HEAD'),'2');assert.equal(f.service.commit(input).commit,recovered.commit);assert.equal(git(w.worktreePath,'status','--porcelain'),'');
});
test('FI-06/14: immutable object corruption/missing anchor is explicit; no replacement or overwrite',t=>{
 const f=fixture(t);const store=ImmutableObjectStore.open(f.repo,'p');const ref=store.put('version one');assert.equal(store.put('version one').sha256,ref.sha256);
 writeFileSync(store.objectPath(ref),'corrupt');assert.throws(()=>store.read(ref),/corrupt/);assert.throws(()=>store.put('version one'),/corrupt/);
 unlinkSync(store.objectPath(ref));assert.throws(()=>store.read(ref));assert.throws(()=>ImmutableObjectStore.open(f.repo,'other'),/another project/);
});
test('reparse/symlink traversal and path escape are denied before file access',t=>{
 const f=fixture(t);const w=f.service.prepare(f.req);const external=join(f.root,'outside');mkdirSync(external);writeFileSync(join(external,'secret'),'SYNTHETIC_SECRET');
 symlinkSync(external,join(w.worktreePath,'link'),process.platform==='win32'?'junction':'dir');
 assert.throws(()=>f.service.commit({...saveRequest(w.worktreePath,f.base),paths:['link/secret'],expectedFiles:{'link/secret':digest('SYNTHETIC_SECRET')}}),/links and junctions/);
 assert.throws(()=>f.service.commit({...saveRequest(w.worktreePath,f.base),paths:['../outside/secret'],expectedFiles:{'../outside/secret':digest('SYNTHETIC_SECRET')}}),/Unsafe path/);
 const store=ImmutableObjectStore.open(f.repo,'p');const r=store.put('safe');unlinkSync(store.objectPath(r));symlinkSync(process.platform==='win32'?external:join(external,'secret'),store.objectPath(r),process.platform==='win32'?'junction':'file');assert.throws(()=>store.read(r),/links and junctions/);
});
test('configured hooks, signing, filters and fsmonitor are blocked rather than silently skipped',t=>{
 const f=fixture(t);const marker=join(f.root,'hook-ran');writeFileSync(join(f.repo,'.git','hooks','pre-commit'),`#!/bin/sh\ntouch '${marker}'\n`,{mode:0o700});
 assert.throws(()=>f.service.prepare(f.req),/hooks require/);assert.equal(existsSync(marker),false);unlinkSync(join(f.repo,'.git','hooks','pre-commit'));
 for(const key of ['commit.gpgsign','core.fsmonitor','core.hooksPath','diff.external','log.showSignature','gpg.program','merge.verifySignatures']){git(f.repo,'config',key,key==='commit.gpgsign'?'true':'malicious-command');assert.throws(()=>f.service.prepare(f.req),/requires a reviewed restricted adapter/);git(f.repo,'config','--unset',key);}
 git(f.repo,'config','filter.test.clean','malicious-command');writeFileSync(join(f.repo,'.gitattributes'),'code.txt filter=test\n');assert.throws(()=>f.service.prepare(f.req),/Active filter driver test/);git(f.repo,'config','--unset','filter.test.clean');unlinkSync(join(f.repo,'.gitattributes'));
 assert.equal(existsSync(marker),false);
});
test('exact Git object and path scope is checked before source retrieval',t=>{
 const f=fixture(t);f.service.prepare(f.req);assert.throws(()=>f.service.readAuthorizedFile({demandId:'a',commit:f.base!,path:'code.txt',allowedCommits:[],allowedPaths:['code.txt']}),/outside this run/);
 assert.equal(f.service.readAuthorizedFile({demandId:'a',commit:f.base!,path:'code.txt',allowedCommits:[f.base!],allowedPaths:['code.txt']}).toString(),'baseline\n');
});

test('regular-file reader rejects directories, oversized files, and FIFO without blocking',async t=>{
 const {readRegular}=await import('../src/workspace/paths.ts');const f=fixture(t);
 assert.throws(()=>readRegular(f.root),/regular file/);const oversized=join(f.root,'oversized');writeFileSync(oversized,'x'.repeat(1025));assert.throws(()=>readRegular(oversized,1024),/exceeds/);
 if(process.platform!=='win32'){const fifo=join(f.root,'pipe');execFileSync('/usr/bin/mkfifo',[fifo]);assert.throws(()=>readRegular(fifo),/regular file/);}
});

test('no-change commit closes its intent and does not block a later real commit',t=>{
 const f=fixture(t);const w=f.service.prepare(f.req);const noChange=f.service.commit(saveRequest(w.worktreePath,f.base));assert.equal(noChange.noChanges,true);assert.equal(noChange.commit,f.base);
 writeFileSync(join(w.worktreePath,'code.txt'),'actual change');const saved=f.service.commit({...saveRequest(w.worktreePath,f.base),operationId:'actual-change'});assert.notEqual(saved.commit,f.base);assert.equal(git(w.worktreePath,'rev-list','--count','HEAD'),'2');
});

function advanceFormal(repo:string,path:string,body:string):string {writeFileSync(join(repo,path),body);git(repo,'add','--',path);git(repo,'commit','-m','Formal source advanced');return git(repo,'rev-parse','HEAD');}
function updateRequest(source:string){return {operationId:'update-a',demandId:'a',sourceCommit:source,formalTarget:'main',updateAuthorized:true,writerStopped:true,controlState:'active' as const,author:{name:'Fixture',email:'fixture@example.invalid'}};}

test('AC-060/061: pinned formal update requires grant and actual capability verification',t=>{
 const f=fixture(t);const w=f.service.prepare(f.req);const source=advanceFormal(f.repo,'formal.txt','capability');const input=updateRequest(source);
 for(const controlState of ['paused','cancelled','awaiting-acceptance'] as const)assert.throws(()=>f.service.updateBaseline({...input,controlState}),/specific baseline-update grant/);
 assert.throws(()=>f.service.updateBaseline({...input,updateAuthorized:false}),/specific baseline-update grant/);
 const integrated=f.service.updateBaseline(input);assert.equal(integrated.head,source);assert.equal(integrated.capabilityVerified,false);assert.equal(f.service.getBinding('a')!.currentBaseline,f.base);
 advanceFormal(f.repo,'later.txt','must not chase latest');assert.equal(f.service.updateBaseline(input).head,source);
 assert.throws(()=>f.service.verifyBaseline({operationId:input.operationId,expectedHead:source,capabilitiesVerified:false,evidenceRefs:['ancestry-only']}),/Actual code/);
 const verified=f.service.verifyBaseline({operationId:input.operationId,expectedHead:source,capabilitiesVerified:true,evidenceRefs:['synthetic-real-file-capability-check']});assert.equal(verified.state,'verified');assert.equal(f.service.getBinding('a')!.currentBaseline,source);assert.equal(f.service.getBinding('a')!.initialBaseline,f.base);
 assert.equal(readFileSync(join(w.worktreePath,'formal.txt'),'utf8'),'capability');assert.equal(existsSync(join(w.worktreePath,'later.txt')),false);
});
for(const point of ['baseline.intent','baseline.integrated'])test(`FI-13: recover ${point} without repeat integration`,t=>{
 const f=fixture(t);const w=f.service.prepare(f.req);writeFileSync(join(w.worktreePath,'code.txt'),'demand modification');f.service.commit(saveRequest(w.worktreePath,f.base));
 const source=advanceFormal(f.repo,'formal.txt','unrelated formal addition');const input=updateRequest(source);const crash=new WorkspaceService({db:f.db,gitExecutable,fault:p=>{if(p===point)throw new Error('crash');}});
 assert.throws(()=>crash.updateBaseline(input),/crash/);const r=f.service.reconcile(input.operationId) as any;assert.equal(r.state,'integrated-awaiting-verification');const count=git(w.worktreePath,'rev-list','--count','HEAD');f.service.reconcile(input.operationId);assert.equal(git(w.worktreePath,'rev-list','--count','HEAD'),count);assert.equal(f.service.git.commitInfo(w.worktreePath,r.head).parents.length,2);
});
test('FI-13: conflicted merge preserves exact Git scene and does not retry or clean user work',t=>{
 const f=fixture(t);const w=f.service.prepare(f.req);writeFileSync(join(w.worktreePath,'code.txt'),'demand content\n');f.service.commit(saveRequest(w.worktreePath,f.base));const source=advanceFormal(f.repo,'code.txt','conflicting formal content\n');const input=updateRequest(source);
 const conflict=f.service.updateBaseline(input);assert.equal(conflict.state,'conflict');assert.deepEqual(conflict.conflicts,['code.txt']);const before=readFileSync(join(w.worktreePath,'code.txt'),'utf8');assert.match(before,/<<<<<<< HEAD/);
 assert.equal((f.service.reconcile(input.operationId) as any).state,'conflict');assert.equal(readFileSync(join(w.worktreePath,'code.txt'),'utf8'),before);assert.equal(f.service.git.mergeState(w.worktreePath).mergeHead,source);
});
test('non-app .local personal materials are not implicitly committed or ignored',t=>{
 const f=fixture(t);const w=f.service.prepare(f.req);mkdirSync(join(w.worktreePath,'.local'),{recursive:true});writeFileSync(join(w.worktreePath,'.local','personal'),'private');
 assert.throws(()=>f.service.commit({...saveRequest(w.worktreePath,f.base),paths:['.local/personal'],expectedFiles:{'.local/personal':digest('private')}}),/Local personal/);
 git(w.worktreePath,'add','.local/personal');assert.throws(()=>f.service.git.guardPrivate(w.worktreePath),/tracked or staged/);
 assert.ok(!readFileSync(join(f.repo,'.git','info','exclude'),'utf8').split('\n').includes('/.local/'));
});

test('corrupt or missing Git objects fail retrieval rather than selecting another version',t=>{
 const f=fixture(t);f.service.prepare(f.req);const path=join(f.repo,'.git','objects',f.base!.slice(0,2),f.base!.slice(2));chmodSync(path,0o600);writeFileSync(path,'not a Git object');
 assert.throws(()=>f.service.readAuthorizedFile({demandId:'a',commit:f.base!,path:'code.txt',allowedCommits:[f.base!],allowedPaths:['code.txt']}));unlinkSync(path);
 assert.throws(()=>f.service.readAuthorizedFile({demandId:'a',commit:f.base!,path:'code.txt',allowedCommits:[f.base!],allowedPaths:['code.txt']}));
});
test('operation retries use semantic canonical JSON rather than incidental object key order',t=>{
 const f=fixture(t);const w=f.service.prepare(f.req);const reversed=Object.fromEntries(Object.entries(f.req).reverse()) as any;assert.equal(f.service.prepare(reversed).worktreePath,w.worktreePath);
 writeFileSync(join(w.worktreePath,'code.txt'),'changed');const input=saveRequest(w.worktreePath,f.base);const saved=f.service.commit(input);assert.equal(f.service.commit(Object.fromEntries(Object.entries(input).reverse()) as any).commit,saved.commit);
});
test('Git administration symlink/junction cannot redirect object reads outside bound repository',t=>{
 const f=fixture(t);f.service.prepare(f.req);const outside=join(f.root,'outside');mkdirSync(outside);symlinkSync(outside,join(f.repo,'.git','objects','redirect'),process.platform==='win32'?'junction':'dir');assert.throws(()=>f.service.git.status(f.repo),/symlinks or junctions/);
});

test('an unfinished preparation reserves its branch and path across different demands',t=>{
 const f=fixture(t);const crash=new WorkspaceService({db:f.db,gitExecutable,fault:p=>{if(p==='prepare.intent')throw new Error('crash');}});assert.throws(()=>crash.prepare(f.req),/crash/);
 assert.throws(()=>f.service.prepare({...f.req,demandId:'b',operationId:'prepare-b',worktreePath:join(f.root,'b')}),/reserves/);assert.equal((f.service.reconcile('prepare-a') as any).demandId,'a');
});
test('explicit clean existing worktree takeover preserves work and blocks dirty variants',t=>{
 const f=fixture(t);git(f.repo,'worktree','add','-b','external/a',f.req.worktreePath,f.base!);writeFileSync(join(f.req.worktreePath,'code.txt'),'user unfinished work');
 const input={...f.req,branch:'external/a',expectedHead:f.base!,takeoverAuthorized:true,writerStopped:true};assert.throws(()=>f.service.adoptExisting(input),/uncommitted/);assert.equal(readFileSync(join(f.req.worktreePath,'code.txt'),'utf8'),'user unfinished work');
 git(f.req.worktreePath,'add','code.txt');git(f.req.worktreePath,'commit','-m','User saved their own work');const head=git(f.req.worktreePath,'rev-parse','HEAD');const adopted=f.service.adoptExisting({...input,expectedHead:head});assert.equal(adopted.head,head);assert.equal(adopted.initialBaseline,f.base);assert.equal(f.service.git.worktrees(f.repo).length,2);
});

test('AC-028: external code drift is visible without overwriting user edits or old content',t=>{
 const f=fixture(t);const w=f.service.prepare(f.req);assert.equal(f.service.inspectContent({demandId:'a',expectedCommit:f.base}).changed,false);writeFileSync(join(w.worktreePath,'code.txt'),'direct user edit');
 const state=f.service.inspectContent({demandId:'a',expectedCommit:f.base});assert.equal(state.changed,true);assert.equal(state.head,f.base);assert.equal(readFileSync(join(w.worktreePath,'code.txt'),'utf8'),'direct user edit');assert.equal(f.service.git.readFile(w.worktreePath,f.base!,'code.txt').toString(),'baseline\n');
});

test('unused credential helpers are preserved while partial-clone/network execution stays blocked',t=>{
 const f=fixture(t);const marker=join(f.root,'credential-helper-ran');git(f.repo,'config','credential.helper',`!touch '${marker}'`);git(f.repo,'config','remote.origin.url',`ext::touch ${marker}`);git(f.repo,'config','protocol.ext.allow','always');
 const w=f.service.prepare(f.req);writeFileSync(join(w.worktreePath,'code.txt'),'local-only change');f.service.commit(saveRequest(w.worktreePath,f.base));assert.equal(existsSync(marker),false);assert.match(git(f.repo,'config','--get','credential.helper'),/touch/);
 git(f.repo,'config','remote.origin.promisor','true');assert.throws(()=>f.service.git.status(w.worktreePath),/requires a reviewed restricted adapter/);assert.equal(existsSync(marker),false);
});

test('unused LFS, textconv, and merge driver defaults remain intact while real local operations succeed',t=>{
 const f=fixture(t);const marker=join(f.root,'driver-ran');
 for(const key of ['filter.lfs.clean','filter.lfs.smudge','filter.lfs.process','diff.astextplain.textconv','merge.custom.driver'])git(f.repo,'config',key,`touch '${marker}'`);
 git(f.repo,'config','filter.lfs.required','true');const w=f.service.prepare(f.req);writeFileSync(join(w.worktreePath,'code.txt'),'ordinary text');const saved=f.service.commit(saveRequest(w.worktreePath,f.base));assert.ok(saved.commit);assert.equal(existsSync(marker),false);
 assert.equal(git(f.repo,'config','--get','filter.lfs.required'),'true');assert.match(git(f.repo,'config','--get','diff.astextplain.textconv'),/touch/);
});

test('active driver attributes from worktree, index, info attributes and macros block before execution',t=>{
 const f=fixture(t);const marker=join(f.root,'driver-ran');
 for(const [attribute,key] of [['filter','filter.test.clean'],['diff','diff.test.textconv'],['merge','merge.test.driver']]) {
  git(f.repo,'config',key,`touch '${marker}'`);
  writeFileSync(join(f.repo,'.gitattributes'),`[attr]danger ${attribute}=test\ncode.txt danger\n`);assert.throws(()=>f.service.git.status(f.repo),/Active .* driver test/);
  git(f.repo,'config','--unset',key);git(f.repo,'add','.gitattributes');unlinkSync(join(f.repo,'.gitattributes'));git(f.repo,'config',key,`touch '${marker}'`);assert.throws(()=>f.service.git.status(f.repo),/Active .* driver test/);
  git(f.repo,'config','--unset',key);git(f.repo,'reset','--','.gitattributes');
  writeFileSync(join(f.repo,'.git','info','attributes'),`code.txt ${attribute}=test\n`);git(f.repo,'config',key,`touch '${marker}'`);assert.throws(()=>f.service.git.status(f.repo),/Active .* driver test/);git(f.repo,'config','--unset',key);unlinkSync(join(f.repo,'.git','info','attributes'));
 }
 assert.equal(existsSync(marker),false);
});

test('source-tree attributes are checked before checkout even when current worktree unsets them',t=>{
 const f=fixture(t);writeFileSync(join(f.repo,'.gitattributes'),'code.txt filter=lfs\n');git(f.repo,'add','.gitattributes');git(f.repo,'commit','-m','Formal filtered path fixture');const base=git(f.repo,'rev-parse','HEAD');
 writeFileSync(join(f.repo,'.gitattributes'),'code.txt -filter\n');git(f.repo,'add','.gitattributes');git(f.repo,'config','filter.lfs.smudge','touch should-never-run');
 assert.throws(()=>f.service.prepare({...f.req,baseline:base}),/Active filter driver lfs/);assert.equal(existsSync(f.req.worktreePath),false);assert.equal(existsSync(join(f.repo,'should-never-run')),false);
});

test('synthetic global LFS and Windows textconv defaults are actually discovered without config suppression',t=>{
 const f=fixture(t);const home=join(f.root,'synthetic-home');mkdirSync(home);const marker=join(f.root,'global-driver-ran');
 writeFileSync(join(home,'.gitconfig'),`[filter "lfs"]\n clean = touch global-driver-ran\n smudge = touch global-driver-ran\n process = touch global-driver-ran\n required = true\n[diff "astextplain"]\n textconv = touch global-driver-ran\n`);
 const script=`import {DatabaseSync} from 'node:sqlite';import {writeFileSync,existsSync,readFileSync} from 'node:fs';import {WorkspaceService,digest} from ${JSON.stringify(new URL('../src/workspace/index.ts',import.meta.url).href)};const db=new DatabaseSync(${JSON.stringify(join(f.root,'control.sqlite'))});const service=new WorkspaceService({db,gitExecutable:${JSON.stringify(gitExecutable)}});const request=${JSON.stringify(f.req)};const w=service.prepare(request);writeFileSync(w.worktreePath+'/code.txt','global-config fixture');service.commit({operationId:'global-save',demandId:'a',expectedHead:request.baseline,paths:['code.txt'],expectedFiles:{'code.txt':digest(readFileSync(w.worktreePath+'/code.txt'))},message:'Synthetic global config check',author:{name:'Fixture',email:'fixture@example.invalid'},commitAuthorized:true,writerStopped:true});writeFileSync(w.worktreePath+'/.gitattributes','code.txt filter=lfs\\n');let denied=false;try{service.git.status(w.worktreePath)}catch(e){denied=e.code==='UNSUPPORTED_GIT_CONFIG'}if(!denied)throw Error('Global LFS config was not discovered and enforced');db.close();`;
 execFileSync(process.execPath,['--input-type=module','-e',script],{cwd:f.repo,env:{...process.env,HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:join(home,'.config')},stdio:'pipe',timeout:60000});
 assert.equal(existsSync(marker),false);assert.equal(existsSync(join(f.repo,'global-driver-ran')),false);assert.equal(existsSync(join(f.req.worktreePath,'global-driver-ran')),false);
});
