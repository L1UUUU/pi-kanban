import { RuntimeError } from './types.ts';
export interface NativeCheckResult {requestId:string;exitCode:number|null;output:string;reason:'exited'|'timeout'|'output-limit'|'descendants-survived'|'launch-failed';nativeEvidence:Record<string,unknown>}
/** Invoked only on the separately owned native helper stderr handle. Parsing a
 * Worker-supplied object through this function does not establish provenance. */
export function validateNativeCheckReceipt(event:Record<string,unknown>,expected:{requestId:string;generation:string;args:string[];maxOutputBytes:number}):NativeCheckResult {
  const invalid=()=>{throw new RuntimeError('NATIVE_CHECK_INVALID','Mismatched, incomplete or out-of-bounds native command receipt');};
  if(event.type!=='native.check-result'||event.requestId!==expected.requestId||event.generation!==expected.generation||JSON.stringify(event.arguments)!==JSON.stringify(expected.args)||
    !['exited','timeout','output-limit','descendants-survived','launch-failed'].includes(String(event.reason))||typeof event.outputBase64!=='string'||event.outputBase64.length>699052||
    !Number.isSafeInteger(event.status)||Number(event.status)<0||Number(event.status)>0xffffffff)invalid();
  if(event.reason==='launch-failed') { if(event.status===0||event.pid!==0||event.exitCode!==null||event.outputBase64!=='')invalid(); }
  else if(event.status!==0||!Number.isSafeInteger(event.pid)||Number(event.pid)<1||typeof event.birth!=='string'||!/^[1-9]\d{0,19}$/.test(event.birth)||!Number.isSafeInteger(event.exitCode)||Number(event.exitCode)<0||Number(event.exitCode)>0xffffffff)invalid();
  const encoded=event.outputBase64 as string,output=Buffer.from(encoded,'base64');
  if(output.toString('base64')!==encoded||output.byteLength>Math.min(expected.maxOutputBytes,524288))invalid();
  return {requestId:expected.requestId,exitCode:event.exitCode as number|null,output:output.toString('utf8'),reason:event.reason as NativeCheckResult['reason'],nativeEvidence:{...event}};
}
