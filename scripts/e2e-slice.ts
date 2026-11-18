/**
 * The browser specs a change can break: the PR slice (issue #3455).
 *
 *   bun run e2e:slice [--base <ref>] [--head <ref>] [--budget <minutes>] [--body-file <file>] [--skip-webkit] [--print] [--json]
 *   bun run scripts/e2e-slice.ts plan       # the plan job of .github/workflows/e2e-slice.yml
 *   bun run scripts/e2e-slice.ts shard <k>  # one shard of it, in the Playwright image
 *
 * Every PR runs a small slice of tests/e2e/*.spec.ts, about ten minutes on up
 * to SLICE_MAX_SHARDS shards; the whole suite runs on main (inbox-e2e.yml),
 * and `ci:e2e` / `ci:e2e-all` still run it on a PR. The slice, in this order:
 *
 *  1. the spec files the change adds or edits;
 *  2. the specs named on an `e2e:` line in the PR body (file names or globs
 *     under tests/e2e, separated by spaces or commas), or in --body-file;
 *  3. the specs the rules in tests/e2e/slice-rules.ts map the changed paths to,
 *     shortest first: the closer rules, then the smoke sets for shared code.
 *     A changed helper under tests/e2e or tests/helpers picks the specs that
 *     reach it, by import (also through other helpers) or by a path string
 *     (`bun tests/e2e/<seed>.ts`); the smoke sets when more than
 *     SLICE_HELPER_FANOUT specs do.
 *
 * The budget is in spec-minutes from tests/e2e/shard-times.json (a spec with
 * no time counts as the median), SLICE_MAX_SHARDS × SLICE_SHARD_MINUTES by
 * default. The specs of 1 and 2 always run, whatever their time (the slice may
 * then use up to SLICE_HARD_MAX_SHARDS shards); the specs of 3 get what is
 * left, and the rest drop from the end of that order and are listed. The
 * slice never fails for that. The slice quarantine never drops a spec the
 * change edits. A changed path no rule matches is a notice,
 * never a failure. Paths in SLICE_NO_BROWSER (docs, markdown, the marketing
 * site, unit tests, the Pi and OpenCode hosts) select nothing.
 *
 * Locally, without --print, the chosen specs go to Playwright as one run
 * (build the apps and the binary first; see tests/e2e/playwright.config.ts).
 * --base defaults to origin/main, so a stacked branch passes the branch below.
 *
 * scripts/e2e-slice.test.ts checks the order, the budget, the `e2e:` line,
 * the notices, the quarantine and the workflow.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { E2E_CONFIG, SHARD_1_EXTRA_S, SMOKE_SPECS, fileFilter, repoRoot, runSpecs, shardOf, shards, specFiles, specTimes } from './ci-e2e-shard';
import { failedSpecs } from './ci-e2e-main';
import type { Report } from './ci-e2e-reuse';
import {
  SLICE_HELPER_FANOUT,
  SLICE_NO_BROWSER,
  SLICE_QUARANTINE,
  SLICE_RULES,
  SLICE_SMOKE,
  type SliceRule,
} from '../tests/e2e/slice-rules';

export const SLICE_MAX_SHARDS = 4;
export const SLICE_SHARD_MINUTES = 10;
/** The shard cap when the specs the PR edits or names are alone over the budget: they always run, on more shards. */
export const SLICE_HARD_MAX_SHARDS = 8;
export const SLICE_PLAN_DIR = '.local/e2e-slice';
/** The update specs need the release-numbered binary, as on shard 1 of the full run. */
export const RELEASE_BINARY_SPECS = ['tests/e2e/inbox-update-notice.spec.ts', 'tests/e2e/inbox-updates.spec.ts'];

export interface SliceRules {
  rules: SliceRule[];
  smoke: Record<string, string[]>;
  noBrowser: { paths: string[]; why: string }[];
  quarantine: { spec: string; issue: number; why: string }[];
  helperFanout: number;
}

export const DEFAULT_RULES: SliceRules = {
  rules: SLICE_RULES,
  smoke: SLICE_SMOKE,
  noBrowser: SLICE_NO_BROWSER,
  quarantine: SLICE_QUARANTINE,
  helperFanout: SLICE_HELPER_FANOUT,
};

export interface SliceInput {
  /** Changed paths, repo-relative. */
  changed: string[];
  /** The PR body, for its `e2e:` line. */
  body?: string;
  /** Every spec file at the head, repo-relative (tests/e2e/x.spec.ts). */
  specs: string[];
  /** Measured seconds per spec, by file name. */
  times: Record<string, number>;
  rules?: SliceRules;
  /** Spec-minutes the slice may take. */
  budgetMinutes?: number;
  /** Added and removed lines per changed path, for rules with `lines`. */
  diffLines?: Record<string, string[]>;
  /** Source of each spec and helper under tests/e2e and tests/helpers, for a changed helper. */
  sources?: Record<string, string>;
  /** Specs another workflow already runs on this PR, left out with this reason. */
  elsewhere?: { specs: string[]; why: string };
  /** Leave out WebKit-only specs (a machine with Chromium only). */
  skipWebkit?: boolean;
}

export interface Chosen {
  spec: string;
  seconds: number;
  why: string;
}

export interface Slice {
  chosen: Chosen[];
  /** Spec-minutes of the chosen specs. */
  minutes: number;
  dropped: { spec: string; why: string }[];
  /** Changed paths no rule matched. */
  unmatched: string[];
  /** Changed paths only a smoke (fallback) rule matched. */
  smokeOnly: string[];
  /** Tokens on the `e2e:` line that name no spec. */
  unknown: string[];
  budgetMinutes: number;
  /** The edited and named specs alone are over the budget: they all run, on up to SLICE_HARD_MAX_SHARDS shards. */
  overBudget: boolean;
}

const glob = (pattern: string, target: string) => new Bun.Glob(pattern).match(target);
const SPEC_RE = /^tests\/e2e\/[^/]+\.spec\.ts$/;

/** The tokens on the PR body's `e2e:` lines, HTML comments and code ticks removed. */
export function e2eLine(body: string | undefined): string[] {
  if (!body) return [];
  // A RegExp from a string: Semgrep's TypeScript parser fails on an HTML comment opener inside a regex literal.
  const text = body.replace(new RegExp('<' + '!--[\\s\\S]*?--' + '>', 'g'), '');
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:[-*]\s+)?e2e\s*:(.*)$/i.exec(line);
    if (!m) continue;
    for (const raw of m[1].split(/[\s,]+/)) {
      const token = raw.replace(/^`+|`+$/g, '').trim();
      if (token && !/^(none|-)$/i.test(token)) out.push(token);
    }
  }
  return out;
}

/** The specs one `e2e:` token names: a file name, a path under tests/e2e or a glob, with or without `.spec.ts`. */
export function specsOfToken(token: string, specs: string[]): string[] {
  const name = token.replace(/^\.?\/?tests\/e2e\//, '');
  const candidates = /\.ts$/.test(name) ? [name] : [name, `${name}.spec.ts`];
  return specs.filter((spec) => candidates.some((c) => glob(c, basename(spec))));
}

function weightOf(times: Record<string, number>): (spec: string) => number {
  const known = Object.values(times).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 60;
  return (spec) => times[basename(spec)] ?? median;
}

function ruleMatches(rule: SliceRule, file: string, diffLines: Record<string, string[]> | undefined): boolean {
  if (!rule.paths.some((p) => glob(p, file))) return false;
  if (!rule.lines) return true;
  const re = new RegExp(rule.lines);
  return (diffLines?.[file] ?? []).some((line) => re.test(line));
}

const stripExt = (path: string) => path.replace(/\.(?:ts|tsx|js|mjs|cjs|json)$/, '');

/**
 * The repo files (without extension) one source file refers to: relative
 * module specifiers (`'./x'`, `'../helpers/x'`) resolved against its folder,
 * and repo paths written as strings (`join(repo, 'tests/e2e/voice-inbox.ts')`,
 * the seeds and stand-in Inboxes specs start with `bun <path>`).
 */
export function referencesOf(file: string, text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/['"`](\.{1,2}\/[^'"`\s]+)['"`]/g)) out.add(stripExt(posix.normalize(posix.join(posix.dirname(file), m[1]))));
  for (const m of text.matchAll(/['"`](tests\/[^'"`\s]+)['"`]/g)) out.add(stripExt(posix.normalize(m[1])));
  return out;
}

/** The specs that reach `helper` through any chain of references (helper → helper → spec). */
export function specsReaching(helper: string, sources: Record<string, string>): string[] {
  const refs = Object.entries(sources).map(([file, text]) => [file, referencesOf(file, text)] as const);
  const reached = new Set<string>([stripExt(helper)]);
  const files = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const [file, set] of refs) {
      if (files.has(file)) continue;
      if ([...set].some((r) => reached.has(r))) {
        files.add(file);
        reached.add(stripExt(file));
        grew = true;
      }
    }
  }
  return [...files].filter((f) => SPEC_RE.test(f)).sort();
}

const isHelper = (file: string) => (file.startsWith('tests/e2e/') || file.startsWith('tests/helpers/')) && /\.(?:ts|tsx|js|mjs|cjs)$/.test(file);

/** Pick the slice. Pure: every input is passed in. */
export function selectSlice(input: SliceInput): Slice {
  const rules = input.rules ?? DEFAULT_RULES;
  const budgetMinutes = input.budgetMinutes ?? SLICE_MAX_SHARDS * SLICE_SHARD_MINUTES;
  const weight = weightOf(input.times);
  const allSpecs = [...input.specs].sort();
  const specSet = new Set(allSpecs);
  const bySpecGlob = (patterns: string[]) => allSpecs.filter((s) => patterns.some((p) => glob(p, basename(s))));

  const edited: Chosen[] = [];
  const named: Chosen[] = [];
  const close = new Map<string, string>();
  const smoke = new Map<string, string>();
  const unmatched: string[] = [];
  const smokeOnly: string[] = [];
  const unknown: string[] = [];

  const addSmoke = (apps: string[], why: string) => {
    for (const app of apps) for (const spec of bySpecGlob(rules.smoke[app] ?? [])) if (!smoke.has(spec)) smoke.set(spec, `${app} smoke (${why})`);
  };

  for (const file of [...new Set(input.changed)].sort()) {
    if (SPEC_RE.test(file)) {
      // A deleted spec is not in the head's list: nothing to run.
      if (specSet.has(file)) edited.push({ spec: file, seconds: weight(file), why: 'edited by the change' });
      continue;
    }
    if (rules.noBrowser.some((n) => n.paths.some((p) => glob(p, file)))) continue;
    // A helper under tests/e2e or tests/helpers: the specs that reach it, directly or through other helpers.
    if (isHelper(file) && !rules.rules.some((r) => !r.fallback && ruleMatches(r, file, input.diffLines))) {
      const importers = specsReaching(file, input.sources ?? {}).filter((s) => specSet.has(s));
      if (importers.length === 0) {
        // A shared test helper no spec uses (a unit test helper) is not a gap in the rules; a tests/e2e file is.
        if (file.startsWith('tests/e2e/')) unmatched.push(file);
      } else if (importers.length > rules.helperFanout) {
        addSmoke(Object.keys(rules.smoke), `${file}, imported by ${importers.length} specs`);
      } else {
        for (const spec of importers) if (!close.has(spec)) close.set(spec, `imports ${file}`);
      }
      continue;
    }
    const closer = rules.rules.filter((r) => !r.fallback && ruleMatches(r, file, input.diffLines));
    const hits = closer.length ? closer : rules.rules.filter((r) => r.fallback && ruleMatches(r, file, input.diffLines));
    if (hits.length === 0) {
      unmatched.push(file);
      continue;
    }
    if (!closer.length) smokeOnly.push(file);
    for (const rule of hits) {
      for (const spec of bySpecGlob(rule.specs ?? [])) if (!close.has(spec)) close.set(spec, rule.name);
      if (rule.smoke) addSmoke(rule.smoke, rule.name);
    }
  }

  for (const token of e2eLine(input.body)) {
    const hit = specsOfToken(token, allSpecs);
    if (hit.length === 0) unknown.push(token);
    for (const spec of hit) named.push({ spec, seconds: weight(spec), why: 'named on the e2e: line' });
  }

  const byTime = (m: Map<string, string>): Chosen[] =>
    [...m].map(([spec, why]) => ({ spec, seconds: weight(spec), why })).sort((a, b) => a.seconds - b.seconds || a.spec.localeCompare(b.spec));

  const ordered: (Chosen & { required: boolean })[] = [];
  const seen = new Set<string>();
  const editedSet = new Set(edited.map((c) => c.spec));
  for (const [list, required] of [[edited, true], [named, true], [byTime(close), false], [byTime(smoke), false]] as const) {
    for (const c of list) {
      if (seen.has(c.spec)) continue;
      seen.add(c.spec);
      ordered.push({ ...c, required });
    }
  }

  const dropped: { spec: string; why: string }[] = [];
  const kept: typeof ordered = [];
  const quarantine = new Map(rules.quarantine.map((q) => [q.spec, q]));
  const elsewhere = new Set(input.elsewhere?.specs ?? []);
  for (const c of ordered) {
    // The slice quarantine never drops a spec the PR edits: the PR may be the fix.
    const q = editedSet.has(c.spec) ? undefined : quarantine.get(basename(c.spec));
    if (q) dropped.push({ spec: c.spec, why: `quarantined for the slice (#${q.issue}): ${q.why}` });
    else if (elsewhere.has(c.spec)) dropped.push({ spec: c.spec, why: input.elsewhere!.why });
    else if (input.skipWebkit && /-webkit\.spec\.ts$/.test(c.spec)) dropped.push({ spec: c.spec, why: 'needs WebKit, and this run has Chromium only' });
    else kept.push(c);
  }

  // The specs the PR edits or names always run. The budget is what is left for the mapped and smoke specs,
  // taken in order until one does not fit; the rest drop from the end and are listed.
  const chosen: Chosen[] = [];
  let used = 0;
  for (const c of kept) {
    if (!c.required) continue;
    chosen.push({ spec: c.spec, seconds: c.seconds, why: c.why });
    used += c.seconds;
  }
  const overBudget = used > budgetMinutes * 60;
  let over = false;
  for (const c of kept) {
    if (c.required) continue;
    if (!over && used + c.seconds <= budgetMinutes * 60) {
      chosen.push({ spec: c.spec, seconds: c.seconds, why: c.why });
      used += c.seconds;
    } else {
      over = true;
      dropped.push({ spec: c.spec, why: `over the ${budgetMinutes}-minute budget (${c.why})` });
    }
  }

  return { chosen, minutes: Math.round((used / 60) * 10) / 10, dropped, unmatched, smokeOnly, unknown, budgetMinutes, overBudget };
}

/**
 * Shards for the slice: enough that each takes about SLICE_SHARD_MINUTES, at
 * most SLICE_MAX_SHARDS, or SLICE_HARD_MAX_SHARDS when the edited and named
 * specs alone are over the budget; none when empty.
 */
export function shardCount(slice: Slice): number {
  if (slice.chosen.length === 0) return 0;
  const cap = slice.overBudget ? SLICE_HARD_MAX_SHARDS : SLICE_MAX_SHARDS;
  return Math.min(cap, Math.max(1, Math.ceil(slice.minutes / SLICE_SHARD_MINUTES)));
}

/** Minutes for the build and setup before a shard's specs start: install, both apps, the binary, ripgrep (measured about 3). */
export const SHARD_SETUP_MINUTES = 5;

/**
 * The shard job's timeout. The longest shard's measured spec-minutes S (with
 * shard 1's head start, as scripts/ci-e2e-shard.ts counts it) run, then at
 * worst once more as the retry of every file (a missing report), with 25%
 * slack on the measured times: 2.5 × S, plus SHARD_SETUP_MINUTES and 3 for the
 * update specs' release pass (63 + 9 s, retried). At least 30, at most 180.
 * A full 10-minute shard: 5 + 3 + 2.5 × 10 = 33 minutes.
 */
export function shardTimeout(slice: Slice): number {
  const count = shardCount(slice);
  if (count === 0) return 30;
  const specs = slice.chosen.map((c) => c.spec);
  const seconds = new Map(slice.chosen.map((c) => [c.spec, c.seconds]));
  const loads = shards(specs, Object.fromEntries(slice.chosen.map((c) => [basename(c.spec), c.seconds])), count).map(
    (list, i) => list.reduce((sum, f) => sum + (seconds.get(f) ?? 0), 0) + (i === 0 ? SHARD_1_EXTRA_S : 0),
  );
  const longest = Math.max(...loads) / 60;
  return Math.min(180, Math.max(30, Math.ceil(SHARD_SETUP_MINUTES + 3 + 2.5 * longest)));
}

/** The slice as text: the chosen specs and the estimate first, then what was dropped and the notices. */
export function describeSlice(slice: Slice, markdown = false): string {
  const name = (s: string) => basename(s);
  const item = (text: string) => (markdown ? `- ${text}` : `  ${text}`);
  const head = (text: string) => (markdown ? `\n**${text}**\n` : `\n${text}`);
  const lines: string[] = [];
  const count = shardCount(slice);
  lines.push(
    slice.chosen.length
      ? `e2e slice: ${slice.chosen.length} specs, about ${slice.minutes} spec-minutes on ${count} shard${count === 1 ? '' : 's'} (budget ${slice.budgetMinutes}).`
      : 'e2e slice: no browser spec to run for this change.',
  );
  if (slice.overBudget) {
    lines.push(
      `The specs this change edits or names on its e2e: line are over the ${slice.budgetMinutes}-minute budget on their own. They always run, so this slice uses up to ${SLICE_HARD_MAX_SHARDS} shards and runs no mapped or smoke spec.`,
    );
  }
  if (slice.chosen.length) {
    lines.push(head('Chosen'));
    for (const c of slice.chosen) lines.push(item(`${name(c.spec)} (${c.seconds}s): ${c.why}`));
  }
  if (slice.dropped.length) {
    lines.push(head(`Dropped (${slice.dropped.length}; the full run on main still runs them)`));
    for (const d of slice.dropped) lines.push(item(`${name(d.spec)}: ${d.why}`));
  }
  if (slice.unknown.length) {
    lines.push(head('Names on the e2e: line that match no spec'));
    for (const t of slice.unknown) lines.push(item(t));
  }
  if (slice.unmatched.length) {
    lines.push(head(`Changed paths no rule matches (${slice.unmatched.length}; a notice, not a failure)`));
    for (const f of slice.unmatched) lines.push(item(f));
  }
  if (slice.smokeOnly.length) {
    lines.push(head(`Changed paths only the smoke sets cover (${slice.smokeOnly.length})`));
    if (slice.smokeOnly.length <= 10) {
      for (const f of slice.smokeOnly) lines.push(item(f));
    } else {
      // Many: a count per folder (two levels), so the summary stays readable.
      const dirs = new Map<string, number>();
      for (const f of slice.smokeOnly) {
        const parts = f.split('/');
        const dir = parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length === 2 ? parts[0] : f;
        dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
      }
      for (const [dir, n] of [...dirs].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) lines.push(item(`${dir}: ${n} file${n === 1 ? '' : 's'}`));
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// git and the command line

function git(args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd: repoRoot, stdin: 'ignore' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}
const gitPaths = (args: string[]) => git([args[0], '-z', ...args.slice(1)]).split('\0').filter(Boolean);

/** The added and removed lines of the changed paths some rule reads lines of. */
function diffLinesOf(base: string, head: string | null, changed: string[], rules: SliceRules): Record<string, string[]> {
  const wanted = changed.filter((f) => rules.rules.some((r) => r.lines && r.paths.some((p) => glob(p, f))));
  const out: Record<string, string[]> = {};
  for (const file of wanted) {
    const diff = git(['--literal-pathspecs', 'diff', '-U0', '--no-color', '--no-ext-diff', base, ...(head ? [head] : []), '--', file]);
    out[file] = diff.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).map((l) => l.slice(1));
  }
  return out;
}

export interface Gathered {
  input: SliceInput;
  base: string;
  head: string | null;
}

/**
 * The selector's inputs from git: changed paths from the merge base of `base`
 * to `head` (or to the working tree, untracked files included), and the specs
 * and their times at `head`, or in the working tree when `specsFromTree` is
 * set or there is no head.
 */
export function gather(opts: {
  base: string;
  head: string | null;
  specsFromTree?: boolean;
  body?: string;
  budgetMinutes?: number;
  skipWebkit?: boolean;
  elsewhere?: SliceInput['elsewhere'];
}): Gathered {
  const mergeBase = git(['merge-base', opts.base, opts.head ?? 'HEAD']).trim();
  const changed = opts.head
    ? gitPaths(['diff', '--name-only', '--no-renames', mergeBase, opts.head])
    : [...gitPaths(['diff', '--name-only', '--no-renames', mergeBase]), ...gitPaths(['ls-files', '--others', '--exclude-standard'])];
  const head = opts.specsFromTree ? null : opts.head;
  const specs = head ? gitPaths(['ls-tree', '-r', '--name-only', head, '--', 'tests/e2e']).filter((f) => SPEC_RE.test(f)) : specFiles();
  const times = head ? (JSON.parse(git(['show', `${head}:tests/e2e/shard-times.json`])) as Record<string, number>) : specTimes();
  // The specs' and helpers' sources, only when a helper changed (they are read to follow its importers).
  const sources: Record<string, string> = {};
  if (changed.some((f) => isHelper(f) && !SPEC_RE.test(f))) {
    const files = head
      ? gitPaths(['ls-tree', '-r', '--name-only', head, '--', 'tests/e2e', 'tests/helpers'])
      : gitPaths(['ls-files', 'tests/e2e', 'tests/helpers']).filter((f) => existsSync(join(repoRoot, f)));
    for (const f of files.filter((f) => isHelper(f) && !/\.test\.tsx?$/.test(f))) sources[f] = head ? git(['show', `${head}:${f}`]) : readFileSync(join(repoRoot, f), 'utf8');
    if (!head) for (const f of changed) if (isHelper(f) && !(f in sources) && existsSync(join(repoRoot, f))) sources[f] = readFileSync(join(repoRoot, f), 'utf8');
  }
  return {
    base: mergeBase,
    head: opts.head,
    input: {
      changed,
      body: opts.body,
      specs,
      times,
      budgetMinutes: opts.budgetMinutes,
      diffLines: diffLinesOf(mergeBase, opts.head, changed, DEFAULT_RULES),
      sources,
      skipWebkit: opts.skipWebkit,
      elsewhere: opts.elsewhere,
    },
  };
}

/** The reason the CI slice leaves out SMOKE_SPECS. */
export const SMOKE_ELSEWHERE = { specs: SMOKE_SPECS, why: 'Browser smoke (browser-smoke.yml) runs it on every PR that reaches the binary or the app pages' };

/** The plan job's outputs: the shard count, the matrix, whether a shard needs the release-numbered binary, and the shard timeout. */
export function planOutputs(slice: Slice): string {
  const count = shardCount(slice);
  const release = slice.chosen.some((c) => RELEASE_BINARY_SPECS.includes(c.spec));
  return `count=${count}\nmatrix=${JSON.stringify(Array.from({ length: count }, (_, i) => i + 1))}\nrelease=${release}\ntimeout=${shardTimeout(slice)}\n`;
}

/** The plan job: select, write the plan for the shards (the shape scripts/ci-e2e-shard.ts reads), the summary and the outputs. */
function plan(): void {
  const env = process.env;
  const budget = env.E2E_SLICE_BUDGET ? Number(env.E2E_SLICE_BUDGET) : undefined;
  // GitHub's merge commit is checked out: main as it was (HEAD^1), the PR's head (HEAD^2). The specs come from the merge itself.
  const { input } = gather({ base: 'HEAD^1', head: 'HEAD^2', specsFromTree: true, body: env.PR_BODY ?? '', budgetMinutes: budget, elsewhere: SMOKE_ELSEWHERE });
  const slice = selectSlice(input);
  const count = shardCount(slice);
  const out = join(repoRoot, SLICE_PLAN_DIR);
  mkdirSync(out, { recursive: true });
  const specs = slice.chosen.map((c) => c.spec);
  writeFileSync(join(out, 'plan.json'), `${JSON.stringify({ count, specs, reused: [], why: 'the PR slice (scripts/e2e-slice.ts)' }, null, 1)}\n`);
  writeFileSync(join(out, 'slice.json'), `${JSON.stringify(slice, null, 1)}\n`);
  const text = describeSlice(slice);
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY) {
    const draft = env.PR_DRAFT === 'true' && count > 0 ? '\n_A draft PR: the slice runs once the PR is ready for review._\n' : '';
    const line = '\nAdd specs with an `e2e:` line in the PR body (file names or globs under tests/e2e). The full suite: the `ci:e2e` label.\n';
    appendFileSync(env.GITHUB_STEP_SUMMARY, `## Browser specs: the PR slice\n\n${describeSlice(slice, true)}${draft}${line}`);
  }
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, planOutputs(slice));
}

/** The spec files a Playwright run failed, from its JSON report; every file when the report is missing, has a top-level error or names none. */
function failedOf(reportPath: string, files: string[]): string[] {
  if (!existsSync(reportPath)) return files;
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;
  if ((report.errors ?? []).length > 0) return files;
  const failed = failedSpecs(report).filter((f) => files.includes(f));
  return failed.length ? failed : files;
}

/**
 * One shard of the slice, in the Playwright image: its specs (shardOf, as the
 * full run splits them), then one retry of each spec file that failed. A spec
 * that passes on the retry passes the shard and is named in the notes, as a
 * candidate for tests/e2e/quarantine.json.
 */
function shard(k: number): number {
  const planFile = join(repoRoot, SLICE_PLAN_DIR, 'plan.json');
  const p = JSON.parse(readFileSync(planFile, 'utf8')) as { count: number; specs: string[] };
  if (!Number.isInteger(k) || k < 1 || k > p.count) {
    console.error(`e2e slice: shard ${k} is not in 1..${p.count}`);
    return 2;
  }
  const { files } = shardOf(k, p);
  console.log(`e2e slice shard ${k}/${p.count}: ${files.length} specs\n  ${files.join('\n  ')}`);
  if (files.length === 0) return 0;
  const notes: string[] = [];
  const names = (list: string[]) => list.map((f) => basename(f)).join(', ');
  const reportDir = join(repoRoot, '.local/e2e-report');

  const first = join(reportDir, 'report.json');
  let code = runSpecs(files, true, first);
  if (code !== 0) {
    const failed = failedOf(first, files);
    console.log(`e2e slice: retrying ${failed.length} failed spec files once\n  ${failed.join('\n  ')}`);
    code = runSpecs(failed, true, join(reportDir, 'retry.json'));
    notes.push(
      code === 0
        ? `Shard ${k}: failed, then passed on one retry (flaky? see tests/e2e/quarantine.json): ${names(failed)}`
        : `Shard ${k}: failed twice: ${names(failed)}`,
    );
  }

  // The update specs skip themselves on the dev binary: once more on the release-numbered one, as shard 1 of the full run does.
  const release = files.filter((f) => RELEASE_BINARY_SPECS.includes(f));
  const releaseBinary = process.env.E2E_SLICE_RELEASE_BINARY;
  if (release.length && releaseBinary) {
    process.env.PLANNOTATOR_E2E_RELEASE_BINARY = releaseBinary;
    let releaseCode = runSpecs(release, true, join(reportDir, 'release.json'));
    if (releaseCode !== 0) releaseCode = runSpecs(release, true, join(reportDir, 'release-retry.json'));
    delete process.env.PLANNOTATOR_E2E_RELEASE_BINARY;
    if (releaseCode !== 0) notes.push(`Shard ${k}: the update specs failed twice on the release-numbered binary: ${names(release)}`);
    code = code || releaseCode;
  }

  if (notes.length) {
    mkdirSync(join(repoRoot, SLICE_PLAN_DIR), { recursive: true });
    writeFileSync(join(repoRoot, SLICE_PLAN_DIR, `notes-${k}.md`), `${notes.map((n) => `- ${n}`).join('\n')}\n`);
    console.log(notes.join('\n'));
  }
  return code;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

/** The local command: print the slice, then (without --print) run it. */
function local(args: string[]): number {
  const known = new Set(['--base', '--head', '--budget', '--body-file', '--skip-webkit', '--print', '--json']);
  for (const a of args) if (a.startsWith('--') && !known.has(a)) throw new Error(`unknown option ${a}`);
  const budgetText = flag(args, '--budget');
  const budgetMinutes = budgetText === undefined ? undefined : Number(budgetText);
  if (budgetMinutes !== undefined && !(budgetMinutes > 0)) throw new Error('--budget takes a number of minutes');
  const bodyFile = flag(args, '--body-file');
  const { input } = gather({
    base: flag(args, '--base') ?? 'origin/main',
    head: flag(args, '--head') ?? null,
    body: bodyFile ? readFileSync(bodyFile, 'utf8') : undefined,
    budgetMinutes,
    skipWebkit: args.includes('--skip-webkit'),
  });
  const slice = selectSlice(input);
  console.log(args.includes('--json') ? JSON.stringify(slice, null, 1) : describeSlice(slice));
  if (args.includes('--print') || args.includes('--json') || slice.chosen.length === 0) return 0;
  const files = slice.chosen.map((c) => c.spec);
  console.log(`Running ${files.length} specs: bunx playwright test -c ${E2E_CONFIG} ${files.map(fileFilter).join(' ')}`);
  return runSpecs(files, false);
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'plan') plan();
    else if (cmd === 'shard') process.exit(shard(Number(rest[0])));
    else process.exit(local(process.argv.slice(2)));
  } catch (err) {
    console.error(`e2e slice: ${err instanceof Error ? err.message : String(err)}`);
    console.error('usage: bun run e2e:slice [--base <ref>] [--head <ref>] [--budget <minutes>] [--body-file <file>] [--skip-webkit] [--print] [--json]');
    process.exit(2);
  }
}
