import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
const shared = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2023' };
await rm('dist', { recursive: true, force: true });
await mkdir('dist/renderer', { recursive: true });
await build({ ...shared, entryPoints: ['src/host/main.ts'], outfile: 'dist/host/main.mjs', platform: 'node', format: 'esm', packages: 'external' });
// The isolated Worker must not need access to sibling Host files/node_modules.
await build({ ...shared, entryPoints: ['src/agent/worker-main.ts'], outfile: 'dist/worker/main.mjs', platform: 'node', format: 'esm', banner: { js: "import { createRequire as __piCreateRequire } from 'node:module'; const require = __piCreateRequire(import.meta.url);" } });
await build({ ...shared, entryPoints: ['src/desktop/main.ts'], outfile: 'dist/desktop/main.cjs', platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...shared, entryPoints: ['src/desktop/preload.ts'], outfile: 'dist/desktop/preload.cjs', platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...shared, entryPoints: ['src/desktop/renderer/main.tsx'], outfile: 'dist/renderer/app.js', platform: 'browser', format: 'esm', minify: true });
await cp('src/desktop/renderer/index.html', 'dist/renderer/index.html');
// Preview fixtures are deliberately not included in the production build.
