import path from 'path';
import { defineConfig, mergeConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import pkg from '../../package.json';
import { katexWoff2Only } from '../../build/katex-woff2-only';
import { packedInboxApp } from '../../build/pack-inbox';
import { diffsWorkerCatalogs } from '../../build/diffs-worker-catalogs';
import { inboxPageMarks } from '../../build/inbox-page-marks';

/**
 * What the window, the phone's surface (vite.surface.config.ts) and the Shape
 * page (vite.shape.config.ts) build with alike. Each adds how its page is put
 * together: the window packs its code split scripts behind the page (below),
 * the surface and the Shape page inline everything.
 */
export const sharedConfig = defineConfig({
  server: {
    port: 3003,
    host: '127.0.0.1',
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react(), tailwindcss(), katexWoff2Only()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      // Drop the dead Oniguruma WASM (~622 KB base64). The message body's code
      // fences reach Pierre's shared highlighter. See build/shiki-wasm-stub.ts.
      'shiki/wasm': path.resolve(__dirname, '../../build/shiki-wasm-stub.ts'),
      // Highlights, Pierre's second highlighter (WASM), never runs: Plannotator
      // highlights with Shiki. See build/pierre-highlights-stub.ts.
      '@pierre/highlights/themes/loader': path.resolve(__dirname, '../../build/pierre-highlights-stub.ts'),
      '@pierre/highlights': path.resolve(__dirname, '../../build/pierre-highlights-stub.ts'),
      '@plannotator/shared': path.resolve(__dirname, '../../packages/shared'),
      '@plannotator/ui': path.resolve(__dirname, '../../packages/ui'),
      '@plannotator/inbox': path.resolve(__dirname, '../../packages/inbox/index.ts'),
      '@plannotator/review-editor/worker-pool': path.resolve(__dirname, '../../packages/review-editor/workerPool.tsx'),
    },
  },
  // The guided review's diff renderer (review-editor's AllFilesCodeView)
  // imports Pierre's highlight worker (?worker&inline), whose dynamic
  // import("shiki/wasm") edge iife cannot split: emit it as ES with dynamic
  // imports collapsed, as apps/review does.
  worker: {
    format: 'es',
    // Pierre's language and theme catalogs, dead code in its worker (see the plugin).
    plugins: () => [diffsWorkerCatalogs()],
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  build: {
    target: 'esnext',
    // Fonts and pictures stay data URLs in the stylesheet and scripts.
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
    cssCodeSplit: false,
    // No <link rel="modulepreload"> for a lazy chunk's files. WebKit (Safari,
    // every iPad browser) remembers a preload whose download broke off (a
    // flaky link) for the tab: every later import of that file fails at once
    // with no request, a reload of the tab included, and only a new tab
    // recovers. Without the preload, the import itself fetches, and the
    // diagram block's re-attempt or a reload gets the file. The cost is a
    // lazy chunk's own imports starting after it arrives instead of with it.
    modulePreload: false,
  },
});

/**
 * The window (#2593). Its scripts split at every dynamic import and are packed
 * behind the page (build/pack-inbox.ts), which the Inbox server answers from
 * memory, so the guided and code review, the diagram runtimes and the Shiki
 * grammars load on first use. The page keeps its stylesheet inline.
 *
 * `charset: 'ascii'` writes every non-ASCII character in the scripts as an
 * escape (`→`, never `→`). The meaning is the same, but V8 can then keep
 * each script's source at one byte per character; a single non-ASCII
 * character makes it two bytes for the whole script.
 */
export default mergeConfig(
  sharedConfig,
  defineConfig({
    esbuild: { charset: 'ascii' },
    // The window's sheet keys on page marks, not on :has() anchored on the page (build/inbox-page-marks.ts).
    plugins: [packedInboxApp(), inboxPageMarks()],
  }),
);
