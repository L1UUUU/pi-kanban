import { createHash } from 'node:crypto';
import { RuntimeError } from './types.ts';
/** Win32 profile names are limited to 64 characters. Bind the full identity with
 * a 192-bit digest rather than truncating demand/generation components. */
export function appContainerProfileName(demand:string,role:string,generation:string):string {
  if(![demand,role,generation].every(value=>typeof value==='string'&&/^[-a-zA-Z0-9_]{1,80}$/.test(value)))throw new RuntimeError('NATIVE_IDENTITY_INVALID','Bound ASCII identity required');
  return `pi-kanban-${createHash('sha256').update(`${demand}|${role}|${generation}`,'utf8').digest('hex').slice(0,48)}`;
}
