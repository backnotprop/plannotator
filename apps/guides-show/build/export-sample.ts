/**
 * Write sample exported guides against a built viewer, for smoke tests.
 *   bun build/export-sample.ts [--base http://localhost:8787/v1/] [--out dist/samples]
 * Reads dist/viewer/manifest.json; emits one HTML per fixture.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createGuideHtml, guideExportFilename } from '../../../packages/core/guide-format';
import { GUIDE_SNAPSHOT_FIXTURES } from '../../../packages/core/guide-format-fixtures';
import type { ViewerManifest } from './manifest-plugin';

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const base = opt('--base', 'https://guides.show/v1/');
const outDir = path.resolve(import.meta.dirname, '..', opt('--out', 'dist/samples'));
const manifest = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../dist/viewer/manifest.json'), 'utf8')) as ViewerManifest;
mkdirSync(outDir, { recursive: true });
for (const { name, snapshot } of GUIDE_SNAPSHOT_FIXTURES) {
  const html = createGuideHtml(snapshot, {
    viewer: { baseUrl: base, js: manifest.js, css: manifest.css, jsIntegrity: manifest.jsIntegrity, cssIntegrity: manifest.cssIntegrity, langs: manifest.langs },
  });
  const file = path.join(outDir, `${name}-${guideExportFilename(snapshot.guide.title)}`);
  writeFileSync(file, html);
  console.log(`${file}  ${html.length} bytes`);
}
