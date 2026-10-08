import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The Plannotator Snapshots HUD: one inlined HTML file the Snapshots hub serves at /hud.
export default defineConfig({
  server: { port: 3007, host: '127.0.0.1' },
  plugins: [react(), viteSingleFile()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@plannotator/shared': path.resolve(__dirname, '../../packages/shared'),
      '@plannotator/ui': path.resolve(__dirname, '../../packages/ui'),
      '@plannotator/snapshots-hud': path.resolve(__dirname, '../../packages/snapshots-hud'),
    },
  },
  build: {
    target: 'safari16',
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
    cssCodeSplit: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
