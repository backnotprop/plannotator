// @plannotator/system/node: reads a drawing from disk or from git. Bun or
// Node. Git is only ever read (rev-parse, ls-tree, cat-file, diff); nothing
// here fetches.
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { citations } from '../format/cited.ts';
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES } from '../format/keys.ts';
import { loadFiles } from '../format/load.ts';
import type { LoadIssue, LoadResult, SystemFiles } from '../format/types.ts';
import { decodeUtf8, git, gitBytes, isGitRepo, lsTree, resolveCommit } from './git.ts';

/** Where a drawing lives inside a repo. */
export const DRAWING_DIR = '.plannotator/system';

/** A file the loader should see: the drawing's own files, and .yml or stray .yaml files it reports. */
const isDrawingFile = (rel: string) => /^(?:(?:sheets|revisions)\/)?[^/]+\.ya?ml$/.test(rel);
const issue = (file: string, message: string): LoadIssue => ({ file, field: '', message });
/** The whole drawing is over the cap: filed under no file, and the only error then. */
const totalCap = () => issue('', `the drawing is over ${MAX_TOTAL_BYTES} bytes; this Plannotator reads at most that in one drawing`);

/** The drawing's files in a folder on disk, and what kept a file out (a symlink, a size over the cap, bytes that are not UTF-8). */
export async function readFiles(dir: string): Promise<{ files: SystemFiles; issues: LoadIssue[] }> {
  const files: SystemFiles = Object.create(null);
  const issues: LoadIssue[] = [];
  try {
    if ((await lstat(dir)).isSymbolicLink()) return { files, issues: [issue('', `${dir} is a symlink; the drawing folder is a plain folder`)] };
  } catch {
    // no folder, no drawing
    return { files, issues };
  }
  // stop reading as soon as the drawing passes the total cap
  let total = 0;
  let over = false;
  const walk = async (rel: string) => {
    let entries;
    try {
      entries = await readdir(join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (over) return;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        if (isDrawingFile(path) || (!rel && (e.name === 'sheets' || e.name === 'revisions'))) {
          issues.push(issue(path, 'is a symlink; a drawing file is a plain file in the drawing folder'));
        }
      } else if (e.isDirectory()) {
        if (!rel && (e.name === 'sheets' || e.name === 'revisions')) await walk(e.name);
      } else if (e.isFile() && isDrawingFile(path)) {
        const size = (await lstat(join(dir, path))).size;
        if (size > MAX_FILE_BYTES) {
          issues.push(issue(path, `is ${size} bytes; this Plannotator reads at most ${MAX_FILE_BYTES} bytes in one file`));
          continue;
        }
        total += size;
        if (total > MAX_TOTAL_BYTES) {
          over = true;
          return;
        }
        const text = decodeUtf8(await readFile(join(dir, path)));
        if (text == null) issues.push(issue(path, 'is not UTF-8 text'));
        else files[path] = text;
      }
    }
  };
  await walk('');
  if (over) return { files: Object.create(null), issues: [totalCap()] };
  return { files, issues };
}

/** Load with the issues that kept files out, so a symlinked system.yaml reads as that and not as "missing". */
function withIssues(files: SystemFiles, issues: LoadIssue[]): LoadResult {
  const result = loadFiles(files);
  const kept = new Set(issues.map((i) => i.file));
  const errors = result.errors.filter((e) => !(e.message === 'is missing' && kept.has(e.file)));
  // over the total cap nothing was read, and the cap is the one error
  if (issues.length && !result.model && !Object.keys(files).length) return { model: null, errors: issues, warnings: result.warnings };
  return { ...result, errors: [...issues, ...errors] };
}

/** Load the drawing in a folder (usually `<repo>/.plannotator/system`). No folder: model null and no errors. */
export async function load(dir: string): Promise<LoadResult> {
  const { files, issues } = await readFiles(dir);
  return withIssues(files, issues);
}

async function collectCommitted(o: { root: string; ref: string }): Promise<{ files: SystemFiles; issues: LoadIssue[] }> {
  const commit = await resolveCommit(o.root, o.ref);
  if (!commit) throw new Error(`git: "${o.ref}" is not a commit in ${o.root}`);
  const tree = await lsTree(o.root, commit, DRAWING_DIR);
  const files: SystemFiles = Object.create(null);
  const issues: LoadIssue[] = [];
  let total = 0;
  for (const [full, entry] of tree) {
    if (!full.startsWith(DRAWING_DIR + '/')) continue;
    const rel = full.slice(DRAWING_DIR.length + 1);
    if (!isDrawingFile(rel) && !(entry.mode === '120000' && (rel === 'sheets' || rel === 'revisions'))) continue;
    if (entry.mode === '120000') {
      issues.push(issue(rel, `is a symlink at ${o.ref}; a drawing file is a plain file in the drawing folder`));
      continue;
    }
    if (entry.type !== 'blob') continue;
    if ((entry.size ?? 0) > MAX_FILE_BYTES) {
      issues.push(issue(rel, `is ${entry.size} bytes; this Plannotator reads at most ${MAX_FILE_BYTES} bytes in one file`));
      continue;
    }
    total += entry.size ?? 0;
    if (total > MAX_TOTAL_BYTES) return { files: Object.create(null), issues: [totalCap()] };
    const text = decodeUtf8(await gitBytes(o.root, ['cat-file', 'blob', `${commit}:${full}`], MAX_FILE_BYTES + 1));
    if (text == null) issues.push(issue(rel, 'is not UTF-8 text'));
    else files[rel] = text;
  }
  return { files, issues };
}

/**
 * The drawing as committed at a ref, read only. No drawing at that ref gives
 * no files. Throws when the ref is not a commit, or a drawing file is a
 * symlink, over the size cap or not UTF-8.
 */
export async function readCommitted(o: { root: string; ref: string }): Promise<SystemFiles> {
  const { files, issues } = await collectCommitted(o);
  if (issues.length) throw new Error(issues.map((i) => `${i.file || DRAWING_DIR}: ${i.message}`).join('\n'));
  return files;
}

/** Load the drawing as committed at a ref, with any file that could not be read as an error. */
export async function loadCommitted(o: { root: string; ref: string }): Promise<LoadResult> {
  const { files, issues } = await collectCommitted(o);
  return withIssues(files, issues);
}

/** Outside git: true when the path exists with exactly this case and no part of it is a symlink. */
async function onDisk(root: string, path: string, listings: Map<string, Set<string> | null>): Promise<'ok' | 'missing' | 'symlink'> {
  let dir = root;
  for (const seg of path.split('/')) {
    if (!listings.has(dir)) {
      try {
        listings.set(dir, new Set(await readdir(dir)));
      } catch {
        listings.set(dir, null);
      }
    }
    if (!listings.get(dir)?.has(seg)) return 'missing';
    dir = join(dir, seg);
    try {
      if ((await lstat(dir)).isSymbolicLink()) return 'symlink';
    } catch {
      return 'missing';
    }
  }
  return 'ok';
}

type Lookup = (path: string) => Promise<'ok' | 'missing' | 'symlink'>;

/** How to look a path up in one repo: in its tree at a commit, or on disk when it is not a git repo. */
async function lookupIn(root: string, at: string | undefined, name: string, errors: LoadIssue[]): Promise<Lookup | null> {
  if (!(await isGitRepo(root))) {
    const listings = new Map<string, Set<string> | null>();
    return (p) => onDisk(root, p, listings);
  }
  if (!at) {
    errors.push({ file: 'system.yaml', field: `sources.repos.${name}.at`, message: 'no commit to check the cited paths at' });
    return null;
  }
  const commit = await resolveCommit(root, at);
  if (!commit) {
    errors.push({
      file: 'system.yaml', field: `sources.repos.${name}.at`,
      message: `${at} is not a commit in ${root}; fetch it, or check at another commit (--at)`,
    });
    return null;
  }
  const prefix = (await git(root, ['rev-parse', '--show-prefix'])).trim();
  const tree = await lsTree(root, commit);
  return async (p) => {
    const e = tree.get(prefix + p);
    return !e ? 'missing' : e.mode === '120000' ? 'symlink' : 'ok';
  };
}

export type CheckResult = { errors: LoadIssue[]; warnings: LoadIssue[]; missing: string[] };

/**
 * The loader, plus every cited path. In a git repo a path counts only if it
 * is in the tree of the commit the drawing was drawn from
 * (`sources.repos.<alias>.at`; `at` overrides it for this repo), so an
 * untracked, ignored or symlinked file does not. Outside git the files on
 * disk are read, and a symlink anywhere on the path does not count. `roots`
 * gives a checkout for any other alias in `sources.repos`. A drawing is clean
 * when all three lists are empty.
 */
export async function check(o: { dir: string; root: string; roots?: Record<string, string>; at?: string }): Promise<CheckResult> {
  const result = await load(o.dir);
  const errors = [...result.errors];
  const warnings = [...result.warnings];
  const missing: string[] = [];
  const model = result.model;
  if (!model) {
    if (!errors.length) errors.push({ file: 'system.yaml', field: '', message: `no drawing in ${o.dir}` });
    return { errors, warnings, missing };
  }
  const roots: Record<string, string> = { ...o.roots, self: o.root };
  const lookups = new Map<string, Lookup | null>();
  const unchecked = new Set<string>();
  const seen = new Set<string>();
  for (const c of citations(model)) {
    if (!Object.hasOwn(roots, c.repo)) {
      unchecked.add(c.repo);
      continue;
    }
    if (!lookups.has(c.repo)) {
      const at = c.repo === 'self' && o.at ? o.at : model.sources?.repos[c.repo]?.at;
      lookups.set(c.repo, await lookupIn(roots[c.repo]!, at, c.repo, errors));
    }
    const lookup = lookups.get(c.repo);
    const key = `${c.repo}:${c.path}`;
    if (!lookup || seen.has(key)) continue;
    seen.add(key);
    const found = await lookup(c.path);
    if (found === 'missing') missing.push(c.repo === 'self' ? c.path : key);
    else if (found === 'symlink') {
      errors.push({
        file: 'system.yaml', field: `${c.by.kind === 'part' ? 'parts' : 'flows'}.${c.by.id}.code`,
        message: `${c.repo === 'self' ? c.path : key} is a symlink; cite the file it points to`,
      });
    }
  }
  for (const alias of unchecked) {
    warnings.push({ file: 'system.yaml', field: `sources.repos.${alias}`, message: `paths in repo "${alias}" were not checked: no checkout of it was given` });
  }
  return { errors, warnings, missing };
}

export { gateRepo, parseNameStatus } from './gate-repo.ts';

// The recipes, the agents and the scheduled check (step A6).
export { DRAW_BRANCH, firstDrawPrompt, recipes, REDRAW_BRANCH, updatePrompt, type UpdatePromptInput } from '../recipe/prompts.ts';
export { parseSetup, SYSTEM_AGENTS, type SystemAgent, type SystemSetup } from '../agent/setup.ts';
export { agentModel } from '../agent/model.ts';
export { unattendedDocs, unattendedDocUrl, type DocUrlCheck } from '../agent/docs.ts';
export { CLAUDE_REDRAW_TOOLS, redrawCommand, SYSTEM_COMMANDS, type SystemSubcommand } from '../agent/command.ts';
export { checkKey, EMPTY_STATE, readSetup, readState, systemPaths, takeLock, writeState, type TickState } from './state.ts';
export { changedCount, mergedPrs, redrawNote, SUMMARY_FILE, tick, type Forge, type Notify, type RunAgent, type TickDeps, type TickResult } from './tick.ts';
export { install, LABEL_PREFIX, launchAgentsDir, list, plist, remove, schedule, scheduleLabel, SYSTEM_TICK_INTERVAL_SECONDS, type CommandRunner, type ScheduleOptions } from './schedule.ts';
