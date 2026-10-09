import { createHash } from 'node:crypto';
import { readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ArtifactRef, MethodSnapshot, PlanInput, ReportVerification, RunAttempt, WorkerReport } from '../domain/types.ts';
import type { AgentMaterial } from '../agent/resources.ts';
import { ImmutableObjectStore, canonicalJson } from '../workspace/index.ts';
import type { WorkspaceService } from '../workspace/index.ts';
import { canonicalDirectory, noLinks, readRegular, sourcePath } from '../workspace/paths.ts';
import { RuntimeError } from '../runtime/types.ts';

export const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
/** Scope, required checks and unresolved questions are part of P, even when a
 * Worker forgets to repeat them in the prose spec or ticket artifacts. */
export function planMaterial(plan: PlanInput): AgentMaterial {
  const content = canonicalJson({ id: plan.id, scope: plan.scope, spec: plan.spec, tickets: plan.tickets, requiredChecks: plan.requiredChecks, unresolvedQuestions: plan.unresolvedQuestions });
  return { id: `plan-scope:${plan.id}`, kind: 'plan', sha256: hash(content), content };
}
export interface SourceSnapshot {
  schemaVersion: 1; demandId: string; head: string | null;
  changes: string[];
  files: { path: string; sha256: string; bytes: number; executable: boolean }[];
}
export interface StoredArtifact {
  ref: ArtifactRef; projectId: string; demandId: string; kind: AgentMaterial['kind']; runId: string; bytes: number;
}
function requireFact(value: unknown, code: string, message: string): asserts value { if (!value) throw new RuntimeError(code, message); }
/** Host-only immutable registry. Worker locations never become filesystem paths. */
export class ProductionEvidence {
  readonly db: DatabaseSync; readonly workspace: () => WorkspaceService;
  constructor(db: DatabaseSync, workspace: () => WorkspaceService) {
    this.db = db; this.workspace = workspace;
    db.exec(`CREATE TABLE IF NOT EXISTS host_frozen_method_materials(digest TEXT PRIMARY KEY,snapshot TEXT NOT NULL,materials TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_artifacts(id TEXT NOT NULL,demand_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,demand_id));
      CREATE TABLE IF NOT EXISTS host_run_evidence(run_id TEXT PRIMARY KEY,body TEXT NOT NULL);`);
  }
  freezeMethod(snapshot: MethodSnapshot, materials: AgentMaterial[]): void {
    requireFact(materials.length && materials.every(m => m.kind === 'method' && hash(m.content) === m.sha256), 'METHOD_UNVERIFIED', 'Method content must match every locked body digest.');
    const values = [canonicalJson(snapshot), canonicalJson(materials)];
    const prior = this.db.prepare('SELECT snapshot,materials FROM host_frozen_method_materials WHERE digest=?').get(snapshot.digest);
    if (prior) { requireFact(prior.snapshot === values[0] && prior.materials === values[1], 'METHOD_CONFLICT', 'Frozen method identity was reused for different materials.'); return; }
    this.db.prepare('INSERT INTO host_frozen_method_materials VALUES(?,?,?)').run(snapshot.digest, ...values);
  }
  method(snapshot: MethodSnapshot): AgentMaterial[] {
    const row = this.db.prepare('SELECT snapshot,materials FROM host_frozen_method_materials WHERE digest=?').get(snapshot.digest);
    requireFact(row && row.snapshot === canonicalJson(snapshot), 'METHOD_SNAPSHOT_MISSING', 'The exact demand-frozen method and dependencies have not been retained.');
    const materials = JSON.parse(String(row.materials)) as AgentMaterial[];
    requireFact(materials.length && materials.every(m => m.kind === 'method' && hash(m.content) === m.sha256), 'METHOD_CHANGED', 'Frozen method material integrity failed.');
    return materials;
  }
  objects(projectId: string): ImmutableObjectStore {
    return ImmutableObjectStore.open(this.workspace().getProject(projectId).anchorPath, projectId);
  }
  save(input: { id: string; projectId: string; demandId: string; runId: string; kind: AgentMaterial['kind']; text: string }): ArtifactRef {
    requireFact(typeof input.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,199}$/.test(input.id) && typeof input.text === 'string' && Buffer.byteLength(input.text) <= 1024 * 1024, 'ARTIFACT_INVALID', 'A bounded named UTF-8 artifact is required.');
    const object = this.objects(input.projectId).put(input.text);
    const ref = { id: input.id, digest: object.sha256, location: `pi-object:${object.sha256}:${object.bytes}` };
    const artifact: StoredArtifact = { ref, projectId: input.projectId, demandId: input.demandId, kind: input.kind, runId: input.runId, bytes: object.bytes };
    const prior = this.db.prepare('SELECT body FROM host_artifacts WHERE id=? AND demand_id=?').get(input.id, input.demandId);
    if (prior) { const existing = JSON.parse(String(prior.body)) as StoredArtifact; requireFact(canonicalJson(existing.ref) === canonicalJson(ref) && existing.projectId === input.projectId && existing.kind === input.kind, 'ARTIFACT_CONFLICT', 'An immutable artifact ID cannot change content or kind.'); return existing.ref; }
    this.db.prepare('INSERT INTO host_artifacts VALUES(?,?,?)').run(input.id, input.demandId, canonicalJson(artifact));
    return ref;
  }
  reference(demandId: string, id: string): ArtifactRef {
    const row = this.db.prepare('SELECT body FROM host_artifacts WHERE id=? AND demand_id=?').get(id, demandId);
    requireFact(row, 'ARTIFACT_MISSING', 'The exact demand-owned artifact is not registered.');
    const artifact = JSON.parse(String(row.body)) as StoredArtifact; this.read(demandId, artifact.ref); return artifact.ref;
  }
  requireOrigin(demandId: string, ref: ArtifactRef, runId: string): void {
    this.read(demandId, ref);
    const row = this.db.prepare('SELECT body FROM host_artifacts WHERE id=? AND demand_id=?').get(ref.id, demandId)!;
    requireFact((JSON.parse(String(row.body)) as StoredArtifact).runId === runId, 'ARTIFACT_ORIGIN_MISMATCH', 'This evidence was not produced by the exact observed run.');
  }
  read(demandId: string, ref: ArtifactRef): AgentMaterial {
    const row = this.db.prepare('SELECT body FROM host_artifacts WHERE id=? AND demand_id=?').get(ref.id, demandId);
    requireFact(row, 'ARTIFACT_MISSING', 'The exact demand-owned artifact is not registered.');
    const artifact = JSON.parse(String(row.body)) as StoredArtifact;
    requireFact(canonicalJson(artifact.ref) === canonicalJson(ref), 'ARTIFACT_CHANGED', 'Artifact location and digest must match the immutable Host registry.');
    const content = this.objects(artifact.projectId).read({ sha256: ref.digest, bytes: artifact.bytes }).toString('utf8');
    requireFact(hash(content) === ref.digest, 'ARTIFACT_ENCODING', 'Artifact must be exact UTF-8.');
    return { id: ref.id, kind: artifact.kind, sha256: ref.digest, content };
  }
  /** Full source commitment, excluding only explicitly denied Host/Git directories.
   * No symbolic links, devices, oversized trees, or hidden implicit source lookup. */
  source(demandId: string): SourceSnapshot {
    const workspace = this.workspace(), binding = workspace.getBinding(demandId);
    requireFact(binding, 'WORKSPACE_MISSING', 'Prepare the dedicated demand worktree first.');
    const root = canonicalDirectory(binding.worktreePath);
    const inspection = workspace.inspectContent({ demandId, expectedCommit: binding.head });
    const files: SourceSnapshot['files'] = []; let bytes = 0; let entries = 0;
    const walk = (folder: string, prefix: string): void => {
      for (const name of readdirSync(folder).sort()) {
        requireFact(++entries <= 20_000, 'SOURCE_TOO_LARGE', 'Source scope exceeds 20,000 entries.');
        if (name.toLowerCase() === '.git' || name.toLowerCase() === '.local') {
          requireFact(prefix === '', 'NESTED_PRIVATE_PATH', 'Nested .git/.local trees are not covered by the root-only native deny scope; remove them from the permitted project before execution.');
          continue;
        }
        const sensitive = /^(?:\.aws|\.ssh|\.gnupg|\.azure|\.kube|\.netrc|\.npmrc|\.pypirc|\.envrc|auth\.json|credentials(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\.(?:json|txt|yaml|yml))?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i.test(name) || (/^\.env(?:\..*)?$/i.test(name) && !/^\.env\.(?:example|template|sample)$/i.test(name)) || /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(name) || /service[-_]?account.*\.json$/i.test(name);
        requireFact(!sensitive, 'SOURCE_SENSITIVE_PATH', 'The worktree contains a known credential-sensitive filename. Supply a permitted sanitized project before granting Worker read access; filename checks do not detect all secrets.');
        const relative = prefix ? `${prefix}/${name}` : name; sourcePath(relative);
        const file = join(folder, name); noLinks(file); const stat = lstatSync(file);
        if (stat.isDirectory()) walk(file, relative);
        else {
          requireFact(stat.isFile() && stat.nlink === 1, 'SOURCE_UNSAFE', 'Source must contain ordinary non-linked files only.');
          const body = readRegular(file, 1024 * 1024); bytes += body.length;
          requireFact(bytes <= 32 * 1024 * 1024, 'SOURCE_TOO_LARGE', 'Source data exceeds the 32 MiB run scope.');
          files.push({ path: relative, sha256: hash(body), bytes: body.length, executable: process.platform !== 'win32' && (stat.mode & 0o111) !== 0 });
        }
      }
    };
    walk(root, ''); return { schemaVersion: 1, demandId, head: inspection.head, changes: inspection.changes, files };
  }
  sourceMaterial(demandId: string): AgentMaterial {
    const content = canonicalJson(this.source(demandId)); return { id: `source-scope:${demandId}`, kind: 'source', sha256: hash(content), content };
  }
  saveSource(projectId: string, demandId: string, runId: string, id: string): ArtifactRef {
    const first = this.source(demandId), second = this.source(demandId);
    requireFact(canonicalJson(first) === canonicalJson(second), 'CONTENT_CHANGED', 'Source changed during Host snapshotting.');
    // Preserve each exact byte object, not just hashes pointing at mutable source.
    const binding = this.workspace().getBinding(demandId)!;
    for (const file of second.files) {
      const body = readRegular(join(binding.worktreePath, file.path));
      requireFact(hash(body) === file.sha256, 'CONTENT_CHANGED', 'Source changed during immutable object capture.');
      this.objects(projectId).put(body);
    }
    requireFact(canonicalJson(this.source(demandId)) === canonicalJson(second), 'CONTENT_CHANGED', 'Source changed after immutable object capture.');
    return this.save({ projectId, demandId, runId, id, kind: 'source', text: canonicalJson(second) });
  }
  stable(demandId: string, code: ArtifactRef): boolean {
    try { const material = this.read(demandId, code); return material.kind === 'source' && material.content === canonicalJson(this.source(demandId)); } catch { return false; }
  }
  recordRun(run: RunAttempt, value: { materials: AgentMaterial[]; source: AgentMaterial; role: string; sessionId: string; runtimeRunId: string; generation: string }): void {
    const body = canonicalJson({ ...value, domainRunId: run.id, contextId: run.contextId });
    const prior = this.db.prepare('SELECT body FROM host_run_evidence WHERE run_id=?').get(run.id);
    requireFact(!prior || prior.body === body, 'CONTEXT_CHANGED', 'Run context cannot be silently replaced.');
    if (!prior) this.db.prepare('INSERT INTO host_run_evidence VALUES(?,?)').run(run.id, body);
  }
  verification(report: WorkerReport, run: RunAttempt, stopped: boolean): ReportVerification {
    const refs: ArtifactRef[] = [];
    if (report.type === 'plan-draft') refs.push(report.plan.spec, report.plan.tickets);
    if (report.type === 'content-ready') refs.push(report.content.code, ...report.content.knowledge);
    if (report.type === 'check') refs.push(report.check.evidence);
    if (['review', 'dispute', 'resolve-finding'].includes(report.type)) refs.push((report as { evidence: ArtifactRef }).evidence);
    for (const ref of refs) this.read(run.demandId, ref);
    const artifactsVerified = refs.length > 0;
    const result: ReportVerification = { artifactsVerified };
    if (report.type === 'content-ready') result.contentStable = stopped && this.stable(run.demandId, report.content.code);
    if (report.type === 'review' || report.type === 'resolve-finding') {
      const row = this.db.prepare('SELECT body FROM host_run_evidence WHERE run_id=?').get(run.id);
      if (row) {
        const context = JSON.parse(String(row.body)) as { role: string; materials: AgentMaterial[]; source: AgentMaterial; contextId: string };
        const source = this.sourceMaterial(run.demandId);
        result.reviewInputsVerified = stopped && context.role === 'review' && context.contextId === run.contextId && context.source.sha256 === source.sha256 &&
          context.materials.every(m => hash(m.content) === m.sha256 && !['implementation-session', 'implementation-summary'].includes(m.kind)) &&
          run.contextSources.every(id => context.materials.some(m => m.id === id)) &&
          this.method(run.method).every(method => context.materials.some(m => canonicalJson(m) === canonicalJson(method)));
      }
    }
    // plan-ready intentionally receives no boundaryReview attestation here. Only
    // an independently observed reviewer can add it; a Worker flag is never proof.
    return result;
  }
}
