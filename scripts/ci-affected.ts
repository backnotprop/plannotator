/**
 * What a PR's CI runs: the jobs and test files its change can affect.
 *
 *   bun run ci:affected --print [--base <ref>] [--head <ref>] [--scanners] [--json]
 *       your branch against the merge base with origin/main (the working tree,
 *       untracked files included, unless --head is given)
 *   bun run scripts/ci-affected.ts plan            the Test workflow's plan job
 *   bun run scripts/ci-affected.ts gate <workflow> the gate job of browser-smoke.yml,
 *                                                  security.yml or windows.yml
 *
 * A test file is affected when a changed file is in its closure over three kinds
 * of edge:
 *  - import: Bun.Transpiler.scanImports (static, require, literal dynamic import,
 *    `with { type: "file" | "text" }`), resolved by Bun.resolveSync, so tsconfig
 *    `paths`, package `exports` and workspace links count (needs `bun install`);
 *  - ref: a string literal outside comments that names a tracked file from the
 *    file's folder or the repo root (readFileSync, Bun.file, a spawned entry);
 *  - vendored: apps/pi-extension/generated/x.ts depends on the packages/ source
 *    named in its `@generated ... Source:` header (needs apps/pi-extension/vendor.sh).
 * A changed file that is not code also reaches every code file that names its
 * basename in a string (join(root, 'skills', name, 'SKILL.md')).
 * Tree-scanning tests (a test-side file that lists folders of the checkout:
 * readdir, Glob, git ls-files) can read any file, so they run on every change.
 *
 * Fail safe: the plan is `all` (every job and every test) on anything it cannot
 * decide. Skipping is the risky direction. See RUN_ALL and plan() for the list;
 * a picker error, a run that is neither a pull_request nor a push to main, or
 * the repo variable CI_AFFECTED=off also give `all`. A push to main plans its
 * commits since the last one whose Test run passed (pushChanges), and only
 * when every path they change is the site or the docs (PUSH_LIGHT); any other
 * push, or a base it cannot read, gives `all`. A docs-only change (the
 * allowlist of scripts/ci-docs-only.sh) gives `docs`: only the plan job and
 * Gitleaks run. The native app's files (apps/mobile/ios, apps/mobile/android:
 * nativeAppFile) are left out of every plan: only mobile-ios.yml builds them.
 *
 * scripts/ci-affected-map.test.ts holds the workflows to this map: every job has
 * an entry, every gated job reads its gate so that a failed gate runs it, and
 * every rule matches a tracked file.
 */
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { HEAVY_LANES, DOM_SHARDS, UNIT_SHARDS, bunfigIgnorePatterns, domList, laneNames } from './ci-test-lane';

export const repoRoot = resolve(import.meta.dir, '..');

export const TEST_RE = /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/;
export const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/** A change to one of these runs every job of the fast tier and every test: they change how tests resolve or run, or what CI does. */
export const RUN_ALL: { glob: string; why: string }[] = [
  { glob: 'bun.lock', why: 'the lockfile' },
  { glob: 'package.json', why: 'the root manifest' },
  { glob: '**/bunfig.toml', why: 'a bunfig (test preloads and loaders)' },
  { glob: '**/tsconfig*.json', why: 'a tsconfig (how imports resolve)' },
  { glob: 'patches/**', why: 'a dependency patch' },
  { glob: 'vendor/**', why: 'a vendored dependency' },
  { glob: 'tests/setup/**', why: 'the test preloads' },
  { glob: 'tests/helpers/**', why: 'a shared test helper' },
  { glob: 'packages/ui/test-setup/**', why: 'the DOM test setup' },
  { glob: 'scripts/ci-affected.ts', why: 'the picker itself' },
  { glob: 'scripts/ci-test-lane.ts', why: 'the test lanes' },
  { glob: 'scripts/dom-gating.ts', why: 'the DOM lane rules' },
  { glob: 'scripts/ci-docs-only.sh', why: 'the docs-only rule' },
  { glob: '.github/workflows/**', why: 'a workflow' },
];

/** The tree-wide guards: the Checks job runs them on every PR that is not docs-only, so the unit lanes leave them out of a subset. */
export const CORE_GUARDS = [
  'tests/never-touch-the-real-inbox.test.ts',
  'tests/no-browser-sentinel.test.ts',
  'tests/gh-tripwire.test.ts',
  'tests/agent-cli-stubs.test.ts',
  'tests/e2e-relay-pin.test.ts',
  'tests/agents-md-size.test.ts',
  'scripts/dom-test-allowlist.test.ts',
  'scripts/ci-test-lanes.test.ts',
  'scripts/ci-affected-map.test.ts',
];

/** Top-level entries the picker knows. A change under any other one runs everything. */
export const KNOWN_TOP = [
  'apps', 'packages', 'scripts', 'tests', 'build', 'docs', 'adr', 'spec', 'bin', 'patches', 'vendor', '.github', '.agents',
  '.claude-plugin', '.factory-plugin', '.product', '.adr-dir', '.gitignore', '.gitattributes', '.gitleaks.toml', '.semgrep.yml', '.semgrepignore',
  'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'README.md', 'SECURITY.md', 'LICENSE-MIT', 'LICENSE-APACHE', 'bun.lock', 'bunfig.toml',
  'openpackage.yml', 'package.json',
];

/** File kinds the graph handles: code, or data a test reaches by an import, a path string or its name. Any other kind runs everything. */
const KNOWN_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'md', 'mdx', 'json', 'jsonc', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'txt',
  'css', 'html', 'astro', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'icns', 'woff', 'woff2', 'mp4', 'webm',
  'sh', 'ps1', 'cmd', 'py', 'sql', 'qnt', 'patch', 'xml', 'lock', 'bin', 'tgz', 'mmd',
]);
// Package.resolved: a Swift lockfile (the native app's), data no Bun test reads; it plans like any data file.
const KNOWN_BARE = /^(LICENSE[-\w]*|NOTICE|README|Dockerfile|_headers|xdg-open|open-in-vscode|Package\.resolved|\.gitignore|\.gitattributes|\.vscodeignore|\.semgrepignore|\.npmignore|\.adr-dir)$/;

/**
 * The native app's own file kinds (apps/mobile/ios, apps/mobile/android):
 * Swift, Xcode project, settings and asset files, Kotlin, Java and Gradle
 * files that no Bun test reads. Only .github/workflows/mobile-ios.yml builds
 * them, on its own path filter, so the picker drops them from a plan: a PR
 * that changes only these runs no test lane and no Checks. The kinds are
 * listed, because skipping is the risky direction: anything else there (a
 * shell script, a tsconfig, a lockfile such as Package.resolved, .ts or
 * package.json) keeps the ordinary rules. A `.gitignore` there is one of the
 * kinds: it names Swift's and Xcode's own build output and no test reads it.
 */
const NATIVE_IOS = /^apps\/mobile\/ios\/(([^/]+\/)*[^/]+\.(swift|pbxproj|plist|xcconfig|entitlements|xcstrings|strings|storyboard|xib|xcscheme|xcworkspacedata|xcsettings|xctestplan|md|png|jpe?g|pdf|svg)|([^/]+\/)*[^/]+\.xcassets\/([^/]+\/)*Contents\.json|([^/]+\/)*\.gitignore)$/;
const NATIVE_ANDROID = /^apps\/mobile\/android\/(([^/]+\/)*[^/]+\.(kt|kts|java|gradle|pro|md|png|webp|jpe?g|svg)|([^/]+\/)*res\/([^/]+\/)*[^/]+\.xml|([^/]+\/)*AndroidManifest\.xml|gradle\.properties|gradle\/wrapper\/gradle-wrapper\.(jar|properties))$/;

export function nativeAppFile(path: string): boolean {
  return NATIVE_IOS.test(path) || NATIVE_ANDROID.test(path);
}

/**
 * The app contract's number (apps/mobile/contract/VERSION) and generated
 * native sources (apps/mobile/contract/generated): data the contract tests read
 * by name and check for staleness, so a change reaches those tests like any
 * data file.
 */
const CONTRACT_GENERATED = /^apps\/mobile\/contract\/(VERSION|generated\/([^/]+\/)*[^/]+\.(swift|kt|xcstrings|strings))$/;

export function knownKind(path: string): boolean {
  const base = path.split('/').pop()!;
  if (KNOWN_BARE.test(base)) return true;
  if (CONTRACT_GENERATED.test(path)) return true;
  const ext = extname(base).slice(1).toLowerCase();
  return ext !== '' && KNOWN_EXT.has(ext);
}

const match = (glob: string, path: string) => new Bun.Glob(glob).match(path);
export const runAllReason = (path: string) => RUN_ALL.find((r) => match(r.glob, path));

// ---------------------------------------------------------------------------
// Job gates

/** The full browser suite's path list (inbox-e2e.yml): what the compiled binary and the app pages are built from. */
export function e2ePaths(): string[] {
  const wf = Bun.YAML.parse(readFileSync(join(repoRoot, '.github/workflows/inbox-e2e.yml'), 'utf8')) as { on: { pull_request: { paths: string[] } } };
  return wf.on.pull_request.paths;
}

export type Gate = {
  /** The output name the workflow reads. */
  key: string;
  /** What it gates, for the summary. */
  title: string;
  /** Runs when a changed path matches one of these globs (`E2E` stands for e2ePaths()). */
  paths: string[];
  /** Also runs when a changed file is in the import closure of these files (the job's entries), read from the graph. */
  reaches?: string[];
  /** test.yml only: also runs when one of these test files is affected. */
  tests?: (test: string) => boolean;
};

export const DIFF_RENDERER_FILES = [
  'packages/review-editor/components/DiffViewer.fullContentSwap.test.tsx',
  'packages/review-editor/components/DiffViewer.oversizedStub.test.tsx',
  'packages/review-editor/components/DiffViewer.binaryNotice.test.tsx',
  'packages/review-editor/components/DiffViewer.imagePreview.test.tsx',
  'packages/review-editor/components/DiffViewer.headerControls.test.tsx',
  'packages/review-editor/components/DiffViewer.markdownPreview.test.tsx',
  'packages/review-editor/components/DiffViewer.changeNavigation.test.tsx',
  'packages/review-editor/components/AllFilesCodeView.inlineAnnotation.test.tsx',
];
const oneOf = (files: string[]) => (t: string) => files.includes(t);

/**
 * Gates per workflow. Fast-tier workflows (test, browser-smoke, security) run
 * every gate on a RUN_ALL change; windows.yml is a heavy suite and runs a job only
 * for its own paths (its HEAVY_FAIL_SAFE included).
 */
/**
 * What the browser smoke builds: the compiled binary's entry and the app pages
 * it embeds (with their build configs). A change in their import closure runs
 * the smoke, beside inbox-e2e.yml's own path list.
 */
export const SMOKE_ROOTS = [
  'apps/hook/server/index.ts',
  'apps/hook/index.tsx', 'apps/hook/vite.config.ts',
  'apps/review/index.tsx', 'apps/review/vite.config.ts', 'apps/review/diagram-engine/build.ts',
  'apps/inbox/index.tsx', 'apps/inbox/shape.tsx', 'apps/inbox/surface.tsx',
  'apps/inbox/vite.config.ts', 'apps/inbox/vite.shape.config.ts', 'apps/inbox/vite.surface.config.ts',
];

const closures = new WeakMap<Graph, Map<string, Set<string>>>();
/** Every repo file the roots reach through imports and file paths named in their code (kept per graph). */
export function closureOf(g: Graph, roots: string[]): Set<string> {
  const key = roots.join('\n');
  let byRoots = closures.get(g);
  if (!byRoots) closures.set(g, (byRoots = new Map()));
  const known = byRoots.get(key);
  if (known) return known;
  const seen = new Set(roots);
  byRoots.set(key, seen);
  const stack = [...roots];
  while (stack.length) {
    const n = g.graph[stack.pop()!];
    if (!n) continue;
    for (const d of [...n.imports, ...n.refs]) if (!seen.has(d)) { seen.add(d); stack.push(d); }
  }
  return seen;
}

export const GATES: Record<string, Gate[]> = {
  'test.yml': [
    {
      key: 'ui_smoke', title: 'Smoke-test published UI package (Checks)',
      paths: ['packages/ui/**', 'packages/core/**'],
      tests: oneOf(['packages/ui/components/html-viewer/bridgeAsset.test.ts']),
    },
    { key: 'file_browser', title: 'file-browser DOM test (Checks)', paths: [], tests: oneOf(['packages/ui/hooks/useFileBrowser.test.tsx']) },
    { key: 'diff_renderer', title: 'diff-renderer DOM tests (Checks)', paths: ['packages/review-editor/**'], tests: oneOf(DIFF_RENDERER_FILES) },
    {
      key: 'opencode', title: 'OpenCode 2 installed package',
      paths: ['apps/opencode-plugin/**', 'packages/t3-code/**', 'E2E'],
      tests: (t) => t.startsWith('packages/t3-code/') || ['tests/entry-assets.test.ts', 'apps/opencode-plugin/inbox-v2.test.ts', 'apps/opencode-plugin/inbox.test.ts'].includes(t),
    },
    {
      key: 'claude_code_mod', title: 'Claude Code mod (engine harness)',
      paths: ['apps/hook/hooks/**', 'apps/hook/tests/**', 'scripts/test-claude-code-mod.sh'],
    },
  ],
  'browser-smoke.yml': [
    { key: 'smoke', title: 'Browser smoke', paths: ['E2E', 'scripts/ci-e2e-in-image.sh'], reaches: SMOKE_ROOTS },
  ],
  'security.yml': [
    {
      key: 'trivy', title: 'Trivy',
      paths: ['bun.lock', '**/package.json', '**/package-lock.json', '**/Dockerfile*', '.github/**'],
    },
    { key: 'zizmor', title: 'zizmor', paths: ['.github/**'] },
  ],
  'windows.yml': [
    {
      key: 'uninstall', title: 'Uninstall lifecycle (Windows)',
      paths: ['packages/server/uninstall*', 'packages/server/auto-update*', 'apps/hook/server/cli*', 'scripts/install*'],
    },
    {
      key: 'qwen', title: 'Qwen Code installer steps (Windows)',
      paths: ['scripts/install.ps1', 'scripts/install.cmd', 'scripts/install.test.ts', 'apps/qwen-code/**', 'packages/shared/plannotator-tool.ts', 'packages/shared/t3-hook-command.ts'],
    },
    {
      key: 'diagram_engine', title: 'Diagram engine build (Windows)',
      paths: ['apps/review/diagram-engine/**', 'packages/core/**', 'packages/ui/**', 'packages/review-editor/utils/diagramEngineContract.ts', 'apps/review/package.json'],
    },
    { key: 'claude_code_mod', title: 'Claude Code mod (Windows)', paths: ['apps/hook/hooks/mod/**'] },
    {
      key: 'pi_runtime', title: 'Pi extension AI runtime (Windows)',
      paths: ['apps/pi-extension/server/**', 'apps/pi-extension/vendor.sh', 'packages/ai/**', 'packages/server/agent-jobs*', 'packages/server/review-workspace*', 'packages/server/inbox-launch*', 'scripts/smoke-pi-extension-ai-runtime.ts'],
    },
    { key: 'install_cmd', title: 'install.cmd (Windows integration)', paths: ['scripts/install.cmd'] },
    { key: 'install_ps1', title: 'install.ps1 (Windows integration)', paths: ['scripts/install.ps1', 'scripts/check-data-dir-windows.ps1'] },
  ],
};

/** The job of each gated workflow that runs the picker. */
export const GATE_JOB: Record<string, string> = { 'test.yml': 'plan', 'browser-smoke.yml': 'gate', 'security.yml': 'changes', 'windows.yml': 'gate' };

/**
 * How every job of every workflow is decided on a PR. scripts/ci-affected-map.test.ts
 * fails on a job missing here, and checks each kind against the workflow:
 *  - `always`: every PR (the picker's own jobs, Gitleaks);
 *  - `code`: every PR but a docs-only one (test.yml checks);
 *  - `lanes`: the plan's lane list (test.yml unit, dom);
 *  - `gate:<key>`: the gate job's output <key> (GATES; semgrep: the Semgrep plan);
 *  - `own-gate`: a path gate step of its own (guides-show);
 *  - `paths`: the workflow's own `pull_request.paths` (a heavy suite);
 *  - `slice`: the browser slice (e2e-slice.yml, its own picker);
 *  - `label`: the full browser suite, on a PR only with `ci:e2e` / `ci:e2e-all`;
 *  - `tag`: release tags only; `no-pr`: the job never runs on a PR (the
 *    workflow has no pull_request trigger, or the job's `if` names only other events).
 */
export const JOB_MAP: Record<string, Record<string, string>> = {
  'test.yml': {
    plan: 'always', checks: 'code', unit: 'lanes', dom: 'lanes',
    'opencode-v2': 'gate:opencode', 'claude-code-mod': 'gate:claude_code_mod', 'guides-show': 'own-gate',
  },
  'browser-smoke.yml': { gate: 'always', smoke: 'gate:smoke' },
  'security.yml': { changes: 'always', gitleaks: 'always', semgrep: 'gate:semgrep', trivy: 'gate:trivy', zizmor: 'gate:zizmor' },
  'windows.yml': {
    gate: 'always', 'uninstall-windows': 'gate:uninstall', 'qwen-installers-windows': 'gate:qwen', 'diagram-engine-windows': 'gate:diagram_engine',
    'claude-code-mod-windows': 'gate:claude_code_mod', 'pi-extension-ai-runtime-windows': 'gate:pi_runtime',
    'install-cmd-windows': 'gate:install_cmd', 'install-ps1-windows': 'gate:install_ps1',
  },
  'release.yml': {
    'release-eligibility': 'tag', test: 'paths', build: 'paths', 'smoke-binaries': 'paths', 'pi-extension-ai-runtime-windows': 'paths',
    'install-script-smoke': 'paths', attest: 'tag', 'viewer-pin-live': 'tag', release: 'tag', 'npm-package': 'paths',
    'release-security': 'paths', 'npm-publish': 'tag',
  },
  'inbox-pi.yml': { 'inbox-pi': 'paths' },
  'inbox-claude-code.yml': { 'inbox-claude-code': 'paths' },
  'relay.yml': { relay: 'paths' },
  'mobile-ios.yml': { ios: 'paths', 'ios-nightly': 'no-pr' },
  'mobile-contract.yml': { contract: 'paths', ledger: 'paths' },
  'e2e-slice.yml': { plan: 'slice', slice: 'slice' },
  'inbox-e2e.yml': { head: 'label', build: 'label', plan: 'label', 'inbox-window-e2e': 'label', blame: 'label', 'full-ci': 'label' },
  'dast.yml': { 'passive-baseline': 'no-pr' },
  'deploy.yml': { 'detect-changes': 'no-pr', 'site-lane': 'no-pr', 'deploy-marketing': 'no-pr', 'deploy-portal': 'no-pr', 'deploy-paste': 'no-pr', 'deploy-waitlist': 'no-pr' },
  'guides-show-deploy.yml': { publish: 'no-pr' },
  'snapshots-sign-check.yml': { 'sign-and-notarize': 'no-pr' },
};

/** Heavy suites (windows.yml) run every job on these, besides their own paths. */
export const HEAVY_FAIL_SAFE = ['bun.lock', 'package.json', '**/bunfig.toml', 'tests/setup/**', 'scripts/ci-affected.ts', '.github/workflows/windows.yml'];

/** Fast-tier workflows: a RUN_ALL change runs every gated job. */
const FAST_WORKFLOWS = new Set(['test.yml', 'browser-smoke.yml', 'security.yml']);

export function gatePaths(gate: Gate): string[] {
  return gate.paths.flatMap((p) => (p === 'E2E' ? e2ePaths() : [p]));
}

/** Semgrep's targets: its rules read JS/TS, shell, PowerShell, batch and Dockerfiles. */
const SEMGREP_TARGET = /(\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|sh|bash|ps1|cmd|bat)|(^|\/)Dockerfile)$/;
/** A change to these rescans the whole tree. */
const SEMGREP_FULL = ['.semgrep.yml', '.semgrepignore', '.gitignore'];
const SAFE_PATH = /^[A-Za-z0-9._@+/-]+$/;

export type Semgrep = { mode: 'full' | 'files' | 'skip'; files: string[]; why: string };

export function semgrepPlan(mode: Mode, changes: Change[]): Semgrep {
  if (mode === 'all') return { mode: 'full', files: [], why: 'everything runs' };
  if (mode === 'docs') return { mode: 'skip', files: [], why: 'docs only' };
  const full = changes.find((c) => SEMGREP_FULL.includes(c.path));
  if (full) return { mode: 'full', files: [], why: `${full.path} changed` };
  const files = [...new Set(changes.filter((c) => c.status[0] !== 'D' && SEMGREP_TARGET.test(c.path)).map((c) => c.path))].sort();
  if (files.some((f) => !SAFE_PATH.test(f))) return { mode: 'full', files: [], why: 'a changed path has unusual characters' };
  if (!files.length) return { mode: 'skip', files: [], why: 'no changed file Semgrep scans' };
  return { mode: 'files', files, why: `${files.length} changed file(s)` };
}

export type Decision = { key: string; title: string; run: boolean; why: string };

/** Which gated jobs of a workflow run. `affected`: the tests the change changes or reaches (test.yml only). */
export function decideGates(workflow: string, mode: Mode, reasons: string[], changes: Change[], affected?: Set<string>, graph?: Graph): Decision[] {
  const heavy = !FAST_WORKFLOWS.has(workflow);
  const failSafe = heavy ? changes.find((c) => HEAVY_FAIL_SAFE.some((g) => match(g, c.path))) : undefined;
  return (GATES[workflow] ?? []).map((gate) => {
    const d = (run: boolean, why: string): Decision => ({ key: gate.key, title: gate.title, run, why });
    if (reasons.length && (!heavy || mode === 'all' && !changes.length)) return d(true, `everything runs: ${reasons[0]}`);
    if (mode === 'docs') return d(false, 'docs-only change');
    if (heavy && failSafe) return d(true, `${failSafe.path} changed`);
    const globs = gatePaths(gate);
    const hit = changes.find((c) => globs.some((g) => match(g, c.path)));
    if (hit) return d(true, `${hit.path} changed`);
    if (gate.reaches) {
      if (!graph) return d(true, 'no import graph to check what it builds');
      const builds = closureOf(graph, gate.reaches);
      const reached = changes.find((c) => builds.has(c.path));
      if (reached) return d(true, `${reached.path} is in what ${gate.reaches[0]} builds`);
    }
    const test = gate.tests && affected ? [...affected].find(gate.tests) : undefined;
    if (test) return d(true, `affected: ${test}`);
    return d(false, 'nothing it covers changed');
  });
}

// ---------------------------------------------------------------------------
// The import graph

/** listsRepo: lists the checkout, or reads it by a path the graph cannot tell (then opaqueRead too). */
/** unresolvedAt: where each import it cannot resolve would land (a repo path without extension, or a package folder). */
export type Node = { imports: string[]; refs: string[]; vendored?: string; lits: string[]; unresolved: string[]; unresolvedAt?: string[]; listsRepo: boolean; opaqueRead?: boolean };
export type Graph = { files: string[]; graph: Record<string, Node> };

/** Source with comments blanked out (strings and template literals kept). */
export function stripComments(src: string): string {
  let out = '';
  let q: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i++; } else if (c === q || (c === '\n' && q !== '`')) q = null;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; out += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    out += c;
  }
  return out;
}

const STR = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
/** Names the checkout: the repo, the script's folder or the working directory. */
const NAMES_CHECKOUT = /import\.meta\.(dir|url|dirname)|__dirname|process\.cwd\(\)|\brepoRoot\b|\bREPO_ROOT\b|\bROOT\b|\brootDir\b/;
/** Names a scratch folder: a temp dir, a test's data dir or world. */
const NAMES_SCRATCH = /mkdtemp|tmpdir\(\)|\btmp|\btemp|scratch|sandbox|dataDir|world|\bw\.|\bhome\b/i;

/**
 * Whether code lists a folder of the checkout at runtime. A `git ls-files`, a
 * Glob, or a readdir of the checkout counts; a readdir whose folder is a
 * scratch one (traced through `const x = ...` up to three steps) does not. A
 * folder it cannot trace (a parameter, an import) counts: the safe direction.
 */
export function listsCheckout(code: string): boolean {
  if (/ls-files/.test(code)) return true;
  if (/new (Bun\.)?Glob\(|globSync\(/.test(code)) return NAMES_CHECKOUT.test(code) || !NAMES_SCRATCH.test(code);
  /** Every value assigned to `id` (its declaration and later assignments), `null`/`undefined` left out; undefined when none. */
  const assigned = (id: string) => {
    const values = [
      ...code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${id}\\s*(?::[^=;\\n]+)?=\\s*([^;\\n]*)`, 'g')),
      ...code.matchAll(new RegExp(`(?<![.\\w$])${id}\\s*=(?![=>])\\s*([^;\\n]*)`, 'g')),
    ].map((m) => m[1]!.trim()).filter((v) => v && !/^(null|undefined)$/.test(v));
    return values.length ? values.join(' ; ') : undefined;
  };
  const seen = new Set<string>();
  const checkout = (expr: string, depth: number): boolean => {
    if (NAMES_CHECKOUT.test(expr)) return true;
    if (NAMES_SCRATCH.test(expr)) return false;
    if (depth === 0) return true;
    const ids = [...expr.replace(STR, '""').matchAll(/(?<![.\w$])[A-Za-z_$][\w$]*/g)].map((m) => m[0])
      .filter((id) => !/^(join|resolve|dirname|realpathSync|path|await|new|String|withFileTypes|recursive|true|false|null|undefined|as|string)$/.test(id) && !seen.has(id));
    if (!ids.length) return true;
    return ids.some((id) => { seen.add(id); const e = assigned(id); return e === undefined ? true : checkout(e, depth - 1); });
  };
  /** The call's first argument: up to the comma or close paren at its own depth. */
  const firstArg = (rest: string) => {
    let depth = 0;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return rest.slice(0, i); depth--; }
      else if (c === ',' && depth === 0) return rest.slice(0, i);
    }
    return rest;
  };
  for (const m of code.matchAll(/(?:readdirSync|readdir|opendirSync)\(([^\n]*)/g)) { seen.clear(); if (checkout(firstArg(m[1]!), 3)) return true; }
  return false;
}

/** The arguments of the call whose `(` is at `open`, split at top-level commas (strings and nesting respected). */
function callArgs(s: string, open: number): { args: string[]; end: number } | null {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { const last = s.slice(start, i).trim(); if (last || args.length) args.push(last); return { args, end: i }; }
      depth--;
    } else if (c === ',' && depth === 0) { args.push(s.slice(start, i).trim()); start = i + 1; }
  }
  return null;
}

/**
 * A path value: absolute, a relative literal, literal segments after a base it
 * cannot tell, or a known folder joined with a name it cannot tell (`under`,
 * with the literal segments after that name).
 */
type PathValue = { abs: string } | { rel: string } | { tail: string } | { under: string; after: string[] } | null;

/** What a variable is set to: the expression after `const|let|var name =`, up to a top-level `;` or line end. */
export function bindings(code: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*/g)) {
    if (out.has(m[1]!)) continue;
    const from = m.index! + m[0].length;
    let depth = 0;
    let i = from;
    for (; i < code.length; i++) {
      const c = code[i]!;
      if (c === '"' || c === "'" || c === '`') { for (i++; i < code.length && code[i] !== c; i++) if (code[i] === '\\') i++; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
      else if (depth === 0 && (c === ';' || c === '\n' || c === ',')) break;
    }
    out.set(m[1]!, code.slice(from, i).trim());
  }
  return out;
}

/** Calls that read a file's content or its presence. */
const OPAQUE_READ = /^(readFileSync|readFile|file|existsSync|statSync)$/;
const PATH_CALL = /(?<![\w$.])(?:path\.|posix\.|nodePath\.|Bun\.)?(join|resolve|dirname|fileURLToPath|realpathSync|readFileSync|readFile|existsSync|statSync|file)\s*\(|\bnew URL\s*\(/g;

/**
 * The repo files a source file names by a path it builds: `join(import.meta.dir,
 * '..', 'App.tsx')`, `join(ROOT, 'packages', 'shared', 'x.ts')` with ROOT a
 * local binding, `new URL('../x.ts', import.meta.url)`, a template such as
 * `${ROOT}/x.ts`. Literal segments after a base it cannot tell are tried from
 * the file's folder and from the repo root.
 */
export type PathRead = { fn: string; arg: string; value: PathValue; named: boolean; checkout: boolean };
export function builtPathRefs(code: string, abs: string, repo: string, fileSet: Set<string>, trace?: PathRead[]): string[] {
  const dir = dirname(abs);
  const binds = bindings(code);
  const evalExpr = (raw: string, depth: number): PathValue => {
    let e = raw.trim().replace(/\s+as\s+[\w.<>[\]| ]+$/, '').replace(/!$/, '').trim();
    while (e.startsWith('(') && callArgs(e, 0)?.end === e.length - 1) e = e.slice(1, -1).trim();
    if (depth > 6 || !e) return null;
    const lit = /^(['"])([^'"\\]*)\1$/.exec(e);
    if (lit) return { rel: lit[2]! };
    if (/^import\.meta\.(dir|dirname)$|^__dirname$/.test(e)) return { abs: dir };
    if (/^import\.meta\.(url|path|filename)$|^__filename$/.test(e)) return { abs };
    if (/^process\.cwd\(\)$/.test(e)) return { abs: repo };
    const tpl = /^`([^`]*)`$/.exec(e);
    if (tpl) {
      let unknownBase = false;
      const text = tpl[1]!.replace(/\$\{([^}]*)\}/g, (_, x: string) => {
        const v = evalExpr(x, depth + 1);
        if (v && 'abs' in v) return v.abs;
        if (v && 'rel' in v) return v.rel;
        unknownBase = true;
        return '\u0000';
      });
      if (!unknownBase) return text.startsWith('/') ? { abs: text } : { rel: text };
      const rest = text.split('\u0000').pop()!.replace(/^\//, '');
      return rest && !rest.includes('\u0000') ? { tail: rest } : null;
    }
    const member = /^(.*)\.(pathname|href)$/.exec(e);
    if (member) return evalExpr(member[1]!, depth + 1);
    const call = /^(?:new\s+)?((?:path\.|posix\.|nodePath\.|Bun\.)?[A-Za-z_$][\w$]*)\s*\(/.exec(e);
    if (call && callArgs(e, call[0].length - 1)?.end === e.length - 1) {
      const fn = call[1]!.replace(/^(path|posix|nodePath|Bun)\./, '');
      const args = callArgs(e, call[0].length - 1)!.args.map((a) => evalExpr(a, depth + 1));
      if (fn === 'fileURLToPath' || fn === 'realpathSync' || fn === 'normalize') return args[0] ?? null;
      if (fn === 'dirname') { const a = args[0]; return a && 'abs' in a ? { abs: dirname(a.abs) } : null; }
      if (fn === 'URL') {
        const [p, base] = args;
        if (p && 'rel' in p && base && 'abs' in base) return { abs: resolve(base.abs.endsWith('/') ? base.abs : dirname(base.abs), p.rel) };
        return null;
      }
      if (fn === 'join' || fn === 'resolve') {
        if (!args.length) return null;
        let anchor = -1;
        args.forEach((a, i) => { if (a && 'abs' in a && (fn === 'resolve' || i === 0)) anchor = i; });
        if (anchor >= 0) {
          const rest = args.slice(anchor + 1);
          const base = (args[anchor] as { abs: string }).abs;
          const known = rest.findIndex((a) => !(a && 'rel' in a));
          const rels = (xs: PathValue[]) => xs.map((a) => (a as { rel: string }).rel);
          if (known < 0) return { abs: resolve(base, ...rels(rest)) };
          const after = rest.slice(known + 1);
          return { under: resolve(base, ...rels(rest.slice(0, known))), after: after.every((a) => a && 'rel' in a) ? rels(after) : [] };
        }
        if (args.every((a) => a && 'rel' in a)) return { rel: join(...args.map((a) => (a as { rel: string }).rel)) };
        const rest = args.slice(1);
        if (rest.length && rest.every((a) => a && 'rel' in a)) return { tail: join(...rest.map((a) => (a as { rel: string }).rel)) };
        return null;
      }
      return null;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(e)) { const b = binds.get(e); return b === undefined ? null : evalExpr(b, depth + 1); }
    return null;
  };
  const out = new Set<string>();
  const add = (candidate: string): boolean => {
    const rel = relative(repo, candidate);
    if (rel.startsWith('..')) return false;
    const hit = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].map((x) => rel + x).find((c) => fileSet.has(c));
    if (hit) out.add(hit);
    return !!hit;
  };
  let literals: string[] | undefined;
  /** Whether the value names a repo file (a known folder joined with a name: one of the file's own literals). */
  const consider = (v: PathValue): boolean => {
    if (!v) return false;
    if ('abs' in v) return add(v.abs);
    if ('under' in v) {
      literals ??= [...new Set([...code.matchAll(STR)].map((m) => m[2]!).filter((x) => x.length > 1 && x.length < 200 && !/\s|\$\{/.test(x)))];
      let hit = false;
      for (const l of literals) if (add(resolve(v.under, l, ...v.after))) hit = true;
      if (v.after.length) {
        const prefix = relative(repo, v.under);
        const tail = join(...v.after);
        for (const f of fileSet) if (f.startsWith(prefix + '/') && f.endsWith('/' + tail) && f.slice(prefix.length + 1, -tail.length - 1).split('/').length === 1) { out.add(f); hit = true; }
      }
      return hit;
    }
    if ('tail' in v || ('rel' in v && v.rel.includes('/'))) {
      const t = 'tail' in v ? v.tail : v.rel;
      return add(resolve(dir, t)) || add(resolve(repo, t));
    }
    return false;
  };
  for (const m of code.matchAll(PATH_CALL)) {
    const open = m.index! + m[0].length - 1;
    const c = callArgs(code, open);
    if (!c) continue;
    const fn = m[1];
    const expr = fn === 'join' || fn === 'resolve' || fn === 'dirname' || !fn ? code.slice(m.index!, c.end + 1) : c.args[0];
    if (!expr) continue;
    const value = evalExpr(expr, 0);
    const named = consider(value);
    trace?.push({ fn: fn ?? 'URL', arg: expr, value, named, checkout: !named && namesCheckout(expr) });
  }
  for (const m of code.matchAll(/`[^`]*\$\{[^`]*`/g)) consider(evalExpr(m[0], 0));
  /** Whether an expression, through the file's own bindings, starts from the checkout. */
  function namesCheckout(e: string, d = 4, seen = new Set<string>()): boolean {
    if (NAMES_CHECKOUT.test(e) || /import\.meta\.path|__filename|\bREPO\b|\bREPO_DIR\b/.test(e)) return true;
    if (d === 0) return false;
    for (const id of e.replace(STR, '""').match(/(?<![.\w$])[A-Za-z_$][\w$]*/g) ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const b = binds.get(id);
      if (b !== undefined && namesCheckout(b, d - 1, seen)) return true;
    }
    return false;
  }
  return [...out].filter((r) => r !== relative(repo, abs));
}

/** The graph of every tracked code file (plus apps/pi-extension/generated, and `extra` files such as untracked ones). */
export function buildGraph(repo = repoRoot, extra: string[] = []): Graph {
  repo = realpathSync(repo);
  const ls = (...args: string[]) => Bun.spawnSync(['git', 'ls-files', ...args], { cwd: repo }).stdout.toString().split('\n').filter(Boolean);
  const files = [...new Set([...ls(), ...ls('--others', '--ignored', '--exclude-standard', 'apps/pi-extension/generated'), ...extra])]
    .filter((f) => existsSync(join(repo, f)));
  const fileSet = new Set(files);
  const transpilers = new Map<string, Bun.Transpiler>();
  const transpiler = (f: string) => {
    const loader = ({ '.tsx': 'tsx', '.jsx': 'jsx', '.ts': 'ts', '.mts': 'ts', '.cts': 'ts' } as const)[extname(f) as '.ts'] ?? 'js';
    if (!transpilers.has(loader)) transpilers.set(loader, new Bun.Transpiler({ loader }));
    return transpilers.get(loader)!;
  };
  const inRepo = (abs: string): string | null => {
    if (!abs.startsWith('/')) return null; // a builtin: Bun resolves 'fs' to 'node:fs'
    let real = abs;
    try { real = realpathSync(abs); } catch { /* resolved, not on disk */ }
    const rel = relative(repo, real);
    return rel.startsWith('..') || rel.includes('node_modules/') ? null : rel;
  };
  const graph: Record<string, Node> = {};
  /** Workspace package name -> its folder, for a bare import that does not resolve. */
  const packages = new Map<string, string>();
  for (const f of files) {
    if (!/(^|\/)package\.json$/.test(f) || f.includes('node_modules/')) continue;
    try { const name = JSON.parse(readFileSync(join(repo, f), 'utf8')).name; if (typeof name === 'string') packages.set(name, dirname(f)); } catch { /* not JSON */ }
  }
  for (const f of files) {
    if (!CODE_RE.test(f)) continue;
    const abs = join(repo, f);
    let src: string;
    try { src = readFileSync(abs, 'utf8'); } catch { continue; }
    const node: Node = { imports: [], refs: [], lits: [], unresolved: [], listsRepo: false };
    graph[f] = node;
    let imports: { path: string }[];
    const at = (where: string) => (node.unresolvedAt ??= []).push(where);
    try {
      imports = transpiler(f).scanImports(src.replace(/^#![^\n]*/, ''));
    } catch {
      // Bun's scanner also throws on a JSX warning (a key after a spread). The
      // regex reads every static form: from '...', import '...', import('...'), require('...').
      imports = [...src.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)(['"])([^'"]+)\1/g)].map((m) => ({ path: m[2] }));
    }
    for (const { path: spec } of imports) {
      if (spec.startsWith('bun:') || spec.startsWith('node:')) continue;
      try {
        const hit = inRepo(Bun.resolveSync(spec, dirname(abs)));
        if (hit && hit !== f) node.imports.push(hit);
      } catch {
        const guess = spec.startsWith('.') ? relative(repo, resolve(dirname(abs), spec)) : null;
        if (guess && fileSet.has(guess)) node.imports.push(guess);
        // Build output (dist/) is absent on an unbuilt checkout; tests stub it.
        else if ((spec.startsWith('.') || spec.startsWith('@plannotator/')) && !spec.includes('/dist/')) node.unresolved.push(spec);
        if (spec.includes('/dist/')) continue;
        if (spec.startsWith('.')) at(guess!.replace(/\.[cm]?[jt]sx?$/, ''));
        else {
          const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
          const dir = packages.get(name);
          if (dir !== undefined) at(join(dir, spec.slice(name.length)).replace(/\/$/, '') || '.');
        }
      }
    }
    const code = stripComments(src);
    node.listsRepo = listsCheckout(code);
    const refs = new Set<string>();
    const lits = new Set<string>();
    for (const m of code.matchAll(STR)) {
      const s = m[2];
      if (s.length < 3 || s.length > 200 || /\s/.test(s)) continue;
      const seg = s.split('/').pop()!.replace(/\$\{[^}]*\}/g, '');
      if (seg.length > 3 && /^[\w.-]*\.[A-Za-z]{1,5}$/.test(seg)) lits.add(seg);
      if (s.includes('${') || (!s.includes('/') && !s.includes('.'))) continue;
      for (const base of [relative(repo, resolve(dirname(abs), s)), s.replace(/^\.\//, ''), relative(repo, resolve(repo, s))]) {
        const hit = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].map((ext) => base + ext).find((c) => c !== f && fileSet.has(c));
        if (hit) { refs.add(hit); break; }
      }
    }
    const reads: PathRead[] = [];
    for (const r of builtPathRefs(code, abs, repo, fileSet, reads)) refs.add(r);
    // A test-side read of the checkout by a path the graph cannot tell (a
    // parameter, a name from elsewhere) could be any file: run it like a
    // tree-scanning test, on every PR.
    if (testSide(f) && reads.some((r) => OPAQUE_READ.test(r.fn) && r.checkout)) { node.listsRepo = true; node.opaqueRead = true; }
    node.refs = [...refs].filter((r) => r !== f && !node.imports.includes(r));
    node.lits = [...lits];
    if (f.startsWith('apps/pi-extension/generated/')) node.vendored = /^\/\/ @generated[^\n]*Source: (\S+)/.exec(src)?.[1];
  }
  return { files, graph };
}

/** Test files the plain `bun test` sweep runs (bunfig's ignore patterns left out). */
export function testFiles(g: Graph, ignore = bunfigIgnorePatterns()): string[] {
  return g.files.filter((f) => TEST_RE.test(f) && !ignore.some((p) => match(p, f)) && !f.startsWith('apps/pi-extension/generated/')).sort();
}

const testSide = (f: string) => /^(tests|scripts)\//.test(f) || /\.test\.|test-|\/test\//.test(f);

/** Tests that list folders of the checkout at runtime, themselves or through a test-side file they import. */
export function scannerTests(g: Graph, tests: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of tests) {
    const seen = new Set([t]);
    const stack = [t];
    while (stack.length) {
      const n = g.graph[stack.pop()!];
      if (!n) continue;
      if (n.listsRepo) { out.add(t); break; }
      for (const d of n.imports) if (!seen.has(d) && testSide(d)) { seen.add(d); stack.push(d); }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The plan

export type Change = { status: string; path: string; added: string[]; removed: string[] };
export type Mode = 'all' | 'subset' | 'docs';
export type Picked = { path: string; why: 'changed' | 'reached' | 'scanner' | 'all'; via?: string };
export type Plan = {
  mode: Mode;
  reasons: string[];
  changed: string[];
  tests: Picked[];
  total: number;
  unit: { lanes: string[]; files: string[]; shards: number };
  dom: { lanes: string[]; files: string[]; shards: number };
  gates: Decision[];
  semgrep: Semgrep;
  notes: string[];
};

/** A workspace package.json change that only adds subpath exports or `files` entries. */
export function addsExportsOnly(c: Change): boolean {
  const strip = (l: string) => l.trim().replace(/,$/, '');
  const added = c.added.map(strip);
  const removed = c.removed.map(strip);
  const fresh = added.filter((l) => !removed.includes(l));
  return fresh.length > 0 && removed.every((l) => added.includes(l))
    && fresh.every((l) => /^"\.\/[^"]+": "\.\/[^"]+"$/.test(l) || /^"[^":]+\.[a-z]+"$/.test(l));
}

/**
 * Unit files per subset lane, and DOM files per subset lane. Measured on CI: a
 * unit file takes about 2-4 s and an editor DOM file up to 15 s, so these keep
 * a lane near 5 minutes. A lane costs about a minute of setup, so a lane per
 * few files would waste more than it saves.
 */
export const UNIT_FILES_PER_LANE = 80;
export const DOM_FILES_PER_LANE = 20;
/** Over this share of all test files, the full lanes run instead (they split better). */
export const MOST = 0.6;

const allLanes = () => ({
  unit: laneNames().filter((l) => !l.startsWith('dom-')),
  dom: laneNames().filter((l) => l.startsWith('dom-')),
});

/** Why the change cannot be planned file by file, or null. Needs no graph. */
export function pathReasons(changes: Change[]): string[] {
  const reasons: string[] = [];
  for (const c of changes) {
    if (nativeAppFile(c.path)) continue;
    const top = c.path.split('/')[0]!;
    const all = runAllReason(c.path);
    if (all) reasons.push(`${c.path}: ${all.why}`);
    else if (/^(apps|packages)\/[^/]+\/package\.json$/.test(c.path)) { if (!addsExportsOnly(c)) reasons.push(`${c.path}: a package manifest`); }
    else if (!KNOWN_TOP.includes(top)) reasons.push(`${c.path}: a top-level entry the picker does not know`);
    else if (!knownKind(c.path)) reasons.push(`${c.path}: a file kind the picker does not know`);
    else if (/^[DR]/.test(c.status) && CODE_RE.test(c.path)) reasons.push(`${c.path}: deleted or renamed code`);
  }
  return reasons;
}

/** Every file a bunfig.toml's test preload loads, with what those files import. */
export function preloadClosure(g: Graph, repo = repoRoot): Set<string> {
  const roots: string[] = [];
  for (const f of g.files) {
    if (!/(^|\/)bunfig\.toml$/.test(f)) continue;
    let config: { preload?: unknown; test?: { preload?: unknown } };
    try { config = Bun.TOML.parse(readFileSync(join(repo, f), 'utf8')) as typeof config; } catch { continue; }
    for (const p of [config.preload, config.test?.preload].flat()) if (typeof p === 'string') roots.push(relative(repo, resolve(repo, dirname(f), p)));
  }
  return closureOf(g, roots);
}

export type PlanInput = {
  changes: Change[];
  /** Every change a plain docs file (scripts/ci-docs-only.sh). */
  docsOnly: boolean;
  /** Set when the run cannot be planned at all (not a PR, switched off, ...). */
  forceAll?: string;
};

export function plan(g: Graph, input: PlanInput): Plan {
  const all = testFiles(g);
  const notes: string[] = [];
  const reasons: string[] = input.forceAll ? [input.forceAll] : [];
  if (!input.forceAll && !input.changes.length) reasons.push('the diff is empty');
  // The native app's files reach no Bun test: the rest of the change is planned alone.
  const changes = input.changes.filter((c) => !nativeAppFile(c.path));
  const docs = !reasons.length && (input.docsOnly || !changes.length);
  if (!reasons.length && !docs) {
    reasons.push(...pathReasons(changes));
    for (const c of changes) {
      const bad = g.graph[c.path]?.unresolved[0];
      if (bad) reasons.push(`${c.path}: an import the graph cannot resolve (${bad})`);
    }
    // What a bunfig preloads runs before every test file under it: a change there runs everything.
    const preloaded = preloadClosure(g);
    for (const c of changes) if (preloaded.has(c.path)) reasons.push(`${c.path}: a test preload loads it (bunfig.toml)`);
    // The other side: a file whose import of the changed path did not resolve has no edge to it.
    // Only importers a test runs count (a stale manual script does not).
    const run = new Set(all);
    const stack = [...all];
    while (stack.length) for (const d of g.graph[stack.pop()!]?.imports ?? []) if (!run.has(d)) { run.add(d); stack.push(d); }
    const lost: [string, string][] = [];
    for (const [f, n] of Object.entries(g.graph)) if (run.has(f)) for (const a of n.unresolvedAt ?? []) lost.push([f, a]);
    for (const c of changes) {
      if (!CODE_RE.test(c.path) && !/\.(json|css)$/.test(c.path)) continue;
      const bare = c.path.replace(/\.[cm]?[jt]sx?$/, '');
      const hit = lost.find(([, a]) => a === bare || a === c.path || bare === `${a}/index` || c.path.startsWith(`${a}/`));
      if (hit) reasons.push(`${c.path}: ${hit[0]} has an import the graph cannot resolve that may be this file`);
    }
  }

  const picked = new Map<string, Picked>();
  if (!reasons.length && !docs) {
    const seeds = new Map<string, string>();
    for (const c of changes) {
      // A deleted path (or a rename's old one) has no file left to import it, but
      // its name still finds the tests that read it (the lookup by file name below).
      seeds.set(c.path, c.path);
      // The DOM lanes run exactly the list: a file added to it is a file to run.
      if (c.path === 'tests/dom-test-list.txt') for (const l of c.added) if (l.trim() && !l.trim().startsWith('#')) seeds.set(l.trim(), c.path);
      if (c.path === 'apps/pi-extension/vendor.sh') for (const f of g.files) if (f.startsWith('apps/pi-extension/generated/')) seeds.set(f, c.path);
    }
    const rev = new Map<string, string[]>();
    const byLit = new Map<string, string[]>();
    const push = (m: Map<string, string[]>, k: string, v: string) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
    for (const [f, n] of Object.entries(g.graph)) {
      for (const d of [...n.imports, ...n.refs]) push(rev, d, f);
      if (n.vendored) push(rev, n.vendored, f);
      for (const l of n.lits) push(byLit, l, f);
    }
    for (const [s, from] of [...seeds]) if (!CODE_RE.test(s)) for (const f of byLit.get(s.split('/').pop()!) ?? []) if (!seeds.has(f)) seeds.set(f, from);
    const via = new Map(seeds);
    const stack = [...seeds.keys()];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const d of rev.get(cur) ?? []) if (!via.has(d)) { via.set(d, via.get(cur)!); stack.push(d); }
    }
    const changedSet = new Set(changes.map((c) => c.path));
    for (const t of all) {
      if (changedSet.has(t)) picked.set(t, { path: t, why: 'changed' });
      else if (via.has(t)) picked.set(t, { path: t, why: 'reached', via: via.get(t) });
    }
    for (const t of scannerTests(g, all)) if (!picked.has(t)) picked.set(t, { path: t, why: 'scanner' });
    if (!g.files.some((f) => f.startsWith('apps/pi-extension/generated/')) && changes.some((c) => /^(packages|apps\/pi-extension)\//.test(c.path))) {
      for (const t of all) if (t.startsWith('apps/pi-extension/') && !picked.has(t)) picked.set(t, { path: t, why: 'reached', via: 'apps/pi-extension/generated is missing' });
      notes.push('apps/pi-extension/generated is missing (run apps/pi-extension/vendor.sh): every Pi test was added');
    }
    if (picked.size > all.length * MOST) reasons.push(`${picked.size} of ${all.length} test files are affected: the full lanes run`);
  }

  const mode: Mode = reasons.length ? 'all' : docs ? 'docs' : 'subset';
  const tests: Picked[] = mode === 'all' ? all.map((t) => ({ path: t, why: 'all' as const }))
    : mode === 'docs' ? [] : [...picked.values()].sort((a, b) => a.path.localeCompare(b.path));

  let unit = { ...{ lanes: allLanes().unit, files: [] as string[], shards: UNIT_SHARDS } };
  let dom = { ...{ lanes: allLanes().dom, files: [] as string[], shards: DOM_SHARDS } };
  if (mode !== 'all') {
    const heavy = Object.values(HEAVY_LANES).flat();
    const guards = new Set(CORE_GUARDS);
    const list = new Set(domList());
    const files = tests.map((t) => t.path).filter((t) => !guards.has(t));
    const unitFiles = files.filter((t) => !heavy.includes(t));
    const domFiles = files.filter((t) => list.has(t));
    const us = Math.min(UNIT_SHARDS, Math.ceil(unitFiles.length / UNIT_FILES_PER_LANE));
    const ds = Math.min(DOM_SHARDS, Math.ceil(domFiles.length / DOM_FILES_PER_LANE));
    unit = {
      lanes: [
        ...Object.entries(HEAVY_LANES).filter(([, fs]) => fs.some((f) => files.includes(f))).map(([lane]) => lane),
        ...Array.from({ length: us }, (_, i) => `unit-${i + 1}`),
      ],
      files: files.filter((t) => heavy.includes(t) || unitFiles.includes(t)),
      shards: us,
    };
    dom = { lanes: Array.from({ length: ds }, (_, i) => `dom-${i + 1}`), files: domFiles, shards: ds };
  }
  // A tree-scanning test alone does not start a job: only the tests the change itself reaches do.
  const affected = new Set(tests.filter((t) => t.why !== 'scanner').map((t) => t.path));
  return {
    mode, reasons, notes, tests, total: all.length,
    changed: input.changes.map((c) => `${c.status}\t${c.path}`),
    unit, dom,
    gates: decideGates('test.yml', mode, reasons, changes, affected, g),
    semgrep: semgrepPlan(mode, changes),
  };
}

// ---------------------------------------------------------------------------
// Reading the change

const git = (args: string[], repo = repoRoot) => {
  const r = Bun.spawnSync(['git', ...args], { cwd: repo });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
};

/** Untracked files that are part of a local change. Private scratch folders are left out. */
const SCRATCH = /^(\.ops|\.product|\.local)\//;
export const untrackedFiles = (repo = repoRoot) =>
  git(['ls-files', '--others', '--exclude-standard'], repo).split('\n').filter((f) => f && !SCRATCH.test(f));

/** base..head, or base..working tree (untracked files included) when head is absent. */
export function changesBetween(base: string, head?: string, repo = repoRoot): Change[] {
  const range = head ? [base, head] : [base];
  const out: Change[] = [];
  for (const line of git(['diff', '--name-status', '-M', ...range], repo).split('\n').filter(Boolean)) {
    const [status, ...paths] = line.split('\t');
    for (const p of paths) {
      const d = /package\.json$|^tests\/dom-test-list\.txt$/.test(p) && status![0] !== 'D' ? git(['diff', '-U0', ...range, '--', p], repo).split('\n') : [];
      out.push({
        status: paths.length > 1 && p === paths[0] ? 'D' : status!, path: p,
        added: d.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)),
        removed: d.filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1)),
      });
    }
  }
  if (!head) {
    for (const p of untrackedFiles(repo)) {
      const lines = /package\.json$|^tests\/dom-test-list\.txt$/.test(p) ? readFileSync(join(repo, p), 'utf8').split('\n') : [];
      out.push({ status: 'A', path: p, added: lines, removed: [] });
    }
  }
  return out;
}

/** scripts/ci-docs-only.sh's verdict on the same change (modes included): true only for `docs`. */
export function docsOnly(base: string, head?: string, repo = repoRoot): boolean {
  let raw = git(['diff', '--no-renames', '--no-ext-diff', '--raw', base, ...(head ? [head] : [])], repo);
  if (!head) for (const p of untrackedFiles(repo)) raw += `:000000 100644 0000000 0000000 A\t${p}\n`;
  const r = Bun.spawnSync(['bash', join(repoRoot, 'scripts/ci-docs-only.sh'), 'classify'], { cwd: repo, stdin: new TextEncoder().encode(raw) });
  return r.exitCode === 0 && r.stdout.toString().trim() === 'docs';
}

/** A PR with this label runs everything in every workflow with a gate job (read at the run's start). */
export const RUN_ALL_LABEL = 'ci:full';

/** The PR's labels when the run started, from the event payload; [] outside a PR or on a payload it cannot read. */
export function prLabels(env = process.env): string[] {
  if (env.GITHUB_EVENT_NAME !== 'pull_request' || !env.GITHUB_EVENT_PATH) return [];
  try {
    const labels = (JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as { pull_request?: { labels?: { name?: unknown }[] } }).pull_request?.labels ?? [];
    return labels.map((l) => l.name).filter((n): n is string => typeof n === 'string');
  } catch {
    return [];
  }
}

/** In a pull_request job: the PR's base tip and its merge commit, or why there is none. */
export function prRange(env = process.env, repo = repoRoot): { base: string; head: string } | { why: string } {
  if ((env.CI_AFFECTED ?? '').trim().toLowerCase() === 'off') return { why: 'the repo variable CI_AFFECTED is off' };
  if (env.GITHUB_EVENT_NAME !== 'pull_request') return { why: `not a pull_request run (${env.GITHUB_EVENT_NAME || 'no event'})` };
  try {
    const base = git(['rev-parse', '--verify', '--quiet', 'HEAD^1'], repo).trim();
    git(['rev-parse', '--verify', '--quiet', 'HEAD^2'], repo);
    return { base, head: git(['rev-parse', 'HEAD'], repo).trim() };
  } catch {
    return { why: 'the checkout is not the PR merge commit' };
  }
}

/** Classify a list of paths with scripts/ci-docs-only.sh as plain files (a preview has no modes). */
function docsOnlyPaths(changes: Change[]): boolean {
  const raw = changes.map((c) => `:${c.status === 'A' ? '000000' : '100644'} ${c.status === 'D' ? '000000' : '100644'} 0000000 0000000 ${c.status}\t${c.path}`).join('\n');
  const r = Bun.spawnSync(['bash', join(repoRoot, 'scripts/ci-docs-only.sh'), 'classify'], { stdin: new TextEncoder().encode(raw) });
  return r.exitCode === 0 && r.stdout.toString().trim() === 'docs';
}

/**
 * The change a CI job plans for: a PR's merge commit against its base tip; or,
 * in a manual run given `as_if_changed` (CI_AFFECTED_AS_IF, paths separated by
 * spaces), those paths as if a PR changed them, to preview a PR's run on the
 * real runners. Anything else: why everything runs.
 */
export function ciChanges(env = process.env, repo = repoRoot): { changes: Change[]; docsOnly: boolean; preview?: true } | { why: string } {
  const asIf = (env.CI_AFFECTED_AS_IF ?? '').trim();
  if ((env.CI_AFFECTED ?? '').trim().toLowerCase() === 'off') return { why: 'the repo variable CI_AFFECTED is off' };
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && asIf) {
    const paths = asIf.split(/\s+/);
    if (paths.some((p) => !SAFE_PATH.test(p) || p.startsWith('/') || p.split('/').includes('..'))) return { why: 'the as-if path list has unusual characters' };
    const changes = paths.map((path) => ({ status: existsSync(join(repo, path)) ? 'M' : 'D', path, added: [], removed: [] }));
    return { changes, docsOnly: docsOnlyPaths(changes), preview: true };
  }
  if (prLabels(env).includes(RUN_ALL_LABEL)) return { why: `the PR has the ${RUN_ALL_LABEL} label` };
  const range = prRange(env, repo);
  if ('why' in range) return range;
  return { changes: changesBetween(range.base, range.head, repo), docsOnly: docsOnly(range.base, range.head, repo) };
}

// ---------------------------------------------------------------------------
// A push to main

/**
 * The passed Test runs of pushes to main, newest first. deploy.yml reads the
 * same list for its BEFORE_SHA (scripts/ci-affected-map.test.ts holds the two
 * to it), so the plan's base is the commit the last deploy came from.
 */
export const PASSED_MAIN_RUNS = 'actions/workflows/test.yml/runs?branch=main&event=push&status=success&per_page=50';

/**
 * The paths a push to main may change and still plan like a PR: the marketing
 * site and the docs, which nothing the product ships is built from (the
 * native app's own files count too: only mobile-ios.yml builds them). Any
 * other path in the range runs everything, as main always did: main is the
 * backstop for what a PR's plan leaves out. A path here still gets every
 * safety valve of the plan (a manifest, a tsconfig, deleted code...).
 */
export const PUSH_LIGHT = ['apps/marketing/**', 'docs/**', 'adr/**', '.github/assets/**', '*.md', 'LICENSE-*'];

/**
 * Site files the product reads from plannotator.ai at runtime, so a change
 * there reaches people the moment the site deploys, whatever the picker
 * missed: never light. The Inbox's icon sets (INBOX_ICON_SETS_POINTER_DEFAULT),
 * the decision post's banner (DECISION_POST_BANNER), the hand-uploaded hosted
 * files (PERSONAL_AGENTS_BANNER_BASE), the announcement dialogs' footage and
 * posters (MEDIA_BASE_URL), and the pages a cloud agent is told to follow
 * (INBOX_CLOUD_SETUP_PAGE, INBOX_CLOUD_MUSE_PAGE) with their sources.
 */
export const PUSH_RUNTIME_SITE: RegExp[] = [
  /^apps\/marketing\/public\/assets\/(icon-sets|decisions|hosted)\//,
  /^apps\/marketing\/public\/assets\/(ask-this-session|inbox-film|tui-herdr)[^/]*$/,
  /^apps\/marketing\/src\/lib\/inbox-(cloud-agent|muse)\.md$/,
  /^apps\/marketing\/src\/pages\/\[inbox\]\//,
];

export const pushLight = (path: string) =>
  nativeAppFile(path) || (PUSH_LIGHT.some((g) => match(g, path)) && !PUSH_RUNTIME_SITE.some((r) => r.test(path)));

const SHA = /^[0-9a-f]{40}$/;

/**
 * The commit of the newest passed Test run of a push to main that is older
 * than this run: deploy.yml's BEFORE_SHA (`[.workflow_runs[] | select(.id <
 * TEST_RUN_ID)] | first | .head_sha`). Null when there is none or the answer
 * is not the shape expected.
 */
export function lastPassedSha(runs: unknown, runId: number): string | null {
  const list = (runs as { workflow_runs?: unknown } | null)?.workflow_runs;
  if (!Array.isArray(list)) return null;
  const hit = list.find((r) => typeof r?.id === 'number' && r.id < runId);
  return typeof hit?.head_sha === 'string' && SHA.test(hit.head_sha) ? hit.head_sha : null;
}

/** A GET on this repository's API (a path after `repos/<owner>/<repo>/`). */
export type RepoApi = (path: string) => Promise<unknown>;

function githubApi(env = process.env): RepoApi {
  return async (path) => {
    const token = env.GH_TOKEN;
    if (!token) throw new Error('no GH_TOKEN');
    const res = await fetch(`${env.GITHUB_API_URL || 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status} on ${path.split('?')[0]}`);
    return res.json();
  };
}

/**
 * In a push to main: the last main commit whose Test run passed, and the
 * pushed commit. A run can cover several commits (a newer push replaces a
 * waiting run), and a failed run's commits are tested again by the next one,
 * so the base is never just the parent. Anything it cannot tell (the first
 * run, an API error, a base that the pushed commit does not contain) is why
 * everything runs.
 */
export async function pushRange(env = process.env, api: RepoApi = githubApi(env), repo = repoRoot): Promise<{ base: string; head: string } | { why: string }> {
  if ((env.CI_AFFECTED ?? '').trim().toLowerCase() === 'off') return { why: 'the repo variable CI_AFFECTED is off' };
  if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== 'refs/heads/main') return { why: `not a pull_request run or a push to main (${env.GITHUB_EVENT_NAME || 'no event'})` };
  const runId = Number(env.GITHUB_RUN_ID);
  if (!Number.isSafeInteger(runId) || runId <= 0) return { why: 'a push to main without a run id' };
  try {
    const head = git(['rev-parse', 'HEAD'], repo).trim();
    const base = lastPassedSha(await api(PASSED_MAIN_RUNS), runId);
    if (!base) return { why: 'a push to main with no earlier passed Test run to plan from' };
    // "ahead": the pushed commit contains the base (history was not rewritten).
    const order = ((await api(`compare/${base}...${head}`)) as { status?: unknown } | null)?.status;
    if (order !== 'ahead') return { why: `a push to main that is ${String(order)} of the last passed commit ${base.slice(0, 9)}, not ahead` };
    try { git(['cat-file', '-e', `${base}^{commit}`], repo); } catch { git(['fetch', '--no-tags', '--depth=1', 'origin', base], repo); }
    return { base, head };
  } catch (e) {
    return { why: `a push to main whose last passed commit could not be read: ${(e as Error).message.split('\n')[0]}` };
  }
}

/**
 * The change a push to main plans for: everything since the last passed
 * commit, when every path in it is a light one (PUSH_LIGHT); otherwise why
 * everything runs.
 */
export async function pushChanges(env = process.env, api?: RepoApi, repo = repoRoot): Promise<{ changes: Change[]; docsOnly: boolean; base: string } | { why: string }> {
  const range = await pushRange(env, api, repo);
  if ('why' in range) return range;
  const changes = changesBetween(range.base, range.head, repo);
  const heavy = changes.find((c) => !pushLight(c.path));
  if (heavy) return { why: `a push to main whose commits since ${range.base.slice(0, 9)} change more than the site and docs (${heavy.path})` };
  return { changes, docsOnly: docsOnly(range.base, range.head, repo), base: range.base };
}

// ---------------------------------------------------------------------------
// Reports

const MAX_LIST = 400;

export function report(p: Plan, extra: Decision[] = []): string {
  const by = (w: Picked['why']) => p.tests.filter((t) => t.why === w);
  const changedTests = by('changed');
  const reached = by('reached');
  const scanners = by('scanner');
  const lines: string[] = [];
  lines.push(`Mode: ${p.mode}${p.mode === 'all' ? ` (every job and every test, as on main): ${p.reasons.slice(0, 5).join('; ')}${p.reasons.length > 5 ? `; and ${p.reasons.length - 5} more` : ''}` : p.mode === 'docs' ? ' (docs only: no tests run)' : ''}`);
  lines.push(`Changed files: ${p.changed.length}`);
  if (p.mode === 'subset') {
    lines.push(`Test files: ${p.tests.length} of ${p.total} (${changedTests.length} changed by the PR, ${reached.length} reached by the change, ${scanners.length} tree-scanning), plus ${CORE_GUARDS.length} guards in Checks`);
  } else if (p.mode === 'all') {
    lines.push(`Test files: all ${p.total}`);
  }
  lines.push('');
  lines.push('Jobs:');
  const lane = (name: string, lanes: string[], files: number) => `  ${lanes.length ? 'run    ' : 'skipped'} ${name}: ${lanes.length ? `${lanes.join(', ')}${p.mode === 'all' ? '' : ` (${files} files)`}` : 'no affected test file'}`;
  lines.push(`  ${p.mode === 'docs' ? 'skipped' : 'run    '} Checks (types, release version, guards)`);
  lines.push(lane('Unit tests', p.unit.lanes, p.unit.files.length));
  lines.push(lane('DOM tests', p.dom.lanes, p.dom.files.length));
  for (const d of [...p.gates, ...extra]) lines.push(`  ${d.run ? 'run    ' : 'skipped'} ${d.title}: ${d.why}`);
  lines.push(`  ${p.semgrep.mode === 'skip' ? 'skipped' : 'run    '} Semgrep CE (${p.semgrep.mode}): ${p.semgrep.why}`);
  if (p.mode === 'subset') {
    lines.push('');
    lines.push(`Tests the PR changed or the change reaches (${changedTests.length + reached.length}):`);
    for (const t of [...changedTests, ...reached].slice(0, MAX_LIST)) lines.push(`  ${t.path}${t.via ? `  (via ${t.via})` : '  (changed)'}`);
    if (changedTests.length + reached.length > MAX_LIST) lines.push(`  ... and ${changedTests.length + reached.length - MAX_LIST} more`);
  }
  for (const n of p.notes) lines.push(`Note: ${n}`);
  return lines.join('\n');
}

function summaryMarkdown(p: Plan): string {
  const text = report(p);
  const scanners = p.tests.filter((t) => t.why === 'scanner').map((t) => t.path);
  return [
    '### What this PR runs (scripts/ci-affected.ts)',
    '',
    '```text',
    text,
    '```',
    ...(scanners.length ? ['', `<details><summary>Tree-scanning tests, run on every change (${scanners.length})</summary>`, '', ...scanners.map((s) => `- ${s}`), '', '</details>'] : []),
    '',
    'Print the same for a branch locally: `bun run ci:affected --print`.',
    '',
  ].join('\n');
}

/** One-line notice for `gh run view`: the tests the change reaches and the jobs it skips. */
function notice(p: Plan): string {
  const direct = p.tests.filter((t) => t.why === 'changed' || t.why === 'reached').map((t) => t.path);
  const skipped = [
    ...(p.unit.lanes.length ? [] : ['Unit tests']), ...(p.dom.lanes.length ? [] : ['DOM tests']),
    ...p.gates.filter((d) => !d.run).map((d) => d.title),
  ];
  const head = p.mode === 'all' ? `Every test runs (${p.reasons[0]}).`
    : p.mode === 'docs' ? 'Docs only: no tests run.'
    : `${direct.length} test files changed or reached by the change: ${direct.slice(0, 40).join(', ')}${direct.length > 40 ? `, and ${direct.length - 40} more (job log)` : ''}. Plus ${p.tests.length - direct.length} tree-scanning tests.`;
  return `${head} Skipped: ${skipped.length ? skipped.join(', ') : 'nothing'}.`;
}

const esc = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function setOutputs(values: Record<string, string>) {
  const out = process.env.GITHUB_OUTPUT;
  const text = Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  if (out) appendFileSync(out, text);
  else process.stdout.write(text);
}

// ---------------------------------------------------------------------------
// CLI

function planOutputs(p: Plan): Record<string, string> {
  const flags = Object.fromEntries(p.gates.map((d) => [d.key, String(d.run)]));
  return {
    mode: p.mode,
    unit_lanes: JSON.stringify(p.unit.lanes),
    dom_lanes: JSON.stringify(p.dom.lanes),
    // Empty in `all` mode: the lanes then run in full.
    unit_tests: p.mode === 'all' ? '' : JSON.stringify(p.unit.files),
    dom_tests: p.mode === 'all' ? '' : JSON.stringify(p.dom.files),
    unit_shards: String(p.unit.shards),
    dom_shards: String(p.dom.shards),
    ...flags,
  };
}

function allPlan(why: string): Plan {
  return {
    mode: 'all', reasons: [why], changed: [], tests: [], total: 0, notes: [],
    unit: { lanes: allLanes().unit, files: [], shards: UNIT_SHARDS },
    dom: { lanes: allLanes().dom, files: [], shards: DOM_SHARDS },
    gates: GATES['test.yml']!.map((g) => ({ key: g.key, title: g.title, run: true, why: `everything runs: ${why}` })),
    semgrep: { mode: 'full', files: [], why: 'everything runs' },
  };
}

/**
 * The Test workflow's plan job. Never fails: any error is a plan that runs everything.
 * A push to main plans its commits since the last passed one when they are all light
 * (pushChanges); a PR its merge commit; anything else runs everything.
 */
async function ciPlan() {
  let p: Plan;
  const push = process.env.GITHUB_EVENT_NAME === 'push';
  try {
    const got = push ? await pushChanges() : ciChanges();
    if ('why' in got) p = plan({ files: [], graph: {} }, { changes: [], docsOnly: false, forceAll: got.why });
    else {
      p = plan(buildGraph(), { changes: got.changes, docsOnly: got.docsOnly });
      if ('preview' in got && got.preview) p.notes.push('a manual preview: planned as if a PR changed only the as_if_changed paths');
      if ('base' in got) p.notes.push(`a push to main: planned for every commit since ${got.base.slice(0, 9)}, the last one whose Test run passed (only the site and docs changed)`);
    }
  } catch (e) {
    p = allPlan(`the picker failed: ${(e as Error).message.split('\n')[0]}`);
  }
  const text = report(p);
  console.log(`==== ci-affected: what this ${push ? 'push' : 'PR'} runs ====`);
  console.log(text);
  const scanners = p.tests.filter((t) => t.why === 'scanner');
  if (scanners.length) {
    console.log(`\nTree-scanning tests (${scanners.length}):`);
    for (const t of scanners) console.log(`  ${t.path}`);
  }
  console.log('==== end ====');
  console.log(`::notice title=Tests this ${push ? 'push' : 'PR'} runs (${p.mode})::${esc(notice(p))}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(p));
  setOutputs(planOutputs(p));
}

/** A gate job of another workflow: path rules only, no graph. Never fails: an error runs every job. */
function ciGate(workflow: string) {
  const file = workflow.endsWith('.yml') ? workflow : `${workflow}.yml`;
  let decisions: Decision[];
  let semgrep: Semgrep | undefined;
  try {
    if (!GATES[file]) throw new Error(`no gates for ${file}`);
    const got = ciChanges();
    let mode: Mode = 'all';
    let reasons: string[] = [];
    let changes: Change[] = [];
    if ('why' in got) reasons = [got.why];
    else {
      changes = got.changes;
      if (!changes.length) reasons = ['the diff is empty'];
      else if (got.docsOnly) mode = 'docs';
      else { reasons = pathReasons(changes); mode = reasons.length ? 'all' : 'subset'; }
    }
    const graph = mode === 'subset' && GATES[file]!.some((g) => g.reaches) ? buildGraph() : undefined;
    decisions = decideGates(file, mode, reasons, changes, undefined, graph);
    if (file === 'security.yml') semgrep = semgrepPlan(mode, changes);
  } catch (e) {
    const why = `the gate failed: ${(e as Error).message.split('\n')[0]}`;
    decisions = (GATES[file] ?? []).map((g) => ({ key: g.key, title: g.title, run: true, why }));
    if (file === 'security.yml') semgrep = { mode: 'full', files: [], why };
  }
  const lines = decisions.map((d) => `${d.run ? 'run    ' : 'skipped'} ${d.title}: ${d.why}`);
  if (semgrep) lines.push(`${semgrep.mode === 'skip' ? 'skipped' : 'run    '} Semgrep CE (${semgrep.mode}): ${semgrep.why}${semgrep.files.length ? `\n  ${semgrep.files.join('\n  ')}` : ''}`);
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### What this PR runs in ${file}\n\n\`\`\`text\n${lines.join('\n')}\n\`\`\`\n`);
  setOutputs({
    ...Object.fromEntries(decisions.map((d) => [d.key, String(d.run)])),
    ...(semgrep ? { semgrep: semgrep.mode, semgrep_files: JSON.stringify(semgrep.files) } : {}),
  });
}

function localPrint(args: string[]) {
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const head = opt('--head');
  let base = opt('--base');
  base = base ? git(['rev-parse', '--verify', `${base}^{commit}`]).trim() : git(['merge-base', 'HEAD', 'origin/main']).trim();
  if (!existsSync(join(repoRoot, 'node_modules'))) {
    console.error('ci-affected: run `bun install` first (imports resolve through node_modules)');
    process.exit(2);
  }
  const changes = changesBetween(base, head);
  const extra = head ? [] : untrackedFiles();
  const p = plan(buildGraph(repoRoot, extra), { changes, docsOnly: changes.length > 0 && docsOnly(base, head) });
  const other = [...decideGates('browser-smoke.yml', p.mode, p.reasons, changes), ...decideGates('security.yml', p.mode, p.reasons, changes), ...decideGates('windows.yml', p.mode, p.reasons, changes)];
  if (args.includes('--json')) { console.log(JSON.stringify({ base, head: head ?? 'working tree', ...p, other }, null, 1)); return; }
  console.log(`Against ${base.slice(0, 9)} (${head ? head : 'the working tree'}):`);
  console.log(report(p, other));
  const scanners = p.tests.filter((t) => t.why === 'scanner');
  if (scanners.length) {
    if (args.includes('--scanners')) { console.log(`\nTree-scanning tests (${scanners.length}):`); for (const t of scanners) console.log(`  ${t.path}`); }
    else console.log(`\nPlus ${scanners.length} tree-scanning tests CI runs on every change (--scanners lists them).`);
  }
  console.log('\nRun the ones you can locally with `bun run test:sandbox <file...>`. Release dry run, Inbox Pi, Claude Code and relay follow the path lists in their workflows.');
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'plan') await ciPlan();
  else if (cmd === 'gate' && rest[0]) ciGate(rest[0]);
  else if (cmd === '--print' || cmd === 'print' || process.argv.includes('--print')) localPrint(process.argv.slice(2));
  else {
    console.error('usage: bun run ci:affected --print [--base <ref>] [--head <ref>] [--scanners] [--json]\n       bun run scripts/ci-affected.ts plan | gate <workflow>');
    process.exit(2);
  }
}
