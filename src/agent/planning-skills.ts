import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import type { Skill, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import type { MethodSnapshot } from '../domain/types.ts';
import { RuntimeError } from '../runtime/types.ts';
import type { AgentMaterial } from './resources.ts';
import { PINNED_PLANNING_FILES } from './planning-skill-lock.ts';
export { PINNED_PLANNING_FILES, PINNED_PLANNING_COMMIT, PINNED_PLANNING_REPOSITORY } from './planning-skill-lock.ts';

export const PLANNING_SKILL_ADAPTER = 'design-feature-staged-v1';
export const PLANNING_SKILL_STAGES = ['facts', 'clarification', 'design', 'design-review', 'design-resolution', 'spec', 'tickets'] as const;
export type PlanningSkillStage = typeof PLANNING_SKILL_STAGES[number];
type SkillStage = 'clarification' | 'design' | 'spec' | 'tickets';
export interface PlanningResourceReference { id: string; path: string; sha256: string }
export interface PlanningSkillMapping {
  name: string; stage: SkillStage; entryId: string; policyId: string; referenceIds: string[];
}
/** Portable names are a closed resource graph, never filesystem discovery instructions. */
export interface PlanningSkillManifest {
  schemaVersion: 1; entryId: string; resources: PlanningResourceReference[];
  skills: PlanningSkillMapping[]; supportingIds: string[];
  overrides: { invocation: 'host-selected-stage'; destinations: 'local-plan-artifacts'; technicalTicketSplit: 'agent-owned' };
}
export interface PlanningSkillBundle {
  manifest: PlanningSkillManifest; manifestMaterial: AgentMaterial; materials: AgentMaterial[];
}
export interface PlanningProjectedResource extends PlanningResourceReference { content: string }
export interface PlanningSkillProjection {
  schemaVersion: 1; stage: PlanningSkillStage; manifest: { id: string; sha256: string };
  entry: PlanningProjectedResource;
  active: { name: string; entry: PlanningProjectedResource; policy: PlanningProjectedResource | null; references: PlanningProjectedResource[] };
  overrides: PlanningSkillManifest['overrides'];
}
export interface PlanningSkillRead { id: string; sha256: string; skillName: string; path: string }
export interface PlanningSkillSession {
  stage: PlanningSkillStage; projection: PlanningSkillProjection; activeSkill: PlanningSkillRead; skills: Skill[]; initialMaterials: AgentMaterial[];
  systemInstructions: string; tools: ToolDefinition[]; hasLoadedPrimary: () => boolean;
  readSkill: (name: string) => Promise<PlanningProjectedResource>;
  readReference: (from: string, path: string) => Promise<PlanningProjectedResource>;
}
const requiredSkills: Record<SkillStage, string> = { clarification: 'grilling', design: 'codebase-design', spec: 'to-spec', tickets: 'to-tickets' };
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
function fail(message: string): never { throw new RuntimeError('PLANNING_RESOURCE_INVALID', message); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('An ordinary resource object is required.');
  const o = value as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== [...keys].sort().join(',')) fail('Missing or unsupported resource fields.');
  return o;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail('A bounded resource identifier is required.');
  return value as string;
}
function id(value: unknown): string { const result = text(value, 128); if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/.test(result)) fail('Invalid resource identifier.'); return result; }
function sha(value: unknown): string { const result = text(value, 64); if (!/^[a-f0-9]{64}$/.test(result)) fail('Every resource requires an exact lowercase SHA-256.'); return result; }
function list<T>(value: unknown, parse: (entry: unknown) => T, max = 64): T[] {
  if (!Array.isArray(value) || value.length > max) fail('A bounded explicit resource list is required.');
  return (value as unknown[]).map(parse);
}
function unique(values: string[], label: string) { if (new Set(values).size !== values.length) fail(`Duplicate ${label}.`); }
/** Cross-platform path grammar rejects URL schemes, drive/UNC paths, streams and encoded aliases. */
export function planningResourcePath(value: unknown): string {
  const path = text(value, 1024);
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path) || path.split('/').some(part => part === '.' || part === '..') || path.split('/').some(part => part.endsWith('.'))) fail('Resource paths must be canonical relative portable paths.');
  return path;
}
function resourceReference(value: unknown): PlanningResourceReference {
  const o = record(value, ['id', 'path', 'sha256']); return { id: id(o.id), path: planningResourcePath(o.path), sha256: sha(o.sha256) };
}
function overrides(value: unknown): PlanningSkillManifest['overrides'] {
  const o = record(value, ['invocation', 'destinations', 'technicalTicketSplit']);
  if (o.invocation !== 'host-selected-stage' || o.destinations !== 'local-plan-artifacts' || o.technicalTicketSplit !== 'agent-owned') fail('Only the scoped planning adapter overrides are supported.');
  return { invocation: 'host-selected-stage', destinations: 'local-plan-artifacts', technicalTicketSplit: 'agent-owned' };
}
/** Construct explicit references; this never reads a directory or copies the private method. */
export function createBundledPlanningManifest(entry: { id: string; sha256: string }): PlanningSkillManifest {
  const publicId = (path: string) => `mattpocock/${path}`;
  const resources = [{ id: entry.id, path: 'private/design-feature/SKILL.md', sha256: entry.sha256 }, ...PINNED_PLANNING_FILES.map(file => ({ id: publicId(file.path), path: file.path, sha256: file.sha256 }))];
  const skills = Object.entries(requiredSkills).map(([stage, name]) => {
    const root = `skills/${name === 'grilling' ? 'productivity' : 'engineering'}/${name}`;
    return { name, stage: stage as SkillStage, entryId: publicId(`${root}/SKILL.md`), policyId: publicId(`${root}/agents/openai.yaml`), referenceIds: name === 'codebase-design' ? ['DEEPENING.md', 'DESIGN-IT-TWICE.md'].map(path => publicId(`${root}/${path}`)) : [] };
  });
  return parsePlanningSkillManifest({ schemaVersion: 1, entryId: entry.id, resources, skills, supportingIds: ['.agents/invocation.md', 'LICENSE'].map(publicId), overrides: { invocation: 'host-selected-stage', destinations: 'local-plan-artifacts', technicalTicketSplit: 'agent-owned' } });
}
function verifyPinnedPublicResources(resources: PlanningResourceReference[]): void {
  for (const resource of resources) {
    const lock = PINNED_PLANNING_FILES.find(file => file.path === resource.path);
    if (!lock || lock.sha256 !== resource.sha256) fail('Public planning resources must match the explicitly pinned upstream commit.');
  }
}
export function parsePlanningSkillManifest(value: unknown): PlanningSkillManifest {
  const o = record(value, ['schemaVersion', 'entryId', 'resources', 'skills', 'supportingIds', 'overrides']);
  if (o.schemaVersion !== 1) fail('Unsupported planning resource schema.');
  const resources = list(o.resources, resourceReference), entryId = id(o.entryId);
  unique(resources.map(r => r.id), 'resource identity'); unique(resources.map(r => r.path.toLowerCase()), 'portable resource path');
  const skills = list(o.skills, value => {
    const s = record(value, ['name', 'stage', 'entryId', 'policyId', 'referenceIds']);
    if (!Object.hasOwn(requiredSkills, String(s.stage)) || s.name !== requiredSkills[s.stage as SkillStage]) fail('Stage skills must be explicitly mapped to the selected planning method.');
    return { name: text(s.name, 64), stage: s.stage as SkillStage, entryId: id(s.entryId), policyId: id(s.policyId), referenceIds: list(s.referenceIds, id) };
  }, 4);
  if (skills.length !== 4) fail('All four planning stage dependencies are required.');
  unique(skills.map(s => s.name), 'skill name'); unique(skills.map(s => s.stage), 'skill stage');
  const supportingIds = list(o.supportingIds, id), owned = [entryId, ...supportingIds, ...skills.flatMap(s => [s.entryId, s.policyId, ...s.referenceIds])];
  unique(owned, 'resource ownership');
  if (owned.length !== resources.length || owned.some(name => !resources.some(r => r.id === name))) fail('Every resource must be explicitly mapped once; missing and unused resources are rejected.');
  const publicResources = resources.filter(resource => resource.id !== entryId);
  if (publicResources.length !== PINNED_PLANNING_FILES.length) fail('The complete pinned upstream dependency closure is required.');
  verifyPinnedPublicResources(publicResources);
  if (JSON.stringify(supportingIds.map(name => resources.find(r => r.id === name)!.path).sort()) !== JSON.stringify(['.agents/invocation.md', 'LICENSE'])) fail('Pinned upstream invocation policy and MIT license are required as supporting resources.');
  for (const skill of skills) {
    const entry = resources.find(r => r.id === skill.entryId)!, root = posix.dirname(entry.path);
    if (root !== `skills/${skill.name === 'grilling' ? 'productivity' : 'engineering'}/${skill.name}`) fail('A stage must map to its pinned upstream skill directory.');
    if (posix.basename(entry.path) !== 'SKILL.md' || root === '.') fail('Skill entries require their own directory and SKILL.md.');
    const policy = resources.find(r => r.id === skill.policyId)!;
    if (policy.path !== `${root}/agents/openai.yaml`) fail('A skill needs its own pinned agents/openai.yaml.');
    for (const refId of skill.referenceIds) if (!resources.find(r => r.id === refId)!.path.startsWith(`${root}/`)) fail('References cannot cross skill ownership.');
  }
  return { schemaVersion: 1, entryId, resources: resources.sort((a, b) => a.id.localeCompare(b.id)), skills: skills.sort((a, b) => a.stage.localeCompare(b.stage)), supportingIds: supportingIds.sort(), overrides: overrides(o.overrides) };
}
export function planningManifestMaterial(methodId: string, manifest: PlanningSkillManifest): AgentMaterial {
  const parsed = parsePlanningSkillManifest(manifest);
  if (parsed.entryId !== methodId) fail('Planning manifest entry must name the configured private method.');
  const content = JSON.stringify(parsed);
  return { id: `${methodId}:skill-bundle`, kind: 'method', sha256: hash(content), content };
}
/** Matches the Host method identity without depending on local path names. */
export function planningBundleDigest(methodId: string, version: string, manifest: PlanningSkillManifest): string {
  const parsed = parsePlanningSkillManifest(manifest), entry = parsed.resources.find(resource => resource.id === methodId);
  if (!entry || parsed.entryId !== methodId) fail('Planning digest requires the private entry identity.');
  return hash(JSON.stringify({ id: methodId, logicalName: 'design-feature', version, adapter: PLANNING_SKILL_ADAPTER, skillBundle: parsed,
    files: [{ id: entry.id, sha256: entry.sha256 }, ...parsed.resources.filter(resource => resource.id !== methodId).map(resource => ({ id: resource.id, sha256: resource.sha256 })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)] }));
}
function checkedMaterial(material: AgentMaterial): void {
  if (material.kind !== 'method' || typeof material.content !== 'string' || !material.content.trim() || material.content.includes('\0') || Buffer.byteLength(material.content) > 1024 * 1024 || hash(material.content) !== material.sha256) fail('Planning material is missing, oversized or changed.');
}
function skillMetadata(resource: PlanningProjectedResource, expected: string, policy: PlanningProjectedResource | null): Skill {
  let frontmatter: Record<string, unknown>;
  try { frontmatter = parseFrontmatter<Record<string, unknown>>(resource.content).frontmatter; } catch { return fail('Skill frontmatter must be valid.'); }
  if (frontmatter.name !== expected || typeof frontmatter.description !== 'string' || !frontmatter.description.trim() || frontmatter.description.length > 1024 || (frontmatter['disable-model-invocation'] !== undefined && typeof frontmatter['disable-model-invocation'] !== 'boolean')) fail('Skill name, description or invocation metadata is invalid.');
  const disabled = frontmatter['disable-model-invocation'] === true;
  if (policy) {
    const implicit = policy.content.match(/^\s+allow_implicit_invocation:\s*(true|false)\s*$/m)?.[1];
    if ((disabled && implicit !== 'false') || (!disabled && implicit === 'false')) fail('Upstream invocation restrictions must agree across SKILL.md and agents/openai.yaml.');
  }
  const filePath = `controlled-skill:${resource.path}`, baseDir = `controlled-skill:${posix.dirname(resource.path)}`;
  return { name: expected, description: frontmatter.description, filePath, baseDir, disableModelInvocation: disabled,
    sourceInfo: { path: filePath, source: 'digest-locked-planning', scope: 'temporary', origin: 'top-level', baseDir } };
}
function resolveReference(root: string, from: string, reference: string): string {
  planningResourcePath(from);
  if (typeof reference !== 'string' || !reference || reference.length > 1024 || !/^(?:\.\.?\/)*[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(reference) || reference.split('/').some(part => part !== '.' && part !== '..' && part.endsWith('.'))) fail('Only safe relative references are supported; remote and absolute resources are denied.');
  const resolved = posix.normalize(posix.join(posix.dirname(from), reference));
  if (!resolved.startsWith(`${root}/`)) fail('Reference escapes its owning skill.');
  return planningResourcePath(resolved);
}
function markdownReferences(content: string): string[] {
  const refs: string[] = [];
  for (const match of content.matchAll(/\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"\n]*")?\)/g)) {
    const link = match[1]!;
    if (!link.startsWith('#')) refs.push(link.replace(/#.*$/, ''));
  }
  return refs;
}
function verifyClosure(skill: PlanningSkillProjection['active']): void {
  skillMetadata(skill.entry, skill.name, skill.policy);
  const resources = [skill.entry, ...skill.references], root = posix.dirname(skill.entry.path);
  for (const resource of resources) for (const reference of markdownReferences(resource.content)) {
    const target = resolveReference(root, resource.path, reference);
    if (!resources.some(r => r.path === target)) fail(`Missing explicitly pinned relative reference in ${skill.name}.`);
  }
}
/** Reconstruct exclusively from a frozen snapshot and its exact material set. */
export function resolvePlanningBundle(snapshot: MethodSnapshot, input: readonly AgentMaterial[]): PlanningSkillBundle {
  if (snapshot.adapter !== PLANNING_SKILL_ADAPTER) fail('The selected method has no staged skill adapter.');
  const materials = structuredClone(input) as AgentMaterial[];
  unique(materials.map(m => m.id), 'frozen material identity'); materials.forEach(checkedMaterial);
  const manifestMaterial = materials.find(m => m.id === `${snapshot.id}:skill-bundle`);
  if (!manifestMaterial || !snapshot.dependencies?.includes(`${manifestMaterial.id}@${manifestMaterial.sha256}`)) fail('The frozen snapshot must pin the explicit resource manifest.');
  let parsed: unknown; try { parsed = JSON.parse(manifestMaterial.content); } catch { return fail('Planning resource manifest is not JSON.'); }
  const manifest = parsePlanningSkillManifest(parsed);
  if (manifest.entryId !== snapshot.id || JSON.stringify(manifest) !== manifestMaterial.content) fail('The frozen resource manifest is not canonical or names a different entry.');
  if (planningBundleDigest(snapshot.id, snapshot.version, manifest) !== snapshot.digest) fail('The frozen method digest does not bind this resource graph.');
  if (materials.length !== manifest.resources.length + 1) fail('Frozen material closure is incomplete or includes unlisted data.');
  for (const resource of manifest.resources) {
    const material = materials.find(m => m.id === resource.id);
    if (!material || material.sha256 !== resource.sha256 || (resource.id !== snapshot.id && !snapshot.dependencies?.includes(`${resource.id}@${resource.sha256}`))) fail('Every dependency must be present and digest-locked by the frozen snapshot.');
  }
  const expectedDependencies = [...manifest.resources.filter(r => r.id !== snapshot.id).map(r => `${r.id}@${r.sha256}`), `${manifestMaterial.id}@${manifestMaterial.sha256}`].sort();
  if (JSON.stringify([...(snapshot.dependencies ?? [])].sort()) !== JSON.stringify(expectedDependencies)) fail('Snapshot dependency closure differs from the resource manifest.');
  const bundle = { manifest, manifestMaterial, materials };
  for (const stage of ['facts', 'clarification', 'design', 'spec', 'tickets'] as const) validateProjection(projectPlanningSkillBundle(bundle, stage));
  return bundle;
}
function stageSkill(stage: PlanningSkillStage): string {
  if (stage === 'design' || stage === 'design-resolution') return 'codebase-design';
  return stage === 'clarification' ? 'grilling' : stage === 'spec' ? 'to-spec' : stage === 'tickets' ? 'to-tickets' : 'design-feature';
}
export function projectPlanningSkillBundle(bundle: PlanningSkillBundle, stage: PlanningSkillStage): PlanningSkillProjection {
  if (!PLANNING_SKILL_STAGES.includes(stage)) fail('Unknown planning stage.');
  const get = (resourceId: string): PlanningProjectedResource => {
    const ref = bundle.manifest.resources.find(r => r.id === resourceId), material = bundle.materials.find(m => m.id === resourceId);
    if (!ref || !material || ref.sha256 !== material.sha256) return fail('Missing or changed projected resource.');
    checkedMaterial(material); return { ...ref, content: material.content };
  };
  const entry = get(bundle.manifest.entryId), name = stageSkill(stage), mapping = bundle.manifest.skills.find(s => s.name === name);
  return structuredClone({ schemaVersion: 1, stage, manifest: { id: bundle.manifestMaterial.id, sha256: bundle.manifestMaterial.sha256 }, entry,
    active: { name, entry: mapping ? get(mapping.entryId) : entry, policy: mapping ? get(mapping.policyId) : null, references: mapping ? mapping.referenceIds.map(get) : [] }, overrides: bundle.manifest.overrides });
}
function projectedResource(value: unknown): PlanningProjectedResource {
  const o = record(value, ['id', 'path', 'sha256', 'content']);
  const ref = resourceReference({ id: o.id, path: o.path, sha256: o.sha256 });
  if (typeof o.content !== 'string') return fail('Projected resource body is required.');
  checkedMaterial({ ...ref, kind: 'method', content: o.content }); return { ...ref, content: o.content };
}
function validateProjection(value: unknown): PlanningSkillProjection {
  const o = record(value, ['schemaVersion', 'stage', 'manifest', 'entry', 'active', 'overrides']);
  if (o.schemaVersion !== 1 || !PLANNING_SKILL_STAGES.includes(o.stage as PlanningSkillStage)) fail('Unknown projected stage.');
  const manifest = record(o.manifest, ['id', 'sha256']), entry = projectedResource(o.entry), active = record(o.active, ['name', 'entry', 'policy', 'references']);
  if (active.name !== stageSkill(o.stage as PlanningSkillStage)) fail('A stage cannot load another stage skill.');
  const result: PlanningSkillProjection = { schemaVersion: 1, stage: o.stage as PlanningSkillStage, manifest: { id: id(manifest.id), sha256: sha(manifest.sha256) }, entry,
    active: { name: text(active.name, 64), entry: projectedResource(active.entry), policy: active.policy === null ? null : projectedResource(active.policy), references: list(active.references, projectedResource) }, overrides: overrides(o.overrides) };
  if (result.manifest.id !== `${entry.id}:skill-bundle`) fail('Projected manifest must bind the private method identity.');
  const resources = [result.active.entry, ...(result.active.policy ? [result.active.policy] : []), ...result.active.references];
  unique(resources.map(r => r.id), 'projected resource'); unique(resources.map(r => r.path.toLowerCase()), 'projected path');
  const root = posix.dirname(result.active.entry.path);
  if (result.active.name === 'design-feature') {
    if (JSON.stringify(result.active.entry) !== JSON.stringify(entry) || result.active.policy || result.active.references.length) fail('Entry-only stages cannot receive downstream resources.');
    skillMetadata(entry, 'design-feature', null);
  } else {
    verifyPinnedPublicResources(resources);
    if (root !== `skills/${result.active.name === 'grilling' ? 'productivity' : 'engineering'}/${result.active.name}`) fail('Stage skill directory differs from the pinned upstream resource.');
    if (!result.active.policy || result.active.policy.path !== `${root}/agents/openai.yaml` || result.active.references.some(r => !r.path.startsWith(`${root}/`) || posix.basename(r.path) === 'SKILL.md')) fail('Projected resources must belong only to the active skill.');
    verifyClosure(result.active);
  }
  return result;
}
/** Tools are data readers only. The audit callback must settle successfully before bytes are returned. */
export function createPlanningSkillSession(input: PlanningSkillProjection, options: { onRead?: (reference: PlanningSkillRead) => Promise<void> } = {}): PlanningSkillSession {
  const projection = validateProjection(structuredClone(input)), active = projection.active;
  const metadata = skillMetadata(active.entry, active.name, active.policy), loaded = new Set<string>();
  const activeSkill: PlanningSkillRead = { id: active.entry.id, sha256: active.entry.sha256, skillName: active.name, path: active.entry.path };
  const release = async (resource: PlanningProjectedResource) => {
    await options.onRead?.({ id: resource.id, sha256: resource.sha256, skillName: active.name, path: resource.path });
    loaded.add(resource.id); return structuredClone(resource);
  };
  const readSkill = async (name: string) => {
    if (name !== active.name) return fail('Only the Host-selected active stage skill can be invoked.');
    return release(active.entry);
  };
  const readReference = async (from: string, path: string) => {
    const resources = [active.entry, ...active.references], source = resources.find(r => r.path === from);
    if (!source || !loaded.has(source.id)) return fail('Read the owning skill or reference before following its links.');
    const resolved = resolveReference(posix.dirname(active.entry.path), from, path);
    if (!markdownReferences(source.content).some(link => resolveReference(posix.dirname(active.entry.path), from, link) === resolved)) return fail('Only declared links from a loaded resource may be followed.');
    const resource = resources.find(r => r.path === resolved);
    if (!resource) return fail('Reference is not pinned in the active stage.');
    return release(resource);
  };
  const result = (resource: PlanningProjectedResource) => ({ content: [{ type: 'text' as const, text: resource.content }], details: { id: resource.id, sha256: resource.sha256, path: resource.path, skillName: active.name } });
  const tools: ToolDefinition[] = [
    { name: 'controlled_skill', label: 'Load active planning skill', description: `Load the exact pinned ${active.name} skill for this Host-selected stage. This is the adapter for upstream Skill tool calls. No other skill can be invoked.`, parameters: Type.Object({ name: Type.String() }, { additionalProperties: false }), async execute(_id, params) { const p = record(params, ['name']); return result(await readSkill(text(p.name, 64))); } },
    { name: 'controlled_skill_resource', label: 'Read pinned skill reference', description: 'Follow one declared relative link from a loaded active skill resource. Use its portable path as from; no filesystem, remote or cross-stage reads.', parameters: Type.Object({ from: Type.String(), path: Type.String() }, { additionalProperties: false }), async execute(_id, params) { const p = record(params, ['from', 'path']); return result(await readReference(text(p.from, 1024), text(p.path, 1024))); } },
  ];
  return { stage: projection.stage, projection: structuredClone(projection), activeSkill, skills: [metadata], initialMaterials: [], tools, readSkill, readReference, hasLoadedPrimary: () => loaded.has(active.entry.id),
    systemInstructions: `Planning stage: ${projection.stage}. The Host explicitly selected ${active.name}. Before any stage report, call controlled_skill with name "${active.name}" and apply the exact returned original skill. Upstream calls to the Skill tool mean controlled_skill here. Relative skill links use controlled_skill_resource with the returned portable path as from. No other stage can be loaded in this context.\nScoped project adapter overrides (separate from unchanged upstream originals): the approved planning workflow permits Host-selected automatic invocation, including user-invoked entry/to-spec/to-tickets, solely within this stage. This does not grant cross-skill invocation, source execution, data disclosure, model or budget authorization. Spec and tickets are local versioned Host plan artifacts; use the original templates and dependency semantics with the Host artifact destination. Internal technical ticket granularity and dependency splitting are agent-owned under the approved product rules; they need no additional split approval. Preserve explicit human scope/behavior decisions and final design plus test-seam confirmation; report unresolved tradeoffs instead of assuming approval. Reuse valid confirmations. Optional DESIGN-IT-TWICE resources do not authorize extra agents or make alternative-design contests mandatory. Planning cannot implement, commit or push.` };
}
