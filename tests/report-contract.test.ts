import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { controlledReportParameters, reportAdapterInstructions } from '../src/agent/report-contract.ts';
import { explicitResourceLoader } from '../src/agent/resources.ts';
import { emptyConfiguration, loadMethods } from '../src/host/configuration.ts';
import { hash } from '../src/host/evidence.ts';

const variants = (role: 'planning'|'boundary-review'|'implementation'|'review') => (JSON.parse(JSON.stringify(controlledReportParameters(role))).properties.report.anyOf as {properties:Record<string,any>;required:string[]}[]);
test('report schema exposes complete role-specific P/C/evidence/finding variants without Host authority fields', () => {
  const planning = variants('planning'), boundary = variants('boundary-review'), implementation = variants('implementation'), review = variants('review');
  const find = (items: ReturnType<typeof variants>, type: string) => items.find(item => item.properties.type.const === type)!;
  assert.ok(find(planning, 'plan-draft')); assert.equal(find(planning, 'plan-ready'), undefined); assert.ok(find(boundary, 'plan-ready'));
  assert.deepEqual(find(planning, 'plan-draft').properties.plan.required, ['id','scope','spec','tickets','requiredChecks','unresolvedQuestions']);
  assert.deepEqual(find(implementation, 'content-ready').properties.content.required, ['id','planId','code','knowledge','maintenance','deliveryNotes']);
  assert.deepEqual(find(review, 'check').properties.check.required, ['id','contentId','requirementId','status','evidence','environment']);
  assert.ok(find(review, 'review').properties.findings.items.required.includes('verification')); assert.ok(find(review, 'resolve-finding')); assert.equal(find(implementation, 'resolve-finding'), undefined);
  for (const items of [planning,boundary,implementation,review]) for (const variant of items) for (const field of ['requestId','runId','generation','demandId','accepted','authorized']) assert.equal(variant.properties[field], undefined);
});
test('every real Agent assembly includes the Host adapter independently of the selected external method', () => {
  for (const role of ['planning','boundary-review','implementation','review'] as const) {
    const content = 'USER-SUPPLIED-METHOD-CONTENT';
    const prompt = explicitResourceLoader(role, [{ id:'selected-method',kind:'method',sha256:hash(content),content }]).getSystemPrompt()!;
    assert.match(prompt,/Host report adapter v1/); assert.match(prompt,/USER-SUPPLIED-METHOD-CONTENT/); assert.match(prompt,/project-checks/); assert.match(prompt,/content-scope/);
    assert.ok(prompt.includes(reportAdapterInstructions(role)));
  }
});
test('candidate implementation/review method files load only by explicit hash selection and do not replace design-feature', () => {
  const configuration = emptyConfiguration();
  for (const stage of ['implementation','review'] as const) {
    const path = fileURLToPath(new URL(`../methods/${stage}-candidate-v1.md`, import.meta.url)), content = readFileSync(path,'utf8');
    assert.match(content,/explicit candidate method/); configuration.methods[stage] = { id:`${stage}-candidate-v1`,logicalName:stage,path,sha256:hash(content),version:'1.0.0',adapter:'explicit-text-v1',dependencies:[] };
  }
  const loaded = loadMethods(configuration); assert.ok(loaded.methods.implementation); assert.ok(loaded.methods.review); assert.equal(loaded.methods.planning, undefined);
});
