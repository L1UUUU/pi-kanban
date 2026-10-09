import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ContentSnapshot, Demand } from '../src/domain/types.ts';
import { ProductionEvidence, hash } from '../src/host/evidence.ts';
import { executionEvidenceMaterials } from '../src/host/execution-evidence.ts';
import { canonicalJson, WorkspaceService } from '../src/workspace/index.ts';

// Real local Git and immutable byte storage. No model, shell-capable Worker or
// synthetic native isolation proof participates in these comparison tests.
const gitExecutable = process.env.PI_KANBAN_TEST_GIT ?? (process.platform === 'win32' ? execFileSync('where.exe', ['git.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]! : '/usr/bin/git');
function git(cwd: string, ...args: string[]): string {
  return execFileSync(gitExecutable, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } }).trim();
}
function put(root: string, path: string, body: string | Buffer): void { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); }
function fixture(t: test.TestContext, files: Record<string, string | Buffer> = {}, executablePaths: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'pi-execution-evidence-')), repo = join(root, 'repo'); mkdirSync(repo);
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid'); git(repo, 'config', 'core.autocrlf', 'false');
  for (const [path, body] of Object.entries({ 'code.txt': 'baseline\n', 'delete.txt': 'old deleted behavior\r\n', ...files })) put(repo, path, body);
  git(repo, 'add', '.');
  for (const path of executablePaths) git(repo, 'update-index', '--chmod=+x', '--', path);
  git(repo, 'commit', '-m', 'Exact fixture baseline'); const base = git(repo, 'rev-parse', 'HEAD');
  const db = new DatabaseSync(join(root, 'host.sqlite')), workspace = new WorkspaceService({ db, gitExecutable });
  workspace.bindProject({ projectId: 'project', anchorPath: repo, formalTarget: 'main' });
  const binding = workspace.prepare({ operationId: 'prepare-demand', projectId: 'project', demandId: 'demand', worktreePath: join(root, 'demand'), branch: 'demand/change', baseline: base, prepareAuthorized: true });
  const evidence = new ProductionEvidence(db, () => workspace);
  const spec = evidence.save({ id: 'spec', projectId: 'project', demandId: 'demand', runId: 'planning', kind: 'plan', text: 'The exact confirmed spec.\n' });
  const tickets = evidence.save({ id: 'tickets', projectId: 'project', demandId: 'demand', runId: 'planning', kind: 'plan', text: 'Implement local ticket one.\n' });
  const demand: Demand = {
    id: 'demand', projectId: 'project', title: 'Local fixture', description: '', revision: 1, control: 'active', phase: 'implementing', planningStarted: true,
    methodSnapshot: {}, plans: [{ id: 'plan', scope: 'local', spec, tickets, requiredChecks: [], unresolvedQuestions: [], ready: true, createdByRun: 'planning' }],
    activePlanId: 'plan', confirmedPlanId: 'plan', contents: [], checks: [], reviews: [], findings: [], results: [], acceptances: [], cycle: 1, blockedReasons: [], invalidatedContentIds: [], messages: [], createdAt: '2026-10-09T00:00:00Z',
    executionFlow: { id: 'execution', revision: 1, planId: 'plan', planningFlowId: 'planning', approvedInputDigest: 'a'.repeat(64), step: 'ticket-implementation', scope: 'ticket', ticketId: 'ticket-one',
      tickets: [{ ticketId: 'ticket-one', status: 'implementing', reviewIds: [], resolutionIds: [] }], implementations: [], checkInputIds: [], reviews: [], resolutions: [], repairHistory: [], history: [] },
  };
  const freeze = (): ContentSnapshot => {
    const content: ContentSnapshot = { id: 'content-one', planId: 'plan', code: evidence.saveSource('project', 'demand', 'implementation', 'code-one'), knowledge: [], maintenance: 'not-needed', deliveryNotes: '', createdByRun: 'implementation', cycle: 1 };
    demand.contents.push(content); demand.activeContentId = content.id; demand.executionFlow!.baseCommit = base; demand.executionFlow!.step = 'review-standards'; return content;
  };
  const baseline = (value: string | null): void => {
    const next = { ...workspace.getBinding(demand.id)!, currentBaseline: value };
    db.prepare('UPDATE workspace_bindings SET data=? WHERE demand_id=?').run(canonicalJson(next), demand.id);
    demand.executionFlow!.baseCommit = value ?? undefined;
  };
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, repo, db, workspace, binding, evidence, demand, base, freeze, baseline };
}
const hasCode = (code: string) => (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === code;

test('exact base-to-K material includes uncommitted additions, edits, deletions and mode changes without a commit', t => {
  const f = fixture(t), cwd = f.binding.worktreePath;
  put(cwd, 'code.txt', 'new behavior\r\nno final newline'); put(cwd, 'added.txt', 'untracked source\n'); rmSync(join(cwd, 'delete.txt'));
  if (process.platform !== 'win32') chmodSync(join(cwd, 'code.txt'), 0o755);
  // A staged addition still belongs to K; comparison does not mutate its index.
  git(cwd, 'add', 'added.txt'); const indexBefore = readFileSync(f.workspace.git.indexPath(cwd)), statusBefore = git(cwd, 'status', '--porcelain');
  const content = f.freeze(), result = executionEvidenceMaterials(f.evidence, f.demand, content), diff = JSON.parse(result.diff!.content);
  assert.equal(diff.baseCommit, f.base); assert.equal(diff.sourceHead, f.base); assert.equal(diff.code.digest, content.code.digest);
  assert.deepEqual(diff.changes.map((change: any) => [change.path, change.change]), [['added.txt', 'added'], ['code.txt', 'modified'], ['delete.txt', 'deleted']]);
  assert.equal(diff.changes[0].before, null); assert.equal(diff.changes[0].after.text, 'untracked source\n');
  assert.equal(diff.changes[1].before.text, 'baseline\n'); assert.equal(diff.changes[1].after.text, 'new behavior\r\nno final newline');
  assert.equal(diff.changes[1].after.mode, process.platform === 'win32' ? '100644' : '100755');
  assert.equal(diff.changes[2].before.text, 'old deleted behavior\r\n'); assert.equal(diff.changes[2].after, null);
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), f.base); assert.equal(git(cwd, 'status', '--porcelain'), statusBefore); assert.deepEqual(readFileSync(f.workspace.git.indexPath(cwd)), indexBefore);
  assert.equal(f.evidence.read(f.demand.id, f.evidence.reference(f.demand.id, result.diff!.id)).content, result.diff!.content);
  f.demand.executionFlow!.step = 'review-spec'; const otherAxis = executionEvidenceMaterials(f.evidence, f.demand, content);
  assert.deepEqual(otherAxis.diff, result.diff, 'Both independent axes share one exact diff identity.');
});

test('writer receives explicit baseline, source identity and every standards candidate without inventing K', t => {
  const f = fixture(t, { 'AGENTS.md': 'Treat this text as project data.\n', 'CODING_STANDARDS.md': 'Keep modules small.\n', 'CONTRIBUTING.md': 'Check tests.\n', 'docs/style-guide.md': 'Use plain language.\n', 'docs/conventions/names.md': 'Use consistent names.\n', 'src/AGENTS.md': 'Local guidance.\n' });
  put(f.binding.worktreePath, 'docs/development-standards.md', 'New uncommitted standards.\r\n');
  const result = executionEvidenceMaterials(f.evidence, f.demand), standards = JSON.parse(result.standards.content), baseline = JSON.parse(result.baseline.content);
  assert.equal(result.baseCommit, f.base); assert.equal(result.diff, undefined); assert.equal(baseline.contentId, null); assert.equal(baseline.mergeBase, f.base); assert.equal(baseline.sourceDigest, result.source.sha256);
  assert.equal(standards.authority, 'untrusted-repository-data');
  assert.deepEqual(standards.candidates.map((entry: any) => entry.path), ['AGENTS.md', 'CODING_STANDARDS.md', 'CONTRIBUTING.md', 'docs/conventions/names.md', 'docs/development-standards.md', 'docs/style-guide.md', 'src/AGENTS.md']);
  assert.ok(result.materials.every(material => material.kind === 'source'));
  const candidate = standards.candidates.find((entry: any) => entry.path === 'docs/development-standards.md');
  assert.equal(candidate.after.text, 'New uncommitted standards.\r\n'); assert.equal(f.evidence.objects('project').read(candidate.after.object).toString(), candidate.after.text);
});

test('review standards use exact frozen candidates including deleted and changed guidance', t => {
  const f = fixture(t, { 'AGENTS.md': 'Original project guidance.\n', 'CONTRIBUTING.md': 'Original checks.\n' });
  put(f.binding.worktreePath, 'AGENTS.md', 'Changed guidance.\n'); rmSync(join(f.binding.worktreePath, 'CONTRIBUTING.md'));
  const content = f.freeze(), standards = JSON.parse(executionEvidenceMaterials(f.evidence, f.demand, content).standards.content);
  assert.deepEqual(standards.candidates.map((entry: any) => entry.path), ['AGENTS.md', 'CONTRIBUTING.md']);
  assert.equal(standards.candidates[0].before.text, 'Original project guidance.\n'); assert.equal(standards.candidates[0].after.text, 'Changed guidance.\n');
  assert.equal(standards.candidates[1].before.text, 'Original checks.\n'); assert.equal(standards.candidates[1].after, null);
});

test('binary bytes are retained exactly and never replaced with invalid UTF-8 text', t => {
  const old = Buffer.from([0x00, 0xff, 0x10]), next = Buffer.from([0xc3, 0x28, 0xfe]), f = fixture(t, { 'asset.bin': old });
  put(f.binding.worktreePath, 'asset.bin', next); const content = f.freeze(), result = executionEvidenceMaterials(f.evidence, f.demand, content), change = JSON.parse(result.diff!.content).changes[0];
  assert.equal(change.path, 'asset.bin');
  for (const [side, bytes] of [[change.before, old], [change.after, next]] as const) {
    assert.equal(side.encoding, 'binary'); assert.equal(side.text, null); assert.equal(side.sha256, hash(bytes)); assert.equal(side.bytes, bytes.length);
    assert.deepEqual(f.evidence.objects('project').read(side.object), bytes);
  }
});

test('an executable-only change is a nonempty source comparison', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); chmodSync(join(f.binding.worktreePath, 'code.txt'), 0o755); const content = f.freeze();
  const changes = JSON.parse(executionEvidenceMaterials(f.evidence, f.demand, content).diff!.content).changes;
  assert.equal(changes.length, 1); assert.equal(changes[0].before.sha256, changes[0].after.sha256); assert.equal(changes[0].before.mode, '100644'); assert.equal(changes[0].after.mode, '100755');
});

test('a committed executable baseline remains an empty comparison when K is unchanged on every platform', t => {
  const f = fixture(t, {}, ['code.txt']);
  assert.equal(f.workspace.git.filesAt(f.binding.worktreePath, f.base).find(file => file.path === 'code.txt')!.mode, '100755');
  assert.equal(f.workspace.git.indexFiles(f.binding.worktreePath).find(file => file.path === 'code.txt')!.mode, '100755');
  assert.equal(f.evidence.source(f.demand.id).files.find(file => file.path === 'code.txt')!.executable, true);
  const content = f.freeze();
  assert.throws(() => executionEvidenceMaterials(f.evidence, f.demand, content), hasCode('EXECUTION_DIFF_EMPTY'));
});

test('Windows source uses exact Git index modes and binds index identity into K, independent of POSIX bits', t => {
  const f = fixture(t, {}, ['code.txt']), cwd = f.binding.worktreePath;
  git(cwd, 'config', 'core.filemode', 'false'); chmodSync(join(cwd, 'code.txt'), 0o644);
  // Exercise Windows metadata semantics on every test host. Git, index parsing,
  // source bytes and object storage are real; this is not native Windows proof.
  const platform = t.mock.property(process, 'platform', 'win32');
  try {
    const before = f.evidence.source(f.demand.id), content = f.freeze();
    assert.equal(before.files.find(file => file.path === 'code.txt')!.executable, true); assert.match(before.indexDigest!, /^[a-f0-9]{64}$/);
    assert.throws(() => executionEvidenceMaterials(f.evidence, f.demand, content), hasCode('EXECUTION_DIFF_EMPTY'));
    git(cwd, 'update-index', '--chmod=-x', '--', 'code.txt');
    const after = f.evidence.source(f.demand.id);
    assert.equal(after.files.find(file => file.path === 'code.txt')!.executable, false); assert.notEqual(after.indexDigest, before.indexDigest);
    assert.equal(f.evidence.stable(f.demand.id, content.code), false);
    assert.throws(() => executionEvidenceMaterials(f.evidence, f.demand, content), hasCode('CONTENT_CHANGED'));
  } finally { platform.mock.restore(); }
});

test('Windows repeated source snapshots reject an index mode change during immutable capture', t => {
  const f = fixture(t, {}, ['code.txt']), cwd = f.binding.worktreePath, original = f.workspace.git.indexFiles.bind(f.workspace.git);
  git(cwd, 'config', 'core.filemode', 'false'); let changed = false;
  f.workspace.git.indexFiles = (...args) => { const entries = original(...args); if (!changed) { changed = true; git(cwd, 'update-index', '--chmod=-x', '--', 'code.txt'); } return entries; };
  const platform = t.mock.property(process, 'platform', 'win32');
  try { assert.throws(() => f.freeze(), hasCode('CONTENT_CHANGED')); }
  finally { platform.mock.restore(); }
});

test('guarded index mode lookup rejects staged symlinks before Windows source can use their mode', t => {
  const f = fixture(t), cwd = f.binding.worktreePath, object = f.workspace.git.filesAt(cwd, f.base).find(file => file.path === 'code.txt')!.object;
  git(cwd, 'update-index', '--add', '--cacheinfo', `120000,${object},code.txt`);
  assert.throws(() => f.workspace.git.indexFiles(cwd), hasCode('UNSUPPORTED_INDEX'));
  const platform = t.mock.property(process, 'platform', 'win32');
  try { assert.throws(() => f.evidence.source(f.demand.id), hasCode('UNSUPPORTED_INDEX')); }
  finally { platform.mock.restore(); }
});

test('guarded index mode lookup rejects real unresolved merge stages', t => {
  const f = fixture(t), cwd = f.binding.worktreePath;
  put(cwd, 'code.txt', 'demand branch\n'); git(cwd, 'add', 'code.txt'); git(cwd, 'commit', '-m', 'Demand branch fixture');
  put(f.repo, 'code.txt', 'formal branch\n'); git(f.repo, 'add', 'code.txt'); git(f.repo, 'commit', '-m', 'Formal branch fixture');
  assert.throws(() => git(cwd, 'merge', '--no-edit', 'main'));
  assert.throws(() => f.workspace.git.indexFiles(cwd), hasCode('INDEX_CONFLICT'));
  const platform = t.mock.property(process, 'platform', 'win32');
  try { assert.throws(() => f.evidence.source(f.demand.id), hasCode('INDEX_CONFLICT')); }
  finally { platform.mock.restore(); }
});

test('missing, symbolic, nonexistent and nonancestor bases cannot fall back to HEAD', t => {
  const f = fixture(t); f.baseline(null); assert.throws(() => executionEvidenceMaterials(f.evidence, f.demand), hasCode('EXECUTION_BASE_MISSING'));
  f.baseline('HEAD'); assert.throws(() => executionEvidenceMaterials(f.evidence, f.demand), hasCode('INVALID_COMMIT'));
  f.baseline('f'.repeat(40)); assert.throws(() => executionEvidenceMaterials(f.evidence, f.demand), hasCode('GIT_FAILED'));
  put(f.repo, 'later.txt', 'Not part of demand ancestry.\n'); git(f.repo, 'add', 'later.txt'); git(f.repo, 'commit', '-m', 'Later formal change'); f.baseline(git(f.repo, 'rev-parse', 'HEAD'));
  assert.throws(() => executionEvidenceMaterials(f.evidence, f.demand), hasCode('EXECUTION_BASE_INVALID'));
  assert.equal(git(f.binding.worktreePath, 'rev-parse', 'HEAD'), f.base);
});

test('missing or empty spec, missing K and an empty frozen diff fail closed', t => {
  const f = fixture(t), plan = f.demand.plans[0], original = plan.spec;
  plan.spec = { ...original, id: 'unregistered-spec' }; assert.throws(() => executionEvidenceMaterials(f.evidence, f.demand), hasCode('ARTIFACT_MISSING'));
  plan.spec = f.evidence.save({ id: 'empty-spec', projectId: 'project', demandId: 'demand', runId: 'planning', kind: 'plan', text: ' \n' });
  assert.throws(() => executionEvidenceMaterials(f.evidence, f.demand), hasCode('EXECUTION_SPEC_MISSING')); plan.spec = original;
  f.demand.executionFlow!.step = 'review-spec'; assert.throws(() => executionEvidenceMaterials(f.evidence, f.demand), hasCode('EXECUTION_CONTENT_MISSING'));
  const content = f.freeze(); assert.throws(() => executionEvidenceMaterials(f.evidence, f.demand, content), hasCode('EXECUTION_DIFF_EMPTY'));
});

test('stale, foreign, invalidated and missing immutable K objects cannot substitute live source', t => {
  const f = fixture(t); put(f.binding.worktreePath, 'code.txt', 'approved change\n'); const content = f.freeze();
  assert.throws(() => executionEvidenceMaterials(f.evidence, f.demand, { ...content, createdByRun: 'foreign-run' }), hasCode('EXECUTION_CONTENT_MISSING'));
  f.demand.invalidatedContentIds.push(content.id); assert.throws(() => executionEvidenceMaterials(f.evidence, f.demand, content), hasCode('EXECUTION_CONTENT_MISSING')); f.demand.invalidatedContentIds = [];
  put(f.binding.worktreePath, 'code.txt', 'source drift\n'); assert.throws(() => executionEvidenceMaterials(f.evidence, f.demand, content), hasCode('CONTENT_CHANGED'));
  put(f.binding.worktreePath, 'code.txt', 'approved change\n');
  unlinkSync(f.evidence.objects('project').objectPath({ sha256: hash('approved change\n'), bytes: Buffer.byteLength('approved change\n') }));
  assert.throws(() => executionEvidenceMaterials(f.evidence, f.demand, content), hasCode('ENOENT'));
});

test('source drift while reading baseline blocks the complete comparison before material registration', t => {
  const f = fixture(t); put(f.binding.worktreePath, 'code.txt', 'approved change\n'); const content = f.freeze(), original = f.workspace.git.readFile.bind(f.workspace.git);
  let changed = false;
  f.workspace.git.readFile = (...args) => { const result = original(...args); if (!changed) { changed = true; put(f.binding.worktreePath, 'code.txt', 'changed during comparison\n'); } return result; };
  assert.throws(() => executionEvidenceMaterials(f.evidence, f.demand, content), hasCode('CONTENT_CHANGED'));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM host_artifacts WHERE id LIKE 'execution-%'").get()!.n, 0);
});

test('a deleted baseline credential path blocks before any baseline blob is read', t => {
  const f = fixture(t, { '.env': 'SYNTHETIC_ONLY=never_disclose\n' }); rmSync(join(f.binding.worktreePath, '.env')); const content = f.freeze();
  let reads = 0; const original = f.workspace.git.readFile.bind(f.workspace.git); f.workspace.git.readFile = (...args) => { reads++; return original(...args); };
  assert.throws(() => executionEvidenceMaterials(f.evidence, f.demand, content), hasCode('SOURCE_SENSITIVE_PATH')); assert.equal(reads, 0);
});

test('oversized text comparison or standards context rejects without silent truncation', t => {
  const f = fixture(t); put(f.binding.worktreePath, 'large-a.txt', 'a'.repeat(600_000)); put(f.binding.worktreePath, 'large-b.txt', 'b'.repeat(600_000)); const content = f.freeze();
  assert.throws(() => executionEvidenceMaterials(f.evidence, f.demand, content), hasCode('EXECUTION_EVIDENCE_TOO_LARGE'));
  const g = fixture(t, { 'CODING_STANDARDS.md': 'x'.repeat(600_000) });
  assert.throws(() => executionEvidenceMaterials(g.evidence, g.demand), hasCode('EXECUTION_EVIDENCE_TOO_LARGE'));
});
