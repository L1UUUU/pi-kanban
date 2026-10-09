import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, protocol, session, Tray } from 'electron';
import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { assetName, isTrustedSender, WORKBENCH_URL } from './security.ts';
import { assertFrame } from '../host/protocol.ts';
import { ConfigurationStore } from '../host/configuration.ts';

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let host: ChildProcess | null = null;
let quitting = false;
let exitRequested = false;
let notifiedAboutTray = false;
const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function request(method: string, params: unknown = {}): Promise<any> {
  if (!host?.connected) return Promise.reject(new Error('Host disconnected. Restart the app to inspect recovery state.'));
  const id = randomUUID(), frame = { id, method, params }; assertFrame(frame);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Host response timed out; state is unknown. Refresh before retrying.')); }, 30_000);
    pending.set(id, { resolve, reject, timer }); host!.send(frame);
  });
}

async function startHost(): Promise<void> {
  const executable = process.env.PI_KANBAN_NODE;
  if (!executable || !isAbsolute(executable) || !existsSync(executable)) throw new Error('PI_KANBAN_NODE must point to the separately installed Node.js 24 executable. Start with npm start.');
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  if (!/^v24\./.test(version)) throw new Error(`Expected Node.js 24, received ${version}.`);
  const environment: NodeJS.ProcessEnv = { PI_KANBAN_DATA_DIR: join(app.getPath('userData'), 'host'), NODE_NO_WARNINGS: '1' };
  if (process.env.PI_KANBAN_GIT && isAbsolute(process.env.PI_KANBAN_GIT)) environment.PI_KANBAN_GIT = process.env.PI_KANBAN_GIT;
  // Explicit OS loader/profile/temp paths required by the trusted native helper only. No API tokens, shell config, proxy, or HOME.
  for (const key of ['SystemRoot', 'SystemDrive', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG']) if (process.env[key]) environment[key] = process.env[key];
  if (process.env.PI_KANBAN_RUNTIME_TRUST_DIR && isAbsolute(process.env.PI_KANBAN_RUNTIME_TRUST_DIR)) environment.PI_KANBAN_RUNTIME_TRUST_DIR = process.env.PI_KANBAN_RUNTIME_TRUST_DIR;
  if (/^[a-f0-9]{64}$/.test(process.env.PI_KANBAN_RUNTIME_TRUST_SHA256 ?? '')) environment.PI_KANBAN_RUNTIME_TRUST_SHA256 = process.env.PI_KANBAN_RUNTIME_TRUST_SHA256;
  // A configured reference selects at most one credential for the trusted Host.
  // The native Worker environment never inherits it. Importing settings alone
  // does not grant a request; the Host ledger requires separate finite consent.
  try {
    const settings = new ConfigurationStore(join(app.getPath('userData'), 'host', 'configuration')).load();
    const reference = settings.provider?.credentialRef;
    if (reference?.startsWith('env:')) {
      const key = reference.slice(4);
      if (process.env[key]) environment[key] = process.env[key];
    }
  } catch { /* Host diagnostics will show invalid/missing config; no ambient key fallback. */ }
  host = fork(join(app.getAppPath(), 'dist/host/main.mjs'), [], { execPath: executable, execArgv: [], env: environment, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  host.stderr?.on('data', () => { /* Do not forward untrusted logs onto control IPC. */ });
  host.on('message', (value: any) => {
    if (!value || typeof value !== 'object') return;
    if (value.event === 'state') { window?.webContents.send('workbench:state', value.result); return; }
    const entry = pending.get(value.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(value.id);
    if (value.ok) entry.resolve(value.result);
    else entry.reject(new Error(`${value.error?.code ?? 'HOST_ERROR'}: ${value.error?.message ?? 'Operation failed'}`));
  });
  host.once('exit', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Host exited; operation outcome may be unknown.')); }
    pending.clear();
    if (!quitting) void dialog.showMessageBox({ type: 'error', message: '后台进程已停止', detail: '请重新启动应用核验现场。不会自动重启写入者或丢弃成果。' });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Host startup timed out.')), 10_000);
    host!.once('error', error => { clearTimeout(timer); reject(error); });
    const ready = (value: any) => { if (value?.event === 'ready') { clearTimeout(timer); host!.off('message', ready); resolve(); } };
    host!.on('message', ready);
  });
}

function registerControl(): void {
  for (const method of ['snapshot', 'createDemand', 'command', 'sendMessage', 'prepareModelApproval', 'authorizeModel', 'knowledgeAction', 'readArtifact']) ipcMain.handle(`workbench:${method}`, async (event, params = {}) => {
    if (!window || event.sender !== window.webContents || !isTrustedSender(event.senderFrame?.url ?? '', event.senderFrame === event.sender.mainFrame)) throw new Error('Untrusted control origin.');
    assertFrame(params);
    const state = await request(method, params);
    if (method !== 'readArtifact') window.webContents.send('workbench:state', state);
    return state;
  });
  ipcMain.handle('workbench:importConfiguration', async event => {
    if (!window || event.sender !== window.webContents || !isTrustedSender(event.senderFrame?.url ?? '', event.senderFrame === event.sender.mainFrame)) throw new Error('Untrusted control origin.');
    const selection = await dialog.showOpenDialog(window, { title: '导入运行配置（不会授予模型费用或启动执行）', properties: ['openFile'], filters: [{ name: 'JSON configuration', extensions: ['json'] }] });
    const state = selection.canceled ? await request('snapshot') : await request('importConfiguration', { filePath: selection.filePaths[0] });
    window.webContents.send('workbench:state', state); return state;
  });
  ipcMain.handle('workbench:createProject', async event => {
    if (!window || event.sender !== window.webContents || !isTrustedSender(event.senderFrame?.url ?? '', event.senderFrame === event.sender.mainFrame)) throw new Error('Untrusted control origin.');
    const selection = await dialog.showOpenDialog(window, { title: '选择项目目录（只接入，不会自动开工）', properties: ['openDirectory'] });
    if (selection.canceled) return request('snapshot');
    const observed = await request('inspectProject', { rootPath: selection.filePaths[0] });
    let projectInput: Record<string, unknown> = { rootPath: observed.rootPath };
    if (observed.formalTarget) {
      const decision = await dialog.showMessageBox(window, { type: 'question', title: '确认项目的固定起点', message: `正式目标：${observed.formalTarget}`, detail: `目录：${observed.rootPath}\n固定起点：${observed.baseline ?? '空仓库，尚无提交'}\n\n接入后只有明确开始规划，才会准备一条需求一个工作区。不会自动实施、推送或合入。`, buttons: ['确认此目标和起点', '仅记录项目', '取消'], defaultId: 0, cancelId: 2 });
      if (decision.response === 2) return request('snapshot');
      if (decision.response === 0) projectInput = { ...projectInput, formalTarget: observed.formalTarget, baseline: observed.baseline };
    } else {
      const decision = await dialog.showMessageBox(window, { type: 'info', message: '可先记录项目与想法', detail: `Git 准备条件未满足：${observed.blockers.join('\n')}\n不会创建工作区或自动开始实施。`, buttons: ['记录项目', '取消'], defaultId: 0, cancelId: 1 });
      if (decision.response === 1) return request('snapshot');
    }
    const state = await request('createProject', projectInput);
    window.webContents.send('workbench:state', state); return state;
  });
}

async function orderlyExit(): Promise<void> {
  if (exitRequested || quitting) return;
  exitRequested = true;
  try {
    const status = await request('shutdown');
    if (!status.safe) {
      window?.show();
      await dialog.showMessageBox({ type: 'warning', message: '停止尚未核验完成', detail: `保留应用以核验执行状态：\n${status.blockers.join('\n')}` });
      return;
    }
    quitting = true; host?.disconnect(); tray?.destroy(); app.quit();
  } catch (error) {
    window?.show(); await dialog.showMessageBox({ type: 'error', message: '无法确认安全退出', detail: String(error) });
  } finally { exitRequested = false; }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void orderlyExit(); } });
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    protocol.handle('app', request => {
      const name = assetName(request.url);
      return name ? net.fetch(pathToFileURL(join(app.getAppPath(), 'dist/renderer', name)).href) : new Response('Not found', { status: 404 });
    });
    await startHost(); registerControl();
    window = new BrowserWindow({ width: 1440, height: 940, minWidth: 1024, minHeight: 680, backgroundColor: '#11151c', title: 'pi-kanban', webPreferences: { preload: join(app.getAppPath(), 'dist/desktop/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.on('close', event => {
      if (quitting) return;
      event.preventDefault(); window?.hide();
      if (!notifiedAboutTray) { notifiedAboutTray = true; void dialog.showMessageBox({ message: '窗口已收起到托盘', detail: '已授权工作会继续。选择托盘中的“退出并停止”才会收束执行。当前未满足条件的工作不会自动启动。' }); }
    });
    const pixels = Buffer.alloc(16 * 16 * 4);
    for (let y = 3; y < 13; y++) for (let x = 3; x < 13; x++) { const offset = (y * 16 + x) * 4; pixels.set([99, 220, 192, 255], offset); }
    tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }));
    tray.setToolTip('pi-kanban');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开工作区', click: () => window?.show() }, { type: 'separator' }, { label: '退出并停止', click: () => void orderlyExit() }]));
    tray.on('click', () => window?.show());
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'pi-kanban', submenu: [{ label: '退出并停止', click: () => void orderlyExit() }] }, { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }]));
    await window.loadURL(WORKBENCH_URL);
  }).catch(error => { quitting = true; dialog.showErrorBox('无法启动 pi-kanban', String(error)); host?.disconnect(); app.quit(); });
}
