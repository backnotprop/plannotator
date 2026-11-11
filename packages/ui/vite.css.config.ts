import path from 'path';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      '@plannotator/ui': path.resolve(__dirname, '.'),
      'katex/dist/katex.min.css': path.resolve(__dirname, 'build-stubs/katex-css-stub.css'),
    },
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'styles-entry.css'),
      formats: ['es'],
      fileName: () => 'styles.js',
    },
    outDir: '.',
    cssCodeSplit: true,
    rollupOptions: { output: { assetFileNames: 'styles.css' } },
    emptyOutDir: false,
  },
});
