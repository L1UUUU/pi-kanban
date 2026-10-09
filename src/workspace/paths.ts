import { lstatSync, realpathSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, fstatSync, readSync, constants, statSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, basename, join, parse, sep } from 'node:path';

export class WorkspaceError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = 'WorkspaceError'; this.code = code; }
}
export function insist(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new WorkspaceError(code, message);
}
export function id(value: string): string {
  insist(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value), 'INVALID_ID', 'A bounded identifier is required.');
  return value;
}
/** Rejects symlinks/junctions in every existing component, including ancestors. */
export function noLinks(path: string, allowMissing = false): string {
  const absolute = resolve(path); const root = parse(absolute).root;
  let cursor = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    try { insist(!lstatSync(cursor).isSymbolicLink(), 'UNSAFE_PATH', 'Symbolic links and junctions are not supported.'); }
    catch (error: any) { if (allowMissing && error.code === 'ENOENT') return absolute; throw error; }
  }
  return absolute;
}
export function canonicalDirectory(path: string): string {
  const checked = noLinks(path);
  insist(lstatSync(checked).isDirectory(), 'INVALID_PATH', 'Expected a directory.');
  return realpathSync.native(checked);
}
/** Canonicalize an existing destination or its nearest existing parent without following links. */
export function canonicalDestination(path:string):string {
  const absolute=noLinks(path,true);let cursor=absolute;const missing:string[]=[];
  while(!existsSync(cursor)){missing.unshift(basename(cursor));const parent=dirname(cursor);insist(parent!==cursor,'INVALID_PATH','No existing filesystem root for destination.');cursor=parent;}
  return join(canonicalDirectory(cursor),...missing);
}
/** Existing directories are equal only when no-link-checked filesystem identities agree. */
export function sameDirectory(left:string,right:string):boolean {
  noLinks(left,true);noLinks(right,true);if(!existsSync(left) || !existsSync(right))return false;
  const a=canonicalDirectory(left),b=canonicalDirectory(right);
  const first=statSync(a,{bigint:true}),second=statSync(b,{bigint:true});
  if(first.ino!==0n && second.ino!==0n)return first.dev===second.dev && first.ino===second.ino;
  // Fail closed on platforms without file IDs. Do not blindly case-fold existing names.
  return a===b;
}
/** Same operation path, including stable aliases of an existing directory. */
export function sameDestination(left:string,right:string):boolean {
  if(existsSync(left) && existsSync(right))return sameDirectory(left,right);
  return canonicalDestination(left)===canonicalDestination(right);
}
/** Reservations conservatively collide on Windows spelling variants even before creation. */
export function destinationsCollide(left:string,right:string):boolean {
  if(existsSync(left) && existsSync(right))return sameDirectory(left,right);
  const a=canonicalDestination(left),b=canonicalDestination(right);return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
}
export function within(root: string, path: string): string {
  const target = resolve(root, path); const rel = relative(root, target);
  insist(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'PATH_ESCAPE', 'Path escapes the owned directory.');
  return target;
}
/** Conservative portable paths: no Windows aliases, ADS, traversal, or Git magic. */
export function sourcePath(path: string): string {
  insist(typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.includes('\\') && !path.includes('\0') && !isAbsolute(path), 'INVALID_PATH', 'Expected a portable relative path.');
  for (const part of path.split('/')) {
    insist(part !== '' && part !== '.' && part !== '..' && !/[<>:"|?*\x00-\x1f]/.test(part) && !/[ .]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part), 'INVALID_PATH', 'Unsafe path component.');
  }
  insist(!path.split('/').some(p => p.toLowerCase() === '.git'), 'PRIVATE_PATH', 'Git administration is not delivery content.');
  insist(!/^\.local(?:\/|$)/i.test(path), 'PRIVATE_PATH', 'Local personal materials cannot enter Git; formal-document exceptions require explicit project support.');
  return path;
}
export function secureMkdir(path: string): void {
  noLinks(path, true); mkdirSync(path, {recursive:true, mode:0o700}); noLinks(path);
}
export function readRegular(path: string, maxBytes = 16 * 1024 * 1024): Buffer {
  noLinks(path); const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat=fstatSync(fd); insist(stat.isFile(),'INVALID_FILE','Expected a regular file, not a device, pipe, or directory.');
    insist(stat.size<=maxBytes,'CONTENT_TOO_LARGE','Object exceeds the configured limit.');
    const chunks:Buffer[]=[];let total=0;
    while(true) {
      const chunk=Buffer.alloc(Math.min(64*1024,maxBytes-total+1));const count=readSync(fd,chunk,0,chunk.length,null);
      if(!count)break;total+=count;insist(total<=maxBytes,'CONTENT_TOO_LARGE','Object grew beyond the configured limit.');chunks.push(chunk.subarray(0,count));
    }
    return Buffer.concat(chunks,total);
  } finally { closeSync(fd); }
}
export function syncDirectory(path: string): void {
  // Windows does not support POSIX directory fsync. That durability variant remains unverified.
  if (process.platform === 'win32') return;
  const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function ensureParent(path: string): void { secureMkdir(dirname(path)); }
