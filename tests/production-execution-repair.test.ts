import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executionProductionFixture, implementTickets, drive, reviewScript, writerScript, call, context, pending, seam, git, deferred, uncheckedContent, boundReport, loadSkill, consumeSkills } from './helpers/execution-production.ts';
import type { ExecutionFixture, Launch, SyntheticPlanningNativePort } from './helpers/execution-production.ts';
import type { ExecutionFindingInput } from '../src/domain/types.ts';
import { HostApplication } from '../src/host/application.ts';

// Installed Pi SDK + actual Worker framing + production Host/SQLite/Git.
// Native ownership/ACL observations and provider responses are explicitly
// synthetic. Local Node checks execute for real; no network model call occurs.
test('production findings enter one serial fix and focused axis resolutions without restarting broad review', async t => {
  const f = executionProductionFixture(t); f.authorizeImplementation(); f.authorizeModel(); await implementTickets(f, true);
  const standards = await f.launch('review-standards');
  const standardRef = f.production.evidence.reference('demand', standards.launch.init.materials.find(material => material.id.startsWith('execution-standards:'))!.id);
  const finding = (id: string, category: ExecutionFindingInput['category']): ExecutionFindingInput => ({ id, category, severity: 'blocking', location: 'behavior.mjs:1', basis: category === 'spec-violation' ? 'R2 specifies the undefined fallback.' : 'CONTRIBUTING.md requires explicit undefined handling at the entry point.', impact: 'The exact documented obligation is not implemented.', verification: seam, reference: category === 'spec-violation' ? f.demand().planningFlow!.spec!.evidence : standardRef, ...(category === 'spec-violation' ? { clause: 'R2' } : {}), requiresDesignDecision: false });
  await drive(f, standards, reviewScript(f, standards.launch, [finding('standards-entry', 'documented-violation')]));
  assert.equal(f.demand().executionFlow!.step, 'review-spec', 'Standards findings are collected before launching a single combined repair.');
  const spec = await f.launch('review-spec'); await drive(f, spec, reviewScript(f, spec.launch, [finding('spec-fallback', 'spec-violation')]));
  const repair = f.demand().executionFlow!.repairScope!; assert.deepEqual(repair.findingIds.sort(), ['spec-fallback', 'standards-entry']); assert.equal(f.demand().activeResultId, undefined);
  const fix = await f.launch('ticket-fix'); assert.equal(fix.launch.run.writes, true);
  await drive(f, fix, writerScript(f, fix.launch, { id: 'K3', tests: "assert.equal(behavior(undefined), 'fallback'); assert.equal(behavior(''), ''); assert.equal(behavior('requested'), 'requested');", source: "export function behavior(value) { return value === undefined ? 'fallback' : value; }\n" }));
  const standardsResolution = await f.launch('resolution-standards');
  const inputs = JSON.parse(standardsResolution.launch.init.materials.find(item => item.id.startsWith('execution-input:'))!.content);
  assert.deepEqual(inputs.repairScope.findingIds, ['standards-entry']); assert.ok(!JSON.stringify(inputs).includes('spec-fallback'));
  await drive(f, standardsResolution, reviewScript(f, standardsResolution.launch));
  const specResolution = await f.launch('resolution-spec');
  const specInputs = JSON.parse(specResolution.launch.init.materials.find(item => item.id.startsWith('execution-input:'))!.content);
  assert.deepEqual(specInputs.repairScope.findingIds, ['spec-fallback']); assert.ok(!JSON.stringify(specInputs).includes('standards-entry'));
  await drive(f, specResolution, reviewScript(f, specResolution.launch));
  assert.equal(f.demand().executionFlow!.step, 'complete'); assert.equal(f.demand().executionFlow!.reviews.length, 2); assert.equal(f.demand().executionFlow!.resolutions.length, 2);
  assert.ok(f.demand().findings.every(item => item.status === 'closed')); assert.equal(f.demand().activeContentId, 'K3'); assert.equal(f.demand().results.length, 1);
  // Reopen the persisted production database through the desktop Host facade.
  f.store.db.exec('ALTER TABLE host_model_decisions ADD COLUMN configuration_digest TEXT');
  const app = new HostApplication(join(f.root, 'host.sqlite'));
  try {
    const view = app.snapshot().demands.find(demand => demand.id === 'demand')!;
    assert.deepEqual(view.executionFlow, f.demand().executionFlow);
    assert.deepEqual(view.executionFlow!.tickets.map(ticket => ticket.status), ['done', 'done']);
    assert.equal(view.executionFlow!.reviews.length, 2); assert.equal(view.executionFlow!.resolutions.length, 2);
  } finally { app.close(); }
  assert.deepEqual(f.drivers.flatMap(driver => driver.launches).map(item => item.init.execution!.step), ['ticket-implementation', 'ticket-implementation', 'review-standards', 'review-spec', 'ticket-fix', 'resolution-standards', 'resolution-spec']);
});
