/** Independent Host-side Windows recorder. Executes the real bundled Pi Worker and
 * native helper against disposable fixtures; the only model is a deterministic
 * in-memory responder. Output is partial diagnostic evidence, never a release
 * authorization. It has no provider URL, credentials, or network model transport. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PrivateFrameDecoder, encodePrivateFrame } from '../../src/runtime/pipe-frames.ts';
import { NativeRecoveryStore } from '../../src/runtime/native-recovery.ts';

if (process.platform !== 'win32' || process.arch !== 'x64' || !/^v24\./.test(process.version)) throw new Error('The native Worker probe requires actual Windows x64 with Node 24; no platform fallback.');
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) { assert.ok(['--helper', '--worker', '--output'].includes(process.argv[i]) && process.argv[i + 1], 'Expected --helper, --worker, --output paths'); options.set(process.argv[i], resolve(process.argv[i + 1])); }
const helperPath = options.get('--helper') ?? resolve('build/native/Release/pi_kanban_native_helper.exe');
const workerPath = options.get('--worker') ?? resolve('dist/worker/main.mjs');
const outputDirectory = options.get('--output') ?? resolve('artifacts/windows-worker');
mkdirSync(outputDirectory, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'pi-kanban-worker-'));
const nodeRoot = join(root, 'runtime-node'), workerRoot = join(root, 'runtime-worker');
const nodePath = join(nodeRoot, 'node.exe'), bundledWorker = join(workerRoot, 'main.mjs');
for (const folder of [nodeRoot, workerRoot, join(root, 'other'), join(root, 'host')]) mkdirSync(folder);
copyFileSync(process.execPath, nodePath); copyFileSync(workerPath, bundledWorker);
writeFileSync(join(nodeRoot, 'private-sibling.txt'), 'PRIVATE-NODE-SIBLING'); writeFileSync(join(workerRoot, 'private-sibling.txt'), 'PRIVATE-WORKER-SIBLING');
const hash = value => createHash('sha256').update(value).digest('hex');
const fileHash = path => hash(readFileSync(path));
const challenge = randomBytes(32).toString('hex');
writeFileSync(join(root, 'other', 'private.txt'), `OTHER-${challenge}`);
writeFileSync(join(root, 'host', 'control.txt'), `HOST-${challenge}`);
const transcript = [], probes = [], liveHelpers = new Set();
const record = (kind, value) => { const event = { kind, at: new Date().toISOString(), value }; transcript.push(event); writeFileSync(join(outputDirectory, 'transcript.json'), JSON.stringify(transcript, null, 2)); };
const evidence = { schemaVersion: 1, recorder: 'host-native-worker-probe-v1', status: 'running', synthetic: false, model: 'deterministic-no-network-no-spend', releaseAuthorized: false,
  osBuild: release(), arch: process.arch, nodeVersion: process.version, bindings: { nodeSha256: fileHash(nodePath), helperSha256: fileHash(helperPath), workerSha256: fileHash(bundledWorker), piLockSha256: fileHash(resolve('node_modules/@earendil-works/pi-coding-agent/package.json')) }, fixtureRoot: root, probes };
const save = () => writeFileSync(join(outputDirectory, 'report.json'), JSON.stringify({ ...evidence, transcriptSha256: fileHash(join(outputDirectory, 'transcript.json')) }, null, 2));
const passed = (id, observation) => { probes.push({ id, passed: true, observation }); record('probe', probes.at(-1)); };
const listener = createServer(socket => { record('unexpected-network-connection', {}); socket.destroy(); });
await new Promise((res, rej) => { listener.once('error', rej); listener.listen(0, '127.0.0.1', res); });
const port = listener.address().port;
let connected = 0; listener.on('connection', () => { connected++; });

function launch(role, suffix, workspaceOverride, enableRecovery = false) {
  const generation = `probe-${randomUUID()}`, workspace = workspaceOverride ?? join(root, `source-${suffix}`), scratch = join(root, `scratch-${suffix}`);
  if (!workspaceOverride) { mkdirSync(workspace); mkdirSync(join(workspace, '.git')); writeFileSync(join(workspace, 'source.txt'), 'original'); writeFileSync(join(workspace, '.git', 'object'), 'PRIVATE-GIT'); }
  mkdirSync(scratch); const sessionDir = join(scratch, 'sessions'); mkdirSync(sessionDir);
  const descriptor = { type: 'launch', version: 1, demand: 'probe', role, generation, profileName: `pi-kanban-probe-${role}-${generation}`, nodeExecutable: nodePath, workerEntry: bundledWorker, workspace, scratch,
    nodeSha256: evidence.bindings.nodeSha256, workerSha256: evidence.bindings.workerSha256, policyEvidence: 'actual-native-worker-probe-partial-not-release', aclEvidence: `fixture-${suffix}`, privateChannelEvidence: 'parent-owned-anonymous-pipes', timeoutMs: 45000, processLimit: 8, memoryLimitBytes: 1024 * 1024 * 1024, outputLimitBytes: 4 * 1024 * 1024,
    resourceAuthorizationId: 'disposable-synthetic-fixtures-only', readonlyRuntimeRoots: [nodePath, bundledWorker], recoveryReceiptPath: '', recoveryKey: '', recoveryContextSha256: '' };
  const recoveryStore = enableRecovery ? new NativeRecoveryStore(join(root, 'host', 'native-recovery')) : null;
  const profile = { profileId: 'native-worker-probe', osBuild: release(), arch: 'x64', node: { path: nodePath, version: process.version, sha256: evidence.bindings.nodeSha256 }, helper: { path: helperPath, version: 'probe', sha256: evidence.bindings.helperSha256 }, worker: { path: bundledWorker, version: 'probe', sha256: evidence.bindings.workerSha256 }, pi: { path: resolve('node_modules/@earendil-works/pi-coding-agent/package.json'), version: JSON.parse(readFileSync(resolve('node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8')).version, sha256: evidence.bindings.piLockSha256, package: '@earendil-works/pi-coding-agent' }, policySha256: hash('native-worker-probe-partial'), evidence: [] };
  const runRecord = { runId: `run-${randomUUID()}`, generation, demandId: 'probe', role, writes: role === 'implementation', grantId: 'probe', workspace, profileId: profile.profileId, timeoutMs: 45000, maxOutputBytes: 4194304, state: 'running', identity: null, stopReason: null, evidence: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (recoveryStore) Object.assign(descriptor, recoveryStore.prepare(runRecord, profile));
  const helper = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { SystemRoot: process.env.SystemRoot, SystemDrive: process.env.SystemDrive, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA, FORBIDDEN_HOST_CREDENTIAL: 'SYNTHETIC-NEVER-A-REAL-SECRET' } });
  liveHelpers.add(helper); const native = [], worker = [], nativeDecoder = new PrivateFrameDecoder(), workerDecoder = new PrivateFrameDecoder(); let failure, exited = false;
  const send = value => helper.stdin.write(encodePrivateFrame(Buffer.from(JSON.stringify(value))));
  for (const [stream, decoder, values, kind] of [[helper.stderr, nativeDecoder, native, 'native'], [helper.stdout, workerDecoder, worker, 'worker']]) stream.on('data', data => { try { for (const frame of decoder.push(data)) { const value = JSON.parse(Buffer.from(frame).toString('utf8')); values.push(value); record(kind, { suffix, ...value }); } } catch (error) { failure = error; } });
  helper.on('error', error => { failure = error; }); helper.stdin.on('error', error => { if (!exited) failure = error; }); helper.on('close', (code, signal) => { exited = true; liveHelpers.delete(helper); record('helper-exit', { suffix, code, signal }); });
  const wait = async (test, label, milliseconds = 15000) => { const until = Date.now() + milliseconds; while (!test()) { if (failure) throw failure; if (Date.now() >= until) throw new Error(`${label}: timed out; native=${JSON.stringify(native.slice(-3))}`); if (exited) throw new Error(`${label}: helper exited before required observation`); await delay(10); } return test(); };
  const event = (type, predicate = () => true) => native.find(value => value.type === type && predicate(value));
  send(descriptor);
  const stop = async () => { send({ type: 'stop' }); await wait(() => event('native.observation', value => value.status === 0 && value.activePids.length === 0), 'actual zero-process Job observation'); assert.ok(event('native.resources', value => value.phase === 'revoke' && value.status === 0), 'Actual ACL revocation required'); await wait(() => exited, 'helper exit after stop'); };
  return { helper, generation, workspace, scratch, sessionDir, descriptor, native, worker, send, wait, event, stop, recoveryStore, profile, runRecord, get exited() { return exited; } };
}

function accessProgram(run, role) {
  // The exact command is chosen and checked by this Host recorder. Native stderr
  // carries its receipt separately from all untrusted Worker output.
  return `const fs=require('node:fs'),net=require('node:net');const p=${JSON.stringify({ source: join(run.workspace, 'source.txt'), other: join(root, 'other', 'private.txt'), host: join(root, 'host', 'control.txt'), git: join(run.workspace, '.git', 'object'), nodeSibling: join(nodeRoot, 'private-sibling.txt'), workerSibling: join(workerRoot, 'private-sibling.txt') })};const result={challenge:${JSON.stringify(challenge)},version:process.version,role:${JSON.stringify(role)},ownRead:fs.readFileSync(p.source,'utf8')==='original',ownWrite:false,denied:{},environmentClean:!process.env.FORBIDDEN_HOST_CREDENTIAL&&!process.env.NODE_OPTIONS&&!process.env.OPENAI_API_KEY};try{fs.writeFileSync(p.source,'changed');result.ownWrite=true}catch(e){result.writeError=e.code}for(const key of ['other','host','git','nodeSibling','workerSibling']){try{fs.readFileSync(p[key]);result.denied[key]=false}catch(e){result.denied[key]=['EACCES','EPERM'].includes(e.code)}}const socket=net.connect({host:'127.0.0.1',port:${port}});let finished=false;const done=(denied,code)=>{if(finished)return;finished=true;socket.destroy();result.networkDenied=denied;result.networkError=code;process.stdout.write(JSON.stringify(result));process.exit(result.ownRead&&result.ownWrite===${role === 'implementation'}&&Object.values(result.denied).every(Boolean)&&result.environmentClean&&denied?0:1)};socket.once('connect',()=>done(false,'connected'));socket.once('error',e=>done(['EACCES','EPERM'].includes(e.code),e.code));setTimeout(()=>done(false,'inconclusive-timeout'),3000);`;
}

async function runPiRole(role) {
  const run = launch(role, role); await run.wait(() => run.event('native.started'), 'native Node Worker launch');
  assert.ok(run.event('native.resources', event => event.phase === 'provision' && event.status === 0));
  const capability = randomBytes(32).toString('hex'), sessionId = `session-${randomUUID()}`, runId = `runtime-${randomUUID()}`;
  const args = ['-e', accessProgram(run, role)];
  const init = { version: 1, type: 'worker.init', runId, generation: run.generation, demandId: 'probe', domainRunId: 'domain-probe', domainGeneration: 1, role, workspace: run.workspace, scratch: run.scratch, sessionDir: run.sessionDir, sessionId, capability, prompt: 'Execute only deterministic fixture instructions through the private Host channel.', materials: [],
    model: { provider: 'fixture', id: 'deterministic', contextWindow: 32768, maxTokens: 128 }, compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 64 }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 }, limits: { maxFileBytes: 65536, commandTimeoutMs: 10000, maxOutputBytes: 65536 } };
  run.send({ type: 'worker-input', payload: init });
  let cursor = 0, models = 0, reports = 0, checkReceipt, checkRequest, ready = false, settled = false;
  await run.wait(() => run.worker.length, 'actual Pi SDK private channel', 25000);
  const until = Date.now() + 30000;
  while (!settled) {
    assert.ok(Date.now() < until, 'Pi session must settle within its deadline');
    for (; cursor < run.worker.length; cursor++) {
      const frame = run.worker[cursor]; assert.equal(frame.generation, run.generation);
      if (frame.type === 'worker.ready') { assert.equal(frame.sessionId, sessionId); ready = true; }
      else if (frame.type === 'model.request') {
        assert.equal(frame.runId, runId); assert.equal(frame.sessionId, sessionId); assert.equal(frame.capability, capability); assert.equal(frame.sequence, ++models); assert.ok(models <= 3); assert.ok(Array.isArray(frame.context.messages));
        const value = models === 1 ? { text: '', toolCalls: [{ id: 'native-check-1', name: 'controlled_node', arguments: { args } }] } : models === 2 ? { text: '', toolCalls: [{ id: 'report-1', name: 'controlled_report', arguments: { report: { type: 'blocked', reason: 'Deterministic fixture complete; no business task or paid model.' } } }] } : { text: 'Fixture complete.' };
        run.send({ type: 'worker-input', payload: { sequence: models, ok: true, value: { ...value, usage: { tokens: 1, costMicros: 0, source: 'deterministic-fixture' } } } });
      } else if (frame.type === 'worker.check-request') {
        assert.equal(frame.capability, capability); assert.equal(frame.runId, runId); assert.equal(frame.toolCallId, 'native-check-1'); assert.deepEqual(frame.args, args); assert.ok(!checkRequest); checkRequest = frame;
        run.send({ type: 'run-node', requestId: frame.requestId, args, timeoutMs: 10000, maxOutputBytes: 65536 });
      } else if (frame.type === 'worker.report') {
        assert.equal(frame.capability, capability); assert.equal(frame.report.type, 'blocked'); reports++;
        run.send({ type: 'worker-input', payload: { type: 'worker.receipt', requestId: frame.report.requestId, ok: true, value: { status: 'applied' } } });
      } else if (frame.type === 'worker.settled') { assert.equal(frame.sessionId, sessionId); settled = true; }
      else assert.equal(frame.type, 'worker.event', 'Unknown Worker output');
    }
    if (checkRequest && !checkReceipt) {
      const receipt = run.event('native.check-result', value => value.requestId === checkRequest.requestId);
      if (receipt) {
        assert.equal(receipt.generation, run.generation); assert.deepEqual(receipt.arguments, args); assert.equal(receipt.status, 0); assert.equal(receipt.reason, 'exited'); assert.equal(receipt.exitCode, 0); assert.ok(receipt.pid > 0);
        const result = JSON.parse(Buffer.from(receipt.outputBase64, 'base64').toString('utf8')); assert.equal(result.challenge, challenge); assert.equal(result.ownWrite, role === 'implementation'); assert.equal(result.ownRead, true); assert.equal(result.environmentClean, true); assert.equal(result.networkDenied, true); assert.deepEqual(result.denied, { other: true, host: true, git: true, nodeSibling: true, workerSibling: true }); checkReceipt = receipt;
        run.send({ type: 'worker-input', payload: { type: 'worker.check-result', requestId: checkRequest.requestId, ok: true, value: { requestId: checkRequest.requestId, exitCode: receipt.exitCode, output: JSON.stringify(result), reason: receipt.reason, evidence: { id: 'independent-native-receipt' } } } });
      }
    }
    if (!settled) { if (run.exited) throw new Error(`Worker exited before settled: ${JSON.stringify(run.native)}`); await delay(10); }
  }
  assert.ok(ready && checkReceipt && models === 3 && reports === 1); assert.equal(readFileSync(join(run.workspace, 'source.txt'), 'utf8'), role === 'implementation' ? 'changed' : 'original');
  await run.wait(() => run.event('native.observation', value => value.status === 0 && value.activePids.length === 0), 'natural Worker full Job stop');
  assert.ok(run.event('native.resources', value => value.phase === 'revoke' && value.status === 0));
  passed(role === 'implementation' ? 'implementation-own-write' : 'review-source-read-only', `Actual Node ${process.version}/bundled Pi ${role}, native receipt and independent Host source verification; zero Job census and successful ACL revocation.`);
  return run;
}

try {
  record('start', evidence);
  await runPiRole('implementation'); await runPiRole('review');
  assert.equal(connected, 0, 'Trusted listener must observe zero sandbox connections');
  for (const id of ['cross-demand-denied', 'shared-git-denied', 'host-control-denied', 'private-model-channel', 'node-pi-compatibility']) passed(id, 'Both real role runs passed exact Host-selected native command, private broker tool loop and native process receipt assertions.');
  passed('network-denied', 'Both role checks returned actual EACCES/EPERM against a live trusted loopback listener; Host observed zero connections. This does not claim every network/service escape is tested.');
  // A second helper-owned Node process must be present in the same Job; stopping
  // while it is writing must leave an actual zero census and quiescent file.
  const descendant = launch('implementation', 'descendant');
  await descendant.wait(() => descendant.event('native.started'), 'descendant fixture Worker');
  const heartbeat = join(descendant.scratch, 'heartbeat.txt');
  descendant.send({ type: 'run-node', requestId: 'heartbeat-check', args: ['-e', `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'tick\\n'),20)`], timeoutMs: 20000, maxOutputBytes: 4096 });
  await descendant.wait(() => existsSync(heartbeat) && statSync(heartbeat).size > 0, 'native-mediated heartbeat');
  descendant.send({ type: 'query' }); await descendant.wait(() => descendant.event('native.observation', event => event.status === 0 && event.activePids.length >= 2), 'actual same Job membership');
  await descendant.stop(); const heartbeatSize = statSync(heartbeat).size; await delay(150); assert.equal(statSync(heartbeat).size, heartbeatSize);
  passed('descendant-stop', 'Native helper-mediated Node heartbeat was present with the Worker in actual Job census; explicit stop produced zero processes, successful ACL revoke and quiescent heartbeat.');
  // Simulate Host process loss by closing its only control pipe. The new Host
  // store must authenticate native proof, never infer success from PID absence.
  const recovery = launch('implementation', 'eof-recovery', undefined, true);
  await recovery.wait(() => recovery.event('native.started'), 'recovery fixture Worker');
  const started = recovery.event('native.started');
  recovery.runRecord.identity = { pid: started.pid, birth: started.birth, generation: recovery.generation, controlId: recovery.runRecord.runId, driver: 'windows-appcontainer-job-v1' };
  recovery.recoveryStore.bind(recovery.runRecord.runId, recovery.runRecord.identity);
  recovery.helper.stdin.end(); await recovery.wait(() => recovery.exited, 'native EOF cleanup');
  const restartedStore = new NativeRecoveryStore(recovery.recoveryStore.directory);
  const recovered = restartedStore.observe(recovery.runRecord, recovery.profile); assert.equal(recovered?.state, 'stopped');
  passed('host-eof-recovery', 'Reconstructed Host authenticated native HMAC receipt binding exact generation, process birth, artifact/policy context, zero Job census and successful ACL revoke after control EOF.');
  // Reparse provisioning must fail before launch, with actual Win32 denial.
  const linkWorkspace = join(root, 'source-reparse'); mkdirSync(linkWorkspace); symlinkSync(join(root, 'other'), join(linkWorkspace, 'escape'), 'junction');
  const rejected = launch('review', 'reparse', linkWorkspace); await rejected.wait(() => rejected.event('native.resources', value => value.phase === 'provision'), 'reparse denial');
  assert.notEqual(rejected.event('native.resources').status, 0); assert.equal(rejected.event('native.started'), undefined); passed('reparse-denied', 'Native provisioner rejected a real junction before spawning any Worker. Race attacks are not claimed.');
  evidence.status = 'passed'; save(); console.log(JSON.stringify({ nativeWorkerProbePassed: true, actualNodePi: true, paidModelCalls: 0, releaseAuthorized: false, report: join(outputDirectory, 'report.json') }));
} catch (error) {
  evidence.status = 'failed'; evidence.error = String(error?.stack ?? error); record('failure', { error: evidence.error }); save(); console.error(evidence.error); process.exitCode = 1;
} finally {
  listener.close();
  for (const helper of liveHelpers) { helper.stdin.end(); await delay(50); if (helper.exitCode === null) helper.kill(); }
  // Fixtures are retained intentionally for ACL/identity diagnosis. They contain
  // synthetic data only; abnormal helper death must never be called clean revoke.
}
