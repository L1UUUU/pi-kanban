import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, openSync, ftruncateSync, closeSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { readLockedShellManifest, MAX_SHELL_MANIFEST_BYTES, MAX_SHELL_MANIFEST_FILES, MAX_SHELL_RUNTIME_BYTES } from '../src/runtime/shell-profile.ts';
import type { LockedShellRuntime } from '../src/runtime/shell-profile.ts';

// Synthetic local bytes exercise manifest validation only. No Git Bash binary,
// Windows containment, real shell command, native process or network is exercised.
const hash = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
function fixture(t: test.TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'synthetic-shell-manifest-'))), runtime = join(root, 'runtime'), bin = join(runtime, 'usr', 'bin');
  mkdirSync(bin, { recursive: true }); t.after(() => rmSync(root, { recursive: true, force: true }));
  const bash = join(bin, 'bash.exe'), dll = join(bin, 'msys-2.0.dll'), manifestPath = join(root, 'manifest.json');
  writeFileSync(bash, 'SYNTHETIC BASH'); writeFileSync(dll, 'SYNTHETIC DLL');
  const files = [{ path: bash, sha256: hash('SYNTHETIC BASH') }, { path: dll, sha256: hash('SYNTHETIC DLL') }];
  let shell: LockedShellRuntime = { path: bash, sha256: files[0]!.sha256, version: '2.47.0.windows.1', kind: 'git-bash', manifest: { path: manifestPath, sha256: '' } };
  const save = (value: unknown) => { const body = JSON.stringify(value); writeFileSync(manifestPath, body); shell = { ...shell, manifest: { path: manifestPath, sha256: hash(body) } }; return shell; };
  save({ schemaVersion: 1, rootPath: runtime, files });
  return { root, runtime, bin, bash, dll, manifestPath, files, get shell() { return shell; }, save };
}
test('exact Git Bash manifest validates only listed files and returns no directory permission', t => {
  const f = fixture(t); const manifest = readLockedShellManifest(f.shell);
  assert.equal(manifest.rootPath, f.runtime); assert.deepEqual(manifest.files, f.files);
  assert.equal(manifest.files.some(file => file.path === f.runtime || file.path === f.bin), false);
  writeFileSync(join(f.bin, 'unlisted-secret'), 'SYNTHETIC UNLISTED');
  assert.equal(readLockedShellManifest(f.shell).files.length, 2, 'The root is not recursively expanded or authorized.');
});
test('shell executable, manifest and each dependency are independently hash pinned', t => {
  const f = fixture(t);
  assert.throws(() => readLockedShellManifest({ ...f.shell, sha256: 'a'.repeat(64) }), { code: 'SHELL_FILE_CHANGED' });
  writeFileSync(f.dll, 'SYNTHETIC CHANGED');
  assert.throws(() => readLockedShellManifest(f.shell), { code: 'SHELL_FILE_CHANGED' });
  writeFileSync(f.dll, 'SYNTHETIC DLL'); writeFileSync(f.bash, 'SYNTHETIC CHANGED');
  assert.throws(() => readLockedShellManifest(f.shell), { code: 'SHELL_FILE_CHANGED' });
  writeFileSync(f.bash, 'SYNTHETIC BASH'); writeFileSync(f.manifestPath, '{}');
  assert.throws(() => readLockedShellManifest(f.shell), { code: 'SHELL_FILE_CHANGED' });
});
test('shell runtime cannot omit its exact executable from an otherwise valid manifest', t => {
  const f = fixture(t); f.save({ schemaVersion: 1, rootPath: f.runtime, files: [f.files[1]] });
  assert.throws(() => readLockedShellManifest(f.shell), { code: 'SHELL_MANIFEST_INCOMPLETE' });
});
test('manifest root is dedicated and every executable/dependency must remain strictly inside it', t => {
  const f = fixture(t), outside = join(f.root, 'outside.dll'); writeFileSync(outside, 'SYNTHETIC OUTSIDE');
  f.save({ schemaVersion: 1, rootPath: f.runtime, files: [...f.files, { path: outside, sha256: hash('SYNTHETIC OUTSIDE') }] });
  assert.throws(() => readLockedShellManifest(f.shell), { code: 'SHELL_PATH_DENIED' });
  f.save({ schemaVersion: 1, rootPath: parse(f.root).root, files: f.files });
  assert.throws(() => readLockedShellManifest(f.shell), { code: 'SHELL_ROOT_DENIED' });
  const other = join(f.root, 'other'); mkdirSync(other); f.save({ schemaVersion: 1, rootPath: other, files: f.files });
  assert.throws(() => readLockedShellManifest(f.shell), { code: 'SHELL_PATH_DENIED' });
});
test('manifest duplicate paths and Windows case aliases are rejected even on Linux', t => {
  const f = fixture(t);
  for (const duplicate of [f.files[0], { ...f.files[0]!, path: f.bash.toUpperCase() }]) {
    f.save({ schemaVersion: 1, rootPath: f.runtime, files: [...f.files, duplicate] });
    assert.throws(() => readLockedShellManifest(f.shell), { code: 'SHELL_MANIFEST_INVALID' });
  }
});
test('manifest cannot authorize directories or use relative artifact paths', t => {
  const f = fixture(t);
  f.save({ schemaVersion: 1, rootPath: f.runtime, files: [...f.files, { path: f.bin, sha256: 'a'.repeat(64) }] });
  assert.throws(() => readLockedShellManifest(f.shell), { code: 'SHELL_FILE_INVALID' });
  f.save({ schemaVersion: 1, rootPath: f.runtime, files: [{ path: 'usr/bin/bash.exe', sha256: f.shell.sha256 }] });
  assert.throws(() => readLockedShellManifest(f.shell), { code: 'SHELL_PATH_DENIED' });
  f.save({ schemaVersion: 1, rootPath: 'runtime', files: f.files });
  assert.throws(() => readLockedShellManifest(f.shell), { code: 'SHELL_PATH_DENIED' });
});
test('manifest schema, entry shape, file count and byte limits are bounded', t => {
  const f = fixture(t), valid = { schemaVersion: 1, rootPath: f.runtime, files: f.files };
  for (const value of [{ ...valid, schemaVersion: 2 }, { ...valid, grants: ['root'] }, { ...valid, files: [] }, { ...valid, files: Array(MAX_SHELL_MANIFEST_FILES + 1).fill(f.files[0]) }, { ...valid, files: [{ ...f.files[0], recursive: true }] }]) {
    f.save(value); assert.throws(() => readLockedShellManifest(f.shell), { code: 'SHELL_MANIFEST_INVALID' });
  }
  const oversized = ' '.repeat(MAX_SHELL_MANIFEST_BYTES + 1); writeFileSync(f.manifestPath, oversized);
  assert.throws(() => readLockedShellManifest({ ...f.shell, manifest: { path: f.manifestPath, sha256: hash(oversized) } }), { code: 'SHELL_FILE_INVALID' });
  writeFileSync(f.manifestPath, '{');
  assert.throws(() => readLockedShellManifest({ ...f.shell, manifest: { path: f.manifestPath, sha256: hash('{') } }), { code: 'SHELL_MANIFEST_INVALID' });
});
test('shell kind, exact version and both lock hashes are mandatory', t => {
  const f = fixture(t);
  for (const value of [{ ...f.shell, kind: 'cmd' }, { ...f.shell, version: '^2.47.0' }, { ...f.shell, sha256: '' }, { ...f.shell, manifest: { ...f.shell.manifest, sha256: '' } }])
    assert.throws(() => readLockedShellManifest(value as LockedShellRuntime), { code: 'SHELL_PROFILE_INVALID' });
});
test('symlinked files, manifest and directory components cannot expand shell access', { skip: process.platform === 'win32' ? 'Symlink creation requires optional Windows privileges.' : false }, t => {
  const f = fixture(t), alias = join(f.bin, 'alias.dll'); symlinkSync(f.dll, alias);
  f.save({ schemaVersion: 1, rootPath: f.runtime, files: [...f.files, { path: alias, sha256: f.files[1]!.sha256 }] });
  assert.throws(() => readLockedShellManifest(f.shell), { code: 'SHELL_PATH_DENIED' });
  f.save({ schemaVersion: 1, rootPath: f.runtime, files: f.files });
  const manifestAlias = join(f.root, 'alias-manifest.json'); symlinkSync(f.manifestPath, manifestAlias);
  assert.throws(() => readLockedShellManifest({ ...f.shell, manifest: { ...f.shell.manifest, path: manifestAlias } }), { code: 'SHELL_PATH_DENIED' });
  const rootAlias = join(f.root, 'runtime-alias'); symlinkSync(f.runtime, rootAlias);
  f.save({ schemaVersion: 1, rootPath: rootAlias, files: f.files });
  assert.throws(() => readLockedShellManifest(f.shell), { code: 'SHELL_PATH_DENIED' });
});


test('total shell runtime is capped before hashing oversized dependency sets', t => {
  const f = fixture(t), extra: { path: string; sha256: string }[] = [];
  for (let index = 0; index < 4; index++) {
    const path = join(f.bin, `sparse-${index}.dll`), fd = openSync(path, 'w');
    try { ftruncateSync(fd, MAX_SHELL_RUNTIME_BYTES / 4); } finally { closeSync(fd); }
    extra.push({ path, sha256: 'a'.repeat(64) });
  }
  f.save({ schemaVersion: 1, rootPath: f.runtime, files: [...f.files, ...extra] });
  // The placeholder digest must never be reached: a complete size preflight rejects
  // this sparse 1 GiB-plus manifest before spending time reading its large files.
  assert.throws(() => readLockedShellManifest(f.shell), { code: 'SHELL_MANIFEST_TOO_LARGE' });
});
