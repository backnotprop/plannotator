/**
 * The standalone Shape page (shape.html): what `plannotator shape open`
 * serves to people without the Plannotator Inbox. Built beside the window into
 * dist/ (build:hook copies it to apps/hook/dist/shape.html), with the window's
 * plugins and aliases, like the surface.
 */
import path from 'path';
import { defineConfig, mergeConfig } from 'vite';
import windowConfig from './vite.config';

export default mergeConfig(
  windowConfig,
  defineConfig({
    resolve: {
      alias: [{ find: /^@plannotator\/inbox\/(.+)$/, replacement: path.resolve(__dirname, '../../packages/inbox/$1') }],
    },
    build: {
      emptyOutDir: false,
      rollupOptions: { input: path.resolve(__dirname, 'shape.html') },
    },
  }),
);
