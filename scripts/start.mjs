import { spawn } from 'node:child_process';
import electron from 'electron';
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Start the workbench using Node.js 24.');
const child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, PI_KANBAN_NODE: process.execPath } });
child.on('exit', code => { process.exitCode = code ?? 1; });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
