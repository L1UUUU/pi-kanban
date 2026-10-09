import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('actual independent Node Host: private IPC requests persist, forged worker methods denied, explicit shutdown closes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-host-process-'));
  const child = fork(fileURLToPath(new URL('../src/host/main.ts', import.meta.url)), [], { execArgv: [], env: { PI_KANBAN_DATA_DIR: directory, SystemRoot: process.env.SystemRoot }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostics = ''; child.stderr?.on('data', data => { diagnostics += data.toString(); });
  const waitFor = (predicate: (message: any) => boolean): Promise<any> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Host timeout: ${diagnostics}`)); }, 5000);
    const listener = (message: any) => { if (predicate(message)) { cleanup(); resolve(message); } };
    const exited = () => { cleanup(); reject(new Error(`Host exited early: ${diagnostics}`)); };
    const cleanup = () => { clearTimeout(timer); child.off('message', listener); child.off('exit', exited); };
    child.on('message', listener); child.once('exit', exited);
  });
  let sequence = 0;
  const request = async (method: string, params: unknown = {}) => {
    const id = `request-${++sequence}`;
    const received = waitFor(message => message.id === id || (message.id === null && message.ok === false));
    child.send({ id, method, params }); return received;
  };
  try {
    await waitFor(message => message.event === 'ready');
    const state = await request('snapshot');
    assert.equal(state.ok, true); assert.equal(state.result.runtime.executionEnabled, false);
    const created = await request('createProject', { rootPath: directory });
    const project = created.result.projects[0];
    const demand = await request('createDemand', { requestId: 'create-once', projectId: project.id, title: 'Synthetic IPC idea', description: '' });
    assert.equal(demand.result.demands[0].phase, 'idea');
    const forged = await request('report', { type: 'authorize-implementation' });
    assert.equal(forged.ok, false); assert.equal(forged.error.code, 'UNKNOWN_METHOD');
    const stopped = await request('shutdown'); assert.deepEqual(stopped.result, { safe: true, blockers: [] });
    const exit = once(child, 'exit'); child.disconnect();
    assert.equal((await exit)[0], 0);
  } finally {
    if (child.connected) child.disconnect();
    if (child.exitCode === null && !child.killed) { child.kill(); await once(child, 'exit').catch(() => {}); }
    rmSync(directory, { recursive: true, force: true });
  }
});
