import esbuild from 'esbuild';
import process from 'process';
import fs from 'fs';
import path from 'path';

const prod = process.argv[2] === 'production';

// Banner for the output file
const banner = `/*
 * Plannotator for Obsidian
 * https://github.com/backnotprop/plannotator
 */`;

// Build context for watch mode
const context = await esbuild.context({
  banner: {
    js: banner,
  },
  entryPoints: ['main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
  ],
  format: 'cjs',
  target: 'es2022',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: prod,
  // Handle JSX
  jsx: 'automatic',
  // Define globals
  define: {
    'process.env.NODE_ENV': prod ? '"production"' : '"development"',
    __APP_VERSION__: '"0.0.1"',
  },
  // Resolve workspace packages
  alias: {
    '@plannotator/editor': '../../packages/editor',
    '@plannotator/ui': '../../packages/ui',
  },
  // Handle CSS - inline it
  loader: {
    '.css': 'text',
  },
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
