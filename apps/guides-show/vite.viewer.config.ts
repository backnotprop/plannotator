import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { GUIDE_SNAPSHOT_VERSION } from '../../packages/core/guide-format';
import { viewerManifestPlugin } from './build/manifest-plugin';
import { readOnlyStubsPlugin } from './build/read-only-stubs-plugin';

/**
 * The portable Guided Review viewer — a MULTI-FILE build (never single-file):
 *   - `viewer.<hash>.js` / `viewer.<hash>.css`: what an exported HTML pins,
 *   - one chunk per Shiki grammar/theme (Rollup splits Shiki's lazy loaders
 *     automatically once dynamic imports are not inlined — see the Phase 2
 *     spike in adr/implementation/portable-guided-reviews.md),
 *   - the highlight worker as its own file, fetched at runtime,
 *   - fonts as files.
 * `base: './'` keeps every reference relative, so the tree can be served from
 * any origin/prefix; the exported HTML pins the absolute entry URLs.
 */
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [readOnlyStubsPlugin(), react(), tailwindcss(), viewerManifestPlugin({ version: GUIDE_SNAPSHOT_VERSION })],
  server: { port: 3011 },
  resolve: {
    alias: {
      // Same as apps/review: drop the dead Oniguruma WASM. resolve.alias is
      // shared with the worker build; plugins would not be.
      'shiki/wasm': path.resolve(__dirname, '../../build/shiki-wasm-stub.ts'),
      // Read-only hosts never render the annotation composer, comment popover
      // or reviewer identity — stub them at build time so their dependency
      // tails (markdown/sanitizer, base-ui dialogs, the username wordlist)
      // stay out of the CDN entry. The app's own import graph is untouched.
      'katex/dist/katex.min.css': path.resolve(__dirname, 'viewer/stubs/empty.css'),
    },
  },
  worker: {
    format: 'es',
    rollupOptions: { output: { inlineDynamicImports: true, entryFileNames: 'worker.[hash].js' } },
  },
  build: {
    target: 'esnext',
    outDir: path.resolve(__dirname, 'dist/viewer'),
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2_000,
    rollupOptions: {
      input: { viewer: path.resolve(__dirname, 'viewer/main.tsx') },
      output: {
        inlineDynamicImports: false,
        entryFileNames: 'viewer.[hash].js',
        chunkFileNames: 'chunks/[name].[hash].js',
        assetFileNames: (info) => {
          const name = info.names?.[0] ?? info.name ?? 'asset';
          if (name.endsWith('.css')) return 'viewer.[hash].css';
          if (/\.(woff2?|ttf|otf)$/.test(name)) return 'fonts/[name].[hash][extname]';
          return 'assets/[name].[hash][extname]';
        },
      },
    },
  },
});
