import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, lstatSync, appendFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { insist, noLinks, readRegular, sourcePath, WorkspaceError, canonicalDirectory, canonicalDestination } from './paths.ts';

export interface GitOptions { gitExecutable?: string; timeoutMs?: number; maxBuffer?: number }
/** Host-only bounded Git broker. No public arbitrary-command or network interface. */
export class ControlledGit {
  readonly executable: string; private timeout: number; private maxBuffer: number;
  constructor(options: GitOptions = {}) {
    const candidate = options.gitExecutable ?? (process.platform === 'win32' ? '' : '/usr/bin/git');
    insist(isAbsolute(candidate) && existsSync(candidate), 'GIT_UNAVAILABLE', 'Configure a verified absolute Git executable path.');
    this.executable = candidate; this.timeout = options.timeoutMs ?? 15_000; this.maxBuffer = options.maxBuffer ?? 8 * 1024 * 1024;
    insist(this.timeout > 0 && this.timeout <= 120_000, 'INVALID_LIMIT', 'Git requires a bounded timeout.');
  }
  private invoke(cwd: string, args: string[], input?: string, extraEnv: Record<string,string> = {}): Buffer {
    noLinks(cwd);
    const env: NodeJS.ProcessEnv = {PATH:dirname(this.executable), HOME:homedir(), USERPROFILE:homedir(), SYSTEMROOT:process.env.SYSTEMROOT,
      LANG:'C', LC_ALL:'C', GIT_TERMINAL_PROMPT:'0', GIT_OPTIONAL_LOCKS:'0', GIT_LITERAL_PATHSPECS:'1', GIT_ALLOW_PROTOCOL:'', GIT_NO_LAZY_FETCH:'1', ...extraEnv};
    try { return execFileSync(this.executable, ['--no-pager', ...args], {cwd, env, input, timeout:this.timeout, maxBuffer:this.maxBuffer, windowsHide:true, stdio:['pipe','pipe','pipe']}); }
    catch (error: any) {
      // Never return uncontrolled stderr (which could contain personal paths or content) to a Worker.
      throw new WorkspaceError(error.code === 'ETIMEDOUT' ? 'GIT_TIMEOUT' : 'GIT_FAILED', `Controlled Git operation failed (${args[0]}), exit ${error.status ?? 'unknown'}.`);
    }
  }
  private config(cwd: string): Map<string,string[]> {
    const bytes = this.invoke(cwd, ['config','--null','--list']); const result = new Map<string,string[]>();
    for (const entry of bytes.toString().split('\0').filter(Boolean)) {
      const split = entry.indexOf('\n'); const key = (split < 0 ? entry : entry.slice(0,split)).toLowerCase();
      result.set(key, [...(result.get(key) ?? []), split < 0 ? '' : entry.slice(split+1)]);
    } return result;
  }
  commonDirectory(cwd:string):string {
    const dotGit=join(cwd,'.git');noLinks(dotGit);let gitDir:string;
    if(lstatSync(dotGit).isDirectory())gitDir=canonicalDirectory(dotGit);
    else {const pointer=readRegular(dotGit,8192).toString().match(/^gitdir: ([^\r\n]+)\r?\n?$/);insist(pointer,'GIT_ADMIN_INVALID','Invalid worktree administration pointer.');gitDir=canonicalDirectory(resolve(cwd,pointer[1]));}
    const commonPointer=join(gitDir,'commondir');
    if(!existsSync(commonPointer))return gitDir;
    const common=readRegular(commonPointer,8192).toString().trim();insist(common.length>0 && !/[\r\n\0]/.test(common),'GIT_ADMIN_INVALID','Invalid common administration pointer.');return canonicalDirectory(resolve(gitDir,common));
  }
  private guardAdministration(common:string):void {
    // Reject junctions/symlinks within shared Git administration before object/index operations.
    // The bounded scan is intentionally conservative for this small-project prototype.
    let count=0;const pending=[common];
    while(pending.length){const directory=pending.pop()!;noLinks(directory);
      for(const entry of readdirSync(directory,{withFileTypes:true})){
        insist(++count<=100000,'GIT_ADMIN_TOO_LARGE',"Git administrative tree exceeds this prototype’s bounded verification scope.");
        insist(!entry.isSymbolicLink(),'UNSAFE_PATH','Git administrative symlinks or junctions require a verified adapter.');
        insist(entry.isFile() || entry.isDirectory(),'INVALID_FILE','Git administration contains a non-regular filesystem object.');
        if(entry.isDirectory())pending.push(join(directory,entry.name));
      }
    }
  }
  guard(cwd: string): void {
    noLinks(cwd); const common=this.commonDirectory(cwd);this.guardAdministration(common);const config = this.config(cwd);
    for (const [key, values] of config) {
      const dangerous = /^gpg\./.test(key)
        || ['core.hookspath','core.fsmonitor','core.sshcommand','core.gitproxy','core.attributesfile','core.pager','core.editor','core.worktree','core.alternaterefscommand','diff.external','log.showsignature','merge.verifysignatures','sequence.editor'].includes(key)
        || ['extensions.worktreeconfig','extensions.partialclone'].includes(key) || /^remote\..*\.promisor$/.test(key);
      const signing = ['commit.gpgsign','tag.gpgsign'].includes(key) && values.some(v => !['false','no','off','0'].includes(v.toLowerCase()));
      insist(!dangerous && !signing, 'UNSUPPORTED_GIT_CONFIG', `Project Git setting ${key} requires a reviewed restricted adapter; it was not bypassed.`);
    }
    insist(!existsSync(join(common,'objects','info','alternates')),'UNSUPPORTED_GIT_CONFIG','Alternate object stores require explicit project binding and are unsupported.');
    this.guardActiveDrivers(cwd,config);
    const hooks = join(common,'hooks');
    if (existsSync(hooks)) { noLinks(hooks); for (const name of readdirSync(hooks)) {
      if (name.endsWith('.sample')) continue;
      const path = join(hooks,name); noLinks(path);
      insist(false, 'UNSUPPORTED_GIT_HOOK', 'Project Git hooks require a restricted adapter and were not executed or bypassed.');
    }}
  }
  /** Attribute inspection never executes filters, textconv, or custom merge programs. */
  private guardActiveDrivers(cwd:string,config:Map<string,string[]>,explicitPaths?:string[],source?:string):void {
    const drivers=new Map<string,Set<string>>([['filter',new Set()],['diff',new Set()],['merge',new Set()]]);
    for(const key of config.keys()) {
      const match=key.match(/^(filter)\.(.+)\.(?:clean|smudge|process|required)$/) ?? key.match(/^(diff)\.(.+)\.(?:command|textconv)$/) ?? key.match(/^(merge)\.(.+)\.driver$/);
      if(match)drivers.get(match[1])!.add(match[2]);
    }
    if(![...drivers.values()].some(values=>values.size))return;
    const defaultMerge=config.get('merge.default')?.at(-1)?.toLowerCase();
    insist(!defaultMerge || !drivers.get('merge')!.has(defaultMerge),'UNSUPPORTED_GIT_CONFIG','Active default merge driver requires a reviewed restricted adapter; it was not bypassed.');
    const paths=explicitPaths ?? this.invoke(cwd,['ls-files','--cached','--others','--exclude-standard','-z']).toString().split('\0').filter(Boolean);
    if(!paths.length)return;
    const input=[...new Set(paths)].join('\0')+'\0';
    const views=source ? [[`--source=${source}`]] : [[],['--cached']];
    for(const view of views) {
      const attributes=this.invoke(cwd,['check-attr','-z','--stdin',...view,'filter','diff','merge'],input).toString().split('\0');
      for(let index=0;index+2<attributes.length;index+=3) {
        const attribute=attributes[index+1];const driver=attributes[index+2].toLowerCase();
        insist(!drivers.get(attribute)?.has(driver),'UNSUPPORTED_GIT_CONFIG',`Active ${attribute} driver ${driver} requires a reviewed restricted adapter; it was not bypassed.`);
      }
    }
  }
  private run(cwd: string, args: string[], input?: string, extraEnv?: Record<string,string>): Buffer { this.guard(cwd); return this.invoke(cwd,args,input,extraEnv); }
  validateBranch(branch: string): void {
    insist(typeof branch === 'string' && /^[A-Za-z0-9][A-Za-z0-9/_-]{0,150}$/.test(branch) && !branch.includes('//') && !branch.endsWith('/') && !branch.endsWith('.lock'), 'INVALID_BRANCH', 'Use a portable explicit branch name.');
  }
  validateOid(oid: string): void { insist(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid), 'INVALID_COMMIT', 'An exact Git object identity is required.'); }
  head(cwd: string): string | null {
    this.guard(cwd);
    try { return this.invoke(cwd,['rev-parse','--verify','HEAD^{commit}']).toString().trim(); }
    catch (e) {
      // Missing HEAD only means unborn when symbolic HEAD exists and the branch ref is absent.
      const branch = this.invoke(cwd,['symbolic-ref','HEAD']).toString().trim();
      const refs = this.invoke(cwd,['for-each-ref','--format=%(refname)',branch]).toString().trim();
      if (!refs) return null; throw e;
    }
  }
  branch(cwd: string): string { return this.run(cwd,['symbolic-ref','--short','HEAD']).toString().trim(); }
  resolveCommit(cwd: string, oid: string): string { this.validateOid(oid); return this.run(cwd,['rev-parse','--verify',`${oid}^{commit}`]).toString().trim(); }
  status(cwd: string): string[] { return this.run(cwd,['status','--ignore-submodules=all','--porcelain=v1','-z','--untracked-files=all']).toString().split('\0').filter(Boolean); }
  staged(cwd: string): string[] { return this.run(cwd,['diff','--ignore-submodules=all','--cached','--name-only','-z']).toString().split('\0').filter(Boolean); }
  tracked(cwd: string): string[] { return this.run(cwd,['ls-files','-z']).toString().split('\0').filter(Boolean); }
  guardPrivate(cwd: string): void {
    const files = [...this.tracked(cwd), ...this.staged(cwd)];
    insist(!files.some(p => /^\.local(?:\/|$)/i.test(p)), 'PRIVATE_TRACKED', 'Private application materials are tracked or staged. Preserve them and resolve this explicitly before continuing.');
  }
  excludeOwned(cwd: string): void {
    this.guard(cwd); const common = this.invoke(cwd,['rev-parse','--path-format=absolute','--git-common-dir']).toString().trim();
    const path = join(common,'info','exclude'); noLinks(path,true);
    const current = existsSync(path) ? readRegular(path).toString() : '';
    if (!current.split(/\r?\n/).includes('/.local/pi-kanban/')) {
      appendFileSync(path, `${current && !current.endsWith('\n') ? '\n' : ''}/.local/pi-kanban/\n`, {mode:0o600});
      const fd = openSync(path,'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  }
  worktrees(cwd: string): Array<{path:string;branch:string|null;head:string|null}> {
    const entries = this.run(cwd,['worktree','list','--porcelain','-z']).toString().split('\0');
    const output: Array<{path:string;branch:string|null;head:string|null}> = []; let current: any;
    for (const entry of entries) {
      if (entry.startsWith('worktree ')) { current = {path:canonicalDestination(entry.slice(9)),branch:null,head:null}; output.push(current); }
      else if (entry.startsWith('branch ') && current) current.branch = entry.slice(7).replace(/^refs\/heads\//,'');
      else if (entry.startsWith('HEAD ') && current) current.head = /^0+$/.test(entry.slice(5)) ? null : entry.slice(5);
    } return output;
  }
  verifyTree(cwd: string, commit: string): void {
    this.validateOid(commit);
    const records = this.run(cwd,['ls-tree','-r','-z',commit]).toString().split('\0').filter(Boolean);
    const paths:string[]=[];
    for (const record of records) {
      const separator=record.indexOf('\t');const metadata=record.slice(0,separator);const path=record.slice(separator+1);sourcePath(path);paths.push(path);
      insist(!metadata.startsWith('120000') && !metadata.startsWith('160000'), 'UNSUPPORTED_TREE', 'Symlinks and submodules require an explicitly verified filesystem adapter.');
    }
    const currentPaths=this.invoke(cwd,['ls-files','--cached','--others','--exclude-standard','-z']).toString().split('\0').filter(Boolean);
    const combined=[...new Set([...paths,...currentPaths])];const configuration=this.config(cwd);
    this.guardActiveDrivers(cwd,configuration,combined);this.guardActiveDrivers(cwd,configuration,combined,commit);
  }
  addWorktree(cwd: string, path: string, branch: string, base: string | null): void {
    this.validateBranch(branch); noLinks(path,true); if (base) { this.validateOid(base); this.verifyTree(cwd,base); }
    this.run(cwd,base ? ['worktree','add','-b',branch,path,base] : ['worktree','add','--orphan','-b',branch,path]);
  }
  indexPath(cwd: string): string { return resolve(cwd,this.run(cwd,['rev-parse','--git-path','index']).toString().trim()); }
  formalHead(cwd: string, branch: string): string | null {
    this.validateBranch(branch); if (!this.branchExists(cwd,branch)) return null;
    return this.run(cwd,['rev-parse','--verify',`refs/heads/${branch}^{commit}`]).toString().trim();
  }
  branchExists(cwd: string, branch: string): boolean { this.validateBranch(branch); return this.run(cwd,['for-each-ref','--format=%(refname)',`refs/heads/${branch}`]).length > 0; }
  makeTree(cwd: string, head: string|null, paths: string[], indexPath: string): string {
    noLinks(indexPath,true); for (const path of paths) sourcePath(path);
    this.guard(cwd);this.guardActiveDrivers(cwd,this.config(cwd),paths);
    const env = {GIT_INDEX_FILE:indexPath}; this.run(cwd, head ? ['read-tree',head] : ['read-tree','--empty'],undefined,env);
    this.run(cwd,['add','--',...paths],undefined,env); const tree = this.run(cwd,['write-tree'],undefined,env).toString().trim();
    this.verifyTree(cwd,tree); return tree;
  }
  commitTree(cwd: string, tree: string, parent: string|null, message: string, timestamp: string, author: {name:string;email:string}): string {
    this.validateOid(tree); if (parent) this.validateOid(parent);
    insist(!/[\r\n<>\0]/.test(author.name + author.email) && author.name.length > 0 && author.email.includes('@'), 'INVALID_AUTHOR', 'Explicit commit identity is required.');
    return this.run(cwd,['commit-tree',tree,...(parent ? ['-p',parent] : [])],message+'\n',{
      GIT_AUTHOR_NAME:author.name,GIT_COMMITTER_NAME:author.name,GIT_AUTHOR_EMAIL:author.email,GIT_COMMITTER_EMAIL:author.email,
      GIT_AUTHOR_DATE:timestamp,GIT_COMMITTER_DATE:timestamp,
    }).toString().trim();
  }
  updateBranch(cwd: string, branch: string, next: string, previous: string|null): void {
    this.validateBranch(branch); this.validateOid(next); this.run(cwd,['update-ref',`refs/heads/${branch}`,next,previous ?? '0'.repeat(next.length)]);
  }
  syncIndex(cwd: string, commit: string): void { this.validateOid(commit); this.run(cwd,['read-tree',commit]); }
  commitInfo(cwd: string, commit: string): {tree:string;parents:string[]} {
    this.validateOid(commit); const lines = this.run(cwd,['show','-s','--format=%T%n%P',commit]).toString().trim().split('\n');
    return {tree:lines[0],parents:(lines[1] ?? '').split(' ').filter(Boolean)};
  }
  readFile(cwd: string, commit: string, path: string): Buffer {
    this.validateOid(commit); sourcePath(path); return this.run(cwd,['show',`${commit}:${path}`]);
  }
  mergeState(cwd:string):{mergeHead:string|null;unmergedPaths:string[]} {
    const path=resolve(cwd,this.run(cwd,['rev-parse','--git-path','MERGE_HEAD']).toString().trim());
    const mergeHead=existsSync(path)?readRegular(path,1024).toString().trim():null;
    const unmergedPaths=this.run(cwd,['diff','--ignore-submodules=all','--name-only','--diff-filter=U','-z']).toString().split('\0').filter(Boolean);
    return {mergeHead,unmergedPaths};
  }
  mergeFormal(cwd:string,source:string,message:string,timestamp:string,author:{name:string;email:string}):void {
    this.validateOid(source);this.verifyTree(cwd,source);
    const head=this.head(cwd);const configuration=this.config(cwd);
    if(head && !this.isAncestor(cwd,head,source) && [...configuration.keys()].some(key=>/^(filter\..*\.(clean|smudge|process|required)|diff\..*\.(command|textconv)|merge\..*\.driver)$/.test(key))) {
      const attributeFiles=(commit:string)=>this.invoke(cwd,['ls-tree','-r','-z',commit]).toString().split('\0').filter(record=>/(?:\t|\/)\.gitattributes$/.test(record)).sort().join('\0');
      insist(attributeFiles(head)===attributeFiles(source),'ATTRIBUTE_MERGE_UNVERIFIED','Divergent attribute-changing merges with executable drivers require a restricted adapter; no filter was bypassed or executed.');
    }
    insist(!/[\r\n<>\0]/.test(author.name+author.email) && author.name.length>0 && author.email.includes('@'),'INVALID_AUTHOR','Explicit integration identity is required.');
    this.run(cwd,['merge','--no-edit','--no-stat','-m',message,source],undefined,{
      GIT_AUTHOR_NAME:author.name,GIT_COMMITTER_NAME:author.name,GIT_AUTHOR_EMAIL:author.email,GIT_COMMITTER_EMAIL:author.email,
      GIT_AUTHOR_DATE:timestamp,GIT_COMMITTER_DATE:timestamp,
    });
  }
  commitMessage(cwd:string,commit:string):string {this.validateOid(commit);return this.run(cwd,['show','-s','--format=%B',commit]).toString().trim();}
  isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
    this.validateOid(ancestor); this.validateOid(descendant); this.guard(cwd);
    try { this.invoke(cwd,['merge-base','--is-ancestor',ancestor,descendant]); return true; } catch (e: any) {
      if (e.message.endsWith('exit 1.')) return false; throw e;
    }
  }
}
