/**
 * The standalone Shape page (shape.html): what `plannotator shape open`
 * serves to people without the Plannotator Inbox. Built beside the window into
 * dist/ (build:hook copies it to apps/hook/dist/shape.html), with the window's
 * shared plugins and aliases, like the surface. Its server (shape-open.ts)
 * serves the page alone, with no route to load a chunk from, so everything
 * stays inline.
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
        input: path.resolve(__dirname, 'shape.html'),
        output: {
          inlineDynamicImports: true,
        },
      },
    },
  }),
);
