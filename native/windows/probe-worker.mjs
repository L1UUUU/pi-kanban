/** Independent Host-side Windows recorder. Executes the real bundled Pi Worker and
 * native helper against disposable fixtures; the only model is a deterministic
 * in-memory responder. Output is partial diagnostic evidence, never a release
 * authorization. It has no provider URL, credentials, or network model transport. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, symlinkSync, rmSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, release, version as osVersion } from 'node:os';
import { dirname, join, resolve, relative, parse } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PrivateFrameDecoder, encodePrivateFrame } from '../../src/runtime/pipe-frames.ts';
import { appContainerProfileName } from '../../src/runtime/appcontainer-name.ts';
import { NativeRecoveryStore } from '../../src/runtime/native-recovery.ts';

if (process.platform !== 'win32' || process.arch !== 'x64' || !/^v24\./.test(process.version)) throw new Error('The native Worker probe requires actual Windows x64 with Node 24; no platform fallback.');
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) { assert.ok(['--helper', '--worker', '--output', '--policy', '--git-bash'].includes(process.argv[i]) && process.argv[i + 1], 'Expected --helper, --worker, --output paths'); options.set(process.argv[i], process.argv[i] === '--policy' ? process.argv[i + 1] : resolve(process.argv[i + 1])); }
const helperPath = options.get('--helper') ?? resolve('build/native/Release/pi_kanban_native_helper.exe');
const workerPath = options.get('--worker') ?? resolve('dist/worker/main.mjs');
const policyVariant = options.get('--policy') ?? 'lpac-strict-v1';
assert.ok(['lpac-strict-v1', 'lpac-registry-read-no-network-v2', 'appcontainer-no-network-v3'].includes(policyVariant));
const outputDirectory = options.get('--output') ?? resolve('artifacts/windows-worker');
mkdirSync(outputDirectory, { recursive: true });
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pi-kanban-worker-')));
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
// Shell preparation runs only after the independent Node/Pi/recovery probes.
// Copy three required official executables and the bounded usr/bin DLL set, never
// all Git programs or neighboring config/key files. Installed ACLs stay untouched.
let shellFixture = null;
function prepareShellFixture() {
  const installed = realpathSync(options.get('--git-bash')), shellRoot = join(root, 'runtime-shell'), files = [];
  const sourceDirectory = join(installed, 'usr', 'bin'), requiredExecutables = new Set(['bash.exe', 'cat.exe', 'rm.exe']);
  const selected = readdirSync(sourceDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && (requiredExecutables.has(entry.name.toLowerCase()) || /\.dll$/i.test(entry.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const name of requiredExecutables) assert.ok(selected.some(entry => entry.name.toLowerCase() === name), `Official Git fixture is missing ${name}`);
  assert.ok(selected.length <= 512, `Official Bash fixture has ${selected.length} files; the exact manifest bound remains 512`);
  for (const entry of selected) {
    const source = join(sourceDirectory, entry.name); assert.ok(!lstatSync(source).isSymbolicLink());
    const destination = join(shellRoot, 'usr', 'bin', entry.name); mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination);
    files.push({ path: destination, sha256: fileHash(destination) });
  }
  const executable = join(shellRoot, 'usr', 'bin', 'bash.exe'); assert.ok(files.some(file => file.path === executable));
  const home = join(root, 'shell-version-home'); mkdirSync(home);
  const version = spawnSync(join(installed, 'usr', 'bin', 'bash.exe'), ['--noprofile', '--norc', '-c', 'printf %s "$BASH_VERSION"'], { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { SystemRoot: process.env.SystemRoot, SystemDrive: process.env.SystemDrive, HOME: home, USERPROFILE: home, TEMP: home, TMP: home } });
  assert.equal(version.status, 0, `Official Bash version probe failed: ${version.stderr}`); const semanticVersion = version.stdout.match(/^\d+\.\d+\.\d+/)?.[0]; assert.ok(semanticVersion);
  const manifestPath = join(root, 'host', 'shell-manifest.json'); writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, rootPath: shellRoot, files }));
  writeFileSync(join(shellRoot, 'private-sibling.txt'), 'UNLISTED-PRIVATE-RUNTIME-SIBLING');
  return { rootPath: shellRoot, files, path: executable, version: semanticVersion, sha256: fileHash(executable), kind: 'git-bash', manifest: { path: manifestPath, sha256: fileHash(manifestPath) } };
}
const transcript = [], probes = [], liveHelpers = new Set();
const record = (kind, value) => { const event = { kind, at: new Date().toISOString(), value }; transcript.push(event); writeFileSync(join(outputDirectory, 'transcript.json'), JSON.stringify(transcript, null, 2)); };
const evidence = { schemaVersion: 1, recorder: 'host-native-worker-probe-v1', status: 'running', synthetic: false, model: 'deterministic-no-network-no-spend', releaseAuthorized: false,
  toolScope: options.has('--git-bash') ? 'node-and-git-bash-diagnostic' : 'node-native-tools-only',
  policyVariant, osBuild: release(), osVersion: osVersion(), arch: process.arch, nodeVersion: process.version, bindings: { nodeSha256: fileHash(nodePath), helperSha256: fileHash(helperPath), workerSha256: fileHash(bundledWorker), piLockSha256: fileHash(resolve('node_modules/@earendil-works/pi-coding-agent/package.json')) }, fixtureRoot: root, probes };
const save = () => writeFileSync(join(outputDirectory, 'report.json'), JSON.stringify({ ...evidence, transcriptSha256: fileHash(join(outputDirectory, 'transcript.json')) }, null, 2));
const passed = (id, observation) => { probes.push({ id, passed: true, observation }); record('probe', probes.at(-1)); };
const listener = createServer(socket => { record('unexpected-network-connection', {}); socket.destroy(); });
await new Promise((res, rej) => { listener.once('error', rej); listener.listen(0, '127.0.0.1', res); });
const port = listener.address().port;
let connected = 0; listener.on('connection', () => { connected++; });

function launch(role, suffix, workspaceOverride, enableRecovery = false, diskLimitBytes = 1024 * 1024 * 1024, enableShell = false) {
  const generation = `probe-${randomUUID()}`, workspace = workspaceOverride ?? join(root, `source-${suffix}`), scratch = join(root, `scratch-${suffix}`);
  if (!workspaceOverride) { mkdirSync(workspace); mkdirSync(join(workspace, '.git')); writeFileSync(join(workspace, 'source.txt'), 'original'); writeFileSync(join(workspace, 'delete-me.txt'), 'delete fixture'); writeFileSync(join(workspace, '.git', 'object'), 'PRIVATE-GIT'); }
  mkdirSync(scratch); const sessionDir = join(scratch, 'sessions'); mkdirSync(sessionDir);
  const descriptor = { type: 'launch', version: 1, policyVariant, demand: 'probe', role, generation, profileName: appContainerProfileName('probe', role, generation), nodeExecutable: nodePath, workerEntry: bundledWorker, workspace, scratch,
    nodeSha256: evidence.bindings.nodeSha256, workerSha256: evidence.bindings.workerSha256, policyEvidence: 'actual-native-worker-probe-partial-not-release', aclEvidence: `fixture-${suffix}`, privateChannelEvidence: 'parent-owned-anonymous-pipes', timeoutMs: 45000, processLimit: 8, memoryLimitBytes: 1024 * 1024 * 1024, outputLimitBytes: 4 * 1024 * 1024,
    resourceAuthorizationId: 'disposable-synthetic-fixtures-only', readonlyRuntimeRoots: [nodePath, bundledWorker], recoveryReceiptPath: '', recoveryKey: '', recoveryContextSha256: '', diskLimitBytes, fileLimit: 100000, minimumFreeBytes: 256 * 1024 * 1024, diskPollMs: 100, shellExecutable: '', shellRootPath: '', shellSha256: '', shellFiles: [] };
  if (enableShell) { assert.ok(shellFixture); Object.assign(descriptor, { shellExecutable: shellFixture.path, shellRootPath: shellFixture.rootPath, shellSha256: shellFixture.sha256, shellFiles: shellFixture.files, readonlyRuntimeRoots: [nodePath, bundledWorker, ...shellFixture.files.map(file => file.path)] }); }
  const recoveryStore = enableRecovery ? new NativeRecoveryStore(join(root, 'host', 'native-recovery')) : null;
  const profile = { profileId: 'native-worker-probe', policyVariant, osBuild: release(), arch: 'x64', node: { path: nodePath, version: process.version, sha256: evidence.bindings.nodeSha256 }, helper: { path: helperPath, version: 'probe', sha256: evidence.bindings.helperSha256 }, worker: { path: bundledWorker, version: 'probe', sha256: evidence.bindings.workerSha256 }, pi: { path: resolve('node_modules/@earendil-works/pi-coding-agent/package.json'), version: JSON.parse(readFileSync(resolve('node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8')).version, sha256: evidence.bindings.piLockSha256, package: '@earendil-works/pi-coding-agent' }, policySha256: hash('native-worker-probe-partial'), evidence: [] };
  if (enableShell) profile.shell = { path: shellFixture.path, version: shellFixture.version, sha256: shellFixture.sha256, kind: shellFixture.kind, manifest: shellFixture.manifest };
  const runRecord = { runId: `run-${randomUUID()}`, generation, demandId: 'probe', role, writes: role === 'implementation', grantId: 'probe', workspace, profileId: profile.profileId, timeoutMs: 45000, maxOutputBytes: 4194304, state: 'running', identity: null, stopReason: null, evidence: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (recoveryStore) Object.assign(descriptor, recoveryStore.prepare(runRecord, profile));
  const helper = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { SystemRoot: process.env.SystemRoot, SystemDrive: process.env.SystemDrive, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA, FORBIDDEN_HOST_CREDENTIAL: 'SYNTHETIC-NEVER-A-REAL-SECRET' } });
  liveHelpers.add(helper); const native = [], worker = [], nativeDecoder = new PrivateFrameDecoder(), workerDecoder = new PrivateFrameDecoder(); let failure, exited = false;
  const send = value => helper.stdin.write(encodePrivateFrame(Buffer.from(JSON.stringify(value))));
  for (const [stream, decoder, values, kind] of [[helper.stderr, nativeDecoder, native, 'native'], [helper.stdout, workerDecoder, worker, 'worker']]) stream.on('data', data => { try { for (const frame of decoder.push(data)) { const value = JSON.parse(Buffer.from(frame).toString('utf8')); values.push(value); record(kind, { suffix, ...value }); } } catch (error) { failure = error; } });
  helper.on('error', error => { failure = error; }); helper.stdin.on('error', error => { if (!exited) failure = error; }); helper.on('close', (code, signal) => { exited = true; liveHelpers.delete(helper); record('helper-exit', { suffix, code, signal }); });
  const wait = async (test, label, milliseconds = 15000) => { const until = Date.now() + milliseconds; while (!test()) { if (failure) throw failure; if (Date.now() >= until) throw new Error(`${label}: timed out; native=${JSON.stringify(native.slice(-3))}`); if (exited) throw new Error(`${label}: helper exited before required observation; native=${JSON.stringify(native.slice(-10))}`); await delay(10); } return test(); };
  const event = (type, predicate = () => true) => native.find(value => value.type === type && predicate(value));
  send(descriptor);
  const stop = async () => { send({ type: 'stop' }); await wait(() => event('native.observation', value => value.status === 0 && value.activePids.length === 0), 'actual zero-process Job observation'); assert.ok(event('native.resources', value => value.phase === 'revoke' && value.status === 0), 'Actual ACL revocation required'); await wait(() => exited, 'helper exit after stop'); };
  return { helper, generation, workspace, scratch, sessionDir, descriptor, native, worker, send, wait, event, stop, recoveryStore, profile, runRecord, get exited() { return exited; } };
}

function accessProgram(run, role) {
  // The exact command is chosen and checked by this Host recorder. Native stderr
  // carries its receipt separately from all untrusted Worker output.
  return `const fs=require('node:fs'),net=require('node:net'),assert=require('node:assert/strict');
const p=${JSON.stringify({ source: join(run.workspace, 'source.txt'), deletion: join(run.workspace, 'delete-me.txt'), other: join(root, 'other', 'private.txt'), host: join(root, 'host', 'control.txt'), git: join(run.workspace, '.git', 'object'), nodeSibling: join(nodeRoot, 'private-sibling.txt'), workerSibling: join(workerRoot, 'private-sibling.txt') })};
const ancestors=${JSON.stringify({ nodeDirectory: nodeRoot, workerDirectory: workerRoot, fixtureRoot: root, volumeRoot: parse(root).root })};
assert.ok(fs.statSync(p.source).size<=65536,'bounded own-source read');
const source=fs.readFileSync(p.source,'utf8');
const matches=source.split(/\\r?\\n/).map((text,index)=>({line:index+1,text})).filter(row=>/^original$/.test(row.text));
assert.deepEqual(matches,[{line:1,text:'original'}],'own-source search and Node assertion check');
const result={challenge:${JSON.stringify(challenge)},version:process.version,role:${JSON.stringify(role)},ownRead:source==='original',ownSearch:matches,assertionCheck:true,ownWrite:false,ownDelete:false,gitDelete:false,denied:{},directoryListingDenied:{},ancestorMetadata:{},shellEnvironmentAbsent:!Object.keys(process.env).some(name=>['path','comspec','shell'].includes(name.toLowerCase())),environmentClean:!process.env.FORBIDDEN_HOST_CREDENTIAL&&!process.env.NODE_OPTIONS&&!process.env.OPENAI_API_KEY};
try{fs.writeFileSync(p.source,'changed');result.ownWrite=true}catch(e){result.writeError=e.code}
try{fs.unlinkSync(p.deletion);result.ownDelete=true}catch(e){result.deleteError=e.code}
try{fs.unlinkSync(p.git);result.gitDelete=true}catch(e){result.gitDeleteError=e.code}
for(const key of ['other','host','git','nodeSibling','workerSibling']){try{fs.readFileSync(p[key]);result.denied[key]=false}catch(e){result.denied[key]=['EACCES','EPERM'].includes(e.code)}}
for(const [key,path]of Object.entries(ancestors)){try{fs.lstatSync(path);result.ancestorMetadata[key]='readable'}catch(e){result.ancestorMetadata[key]=e.code}try{fs.readdirSync(path);result.directoryListingDenied[key]=false}catch(e){result.directoryListingDenied[key]=['EACCES','EPERM'].includes(e.code)}}
const socket=net.connect({host:'127.0.0.1',port:${port}});let finished=false;
const done=(denied,code)=>{if(finished)return;finished=true;socket.destroy();result.networkDenied=denied;result.networkError=code;process.stdout.write(JSON.stringify(result));process.exit(result.ownRead&&result.assertionCheck&&result.shellEnvironmentAbsent&&result.ownWrite===${role === 'implementation'}&&result.ownDelete===${role === 'implementation'}&&!result.gitDelete&&['EACCES','EPERM'].includes(result.gitDeleteError)&&Object.values(result.denied).every(Boolean)&&Object.values(result.directoryListingDenied).every(Boolean)&&result.environmentClean&&denied?0:1)};
socket.once('connect',()=>done(false,'connected'));socket.once('error',e=>done(['EACCES','EPERM'].includes(e.code),e.code));setTimeout(()=>done(false,'inconclusive-timeout'),3000);`;
}

async function runPiRole(role, workspaceOverride) {
  const run = launch(role, role, workspaceOverride); await run.wait(() => run.event('native.started'), 'native Node Worker launch');
  assert.ok(run.event('native.resources', event => event.phase === 'provision' && event.status === 0));
  assert.equal(run.event('native.started').policyVariant, policyVariant);
  assert.equal(run.event('native.started').policyAccessVerified, true); assert.equal(run.event('native.started').allApplicationPackagesReadable, policyVariant === 'appcontainer-no-network-v3');
  const capability = randomBytes(32).toString('hex'), sessionId = `session-${randomUUID()}`, runId = `runtime-${randomUUID()}`;
  const args = ['-e', accessProgram(run, role)];
  const init = { version: 1, type: 'worker.init', runId, generation: run.generation, demandId: 'probe', domainRunId: 'domain-probe', domainGeneration: 1, role, workspace: run.workspace, workspaceCapability: { version: 1, kind: 'native-pinned-workspace', path: run.workspace, generation: run.generation }, scratch: run.scratch, sessionDir: run.sessionDir, sessionId, capability, shellEnabled: false, prompt: 'Execute only deterministic fixture instructions through the private Host channel.', materials: [],
    model: { provider: 'fixture', id: 'deterministic', contextWindow: 32768, maxTokens: 128 }, compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 64 }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 }, limits: { maxFileBytes: 65536, commandTimeoutMs: 10000, maxOutputBytes: 65536 } };
  run.send({ type: 'worker-input', payload: init });
  let cursor = 0, models = 0, reports = 0, checkReceipt, checkRequest, ready = false, settled = false, readSearchChecked = false;
  await run.wait(() => run.worker.length, 'actual Pi SDK private channel', 25000);
  const until = Date.now() + 30000;
  while (!settled) {
    assert.ok(Date.now() < until, 'Pi session must settle within its deadline');
    for (; cursor < run.worker.length; cursor++) {
      const frame = run.worker[cursor]; assert.equal(frame.generation, run.generation);
      if (frame.type === 'worker.ready') { assert.equal(frame.sessionId, sessionId); ready = true; }
      else if (frame.type === 'model.request') {
        assert.equal(frame.runId, runId); assert.equal(frame.sessionId, sessionId); assert.equal(frame.capability, capability); assert.equal(frame.sequence, ++models); assert.ok(models <= 4); assert.ok(Array.isArray(frame.context.messages));
        // Pi 1.1.0 normalizes active tool declarations into system transcript
        // entries, rather than retaining a context.tools array.
        const toolNames = frame.context.messages.flatMap(message => message.toolsAdded ?? []).map(tool => tool.name);
        assert.ok(['controlled_node', 'controlled_read', 'controlled_search'].every(name => toolNames.includes(name)));
        assert.ok(toolNames.every(name => /^controlled_/.test(name) && name !== 'controlled_shell'), 'Actual Pi model context must expose no shell or built-in tools');
        if (models === 2) {
          const read = frame.context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'native-read-1');
          const search = frame.context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'native-search-1');
          assert.ok(read && search, 'Actual Pi read/search results must precede the Node check'); assert.equal(read.isError, false); assert.equal(search.isError, false);
          assert.deepEqual(read.content, [{ type: 'text', text: 'original' }]);
          assert.deepEqual(JSON.parse(search.content[0].text), { matches: [{ path: 'source.txt', line: 1, text: 'original' }], truncated: false, skippedFiles: 0 });
          readSearchChecked = true;
        }
        const value = models === 1 ? { text: '', toolCalls: [{ id: 'native-read-1', name: 'controlled_read', arguments: { path: 'source.txt' } }, { id: 'native-search-1', name: 'controlled_search', arguments: { query: 'original', maxResults: 10 } }] }
          : models === 2 ? { text: '', toolCalls: [{ id: 'native-check-1', name: 'controlled_node', arguments: { args } }] }
          : models === 3 ? { text: '', toolCalls: [{ id: 'report-1', name: 'controlled_report', arguments: { report: { type: 'blocked', reason: 'Deterministic fixture complete; no business task or paid model.' } } }] } : { text: 'Fixture complete.' };
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
        assert.equal(receipt.generation, run.generation); assert.deepEqual(receipt.arguments, args); assert.equal(receipt.status, 0); assert.equal(receipt.reason, 'exited'); assert.equal(receipt.exitCode, 0, `Native access check failed: ${Buffer.from(receipt.outputBase64, 'base64').toString('utf8').slice(0,8192)}`); assert.ok(receipt.pid > 0);
        const result = JSON.parse(Buffer.from(receipt.outputBase64, 'base64').toString('utf8')); assert.equal(result.challenge, challenge); assert.equal(result.ownWrite, role === 'implementation'); assert.equal(result.ownDelete, role === 'implementation'); assert.equal(result.gitDelete, false); if (role === 'review') assert.ok(['EACCES','EPERM'].includes(result.deleteError)); assert.equal(result.ownRead, true); assert.deepEqual(result.ownSearch, [{ line: 1, text: 'original' }]); assert.equal(result.assertionCheck, true); assert.equal(result.shellEnvironmentAbsent, true); assert.equal(result.environmentClean, true); assert.equal(result.networkDenied, true); assert.deepEqual(Object.keys(result.ancestorMetadata), ['nodeDirectory','workerDirectory','fixtureRoot','volumeRoot']); assert.deepEqual(result.directoryListingDenied, { nodeDirectory: true, workerDirectory: true, fixtureRoot: true, volumeRoot: true }); assert.deepEqual(result.denied, { other: true, host: true, git: true, nodeSibling: true, workerSibling: true }); checkReceipt = receipt;
        run.send({ type: 'worker-input', payload: { type: 'worker.check-result', requestId: checkRequest.requestId, ok: true, value: { requestId: checkRequest.requestId, exitCode: receipt.exitCode, output: JSON.stringify(result), reason: receipt.reason, evidence: { id: 'independent-native-receipt' } } } });
      }
    }
    if (!settled) { if (run.exited) throw new Error(`Worker exited before settled: ${JSON.stringify(run.native)}`); await delay(10); }
  }
  assert.ok(ready && readSearchChecked && checkReceipt && models === 4 && reports === 1); assert.equal(readFileSync(join(run.workspace, 'source.txt'), 'utf8'), role === 'implementation' ? 'changed' : 'original');
  await run.wait(() => run.event('native.observation', value => value.status === 0 && value.activePids.length === 0), 'natural Worker full Job stop');
  assert.ok(run.event('native.resources', value => value.phase === 'revoke' && value.status === 0));
  passed(role === 'implementation' ? 'implementation-own-write' : 'review-source-read-only', `Actual Node ${process.version}/bundled Pi ${role}: controlled read/search results and native Node assertion receipt checked against Host fixtures; independent Host source verification, zero Job census and successful ACL revocation.`);
  return run;
}

async function runCompletionDescendantFixture(persistent) {
  const suffix = persistent ? 'persistent-descendant' : 'short-lived-descendant';
  const run = launch('implementation', suffix, undefined, true);
  await run.wait(() => run.event('native.started'), `${suffix} Worker`);
  const started = run.event('native.started');
  run.runRecord.identity = { pid: started.pid, birth: started.birth, generation: run.generation, controlId: run.runRecord.runId, driver: 'windows-appcontainer-job-v1' };
  run.recoveryStore.bind(run.runRecord.runId, run.runRecord.identity);
  const ready = join(run.scratch, 'child-ready.json'), heartbeat = join(run.scratch, 'child-heartbeat.txt'), exited = join(run.scratch, 'child-exited.txt');
  // Child stdin belongs only to the command parent. Its EOF proves that parent
  // closed its handle; the short-lived child's 75 ms timer starts at that point,
  // not at process creation. Child stdout/stderr never hold the helper's pipe.
  const childProgram = `const fs=require('node:fs');const beat=()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'tick\\n');const timer=setInterval(beat,10);process.stdin.on('end',()=>{${persistent ? '' : `setTimeout(()=>{clearInterval(timer);fs.writeFileSync(${JSON.stringify(exited)},${JSON.stringify(challenge)});process.exit(0)},75);`}});process.stdin.resume();beat();fs.writeFileSync(${JSON.stringify(`${ready}.tmp`)},JSON.stringify({challenge:${JSON.stringify(challenge)},pid:process.pid}));fs.renameSync(${JSON.stringify(`${ready}.tmp`)},${JSON.stringify(ready)});`;
  const parentProgram = `const fs=require('node:fs'),cp=require('node:child_process');const child=cp.spawn(process.execPath,['--preserve-symlinks','--preserve-symlinks-main','-e',${JSON.stringify(childProgram)}],{stdio:['pipe','ignore','ignore'],windowsHide:true,env:process.env});child.on('error',error=>{process.stderr.write(String(error));process.exit(2)});const deadline=Date.now()+5000;const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})&&fs.existsSync(${JSON.stringify(heartbeat)})){const value=JSON.parse(fs.readFileSync(${JSON.stringify(ready)},'utf8'));const bytes=fs.statSync(${JSON.stringify(heartbeat)}).size;if(value.pid===child.pid&&value.challenge===${JSON.stringify(challenge)}&&bytes>0){clearInterval(timer);process.stdout.write(JSON.stringify({challenge:value.challenge,childPid:child.pid,heartbeatBytes:bytes}));process.exit(0)}}if(Date.now()>=deadline)process.exit(3)},5);`;
  const args = ['-e', parentProgram];
  assert.ok(parentProgram.length <= 8192, 'Bounded parent command fixture');
  run.send({ type: 'run-node', requestId: suffix, args, timeoutMs: 10000, maxOutputBytes: 4096 });
  await run.wait(() => run.event('native.check-result', event => event.requestId === suffix), `${suffix} exact command receipt`, 15000);
  const receipt = run.event('native.check-result', event => event.requestId === suffix), diagnostic = JSON.stringify(receipt);
  assert.equal(receipt.generation, run.generation); assert.deepEqual(receipt.arguments, args); assert.equal(receipt.status, 0, diagnostic); assert.equal(receipt.exitCode, 0, diagnostic);
  const result = JSON.parse(Buffer.from(receipt.outputBase64, 'base64').toString('utf8'));
  assert.equal(result.challenge, challenge); assert.ok(Number.isInteger(result.childPid) && result.childPid > 0 && result.heartbeatBytes > 0);
  assert.deepEqual(JSON.parse(readFileSync(ready, 'utf8')), { challenge, pid: result.childPid }); assert.ok(statSync(heartbeat).size >= result.heartbeatBytes);
  assert.equal(receipt.completion.completionBudgetMs, 250); assert.equal(receipt.completion.waitStatus, 0); assert.equal(receipt.completion.exitConfirmed, true); assert.equal(receipt.completion.censusStatus, 0);
  assert.ok(receipt.completion.initialUnexpectedPids.includes(result.childPid), 'Fixture must actually overlap parent exit and first native census; a scheduling miss is not branch coverage');
  const childObservation = receipt.completion.initialUnexpectedProcesses.processes.find(value => value.pid === result.childPid);
  assert.ok(childObservation, diagnostic); assert.equal(childObservation.openStatus, 0); assert.equal(childObservation.waitStatus, 258); assert.equal(childObservation.exitCode, 259); assert.equal(childObservation.membershipStatus, 0); assert.equal(childObservation.inJob, true);
  assert.equal(receipt.completion.outputDrainTimedOut, false); assert.ok([0, 109].includes(receipt.completion.outputReadStatus));
  if (persistent) {
    assert.equal(receipt.reason, 'descendants-survived', diagnostic); assert.equal(receipt.completion.settled, false); assert.equal(receipt.completion.completionTimedOut, true); assert.ok(receipt.completion.unexpectedPids.includes(result.childPid));
    await run.wait(() => run.exited, 'persistent child native failure cleanup');
    assert.ok(run.event('native.observation', value => value.status === 0 && value.activePids.length === 0)); assert.ok(run.event('native.resources', value => value.phase === 'revoke' && value.status === 0));
  } else {
    assert.equal(receipt.reason, 'exited', diagnostic); assert.equal(receipt.completion.settled, true); assert.equal(receipt.completion.completionTimedOut, false); assert.ok(receipt.completion.completionWaitMs <= 250); assert.deepEqual(receipt.completion.unexpectedPids, []);
    assert.equal(readFileSync(exited, 'utf8'), challenge); await run.stop();
  }
  assert.equal(new NativeRecoveryStore(run.recoveryStore.directory).observe(run.runRecord, run.profile)?.state, 'stopped');
  const size = statSync(heartbeat).size; await delay(150); assert.equal(statSync(heartbeat).size, size, 'Authenticated cleanup must also leave the descendant heartbeat quiescent');
  passed(persistent ? 'persistent-descendant-denied' : 'short-lived-descendant-settled', persistent
    ? 'Actual Node command exited zero after its same-Job child wrote a heartbeat; the child remained in first/final native census beyond the shared 250 ms completion window, so the command failed. Zero-Job/revoked-ACL authenticated cleanup and a quiescent heartbeat were independently checked.'
    : 'Actual Node command exited zero while its same-Job child was still live in first native census; the child exited after parent-pipe EOF and disappeared from final census within the shared 250 ms window. Normal output end, successful receipt and authenticated stop/cleanup were independently checked.');
}

try {
  record('start', evidence);
  const implemented = await runPiRole('implementation');
  writeFileSync(join(implemented.workspace, 'source.txt'), 'original'); writeFileSync(join(implemented.workspace, 'delete-me.txt'), 'delete fixture');
  const reviewed = await runPiRole('review', implemented.workspace);
  assert.notEqual(implemented.generation, reviewed.generation);
  passed('role-transition-clean', 'Same source tree transitioned from implementation to independent review after observed zero Job census and successful old-SID ACL revoke; the new generation read it but could not modify it. This does not claim exhaustive role-transition attack coverage.');
  assert.equal(connected, 0, 'Trusted listener must observe zero sandbox connections');
  for (const id of ['cross-demand-denied', 'shared-git-denied', 'host-control-denied', 'private-model-channel', 'node-pi-compatibility']) passed(id, 'Both real role runs passed exact Host-selected native command, private broker tool loop and native process receipt assertions.');
  passed('network-denied', 'Both role checks returned actual EACCES/EPERM against a live trusted loopback listener; Host observed zero connections. This does not claim every network/service escape is tested.');
  // A second helper-owned Node process must be present in the same Job; stopping
  // while it is writing must leave an actual zero census and quiescent file.
  const descendant = launch('implementation', 'descendant');
  await descendant.wait(() => descendant.event('native.started'), 'descendant fixture Worker');
  // A valid shell-shaped request must fail at the actual helper when this
  // generation has no shell descriptor. Do not infer denial from missing output.
  assert.equal(descendant.descriptor.shellExecutable, ''); assert.equal(descendant.descriptor.shellRootPath, ''); assert.equal(descendant.descriptor.shellSha256, ''); assert.deepEqual(descendant.descriptor.shellFiles, []);
  assert.deepEqual(descendant.descriptor.readonlyRuntimeRoots, [nodePath, bundledWorker]);
  const shellAbsentArgs = ['--noprofile', '--norc', '-c', 'exit 73'];
  descendant.send({ type: 'run-shell', requestId: 'node-only-no-shell', args: shellAbsentArgs, timeoutMs: 10000, maxOutputBytes: 4096 });
  await descendant.wait(() => descendant.event('native.check-result', event => event.requestId === 'node-only-no-shell'), 'native shell-unavailable denial');
  const shellAbsent = descendant.event('native.check-result', event => event.requestId === 'node-only-no-shell');
  assert.equal(shellAbsent.generation, descendant.generation); assert.deepEqual(shellAbsent.arguments, shellAbsentArgs); assert.equal(shellAbsent.status, 5, 'Actual Win32 ERROR_ACCESS_DENIED required'); assert.equal(shellAbsent.reason, 'launch-failed'); assert.equal(shellAbsent.pid, 0); assert.equal(shellAbsent.exitCode, null); assert.equal(shellAbsent.outputBase64, '');
  const heartbeat = join(descendant.scratch, 'heartbeat.txt');
  descendant.send({ type: 'run-node', requestId: 'heartbeat-check', args: ['-e', `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'tick\\n'),20)`], timeoutMs: 20000, maxOutputBytes: 4096 });
  await descendant.wait(() => existsSync(heartbeat) && statSync(heartbeat).size > 0, 'native-mediated heartbeat');
  descendant.send({ type: 'query' }); await descendant.wait(() => descendant.event('native.observation', event => event.status === 0 && event.activePids.length >= 2), 'actual same Job membership');
  await descendant.stop(); const heartbeatSize = statSync(heartbeat).size; await delay(150); assert.equal(statSync(heartbeat).size, heartbeatSize);
  passed('node-only-shell-unavailable', 'Real Pi contexts expose controlled Node/read tools without shell or built-ins; native Node commands read/search/assert own source with no PATH/ComSpec/SHELL. An actual helper run-shell request with empty shell artifacts returned ERROR_ACCESS_DENIED and pid 0; Node continued and zero-Job/revoked-ACL cleanup passed.');
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
  // Concurrent helpers share pinned executable files/ancestor ACLs. Stopping A
  // must remove only A's generated SID while B retains its exact allowed scope.
  const concurrentA = launch('implementation', 'concurrent-a');
  const concurrentB = launch('review', 'concurrent-b');
  await Promise.all([concurrentA.wait(() => concurrentA.event('native.started'), 'concurrent A launch'), concurrentB.wait(() => concurrentB.event('native.started'), 'concurrent B launch')]);
  const concurrentArgs = ['-e', `const fs=require('node:fs');let ticks=0;const timer=setInterval(()=>{try{if(!fs.readFileSync(${JSON.stringify(bundledWorker)}).length)process.exit(2);if(fs.readFileSync(${JSON.stringify(join(concurrentB.workspace, 'source.txt'))},'utf8')!=='original')process.exit(3);try{fs.readFileSync(${JSON.stringify(join(workerRoot, 'private-sibling.txt'))});process.exit(4)}catch(e){if(!['EACCES','EPERM'].includes(e.code))process.exit(5)}if(++ticks===50){clearInterval(timer);process.stdout.write(${JSON.stringify(challenge)})}}catch(e){process.stderr.write(String(e));process.exit(1)}},10)`];
  // Five bounded commands also exercise receipt-to-next-command handoff. A real
  // unexpected PID or output-drain deadline remains a failed native probe.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const requestId = `concurrent-check-${attempt}`;
    concurrentB.send({ type: 'run-node', requestId, args: concurrentArgs, timeoutMs: 10000, maxOutputBytes: 4096 });
    if (attempt === 1) await concurrentA.stop();
    await concurrentB.wait(() => concurrentB.event('native.check-result', event => event.requestId === requestId), 'unaffected concurrent helper check');
    const concurrentReceipt = concurrentB.event('native.check-result', event => event.requestId === requestId);
    const diagnostic = JSON.stringify({ attempt, status: concurrentReceipt.status, exitCode: concurrentReceipt.exitCode, reason: concurrentReceipt.reason, completion: concurrentReceipt.completion });
    assert.equal(concurrentReceipt.status, 0, diagnostic); assert.equal(concurrentReceipt.exitCode, 0, diagnostic); assert.equal(concurrentReceipt.reason, 'exited', diagnostic); assert.deepEqual(concurrentReceipt.arguments, concurrentArgs); assert.equal(Buffer.from(concurrentReceipt.outputBase64, 'base64').toString('utf8'), challenge);
    assert.equal(concurrentReceipt.completion?.waitStatus, 0, diagnostic); assert.equal(concurrentReceipt.completion?.exitConfirmed, true, diagnostic); assert.equal(concurrentReceipt.completion?.censusStatus, 0, diagnostic); assert.deepEqual(concurrentReceipt.completion?.unexpectedPids, [], diagnostic); assert.equal(concurrentReceipt.completion?.settled, true, diagnostic); assert.equal(concurrentReceipt.completion?.completionBudgetMs, 250, diagnostic); assert.ok(concurrentReceipt.completion?.completionWaitMs <= 250, diagnostic); assert.equal(concurrentReceipt.completion?.outputDrainTimedOut, false, diagnostic); assert.ok([0, 109].includes(concurrentReceipt.completion?.outputReadStatus), diagnostic);
  }
  concurrentB.send({ type: 'query' }); await concurrentB.wait(() => concurrentB.event('native.observation', event => event.status === 0 && event.activePids.includes(concurrentB.event('native.started').pid)), 'other helper remains alive');
  await concurrentB.stop();
  passed('concurrent-acl-isolation', 'Two overlapping helpers shared exact runtime files; A revoked and independently checked old-SID absence while B completed five bounded Node commands that repeatedly read allowed runtime/source and remained denied sibling data. Each receipt retained successful process-wait/Job-census/output-drain observations; B survived A stop and receipt-to-next-command handoffs.');
  await runCompletionDescendantFixture(false);
  await runCompletionDescendantFixture(true);
  // Break both Host output readers while a native-contained command produces
  // continuous output. Native Event/forwarding failure must finalize just like EOF.
  const broken = launch('implementation', 'broken-output', undefined, true);
  await broken.wait(() => broken.event('native.started'), 'broken-output fixture Worker');
  const brokenStarted = broken.event('native.started');
  broken.runRecord.identity = { pid: brokenStarted.pid, birth: brokenStarted.birth, generation: broken.generation, controlId: broken.runRecord.runId, driver: 'windows-appcontainer-job-v1' };
  broken.recoveryStore.bind(broken.runRecord.runId, broken.runRecord.identity);
  const brokenHeartbeat = join(broken.scratch, 'heartbeat.txt');
  broken.send({ type: 'run-node', requestId: 'broken-output-check', args: ['-e', `const fs=require('node:fs');setInterval(()=>{fs.appendFileSync(${JSON.stringify(brokenHeartbeat)},'tick\\n');process.stdout.write('continuous-output\\n')},10)`], timeoutMs: 20000, maxOutputBytes: 262144 });
  await broken.wait(() => existsSync(brokenHeartbeat) && statSync(brokenHeartbeat).size > 0, 'output-producing contained command');
  broken.helper.stdout.destroy(); broken.helper.stderr.destroy();
  broken.send({ type: 'query' }); // Forces a native write to the now-closed Host reader.
  await broken.wait(() => broken.exited, 'broken Host output cleanup', 18000);
  assert.equal(new NativeRecoveryStore(broken.recoveryStore.directory).observe(broken.runRecord, broken.profile)?.state, 'stopped');
  const brokenSize = statSync(brokenHeartbeat).size; await delay(150); assert.equal(statSync(brokenHeartbeat).size, brokenSize);
  passed('host-output-loss-recovery', 'Both Host output pipes closed during continuous contained Node output; independent reconstructed Host authenticated zero-Job/revoked-ACL receipt and observed quiescent writes.');
  // This is a sampled disk policy, not a kernel quota. Preserve the overflow
  // fixture and report actual observed bytes; between-sample overshoot is expected.
  const disk = launch('implementation', 'disk-overrun', undefined, true, 1024 * 1024);
  await disk.wait(() => disk.event('native.started'), 'disk policy fixture Worker');
  const diskStarted = disk.event('native.started');
  disk.runRecord.identity = { pid: diskStarted.pid, birth: diskStarted.birth, generation: disk.generation, controlId: disk.runRecord.runId, driver: 'windows-appcontainer-job-v1' };
  disk.recoveryStore.bind(disk.runRecord.runId, disk.runRecord.identity);
  const overflowFile = join(disk.scratch, 'overflow.bin');
  disk.send({ type: 'run-node', requestId: 'scratch-overrun', args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(overflowFile)},Buffer.alloc(2*1024*1024));setInterval(()=>{},1000)`], timeoutMs: 15000, maxOutputBytes: 4096 });
  await disk.wait(() => disk.exited, 'sampled disk overrun cleanup', 18000);
  const diskObservation = disk.event('native.disk-observation', event => event.status !== 0);
  assert.ok(diskObservation); assert.equal(diskObservation.hardQuota, false); assert.equal(diskObservation.diskLimitBytes, 1024 * 1024); assert.ok(diskObservation.bytes > diskObservation.diskLimitBytes);
  assert.equal(new NativeRecoveryStore(disk.recoveryStore.directory).observe(disk.runRecord, disk.profile)?.state, 'stopped');
  assert.equal(statSync(overflowFile).size, 2 * 1024 * 1024, 'Policy retains overflow files for diagnosis; no automatic deletion');
  passed('sampled-disk-bound', `Native ${diskObservation.pollMs} ms sampled source+scratch bound stopped the real Job and revoked ACLs. Limit ${diskObservation.diskLimitBytes}, sampled lower-bound bytes ${diskObservation.bytes}, retained file bytes ${statSync(overflowFile).size}; polling overshoot is explicitly not a hard quota.`);
  // Stop queued before the native launch acknowledgement reaches the Host must
  // still terminate that exact eventual Job; no PID needs to have entered the DB.
  const late = launch('implementation', 'late-launch-stop', undefined, true);
  late.send({ type: 'stop' }); late.helper.stdin.end();
  await late.wait(() => late.exited, 'late native launch stop');
  assert.ok(late.event('native.started'), 'Real late-created Worker identity must be observed in raw native transcript');
  assert.equal(late.runRecord.identity, null);
  assert.equal(new NativeRecoveryStore(late.recoveryStore.directory).observe(late.runRecord, late.profile)?.state, 'stopped');
  passed('late-launch-stop', 'A stop/EOF queued before Host identity registration terminated the eventual native generation, revoked ACLs and produced authenticated recovery proof.');
  // Reparse provisioning must fail before launch, with actual Win32 denial.
  const linkWorkspace = join(root, 'source-reparse'); mkdirSync(linkWorkspace); symlinkSync(join(root, 'other'), join(linkWorkspace, 'escape'), 'junction');
  const rejected = launch('review', 'reparse', linkWorkspace, true); await rejected.wait(() => rejected.event('native.resources', value => value.phase === 'provision'), 'reparse denial');
  assert.notEqual(rejected.event('native.resources').status, 0); assert.equal(rejected.event('native.started'), undefined); await rejected.wait(() => rejected.exited, 'never-created authenticated cleanup'); assert.equal(new NativeRecoveryStore(rejected.recoveryStore.directory).observe(rejected.runRecord, rejected.profile)?.state, 'stopped'); passed('reparse-denied', 'Native provisioner rejected a real junction before spawning any Worker. Race attacks are not claimed.');
  if (options.has('--git-bash')) {
    shellFixture = prepareShellFixture();
    record('shell-fixture', { executables: ['bash.exe', 'cat.exe', 'rm.exe'], fileCount: shellFixture.files.length, manifestSha256: shellFixture.manifest.sha256 });
    const bashPath = path => path.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, (_, drive) => `/${drive.toLowerCase()}`);
    const quote = text => `'${text.replace(/'/g, `'"'"'`)}'`;
    for (const role of ['implementation', 'review']) {
      const shell = launch(role, `bash-${role}`, undefined, true, 1024 * 1024 * 1024, true);
      await shell.wait(() => shell.event('native.started'), `Bash ${role} native Worker launch`, 40000);
      const own = quote(bashPath(join(shell.workspace, 'source.txt'))), removable = quote(bashPath(join(shell.workspace, 'delete-me.txt')));
      const denied = [join(root, 'other', 'private.txt'), join(root, 'host', 'control.txt'), join(shell.workspace, '.git', 'object'), join(shellFixture.rootPath, 'private-sibling.txt')];
      const denyTests = denied.map(path => `value=''; if { IFS= read -r value < ${quote(bashPath(path))} || [[ -n "$value" ]]; } 2>/dev/null; then exit 31; fi`).join('; ');
      const writeTest = role === 'implementation' ? `printf shell-changed > ${own}; /usr/bin/rm.exe ${removable}` : `if { printf forbidden > ${own}; } 2>/dev/null; then exit 32; fi; if /usr/bin/rm.exe ${removable} 2>/dev/null; then exit 33; fi`;
      const command = `set -eu; /usr/bin/cat.exe ${own} >/dev/null; ${denyTests}; ${writeTest}; printf %s ${quote(challenge)}`;
      const args = ['--noprofile', '--norc', '-c', command];
      shell.send({ type: 'run-shell', requestId: `bash-${role}`, args, timeoutMs: 15000, maxOutputBytes: 65536 });
      await shell.wait(() => shell.event('native.check-result', event => event.requestId === `bash-${role}`), `Bash ${role} receipt`, 20000);
      const receipt = shell.event('native.check-result', event => event.requestId === `bash-${role}`);
      const diagnostic = JSON.stringify({ status: receipt.status, reason: receipt.reason, exitCode: receipt.exitCode, output: Buffer.from(receipt.outputBase64, 'base64').toString('utf8').slice(0, 8192) });
      assert.equal(receipt.status, 0, diagnostic); assert.equal(receipt.reason, 'exited', diagnostic); assert.equal(receipt.exitCode, 0, diagnostic); assert.deepEqual(receipt.arguments, args); assert.equal(Buffer.from(receipt.outputBase64, 'base64').toString('utf8'), challenge);
      assert.equal(readFileSync(join(shell.workspace, 'source.txt'), 'utf8'), role === 'implementation' ? 'shell-changed' : 'original'); assert.equal(existsSync(join(shell.workspace, 'delete-me.txt')), role === 'review');
      // Bash /dev/tcp performs a real connection attempt with the same no-network
      // token. No HTTP/provider destination or network capability is introduced.
      const networkArgs = ['--noprofile', '--norc', '-c', `if exec 9<>/dev/tcp/127.0.0.1/${port}; then exit 34; fi`];
      shell.send({ type: 'run-shell', requestId: `bash-network-${role}`, args: networkArgs, timeoutMs: 5000, maxOutputBytes: 65536 });
      await shell.wait(() => shell.event('native.check-result', event => event.requestId === `bash-network-${role}`), 'Bash no-network receipt');
      const network = shell.event('native.check-result', event => event.requestId === `bash-network-${role}`); assert.equal(network.status, 0); assert.equal(network.reason, 'exited'); assert.equal(network.exitCode, 0); assert.match(Buffer.from(network.outputBase64, 'base64').toString('utf8'), /Permission denied|Operation not permitted/i); assert.equal(connected, 0);
      await shell.stop();
    }
    passed('git-bash-compatibility', `Actual locked Bash ${shellFixture.version}, ${shellFixture.files.length} exact copied executable/DLL dependencies, same-SID/Job subprocess receipt, external cat/rm commands, per-role read/write/delete rights, private/sibling denials, live-listener no-network and actual zero-Job/revocation stop. No installed-runtime ACLs changed.`);
  }
  evidence.status = 'passed'; save(); console.log(JSON.stringify({ nativeWorkerProbePassed: true, actualNodePi: true, paidModelCalls: 0, releaseAuthorized: false, report: join(outputDirectory, 'report.json') }));
} catch (error) {
  evidence.status = 'failed'; evidence.error = String(error?.stack ?? error); record('failure', { error: evidence.error }); save(); console.error(evidence.error); process.exitCode = 1;
} finally {
  listener.close();
  for (const helper of liveHelpers) { helper.stdin.end(); await delay(50); if (helper.exitCode === null) helper.kill(); }
  // Fixtures are retained intentionally for ACL/identity diagnosis. They contain
  // synthetic data only; abnormal helper death must never be called clean revoke.
}
