import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { citations } from '../format/cited.ts';
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES } from '../format/keys.ts';
import { loadFiles } from '../format/load.ts';
import { stillWanted } from '../format/status.ts';
import type { LoadIssue, LoadResult, SystemFiles } from '../format/types.ts';
import { decodeUtf8, git, isGitRepo, lsTree, resolveCommit } from './git.ts';

const isDrawingFile = (rel: string) => /^(?:(?:sheets|revisions)\/)?[^/]+\.ya?ml$/.test(rel);
const issue = (file: string, message: string): LoadIssue => ({ file, field: '', message });
const totalCap = () => issue('', `the drawing is over ${MAX_TOTAL_BYTES} bytes; this Plannotator reads at most that in one drawing`);

export async function readFiles(dir: string): Promise<{ files: SystemFiles; issues: LoadIssue[] }> {
  const files: SystemFiles = Object.create(null);
  const issues: LoadIssue[] = [];
  try {
    if ((await lstat(dir)).isSymbolicLink()) return { files, issues: [issue('', `${dir} is a symlink; the drawing folder is a plain folder`)] };
  } catch {
    return { files, issues };
  }
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

function withIssues(files: SystemFiles, issues: LoadIssue[]): LoadResult {
  const result = loadFiles(files);
  const kept = new Set(issues.map((i) => i.file));
  const errors = result.errors.filter((e) => !(e.message === 'is missing' && kept.has(e.file)));
  if (issues.length && !result.model && !Object.keys(files).length) return { model: null, errors: issues, warnings: result.warnings };
  return { ...result, errors: [...issues, ...errors] };
}

export async function load(dir: string): Promise<LoadResult> {
  const { files, issues } = await readFiles(dir);
  return withIssues(files, issues);
}

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
  // a check is the end of a draw: a sheet still wanted is one the drawer forgot, and while one is the
  // scheduled check never redraws the drawing (it reads it as still being drawn)
  for (const w of stillWanted(model)) {
    warnings.push({ file: 'system.yaml', field: 'wanted', message: `Sheet ${w.code} is listed under wanted, but no file draws it yet. Draw it, then remove it from wanted.` });
  }
  return { errors, warnings, missing };
}

export { gateRepo, parseNameStatus } from './gate-repo.ts';

export { firstDrawPrompt, recipes, reviewPrompt, updatePrompt, type ReviewPromptInput, type UpdatePromptInput } from '../recipe/prompts.ts';
export { parseSetup, SYSTEM_AGENTS, type SystemAgent, type SystemSetup } from '../agent/setup.ts';
export { agentModel } from '../agent/model.ts';
export { unattendedDocs, unattendedDocUrl, type DocUrlCheck } from '../agent/docs.ts';
export { redrawCommand, SYSTEM_COMMANDS, type SystemSubcommand } from '../agent/command.ts';
export { checkKey, EMPTY_STATE, readSetup, readState, systemPaths, takeLock, writeState, type TickState } from './state.ts';
export { changedCount, mergedPrs, plannotatorProgram, prepareSource, redrawNote, runCommand, tick, TICK_TIMEOUTS_MS, type Notify, type Run, type RunAgent, type TickDeps, type TickResult } from './tick.ts';
export { install, LABEL_PREFIX, launchAgentsDir, list, plist, remove, schedule, scheduleLabel, SYSTEM_TICK_INTERVAL_SECONDS, type CommandRunner, type ScheduleOptions } from './schedule.ts';
