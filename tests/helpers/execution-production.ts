import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planningProductionFixture, git } from './planning-production.ts';
import type { Launch, Script, SyntheticPlanningNativePort } from './planning-production.ts';
import { bundledPlanningMethod, bundledImplementationMethod } from '../../src/host/configuration.ts';
import { hash } from '../../src/host/evidence.ts';
import { planningInputDigest } from '../../src/domain/planning.ts';
import type { ArtifactRef, PlanningWorkerReport, PlanningWorkStep, ReportVerification, UserCommand, WorkerReport, ExecutionWorkStep, ExecutionFindingInput } from '../../src/domain/types.ts';
import type { ProviderResponse } from '../../src/runtime/model-broker.ts';

export { git };
export type { Launch, Script, SyntheticPlanningNativePort };
export const seam = 'Call behavior(value) with requested, empty and repeated input; undefined returns the documented fallback.';
export const pending = (id: string): ArtifactRef => ({ id, digest: 'pending', location: 'host-artifact' });
export const call = (name: string, args: Record<string, unknown>, id = randomUUID()): NonNullable<ProviderResponse['toolCalls']>[number] => ({ id, name, arguments: args as NonNullable<ProviderResponse['toolCalls']>[number]['arguments'] });
export const context = (request: Parameters<Script>[0]) => JSON.parse(request.materials[0]!.text) as { messages: { role: string; toolName?: string; isError?: boolean; content: { type: string; text: string }[] }[] };
export function checkReceipt(request: Parameters<Script>[0], ordinal = -1): ArtifactRef {
  const results = context(request).messages.filter(message => message.role === 'toolResult' && message.toolName === 'controlled_node' && !message.isError);
  const result = results.at(ordinal); assert.ok(result, 'A real Worker controlled_node result is required.');
  const text = result.content.find(item => item.type === 'text')!.text;
  return JSON.parse(text.split('Host check receipt: ')[1]!).evidence as ArtifactRef;
}

/** Only the completed planning precondition uses synthetic domain observations.
 * Every execution stage uses the installed SDK, actual Worker streams, private
 * Host channel, controlled tools and real Git/SQLite. The native port remains
 * explicitly synthetic: local Node child tests establish red/green behavior,
 * never Windows Job, ACL, AppContainer, real model or isolation evidence. */
export function executionProductionFixture(t: TestContext, options: { standards?: boolean } = {}) {
  const vendor = fileURLToPath(new URL('../../vendor/mattpocock-skills', import.meta.url));
  const f = planningProductionFixture(t, root => {
    if (options.standards !== false) {
      const repo = join(root, 'repo');
      writeFileSync(join(repo, 'CONTRIBUTING.md'), 'Documented repository standard: behavior(value) must handle undefined explicitly at its entry point and return the documented fallback.\n');
      git(repo, 'add', 'CONTRIBUTING.md'); git(repo, 'commit', '-m', 'Document synthetic repository standard');
    }
    const path = join(root, 'planning.md'), content = '---\nname: design-feature\ndescription: Synthetic completed-planning precondition.\ndisable-model-invocation: true\n---\nPrepare the approved local spec and tickets.\n';
    writeFileSync(path, content); return bundledPlanningMethod({ id: 'execution-planning-fixture', path, sha256: hash(content) }, vendor);
  });
  f.configuration.methods.implementation = bundledImplementationMethod(vendor);
  f.configuration.methods.review = bundledImplementationMethod(vendor);
  f.configuration.provider!.allowedRoles = ['planning', 'boundary-review', 'implementation', 'review'];
  const methods = f.production.captureMethods();
  const demand = () => f.store.getDemand('demand');
  const command = (body: Omit<UserCommand, 'requestId' | 'demandId'> | Record<string, unknown>) => f.workflow.execute({ ...body, requestId: randomUUID(), demandId: 'demand', expectedRevision: demand().revision } as UserCommand, f.user);
  for (const stage of ['implementation', 'review'] as const) command({ type: 'switch-method', stage, method: methods[stage]!, reason: 'Explicitly select the pinned local implement-spec protocol for this fixture.', impactReviewed: true });
  const save = (id: string, text: string, runId = 'synthetic-planning-precondition') => f.production.evidence.save({ id, projectId: 'project', demandId: 'demand', runId, kind: 'plan', text });
  const flow = () => demand().planningFlow!;
  const handoff = (step: PlanningWorkStep, body: Record<string, unknown>) => {
    const run = f.workflow.claimNextRun({ demandId: 'demand', profileVerified: true, budgetAvailable: true, workspaceVerified: true }); assert.ok(run); assert.equal(run.planningStep, step);
    const inputDigest = planningInputDigest(demand(), step);
    const verification: ReportVerification = { artifactsVerified: true, planningStage: { runId: run.id, planningStep: step, flowId: flow().id, flowRevision: flow().revision, inputDigest, sourceVerified: true, requiredSkillVerified: true, actualRunObserved: true, actualStopVerified: true } };
    if (step === 'facts' || step === 'design-review') verification.planningIndependent = { kind: step, runId: run.id, contextId: run.contextId, flowId: flow().id, flowRevision: flow().revision, inputDigest, evidenceDigest: (step === 'facts' ? body.evidence as ArtifactRef : (body.review as { evidence: ArtifactRef }).evidence).digest, actualRunObserved: true, isolatedInputsVerified: true, readOnlyVerified: true };
    f.workflow.report({ ...body, flowId: flow().id, flowRevision: flow().revision, requestId: randomUUID(), demandId: 'demand', runId: run.id, generation: run.generation } as WorkerReport & PlanningWorkerReport, f.workflow.workerContext(run.id), verification);
    f.workflow.confirmStopped(run.id, { processAbsent: true, descendantsAbsent: true, workspaceVerified: true, evidence: 'SYNTHETIC completed-planning precondition only; not a production execution observation.' });
  };
  handoff('facts', { type: 'planning-facts', evidence: save('facts', 'Observed code.txt baseline; no implementation exists.'), summary: 'Existing source baseline is retained.' });
  handoff('clarification', { type: 'planning-clarification', understanding: { id: 'understanding', scope: 'Deliver behavior through its existing caller.', acceptanceCriteria: ['R1: requested input is preserved.', 'R2: empty and repeated input are preserved; undefined returns fallback.'], nonGoals: ['No external publication.'], constraints: ['Keep work local and uncommitted.'], evidence: save('understanding', 'R1 requested behavior. R2 empty, repeated, and undefined input behavior.') }, questions: [] });
  command({ type: 'confirm-understanding', flowId: flow().id, flowRevision: flow().revision, understandingId: flow().understanding!.id, digest: flow().understanding!.digest });
  handoff('design', { type: 'planning-design', design: { id: 'design', understandingDigest: flow().understanding!.digest, summary: 'One behavior(value) entry point owns the specified result.', testingSeams: [seam], constraints: ['Use the caller seam without new external dependencies.'], evidence: save('design', `Testing Decisions: ${seam}`) } });
  handoff('design-review', { type: 'planning-design-review', review: { id: 'design-review', designDigest: flow().design!.digest, evidence: save('design-review', 'Independent synthetic planning fixture review.'), findings: [] } });
  handoff('design-resolution', { type: 'planning-design-resolution', resolution: { id: 'design-resolution', reviewId: flow().review!.id, designDigest: flow().design!.digest, evidence: save('final-design', `Approved design and Testing Decisions: ${seam}`), dispositions: [] }, questions: [] });
  command({ type: 'confirm-final-design', flowId: flow().id, flowRevision: flow().revision, designId: flow().design!.id, digest: flow().resolution!.digest });
  handoff('spec', { type: 'planning-spec', spec: { id: 'spec', kind: 'spec', designDigest: flow().design!.digest, evidence: save('spec', `R1: requested input is preserved. R2: empty and repeated input are preserved; undefined returns fallback. Testing Decisions: ${seam}`), requiredChecks: [{ id: 'behavior', name: 'Whole-spec behavior at the approved caller seam', source: 'demand' }] } });
  handoff('tickets', { type: 'planning-tickets', planId: 'ready-plan', ticketIndex: save('ticket-index', 'ticket-one then ticket-two. Both retain the approved Testing Decisions.'), tickets: [
    { id: 'ticket-one', kind: 'ticket', title: 'Deliver requested input behavior', specId: 'spec', specClauses: ['R1'], evidence: save('ticket-one', 'Implement R1 through behavior(value).'), blockedBy: [] },
    { id: 'ticket-two', kind: 'ticket', title: 'Preserve empty repeated and undefined input', specId: 'spec', specClauses: ['R1', 'R2'], evidence: save('ticket-two', 'Implement R2 after ticket-one through the same caller seam.'), blockedBy: ['ticket-one'] },
  ] });
  assert.equal(demand().planningFlow!.step, 'complete'); assert.equal(demand().grant, undefined);
  const nativeChecks: { runId: string; args: string[]; requestId: string; exitCode: number | null; output: string }[] = [];
  const authorizeImplementation = () => command({ type: 'authorize-implementation', planId: 'ready-plan', localCommit: false });
  const authorizeModel = (runtime = true) => {
    const id = randomUUID(), provider = f.configuration.provider!;
    const data = [...f.production.requiredModelData('demand'), ...Object.values(demand().methodSnapshot).flatMap(method => f.production.evidence.method(method!)).map(({ id, sha256 }) => ({ id, sha256 }))];
    f.budget.grant({ id, demandId: 'demand', decisionId: `decision-${id}`, provider: provider.provider, modelId: provider.modelId, destination: provider.destination, credentialRef: provider.credentialRef!, data, allowedRoles: ['implementation', 'review'], contextPolicy: 'approved-run-derived-v1', ...provider.limits! });
    f.store.db.prepare('INSERT INTO host_model_decisions VALUES(?,?,?,?)').run(id, 'demand', `decision-${id}`, runtime ? 'demand-worktree-private-runtime-v1' : null); return id;
  };
  const launch = async (step: ExecutionWorkStep) => {
    assert.equal(demand().executionFlow!.step, step); await f.production.tick();
    const candidates = f.drivers.flatMap(driver => driver.launches.map(launch => ({ driver, launch }))).filter(({ launch }) => f.store.getRun(launch.init.domainRunId).status !== 'stopped');
    assert.equal(candidates.length, 1, JSON.stringify({ diagnostics: f.production.diagnostics('demand'), blockers: demand().blockedReasons }));
    const current = candidates[0]!; assert.equal(current.launch.init.execution!.step, step);
    Object.defineProperty(current.driver, 'runNodeCheck', { configurable: true, value: async (runId: string, args: string[], _limits: unknown, requestId: string) => {
      assert.deepEqual(args, ['--test', '--test-isolation=none', 'behavior.test.mjs'], 'Synthetic fixture accepts only its explicit local Node test command.');
      const result = spawnSync(process.execPath, args, { cwd: current.launch.init.workspace, encoding: 'utf8', timeout: 10_000, maxBuffer: 524288 });
      assert.equal(result.error, undefined); const output = `${result.stdout}${result.stderr}`;
      nativeChecks.push({ runId, args, requestId, exitCode: result.status, output });
      return { requestId, exitCode: result.status, output, reason: 'exited', nativeEvidence: { synthetic: true, localNodeChildOnly: true, isolationEvidence: false } };
    } });
    return current;
  };
  return { ...f, demand, command, save, authorizeImplementation, authorizeModel, launch, nativeChecks };
}
export type ExecutionFixture = ReturnType<typeof executionProductionFixture>;
export const node = () => call('controlled_node', { args: ['--test', '--test-isolation=none', 'behavior.test.mjs'] });
export const write = (path: string, content: string) => call('controlled_write', { path, content });
export const testBody = (assertions: string) => `import assert from 'node:assert/strict';\nimport { behavior } from './behavior.mjs';\n${assertions}\n`;
export function writerScript(f: ExecutionFixture, launch: Launch, input: { id: string; tests: string; source: string; alter?: (report: Record<string, unknown>) => void }): Script {
  let red: ArtifactRef, green: ArtifactRef;
  return (request, turn) => {
    let toolCalls: NonNullable<ProviderResponse['toolCalls']> = [];
    if (turn === 1) toolCalls = [call('controlled_skill', { name: 'implement-spec' })];
    if (turn === 2) toolCalls = [call('controlled_skill', { name: launch.init.executionSkills!.active.name })];
    if (turn === 3) toolCalls = [write('behavior.test.mjs', testBody(input.tests))];
    if (turn === 4) toolCalls = [node()];
    if (turn === 5) { red = checkReceipt(request); toolCalls = [write('behavior.mjs', input.source)]; }
    if (turn === 6) toolCalls = [node()];
    if (turn === 7) {
      green = checkReceipt(request); const report: Record<string, unknown> = { type: 'execution-content', content: { id: input.id, planId: 'ready-plan', code: { id: `code-${input.id}`, digest: 'pending', location: 'current-worktree' }, knowledge: [], maintenance: 'not-needed', deliveryNotes: 'WRITER-PRIVATE-DELIVERY-NOTES: synthetic local behavior verified at approved caller seam.' }, tdd: { mode: 'red-green', testingSeams: [seam], red: [red], green: [green] }, ...(launch.init.execution!.step === 'ticket-fix' ? { repairScopeId: f.demand().executionFlow!.repairScope!.id } : {}) };
      input.alter?.(report); toolCalls = [call('controlled_report', { report })];
    }
    return { text: turn === 1 ? 'WRITER-PRIVATE-CHAT: scratch reasoning is isolated from reviewers.' : '', ...(toolCalls.length ? { toolCalls } : {}) };
  };
}
export function reviewScript(f: ExecutionFixture, launch: Launch, findings: ExecutionFindingInput[] = [], inspect?: (request: Parameters<Script>[0], turn: number) => void): Script {
  const step = launch.init.execution!.step, axis = step.endsWith('standards') ? 'standards' : 'spec', focused = step.startsWith('resolution-');
  return (request, turn) => {
    inspect?.(request, turn); let toolCalls: NonNullable<ProviderResponse['toolCalls']> = [];
    if (turn === 1) toolCalls = [call('controlled_skill', { name: 'implement-spec' })];
    if (turn === 2) toolCalls = [call('controlled_skill', { name: launch.init.executionSkills!.active.name })];
    if (turn === 3) toolCalls = [node()];
    if (turn === 4) toolCalls = [call('controlled_report', { report: { type: 'check', check: { id: `check-${launch.init.domainRunId}`, contentId: f.demand().activeContentId!, requirementId: 'behavior', status: 'passed', evidence: checkReceipt(request), environment: 'host-observed' } } })];
    if (turn === 5) {
      const id = `${step}-${f.demand().activeContentId}`, evidence = pending(id), contentId = f.demand().activeContentId!;
      const selected = f.demand().executionFlow!.reviews.filter(review => review.axis === axis).flatMap(review => review.findings);
      const report = focused ? { type: 'execution-resolution', resolution: { id, axis, contentId, repairScopeId: f.demand().executionFlow!.repairScope!.id, evidence, dispositions: selected.map(finding => ({ findingId: finding.id, outcome: 'fixed', rationale: 'The exact cited finding is resolved at the same approved caller seam.', evidence })) } } : { type: 'execution-review', review: { id, axis, contentId, evidence, knowledgeReviewed: true, findings } };
      toolCalls = [call('controlled_report', { report: { ...report, artifactBodies: [{ id, kind: 'check-evidence', text: `${axis.toUpperCase()}-PRIVATE-REVIEW-EVIDENCE: exact source and local knowledge checked.` }] } })];
    }
    return { text: turn === 1 ? `${axis.toUpperCase()}-PRIVATE-CHAT` : '', ...(toolCalls.length ? { toolCalls } : {}) };
  };
}
export async function drive(f: ExecutionFixture, current: Awaited<ReturnType<ExecutionFixture['launch']>>, script: Script) {
  const before = structuredClone(f.demand().executionFlow);
  current.driver.beforeSettled = () => assert.deepEqual(f.demand().executionFlow, before, 'No live Worker can advance the persisted execution flow.');
  f.setScript(script); await current.driver.drive(current.launch); current.driver.beforeSettled = undefined;
  if (f.scriptErrors.length) throw f.scriptErrors[0];
  await f.coordinator.observeCompletedRuns();
  assert.equal(f.store.getRun(current.launch.init.domainRunId).status, 'stopped');
  assert.equal(current.driver.stopped.has(current.launch.run.runId), true);
}
export async function implementTickets(f: ExecutionFixture, omitFallback = false) {
  const first = await f.launch('ticket-implementation');
  await drive(f, first, writerScript(f, first.launch, { id: 'K1', tests: "assert.equal(behavior('requested'), 'requested');", source: "export function behavior(value) { return 'requested'; }\n" }));
  assert.equal(f.demand().executionFlow!.ticketId, 'ticket-two');
  const second = await f.launch('ticket-implementation');
  await drive(f, second, writerScript(f, second.launch, { id: 'K2', tests: "assert.equal(behavior(''), ''); assert.equal(behavior('requested'), 'requested'); assert.equal(behavior('requested'), 'requested');", source: omitFallback ? 'export function behavior(value) { return value; }\n' : "export function behavior(value) { return value === undefined ? 'fallback' : value; }\n" }));
  assert.equal(f.demand().executionFlow!.step, 'review-standards'); return { first, second };
}
