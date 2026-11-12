import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergedPrs, readState, redrawNote, runCommand, systemPaths, tick, type Notify, type RunAgent, type TickDeps } from '../src/node/index.ts';
import { git, isolateGitConfig, smallDrawing, tempDir, writeTree } from './helpers.ts';
import { gitBytes } from '../src/node/git.ts';
import { drawingStatus } from '../src/index.ts';
import { load } from '../src/node/index.ts';

// The agent is a scripted stand-in: a shell script that edits the drawing as a redraw would,
// because no model is called in tests.

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
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const escapee = (pidFile: string) =>
  `perl -MPOSIX -e 'exit if fork; POSIX::setsid(); open(my $f, ">", $ARGV[0]); print $f $$; close $f; sleep 30' '${pidFile}'`;
const killPidFile = (pidFile: string) => {
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : 0;
  if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
};

afterEach(() => cleanups.splice(0).forEach((f) => f()));

const drawing = (at: string) => {
  const files = smallDrawing();
  files['system.yaml'] = files['system.yaml']!.replace('at: 1a2b3c4', `at: "${at}"`);
  return files;
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
  git(team, 'push', '-q', 'origin', 'main');
  git(t.dir, 'clone', '-q', origin, root);
  const p = systemPaths(dataDir, KEY);
  mkdirSync(p.dir, { recursive: true });
  if (o.drawn !== false) writeTree(p.drawing, drawing(drawnAt));
  writeFileSync(p.setup, JSON.stringify({ v: 1, repos: [], docs: ['https://docs.example.com/', 'https://127.0.0.1/'], agent: 'claude', model: 'claude-opus-5-5', thread_message: 'msg_7' }));
  const land = (files: Record<string, string>, message: string) => {
    writeTree(team, files);
    git(team, 'add', '-A');
    git(team, 'commit', '-q', '-m', message);
    git(team, 'push', '-q', 'origin', 'main');
    return git(team, 'rev-parse', 'HEAD').trim();
  };
  return { dir: t.dir, origin, team, root, dataDir, paths: p, land, drawnAt };
}

function scriptAgent(script: string): { runAgent: RunAgent; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    runAgent: async ({ cwd, drawing, summaryFile, prompt }) => {
      prompts.push(prompt);
      try {
        return { ok: true, output: execFileSync('sh', ['-c', script], { cwd, env: { ...process.env, DRAWING: drawing, SUMMARY: summaryFile }, encoding: 'utf8' }) };
      } catch (e) {
        return { ok: false, output: String((e as Error).message) };
      }
    },
  };
}

const ADD_JOBS = `
cat >> "$DRAWING/system.yaml" <<'YAML'
  jobs: { from: app, to: api, says: runs jobs }
YAML
perl -0pi -e 's/(  api: \\{ in: app, name: API, code: \\{ src\\/api: every route \\} \\}\\n)/$1  jobsp: { in: app, name: Jobs, code: { src\\/jobs.ts: the job runner } }\\n/' "$DRAWING/system.yaml"
perl -pi -e 's/row: \\[api\\]/row: [api, jobsp]/' "$DRAWING/sheets/L-101.yaml"
printf 'On the app sheet, the app now runs jobs.\\n' > "$SUMMARY"
`;

function fakes() {
  const notes: Parameters<Notify>[0][] = [];
  const notify: Notify = async (o) => {
    notes.push(o);
  };
  return { notify, notes };
}

const noAgent: RunAgent = async () => {
  throw new Error('the agent must not run');
};
const noNotify: Notify = async () => {
  throw new Error('no note must be sent');
};
const NONE: TickDeps = { runAgent: noAgent, notify: noNotify };

const drawingFiles = (dir: string) => {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out[r] = readFileSync(join(dir, r), 'utf8');
    }
  };
  walk('');
  return out;
};

function repoSnapshot(root: string) {
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, '.git', rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else files.push(`${r} ${createHash('sha256').update(readFileSync(join(root, '.git', r))).digest('hex')}`);
    }
  };
  const status = git(root, '--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--untracked-files=all', '--ignored');
  walk('');
  return {
    status,
    refs: git(root, 'for-each-ref', '--format=%(refname) %(objectname)'),
    head: git(root, 'rev-parse', 'HEAD'),
    config: readFileSync(join(root, '.git', 'config'), 'utf8'),
    worktrees: existsSync(join(root, '.git', 'worktrees')) ? readdirSync(join(root, '.git', 'worktrees')) : null,
    files: files.sort(),
  };
}

describe('tick', () => {
  test('not set up, or no drawing yet: nothing runs', async () => {
    const p = project({ drawn: false });
    expect(await tick({ root: p.root, dataDir: p.dataDir, key: 'other-000000', deps: NONE })).toMatchObject({ ran: 'nothing', why: 'not set up: no setup.json for this project' });
    expect(await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: NONE })).toMatchObject({ ran: 'nothing', why: 'no drawing yet' });
    expect(existsSync(p.paths.source)).toBe(false);
  });

  test("a drawing drawn at main's tip: the source clone is made at the tip, and nothing runs", async () => {
    const p = project();
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: NONE });
    expect(r).toMatchObject({ ran: 'nothing', why: 'main has not moved', gated: p.drawnAt });
    expect(git(p.paths.source, 'rev-parse', 'HEAD').trim()).toBe(p.drawnAt);
    expect(git(p.paths.source, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(p.paths.source, '.git', 'objects', 'info', 'alternates'), 'utf8')).toContain(join(p.root, '.git', 'objects'));
    expect(existsSync(p.paths.lock)).toBe(false);
  });

  test('an edit to a file the drawing does not cite is gated with no agent, and state.json moves on', async () => {
    const p = project();
    const tip = p.land({ 'src/util.ts': 'x\n' }, 'add util');
    const first = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent('true').runAgent, ...fakes() } });
    expect(first.ran).toBe('gated');
    expect(first.gated).toBe(tip);
    expect(existsSync(p.paths.redraw)).toBe(false);
    const tip2 = p.land({ 'src/util.ts': 'y\n', 'docs/guide.md': 'more\n' }, 'edit util');
    const now = new Date('2026-11-06T12:00:00Z');
    expect(await tick({ root: p.root, dataDir: p.dataDir, key: KEY, now, deps: NONE })).toEqual({ ran: 'gated', gated: tip2 });
    expect(await readState(p.dataDir, KEY)).toMatchObject({ v: 1, gated: tip2, gated_at: '2026-11-06T12:00:00.000Z', last_error: null, failed: null });
    expect(await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: NONE })).toMatchObject({ ran: 'nothing' });
  });

  test('an added file wakes the agent: the drawing is redrawn in its own folder, drawn at the tip, and noted once', async () => {
    const p = project();
    const reviews = join(p.paths.reviews, 'example.com', 'acme', 'small');
    mkdirSync(reviews, { recursive: true });
    writeFileSync(join(reviews, '12@abc1234.yaml'), 'revision: PR-12\n');
    const before = drawingFiles(p.paths.drawing);
    const tip = p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs (#12)');
    const agent = scriptAgent(ADD_JOBS);
    const f = fakes();
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: agent.runAgent, notify: f.notify } });
    expect(r).toMatchObject({ ran: 'redrew', gated: tip });

    const prompt = agent.prompts[0]!;
    expect(prompt).toContain(`already at the new commit: ${p.paths.source}`);
    expect(prompt).toContain(`to edit the drawing in: ${p.paths.redraw}`);
    expect(prompt).toContain(`The summary file: ${p.paths.summary}`);
    expect(prompt).toContain(`set sources.repos.self.at to it): ${tip}`);
    expect(prompt).toContain('  - src/jobs.ts (added)');
    expect(prompt).toContain('  - PR 12');
    expect(prompt).toContain(`PR 12: ${join(reviews, '12@abc1234.yaml')}`);
    expect(prompt).toContain('  - https://docs.example.com/');
    expect(prompt).not.toContain('127.0.0.1');

    const after = drawingFiles(p.paths.drawing);
    expect(after['system.yaml']).toContain(`self: { repo: example.com/acme/small, at: "${tip}" }`);
    expect(after['system.yaml']).toContain('jobsp: { in: app, name: Jobs');
    expect(after['sheets/L-101.yaml']).toContain('row: [api, jobsp]');
    expect(drawingFiles(p.paths.previous)).toEqual(before);
    expect(existsSync(p.paths.redraw)).toBe(false);
    expect(existsSync(p.paths.summary)).toBe(false);

    expect(git(p.origin, 'for-each-ref', '--format=%(refname)').trim()).toBe('refs/heads/main');
    expect(git(p.origin, 'rev-parse', 'refs/heads/main').trim()).toBe(tip);

    expect(f.notes).toHaveLength(1);
    expect(f.notes[0]).toMatchObject({ project: p.root, replyTo: 'msg_7' });
    expect(f.notes[0]!.body).toBe(`Main moved to ${tip.slice(0, 7)}. PR 12 landed: On the app sheet, the app now runs jobs. 1 part and 1 line changed.`);

    expect(await readState(p.dataDir, KEY)).toMatchObject({ gated: tip, last_error: null, failed: null });
    expect(git(p.paths.source, 'rev-parse', 'HEAD').trim()).toBe(tip);
    expect(git(p.paths.source, 'status', '--porcelain')).toBe('');
    expect(existsSync(p.paths.lock)).toBe(false);
  });

  test('a full tick leaves the person\'s repo byte for byte as it was: status, refs, config, worktrees and every file under .git, the index included', async () => {
    const p = project();
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(p.root, 'src', 'main.ts'), later, later);
    const before = repoSnapshot(p.root);
    const tip = p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs (#12)');
    const agent = `${ADD_JOBS}
echo changed > src/main.ts
echo extra > src/extra.ts && git add src/extra.ts && git commit -q -m "the agent's own commit"`;
    expect(await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent(agent).runAgent, ...fakes() } })).toMatchObject({ ran: 'redrew', gated: tip });
    expect(repoSnapshot(p.root)).toEqual(before);
    expect(git(p.root, 'rev-parse', 'origin/main').trim()).toBe(p.drawnAt);
    p.land({ 'src/util.ts': 'x\n' }, 'add util');
    expect((await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent('true').runAgent, ...fakes() } })).ran).toBe('gated');
    expect((await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: NONE })).ran).toBe('nothing');
    expect(repoSnapshot(p.root)).toEqual(before);
  });

  test('the next redraw starts from the redrawn drawing', async () => {
    const p = project();
    p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs (#12)');
    const f = fakes();
    expect((await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent(ADD_JOBS).runAgent, notify: f.notify } })).ran).toBe('redrew');

    const tip = p.land({ 'src/mail.ts': 'mail\n' }, 'Merge pull request #13 from acme/mail');
    const second = scriptAgent(`
perl -0pi -e 's/(  jobsp: [^\\n]*\\n)/$1  mail: { in: app, name: Mail, code: { src\\/mail.ts: sends mail } }\\n/' "$DRAWING/system.yaml"
perl -pi -e 's/row: \\[api, jobsp\\]/row: [api, jobsp, mail]/' "$DRAWING/sheets/L-101.yaml"
echo 'On the app sheet, the app sends mail' > "$SUMMARY"
`);
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: second.runAgent, notify: f.notify } });
    expect(r).toMatchObject({ ran: 'redrew', gated: tip });
    expect(drawingFiles(p.paths.drawing)['sheets/L-101.yaml']).toContain('row: [api, jobsp, mail]');
    expect(f.notes[1]!.body).toBe(`Main moved to ${tip.slice(0, 7)}. PR 13 landed: On the app sheet, the app sends mail. 1 part changed.`);
  });

  test('files the agent changed in the source clone, its own commits included, are named in the note, kept, and the clone put back', async () => {
    const p = project();
    const tip = p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs');
    const f = fakes();
    const agent = scriptAgent(`${ADD_JOBS}
echo extra > src/extra.ts && git add src/extra.ts && git commit -q -m "the agent's own commit"
echo changed > src/main.ts`);
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: agent.runAgent, notify: f.notify } });
    expect(r.ran).toBe('redrew');
    expect(f.notes[0]!.body).toContain('This redraw also changed: src/extra.ts, src/main.ts.');
    expect(readFileSync(join(p.paths.changed, tip, 'src', 'main.ts'), 'utf8')).toBe('changed\n');
    expect(git(p.paths.source, 'rev-parse', 'HEAD').trim()).toBe(tip);
    expect(git(p.paths.source, 'status', '--porcelain')).toBe('');
    expect(git(p.origin, 'for-each-ref', '--format=%(refname)').trim()).toBe('refs/heads/main');
  });

  test('an agent that throws midway is set aside: the last good drawing stays, its partial copy is kept, the clone is clean', async () => {
    const p = project();
    const before = drawingFiles(p.paths.drawing);
    const tip = p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs');
    const f = fakes();
    const runAgent: RunAgent = async ({ drawing }) => {
      writeFileSync(join(drawing, 'sheets', 'half.yaml'), 'half\n');
      throw new Error('the agent process went away');
    };
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent, notify: f.notify } });
    expect(r).toMatchObject({ ran: 'failed', error: 'the agent process went away' });
    expect(readFileSync(join(p.paths.failed, tip, 'drawing', 'sheets', 'half.yaml'), 'utf8')).toBe('half\n');
    expect(drawingFiles(p.paths.drawing)).toEqual(before);
    expect(existsSync(p.paths.redraw)).toBe(false);
    expect(git(p.paths.source, 'status', '--porcelain')).toBe('');
    expect(await readState(p.dataDir, KEY)).toMatchObject({ failed: tip });
    expect(f.notes).toEqual([]);
  });

  test('a redraw cut off before it ended does not stop later ticks: its copy and its clone changes are set aside, recorded, and the redraw goes on', async () => {
    const p = project();
    p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs (#12)');
    const f = fakes();
    expect((await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent(ADD_JOBS).runAgent, notify: f.notify } })).ran).toBe('redrew');
    const good = drawingFiles(p.paths.drawing);
    mkdirSync(p.paths.redraw, { recursive: true });
    writeFileSync(join(p.paths.redraw, 'system.yaml'), 'cut off\n');
    writeFileSync(join(p.paths.source, 'stray.txt'), 'stray\n');
    const tip = p.land({ 'src/mail.ts': 'mail\n' }, 'Add mail (#13)');
    const now = new Date('2026-11-07T08:00:00Z');
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, now, deps: { runAgent: scriptAgent('echo "On the app sheet, nothing moved." > "$SUMMARY"').runAgent, notify: f.notify } });
    expect(r).toMatchObject({ ran: 'gated', gated: tip });
    const kept = join(p.paths.failed, 'interrupted-2026-11-07T08-00-00-000Z');
    expect(readFileSync(join(kept, 'drawing', 'system.yaml'), 'utf8')).toBe('cut off\n');
    expect(readFileSync(join(kept, 'source', 'stray.txt'), 'utf8')).toBe('stray\n');
    expect(drawingFiles(p.paths.drawing)).toEqual(good);
    const state = await readState(p.dataDir, KEY);
    expect(state.set_aside).toContain(kept);
    expect(state).toMatchObject({ gated: tip, last_error: null, failed: null });
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    test(`a tick stopped by ${signal} mid-redraw stops the agent's whole process group before it exits`, async () => {
      const p = project();
      p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs');
      const pidFile = join(p.dir, 'agent-child.pid');
      const script = join(p.dir, 'run-tick.ts');
      writeFileSync(script, [
        `import { tick } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'node', 'index.ts'))};`,
        'const [root, dataDir, key, pidFile] = process.argv.slice(2);',
        'await tick({ root, dataDir, key, deps: {',
        "  agentCommand: () => ({ command: ['sh', '-c', `sleep 30 & echo $! > '${pidFile}'; wait`], stdin: null }),",
        '  notify: async () => {},',
        '} });',
        '',
      ].join('\n'));
      const child = spawn(process.execPath, [script, p.root, p.dataDir, KEY, pidFile], { stdio: 'ignore' });
      const exited = new Promise<number | null>((ok) => child.on('exit', (code) => ok(code)));
      let agentChild = 0;
      try {
        for (let i = 0; i < 150 && !agentChild; i++) {
          await sleep(100);
          if (existsSync(pidFile)) agentChild = Number(readFileSync(pidFile, 'utf8').trim()) || 0;
        }
        expect(agentChild).toBeGreaterThan(0);
        child.kill(signal);
        expect(await exited).toBe(signal === 'SIGTERM' ? 143 : 130);
        for (let i = 0; i < 30 && alive(agentChild); i++) await sleep(100);
        expect(alive(agentChild)).toBe(false);
      } finally {
        if (agentChild && alive(agentChild)) process.kill(agentChild, 'SIGKILL');
        child.kill('SIGKILL');
      }
    }, 30_000);
  }

  test('an agent whose escaped child holds its output open is still stopped: the tick returns within the bound and the grace', async () => {
    const p = project();
    p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs');
    const f = fakes();
    const pidFile = join(p.dir, 'escapee.pid');
    const started = Date.now();
    try {
      const r = await tick({
        root: p.root, dataDir: p.dataDir, key: KEY,
        deps: { agentCommand: () => ({ command: ['sh', '-c', `${escapee(pidFile)}; sleep 30`], stdin: null }), agentTimeoutMs: 300, notify: f.notify },
      });
      expect(r).toMatchObject({ ran: 'failed', error: expect.stringContaining('stopped after') });
      expect(Date.now() - started).toBeLessThan(300 + 5000 + 4000);
      expect(existsSync(p.paths.lock)).toBe(false);
    } finally {
      killPidFile(pidFile);
    }
  }, 30_000);

  test('a hung agent is stopped at its time bound, the failure is recorded and the lock let go', async () => {
    const p = project();
    const tip = p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs');
    const f = fakes();
    const started = Date.now();
    const r = await tick({
      root: p.root, dataDir: p.dataDir, key: KEY,
      deps: { agentCommand: () => ({ command: ['sh', '-c', 'sleep 30'], stdin: null }), agentTimeoutMs: 300, notify: f.notify },
    });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r).toMatchObject({ ran: 'failed', error: 'the agent did not finish: the agent was stopped after 0 seconds with no end' });
    expect(await readState(p.dataDir, KEY)).toMatchObject({ failed: tip, last_error: expect.stringContaining('stopped after') });
    expect(existsSync(p.paths.lock)).toBe(false);
  });

  test('a redraw that does not check clean is refused, naming the problem; the drawing stays and no note goes', async () => {
    const p = project();
    const before = drawingFiles(p.paths.drawing);
    const tip = p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs');
    const f = fakes();
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent(`perl -pi -e 's/row: \\[api\\]/row: [api, ghost]/' "$DRAWING/sheets/L-101.yaml"`).runAgent, ...f } });
    expect(r.ran).toBe('failed');
    expect(r.error).toContain('the redraw does not check clean: sheets/L-101.yaml');
    expect(r.error).toContain('unknown part "ghost"');
    expect(drawingFiles(p.paths.drawing)).toEqual(before);
    expect(readFileSync(join(p.paths.failed, tip, 'drawing', 'sheets', 'L-101.yaml'), 'utf8')).toContain('ghost');
    expect(f.notes).toEqual([]);
  });

  test('an agent that fails is a failed tick with its last words', async () => {
    const p = project();
    p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs');
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: async () => ({ ok: false, output: 'model not found' }), ...fakes() } });
    expect(r).toMatchObject({ ran: 'failed', error: 'the agent did not finish: model not found' });
  });

  test('when the remote cannot be fetched, no model runs, and the next tick tries again', async () => {
    const p = project();
    expect((await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: NONE })).ran).toBe('nothing');
    p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs');
    renameSync(p.origin, `${p.origin}.away`);
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: NONE });
    expect(r).toMatchObject({ ran: 'failed', error: expect.stringContaining('git fetch') });
    expect(await readState(p.dataDir, KEY)).toMatchObject({ failed: null, last_error: expect.stringContaining('git fetch') });
    expect(existsSync(p.paths.failed)).toBe(false);
    renameSync(`${p.origin}.away`, p.origin);
    expect((await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent(ADD_JOBS).runAgent, ...fakes() } })).ran).toBe('redrew');
    expect(await readState(p.dataDir, KEY)).toMatchObject({ failed: null, last_error: null, set_aside: null });
  });

  const oldClones = (failed: string) => (existsSync(failed) ? readdirSync(failed).filter((n) => n.startsWith('source-')) : []);

  test('when an object the source clone borrows is gone from the person\'s repo, the next tick clones again and redraws', async () => {
    const p = project();
    const a = p.land({ 'src/main.ts': 'main, now with a banner\n' }, 'A banner');
    git(p.root, 'fetch', '-q', 'origin');
    expect(await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: NONE })).toMatchObject({ ran: 'gated', gated: a });
    expect(readFileSync(join(p.paths.source, '.git', 'objects', 'info', 'alternates'), 'utf8')).toContain(join(p.root, '.git', 'objects'));
    expect(readdirSync(join(p.paths.source, '.git', 'objects')).filter((n) => /^[0-9a-f]{2}$/.test(n))).toEqual([]);

    const blob = git(p.root, 'rev-parse', `${a}:src/main.ts`).trim();
    renameSync(join(p.root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), join(p.dir, 'lost-blob'));
    expect(() => git(p.paths.source, 'cat-file', '-e', blob)).toThrow();

    const tip = p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs (#12)');
    const f = fakes();
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent(ADD_JOBS).runAgent, notify: f.notify } });
    expect(r).toMatchObject({ ran: 'redrew', gated: tip });
    expect(drawingFiles(p.paths.drawing)['system.yaml']).toContain(`at: "${tip}"`);
    expect(f.notes).toHaveLength(1);
    const old = oldClones(p.paths.failed);
    expect(old).toHaveLength(1);
    expect(existsSync(join(p.paths.failed, old[0]!, '.git'))).toBe(true);
    expect(existsSync(join(p.paths.source, '.git', 'objects', 'info', 'alternates'))).toBe(false);
    git(p.paths.source, 'rev-list', '--objects', '--no-walk', tip);
    git(p.paths.source, 'cat-file', '-e', blob);
    expect(git(p.paths.source, 'rev-parse', 'HEAD').trim()).toBe(tip);
    expect(await readState(p.dataDir, KEY)).toMatchObject({ last_error: null, failed: null, set_aside: expect.stringContaining(join(p.paths.failed, old[0]!)) });

    p.land({ 'src/main.ts': 'main, banner and footer\n' }, 'A footer');
    expect((await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: NONE })).ran).toBe('gated');
    expect(oldClones(p.paths.failed)).toHaveLength(1);
  });

  test('after git gc drops what the source clone borrowed, its fetch takes the objects again and the redraw goes on', async () => {
    const p = project();
    const a = p.land({ 'src/main.ts': 'main, now with a banner\n' }, 'A banner');
    git(p.root, 'fetch', '-q', 'origin');
    expect((await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: NONE })).ran).toBe('gated');
    git(p.root, 'remote', 'set-head', 'origin', '-d');
    git(p.root, 'update-ref', '-d', 'refs/remotes/origin/main');
    git(p.root, 'reflog', 'expire', '--expire=now', '--all');
    git(p.root, 'gc', '-q', '--prune=now');
    expect(() => git(p.paths.source, 'cat-file', '-e', `${a}^{commit}`)).toThrow();
    const tip = p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs (#12)');
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent(ADD_JOBS).runAgent, ...fakes() } });
    expect(r).toMatchObject({ ran: 'redrew', gated: tip });
    git(p.paths.source, 'rev-list', '--objects', '--no-walk', tip, a);
  });

  test('when the person moves the repo, the folder the source clone borrows from is gone: the next tick clones again and redraws', async () => {
    const p = project();
    expect((await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: NONE })).ran).toBe('nothing');
    const moved = `${p.root}-moved`;
    renameSync(p.root, moved);
    const tip = p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs (#12)');
    const r = await tick({ root: moved, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent(ADD_JOBS).runAgent, ...fakes() } });
    expect(r).toMatchObject({ ran: 'redrew', gated: tip });
    expect(oldClones(p.paths.failed)).toHaveLength(1);
    expect(readFileSync(join(p.paths.source, '.git', 'objects', 'info', 'alternates'), 'utf8')).toContain(join(moved, '.git', 'objects'));
  });

  test('a tick stopped between the two renames of the swap left no drawing: the next tick puts the last good one back and redraws', async () => {
    const p = project();
    const good = drawingFiles(p.paths.drawing);
    const tip = p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs (#12)');
    renameSync(p.paths.drawing, p.paths.previous);
    writeTree(p.paths.redraw, { 'system.yaml': 'the checked copy\n' });
    const now = new Date('2026-11-07T09:00:00Z');
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, now, deps: { runAgent: scriptAgent(ADD_JOBS).runAgent, ...fakes() } });
    expect(r).toMatchObject({ ran: 'redrew', gated: tip });
    expect(drawingFiles(p.paths.drawing)['system.yaml']).toContain(`at: "${tip}"`);
    expect(drawingFiles(p.paths.previous)).toEqual(good);
    expect(readFileSync(join(p.paths.failed, 'interrupted-2026-11-07T09-00-00-000Z', 'drawing', 'system.yaml'), 'utf8')).toBe('the checked copy\n');
  });

  test('a swap whose second rename fails puts the drawing back: the redraw is refused and the last good drawing stays', async () => {
    const p = project();
    const good = drawingFiles(p.paths.drawing);
    const tip = p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs (#12)');
    // a file held open in redraw/ (Windows: EBUSY) fails the rename that would put the redraw in place
    const rename: TickDeps['rename'] = async (from, to) => {
      if (from === p.paths.redraw && to === p.paths.drawing) throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${from}'`), { code: 'EBUSY' });
      renameSync(from, to);
    };
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent(ADD_JOBS).runAgent, ...fakes(), rename } });
    expect(r).toMatchObject({ ran: 'failed', error: expect.stringContaining('EBUSY') });
    expect(drawingFiles(p.paths.drawing)).toEqual(good);
    expect(readFileSync(join(p.paths.failed, tip, 'drawing', 'system.yaml'), 'utf8')).toContain('jobsp');
    expect(await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: NONE })).toMatchObject({ ran: 'nothing', why: expect.stringContaining('failed; waiting for main to move') });
  });

  test('a swap whose second rename and move back both fail reports the first failure, with the second', async () => {
    const p = project();
    p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs (#12)');
    const rename: TickDeps['rename'] = async (from, to) => {
      if (from === p.paths.redraw) throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${from}'`), { code: 'EBUSY' });
      if (from === p.paths.previous) throw Object.assign(new Error(`EACCES: permission denied, rename '${from}'`), { code: 'EACCES' });
      renameSync(from, to);
    };
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent(ADD_JOBS).runAgent, ...fakes(), rename } });
    expect(r.ran).toBe('failed');
    expect(r.error).toStartWith('EBUSY');
    expect(r.error).toContain('EACCES');
    expect(await readState(p.dataDir, KEY)).toMatchObject({ last_error: expect.stringMatching(/^EBUSY.*EACCES/) });
  });

  test('a drawing still being drawn (sheets under wanted:) is not redrawn or fetched for; once nothing is wanted, the next tick redraws', async () => {
    const p = project();
    const half = drawing(p.drawnAt);
    half['system.yaml'] += 'wanted:\n  - { code: F-201, kind: flow, question: "How a job runs." }\n';
    writeTree(p.paths.drawing, half);
    p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs (#12)');
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: NONE });
    expect(r).toMatchObject({ ran: 'nothing', why: expect.stringContaining('still being drawn') });
    expect(existsSync(p.paths.source)).toBe(false);
    expect(drawingFiles(p.paths.drawing)).toEqual(half);
    writeTree(p.paths.drawing, drawing(p.drawnAt));
    expect((await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent(ADD_JOBS).runAgent, ...fakes() } })).ran).toBe('redrew');
  });

  test('a wanted entry whose sheet is drawn is not "still drawing": the tick reads it as the Inbox\'s status does', async () => {
    const p = project();
    const files = drawing(p.drawnAt);
    files['system.yaml'] += 'wanted:\n  - { code: L-101, kind: logical, question: "The app." }\n';
    writeTree(p.paths.drawing, files);
    expect(drawingStatus(await load(p.paths.drawing)).state).toBe('drawn');
    expect(await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: NONE })).toMatchObject({ ran: 'nothing', why: 'main has not moved' });
  });

  test('a redraw that leaves a sheet under wanted: is refused, so a finished drawing never stops later redraws', async () => {
    const p = project();
    const before = drawingFiles(p.paths.drawing);
    p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs (#12)');
    const agent = scriptAgent(`${ADD_JOBS}\nprintf 'wanted:\\n  - { code: F-201, kind: flow, question: "How a job runs." }\\n' >> "$DRAWING/system.yaml"`);
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: agent.runAgent, ...fakes() } });
    expect(r).toMatchObject({ ran: 'failed', error: expect.stringContaining('Sheet F-201 is listed under wanted') });
    expect(drawingFiles(p.paths.drawing)).toEqual(before);
  });

  test("a private repo: the person's repo-local url.<base>.insteadOf and an includeIf'd core.sshCommand reach origin from the source clone, and are read again each tick", async () => {
    const p = project();
    const dir = p.dir;
    const script = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
      return join(dir, name);
    };
    const recorder = (name: string) => script(`${name}.sh`, `echo "$*" >> "${join(dir, `${name}.log`)}"\nfor last; do :; done\nexec sh -c "$last"`);
    recorder('ssh-work');
    recorder('ssh-work-2');
    const tripwire = script('ssh-tripwire.sh', `echo "$*" >> "${join(dir, 'tripwire.log')}"\nexit 1`);
    git(p.root, 'remote', 'set-url', 'origin', 'work:origin.git');
    git(p.root, 'config', `url.ssh://git.example.test${dir}/.insteadOf`, 'work:');
    const work = join(dir, 'work.gitconfig');
    const sshCommand = (name: string) => git(dir, 'config', '--file', work, 'core.sshCommand', `sh "${join(dir, `${name}.sh`)}"`);
    sshCommand('ssh-work');
    const global = join(dir, 'global.gitconfig');
    writeFileSync(global, `[includeIf "gitdir:${realpathSync(p.root)}/"]\n\tpath = ${work}\n`);
    const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_SSH: process.env.GIT_SSH };
    process.env.GIT_CONFIG_GLOBAL = global;
    process.env.GIT_SSH = tripwire;
    try {
      expect(await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: NONE })).toMatchObject({ ran: 'nothing', why: 'main has not moved', gated: p.drawnAt });
      expect(readFileSync(join(dir, 'ssh-work.log'), 'utf8')).toContain(`git.example.test git-upload-pack '${dir}/origin.git'`);
      expect(existsSync(join(dir, 'tripwire.log'))).toBe(false);
      const own = execFileSync('git', ['-C', p.paths.source, 'ls-remote', 'origin', 'refs/heads/main'], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8',
      });
      expect(own).toContain(p.drawnAt);
      sshCommand('ssh-work-2');
      const tip = p.land({ 'src/util.ts': 'x\n' }, 'add util');
      expect(await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent('true').runAgent, ...fakes() } })).toMatchObject({ gated: tip });
      expect(readFileSync(join(dir, 'ssh-work-2.log'), 'utf8')).toContain('git-upload-pack');
      expect(existsSync(join(dir, 'tripwire.log'))).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test('a checkout in the source clone downloads no Git LFS objects: every smudge runs with GIT_LFS_SKIP_SMUDGE=1', async () => {
    const p = project();
    p.land({ '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'assets/model.bin': 'a pointer file\n' }, 'Add a model');
    const smudge = join(p.dir, 'smudge.sh');
    writeFileSync(smudge, `#!/bin/sh\necho "skip=$GIT_LFS_SKIP_SMUDGE" >> "${join(p.dir, 'smudge.log')}"\ncat\n`);
    chmodSync(smudge, 0o755);
    const global = join(p.dir, 'global.gitconfig');
    writeFileSync(global, `[filter "lfs"]\n\tclean = cat\n\tsmudge = ${smudge}\n\trequired = true\n`);
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = global;
    try {
      const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent('true').runAgent, ...fakes() } });
      expect(r).toMatchObject({ ran: 'gated' });
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved;
    }
    const calls = readFileSync(join(p.dir, 'smudge.log'), 'utf8').trim().split('\n');
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls)).toEqual(new Set(['skip=1']));
  });

  test('a commit in the new range whose objects the source clone borrowed and lost is found: the clone is made again and the redraw goes on', async () => {
    const p = project();
    expect((await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: NONE })).ran).toBe('nothing');
    p.land({ 'src/main.ts': 'main, now with a banner\n' }, 'A banner (#11)');
    const b = git(p.team, 'rev-parse', 'HEAD').trim();
    const tip = p.land({ 'src/main.ts': 'main, banner and footer\n', 'src/jobs.ts': 'jobs\n' }, 'Run jobs (#12)');
    git(p.root, 'fetch', '-q', 'origin');
    const blob = git(p.root, 'rev-parse', `${b}:src/main.ts`).trim();
    renameSync(join(p.root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), join(p.dir, 'lost-blob'));
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: scriptAgent(`git log -p ${p.drawnAt}..HEAD > /dev/null`).runAgent, ...fakes() } });
    expect(r).toMatchObject({ ran: 'gated', gated: tip });
    expect(oldClones(p.paths.failed)).toHaveLength(1);
    git(p.paths.source, 'cat-file', '-e', blob);
  });

  test('a re-clone keeps the newest two old source clones under failed/ and removes the older ones', async () => {
    const p = project();
    expect((await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: NONE })).ran).toBe('nothing');
    const earlier = ['source-2026-01-01T00-00-00-000Z', 'source-2026-02-01T00-00-00-000Z', 'source-2026-03-01T00-00-00-000Z'];
    for (const n of earlier) mkdirSync(join(p.paths.failed, n, '.git'), { recursive: true });
    mkdirSync(join(p.paths.failed, 'interrupted-2026-01-01T00-00-00-000Z'), { recursive: true });
    const moved = `${p.root}-moved`;
    renameSync(p.root, moved);
    p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs (#12)');
    const now = new Date('2026-11-07T10:00:00Z');
    expect((await tick({ root: moved, dataDir: p.dataDir, key: KEY, now, deps: { runAgent: scriptAgent(ADD_JOBS).runAgent, ...fakes() } })).ran).toBe('redrew');
    expect(oldClones(p.paths.failed).sort()).toEqual(['source-2026-03-01T00-00-00-000Z', 'source-2026-11-07T10-00-00-000Z']);
    expect(existsSync(join(p.paths.failed, 'interrupted-2026-01-01T00-00-00-000Z'))).toBe(true);
  });

  test('a tick whose lock another holder broke stops before the swap: it swaps, saves and moves nothing more', async () => {
    const p = project();
    const before = drawingFiles(p.paths.drawing);
    p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs (#12)');
    const other = JSON.stringify({ token: 'another-holder', pid: process.pid });
    const agent = scriptAgent(`${ADD_JOBS}\nprintf '%s' '${other}' > '${p.paths.lock}'`);
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: agent.runAgent, ...fakes() } });
    expect(r).toMatchObject({ ran: 'failed', error: expect.stringContaining('lost tick.lock') });
    expect(drawingFiles(p.paths.drawing)).toEqual(before);
    expect(existsSync(p.paths.redraw)).toBe(true);
    expect(await readState(p.dataDir, KEY)).toMatchObject({ gated: null, failed: null, last_error: null });
    expect(readFileSync(p.paths.lock, 'utf8')).toBe(other);
  });

  for (const [what, extra, check] of [
    ['changes nothing', '', (p: ReturnType<typeof project>) => {
      expect(existsSync(p.paths.redraw)).toBe(true);
    }],
    ['leaves a file in the source clone', `\necho stray > stray.txt`, (p: ReturnType<typeof project>) => {
      expect(readFileSync(join(p.paths.source, 'stray.txt'), 'utf8')).toBe('stray\n');
      expect(existsSync(p.paths.changed)).toBe(false);
    }],
  ] as const) {
    test(`a tick whose lock was broken while its agent ran, an agent that ${what}, touches nothing after the agent`, async () => {
      const p = project();
      const before = drawingFiles(p.paths.drawing);
      p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs (#12)');
      const other = JSON.stringify({ token: 'another-holder', pid: process.pid });
      const agent = scriptAgent(`printf '%s' '${other}' > '${p.paths.lock}'${extra}`);
      const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: agent.runAgent, ...fakes() } });
      expect(r).toMatchObject({ ran: 'failed', error: expect.stringContaining('lost tick.lock') });
      check(p);
      expect(drawingFiles(p.paths.drawing)).toEqual(before);
      expect(await readState(p.dataDir, KEY)).toMatchObject({ gated: null, failed: null, last_error: null });
    });
  }

  test('a lock that cannot be taken (a file system that refuses it) is a failed tick recorded in state.json, never a throw', async () => {
    const p = project();
    const takeLock: TickDeps['takeLock'] = async () => {
      throw Object.assign(new Error('EIO: i/o error, link'), { code: 'EIO' });
    };
    const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { ...NONE, takeLock } });
    expect(r).toMatchObject({ ran: 'failed', error: expect.stringContaining('EIO') });
    expect(await readState(p.dataDir, KEY)).toMatchObject({ last_error: expect.stringContaining('tick.lock could not be taken: EIO') });
  });

  test('a live tick holds the lock; a dead one is taken over', async () => {
    const p = project();
    p.land({ 'src/util.ts': 'x\n' }, 'add util');
    writeFileSync(p.paths.lock, String(process.pid));
    expect(await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: NONE })).toMatchObject({ ran: 'nothing', why: 'another tick is running' });
    expect(readFileSync(p.paths.lock, 'utf8')).toBe(String(process.pid));
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
  expect(await mergedPrs(p.team, from, to, ['b.ts'])).toEqual([22]);
});

test('mergedPrs keeps a pull request whose rename touched a given file, by its old path or its new one', async () => {
  const p = project();
  const from = git(p.team, 'rev-parse', 'HEAD').trim();
  git(p.team, 'mv', 'src/main.ts', 'src/app.ts');
  git(p.team, 'commit', '-q', '-m', 'Rename the entry (#12)');
  const to = p.land({ 'b.ts': 'b\n' }, 'Add b (#13)');
  expect(await mergedPrs(p.team, from, to, ['src/main.ts'])).toEqual([12]);
  expect(await mergedPrs(p.team, from, to, ['src/app.ts'])).toEqual([12]);
  expect(await mergedPrs(p.team, from, to, ['src/main.ts', 'b.ts'])).toEqual([12, 13]);
});

test('a redraw prompt lists the pull request that renamed a drawn file', async () => {
  const p = project();
  git(p.team, 'mv', 'src/main.ts', 'src/app.ts');
  git(p.team, 'commit', '-q', '-m', 'Rename the entry (#12)');
  p.land({ 'src/jobs.ts': 'jobs\n' }, 'Run jobs (#13)');
  const agent = scriptAgent('true');
  const r = await tick({ root: p.root, dataDir: p.dataDir, key: KEY, deps: { runAgent: agent.runAgent, ...fakes() } });
  expect(r.ran).toBe('gated');
  const prompt = agent.prompts[0]!;
  expect(prompt).toContain('src/main.ts');
  expect(prompt).toContain('  - PR 12');
  expect(prompt).toContain('  - PR 13');
});

test("the CLI's git reads (check and gate against the person's repo) take no optional lock: a status through them leaves a stale index as it was", async () => {
  const p = project();
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(p.root, 'src', 'main.ts'), later, later);
  const index = () => createHash('sha256').update(readFileSync(join(p.root, '.git', 'index'))).digest('hex');
  const before = index();
  await gitBytes(p.root, ['status', '--porcelain']);
  expect(index()).toBe(before);
});

test('redrawNote: the words of the note', () => {
  const base = { to: '9c41e07aaaa' };
  expect(redrawNote({ ...base, prs: [1335], summary: 'On the Desktop app sheet, stable now shows a corner, not a header.', count: { parts: 1, flows: 0 } }))
    .toBe('Main moved to 9c41e07. PR 1335 landed: On the Desktop app sheet, stable now shows a corner, not a header. 1 part changed.');
  expect(redrawNote({ ...base, prs: [], summary: '', count: { parts: 0, flows: 2 } })).toBe('Main moved to 9c41e07. 2 lines changed.');
  expect(redrawNote({ ...base, prs: [4, 5], summary: '', count: { parts: 2, flows: 0 }, also: ['src/a.ts'] })).toBe('Main moved to 9c41e07. PRs 4, 5 landed. 2 parts changed. This redraw also changed: src/a.ts.');
});

test('a command past its time bound is stopped with its whole process group, children included', async () => {
  const t = tempDir();
  cleanups.push(t.done);
  const dir = t.dir;
  const pidFile = join(dir, 'child.pid');
  const r = await runCommand(['sh', '-c', `sleep 30 & echo $! > '${pidFile}'; wait`], { cwd: dir, timeoutMs: 300 });
  expect(r.timedOut).toBe(true);
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 50 && alive(); i++) await new Promise((ok) => setTimeout(ok, 100));
  expect(alive()).toBe(false);
});

test('a command that ends while an escaped child still holds its output returns after the grace, with its output and code', async () => {
  const t = tempDir();
  cleanups.push(t.done);
  const pidFile = join(t.dir, 'escapee.pid');
  const started = Date.now();
  try {
    const r = await runCommand(['sh', '-c', `${escapee(pidFile)}; echo done`], { cwd: t.dir, timeoutMs: 60_000 });
    expect(r).toMatchObject({ code: 0, stdout: 'done\n', timedOut: false });
    expect(Date.now() - started).toBeLessThan(5000 + 4000);
  } finally {
    killPidFile(pidFile);
  }
}, 30_000);

test('a command that ends in time is not marked as stopped', async () => {
  const t = tempDir();
  cleanups.push(t.done);
  const r = await runCommand(['sh', '-c', 'echo done'], { cwd: t.dir, timeoutMs: 10_000 });
  expect(r).toMatchObject({ code: 0, stdout: 'done\n', timedOut: false });
});
