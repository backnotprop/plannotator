/**
 * The vendored @pierre/layouts (packages/vendor-pierre-layouts): checks that
 * `upstream/` is still byte for byte the copy UPSTREAM.md records, and prints
 * the pinned commit.
 *
 *   bun scripts/check-vendored-pierre-layouts.ts           # check (exit 1 on any difference)
 *   bun scripts/check-vendored-pierre-layouts.ts --write   # after an update: record the new manifest
 *
 * The manifest is the fenced `sha256` block of UPSTREAM.md, one `<sha256>  <path>`
 * line per file (the format `shasum -a 256 -c` reads, paths relative to upstream/).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export const vendorDir = resolve(import.meta.dir, '../packages/vendor-pierre-layouts');
const MANIFEST_BLOCK = /```sha256\n([\s\S]*?)```/;

export interface ManifestEntry {
  sha256: string;
  path: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** Every file under `upstream/`, hashed, sorted by path. */
export function hashUpstream(dir = vendorDir): ManifestEntry[] {
  const root = join(dir, 'upstream');
  return walk(root)
    .map((file) => ({ path: relative(root, file).split(sep).join('/'), sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function readUpstreamMd(dir = vendorDir): string {
  return readFileSync(join(dir, 'UPSTREAM.md'), 'utf8');
}

export function parseManifest(upstreamMd: string): ManifestEntry[] {
  const block = MANIFEST_BLOCK.exec(upstreamMd);
  if (!block) throw new Error('UPSTREAM.md has no ```sha256 block');
  return block[1]
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      if (!match) throw new Error(`UPSTREAM.md: not a manifest line: ${line}`);
      return { sha256: match[1], path: match[2] };
    });
}

/** The commit UPSTREAM.md pins (its `Commit:` line). */
export function pinnedCommit(upstreamMd: string): string {
  const match = /^- Commit: `([0-9a-f]{40})`/m.exec(upstreamMd);
  if (!match) throw new Error('UPSTREAM.md has no "- Commit: `<sha>`" line');
  return match[1];
}

/** What differs between the recorded manifest and the files: empty when `upstream/` is untouched. */
export function manifestDifferences(recorded: readonly ManifestEntry[], actual: readonly ManifestEntry[]): string[] {
  const want = new Map(recorded.map((e) => [e.path, e.sha256]));
  const have = new Map(actual.map((e) => [e.path, e.sha256]));
  const out: string[] = [];
  for (const [path, sha] of want) {
    if (!have.has(path)) out.push(`missing: ${path}`);
    else if (have.get(path) !== sha) out.push(`changed: ${path}`);
  }
  for (const path of have.keys()) if (!want.has(path)) out.push(`not in the manifest: ${path}`);
  return out;
}

export function formatManifest(entries: readonly ManifestEntry[]): string {
  return entries.map((e) => `${e.sha256}  ${e.path}\n`).join('');
}

if (import.meta.main) {
  const md = readUpstreamMd();
  const actual = hashUpstream();
  if (process.argv.includes('--write')) {
    writeFileSync(join(vendorDir, 'UPSTREAM.md'), md.replace(MANIFEST_BLOCK, '```sha256\n' + formatManifest(actual) + '```'));
    console.log(`Recorded ${actual.length} files under upstream/.`);
  } else {
    const differences = manifestDifferences(parseManifest(md), actual);
    console.log(`@pierre/layouts pinned at ${pinnedCommit(md)}`);
    if (differences.length > 0) {
      console.error(`upstream/ differs from UPSTREAM.md (never edit upstream/; see packages/vendor-pierre-layouts/README.md):\n  ${differences.join('\n  ')}`);
      process.exit(1);
    }
    console.log(`upstream/ matches its manifest (${actual.length} files).`);
  }
}
