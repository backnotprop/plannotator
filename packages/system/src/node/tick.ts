import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { access, cp, mkdir, open, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { redrawCommand } from '../agent/command.ts';
import { unattendedDocs } from '../agent/docs.ts';
import type { SystemSetup } from '../agent/setup.ts';
import { stillWanted } from '../format/status.ts';
import type { SystemModel } from '../format/types.ts';
import type { GateResult } from '../gate/gate.ts';
import { updatePrompt } from '../recipe/prompts.ts';
import { gateRepo } from './gate-repo.ts';
import { checkRef } from './git.ts';
import { check, load, readFiles } from './index.ts';
import { readSetup, readState, systemPaths, takeLock, writeState, type HeldLock, type TickState } from './state.ts';

export type TickResult = {
  ran: 'nothing' | 'gated' | 'redrew' | 'failed';
  gated: string;
  why?: string;
  note?: string;
  error?: string;
};

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
  /** The rename the swap of a checked redraw uses; node's unless given (the tests pass one that fails). */
  rename?: (from: string, to: string) => Promise<void>;
  /** How tick.lock is taken; `takeLock` unless given (the tests pass one that throws). */
  takeLock?: (path: string) => Promise<HeldLock | null>;
};

/** Why a tick stopped when another holder broke its tick.lock (a sleep or a pause made its heartbeat look stale). */
const LOST_LOCK = 'this tick lost tick.lock to another holder and stopped: it swapped and saved nothing after that';
class LostLock extends Error {}

export const TICK_TIMEOUTS_MS = { agent: 45 * 60_000, git: 5 * 60_000, note: 2 * 60_000 } as const;

export type Run = { code: number; stdout: string; stderr: string; timedOut: boolean };

const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`);

const KILL_GRACE_MS = 5000;

/** Stop a child and everything it started: its process group, or on Windows its process tree. */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, signal);
  } catch {
  }
}

const live = new Set<number>();
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
let stopping: NodeJS.Signals | null = null;
let exitWhenStopped: (() => void) | null = null;
let exitHooked = false;

function onStopSignal(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = signal;
  for (const pid of live) killGroup(pid, 'SIGTERM');
  const sole = process.listenerCount(signal) <= 1;
  const end = () => {
    for (const pid of live) killGroup(pid, 'SIGKILL');
    if (sole) process.exit(128 + (osConstants.signals[signal] ?? 0));
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

export function runCommand(argv: string[], o: { cwd: string; timeoutMs: number; stdin?: string | null; env?: Record<string, string>; keep?: number }): Promise<Run> {
  const keep = o.keep ?? 16 * 1024 * 1024;
  if (stopping) return Promise.resolve({ code: 1, stdout: '', stderr: `not started: the tick got ${stopping}`, timedOut: false });
  return new Promise((done) => {
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
    // A process that left the group can hold the pipes open after exit: give output a grace to arrive, then let go.
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

const failure = (name: string, r: Run, timeoutMs: number) =>
  r.timedOut ? `${name} was stopped after ${minutes(timeoutMs)} with no end` : `${name}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`;

// launchd has no terminal or editor. GIT_OPTIONAL_LOCKS=0 keeps a read from taking index.lock and failing the person's own commit.
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', GIT_OPTIONAL_LOCKS: '0', GIT_LFS_SKIP_SMUDGE: '1' };

const runGit = (cwd: string, args: string[], env?: Record<string, string>) =>
  runCommand(['git', '--no-optional-locks', '-C', cwd, ...args], { cwd, env: { ...GIT_ENV, ...env }, timeoutMs: TICK_TIMEOUTS_MS.git });

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

async function defaultBranch(root: string): Promise<string> {
  const head = (await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
  if (head.startsWith('origin/')) return head.slice('origin/'.length);
  for (const b of ['main', 'master']) if (await gitOk(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`])) return b;
  for (const b of ['main', 'master']) if (await gitOk(root, ['ls-remote', '--exit-code', '--heads', 'origin', b])) return b;
  throw new Error('no default branch: origin has no HEAD, main or master');
}

/**
 * A rename or copy counts under both its old and its new path, because the gate may name either
 * one.
 */
export async function mergedPrs(root: string, from: string, to: string, paths?: readonly string[]): Promise<number[]> {
  const out = await git(root, [
    'log', '--first-parent', '--diff-merges=first-parent', '--name-status', '-M', '-z', '--format=%x01%s', '--end-of-options',
    `${checkRef(from)}..${checkRef(to)}`,
  ]);
  const wanted = paths ? new Set(paths) : null;
  const prs = new Set<number>();
  for (const entry of out.split('\x01').slice(1)) {
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

const commandAgent = (deps: TickDeps | undefined): RunAgent => async ({ setup, cwd, prompt }) => {
  const { command, stdin } = (deps?.agentCommand ?? redrawCommand)(setup, prompt);
  const timeoutMs = deps?.agentTimeoutMs ?? TICK_TIMEOUTS_MS.agent;
  const r = await runCommand(command, { cwd, stdin, env: GIT_ENV, timeoutMs, keep: 64 * 1024 });
  if (r.timedOut) return { ok: false, output: `the agent was stopped after ${minutes(timeoutMs)} with no end` };
  return { ok: r.code === 0, output: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}` };
};

const inboxNotify = (plannotator: string): Notify => async ({ project, subject, body, replyTo }) => {
  const message = { body, project_path: project, ...(replyTo ? { reply_to: replyTo } : { subject }) };
  const r = await runCommand([plannotator, 'inbox', 'call', 'send_message', '-'], { cwd: project, stdin: JSON.stringify(message), env: { GIT_OPTIONAL_LOCKS: '0' }, timeoutMs: TICK_TIMEOUTS_MS.note });
  if (r.code !== 0 || r.timedOut) throw new Error(failure('plannotator inbox call send_message', r, TICK_TIMEOUTS_MS.note));
};

export async function plannotatorProgram(): Promise<string> {
  if (/^plannotator(?:\.exe)?$/.test(basename(process.execPath))) return process.execPath;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, 'plannotator');
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return realpath(candidate).catch(() => candidate);
  }
  return 'plannotator';
}

const remoteFrom = (root: string, url: string) => (/^\.\.?(\/|$)/.test(url) ? resolve(root, url) : url);

async function originUrl(root: string): Promise<string> {
  const configured = (await git(root, ['config', '--get-all', 'remote.origin.url']).catch(() => '')).split('\n')[0]!.trim();
  return remoteFrom(root, configured || (await git(root, ['remote', 'get-url', 'origin'])).trim());
}

const ACCESS_KEYS = '^(core\\.(sshcommand|askpass|gitproxy)|ssh\\.variant|credential\\..+|url\\..+|http\\..+)$';
const resetByEmpty = (key: string) => /^(credential\.(.+\.)?helper|http\.(.+\.)?extraheader)$/.test(key);
type ConfigEntry = { key: string; value: string | null };

async function remoteAccess(root: string): Promise<ConfigEntry[]> {
  const r = await runGit(root, ['config', '-z', '--get-regexp', ACCESS_KEYS]);
  if (r.timedOut || (r.code !== 0 && r.code !== 1)) throw new Error(failure('git config', r, TICK_TIMEOUTS_MS.git));
  return r.stdout.split('\0').filter(Boolean).map((e) => {
    const nl = e.indexOf('\n');
    return nl < 0 ? { key: e, value: null } : { key: e.slice(0, nl), value: e.slice(nl + 1) };
  });
}

// An empty value resets a git list: the clone must end with the person's list exactly, not the global list twice.
function accessList(entries: ConfigEntry[]): ConfigEntry[] {
  const byKey = new Map<string, (string | null)[]>();
  for (const e of entries) {
    if (!byKey.has(e.key)) byKey.set(e.key, []);
    byKey.get(e.key)!.push(e.value);
  }
  return [...byKey].flatMap(([key, values]) => [...(resetByEmpty(key) ? [{ key, value: '' }] : []), ...values.map((value) => ({ key, value }))]);
}

function accessEnv(entries: ConfigEntry[]): Record<string, string> {
  const base = Number(process.env.GIT_CONFIG_COUNT) || 0;
  const list = accessList(entries);
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(base + list.length) };
  list.forEach((e, i) => {
    env[`GIT_CONFIG_KEY_${base + i}`] = e.key;
    env[`GIT_CONFIG_VALUE_${base + i}`] = e.value ?? 'true';
  });
  return env;
}

function accessFile(entries: ConfigEntry[]): string {
  const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
  const lines = ['# Written by Plannotator System on every tick: the remote-access config of the project\'s repo. Edits here are replaced.'];
  for (const { key, value } of accessList(entries)) {
    const first = key.indexOf('.');
    const last = key.lastIndexOf('.');
    const sub = last > first ? key.slice(first + 1, last) : null;
    if (sub?.includes('\n')) continue;
    lines.push(sub === null ? `[${key.slice(0, first)}]` : `[${key.slice(0, first)} ${quote(sub)}]`);
    lines.push(value === null ? `\t${key.slice(last + 1)}` : `\t${key.slice(last + 1)} = ${quote(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

const ACCESS_CONFIG = 'plannotator-remote.config';

async function carryAccess(source: string, entries: ConfigEntry[]): Promise<void> {
  const file = join(source, '.git', ACCESS_CONFIG);
  const text = accessFile(entries);
  if ((await readFile(file, 'utf8').catch(() => null)) !== text) {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, file);
  }
  const included = (await git(source, ['config', '--local', '--get-all', 'include.path']).catch(() => '')).split('\n').map((l) => l.trim());
  if (!included.includes(ACCESS_CONFIG)) await git(source, ['config', '--local', '--add', 'include.path', ACCESS_CONFIG]);
}

async function pruneOld(dir: string, prefix: string, keep: number): Promise<void> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith(prefix)).sort();
  for (const n of names.slice(0, Math.max(0, names.length - keep))) await rm(join(dir, n), { recursive: true, force: true });
}

const KEEP_OLD_SOURCES = 2;

export async function prepareSource(root: string, source: string,
  o: { need?: (string | null | undefined)[]; aside?: string; stamp?: string } = {}): Promise<{ main: string; tip: string; recloned?: string }> {
  const url = await originUrl(root);
  const access = await remoteAccess(root);
  let recloned: string | undefined;
  let borrow = true;
  const damaged = async (fresh: boolean, why: string) => {
    if (fresh && borrow) {
      borrow = false;
      await rm(source, { recursive: true, force: true });
    } else if (!fresh && recloned === undefined && o.aside) {
      recloned = await moveAside(source, join(o.aside, `source-${o.stamp ?? new Date().toISOString().replace(/[:.]/g, '-')}`));
      await pruneOld(o.aside, 'source-', KEEP_OLD_SOURCES);
    } else {
      throw new Error(why);
    }
  };
  for (;;) {
    const fresh = !(await stat(join(source, '.git')).then(() => true, () => false));
    if (fresh) {
      await mkdir(dirname(source), { recursive: true, mode: 0o700 });
      const reference = borrow ? ['--reference', (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()] : [];
      const run = await runGit(dirname(source), ['clone', '--quiet', '--no-local', '--no-checkout', ...reference, '--', url, source], accessEnv(access));
      const cloned = run.code === 0 && !run.timedOut ? null : new Error(failure('git clone', run, TICK_TIMEOUTS_MS.git));
      if (cloned && borrow) { await damaged(true, cloned.message); continue; }
      if (cloned) throw cloned;
      await carryAccess(source, access);
    } else {
      if (!(await alternatesPresent(source))) { await damaged(false, 'the source clone lost the folder it borrows objects from'); continue; }
      await carryAccess(source, access);
      if ((await git(source, ['config', '--get', 'remote.origin.url']).catch(() => '')).trim() !== url) await git(source, ['remote', 'set-url', 'origin', url]);
    }
    const main = await defaultBranch(source);
    const fetched = await git(source, ['fetch', '--quiet', 'origin', `+refs/heads/${main}:refs/remotes/origin/${main}`]).then(() => null, (e: Error) => e);
    if (fetched) {
      const last = fresh ? null : await commitOf(source, `refs/remotes/origin/${main}`);
      if (last && !(await whole(source, last))) { await damaged(false, `the source clone is missing objects: ${fetched.message}`); continue; }
      throw fetched;
    }
    const tip = await commitOf(source, `refs/remotes/origin/${main}`);
    if (!tip) throw new Error(`origin has no ${main}`);
    const broken = (await whole(source, tip)) ? [] : [tip.slice(0, 7)];
    for (const c of o.need ?? []) {
      if (!c || !isRef(c) || (await whole(source, c))) continue;
      // A commit that is there but not whole lost objects; one that is missing did only if main's
      // history has a hole, otherwise origin itself lost it (rewritten): not the clone's fault.
      if (await gitOk(source, ['cat-file', '-e', `${c}^{commit}`]) || !(await gitOk(source, ['rev-list', '--quiet', tip]))) broken.push(c.slice(0, 7));
    }
    const since: string[] = [];
    for (const c of o.need ?? []) if (c && isRef(c) && (await gitOk(source, ['cat-file', '-e', `${c}^{commit}`]))) since.push(c);
    if (!broken.length && since.length && !(await gitOk(source, ['rev-list', '--objects', '--quiet', '--end-of-options', tip, ...since.map((c) => `^${c}`)]))) {
      broken.push(`${since.map((c) => c.slice(0, 7)).join(' ')}..${tip.slice(0, 7)}`);
    }
    if (broken.length) { await damaged(fresh, `the source clone cannot read ${broken.join(', ')} whole`); continue; }
    if (fresh) await git(source, ['checkout', '--quiet', '--force', '--detach', tip]);
    return recloned ? { main, tip, recloned } : { main, tip };
  }
}

async function alternatesPresent(source: string): Promise<boolean> {
  const list = await readFile(join(source, '.git', 'objects', 'info', 'alternates'), 'utf8').catch(() => '');
  for (const line of list.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
    if (!(await stat(isAbsolute(line) ? line : resolve(source, '.git', 'objects', line)).then((s) => s.isDirectory(), () => false))) return false;
  }
  return true;
}

const isRef = (c: string) => { try { checkRef(c); return true; } catch { return false; } };

const whole = (cwd: string, commit: string) => gitOk(cwd, ['rev-list', '--objects', '--no-walk', '--end-of-options', checkRef(commit)]);

async function dirty(wt: string): Promise<boolean> {
  return (await changedPaths(wt)).length > 0 || (await gitOk(wt, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']));
}

async function setAside(wt: string, into: string): Promise<void> {
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

async function moveAside(from: string, to: string): Promise<string> {
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  let dest = to;
  for (let n = 2; await stat(dest).then(() => true, () => false); n++) dest = `${to}-${n}`;
  await rename(from, dest);
  return dest;
}

async function resetSource(source: string, commit: string): Promise<void> {
  await runGit(source, ['merge', '--abort']);
  await git(source, ['checkout', '--quiet', '--force', '--detach', commit]);
  await git(source, ['clean', '--quiet', '-fd']);
}

async function setDrawnAt(dir: string, commit: string): Promise<void> {
  const file = join(dir, 'system.yaml');
  const text = await readFile(file, 'utf8');
  const node = parseDocument(text).getIn(['sources', 'repos', 'self', 'at'], true) as { value?: unknown; range?: [number, number, number] } | undefined;
  if (!node?.range || node.value === commit) return;
  await writeFile(file, `${text.slice(0, node.range[0])}"${commit}"${text.slice(node.range[1])}`);
}

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
  let release: HeldLock | null;
  try {
    release = await (o.deps?.takeLock ?? takeLock)(paths.lock);
  } catch (e) {
    // a file system the lock cannot be made on, a folder that cannot be written: recorded, never thrown
    const before = await readState(o.dataDir, o.key);
    const error = `tick.lock could not be taken: ${(e as Error).message}`;
    await writeState(o.dataDir, o.key, { ...before, last_error: error }).catch(() => {});
    return { ran: 'failed', gated: before.gated ?? '', error };
  }
  if (!release) return { ran: 'nothing', gated: '', why: 'another tick is running' };
  const lock = release;
  const now = () => (o.now ?? new Date()).toISOString();
  const state = await readState(o.dataDir, o.key);
  /** Throws LostLock when another holder has broken this tick's lock: what follows must not touch the shared folders. */
  const holding = async () => {
    if (!(await lock.check())) throw new LostLock(LOST_LOCK);
  };
  let current = state;
  const save = async (s: Partial<TickState>) => {
    await holding();
    current = { ...current, ...s };
    await writeState(o.dataDir, o.key, current);
  };
  try {
    await restoreDrawing(paths);
    const model = (await load(paths.drawing)).model;
    if (!model) return { ran: 'nothing', gated: '', why: 'no drawing yet' };
    // A first draw lists sheets under wanted: while drawing; a redraw would copy it half drawn over the drawing agent.
    if (stillWanted(model).length) return { ran: 'nothing', gated: state.gated ?? '', why: 'the drawing is still being drawn: system.yaml lists sheets under wanted:' };
    const stamp = now().replace(/[:.]/g, '-');
    const { tip: target, recloned } = await prepareSource(o.root, paths.source,
      { need: [model.sources?.repos.self?.at, state.gated], aside: paths.failed, stamp });
    if (recloned) await save({ set_aside: `${now()}: the source clone could not read the objects it borrows from the project's repo; it was cloned again and the old one kept in ${recloned}` });
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
    return await redraw({ ...o, setup, paths, from, target, model, result, state, save, now, holding });
  } catch (e) {
    if (e instanceof LostLock) return { ran: 'failed', gated: state.gated ?? '', error: LOST_LOCK };
    const error = (e as Error).message;
    await save({ last_error: error }).catch(() => {});
    return { ran: 'failed', gated: state.gated ?? '', error };
  } finally {
    await release();
  }
}

async function swapIn(paths: ReturnType<typeof systemPaths>, move: (from: string, to: string) => Promise<void> = rename): Promise<void> {
  await syncTree(paths.redraw);
  await rm(paths.previous, { recursive: true, force: true });
  await move(paths.drawing, paths.previous);
  try {
    await move(paths.redraw, paths.drawing);
  } catch (e) {
    // the second rename failed (on Windows a file held open in redraw/: EBUSY, EPERM): put the drawing back
    // before the failure sets redraw/ aside, or no drawing would be left
    const first = e as Error;
    try {
      await move(paths.previous, paths.drawing);
    } catch (back) {
      throw new AggregateError([first, back], `${first.message}; moving the drawing back from previous/ also failed: ${(back as Error).message}`);
    }
    throw first;
  }
  await syncPath(paths.dir, 'r');
}

/** fsync one file or folder; where the platform cannot (a folder on Windows), nothing. */
async function syncPath(path: string, flags: 'r' | 'r+'): Promise<void> {
  const fh = await open(path, flags).catch(() => null);
  if (!fh) return;
  await fh.sync().catch(() => {});
  await fh.close().catch(() => {});
}

async function syncTree(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isDirectory()) await syncTree(join(dir, e.name));
    else if (e.isFile()) await syncPath(join(dir, e.name), 'r+');
  }
  await syncPath(dir, 'r');
}

async function restoreDrawing(paths: ReturnType<typeof systemPaths>): Promise<void> {
  const exists = (p: string) => stat(p).then(() => true, () => false);
  if (!(await exists(paths.drawing)) && (await exists(paths.previous)) && (await exists(paths.redraw))) await rename(paths.previous, paths.drawing);
}

type RedrawInput = {
  holding: () => Promise<void>;
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

  await r.holding();
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
    if (!(await r.holding().then(() => true, () => false))) return { ran: 'failed', gated: r.state.gated ?? '', error: LOST_LOCK };
    const into = join(r.paths.failed, r.target);
    await moveAside(work, join(into, 'drawing')).catch(() => {});
    await setAside(source, join(into, 'source')).catch(() => {});
    await resetSource(source, r.target).catch(() => {});
    await r.save({ last_error: error, failed: r.target });
    return { ran: 'failed', gated: r.state.gated ?? '', error };
  };

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
  // The agent is the long step: a lock lost meanwhile must be found before redraw/ or source/ is touched again.
  await r.holding();
  const { agent, prs, fail } = c;
  const { source, drawing, redraw: work, summary: summaryPath } = r.paths;
  if (!agent.ok) return fail(`the agent did not finish: ${agent.output.trim().slice(-400) || 'no output'}`);
  const summary = (await readFile(summaryPath, 'utf8').catch(() => '')).trim();
  await unlink(summaryPath).catch(() => {});

  const head = (await git(source, ['rev-parse', 'HEAD'])).trim();
  const committed = head === r.target ? [] : (await git(source, ['diff', '--name-only', '-z', '--no-renames', r.target, head])).split('\0').filter(Boolean);
  const also = [...new Set([...committed, ...(await changedPaths(source))])].sort();
  if (also.length) await setAside(source, join(r.paths.changed, r.target));
  await resetSource(source, r.target);

  const same = JSON.stringify((await readFiles(work)).files) === JSON.stringify((await readFiles(drawing)).files);
  if (same) {
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

  const after = (await load(work)).model;
  await r.holding();
  await swapIn(r.paths, r.deps?.rename);

  const note = redrawNote({ to: r.target, prs, summary, count: after ? changedCount(r.model, after) : { parts: 0, flows: 0 }, also });
  const notify = r.deps?.notify ?? inboxNotify(r.deps?.plannotator ?? (await plannotatorProgram()));
  let noteError: string | null = null;
  await notify({ project: r.root, subject: `System: ${r.model.name}`, body: note, replyTo: r.setup.thread_message }).catch((e: Error) => {
    noteError = `the note was not sent: ${e.message}`;
  });
  await r.save({ gated: r.target, gated_at: r.now(), redrew_at: r.now(), last_error: noteError, failed: null });
  return { ran: 'redrew', gated: r.target, note, ...(noteError ? { error: noteError } : {}) };
}
