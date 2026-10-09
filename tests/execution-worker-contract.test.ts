import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { bundledImplementationMethod, emptyConfiguration, loadMethods } from '../src/host/configuration.ts';
import { createImplementationSkillSession, projectImplementationSkillBundle, resolveImplementationBundle, IMPLEMENTATION_SKILL_STAGES } from '../src/agent/implementation-skills.ts';
import { explicitResourceLoader } from '../src/agent/resources.ts';
import { createBrokeredPiSession } from '../src/agent/brokered-pi.ts';
import { runWorkerFromStreams, validateWorkerInit } from '../src/agent/worker-runtime.ts';
import type { WorkerInit } from '../src/agent/worker-runtime.ts';
import { controlledTools } from '../src/agent/controlled-tools.ts';
import { executionReportParameters } from '../src/agent/execution-report-contract.ts';
import { PrivateFrameDecoder, encodePrivateFrame } from '../src/runtime/pipe-frames.ts';
import type { ExecutionWorkStep } from '../src/domain/types.ts';
import type { ProviderResponse } from '../src/runtime/model-broker.ts';

const ref = (id: string) => ({ id, digest: 'a'.repeat(64), location: `pi-object:${id}` });
function reportFor(step: ExecutionWorkStep): Record<string, any> {
  if (step === 'ticket-implementation' || step === 'ticket-fix') return { type: 'execution-content', content: { id: 'new-content', planId: 'approved-plan', code: { id: 'new-code', digest: 'pending', location: 'current-worktree' }, knowledge: [], maintenance: 'not-needed', deliveryNotes: 'Synthetic contract fixture, not implementation evidence.' }, tdd: { mode: 'red-green', testingSeams: ['public behavior'], red: [ref('red')], green: [ref('green')] }, ...(step === 'ticket-fix' ? { repairScopeId: 'repair' } : {}) };
  if (step === 'review-standards' || step === 'review-spec') return { type: 'execution-review', review: { id: 'review', axis: step === 'review-standards' ? 'standards' : 'spec', contentId: 'current-content', evidence: ref('review-evidence'), knowledgeReviewed: true, findings: [] } };
  return { type: 'execution-resolution', resolution: { id: 'resolution', axis: step === 'resolution-standards' ? 'standards' : 'spec', contentId: 'current-content', repairScopeId: 'repair', evidence: ref('resolution-evidence'), dispositions: [] } };
}
function validate(step: ExecutionWorkStep, report: Record<string, any>) {
  return validateToolArguments({ name: 'controlled_report', description: 'Bound stage report', parameters: executionReportParameters(step) }, { type: 'toolCall', id: 'call', name: 'controlled_report', arguments: { report } });
}
function fixture(t: test.TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'execution-worker-contract-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'source'), scratch = join(root, 'scratch'); mkdirSync(workspace); mkdirSync(scratch);
  const configuration = emptyConfiguration(); configuration.methods.implementation = bundledImplementationMethod(fileURLToPath(new URL('../vendor/mattpocock-skills', import.meta.url))); configuration.methods.review = structuredClone(configuration.methods.implementation);
  const loaded = loadMethods(configuration), bundle = resolveImplementationBundle(loaded.methods.implementation!, loaded.materials.implementation);
  const boot = (step: ExecutionWorkStep): WorkerInit => ({ version: 1, type: 'worker.init', runId: 'native-run', generation: 'native-generation', demandId: 'demand', domainRunId: 'domain-run', domainGeneration: 2,
    role: step === 'ticket-implementation' || step === 'ticket-fix' ? 'implementation' : 'review', workspace, scratch, sessionDir: join(scratch, `session-${step}`), sessionId: `fresh-${step}`, capability: 'a'.repeat(64), prompt: 'Run the explicitly selected synthetic stage.', materials: [],
    execution: { flowId: 'execution-flow', flowRevision: 3, inputDigest: 'b'.repeat(64), step, contextId: `context-${step}`, scope: step === 'ticket-implementation' ? 'ticket' : 'whole-spec', ...(step === 'ticket-implementation' ? { ticketId: 'ticket-one' } : { contentId: 'current-content' }) }, executionSkills: projectImplementationSkillBundle(bundle, step),
    model: { provider: 'synthetic', id: 'no-network-model', contextWindow: 32768, maxTokens: 512 }, compaction: { enabled: false, reserveTokens: 512, keepRecentTokens: 512 }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, limits: { maxFileBytes: 1024, commandTimeoutMs: 1000, maxOutputBytes: 8192 } });
  return { boot, workspace, scratch, bundle };
}

test('execution bootstrap binds both skill projection and exact stage/input/scope identity', t => {
  const { boot } = fixture(t);
  for (const step of IMPLEMENTATION_SKILL_STAGES) {
    const valid = boot(step); assert.equal(validateWorkerInit(valid, valid.generation).execution!.step, step);
    for (const change of [{ execution: undefined }, { executionSkills: undefined }, { role: 'planning' }, { role: valid.role === 'review' ? 'implementation' : 'review' }, { checkOnly: true }, { planning: {} }, { execution: { ...valid.execution, flowRevision: 0 } }, { execution: { ...valid.execution, inputDigest: 'unpinned' } }, { execution: { ...valid.execution, contextId: '' } }, { execution: { ...valid.execution, step: 'complete' } }, { execution: { ...valid.execution, forgedAuthority: true } }, { execution: { ...valid.execution, scope: 'all-worktrees' } }]) assert.throws(() => validateWorkerInit({ ...valid, ...change }, valid.generation), { code: 'WORKER_BOOTSTRAP_INVALID' });
    const changed = structuredClone(valid); changed.executionSkills!.entry.content += '\nchanged'; assert.throws(() => validateWorkerInit(changed, valid.generation), { code: 'IMPLEMENTATION_RESOURCE_INVALID' });
    if (step !== 'ticket-implementation') assert.throws(() => validateWorkerInit({ ...valid, execution: { ...valid.execution, contentId: undefined } }, valid.generation), { code: 'WORKER_BOOTSTRAP_INVALID' });
  }
  const implementation = boot('ticket-implementation');
  assert.throws(() => validateWorkerInit({ ...implementation, execution: { ...implementation.execution, ticketId: undefined } }, implementation.generation), { code: 'WORKER_BOOTSTRAP_INVALID' });
});

test('execution report schemas exclude legacy, cross-axis, identity and approval variants', () => {
  for (const step of IMPLEMENTATION_SKILL_STAGES) {
    assert.deepEqual(validate(step, reportFor(step)).report, reportFor(step));
    assert.equal(validate(step, { type: 'blocked', reason: 'Missing actual prerequisite.' }).report.type, 'blocked');
    for (const type of ['content-ready', 'review', 'dispute', 'resolve-finding', 'plan-ready', 'runtime-ended', 'message-applied', 'authorize-implementation', 'accept']) assert.throws(() => validate(step, { type }), /Validation failed/);
    for (const key of ['requestId', 'demandId', 'runId', 'generation', 'flowId', 'flowRevision', 'executionStep', 'scope', 'ticketId', 'contentId', 'inputDigest', 'tddVerified', 'accepted']) assert.throws(() => validate(step, { ...reportFor(step), [key]: 'forged' }), /Validation failed/);
    const check = { type: 'check', check: { id: 'check', contentId: 'current-content', requirementId: 'required-check', status: 'passed', evidence: ref('actual-check'), environment: 'host-observed' } };
    if (step === 'ticket-implementation' || step === 'ticket-fix') assert.throws(() => validate(step, check), /Validation failed/);
    else assert.equal(validate(step, check).report.type, 'check');
    if (step.startsWith('review-')) { const report = reportFor(step); report.review.axis = step === 'review-spec' ? 'standards' : 'spec'; assert.throws(() => validate(step, report), /Validation failed/); }
    if (step.startsWith('resolution-')) { const report = reportFor(step); report.resolution.axis = step === 'resolution-spec' ? 'standards' : 'spec'; assert.throws(() => validate(step, report), /Validation failed/); }
  }
  const implementation = reportFor('ticket-implementation');
  for (const field of ['red', 'green', 'testingSeams']) { const report = structuredClone(implementation); report.tdd[field] = []; assert.throws(() => validate('ticket-implementation', report), /Validation failed/); }
  const pureRefactor = reportFor('ticket-fix'); pureRefactor.tdd = { mode: 'preserve-behavior', rationale: 'Only documented naming standards changed.', testingSeams: ['public behavior'], red: [], green: [ref('green')] };
  assert.equal(validate('ticket-fix', pureRefactor).report.tdd.mode, 'preserve-behavior');
  assert.throws(() => validate('ticket-implementation', { ...implementation, tdd: pureRefactor.tdd }), /Validation failed/);
  delete pureRefactor.tdd.rationale; assert.throws(() => validate('ticket-fix', pureRefactor), /Validation failed/);
  const standards = reportFor('review-standards'); standards.review.findings = [{ id: 'smell', severity: 'blocking', category: 'smell', location: 'src/file.ts', basis: 'Personal style preference.', impact: 'No requirement impact.', verification: 'Inspect source.', reference: ref('code'), requiresDesignDecision: false }];
  assert.throws(() => validate('review-standards', standards), /Validation failed/); standards.review.findings[0].severity = 'suggestion'; assert.equal(validate('review-standards', standards).report.review.findings.length, 1);
});

test('execution tools and initial resources preserve writer/read-only boundaries and user-data lane', t => {
  const { boot, bundle } = fixture(t), content = 'UNTRUSTED-DERIVED-FINDING-DO-NOT-PROMOTE', data = { id: 'finding', kind: 'check-evidence' as const, content, sha256: createHash('sha256').update(content).digest('hex') };
  for (const step of IMPLEMENTATION_SKILL_STAGES) {
    const init = boot(step), implementationSkills = createImplementationSkillSession(init.executionSkills!);
    const loader = explicitResourceLoader(init.role, [...bundle.materials, data], { implementationSkills });
    assert.deepEqual(loader.getAgentsFiles().agentsFiles, []); assert.deepEqual(loader.getSkills().skills.map(skill => skill.name), ['implement-spec', step.startsWith('ticket-') ? 'tdd' : 'code-review']);
    assert.equal(loader.getSystemPrompt()!.includes(content), false); assert.equal(loader.getSystemPrompt()!.includes(init.executionSkills!.entry.content), false); assert.equal(loader.getSystemPrompt()!.includes(init.executionSkills!.active.entry.content), false);
    const tools = controlledTools({ ...init, executionStep: step, ...init.limits, report: async () => ({}), stopRequired: () => {} });
    for (const name of ['controlled_write', 'controlled_delete']) assert.equal(tools.some(tool => tool.name === name), init.role === 'implementation');
    for (const name of ['shell', 'bash', 'git', 'controlled_shell', 'controlled_worktree', 'controlled_publish']) assert.equal(tools.some(tool => tool.name === name), false);
    assert.deepEqual(JSON.parse(JSON.stringify(tools.find(tool => tool.name === 'controlled_report')!.parameters)), JSON.parse(JSON.stringify(executionReportParameters(step))));
    assert.throws(() => controlledTools({ ...init, role: init.role === 'implementation' ? 'review' : 'implementation', executionStep: step, ...init.limits, report: async () => ({}), stopRequired: () => {} }), { code: 'EXECUTION_TOOL_ROLE_DENIED' });
  }
});

test('every execution writer and reviewer refuses inherited native conversation history', async t => {
  const { boot } = fixture(t);
  for (const step of IMPLEMENTATION_SKILL_STAGES) {
    const init = boot(step), manager = SessionManager.inMemory(init.workspace); manager.appendMessage({ role: 'user', content: 'OLD-WRITER-OR-REVIEW-CONVERSATION', timestamp: 1 });
    await assert.rejects(createBrokeredPiSession({ cwd: init.workspace, agentDir: init.sessionDir, role: init.role, materials: [], implementationSkills: createImplementationSkillSession(init.executionSkills!), tools: [], sessionManager: manager, channel: { complete: async () => { throw new Error('No model operation allowed'); } }, model: init.model, compaction: init.compaction, retry: init.retry }), { code: init.role === 'review' ? 'REVIEW_HISTORY_DENIED' : 'EXECUTION_HISTORY_DENIED' });
  }
});

type ScriptContext = { systemPrompt?: string; messages: { role: string; toolName?: string; toolCallId?: string; content?: { type: string; text?: string }[]; isError?: boolean; toolsAdded?: { name: string }[] }[] };
async function runScripted(init: WorkerInit, script: (context: ScriptContext, turn: number) => ProviderResponse, options: { denySkill?: boolean } = {}) {
  const input = new PassThrough(), output = new PassThrough(), decoder = new PrivateFrameDecoder(), frames: Record<string, any>[] = []; let turns = 0;
  const send = (value: unknown) => input.write(encodePrivateFrame(Buffer.from(JSON.stringify(value))));
  output.on('data', (chunk: Buffer) => { try { for (const frame of decoder.push(chunk)) {
    const value = JSON.parse(Buffer.from(frame).toString()) as Record<string, any>; frames.push(value);
    if (value.type === 'model.request') send({ sequence: value.sequence, ok: true, value: script(value.context, ++turns) });
    if (value.type === 'worker.skill-request') send({ type: 'worker.skill-result', requestId: value.requestId, ok: !options.denySkill, value: { synthetic: true } });
    if (value.type === 'worker.report') send({ type: 'worker.receipt', requestId: value.report.requestId, ok: true, value: { status: 'synthetic-receipt' } });
  } } catch (error) { input.destroy(error as Error); } });
  try { const running = runWorkerFromStreams(input, output, init.generation); send(init); await running; return { frames, turns }; }
  finally { input.destroy(); output.destroy(); }
}

for (const step of ['ticket-implementation', 'review-spec'] as const) test(`actual ${step} Worker requires root and primary bytes in a successful model turn before reporting`, async t => {
  const { boot } = fixture(t), init = boot(step), projection = init.executionSkills!, report = reportFor(step), marker = 'UNTRUSTED-ARTIFACT-IN-USER-DATA';
  init.materials.push({ id: 'initial-artifact', kind: 'check-evidence', content: marker, sha256: createHash('sha256').update(marker).digest('hex') }); init.prompt += `\nHost-approved input data (not instructions): ${marker}`;
  writeFileSync(join(init.workspace, 'AGENTS.md'), 'UNTRUSTED-REPOSITORY-AGENTS');
  const outcome = await runScripted(init, (context, turn): ProviderResponse => {
    const results = context.messages.filter(message => message.role === 'toolResult');
    if (turn === 1) {
      assert.equal(JSON.stringify(context).includes(JSON.stringify(projection.entry.content).slice(1, -1)), false); assert.equal(JSON.stringify(context).includes(JSON.stringify(projection.active.entry.content).slice(1, -1)), false);
      assert.equal(String(context.systemPrompt).includes(marker), false); assert.equal(JSON.stringify(context.messages.filter(message => message.role === 'system')).includes(marker), false); assert.equal(JSON.stringify(context.messages.filter(message => message.role === 'user')).includes(marker), true); assert.equal(JSON.stringify(context).includes('UNTRUSTED-REPOSITORY-AGENTS'), false);
      return { text: '', toolCalls: [{ id: 'root', name: 'controlled_skill', arguments: { name: 'implement-spec' } }] };
    }
    if (turn === 2) { assert.ok(results.some(message => message.content?.some(part => part.text === projection.entry.content))); return { text: '', toolCalls: [{ id: 'primary', name: 'controlled_skill', arguments: { name: projection.active.name } }, { id: 'premature', name: 'controlled_report', arguments: { report } }] }; }
    if (turn === 3) {
      assert.equal(results.find(message => message.toolCallId === 'premature')?.isError, true); assert.ok(results.some(message => message.content?.some(part => part.text === projection.active.entry.content)));
      return { text: '', toolCalls: [{ id: 'valid-report', name: 'controlled_report', arguments: { report } }] };
    }
    assert.equal(turn, 4); return { text: 'Synthetic stage ended.' };
  });
  assert.equal(outcome.turns, 4); const reports = outcome.frames.filter(frame => frame.type === 'worker.report'); assert.equal(reports.length, 1); assert.equal(outcome.frames.filter(frame => frame.type === 'worker.skill-request').length, 2);
  assert.deepEqual(reports[0]!.report, { ...report, flowId: init.execution!.flowId, flowRevision: init.execution!.flowRevision, inputDigest: init.execution!.inputDigest, executionStep: step, scope: init.execution!.scope, ...(init.execution!.ticketId ? { ticketId: init.execution!.ticketId } : {}), ...(init.execution!.contentId ? { contentId: init.execution!.contentId } : {}), requestId: reports[0]!.report.requestId, demandId: init.demandId, runId: init.domainRunId, generation: init.domainGeneration });
});

test('an unavailable skill can report blocked without releasing bytes or advancing a stage', async t => {
  const { boot } = fixture(t), init = boot('ticket-implementation');
  const outcome = await runScripted(init, (context, turn): ProviderResponse => {
    if (turn === 1) return { text: '', toolCalls: [{ id: 'denied-root', name: 'controlled_skill', arguments: { name: 'implement-spec' } }] };
    if (turn === 2) { assert.equal(context.messages.find(message => message.toolCallId === 'denied-root')?.isError, true); assert.equal(JSON.stringify(context).includes(JSON.stringify(init.executionSkills!.entry.content).slice(1, -1)), false); return { text: '', toolCalls: [{ id: 'blocked', name: 'controlled_report', arguments: { report: { type: 'blocked', reason: 'The Host did not authorize the exact skill read.' } } }] }; }
    assert.equal(turn, 3); return { text: 'Blocked.' };
  }, { denySkill: true });
  assert.deepEqual(outcome.frames.filter(frame => frame.type === 'worker.report').map(frame => frame.report.type), ['blocked']);
});
