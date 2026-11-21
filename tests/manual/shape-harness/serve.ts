// Serves the Shape dev harness: `bun tests/manual/shape-harness/serve.ts [port]`.
// Vite and the Tailwind plugin come from packages/ui's own install; the
// harness is no workspace, so no shipped bundle includes it.
import os from 'node:os';
import path from 'node:path';

const HERE = import.meta.dir;
const REPO = path.resolve(HERE, '../../..');
const UI = path.join(REPO, 'packages/ui');
const { createServer } = await import(path.join(UI, 'node_modules/vite/dist/node/index.js'));
const tailwindcss = (await import(path.join(UI, 'node_modules/@tailwindcss/vite/dist/index.mjs'))).default;

const port = Number(process.argv[2] ?? 5293);
const mod = (pkg: string, sub = '') => path.join(UI, 'node_modules', pkg, sub);

const server = await createServer({
  configFile: false,
  root: HERE,
  cacheDir: path.join(os.tmpdir(), 'plannotator-shape-harness-vite'),
  publicDir: path.join(HERE, 'public'),
  define: { __APP_VERSION__: JSON.stringify('shape-harness') },
  esbuild: { jsx: 'automatic' },
  plugins: [tailwindcss()],
  server: { port, strictPort: true, host: '127.0.0.1', fs: { allow: [REPO] } },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^react$/, replacement: mod('react') },
      { find: /^react\/(.*)$/, replacement: mod('react', '$1') },
      { find: /^react-dom$/, replacement: mod('react-dom') },
      { find: /^react-dom\/(.*)$/, replacement: mod('react-dom', '$1') },
      { find: 'shiki/wasm', replacement: path.join(REPO, 'build/shiki-wasm-stub.ts') },
      { find: '@plannotator/ui', replacement: UI },
      { find: '@plannotator/core', replacement: path.join(REPO, 'packages/core') },
      { find: '@plannotator/shared', replacement: path.join(REPO, 'packages/shared') },
      { find: '@plannotator/guide-viewer', replacement: path.join(REPO, 'packages/guide-viewer') },
      { find: '@review-editor', replacement: path.join(REPO, 'packages/review-editor') },
    ],
  },
  worker: { format: 'es' },
  logLevel: 'info',
});
await server.listen();
server.printUrls();
