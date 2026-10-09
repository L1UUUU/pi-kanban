import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { HostApplication } from '../src/host/application.ts';
import { syntheticPlanningFlow } from '../src/desktop/renderer/planning-preview.ts';
import { makePlanningCommand } from '../src/desktop/renderer/planning-model.ts';
import { COMMANDS } from '../src/host/protocol.ts';
import { bundledPlanningMethod, emptyConfiguration } from '../src/host/configuration.ts';

/** Controller tests inject explicitly synthetic persisted stage records; they
 * do not attest real planning, independent review, model use, or native runtime. */
function setup(app: HostApplication, step: Parameters<typeof syntheticPlanningFlow>[0], control: 'active' | 'paused' = 'active') {
  const project = app.workflow.createProject({ name: 'Synthetic staged UI controller', rootPath: tmpdir() });
  const demand = app.workflow.createDemand({ projectId: project.id, title: 'Synthetic requirements', description: 'Controller fixture only' });
  demand.planningStarted = true; demand.control = control; demand.planningFlow = syntheticPlanningFlow(step);
  demand.methodSnapshot = { planning: { id: 'synthetic-staged-method', digest: 'a'.repeat(64), version: 'fixture', adapter: 'design-feature-staged-v1' } };
  demand.phase = step.includes('confirmation') ? 'awaiting-design' : 'planning';
  app.store.saveDemand(demand);
  return app.snapshot().demands.find(item => item.id === demand.id)!;
}

test('Host staged controls require explicit current flow, digest, revision and permitted revision scope', () => {
  const app = new HostApplication();
  try {
    const target = setup(app, 'awaiting-understanding-confirmation');
    const command = makePlanningCommand({ kind: 'confirm-understanding', demand: target }, { reviewed: true }, 'synthetic-confirm');
    for (const key of ['expectedVersion', 'flowId', 'flowRevision', 'understandingId', 'digest']) {
      const invalid = { ...command }; delete invalid[key as keyof typeof invalid];
      assert.throws(() => app.handle('command', invalid));
    }
    assert.throws(() => app.handle('command', { ...command, digest: 'not-a-hash' }), /digest/);
    assert.throws(() => app.handle('command', { ...command, flowId: 'other-flow' }), /planning version/);
    assert.throws(() => app.handle('command', { ...command, kind: 'revise-planning', scope: 'tickets', text: 'bypass decision' }), /requirements or design/);
    assert.equal(app.store.getDemand(target.id).revision, target.version);
    assert.equal(app.store.getDemand(target.id).grant, undefined);
    for (const kind of ['answer-planning-question', 'confirm-understanding', 'confirm-final-design', 'revise-planning']) assert.equal(COMMANDS.has(kind), true);
  } finally { app.close(); }
});

test('Host records separate requirement and final-design consent without model or implementation approval', () => {
  const app = new HostApplication();
  try {
    const first = setup(app, 'awaiting-understanding-confirmation');
    const requirementCommand = makePlanningCommand({ kind: 'confirm-understanding', demand: first }, { reviewed: true }, 'requirements');
    let result = app.handle('command', requirementCommand).demands.find(item => item.id === first.id)!;
    assert.equal(result.planningFlow!.step, 'design'); assert.ok(result.planningFlow!.understandingConfirmation); assert.equal(result.planningFlow!.finalDesignConfirmation, undefined);
    assert.equal(app.store.getDemand(first.id).grant, undefined);
    assert.equal(app.handle('command', requirementCommand).demands.find(item => item.id === first.id)!.version, result.version);
    assert.throws(() => app.handle('command', { ...requirementCommand, requestId: 'stale-new-click' }), /revision changed/);
    const finalTarget = setup(app, 'awaiting-final-design-confirmation'), finalCommand = makePlanningCommand({ kind: 'confirm-final-design', demand: finalTarget }, { reviewed: true }, 'final-design');
    assert.throws(() => app.handle('command', { ...finalCommand, digest: finalTarget.planningFlow!.design!.digest }), /exact reviewed design/);
    result = app.handle('command', finalCommand).demands.find(item => item.id === finalTarget.id)!;
    assert.equal(result.planningFlow!.step, 'spec'); assert.equal(result.planningFlow!.confirmations.length, 2);
    assert.equal(app.store.getDemand(finalTarget.id).grant, undefined); assert.equal(app.store.listRuns().length, 0);
    assert.equal(app.store.db.prepare('SELECT count(*) n FROM model_grants').get()!.n, 0);
    assert.equal(app.snapshot().runtime.executionEnabled, false);
  } finally { app.close(); }
});

test('Host paused answers and scoped revisions retain control plus immutable prior findings across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-planning-host-')), database = join(directory, 'host.sqlite');
  let app = new HostApplication(database);
  try {
    const target = setup(app, 'design-resolution', 'paused'), question = target.planningFlow!.questions[0];
    const answer = makePlanningCommand({ kind: 'answer-planning-question', demand: target, questionId: question.id }, { text: 'Synthetic: preserve equal boundaries.' }, 'answer');
    let current = app.handle('command', answer).demands[0];
    assert.equal(current.control, 'paused'); assert.equal(current.planningFlow!.answers[0].questionDigest, question.digest); assert.equal(current.planningFlow!.finalDesignConfirmation, undefined);
    const originalRequirements = structuredClone(current.planningFlow!.understandingConfirmation);
    current = app.handle('command', makePlanningCommand({ kind: 'revise-planning', demand: current, scope: 'design' }, { text: 'Synthetic: change only the testing seam.' }, 'revise')).demands[0];
    assert.equal(current.control, 'paused'); assert.equal(current.planningFlow!.step, 'design');
    assert.deepEqual(current.planningFlow!.understandingConfirmation, originalRequirements);
    assert.equal(current.planningFlow!.history[0].review!.id, 'synthetic-design-review');
    assert.equal(current.planningFlow!.history[0].answers[0].answer, 'Synthetic: preserve equal boundaries.');
    const savedFlow = structuredClone(current.planningFlow);
    current.planningFlow!.history[0].review!.findings[0].basis = 'Mutated display clone';
    app.close(); app = new HostApplication(database);
    const restored = app.snapshot().demands[0];
    assert.deepEqual(restored.planningFlow, savedFlow); assert.equal(restored.control, 'paused');
    assert.equal(app.store.listRuns().length, 0); assert.equal(app.store.outbox('pending').filter(item => item.kind === 'start-run').length, 0);
  } finally { app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Host rejects first planning decisions with native execution active but reconciles an exact saved receipt', () => {
  const app = new HostApplication();
  try {
    const target = setup(app, 'awaiting-understanding-confirmation'), command = makePlanningCommand({ kind: 'confirm-understanding', demand: target }, { reviewed: true }, 'stable-receipt');
    const request = { demandId: target.id, role: 'boundary-review', writes: false, grantId: 'synthetic', workspace: tmpdir(), profileId: 'synthetic', timeoutMs: 1000, maxOutputBytes: 1000 };
    app.store.db.prepare('INSERT INTO runtime_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-still-running', target.id, 'synthetic-generation', 'unknown', 0, 0, JSON.stringify(request), null, null, new Date().toISOString(), new Date().toISOString(), null);
    assert.throws(() => app.handle('command', command), /native execution tree/);
    app.store.db.prepare("UPDATE runtime_runs SET state='stopped' WHERE run_id='synthetic-still-running'").run();
    const applied = app.handle('command', command).demands[0];
    app.store.db.prepare("UPDATE runtime_runs SET state='unknown' WHERE run_id='synthetic-still-running'").run();
    assert.equal(app.handle('command', command).demands[0].version, applied.version);
    assert.throws(() => app.handle('command', { ...command, digest: 'f'.repeat(64) }), /different content/);
    assert.equal(app.store.getDemand(target.id).planningFlow!.confirmations.length, 1);
  } finally { app.close(); }
});

test('Host configuration snapshots and JSON re-import preserve the complete pinned planning skill bundle', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-planning-config-ui-')), app = new HostApplication();
  try {
    const path = join(directory, 'synthetic-entry.md'), source = '---\nname: design-feature\ndescription: Synthetic UI configuration fixture\ndisable-model-invocation: true\n---\nSynthetic private entry body, never included in a display snapshot.\n';
    writeFileSync(path, source);
    const configuration = emptyConfiguration();
    configuration.methods.planning = bundledPlanningMethod({ id: 'synthetic-ui-method', path, sha256: createHash('sha256').update(source).digest('hex') }, fileURLToPath(new URL('../vendor/mattpocock-skills', import.meta.url)));
    const original = structuredClone(configuration.methods.planning.skillBundle), imported = join(directory, 'input.json');
    writeFileSync(imported, JSON.stringify(configuration));
    const snapshot = app.handle('importConfiguration', { filePath: imported });
    assert.deepEqual(snapshot.configuration!.configuration.methods.planning!.skillBundle, original);
    assert.equal(snapshot.configuration!.methods.find(method => method.stage === 'planning')!.status, 'configured');
    const serialized = JSON.stringify(snapshot.configuration!.configuration);
    assert.doesNotMatch(serialized, /Synthetic private entry body/);
    const exported = join(directory, 'exported.json'); writeFileSync(exported, serialized);
    const reimported = app.handle('importConfiguration', { filePath: exported });
    assert.deepEqual(reimported.configuration!.configuration.methods.planning!.skillBundle, original);
    assert.equal(reimported.runtime.executionEnabled, false);
    assert.equal(app.store.db.prepare('SELECT count(*) n FROM model_grants').get()!.n, 0);
  } finally { app.close(); rmSync(directory, { recursive: true, force: true }); }
});
