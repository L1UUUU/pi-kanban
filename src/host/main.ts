import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { HostApplication } from './application.ts';
import { parseRequest } from './protocol.ts';

if (!process.send || !process.connected) throw new Error('Host requires the private desktop IPC channel. No TCP control port is supported.');
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Host requires a separately installed Node.js 24 runtime.');
const directory = process.env.PI_KANBAN_DATA_DIR;
if (!directory) throw new Error('Host data directory was not provided by the desktop launcher.');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const application = new HostApplication(resolve(directory, 'workbench.sqlite'));
await application.coordinator.recover();
let fingerprint = '';
const timer = setInterval(() => { void (async () => {
  await application.tick();
  const current = JSON.stringify([application.store.listDemands().map(d => [d.id,d.revision]), application.store.listRuns()]);
  if (current !== fingerprint) { fingerprint = current; process.send?.({ event: 'state', result: application.snapshot() }); }
})().catch(() => { /* Preserve unresolved state; never spin new workers after errors. */ }); }, 500);
timer.unref();
process.on('message', async (raw: unknown) => {
  let requestId: string | null = null;
  try {
    const request = parseRequest(raw); requestId = request.id;
    const result = request.method === 'shutdown' ? await application.requestShutdown() : request.method === 'knowledgeAction' ? await application.knowledgeAction(request.params) : request.method === 'inspectProject' ? application.inspectProject(request.params) : application.handle(request.method, request.params);
    process.send?.({ id: request.id, ok: true, result });
    if (request.method !== 'snapshot') void application.tick().catch(() => { /* Durable unknown states remain visible. */ });
  } catch (error) {
    // Error details never include raw frame data, credentials, or arbitrary logs.
    process.send?.({ id: requestId, ok: false, error: { code: (error as { code?: string }).code ?? 'HOST_ERROR', message: error instanceof Error ? error.message : 'Host operation failed.' } });
  }
});
process.on('disconnect', async () => {
  clearInterval(timer);
  await application.requestShutdown();
  application.close();
  process.exitCode = 0;
});
process.send({ event: 'ready' });
