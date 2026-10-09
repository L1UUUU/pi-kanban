/** The desktop control protocol is deliberately separate from Worker reports. */
export const MAX_FRAME_BYTES = 128 * 1024;
export const COMMANDS = new Set(['start-planning', 'confirm-plan', 'authorize-implementation', 'pause', 'resume', 'cancel', 'accept-result', 'return-result', 'revise-plan', 'decide-finding', 'resolve-blocker', 'switch-method']);
export class ProtocolError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new ProtocolError('INVALID_INPUT', 'Expected an ordinary object.');
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, max = 20_000, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max || value.includes('\0')) throw new ProtocolError('INVALID_INPUT', `Invalid ${name}.`);
  return value;
}
export function id(value: unknown, name = 'identifier'): string { return text(value, name, 160); }
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ProtocolError('INVALID_INPUT', 'An explicit current version is required.');
  return Number(value);
}
export function assertFrame(value: unknown): void {
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { throw new ProtocolError('INVALID_INPUT', 'Frame is not serializable.'); }
  if (bytes > MAX_FRAME_BYTES) throw new ProtocolError('FRAME_TOO_LARGE', 'Message exceeds the control frame limit.');
}
export interface RpcRequest { id: string; method: string; params: Record<string, unknown> }
export function parseRequest(value: unknown): RpcRequest {
  assertFrame(value); const frame = record(value);
  const method = text(frame.method, 'method', 40);
  if (!new Set(['snapshot', 'inspectProject', 'createProject', 'createDemand', 'command', 'sendMessage', 'importConfiguration', 'prepareModelApproval', 'authorizeModel', 'shutdown']).has(method)) throw new ProtocolError('UNKNOWN_METHOD', 'This action is not part of the desktop control protocol.');
  return { id: id(frame.id, 'request identifier'), method, params: frame.params === undefined ? {} : record(frame.params) };
}
