// @plannotator/system/node: reads a drawing from disk or from git. Bun or
// Node. Git is only ever read (ls-tree, show, diff); nothing here fetches.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { citations } from '../format/cited.ts';
import { loadFiles } from '../format/load.ts';
import type { LoadResult, SystemFiles } from '../format/types.ts';
import { git } from './git.ts';

/** Where a drawing lives inside a repo. */
export const DRAWING_DIR = '.plannotator/system';

const isDrawingFile = (rel: string) =>
  rel === 'system.yaml' || /^(sheets|revisions)\/[^/]+\.ya?ml$/.test(rel) || /^[^/]+\.ya?ml$/.test(rel);

async function readDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** The drawing's files in a folder on disk. A folder that does not exist gives no files. */
export async function readFiles(dir: string): Promise<SystemFiles> {
  const files: SystemFiles = {};
  const names = [
    ...(await readDir(dir)),
    ...(await readDir(join(dir, 'sheets'))).map((n) => `sheets/${n}`),
    ...(await readDir(join(dir, 'revisions'))).map((n) => `revisions/${n}`),
  ];
  for (const rel of names) if (isDrawingFile(rel)) files[rel] = await readFile(join(dir, rel), 'utf8');
  return files;
}

/** Load the drawing in a folder (usually `<repo>/.plannotator/system`). No folder: model null and no errors. */
export async function load(dir: string): Promise<LoadResult> {
  return loadFiles(await readFiles(dir));
}

/** The drawing as committed at a ref (`git show <ref>:.plannotator/system/...`), read only. No drawing at that ref gives no files. */
export async function readCommitted(o: { root: string; ref: string }): Promise<SystemFiles> {
  const listed = await git(o.root, ['ls-tree', '-r', '-z', '--name-only', o.ref, '--', DRAWING_DIR]);
  const files: SystemFiles = {};
  for (const full of listed.split('\0').filter(Boolean)) {
    const rel = full.slice(DRAWING_DIR.length + 1);
    if (isDrawingFile(rel)) files[rel] = await git(o.root, ['show', `${o.ref}:${full}`]);
  }
  return files;
}

/** True when the path exists with exactly this case, so a check on macOS agrees with one on Linux. */
async function existsExact(root: string, path: string, listings: Map<string, Set<string> | null>): Promise<boolean> {
  let dir = root;
  for (const seg of path.split('/')) {
    if (!listings.has(dir)) {
      try {
        listings.set(dir, new Set(await readdir(dir)));
      } catch {
        listings.set(dir, null);
      }
    }
    if (!listings.get(dir)?.has(seg)) return false;
    dir = join(dir, seg);
  }
  try {
    await stat(dir);
    return true;
  } catch {
    return false;
  }
}

export type CheckResult = { errors: string[]; warnings: string[]; missing: string[] };

/**
 * The loader, plus every cited path. `root` is this repo's checkout at the
 * commit the drawing was drawn from (`sources.repos.self.at`); `roots` gives a
 * checkout for any other alias in `sources.repos`. A drawing is clean when all
 * three lists are empty.
 */
export async function check(o: { dir: string; root: string; roots?: Record<string, string> }): Promise<CheckResult> {
  const result = await load(o.dir);
  const errors = [...result.errors];
  const warnings = [...result.warnings];
  const missing: string[] = [];
  if (!result.model) {
    if (!errors.length) errors.push(`no drawing in ${o.dir} (no system.yaml)`);
    return { errors, warnings, missing };
  }
  const roots: Record<string, string> = { ...o.roots, self: o.root };
  const listings = new Map<string, Set<string> | null>();
  const unchecked = new Set<string>();
  const seen = new Set<string>();
  for (const c of citations(result.model)) {
    const repoRoot = roots[c.repo];
    if (!repoRoot) {
      unchecked.add(c.repo);
      continue;
    }
    const key = `${c.repo}:${c.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!(await existsExact(repoRoot, c.path, listings))) missing.push(c.repo === 'self' ? c.path : key);
  }
  for (const alias of unchecked) warnings.push(`paths in repo "${alias}" were not checked: no checkout of it was given`);
  return { errors, warnings, missing };
}
