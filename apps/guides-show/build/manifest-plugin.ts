import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

export interface ViewerManifest {
  version: number;
  js: string;
  css: string;
  jsIntegrity: string;
  cssIntegrity: string;
  langs: Record<string, string>;
}

const sri = (source: string | Uint8Array) => `sha384-${createHash('sha384').update(source).digest('base64')}`;

export function viewerManifestPlugin(opts: { version: number }): Plugin {
  return {
    name: 'guides-show-viewer-manifest',
    apply: 'build',
    enforce: 'post',
    writeBundle(options, bundle) {
      const outDir = options.dir ?? path.dirname(options.file ?? '');
      const bytes = (fileName: string) => readFileSync(path.join(outDir, fileName));
      let js: string | undefined, jsIntegrity = '', css: string | undefined, cssIntegrity = '';
      const langs: Record<string, string> = {};
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === 'chunk') {
          if (output.isEntry && output.name === 'viewer') { js = fileName; jsIntegrity = sri(bytes(fileName)); continue; }
          const ids = [output.facadeModuleId ?? '', ...output.moduleIds];
          const lang = ids.map((id) => /@shikijs\/langs\/dist\/([^/]+)\.mjs$/.exec(id)?.[1]).find(Boolean);
          if (lang) langs[lang] = fileName;
        } else if (output.type === 'asset' && fileName.endsWith('.css')) {
          if (css) throw new Error(`viewer manifest: multiple css assets (${css}, ${fileName})`);
          css = fileName; cssIntegrity = sri(bytes(fileName));
        }
      }
      if (!js || !css) throw new Error(`viewer manifest: missing entry (js=${js}, css=${css})`);
      const manifest: ViewerManifest = { version: opts.version, js, css, jsIntegrity, cssIntegrity, langs };
      writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    },
  };
}
