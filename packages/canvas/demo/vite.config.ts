/**
 * The canvas demo: a development page, never built into any product
 * artefact. `bun run --cwd packages/canvas demo` serves it; the benchmark
 * (`bench/run.ts`) builds it once and measures the built page.
 */
import path from 'path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { lookup } from 'node:dns/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Plugin, defineConfig } from 'vite';
import { createUnfurlHandler } from '../unfurl/route';

const root = path.resolve(__dirname);
const repo = path.resolve(__dirname, '../../..');

/** Where the demo's editor asks for link previews. */
const UNFURL_PATH = '/__canvas/unfurl';

/**
 * The link preview route, mounted on the demo's own dev server and nowhere
 * else. `allowPrivate` is on here only so the demo can preview its own
 * fixture page on loopback; a product server would leave it off.
 */
function unfurlRoute(): Plugin {
  const handle = createUnfurlHandler({
    allowPrivate: true,
    lookup: async (hostname) => (await lookup(hostname, { all: true })).map((entry) => entry.address),
  });
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith(UNFURL_PATH)) return next();
    void handle(new Request(`http://demo.invalid${req.url}`, { method: req.method })).then(async (response) => {
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
    });
  };
  return {
    name: 'canvas-demo-unfurl',
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  };
}

export default defineConfig({
  root,
  server: { port: 3017, host: '127.0.0.1', strictPort: false },
  preview: { port: 3018, host: '127.0.0.1', strictPort: false },
  plugins: [unfurlRoute(), react(), tailwindcss()],
  publicDir: path.resolve(root, 'public'),
  resolve: {
    alias: {
      'shiki/wasm': path.resolve(repo, 'build/shiki-wasm-stub.ts'),
      '@pierre/highlights/themes/loader': path.resolve(repo, 'build/pierre-highlights-stub.ts'),
      '@pierre/highlights': path.resolve(repo, 'build/pierre-highlights-stub.ts'),
      '@pierre/patches': path.resolve(repo, 'build/pierre-patches-stub.ts'),
      '@plannotator/ui': path.resolve(repo, 'packages/ui'),
    },
  },
  build: { target: 'esnext', outDir: path.resolve(root, 'dist'), emptyOutDir: true },
});
