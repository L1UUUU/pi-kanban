import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { ConfigurationStore, CONFIGURATION_FILENAME, MAX_METHOD_BYTES, configurationDigest, createModelGrant, emptyConfiguration, inspectConfiguration, loadMethods, parseConfiguration, runtimeProfileInput } from '../src/host/configuration.ts';
import type { FileReference, MethodSourceConfiguration, ProviderConfiguration, RuntimeConfiguration, ShellConfiguration, WorkbenchConfiguration } from '../src/host/configuration.ts';
import { MAX_SHELL_MANIFEST_BYTES } from '../src/runtime/shell-profile.ts';

function fixture(t: any) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pi-config-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = (id: string, content = `Synthetic method fixture: ${id}\n`): FileReference => {
    const path = join(root, `${id}.txt`); writeFileSync(path, content);
    return { id, path, sha256: createHash('sha256').update(content).digest('hex') };
  };
  const method = (stage: string): MethodSourceConfiguration => ({ ...file(stage), logicalName: stage === 'planning' ? 'design-feature' : `${stage}-candidate`, version: '1.0.0', adapter: 'explicit-text-v1', dependencies: [file(`${stage}-dependency`)] });
  const configuration = emptyConfiguration();
  configuration.methods = { planning: method('planning'), implementation: method('implementation'), review: method('review') };
  return { root, file, configuration, store: new ConfigurationStore(join(root, 'owned')) };
}
function provider(): ProviderConfiguration {
  return { provider: 'synthetic', modelId: 'fixture-v1', destination: 'https://synthetic.invalid/v1/messages', credentialRef: 'env:PI_KANBAN_TEST_CREDENTIAL', contextPolicy: 'exact-materials-only',
    data: [{ id: 'synthetic-material', sha256: 'a'.repeat(64) }], allowedRoles: ['planning', 'boundary-review', 'implementation', 'review'],
    limits: { maxRequests: 4, maxTokens: 400, maxCostMicros: 4000, currency: 'USD', expiresAt: new Date(Date.now() + 600_000).toISOString(), meteringPolicy: 'synthetic-v1' } };
}
function runtime(file: (id: string) => FileReference): RuntimeConfiguration {
  return { profileId: 'windows-synthetic-fixture', osBuild: '10.0.26100', arch: 'x64',
    node: { ...file('node'), version: '24.19.0' }, helper: { ...file('helper'), version: '1.0.0' }, worker: { ...file('worker'), version: '1.0.0' },
    pi: { ...file('pi'), version: '1.1.0', package: '@earendil-works/pi-coding-agent' }, policySha256: 'b'.repeat(64),
    evidence: { privateChannel: file('private-channel'), filesystem: file('filesystem'), processTree: file('process-tree'), network: file('network') } };
}
function shellFixture(t: any) {
  const result = fixture(t), rootPath = join(result.root, 'git-install'), bin = join(rootPath, 'usr', 'bin');
  mkdirSync(bin, { recursive: true });
  const lock = (name: string, content: string) => {
    const path = join(bin, name); writeFileSync(path, content);
    return { path, sha256: createHash('sha256').update(content).digest('hex') };
  };
  const executable = lock('bash.exe', 'Synthetic Git Bash executable; inspection must never execute this file.'), dependency = lock('msys-2.0.dll', 'Synthetic MSYS dependency.');
  const manifest = { schemaVersion: 1, rootPath, files: [executable, dependency] };
  const shell: ShellConfiguration = { ...executable, id: 'git-bash', version: '5.2.37', kind: 'git-bash', manifest: result.file('shell-manifest', JSON.stringify(manifest)) };
  result.configuration.runtime = { ...runtime(result.file), shell };
  const writeManifest = (value: unknown) => {
    const content = JSON.stringify(value); writeFileSync(shell.manifest.path, content);
    shell.manifest.sha256 = createHash('sha256').update(content).digest('hex');
  };
  return { ...result, rootPath, shell, executable, dependency, manifest, writeManifest };
}

test('an absent configuration reports actual missing planning/provider/runtime and never guesses defaults', t => {
  const { store } = fixture(t), empty = store.load(), summary = store.inspect();
  assert.deepEqual(empty, emptyConfiguration());
  assert.equal(summary.sourceStatus, 'missing'); assert.equal(summary.planningMethodMissing, true);
  assert.equal(summary.configuration.provider, null); assert.equal(summary.configuration.runtime, null);
  assert.equal(summary.executionEnabled, false); assert.match(summary.blockers.join(' '), /actual user-supplied design-feature/);
  assert.equal(existsSync(store.directory), false, 'inspection must not create config files');
});

test('strict versioned schema rejects unknown/authorizing/secret fields and malformed values', t => {
  const { configuration } = fixture(t);
  for (const change of [{ schemaVersion: 2 }, { authorized: true }, { executionEnabled: true }, { verified: true }, { apiKey: 'SECRET-SENTINEL' }, { revision: Infinity }, { revision: -1 }, { revision: 1.5 }]) {
    assert.throws(() => parseConfiguration({ ...configuration, ...change }));
  }
  assert.throws(() => parseConfiguration({ ...configuration, methods: {} }), /incomplete/);
  assert.throws(() => parseConfiguration({ ...configuration, methods: { ...configuration.methods, other: null } }), /unsupported/);
  assert.throws(() => parseConfiguration({ ...configuration, methods: { ...configuration.methods, planning: { ...configuration.methods.planning, logicalName: 'invented-planner' } } }), { code: 'PLANNING_METHOD_REQUIRED' });
  assert.throws(() => parseConfiguration({ ...configuration, methods: { ...configuration.methods, implementation: { ...configuration.methods.implementation, dependencies: undefined } } }));
});

test('explicit methods produce exact immutable material and dependency-inclusive snapshots', t => {
  const { configuration } = fixture(t), loaded = loadMethods(configuration);
  assert.equal(loaded.blockers.length, 0); assert.equal(loaded.summaries.length, 3);
  assert.equal(loaded.materials.planning.length, 2); assert.equal(loaded.materials.review.length, 2);
  const main = configuration.methods.planning!, dependency = main.dependencies[0];
  assert.equal(loaded.methods.planning!.id, main.id);
  assert.deepEqual(loaded.methods.planning!.dependencies, [`${dependency.id}@${dependency.sha256}`]);
  assert.equal(loaded.materials.planning[1].content, readFileSync(dependency.path, 'utf8'));
  assert.match(loaded.methods.planning!.digest, /^[a-f0-9]{64}$/);
  assert.notEqual(loaded.methods.planning!.digest, main.sha256, 'snapshot binds metadata and all declared files');
  const snapshot = loaded.methods.planning!.digest;
  writeFileSync(dependency.path, 'changed dependency');
  dependency.sha256 = createHash('sha256').update('changed dependency').digest('hex');
  assert.notEqual(loadMethods(configuration).methods.planning!.digest, snapshot);
});

test('method dependencies are complete, order-independent, and never globally discovered', t => {
  const { root, file, configuration } = fixture(t), method = configuration.methods.planning!;
  method.dependencies.push(file('second-dependency'));
  const first = loadMethods(configuration).methods.planning!.digest;
  method.dependencies.reverse();
  assert.equal(loadMethods(configuration).methods.planning!.digest, first);
  writeFileSync(join(root, 'AGENTS.md'), 'Undeclared global instructions');
  mkdirSync(join(root, '.pi')); writeFileSync(join(root, '.pi', 'settings.json'), '{"apiKey":"DO-NOT-READ"}');
  const loaded = loadMethods(configuration);
  assert.equal(loaded.methods.planning!.digest, first); assert.equal(loaded.materials.planning.length, 3);
  assert(!JSON.stringify(loaded).includes('DO-NOT-READ'));
  method.dependencies.push({ ...method.dependencies[0] });
  assert.throws(() => loadMethods(configuration), /duplicate/);
});

test('stale, missing, directory, oversize and invalid UTF-8 method files block the affected stage', t => {
  const { configuration } = fixture(t), main = configuration.methods.planning!;
  writeFileSync(main.dependencies[0].path, 'stale');
  let loaded = loadMethods(configuration);
  assert.equal(loaded.methods.planning, undefined); assert.deepEqual(loaded.materials.planning, []); assert.match(loaded.blockers.join(' '), /DIGEST_MISMATCH/);
  assert(loaded.methods.implementation);
  rmSync(main.dependencies[0].path); loaded = loadMethods(configuration); assert.match(loaded.blockers.join(' '), /ENOENT/);
  mkdirSync(main.dependencies[0].path); assert.match(loadMethods(configuration).blockers.join(' '), /FILE_REQUIRED/);
  rmSync(main.dependencies[0].path, { recursive: true }); writeFileSync(main.dependencies[0].path, Buffer.alloc(MAX_METHOD_BYTES + 1));
  assert.match(loadMethods(configuration).blockers.join(' '), /TOO_LARGE/);
  const invalid = Buffer.from([0xff, 0xfe]); writeFileSync(main.dependencies[0].path, invalid); main.dependencies[0].sha256 = createHash('sha256').update(invalid).digest('hex');
  assert.match(loadMethods(configuration).blockers.join(' '), /ENCODING_INVALID/);
});

test('methods reject final symlinks and ancestor junction/reparse aliases even when hashes match', t => {
  const { root, configuration } = fixture(t), method = configuration.methods.planning!;
  const linked = join(root, 'linked-method.txt');
  try { symlinkSync(method.path, linked, 'file'); } catch (error: any) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Creating a symbolic-link fixture requires Windows test privilege'); return; } throw error; }
  method.path = linked;
  assert.match(loadMethods(configuration).blockers.join(' '), /UNSAFE_CONFIGURATION_PATH/);
  const real = join(root, 'real'); mkdirSync(real); const material = 'Synthetic nested method'; writeFileSync(join(real, 'method.txt'), material);
  const alias = join(root, 'alias'); symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  method.path = join(alias, 'method.txt'); method.sha256 = createHash('sha256').update(material).digest('hex');
  assert.match(loadMethods(configuration).blockers.join(' '), /UNSAFE_CONFIGURATION_PATH/);
});

test('runtime pins exact binaries and evidence without accepting configuration as isolation proof', t => {
  const { file, configuration } = fixture(t); configuration.runtime = runtime(file); configuration.provider = provider();
  const summary = inspectConfiguration(configuration);
  assert.equal(summary.runtime.status, 'configured-unverified'); assert.equal(summary.provider.status, 'configured-unapproved');
  assert.equal(summary.executionEnabled, false); assert.match(summary.blockers.join(' '), /independently verified/);
  const nativeInput = runtimeProfileInput(configuration);
  assert.equal(nativeInput.node.sha256, configuration.runtime.node!.sha256); assert.equal(nativeInput.evidence.length, 4);
  assert(!('id' in nativeInput.node)); assert(!('verified' in nativeInput));
  writeFileSync(configuration.runtime.helper!.path, 'stale helper');
  assert.equal(inspectConfiguration(configuration).runtime.status, 'invalid');
  assert.throws(() => parseConfiguration({ ...configuration, runtime: { ...configuration.runtime, verified: true } }), /unsupported/);
  assert.throws(() => parseConfiguration({ ...configuration, runtime: { ...configuration.runtime, node: { ...configuration.runtime!.node, version: '>=24' } } }), /exact version/);
  assert.throws(() => parseConfiguration({ ...configuration, runtime: { ...configuration.runtime, node: { ...configuration.runtime!.node, version: '22.0.0' } } }), /Node 24/);
  configuration.runtime.node = null; assert.throws(() => runtimeProfileInput(configuration), { code: 'RUNTIME_CONFIGURATION_MISSING' });
});

test('legacy runtime documents canonicalize an absent shell to null and never discover one', t => {
  const { file, configuration } = fixture(t); configuration.runtime = runtime(file);
  const parsed = parseConfiguration(configuration);
  assert.equal(parsed.runtime!.shell, null);
  assert.equal(configurationDigest(configuration), configurationDigest({ ...configuration, runtime: { ...configuration.runtime, shell: null } }));
  assert(!Object.hasOwn(runtimeProfileInput(configuration), 'shell'));
  assert.equal(inspectConfiguration(configuration).runtime.status, 'configured-unverified');
  assert.throws(() => parseConfiguration({ ...configuration, runtime: { ...configuration.runtime, shell: undefined } }), /ordinary object/);
});

test('an omitted runtime capability policy canonicalizes to strict with no inferred fallback', t => {
  const { file, configuration } = fixture(t); configuration.runtime = runtime(file);
  assert.equal(parseConfiguration(configuration).runtime!.policyVariant, 'lpac-strict-v1');
  assert.equal(runtimeProfileInput(configuration).policyVariant, 'lpac-strict-v1');
  assert.equal(inspectConfiguration(configuration).configuration.runtime!.policyVariant, 'lpac-strict-v1');
  assert.equal(configurationDigest(configuration), configurationDigest({ ...configuration, runtime: { ...configuration.runtime, policyVariant: 'lpac-strict-v1' } }));
  for (const policyVariant of [null, undefined, '', 'automatic', 'registryRead', 'lpac-registry-read-no-network-v3', true]) {
    assert.throws(() => parseConfiguration({ ...configuration, runtime: { ...configuration.runtime, policyVariant } }), { code: 'INVALID_CONFIGURATION' });
  }
});

test('the explicit registry-read policy round-trips, changes the digest and reaches the native verifier unchanged', t => {
  const { root, file, configuration, store } = fixture(t); configuration.runtime = runtime(file);
  const strictDigest = configurationDigest(configuration);
  configuration.runtime.policyVariant = 'lpac-registry-read-no-network-v2';
  const selectedDigest = configurationDigest(configuration);
  assert.notEqual(selectedDigest, strictDigest);
  const imported = join(root, 'registry-read-config.json'); writeFileSync(imported, JSON.stringify(configuration));
  const saved = store.importFromFile(imported), loaded = store.load(), summary = store.inspect();
  assert.deepEqual(loaded, saved);
  assert.equal(loaded.runtime!.policyVariant, 'lpac-registry-read-no-network-v2');
  assert.equal(runtimeProfileInput(loaded).policyVariant, 'lpac-registry-read-no-network-v2');
  assert.equal(summary.configuration.runtime!.policyVariant, 'lpac-registry-read-no-network-v2');
  assert.equal(summary.configurationDigest, configurationDigest(loaded));
  assert.equal(summary.runtime.status, 'configured-unverified'); assert.equal(summary.executionEnabled, false);
  assert.equal(configurationDigest({ ...loaded, revision: configuration.revision }), selectedDigest);
});

test('explicit Git Bash locks its executable and a separate manifest without granting execution', t => {
  const { configuration, shell, rootPath } = shellFixture(t), summary = inspectConfiguration(configuration);
  assert.equal(summary.runtime.status, 'configured-unverified'); assert.equal(summary.executionEnabled, false);
  assert.deepEqual(summary.configuration.runtime!.shell, shell);
  const input = runtimeProfileInput(configuration);
  assert.deepEqual(input.shell, { path: shell.path, version: shell.version, sha256: shell.sha256, kind: 'git-bash', manifest: { path: shell.manifest.path, sha256: shell.manifest.sha256 } });
  assert(!('id' in input.shell!)); assert(!('id' in input.shell!.manifest));
  assert(!JSON.stringify(input).includes('rootPath'), 'directory containment metadata is not a file or directory grant');
  writeFileSync(join(rootPath, 'unlisted-secret.txt'), 'NOT-AUTHORIZED-FOR-SHELL');
  assert.equal(inspectConfiguration(configuration).runtime.status, 'configured-unverified', 'only explicitly locked artifacts are inspected');
  assert(!JSON.stringify(summary).includes('NOT-AUTHORIZED-FOR-SHELL'));
});

test('shell syntax rejects implicit discovery, version ranges, unknown kinds and authorization fields', t => {
  const { configuration, shell } = shellFixture(t);
  for (const change of [{ kind: 'cmd' }, { version: 'latest' }, { version: '>=5.2.0' }, { path: 'bash' }, { authorized: true }, { verified: true }, { token: 'SECRET-SENTINEL' }, { args: ['--login'] }, { manifest: null }, { manifest: { ...shell.manifest, allowDirectory: true } }]) {
    assert.throws(() => parseConfiguration({ ...configuration, runtime: { ...configuration.runtime, shell: { ...shell, ...change } } }));
  }
  assert.throws(() => parseConfiguration({ ...configuration, runtime: { ...configuration.runtime, shell: { ...shell, manifest: { ...shell.manifest, id: shell.id } } } }), /duplicate/);
});

test('changed executable, manifest or transitive shell artifact invalidates inspection', t => {
  const { configuration, shell, executable, dependency } = shellFixture(t);
  for (const reference of [executable, shell.manifest, dependency]) {
    const original = readFileSync(reference.path); writeFileSync(reference.path, 'Changed artifact.');
    const summary = inspectConfiguration(configuration);
    assert.equal(summary.runtime.status, 'invalid'); assert.equal(summary.executionEnabled, false);
    assert.match(summary.runtime.blockers.join(' '), /runtime\.shell:/);
    writeFileSync(reference.path, original);
    assert.equal(inspectConfiguration(configuration).runtime.status, 'configured-unverified');
  }
});

test('shell manifest cannot omit the executable, duplicate identities or escape its installation root', t => {
  const { configuration, file, manifest, executable, dependency, writeManifest } = shellFixture(t);
  const outside = file('outside-runtime-artifact');
  for (const files of [[], [dependency], [executable, executable], [executable, { ...executable, path: executable.path.toUpperCase() }], [executable, { path: outside.path, sha256: outside.sha256 }], [{ ...executable, sha256: '0'.repeat(64) }]]) {
    writeManifest({ ...manifest, files });
    assert.equal(inspectConfiguration(configuration).runtime.status, 'invalid');
  }
  writeManifest({ ...manifest, files: Array.from({ length: 513 }, () => executable) });
  assert.equal(inspectConfiguration(configuration).runtime.status, 'invalid');
  writeManifest(manifest);
  assert.equal(inspectConfiguration(configuration).runtime.status, 'configured-unverified');
});

test('shell manifest rejects malformed, oversized and nonregular input without enlarging configuration', t => {
  const { configuration, shell, manifest, writeManifest } = shellFixture(t);
  for (const content of [Buffer.from('{broken JSON'), Buffer.from([0xff, 0xfe]), Buffer.alloc(MAX_SHELL_MANIFEST_BYTES + 1, ' ')]) {
    writeFileSync(shell.manifest.path, content); shell.manifest.sha256 = createHash('sha256').update(content).digest('hex');
    assert.equal(inspectConfiguration(configuration).runtime.status, 'invalid');
  }
  writeManifest({ ...manifest, authorized: true }); assert.equal(inspectConfiguration(configuration).runtime.status, 'invalid');
  writeManifest(manifest); rmSync(shell.manifest.path); mkdirSync(shell.manifest.path);
  assert.equal(inspectConfiguration(configuration).runtime.status, 'invalid');
  assert(Buffer.byteLength(JSON.stringify(parseConfiguration(configuration))) < 128 * 1024);
});

test('shell manifest paths must be exact selections without traversal or directory aliases', t => {
  const { configuration, manifest, executable, writeManifest } = shellFixture(t);
  writeManifest({ ...manifest, rootPath: `${manifest.rootPath}${sep}.` });
  assert.equal(inspectConfiguration(configuration).runtime.status, 'invalid');
  writeManifest({ ...manifest, files: [{ ...executable, path: `${manifest.rootPath}${sep}usr${sep}bin${sep}..${sep}bin${sep}bash.exe` }] });
  assert.equal(inspectConfiguration(configuration).runtime.status, 'invalid');
});

test('invalid UTF-8 within a shell manifest cannot silently select a replacement-character filename', t => {
  const { configuration, shell, rootPath, manifest } = shellFixture(t);
  const path = join(rootPath, 'replacement-\ufffd.dll'), content = 'Synthetic replacement-character dependency.';
  writeFileSync(path, content);
  const bytes = Buffer.from(JSON.stringify({ ...manifest, files: [...manifest.files, { path, sha256: createHash('sha256').update(content).digest('hex') }] }));
  const offset = bytes.indexOf(Buffer.from('\ufffd'));
  assert(offset >= 0);
  const invalidUtf8 = Buffer.concat([bytes.subarray(0, offset), Buffer.from([0xff]), bytes.subarray(offset + 3)]);
  writeFileSync(shell.manifest.path, invalidUtf8); shell.manifest.sha256 = createHash('sha256').update(invalidUtf8).digest('hex');
  assert.equal(inspectConfiguration(configuration).runtime.status, 'invalid');
});

test('shell artifacts cannot be redirected through a linked installation directory', t => {
  const { configuration, root, rootPath, shell, manifest, writeManifest } = shellFixture(t);
  const alias = join(root, 'git-alias');
  try { symlinkSync(rootPath, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error: any) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Creating a junction fixture requires Windows test privilege'); return; } throw error; }
  shell.path = join(alias, 'usr', 'bin', 'bash.exe');
  writeManifest({ ...manifest, rootPath: alias, files: manifest.files.map(file => ({ ...file, path: join(alias, 'usr', 'bin', file.path.endsWith('bash.exe') ? 'bash.exe' : 'msys-2.0.dll') })) });
  assert.equal(inspectConfiguration(configuration).runtime.status, 'invalid');
});

test('provider configuration requires exact HTTPS endpoint, reference-only credentials, immutable data and finite bounds', t => {
  const { configuration } = fixture(t); configuration.provider = provider();
  for (const destination of ['http://synthetic.invalid/', 'https://synthetic.invalid', 'https://user:secret@synthetic.invalid/', 'https://synthetic.invalid/?key=secret', 'https://synthetic.invalid/#secret']) {
    assert.throws(() => parseConfiguration({ ...configuration, provider: { ...configuration.provider, destination } }), { code: 'DESTINATION_DENIED' });
  }
  for (const credentialRef of ['sk-REAL-SECRET', 'env:NAME=value', 'env:../NAME', 'host:secret with spaces', 'https://secrets.invalid/value']) {
    assert.throws(() => parseConfiguration({ ...configuration, provider: { ...configuration.provider, credentialRef } }), { code: 'CREDENTIAL_REFERENCE_REQUIRED' });
  }
  for (const key of ['apiKey', 'token', 'headers', 'authorized', 'authorization', 'decisionId']) {
    assert.throws(() => parseConfiguration({ ...configuration, provider: { ...configuration.provider, [key]: 'SECRET-SENTINEL' } }), /unsupported/);
  }
  for (const field of ['maxRequests', 'maxTokens', 'maxCostMicros']) for (const value of [null, 0, -1, Infinity, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseConfiguration({ ...configuration, provider: { ...configuration.provider, limits: { ...configuration.provider!.limits, [field]: value } } }), { code: 'FINITE_BUDGET_REQUIRED' });
  }
  const incomplete = structuredClone(configuration); incomplete.provider!.limits = null; incomplete.provider!.credentialRef = null; incomplete.provider!.data = []; incomplete.provider!.allowedRoles = [];
  assert.equal(inspectConfiguration(incomplete).provider.status, 'incomplete');
  assert.throws(() => createModelGrant(incomplete, { id: 'grant', demandId: 'demand', decisionId: 'decision' }, () => {}), { code: 'MODEL_CONFIGURATION_INCOMPLETE' });
  configuration.provider.limits!.expiresAt = '2000-01-01T00:00:00.000Z';
  assert.match(inspectConfiguration(configuration).provider.blockers.join(' '), /expired/);
});

test('a configured provider cannot self-grant; trusted decision receives an immutable exact candidate', t => {
  const { configuration } = fixture(t); configuration.provider = provider();
  const decision = { id: 'grant', demandId: 'demand', decisionId: 'trusted-user-decision' };
  assert.throws(() => createModelGrant(configuration, decision, undefined as any), { code: 'MODEL_AUTHORIZATION_MISSING' });
  assert.throws(() => createModelGrant(configuration, decision, () => { throw new Error('User has not approved'); }), /not approved/);
  let calls = 0;
  const grant = createModelGrant(configuration, decision, candidate => {
    calls++; assert.equal(candidate.decisionId, decision.decisionId);
    assert.equal(candidate.destination, configuration.provider!.destination); assert.equal(candidate.maxCostMicros, 4000);
    assert(Object.isFrozen(candidate)); assert(Object.isFrozen(candidate.data)); assert(Object.isFrozen(candidate.data[0]));
    assert.throws(() => { (candidate.data[0] as any).sha256 = 'forged'; });
  });
  assert.throws(() => createModelGrant(configuration, decision, async () => { throw new Error('Not authorized'); }), { code: 'MODEL_AUTHORIZATION_MISSING' });
  assert.throws(() => createModelGrant(configuration, decision, () => false), { code: 'MODEL_AUTHORIZATION_MISSING' });
  assert.equal(calls, 1); assert.deepEqual(grant.data, configuration.provider.data);
  assert.equal(grant.credentialRef, 'env:PI_KANBAN_TEST_CREDENTIAL');
  assert.equal(grant.contextPolicy, 'exact-materials-only');
  grant.data[0].id = 'changed-copy'; assert.equal(configuration.provider.data[0].id, 'synthetic-material');
});

test('configuration persists atomically, round-trips, rejects stale saves, and leaves invalid saves untouched', t => {
  const { root, configuration, store } = fixture(t); configuration.provider = provider();
  const saved = store.save(configuration); assert.equal(saved.revision, 1); assert.deepEqual(store.load(), saved);
  assert.equal(store.inspect().sourceStatus, 'configured'); assert.equal(store.inspect().configurationDigest, configurationDigest(saved));
  const bytes = readFileSync(store.path);
  assert.throws(() => store.save(configuration), { code: 'CONFIGURATION_REVISION_CONFLICT' });
  assert.throws(() => store.save({ ...saved, apiKey: 'SECRET-SENTINEL' }), /unsupported/);
  assert.deepEqual(readFileSync(store.path), bytes); assert.deepEqual(readdirSync(store.directory), [CONFIGURATION_FILENAME]);
  assert(!bytes.includes('SECRET-SENTINEL'));
  if (process.platform !== 'win32') assert.equal(lstatSync(store.path).mode & 0o777, 0o600);
  const imported = join(root, 'settings-import.json'); writeFileSync(imported, JSON.stringify({ ...configuration, revision: 37 }));
  assert.equal(store.importFromFile(imported).revision, 2, 'source revision never overwrites app-owned revision history');
  assert.equal(new ConfigurationStore(store.directory).load().revision, 2);
});

test('invalid persisted configuration is visibly blocked, not silently accepted or overwritten', t => {
  const { store, configuration } = fixture(t); store.save(configuration); writeFileSync(store.path, '{"schemaVersion":999}');
  assert.throws(() => store.load()); const summary = store.inspect();
  assert.equal(summary.sourceStatus, 'invalid'); assert.equal(summary.executionEnabled, false); assert.equal(summary.planningMethodMissing, true);
  assert.match(summary.blockers[0], /INVALID_CONFIGURATION/);
  assert.throws(() => store.save(configuration)); assert.equal(readFileSync(store.path, 'utf8'), '{"schemaVersion":999}');
});

test('app-owned settings cannot be redirected through symlink/junction directories or target files', t => {
  const { root, configuration, store } = fixture(t); store.save(configuration);
  const external = join(root, 'external.json'); writeFileSync(external, 'KEEP-EXTERNAL'); rmSync(store.path);
  try { symlinkSync(external, store.path, 'file'); } catch (error: any) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Creating symbolic-link fixture requires Windows test privilege'); return; } throw error; }
  assert.throws(() => store.save(configuration), { code: 'UNSAFE_CONFIGURATION_PATH' }); assert.equal(readFileSync(external, 'utf8'), 'KEEP-EXTERNAL');
  const directoryAlias = join(root, 'owned-alias'); symlinkSync(store.directory, directoryAlias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new ConfigurationStore(directoryAlias), { code: 'UNSAFE_CONFIGURATION_PATH' });
});


test('run-derived context scope must be explicit, displayed and independently authorized', t => {
  const { configuration } = fixture(t); configuration.provider = provider();
  const decision = { id: 'grant', demandId: 'demand', decisionId: 'trusted-decision' };
  configuration.provider.contextPolicy = null;
  assert.equal(inspectConfiguration(configuration).provider.status, 'incomplete');
  assert.throws(() => createModelGrant(configuration, decision, () => {}), { code: 'MODEL_CONFIGURATION_INCOMPLETE' });
  assert.throws(() => parseConfiguration({ ...configuration, provider: { ...configuration.provider, contextPolicy: 'all-data' } }));
  configuration.provider.contextPolicy = 'approved-run-derived-v1';
  let observed: string | undefined;
  const grant = createModelGrant(configuration, decision, candidate => { observed = candidate.contextPolicy; });
  assert.equal(observed, 'approved-run-derived-v1'); assert.equal(grant.contextPolicy, observed);
  assert.equal(inspectConfiguration(configuration).configuration.provider!.contextPolicy, observed);
  assert.equal(inspectConfiguration(configuration).executionEnabled, false);
});


test('total method inputs are bounded and alias/conflicting material identities are rejected', t => {
  const { file, configuration } = fixture(t);
  const text = 'x'.repeat(MAX_METHOD_BYTES);
  for (const stage of ['planning', 'implementation', 'review'] as const) {
    const method = configuration.methods[stage]!;
    writeFileSync(method.path, text); method.sha256 = createHash('sha256').update(text).digest('hex');
    method.dependencies = [file(`${stage}-large-a`, text), file(`${stage}-large-b`, text)];
  }
  const loaded = loadMethods(configuration);
  assert.equal(loaded.summaries[2].status, 'invalid'); assert.match(loaded.blockers.join(' '), /total method material bound/);
  assert.equal(loaded.materials.review.length, 0);
  configuration.methods.review!.dependencies[0].id = configuration.methods.planning!.id;
  assert.throws(() => parseConfiguration(configuration), /different files or revisions/);
});
