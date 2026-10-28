/// <reference types="bun-types" />
/**
 * Upload a built viewer to the guides.show R2 bucket — ADD-ONLY.
 *   bun build/deploy-viewer.ts [--bucket guides-show-viewer] [--dry-run] [--local] [--concurrency 1-4]
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
 * Uploads go in a fixed order (chunks and assets, then the entry CSS, then
 * the entry JS, then the manifest) with up to 4 at a time, and each failed
 * upload is retried 4 times (1, 2, 4, 8 s) before the run fails, so a failed
 * run never leaves a live entry pointing at missing files. The order, retry
 * and pool live in viewer-upload.ts.
 *
 * `manifest.json` is a build artifact for producers (Plannotator embeds it at
 * build time); it is published under /meta/<version>/manifest.<builtAt>.json,
 * never under the immutable /v1/ tree.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ViewerManifest } from './manifest-plugin';
import { runCommand } from './run-command';
import { clampConcurrency, existingFromGet, MAX_CONCURRENCY, publishViewer, uploadPlan, withRetry, WRANGLER_TIMEOUT_MS } from './viewer-upload';

const args = process.argv.slice(2);
const opt = (name: string, dflt?: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const bucket = opt('--bucket', 'guides-show-viewer')!;
const dryRun = args.includes('--dry-run');
const local = args.includes('--local');
const target = local ? '--local' : '--remote';
const concurrency = clampConcurrency(Number(opt('--concurrency', String(MAX_CONCURRENCY))));
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

/** One wrangler call, killed after WRANGLER_TIMEOUT_MS (a hung call then fails and is retried). */
function wrangler(argv: string[]) {
  return runCommand(['bunx', 'wrangler', ...argv], { cwd: path.resolve(import.meta.dirname, '..'), timeoutMs: WRANGLER_TIMEOUT_MS });
}

/**
 * The object's bytes, or null when the key does not exist (`existingFromGet`
 * decides). Retried; a failure that lasts aborts the deploy. The temp file is
 * removed whatever happened, a failed or partial download included.
 */
async function existingBytes(key: string): Promise<Uint8Array | null> {
  return withRetry(async () => {
    const tmp = path.join(tmpdir(), `guides-show-verify-${process.pid}-${Math.random().toString(36).slice(2)}`);
    try {
      const r = await wrangler(['r2', 'object', 'get', `${bucket}/${key}`, '--file', tmp, target]);
      return existingFromGet(key, { ...r, file: existsSync(tmp) ? new Uint8Array(readFileSync(tmp)) : null });
    } finally {
      rmSync(tmp, { force: true });
    }
  }, { onRetry: (attempt, error, delay) => console.log(`  retrying read of ${key} in ${delay / 1000}s (attempt ${attempt} failed: ${String(error instanceof Error ? error.message : error).split('\n')[0]})`) });
}

async function put(key: string, file: string, contentType: string, cacheControl?: string): Promise<void> {
  const argv = ['r2', 'object', 'put', `${bucket}/${key}`, '--file', file, '--content-type', contentType];
  if (cacheControl) argv.push('--cache-control', cacheControl);
  const r = await wrangler([...argv, target]);
  if (r.timedOut) throw new Error(`wrangler timed out after ${WRANGLER_TIMEOUT_MS / 1000}s`);
  if (r.code !== 0) throw new Error(r.err || r.out || `wrangler exited ${r.code}`);
}

const files = walk(dist).filter((f) => f !== 'manifest.json');
// Assets first, then the entry CSS, then the entry JS (see viewer-upload.ts).
const steps = uploadPlan(files, manifest);
console.log(`viewer build ${manifest.js} → r2://${bucket}/v1/ (${files.length} files, ${concurrency} at a time)${dryRun ? ' [dry run]' : ''}${local ? ' [local]' : ''}`);

// Immutability guard on the entry files: same key must mean same bytes.
for (const entry of [manifest.js, manifest.css]) {
  let existing: Uint8Array | null = null;
  try {
    existing = dryRun ? null : await existingBytes(`v1/${entry}`);
  } catch (error) {
    console.error(`REFUSING TO DEPLOY: could not check whether v1/${entry} already exists.\n${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  if (existing) {
    const ours = new Uint8Array(readFileSync(path.join(dist, entry)));
    if (existing.length !== ours.length || existing.some((b, i) => b !== ours[i])) {
      console.error(`REFUSING TO DEPLOY: v1/${entry} already exists in ${bucket} with different bytes.`);
      process.exit(2);
    }
    console.log(`v1/${entry} already published (identical) — nothing new to publish for the entry.`);
  }
}

const stamp = /\.([A-Za-z0-9_-]+)\.js$/.exec(manifest.js)?.[1] ?? 'unknown';
const metaKey = `meta/v${manifest.version}/manifest.${stamp}.json`;
if (dryRun) {
  for (const step of steps) console.log(`  put v1/${step.rel}`);
  console.log(`  put ${metaKey}`);
} else {
  try {
    const uploaded = await publishViewer({
      steps,
      concurrency,
      put: (rel) => put(`v1/${rel}`, path.join(dist, rel), ctype(rel), 'public, max-age=31536000, immutable'),
      putManifest: () => put(metaKey, path.join(dist, 'manifest.json'), 'application/json; charset=utf-8'),
      log: (line) => console.log(line),
    });
    console.log(`published ${uploaded} files; manifest at ${metaKey}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
