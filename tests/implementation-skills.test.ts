import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSkillsForPrompt, SessionManager } from '@earendil-works/pi-coding-agent';
import { createBrokeredPiSession } from '../src/agent/brokered-pi.ts';
import type { AgentMaterial } from '../src/agent/resources.ts';
import { explicitResourceLoader } from '../src/agent/resources.ts';
import type { MethodSnapshot } from '../src/domain/types.ts';
import { PINNED_PLANNING_FILES } from '../src/agent/planning-skill-lock.ts';
import { createBundledImplementationManifest, parseImplementationSkillManifest, implementationManifestMaterial, implementationBundleDigest, implementationResourcePath,
  resolveImplementationBundle, projectImplementationSkillBundle, createImplementationSkillSession, IMPLEMENTATION_SKILL_ADAPTER, IMPLEMENTATION_SKILL_STAGES,
  PINNED_IMPLEMENTATION_FILES, PINNED_IMPLEMENTATION_COMMIT } from '../src/agent/implementation-skills.ts';

const vendor = resolve(dirname(fileURLToPath(import.meta.url)), '../vendor/mattpocock-skills');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const root = PINNED_IMPLEMENTATION_FILES.find(file => file.path === 'skills/engineering/implement-spec/SKILL.md')!;
  const manifest = createBundledImplementationManifest({ id: 'selected-implement-spec', sha256: root.sha256 });
  const manifestMaterial = implementationManifestMaterial(manifest.entryId, manifest);
  const materials: AgentMaterial[] = [...manifest.resources.map(resource => ({ id: resource.id, sha256: resource.sha256, kind: 'method' as const, content: readFileSync(join(vendor, resource.path), 'utf8') })), manifestMaterial];
  const snapshot: MethodSnapshot = { id: manifest.entryId, version: `upstream-${PINNED_IMPLEMENTATION_COMMIT}`, adapter: IMPLEMENTATION_SKILL_ADAPTER,
    digest: implementationBundleDigest(manifest.entryId, `upstream-${PINNED_IMPLEMENTATION_COMMIT}`, manifest),
    dependencies: materials.filter(material => material.id !== manifest.entryId).map(material => `${material.id}@${material.sha256}`).sort() };
  return { snapshot, materials, bundle: resolveImplementationBundle(snapshot, materials) };
}

test('execution vendors exact pinned originals without expanding the planning closure', () => {
  const planning = JSON.parse(readFileSync(join(vendor, 'provenance.json'), 'utf8'));
  const execution = JSON.parse(readFileSync(join(vendor, 'implementation-provenance.json'), 'utf8'));
  assert.deepEqual(planning.files, PINNED_PLANNING_FILES); assert.equal(planning.files.length, 12);
  assert.equal(execution.commit, PINNED_IMPLEMENTATION_COMMIT); assert.deepEqual(execution.files, PINNED_IMPLEMENTATION_FILES); assert.equal(execution.files.length, 14);
  const union = new Map([...PINNED_PLANNING_FILES, ...PINNED_IMPLEMENTATION_FILES].map(file => [file.path, file]));
  assert.equal(union.size, 20);
  assert.equal(PINNED_IMPLEMENTATION_FILES.filter(file => !PINNED_PLANNING_FILES.some(prior => prior.path === file.path)).length, 8);
  for (const file of union.values()) {
    const bytes = readFileSync(join(vendor, file.path));
    assert.equal(bytes.length, file.bytes, file.path); assert.equal(hash(bytes), file.sha256, file.path);
    assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), file.gitBlob, file.path);
  }
});

test('frozen execution identity binds the exact canonical graph and all materials', () => {
  const { snapshot, materials, bundle } = fixture();
  assert.equal(materials.length, 15); assert.equal(snapshot.dependencies!.length, 14);
  assert.deepEqual(resolveImplementationBundle(snapshot, [...materials].reverse()), { ...bundle, materials: [...materials].reverse() });
  const reversed = structuredClone(bundle.manifest); reversed.resources.reverse(); reversed.skills.reverse(); reversed.supportingIds.reverse();
  assert.equal(implementationBundleDigest(snapshot.id, snapshot.version, reversed), snapshot.digest);
  const corrupt = (change: (input: AgentMaterial[]) => void) => { const input = structuredClone(materials); change(input); assert.throws(() => resolveImplementationBundle(snapshot, input), { code: 'IMPLEMENTATION_RESOURCE_INVALID' }); };
  corrupt(input => { input.pop(); });
  corrupt(input => { input.push(input[0]!); });
  corrupt(input => { input[0]!.content += 'changed'; });
  corrupt(input => { input[0]!.content += 'changed'; input[0]!.sha256 = hash(input[0]!.content); });
  corrupt(input => { const manifest = input.at(-1)!; manifest.content = JSON.stringify(JSON.parse(manifest.content), null, 2); manifest.sha256 = hash(manifest.content); });
  assert.throws(() => resolveImplementationBundle({ ...snapshot, digest: '0'.repeat(64) }, materials), /frozen method digest/);
  assert.throws(() => resolveImplementationBundle({ ...snapshot, dependencies: snapshot.dependencies!.slice(1) }, materials), /closure|manifest/);
  assert.throws(() => resolveImplementationBundle({ ...snapshot, dependencies: [...snapshot.dependencies!, 'unlisted@' + '0'.repeat(64)] }, materials), /closure/);
  assert.throws(() => resolveImplementationBundle({ ...snapshot, adapter: 'explicit-text-v1' }, materials), /staged adapter/);
});

test('manifest rejects changed originals, cross-skill ownership, missing license and permission expansion', () => {
  const { bundle } = fixture();
  const bad = (change: (manifest: typeof bundle.manifest) => void) => { const manifest = structuredClone(bundle.manifest); change(manifest); assert.throws(() => parseImplementationSkillManifest(manifest), { code: 'IMPLEMENTATION_RESOURCE_INVALID' }); };
  bad(m => { m.resources[0]!.sha256 = 'a'.repeat(64); });
  bad(m => { m.resources[0]!.id = 'different-id'; });
  bad(m => { m.resources[0]!.path = 'https://example.com/SKILL.md'; });
  bad(m => { m.resources.push(m.resources[0]!); });
  bad(m => { m.resources = m.resources.filter(r => r.path !== 'LICENSE'); m.supportingIds = m.supportingIds.filter(id => !id.endsWith('/LICENSE')); });
  bad(m => { m.skills[0]!.policyId = m.skills[1]!.policyId; });
  bad(m => { m.skills[0]!.referenceIds.push(m.skills[1]!.entryId); });
  bad(m => { m.skills[0]!.name = m.skills[1]!.name; });
  bad(m => { (m.overrides as any).publication = 'push'; });
  bad(m => { (m as any).discoverAncestors = true; });
});

test('every execution phase projects implement-spec plus only its selected TDD or independent review skill', () => {
  const { bundle } = fixture();
  for (const stage of IMPLEMENTATION_SKILL_STAGES) {
    const projection = projectImplementationSkillBundle(bundle, stage), session = createImplementationSkillSession(projection);
    const expected = stage === 'ticket-implementation' || stage === 'ticket-fix' ? 'tdd' : 'code-review';
    assert.deepEqual(session.skills.map(skill => skill.name), ['implement-spec', expected]);
    assert.equal(session.entrySkill.skillName, 'implement-spec'); assert.equal(session.activeSkill.skillName, expected);
    assert.deepEqual(session.initialMaterials, []); assert.equal(projection.codebaseDesign, null); assert.equal(session.hasLoadedPrimary(), false);
    assert.equal(session.skills[0]!.disableModelInvocation, true); assert.equal(formatSkillsForPrompt([session.skills[0]!]), '');
    assert.match(session.systemInstructions, /Host-single|Host owns the dependency-ready/);
    assert.match(session.systemInstructions, /fresh read-only/); assert.match(session.systemInstructions, /pushes, PR creation/);
    const unselected = bundle.manifest.skills.filter(skill => skill.name !== 'implement-spec' && skill.name !== expected);
    for (const skill of unselected) assert.equal(JSON.stringify(projection).includes(bundle.materials.find(material => material.id === skill.entryId)!.content), false);
  }
});

test('both root and active reads require successful audit before exact bytes are returned or completion is allowed', async () => {
  const projection = projectImplementationSkillBundle(fixture().bundle, 'ticket-implementation');
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }); const reads: any[] = [];
  const session = createImplementationSkillSession(projection, { onRead: async ref => { reads.push(ref); await pending; } });
  await assert.rejects(session.readSkill('tdd'), /Read implement-spec/);
  let received = false; const reading = session.readSkill('implement-spec').then(result => { received = true; return result; });
  await Promise.resolve(); assert.equal(received, false); assert.equal(session.hasLoadedPrimary(), false); assert.deepEqual(reads, [session.entrySkill]);
  release(); assert.equal((await reading).content, projection.entry.content); assert.equal(session.hasLoadedPrimary(), false);
  const active = await session.readSkill('tdd'); assert.equal(active.content, projection.active.entry.content); assert.equal(session.hasLoadedPrimary(), true);
  assert.deepEqual(reads, [session.entrySkill, session.activeSkill]);
  for (const path of ['tests.md', 'mocking.md']) assert.equal((await session.readReference(active.path, path)).content, readFileSync(join(vendor, 'skills/engineering/tdd', path), 'utf8'));
  const denied = createImplementationSkillSession(projection, { onRead: async ref => { if (ref.skillName === 'tdd') throw new Error('HOST-AUDIT-DENIED'); } });
  await denied.readSkill('implement-spec'); await assert.rejects(denied.readSkill('tdd'), /HOST-AUDIT-DENIED/); assert.equal(denied.hasLoadedPrimary(), false);
  await assert.rejects(denied.readReference(active.path, 'tests.md'), /before following/);
  session.projection.active.entry.content = 'MUTATED-EXPOSED-PROJECTION';
  assert.equal((await session.readSkill('tdd')).content, active.content, 'exposed snapshots cannot mutate retained execution bytes');
});

test('controlled tools deny cross-stage, undeclared, remote, escaping and remapped resources', async () => {
  const { bundle } = fixture(), projection = projectImplementationSkillBundle(bundle, 'ticket-fix'), session = createImplementationSkillSession(projection);
  await session.readSkill('implement-spec'); const active = await session.readSkill('tdd');
  for (const name of ['code-review', 'codebase-design', 'to-spec', 'design-feature']) await assert.rejects(session.readSkill(name), /Host-selected/);
  for (const path of ['../code-review/SKILL.md', '../../codebase-design/SKILL.md', '../../../LICENSE', '/etc/passwd', '//server/file', 'https://example.com/tests.md', 'file:///tmp/x', 'C:/Windows/file', 'C:\\Windows\\file', 'tests.md:stream', '%2e%2e/secret', 'tests.md?x=1', 'tests.md#heading', 'missing.md', 'agents/openai.yaml']) {
    await assert.rejects(session.readReference(active.path, path), { code: 'IMPLEMENTATION_RESOURCE_INVALID' }, path);
  }
  for (const path of ['a/../b', './a', 'a//b', '/a', 'https://remote.invalid/a', 'a\\b', 'a%2fb', 'a/b.']) assert.throws(() => implementationResourcePath(path));
  const bad = (change: (value: typeof projection) => void) => { const value = structuredClone(projection); change(value); assert.throws(() => createImplementationSkillSession(value), { code: 'IMPLEMENTATION_RESOURCE_INVALID' }); };
  bad(p => { p.stage = 'review-spec'; });
  bad(p => { p.active.references.push(projectImplementationSkillBundle(bundle, 'review-spec').active.entry); });
  bad(p => { p.active.references.pop(); });
  bad(p => { p.active.references.push(p.active.references[0]!); });
  bad(p => { p.active.entry.content += 'changed'; p.active.entry.sha256 = hash(p.active.entry.content); });
  bad(p => { p.entry.id = 'different-method'; });
  bad(p => { p.manifest.sha256 = 'a'.repeat(64); });
  bad(p => { (p as any).permission = 'write'; });
});

test('conditional design vocabulary requires reference-only Host selection and is never available in reviews', async () => {
  const { bundle } = fixture(), options = { codebaseDesign: { purpose: 'reference-only' as const } };
  const selected = projectImplementationSkillBundle(bundle, 'ticket-implementation', options), session = createImplementationSkillSession(selected);
  assert.deepEqual(session.skills.map(skill => skill.name), ['implement-spec', 'tdd', 'codebase-design']);
  await session.readSkill('implement-spec'); await assert.rejects(session.readSkill('codebase-design'), /active TDD/);
  await session.readSkill('tdd'); const design = await session.readSkill('codebase-design');
  assert.equal((await session.readReference(design.path, 'DEEPENING.md')).content, readFileSync(join(vendor, 'skills/engineering/codebase-design/DEEPENING.md'), 'utf8'));
  assert.deepEqual(selected.codebaseDesign?.selection, { purpose: 'reference-only' });
  assert.match(session.systemInstructions, /Consulting it requires no new user decision/);
  assert.match(session.systemInstructions, /grants no permission to change scope, behavior or test seams/);
  for (const stage of ['review-standards', 'review-spec', 'resolution-standards', 'resolution-spec'] as const) assert.throws(() => projectImplementationSkillBundle(bundle, stage, options), /Read-only review/);
  assert.throws(() => projectImplementationSkillBundle(bundle, 'ticket-fix', { codebaseDesign: { purpose: 'run-design' as any } }), /reference-only/);
  assert.throws(() => projectImplementationSkillBundle(bundle, 'ticket-fix', { codebaseDesign: { decisionId: 'legacy-decision', approved: true } as any }), /unsupported resource fields/);
  const escalated = structuredClone(selected); (escalated.codebaseDesign!.selection as any).allowScopeChange = true;
  assert.throws(() => createImplementationSkillSession(escalated), /unsupported resource fields/);
});

test('repair instructions preserve TDD while allowing only the Host-verified standards-only refactor exception', () => {
  const session = createImplementationSkillSession(projectImplementationSkillBundle(fixture().bundle, 'ticket-fix'));
  assert.match(session.systemInstructions, /Apply TDD red then green at previously approved public test seams/);
  assert.match(session.systemInstructions, /Only a Host-verified standards-only repair that preserves behavior and has no failed-check or spec obligations/);
  assert.match(session.systemInstructions, /explicit rationale, no red receipts and actual nonempty green check receipts/);
  assert.match(session.systemInstructions, /report any new scope, seam or behavior decision for explicit approval/);
});

test('standards, spec and focused resolution contexts each require fresh root and review consumption', async () => {
  const { bundle, materials } = fixture();
  const sessions = ['review-standards', 'review-spec', 'resolution-standards', 'resolution-spec'].map(stage => createImplementationSkillSession(projectImplementationSkillBundle(bundle, stage as any)));
  for (const [index, session] of sessions.entries()) {
    const loader = explicitResourceLoader('review', materials, { implementationSkills: session });
    assert.deepEqual(loader.getSkills().skills.map(skill => skill.name), ['implement-spec', 'code-review']);
    assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
    assert.doesNotMatch(loader.getSystemPrompt()!, /Two-axis review of the diff|# Test-Driven Development/);
    assert.deepEqual(session.tools.map(tool => tool.name), ['controlled_skill', 'controlled_skill_resource']);
    await session.readSkill('implement-spec'); assert.equal(session.hasLoadedPrimary(), false);
    const review = await session.readSkill('code-review'); assert.equal(session.hasLoadedPrimary(), true);
    assert.equal(review.content, readFileSync(join(vendor, 'skills/engineering/code-review/SKILL.md'), 'utf8'));
    await assert.rejects(session.readSkill('tdd'), /Host-selected/);
    for (const following of sessions.slice(index + 1)) assert.equal(following.hasLoadedPrimary(), false, 'another context cannot inherit consumption');
    const content = 'UNTRUSTED-IMPLEMENTER-SUMMARY';
    assert.throws(() => explicitResourceLoader('review', [...materials, { id: 'summary', kind: 'implementation-summary', content, sha256: hash(content) }], { implementationSkills: session }), { code: 'REVIEW_CONTEXT_DENIED' });
  }
});

test('actual Pi progressively consumes both audited originals without loading unrelated resources or source data as instructions', async t => {
  const { bundle, materials } = fixture(), root = mkdtempSync(join(tmpdir(), 'implementation-skills-'));
  t.after(() => rmSync(root, { recursive: true, force: true })); const cwd = join(root, 'workspace'), agentDir = join(root, 'private-agent'); mkdirSync(cwd); mkdirSync(agentDir);
  const projection = projectImplementationSkillBundle(bundle, 'ticket-implementation'), reads: string[] = [], observed: string[] = [];
  const implementationSkills = createImplementationSkillSession(projection, { onRead: async ref => { reads.push(ref.path); } });
  const data: AgentMaterial = { id: 'frozen-spec', kind: 'plan', content: 'UNTRUSTED-SPEC-IS-NOT-SYSTEM-INSTRUCTIONS', sha256: hash('UNTRUSTED-SPEC-IS-NOT-SYSTEM-INSTRUCTIONS') };
  const loader = explicitResourceLoader('implementation', [...materials, data], { implementationSkills });
  assert.deepEqual(loader.getAgentsFiles().agentsFiles, []); assert.doesNotMatch(loader.getSystemPrompt()!, /UNTRUSTED-SPEC/);
  assert.throws(() => loader.extendResources({ skillPaths: [] }), { code: 'RESOURCE_DISCOVERY_DENIED' });
  const runtime = await createBrokeredPiSession({ cwd, agentDir, role: 'implementation', materials: [...materials, data], implementationSkills, tools: implementationSkills.tools, sessionManager: SessionManager.inMemory(cwd),
    model: { provider: 'synthetic-execution-resource-test', id: 'no-provider', contextWindow: 32768, maxTokens: 512 },
    compaction: { enabled: false, reserveTokens: 512, keepRecentTokens: 512 }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    channel: { async complete(context) {
      observed.push(JSON.stringify(context));
      if (observed.length === 1) return { text: '', toolCalls: [{ id: 'load-root', name: 'controlled_skill', arguments: { name: 'implement-spec' } }] };
      if (observed.length === 2) return { text: '', toolCalls: [{ id: 'load-tdd', name: 'controlled_skill', arguments: { name: 'tdd' } }] };
      if (observed.length === 3) return { text: '', toolCalls: [{ id: 'read-tests', name: 'controlled_skill_resource', arguments: { from: projection.active.entry.path, path: 'tests.md' } }] };
      return { text: 'Synthetic execution result.' };
    } },
  });
  try {
    assert.deepEqual(runtime.session.getActiveToolNames().sort(), ['controlled_skill', 'controlled_skill_resource']);
    await runtime.session.prompt('Apply the explicitly selected execution stage.');
    assert.equal(observed.length, 4); assert.equal(reads.length, 3); assert.equal(implementationSkills.hasLoadedPrimary(), true);
    assert.doesNotMatch(observed[0]!, /You have been provided a spec|# Test-Driven Development|# Good and Bad Tests/);
    assert.match(observed[1]!, /You have been provided a spec/); assert.doesNotMatch(observed[1]!, /# Test-Driven Development/);
    assert.match(observed[2]!, /# Test-Driven Development/); assert.doesNotMatch(observed[2]!, /# Good and Bad Tests/);
    assert.match(observed[3]!, /# Good and Bad Tests/);
    for (const context of observed) assert.doesNotMatch(context, /UNTRUSTED-SPEC|Two-axis review of the diff|How to deepen a cluster/);
  } finally { runtime.dispose(); }
});
