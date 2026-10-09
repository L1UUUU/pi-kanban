import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, openSync, fstatSync, closeSync, readSync, constants } from 'node:fs';
import { isAbsolute, relative, resolve, dirname } from 'node:path';
import { release } from 'node:os';
import { RuntimeError } from './types.ts';
import type { LockedShellRuntime } from './shell-profile.ts';
export type { LockedShellRuntime } from './shell-profile.ts';
import { MAX_WINDOWS_EVIDENCE_BYTES, requireWindowsProbeCoverage, validateWindowsEvidenceTrustAnchor, verifyWindowsEvidence } from './evidence-auth.ts';
import type { WindowsEvidenceTrustAnchor, WindowsRuntimePolicyVariant } from './evidence-auth.ts';
export { REQUIRED_WINDOWS_PROBES } from './evidence-auth.ts';
export type { WindowsEvidenceTrustAnchor, WindowsRuntimePolicyVariant } from './evidence-auth.ts';
interface BinaryLock { path: string; version: string; sha256: string }
export interface LockedRuntimeProfile {
  profileId: string; osBuild: string; arch: 'x64'; node: BinaryLock; helper: BinaryLock; worker: BinaryLock;
  pi: BinaryLock & { package: '@earendil-works/pi-coding-agent' }; policySha256: string;
  policyVariant?: WindowsRuntimePolicyVariant;
  /** Retained for diagnostic/legacy data only; executable product profiles reject shells. */
  shell?: LockedShellRuntime | null;
  evidence: { id: string; path: string; sha256: string }[];
}
export const NODE_ONLY_RUNTIME_MESSAGE = 'The supported product runtime is Node-only. Git Bash and arbitrary shell commands are excluded; clear runtime.shell before verification or execution.';
/** Product scope is enforced independently of imported configuration and diagnostic evidence. */
export function assertNodeOnlyRuntime(value: { shell?: unknown }): void {
  if (value.shell !== undefined && value.shell !== null) throw new RuntimeError('SHELL_NOT_SUPPORTED', NODE_ONLY_RUNTIME_MESSAGE);
}
function freezeDeep<T>(value: T): T { if (value && typeof value === 'object') { for (const item of Object.values(value)) freezeDeep(item); Object.freeze(value); } return value; }
const verificationToken = Symbol('verified-runtime-profile');
const verified = new WeakSet<object>();
export class VerifiedRuntimeProfile {
  readonly config: LockedRuntimeProfile; readonly evidenceDigests: readonly string[];
  private constructor(token: symbol, config: LockedRuntimeProfile, digests: string[]) {
    if (token !== verificationToken) throw new RuntimeError('ISOLATION_UNVERIFIED', 'Profile construction requires the independent verifier');
    this.config = freezeDeep(structuredClone(config)); this.evidenceDigests = Object.freeze([...digests]); verified.add(this); Object.freeze(this);
  }
  static verify(input: unknown, trustedEvidenceRoot: string, trust?: WindowsEvidenceTrustAnchor): VerifiedRuntimeProfile {
    return verifyProfile(input, trustedEvidenceRoot, trust, (config, digests) => new VerifiedRuntimeProfile(verificationToken, config, digests));
  }
}
export function assertVerifiedProfile(value: VerifiedRuntimeProfile) {
  if (!verified.has(value)) throw new RuntimeError('ISOLATION_UNVERIFIED', 'Only the independent verifier can create an executable profile');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeError('PROFILE_INVALID', 'Profile object required');
  return value as Record<string, unknown>;
}
function boundedRead(path: string, maxBytes: number): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.size > maxBytes) throw new RuntimeError('PROFILE_FILE_INVALID', 'Expected a bounded regular file');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes)
      throw new RuntimeError('PROFILE_FILE_CHANGED', 'Profile source changed before open');
    // Read at most the observed length plus one byte, even if another process grows it.
    const bytes = Buffer.alloc(opened.size + 1); let count = 0;
    while (count < bytes.length) { const size = readSync(fd, bytes, count, bytes.length - count, count); if (!size) break; count += size; }
    const after = fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || count !== after.size)
      throw new RuntimeError('PROFILE_FILE_CHANGED', 'Profile source changed while reading');
    return bytes.subarray(0, count);
  } finally { closeSync(fd); }
}
function digest(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }
function hash(path: string, maxBytes = 256 * 1024 * 1024) { return digest(boundedRead(path, maxBytes)); }
function lockedPath(path: string) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new RuntimeError('PROFILE_PATH', 'Absolute locked path required');
  let cursor = resolve(path);
  for (;;) { if (lstatSync(cursor).isSymbolicLink()) throw new RuntimeError('PROFILE_PATH', 'Symlink or junction in locked path'); const parent = dirname(cursor); if (parent === cursor) break; cursor = parent; }
  const real = realpathSync(path);
  if (real.toLowerCase() !== resolve(path).toLowerCase()) throw new RuntimeError('PROFILE_PATH', 'Locked path is not canonical');
  return real;
}
function verifyProfile(input: unknown, trustedEvidenceRoot: string, trust: WindowsEvidenceTrustAnchor | undefined,
  make: (config: LockedRuntimeProfile, digests: string[]) => VerifiedRuntimeProfile): VerifiedRuntimeProfile {
  const value = object(input);
  assertNodeOnlyRuntime(value);
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new RuntimeError('WINDOWS_PROFILE_REQUIRED', 'Native Windows x64 is required; no platform fallback');
  // Evidence-root ownership, profile hashes and adjacent public keys cannot establish provenance.
  // No trust anchor is embedded in user-configurable profile JSON or implicitly provisioned here.
  if (!trust) throw new RuntimeError('EVIDENCE_TRUST_REQUIRED', 'A separately provisioned Host recorder trust anchor is required');
  const config = value as unknown as LockedRuntimeProfile;
  if (typeof config.profileId !== 'string' || !config.profileId || config.arch !== 'x64' || config.osBuild !== release())
    throw new RuntimeError('PROFILE_MACHINE_MISMATCH', 'Profile OS build and architecture must match this machine exactly');
  if (Number(release().split('.')[2]) < 22000) throw new RuntimeError('WINDOWS_11_REQUIRED', 'Windows 11 build or later required');
  if (typeof config.policySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(config.policySha256)) throw new RuntimeError('POLICY_UNVERIFIED', 'Policy digest missing');
  if (config.policyVariant !== undefined && config.policyVariant !== 'lpac-strict-v1' && config.policyVariant !== 'lpac-registry-read-no-network-v2' && config.policyVariant !== 'appcontainer-no-network-v3')
    throw new RuntimeError('PROFILE_POLICY_MISMATCH', 'An explicit supported Windows policy variant is required');
  for (const key of ['node', 'helper', 'worker', 'pi'] as const) {
    const binary = object(config[key]);
    if (typeof binary.version !== 'string' || !binary.version || typeof binary.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(binary.sha256) || typeof binary.path !== 'string')
      throw new RuntimeError('PROFILE_BINARY_MISSING', `${key} exact lock missing`);
    if (hash(lockedPath(binary.path)) !== binary.sha256) throw new RuntimeError('PROFILE_BINARY_CHANGED', `${key} digest changed`);
  }
  if (!/^v?24\./.test(config.node.version) || config.pi.package !== '@earendil-works/pi-coding-agent')
    throw new RuntimeError('PROFILE_RUNTIME_MISMATCH', 'Expected Node 24 and the exact official Pi package');
  if (!Array.isArray(config.evidence) || !config.evidence.length || config.evidence.length > 32)
    throw new RuntimeError('ISOLATION_UNVERIFIED', 'Bounded independently captured Windows evidence required');
  const root = lockedPath(trustedEvidenceRoot), covered = new Set<string>(), digests: string[] = [];
  if (!lstatSync(root).isDirectory()) throw new RuntimeError('EVIDENCE_SOURCE_DENIED', 'Host evidence root must be a directory');
  for (const inputRef of config.evidence) {
    const ref = object(inputRef);
    if (typeof ref.id !== 'string' || !ref.id.trim() || ref.id.length > 128 || typeof ref.path !== 'string' ||
        typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256))
      throw new RuntimeError('EVIDENCE_INVALID', 'Evidence requires bounded IDs and exact file references');
    const path = lockedPath(ref.path), rel = relative(root, path);
    if (rel.startsWith('..') || isAbsolute(rel) || !rel)
      throw new RuntimeError('EVIDENCE_SOURCE_DENIED', 'Evidence must be a file under the Host-owned evidence directory');
    // The signature and reference digest must authenticate the SAME file snapshot.
    const bytes = boundedRead(path, MAX_WINDOWS_EVIDENCE_BYTES);
    if (digest(bytes) !== ref.sha256) throw new RuntimeError('EVIDENCE_CHANGED', 'Evidence digest changed');
    const report = verifyWindowsEvidence(bytes, { ...config, evidenceId: ref.id }, trust);
    for (const probe of report.probes) covered.add(probe.id);
    digests.push(ref.sha256);
  }
  requireWindowsProbeCoverage(covered);
  return make(config, digests);
}
/** The two-argument form intentionally fails closed until the Host has a pinned recorder trust anchor. */
export function verifyWindowsRuntimeProfile(input: unknown, trustedEvidenceRoot: string, trust?: WindowsEvidenceTrustAnchor): VerifiedRuntimeProfile {
  return VerifiedRuntimeProfile.verify(input, trustedEvidenceRoot, trust);
}

/** Fixed filename under a trusted Host installation, never under an evidence/project root. */
export const INSTALLED_WINDOWS_EVIDENCE_TRUST_FILE = 'windows-evidence-trust.json';
/**
 * Installation/provisioning contract:
 * 1. Provision approved public recorder material as this fixed file with schemaVersion: 1.
 * 2. Pin its SHA-256 in trusted Host installation code/metadata independently of the file.
 * 3. Supply that installation directory and pinned hash here; pass the result to the verifier.
 *
 * Inputs may be supplied by trusted operator-only Host startup configuration, including
 * PI_KANBAN_RUNTIME_TRUST_DIR / PI_KANBAN_RUNTIME_TRUST_SHA256 propagated only from
 * trusted Electron to Host. Never read them from Worker-controlled environment, runtime
 * configuration, IPC, project/evidence files, or an adjacent digest file. This loader never generates keys,
 * accepts a TOFU key, or treats file ownership/location alone as recorder authority.
 * There is intentionally no default key: an unprovisioned installation remains disabled.
 */
export function loadInstalledWindowsEvidenceTrust(installationDirectory: string, pinnedTrustFileSha256: string): Readonly<WindowsEvidenceTrustAnchor> {
  if (typeof pinnedTrustFileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pinnedTrustFileSha256))
    throw new RuntimeError('EVIDENCE_TRUST_REQUIRED', 'An independently pinned installation trust-file digest is required');
  const root = lockedPath(installationDirectory);
  if (!lstatSync(root).isDirectory()) throw new RuntimeError('EVIDENCE_TRUST_REQUIRED', 'Trusted Host installation directory required');
  const path = lockedPath(resolve(root, INSTALLED_WINDOWS_EVIDENCE_TRUST_FILE));
  const bytes = boundedRead(path, 32 * 1024);
  if (digest(bytes) !== pinnedTrustFileSha256) throw new RuntimeError('EVIDENCE_TRUST_CHANGED', 'Installed Host recorder trust does not match the independent installation pin');
  let value: Record<string, unknown>;
  try { value = object(JSON.parse(bytes.toString('utf8'))); } catch { throw new RuntimeError('EVIDENCE_TRUST_REQUIRED', 'Invalid installed Host recorder trust'); }
  if (Object.keys(value).sort().join(',') !== 'keyId,publicKeyPem,recorderSha256,schemaVersion' || value.schemaVersion !== 1)
    throw new RuntimeError('EVIDENCE_TRUST_REQUIRED', 'Installed trust must contain only versioned public recorder material');
  return validateWindowsEvidenceTrustAnchor(value as unknown as WindowsEvidenceTrustAnchor);
}
