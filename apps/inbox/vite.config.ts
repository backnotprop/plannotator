import path from 'path';
import { defineConfig, mergeConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import pkg from '../../package.json';
import { katexWoff2Only } from '../../build/katex-woff2-only';
import { packedInboxApp } from '../../build/pack-inbox';
import { diffsWorkerCatalogs } from '../../build/diffs-worker-catalogs';
import { inboxPageMarks } from '../../build/inbox-page-marks';

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
      'shiki/wasm': path.resolve(__dirname, '../../build/shiki-wasm-stub.ts'),
      '@pierre/highlights/themes/loader': path.resolve(__dirname, '../../build/pierre-highlights-stub.ts'),
      '@pierre/highlights': path.resolve(__dirname, '../../build/pierre-highlights-stub.ts'),
      '@plannotator/shared': path.resolve(__dirname, '../../packages/shared'),
      '@plannotator/ui': path.resolve(__dirname, '../../packages/ui'),
      '@plannotator/inbox': path.resolve(__dirname, '../../packages/inbox/index.ts'),
      '@plannotator/review-editor/worker-pool': path.resolve(__dirname, '../../packages/review-editor/workerPool.tsx'),
    },
  },
  worker: {
    format: 'es',
    plugins: () => [diffsWorkerCatalogs()],
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
    cssCodeSplit: false,
    modulePreload: false,
  },
});

export default mergeConfig(
  sharedConfig,
  defineConfig({
    esbuild: { charset: 'ascii' },
    plugins: [packedInboxApp(), inboxPageMarks()],
  }),
);
