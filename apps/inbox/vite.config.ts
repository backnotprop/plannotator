import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import tailwindcss from '@tailwindcss/vite';
import pkg from '../../package.json';
import { katexWoff2Only } from '../../build/katex-woff2-only';

export default defineConfig({
  server: {
    port: 3003,
    host: '127.0.0.1',
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react(), tailwindcss(), katexWoff2Only(), viteSingleFile()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      // Drop the dead Oniguruma WASM (~622 KB base64). The message body's code
      // fences reach Pierre's shared highlighter. See build/shiki-wasm-stub.ts.
      'shiki/wasm': path.resolve(__dirname, '../../build/shiki-wasm-stub.ts'),
      '@plannotator/shared': path.resolve(__dirname, '../../packages/shared'),
      '@plannotator/ui': path.resolve(__dirname, '../../packages/ui'),
      '@plannotator/inbox': path.resolve(__dirname, '../../packages/inbox/index.ts'),
    },
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
