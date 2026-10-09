import { join } from 'node:path';
import type { AgentMaterial } from '../agent/resources.ts';
import type { ContentSnapshot, Demand } from '../domain/types.ts';
import { RuntimeError } from '../runtime/types.ts';
import { canonicalJson } from '../workspace/index.ts';
import { readRegular, sourcePath } from '../workspace/paths.ts';
import { hash, ProductionEvidence } from './evidence.ts';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TREE_BYTES = 32 * MAX_FILE_BYTES;
const MAX_MATERIAL_BYTES = MAX_FILE_BYTES;

export interface ExecutionEvidenceMaterials {
  baseCommit: string;
  source: AgentMaterial;
  baseline: AgentMaterial;
  diff?: AgentMaterial;
  standards: AgentMaterial;
  materials: AgentMaterial[];
}
interface FileVersion {
  sha256: string; bytes: number; executable: boolean;
  mode: '100644' | '100755'; encoding: 'utf8' | 'binary'; text: string | null;
  object: { sha256: string; bytes: number };
}
interface FileChange { path: string; change: 'added' | 'deleted' | 'modified'; before: FileVersion | null; after: FileVersion | null }
function requireFact(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new RuntimeError(code, message);
}
/** Match the live-source deny scope before any old/deleted blob is read. */
function permittedPath(path: string): void {
  sourcePath(path);
  for (const name of path.split('/')) {
    const sensitive = /^(?:\.aws|\.ssh|\.gnupg|\.azure|\.kube|\.netrc|\.npmrc|\.pypirc|\.envrc|auth\.json|credentials(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\.(?:json|txt|yaml|yml))?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i.test(name) || (/^\.env(?:\..*)?$/i.test(name) && !/^\.env\.(?:example|template|sample)$/i.test(name)) || /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(name) || /service[-_]?account.*\.json$/i.test(name);
    requireFact(!sensitive, 'SOURCE_SENSITIVE_PATH', 'The comparison baseline contains a known credential-sensitive filename; supply a permitted sanitized baseline before execution.');
    requireFact(name.toLowerCase() !== '.local', 'NESTED_PRIVATE_PATH', 'Private source trees cannot enter execution evidence.');
  }
}
function standardsCandidate(path: string): boolean {
  const parts = path.toLowerCase().split('/'), name = parts.at(-1)!;
  // Include every recognized candidate, including nested AGENTS and guides. The
  // names are discovery hints only, never an authority or instruction hierarchy.
  return /^(?:agents|contributing|coding[-_ ]standards)(?:\.[a-z0-9]+)?$/.test(name)
    || /(?:^|[-_. ])(?:standards?|style|conventions?|guidelines?)(?:[-_. ]|$)/.test(name)
    || parts.slice(0, -1).some(part => /^(?:standards?|style|conventions?|guidelines?)$/.test(part));
}
function checkedMaterial(id: string, value: unknown): AgentMaterial {
  const content = canonicalJson(value);
  requireFact(Buffer.byteLength(content) <= MAX_MATERIAL_BYTES, 'EXECUTION_EVIDENCE_TOO_LARGE', 'Exact execution evidence exceeds the bounded context; no source or standards text was truncated.');
  return { id, kind: 'source', sha256: hash(content), content };
}

/** Host-only explicit base-to-K comparison. HEAD is ancestry evidence, never the
 * review target. No commit, index mutation, implicit base, shell or textconv.
 * Repository documents remain untrusted data in the staged user-data lane. */
export function executionEvidenceMaterials(evidence: ProductionEvidence, demand: Demand, content?: ContentSnapshot): ExecutionEvidenceMaterials {
  const workspace = evidence.workspace(), binding = workspace.getBinding(demand.id), flow = demand.executionFlow;
  requireFact(binding && binding.projectId === demand.projectId, 'WORKSPACE_MISSING', 'Execution requires this demand’s dedicated project worktree.');
  requireFact(flow, 'EXECUTION_FLOW_MISSING', 'Execution requires an approved implement-spec flow.');
  const plan = demand.plans.find(plan => plan.id === flow.planId && plan.id === demand.activePlanId && plan.id === demand.confirmedPlanId);
  requireFact(plan?.ready, 'EXECUTION_SPEC_MISSING', 'Execution requires the exact active confirmed spec plan.');
  const spec = evidence.read(demand.id, plan.spec);
  requireFact(spec.kind === 'plan' && spec.content.trim().length > 0, 'EXECUTION_SPEC_MISSING', 'The confirmed spec must be a nonempty demand-owned immutable plan artifact.');
  const writer = flow.step === 'ticket-implementation' || flow.step === 'ticket-fix';
  requireFact(content || writer, 'EXECUTION_CONTENT_MISSING', 'Independent execution review requires the exact frozen content snapshot.');
  if (content) {
    requireFact(content.id === demand.activeContentId && content.planId === plan.id && !demand.invalidatedContentIds.includes(content.id)
      && demand.contents.some(saved => canonicalJson(saved) === canonicalJson(content)), 'EXECUTION_CONTENT_MISSING', 'Execution content must be the exact active demand-owned snapshot for the confirmed plan.');
    evidence.requireOrigin(demand.id, content.code, content.createdByRun);
  }
  const baseCommit = flow.baseCommit ?? binding.currentBaseline;
  requireFact(baseCommit && baseCommit === binding.currentBaseline, 'EXECUTION_BASE_MISSING', 'Execution requires an explicit unchanged non-null workspace baseline commit.');
  requireFact(workspace.git.resolveCommit(binding.worktreePath, baseCommit) === baseCommit, 'EXECUTION_BASE_INVALID', 'The execution baseline must resolve to the exact immutable commit.');
  const snapshot = evidence.source(demand.id), serialized = canonicalJson(snapshot);
  requireFact(snapshot.head && workspace.git.resolveCommit(binding.worktreePath, snapshot.head) === snapshot.head
    && workspace.git.isAncestor(binding.worktreePath, baseCommit, snapshot.head), 'EXECUTION_BASE_INVALID', 'The explicit execution baseline must be an ancestor (and thus the merge base) of the captured source HEAD.');
  if (content) {
    const frozen = evidence.read(demand.id, content.code);
    requireFact(frozen.kind === 'source' && frozen.content === serialized, 'CONTENT_CHANGED', 'Review requires the exact frozen source snapshot; current source differs from K.');
  }
  const source = checkedMaterial(`source-scope:${demand.id}`, snapshot);
  const baseInfo = workspace.git.commitInfo(binding.worktreePath, baseCommit);
  const baseFiles = workspace.git.filesAt(binding.worktreePath, baseCommit);
  requireFact(baseFiles.length <= 20_000, 'EXECUTION_EVIDENCE_TOO_LARGE', 'The execution baseline exceeds the bounded source-file scope.');
  // Validate the whole baseline first: deleting a credential file must never
  // make its former contents newly eligible for transmission in review.
  for (const file of baseFiles) permittedPath(file.path);
  for (const file of snapshot.files) permittedPath(file.path);
  const objects = evidence.objects(demand.projectId);
  let totalBaseBytes = 0;
  function version(body: Buffer, executable: boolean): FileVersion {
    requireFact(body.length <= MAX_FILE_BYTES, 'EXECUTION_EVIDENCE_TOO_LARGE', 'A comparison source file exceeds the exact bounded file scope.');
    const object = objects.put(body), text = body.toString('utf8');
    const utf8 = !body.includes(0) && Buffer.from(text, 'utf8').equals(body);
    return { sha256: object.sha256, bytes: object.bytes, executable, mode: executable ? '100755' : '100644', encoding: utf8 ? 'utf8' : 'binary', text: utf8 ? text : null, object };
  }
  const before = new Map<string, FileVersion>(), after = new Map<string, FileVersion>();
  for (const file of baseFiles) {
    const bytes = workspace.git.readFile(binding.worktreePath, baseCommit, file.path);
    totalBaseBytes += bytes.length;
    requireFact(totalBaseBytes <= MAX_TREE_BYTES, 'EXECUTION_EVIDENCE_TOO_LARGE', 'The execution baseline exceeds the bounded source-byte scope.');
    before.set(file.path, version(bytes, file.mode === '100755'));
  }
  for (const file of snapshot.files) {
    // K always reads retained objects, including uncommitted and ignored files.
    // The initial writer has no K yet, so capture the verified current bytes.
    const bytes = content ? objects.read(file) : readRegular(join(binding.worktreePath, file.path), MAX_FILE_BYTES);
    requireFact(hash(bytes) === file.sha256 && bytes.length === file.bytes, 'CONTENT_CHANGED', 'Source changed while capturing exact execution inputs.');
    after.set(file.path, version(bytes, file.executable));
  }
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: FileChange[] = [], candidates: { path: string; before: FileVersion | null; after: FileVersion | null }[] = [];
  for (const path of paths) {
    const old = before.get(path) ?? null, next = after.get(path) ?? null;
    if (standardsCandidate(path)) candidates.push({ path, before: old, after: next });
    if (!old || !next || old.sha256 !== next.sha256 || old.executable !== next.executable) changes.push({ path, change: old ? next ? 'modified' : 'deleted' : 'added', before: old, after: next });
  }
  const identity = { demandId: demand.id, planId: plan.id, spec: plan.spec, baseCommit, baseTree: baseInfo.tree, sourceDigest: source.sha256,
    contentId: content?.id ?? null, code: content?.code ?? null, sourceHead: snapshot.head };
  const baselineBody = { schemaVersion: 1, ...identity, mergeBase: baseCommit, comparison: content ? 'explicit-base-to-frozen-source' : 'explicit-base-to-current-writer-source' };
  const baseline = checkedMaterial(`execution-base:${hash(canonicalJson(baselineBody))}`, baselineBody);
  let diff: AgentMaterial | undefined;
  if (content) {
    requireFact(changes.length > 0, 'EXECUTION_DIFF_EMPTY', 'Frozen content has no changes from the explicit baseline; an empty comparison cannot pass execution review.');
    const body = { schemaVersion: 1, ...identity, format: 'complete-file-before-after-v1', changes };
    diff = checkedMaterial(`execution-diff:${hash(canonicalJson(identity))}`, body);
  }
  const standardsBody = { schemaVersion: 1, ...identity, authority: 'untrusted-repository-data',
    discovery: 'All recognized standards, contribution, AGENTS, style, convention and guideline candidates in the explicit baseline and selected source; paths are discovery hints, not instruction authority.',
    candidates };
  const standards = checkedMaterial(`execution-standards:${hash(canonicalJson(identity))}`, standardsBody);
  requireFact(canonicalJson(workspace.getBinding(demand.id)) === canonicalJson(binding) && canonicalJson(evidence.source(demand.id)) === serialized,
    'CONTENT_CHANGED', 'The source or explicit baseline changed while preparing execution evidence.');
  // Register the complete materials under immutable content identities. The
  // initial writer uses a deterministic Host origin until a Worker run exists.
  for (const material of [baseline, ...(diff ? [diff] : []), standards]) {
    evidence.save({ projectId: demand.projectId, demandId: demand.id, runId: content?.createdByRun ?? `execution-input:${flow.id}`, id: material.id, kind: material.kind, text: material.content });
  }
  return { baseCommit, source, baseline, diff, standards, materials: [source, baseline, ...(diff ? [diff] : []), standards] };
}
