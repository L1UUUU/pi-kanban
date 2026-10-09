/** Domain contracts. All IDs and evidence in tests are synthetic.
 * The Host owns WorkflowService; never expose it, trustedUser(), or workerContext()
 * to a renderer or Worker. Transport authentication is an adapter responsibility.
 */
export type Stage = 'planning' | 'implementation' | 'review';
export type Control = 'active' | 'paused' | 'cancelled' | 'exited';
export type Phase = 'idea' | 'planning' | 'awaiting-design' | 'awaiting-authorization' | 'implementing' | 'checking' | 'reviewing' | 'rework' | 'awaiting-acceptance' | 'accepted' | 'blocked';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ArtifactRef { id: string; digest: string; location: string }
export interface MethodSnapshot { id: string; version: string; digest: string; adapter: string; dependencies?: string[] }
export type Methods = Partial<Record<Stage, MethodSnapshot>>;
export interface CheckRequirement { id: string; name: string; source: 'project' | 'demand'; highResource?: boolean }
export interface Project { id: string; name: string; rootPath: string; methods: Methods; baseChecks: CheckRequirement[]; revision: number }
export interface PlanInput { id: string; scope: string; spec: ArtifactRef; tickets: ArtifactRef; requiredChecks: CheckRequirement[]; unresolvedQuestions: string[] }
export interface BoundaryReview { contextId: string; planningContextId: string; evidence: ArtifactRef; unresolvedBlockingFindings: string[] }
export interface PlanRevision extends PlanInput { ready: boolean; boundaryReview?: BoundaryReview; designBinding?: { flowId: string; understandingDigest: string; designDigest: string; finalConfirmationDigest: string }; createdByRun: string }
/** Optional persisted planning protocol. Legacy method adapters keep their original handoff. */
export type PlanningStep = 'facts' | 'clarification' | 'awaiting-understanding-confirmation' | 'design' | 'design-review' | 'design-resolution' | 'awaiting-final-design-confirmation' | 'spec' | 'tickets' | 'complete';
export type PlanningWorkStep = Exclude<PlanningStep, 'awaiting-understanding-confirmation' | 'awaiting-final-design-confirmation' | 'complete'>;
export interface PlanningBinding { flowId: string; flowRevision: number }
export interface PlanningQuestionInput { id: string; scope: 'requirements' | 'design'; question: string; basis: string; findingId?: string }
export interface PlanningQuestion extends PlanningQuestionInput { digest: string }
export interface PlanningAnswer { scope: 'requirements' | 'design'; questionId: string; question: string; questionDigest: string; findingId?: string; reviewId?: string; answer: string; userId: string; createdAt: string }
export interface UnderstandingInput { id: string; scope: string; acceptanceCriteria: string[]; nonGoals: string[]; constraints: string[]; evidence: ArtifactRef }
export interface PlanningUnderstanding extends UnderstandingInput { version: number; digest: string; createdByRun: string; contextId: string }
export interface DesignInput { id: string; understandingDigest: string; summary: string; testingSeams: string[]; constraints: string[]; evidence: ArtifactRef }
export interface PlanningDesign extends DesignInput { version: number; digest: string; createdByRun: string; contextId: string }
export interface PlanningReviewFinding { id: string; severity: 'blocking' | 'decision' | 'suggestion'; trigger: string; expectedOutcome: string; basis: string; verification: string }
export interface PlanningDesignReview { id: string; designDigest: string; evidence: ArtifactRef; findings: PlanningReviewFinding[]; runId: string; contextId: string; inputDigest: string }
export interface PlanningDisposition { findingId: string; outcome: 'adopted' | 'not-applicable' | 'user-resolved'; rationale: string; answerQuestionId?: string }
export interface PlanningResolution { id: string; reviewId: string; designDigest: string; evidence: ArtifactRef; dispositions: PlanningDisposition[]; digest: string; createdByRun: string }
export interface PlanningConfirmation { kind: 'understanding' | 'final-design'; targetId: string; digest: string; flowRevision: number; userId: string; createdAt: string }
/** A spec is a non-executable document; only local tickets carry work dependencies. */
export interface PlanningSpec { id: string; kind: 'spec'; designDigest: string; evidence: ArtifactRef; requiredChecks: CheckRequirement[]; createdByRun: string }
export interface PlanningTicket { id: string; kind: 'ticket'; title: string; evidence: ArtifactRef; specId: string; specClauses: string[]; blockedBy: string[] }
export type PlanningArchive = Omit<PlanningFlow, 'history'>;
export interface PlanningFlow {
  id: string; revision: number; step: PlanningStep; history: PlanningArchive[]; messages: Pick<DemandMessage, 'id' | 'text' | 'kind'>[];
  revisionInstruction?: { scope: 'requirements' | 'design'; reason: string; userId: string; createdAt: string };
  facts?: { evidence: ArtifactRef; summary: string; runId: string; contextId: string; inputDigest: string };
  understanding?: PlanningUnderstanding; design?: PlanningDesign; review?: PlanningDesignReview; resolution?: PlanningResolution;
  questions: PlanningQuestion[]; answers: PlanningAnswer[]; confirmations: PlanningConfirmation[];
  understandingConfirmation?: PlanningConfirmation; finalDesignConfirmation?: PlanningConfirmation;
  spec?: PlanningSpec; tickets: PlanningTicket[];
}
export type PlanningWorkerReport = PlanningBinding & (
  | { type: 'planning-facts'; evidence: ArtifactRef; summary: string }
  | { type: 'planning-questions'; scope: 'requirements' | 'design'; questions: PlanningQuestionInput[] }
  | { type: 'planning-clarification'; understanding: UnderstandingInput; questions: PlanningQuestionInput[] }
  | { type: 'planning-design'; design: DesignInput }
  | { type: 'planning-design-review'; review: Omit<PlanningDesignReview, 'runId' | 'contextId' | 'inputDigest'> }
  | { type: 'planning-design-resolution'; resolution: Omit<PlanningResolution, 'digest' | 'createdByRun'>; questions: PlanningQuestionInput[] }
  | { type: 'planning-spec'; spec: Omit<PlanningSpec, 'createdByRun'> }
  | { type: 'planning-tickets'; planId: string; tickets: PlanningTicket[]; ticketIndex: ArtifactRef }
);
export type PlanningUserCommand = PlanningBinding & (
  | { type: 'answer-planning-question'; questionId: string; questionDigest: string; answer: string }
  | { type: 'confirm-understanding'; understandingId: string; digest: string }
  | { type: 'confirm-final-design'; designId: string; digest: string }
  | { type: 'revise-planning'; scope: 'requirements' | 'design'; reason: string }
);
/** Trusted observation of the exact new read-only context, never a Worker flag. */
export interface PlanningIndependentVerification {
  kind: 'facts' | 'design-review'; runId: string; contextId: string; flowId: string; flowRevision: number;
  inputDigest: string; evidenceDigest: string; actualRunObserved: boolean; isolatedInputsVerified: boolean; readOnlyVerified: boolean;
}
export interface ContentInput { id: string; planId: string; code: ArtifactRef; knowledge: ArtifactRef[]; maintenance: 'complete' | 'not-needed'; deliveryNotes: string }
export interface ContentSnapshot extends ContentInput { createdByRun: string; cycle: number }
export interface CheckEvidence { id: string; contentId: string; requirementId: string; status: 'passed' | 'failed' | 'unavailable'; evidence: ArtifactRef; environment: string }
export interface FindingInput { id: string; severity: 'blocking' | 'suggestion' | 'decision'; location: string; basis: string; impact: string; verification: string }
export interface Finding extends FindingInput { contentId: string; reviewRunId: string; status: 'open' | 'disputed' | 'closed'; dispute?: ArtifactRef; resolution?: ArtifactRef }
export interface ReviewRecord { id: string; contentId: string; runId: string; contextId: string; evidence: ArtifactRef; knowledgeReviewed: boolean; findings: string[] }
export interface DeliveryResult { id: string; demandId: string; P: string; K: ArtifactRef; N: ArtifactRef[]; E: CheckEvidence[]; review: ReviewRecord; findingClosures: Finding[]; notes: string; contentId: string; createdAt: string }
export interface Acceptance { resultId: string; decision: 'accepted' | 'returned'; userId: string; reason?: string; createdAt: string }
export interface Grant { planId: string; userId: string; localCommit: boolean; createdAt: string }
export interface DemandMessage { id: string; text: string; kind: 'question' | 'information' | 'change-request'; state: 'saved' | 'delivered' | 'applied'; runId?: string }
export interface Demand { id: string; projectId: string; title: string; description: string; revision: number; control: Control; phase: Phase; planningStarted: boolean; planningFlow?: PlanningFlow; methodSnapshot: Methods; plans: PlanRevision[]; activePlanId?: string; confirmedPlanId?: string; grant?: Grant; contents: ContentSnapshot[]; activeContentId?: string; checks: CheckEvidence[]; reviews: ReviewRecord[]; findings: Finding[]; results: DeliveryResult[]; activeResultId?: string; acceptances: Acceptance[]; cycle: number; blockedReasons: string[]; invalidatedContentIds: string[]; messages: DemandMessage[]; createdAt: string }
export interface UserContext { readonly kind: 'trusted-user'; readonly userId: string }
export interface WorkerContext { readonly kind: 'worker'; readonly runId: string }
export interface CommandBase { requestId: string; demandId: string; expectedRevision?: number; originalText?: string }
export type UserCommand = CommandBase & (
  | { type: 'start-planning' }
  | { type: 'confirm-plan'; planId: string }
  | { type: 'authorize-implementation'; planId: string; confirmDesign?: boolean; localCommit?: boolean }
  | { type: 'pause' | 'cancel' | 'resume' | 'exit' }
  | { type: 'revise-plan'; previousPlanId: string; reason: string }
  | { type: 'accept-result'; resultId: string }
  | { type: 'return-result'; resultId: string; reason: string }
  | { type: 'switch-method'; stage: Stage; method: MethodSnapshot; reason: string; impactReviewed: boolean }
  | { type: 'message'; messageId: string; text: string; kind: DemandMessage['kind'] }
  | { type: 'resolve-blocker'; reason: string }
  | { type: 'decide-finding'; findingId: string; reason: string }
  | PlanningUserCommand
);
export interface ReportBase { requestId: string; demandId: string; runId: string; generation: number }
export type WorkerReport = ReportBase & (
  | { type: 'plan-draft'; plan: PlanInput }
  | { type: 'plan-ready'; planId: string; boundaryReview: BoundaryReview }
  | { type: 'content-ready'; content: ContentInput }
  | { type: 'check'; check: CheckEvidence }
  | { type: 'review'; reviewId: string; contentId: string; evidence: ArtifactRef; knowledgeReviewed: boolean; findings: FindingInput[] }
  | { type: 'dispute'; findingId: string; evidence: ArtifactRef }
  | { type: 'resolve-finding'; findingId: string; contentId: string; evidence: ArtifactRef; outcome: 'fixed' | 'false-positive' | 'not-applicable' }
  | { type: 'blocked'; reason: string }
  | { type: 'message-delivered' | 'message-applied'; messageId: string }
  | { type: 'runtime-ended' }
  | PlanningWorkerReport
);
/** These attestations must come from trusted Host adapters, never report payloads.
 * They record externally verified facts, not proofs supplied by an Agent. */
export interface BoundaryReviewVerification {
  runId: string; contextId: string; planningRunId: string; planId: string;
  evidenceDigest: string; actualReviewObserved: boolean; isolatedInputsVerified: boolean;
}
export interface PlanningStageVerification { runId: string; planningStep: PlanningWorkStep; flowId: string; flowRevision: number; inputDigest: string; sourceVerified: boolean; requiredSkillVerified: boolean; actualRunObserved: boolean; actualStopVerified: boolean }
export interface ReportVerification { artifactsVerified?: boolean; contentStable?: boolean; reviewInputsVerified?: boolean; boundaryReview?: BoundaryReviewVerification; planningIndependent?: PlanningIndependentVerification; planningStage?: PlanningStageVerification }
export interface Receipt { id: string; requestId: string; demandId: string; revision: number; status: 'applied' | 'noop' | 'historical'; outcome: string; createdAt: string }
export interface RunAttempt { id: string; demandId: string; stage: Stage; planningStep?: PlanningWorkStep; planningFlowId?: string; planningRevision?: number; generation: number; contextId: string; planId?: string; contentId?: string; cycle: number; status: 'starting' | 'running' | 'stopping' | 'unknown' | 'stopped'; writer: boolean; highResource: boolean; method: MethodSnapshot; contextSources: string[]; processIdentity?: string; stopReason?: string; createdAt: string }
export interface DispatchConditions { profileVerified: boolean; budgetAvailable: boolean; workspaceVerified: boolean; demandId?: string; highResource?: boolean }
export interface StopProof { processAbsent: boolean; descendantsAbsent: boolean; workspaceVerified: boolean; evidence: string }
export interface RecoveryProof extends StopProof { profileVerified: boolean; budgetAvailable: boolean }
export interface OutboxItem { id: number; businessKey: string; demandId: string; kind: 'start-run' | 'stop-run' | 'notification'; payload: Record<string, unknown>; status: 'pending' | 'done'; createdAt: string }
