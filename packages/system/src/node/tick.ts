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
// agent, the forge (gh) and the note are injectable so the whole path runs in
// tests with no model, no network and no real gh.
import { spawn } from 'node:child_process';
import { cp, mkdir, readdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
export type TickDeps = { runAgent?: RunAgent; forge?: Forge; notify?: Notify; plannotator?: string };

type Run = { code: number; stdout: string; stderr: string };

/** Run one command to the end. Output past `keep` bytes keeps only its tail. */
function run(argv: string[], o: { cwd: string; stdin?: string | null; env?: Record<string, string>; keep?: number }): Promise<Run> {
  const keep = o.keep ?? 16 * 1024 * 1024;
  return new Promise((done) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const tail = (s: string) => (s.length > keep ? s.slice(-keep) : s);
    child.stdout.on('data', (d: Buffer) => (stdout = tail(stdout + d.toString('utf8'))));
    child.stderr.on('data', (d: Buffer) => (stderr = tail(stderr + d.toString('utf8'))));
    child.on('error', (e) => done({ code: 127, stdout, stderr: stderr + e.message }));
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(o.stdin ?? '');
  });
}

/** git that never asks for a password or opens an editor: launchd has no terminal. */
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' };

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await run(['git', '-C', cwd, ...args], { cwd, env: GIT_ENV });
  if (r.code !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}
const gitOk = async (cwd: string, args: string[]) => (await run(['git', '-C', cwd, ...args], { cwd, env: GIT_ENV })).code === 0;
const commitOf = async (cwd: string, ref: string) => (await git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${checkRef(ref)}^{commit}`]).catch(() => '')).trim() || null;

/** The default branch's name, from origin/HEAD, else main or master. */
async function defaultBranch(root: string): Promise<string> {
  const head = (await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
  if (head.startsWith('origin/')) return head.slice('origin/'.length);
  for (const b of ['main', 'master']) if (await gitOk(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`])) return b;
  for (const b of ['main', 'master']) if (await gitOk(root, ['ls-remote', '--exit-code', '--heads', 'origin', b])) return b;
  throw new Error('no default branch: origin has no HEAD, main or master');
}

/** Pull request numbers named by the first-parent commits in a range: "Merge pull request #n" and a squash's "(#n)". */
export async function mergedPrs(root: string, from: string, to: string): Promise<number[]> {
  const out = await git(root, ['log', '--first-parent', '--format=%s', '--end-of-options', `${checkRef(from)}..${checkRef(to)}`]);
  const prs = new Set<number>();
  for (const line of out.split('\n')) {
    const m = /^Merge pull request #(\d+)\b/.exec(line) ?? /\(#(\d+)\)\s*$/.exec(line);
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

/** The note a redraw sends: "Main moved to 9c41e07. PR 1335 landed: <the agent's sentences> 1 part changed. Redraw: <link>" */
export function redrawNote(o: { to: string; prs: number[]; summary: string; count: { parts: number; flows: number }; pr: string | null }): string {
  const words = [`Main moved to ${o.to.slice(0, 7)}.`];
  const summary = o.summary.replace(/\s+/g, ' ').trim();
  const said = summary && !/[.!?]$/.test(summary) ? `${summary}.` : summary;
  if (o.prs.length) words.push(`${o.prs.length === 1 ? 'PR' : 'PRs'} ${o.prs.join(', ')} landed${said ? ':' : '.'}`);
  if (said) words.push(said);
  const { parts, flows } = o.count;
  if (parts && flows) words.push(`${plural(parts, 'part')} and ${plural(flows, 'line')} changed.`);
  else if (parts || flows) words.push(`${parts ? plural(parts, 'part') : plural(flows, 'line')} changed.`);
  if (o.pr) words.push(`Redraw: ${o.pr}`);
  return words.join(' ');
}

/** The default agent: the person's own agent CLI, headless, in the worktree. */
const defaultRunAgent: RunAgent = async ({ setup, cwd, prompt, docs }) => {
  const { command, stdin } = redrawCommand(setup, prompt, { docs });
  const r = await run(command, { cwd, stdin, keep: 64 * 1024 });
  return { ok: r.code === 0, output: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}` };
};

/** The default forge: the GitHub CLI with the person's own sign-in. */
const ghForge: Forge = {
  async findOpenPr({ cwd, head }) {
    const r = await run(['gh', 'pr', 'list', '--head', head, '--state', 'open', '--json', 'url', '--limit', '1'], { cwd, env: { GH_PROMPT_DISABLED: '1' } });
    if (r.code !== 0) throw new Error(`gh pr list: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
    const rows = JSON.parse(r.stdout || '[]') as { url?: string }[];
    return rows[0]?.url ?? null;
  },
  async openPr({ cwd, base, head, title, body }) {
    const r = await run(['gh', 'pr', 'create', '--base', base, '--head', head, '--title', title, '--body-file', '-'], { cwd, stdin: body, env: { GH_PROMPT_DISABLED: '1' } });
    if (r.code !== 0) throw new Error(`gh pr create: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
    return r.stdout.trim().split('\n').pop()!.trim();
  },
};

/** The default note: `plannotator inbox call send_message`, the JSON on stdin. */
const inboxNotify = (plannotator: string): Notify => async ({ project, subject, body, replyTo }) => {
  const message = { body, project_path: project, ...(replyTo ? { reply_to: replyTo } : { subject }) };
  const r = await run([plannotator, 'inbox', 'call', 'send_message', '-'], { cwd: project, stdin: JSON.stringify(message) });
  if (r.code !== 0) throw new Error(`plannotator inbox call send_message: ${r.stderr.trim() || `exit ${r.code}`}`);
};

/** The same folder, after symlinks: macOS's /var and /private/var are one folder. */
const same = async (a: string, b: string) => (await realpath(a).catch(() => resolve(a))) === (await realpath(b).catch(() => resolve(b)));

/**
 * Put the drawing's worktree on the redraw branch at `base`, then merge
 * `merge` into it when given. Made when missing; an existing one must be a
 * clean worktree of this repo, or it is left alone.
 */
async function prepareWorktree(root: string, wt: string, base: string, merge: string | null): Promise<void> {
  const exists = await stat(wt).then(() => true, () => false);
  if (!exists) {
    await mkdir(dirname(wt), { recursive: true, mode: 0o700 });
    await git(root, ['worktree', 'add', '-B', REDRAW_BRANCH, wt, base]);
  } else {
    const common = (await git(wt, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => '')).trim();
    const own = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    if (!common || !(await same(common, own))) throw new Error(`${wt} is not a worktree of ${root}`);
    if ((await changedPaths(wt)).length) throw new Error(`the drawing's worktree ${wt} has uncommitted changes; the check leaves it alone`);
    await git(wt, ['checkout', '--quiet', '-B', REDRAW_BRANCH, base]);
  }
  if (merge && !(await gitOk(wt, ['merge-base', '--is-ancestor', merge, 'HEAD']))) {
    const r = await run(['git', '-C', wt, 'merge', '--no-edit', '--quiet', merge], { cwd: wt, env: GIT_ENV });
    if (r.code !== 0) {
      await run(['git', '-C', wt, 'merge', '--abort'], { cwd: wt, env: GIT_ENV });
      throw new Error(`the redraw branch does not merge with ${merge}: ${(r.stderr || r.stdout).trim()}`);
    }
  }
}

/**
 * Keep what a refused redraw left (every changed file, under
 * `<failed>/<commit>/`), then put the worktree back to its last commit, so the
 * next redraw starts clean and nothing the agent wrote is lost.
 */
async function setAside(wt: string, into: string): Promise<void> {
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

/** Set sources.repos.self.at in system.yaml, keeping the rest of the file as it is written. */
async function setDrawnAt(dir: string, commit: string): Promise<void> {
  const file = join(dir, 'system.yaml');
  const doc = parseDocument(await readFile(file, 'utf8'));
  if (doc.getIn(['sources', 'repos', 'self', 'at']) === commit) return;
  doc.setIn(['sources', 'repos', 'self', 'at'], commit);
  await writeFile(file, doc.toString());
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
  const save = (s: Partial<TickState>) => writeState(o.dataDir, o.key, { ...state, ...s });
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
    const error = (e as Error).message;
    await save({ last_error: error, ...(target ? { failed: target } : {}) }).catch(() => {});
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
  const runAgent = r.deps?.runAgent ?? defaultRunAgent;
  const notify = r.deps?.notify ?? inboxNotify(r.deps?.plannotator ?? 'plannotator');
  const wt = r.paths.worktree;
  const remoteRedraw = `refs/remotes/origin/${REDRAW_BRANCH}`;

  // Ask the forge before any model runs: a redraw that cannot be offered is not drawn.
  const openPr = await forge.findOpenPr({ cwd: r.root, head: REDRAW_BRANCH });
  // The redraw branch goes on from where it is on origin (an open pull request
  // gets more commits), with main merged in: it is never force-pushed.
  const onOrigin = await gitOk(r.root, ['fetch', '--quiet', 'origin', `+refs/heads/${REDRAW_BRANCH}:${remoteRedraw}`]);
  await prepareWorktree(r.root, wt, onOrigin ? remoteRedraw : r.target, onOrigin ? r.target : null);

  const prs = await mergedPrs(r.root, r.from, r.target);
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

  const agent = await runAgent({ setup: r.setup, cwd: wt, prompt, docs });
  if (!agent.ok) return fail(`the agent did not finish: ${agent.output.trim().slice(-400) || 'no output'}`);
  const outside = (await changedPaths(wt)).filter((p) => p !== SUMMARY_FILE && !p.startsWith(`${DRAWING_DIR}/`));
  if (outside.length) return fail(`the agent changed files outside ${DRAWING_DIR}: ${outside.slice(0, 5).join(', ')}`);
  const summary = (await readFile(summaryPath, 'utf8').catch(() => '')).trim();
  await unlink(summaryPath).catch(() => {});

  const dir = join(wt, DRAWING_DIR);
  if (!(await changedPaths(wt)).length) {
    // the agent read the change and the drawing stands
    await r.save({ gated: r.target, gated_at: r.now(), last_error: null, failed: null });
    return { ran: 'gated', gated: r.target, why: summary || 'the agent found nothing to change' };
  }
  await setDrawnAt(dir, r.target);
  const checked = await check({ dir, root: wt });
  const issues = [...checked.errors, ...checked.warnings].map((i) => `${i.file}${i.field ? ` ${i.field}` : ''}: ${i.message}`);
  issues.push(...checked.missing.map((m) => `missing: ${m}`));
  if (issues.length) return fail(`the redraw does not check clean: ${issues.slice(0, 5).join('; ')}`);

  const title = `System: redraw for ${prs.length ? prs.map((n) => `PR ${n}`).join(', ') : r.target.slice(0, 7)}`;
  const body = [
    summary || 'The drawing follows the code at the new commit.',
    '',
    `Main moved from ${r.from.slice(0, 7)} to ${r.target.slice(0, 7)}. The files that woke the check:`,
    ...r.result.why.map((w) => `- ${w.path} (${w.reason})`),
  ].join('\n');
  await git(wt, ['add', '--', DRAWING_DIR]);
  await git(wt, ['commit', '--quiet', '-m', title, '-m', body]);
  if (REDRAW_BRANCH === r.main) throw new Error('the redraw branch is the default branch; refusing to push');
  await git(wt, ['push', '--quiet', 'origin', `HEAD:refs/heads/${REDRAW_BRANCH}`]);
  const pr = openPr ?? (await forge.openPr({ cwd: wt, base: r.main, head: REDRAW_BRANCH, title, body }));

  const after = (await load(dir)).model;
  const note = redrawNote({ to: r.target, prs, summary, count: after ? changedCount(r.model, after) : { parts: 0, flows: 0 }, pr });
  let noteError: string | null = null;
  await notify({ project: r.root, subject: `System: ${r.model.name}`, body: note, replyTo: r.setup.thread_message }).catch((e: Error) => {
    noteError = `the note was not sent: ${e.message}`;
  });
  await r.save({ gated: r.target, gated_at: r.now(), redrew_at: r.now(), redraw_pr: pr, last_error: noteError, failed: null });
  return { ran: 'redrew', gated: r.target, pr, note, ...(noteError ? { error: noteError } : {}) };
}
