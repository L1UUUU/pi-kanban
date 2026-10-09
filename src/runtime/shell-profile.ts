/** Exact Git Bash runtime files. A manifest root is a validation boundary, NEVER a directory ACL grant. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, parse, relative, resolve } from 'node:path';
import { RuntimeError } from './types.ts';

export interface LockedShellRuntime {
  path: string;
  version: string;
  sha256: string;
  kind: 'git-bash';
  manifest: { path: string; sha256: string };
}
export interface LockedShellManifest { rootPath: string; files: { path: string; sha256: string }[] }
export const MAX_SHELL_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_SHELL_MANIFEST_FILES = 512;
export const MAX_SHELL_RUNTIME_BYTES = 1024 * 1024 * 1024;
const MAX_SHELL_FILE_BYTES = 256 * 1024 * 1024;
const sha256 = /^[a-f0-9]{64}$/;
function fail(code: string, message: string): never { throw new RuntimeError(code, message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SHELL_MANIFEST_INVALID', 'A bounded shell manifest object is required');
  return value as Record<string, unknown>;
}
function identity(path: string): string { return path.toLowerCase(); }
function canonicalPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || value !== resolve(value)) fail('SHELL_PATH_DENIED', 'Absolute canonical shell paths are required');
  if (process.platform === 'win32' && (!/^[a-zA-Z]:[\\/]/.test(value) || value.slice(2).includes(':')))
    fail('SHELL_PATH_DENIED', 'Shell files must use local drive paths without device aliases or alternate streams');
  let cursor = resolve(value);
  for (;;) {
    if (lstatSync(cursor).isSymbolicLink()) fail('SHELL_PATH_DENIED', 'Symlink or junction in shell runtime path');
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  const path = realpathSync(value);
  if (identity(path) !== identity(resolve(value))) fail('SHELL_PATH_DENIED', 'Shell runtime path is not canonical');
  return path;
}
function strictlyInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
}
/** Checks the digest of one bounded snapshot and never follows a directory grant. */
function pinnedFile(path: string, expected: string, maxBytes: number, capture = false): Buffer {
  if (!sha256.test(expected)) fail('SHELL_MANIFEST_INVALID', 'Exact shell file SHA-256 required');
  const canonical = canonicalPath(path), before = lstatSync(canonical);
  if (!before.isFile() || before.size > maxBytes) fail('SHELL_FILE_INVALID', 'Expected a bounded regular shell runtime file');
  const fd = openSync(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.size > maxBytes)
      fail('SHELL_FILE_CHANGED', 'Shell runtime source changed before open');
    const hash = createHash('sha256'), chunks: Buffer[] = [], buffer = Buffer.alloc(Math.min(64 * 1024, opened.size + 1));
    let count = 0;
    while (count <= opened.size) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, opened.size + 1 - count), count);
      if (!read) break;
      hash.update(buffer.subarray(0, read)); if (capture) chunks.push(Buffer.from(buffer.subarray(0, read))); count += read;
    }
    const after = fstatSync(fd), finalPath = canonicalPath(path), final = lstatSync(finalPath);
    if (count !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
        identity(finalPath) !== identity(canonical) || final.dev !== opened.dev || final.ino !== opened.ino || !final.isFile())
      fail('SHELL_FILE_CHANGED', 'Shell runtime source changed while reading');
    if (hash.digest('hex') !== expected) fail('SHELL_FILE_CHANGED', 'Shell executable, manifest or dependency digest changed');
    return capture ? Buffer.concat(chunks) : Buffer.alloc(0);
  } finally { closeSync(fd); }
}
/**
 * Validate each explicitly pinned regular file before configuring or launching Git Bash.
 * Native launch must recheck/reject reparse points while holding its own file handles.
 * Never turn rootPath or any file's parent into a read/execute directory permission.
 */
export function readLockedShellManifest(shell: LockedShellRuntime): LockedShellManifest {
  const lock = object(shell), manifestLock = object(lock.manifest);
  if (lock.kind !== 'git-bash' || typeof lock.version !== 'string' || !/^v?\d+\.\d+\.\d+(?:[.-][A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(lock.version) ||
      typeof lock.path !== 'string' || typeof lock.sha256 !== 'string' || !sha256.test(lock.sha256) ||
      typeof manifestLock.path !== 'string' || typeof manifestLock.sha256 !== 'string' || !sha256.test(manifestLock.sha256))
    fail('SHELL_PROFILE_INVALID', 'Git Bash requires an exact executable version/digest and pinned manifest');
  const manifestBytes = pinnedFile(manifestLock.path, manifestLock.sha256, MAX_SHELL_MANIFEST_BYTES, true);
  let manifest: Record<string, unknown>;
  try { manifest = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes))); } catch { fail('SHELL_MANIFEST_INVALID', 'Shell manifest must be valid bounded JSON'); }
  if (manifest.schemaVersion !== 1 || Object.keys(manifest).sort().join(',') !== 'files,rootPath,schemaVersion' ||
      !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_SHELL_MANIFEST_FILES)
    fail('SHELL_MANIFEST_INVALID', 'Shell manifest requires schema version 1 and one to 512 exact files');
  const root = canonicalPath(manifest.rootPath);
  if (identity(root) === identity(parse(root).root) || !lstatSync(root).isDirectory())
    fail('SHELL_ROOT_DENIED', 'Shell manifest root must be a dedicated non-root directory');
  const executable = canonicalPath(lock.path);
  if (!strictlyInside(root, executable)) fail('SHELL_PATH_DENIED', 'Shell executable is outside the declared runtime root');
  const files: LockedShellManifest['files'] = [], seen = new Set<string>(); let executableFound = false, totalBytes = 0;
  for (const input of manifest.files) {
    const entry = object(input);
    if (Object.keys(entry).sort().join(',') !== 'path,sha256' || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string' || !sha256.test(entry.sha256))
      fail('SHELL_MANIFEST_INVALID', 'Manifest entries must be exact file paths and SHA-256 digests');
    if (seen.has(identity(resolve(entry.path)))) fail('SHELL_MANIFEST_INVALID', 'Duplicate or case-aliased shell runtime file');
    const path = canonicalPath(entry.path), key = identity(path);
    if (!strictlyInside(root, path)) fail('SHELL_PATH_DENIED', 'Shell runtime dependency escapes the declared root');
    if (seen.has(key)) fail('SHELL_MANIFEST_INVALID', 'Duplicate or case-aliased shell runtime file');
    if (key === identity(executable)) {
      if (entry.sha256 !== lock.sha256) fail('SHELL_FILE_CHANGED', 'Manifest shell executable digest differs from the configured lock');
      executableFound = true;
    }
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size > MAX_SHELL_FILE_BYTES) fail('SHELL_FILE_INVALID', 'Expected a bounded regular shell runtime file');
    totalBytes += stats.size;
    if (totalBytes > MAX_SHELL_RUNTIME_BYTES) fail('SHELL_MANIFEST_TOO_LARGE', 'Shell runtime files must total at most 1 GiB');
    seen.add(key); files.push({ path, sha256: entry.sha256 });
  }
  if (!executableFound) fail('SHELL_MANIFEST_INCOMPLETE', 'The exact locked shell executable must be listed in its manifest');
  // Preflight the whole manifest size before hashing any potentially large dependency.
  for (const file of files) pinnedFile(file.path, file.sha256, MAX_SHELL_FILE_BYTES);
  return { rootPath: root, files };
}
