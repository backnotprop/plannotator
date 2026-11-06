import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergedPrs, readState, redrawNote, systemPaths, tick, type Forge, type Notify, type RunAgent, type TickDeps } from '../src/node/index.ts';
import { git, isolateGitConfig, smallDrawing, tempDir, writeTree } from './helpers.ts';

// A real project: a bare origin in a temp folder (a local path, no network),
// a teammate's clone that lands commits on main, and the person's clone that
// the tick runs in. The agent is a scripted stand-in: a shell script that
// edits the drawing as a redraw would, because no model is called in tests.
// It proves the plumbing (gate, worktree, check, commit, push, state.json,
// the lock), not drawing quality, which a live run proves (step A8).

isolateGitConfig();
const IDENTITY = { GIT_AUTHOR_NAME: 'Alex Rivera', GIT_AUTHOR_EMAIL: 'alex@example.com', GIT_COMMITTER_NAME: 'Alex Rivera', GIT_COMMITTER_EMAIL: 'alex@example.com' };
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(IDENTITY)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const k of Object.keys(IDENTITY)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const KEY = 'small-1a2b3c';
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

/** The drawing in the teammate's clone, drawn at `at`. */
const drawing = (at: string) => {
  const files = smallDrawing();
  files['system.yaml'] = files['system.yaml']!.replace('at: 1a2b3c4', `at: "${at}"`);
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [`.plannotator/system/${k}`, v]));
};

function project(o: { drawn?: boolean } = {}) {
  const t = tempDir();
  cleanups.push(t.done);
  const origin = join(t.dir, 'origin.git');
  const team = join(t.dir, 'team');
  const root = join(t.dir, 'root');
  const dataDir = join(t.dir, 'data');
  git(t.dir, 'init', '-q', '--bare', origin);
  git(t.dir, 'init', '-q', team);
  git(team, 'remote', 'add', 'origin', origin);
  writeTree(team, { 'src/main.ts': 'main\n', 'src/api/index.ts': 'api\n', 'README.md': 'small\n' });
  git(team, 'add', '-A');
  git(team, 'commit', '-q', '-m', 'the code');
  const drawnAt = git(team, 'rev-parse', 'HEAD').trim();
  if (o.drawn !== false) {
    writeTree(team, drawing(drawnAt));
    git(team, 'add', '-A');
    git(team, 'commit', '-q', '-m', 'System: first drawing of small (#3)');
  }
  git(team, 'push', '-q', 'origin', 'main');
  git(t.dir, 'clone', '-q', origin, root);
  const p = systemPaths(dataDir, KEY);
  mkdirSync(p.dir, { recursive: true });
  writeFileSync(p.setup, JSON.stringify({ v: 1, repos: [], docs: ['https://docs.example.com/', 'https://127.0.0.1/'], agent: 'claude', model: 'claude-opus-5-5', thread_message: 'msg_7' }));
  /** Land a commit on main from the teammate's clone. */
  const land = (files: Record<string, string>, message: string) => {
    writeTree(team, files);
    git(team, 'add', '-A');
    git(team, 'commit', '-q', '-m', message);
    git(team, 'push', '-q', 'origin', 'main');
    return git(team, 'rev-parse', 'HEAD').trim();
  };
  return { dir: t.dir, origin, team, root, dataDir, paths: p, land, drawnAt };
}

/** A stand-in agent: runs `script` with sh in the worktree; records each prompt. */
function scriptAgent(script: string): { runAgent: RunAgent; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    runAgent: async ({ cwd, prompt }) => {
      prompts.push(prompt);
      try {
        return { ok: true, output: execFileSync('sh', ['-c', script], { cwd, encoding: 'utf8' }) };
      } catch (e) {
        return { ok: false, output: String((e as Error).message) };
      }
    },
  };
}

/** The redraw a person would accept: a new part `jobs` for the new file, placed on L-101, and one sentence. */
const ADD_JOBS = `
cat >> .plannotator/system/system.yaml <<'YAML'
  jobs: { from: app, to: api, says: runs jobs }
YAML
perl -0pi -e 's/(  api: \\{ in: app, name: API, code: \\{ src\\/api: every route \\} \\}\\n)/$1  jobsp: { in: app, name: Jobs, code: { src\\/jobs.ts: the job runner } }\\n/' .plannotator/system/system.yaml
perl -pi -e 's/row: \\[api\\]/row: [api, jobsp]/' .plannotator/system/sheets/L-101.yaml
printf 'On the app sheet, the app now runs jobs.\\n' > .plannotator/redraw-summary.txt
`;

function fakes() {
  const opened: Parameters<Forge['openPr']>[0][] = [];
  const notes: Parameters<Notify>[0][] = [];
  let open: string | null = null;
  const forge: Forge = {
    findOpenPr: async () => open,
    openPr: async (o) => {
      opened.push(o);
      open = 'https://example.com/acme/small/pull/7';
      return open;
    },
  };
  const notify: Notify = async (o) => {
    notes.push(o);
  };
  return { forge, notify, opened, notes };
}

const noAgent: RunAgent = async () => {
  throw new Error('the agent must not run');
};

describe('tick', () => {
  test('not set up, or no drawing on main yet: nothing runs', async () => {
    const p = project({ drawn: false });
    expect(await tick({ root: p.root, dataDir: p.dataDir, key: 'other-000000' })).toMatchObject({ ran: 'nothing', why: 'not set up: no setup.json for this project' });
    expect(await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: noAgent } })).toMatchObject({ ran: 'nothing', why: 'no drawing on main yet' });
  });

  test('the commit that added the drawing is gated with no agent; then main has not moved and nothing runs', async () => {
    const p = project();
    const tip = git(p.root, 'rev-parse', 'origin/main').trim();
    expect(await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: noAgent } })).toEqual({ ran: 'gated', gated: tip });
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: noAgent } });
    expect(r).toMatchObject({ ran: 'nothing', why: 'main has not moved' });
    expect(existsSync(p.paths.lock)).toBe(false);
  });

  test('an edit to a file the drawing does not cite is gated with no agent, and state.json moves on', async () => {
    const p = project();
    const tip = p.land({ 'src/util.ts': 'x\n' }, 'add util');
    // the first tick sees an added file; give the gate a modified, uncited file instead
    const first = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent('true').runAgent, ...fakes() } });
    expect(first.ran).toBe('gated'); // the stand-in changed nothing: the drawing stands
    expect(first.gated).toBe(tip);
    const tip2 = p.land({ 'src/util.ts': 'y\n', 'docs/guide.md': 'more\n' }, 'edit util');
    const now = new Date('2026-11-06T12:00:00Z');
    expect(await tick({ root: p.root, dataDir: p.dataDir, key: KEY, now, deps: { runAgent: noAgent } })).toEqual({ ran: 'gated', gated: tip2 });
    expect(await readState(p.dataDir, KEY)).toMatchObject({ v: 1, gated: tip2, gated_at: '2026-11-06T12:00:00.000Z', last_error: null, failed: null });
    // and the next tick diffs from there
    expect(await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: noAgent } })).toMatchObject({ ran: 'nothing' });
  });

  test('an added file wakes the agent: the redraw is committed on its own branch, pushed, offered as one PR, and noted once', async () => {
    const p = project();
    const reviews = join(p.paths.reviews, 'example.com', 'acme', 'small');
    mkdirSync(reviews, { recursive: true });
    writeFileSync(join(reviews, '12@abc1234.yaml'), 'revision: PR-12\n');
    const tip = p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs (#12)');
    const agent = scriptAgent(ADD_JOBS);
    const f = fakes();
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: agent.runAgent, forge: f.forge, notify: f.notify } });
    expect(r).toMatchObject({ ran: 'redrew', gated: tip, pr: 'https://example.com/acme/small/pull/7' });

    // the agent was told what landed, why it woke, and where to write
    const prompt = agent.prompts[0]!;
    expect(prompt).toContain(`set sources.repos.self.at to it): ${tip}`);
    expect(prompt).toContain('  - src/jobs.ts (added)');
    expect(prompt).toContain('  - PR 12');
    expect(prompt).toContain(`PR 12: ${join(reviews, '12@abc1234.yaml')}`);
    expect(prompt).toContain('  - https://docs.example.com/');
    expect(prompt).not.toContain('127.0.0.1');

    // the redraw branch on origin: one commit on top of main's tip, touching only the drawing, drawn at the tip
    const head = git(p.origin, 'rev-parse', 'refs/heads/plannotator/system-redraw').trim();
    expect(git(p.origin, 'rev-parse', `${head}^`).trim()).toBe(tip);
    expect(git(p.origin, 'diff', '--name-only', tip, head).trim().split('\n').sort()).toEqual(['.plannotator/system/sheets/L-101.yaml', '.plannotator/system/system.yaml']);
    expect(git(p.origin, 'show', `${head}:.plannotator/system/system.yaml`)).toContain(`self: { repo: example.com/acme/small, at: "${tip}" }`);
    expect(git(p.origin, 'log', '-1', '--format=%s', head).trim()).toBe('System: redraw for PR 12');
    // main is untouched
    expect(git(p.origin, 'rev-parse', 'refs/heads/main').trim()).toBe(tip);

    expect(f.opened).toEqual([{ cwd: p.paths.worktree, base: 'main', head: 'plannotator/system-redraw', title: 'System: redraw for PR 12', body: expect.stringContaining('src/jobs.ts (added)') }]);
    expect(f.notes).toHaveLength(1);
    expect(f.notes[0]).toMatchObject({ project: p.root, replyTo: 'msg_7' });
    expect(f.notes[0]!.body).toBe(`Main moved to ${tip.slice(0, 7)}. PR 12 landed: On the app sheet, the app now runs jobs. 1 part and 1 line changed. Redraw: https://example.com/acme/small/pull/7`);

    expect(await readState(p.dataDir, KEY)).toMatchObject({ gated: tip, redraw_pr: 'https://example.com/acme/small/pull/7', last_error: null, failed: null });
    expect(git(p.paths.worktree, 'status', '--porcelain')).toBe('');
    expect(existsSync(p.paths.lock)).toBe(false);
  });

  test('while the redraw PR is open, the next redraw adds to the same branch with main merged in, never forced', async () => {
    const p = project();
    p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs (#12)');
    const f = fakes();
    const first = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent(ADD_JOBS).runAgent, forge: f.forge, notify: f.notify } });
    expect(first.ran).toBe('redrew');
    const firstHead = git(p.origin, 'rev-parse', 'refs/heads/plannotator/system-redraw').trim();

    const tip = p.land({ 'src/mail.ts': 'mail\n' }, 'Merge pull request #13 from acme/mail');
    const second = scriptAgent(`
perl -0pi -e 's/(  jobsp: [^\\n]*\\n)/$1  mail: { in: app, name: Mail, code: { src\\/mail.ts: sends mail } }\\n/' .plannotator/system/system.yaml
perl -pi -e 's/row: \\[api, jobsp\\]/row: [api, jobsp, mail]/' .plannotator/system/sheets/L-101.yaml
echo 'On the app sheet, the app sends mail' > .plannotator/redraw-summary.txt
`);
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: second.runAgent, forge: f.forge, notify: f.notify } });
    expect(r).toMatchObject({ ran: 'redrew', gated: tip, pr: 'https://example.com/acme/small/pull/7' });
    expect(f.opened).toHaveLength(1);
    const head = git(p.origin, 'rev-parse', 'refs/heads/plannotator/system-redraw').trim();
    for (const ancestor of [firstHead, tip]) expect(() => git(p.origin, 'merge-base', '--is-ancestor', ancestor, head)).not.toThrow();
    expect(f.notes[1]!.body).toBe(`Main moved to ${tip.slice(0, 7)}. PR 13 landed: On the app sheet, the app sends mail. 1 part changed. Redraw: https://example.com/acme/small/pull/7`);
  });

  test('an agent that edits code outside the drawing is refused: nothing is pushed, its files are kept aside, and it waits for main to move', async () => {
    const p = project();
    const tip = p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs');
    const f = fakes();
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent(`${ADD_JOBS}\necho hacked > src/main.ts`).runAgent, forge: f.forge, notify: f.notify } });
    expect(r).toMatchObject({ ran: 'failed', error: 'the agent changed files outside .plannotator/system: src/main.ts' });
    expect(() => git(p.origin, 'rev-parse', '--verify', '--quiet', 'refs/heads/plannotator/system-redraw')).toThrow();
    expect(f.opened).toEqual([]);
    expect(f.notes).toEqual([]);
    expect(readFileSync(join(p.paths.failed, tip, 'src', 'main.ts'), 'utf8')).toBe('hacked\n');
    expect(git(p.paths.worktree, 'status', '--porcelain')).toBe('');
    expect(await readState(p.dataDir, KEY)).toMatchObject({ failed: tip, gated: null });
    expect(await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: noAgent, ...f } })).toMatchObject({ ran: 'nothing', why: `the last redraw for ${tip.slice(0, 7)} failed; waiting for main to move` });
  });

  test('a redraw that does not check clean is refused, naming the problem', async () => {
    const p = project();
    p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs');
    const f = fakes();
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent("perl -pi -e 's/row: \\[api\\]/row: [api, ghost]/' .plannotator/system/sheets/L-101.yaml").runAgent, ...f } });
    expect(r.ran).toBe('failed');
    expect(r.error).toContain('the redraw does not check clean: sheets/L-101.yaml');
    expect(r.error).toContain('unknown part "ghost"');
    expect(f.opened).toEqual([]);
  });

  test('an agent that fails is a failed tick with its last words', async () => {
    const p = project();
    p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs');
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: async () => ({ ok: false, output: 'model not found' }), ...fakes() } });
    expect(r).toMatchObject({ ran: 'failed', error: 'the agent did not finish: model not found' });
  });

  test('when the forge cannot be asked, no model runs', async () => {
    const p = project();
    p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs');
    const deps: TickDeps = {
      runAgent: noAgent,
      forge: { findOpenPr: async () => { throw new Error('gh pr list: not signed in'); }, openPr: async () => '' },
    };
    expect(await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps })).toMatchObject({ ran: 'failed', error: 'gh pr list: not signed in' });
    // nothing was spent, so the next tick tries again
    expect(await readState(p.dataDir, KEY)).toMatchObject({ failed: null, last_error: 'gh pr list: not signed in' });
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent(ADD_JOBS).runAgent, ...fakes() } });
    expect(r.ran).toBe('redrew');
    expect(await readState(p.dataDir, KEY)).toMatchObject({ failed: null, last_error: null });
  });

  test('a push origin refuses after the agent ran is a failed redraw: no PR, no note, the worktree clean', async () => {
    const p = project();
    const tip = p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs');
    writeFileSync(join(p.origin, 'hooks', 'pre-receive'), '#!/bin/sh\necho "refused by the test" >&2\nexit 1\n', { mode: 0o755 });
    const f = fakes();
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent(ADD_JOBS).runAgent, forge: f.forge, notify: f.notify } });
    expect(r.ran).toBe('failed');
    expect(r.error).toContain('refused by the test');
    expect(f.opened).toEqual([]);
    expect(f.notes).toEqual([]);
    expect(await readState(p.dataDir, KEY)).toMatchObject({ failed: tip });
    expect(git(p.paths.worktree, 'status', '--porcelain')).toBe('');
  });

  test('a live tick holds the lock; a dead one is taken over', async () => {
    const p = project();
    p.land({ 'src/util.ts': 'x\n' }, 'add util');
    writeFileSync(p.paths.lock, String(process.pid));
    expect(await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: noAgent } })).toMatchObject({ ran: 'nothing', why: 'another tick is running' });
    expect(readFileSync(p.paths.lock, 'utf8')).toBe(String(process.pid));
    // a pid no process has
    writeFileSync(p.paths.lock, '99999999');
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent('true').runAgent, ...fakes() } });
    expect(r.ran).toBe('gated');
    expect(existsSync(p.paths.lock)).toBe(false);
  });
});

test('mergedPrs reads merge and squash subjects on the first-parent line, and keeps those that changed a file', async () => {
  const p = project();
  const from = git(p.team, 'rev-parse', 'HEAD').trim();
  p.land({ 'a.ts': 'a\n' }, 'Merge pull request #21 from acme/a');
  p.land({ 'b.ts': 'b\n' }, 'Add b (#22)');
  const to = p.land({ 'c.ts': 'c\n' }, 'fix #23 in c');
  expect(await mergedPrs(p.team, from, to)).toEqual([21, 22]);
  // only the ones that changed a given file
  expect(await mergedPrs(p.team, from, to, ['b.ts'])).toEqual([22]);
});

test('redrawNote: the words of the note', () => {
  const base = { to: '9c41e07aaaa', pr: 'https://example.com/pull/9' };
  expect(redrawNote({ ...base, prs: [1335], summary: 'On the Desktop app sheet, stable now shows a corner, not a header.', count: { parts: 1, flows: 0 } }))
    .toBe('Main moved to 9c41e07. PR 1335 landed: On the Desktop app sheet, stable now shows a corner, not a header. 1 part changed. Redraw: https://example.com/pull/9');
  expect(redrawNote({ ...base, prs: [], summary: '', count: { parts: 0, flows: 2 } })).toBe('Main moved to 9c41e07. 2 lines changed. Redraw: https://example.com/pull/9');
  expect(redrawNote({ ...base, prs: [4, 5], summary: '', count: { parts: 2, flows: 0 } })).toBe('Main moved to 9c41e07. PRs 4, 5 landed. 2 parts changed. Redraw: https://example.com/pull/9');
});
