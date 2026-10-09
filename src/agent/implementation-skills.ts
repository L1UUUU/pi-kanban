import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import type { Skill, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import type { MethodSnapshot } from '../domain/types.ts';
import { RuntimeError } from '../runtime/types.ts';
import type { AgentMaterial } from './resources.ts';
import { PINNED_IMPLEMENTATION_FILES } from './implementation-skill-lock.ts';
export { PINNED_IMPLEMENTATION_FILES, PINNED_IMPLEMENTATION_COMMIT, PINNED_IMPLEMENTATION_REPOSITORY } from './implementation-skill-lock.ts';

export const IMPLEMENTATION_SKILL_ADAPTER = 'implement-spec-staged-v1';
export const IMPLEMENTATION_SKILL_STAGES = ['ticket-implementation', 'ticket-fix', 'review-standards', 'review-spec', 'resolution-standards', 'resolution-spec'] as const;
export type ImplementationSkillStage = typeof IMPLEMENTATION_SKILL_STAGES[number];
type SkillName = 'implement-spec' | 'tdd' | 'code-review' | 'codebase-design';
export interface ImplementationResourceReference { id: string; path: string; sha256: string }
export interface ImplementationSkillMapping { name: SkillName; entryId: string; policyId: string; referenceIds: string[] }
export interface ImplementationSkillManifest {
  schemaVersion: 1; entryId: string; resources: ImplementationResourceReference[];
  skills: ImplementationSkillMapping[]; supportingIds: string[];
  overrides: { invocation: 'host-selected-stage'; destinations: 'local-execution-artifacts'; scheduling: 'host-single-writer-frontier'; review: 'fresh-readonly-axes'; approvals: 'explicit-decisions'; publication: 'forbidden' };
}
export interface ImplementationSkillBundle { manifest: ImplementationSkillManifest; manifestMaterial: AgentMaterial; materials: AgentMaterial[] }
export interface ImplementationProjectedResource extends ImplementationResourceReference { content: string }
export interface ImplementationProjectedSkill { name: SkillName; entry: ImplementationProjectedResource; policy: ImplementationProjectedResource; references: ImplementationProjectedResource[] }
/** Host-selected vocabulary access grants no design, scope or testing-seam changes. */
export interface ImplementationDesignSelection { purpose: 'reference-only' }
export interface ImplementationSkillProjection {
  schemaVersion: 1; stage: ImplementationSkillStage; manifest: { id: string; sha256: string };
  entry: ImplementationProjectedResource; entryPolicy: ImplementationProjectedResource;
  active: ImplementationProjectedSkill;
  codebaseDesign: { selection: ImplementationDesignSelection; skill: ImplementationProjectedSkill } | null;
  overrides: ImplementationSkillManifest['overrides'];
}
export interface ImplementationSkillRead { id: string; sha256: string; skillName: string; path: string }
export interface ImplementationSkillSession {
  stage: ImplementationSkillStage; projection: ImplementationSkillProjection;
  entrySkill: ImplementationSkillRead; activeSkill: ImplementationSkillRead; skills: Skill[]; initialMaterials: AgentMaterial[];
  systemInstructions: string; tools: ToolDefinition[]; hasLoadedPrimary: () => boolean;
  readSkill: (name: string) => Promise<ImplementationProjectedResource>;
  readReference: (from: string, path: string) => Promise<ImplementationProjectedResource>;
}
const skillNames: readonly SkillName[] = ['implement-spec', 'tdd', 'code-review', 'codebase-design'];
const skillReferences: Record<SkillName, string[]> = { 'implement-spec': [], tdd: ['tests.md', 'mocking.md'], 'code-review': [], 'codebase-design': ['DEEPENING.md', 'DESIGN-IT-TWICE.md'] };
const rootPath = 'skills/engineering/implement-spec/SKILL.md';
const publicId = (path: string) => `mattpocock/${path}`;
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
function fail(message: string): never { throw new RuntimeError('IMPLEMENTATION_RESOURCE_INVALID', message); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('An ordinary resource object is required.');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).sort().join(',') !== [...keys].sort().join(',')) fail('Missing or unsupported resource fields.');
  return result;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail('A bounded resource identifier is required.');
  return value;
}
function id(value: unknown): string { const result = text(value, 128); if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/.test(result)) fail('Invalid resource identifier.'); return result; }
function sha(value: unknown): string { const result = text(value, 64); if (!/^[a-f0-9]{64}$/.test(result)) fail('Every resource requires an exact lowercase SHA-256.'); return result; }
function list<T>(value: unknown, parse: (entry: unknown) => T, max = 32): T[] {
  if (!Array.isArray(value) || value.length > max) fail('A bounded explicit resource list is required.');
  return value.map(parse);
}
function unique(values: string[], label: string): void { if (new Set(values).size !== values.length) fail(`Duplicate ${label}.`); }
export function implementationResourcePath(value: unknown): string {
  const path = text(value, 1024);
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path) || path.split('/').some(part => part === '.' || part === '..' || part.endsWith('.'))) fail('Resource paths must be canonical relative portable paths.');
  return path;
}
function reference(value: unknown): ImplementationResourceReference {
  const r = record(value, ['id', 'path', 'sha256']); return { id: id(r.id), path: implementationResourcePath(r.path), sha256: sha(r.sha256) };
}
const scopedOverrides: ImplementationSkillManifest['overrides'] = {
  invocation: 'host-selected-stage', destinations: 'local-execution-artifacts', scheduling: 'host-single-writer-frontier',
  review: 'fresh-readonly-axes', approvals: 'explicit-decisions', publication: 'forbidden',
};
function overrides(value: unknown): ImplementationSkillManifest['overrides'] {
  const actual = record(value, Object.keys(scopedOverrides));
  if (Object.entries(scopedOverrides).some(([key, expected]) => actual[key] !== expected)) fail('Only the scoped execution adapter overrides are supported.');
  return { ...scopedOverrides };
}
function verifyPinned(resources: ImplementationResourceReference[]): void {
  for (const resource of resources) {
    const pinned = PINNED_IMPLEMENTATION_FILES.find(file => file.path === resource.path);
    if (!pinned || pinned.sha256 !== resource.sha256) fail('Execution resources must match the explicitly pinned upstream commit.');
  }
}
/** Explicit public graph, independent from the unchanged planning closure. */
export function createBundledImplementationManifest(entry: { id: string; sha256: string }): ImplementationSkillManifest {
  const resources = PINNED_IMPLEMENTATION_FILES.map(file => ({ id: file.path === rootPath ? entry.id : publicId(file.path), path: file.path, sha256: file.path === rootPath ? entry.sha256 : file.sha256 }));
  const skills = skillNames.map(name => {
    const root = `skills/engineering/${name}`;
    return { name, entryId: name === 'implement-spec' ? entry.id : publicId(`${root}/SKILL.md`), policyId: publicId(`${root}/agents/openai.yaml`), referenceIds: skillReferences[name].map(path => publicId(`${root}/${path}`)) };
  });
  return parseImplementationSkillManifest({ schemaVersion: 1, entryId: entry.id, resources, skills, supportingIds: ['.agents/invocation.md', 'LICENSE'].map(publicId), overrides: scopedOverrides });
}
export function parseImplementationSkillManifest(value: unknown): ImplementationSkillManifest {
  const m = record(value, ['schemaVersion', 'entryId', 'resources', 'skills', 'supportingIds', 'overrides']);
  if (m.schemaVersion !== 1) fail('Unsupported execution resource schema.');
  const entryId = id(m.entryId), resources = list(m.resources, reference);
  unique(resources.map(r => r.id), 'resource identity'); unique(resources.map(r => r.path.toLowerCase()), 'portable resource path');
  if (resources.length !== PINNED_IMPLEMENTATION_FILES.length) fail('The complete pinned execution dependency closure is required.');
  verifyPinned(resources);
  for (const r of resources) if (r.id !== (r.path === rootPath ? entryId : publicId(r.path)) || r.id === `${entryId}:skill-bundle`) fail('Resource identity does not match its pinned ownership.');
  const skills = list(m.skills, value => {
    const s = record(value, ['name', 'entryId', 'policyId', 'referenceIds']);
    if (!skillNames.includes(s.name as SkillName)) fail('Only explicitly mapped execution skills are supported.');
    return { name: s.name as SkillName, entryId: id(s.entryId), policyId: id(s.policyId), referenceIds: list(s.referenceIds, id).sort() };
  }, 4);
  if (skills.length !== skillNames.length) fail('All four execution skill dependencies are required.');
  unique(skills.map(s => s.name), 'skill name');
  const supportingIds = list(m.supportingIds, id).sort(), owned = [...supportingIds, ...skills.flatMap(s => [s.entryId, s.policyId, ...s.referenceIds])];
  unique(owned, 'resource ownership');
  if (owned.length !== resources.length || owned.some(name => !resources.some(r => r.id === name))) fail('Every resource must be explicitly mapped once.');
  if (JSON.stringify(supportingIds) !== JSON.stringify(['.agents/invocation.md', 'LICENSE'].map(publicId).sort())) fail('Pinned invocation policy and MIT license are required.');
  for (const skill of skills) {
    const root = `skills/engineering/${skill.name}`;
    if (skill.entryId !== (skill.name === 'implement-spec' ? entryId : publicId(`${root}/SKILL.md`)) || skill.policyId !== publicId(`${root}/agents/openai.yaml`) || JSON.stringify(skill.referenceIds) !== JSON.stringify(skillReferences[skill.name].map(path => publicId(`${root}/${path}`)).sort())) fail('Each skill must own its exact pinned entry, policy and reference closure.');
  }
  return { schemaVersion: 1, entryId, resources: resources.sort((a, b) => a.id.localeCompare(b.id)), skills: skills.sort((a, b) => a.name.localeCompare(b.name)), supportingIds, overrides: overrides(m.overrides) };
}
export function implementationManifestMaterial(methodId: string, manifest: ImplementationSkillManifest): AgentMaterial {
  const parsed = parseImplementationSkillManifest(manifest);
  if (parsed.entryId !== methodId) fail('Execution manifest must name the configured implement-spec method.');
  const content = JSON.stringify(parsed);
  return { id: `${methodId}:skill-bundle`, kind: 'method', sha256: hash(content), content };
}
export function implementationBundleDigest(methodId: string, version: string, manifest: ImplementationSkillManifest): string {
  const parsed = parseImplementationSkillManifest(manifest), entry = parsed.resources.find(r => r.id === methodId);
  if (!entry || parsed.entryId !== methodId) fail('Execution digest requires the implement-spec entry identity.');
  return hash(JSON.stringify({ id: methodId, logicalName: 'implement-spec', version, adapter: IMPLEMENTATION_SKILL_ADAPTER, skillBundle: parsed,
    files: [{ id: entry.id, sha256: entry.sha256 }, ...parsed.resources.filter(r => r.id !== methodId).map(r => ({ id: r.id, sha256: r.sha256 })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)] }));
}
function checkedMaterial(material: AgentMaterial): void {
  if (material.kind !== 'method' || typeof material.content !== 'string' || !material.content.trim() || material.content.includes('\0') || Buffer.byteLength(material.content) > 1024 * 1024 || hash(material.content) !== material.sha256) fail('Execution material is missing, oversized or changed.');
}
function skillMetadata(skill: ImplementationProjectedSkill): Skill {
  let frontmatter: Record<string, unknown>;
  try { frontmatter = parseFrontmatter<Record<string, unknown>>(skill.entry.content).frontmatter; } catch { return fail('Skill frontmatter must be valid.'); }
  if (frontmatter.name !== skill.name || typeof frontmatter.description !== 'string' || !frontmatter.description.trim() || frontmatter.description.length > 1024 || (frontmatter['disable-model-invocation'] !== undefined && typeof frontmatter['disable-model-invocation'] !== 'boolean')) fail('Skill name, description or invocation metadata is invalid.');
  const disabled = frontmatter['disable-model-invocation'] === true, implicit = skill.policy.content.match(/^\s+allow_implicit_invocation:\s*(true|false)\s*$/m)?.[1];
  if ((disabled && implicit !== 'false') || (!disabled && implicit === 'false')) fail('Original invocation restrictions must agree across skill and policy.');
  const filePath = `controlled-skill:${skill.entry.path}`, baseDir = `controlled-skill:${posix.dirname(skill.entry.path)}`;
  return { name: skill.name, description: frontmatter.description, filePath, baseDir, disableModelInvocation: disabled,
    sourceInfo: { path: filePath, source: 'digest-locked-implementation', scope: 'temporary', origin: 'top-level', baseDir } };
}
function resolveReference(root: string, from: string, value: string): string {
  implementationResourcePath(from);
  if (typeof value !== 'string' || !value || value.length > 1024 || !/^(?:\.\.?\/)*[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) || value.split('/').some(part => part !== '.' && part !== '..' && part.endsWith('.'))) fail('Only safe relative references are supported; remote and absolute resources are denied.');
  const resolved = posix.normalize(posix.join(posix.dirname(from), value));
  if (!resolved.startsWith(`${root}/`)) fail('Reference escapes its owning skill.');
  return implementationResourcePath(resolved);
}
function markdownReferences(content: string): string[] {
  const result: string[] = [];
  for (const match of content.matchAll(/\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"\n]*")?\)/g)) if (!match[1]!.startsWith('#')) result.push(match[1]!.replace(/#.*$/, ''));
  return result;
}
function stageSkill(stage: ImplementationSkillStage): 'tdd' | 'code-review' { return stage === 'ticket-implementation' || stage === 'ticket-fix' ? 'tdd' : 'code-review'; }
/** Frozen bytes only: restart and review never consult the current vendor directory. */
export function resolveImplementationBundle(snapshot: MethodSnapshot, input: readonly AgentMaterial[]): ImplementationSkillBundle {
  if (snapshot.adapter !== IMPLEMENTATION_SKILL_ADAPTER) fail('The selected method has no implement-spec staged adapter.');
  const materials = structuredClone(input) as AgentMaterial[];
  unique(materials.map(m => m.id), 'frozen material identity'); materials.forEach(checkedMaterial);
  const manifestMaterial = materials.find(m => m.id === `${snapshot.id}:skill-bundle`);
  if (!manifestMaterial || !snapshot.dependencies?.includes(`${manifestMaterial.id}@${manifestMaterial.sha256}`)) fail('The frozen snapshot must pin the explicit resource manifest.');
  let raw: unknown; try { raw = JSON.parse(manifestMaterial.content); } catch { return fail('Execution resource manifest is not JSON.'); }
  const manifest = parseImplementationSkillManifest(raw);
  if (manifest.entryId !== snapshot.id || JSON.stringify(manifest) !== manifestMaterial.content) fail('The frozen resource manifest is not canonical or names a different entry.');
  if (implementationBundleDigest(snapshot.id, snapshot.version, manifest) !== snapshot.digest) fail('The frozen method digest does not bind this resource graph.');
  if (materials.length !== manifest.resources.length + 1) fail('Frozen material closure is incomplete or includes unlisted data.');
  for (const resource of manifest.resources) if (!materials.some(m => m.id === resource.id && m.sha256 === resource.sha256)) fail('Every dependency must be present and digest-locked.');
  const expected = [...manifest.resources.filter(r => r.id !== snapshot.id).map(r => `${r.id}@${r.sha256}`), `${manifestMaterial.id}@${manifestMaterial.sha256}`].sort();
  if (JSON.stringify([...(snapshot.dependencies ?? [])].sort()) !== JSON.stringify(expected)) fail('Snapshot dependency closure differs from the resource manifest.');
  const bundle = { manifest, manifestMaterial, materials };
  for (const stage of IMPLEMENTATION_SKILL_STAGES) validateProjection(projectImplementationSkillBundle(bundle, stage));
  return bundle;
}
export function projectImplementationSkillBundle(bundle: ImplementationSkillBundle, stage: ImplementationSkillStage, options: { codebaseDesign?: ImplementationDesignSelection } = {}): ImplementationSkillProjection {
  if (!IMPLEMENTATION_SKILL_STAGES.includes(stage)) fail('Unknown execution stage.');
  const get = (resourceId: string): ImplementationProjectedResource => {
    const ref = bundle.manifest.resources.find(r => r.id === resourceId), material = bundle.materials.find(m => m.id === resourceId);
    if (!ref || !material || ref.sha256 !== material.sha256) return fail('Missing or changed projected resource.');
    checkedMaterial(material); return { ...ref, content: material.content };
  };
  const skill = (name: SkillName): ImplementationProjectedSkill => {
    const mapping = bundle.manifest.skills.find(s => s.name === name);
    if (!mapping) return fail('The selected skill is not mapped.');
    return { name, entry: get(mapping.entryId), policy: get(mapping.policyId), references: mapping.referenceIds.map(get) };
  };
  const root = skill('implement-spec');
  return validateProjection({ schemaVersion: 1, stage, manifest: { id: bundle.manifestMaterial.id, sha256: bundle.manifestMaterial.sha256 }, entry: root.entry, entryPolicy: root.policy,
    active: skill(stageSkill(stage)), codebaseDesign: options.codebaseDesign ? { selection: options.codebaseDesign, skill: skill('codebase-design') } : null, overrides: bundle.manifest.overrides });
}
function projectedResource(value: unknown): ImplementationProjectedResource {
  const r = record(value, ['id', 'path', 'sha256', 'content']), ref = reference({ id: r.id, path: r.path, sha256: r.sha256 });
  const material: AgentMaterial = { id: ref.id, kind: 'method', sha256: ref.sha256, content: r.content as string }; checkedMaterial(material);
  verifyPinned([ref]); return { ...ref, content: material.content };
}
function projectedSkill(value: unknown, expected: SkillName, entryId: string): ImplementationProjectedSkill {
  const s = record(value, ['name', 'entry', 'policy', 'references']);
  if (s.name !== expected) fail('A stage cannot load another stage skill.');
  const skill = { name: expected, entry: projectedResource(s.entry), policy: projectedResource(s.policy), references: list(s.references, projectedResource) };
  const root = `skills/engineering/${expected}`, resources = [skill.entry, skill.policy, ...skill.references];
  unique(resources.map(r => r.id), 'projected resource'); unique(resources.map(r => r.path.toLowerCase()), 'projected path');
  if (skill.entry.path !== `${root}/SKILL.md` || skill.policy.path !== `${root}/agents/openai.yaml` || JSON.stringify(skill.references.map(r => r.path).sort()) !== JSON.stringify(skillReferences[expected].map(path => `${root}/${path}`).sort())) fail('Projected resources must belong only to the selected skill and include its exact references.');
  for (const r of resources) if (r.id !== (r.path === rootPath ? entryId : publicId(r.path))) fail('Projected resource identity differs from pinned ownership.');
  for (const resource of [skill.entry, ...skill.references]) for (const link of markdownReferences(resource.content)) {
    const target = resolveReference(root, resource.path, link);
    if (![skill.entry, ...skill.references].some(r => r.path === target)) fail('Missing explicitly pinned relative reference.');
  }
  skillMetadata(skill); return skill;
}
function validateProjection(value: unknown): ImplementationSkillProjection {
  const p = record(value, ['schemaVersion', 'stage', 'manifest', 'entry', 'entryPolicy', 'active', 'codebaseDesign', 'overrides']);
  if (p.schemaVersion !== 1 || !IMPLEMENTATION_SKILL_STAGES.includes(p.stage as ImplementationSkillStage)) fail('Unknown execution projection stage.');
  const stage = p.stage as ImplementationSkillStage, entry = projectedResource(p.entry), manifest = record(p.manifest, ['id', 'sha256']);
  const root = projectedSkill({ name: 'implement-spec', entry, policy: p.entryPolicy, references: [] }, 'implement-spec', entry.id);
  const expectedManifest = implementationManifestMaterial(entry.id, createBundledImplementationManifest(entry));
  if (id(manifest.id) !== expectedManifest.id || sha(manifest.sha256) !== expectedManifest.sha256) fail('Projected manifest does not bind the exact execution closure.');
  let codebaseDesign: ImplementationSkillProjection['codebaseDesign'] = null;
  if (p.codebaseDesign !== null) {
    if (stageSkill(stage) !== 'tdd') fail('Read-only review stages cannot acquire conditional design resources.');
    const conditional = record(p.codebaseDesign, ['selection', 'skill']), selection = record(conditional.selection, ['purpose']);
    if (selection.purpose !== 'reference-only') fail('Conditional design must be explicitly Host-selected for reference-only consultation.');
    codebaseDesign = { selection: { purpose: 'reference-only' }, skill: projectedSkill(conditional.skill, 'codebase-design', entry.id) };
  }
  return structuredClone({ schemaVersion: 1, stage, manifest: { id: expectedManifest.id, sha256: expectedManifest.sha256 }, entry: root.entry, entryPolicy: root.policy,
    active: projectedSkill(p.active, stageSkill(stage), entry.id), codebaseDesign, overrides: overrides(p.overrides) });
}
/** Read tools only. Audit must commit before any original bytes are released. */
export function createImplementationSkillSession(input: ImplementationSkillProjection, options: { onRead?: (reference: ImplementationSkillRead) => Promise<void> } = {}): ImplementationSkillSession {
  const projection = validateProjection(structuredClone(input)), loaded = new Set<string>();
  const root: ImplementationProjectedSkill = { name: 'implement-spec', entry: projection.entry, policy: projection.entryPolicy, references: [] };
  const selected = [root, projection.active, ...(projection.codebaseDesign ? [projection.codebaseDesign.skill] : [])];
  const readIdentity = (skill: ImplementationProjectedSkill, resource = skill.entry): ImplementationSkillRead => ({ id: resource.id, sha256: resource.sha256, skillName: skill.name, path: resource.path });
  const entrySkill = readIdentity(root), activeSkill = readIdentity(projection.active);
  const release = async (skill: ImplementationProjectedSkill, resource: ImplementationProjectedResource) => {
    await options.onRead?.(readIdentity(skill, resource)); loaded.add(resource.id); return structuredClone(resource);
  };
  const readSkill = async (name: string) => {
    const skill = selected.find(s => s.name === name);
    if (!skill) return fail('Only the Host-selected root and stage skills can be invoked.');
    if (name !== root.name && !loaded.has(root.entry.id)) return fail('Read implement-spec before its selected stage dependency.');
    if (name === 'codebase-design' && !loaded.has(projection.active.entry.id)) return fail('Read the active TDD skill before the selected design reference.');
    return release(skill, skill.entry);
  };
  const readReference = async (from: string, path: string) => {
    const skill = selected.find(s => [s.entry, ...s.references].some(r => r.path === from)), source = skill && [skill.entry, ...skill.references].find(r => r.path === from);
    if (!skill || !source || !loaded.has(source.id)) return fail('Read the owning skill or reference before following its links.');
    const root = posix.dirname(skill.entry.path), resolved = resolveReference(root, from, path);
    if (!markdownReferences(source.content).some(link => resolveReference(root, from, link) === resolved)) return fail('Only declared links from a loaded resource may be followed.');
    const resource = [skill.entry, ...skill.references].find(r => r.path === resolved);
    if (!resource) return fail('Reference is not pinned in the selected skill.');
    return release(skill, resource);
  };
  const result = (resource: ImplementationProjectedResource) => ({ content: [{ type: 'text' as const, text: resource.content }], details: readIdentity(selected.find(s => [s.entry, ...s.references].some(r => r.id === resource.id))!, resource) });
  const tools: ToolDefinition[] = [
    { name: 'controlled_skill', label: 'Load selected execution skill', description: `Load implement-spec first, then ${projection.active.name} for this Host-selected stage. Upstream Skill calls use this tool; no implicit cross-stage invocation.`, parameters: Type.Object({ name: Type.String() }, { additionalProperties: false }), async execute(_id, params) { const p = record(params, ['name']); return result(await readSkill(text(p.name, 64))); } },
    { name: 'controlled_skill_resource', label: 'Read pinned skill reference', description: 'Follow a declared relative link from an already loaded selected skill. Use its portable path as from; no filesystem, remote or cross-skill reads.', parameters: Type.Object({ from: Type.String(), path: Type.String() }, { additionalProperties: false }), async execute(_id, params) { const p = record(params, ['from', 'path']); return result(await readReference(text(p.from, 1024), text(p.path, 1024))); } },
  ];
  return { stage: projection.stage, projection: structuredClone(projection), entrySkill, activeSkill, skills: selected.map(skillMetadata), initialMaterials: [], tools, readSkill, readReference,
    hasLoadedPrimary: () => loaded.has(root.entry.id) && loaded.has(projection.active.entry.id),
    systemInstructions: `Execution stage: ${projection.stage}. The Host explicitly selected implement-spec as the root for both implementation and Review. Before any stage report, call controlled_skill with name "implement-spec", then with name "${projection.active.name}", and apply both exact original skills. Upstream Skill calls mean controlled_skill; declared relative links use controlled_skill_resource with the returned portable path as from.\nScoped project adapter overrides (separate from unchanged upstream originals): Host-selected invocation applies only to this approved stage, including the otherwise user-invoked implement-spec root. It grants no model, budget, data disclosure or additional tool authority. The Host owns the dependency-ready ticket frontier, one active writer and local integration lifecycle; upstream parallel implementers/worktrees/mergers are serialized behind that Host gate. Workers cannot dispatch extra agents, create unmanaged worktrees, reset branches or accept their own results. All outcomes are local versioned Host execution artifacts. External tracker setup, issue transitions, pushes, PR creation, ready-for-review publication and cleanup outside Host control are forbidden. Apply TDD red then green at previously approved public test seams. Only a Host-verified standards-only repair that preserves behavior and has no failed-check or spec obligations may use preserve-behavior mode with an explicit rationale, no red receipts and actual nonempty green check receipts; do not manufacture a failing test for pure refactoring. Preserve valid approvals and report any new scope, seam or behavior decision for explicit approval. Refactoring belongs to the review/fix cycle. Codebase-design is a vocabulary reference within the pinned closure and is available only when explicitly selected by the Host for this writer stage. Consulting it requires no new user decision and grants no permission to change scope, behavior or test seams, or to dispatch more agents. ${projection.codebaseDesign ? 'The Host selected codebase-design for reference-only consultation; load it only after TDD when its vocabulary is needed. Optional design alternatives do not authorize more agents or changed scope.' : 'No conditional design reference is selected.'} Only after the ticket graph is complete, run whole-spec review as separate fresh read-only standards and spec contexts bound to the same fixed point, content and frozen spec. Then use one Host-authorized writer to fix all accepted findings, followed by focused independent resolution on those findings; do not start broad review after every ticket or fix. Apply only this stage\'s axis, preserve repo-standard precedence and labelled smell judgements, and report source evidence without merging or reranking axes. The Host aggregates the axes and controls acceptance. Findings and resolution assessments never write code; approved fixes run in a separate writer stage.`,
  };
}
