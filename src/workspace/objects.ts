import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, writeFileSync, linkSync, unlinkSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalDirectory, id, insist, noLinks, readRegular, secureMkdir, syncDirectory } from './paths.ts';

export interface ObjectRef { sha256: string; bytes: number }
export function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
export function canonicalJson(value: unknown): string {
  const normalized=(input:any):any=>{
    if(Array.isArray(input))return input.map(normalized);
    if(input && typeof input==='object')return Object.fromEntries(Object.keys(input).sort().filter(key=>input[key]!==undefined).map(key=>[key,normalized(input[key])]));
    return input;
  };
  return JSON.stringify(normalized(value));
}

/** Immutable, host-owned content. SQL stores references, never a second mutable body. */
export class ImmutableObjectStore {
  readonly root: string; readonly projectId: string;
  private anchor: string; private identity: string;
  private constructor(anchor: string, projectId: string, identity: string) {
    this.anchor = anchor; this.projectId = projectId; this.root = join(anchor, '.local', 'pi-kanban'); this.identity = identity;
  }
  static open(anchorPath: string, projectId: string): ImmutableObjectStore {
    id(projectId); const anchor = canonicalDirectory(anchorPath); const root = join(anchor, '.local', 'pi-kanban');
    const existed=existsSync(root);secureMkdir(root); const manifestPath = join(root, 'manifest.json');
    insist(!existed || existsSync(manifestPath) || readdirSync(root).length===0,'UNOWNED_STORE','An existing nonempty materials directory has no verified ownership manifest.');
    if (!existsSync(manifestPath)) {
      // Exclusive install refuses a concurrent or pre-existing owner; it never overwrites.
      const body = JSON.stringify({version:1, projectId, anchorIdentity:randomUUID()});
      const fd = openSync(manifestPath, 'wx', 0o600); try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
      syncDirectory(root);
    }
    const manifest = JSON.parse(readRegular(manifestPath).toString());
    insist(manifest.version === 1 && manifest.projectId === projectId && typeof manifest.anchorIdentity === 'string', 'PROJECT_IDENTITY', 'Project material anchor belongs to another project or is damaged.');
    secureMkdir(join(root, 'objects')); secureMkdir(join(root, 'pending'));
    return new ImmutableObjectStore(anchor, projectId, manifest.anchorIdentity);
  }
  private checkAnchor(): void {
    insist(canonicalDirectory(this.anchor) === this.anchor, 'ANCHOR_UNAVAILABLE', 'Project anchor moved or is unavailable.');
    const manifest = JSON.parse(readRegular(join(this.root, 'manifest.json')).toString());
    insist(manifest.projectId === this.projectId && manifest.anchorIdentity === this.identity, 'PROJECT_IDENTITY', 'Project anchor was replaced.');
  }
  objectPath(ref: ObjectRef): string {
    insist(/^[a-f0-9]{64}$/.test(ref.sha256) && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0, 'INVALID_OBJECT', 'Invalid content reference.');
    return join(this.root, 'objects', ref.sha256);
  }
  put(value: string | Buffer): ObjectRef {
    this.checkAnchor(); const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    insist(bytes.length <= 16 * 1024 * 1024, 'CONTENT_TOO_LARGE', 'Object exceeds 16 MiB.');
    const ref = {sha256:digest(bytes), bytes:bytes.length}; const target = this.objectPath(ref);
    if (existsSync(target)) { this.verify(ref); return ref; }
    const pending = join(this.root, 'pending', randomUUID()); noLinks(pending, true);
    const fd = openSync(pending, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    insist(digest(readRegular(pending)) === ref.sha256, 'CONTENT_CORRUPT', 'Pending object verification failed.');
    // Atomic no-replace publication on the same volume. link avoids rename replacing an existing immutable object.
    try { noLinks(target, true); linkSync(pending, target); syncDirectory(join(this.root, 'objects')); }
    catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    this.verify(ref); unlinkSync(pending); syncDirectory(join(this.root, 'pending')); return ref;
  }
  read(ref: ObjectRef): Buffer {
    this.checkAnchor(); const target = this.objectPath(ref); noLinks(target);
    insist(lstatSync(target).isFile(), 'INVALID_OBJECT', 'Content object is not a regular file.');
    const data = readRegular(target);
    insist(data.length === ref.bytes && digest(data) === ref.sha256, 'CONTENT_CORRUPT', 'Immutable content is missing or corrupt; no replacement was selected.');
    return data;
  }
  verify(ref: ObjectRef): boolean { this.read(ref); return true; }
}
