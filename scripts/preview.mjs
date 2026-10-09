import { build } from 'esbuild';
import { createServer } from 'node:http';
import { cp, mkdir, readFile } from 'node:fs/promises';
await mkdir('artifacts/preview', { recursive: true });
await build({ entryPoints: ['src/desktop/renderer/preview.tsx'], outfile: 'artifacts/preview/app.js', bundle: true, platform: 'browser', format: 'esm', target: 'es2023' });
await cp('src/desktop/renderer/index.html', 'artifacts/preview/index.html');
const files = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/app.css', ['app.css', 'text/css']]]);
createServer(async (request, response) => {
  const entry = files.get(new URL(request.url, 'http://127.0.0.1:4173').pathname);
  if (!entry) { response.writeHead(404).end(); return; }
  try { response.writeHead(200, { 'Content-Type': entry[1], 'X-Content-Type-Options': 'nosniff' }); response.end(await readFile(`artifacts/preview/${entry[0]}`)); }
  catch { response.writeHead(500).end('Preview asset unavailable'); }
}).listen(4173, '127.0.0.1', () => console.log('Synthetic UI preview only: http://127.0.0.1:4173'));
