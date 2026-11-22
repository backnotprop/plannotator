/**
 * Guard for the docs-only rule (scripts/ci-docs-only.sh): a PR that changes
 * only root docs, LICENSE-*, .github/assets, adr/, docs/ outside
 * docs/agent-guides, or the iPhone app's Swift and Xcode files under
 * apps/mobile/ios runs no test, build or scan but Gitleaks and the pickers
 * (scripts/ci-affected.ts reads the script's verdict).
 *
 * What can regress, and the test that says so:
 *   - the allowlist takes a path some test, build or scanner reads, so a PR
 *     that breaks it skips the only run that would say so (the table, and
 *     "no code reads an allowlisted file");
 *   - the gate skips where it cannot know the diff: a push, a merge queue, a
 *     checkout that is not the PR merge commit, an empty diff, a rename out of
 *     packages/ (the git rows);
 *   - the picker stops taking the script's verdict, or Gitleaks gets gated
 *     (the picker rows).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const SCRIPT = join(repoRoot, 'scripts/ci-docs-only.sh');


const classifyRaw = (lines: string[]) =>
  Bun.spawnSync(['bash', SCRIPT, 'classify'], { stdin: new TextEncoder().encode(lines.join('\n')) }).stdout.toString().trim();
/** A `git diff --raw` line: a plain file (100644) changed, unless other modes are given. */
const raw = (file: string, oldMode = '100644', newMode = '100644') => `:${oldMode} ${newMode} 1111111 2222222 M\t${file}`;
const classify = (paths: string[]) => classifyRaw(paths.map((f) => raw(f)));

const EVERYTHING = 'everything';
const CHEAP = 'cheap lanes only';
const lanes = (paths: string[]) => (classify(paths) === 'docs' ? CHEAP : EVERYTHING);

describe('which lanes a change runs', () => {
  const rows: [string, string[], string][] = [
    ['README only', ['README.md'], CHEAP],
    ['root docs, licenses, README images', ['CONTRIBUTING.md', 'SECURITY.md', 'LICENSE-MIT', 'LICENSE-APACHE', '.github/assets/inbox-dark.webp', '.github/assets/icons/pi-dark.svg'], CHEAP],
    ['adr and docs/ pages and pictures', ['adr/0001-record-architecture-decisions.md', 'adr/research/x.svg', 'docs/vim-controls.md', 'docs/releases/0.28.31/first-run.png', 'docs/releases/0.29/shot.jpeg'], CHEAP],
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
    ['a folder named like a doc', ['docs/x.md/evil.ts'], EVERYTHING],
    ['a look-alike name', ['README.md.ts', 'LICENSE-MIT.js', 'xREADME.md'], EVERYTHING],
    ['another case', ['readme.md', 'Docs/x.md', 'ADR/x.md', '.github/assets/x.PNG'], EVERYTHING],
    // git C-quotes unusual names: never matches, so it runs (the safe direction).
    ['a quoted path', ['"docs/caf\\303\\251.md"'], EVERYTHING],
    // Code in the allowlisted folders: `bun test` discovers *.test.ts anywhere, tests/helpers/published-packages.ts
    // walks the tree for package.json, Semgrep scans every JS/TS and shell file. None of them names a path.
    ['a test file under docs/releases', ['docs/releases/0.30/notes.test.ts'], EVERYTHING],
    ['a package.json under adr/', ['adr/spike/package.json'], EVERYTHING],
    ['a package.json under docs/releases', ['docs/releases/x/package.json'], EVERYTHING],
    ['a .ts under .github/assets', ['.github/assets/x.ts'], EVERYTHING],
    ['a .js under .github/assets', ['.github/assets/x.js'], EVERYTHING],
    ['a shell script under adr/', ['adr/x.sh'], EVERYTHING],
    ['a .ts under adr/', ['adr/research/x.ts'], EVERYTHING],
    // The iPhone app: only mobile-ios.yml builds its Swift and Xcode files.
    ['the iPhone app\'s Swift, Xcode and asset files', ['apps/mobile/ios/App/InboxApp.swift', 'apps/mobile/ios/Inbox.xcodeproj/project.pbxproj', 'apps/mobile/ios/App/Info.plist', 'apps/mobile/ios/App/Assets.xcassets/AppIcon.appiconset/Contents.json', 'apps/mobile/ios/Local.example.xcconfig', 'apps/mobile/ios/App/Inbox.entitlements'], CHEAP],
    // Semgrep scans shell; `bun test` finds *.test.ts anywhere; the package walk finds package.json; tests read the contract.
    ['the iPhone app\'s own ignore file', ['apps/mobile/ios/.gitignore'], CHEAP],
    ['an ignore file elsewhere', ['apps/mobile/.gitignore'], EVERYTHING],
    ['the iPhone app\'s CI script', ['apps/mobile/ios/ci.sh'], EVERYTHING],
    ['the iPhone app\'s Swift lockfile', ['apps/mobile/ios/InboxCore/Package.resolved'], EVERYTHING],
    ['a test file under apps/mobile/ios', ['apps/mobile/ios/x.test.ts'], EVERYTHING],
    ['a package.json under apps/mobile/ios', ['apps/mobile/ios/package.json'], EVERYTHING],
    ['JSON outside an asset catalog under apps/mobile/ios', ['apps/mobile/ios/fixture.json'], EVERYTHING],
    ['the app contract', ['apps/mobile/contract/door.json', 'apps/mobile/contract/generated/swift/Wire.swift'], EVERYTHING],
    ['Swift plus one .ts file', ['apps/mobile/ios/App/InboxApp.swift', 'packages/ui/utils/x.ts'], EVERYTHING],
  ];
  for (const [name, paths, expected] of rows) test(name, () => expect(lanes(paths)).toBe(expected));

  test('an added or deleted doc is still docs', () => {
    expect(classifyRaw([raw('README.md', '000000', '100644'), raw('docs/old.md', '100644', '000000')])).toBe('docs');
  });
  test('only plain files: an executable doc, a symlink or a gitlink runs everything', () => {
    expect(classifyRaw([raw('README.md', '100644', '100755')]), 'made executable').toBe('code');
    expect(classifyRaw([raw('adr/run.md', '000000', '100755')]), 'added executable').toBe('code');
    expect(classifyRaw([raw('README.md', '100755', '100644')]), 'was executable').toBe('code');
    expect(classifyRaw([raw('adr/research', '000000', '120000')]), 'symlink').toBe('code');
    expect(classifyRaw([raw('README.md', '100644', '120000')]), 'file to symlink').toBe('code');
    expect(classifyRaw([raw('adr/vendor', '000000', '160000')]), 'gitlink').toBe('code');
  });
  test('a line it cannot parse runs everything', () => {
    expect(classifyRaw(['README.md'])).toBe('code');
    expect(classifyRaw([raw('README.md'), 'garbage'])).toBe('code');
  });
  test('a pattern the shell cannot compile runs everything (a match error is never a pass)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-docs-only-pattern-'));
    try {
      const broken = join(dir, 'gate.sh');
      writeFileSync(broken, readFileSync(SCRIPT, 'utf8').replace(/^DOCS_ONLY='\^\(/m, "DOCS_ONLY='^(("));
      expect(readFileSync(broken, 'utf8')).toContain("DOCS_ONLY='^((");
      const r = Bun.spawnSync(['bash', broken, 'classify'], { stdin: new TextEncoder().encode(raw('README.md')) });
      expect(r.stdout.toString().trim()).toBe('code');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
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
    write('docs/guide.md');
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

  function gate(repo: string, event = 'pull_request', PATH = env.PATH): string {
    const output = join(repo, '.gh-output');
    writeFileSync(output, '');
    const r = Bun.spawnSync(['bash', SCRIPT], { cwd: repo, env: { ...env, PATH, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: output } });
    expect(r.exitCode).toBe(0);
    return readFileSync(output, 'utf8').trim();
  }

  test('a README-only PR skips', () => expect(gate(prRepo((_, write) => write('README.md')))).toBe('skip=true'));
  test('README plus a .ts file runs', () =>
    expect(gate(prRepo((_, write) => { write('README.md'); write('packages/x.ts'); }))).toBe('skip=false'));
  test('a file moved from packages/ into docs/ runs (no rename detection: the old path counts)', () =>
    expect(gate(prRepo((git) => git('mv', 'packages/x.ts', 'docs/x.md')))).toBe('skip=false'));
  test('an empty diff runs', () => expect(gate(prRepo(() => {}))).toBe('skip=false'));
  test('a push, a merge queue or a manual run runs, whatever changed', () => {
    const repo = prRepo((_, write) => write('README.md'));
    for (const event of ['push', 'merge_group', 'workflow_dispatch', 'schedule', '']) expect(gate(repo, event), event).toBe('skip=false');
  });
  test('a checkout that is not the PR merge commit runs', () =>
    expect(gate(prRepo((_, write) => write('README.md'), false))).toBe('skip=false'));
  test('a doc moved into packages/ runs', () =>
    expect(gate(prRepo((git) => git('mv', 'docs/guide.md', 'packages/guide.ts')))).toBe('skip=false'));
  test('a symlink under adr/ runs', () =>
    expect(gate(prRepo((_, __, repo) => { mkdirSync(join(repo, 'adr')); symlinkSync('../packages', join(repo, 'adr/research')); }))).toBe('skip=false'));
  test('a gitlink under adr/ runs', () =>
    expect(gate(prRepo((git) => git('update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},adr/vendor`)))).toBe('skip=false'));
  test('a doc made executable runs (a mode-only change)', () =>
    expect(gate(prRepo((_, __, repo) => chmodSync(join(repo, 'README.md'), 0o755)))).toBe('skip=false'));
  test('a failing git diff runs, even when it printed docs-only lines first', () => {
    const repo = prRepo((_, write) => write('README.md'));
    expect(gate(repo), 'the honest run').toBe('skip=true');
    const bin = join(dir, 'failing-git');
    mkdirSync(bin, { recursive: true });
    const git = Bun.which('git')!;
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = diff ]; then printf ':100644 100644 1111111 2222222 M\\tREADME.md\\n'; exit 2; fi\nexec '${git}' "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    expect(gate(repo, 'pull_request', `${bin}:${env.PATH}`)).toBe('skip=false');
  });
});

type Job = { if?: string; needs?: unknown };
const jobsOf = (file: string) => (Bun.YAML.parse(readFileSync(join(repoRoot, file), 'utf8')) as { jobs: Record<string, Job> }).jobs;

describe('the picker takes this verdict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-docs-only-picker-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'ci', GIT_AUTHOR_EMAIL: 'ci@example.invalid', GIT_COMMITTER_NAME: 'ci', GIT_COMMITTER_EMAIL: 'ci@example.invalid' };
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: dir, env });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.toString().trim();
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'a\n');
  writeFileSync(join(dir, 'x.ts'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');

  test('a README change is docs only to scripts/ci-affected.ts; a README plus a .ts file is not', async () => {
    const { docsOnly } = await import('./ci-affected');
    writeFileSync(join(dir, 'README.md'), 'b\n');
    git('commit', '-q', '-am', 'docs');
    expect(docsOnly(base, git('rev-parse', 'HEAD'), dir)).toBe(true);
    writeFileSync(join(dir, 'x.ts'), 'b\n');
    git('commit', '-q', '-am', 'code');
    expect(docsOnly(base, git('rev-parse', 'HEAD'), dir)).toBe(false);
  });

  test('Gitleaks always runs, docs only or not', () => {
    const gitleaks = jobsOf('.github/workflows/security.yml').gitleaks!;
    expect(gitleaks.if).toBeUndefined();
    expect(gitleaks.needs).toBeUndefined();
  });
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
    'packages/core/fixtures/inbox-relay-push-v2-vectors.json': 'its "about" text cites the design doc',
    'packages/core/inbox-push-vectors.ts': 'it writes the push vectors\' "about" text, which cites the design doc',
    'packages/review-editor/dock/panels/artifactDocument.test.ts': 'an <img src> string in a fixture',
    'packages/shared/inbox/search.test.ts': 'an attachment path in a fixture',
    'tests/e2e/inbox-search-world.ts': 'writes its own file at that path in a temp project',
    'tests/e2e/inbox-ack.spec.ts': 'words in an agent message',
    'scripts/ci-affected.ts': 'PUSH_LIGHT: globs of the paths a light push to main may change, matched against a diff',
    'scripts/ci-affected-map.test.ts': 'paths a test of PUSH_LIGHT classifies',
    'scripts/site-lane.test.ts': 'paths a test of the site lane classifies, and files of a throwaway git history',
  };

  test('the allowlist covers real files', () => {
    expect(docs).toContain('README.md');
    expect(docs.some((f) => f.startsWith('.github/assets/'))).toBe(true);
    // Narrowing to document and image types left out nothing that is there today.
    const folders = tracked.filter((f) => /^(adr|docs\/releases|\.github\/assets)\//.test(f));
    expect(folders.filter((f) => !allowlist.test(f))).toEqual([]);
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
