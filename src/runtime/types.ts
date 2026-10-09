/** Host-owned contracts. A role, PID, or Worker-reported boolean is not authorization. */
export type RuntimeRole = 'planning' | 'implementation' | 'review' | 'boundary-review' | 'check';
export type RunState = 'launch_intent' | 'running' | 'stop_requested' | 'stopping' | 'stopped' | 'unknown';
export interface LaunchRequest {
  demandId: string;
  role: RuntimeRole;
  writes: boolean;
  grantId: string;
  workspace: string;
  profileId: string;
  highResource?: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
}
export interface ProcessIdentity {
  pid: number;
  birth: string;
  generation: string;
  controlId: string;
  driver: string;
}
export interface RunRecord extends LaunchRequest {
  runId: string;
  generation: string;
  state: RunState;
  identity: ProcessIdentity | null;
  stopReason: string | null;
  createdAt: string;
  updatedAt: string;
  evidence: string | null;
}
export interface Observation {
  state: 'alive' | 'stopped' | 'unknown';
  generation: string;
  /** Actual controlled descendants, not merely the parent process. */
  activePids: number[];
  proof: string;
}
export interface RuntimeDriver {
  readonly id: string;
  readonly isolation: 'unverified-windows-candidate' | 'verified-windows-native' | 'synthetic-process-supervision-only';
  setStopHandler?(handler: (runId: string, reason: string) => Promise<void>): void;
  preflight(request: LaunchRequest): void;
  launch(run: RunRecord): Promise<ProcessIdentity>;
  stop(run: RunRecord): Promise<Observation>;
  observe(run: RunRecord): Promise<Observation>;
  /** Optional authenticated durable proof for crash before process registration.
   * Never infer this from a missing PID or a generic process lookup. */
  recoverUnregistered?(run: RunRecord): Promise<Observation>;
}
export class RuntimeError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = 'RuntimeError'; this.code = code; }
}
