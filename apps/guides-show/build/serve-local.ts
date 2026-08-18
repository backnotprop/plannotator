/// <reference types="bun-types" />
/**
 * Local stand-in for guides.show: serves dist/viewer under /v1/ with the same
 * headers the Worker sends (immutable cache, CORS for file:// documents).
 *   bun build/serve-local.ts [--port 8787]
 */
import path from 'node:path';
import { viewerAssetHeaders, viewerKeyFromPath } from '../worker/index';
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1] || 8787);
const root = path.resolve(import.meta.dirname, '../dist/viewer');
Bun.serve({
  port,
  async fetch(req) {
    const key = viewerKeyFromPath(new URL(req.url).pathname);
    if (!key) return new Response('guides.show local', { status: 404 });
    const file = Bun.file(path.join(root, key.slice('v1/'.length)));
    if (!(await file.exists())) return new Response('not found', { status: 404 });
    return new Response(file, { headers: viewerAssetHeaders(key) });
  },
});
console.log(`serving ${root} at http://localhost:${port}/v1/`);
