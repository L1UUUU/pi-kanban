import type { KnowledgeAction, KnowledgeLifecycleView } from '../../host/knowledge-lifecycle.ts';
import type { Finding, Methods, Stage } from '../../domain/types.ts';
import type { ConfigurationSummary } from '../../host/configuration.ts';
export type { ConfigurationSummary, ProviderConfiguration } from '../../host/configuration.ts';
/** Display-only Host snapshot. This is not an authorization boundary or a second workflow engine. */
export type Phase = 'idea' | 'planning' | 'awaiting-design' | 'awaiting-authorization' | 'implementing' | 'checking' | 'reviewing' | 'rework' | 'awaiting-acceptance' | 'accepted' | 'blocked';
export type Control = 'active' | 'paused' | 'cancelled' | 'exited';
export interface Project { id: string; name: string; rootPath: string }
export interface Activity {
  id: string;
  kind: 'tool' | 'runtime' | 'workflow' | 'notice';
  title: string;
  detail?: string;
  timestamp?: string;
  status?: 'running' | 'complete' | 'failed' | 'waiting';
}
export interface Message {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  state?: 'saved' | 'delivered' | 'applied';
  timestamp?: string;
  stage?: string;
}
export interface Check { id: string; name: string; status: 'passed' | 'failed' | 'unavailable' | 'pending'; evidence?: string; contentId?: string }
export interface Knowledge { id: string; title: string; status: 'candidate' | 'verified' | 'ineligible'; detail?: string; source?: string }
export interface Plan { id: string; scope: string; ready: boolean; confirmed: boolean; specPath?: string; requiredChecks?: string[]; unresolvedQuestions?: string[] }
export interface Result { id: string; contentId: string; notes: string; createdAt: string; codeRef?: string; knowledgeRefs?: string[]; accepted?: boolean }
export interface Demand {
  id: string;
  projectId: string;
  title: string;
  description: string;
  version: number;
  phase: Phase;
  control: Control;
  plan?: Plan;
  result?: Result;
  blockers: string[];
  /** Persisted workflow blockers, excluding runtime diagnostic prerequisites. */
  workflowBlockers?: string[];
  findings?: Finding[];
  activeContentId?: string;
  methodSnapshot?: Methods;
  activities: Activity[];
  messages: Message[];
  checks?: Check[];
  knowledge?: Knowledge[];
  knowledgeLifecycle?: KnowledgeLifecycleView;
  runState?: 'idle' | 'queued' | 'running' | 'stopping' | 'unknown' | 'stopped';
  workspacePath?: string;
  branch?: string;
}
export interface ViewState {
  /** Monotonic Host snapshot order, including runtime changes without a domain revision. */
  sequence: number;
  projects: Project[];
  demands: Demand[];
  runtime: {
    platform: string;
    node: string;
    executionEnabled: boolean;
    blockers: string[];
    connection?: 'connected' | 'disconnected';
    model?: string;
  };
  selected?: { projectId?: string; demandId?: string };
  configuration?: ConfigurationSummary & { authorization?: { demandId: string; grantId: string; configurationDigest: string } };
  /** Only set by the isolated synthetic preview entry; never inferred from a missing bridge. */
  preview?: boolean;
}
export type CommandKind = 'start-planning' | 'confirm-plan' | 'authorize-implementation' | 'pause' | 'resume' | 'cancel' | 'accept-result' | 'return-result' | 'revise-plan' | 'decide-finding' | 'resolve-blocker' | 'switch-method';
export interface Command {
  kind: CommandKind;
  demandId: string;
  expectedVersion: number;
  planId?: string;
  resultId?: string;
  previousPlanId?: string;
  findingId?: string;
  contentId?: string;
  stage?: Stage;
  methodId?: string;
  methodVersion?: string;
  methodDigest?: string;
  configurationDigest?: string;
  impactReviewed?: boolean;
  localCommit?: boolean;
  authorName?: string;
  authorEmail?: string;
  text?: string;
  requestId: string;
}
export interface ModelAuthorizationCommand {
  demandId: string;
  expectedVersion: number;
  requestId: string;
  configurationDigest: string;
  resourceScope: 'demand-worktree-private-runtime-v1';
}
export interface WorkbenchBridge {
  snapshot(): Promise<ViewState>;
  subscribe(listener: (state: ViewState) => void): () => void;
  createProject(): Promise<ViewState>;
  importConfiguration(): Promise<ViewState>;
  prepareModelApproval(input: { demandId: string; expectedVersion: number }): Promise<ViewState>;
  authorizeModel(input: ModelAuthorizationCommand): Promise<ViewState>;
  createDemand(input: { projectId: string; title: string; description: string; requestId: string }): Promise<ViewState>;
  command(input: Command): Promise<ViewState>;
  knowledgeAction(input: KnowledgeAction): Promise<ViewState>;
  sendMessage(input: { demandId: string; text: string; requestId: string }): Promise<ViewState>;
}
declare global { interface Window { workbench?: WorkbenchBridge } }
/** Stable display DTO alias used by the Host adapter. */
export type DemandView = Demand;
