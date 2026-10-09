import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { HostApplication } from '../src/host/application.ts';

const git = process.platform === 'win32' ? execFileSync('where.exe', ['git.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0] : existsSync('/usr/bin/git') ? '/usr/bin/git' : '/usr/local/bin/git';
test('desktop artifact reads resolve immutable same-demand bytes in bounded pages, never supplied filesystem paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-artifact-host-')), repo = join(root, 'repo'); mkdirSync(repo);
  execFileSync(git, ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  const saved = process.env.PI_KANBAN_GIT; process.env.PI_KANBAN_GIT = git;
  const app = new HostApplication();
  try {
    const p = app.handle('createProject', { rootPath: repo, formalTarget: 'main', baseline: null }).projects[0];
    const d = app.workflow.createDemand({ projectId: p.id, title: 'Synthetic plan reader', description: '' });
    const other = app.workflow.createDemand({ projectId: p.id, title: 'Other synthetic demand', description: '' });
    const body = 'Exact immutable plan.\n' + '方案正文'.repeat(6000);
    const ref = app.production.evidence.save({ id: 'plan-one', projectId: p.id, demandId: d.id, runId: 'synthetic-run', kind: 'plan', text: body });
    let offset: number | null = 0, collected = '';
    while (offset !== null) {
      const page = app.readArtifact({ demandId: d.id, artifactId: ref.id, digest: ref.digest, offset, path: join(root, 'never-read') });
      assert.ok(page.text.length <= 16_384); assert.equal(page.digest, ref.digest); assert.equal(page.totalCharacters, body.length);
      collected += page.text; offset = page.nextOffset;
    }
    assert.equal(collected, body);
    assert.throws(() => app.readArtifact({ demandId: other.id, artifactId: ref.id, digest: ref.digest }), /not registered/);
    assert.throws(() => app.readArtifact({ demandId: d.id, artifactId: ref.id, digest: 'f'.repeat(64) }), /exact immutable/);
    assert.throws(() => app.readArtifact({ demandId: d.id, artifactId: ref.id, digest: ref.digest, offset: -1 }), /offset/);
    const path = app.production.evidence.objects(p.id).objectPath({ sha256: ref.digest, bytes: Buffer.byteLength(body) });
    writeFileSync(path, 'tampered body');
    assert.throws(() => app.readArtifact({ demandId: d.id, artifactId: ref.id, digest: ref.digest }), /corrupt/);
  } finally { app.close(); if (saved === undefined) delete process.env.PI_KANBAN_GIT; else process.env.PI_KANBAN_GIT = saved; rmSync(root, { recursive: true, force: true }); }
});
