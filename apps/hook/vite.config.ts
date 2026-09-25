import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import pkg from '../../package.json';
import { packedApp } from '../../build/pack-app';
import { devMockApi } from './dev-mock-api';

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react(), tailwindcss(), devMockApi(), packedApp()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      // Drop the dead Oniguruma WASM (~622 KB base64). The plan editor reaches
      // Pierre's shared highlighter through CodeFilePopout and the fence
      // highlighter. See build/shiki-wasm-stub.ts.
      'shiki/wasm': path.resolve(__dirname, '../../build/shiki-wasm-stub.ts'),
      '@': path.resolve(__dirname, '.'),
      '@plannotator/shared': path.resolve(__dirname, '../../packages/shared'),
      '@plannotator/ui': path.resolve(__dirname, '../../packages/ui'),
      '@plannotator/editor/styles': path.resolve(__dirname, '../../packages/editor/index.css'),
      '@plannotator/editor': path.resolve(__dirname, '../../packages/editor/App.tsx'),
    }
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 100000000,
    cssCodeSplit: false,
  },
});
