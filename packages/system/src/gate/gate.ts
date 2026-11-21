// The gate: changed files and the drawing's code maps go in, the parts and
// lines that may be stale come out, and whether the agent should redraw. No
// model, no disk, no git: a pure function.
//
// The rule: if every changed file is already named by the drawing and the
// change adds no process, store, host, route, connection or switch, the
// drawing does not change. A script cannot read "adds a process", so the gate
// wakes on what can stand for it: an added, deleted or renamed file that is not
// a test, a doc or a lockfile; a modified file that matches `watch:`; a cited
// path that is gone. A modified file no part cites does not wake it.
import { citations, covers } from '../format/cited.ts';
import type { SystemModel } from '../format/types.ts';

export type ChangedFile = { path: string; status: 'A' | 'M' | 'D' | 'R'; from?: string };
export type GateInput = { files: ChangedFile[]; model: SystemModel; /** The repo alias the files are in; default 'self'. */ repo?: string };
export type GateReason = 'added' | 'deleted' | 'renamed' | 'watched' | 'cited-gone';
export type GateResult = {
  /** Parts and lines that cite a changed path: amber in a PR, "may be stale" on main. */
  touched: { parts: string[]; flows: string[] };
  /** The shape may have moved: run the agent. */
  wake: boolean;
  why: { path: string; reason: GateReason }[];
  /** Changed files the gate does not count: tests, docs, lockfiles and the drawing itself. */
  ignored: string[];
};

/** A folder with one of these names, anywhere in a path, holds tests (the command's help lists them). */
export const TEST_FOLDERS = ['test', 'tests', '__tests__', 'e2e', 'fixtures', 'test-fixtures', '__snapshots__'] as const;
/** File names the gate reads as lockfiles, in any folder. */
export const LOCKFILE_NAMES = [
  'bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock',
  'go.sum', 'Gemfile.lock', 'poetry.lock', 'uv.lock', 'composer.lock',
] as const;
const TEST = [new RegExp(`(^|/)(${TEST_FOLDERS.join('|')})/`), /\.(test|spec)\.[cm]?[jt]sx?$/];
const DOC = [/\.mdx?$/i, /(^|\/)docs\//];
const LOCKFILES: ReadonlySet<string> = new Set(LOCKFILE_NAMES);

/**
 * A path the gate never counts unless the drawing cites it: a test, a doc, a
 * lockfile, or the drawing itself (a redraw must not wake the next redraw).
 * Fixed in the package, not a setting.
 */
export function isIgnoredPath(path: string): boolean {
  if (path === '.plannotator/system' || path.startsWith('.plannotator/system/')) return true;
  if (LOCKFILES.has(path.slice(path.lastIndexOf('/') + 1))) return true;
  return TEST.some((re) => re.test(path)) || DOC.some((re) => re.test(path));
}

/** A path glob: `**` crosses folders, `*` and `?` stay inside one. */
export function globMatch(glob: string, path: string): boolean {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(path);
}

export function gate(input: GateInput): GateResult {
  const repo = input.repo ?? 'self';
  const refs = citations(input.model).filter((c) => c.repo === repo);
  const exact = new Set(refs.map((r) => r.path));
  const watch = repo === 'self' ? input.model.watch : [];
  const parts = new Set<string>();
  const flows = new Set<string>();
  const why: GateResult['why'] = [];
  const ignored: string[] = [];

  for (const f of input.files) {
    const paths = f.status === 'R' && f.from ? [f.from, f.path] : [f.path];
    // a test, doc or lockfile counts only when the drawing names that very
    // file; a cited folder covers its code, not its tests
    if (paths.every((p) => isIgnoredPath(p) && !exact.has(p))) {
      ignored.push(f.path);
      continue;
    }
    const hits = refs.filter((r) => paths.some((p) => covers(r.path, p)));
    for (const h of hits) (h.by.kind === 'part' ? parts : flows).add(h.by.id);
    const gone = (f.status === 'D' && exact.has(f.path)) || (f.status === 'R' && !!f.from && exact.has(f.from));
    if (gone) why.push({ path: f.status === 'R' ? f.from! : f.path, reason: 'cited-gone' });
    else if (f.status === 'A') why.push({ path: f.path, reason: 'added' });
    else if (f.status === 'D') why.push({ path: f.path, reason: 'deleted' });
    else if (f.status === 'R') why.push({ path: f.path, reason: 'renamed' });
    else if (watch.some((g) => globMatch(g, f.path))) why.push({ path: f.path, reason: 'watched' });
  }

  return { touched: { parts: [...parts].sort(), flows: [...flows].sort() }, wake: why.length > 0, why, ignored };
}
