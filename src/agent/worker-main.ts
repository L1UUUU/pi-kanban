import { runWorkerFromStreams } from './worker-runtime.ts';
/** Built as a locked executable entry; never launched as an unrestricted fallback. */
async function main(){
  if(process.platform!=='win32'||process.arch!=='x64'||process.argv.length!==4||process.argv[2]!=='--controlled-run'||!/^[-a-zA-Z0-9_]+$/.test(process.argv[3]))
    throw new Error('This Worker entry requires native Windows x64 and an exact controlled-run generation');
  await runWorkerFromStreams(process.stdin,process.stdout,process.argv[3]);
  process.stdin.destroy();
}
void main().catch(error=>{process.stderr.write(`Controlled Worker failed: ${error instanceof Error?error.message:'unknown'}\n`);process.exitCode=1;process.stdin.destroy();});
