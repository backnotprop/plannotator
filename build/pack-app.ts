import { extname } from 'node:path';
import type { Plugin } from 'vite';
import { packApp, type PackedAsset } from '../packages/shared/packed-app';

/**
 * Every file type the app builds emit. A new one fails the build loudly rather
 * than being served with a guessed type.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/**
 * Emit the app as one `index.html` that carries its code-split chunks and
 * assets behind a marker, where vite-plugin-singlefile inlined all of them into
 * the page. The servers serve both halves; see packages/shared/packed-app.ts.
 */
export function packedApp(): Plugin {
  return {
    name: 'plannotator-packed-app',
    enforce: 'post',
    // Last in the hook, not merely a post plugin: Vite's own post build
    // plugins still rewrite the chunks here (vite:build-import-analysis fills
    // in the __VITE_PRELOAD__ dependency lists), so packing any earlier ships
    // chunks that throw on their first dynamic import.
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const page = bundle['index.html'];
        if (page?.type !== 'asset' || typeof page.source !== 'string') {
          throw new Error('packed-app: the build emitted no index.html');
        }
        const assets: Record<string, PackedAsset> = {};
        for (const output of Object.values(bundle)) {
          if (output === page) continue;
          const type = CONTENT_TYPES[extname(output.fileName)];
          if (!type) throw new Error(`packed-app: no content type for ${output.fileName}`);
          const source = output.type === 'chunk' ? output.code : output.source;
          assets[`/${output.fileName}`] = typeof source === 'string'
            ? { type, text: source }
            : { type, base64: Buffer.from(source).toString('base64') };
          delete bundle[output.fileName];
        }
        page.source = packApp(page.source, assets);
      },
    },
  };
}
