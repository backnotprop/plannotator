import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import pkg from '../../package.json';

export default defineConfig({
  server: {
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
      '@plannotator/plan-review/styles': path.resolve(__dirname, '../../packages/plannotator-plan-review/index.css'),
      '@plannotator/plan-review': path.resolve(__dirname, '../../packages/plannotator-plan-review/App.tsx'),
    }
  },
  build: {
    target: 'esnext',
  },
});
