import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledImplementationMethod, bundledPlanningMethod, emptyConfiguration, inspectConfiguration, loadMethods, parseConfiguration } from '../src/host/configuration.ts';
import { IMPLEMENTATION_SKILL_ADAPTER, implementationBundleDigest, implementationManifestMaterial, resolveImplementationBundle } from '../src/agent/implementation-skills.ts';

const vendorRoot = realpathSync.native(fileURLToPath(new URL('../vendor/mattpocock-skills', import.meta.url)));
function configured() {
  const config = emptyConfiguration();
  config.methods.implementation = bundledImplementationMethod(vendorRoot);
  config.methods.review = bundledImplementationMethod(vendorRoot);
  return config;
}

test('implementation and Review explicitly select the same pinned implement-spec root with a separate graph', () => {
  const config = configured(), source = config.methods.implementation!, parsed = parseConfiguration(config), loaded = loadMethods(parsed);
  assert.equal(source.logicalName, 'implement-spec'); assert.equal(source.adapter, IMPLEMENTATION_SKILL_ADAPTER);
  assert.equal(source.path, join(vendorRoot, 'skills/engineering/implement-spec/SKILL.md'));
  assert.equal(source.dependencies.length, 13); assert.equal(source.executionBundle!.resources.length, 14);
  assert.equal('skillBundle' in source, false); assert.equal(parsed.methods.planning, null);
  for (const stage of ['implementation', 'review'] as const) {
    assert.equal(loaded.summaries.find(summary => summary.stage === stage)!.status, 'configured');
    assert.equal(loaded.materials[stage].length, 15);
    const snapshot = loaded.methods[stage]!, manifest = implementationManifestMaterial(source.id, source.executionBundle!);
    assert.equal(snapshot.digest, implementationBundleDigest(source.id, source.version, source.executionBundle!));
    assert.ok(snapshot.dependencies!.includes(`${manifest.id}@${manifest.sha256}`));
    assert.deepEqual(resolveImplementationBundle(snapshot, loaded.materials[stage]).manifest, source.executionBundle);
  }
  assert.deepEqual(loaded.methods.implementation, loaded.methods.review);
  assert.notEqual(loaded.materials.implementation[0], loaded.materials.review[0], 'stage materials remain independent objects');
  const original = loaded.methods.implementation!.digest;
  config.methods.implementation!.dependencies.reverse();
  assert.equal(loadMethods(config).methods.implementation!.digest, original);
  const summary = inspectConfiguration(config);
  assert.equal(summary.executionEnabled, false); assert.equal(summary.provider.status, 'missing');
  assert.equal(summary.runtime.status, 'missing'); assert.match(summary.blockers.join(' '), /separate trusted user decision/);
});

test('execution configuration rejects stage, adapter, root, graph and digest substitutions', () => {
  const config = configured(), source = config.methods.implementation!;
  assert.throws(() => parseConfiguration({ ...config, methods: { ...config.methods, planning: { ...source, logicalName: 'design-feature' } } }), /implementation and Review|Staged implementation/);
  for (const change of [
    { adapter: 'explicit-text-v1' }, { logicalName: 'tdd' }, { executionBundle: undefined },
    { executionBundle: { ...source.executionBundle, entryId: source.dependencies[0].id } },
    { executionBundle: { ...source.executionBundle, overrides: { ...source.executionBundle!.overrides, invocation: 'automatic-global' } } },
    { sha256: 'a'.repeat(64) }, { id: 'wrong-root' }, { dependencies: source.dependencies.slice(1) },
    { executionBundle: { ...source.executionBundle, resources: source.executionBundle!.resources.map((resource, index) => index ? resource : { ...resource, sha256: 'a'.repeat(64) }) } },
  ]) assert.throws(() => parseConfiguration({ ...config, methods: { ...config.methods, implementation: { ...source, ...change } } }));
  const { executionBundle: omitted, ...withoutBundle } = source;
  assert.throws(() => parseConfiguration({ ...config, methods: { ...config.methods, implementation: withoutBundle } }), { code: 'IMPLEMENTATION_METHOD_REQUIRED' });
  assert.throws(() => parseConfiguration({ ...config, methods: { ...config.methods, implementation: { ...source, skillBundle: source.executionBundle } } }), /planning adapter/);
  assert.throws(() => bundledImplementationMethod('relative/vendor'), { code: 'UNSAFE_CONFIGURATION_PATH' });
});

test('generated execution manifest identity cannot be supplied by another stage', () => {
  const config = configured(), source = config.methods.implementation!;
  config.methods.planning = { id: `${source.id}:skill-bundle`, path: join(vendorRoot, 'LICENSE'), sha256: source.dependencies.find(dependency => dependency.path === join(vendorRoot, 'LICENSE'))!.sha256, logicalName: 'design-feature', version: 'fixture', adapter: 'explicit-text-v1', dependencies: [] };
  assert.throws(() => parseConfiguration(config), /generated execution manifest identity/);
});

test('a changed pinned execution file blocks both selected phases without partial materials or text fallback', t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pi-execution-config-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const copy = join(root, 'vendor'); cpSync(vendorRoot, copy, { recursive: true });
  const config = emptyConfiguration(); config.methods.implementation = bundledImplementationMethod(copy); config.methods.review = bundledImplementationMethod(copy);
  const changed = config.methods.implementation!.dependencies.find(dependency => dependency.path === join(copy, 'skills', 'engineering', 'tdd', 'SKILL.md'));
  assert.ok(changed, 'The pinned TDD dependency is present under the selected vendor root.');
  writeFileSync(changed.path, `${readFileSync(changed.path, 'utf8')}\nChanged fixture bytes.\n`);
  const loaded = loadMethods(config);
  for (const stage of ['implementation', 'review'] as const) {
    assert.equal(loaded.methods[stage], undefined); assert.deepEqual(loaded.materials[stage], []);
    assert.match(loaded.summaries.find(summary => summary.stage === stage)!.blockers.join(' '), /DIGEST_MISMATCH/);
  }
});

test('execution selection preserves the planning graph and external private entry exactly', t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pi-external-planning-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const content = '---\nname: design-feature\ndescription: Synthetic external planning fixture\ndisable-model-invocation: true\n---\nSynthetic private planning entry remains external.\n', path = join(root, 'private-design-feature.md'); writeFileSync(path, content);
  const planning = bundledPlanningMethod({ id: 'external-private-design-feature', path, sha256: createHash('sha256').update(content).digest('hex') }, vendorRoot);
  const before = structuredClone(planning), config = configured(); config.methods.planning = planning;
  const parsed = parseConfiguration(config), loaded = loadMethods(config);
  assert.deepEqual(parsed.methods.planning, before); assert.equal('executionBundle' in parsed.methods.planning!, false);
  assert.equal(parsed.methods.planning!.path, path); assert.equal(loaded.blockers.length, 0);
  assert.equal(loaded.materials.planning.find(material => material.id === planning.id)!.content, content);
  assert.ok(!loaded.materials.implementation.some(material => material.id === planning.id));
  assert.ok(!loaded.materials.review.some(material => material.id === planning.id));
});
