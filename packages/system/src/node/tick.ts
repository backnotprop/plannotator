// One scheduled check of one project (`plannotator system tick`, run by
// launchd every SYSTEM_TICK_INTERVAL_SECONDS while the Mac is awake):
//
//   1. fetch the default branch (the person's own git credentials);
//   2. diff from the last commit the drawing is right for to the new tip;
//   3. gate: no wake, write the gated commit and stop (most ticks: no model);
//   4. wake: bring the drawing's worktree to the new tip on the redraw branch,
//      run the person's agent headless with recipe/UPDATE.md, check, commit;
//   5. push the redraw branch, open or keep its one pull request, send one note.
//
// The tick never pushes to the default branch and never force-pushes. The
// agent runs as it normally does, with its full tools (owner ruling
// 2026-11-06: no limits on agents); whatever it changes is offered in the
// redraw pull request for the person to review, and files outside the drawing
// are named there and in the note. Every child process has a time bound, so a
// hung agent, git, hook or gh cannot hold the schedule. The agent, the forge
// (gh) and the note are injectable so the whole path runs in tests with no
// model, no network and no real gh.
//
// TODO(System B9, Ops' Inbox side): a stuck tick (a merge conflict on the
// redraw branch, gh signed out, a time bound hit) and a set-aside worktree are
// recorded only in state.json (`last_error`, `set_aside`). The Inbox's System
// thread should surface them; that is a follow-up on the Inbox side.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, cp, mkdir, readdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { redrawCommand } from '../agent/command.ts';
import { unattendedDocs } from '../agent/docs.ts';
import type { SystemSetup } from '../agent/setup.ts';
import type { SystemModel } from '../format/types.ts';
import type { GateResult } from '../gate/gate.ts';
import { REDRAW_BRANCH, updatePrompt } from '../recipe/prompts.ts';
import { gateRepo } from './gate-repo.ts';
import { checkRef } from './git.ts';
import { check, DRAWING_DIR, load, loadCommitted } from './index.ts';
import { readSetup, readState, systemPaths, takeLock, writeState, type TickState } from './state.ts';

/** Where the redraw agent writes its one sentence per changed sheet, relative to the worktree. Never committed. */
export const SUMMARY_FILE = '.plannotator/redraw-summary.txt';

export type TickResult = {
  /**
   * nothing: nothing to do (no new commit, no drawing on the default branch,
   * not set up, another tick running, or waiting after a failed redraw);
   * gated: the gate ran and the drawing stands; redrew: a redraw was
   * committed, pushed and offered as a pull request; failed: see `error`.
   */
  ran: 'nothing' | 'gated' | 'redrew' | 'failed';
  /** The commit of the default branch this tick is done with, or '' when none. */
  gated: string;
  /** Why nothing ran, in a few words. */
  why?: string;
  /** The redraw pull request's link. */
  pr?: string;
  /** The note sent to the Inbox. */
  note?: string;
  error?: string;
};

export type RunAgent = (o: { setup: SystemSetup; cwd: string; prompt: string; docs: string[] }) => Promise<{ ok: boolean; output: string }>;
export type Forge = {
  /** The open pull request whose head is `head`, or null. Throws when the forge cannot be asked. */
  findOpenPr(o: { cwd: string; head: string }): Promise<string | null>;
  /** Open one pull request and return its link. */
  openPr(o: { cwd: string; base: string; head: string; title: string; body: string }): Promise<string>;
};
export type Notify = (o: { project: string; subject: string; body: string; replyTo: string | null }) => Promise<void>;
export type TickDeps = {
  runAgent?: RunAgent;
  forge?: Forge;
  notify?: Notify;
  /** The plannotator binary the note is sent with, absolute; `plannotatorProgram()` unless given (pass the plist's program). */
  plannotator?: string;
  /** The default agent's command; `redrawCommand` unless given. */
  agentCommand?: (setup: SystemSetup, prompt: string) => { command: string[]; stdin: string | null };
  /** The default agent's time bound; TICK_TIMEOUTS_MS.agent unless given. */
  agentTimeoutMs?: number;
};

/**
 * Time bounds on the tick's own child processes: an engineering default, not
 * a limit a person meets. A child past its bound is stopped with its whole
 * process group (SIGTERM, then SIGKILL 5 s later) and the tick records why
 * in state.json, so a hung agent, a git hook or signing prompt that waits for
 * a person, a stalled network or a gh that never answers cannot keep the job
 * running, which would stop launchd from starting it again.
 */
export const TICK_TIMEOUTS_MS = { agent: 45 * 60_000, git: 5 * 60_000, gh: 2 * 60_000, note: 2 * 60_000 } as const;

export type Run = { code: number; stdout: string; stderr: string; timedOut: boolean };

const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`);

/**
 * Run one command to the end, or until `timeoutMs`: then its process group
 * (it and everything it started) is stopped and `timedOut` is set. Output past
 * `keep` bytes keeps only its tail.
 */
export function runCommand(argv: string[], o: { cwd: string; timeoutMs: number; stdin?: string | null; env?: Record<string, string>; keep?: number }): Promise<Run> {
  const keep = o.keep ?? 16 * 1024 * 1024;
  return new Promise((done) => {
    // its own process group, so a stop reaches what it started too
    const child = spawn(argv[0]!, argv.slice(1), { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const group = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    };
    let hard: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      group('SIGTERM');
      hard = setTimeout(() => group('SIGKILL'), 5000);
    }, o.timeoutMs);
    const tail = (s: string) => (s.length > keep ? s.slice(-keep) : s);
    child.stdout.on('data', (d: Buffer) => (stdout = tail(stdout + d.toString('utf8'))));
    child.stderr.on('data', (d: Buffer) => (stderr = tail(stderr + d.toString('utf8'))));
    const finish = (r: Omit<Run, 'timedOut'>) => {
      clearTimeout(timer);
      clearTimeout(hard);
      if (timedOut) group('SIGKILL');
      done({ ...r, timedOut });
    };
    child.on('error', (e) => finish({ code: 127, stdout, stderr: stderr + e.message }));
    child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(o.stdin ?? '');
  });
}

/** Why a child failed, in a line: its own words, or the time bound it hit. */
const failure = (name: string, r: Run, timeoutMs: number) =>
  r.timedOut ? `${name} was stopped after ${minutes(timeoutMs)} with no end` : `${name}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`;

/**
 * git that never asks on a terminal or opens an editor: launchd has none. The
 * repo's hooks and the person's signing setup run as they normally do; a hook
 * or a signing prompt that waits for a person meets the time bound.
 */
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' };

const runGit = (cwd: string, args: string[]) => runCommand(['git', '-C', cwd, ...args], { cwd, env: GIT_ENV, timeoutMs: TICK_TIMEOUTS_MS.git });

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await runGit(cwd, args);
  if (r.code !== 0) throw new Error(failure(`git ${args[0]}`, r, TICK_TIMEOUTS_MS.git));
  return r.stdout;
}
const gitOk = async (cwd: string, args: string[]) => (await runGit(cwd, args)).code === 0;
const commitOf = async (cwd: string, ref: string) => (await git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${checkRef(ref)}^{commit}`]).catch(() => '')).trim() || null;

/** The default branch's name, from origin/HEAD, else main or master. */
async function defaultBranch(root: string): Promise<string> {
  const head = (await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
  if (head.startsWith('origin/')) return head.slice('origin/'.length);
  for (const b of ['main', 'master']) if (await gitOk(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`])) return b;
  for (const b of ['main', 'master']) if (await gitOk(root, ['ls-remote', '--exit-code', '--heads', 'origin', b])) return b;
  throw new Error('no default branch: origin has no HEAD, main or master');
}

/**
 * Pull request numbers named by the first-parent commits in a range ("Merge
 * pull request #n", a squash's "(#n)"). With `paths`, only the commits that
 * changed one of them: the pull requests that moved the drawing, not every
 * one that landed. A rename or copy counts under both its old and its new
 * path, because the gate may name either one.
 */
export async function mergedPrs(root: string, from: string, to: string, paths?: readonly string[]): Promise<number[]> {
  const out = await git(root, [
    'log', '--first-parent', '--diff-merges=first-parent', '--name-status', '-M', '-z', '--format=%x01%s', '--end-of-options',
    `${checkRef(from)}..${checkRef(to)}`,
  ]);
  const wanted = paths ? new Set(paths) : null;
  const prs = new Set<number>();
  for (const entry of out.split('\x01').slice(1)) {
    // <subject> NUL, then per file <status> NUL <path> NUL (the first status
    // after a newline); a rename or copy (R100, C75) has two paths, old then new
    const [subject = '', ...rest] = entry.split('\0');
    const files: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const status = rest[i]!.replace(/^\n/, '');
      if (!status) continue;
      const paths = status[0] === 'R' || status[0] === 'C' ? 2 : 1;
      files.push(...rest.slice(i + 1, i + 1 + paths));
      i += paths;
    }
    if (wanted && !files.some((f) => wanted.has(f))) continue;
    const m = /^Merge pull request #(\d+)\b/.exec(subject) ?? /\(#(\d+)\)\s*$/.exec(subject);
    if (m) prs.add(Number(m[1]));
  }
  return [...prs].sort((a, b) => a - b);
}

/** Reviews the Inbox stored for these pull requests while they were open: the newest file per number. */
async function storedReviews(reviewsDir: string, repo: string | undefined, prs: number[]): Promise<{ pr: number; path: string }[]> {
  if (!repo || !prs.length || repo.split('/').some((s) => !s || s === '.' || s === '..')) return [];
  const dir = join(reviewsDir, ...repo.split('/'));
  const names = await readdir(dir).catch(() => [] as string[]);
  const found: { pr: number; path: string }[] = [];
  for (const pr of prs) {
    let best: { path: string; at: number } | null = null;
    for (const n of names.filter((n) => n.startsWith(`${pr}@`) && n.endsWith('.yaml'))) {
      const at = (await stat(join(dir, n)).catch(() => null))?.mtimeMs ?? 0;
      if (!best || at > best.at) best = { path: join(dir, n), at };
    }
    if (best) found.push({ pr, path: best.path });
  }
  return found;
}

/** Changed paths in a worktree, untracked files included, from `git status --porcelain -z`. */
async function changedPaths(wt: string): Promise<string[]> {
  const tok = (await git(wt, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0');
  const paths: string[] = [];
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i]!;
    if (!t) continue;
    paths.push(t.slice(3));
    if (t[0] === 'R' || t[0] === 'C') paths.push(tok[++i]!);
  }
  return paths;
}

/** How many parts and lines differ between two drawings: added, removed or changed. */
export function changedCount(before: SystemModel, after: SystemModel): { parts: number; flows: number } {
  const count = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    let n = 0;
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!Object.hasOwn(a, id) || !Object.hasOwn(b, id) || JSON.stringify(a[id]) !== JSON.stringify(b[id])) n++;
    }
    return n;
  };
  return { parts: count(before.parts, after.parts), flows: count(before.flows, after.flows) };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * The note a redraw sends: "Main moved to 9c41e07. PR 1335 landed: <the
 * agent's sentences> 1 part changed. This redraw also changed: <files outside
 * the drawing>. Redraw: <link>"
 */
export function redrawNote(o: { to: string; prs: number[]; summary: string; count: { parts: number; flows: number }; also?: string[]; pr: string | null }): string {
  const words = [`Main moved to ${o.to.slice(0, 7)}.`];
  const summary = o.summary.replace(/\s+/g, ' ').trim();
  const said = summary && !/[.!?]$/.test(summary) ? `${summary}.` : summary;
  if (o.prs.length) words.push(`${o.prs.length === 1 ? 'PR' : 'PRs'} ${o.prs.join(', ')} landed${said ? ':' : '.'}`);
  if (said) words.push(said);
  const { parts, flows } = o.count;
  if (parts && flows) words.push(`${plural(parts, 'part')} and ${plural(flows, 'line')} changed.`);
  else if (parts || flows) words.push(`${parts ? plural(parts, 'part') : plural(flows, 'line')} changed.`);
  if (o.also?.length) words.push(`This redraw also changed: ${o.also.join(', ')}.`);
  if (o.pr) words.push(`Redraw: ${o.pr}`);
  return words.join(' ');
}

/** The default agent: the person's own agent CLI, headless, in the worktree, within its time bound. */
const commandAgent = (deps: TickDeps | undefined): RunAgent => async ({ setup, cwd, prompt }) => {
  const { command, stdin } = (deps?.agentCommand ?? redrawCommand)(setup, prompt);
  const timeoutMs = deps?.agentTimeoutMs ?? TICK_TIMEOUTS_MS.agent;
  const r = await runCommand(command, { cwd, stdin, env: GIT_ENV, timeoutMs, keep: 64 * 1024 });
  if (r.timedOut) return { ok: false, output: `the agent was stopped after ${minutes(timeoutMs)} with no end` };
  return { ok: r.code === 0, output: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}` };
};

/** The default forge: the GitHub CLI with the person's own sign-in. */
const ghForge: Forge = {
  async findOpenPr({ cwd, head }) {
    const r = await runCommand(['gh', 'pr', 'list', '--head', head, '--state', 'open', '--json', 'url', '--limit', '1'], { cwd, env: { GH_PROMPT_DISABLED: '1' }, timeoutMs: TICK_TIMEOUTS_MS.gh });
    if (r.code !== 0) throw new Error(failure('gh pr list', r, TICK_TIMEOUTS_MS.gh));
    const rows = JSON.parse(r.stdout || '[]') as { url?: string }[];
    return rows[0]?.url ?? null;
  },
  async openPr({ cwd, base, head, title, body }) {
    const r = await runCommand(['gh', 'pr', 'create', '--base', base, '--head', head, '--title', title, '--body-file', '-'], { cwd, stdin: body, env: { GH_PROMPT_DISABLED: '1' }, timeoutMs: TICK_TIMEOUTS_MS.gh });
    if (r.code !== 0) throw new Error(failure('gh pr create', r, TICK_TIMEOUTS_MS.gh));
    return r.stdout.trim().split('\n').pop()!.trim();
  },
};

/** The default note: `plannotator inbox call send_message`, the JSON on stdin. */
const inboxNotify = (plannotator: string): Notify => async ({ project, subject, body, replyTo }) => {
  const message = { body, project_path: project, ...(replyTo ? { reply_to: replyTo } : { subject }) };
  const r = await runCommand([plannotator, 'inbox', 'call', 'send_message', '-'], { cwd: project, stdin: JSON.stringify(message), timeoutMs: TICK_TIMEOUTS_MS.note });
  if (r.code !== 0) throw new Error(failure('plannotator inbox call send_message', r, TICK_TIMEOUTS_MS.note));
};

/**
 * The plannotator binary to send the note with, absolute: this process when
 * it is the plannotator binary (the launchd job runs it by its absolute path),
 * else the first plannotator on PATH, resolved. A caller that knows the
 * plist's program passes it as `deps.plannotator` instead.
 */
export async function plannotatorProgram(): Promise<string> {
  if (/^plannotator(?:\.exe)?$/.test(basename(process.execPath))) return process.execPath;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, 'plannotator');
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return realpath(candidate).catch(() => candidate);
  }
  return 'plannotator';
}

/** The same folder, after symlinks: macOS's /var and /private/var are one folder. */
const same = async (a: string, b: string) => (await realpath(a).catch(() => resolve(a))) === (await realpath(b).catch(() => resolve(b)));

/**
 * Put the drawing's worktree on the redraw branch at `base`, then merge
 * `merge` into it when given. Made when missing. An existing one must be a
 * worktree of this repo. It is the tick's own: one left dirty by a redraw that
 * was cut off (a reboot, a logout, a kill) is set aside under `interrupted`
 * and reset, and the return says so, so one cut-off redraw never stops every
 * later tick.
 */
async function prepareWorktree(root: string, wt: string, base: string, merge: string | null, interrupted: string): Promise<string | null> {
  let setAsideNote: string | null = null;
  const exists = await stat(wt).then(() => true, () => false);
  if (!exists) {
    await mkdir(dirname(wt), { recursive: true, mode: 0o700 });
    await git(root, ['worktree', 'add', '-B', REDRAW_BRANCH, wt, base]);
  } else {
    const common = (await git(wt, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => '')).trim();
    const own = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    if (!common || !(await same(common, own))) throw new Error(`${wt} is not a worktree of ${root}`);
    if ((await changedPaths(wt)).length || (await gitOk(wt, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']))) {
      await setAside(wt, interrupted);
      setAsideNote = `the redraw worktree was left with changes (a redraw cut off before it ended); they are kept in ${interrupted}`;
    }
    await git(wt, ['checkout', '--quiet', '-B', REDRAW_BRANCH, base]);
  }
  if (merge && !(await gitOk(wt, ['merge-base', '--is-ancestor', merge, 'HEAD']))) {
    const r = await runGit(wt, ['merge', '--no-edit', '--quiet', merge]);
    if (r.code !== 0) {
      await runGit(wt, ['merge', '--abort']);
      throw new Error(r.timedOut ? failure('git merge', r, TICK_TIMEOUTS_MS.git) : `the redraw branch does not merge with ${merge}: ${(r.stderr || r.stdout).trim()}`);
    }
  }
  return setAsideNote;
}

/**
 * Keep what a refused redraw left (every changed file, under
 * `<failed>/<commit>/`), then put the worktree back to its last commit, so the
 * next redraw starts clean and nothing the agent wrote is lost.
 */
async function setAside(wt: string, into: string): Promise<void> {
  // a merge left half done is undone first, so the reset below can run
  await runGit(wt, ['merge', '--abort']);
  for (const rel of await changedPaths(wt)) {
    const from = join(wt, rel);
    if (await stat(from).then(() => true, () => false)) {
      await mkdir(dirname(join(into, rel)), { recursive: true });
      await cp(from, join(into, rel), { recursive: true });
    }
  }
  await git(wt, ['reset', '--quiet', '--hard', 'HEAD']);
  await git(wt, ['clean', '--quiet', '-fd']);
}

/**
 * Set sources.repos.self.at in system.yaml by replacing only that value's
 * text, so every other byte stays as the agent wrote it (printing the parsed
 * document again would refold its lines). With no such key it adds nothing:
 * the check then names it.
 */
async function setDrawnAt(dir: string, commit: string): Promise<void> {
  const file = join(dir, 'system.yaml');
  const text = await readFile(file, 'utf8');
  const node = parseDocument(text).getIn(['sources', 'repos', 'self', 'at'], true) as { value?: unknown; range?: [number, number, number] } | undefined;
  if (!node?.range || node.value === commit) return;
  await writeFile(file, `${text.slice(0, node.range[0])}"${commit}"${text.slice(node.range[1])}`);
}

/** The newer of two commits, by ancestry; either may be missing. With neither an ancestor of the other, `a`. */
async function newer(root: string, a: string | null, b: string | null): Promise<string | null> {
  if (!a || !b) return a ?? b;
  return (await gitOk(root, ['merge-base', '--is-ancestor', a, b])) ? b : a;
}

/** One tick for one project. Never throws: a failure is `ran: 'failed'` with `error`, also kept in state.json. */
export async function tick(o: { root: string; dataDir: string; key: string; now?: Date; deps?: TickDeps }): Promise<TickResult> {
  if (!isAbsolute(o.root) || !isAbsolute(o.dataDir)) return { ran: 'failed', gated: '', error: 'root and dataDir must be absolute paths' };
  let paths: ReturnType<typeof systemPaths>;
  try {
    paths = systemPaths(o.dataDir, o.key);
  } catch (e) {
    return { ran: 'failed', gated: '', error: (e as Error).message };
  }
  const setup = await readSetup(o.dataDir, o.key);
  if (!setup) return { ran: 'nothing', gated: '', why: 'not set up: no setup.json for this project' };
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const release = await takeLock(paths.lock);
  if (!release) return { ran: 'nothing', gated: '', why: 'another tick is running' };
  const now = () => (o.now ?? new Date()).toISOString();
  const state = await readState(o.dataDir, o.key);
  // every save builds on the last one, so a later save keeps an earlier field (set_aside)
  let current = state;
  const save = async (s: Partial<TickState>) => {
    current = { ...current, ...s };
    await writeState(o.dataDir, o.key, current);
  };
  let target = '';
  try {
    const main = await defaultBranch(o.root);
    await git(o.root, ['fetch', '--quiet', 'origin', `+refs/heads/${main}:refs/remotes/origin/${main}`]);
    target = (await commitOf(o.root, `refs/remotes/origin/${main}`))!;
    const committed = await loadCommitted({ root: o.root, ref: target });
    const model = committed.model;
    if (!model) return { ran: 'nothing', gated: '', why: `no drawing on ${main} yet` };

    const drawnAt = model.sources?.repos.self?.at ? await commitOf(o.root, model.sources.repos.self.at) : null;
    const gated = state.gated ? await commitOf(o.root, state.gated) : null;
    const from = await newer(o.root, drawnAt, gated);
    if (!from) throw new Error(`the drawing's commit ${model.sources?.repos.self?.at ?? '(none)'} is not in this clone; fetch it`);
    if (from === target || (await gitOk(o.root, ['merge-base', '--is-ancestor', target, from]))) {
      return { ran: 'nothing', gated: from, why: 'main has not moved' };
    }
    if (state.failed === target) return { ran: 'nothing', gated: state.gated ?? '', why: `the last redraw for ${target.slice(0, 7)} failed; waiting for main to move` };

    const result: GateResult = await gateRepo({ root: o.root, from, to: target, model });
    if (!result.wake) {
      await save({ gated: target, gated_at: now(), last_error: null, failed: null });
      return { ran: 'gated', gated: target };
    }
    return await redraw({ ...o, setup, paths, main, from, target, model, result, state, save, now });
  } catch (e) {
    // before any agent ran: nothing was spent, so the next tick tries again
    const error = (e as Error).message;
    await save({ last_error: error }).catch(() => {});
    return { ran: 'failed', gated: state.gated ?? '', error };
  } finally {
    await release();
  }
}

type RedrawInput = {
  root: string;
  key: string;
  deps?: TickDeps;
  setup: SystemSetup;
  paths: ReturnType<typeof systemPaths>;
  main: string;
  from: string;
  target: string;
  model: SystemModel;
  result: GateResult;
  state: TickState;
  save: (s: Partial<TickState>) => Promise<void>;
  now: () => string;
};

async function redraw(r: RedrawInput): Promise<TickResult> {
  const forge = r.deps?.forge ?? ghForge;
  const runAgent = r.deps?.runAgent ?? commandAgent(r.deps);
  const wt = r.paths.worktree;
  const remoteRedraw = `refs/remotes/origin/${REDRAW_BRANCH}`;

  // Ask the forge before any model runs: a redraw that cannot be offered is not drawn.
  const openPr = await forge.findOpenPr({ cwd: r.root, head: REDRAW_BRANCH });
  // The redraw branch goes on from where it is on origin (an open pull request
  // gets more commits), with main merged in: it is never force-pushed.
  const onOrigin = await gitOk(r.root, ['fetch', '--quiet', 'origin', `+refs/heads/${REDRAW_BRANCH}:${remoteRedraw}`]);
  const interrupted = join(r.paths.failed, `interrupted-${r.now().replace(/[:.]/g, '-')}`);
  const setAsideNote = await prepareWorktree(r.root, wt, onOrigin ? remoteRedraw : r.target, onOrigin ? r.target : null, interrupted);
  if (setAsideNote) await r.save({ set_aside: `${r.now()}: ${setAsideNote}` });

  const prs = await mergedPrs(r.root, r.from, r.target, r.result.why.map((w) => w.path));
  const docs = unattendedDocs(r.setup.docs).allowed;
  const summaryPath = join(wt, SUMMARY_FILE);
  const prompt = updatePrompt({
    worktree: wt, from: r.from, to: r.target, prs, gate: r.result,
    reviews: await storedReviews(r.paths.reviews, r.model.sources?.repos.self?.repo, prs),
    summaryFile: summaryPath, docs,
  });
  const fail = async (error: string): Promise<TickResult> => {
    await setAside(wt, join(r.paths.failed, r.target)).catch(() => {});
    await r.save({ last_error: error, failed: r.target });
    return { ran: 'failed', gated: r.state.gated ?? '', error };
  };

  const dir = join(wt, DRAWING_DIR);
  // what this redraw starts from: main's drawing, or the open redraw's
  const before = (await load(dir)).model ?? r.model;
  const start = (await git(wt, ['rev-parse', 'HEAD'])).trim();
  // from here a model runs: any failure, a throw included, sets the work aside and waits for main to move
  try {
    const agent = await runAgent({ setup: r.setup, cwd: wt, prompt, docs });
    return await afterAgent(r, { agent, wt, dir, before, start, prs, summaryPath, openPr, forge, fail });
  } catch (e) {
    return fail((e as Error).message);
  }
}

async function afterAgent(
  r: RedrawInput,
  c: {
    agent: { ok: boolean; output: string }; wt: string; dir: string; before: SystemModel; start: string; prs: number[]; summaryPath: string;
    openPr: string | null; forge: Forge; fail: (error: string) => Promise<TickResult>;
  },
): Promise<TickResult> {
  const { agent, wt, dir, before, start, prs, summaryPath, openPr, forge, fail } = c;
  if (!agent.ok) return fail(`the agent did not finish: ${agent.output.trim().slice(-400) || 'no output'}`);
  const summary = (await readFile(summaryPath, 'utf8').catch(() => '')).trim();
  await unlink(summaryPath).catch(() => {});

  const committed = (await git(wt, ['rev-parse', 'HEAD'])).trim() !== start;
  if (!committed && !(await changedPaths(wt)).length) {
    // the agent read the change and the drawing stands
    await r.save({ gated: r.target, gated_at: r.now(), last_error: null, failed: null });
    return { ran: 'gated', gated: r.target, why: summary || 'the agent found nothing to change' };
  }
  await setDrawnAt(dir, r.target);
  const checked = await check({ dir, root: wt });
  const issues = [...checked.errors, ...checked.warnings].map((i) => `${i.file}${i.field ? ` ${i.field}` : ''}: ${i.message}`);
  issues.push(...checked.missing.map((m) => `missing: ${m}`));
  if (issues.length) return fail(`the redraw does not check clean: ${issues.slice(0, 5).join('; ')}`);

  // Everything the agent changed goes in the pull request for the person to
  // review, its own commits included; files outside the drawing are named.
  const title = `System: redraw for ${prs.length ? prs.map((n) => `PR ${n}`).join(', ') : r.target.slice(0, 7)}`;
  const uncommitted = (await changedPaths(wt)).filter((p) => p !== SUMMARY_FILE);
  if (uncommitted.length) {
    await git(wt, ['add', '-A', '--', ...uncommitted]);
    await git(wt, ['commit', '--quiet', '-m', title]);
  }
  const touched = (await git(wt, ['diff', '--name-only', '-z', '--no-renames', start, 'HEAD'])).split('\0').filter(Boolean);
  const also = touched.filter((p) => !p.startsWith(`${DRAWING_DIR}/`)).sort();
  const body = [
    summary || 'The drawing follows the code at the new commit.',
    '',
    `Main moved from ${r.from.slice(0, 7)} to ${r.target.slice(0, 7)}. The files that woke the check:`,
    ...r.result.why.map((w) => `- ${w.path} (${w.reason})`),
    ...(also.length ? ['', 'This redraw also changed files outside the drawing:', ...also.map((p) => `- ${p}`)] : []),
  ].join('\n');
  if (REDRAW_BRANCH === r.main) throw new Error('the redraw branch is the default branch; refusing to push');
  await git(wt, ['push', '--quiet', 'origin', `HEAD:refs/heads/${REDRAW_BRANCH}`]);
  const pr = openPr ?? (await forge.openPr({ cwd: wt, base: r.main, head: REDRAW_BRANCH, title, body }));

  const after = (await load(dir)).model;
  const note = redrawNote({ to: r.target, prs, summary, count: after ? changedCount(before, after) : { parts: 0, flows: 0 }, also, pr });
  const notify = r.deps?.notify ?? inboxNotify(r.deps?.plannotator ?? (await plannotatorProgram()));
  let noteError: string | null = null;
  await notify({ project: r.root, subject: `System: ${r.model.name}`, body: note, replyTo: r.setup.thread_message }).catch((e: Error) => {
    noteError = `the note was not sent: ${e.message}`;
  });
  await r.save({ gated: r.target, gated_at: r.now(), redrew_at: r.now(), redraw_pr: pr, last_error: noteError, failed: null });
  return { ran: 'redrew', gated: r.target, pr, note, ...(noteError ? { error: noteError } : {}) };
}
