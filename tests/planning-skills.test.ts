import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSkillsForPrompt, SessionManager } from '@earendil-works/pi-coding-agent';
import { createBrokeredPiSession } from '../src/agent/brokered-pi.ts';
import { bundledPlanningMethod, emptyConfiguration, loadMethods, parseConfiguration } from '../src/host/configuration.ts';
import { createPlanningSkillSession, parsePlanningSkillManifest, planningResourcePath, projectPlanningSkillBundle, resolvePlanningBundle, PINNED_PLANNING_FILES, PINNED_PLANNING_COMMIT, PLANNING_SKILL_STAGES } from '../src/agent/planning-skills.ts';
import { explicitResourceLoader } from '../src/agent/resources.ts';

const vendor = resolve(dirname(fileURLToPath(import.meta.url)), '../vendor/mattpocock-skills');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const entryText = '---\nname: design-feature\ndescription: Synthetic staged planning fixture\ndisable-model-invocation: true\n---\nPRIVATE-ENTRY-BODY-FIXTURE\n';
function fixture(t: any, copied = false) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'planning-skills-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'private-entry.md'); writeFileSync(path, entryText);
  const vendorRoot = copied ? join(root, 'vendor') : vendor; if (copied) cpSync(vendor, vendorRoot, { recursive: true });
  const configuration = emptyConfiguration(); configuration.methods.planning = bundledPlanningMethod({ id: 'selected-design-feature', path, sha256: hash(entryText) }, vendorRoot);
  const loaded = loadMethods(configuration); assert.equal(loaded.summaries[0].status, 'configured', loaded.summaries[0].blockers.join('\n'));
  const snapshot = loaded.methods.planning!, materials = loaded.materials.planning, bundle = resolvePlanningBundle(snapshot, materials);
  return { root, vendorRoot, configuration, snapshot, materials, bundle };
}

test('all original vendored resources match exact upstream SHA-256, Git blob and byte size', () => {
  const provenance = JSON.parse(readFileSync(join(vendor, 'provenance.json'), 'utf8'));
  assert.equal(provenance.commit, PINNED_PLANNING_COMMIT); assert.deepEqual(provenance.files, PINNED_PLANNING_FILES); assert.equal(provenance.files.length, 12);
  for (const file of PINNED_PLANNING_FILES) {
    const bytes = readFileSync(join(vendor, file.path));
    assert.equal(bytes.length, file.bytes, file.path); assert.equal(hash(bytes), file.sha256, file.path);
    assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), file.gitBlob, file.path);
  }
});

test('configuration freezes the complete pinned graph while private source stays external', t => {
  const f = fixture(t);
  assert.equal(f.materials.length, 14); assert.equal(f.snapshot.dependencies?.length, 13);
  assert(f.snapshot.dependencies?.some(id => id.startsWith('selected-design-feature:skill-bundle@')));
  const manifest = f.materials.find(material => material.id.endsWith(':skill-bundle'))!;
  assert.throws(() => explicitResourceLoader('planning', f.materials), /active-stage skill adapter/);
  assert.doesNotMatch(manifest.content, /PRIVATE-ENTRY-BODY/);
  assert.doesNotMatch(manifest.content, new RegExp(f.root));
  const reversed = structuredClone(f.configuration); reversed.methods.planning!.dependencies.reverse(); reversed.methods.planning!.skillBundle!.resources.reverse();
  assert.deepEqual(loadMethods(reversed).methods.planning, f.snapshot);
  writeFileSync(f.configuration.methods.planning!.path, 'LOCAL-DISK-DRIFT');
  assert.equal(loadMethods(f.configuration).summaries[0].status, 'invalid');
  assert.deepEqual(resolvePlanningBundle(f.snapshot, f.materials), f.bundle, 'frozen runs do not reread current source');
  assert.throws(() => resolvePlanningBundle({ ...f.snapshot, digest: '0'.repeat(64) }, f.materials), /frozen method digest/);
  assert.throws(() => resolvePlanningBundle(f.snapshot, f.materials.slice(1)), /closure|missing/i);
  assert.throws(() => resolvePlanningBundle(f.snapshot, [...f.materials, f.materials[0]!]), /Duplicate/);
  const changed = structuredClone(f.materials); changed[0]!.content += 'tampered';
  assert.throws(() => resolvePlanningBundle(f.snapshot, changed), /changed/);
});

test('each stage advertises only its actual Pi Skill metadata and releases no method bodies in initial context', t => {
  const { bundle, materials } = fixture(t);
  for (const stage of PLANNING_SKILL_STAGES) {
    const projection = projectPlanningSkillBundle(bundle, stage), session = createPlanningSkillSession(projection);
    assert.equal(session.stage, stage); assert.deepEqual(session.initialMaterials, []); assert.equal(session.skills.length, 1);
    const data = { id: 'generated-artifact', kind: 'plan' as const, content: 'UNTRUSTED-ARTIFACT-CANNOT-BECOME-SYSTEM-INSTRUCTIONS', sha256: hash('UNTRUSTED-ARTIFACT-CANNOT-BECOME-SYSTEM-INSTRUCTIONS') };
    const loader = explicitResourceLoader(stage === 'design-review' ? 'boundary-review' : 'planning', [...materials, data], { planningSkills: session });
    assert.equal(loader.getSkills().skills[0]!.name, projection.active.name);
    assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
    const prompt = loader.getSystemPrompt()!;
    assert.doesNotMatch(prompt, /PRIVATE-ENTRY-BODY|UNTRUSTED-ARTIFACT|Interview the user relentlessly|# Codebase Design|<spec-template>|<local-ticket-template>/);
    assert.match(prompt, /controlled_skill/); assert.match(prompt, /Scoped project adapter overrides/);
    assert.throws(() => loader.extendResources({ skillPaths: [] }), { code: 'RESOURCE_DISCOVERY_DENIED' });
    const exposed = loader.getSkills().skills; exposed[0]!.name = 'mutated'; assert.equal(loader.getSkills().skills[0]!.name, projection.active.name);
    for (const other of bundle.manifest.skills.filter(skill => skill.name !== projection.active.name)) {
      assert.equal(JSON.stringify(projection).includes(bundle.materials.find(resource => resource.id === other.entryId)!.content), false);
    }
  }
});

test('original invocation restrictions remain intact; explicit adapter permits only Host-selected stage', async t => {
  const { bundle } = fixture(t);
  for (const stage of ['spec', 'tickets'] as const) {
    const session = createPlanningSkillSession(projectPlanningSkillBundle(bundle, stage));
    assert.equal(session.skills[0]!.disableModelInvocation, true);
    assert.equal(formatSkillsForPrompt(session.skills), '');
    assert.match((await session.readSkill(session.activeSkill.skillName)).content, /disable-model-invocation: true/);
    await assert.rejects(session.readSkill(stage === 'spec' ? 'to-tickets' : 'to-spec'), /Host-selected/);
  }
  assert.equal(createPlanningSkillSession(projectPlanningSkillBundle(bundle, 'design')).skills[0]!.disableModelInvocation, false);
});

test('primary and relative resource reads require a successful audit before releasing exact bytes', async t => {
  const { bundle } = fixture(t), projection = projectPlanningSkillBundle(bundle, 'design');
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }); const reads: any[] = [];
  const session = createPlanningSkillSession(projection, { onRead: async ref => { reads.push(ref); await pending; } });
  let resolved = false; const first = session.readSkill('codebase-design').then(result => { resolved = true; return result; });
  await Promise.resolve(); assert.equal(resolved, false); assert.equal(session.hasLoadedPrimary(), false); assert.equal(reads.length, 1);
  release(); const body = await first; assert.equal(body.content, projection.active.entry.content); assert(session.hasLoadedPrimary());
  assert.deepEqual(reads[0], session.activeSkill);
  const deepening = await session.readReference(body.path, './DEEPENING.md');
  assert.equal(deepening.content, readFileSync(join(vendor, deepening.path), 'utf8'));
  assert.equal((await session.readReference(deepening.path, 'SKILL.md')).sha256, body.sha256);
  assert.equal((await session.readReference(body.path, 'DESIGN-IT-TWICE.md')).content, readFileSync(join(vendor, 'skills/engineering/codebase-design/DESIGN-IT-TWICE.md'), 'utf8'));
  const failed = createPlanningSkillSession(projection, { onRead: async () => { throw new Error('HOST-AUDIT-DENIED'); } });
  await assert.rejects(failed.readSkill('codebase-design'), /HOST-AUDIT-DENIED/); assert.equal(failed.hasLoadedPrimary(), false);
  await assert.rejects(failed.readReference(body.path, 'DEEPENING.md'), /before following/);
});

test('controlled tools cannot resolve undeclared, remote, escaping, cross-stage or unpinned resources', async t => {
  const { bundle } = fixture(t), projection = projectPlanningSkillBundle(bundle, 'design'), session = createPlanningSkillSession(projection);
  const body = await session.readSkill('codebase-design');
  for (const path of ['../../to-spec/SKILL.md', '../to-spec/SKILL.md', '../../../LICENSE', '/etc/passwd', '//server/file', 'https://example.com/DEEPENING.md', 'file:///tmp/x', 'C:/Windows/file', 'C:\\Windows\\file', 'DEEPENING.md:stream', '%2e%2e/secret', 'DEEPENING.md?x=1', 'DEEPENING.md#heading', 'missing.md', 'agents/openai.yaml']) {
    await assert.rejects(session.readReference(body.path, path), { code: 'PLANNING_RESOURCE_INVALID' }, path);
  }
  await assert.rejects(session.readReference('skills/engineering/to-spec/SKILL.md', 'SKILL.md'), /before following/);
  for (const path of ['a/../b', './a', 'a//b', '/a', 'https://remote.invalid/a', 'a\\b', 'a%2fb', 'a/b.']) assert.throws(() => planningResourcePath(path));
  const leaked = structuredClone(projection); leaked.active.references.push(projectPlanningSkillBundle(bundle, 'spec').active.entry);
  assert.throws(() => createPlanningSkillSession(leaked), /only to the active skill/);
  const wrongStage = structuredClone(projection); wrongStage.stage = 'tickets'; assert.throws(() => createPlanningSkillSession(wrongStage), /another stage/);
  const changed = structuredClone(projection); changed.active.entry.content += '\nchanged'; changed.active.entry.sha256 = hash(changed.active.entry.content);
  assert.throws(() => createPlanningSkillSession(changed), /pinned upstream/);
  const missing = structuredClone(projection); missing.active.references.pop(); assert.throws(() => createPlanningSkillSession(missing), /Missing explicitly pinned/);
  const duplicate = structuredClone(projection); duplicate.active.references.push(duplicate.active.references[0]!); assert.throws(() => createPlanningSkillSession(duplicate), /Duplicate/);
});

test('manifest rejects duplicate identities, missing policy/license, remote paths, unpinned digests and changed overrides', t => {
  const { bundle } = fixture(t), graph = bundle.manifest;
  const bad = (mutate: (value: typeof graph) => void) => { const value = structuredClone(graph); mutate(value); assert.throws(() => parsePlanningSkillManifest(value), { code: 'PLANNING_RESOURCE_INVALID' }); };
  bad(g => { g.skills[0]!.name = g.skills[1]!.name; });
  bad(g => { g.resources.push(g.resources[0]!); });
  bad(g => { g.resources[0]!.sha256 = 'latest'; });
  bad(g => { g.resources[0]!.path = 'https://example.com/SKILL.md'; });
  bad(g => { g.resources[0]!.sha256 = 'a'.repeat(64); });
  bad(g => { g.resources = g.resources.filter(r => r.path !== 'LICENSE'); g.supportingIds = g.supportingIds.filter(id => !id.endsWith('/LICENSE')); });
  bad(g => { g.skills[0]!.policyId = g.skills[1]!.policyId; });
  bad(g => { (g.overrides as any).invocation = 'all-skills'; });
  bad(g => { (g as any).discoverAncestors = true; });
});

test('configured pinned dependencies fail closed on source drift, missing bytes, graph mismatch and reserved identity', t => {
  const f = fixture(t, true), method = f.configuration.methods.planning!;
  const path = join(f.vendorRoot, 'skills/engineering/to-spec/SKILL.md'); writeFileSync(path, 'TAMPERED-UPSTREAM');
  assert.match(loadMethods(f.configuration).summaries[0].blockers.join('\n'), /DIGEST_MISMATCH/);
  rmSync(path); assert.match(loadMethods(f.configuration).summaries[0].blockers.join('\n'), /ENOENT/);
  const mismatch = structuredClone(f.configuration); mismatch.methods.planning!.dependencies[0]!.sha256 = 'f'.repeat(64); assert.throws(() => parseConfiguration(mismatch), /exactly once/);
  const removed = structuredClone(f.configuration); delete removed.methods.planning!.skillBundle; assert.throws(() => parseConfiguration(removed), /explicit digest-locked/);
  const crossStage = structuredClone(f.configuration); crossStage.methods.implementation = { id: `${method.id}:skill-bundle`, path: method.path, sha256: method.sha256, logicalName: 'implementation', adapter: 'explicit-text-v1', version: '1.0.0', dependencies: [] };
  assert.throws(() => parseConfiguration(crossStage), /generated planning manifest identity/);
  const unexpected = structuredClone(f.configuration); unexpected.methods.planning!.adapter = 'explicit-text-v1'; assert.throws(() => parseConfiguration(unexpected), /Only the explicit/);
  const collision = structuredClone(f.configuration); const oldId = collision.methods.planning!.dependencies[0]!.id;
  const newId = `${method.id}:skill-bundle`; collision.methods.planning!.dependencies[0]!.id = newId;
  const graph = collision.methods.planning!.skillBundle!; graph.resources.find(r => r.id === oldId)!.id = newId;
  graph.supportingIds = graph.supportingIds.map(id => id === oldId ? newId : id);
  for (const skill of graph.skills) { if (skill.entryId === oldId) skill.entryId = newId; if (skill.policyId === oldId) skill.policyId = newId; skill.referenceIds = skill.referenceIds.map(id => id === oldId ? newId : id); }
  assert.throws(() => parseConfiguration(collision), /reserved/);
});

test('actual installed Pi uses active metadata and progressively loads only audited skill/reference bodies', async t => {
  const { root, bundle, materials } = fixture(t), cwd = join(root, 'workspace'), agentDir = join(root, 'private-agent'); mkdirSync(cwd); mkdirSync(agentDir);
  writeFileSync(join(root, 'AGENTS.md'), 'FORBIDDEN-ANCESTOR'); writeFileSync(join(agentDir, 'AGENTS.md'), 'FORBIDDEN-GLOBAL');
  mkdirSync(join(agentDir, 'extensions')); writeFileSync(join(agentDir, 'extensions', 'trap.ts'), 'throw new Error("FORBIDDEN-EXTENSION")');
  const projection = projectPlanningSkillBundle(bundle, 'design'), reads: string[] = [], observed: string[] = [];
  const planningSkills = createPlanningSkillSession(projection, { onRead: async ref => { reads.push(ref.path); } });
  const runtime = await createBrokeredPiSession({ cwd, agentDir, role: 'planning', materials, planningSkills, tools: planningSkills.tools, sessionManager: SessionManager.inMemory(cwd),
    model: { provider: 'synthetic-planning-resource-test', id: 'no-provider', contextWindow: 32768, maxTokens: 512 },
    compaction: { enabled: false, reserveTokens: 512, keepRecentTokens: 512 }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    channel: { async complete(context) {
      observed.push(JSON.stringify(context));
      if (observed.length === 1) return { text: '', toolCalls: [{ id: 'load-primary', name: 'controlled_skill', arguments: { name: 'codebase-design' } }] };
      if (observed.length === 2) return { text: '', toolCalls: [{ id: 'read-reference', name: 'controlled_skill_resource', arguments: { from: projection.active.entry.path, path: 'DEEPENING.md' } }] };
      return { text: 'Synthetic planning result.' };
    } },
  });
  try {
    assert.equal(runtime.session.resourceLoader.getSkills().skills[0]!.name, 'codebase-design');
    assert.deepEqual(runtime.session.getActiveToolNames().sort(), ['controlled_skill', 'controlled_skill_resource']);
    await runtime.session.prompt('Apply this explicitly selected planning stage.');
    assert.equal(observed.length, 3); assert.equal(reads.length, 2); assert(planningSkills.hasLoadedPrimary());
    assert.doesNotMatch(observed[0]!, /# Codebase Design|How to deepen a cluster/);
    assert.match(observed[1]!, /# Codebase Design/); assert.doesNotMatch(observed[1]!, /How to deepen a cluster/);
    assert.match(observed[2]!, /How to deepen a cluster/);
    for (const context of observed) assert.doesNotMatch(context, /PRIVATE-ENTRY-BODY|FORBIDDEN|<spec-template>|<local-ticket-template>|Interview the user relentlessly/);
  } finally { runtime.dispose(); }
});
