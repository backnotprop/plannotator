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
