// One scheduled check of one project (`plannotator system tick`, run by
// launchd every SYSTEM_TICK_INTERVAL_SECONDS while the Mac is awake):
//
//   1. bring the source clone up to date: fetch the default branch from the
//      project's remote (the person's own git credentials);
//   2. diff from the last commit the drawing is right for to the new tip;
//   3. gate: no wake, write the gated commit and stop (most ticks: no model);
//   4. wake: put the source clone at the new tip, copy the drawing, run the
//      person's agent headless with recipe/UPDATE.md on the copy, check it;
//   5. put the checked copy in place as the drawing and send one note.
//
// Owner ruling 2026-11-06 (row 7689, q-122e6577): the drawing lives in
// Plannotator's own folder (`<dataDir>/system/<key>/drawing/`). System never
// commits, branches or pushes in the person's repo, and writes nothing in
// their checkout or its .git: it reads the repo's remote URL and history, and
// keeps its own clone of the code in `<dataDir>/system/<key>/source/`. The
// agent runs there as it normally does, with its full tools (owner ruling
// 2026-11-06: no limits on agents); files it changed there are named in the
// note, kept under changed/, and the clone is put back for the next run.
// Every child the tick starts itself has a time bound, so a hung agent, git,
// hook or note cannot hold the schedule, and a tick that is stopped (Ctrl-C,
// `schedule remove`) stops its children too. The agent and the note are
// injectable so the whole path runs in tests with no model and no network.
//
// TODO(System B9, Ops' Inbox side): a stuck tick (a fetch that fails, a time
// bound hit) and a set-aside redraw are recorded only in state.json
// (`last_error`, `set_aside`). The Inbox's System thread should surface
// them; that is a follow-up on the Inbox side.
import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { access, cp, mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { redrawCommand } from '../agent/command.ts';
import { unattendedDocs } from '../agent/docs.ts';
import type { SystemSetup } from '../agent/setup.ts';
import type { SystemModel } from '../format/types.ts';
import type { GateResult } from '../gate/gate.ts';
import { updatePrompt } from '../recipe/prompts.ts';
import { gateRepo } from './gate-repo.ts';
import { checkRef } from './git.ts';
import { check, load, readFiles } from './index.ts';
import { readSetup, readState, systemPaths, takeLock, writeState, type TickState } from './state.ts';

export type TickResult = {
  /**
   * nothing: nothing to do (no new commit, no drawing yet, not set up,
   * another tick running, or waiting after a failed redraw); gated: the gate
   * ran and the drawing stands; redrew: the drawing was redrawn in place and
   * a note sent; failed: see `error`.
   */
  ran: 'nothing' | 'gated' | 'redrew' | 'failed';
  /** The commit of the default branch this tick is done with, or '' when none. */
  gated: string;
  /** Why nothing ran, in a few words. */
  why?: string;
  /** The note sent to the Inbox. */
  note?: string;
  error?: string;
};

/**
 * One redraw run: `cwd` is the source clone, `drawing` the copy of the
 * drawing to edit and `summaryFile` where its sentences go; the prompt names
 * all three.
 */
export type RunAgent = (o: { setup: SystemSetup; cwd: string; drawing: string; summaryFile: string; prompt: string; docs: string[] }) => Promise<{ ok: boolean; output: string }>;
export type Notify = (o: { project: string; subject: string; body: string; replyTo: string | null }) => Promise<void>;
export type TickDeps = {
  runAgent?: RunAgent;
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
 * in state.json, so a hung agent, a git credential prompt that waits for a
 * person, a stalled network or a note that never goes cannot keep the job
 * running, which would stop launchd from starting it again.
 */
export const TICK_TIMEOUTS_MS = { agent: 45 * 60_000, git: 5 * 60_000, note: 2 * 60_000 } as const;

export type Run = { code: number; stdout: string; stderr: string; timedOut: boolean };

const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`);

/** How long a stopped child gets after SIGTERM before SIGKILL, and how long its pipes may stay open after it ends. */
const KILL_GRACE_MS = 5000;

/** Stop a child and everything it started: its process group, or on Windows its process tree. */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

// The children running now, by pid. Each runs in its own process group, so
// a signal to the tick does not reach them by itself: while any runs, the tick
// passes SIGINT, SIGTERM and SIGHUP on to every group, and SIGKILLs them at exit.
const live = new Set<number>();
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
let stopping: NodeJS.Signals | null = null;
let exitWhenStopped: (() => void) | null = null;
let exitHooked = false;

function onStopSignal(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = signal;
  for (const pid of live) killGroup(pid, 'SIGTERM');
  // with no other listener the signal would have ended the process: end it,
  // once the children are gone or the grace runs out
  const sole = process.listenerCount(signal) <= 1;
  const end = () => {
    for (const pid of live) killGroup(pid, 'SIGKILL');
    if (sole) process.exit(128 + (osConstants.signals[signal] ?? 0));
    // another listener kept the process: it may start commands again
    stopping = null;
    exitWhenStopped = null;
    if (!live.size) for (const s of STOP_SIGNALS) process.off(s, onStopSignal);
  };
  const hard = setTimeout(end, KILL_GRACE_MS);
  if (!sole) hard.unref();
  exitWhenStopped = () => {
    clearTimeout(hard);
    end();
  };
}

function track(pid: number): void {
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', () => {
      for (const p of live) killGroup(p, 'SIGKILL');
    });
  }
  if (!live.size && !stopping) for (const s of STOP_SIGNALS) process.on(s, onStopSignal);
  live.add(pid);
}

function untrack(pid: number): void {
  if (!live.delete(pid) || live.size) return;
  if (stopping) exitWhenStopped?.();
  else for (const s of STOP_SIGNALS) process.off(s, onStopSignal);
}

/**
 * Run one command to the end, or until `timeoutMs`: then its process group
 * (it and everything it started) is stopped and `timedOut` is set. Output past
 * `keep` bytes keeps only its tail. It returns once the command has ended and
 * its pipes are closed, or KILL_GRACE_MS after it ended when something that
 * left its group still holds them.
 */
export function runCommand(argv: string[], o: { cwd: string; timeoutMs: number; stdin?: string | null; env?: Record<string, string>; keep?: number }): Promise<Run> {
  const keep = o.keep ?? 16 * 1024 * 1024;
  if (stopping) return Promise.resolve({ code: 1, stdout: '', stderr: `not started: the tick got ${stopping}`, timedOut: false });
  return new Promise((done) => {
    // its own process group, so a stop reaches what it started too
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
    });
    const pid = child.pid;
    if (pid) track(pid);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let ended = false;
    const group = (signal: NodeJS.Signals) => {
      if (pid) killGroup(pid, signal);
    };
    let hard: ReturnType<typeof setTimeout> | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      group('SIGTERM');
      hard = setTimeout(() => group('SIGKILL'), KILL_GRACE_MS);
    }, o.timeoutMs);
    const tail = (s: string) => (s.length > keep ? s.slice(-keep) : s);
    child.stdout.on('data', (d: Buffer) => (stdout = tail(stdout + d.toString('utf8'))));
    child.stderr.on('data', (d: Buffer) => (stderr = tail(stderr + d.toString('utf8'))));
    const finish = (r: Omit<Run, 'timedOut'>) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      clearTimeout(hard);
      clearTimeout(drain);
      if (timedOut) group('SIGKILL');
      if (pid) untrack(pid);
      done({ ...r, timedOut });
    };
    child.on('error', (e) => finish({ code: 127, stdout, stderr: stderr + e.message }));
    child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
    // a process that left the group can hold the pipes open after the command
    // ended: give the output a grace to arrive, then let the pipes go
    child.on('exit', (code) => {
      drain = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ code: code ?? 1, stdout, stderr });
      }, KILL_GRACE_MS);
    });
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
  if (r.code !== 0 || r.timedOut) throw new Error(failure(`git ${args[0]}`, r, TICK_TIMEOUTS_MS.git));
  return r.stdout;
}
const gitOk = async (cwd: string, args: string[]) => {
  const r = await runGit(cwd, args);
  return r.code === 0 && !r.timedOut;
};
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
 * agent's sentences> 1 part changed. This redraw also changed: <files the
 * agent changed in the source clone>."
 */
export function redrawNote(o: { to: string; prs: number[]; summary: string; count: { parts: number; flows: number }; also?: string[] }): string {
  const words = [`Main moved to ${o.to.slice(0, 7)}.`];
  const summary = o.summary.replace(/\s+/g, ' ').trim();
  const said = summary && !/[.!?]$/.test(summary) ? `${summary}.` : summary;
  if (o.prs.length) words.push(`${o.prs.length === 1 ? 'PR' : 'PRs'} ${o.prs.join(', ')} landed${said ? ':' : '.'}`);
  if (said) words.push(said);
  const { parts, flows } = o.count;
  if (parts && flows) words.push(`${plural(parts, 'part')} and ${plural(flows, 'line')} changed.`);
  else if (parts || flows) words.push(`${parts ? plural(parts, 'part') : plural(flows, 'line')} changed.`);
  if (o.also?.length) words.push(`This redraw also changed: ${o.also.join(', ')}.`);
  return words.join(' ');
}

/** The default agent: the person's own agent CLI, headless, in the source clone, within its time bound. */
const commandAgent = (deps: TickDeps | undefined): RunAgent => async ({ setup, cwd, prompt }) => {
  const { command, stdin } = (deps?.agentCommand ?? redrawCommand)(setup, prompt);
  const timeoutMs = deps?.agentTimeoutMs ?? TICK_TIMEOUTS_MS.agent;
  const r = await runCommand(command, { cwd, stdin, env: GIT_ENV, timeoutMs, keep: 64 * 1024 });
  if (r.timedOut) return { ok: false, output: `the agent was stopped after ${minutes(timeoutMs)} with no end` };
  return { ok: r.code === 0, output: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}` };
};

/** The default note: `plannotator inbox call send_message`, the JSON on stdin. */
const inboxNotify = (plannotator: string): Notify => async ({ project, subject, body, replyTo }) => {
  const message = { body, project_path: project, ...(replyTo ? { reply_to: replyTo } : { subject }) };
  const r = await runCommand([plannotator, 'inbox', 'call', 'send_message', '-'], { cwd: project, stdin: JSON.stringify(message), timeoutMs: TICK_TIMEOUTS_MS.note });
  if (r.code !== 0 || r.timedOut) throw new Error(failure('plannotator inbox call send_message', r, TICK_TIMEOUTS_MS.note));
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

/** A remote URL as git reads it from `root`: a relative local path is made absolute against the repo. */
const remoteFrom = (root: string, url: string) => (/^\.\.?(\/|$)/.test(url) ? resolve(root, url) : url);

/**
 * Plannotator's own clone of the project, for the agent to read main's code:
 * `<dataDir>/system/<key>/source`. Made when missing with
 * `git clone --reference <the repo's git folder> <its origin URL>`, so the
 * objects the person already has are borrowed, not copied, and fetched from
 * origin each tick, so the tick sees what merged even when the person has not
 * fetched. Toward the person's repo it only reads: its origin URL, its git
 * folder and its objects. Returns the default branch and its tip.
 */
export async function prepareSource(root: string, source: string): Promise<{ main: string; tip: string }> {
  const url = remoteFrom(root, (await git(root, ['remote', 'get-url', 'origin'])).trim());
  const fresh = !(await stat(join(source, '.git')).then(() => true, () => false));
  if (fresh) {
    const objects = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    await mkdir(dirname(source), { recursive: true, mode: 0o700 });
    await git(dirname(source), ['clone', '--quiet', '--no-checkout', '--reference', objects, '--', url, source]);
  } else if ((await git(source, ['remote', 'get-url', 'origin']).catch(() => '')).trim() !== url) {
    await git(source, ['remote', 'set-url', 'origin', url]);
  }
  const main = await defaultBranch(source);
  await git(source, ['fetch', '--quiet', 'origin', `+refs/heads/${main}:refs/remotes/origin/${main}`]);
  const tip = await commitOf(source, `refs/remotes/origin/${main}`);
  if (!tip) throw new Error(`origin has no ${main}`);
  // a fresh clone has no checkout yet; a later one keeps what it has until a redraw resets it
  if (fresh) await git(source, ['checkout', '--quiet', '--force', '--detach', tip]);
  return { main, tip };
}

/** True when a git checkout has changes (tracked or untracked) or a half-done merge. */
async function dirty(wt: string): Promise<boolean> {
  return (await changedPaths(wt)).length > 0 || (await gitOk(wt, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']));
}

/**
 * Keep every changed file of a checkout under `into` (its own path below it),
 * then put the checkout back to its last commit, so nothing the agent wrote
 * is lost and the next run starts clean.
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

/** Move a folder to `to`, or beside it with a number when `to` is taken. */
async function moveAside(from: string, to: string): Promise<string> {
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  let dest = to;
  for (let n = 2; await stat(dest).then(() => true, () => false); n++) dest = `${to}-${n}`;
  await rename(from, dest);
  return dest;
}

/** The source clone back at `commit`, clean, detached: how every redraw starts and ends. */
async function resetSource(source: string, commit: string): Promise<void> {
  await runGit(source, ['merge', '--abort']);
  await git(source, ['checkout', '--quiet', '--force', '--detach', commit]);
  await git(source, ['clean', '--quiet', '-fd']);
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
  try {
    const model = (await load(paths.drawing)).model;
    if (!model) return { ran: 'nothing', gated: '', why: 'no drawing yet' };
    const { tip: target } = await prepareSource(o.root, paths.source);
    const source = paths.source;

    const drawnAt = model.sources?.repos.self?.at ? await commitOf(source, model.sources.repos.self.at) : null;
    const gated = state.gated ? await commitOf(source, state.gated) : null;
    const from = await newer(source, drawnAt, gated);
    if (!from) throw new Error(`the drawing's commit ${model.sources?.repos.self?.at ?? '(none)'} is not in the project's history`);
    if (from === target || (await gitOk(source, ['merge-base', '--is-ancestor', target, from]))) {
      return { ran: 'nothing', gated: from, why: 'main has not moved' };
    }
    if (state.failed === target) return { ran: 'nothing', gated: state.gated ?? '', why: `the last redraw for ${target.slice(0, 7)} failed; waiting for main to move` };

    const result: GateResult = await gateRepo({ root: source, from, to: target, model });
    if (!result.wake) {
      await save({ gated: target, gated_at: now(), last_error: null, failed: null });
      return { ran: 'gated', gated: target };
    }
    return await redraw({ ...o, setup, paths, from, target, model, result, state, save, now });
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
  from: string;
  target: string;
  model: SystemModel;
  result: GateResult;
  state: TickState;
  save: (s: Partial<TickState>) => Promise<void>;
  now: () => string;
};

async function redraw(r: RedrawInput): Promise<TickResult> {
  const runAgent = r.deps?.runAgent ?? commandAgent(r.deps);
  const { source, drawing, redraw: work, summary: summaryPath } = r.paths;

  // A redraw cut off before it ended (a reboot, a logout, a kill) left its
  // copy of the drawing, and maybe changes in the source clone: both are set
  // aside, the last good drawing stays, and this redraw goes on.
  const interrupted = join(r.paths.failed, `interrupted-${r.now().replace(/[:.]/g, '-')}`);
  const kept: string[] = [];
  if (await stat(work).then(() => true, () => false)) kept.push(await moveAside(work, join(interrupted, 'drawing')));
  if (await dirty(source)) {
    await setAside(source, join(interrupted, 'source'));
    kept.push(join(interrupted, 'source'));
  }
  if (kept.length) await r.save({ set_aside: `${r.now()}: a redraw was cut off before it ended; what it left is kept in ${kept.join(' and ')}` });
  await resetSource(source, r.target);
  await cp(drawing, work, { recursive: true });
  await unlink(summaryPath).catch(() => {});

  const prs = await mergedPrs(source, r.from, r.target, r.result.why.map((w) => w.path));
  const docs = unattendedDocs(r.setup.docs).allowed;
  const prompt = updatePrompt({
    source, drawing: work, from: r.from, to: r.target, prs, gate: r.result,
    reviews: await storedReviews(r.paths.reviews, r.model.sources?.repos.self?.repo, prs),
    summaryFile: summaryPath, docs,
  });
  const fail = async (error: string): Promise<TickResult> => {
    // the drawing stays as it was; the agent's copy and its changes are kept
    const into = join(r.paths.failed, r.target);
    await moveAside(work, join(into, 'drawing')).catch(() => {});
    await setAside(source, join(into, 'source')).catch(() => {});
    await resetSource(source, r.target).catch(() => {});
    await r.save({ last_error: error, failed: r.target });
    return { ran: 'failed', gated: r.state.gated ?? '', error };
  };

  // from here a model runs: any failure, a throw included, sets the work aside and waits for main to move
  try {
    const agent = await runAgent({ setup: r.setup, cwd: source, drawing: work, summaryFile: summaryPath, prompt, docs });
    return await afterAgent(r, { agent, prs, fail });
  } catch (e) {
    return fail((e as Error).message);
  }
}

async function afterAgent(
  r: RedrawInput,
  c: { agent: { ok: boolean; output: string }; prs: number[]; fail: (error: string) => Promise<TickResult> },
): Promise<TickResult> {
  const { agent, prs, fail } = c;
  const { source, drawing, redraw: work, summary: summaryPath } = r.paths;
  if (!agent.ok) return fail(`the agent did not finish: ${agent.output.trim().slice(-400) || 'no output'}`);
  const summary = (await readFile(summaryPath, 'utf8').catch(() => '')).trim();
  await unlink(summaryPath).catch(() => {});

  // what the agent changed in the source clone, its own commits included
  const head = (await git(source, ['rev-parse', 'HEAD'])).trim();
  const committed = head === r.target ? [] : (await git(source, ['diff', '--name-only', '-z', '--no-renames', r.target, head])).split('\0').filter(Boolean);
  const also = [...new Set([...committed, ...(await changedPaths(source))])].sort();
  if (also.length) await setAside(source, join(r.paths.changed, r.target));
  await resetSource(source, r.target);

  const same = JSON.stringify((await readFiles(work)).files) === JSON.stringify((await readFiles(drawing)).files);
  if (same) {
    // the agent read the change and the drawing stands
    await rm(work, { recursive: true, force: true });
    await r.save({ gated: r.target, gated_at: r.now(), last_error: null, failed: null });
    const why = summary || 'the agent found nothing to change';
    return { ran: 'gated', gated: r.target, why: also.length ? `${why} (it also changed ${also.join(', ')}, kept in ${join(r.paths.changed, r.target)})` : why };
  }
  await setDrawnAt(work, r.target);
  const checked = await check({ dir: work, root: source });
  const issues = [...checked.errors, ...checked.warnings].map((i) => `${i.file}${i.field ? ` ${i.field}` : ''}: ${i.message}`);
  issues.push(...checked.missing.map((m) => `missing: ${m}`));
  if (issues.length) return fail(`the redraw does not check clean: ${issues.slice(0, 5).join('; ')}`);

  // the checked copy becomes the drawing; the one before it is kept as previous/
  const after = (await load(work)).model;
  await rm(r.paths.previous, { recursive: true, force: true });
  await rename(drawing, r.paths.previous);
  await rename(work, drawing);

  const note = redrawNote({ to: r.target, prs, summary, count: after ? changedCount(r.model, after) : { parts: 0, flows: 0 }, also });
  const notify = r.deps?.notify ?? inboxNotify(r.deps?.plannotator ?? (await plannotatorProgram()));
  let noteError: string | null = null;
  await notify({ project: r.root, subject: `System: ${r.model.name}`, body: note, replyTo: r.setup.thread_message }).catch((e: Error) => {
    noteError = `the note was not sent: ${e.message}`;
  });
  await r.save({ gated: r.target, gated_at: r.now(), redrew_at: r.now(), last_error: noteError, failed: null });
  return { ran: 'redrew', gated: r.target, note, ...(noteError ? { error: noteError } : {}) };
}
