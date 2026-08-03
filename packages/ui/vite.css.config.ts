import path from 'path';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      '@plannotator/ui': path.resolve(__dirname, '.'),
      // Keep KaTeX (and its ~1.1MB of math fonts, which lib mode would inline
      // as data URIs) out of the published styles.css. Hosts that render math
      // load katex/dist/katex.min.css themselves — see build-stubs/ and HANDOFF.md.
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
