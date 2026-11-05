/**
 * The surface (PLAN step S1): one self-contained HTML file a native shell
 * loads, mounting only Plannotator's viewers (packages/inbox/surface). Built
 * beside the window into dist/ (build:hook copies it to
 * apps/hook/dist/surface.html), with the window's shared plugins and aliases.
 * It has no server to load a chunk from, so everything stays inline.
 */
import path from 'path';
import { defineConfig, mergeConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { sharedConfig } from './vite.config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    plugins: [viteSingleFile()],
    resolve: {
      alias: [{ find: /^@plannotator\/inbox\/(.+)$/, replacement: path.resolve(__dirname, '../../packages/inbox/$1') }],
    },
    build: {
      emptyOutDir: false,
      rollupOptions: {
        input: path.resolve(__dirname, 'surface.html'),
        output: {
          inlineDynamicImports: true,
        },
      },
    },
  }),
);
