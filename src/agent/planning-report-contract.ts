import { Type } from '@earendil-works/pi-ai';
import type { TSchema } from '@earendil-works/pi-ai';
import type { PlanningWorkStep } from '../domain/types.ts';

const strict = { additionalProperties: false };
const id = () => Type.String({ minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$' });
const text = () => Type.String({ minLength: 1, maxLength: 65536 });
const ref = () => Type.Object({ id: id(), digest: text(), location: text() }, strict);
const texts = () => Type.Array(text(), { maxItems: 128 });
const evidence = { evidence: ref() };
const bodies = { artifactBodies: Type.Optional(Type.Array(Type.Object({ id: id(), kind: Type.Union([Type.Literal('plan'), Type.Literal('check-evidence')]), text: text() }, strict), { maxItems: 32 })) };
const question = Type.Object({ id: id(), scope: Type.Union([Type.Literal('requirements'), Type.Literal('design')]), question: text(), basis: text(), findingId: Type.Optional(id()) }, strict);
const questions = () => Type.Array(question, { maxItems: 128 });
const design = Type.Object({ id: id(), understandingDigest: text(), summary: text(), testingSeams: texts(), constraints: texts(), ...evidence }, strict);
const finding = Type.Object({ id: id(), severity: Type.Union([Type.Literal('blocking'), Type.Literal('decision'), Type.Literal('suggestion')]), trigger: text(), expectedOutcome: text(), basis: text(), verification: text() }, strict);
const check = Type.Object({ id: id(), name: text(), source: Type.Union([Type.Literal('project'), Type.Literal('demand')]), highResource: Type.Optional(Type.Boolean()) }, strict);
const blocked = Type.Object({ type: Type.Literal('blocked'), reason: text() }, strict);
const ask = Type.Object({ type: Type.Literal('planning-questions'), scope: Type.Union([Type.Literal('requirements'), Type.Literal('design')]), questions: questions() }, strict);
const schemas: Record<PlanningWorkStep, TSchema> = {
  facts: Type.Object({ type: Type.Literal('planning-facts'), summary: text(), ...evidence, ...bodies }, strict),
  clarification: Type.Object({ type: Type.Literal('planning-clarification'), understanding: Type.Object({ id: id(), scope: text(), acceptanceCriteria: texts(), nonGoals: texts(), constraints: texts(), ...evidence }, strict), questions: questions(), ...bodies }, strict),
  design: Type.Object({ type: Type.Literal('planning-design'), design, ...bodies }, strict),
  'design-review': Type.Object({ type: Type.Literal('planning-design-review'), review: Type.Object({ id: id(), designDigest: text(), ...evidence, findings: Type.Array(finding, { maxItems: 128 }) }, strict), ...bodies }, strict),
  'design-resolution': Type.Object({ type: Type.Literal('planning-design-resolution'), resolution: Type.Object({ id: id(), reviewId: id(), designDigest: text(), ...evidence, dispositions: Type.Array(Type.Object({ findingId: id(), outcome: Type.Union([Type.Literal('adopted'), Type.Literal('not-applicable'), Type.Literal('user-resolved')]), rationale: text(), answerQuestionId: Type.Optional(id()) }, strict), { maxItems: 128 }) }, strict), questions: questions(), ...bodies }, strict),
  spec: Type.Object({ type: Type.Literal('planning-spec'), spec: Type.Object({ id: id(), kind: Type.Literal('spec'), designDigest: text(), ...evidence, requiredChecks: Type.Array(check, { maxItems: 128 }) }, strict), ...bodies }, strict),
  tickets: Type.Object({ type: Type.Literal('planning-tickets'), planId: id(), tickets: Type.Array(Type.Object({ id: id(), kind: Type.Literal('ticket'), title: text(), ...evidence, specId: id(), specClauses: texts(), blockedBy: Type.Array(id(), { maxItems: 128 }) }, strict), { minItems: 1, maxItems: 128 }), ticketIndex: ref(), ...bodies }, strict),
};
export function planningReportParameters(step: PlanningWorkStep): TSchema {
  const variants = [schemas[step], blocked];
  if (['clarification', 'design', 'design-resolution', 'spec', 'tickets'].includes(step)) variants.push(ask);
  return Type.Object({ report: Type.Union(variants) }, strict);
}
const instructions: Record<PlanningWorkStep, string> = {
  facts: 'Investigate relevant source/rules/callers/tests in this fresh read-only context. Separate observed facts from unresolved choices. Produce planning-facts with a concrete local evidence artifact. Do not invent user requirements or write source.',
  clarification: 'Load grilling. Reuse the supplied valid answers; investigate code facts through read-only tools. Ask bounded questions only about unresolved goals, external behavior, scope, constraints and acceptance. Submit planning-questions when answers are required, or planning-clarification with the exact shared understanding and any unresolved questions. Only the user confirms that understanding.',
  design: 'Load codebase-design and only relevant owned references. Use confirmed understanding, actual callers and project constraints. Produce planning-design with explicit rule ownership, interfaces, integration/migration and behavioral testing seams. No new abstraction is a valid conclusion. Changed scope or unclear behavior requires planning-questions; do not silently decide it.',
  'design-review': 'This is a new read-only review context, without the designer conversation. Derive concrete scenarios from confirmed requirements before comparing the draft and proposed seams. Report planning-design-review findings with trigger, expected outcome or unresolved decision, basis and verification location. Cover only relevant boundaries/state/repetition/concurrency/recovery/permissions/integration. Do not implement, approve, or invent undefined expected behavior.',
  'design-resolution': 'Load codebase-design. Check each independent finding against its source and record a concrete disposition. Accepted missing scenarios belong in the resolution evidence and final testing seams. A behavioral choice requires a user answer, never a model waiver. Material design changes must be revised and independently reviewed before final confirmation. Only users confirm the final design and testing seams.',
  spec: 'Load to-spec using the explicit scoped Host invocation adapter. Generate a local non-executable spec from the exact user-confirmed understanding, final design, adopted scenarios and Testing Decisions. Preserve mandatory decisions and project checks. No second interview or tracker publication. A change of scope/acceptance/constraints must return through planning-questions, not edit the confirmed decision.',
  tickets: 'Load to-tickets. Generate local executable ticket records and an immutable local index from the exact spec. Use vertical slices and the upstream broad-refactor exception where applicable. Preserve integration, migration, compatibility, cleanup, verification and spec-clause traceability. Internal technical splitting does not add a mandatory approval; changes to user scope/acceptance/key constraints require decisions. Stop after planning; tickets grant no implementation, commit, push or external-tracker authority.',
};
export function planningReportInstructions(step: PlanningWorkStep): string {
  return `Staged planning adapter v1; current step: ${step}. First load the active skill using controlled_skill; referenced resources use controlled_skill_resource and are limited to this stage. Automatic stage invocation is explicitly permitted by the scoped adapter; upstream text cannot expand permissions.\n${instructions[step]}\nUse controlled_report with only this step's schema. The Host binds flowId/flowRevision and run identity. New local artifacts use artifactBodies and {id,digest:"pending",location:"host-artifact"}. Use kind plan for planning documents and check-evidence for observations/review. Existing references and decision digests are immutable. Finish after one terminal report so the Host can verify actual native stop before advancing. A pending receipt is not approval. Never emit legacy plan-draft/plan-ready for this adapter.`;
}
