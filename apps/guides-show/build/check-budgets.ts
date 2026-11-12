import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import type { ViewerManifest } from './manifest-plugin';

const BUDGETS = {
  jsGzipBytes: 400 * 1024,
  cssGzipBytes: 64 * 1024,
};

const dir = path.resolve(import.meta.dirname, '../dist/viewer');
const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as ViewerManifest;
const gz = (file: string) => gzipSync(readFileSync(path.join(dir, file)), { level: 9 }).byteLength;
const js = gz(manifest.js);
const css = gz(manifest.css);
const langCount = Object.keys(manifest.langs).length;
const report = [
  `viewer js  ${manifest.js}  ${(js / 1024).toFixed(1)} KB gz  (budget ${(BUDGETS.jsGzipBytes / 1024).toFixed(0)} KB)`,
  `viewer css ${manifest.css}  ${(css / 1024).toFixed(1)} KB gz  (budget ${(BUDGETS.cssGzipBytes / 1024).toFixed(0)} KB)`,
  `grammar chunks: ${langCount}`,
];
const failures: string[] = [];
if (js > BUDGETS.jsGzipBytes) failures.push(`viewer js exceeds budget by ${((js - BUDGETS.jsGzipBytes) / 1024).toFixed(1)} KB gz`);
if (css > BUDGETS.cssGzipBytes) failures.push(`viewer css exceeds budget by ${((css - BUDGETS.cssGzipBytes) / 1024).toFixed(1)} KB gz`);
if (langCount < 100) failures.push(`expected per-language grammar chunks, found ${langCount} — did dynamic imports get inlined?`);
if (!manifest.jsIntegrity.startsWith('sha384-') || !manifest.cssIntegrity.startsWith('sha384-')) failures.push('manifest is missing SRI hashes');
const workerFiles = readdirSync(dir).filter((f) => /^worker\..*\.js$/.test(f));
if (workerFiles.length !== 1) failures.push(`expected exactly one worker bundle, found ${workerFiles.length}`);
for (const file of workerFiles) {
  const src = readFileSync(path.join(dir, file), 'utf8');
  const moduleSyntax = /(^|[;{}\s])(import|export)\s*[{("'*a-zA-Z_$]/.test(src) || /\bimport\.meta\b/.test(src);
  if (moduleSyntax) failures.push(`${file} uses module syntax; the portable viewer must be able to run it as a classic worker (see portablePool.tsx)`);
  else report.push(`worker ${file} is import-free (classic-worker safe)`);
}
console.log(report.join('\n'));
if (failures.length) {
  console.error('\nBUDGET FAILURES:\n- ' + failures.join('\n- '));
  process.exit(1);
}
