import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Excalidraw (a thread's canvas, packages/inbox/canvas), made to run from the
 * Inbox alone:
 *
 * - Its drawing fonts ship with the window. The package fetches them at run
 *   time from `window.EXCALIDRAW_ASSET_PATH`, and from the esm.sh CDN when
 *   that fails. The fonts are emitted under `/assets/excalidraw/fonts/` (the
 *   pack serves them, build/pack-inbox.ts), and the CDN address is replaced
 *   by the same local folder, so a canvas never asks another site for
 *   anything. Xiaolai (12 MB, Chinese and Japanese handwriting) is left out:
 *   those glyphs fall back to the system's font.
 * - Its font subsetter is stubbed. It is WebAssembly inlined as base64 (the
 *   window ships none, tests/entry-assets.test.ts) and only an SVG export
 *   uses it; Excalidraw catches its failure and embeds the whole font.
 */
const LOCAL = '/assets/excalidraw/';
const SUBSET_OFF = '\0excalidraw-subset-off';
const LEFT_OUT = new Set(['Xiaolai']);

export function excalidrawLocal(root: string): Plugin {
  // The package's `exports` name no folder, so its place is read from the inbox package's own node_modules.
  const distDir = () => join(realpathSync(join(root, 'packages/inbox/node_modules/@excalidraw/excalidraw')), 'dist', 'prod');
  return {
    name: 'plannotator-excalidraw-local',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer && /@excalidraw[\\/+]excalidraw/.test(importer) && /subset-(?:shared|worker)\.chunk\.js$/.test(source)) return SUBSET_OFF;
      return null;
    },
    load(id) {
      if (id !== SUBSET_OFF) return null;
      return [
        'const off = () => { throw new Error("font subsetting is off in this build"); };',
        'export const Commands = { Subset: "SUBSET" };',
        'export const subsetToBase64 = off;',
        'export const subsetToBinary = off;',
        'export const toBase64 = off;',
        'export const WorkerUrl = undefined;',
      ].join('\n');
    },
    transform(code, id) {
      // Its picture resizer (pica, also inside image-blob-reduce) carries a small WebAssembly module as base64 beside
      // the same maths in plain JavaScript. The window ships no inlined WebAssembly, so the module is taken out and
      // the resizer told not to ask for it; it resizes in JavaScript (and in its worker) as it does where
      // WebAssembly is missing.
      if (/[\\/](?:pica|image-blob-reduce)[\\/@]/.test(id) && code.includes('AGFzbQ')) {
        const next = code
          .replace(/(["'])AGFzbQ[A-Za-z0-9+/=]+\1/g, '""')
          // Whatever features a caller names (Excalidraw names "wasm" itself), the WebAssembly one is never found.
          .replace(/\.indexOf\((["'])wasm\1\)/g, '.indexOf("wasm-off")');
        if (next.includes('AGFzbQ') || !next.includes('.indexOf("wasm-off")')) throw new Error(`excalidraw-local: ${id} still asks for its WebAssembly (the package changed; update build/excalidraw-local.ts)`);
        return { code: next, map: null };
      }
      if (!/@excalidraw[\\/+]excalidraw/.test(id) || !code.includes('https://esm.sh/')) return null;
      const next = code.replace(/`https:\/\/esm\.sh\/\$\{[^`]*`[^`]*`[^`]*`/, `(location.origin+${JSON.stringify(LOCAL)})`);
      if (next === code || next.includes('esm.sh')) throw new Error('excalidraw-local: the CDN fallback was not replaced (the package changed; update build/excalidraw-local.ts)');
      return { code: next, map: null };
    },
    generateBundle() {
      const fonts = join(distDir(), 'fonts');
      for (const family of readdirSync(fonts)) {
        if (LEFT_OUT.has(family)) continue;
        for (const file of readdirSync(join(fonts, family))) {
          if (!file.endsWith('.woff2')) continue;
          this.emitFile({ type: 'asset', fileName: `assets/excalidraw/fonts/${family}/${file}`, source: readFileSync(join(fonts, family, file)) });
        }
      }
    },
  };
}
