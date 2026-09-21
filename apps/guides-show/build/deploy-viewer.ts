/// <reference types="bun-types" />
/**
 * Upload a built viewer to the guides.show R2 bucket — ADD-ONLY.
 *   bun build/deploy-viewer.ts [--bucket guides-show-viewer] [--dry-run] [--local]
 *
 * Wrangler 4 targets LOCAL storage for `r2 object` commands unless --remote is
 * passed, so this script passes --remote by default and --local on request.
 *
 * Every file under dist/viewer is content-hashed, so a key can only ever map
 * to one byte sequence; uploading the same key twice is a no-op by
 * construction, and nothing is ever deleted (decision record D8). The two
 * entry files are additionally verified against any existing object before
 * upload: a hash collision with different bytes aborts the deploy.
 *
 * `manifest.json` is a build artifact for producers (Plannotator embeds it at
 * build time); it is published under /meta/<version>/manifest.<builtAt>.json,
 * never under the immutable /v1/ tree.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ViewerManifest } from './manifest-plugin';

const args = process.argv.slice(2);
const opt = (name: string, dflt?: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const bucket = opt('--bucket', 'guides-show-viewer')!;
const dryRun = args.includes('--dry-run');
const local = args.includes('--local');
const dist = path.resolve(import.meta.dirname, '../dist/viewer');
const manifest = JSON.parse(readFileSync(path.join(dist, 'manifest.json'), 'utf8')) as ViewerManifest;

function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}

const CONTENT_TYPES: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const ctype = (f: string) => CONTENT_TYPES[path.extname(f)] ?? 'application/octet-stream';

async function wrangler(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['bunx', 'wrangler', ...argv], { cwd: path.resolve(import.meta.dirname, '..'), stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

async function existingBytes(key: string): Promise<Uint8Array | null> {
  const tmp = `/tmp/guides-show-verify-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const r = await wrangler(['r2', 'object', 'get', `${bucket}/${key}`, '--file', tmp, local ? '--local' : '--remote']);
  if (r.code !== 0) return null;
  try { return new Uint8Array(readFileSync(tmp)); } catch { return null; }
}

const files = walk(dist).filter((f) => f !== 'manifest.json');
console.log(`viewer build ${manifest.js} → r2://${bucket}/v1/ (${files.length} files)${dryRun ? ' [dry run]' : ''}${local ? ' [local]' : ''}`);

// Immutability guard on the entry files: same key must mean same bytes.
for (const entry of [manifest.js, manifest.css]) {
  const existing = dryRun ? null : await existingBytes(`v1/${entry}`);
  if (existing) {
    const ours = new Uint8Array(readFileSync(path.join(dist, entry)));
    if (existing.length !== ours.length || existing.some((b, i) => b !== ours[i])) {
      console.error(`REFUSING TO DEPLOY: v1/${entry} already exists in ${bucket} with different bytes.`);
      process.exit(2);
    }
    console.log(`v1/${entry} already published (identical) — nothing new to publish for the entry.`);
  }
}

let uploaded = 0;
for (const rel of files) {
  const key = `v1/${rel}`;
  if (dryRun) { console.log(`  put ${key}`); continue; }
  const r = await wrangler(['r2', 'object', 'put', `${bucket}/${key}`, '--file', path.join(dist, rel), '--content-type', ctype(rel), '--cache-control', 'public, max-age=31536000, immutable', local ? '--local' : '--remote']);
  if (r.code !== 0) { console.error(`upload failed for ${key}\n${r.err}`); process.exit(1); }
  uploaded++;
  if (uploaded % 25 === 0) console.log(`  ${uploaded}/${files.length}`);
}
if (!dryRun) {
  const stamp = /\.([A-Za-z0-9_-]+)\.js$/.exec(manifest.js)?.[1] ?? 'unknown';
  const metaKey = `meta/v${manifest.version}/manifest.${stamp}.json`;
  const r = await wrangler(['r2', 'object', 'put', `${bucket}/${metaKey}`, '--file', path.join(dist, 'manifest.json'), '--content-type', 'application/json; charset=utf-8', local ? '--local' : '--remote']);
  if (r.code !== 0) { console.error(`manifest upload failed\n${r.err}`); process.exit(1); }
  console.log(`published ${uploaded} files; manifest at ${metaKey}`);
}
