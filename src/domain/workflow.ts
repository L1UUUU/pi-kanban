import { randomUUID } from 'node:crypto';
import { DomainError, WorkbenchStore, canonical, digest, invariant } from './store.ts';
import type { Acceptance, ArtifactRef, Demand, DispatchConditions, Methods, MethodSnapshot, PlanRevision, Project, Receipt, RecoveryProof, ReportVerification, RunAttempt, Stage, StopProof, UserCommand, UserContext, WorkerContext, WorkerReport } from './types.ts';

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const activeRun = (run: RunAttempt) => run.status !== 'stopped';
function text(value: unknown, field: string): asserts value is string { invariant(typeof value === 'string' && value.trim().length > 0, 'INVALID_INPUT', `${field} must be nonempty.`); }
function artifact(ref: ArtifactRef): void { invariant(ref && typeof ref === 'object', 'INVALID_ARTIFACT', 'Artifact reference required.'); text(ref.id, 'artifact.id'); text(ref.digest, 'artifact.digest'); text(ref.location, 'artifact.location'); }
function method(value: MethodSnapshot): void { invariant(value && typeof value === 'object', 'INVALID_METHOD', 'Method snapshot required.'); for (const key of ['id','version','digest','adapter'] as const) text(value[key], `method.${key}`); }
function validateMethods(methods: Methods): void { for (const [stage, value] of Object.entries(methods)) { invariant(['planning','implementation','review'].includes(stage), 'INVALID_METHOD', 'Unknown stage.'); method(value); } }

/** Trusted single business-state entry point, independent of Pi/Electron.
 * Host-only verification arguments attest actual adapter observations. Synthetic
 * test attestations demonstrate rules, never OS/process/artifact validation.
 */
export class WorkflowService {
  readonly store: WorkbenchStore;
  #users = new WeakSet<object>();
  #workers = new WeakMap<object, { runId: string; generation: number }>();
  #fault?: (point: 'before-commit' | 'after-commit') => void;
  constructor(store: WorkbenchStore, options: { fault?: (point: 'before-commit' | 'after-commit') => void } = {}) { this.store = store; this.#fault = options.fault; }
  trustedUser(userId: string): UserContext { text(userId, 'userId'); const context = Object.freeze({ kind: 'trusted-user' as const, userId }); this.#users.add(context); return context; }
  workerContext(runId: string): WorkerContext { const run = this.store.getRun(runId); const context = Object.freeze({kind:'worker' as const,runId}); this.#workers.set(context,{runId,generation:run.generation}); return context; }
  createProject(input: { id?: string; name: string; rootPath: string; methods?: Methods; baseChecks?: Project['baseChecks'] }): Project {
    text(input.name,'name'); text(input.rootPath,'rootPath'); validateMethods(input.methods ?? {});
    const project: Project = { id: input.id ?? id('project'), name: input.name, rootPath: input.rootPath, methods: structuredClone(input.methods ?? {}), baseChecks: structuredClone(input.baseChecks ?? []), revision: 1 };
    this.validateChecks(project.baseChecks);
    return this.store.transaction(() => { invariant(!this.store.listProjects().some(p => p.id === project.id),'ALREADY_EXISTS','Project ID already exists.'); this.store.saveProject(project); return project; });
  }
  updateProjectMethods(projectId: string, methods: Methods, user: UserContext): Project {
    this.assertUser(user); validateMethods(methods);
    return this.store.transaction(() => { const project=this.store.getProject(projectId); project.methods=structuredClone(methods); project.revision++; this.store.saveProject(project); return project; });
  }
  createDemand(input: {id?: string; projectId: string; title: string; description?: string}): Demand {
    text(input.title,'title'); this.store.getProject(input.projectId);
    const demand: Demand = {id:input.id ?? id('demand'),projectId:input.projectId,title:input.title,description:input.description ?? '',revision:1,control:'active',phase:'idea',planningStarted:false,methodSnapshot:{},plans:[],contents:[],checks:[],reviews:[],findings:[],results:[],acceptances:[],cycle:0,blockedReasons:[],invalidatedContentIds:[],messages:[],createdAt:now()};
    return this.store.transaction(() => { invariant(!this.store.listDemands().some(d=>d.id===demand.id),'ALREADY_EXISTS','Demand ID already exists.'); this.store.saveDemand(demand); return demand; });
  }
  getDemand(demandId: string): Demand { return this.store.getDemand(demandId); }
  listDemands(projectId?: string): Demand[] { return this.store.listDemands(projectId); }
  listProjects(): Project[] { return this.store.listProjects(); }
  /** Trusted adapter query. Keep stage decisions in this single rule engine. */
  nextRequestedStage(demandId: string): Stage | null { return this.nextStage(this.store.getDemand(demandId)); }
  /** An explicit settings import may fill missing slots before first dispatch;
   * it never replaces a captured method or upgrades an already-started run. */
  completeMissingMethods(demandId: string): Demand {
    return this.store.transaction(() => {
      const demand = this.store.getDemand(demandId);
      if (!demand.planningStarted || this.store.listRuns(demandId).length) return demand;
      const defaults = this.store.getProject(demand.projectId).methods;
      let changed = false;
      for (const stage of ['planning','implementation','review'] as const) if (!demand.methodSnapshot[stage] && defaults[stage]) { demand.methodSnapshot[stage] = structuredClone(defaults[stage]); changed = true; }
      if (changed) { this.audit(demandId,'missing-methods-configured',demand.methodSnapshot); this.reconcile(demand); demand.revision++; this.store.saveDemand(demand); }
      return demand;
    });
  }
  getRun(runId: string): RunAttempt { return this.store.getRun(runId); }
  listRuns(demandId?: string): RunAttempt[] { return this.store.listRuns(demandId); }

  execute(command: UserCommand, user: UserContext): Receipt {
    this.assertUser(user);
    return this.apply(`user:${user.userId}:${command.requestId}`,command, demand => {
      if (['pause','cancel','resume','exit','switch-method','resolve-blocker'].includes(command.type)) invariant(Number.isInteger(command.expectedRevision) && command.expectedRevision!>=1,'VERSION_REQUIRED','This control must bind the currently displayed demand revision.');
      if (command.expectedRevision !== undefined) invariant(command.expectedRevision === demand.revision,'STALE_CONTROL','The displayed demand revision changed. Refresh before deciding.');
      switch (command.type) {
        case 'start-planning':
          invariant(demand.control==='active','CONTROL_BLOCKED','Resume before planning.');
          if (demand.planningStarted) return ['noop','Planning already requested.'];
          demand.planningStarted=true; demand.methodSnapshot=structuredClone(this.store.getProject(demand.projectId).methods); break;
        case 'confirm-plan':
          this.currentPlan(demand,command.planId);
          if (demand.confirmedPlanId===command.planId) return ['noop','Design already confirmed.'];
          demand.confirmedPlanId=command.planId; break;
        case 'authorize-implementation': {
          const designChanged=!!command.confirmDesign && demand.confirmedPlanId!==command.planId;
          this.currentPlan(demand,command.planId);
          if (command.confirmDesign) demand.confirmedPlanId=command.planId;
          if (!designChanged && demand.grant?.planId===command.planId && (!command.localCommit || demand.grant.localCommit)) return ['noop','Implementation authority already exists.'];
          demand.grant={planId:command.planId,userId:user.userId,localCommit:command.localCommit ?? demand.grant?.localCommit ?? false,createdAt:now()}; break;
        }
        case 'pause': case 'cancel': case 'exit': {
          const control = command.type==='pause'?'paused':command.type==='cancel'?'cancelled':'exited';
          if(demand.control===control) return ['noop','Control already recorded.'];
          invariant(demand.control!=='cancelled','CANCELLED','Cancelled demands cannot be resumed or silently changed.');
          demand.control=control; this.stopRuns(demand,control); break;
        }
        case 'resume':
          invariant(demand.control!=='cancelled','CANCELLED','A cancelled demand cannot resume.');
          invariant(!this.store.listRuns(demand.id).some(r=>activeRun(r) && ['stopping','unknown'].includes(r.status)),'STOP_UNVERIFIED','Actual stop must be verified before resuming.');
          if(demand.control==='active') return ['noop','Demand already active.'];
          demand.control='active'; break;
        case 'revise-plan':
          this.currentPlan(demand,command.previousPlanId); text(command.reason,'reason');
          invariant(!demand.activeResultId,'RESULT_PROTECTED','Return the exact result before changing its plan.');
          invariant(!this.store.listRuns(demand.id).some(activeRun),'WRITER_ACTIVE','Stop the existing run before revising the plan.');
          demand.activePlanId=undefined; demand.confirmedPlanId=undefined; demand.grant=undefined; demand.activeContentId=undefined; demand.cycle++; demand.blockedReasons=[]; break;
        case 'accept-result': {
          invariant(demand.activeResultId===command.resultId,'STALE_RESULT','Acceptance targets a specific current result, not the latest result.');
          const existing=demand.acceptances.find(a=>a.resultId===command.resultId && a.decision==='accepted');
          if(existing) return ['noop','This result was already accepted.'];
          invariant(demand.phase==='awaiting-acceptance','QUALITY_GATE','Only a stable submitted result can be accepted.');
          invariant(!this.store.listRuns(demand.id).some(activeRun),'WRITER_ACTIVE','Cannot accept while execution is active.');
          demand.acceptances.push({resultId:command.resultId,decision:'accepted',userId:user.userId,createdAt:now()}); break;
        }
        case 'return-result': {
          invariant(demand.activeResultId===command.resultId,'STALE_RESULT','Return the exact current result.'); text(command.reason,'reason');
          demand.acceptances.push({resultId:command.resultId,decision:'returned',userId:user.userId,reason:command.reason,createdAt:now()});
          demand.activeResultId=undefined; demand.activeContentId=undefined; demand.cycle++; demand.blockedReasons=[]; break;
        }
        case 'switch-method':
          method(command.method); text(command.reason,'reason'); invariant(command.impactReviewed,'IMPACT_UNREVIEWED','Method changes require recorded impact review.');
          invariant(!this.store.listRuns(demand.id).some(activeRun),'RUN_ACTIVE','Stop the current run before replacing its method.');
          invariant(!demand.activeResultId,'RESULT_PROTECTED','Submitted results are immutable.');
          demand.methodSnapshot[command.stage]=structuredClone(command.method); demand.cycle++; break;
        case 'message':
          text(command.messageId,'messageId'); text(command.text,'text');
          invariant(['question','information','change-request'].includes(command.kind),'INVALID_INPUT','Unknown message kind.');
          if(demand.messages.some(m=>m.id===command.messageId)) { invariant(demand.messages.some(m=>m.id===command.messageId && m.text===command.text && m.kind===command.kind),'CONTENT_CONFLICT','Message ID content differs.'); return ['noop','Message already saved.']; }
          demand.messages.push({id:command.messageId,text:command.text,kind:command.kind,state:'saved'}); break;
        case 'decide-finding': {
          text(command.reason,'reason');const finding=demand.findings.find(f=>f.id===command.findingId);
          invariant(finding?.severity==='decision','NOT_FOUND','An open user-decision finding is required.');
          if(finding.status==='closed') return ['noop','Decision already recorded.'];
          finding.status='closed';finding.resolution={id:command.requestId,digest:digest(command),location:`user-command:${command.requestId}`};
          demand.blockedReasons=demand.blockedReasons.filter(r=>r!==`User decision required: ${finding.id}`);break;
        }
        case 'resolve-blocker':
          text(command.reason,'reason'); invariant(!this.store.listRuns(demand.id).some(activeRun),'RUN_ACTIVE','Verify stopped execution before resolving a blocker.');
          demand.blockedReasons=[]; demand.cycle++; break;
        default: throw new DomainError('INVALID_COMMAND','Unsupported user command.');
      }
      this.audit(demand.id,'user-command',{userId:user.userId,command});
      return ['applied',command.type];
    });
  }

  report(report: WorkerReport, worker: WorkerContext, verification: ReportVerification = {}): Receipt {
    const binding=worker && this.#workers.get(worker);
    invariant(binding,'UNTRUSTED_WORKER','A Host-issued run capability is required.');
    invariant(binding.runId===report.runId,'RUN_SCOPE','Worker cannot report for another run.');
    const bound=this.store.getRun(binding.runId);
    invariant(bound.demandId===report.demandId,'DEMAND_SCOPE','Worker cannot report for another demand.');
    invariant(binding.generation===report.generation && bound.generation===report.generation,'STALE_GENERATION','The run generation is stale.');
    return this.apply(`run:${report.runId}:${report.requestId}`,report,demand=>{
      const run=this.store.getRun(report.runId);
      const newerRun=this.store.listRuns(demand.id).some(other=>other.generation>run.generation);
      const stale=newerRun || (run.planId && run.planId!==demand.activePlanId) || run.cycle!==demand.cycle || (run.contentId && run.contentId!==demand.activeContentId);
      if(stale) { this.audit(demand.id,'historical-report',report); return ['historical','Report retained for its original version.']; }
      invariant(!demand.activeResultId || report.type==='runtime-ended','RESULT_PROTECTED','Submitted content cannot be changed by a report.');
      switch(report.type) {
        case 'plan-draft': {
          this.role(run,'planning'); const plan=report.plan; text(plan.id,'plan.id'); text(plan.scope,'plan.scope'); artifact(plan.spec); artifact(plan.tickets); this.validateChecks(plan.requiredChecks);
          invariant(Array.isArray(plan.unresolvedQuestions),'INVALID_PLAN','Unresolved questions must be explicit.');
          const existing=demand.plans.find(p=>p.id===plan.id);
          if(existing) { const {ready,boundaryReview,createdByRun,...original}=existing; invariant(canonical(original)===canonical(plan),'CONTENT_CONFLICT','An immutable plan ID cannot be overwritten.'); return ['noop','Plan already saved.']; }
          invariant(!demand.activePlanId,'PLAN_REPLACEMENT_REQUIRES_USER','A new plan version requires explicit revision authority.');
          demand.plans.push({...structuredClone(plan),ready:false,createdByRun:run.id}); demand.activePlanId=plan.id;
          run.planId=plan.id; this.store.saveRun(run); break;
        }
        case 'plan-ready': {
          this.role(run,'planning'); const plan=this.currentPlan(demand,report.planId);
          invariant(verification.artifactsVerified,'ARTIFACTS_UNVERIFIED','Host must verify exact spec, ticket, and review artifacts.');
          invariant(plan.unresolvedQuestions.length===0,'UNRESOLVED_DESIGN','Current scope has unresolved questions.');
          const boundary=report.boundaryReview; text(boundary.contextId,'boundary context'); artifact(boundary.evidence);
          invariant(boundary.planningContextId===run.contextId && boundary.contextId!==run.contextId,'REVIEW_NOT_INDEPENDENT','Boundary review requires a distinct context bound to this planning run.');
          const observed=verification.boundaryReview;
          invariant(observed && observed.actualReviewObserved && observed.isolatedInputsVerified && observed.planningRunId===run.id && observed.planId===plan.id && observed.runId!==run.id && observed.contextId===boundary.contextId && observed.evidenceDigest===boundary.evidence.digest,'BOUNDARY_REVIEW_UNVERIFIED','Host must attest an actually observed independent reviewer, isolated inputs, and exact plan/evidence binding.');
          text(observed.runId,'boundary reviewer run');
          invariant(boundary.unresolvedBlockingFindings.length===0,'BOUNDARY_BLOCKED','Boundary findings remain unresolved.');
          if(plan.ready) { invariant(canonical(plan.boundaryReview)===canonical(boundary),'CONTENT_CONFLICT','Ready plan evidence is immutable.'); return ['noop','Planning handoff already ready.']; }
          plan.ready=true; plan.boundaryReview=structuredClone(boundary); break;
        }
        case 'content-ready': {
          this.role(run,'implementation'); const content=report.content;
          this.currentPlan(demand,content.planId); invariant(demand.grant?.planId===content.planId,'AUTHORITY_MISSING','No authority for this plan.');
          text(content.id,'content.id'); text(content.deliveryNotes,'deliveryNotes'); artifact(content.code); content.knowledge.forEach(artifact);
          invariant(verification.artifactsVerified && verification.contentStable,'CONTENT_UNVERIFIED','Host must verify stable code and exact local material versions.');
          invariant(content.maintenance==='complete' || content.maintenance==='not-needed','MAINTENANCE_INCOMPLETE','Necessary maintenance is incomplete.');
          const existing=demand.contents.find(c=>c.id===content.id);
          if(existing) { const {createdByRun,cycle,...original}=existing; invariant(canonical(original)===canonical(content),'CONTENT_CONFLICT','Content IDs are immutable.'); return ['noop','Content already saved.']; }
          demand.contents.push({...structuredClone(content),createdByRun:run.id,cycle:demand.cycle}); demand.activeContentId=content.id; break;
        }
        case 'check': {
          this.role(run,'review'); const check=report.check; this.currentContent(demand,check.contentId); artifact(check.evidence); text(check.id,'check.id'); text(check.environment,'environment');
          invariant(verification.artifactsVerified,'ARTIFACTS_UNVERIFIED','Exact check evidence must be verified.');
          invariant(['passed','failed','unavailable'].includes(check.status),'INVALID_CHECK','Check status is invalid.');
          invariant(this.requiredChecks(demand).some(c=>c.id===check.requirementId),'UNKNOWN_CHECK','Checks cannot silently replace a required behavior.');
          const existing=demand.checks.find(c=>c.id===check.id);
          if(existing) { invariant(canonical(existing)===canonical(check),'CONTENT_CONFLICT','Check IDs are immutable.'); return ['noop','Check already saved.']; }
          demand.checks.push(structuredClone(check));
          if(check.status==='unavailable') demand.blockedReasons.push(`Required check unavailable: ${check.requirementId}`);
          break;
        }
        case 'review': {
          this.role(run,'review'); this.currentContent(demand,report.contentId); artifact(report.evidence); text(report.reviewId,'reviewId');
          invariant(verification.artifactsVerified && verification.reviewInputsVerified,'REVIEW_INPUTS_UNVERIFIED','Host must verify actual stable code, spec, evidence and local materials in independent inputs.');
          invariant(report.knowledgeReviewed,'KNOWLEDGE_UNREVIEWED','Review must cover applicable local maintenance, including a no-change conclusion.');
          const existing=demand.reviews.find(r=>r.id===report.reviewId);
          if(existing) { invariant(existing.contentId===report.contentId && canonical(existing.evidence)===canonical(report.evidence) && canonical(existing.findings.map(id=>{const f=demand.findings.find(f=>f.id===id)!;return {id:f.id,severity:f.severity,location:f.location,basis:f.basis,impact:f.impact,verification:f.verification};}))===canonical(report.findings),'CONTENT_CONFLICT','Review IDs are immutable.'); return ['noop','Review already saved.']; }
          for(const finding of report.findings) {
            text(finding.id,'finding.id'); for(const key of ['location','basis','impact','verification'] as const) text(finding[key],`finding.${key}`);
            invariant(['blocking','suggestion','decision'].includes(finding.severity),'INVALID_FINDING','Unknown severity.');
            invariant(!demand.findings.some(f=>f.id===finding.id),'CONTENT_CONFLICT','Finding IDs cannot be reused.');
            demand.findings.push({...structuredClone(finding),contentId:report.contentId,reviewRunId:run.id,status:'open'});
            if(finding.severity==='decision') demand.blockedReasons.push(`User decision required: ${finding.id}`);
          }
          demand.reviews.push({id:report.reviewId,contentId:report.contentId,runId:run.id,contextId:run.contextId,evidence:structuredClone(report.evidence),knowledgeReviewed:true,findings:report.findings.map(f=>f.id)}); break;
        }
        case 'dispute': {
          this.role(run,'implementation'); artifact(report.evidence); const finding=demand.findings.find(f=>f.id===report.findingId);
          invariant(finding && finding.status!=='closed','FINDING_NOT_OPEN','The finding is not open.');
          finding.status='disputed'; finding.dispute=structuredClone(report.evidence); break;
        }
        case 'resolve-finding': {
          this.role(run,'review'); this.currentContent(demand,report.contentId); artifact(report.evidence);
          invariant(verification.artifactsVerified && verification.reviewInputsVerified,'REVIEW_INPUTS_UNVERIFIED','Finding resolution requires verified reviewer evidence.');
          const finding=demand.findings.find(f=>f.id===report.findingId); invariant(finding,'NOT_FOUND','Finding does not exist.');
          invariant(finding.severity!=='decision','USER_DECISION_REQUIRED','Reviewer cannot decide a user scope or authority question.');
          invariant(report.outcome==='fixed' || finding.status==='disputed','DISPUTE_EVIDENCE_REQUIRED','False positive and applicability resolutions require implementation evidence.');
          if(finding.status==='closed') {invariant(canonical(finding.resolution)===canonical(report.evidence),'CONTENT_CONFLICT','Finding resolution is immutable.');return ['noop','Finding already closed.'];}
          finding.status='closed'; finding.resolution=structuredClone(report.evidence); break;
        }
        case 'blocked': text(report.reason,'reason'); if(!demand.blockedReasons.includes(report.reason)) demand.blockedReasons.push(report.reason); this.stopRuns(demand,'blocked'); break;
        case 'message-delivered': case 'message-applied': {
          const message=demand.messages.find(m=>m.id===report.messageId); invariant(message,'NOT_FOUND','Message not found.');
          invariant(report.type!=='message-applied' || message.kind!=='change-request','CHANGE_REQUIRES_USER_COMMAND','A report cannot turn a change request into implementation authority.');
          if(report.type==='message-applied') invariant(message.state==='delivered','MESSAGE_NOT_DELIVERED','Record delivery before application.');
          if(message.state!=='applied') message.state=report.type==='message-delivered'?'delivered':'applied'; message.runId=run.id; break;
        }
        case 'runtime-ended': this.audit(demand.id,'runtime-ended',{runId:run.id}); return ['applied','Runtime event recorded; no business completion or actual-stop inference.'];
        default: throw new DomainError('INVALID_REPORT','Unsupported Worker report.');
      }
      this.audit(demand.id,'worker-report',{report,verification});
      return ['applied',report.type];
    });
  }

  /** Claims persistent start intent after rechecking all current gates. No process is started here. */
  claimNextRun(conditions: DispatchConditions): RunAttempt | null {
    invariant(conditions.profileVerified,'PROFILE_UNVERIFIED','Execution profile has not passed its actual gates.');
    invariant(conditions.budgetAvailable,'BUDGET_UNAVAILABLE','Finite configured budget and reservations are required.');
    invariant(conditions.workspaceVerified,'WORKSPACE_UNVERIFIED','Workspace ownership and access boundary must be verified.');
    return this.store.transaction(()=>{
      const live=this.store.listRuns().filter(activeRun);
      if(new Set(live.map(r=>r.demandId)).size>=2) return null;
      for(const entry of this.store.outbox('pending').filter(o=>o.kind==='start-run')) {
        if(conditions.demandId && entry.demandId!==conditions.demandId) continue;
        const demand=this.store.getDemand(entry.demandId); const stage=this.nextStage(demand);
        if(!stage || stage!==entry.payload.stage || this.intentKey(demand,stage)!==entry.businessKey || live.some(r=>r.demandId===demand.id)) continue;
        const selected=demand.methodSnapshot[stage]; if(!selected) continue;
        const highResource=!!conditions.highResource || (stage==='review' && this.requiredChecks(demand).some(c=>c.highResource));
        if(highResource && live.some(r=>r.highResource)) continue;
        const content=demand.contents.find(c=>c.id===demand.activeContentId);
        const plan=demand.plans.find(p=>p.id===demand.activePlanId);
        const generation=Math.max(0,...this.store.listRuns(demand.id).map(r=>r.generation))+1;
        const run: RunAttempt={id:id('run'),demandId:demand.id,stage,generation,contextId:id('context'),planId:plan?.id,contentId:stage==='review'?content?.id:undefined,cycle:demand.cycle,status:'starting',writer:stage==='implementation',highResource,method:structuredClone(selected),contextSources:[...(plan?[plan.spec.id,plan.tickets.id]:[]),...(stage==='review' && content?[content.code.id,...content.knowledge.map(n=>n.id),...demand.checks.filter(e=>e.contentId===content.id).map(e=>e.evidence.id)]:[])],createdAt:now()};
        this.store.saveRun(run); demand.revision++; this.store.saveDemand(demand); this.store.db.prepare("UPDATE domain_outbox SET status='done' WHERE id=?").run(entry.id); this.audit(demand.id,'run-claimed',run); return run;
      }
      return null;
    });
  }
  markRunning(runId: string, processIdentity: string): RunAttempt {
    text(processIdentity,'processIdentity');
    return this.store.transaction(()=>{
      const run=this.store.getRun(runId); const demand=this.store.getDemand(run.demandId);
      invariant(activeRun(run),'INVALID_RUN_STATE','A stopped run cannot be registered as running.');
      invariant(!run.processIdentity || run.processIdentity===processIdentity,'PROCESS_IDENTITY_MISMATCH','Registration cannot replace a previously observed process.');
      // Observation can arrive after pause won the startup race. Record the real
      // process for termination without revoking the already-persisted stop intent.
      run.processIdentity=processIdentity;
      run.status=run.status==='stopping' || demand.control!=='active' || demand.blockedReasons.length ? 'stopping' : 'running';
      this.store.saveRun(run);this.bumpRunDemand(run,'run-started');return run;
    });
  }
  confirmStopped(runId: string, proof: StopProof): Demand {
    this.validateStopProof(proof);
    return this.store.transaction(()=>{const run=this.store.getRun(runId); const demand=this.store.getDemand(run.demandId); if(run.status==='stopped') return demand;run.status='stopped';this.store.saveRun(run);this.audit(demand.id,'actual-stop',{runId,proof});this.reconcile(demand);demand.revision++;this.store.saveDemand(demand);return demand;});
  }
  markInterrupted(runId: string, reason: string): RunAttempt {
    text(reason,'reason');return this.store.transaction(()=>{const run=this.store.getRun(runId); invariant(activeRun(run),'INVALID_RUN_STATE','Stopped runs cannot become unknown.');run.status='unknown';run.stopReason=reason;this.store.saveRun(run);this.audit(run.demandId,'interrupted',{runId,reason});this.bumpRunDemand(run,'run-interrupted');return run;});
  }
  recoverRun(runId: string, proof: RecoveryProof): Demand {
    this.validateStopProof(proof); invariant(proof.profileVerified && proof.budgetAvailable,'RECOVERY_BLOCKED','Recovery requires verified profile and finite remaining budget.');
    return this.store.transaction(()=>{const run=this.store.getRun(runId); invariant(run.status==='unknown' || run.status==='starting' || run.status==='stopping','INVALID_RUN_STATE','Only unresolved runs require recovery.'); const demand=this.store.getDemand(run.demandId);run.status='stopped';this.store.saveRun(run);this.audit(demand.id,'recovery-verification',{runId,proof});
      // Later pause/cancel/exit always wins. No control field is changed by recovery.
      demand.cycle++;this.reconcile(demand);demand.revision++;this.store.saveDemand(demand);return demand;});
  }
  /** Recover connection to the same verified process; never creates a new writer. */
  reconnectRun(runId: string, processIdentity: string, generation: number): RunAttempt {
    return this.store.transaction(()=>{const run=this.store.getRun(runId);invariant(run.processIdentity===processIdentity && run.generation===generation,'PROCESS_IDENTITY_MISMATCH','PID reuse or a different generation cannot reconnect.');invariant(activeRun(run),'INVALID_RUN_STATE','Stopped run cannot reconnect.');const d=this.store.getDemand(run.demandId);run.status=d.control==='active' && !d.blockedReasons.length?'running':'stopping';this.store.saveRun(run);this.bumpRunDemand(run,'run-reconnected');return run;});
  }
  /** Persistent notification reads do not approve, resume, or accept anything. */
  notifications(demandId?: string) { return this.store.outbox().filter(o=>o.kind==='notification' && (!demandId || o.demandId===demandId)); }
  acknowledgeOutbox(id: number): void { this.store.transaction(()=>{const item=this.store.outbox().find(o=>o.id===id); invariant(item && item.kind!=='start-run','INVALID_OUTBOX_ACK','Start intents may only be claimed through dispatch.');this.store.db.prepare("UPDATE domain_outbox SET status='done' WHERE id=?").run(id);}); }
  /** Trusted adapter observation, not a Worker claim or manufactured user control.
   * The coordinator uses this for crashes, unknown state, or exhausted finite
   * recovery attempts. Repeated observations are deduplicated durably. */
  blockDemand(demandId: string, code: string, reason: string): Demand {
    text(code,'blocker code'); text(reason,'blocker reason');
    return this.store.transaction(()=>{
      const demand=this.store.getDemand(demandId); const blocker=`${code}: ${reason}`;
      if(demand.blockedReasons.includes(blocker)) return demand;
      demand.blockedReasons.push(blocker);
      this.audit(demandId,'host-blocker',{code,reason});
      this.stopRuns(demand,`host:${code}`);
      this.reconcile(demand);
      demand.revision++;
      this.store.saveDemand(demand);
      return demand;
    });
  }
  /** Detect external modifications without replacing an immutable C or its acceptance. */
  invalidateCurrentContent(demandId: string, reason: string): Demand {
    text(reason,'reason');return this.store.transaction(()=>{const d=this.store.getDemand(demandId);d.blockedReasons.push(`Content changed: ${reason}`);if(d.activeContentId && !d.invalidatedContentIds.includes(d.activeContentId))d.invalidatedContentIds.push(d.activeContentId);this.stopRuns(d,'content-changed');this.audit(d.id,'content-invalidated',{contentId:d.activeContentId,resultId:d.activeResultId,reason});d.phase='blocked';d.revision++;this.store.saveDemand(d);this.notify(d,`content-changed:${d.activeContentId}`,reason);return d;});
  }

  private apply(key: string, request: {requestId:string;demandId:string}, work: (d: Demand)=>[Receipt['status'],string]): Receipt {
    text(request.requestId,'requestId');text(request.demandId,'demandId'); const hash=digest(request);
    const result=this.store.transaction(()=>{
      const prior=this.store.db.prepare('SELECT * FROM domain_receipts WHERE key=?').get(key);
      if(prior) {
        if(prior.hash===hash) return {receipt:JSON.parse(prior.receipt as string) as Receipt,replay:true};
        this.store.db.prepare('INSERT INTO domain_conflicts(key,original_hash,incoming_hash,request,created_at) VALUES (?,?,?,?,?)').run(key,prior.hash as string,hash,JSON.stringify(request),now());return {conflict:true};
      }
      const demand=this.store.getDemand(request.demandId); const [status,outcome]=work(demand);
      if(status==='applied') {this.reconcile(demand);demand.revision++;this.store.saveDemand(demand);}
      const receipt: Receipt={id:id('receipt'),requestId:request.requestId,demandId:demand.id,revision:demand.revision,status,outcome,createdAt:now()};
      this.store.db.prepare('INSERT INTO domain_receipts(key,hash,receipt,request) VALUES (?,?,?,?)').run(key,hash,JSON.stringify(receipt),JSON.stringify(request));this.#fault?.('before-commit');return {receipt,replay:false};
    });
    if('conflict' in result) throw new DomainError('IDEMPOTENCY_CONFLICT','This request ID was already used for different content; both payloads are retained.');
    if(!result.replay) this.#fault?.('after-commit');
    return result.receipt!;
  }
  private bumpRunDemand(run: RunAttempt, kind: string): void {const d=this.store.getDemand(run.demandId);d.revision++;this.store.saveDemand(d);this.audit(d.id,kind,{runId:run.id,status:run.status});}
  private assertUser(context: UserContext): void { invariant(context && this.#users.has(context),'UNTRUSTED_USER','Only a Host-issued trusted user context can control a demand.'); }
  private role(run: RunAttempt, stage: Stage): void { invariant(run.stage===stage,'ROLE_FORBIDDEN',`${run.stage} cannot submit ${stage} results.`); }
  private currentPlan(d: Demand, planId: string): PlanRevision { invariant(d.activePlanId===planId,'STALE_PLAN','Command/report targets an old or unknown plan.');const plan=d.plans.find(p=>p.id===planId);invariant(plan,'NOT_FOUND','Plan not found.');return plan; }
  private currentContent(d: Demand, contentId: string) { invariant(d.activeContentId===contentId,'STALE_CONTENT','Evidence targets a different stable content version.'); const content=d.contents.find(c=>c.id===contentId);invariant(content,'NOT_FOUND','Content not found.');return content; }
  private validateChecks(checks: Project['baseChecks']): void {invariant(Array.isArray(checks),'INVALID_CHECK','Check requirements must be an array.');const ids=new Set<string>();for(const c of checks){text(c.id,'check.id');text(c.name,'check.name');invariant(!ids.has(c.id),'INVALID_CHECK','Duplicate requirement IDs.');ids.add(c.id);invariant(c.source==='project'||c.source==='demand','INVALID_CHECK','Unknown check requirement source.');}}
  private requiredChecks(d: Demand) { const project=this.store.getProject(d.projectId); const plan=d.plans.find(p=>p.id===d.activePlanId);const map=new Map(project.baseChecks.map(c=>[c.id,c]));for(const c of plan?.requiredChecks ?? []) { invariant(!map.has(c.id) || canonical(map.get(c.id))===canonical(c),'CHECK_REQUIREMENT_CONFLICT','Demand cannot override project check requirements.');map.set(c.id,c); }return [...map.values()]; }
  private validateStopProof(proof: StopProof): void { invariant(proof.processAbsent && proof.descendantsAbsent && proof.workspaceVerified,'STOP_UNVERIFIED','Actual process tree absence and workspace state must be verified.');text(proof.evidence,'stop evidence'); }
  private stopRuns(d: Demand, reason: string): void { for(const run of this.store.listRuns(d.id).filter(activeRun)){run.status='stopping';run.stopReason=reason;this.store.saveRun(run);this.enqueue(`stop:${run.id}`,d.id,'stop-run',{runId:run.id,reason});} }
  private intentKey(d: Demand, stage: Stage): string { return `start:${d.id}:${stage}:${d.activePlanId??'draft'}:${stage==='review'?d.activeContentId??'none':'work'}:${d.cycle}:attempt:${Math.max(0,...this.store.listRuns(d.id).map(r=>r.generation))+1}`; }
  private nextStage(d: Demand): Stage | null {
    if((d.activeContentId && d.invalidatedContentIds.includes(d.activeContentId)) || d.control!=='active' || d.blockedReasons.length || d.activeResultId || !d.planningStarted) return null;
    const plan=d.plans.find(p=>p.id===d.activePlanId);
    if(!plan?.ready) return 'planning';
    if(d.confirmedPlanId!==plan.id || d.grant?.planId!==plan.id) return null;
    if(!d.activeContentId) return 'implementation';
    const content=this.currentContent(d,d.activeContentId);
    const reviewed=d.reviews.some(r=>r.contentId===content.id);
    const blockers=d.findings.filter(f=>f.severity==='blocking'&&f.status!=='closed');
    const failed=this.requiredChecks(d).some(req=>[...d.checks].reverse().find(e=>e.contentId===content.id && e.requirementId===req.id)?.status==='failed');
    if(reviewed && (blockers.some(f=>f.contentId===content.id) || failed)) return 'implementation';
    return 'review';
  }
  private reconcile(d: Demand): void {
    if(d.activeContentId && d.invalidatedContentIds.includes(d.activeContentId)) {d.phase='blocked';return;}
    if(d.blockedReasons.length) {d.phase='blocked';for(const reason of new Set(d.blockedReasons))this.notify(d,`blocked:${digest(reason)}`,reason);return;}
    if(d.activeResultId) { d.phase=d.acceptances.some(a=>a.resultId===d.activeResultId && a.decision==='accepted')?'accepted':'awaiting-acceptance'; return; }
    if(!d.planningStarted) {d.phase='idea';return;}
    const plan=d.plans.find(p=>p.id===d.activePlanId);
    if(!plan?.ready) d.phase='planning';
    else if(d.confirmedPlanId!==plan.id) d.phase='awaiting-design';
    else if(d.grant?.planId!==plan.id) d.phase='awaiting-authorization';
    else if(!d.activeContentId) d.phase=d.cycle?'rework':'implementing';
    else {
      const content=this.currentContent(d,d.activeContentId); const review=[...d.reviews].reverse().find(r=>r.contentId===content.id);
      const checks=this.requiredChecks(d).map(req=>[...d.checks].reverse().find(e=>e.contentId===content.id&&e.requirementId===req.id));
      const blockers=d.findings.filter(f=>f.severity!=='suggestion' && f.status!=='closed');
      const live=this.store.listRuns(d.id).some(activeRun);
      if(review && checks.every(c=>c?.status==='passed') && !blockers.length && !live) {
        const result={id:id('result'),demandId:d.id,P:plan.id,K:structuredClone(content.code),N:structuredClone(content.knowledge),E:structuredClone(checks as Demand['checks']),review:structuredClone(review),findingClosures:structuredClone(d.findings.filter(f=>f.status==='closed')),notes:content.deliveryNotes,contentId:content.id,createdAt:now()};
        d.results.push(result);d.activeResultId=result.id;d.phase='awaiting-acceptance';this.notify(d,`accept:${result.id}`,'Stable result ready for acceptance.');return;
      }
      d.phase=review && (blockers.some(f=>f.contentId===content.id&&f.severity==='blocking') || checks.some(c=>c?.status==='failed'))?'rework':checks.some(c=>!c)?'checking':'reviewing';
    }
    const stage=this.nextStage(d);
    if(stage && !this.store.listRuns(d.id).some(activeRun)) {
      if(!d.methodSnapshot[stage]) {d.phase='blocked';this.notify(d,`method:${stage}` ,`Missing ${stage} method; no fallback is permitted.`);return;}
      this.enqueue(this.intentKey(d,stage),d.id,'start-run',{stage,planId:d.activePlanId??null,contentId:d.activeContentId??null,cycle:d.cycle});
    }
  }
  private enqueue(key: string,demandId: string,kind: string,payload: unknown): void {this.store.db.prepare('INSERT OR IGNORE INTO domain_outbox(business_key,demand_id,kind,payload,created_at) VALUES (?,?,?,?,?)').run(key,demandId,kind,JSON.stringify(payload),now());}
  private notify(d: Demand,key: string,message: string): void {this.enqueue(`notice:${d.id}:${key}`,d.id,'notification',{message});}
  private audit(demandId: string,kind: string,data: unknown): void {this.store.db.prepare('INSERT INTO domain_history(demand_id,kind,data,created_at) VALUES (?,?,?,?)').run(demandId,kind,JSON.stringify(data),now());}
}
