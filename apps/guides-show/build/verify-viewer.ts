/// <reference types="bun-types" />
/**
 * Check that a published viewer is whole on the live site.
 *   bun build/verify-viewer.ts [--base https://guides.show/v1/]
 *
 * HEADs every file of the local build (dist/viewer: the entry JS and CSS, the
 * worker, every chunks/ file and asset) under the base URL and fails when any
 * does not answer 200, then checks the entry JS carries the immutable cache and
 * open CORS headers exported guides rely on. A file whose size on the site
 * differs from the local one also fails (a different file under the same key).
 * Each request gives up after 15 s. Read only: it never writes.
 * Run after deploy:viewer, so a partial publish fails the workflow.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ViewerManifest } from './manifest-plugin';
import { findMissing, type HeadResult } from './viewer-upload';

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const base = opt('--base', 'https://guides.show/v1/');
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

const files = walk(dist).filter((f) => f !== 'manifest.json');
// The manifest names what exported guides load; each must be in the build.
for (const rel of [manifest.js, manifest.css, ...Object.values(manifest.langs)]) {
  if (!files.includes(rel)) { console.error(`manifest names ${rel}, which is not in dist/viewer`); process.exit(1); }
}

console.log(`checking ${files.length} files under ${base}`);
const FETCH_TIMEOUT_MS = 15_000;
// The size comes from the HEAD's Content-Length. When it is missing or does
// not match, the body of a GET is counted before anything is reported, so a
// proxy that drops the header on HEAD can neither hide nor fake a mismatch.
const head = async (url: string): Promise<HeadResult> => {
  const res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const length = res.headers.get('content-length');
  return { status: res.status, size: length === null ? null : Number(length) };
};
const getSize = async (url: string): Promise<number | null> => {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} on GET`);
  return (await res.arrayBuffer()).byteLength;
};
const local = files.map((rel) => ({ rel, size: statSync(path.join(dist, rel)).size }));
const problems = await findMissing({ baseUrl: base, files: local, head, getSize, retry: { delaysMs: [1000, 2000, 4000] } });
if (problems.length > 0) {
  console.error(`${problems.length} of ${files.length} viewer files are missing or differ on the site:\n${problems.map((m) => `  ${m}`).join('\n')}`);
  process.exit(1);
}

const entryUrl = `${base.endsWith('/') ? base : `${base}/`}${manifest.js}`;
const res = await fetch(entryUrl, { method: 'HEAD', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
const headerProblems: string[] = [];
if (!/public, max-age=31536000, immutable/i.test(res.headers.get('cache-control') ?? '')) headerProblems.push(`cache-control is "${res.headers.get('cache-control')}"`);
if (res.headers.get('access-control-allow-origin') !== '*') headerProblems.push(`access-control-allow-origin is "${res.headers.get('access-control-allow-origin')}"`);
if (headerProblems.length > 0) { console.error(`${entryUrl}: ${headerProblems.join('; ')}`); process.exit(1); }

console.log(`all ${files.length} viewer files are published at their local sizes; ${manifest.js} has the immutable cache and CORS headers`);
