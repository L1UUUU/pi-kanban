import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { bundledPlanningMethod, emptyConfiguration, loadMethods } from '../src/host/configuration.ts';
import { projectPlanningSkillBundle, resolvePlanningBundle, PLANNING_SKILL_STAGES } from '../src/agent/planning-skills.ts';
import { validateWorkerInit } from '../src/agent/worker-runtime.ts';
import type { WorkerInit } from '../src/agent/worker-runtime.ts';
import { controlledTools } from '../src/agent/controlled-tools.ts';
import { planningReportParameters } from '../src/agent/planning-report-contract.ts';
import type { PlanningWorkStep } from '../src/domain/types.ts';

function fixture(t: test.TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'staged-worker-contract-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'source'), scratch = join(root, 'scratch'); mkdirSync(workspace); mkdirSync(scratch);
  const path = join(root, 'selected-entry.md'), content = '---\nname: design-feature\ndescription: Synthetic bootstrap contract fixture\ndisable-model-invocation: true\n---\nRun only the current planning stage.\n'; writeFileSync(path, content);
  const config = emptyConfiguration(); config.methods.planning = bundledPlanningMethod({ id: 'entry', path, sha256: createHash('sha256').update(content).digest('hex') }, fileURLToPath(new URL('../vendor/mattpocock-skills', import.meta.url)));
  const methods = loadMethods(config), bundle = resolvePlanningBundle(methods.methods.planning!, methods.materials.planning);
  const boot = (step: PlanningWorkStep): WorkerInit => ({ version: 1, type: 'worker.init', runId: 'native-run', generation: 'native-generation', demandId: 'demand', domainRunId: 'domain-run', domainGeneration: 1,
    role: step === 'facts' || step === 'design-review' ? 'boundary-review' : 'planning', workspace, scratch, sessionDir: join(scratch, 'session'), sessionId: 'fresh-session', capability: 'a'.repeat(64), prompt: 'Run a synthetic stage with explicitly approved inputs.', materials: [],
    planning: { flowId: 'flow', flowRevision: 3, inputDigest: 'b'.repeat(64), step, contextId: 'fresh-context' }, planningSkills: projectPlanningSkillBundle(bundle, step),
    model: { provider: 'synthetic', id: 'no-model', contextWindow: 32768, maxTokens: 512 }, compaction: { enabled: false, reserveTokens: 512, keepRecentTokens: 512 }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, limits: { maxFileBytes: 1024, commandTimeoutMs: 1000, maxOutputBytes: 8192 } });
  return { boot, workspace, scratch };
}

test('staged Worker bootstrap rejects missing, mismatched and changed flow/resource boundaries', t => {
  const { boot } = fixture(t);
  for (const step of PLANNING_SKILL_STAGES) {
    const valid = boot(step); assert.equal(validateWorkerInit(valid, valid.generation).planning!.step, step);
    for (const change of [{ planning: undefined }, { planningSkills: undefined }, { role: 'implementation' }, { role: 'check', checkOnly: true }, { planning: { ...valid.planning, flowRevision: 0 } }, { planning: { ...valid.planning, inputDigest: 'unpinned' } }, { planning: { ...valid.planning, contextId: '' } }, { planning: { ...valid.planning, step: step === 'spec' ? 'tickets' : 'spec' } }]) {
      assert.throws(() => validateWorkerInit({ ...valid, ...change }, valid.generation), { code: 'WORKER_BOOTSTRAP_INVALID' });
    }
    const changed = structuredClone(valid); changed.planningSkills!.active.entry.content += '\nchanged';
    assert.throws(() => validateWorkerInit(changed, valid.generation), { code: 'PLANNING_RESOURCE_INVALID' });
  }
});

test('installed Pi schema validation rejects legacy handoffs, cross-stage reports and model-supplied Host authority', () => {
  for (const step of PLANNING_SKILL_STAGES) {
    const tool = { name: 'controlled_report', description: 'Stage report', parameters: planningReportParameters(step) };
    const check = (report: Record<string, any>) => validateToolArguments(tool, { type: 'toolCall', id: 'call', name: tool.name, arguments: { report } });
    assert.deepEqual(check({ type: 'blocked', reason: 'Missing approved input.' }), { report: { type: 'blocked', reason: 'Missing approved input.' } });
    for (const type of ['plan-draft', 'plan-ready', 'content-ready', 'confirm-understanding', 'confirm-final-design', 'authorize-implementation']) assert.throws(() => check({ type }), /Validation failed/);
    for (const key of ['flowId', 'flowRevision', 'requestId', 'runId', 'generation', 'demandId', 'authorized', 'accepted', 'artifactsVerified']) assert.throws(() => check({ type: 'blocked', reason: 'Input is missing.', [key]: 'forged' }), /Validation failed/);
    const question = { type: 'planning-questions', scope: 'requirements', questions: [{ id: 'question', scope: 'requirements', question: 'Which behavior is required?', basis: 'The choice is undefined.' }] };
    if (step === 'facts' || step === 'design-review') assert.throws(() => check(question), /Validation failed/);
    else assert.equal(check(question).report.type, 'planning-questions');
    if (step !== 'facts') assert.throws(() => check({ type: 'planning-facts', summary: 'Observed fact.', evidence: { id: 'fact', digest: 'pending', location: 'host-artifact' } }), /Validation failed/);
  }
});

test('every staged role exposes read-only source tools and its own report contract', t => {
  const { boot, workspace, scratch } = fixture(t);
  for (const step of PLANNING_SKILL_STAGES) {
    const init = boot(step), tools = controlledTools({ workspace, scratch, role: init.role, planningStep: step, ...init.limits, report: async () => ({}), stopRequired: () => {} });
    for (const name of ['controlled_write', 'controlled_delete', 'bash', 'write', 'edit']) assert.equal(tools.some(tool => tool.name === name), false, `${step}: ${name}`);
    assert(tools.some(tool => tool.name === 'controlled_read')); assert(tools.some(tool => tool.name === 'controlled_search'));
    assert(tools.some(tool => tool.name === 'controlled_node'), 'Source-preserving native checks remain within the existing read-only grant; this is not ticket execution authority.');
    const report = tools.find(tool => tool.name === 'controlled_report')!;
    assert.deepEqual(JSON.parse(JSON.stringify(report.parameters)), JSON.parse(JSON.stringify(planningReportParameters(step))));
  }
});
