/**
 * Authentication for evidence emitted by the trusted, out-of-sandbox Windows Host
 * recorder. A digest (or a public key carried in an evidence file) is NOT trust.
 *
 * The Host must provision the Ed25519 public key and recorder digest separately
 * from profiles, project files and evidence. The signing key belongs only to the
 * recorder and must never be readable by Workers. No TOFU or implicit key loading
 * is performed here. Possession of the pinned signing key is the trust boundary;
 * this module cannot turn an untrusted recorder into an independent observer.
 */
import { createPublicKey, verify } from 'node:crypto';
import { RuntimeError } from './types.ts';

export const WINDOWS_RECORDER_ID = 'pi-kanban-windows-host-recorder-v1';
export const REQUIRED_WINDOWS_PROBES = [
  'implementation-own-write', 'review-source-read-only', 'cross-demand-denied',
  'shared-git-denied', 'host-control-denied', 'private-model-channel',
  'network-denied', 'descendant-stop', 'kill-on-helper-close',
  'node-pi-compatibility', 'reparse-denied', 'role-transition-clean',
] as const;
export const MAX_WINDOWS_EVIDENCE_BYTES = 1024 * 1024;
const signatureDomain = Buffer.from('pi-kanban.windows-runtime-evidence.v1\0', 'utf8');
const digestPattern = /^[a-f0-9]{64}$/;
const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Only a trusted Host caller may supply this; never deserialize it from a profile. */
export interface WindowsEvidenceTrustAnchor {
  keyId: string;
  publicKeyPem: string;
  /** SHA-256 of the trusted Host recorder, not just its sandboxed probe Worker. */
  recorderSha256: string;
}
export interface WindowsEvidenceBinaryBinding { path: string; version: string; sha256: string }
export interface WindowsEvidenceBindings {
  node: WindowsEvidenceBinaryBinding;
  helper: WindowsEvidenceBinaryBinding;
  worker: WindowsEvidenceBinaryBinding;
  pi: WindowsEvidenceBinaryBinding & { package: '@earendil-works/pi-coding-agent' };
  policySha256: string;
}
export interface WindowsEvidenceReport {
  schemaVersion: 2;
  evidenceId: string;
  profileId: string;
  osBuild: string;
  arch: 'x64';
  status: 'passed' | 'failed';
  synthetic: boolean;
  releaseAuthorized: boolean;
  recorder: { id: typeof WINDOWS_RECORDER_ID; sha256: string; runId: string; recordedAt: string };
  bindings: WindowsEvidenceBindings;
  probes: { id: string; passed: boolean; observation: string }[];
}
export interface WindowsEvidenceEnvelope {
  schemaVersion: 1;
  algorithm: 'Ed25519';
  keyId: string;
  /** The exact UTF-8 JSON string signed by the Host; it is never reserialized to verify. */
  payload: string;
  signature: string;
}
export interface ExpectedWindowsEvidence extends WindowsEvidenceBindings {
  evidenceId: string;
  profileId: string;
  osBuild: string;
  arch: 'x64';
}
function record(value: unknown, code = 'EVIDENCE_INVALID'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeError(code, 'Expected an evidence object');
  return value as Record<string, unknown>;
}
function parse(value: string): unknown {
  try { return JSON.parse(value); } catch { throw new RuntimeError('EVIDENCE_INVALID', 'Evidence must contain valid JSON'); }
}
function text(value: unknown, max = 1024): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim().length > 0;
}
function signingBytes(payload: string): Buffer { return Buffer.concat([signatureDomain, Buffer.from(payload, 'utf8')]); }

function validatedTrust(trust?: WindowsEvidenceTrustAnchor) {
  // Trust comes from the caller, never from an adjacent key, payload, profile or envelope.
  const anchor = record(trust, 'EVIDENCE_TRUST_REQUIRED');
  if (typeof anchor.keyId !== 'string' || !keyIdPattern.test(anchor.keyId) || typeof anchor.publicKeyPem !== 'string' ||
      anchor.publicKeyPem.length > 16_384 || !anchor.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----') ||
      typeof anchor.recorderSha256 !== 'string' || !digestPattern.test(anchor.recorderSha256))
    throw new RuntimeError('EVIDENCE_TRUST_REQUIRED', 'A separately provisioned Host recorder public key and digest are required');
  let key;
  try { key = createPublicKey(anchor.publicKeyPem); } catch { throw new RuntimeError('EVIDENCE_TRUST_REQUIRED', 'Invalid Host recorder public key'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new RuntimeError('EVIDENCE_TRUST_REQUIRED', 'Host recorder trust requires an Ed25519 public key');
  if (anchor.publicKeyPem.replace(/\r\n/g, '\n').trim() !== key.export({ format: 'pem', type: 'spki' }).toString().trim())
    throw new RuntimeError('EVIDENCE_TRUST_REQUIRED', 'Trust must contain one canonical public key without appended material');
  return { anchor, key };
}

/** Validate provisioned public material without loading or generating any signing key. */
export function validateWindowsEvidenceTrustAnchor(trust: WindowsEvidenceTrustAnchor): Readonly<WindowsEvidenceTrustAnchor> {
  const { anchor } = validatedTrust(trust);
  return Object.freeze({ keyId: anchor.keyId as string, publicKeyPem: anchor.publicKeyPem as string, recorderSha256: anchor.recorderSha256 as string });
}

/** Pure authentication/content checks. This alone does not create an executable profile. */
export function verifyWindowsEvidence(bytes: Uint8Array, expected: ExpectedWindowsEvidence, trust?: WindowsEvidenceTrustAnchor): WindowsEvidenceReport {
  const { anchor, key } = validatedTrust(trust);
  if (bytes.byteLength > MAX_WINDOWS_EVIDENCE_BYTES) throw new RuntimeError('EVIDENCE_TOO_LARGE', 'Bounded evidence required');
  const envelope = record(parse(Buffer.from(bytes).toString('utf8')));
  const keys = Object.keys(envelope).sort().join(',');
  if (keys !== 'algorithm,keyId,payload,schemaVersion,signature' || envelope.schemaVersion !== 1 || envelope.algorithm !== 'Ed25519' ||
      envelope.keyId !== anchor.keyId || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string')
    throw new RuntimeError('EVIDENCE_AUTHENTICATION_FAILED', 'A signed envelope from the pinned Host recorder is required');
  if (Buffer.from(envelope.payload, 'utf8').toString('utf8') !== envelope.payload)
    throw new RuntimeError('EVIDENCE_AUTHENTICATION_FAILED', 'Evidence payload must be lossless UTF-8');
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== envelope.signature || !verify(null, signingBytes(envelope.payload), key, signature))
    throw new RuntimeError('EVIDENCE_AUTHENTICATION_FAILED', 'Host recorder evidence signature is invalid');
  const report = record(parse(envelope.payload));
  if (report.schemaVersion !== 2 || report.status !== 'passed' || report.synthetic !== false || report.releaseAuthorized !== true || report.evidenceId !== expected.evidenceId ||
      report.profileId !== expected.profileId || report.osBuild !== expected.osBuild || report.arch !== expected.arch || report.arch !== 'x64')
    throw new RuntimeError('EVIDENCE_INAPPLICABLE', 'Evidence is not actual passing evidence for this exact profile and machine');
  const recorder = record(report.recorder);
  if (recorder.id !== WINDOWS_RECORDER_ID || recorder.sha256 !== anchor.recorderSha256 ||
      typeof recorder.runId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(recorder.runId) ||
      typeof recorder.recordedAt !== 'string' || !Number.isFinite(Date.parse(recorder.recordedAt)) || new Date(recorder.recordedAt).toISOString() !== recorder.recordedAt)
    throw new RuntimeError('EVIDENCE_RECORDER_MISMATCH', 'Evidence recorder provenance does not match the pinned Host recorder');
  const bindings = record(report.bindings);
  if (typeof expected.policySha256 !== 'string' || !digestPattern.test(expected.policySha256) || bindings.policySha256 !== expected.policySha256)
    throw new RuntimeError('EVIDENCE_INAPPLICABLE', 'Evidence was produced for a different policy');
  for (const name of ['node', 'helper', 'worker', 'pi'] as const) {
    const actual = record(bindings[name]), wanted = record(expected[name]);
    for (const field of ['path', 'version', 'sha256'] as const) {
      if (!text(wanted[field]) || actual[field] !== wanted[field]) throw new RuntimeError('EVIDENCE_INAPPLICABLE', `${name} ${field} differs from the exact artifact lock`);
    }
    if (!digestPattern.test(String(wanted.sha256))) throw new RuntimeError('EVIDENCE_INAPPLICABLE', `${name} digest is invalid`);
    if (name === 'pi' && (wanted.package !== '@earendil-works/pi-coding-agent' || actual.package !== wanted.package))
      throw new RuntimeError('EVIDENCE_INAPPLICABLE', 'Evidence must bind the official Pi package');
  }
  if (!Array.isArray(report.probes) || !report.probes.length || report.probes.length > 128) throw new RuntimeError('EVIDENCE_INCOMPLETE', 'Bounded actual probe observations are required');
  const seen = new Set<string>();
  for (const value of report.probes) {
    const probe = record(value);
    if (!text(probe.id, 128) || seen.has(probe.id) || probe.passed !== true || !text(probe.observation, 16_384))
      throw new RuntimeError('EVIDENCE_INCOMPLETE', 'Duplicate, failed or unobserved probes cannot establish passing isolation evidence');
    seen.add(probe.id);
  }
  return report as unknown as WindowsEvidenceReport;
}

/** Run after authenticating every report. Partial reports cannot remove any mandatory probe. */
export function requireWindowsProbeCoverage(probeIds: Iterable<string>): void {
  const covered = new Set(probeIds), missing = REQUIRED_WINDOWS_PROBES.filter(id => !covered.has(id));
  if (missing.length) throw new RuntimeError('EVIDENCE_INCOMPLETE', `Unverified probes: ${missing.join(', ')}`);
}
