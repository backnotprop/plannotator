/**
 * The thread canvas's whiteboard (Excalidraw, MIT) with nothing fetched from another site (docs/agent-guides/inbox-canvas.md).
 *
 * Excalidraw loads its fonts from `window.EXCALIDRAW_ASSET_PATH`, and always adds a fallback on esm.sh after it.
 * This plugin points that fallback at the Inbox itself (`/assets/excalidraw/`) and emits the fonts there, so the
 * window's packed app (build/pack-inbox.ts) answers them from memory: a canvas never makes a request off this
 * computer. Xiaolai (Chinese, Japanese and Korean handwriting, 12 MB of the 13 MB) is left out: text in those
 * scripts falls back to the system's fonts instead.
 *
 * The fallback's source is matched exactly; an Excalidraw upgrade that changes it fails the build here rather than
 * reaching esm.sh from a person's window.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

export const EXCALIDRAW_ASSET_BASE = '/assets/excalidraw/';
const FALLBACK = /ASSETS_FALLBACK_URL",\s*`https:\/\/esm\.sh\/[^\n]*?\/dist\/prod\/`/;
const LEFT_OUT = new Set(['Xiaolai']);

/** The Excalidraw source with its esm.sh fallback pointed at the Inbox; null when the source has none. */
export function localExcalidrawFallback(code: string): string | null {
  if (!code.includes('ASSETS_FALLBACK_URL')) return null;
  if (!FALLBACK.test(code)) throw new Error('excalidraw-assets: Excalidraw\'s font fallback changed; check that the canvas still loads nothing from another site');
  // Absolute: Excalidraw resolves each font against the fallback as a base URL.
  return code.replace(FALLBACK, () => `ASSETS_FALLBACK_URL", window.location.origin + ${JSON.stringify(EXCALIDRAW_ASSET_BASE)}`);
}

function fontsDir(fromDir: string): string {
  const require = createRequire(join(fromDir, 'package.json'));
  // The package exports no ./package.json: its main script is dist/prod/index.js, beside the fonts.
  return join(dirname(require.resolve('@excalidraw/excalidraw')), 'fonts');
}

export function excalidrawLocalAssets(uiDir: string): Plugin {
  return {
    name: 'plannotator:excalidraw-local-assets',
    transform(code, id) {
      if (!id.includes('@excalidraw/excalidraw') || !id.endsWith('.js')) return null;
      const next = localExcalidrawFallback(code);
      return next === null ? null : { code: next, map: null };
    },
    generateBundle() {
      const root = fontsDir(uiDir);
      for (const family of readdirSync(root)) {
        if (LEFT_OUT.has(family)) continue;
        for (const name of readdirSync(join(root, family))) {
          if (!name.endsWith('.woff2')) continue;
          this.emitFile({ type: 'asset', fileName: `assets/excalidraw/fonts/${family}/${name}`, source: readFileSync(join(root, family, name)) });
        }
      }
    },
  };
}
