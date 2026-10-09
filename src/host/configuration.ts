import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import type { AgentMaterial } from '../agent/resources.ts';
import type { Methods, MethodSnapshot, Stage } from '../domain/types.ts';
import type { ModelGrant } from '../runtime/budget.ts';
import { RuntimeError } from '../runtime/types.ts';
import type { RuntimeRole } from '../runtime/types.ts';
import { assertNodeOnlyRuntime } from '../runtime/profile.ts';
import type { WindowsRuntimePolicyVariant } from '../runtime/profile.ts';

export const CONFIGURATION_SCHEMA_VERSION = 1;
export const CONFIGURATION_FILENAME = 'configuration.v1.json';
export const MAX_CONFIGURATION_BYTES = 128 * 1024;
export const MAX_METHOD_BYTES = 1024 * 1024;
export const MAX_METHOD_TOTAL_BYTES = 8 * 1024 * 1024;
const STAGES: readonly Stage[] = ['planning', 'implementation', 'review'];
const ROLES: readonly RuntimeRole[] = ['planning', 'implementation', 'review', 'boundary-review', 'check'];
export interface FileReference { id: string; path: string; sha256: string }
export interface RuntimeFileReference extends FileReference { version: string }
export interface ShellConfiguration extends RuntimeFileReference { kind: 'git-bash'; manifest: FileReference }
export interface RuntimeConfiguration {
  profileId: string; osBuild: string | null; arch: 'x64' | null;
  node: RuntimeFileReference | null; helper: RuntimeFileReference | null; worker: RuntimeFileReference | null;
  pi: (RuntimeFileReference & { package: '@earendil-works/pi-coding-agent' }) | null;
  /** Legacy metadata round-trips for explicit removal. Non-null shells block the Node-only product. */
  shell?: ShellConfiguration | null;
  /** Omission selects the strict policy only; alternate capabilities require explicit input. */
  policyVariant?: WindowsRuntimePolicyVariant;
  policySha256: string | null;
  evidence: { privateChannel: FileReference | null; filesystem: FileReference | null; processTree: FileReference | null; network: FileReference | null };
}
export interface MethodSourceConfiguration extends FileReference {
  logicalName: string; version: string; adapter: string; dependencies: FileReference[];
}
export interface ModelLimits {
  maxRequests: number; maxTokens: number; maxCostMicros: number;
  currency: string; expiresAt: string; meteringPolicy: string;
}
export interface ProviderConfiguration {
  provider: string; modelId: string; destination: string; credentialRef: string | null;
  contextPolicy: 'exact-materials-only' | 'approved-run-derived-v1' | null;
  data: { id: string; sha256: string }[]; allowedRoles: RuntimeRole[]; limits: ModelLimits | null;
}
export interface WorkbenchConfiguration {
  schemaVersion: 1; revision: number; runtime: RuntimeConfiguration | null;
  methods: Record<Stage, MethodSourceConfiguration | null>;
  provider: ProviderConfiguration | null;
}
export interface MethodConfigurationSummary {
  stage: Stage; logicalName: string; status: 'missing' | 'invalid' | 'configured';
  source: FileReference | null; snapshot: MethodSnapshot | null; dependencyCount: number; blockers: string[];
}
export interface ConfigurationSummary {
  schemaVersion: 1; revision: number; configurationDigest: string;
  sourceStatus: 'missing' | 'configured' | 'invalid'; configuration: WorkbenchConfiguration;
  runtime: { status: 'missing' | 'invalid' | 'configured-unverified'; blockers: string[] };
  methods: MethodConfigurationSummary[]; planningMethodMissing: boolean;
  provider: { status: 'missing' | 'incomplete' | 'configured-unapproved'; blockers: string[] };
  executionEnabled: false; blockers: string[];
}
export interface LoadedMethods {
  methods: Methods; materials: Record<Stage, AgentMaterial[]>;
  summaries: MethodConfigurationSummary[]; blockers: string[];
}
export interface ModelDecisionReference { id: string; demandId: string; decisionId: string }

function fail(code: string, message: string): never { throw new RuntimeError(code, message); }
function object(value: unknown, allowed: readonly string[], label: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_CONFIGURATION', `${label} must be an ordinary object.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key))) fail('INVALID_CONFIGURATION', `${label} has an unsupported field. Credentials, authorization flags and implicit discovery are not configuration.`);
  if (allowed.some(key => !optional.includes(key) && !Object.hasOwn(record, key))) fail('INVALID_CONFIGURATION', `${label} is incomplete; use explicit null for unknown values.`);
  return record;
}
function string(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail('INVALID_CONFIGURATION', `${label} must be bounded nonempty text.`);
  return value;
}
function identifier(value: unknown, label: string): string {
  const result = string(value, label, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/.test(result)) fail('INVALID_CONFIGURATION', `${label} must be a stable identifier.`);
  return result;
}
function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('INVALID_CONFIGURATION', `${label} must be an exact lowercase SHA-256 digest.`);
  return value;
}
function integer(value: unknown, label: string, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail('FINITE_BUDGET_REQUIRED', `${label} must be a finite safe integer of at least ${minimum}.`);
  return value;
}
function nullable<T>(value: unknown, parseValue: (input: unknown) => T): T | null { return value === null ? null : parseValue(value); }
function array<T>(value: unknown, label: string, max: number, parseValue: (input: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) fail('INVALID_CONFIGURATION', `${label} must be an explicit array with at most ${max} entries.`);
  return value.map(parseValue);
}
function unique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) fail('INVALID_CONFIGURATION', `${label} contains duplicate identities.`);
}
function localPath(value: unknown, label: string): string {
  const result = string(value, label, 4096);
  if (!isAbsolute(result) || result !== resolve(result) || /^[/\\]{2}/.test(result) || /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(result)) fail('UNSAFE_CONFIGURATION_PATH', `${label} must be an exact absolute local path, without aliases or traversal.`);
  // Alternate streams/device paths are not ordinary files; allow only the drive colon on Windows.
  if (result.slice(process.platform === 'win32' ? 2 : 0).includes(':')) fail('UNSAFE_CONFIGURATION_PATH', `${label} cannot name an alternate stream.`);
  return result;
}
function fileReference(value: unknown, label: string, extra: readonly string[] = []): FileReference {
  const o = object(value, ['id', 'path', 'sha256', ...extra], label);
  return { id: identifier(o.id, `${label}.id`), path: localPath(o.path, `${label}.path`), sha256: digest(o.sha256, `${label}.sha256`) };
}
function exactVersion(value: unknown, label: string): string {
  const version = string(value, `${label}.version`, 80);
  if (!/^v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(version)) fail('INVALID_CONFIGURATION', `${label} requires an exact version, not a range.`);
  return version;
}
function runtimeFile(value: unknown, label: string, pi = false): RuntimeFileReference & { package?: '@earendil-works/pi-coding-agent' } {
  const ref = fileReference(value, label, pi ? ['version', 'package'] : ['version']);
  const o = value as Record<string, unknown>;
  const version = exactVersion(o.version, label);
  if (label.endsWith('.node') && !/^v?24\./.test(version)) fail('INVALID_CONFIGURATION', 'Only an explicitly pinned Node 24 runtime is supported.');
  if (pi && o.package !== '@earendil-works/pi-coding-agent') fail('INVALID_CONFIGURATION', 'The Pi SDK package must be explicitly identified.');
  return { ...ref, version, ...(pi ? { package: '@earendil-works/pi-coding-agent' as const } : {}) };
}
function shellConfiguration(value: unknown): ShellConfiguration {
  const label = 'runtime.shell', ref = fileReference(value, label, ['version', 'kind', 'manifest']);
  const o = value as Record<string, unknown>;
  if (o.kind !== 'git-bash') fail('INVALID_CONFIGURATION', 'runtime.shell.kind must explicitly identify git-bash.');
  const manifest = fileReference(o.manifest, 'runtime.shell.manifest');
  unique([ref.id, manifest.id], 'Shell and manifest identifiers');
  if (samePath(ref.path, manifest.path)) fail('INVALID_CONFIGURATION', 'The shell executable and manifest must be distinct files.');
  return { ...ref, version: exactVersion(o.version, label), kind: 'git-bash', manifest };
}
function runtimeConfiguration(value: unknown): RuntimeConfiguration {
  const o = object(value, ['profileId', 'osBuild', 'arch', 'node', 'helper', 'worker', 'pi', 'shell', 'policyVariant', 'policySha256', 'evidence'], 'runtime', ['shell', 'policyVariant']);
  const policyVariant = Object.hasOwn(o, 'policyVariant') ? o.policyVariant : 'lpac-strict-v1';
  if (policyVariant !== 'lpac-strict-v1' && policyVariant !== 'lpac-registry-read-no-network-v2' && policyVariant !== 'appcontainer-no-network-v3') fail('INVALID_CONFIGURATION', 'runtime.policyVariant must explicitly select a known locked capability policy.');
  if (o.arch !== null && o.arch !== 'x64') fail('INVALID_CONFIGURATION', 'runtime.arch must be x64 or null.');
  if (o.osBuild !== null && (typeof o.osBuild !== 'string' || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(o.osBuild))) fail('INVALID_CONFIGURATION', 'runtime.osBuild must be an exact numeric Windows release or null.');
  const evidence = object(o.evidence, ['privateChannel', 'filesystem', 'processTree', 'network'], 'runtime.evidence');
  return {
    profileId: identifier(o.profileId, 'runtime.profileId'), osBuild: nullable(o.osBuild, v => string(v, 'runtime.osBuild', 80)), arch: o.arch,
    node: nullable(o.node, v => runtimeFile(v, 'runtime.node')), helper: nullable(o.helper, v => runtimeFile(v, 'runtime.helper')),
    worker: nullable(o.worker, v => runtimeFile(v, 'runtime.worker')),
    pi: nullable(o.pi, v => runtimeFile(v, 'runtime.pi', true) as RuntimeConfiguration['pi'] & {}),
    shell: Object.hasOwn(o, 'shell') ? nullable(o.shell, shellConfiguration) : null,
    policyVariant,
    policySha256: nullable(o.policySha256, v => digest(v, 'runtime.policySha256')),
    evidence: {
      privateChannel: nullable(evidence.privateChannel, v => fileReference(v, 'runtime.evidence.privateChannel')),
      filesystem: nullable(evidence.filesystem, v => fileReference(v, 'runtime.evidence.filesystem')),
      processTree: nullable(evidence.processTree, v => fileReference(v, 'runtime.evidence.processTree')),
      network: nullable(evidence.network, v => fileReference(v, 'runtime.evidence.network')),
    },
  };
}
function methodSource(value: unknown, stage: Stage): MethodSourceConfiguration {
  const ref = fileReference(value, `methods.${stage}`, ['logicalName', 'version', 'adapter', 'dependencies']);
  const o = value as Record<string, unknown>;
  const logicalName = identifier(o.logicalName, `methods.${stage}.logicalName`);
  if (stage === 'planning' && logicalName !== 'design-feature') fail('PLANNING_METHOD_REQUIRED', 'Planning must point to the supplied design-feature method; candidate text cannot silently replace it.');
  const dependencies = array(o.dependencies, `methods.${stage}.dependencies`, 64, v => fileReference(v, 'method dependency'));
  unique([ref.id, ...dependencies.map(d => d.id)], 'Method and dependency identifiers');
  unique([ref.path, ...dependencies.map(d => d.path)], 'Method and dependency paths');
  return { ...ref, logicalName, version: string(o.version, 'method version', 80), adapter: identifier(o.adapter, 'method adapter'), dependencies };
}
function limits(value: unknown): ModelLimits {
  const o = object(value, ['maxRequests', 'maxTokens', 'maxCostMicros', 'currency', 'expiresAt', 'meteringPolicy'], 'provider.limits');
  const currency = string(o.currency, 'currency', 3), expiresAt = string(o.expiresAt, 'expiresAt', 32);
  if (!/^[A-Z]{3}$/.test(currency) || !Number.isFinite(Date.parse(expiresAt)) || new Date(expiresAt).toISOString() !== expiresAt) fail('FINITE_BUDGET_REQUIRED', 'An ISO 4217-style uppercase currency code and exact UTC ISO expiration are required.');
  return { maxRequests: integer(o.maxRequests, 'maxRequests'), maxTokens: integer(o.maxTokens, 'maxTokens'), maxCostMicros: integer(o.maxCostMicros, 'maxCostMicros'), currency, expiresAt, meteringPolicy: identifier(o.meteringPolicy, 'meteringPolicy') };
}
function providerConfiguration(value: unknown): ProviderConfiguration {
  const o = object(value, ['provider', 'modelId', 'destination', 'credentialRef', 'contextPolicy', 'data', 'allowedRoles', 'limits'], 'provider');
  if (o.contextPolicy !== null && o.contextPolicy !== 'exact-materials-only' && o.contextPolicy !== 'approved-run-derived-v1') fail('INVALID_CONFIGURATION', 'An explicit known context policy or null is required.');
  const contextPolicy = o.contextPolicy;
  const destination = string(o.destination, 'provider.destination', 2048);
  let url: URL; try { url = new URL(destination); } catch { return fail('DESTINATION_DENIED', 'An exact HTTPS destination is required.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href !== destination) fail('DESTINATION_DENIED', 'Destination must be exact canonical HTTPS without credentials, query or fragment.');
  const credentialRef = nullable(o.credentialRef, v => string(v, 'credentialRef', 133));
  if (credentialRef !== null && !/^(?:env:[A-Z_][A-Z0-9_]{0,127}|host:[A-Za-z][A-Za-z0-9_.-]{0,127})$/.test(credentialRef)) fail('CREDENTIAL_REFERENCE_REQUIRED', 'Use only env:NAME or host:name; never store a credential value.');
  const data = array(o.data, 'provider.data', 256, v => { const d = object(v, ['id', 'sha256'], 'allowed data'); return { id: identifier(d.id, 'data.id'), sha256: digest(d.sha256, 'data.sha256') }; });
  unique(data.map(d => d.id), 'Allowed data');
  const allowedRoles = array(o.allowedRoles, 'provider.allowedRoles', ROLES.length, v => { if (!ROLES.includes(v as RuntimeRole)) fail('INVALID_CONFIGURATION', 'Unknown model role.'); return v as RuntimeRole; });
  unique(allowedRoles, 'Allowed roles');
  return { provider: identifier(o.provider, 'provider.provider'), modelId: identifier(o.modelId, 'provider.modelId'), destination, credentialRef, contextPolicy, data, allowedRoles, limits: nullable(o.limits, limits) };
}

export function emptyConfiguration(): WorkbenchConfiguration {
  return { schemaVersion: 1, revision: 0, runtime: null, methods: { planning: null, implementation: null, review: null }, provider: null };
}
/** Strict and reconstructive: unknown keys, secret fields and authorizing flags are rejected. */
export function parseConfiguration(value: unknown): WorkbenchConfiguration {
  const o = object(value, ['schemaVersion', 'revision', 'runtime', 'methods', 'provider'], 'configuration');
  if (o.schemaVersion !== CONFIGURATION_SCHEMA_VERSION) fail('CONFIGURATION_SCHEMA_UNSUPPORTED', 'Unsupported configuration schema version.');
  const methods = object(o.methods, STAGES, 'methods');
  const parsed: WorkbenchConfiguration = { schemaVersion: 1, revision: integer(o.revision, 'revision', 0), runtime: nullable(o.runtime, runtimeConfiguration), methods: {
    planning: nullable(methods.planning, v => methodSource(v, 'planning')), implementation: nullable(methods.implementation, v => methodSource(v, 'implementation')), review: nullable(methods.review, v => methodSource(v, 'review')),
  }, provider: nullable(o.provider, providerConfiguration) };
  const materialIdentities = new Map<string, string>();
  for (const method of Object.values(parsed.methods)) if (method) for (const ref of [method, ...method.dependencies]) {
    const identity = JSON.stringify({ path: ref.path, sha256: ref.sha256 });
    if (materialIdentities.has(ref.id) && materialIdentities.get(ref.id) !== identity) fail('INVALID_CONFIGURATION', 'A material identifier cannot refer to different files or revisions across stages.');
    materialIdentities.set(ref.id, identity);
  }
  if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > MAX_CONFIGURATION_BYTES) fail('CONFIGURATION_TOO_LARGE', 'Configuration exceeds the bounded control frame.');
  return parsed;
}
export function configurationDigest(configuration: WorkbenchConfiguration): string { return sha256(JSON.stringify(parseConfiguration(configuration))); }
function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

function samePath(a: string, b: string): boolean { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
/** Check every existing component, not only the final filename. Windows junctions are symlinks to Node. */
function noLinks(path: string, allowMissing = false): void {
  const root = parse(path).root;
  let cursor = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    let stat;
    try { stat = lstatSync(cursor); } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) fail('UNSAFE_CONFIGURATION_PATH', 'Symbolic links and Windows junction/reparse aliases are not allowed.');
    if (cursor !== path && !stat.isDirectory()) fail('UNSAFE_CONFIGURATION_PATH', 'Every parent path component must be a real directory.');
  }
  if (!samePath(realpathSync(path), path)) fail('UNSAFE_CONFIGURATION_PATH', 'The canonical path differs from the explicitly selected local path.');
}
function regularBytes(path: string, maxBytes: number): Buffer {
  localPath(path, 'file path'); noLinks(path);
  const before = lstatSync(path);
  if (!before.isFile()) fail('CONFIGURATION_FILE_REQUIRED', 'Expected a regular file, not a directory, pipe or device.');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) fail('CONFIGURATION_FILE_CHANGED', 'The selected file changed while opening.');
    if (stat.size > maxBytes) fail('CONFIGURATION_TOO_LARGE', 'The selected file exceeds its bounded size.');
    const chunks: Buffer[] = []; let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > maxBytes) fail('CONFIGURATION_TOO_LARGE', 'The selected file grew beyond its bounded size.');
      chunks.push(chunk.subarray(0, count));
    }
    const after = fstatSync(fd), current = lstatSync(path);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || current.ino !== stat.ino || current.dev !== stat.dev || current.isSymbolicLink()) fail('CONFIGURATION_FILE_CHANGED', 'The selected file changed while reading.');
    noLinks(path);
    return Buffer.concat(chunks, total);
  } finally { closeSync(fd); }
}
function checkedFile(reference: FileReference, maxBytes: number): Buffer {
  const bytes = regularBytes(reference.path, maxBytes);
  if (sha256(bytes) !== reference.sha256) fail('CONFIGURATION_DIGEST_MISMATCH', `Digest mismatch for explicitly configured file ${reference.id}.`);
  return bytes;
}
function jsonFile(path: string): unknown {
  const bytes = regularBytes(path, MAX_CONFIGURATION_BYTES);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('INVALID_CONFIGURATION', 'Configuration must be valid UTF-8.'); }
  try { return JSON.parse(text); } catch { return fail('INVALID_CONFIGURATION', 'Configuration must contain valid JSON.'); }
}
function errorText(error: unknown): string {
  // Report only known local validation errors, not arbitrary object/stringification or file contents.
  if (error instanceof RuntimeError) return `${error.code}: ${error.message}`;
  const code = (error as NodeJS.ErrnoException)?.code;
  return `CONFIGURATION_FILE_UNAVAILABLE: ${typeof code === 'string' ? code : 'unable to read the explicitly configured file'}`;
}
function methodDigest(source: MethodSourceConfiguration): string {
  return sha256(JSON.stringify({ id: source.id, logicalName: source.logicalName, version: source.version, adapter: source.adapter,
    files: [{ id: source.id, sha256: source.sha256 }, ...source.dependencies.map(d => ({ id: d.id, sha256: d.sha256 })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))] }));
}
/** All method data are resolved explicitly and verified before any is exposed to a Worker. */
export function loadMethods(configuration: WorkbenchConfiguration): LoadedMethods {
  const config = parseConfiguration(configuration);
  const result: LoadedMethods = { methods: {}, materials: { planning: [], implementation: [], review: [] }, summaries: [], blockers: [] };
  let totalBytes = 0;
  for (const stage of STAGES) {
    const source = config.methods[stage];
    const summary: MethodConfigurationSummary = { stage, logicalName: source?.logicalName ?? (stage === 'planning' ? 'design-feature' : stage), status: 'missing', source: source ? { id: source.id, path: source.path, sha256: source.sha256 } : null, snapshot: null, dependencyCount: source?.dependencies.length ?? 0, blockers: [] };
    if (!source) summary.blockers.push(stage === 'planning' ? 'The actual user-supplied design-feature method and its explicitly declared dependencies are missing.' : `An explicitly named ${stage} method is missing.`);
    else {
      try {
        const materials: AgentMaterial[] = [];
        for (const reference of [source, ...[...source.dependencies].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))]) {
          const bytes = checkedFile(reference, MAX_METHOD_BYTES);
          totalBytes += bytes.byteLength;
          if (totalBytes > MAX_METHOD_TOTAL_BYTES) fail('CONFIGURATION_TOO_LARGE', 'The three stages exceed the total method material bound.');
          let content: string;
          try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('METHOD_ENCODING_INVALID', 'Method materials must be UTF-8 text.'); }
          if (!content!.trim() || content!.includes('\0')) fail('METHOD_CONTENT_INVALID', 'Method materials must contain nonempty text without NUL bytes.');
          // AgentMaterial's digest describes the exact UTF-8 text sent to the explicit resource loader.
          if (sha256(content!) !== reference.sha256) fail('METHOD_ENCODING_INVALID', 'Method text must round-trip as exact UTF-8 without a byte-order mark.');
          materials.push({ id: reference.id, kind: 'method', sha256: reference.sha256, content: content! });
        }
        const snapshot: MethodSnapshot = { id: source.id, version: source.version, digest: methodDigest(source), adapter: source.adapter, dependencies: source.dependencies.map(d => `${d.id}@${d.sha256}`).sort() };
        result.methods[stage] = snapshot; result.materials[stage] = materials;
        summary.status = 'configured'; summary.snapshot = snapshot;
      } catch (error) { summary.status = 'invalid'; summary.blockers.push(errorText(error)); }
    }
    result.summaries.push(summary); result.blockers.push(...summary.blockers.map(reason => `${stage}: ${reason}`));
  }
  return result;
}
function providerGaps(provider: ProviderConfiguration | null, now = Date.now()): string[] {
  if (!provider) return ['No provider, exact model or destination has been configured.'];
  const blockers: string[] = [];
  if (!provider.contextPolicy) blockers.push('Explicit permission scope for exact materials or bounded verified-run-derived context is missing.');
  if (!provider.credentialRef) blockers.push('An env:NAME or host:name credential reference is missing.');
  if (!provider.data.length) blockers.push('An explicit immutable allowed-data list is missing.');
  if (!provider.allowedRoles.length) blockers.push('Explicit allowed model roles are missing.');
  if (!provider.limits) blockers.push('Finite request, token and cost limits, currency, expiration and metering policy are missing.');
  else if (Date.parse(provider.limits.expiresAt) <= now) blockers.push('The proposed finite model authorization has expired.');
  return blockers;
}
function runtimeGaps(runtime: RuntimeConfiguration | null): string[] {
  if (!runtime) return ['A Windows runtime profile is missing.'];
  const blockers: string[] = [];
  for (const key of ['osBuild', 'arch', 'policySha256'] as const) if (!runtime[key]) blockers.push(`runtime.${key} is missing.`);
  for (const key of ['node', 'helper', 'worker', 'pi'] as const) {
    const file = runtime[key];
    if (!file) blockers.push(`runtime.${key} exact version, local path and SHA-256 are missing.`);
    else try { checkedFile(file, 256 * 1024 * 1024); } catch (error) { blockers.push(`runtime.${key}: ${errorText(error)}`); }
  }
  if (runtime.shell) {
    try { assertNodeOnlyRuntime(runtime); } catch (error) { blockers.push(`runtime.shell: ${errorText(error)}`); }
  }
  for (const [kind, reference] of Object.entries(runtime.evidence)) {
    if (!reference) blockers.push(`runtime.evidence.${kind} is missing.`);
    else try { checkedFile(reference, MAX_CONFIGURATION_BYTES); } catch (error) { blockers.push(`runtime.evidence.${kind}: ${errorText(error)}`); }
  }
  return blockers;
}
/** A serializable inspection only. Complete input never establishes isolation or spending authority. */
export function inspectConfiguration(configuration: WorkbenchConfiguration, sourceStatus: ConfigurationSummary['sourceStatus'] = 'configured'): ConfigurationSummary {
  const config = parseConfiguration(configuration), methods = loadMethods(config), runtime = runtimeGaps(config.runtime), provider = providerGaps(config.provider);
  const blockers = [...runtime, ...methods.blockers, ...provider,
    'Windows runtime evidence must be independently verified for the actual host and locked binaries before execution.',
    'Model data and finite spending require a separate trusted user decision; configuration is not authorization.'];
  return {
    schemaVersion: 1, revision: config.revision, configurationDigest: configurationDigest(config), sourceStatus, configuration: config,
    runtime: { status: !config.runtime ? 'missing' : runtime.length ? 'invalid' : 'configured-unverified', blockers: runtime },
    methods: methods.summaries, planningMethodMissing: !methods.methods.planning,
    provider: { status: !config.provider ? 'missing' : provider.length ? 'incomplete' : 'configured-unapproved', blockers: provider }, executionEnabled: false, blockers,
  };
}
/** Maps input to the independent native verifier. No self-attested flags are introduced. */
export function runtimeProfileInput(configuration: WorkbenchConfiguration) {
  const runtime = parseConfiguration(configuration).runtime;
  if (runtime) assertNodeOnlyRuntime(runtime);
  if (!runtime || !runtime.osBuild || !runtime.arch || !runtime.node || !runtime.helper || !runtime.worker || !runtime.pi || !runtime.policySha256 || Object.values(runtime.evidence).some(ref => !ref)) fail('RUNTIME_CONFIGURATION_MISSING', 'All exact runtime bindings and evidence references are required.');
  const binary = (ref: RuntimeFileReference) => ({ path: ref.path, version: ref.version, sha256: ref.sha256 });
  return { profileId: runtime.profileId, osBuild: runtime.osBuild, arch: runtime.arch,
    node: binary(runtime.node), helper: binary(runtime.helper), worker: binary(runtime.worker),
    pi: { ...binary(runtime.pi), package: runtime.pi.package }, policyVariant: runtime.policyVariant ?? 'lpac-strict-v1', policySha256: runtime.policySha256,
    evidence: Object.values(runtime.evidence).map(ref => ({ ...ref! })),
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
/** The callback is trusted Host code that checks a separately persisted authenticated user decision.
 * Never pass an IPC-provided callback or use the presence of decisionId as proof of authorization. */
export function createModelGrant(configuration: WorkbenchConfiguration, decision: ModelDecisionReference, authorize: (candidate: Readonly<ModelGrant>) => void): ModelGrant {
  const config = parseConfiguration(configuration), provider = config.provider;
  const gaps = providerGaps(provider);
  if (gaps.length || !provider?.limits || !provider.credentialRef || !provider.contextPolicy) fail('MODEL_CONFIGURATION_INCOMPLETE', gaps.join(' '));
  const reference = object(decision, ['id', 'demandId', 'decisionId'], 'trusted model decision reference');
  const grant: ModelGrant = { id: identifier(reference.id, 'grant id'), demandId: identifier(reference.demandId, 'demand id'), decisionId: identifier(reference.decisionId, 'decision id'),
    provider: provider.provider, modelId: provider.modelId, destination: provider.destination, credentialRef: provider.credentialRef, contextPolicy: provider.contextPolicy,
    data: provider.data.map(d => ({ ...d })), allowedRoles: [...provider.allowedRoles], ...provider.limits };
  if (typeof authorize !== 'function') fail('MODEL_AUTHORIZATION_MISSING', 'A trusted user-decision verifier must be supplied separately.');
  freeze(grant);
  const authorizationResult: unknown = authorize(grant);
  if (authorizationResult && typeof (authorizationResult as PromiseLike<unknown>).then === 'function') {
    // Do not accidentally treat an unawaited decision as approval. Suppress a rejected Promise while refusing it.
    void Promise.resolve(authorizationResult).catch(() => {});
    fail('MODEL_AUTHORIZATION_MISSING', 'The trusted decision verifier must finish synchronously before a grant can be created.');
  }
  if (authorizationResult !== undefined) fail('MODEL_AUTHORIZATION_MISSING', 'The trusted verifier must either complete without a return value or throw a denial.');
  // The ledger returns mutable deserialized grants itself. Return an independent clone after validation.
  return structuredClone(grant);
}

/** Only the Host chooses this app-owned directory. No config field can redirect persistence. */
export class ConfigurationStore {
  readonly directory: string;
  readonly path: string;
  constructor(appOwnedDirectory: string) {
    this.directory = localPath(appOwnedDirectory, 'app-owned configuration directory');
    this.path = join(this.directory, CONFIGURATION_FILENAME);
    noLinks(this.directory, true);
  }
  load(): WorkbenchConfiguration {
    noLinks(this.directory, true);
    try { return parseConfiguration(jsonFile(this.path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyConfiguration(); throw error; }
  }
  inspect(input?: WorkbenchConfiguration): ConfigurationSummary {
    if (input) return inspectConfiguration(input);
    try { return inspectConfiguration(this.load(), existsSync(this.path) ? 'configured' : 'missing'); }
    catch (error) {
      const summary = inspectConfiguration(emptyConfiguration(), 'invalid');
      summary.blockers.unshift(errorText(error)); return summary;
    }
  }
  /** Invalid/old schemas never silently reset values. Expected revision prevents stale UI overwrites. */
  save(input: unknown): WorkbenchConfiguration {
    const parsed = parseConfiguration(input), current = this.load();
    if (parsed.revision !== current.revision) fail('CONFIGURATION_REVISION_CONFLICT', 'Configuration changed; reload before saving.');
    const saved = parseConfiguration({ ...parsed, revision: integer(current.revision + 1, 'revision') });
    const serialized = `${JSON.stringify(saved, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_CONFIGURATION_BYTES) fail('CONFIGURATION_TOO_LARGE', 'Serialized settings exceed the persisted-file bound.');
    noLinks(this.directory, true); mkdirSync(this.directory, { recursive: true, mode: 0o700 }); noLinks(this.directory);
    const directory = lstatSync(this.directory);
    if (!directory.isDirectory() || (process.platform !== 'win32' && ((directory.mode & 0o022) !== 0 || (process.getuid && directory.uid !== process.getuid())))) fail('UNSAFE_CONFIGURATION_PATH', 'Configuration storage must be an app-owned directory without group/world write access.');
    if (existsSync(this.path)) { noLinks(this.path); if (!lstatSync(this.path).isFile()) fail('CONFIGURATION_FILE_REQUIRED', 'Configuration target must be a regular file.'); }
    const temporary = join(this.directory, `.configuration-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      writeFileSync(fd, serialized, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
      noLinks(this.directory); if (existsSync(this.path)) noLinks(this.path);
      renameSync(temporary, this.path);
      // Windows directory flush requires the native adapter; do not claim POSIX crash durability there.
      if (process.platform !== 'win32') { const directoryFd = openSync(this.directory, constants.O_RDONLY); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); } }
      return saved;
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  /** The desktop folder/file picker supplies path; imports only settings, never executes or loads credentials. */
  importFromFile(path: string): WorkbenchConfiguration {
    const input = parseConfiguration(jsonFile(localPath(path, 'configuration import path')));
    return this.save({ ...input, revision: this.load().revision });
  }
}
