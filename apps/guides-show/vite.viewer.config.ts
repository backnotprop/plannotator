import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { GUIDE_SNAPSHOT_VERSION } from '../../packages/core/guide-format';
import { viewerManifestPlugin } from './build/manifest-plugin';
import { readOnlyStubsPlugin } from './build/read-only-stubs-plugin';
import { diffsWorkerCatalogs } from '../../build/diffs-worker-catalogs';

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [readOnlyStubsPlugin(), react(), tailwindcss(), viewerManifestPlugin({ version: GUIDE_SNAPSHOT_VERSION })],
  server: { port: 3011 },
  resolve: {
    alias: {
      'shiki/wasm': path.resolve(__dirname, '../../build/shiki-wasm-stub.ts'),
      '@pierre/highlights/themes/loader': path.resolve(__dirname, '../../build/pierre-highlights-stub.ts'),
      '@pierre/highlights': path.resolve(__dirname, '../../build/pierre-highlights-stub.ts'),
      'katex/dist/katex.min.css': path.resolve(__dirname, 'viewer/stubs/empty.css'),
    },
  },
  worker: {
    format: 'es',
    plugins: () => [diffsWorkerCatalogs()],
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
