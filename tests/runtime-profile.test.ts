import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyWindowsEvidence, requireWindowsProbeCoverage, validateWindowsEvidenceTrustAnchor, REQUIRED_WINDOWS_PROBES, REQUIRED_WINDOWS_SHELL_PROBES, WINDOWS_RECORDER_ID, MAX_WINDOWS_EVIDENCE_BYTES } from '../src/runtime/evidence-auth.ts';
import type { WindowsEvidenceReport, ExpectedWindowsEvidence, WindowsEvidenceTrustAnchor, WindowsEvidenceEnvelope } from '../src/runtime/evidence-auth.ts';
import { verifyWindowsRuntimeProfile, VerifiedRuntimeProfile, assertVerifiedProfile, loadInstalledWindowsEvidenceTrust, INSTALLED_WINDOWS_EVIDENCE_TRUST_FILE } from '../src/runtime/profile.ts';

// SYNTHETIC CRYPTOGRAPHY/VALIDATION TESTS ONLY. Keys exist only in process memory.
// Passing these tests is NOT Windows runtime/probe evidence. The fixture payload
// deliberately exercises the parser's real-report shape; its invented observations
// are never written into production evidence, trusted by the Host, or used to launch.
const keyPair = generateKeyPairSync('ed25519'), attacker = generateKeyPairSync('ed25519');
const trust: WindowsEvidenceTrustAnchor = { keyId: 'synthetic-test-key', publicKeyPem: keyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString(), recorderSha256: 'a'.repeat(64) };
const binary = (name: string) => ({ path: `C:\\Synthetic\\${name}`, version: '24.19.0', sha256: createHash('sha256').update(name).digest('hex') });
function fixture() {
  const expected: ExpectedWindowsEvidence = { evidenceId: 'synthetic-evidence', profileId: 'synthetic-profile', osBuild: '10.0.26100', arch: 'x64', node: binary('node.exe'), helper: binary('helper.exe'), worker: binary('worker.mjs'), pi: { ...binary('pi.json'), package: '@earendil-works/pi-coding-agent' }, policySha256: 'b'.repeat(64) };
  const { evidenceId, profileId, osBuild, arch, ...bindings } = structuredClone(expected);
  const report: WindowsEvidenceReport = { schemaVersion: 2, evidenceId, profileId, osBuild, arch, status: 'passed', synthetic: false, releaseAuthorized: true,
    recorder: { id: WINDOWS_RECORDER_ID, sha256: trust.recorderSha256, runId: randomUUID(), recordedAt: new Date().toISOString() }, bindings,
    probes: REQUIRED_WINDOWS_PROBES.map(id => ({ id, passed: true, observation: 'SYNTHETIC parser fixture, not an actual Windows observation.' })) };
  return { expected, report };
}
function envelope(report: unknown, key = keyPair.privateKey, domain = 'pi-kanban.windows-runtime-evidence.v1\0'): WindowsEvidenceEnvelope {
  const payload = JSON.stringify(report);
  return { schemaVersion: 1, algorithm: 'Ed25519', keyId: trust.keyId, payload, signature: sign(null, Buffer.concat([Buffer.from(domain), Buffer.from(payload)]), key).toString('base64') };
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

test('synthetic signed exact-bindings fixture authenticates but is not an executable profile', () => {
  const { report, expected } = fixture();
  const result = verifyWindowsEvidence(bytes(envelope(report)), expected, trust);
  assert.deepEqual(result, report);
  assert.throws(() => assertVerifiedProfile(result as unknown as VerifiedRuntimeProfile), { code: 'ISOLATION_UNVERIFIED' });
  assert.throws(() => assertVerifiedProfile(Object.create(VerifiedRuntimeProfile.prototype)), { code: 'ISOLATION_UNVERIFIED' });
  assert.throws(() => Reflect.construct(VerifiedRuntimeProfile, [Symbol('fake-token'), {}, []]), { code: 'ISOLATION_UNVERIFIED' });
});
test('hashes and hand-authored all-pass JSON cannot replace Host signature or independent trust', () => {
  const { report, expected } = fixture(), unsigned = bytes(report);
  assert.equal(digest(unsigned).length, 64, 'Recomputing a file hash provides no authenticity.');
  assert.throws(() => verifyWindowsEvidence(unsigned, expected, trust), { code: 'EVIDENCE_AUTHENTICATION_FAILED' });
  assert.throws(() => verifyWindowsEvidence(bytes(envelope(report)), expected), { code: 'EVIDENCE_TRUST_REQUIRED' });
  assert.throws(() => verifyWindowsEvidence(bytes(envelope(report)), expected, {} as WindowsEvidenceTrustAnchor), { code: 'EVIDENCE_TRUST_REQUIRED' });
});
test('attacker-generated key, adjacent public key and algorithm substitution all fail', () => {
  const { report, expected } = fixture();
  assert.throws(() => verifyWindowsEvidence(bytes(envelope(report, attacker.privateKey)), expected, trust), { code: 'EVIDENCE_AUTHENTICATION_FAILED' });
  const attackerEnvelope = { ...envelope(report, attacker.privateKey), publicKeyPem: attacker.publicKey.export({ format: 'pem', type: 'spki' }).toString() };
  assert.throws(() => verifyWindowsEvidence(bytes(attackerEnvelope), expected, trust), { code: 'EVIDENCE_AUTHENTICATION_FAILED' });
  for (const changed of [{ keyId: 'attacker-key' }, { algorithm: 'none' }, { schemaVersion: 2 }])
    assert.throws(() => verifyWindowsEvidence(bytes({ ...envelope(report), ...changed }), expected, trust), { code: 'EVIDENCE_AUTHENTICATION_FAILED' });
});
test('exact payload bytes, signature bytes and signature domain are authenticated', () => {
  const { report, expected } = fixture(), valid = envelope(report);
  assert.throws(() => verifyWindowsEvidence(bytes({ ...valid, payload: valid.payload + ' ' }), expected, trust), { code: 'EVIDENCE_AUTHENTICATION_FAILED' });
  assert.throws(() => verifyWindowsEvidence(bytes({ ...valid, signature: valid.signature + '\n' }), expected, trust), { code: 'EVIDENCE_AUTHENTICATION_FAILED' });
  assert.throws(() => verifyWindowsEvidence(bytes({ ...valid, signature: Buffer.alloc(64).toString('base64') }), expected, trust), { code: 'EVIDENCE_AUTHENTICATION_FAILED' });
  assert.throws(() => verifyWindowsEvidence(bytes(envelope(report, keyPair.privateKey, '')), expected, trust), { code: 'EVIDENCE_AUTHENTICATION_FAILED' });
});
test('signed diagnostics, self-attested release flags and machine/profile substitution remain blocked', () => {
  const { report, expected } = fixture();
  for (const changed of [{ releaseAuthorized: false }, { releaseAuthorized: undefined }, { synthetic: true }, { status: 'failed' }, { schemaVersion: 1 }, { profileId: 'other-profile' }, { evidenceId: 'other-evidence' }, { osBuild: '10.0.22000' }, { arch: 'arm64' }])
    assert.throws(() => verifyWindowsEvidence(bytes(envelope({ ...report, ...changed })), expected, trust), { code: 'EVIDENCE_INAPPLICABLE' });
});
test('every artifact path, version, hash, Pi identity and policy must match exactly', () => {
  const { report, expected } = fixture();
  for (const name of ['node', 'helper', 'worker', 'pi'] as const) for (const field of ['path', 'version', 'sha256'] as const) {
    const changed = structuredClone(report); changed.bindings[name][field] += '-different';
    assert.throws(() => verifyWindowsEvidence(bytes(envelope(changed)), expected, trust), { code: 'EVIDENCE_INAPPLICABLE' }, `${name}.${field}`);
  }
  for (const bindings of [{ ...report.bindings, policySha256: 'c'.repeat(64) }, { ...report.bindings, pi: { ...report.bindings.pi, package: 'counterfeit-package' } }])
    assert.throws(() => verifyWindowsEvidence(bytes(envelope({ ...report, bindings })), expected, trust), { code: 'EVIDENCE_INAPPLICABLE' });
});
test('trusted signatures cannot substitute unpinned or malformed recorder provenance', () => {
  const { report, expected } = fixture();
  for (const changed of [{ id: 'worker-self-report' }, { sha256: 'c'.repeat(64) }, { runId: '' }, { runId: 'not-a-run-uuid' }, { recordedAt: 'invalid' }, { recordedAt: '2026-10-09' }])
    assert.throws(() => verifyWindowsEvidence(bytes(envelope({ ...report, recorder: { ...report.recorder, ...changed } })), expected, trust), { code: 'EVIDENCE_RECORDER_MISMATCH' });
});
test('failed, duplicate, absent, oversized and unobserved probe outcomes fail closed', () => {
  const { report, expected } = fixture(), first = report.probes[0]!;
  for (const probes of [[], undefined, [...report.probes, first], [{ ...first, passed: false }], [{ ...first, observation: '' }], [{ ...first, observation: ' ' }], [{ ...first, observation: 'x'.repeat(16_385) }], Array.from({ length: 129 }, (_, id) => ({ ...first, id: String(id) }))])
    assert.throws(() => verifyWindowsEvidence(bytes(envelope({ ...report, probes })), expected, trust), { code: 'EVIDENCE_INCOMPLETE' });
});
test('mandatory complete-probe gate rejects omission of each existing required probe', () => {
  assert.equal(REQUIRED_WINDOWS_PROBES.length, 12);
  requireWindowsProbeCoverage(REQUIRED_WINDOWS_PROBES);
  for (const omitted of REQUIRED_WINDOWS_PROBES)
    assert.throws(() => requireWindowsProbeCoverage(REQUIRED_WINDOWS_PROBES.filter(id => id !== omitted)), error => {
      assert.equal((error as { code: string }).code, 'EVIDENCE_INCOMPLETE'); assert.match((error as Error).message, new RegExp(omitted)); return true;
    });
  assert.throws(() => requireWindowsProbeCoverage(['all-passed']), { code: 'EVIDENCE_INCOMPLETE' });
});
test('bounded evidence parsing rejects malformed and oversized input', () => {
  const { expected } = fixture();
  assert.throws(() => verifyWindowsEvidence(Buffer.from('{'), expected, trust), { code: 'EVIDENCE_INVALID' });
  assert.throws(() => verifyWindowsEvidence(Buffer.alloc(MAX_WINDOWS_EVIDENCE_BYTES + 1), expected, trust), { code: 'EVIDENCE_TOO_LARGE' });
  assert.throws(() => verifyWindowsEvidence(bytes(null), expected, trust), { code: 'EVIDENCE_INVALID' });
});
test('trust accepts only bounded Ed25519 public material, never private or different key algorithms', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  for (const changed of [{ publicKeyPem: 'garbage' }, { publicKeyPem: trust.publicKeyPem + trust.publicKeyPem }, { publicKeyPem: keyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }, { publicKeyPem: ec.publicKey.export({ format: 'pem', type: 'spki' }).toString() }, { publicKeyPem: 'x'.repeat(16_385) }, { keyId: '' }, { recorderSha256: 'unknown' }])
    assert.throws(() => validateWindowsEvidenceTrustAnchor({ ...trust, ...changed }), { code: 'EVIDENCE_TRUST_REQUIRED' });
  const validated = validateWindowsEvidenceTrustAnchor(trust); assert.deepEqual(validated, trust); assert.ok(Object.isFrozen(validated));
});
function installation(t: test.TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'synthetic-recorder-trust-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, INSTALLED_WINDOWS_EVIDENCE_TRUST_FILE), content = bytes({ schemaVersion: 1, ...trust });
  writeFileSync(path, content); return { root, path, content };
}
test('installed trust loader requires an independent digest and preserves immutable public anchor', t => {
  const f = installation(t), loaded = loadInstalledWindowsEvidenceTrust(f.root, digest(f.content));
  assert.deepEqual(loaded, trust); assert.ok(Object.isFrozen(loaded));
  assert.throws(() => loadInstalledWindowsEvidenceTrust(f.root, ''), { code: 'EVIDENCE_TRUST_REQUIRED' });
  assert.throws(() => loadInstalledWindowsEvidenceTrust(f.root, 'c'.repeat(64)), { code: 'EVIDENCE_TRUST_CHANGED' });
});
test('replacing installed trust with an evidence-local attacker key cannot satisfy the installation pin', t => {
  const f = installation(t);
  writeFileSync(f.path, bytes({ schemaVersion: 1, ...trust, publicKeyPem: attacker.publicKey.export({ format: 'pem', type: 'spki' }).toString() }));
  assert.throws(() => loadInstalledWindowsEvidenceTrust(f.root, digest(f.content)), { code: 'EVIDENCE_TRUST_CHANGED' });
});
test('installed trust rejects extra authority fields, invalid key material and oversized files', t => {
  const f = installation(t);
  for (const value of [{ schemaVersion: 1, ...trust, privateKeyPem: 'FORBIDDEN' }, { schemaVersion: 1, ...trust, publicKeyPem: 'garbage' }, { schemaVersion: 2, ...trust }]) {
    const content = bytes(value); writeFileSync(f.path, content);
    assert.throws(() => loadInstalledWindowsEvidenceTrust(f.root, digest(content)), { code: 'EVIDENCE_TRUST_REQUIRED' });
  }
  const content = Buffer.alloc(32 * 1024 + 1); writeFileSync(f.path, content);
  assert.throws(() => loadInstalledWindowsEvidenceTrust(f.root, digest(content)), { code: 'PROFILE_FILE_INVALID' });
});
test('installed trust cannot be redirected through a symlink or symlinked installation', { skip: process.platform === 'win32' ? 'Link privileges vary on Windows; this is a portable filesystem unit test.' : false }, t => {
  const f = installation(t), content = f.content;
  const elsewhere = join(f.root, 'elsewhere'); writeFileSync(elsewhere, content); rmSync(f.path); symlinkSync(elsewhere, f.path);
  assert.throws(() => loadInstalledWindowsEvidenceTrust(f.root, digest(content)), { code: 'PROFILE_PATH' });
  rmSync(f.path); const actual = join(f.root, 'actual'); mkdirSync(actual); writeFileSync(join(actual, INSTALLED_WINDOWS_EVIDENCE_TRUST_FILE), content);
  const alias = join(f.root, 'alias'); symlinkSync(actual, alias);
  assert.throws(() => loadInstalledWindowsEvidenceTrust(alias, digest(content)), { code: 'PROFILE_PATH' });
});
test('authentic-looking evidence never bypasses native platform gate or default missing-trust gate', () => {
  const { expected, report } = fixture();
  const input = { ...expected, evidence: [{ id: report.evidenceId, path: 'C:\\Synthetic\\report.json', sha256: digest(bytes(envelope(report))) }] };
  const platformSupported = process.platform === 'win32' && process.arch === 'x64';
  assert.throws(() => verifyWindowsRuntimeProfile(input, tmpdir()), { code: platformSupported ? 'EVIDENCE_TRUST_REQUIRED' : 'WINDOWS_PROFILE_REQUIRED' });
  if (!platformSupported) assert.throws(() => verifyWindowsRuntimeProfile(input, tmpdir(), trust), { code: 'WINDOWS_PROFILE_REQUIRED' });
});


test('Git Bash evidence binds executable, version, kind and manifest exactly, including shell presence', () => {
  const { report, expected } = fixture();
  const shell = { ...binary('bash.exe'), kind: 'git-bash' as const, manifest: { path: 'C:\\Synthetic\\shell-manifest.json', sha256: 'd'.repeat(64) } };
  expected.shell = shell; report.bindings.shell = structuredClone(shell);
  report.probes.push({ id: 'git-bash-compatibility', passed: true, observation: 'SYNTHETIC shell parser fixture only.' });
  assert.deepEqual(verifyWindowsEvidence(bytes(envelope(report)), expected, trust).bindings.shell, shell);
  for (const field of ['path', 'version', 'sha256', 'kind'] as const) {
    const altered = structuredClone(report); (altered.bindings.shell as unknown as Record<string, string>)[field] += '-changed';
    assert.throws(() => verifyWindowsEvidence(bytes(envelope(altered)), expected, trust), { code: 'EVIDENCE_INAPPLICABLE' });
  }
  for (const field of ['path', 'sha256'] as const) {
    const altered = structuredClone(report); altered.bindings.shell!.manifest[field] += '-changed';
    assert.throws(() => verifyWindowsEvidence(bytes(envelope(altered)), expected, trust), { code: 'EVIDENCE_INAPPLICABLE' });
  }
  for (const disabled of [null, undefined]) {
    const altered = structuredClone(report); altered.bindings.shell = disabled;
    assert.throws(() => verifyWindowsEvidence(bytes(envelope(altered)), expected, trust), { code: 'EVIDENCE_INAPPLICABLE' });
    assert.throws(() => verifyWindowsEvidence(bytes(envelope(report)), { ...expected, shell: disabled }, trust), { code: 'EVIDENCE_INAPPLICABLE' });
  }
});
test('Node-only profiles retain their existing probe gate; enabling Git Bash adds its actual compatibility probe', () => {
  const { report, expected } = fixture();
  for (const shell of [null, undefined]) {
    const altered = structuredClone(report); altered.bindings.shell = shell;
    verifyWindowsEvidence(bytes(envelope(altered)), { ...expected, shell }, trust);
  }
  requireWindowsProbeCoverage(REQUIRED_WINDOWS_PROBES, false);
  assert.throws(() => requireWindowsProbeCoverage(REQUIRED_WINDOWS_PROBES, true), { code: 'EVIDENCE_INCOMPLETE' });
  requireWindowsProbeCoverage([...REQUIRED_WINDOWS_PROBES, ...REQUIRED_WINDOWS_SHELL_PROBES], true);
});


test('legacy strict signatures cannot authorize the registry-read candidate or a substituted policy variant', () => {
  const { report, expected } = fixture();
  const strict = 'lpac-strict-v1' as const, registry = 'lpac-registry-read-no-network-v2' as const;
  // Missing variant is backwards compatible with strict only, in either direction.
  verifyWindowsEvidence(bytes(envelope(report)), { ...expected, policyVariant: strict }, trust);
  const strictReport = { ...report, bindings: { ...report.bindings, policyVariant: strict } };
  verifyWindowsEvidence(bytes(envelope(strictReport)), expected, trust);
  assert.throws(() => verifyWindowsEvidence(bytes(envelope(report)), { ...expected, policyVariant: registry }, trust), { code: 'EVIDENCE_INAPPLICABLE' });
  assert.throws(() => verifyWindowsEvidence(bytes(envelope(strictReport)), { ...expected, policyVariant: registry }, trust), { code: 'EVIDENCE_INAPPLICABLE' });
  const candidateReport = { ...report, bindings: { ...report.bindings, policyVariant: registry } };
  assert.throws(() => verifyWindowsEvidence(bytes(envelope(candidateReport)), expected, trust), { code: 'EVIDENCE_INAPPLICABLE' });
  assert.throws(() => verifyWindowsEvidence(bytes(envelope(candidateReport)), { ...expected, policyVariant: strict }, trust), { code: 'EVIDENCE_INAPPLICABLE' });
  verifyWindowsEvidence(bytes(envelope(candidateReport)), { ...expected, policyVariant: registry }, trust);
  for (const policyVariant of [null, '', 'unrestricted-network', false]) {
    const invalidReport = { ...report, bindings: { ...report.bindings, policyVariant } };
    assert.throws(() => verifyWindowsEvidence(bytes(envelope(invalidReport)), expected, trust), { code: 'EVIDENCE_INAPPLICABLE' });
  }
});
