/** Standalone: bun tests/e2e/html-viewer-resource-policy-harness.ts */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '../..');
const directory = mkdtempSync(join(tmpdir(), 'html-resource-policy-'));
// React is a UI workspace dependency, not a root dependency (Bun's isolated linker).
const tsconfig = join(directory, 'tsconfig.json');
writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { jsx: 'react-jsx', paths: {
  react: [join(repo, 'packages/ui/node_modules/react')],
  'react/*': [join(repo, 'packages/ui/node_modules/react/*')],
  'react-dom/*': [join(repo, 'packages/ui/node_modules/react-dom/*')],
} } }));
const build = spawnSync(process.execPath, ['build', '--target=browser', '--tsconfig-override', tsconfig, './tests/e2e/html-viewer-resource-policy-entry.tsx', '--outdir', directory], { cwd: repo, encoding: 'utf8' });
if (build.status !== 0) throw new Error(`Harness bundle failed: ${build.stderr}`);
const css = spawnSync(process.execPath, ['run', '--cwd', 'packages/ui', 'build:css'], { cwd: repo, encoding: 'utf8' });
if (css.status !== 0) throw new Error(`Viewer CSS build failed: ${css.stderr}`);
const bundle = readFileSync(join(directory, 'html-viewer-resource-policy-entry.js'));
const stylesheet = readFileSync(join(repo, 'packages/ui/styles.css'));
const counts: Record<string, number> = {};
const counter = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(request, server) {
    const path = new URL(request.url).pathname;
    counts[path] = (counts[path] ?? 0) + 1;
    if (path.endsWith('/websocket') && server.upgrade(request)) return;
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    if (path.endsWith('/script') || path.endsWith('/worker')) return new Response('/* resource probe */', { headers: { ...headers, 'Content-Type': 'text/javascript' } });
    if (path.endsWith('/stylesheet') || path.endsWith('/import')) return new Response('body { --resource-probe: 1; }', { headers: { ...headers, 'Content-Type': 'text/css' } });
    if (path.endsWith('/image') || path.endsWith('/css-image')) return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', { headers: { ...headers, 'Content-Type': 'image/svg+xml' } });
    if (path.endsWith('/font')) return new Response(readFileSync(join(repo, 'packages/ui/node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2')), { headers: { ...headers, 'Content-Type': 'font/woff2' } });
    if (path.endsWith('/frame')) return new Response('<!doctype html><title>Nested frame</title>', { headers: { ...headers, 'Content-Type': 'text/html' } });
    return new Response('{}', { headers: { ...headers, 'Content-Type': 'application/json' } });
  },
  websocket: { open(socket) { socket.close(); }, message() {} },
});
const app = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/counts') return Response.json(counts);
    if (url.pathname === '/entry.js') return new Response(bundle, { headers: { 'Content-Type': 'text/javascript' } });
    if (url.pathname === '/styles.css') return new Response(stylesheet, { headers: { 'Content-Type': 'text/css' } });
    if (!url.searchParams.has('counter')) {
      url.searchParams.set('counter', counter.url.origin);
      return Response.redirect(url);
    }
    return new Response(`<!doctype html><html class="theme-plannotator light"><head><title>HTML policy harness</title><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>`, {
      headers: { 'Content-Type': 'text/html', ...(url.searchParams.has('inherited') ? { 'Content-Security-Policy': "script-src 'self'" } : {}) },
    });
  },
});
console.log(`HTML_POLICY_URL=${app.url}`);
console.log(`Counter: ${counter.url}`);
function stop() { app.stop(true); counter.stop(true); rmSync(directory, { recursive: true, force: true }); process.exit(0); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
