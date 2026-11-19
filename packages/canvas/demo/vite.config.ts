/**
 * The canvas demo: a development page, never built into any product
 * artefact. `bun run --cwd packages/canvas demo` serves it; the benchmark
 * (`bench/run.ts`) builds it once and measures the built page.
 */
import fs from 'node:fs';
import path from 'path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Plugin, defineConfig } from 'vite';
import { createUnfurlHandler, isLoopbackHost } from '../unfurl/route';

const root = path.resolve(__dirname);
const repo = path.resolve(__dirname, '../../..');

/**
 * The repository's own faces, lent to HTML items in the demo as data: URLs. Both are under the SIL Open Font
 * License 1.1 (see the licence files beside them), which allows embedding. Read here, at build time, from the
 * files already in the repository: nothing is downloaded and no font is added to the package.
 */
const fontsDir = path.resolve(repo, 'apps/marketing/public/fonts');
const face = (family: string, file: string) => ({ family, src: `data:font/woff2;base64,${fs.readFileSync(path.join(fontsDir, file)).toString('base64')}`, weight: [100, 900] });
const HOUSE_FACES = [face('Geist', 'geist/Geist-Variable.woff2'), face('Paper Mono', 'paper-mono/PaperMono-Variable.woff2')];

/** Where the demo's editor asks for link previews. */
const UNFURL_PATH = '/__canvas/unfurl';

/**
 * The link preview route, mounted on the demo's own dev server and nowhere
 * else. `allowPrivate` is on, as it would be for a local single-user server:
 * the demo previews its own fixture page on loopback. Development only.
 *
 * This middleware runs before Vite's own check of the `Host` header, so it
 * makes that check itself: a request that does not name this machine
 * (a page elsewhere that pointed its own name at 127.0.0.1) is refused, and
 * so cannot read a preview of something on loopback. What is left: any page
 * open in the developer's browser can still make the browser SEND a request
 * here, which makes this server GET a loopback address; it cannot read the
 * answer.
 */
function unfurlRoute(): Plugin {
  const handle = createUnfurlHandler({ allowPrivate: true });
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith(UNFURL_PATH)) return next();
    if (!isLoopbackHost(req.headers.host)) {
      res.statusCode = 403;
      res.end();
      return;
    }
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
  define: { __HOUSE_FACES__: JSON.stringify(HOUSE_FACES) },
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
