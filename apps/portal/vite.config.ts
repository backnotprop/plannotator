import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import pkg from '../../package.json';

export default defineConfig({
  // Load .env from monorepo root
  envDir: path.resolve(__dirname, '../..'),
  server: {
    port: 3001,
    host: '0.0.0.0',
  },
  // Enable SPA fallback for client-side routing (e.g., /session/:id)
  appType: 'spa',
  preview: {
    port: 3001,
    host: '0.0.0.0',
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      '@plannotator/ui': path.resolve(__dirname, '../../packages/ui'),
      '@plannotator/editor/styles': path.resolve(__dirname, '../../packages/editor/index.css'),
      '@plannotator/editor': path.resolve(__dirname, '../../packages/editor/App.tsx'),
    }
  },
  build: {
    target: 'esnext',
  },
});
