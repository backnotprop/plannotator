import path from 'path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import tailwindcss from '@tailwindcss/vite';
import pkg from '../../package.json';
import { DEMO_FILE_CONTENTS } from '../../packages/review-editor/demoData';

function demoFileContentPlugin(): Plugin {
  return {
    name: 'demo-file-content',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/file-content')) return next();
        const filePath = new URL(req.url, 'http://localhost').searchParams.get('path');
        const entry = filePath ? DEMO_FILE_CONTENTS[filePath] : undefined;
        if (!entry) return next();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ oldContent: entry.oldContent, newContent: entry.newContent }));
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
  plugins: [demoFileContentPlugin(), react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      '@plannotator/shared': path.resolve(__dirname, '../../packages/shared'),
      '@plannotator/ui': path.resolve(__dirname, '../../packages/ui'),
      '@plannotator/review-editor/styles': path.resolve(__dirname, '../../packages/review-editor/index.css'),
      '@plannotator/review-editor': path.resolve(__dirname, '../../packages/review-editor/App.tsx'),
    }
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
