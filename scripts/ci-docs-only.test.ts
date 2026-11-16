/**
 * Guard for the docs-only gate (scripts/ci-docs-only.sh): a PR that changes
 * only root docs, LICENSE-*, .github/assets, adr/ or docs/ outside
 * docs/agent-guides passes the fast tier's unit, DOM, OpenCode package, engine
 * harness, Browser smoke and Semgrep jobs without running their steps.
 *
 * What can regress, and the test that says so:
 *   - the allowlist takes a path some test, build or scanner reads, so a PR
 *     that breaks it skips the only run that would say so (the table, and
 *     "no code reads an allowlisted file");
 *   - the gate skips where it cannot know the diff: a push, a merge queue, a
 *     checkout that is not the PR merge commit, an empty diff, a rename out of
 *     packages/ (the git rows);
 *   - a gated job stops reporting SUCCESS under its own name (a job-level
 *     `if`), or reads a failed gate as "skip", or a cheap scanner gets gated
 *     (the workflow rows).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const SCRIPT = join(repoRoot, 'scripts/ci-docs-only.sh');

/** The lanes the gate skips on a docs-only PR (workflow file → job ids). */
const GATED: Record<string, string[]> = {
  '.github/workflows/test.yml': ['checks', 'unit', 'dom', 'opencode-v2', 'claude-code-mod'],
  '.github/workflows/browser-smoke.yml': ['smoke'],
  '.github/workflows/security.yml': ['semgrep'],
};
/** Cheap lanes that read docs too (secrets, workflow config), so they always run. */
const NEVER_GATED: Record<string, string[]> = {
  '.github/workflows/security.yml': ['gitleaks', 'trivy', 'zizmor'],
};

const classify = (paths: string[]) =>
  Bun.spawnSync(['bash', SCRIPT, 'classify'], { stdin: new TextEncoder().encode(paths.join('\n')) }).stdout.toString().trim();

const EVERYTHING = 'everything';
const CHEAP = 'cheap lanes only';
const lanes = (paths: string[]) => (classify(paths) === 'docs' ? CHEAP : EVERYTHING);

describe('which lanes a change runs', () => {
  const rows: [string, string[], string][] = [
    ['README only', ['README.md'], CHEAP],
    ['root docs, licenses, README images', ['CONTRIBUTING.md', 'SECURITY.md', 'LICENSE-MIT', 'LICENSE-APACHE', '.github/assets/inbox-dark.webp'], CHEAP],
    ['adr and docs/ pages', ['adr/0001-record-architecture-decisions.md', 'adr/research/x.svg', 'docs/vim-controls.md', 'docs/releases/0.28.31/first-run.png'], CHEAP],
    ['README plus one .ts file', ['README.md', 'packages/ui/utils/x.ts'], EVERYTHING],
    ['an empty diff', [], EVERYTHING],
    // tests/agents-md-size.test.ts, tests/inbox-guidance-parity.test.ts, scripts/install.test.ts and others read these.
    ['docs/agent-guides', ['docs/agent-guides/inbox.md'], EVERYTHING],
    ['AGENTS.md', ['AGENTS.md'], EVERYTHING],
    ['CLAUDE.md (a symlink tests/agents-md-size.test.ts checks)', ['CLAUDE.md'], EVERYTHING],
    // scripts/e2e-slice.test.ts reads it.
    ['the PR template', ['.github/pull_request_template.md'], EVERYTHING],
    // Shipped in npm packages, and some are read by tests (apps/hook/server/feedback-command.test.ts).
    ['a README under apps/ or packages/', ['apps/feedback-service/README.md'], EVERYTHING],
    ['a nested README', ['packages/ui/README.md'], EVERYTHING],
    ['a skill', ['apps/skills/core/plannotator/SKILL.md'], EVERYTHING],
    // Built and deployed, with its own tests, and read by tests outside it (tests/favicon-surfaces.test.ts and others).
    ['marketing content', ['apps/marketing/src/content/docs/guides/claude-code.md'], EVERYTHING],
    ['a workflow', ['README.md', '.github/workflows/test.yml'], EVERYTHING],
    ['the gate itself', ['scripts/ci-docs-only.sh'], EVERYTHING],
    ['the lockfile and manifest', ['bun.lock', 'package.json'], EVERYTHING],
    ['a nested docs folder', ['docs/sub/page.md'], EVERYTHING],
    ['a look-alike name', ['README.md.ts', 'LICENSE-MIT.js', 'xREADME.md'], EVERYTHING],
    // git C-quotes unusual names: never matches, so it runs (the safe direction).
    ['a quoted path', ['"docs/caf\\303\\251.md"'], EVERYTHING],
  ];
  for (const [name, paths, expected] of rows) test(name, () => expect(lanes(paths)).toBe(expected));
});

describe('the gate in a job', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-docs-only-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH ?? '',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'ci',
    GIT_AUTHOR_EMAIL: 'ci@example.invalid',
    GIT_COMMITTER_NAME: 'ci',
    GIT_COMMITTER_EMAIL: 'ci@example.invalid',
  };
  let n = 0;
  let writes = 0;

  /** A repo whose HEAD is a PR merge commit (base tip, then the PR head), as actions/checkout leaves it. */
  function prRepo(change: (git: (...args: string[]) => void, write: (file: string) => void, repo: string) => void, merge = true): string {
    const repo = join(dir, `r${n++}`);
    mkdirSync(repo);
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(['git', ...args], { cwd: repo, env });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    };
    const write = (file: string) => {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), `${file} ${writes++}\n`);
    };
    git('init', '-q', '-b', 'main');
    write('README.md');
    write('packages/x.ts');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'pr');
    change(git, write, repo);
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', 'pr');
    if (merge) {
      git('checkout', '-q', 'main');
      write('apps/main-moved.ts');
      git('add', '-A');
      git('commit', '-q', '-m', 'main moved on');
      git('checkout', '-q', '--detach', 'main');
      git('merge', '-q', '--no-ff', '-m', 'merge', 'pr');
    }
    return repo;
  }

  function gate(repo: string, event = 'pull_request'): string {
    const output = join(repo, '.gh-output');
    writeFileSync(output, '');
    const r = Bun.spawnSync(['bash', SCRIPT], { cwd: repo, env: { ...env, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: output } });
    expect(r.exitCode).toBe(0);
    return readFileSync(output, 'utf8').trim();
  }

  test('a README-only PR skips', () => expect(gate(prRepo((_, write) => write('README.md')))).toBe('skip=true'));
  test('README plus a .ts file runs', () =>
    expect(gate(prRepo((_, write) => { write('README.md'); write('packages/x.ts'); }))).toBe('skip=false'));
  test('a file moved from packages/ into docs/ runs (no rename detection: the old path counts)', () =>
    expect(gate(prRepo((git, _, repo) => { mkdirSync(join(repo, 'docs')); git('mv', 'packages/x.ts', 'docs/x.md'); }))).toBe('skip=false'));
  test('an empty diff runs', () => expect(gate(prRepo(() => {}))).toBe('skip=false'));
  test('a push, a merge queue or a manual run runs, whatever changed', () => {
    const repo = prRepo((_, write) => write('README.md'));
    for (const event of ['push', 'merge_group', 'workflow_dispatch', 'schedule', '']) expect(gate(repo, event), event).toBe('skip=false');
  });
  test('a checkout that is not the PR merge commit runs', () =>
    expect(gate(prRepo((_, write) => write('README.md'), false))).toBe('skip=false'));
});

type Step = { id?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown>; 'continue-on-error'?: boolean };
type Job = { if?: string; name?: string; steps?: Step[] };
const jobsOf = (file: string) => (Bun.YAML.parse(readFileSync(join(repoRoot, file), 'utf8')) as { jobs: Record<string, Job> }).jobs;

describe('the gated jobs', () => {
  for (const [file, ids] of Object.entries(GATED)) {
    for (const id of ids) {
      test(`${file} ${id}: passes under its own name and runs every step unless the gate said skip`, () => {
        const job = jobsOf(file)[id]!;
        // A job-level `if` reports SKIPPED (a matrix job under an unexpanded name); the merge script wants SUCCESS by name.
        expect(job.if, 'job-level if').toBeUndefined();
        const steps = job.steps ?? [];
        const at = steps.findIndex((s) => s.id === 'docs');
        expect(at, 'gate step').toBeGreaterThan(0);
        expect(steps.slice(0, at).every((s) => s.uses?.startsWith('actions/checkout@'))).toBe(true);
        expect(steps[at - 1]!.with?.['fetch-depth'], 'the merge commit and both parents').toBe(2);
        expect(steps[at]!.run?.trim()).toBe('bash scripts/ci-docs-only.sh');
        // A failed gate leaves no output, which must read as "run".
        expect(steps[at]!['continue-on-error']).toBe(true);
        for (const step of steps.slice(at + 1)) expect(step.if ?? '', step.id ?? step.run ?? step.uses).toContain("steps.docs.outputs.skip != 'true'");
      });
    }
  }
  for (const [file, ids] of Object.entries(NEVER_GATED)) {
    for (const id of ids) {
      test(`${file} ${id} always runs`, () => {
        expect(JSON.stringify(jobsOf(file)[id])).not.toContain('steps.docs');
      });
    }
  }
});

describe('no code reads an allowlisted file', () => {
  const tracked = Bun.spawnSync(['git', 'ls-files'], { cwd: repoRoot }).stdout.toString().split('\n').filter(Boolean);
  // The script's own allowlist (an ERE that JS reads the same), so every tracked file needs no process of its own.
  const allowlist = new RegExp(/^DOCS_ONLY='([^']+)'$/m.exec(readFileSync(SCRIPT, 'utf8'))![1]!);
  const docs = tracked.filter((f) => allowlist.test(f));
  const isComment = (text: string) => /^\s*(\*|\/\/|#|\/\*|<!--)/.test(text);
  const grep = (args: string[]) =>
    Bun.spawnSync(['git', 'grep', '-n', '-I', ...args, '--', ':!*.md', ':!*.mdx', ':!adr', ':!.gitignore', ':!scripts/ci-docs-only.*'], { cwd: repoRoot })
      .stdout.toString().split('\n').filter(Boolean)
      .map((line) => /^([^:]+):(\d+):(.*)$/.exec(line)!)
      .filter((m) => !isComment(m[3]!));

  // Strings that name an allowlisted path without reading it from the checkout. Add one only after checking that.
  const MENTIONS: Record<string, string> = {
    'packages/core/fixtures/inbox-relay-vectors.json': 'its "about" text cites the design doc',
    'packages/review-editor/dock/panels/artifactDocument.test.ts': 'an <img src> string in a fixture',
    'packages/shared/inbox/search.test.ts': 'an attachment path in a fixture',
    'tests/e2e/inbox-search-world.ts': 'writes its own file at that path in a temp project',
    'tests/e2e/inbox-ack.spec.ts': 'words in an agent message',
  };

  test('the allowlist covers real files', () => {
    expect(docs).toContain('README.md');
    expect(docs.some((f) => f.startsWith('.github/assets/'))).toBe(true);
  });

  test('a path under docs/, adr/ or .github/assets appears in no code', () => {
    const needles = new Set(['github/assets', 'docs/releases', 'adr/']);
    for (const f of docs) if (f.includes('/')) { needles.add(f); if (f.startsWith('docs/')) needles.add(f.split('/').pop()!); }
    const hits = grep(['-F', ...[...needles].flatMap((x) => ['-e', x])]).filter((m) => !(m[1]! in MENTIONS));
    expect(hits.map((m) => `${m[1]}:${m[2]}: ${m[3]!.trim().slice(0, 120)}`)).toEqual([]);
  });

  test('no code reads a root doc or license from the checkout', () => {
    const rootRead = /(\.\.\/)+((README|CONTRIBUTING|SECURITY)\.md|LICENSE-)/;
    const literal = /['"`](README|CONTRIBUTING|SECURITY)\.md['"`]|['"`]LICENSE-(MIT|APACHE)['"`]/;
    const fromRoot = /repoRoot|REPO_ROOT|\bROOT\b|import\.meta\.(dir|url)|process\.cwd\(\)|scriptsDir/;
    const reads = /readFileSync|readFile\(|Bun\.file|existsSync|statSync|createReadStream|readlinkSync/;
    const hits = grep(['-E', '-e', '(README|CONTRIBUTING|SECURITY)\\.md|LICENSE-(MIT|APACHE)'])
      .filter((m) => rootRead.test(m[3]!) || (literal.test(m[3]!) && fromRoot.test(m[3]!) && reads.test(m[3]!)));
    expect(hits.map((m) => `${m[1]}:${m[2]}: ${m[3]!.trim().slice(0, 120)}`)).toEqual([]);
  });
});
