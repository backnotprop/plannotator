/**
 * Design prototype (throwaway): the Inbox in a Messages-style layout, built
 * with Halftone's component system. Its own entry and its own stylesheet, so
 * nothing of the real Inbox window changes. Halftone is read from its checkout
 * (HALFTONE_DIR, default the owner's), through Halftone's own aliases.json.
 *
 *   apps/inbox/node_modules/.bin/vite build -c apps/inbox/proto-imessage/vite.config.ts
 *   bun scripts/proto-imessage-serve.ts --inbox http://localhost:<port>
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const halftone = process.env.HALFTONE_DIR ?? '/Users/ramos/plannotator/halftone';
const aliases = JSON.parse(readFileSync(path.join(halftone, 'aliases.json'), 'utf8')) as Record<string, string>;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss(), viteSingleFile()],
  define: { 'import.meta.env.DESIGN_AUDIENCE': JSON.stringify('public') },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      ...Object.entries(aliases)
        .sort(([a], [b]) => b.length - a.length)
        .map(([find, to]) => ({
          find: find.endsWith('/') ? new RegExp(`^${escape(find)}`) : new RegExp(`^${escape(find)}$`),
          replacement: path.join(halftone, to) + (find.endsWith('/') ? '/' : ''),
        })),
      // Halftone's runtime packages, for the provider file that lives here, outside its tree.
      { find: /^gt-react$/, replacement: path.join(halftone, 'node_modules/gt-react') },
      { find: /^halftone-styles\//, replacement: path.join(halftone, 'packages/private/design-system/styles') + '/' },
      { find: /^@proto\//, replacement: path.join(__dirname, 'src') + '/' },
      { find: /^@plannotator\/core\//, replacement: path.resolve(__dirname, '../../../packages/core') + '/' },
      { find: /^@inbox\//, replacement: path.resolve(__dirname, '../../../packages/inbox') + '/' },
    ],
  },
  server: { port: 5199, host: '127.0.0.1' },
  build: {
    outDir: path.join(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'esnext',
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
    cssCodeSplit: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
