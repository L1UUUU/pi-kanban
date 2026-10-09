import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)));
const db = new DatabaseSync(':memory:');
let git = null;
try { git = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(); } catch { /* Explicitly unknown. */ }
const output = {
  recordedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, osRelease: os.release(),
  node: { version: process.version, sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') },
  sqlite: db.prepare('SELECT sqlite_version() AS version').get().version, git,
  dependencies: Object.fromEntries(['@earendil-works/pi-coding-agent', 'electron', 'react', 'typescript', 'esbuild'].map(name => [name, { version: lock.packages[`node_modules/${name}`]?.version ?? null, integrity: lock.packages[`node_modules/${name}`]?.integrity ?? null }])),
  executionEnabled: false,
  gates: { G1: 'blocked-native-isolation-verification', G2: 'partial-rule-tests-only', G3: 'blocked-real-methods-and-model-authorization', G4: 'blocked-real-remote-and-reuse-validation', G5: 'blocked-full-acceptance' },
};
db.close();
console.log(JSON.stringify(output, null, 2));
