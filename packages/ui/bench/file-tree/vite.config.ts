// Builds the file tree bench page. Not part of the package. run.ts calls it:
//   PIERRE_TREES_DIR=<an installed @pierre/trees folder> bunx vite build --config bench/file-tree/vite.config.ts
import path from 'path';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const pierre = process.env.PIERRE_TREES_DIR;

export default defineConfig({
  root: __dirname,
  plugins: [tailwindcss()],
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@plannotator/ui': path.resolve(__dirname, '../..'),
      '@pierre/trees': pierre ? path.resolve(pierre, 'dist/index.js') : path.resolve(__dirname, 'pierre-stub.ts'),
    },
  },
  build: {
    target: 'esnext',
    outDir: process.env.BENCH_OUT ?? path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    minify: true,
  },
});
