import path from 'path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import pkg from '../../package.json';
import { FAVICON_PNG_BYTES } from '../../packages/core/favicon';

function faviconPlugin(): Plugin {
  return {
    name: 'plannotator-favicon',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (pathname !== '/favicon.png') return next();

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(FAVICON_PNG_BYTES);
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'favicon.png',
        source: FAVICON_PNG_BYTES,
      });
    },
  };
}

export default defineConfig({
  server: {
    port: 3001,
    host: '0.0.0.0',
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [faviconPlugin(), react(), tailwindcss()],
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
