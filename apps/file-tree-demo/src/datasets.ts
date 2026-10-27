/**
 * The demo's path lists. Everything here is deterministic: the same list on
 * every load, so a screenshot or a timing can be taken again.
 */
import type { FileTreeBadge } from '@plannotator/ui/components/file-tree';

export type DatasetId = 'repo' | 'huge' | 'worst';

export interface Dataset {
  paths: string[];
  /** Real `git status` letters (the repo set only). */
  status: Map<string, FileTreeBadge>;
  /** Folders open at the start. */
  expanded: string[];
  /** One line about where the list came from. */
  note: string;
}

export const DATASETS: { id: DatasetId; label: string }[] = [
  { id: 'repo', label: 'This repo' },
  { id: 'huge', label: 'Huge monorepo (100k)' },
  { id: 'worst', label: 'Worst cases' },
];

// ------------------------------------------------------------------ this repo

const STATUS_TONE: Record<string, { letter: string; tone: FileTreeBadge['tone']; label: string }> = {
  M: { letter: 'M', tone: 'modified', label: 'Modified' },
  A: { letter: 'A', tone: 'added', label: 'Added' },
  D: { letter: 'D', tone: 'deleted', label: 'Deleted' },
  '?': { letter: 'U', tone: 'untracked', label: 'Untracked' },
};

/** Shown as untracked when the checkout has none, so the set always has some. */
const DEMO_UNTRACKED = ['scratch/notes.md', 'scratch/tree-ideas.txt', 'packages/ui/components/file-tree/NOTES.local.md'];

export async function loadRepo(): Promise<Dataset> {
  const res = await fetch('/__demo/repo-files');
  const data = (await res.json()) as { tracked: string[]; untracked: string[]; status: { code: string; path: string }[] };
  const untracked = data.untracked.length > 0 ? data.untracked : DEMO_UNTRACKED;
  const status = new Map<string, FileTreeBadge>();
  for (const { code, path } of data.status) {
    const key = code.trim()[0];
    const tone = key ? STATUS_TONE[key] : undefined;
    if (tone && !path.endsWith('/')) status.set(path, { letter: tone.letter, tone: tone.tone, label: tone.label, struck: key === 'D' });
  }
  for (const path of untracked) if (!status.has(path)) status.set(path, { letter: 'U', tone: 'untracked', label: 'Untracked' });
  const paths = [...new Set([...data.tracked, ...untracked])];
  return {
    paths,
    status,
    expanded: ['packages', 'packages/ui', 'packages/ui/components', 'packages/ui/components/file-tree'],
    note: `git ls-files (${data.tracked.length.toLocaleString()}) + ${untracked.length} untracked${data.untracked.length === 0 ? ' (demo names)' : ''}`,
  };
}

// --------------------------------------------------------------- huge monorepo

/** A small seeded PRNG (mulberry32): the same numbers on every load. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DOMAINS = ['auth', 'billing', 'search', 'checkout', 'catalog', 'inventory', 'analytics', 'notifications', 'payments', 'profile', 'settings', 'admin', 'reports', 'media', 'chat', 'calendar', 'maps', 'orders', 'shipping', 'reviews', 'pricing', 'onboarding', 'feed', 'gateway', 'identity', 'ledger', 'scheduler', 'storage', 'telemetry', 'experiments'];
const KINDS = ['ui', 'core', 'api', 'client', 'server', 'sdk', 'utils', 'hooks', 'store', 'schema', 'worker', 'cli', 'config'];
const NOUNS = ['User', 'Order', 'Product', 'Cart', 'Invoice', 'Account', 'Session', 'Payment', 'Search', 'Filter', 'Table', 'Modal', 'Drawer', 'Toolbar', 'Sidebar', 'Header', 'Footer', 'Avatar', 'Badge', 'Card', 'Chart', 'Form', 'Field', 'Select', 'Tabs', 'Menu', 'Toast', 'Banner', 'Dialog', 'Picker'];
const ROLES = ['List', 'View', 'Panel', 'Item', 'Row', 'Editor', 'Summary', 'Details', 'Button', 'Input', 'Skeleton', 'Empty', 'Grid', 'Preview'];
const UTILS = ['format', 'parse', 'validate', 'debounce', 'throttle', 'retry', 'cache', 'logger', 'errors', 'dates', 'money', 'ids', 'paths', 'http', 'queue', 'diff', 'merge', 'sort', 'group', 'paginate'];
const HOOKS = ['useAuth', 'useFetch', 'useDebounce', 'usePagination', 'useMediaQuery', 'useLocalStorage', 'useKeyboard', 'useHover', 'useResize', 'useInterval', 'useSelection', 'useToast'];

function pick<T>(r: () => number, list: readonly T[]): T {
  return list[Math.floor(r() * list.length)];
}

/** One package: the files a real TypeScript package in a monorepo has. */
function addPackage(out: string[], r: () => number, root: string): void {
  out.push(`${root}/package.json`, `${root}/README.md`, `${root}/tsconfig.json`, `${root}/CHANGELOG.md`, `${root}/src/index.ts`);
  if (r() < 0.6) out.push(`${root}/vitest.config.ts`);
  if (r() < 0.3) out.push(`${root}/.eslintrc.cjs`);
  const components = 4 + Math.floor(r() * 26);
  const seen = new Set<string>();
  for (let i = 0; i < components; i++) {
    const name = `${pick(r, NOUNS)}${pick(r, ROLES)}`;
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = `${root}/src/components/${name}`;
    out.push(`${dir}/${name}.tsx`, `${dir}/${name}.test.tsx`, `${dir}/index.ts`);
    if (r() < 0.5) out.push(`${dir}/${name}.module.css`);
    if (r() < 0.25) out.push(`${dir}/${name}.stories.tsx`);
    if (r() < 0.15) out.push(`${dir}/__snapshots__/${name}.test.tsx.snap`);
  }
  const utils = 2 + Math.floor(r() * 10);
  for (let i = 0; i < utils; i++) {
    const u = pick(r, UTILS);
    out.push(`${root}/src/utils/${u}.ts`, `${root}/src/utils/${u}.test.ts`);
  }
  const hooks = Math.floor(r() * 7);
  for (let i = 0; i < hooks; i++) out.push(`${root}/src/hooks/${pick(r, HOOKS)}.ts`);
  if (r() < 0.5) {
    const routes = 2 + Math.floor(r() * 12);
    for (let i = 0; i < routes; i++) out.push(`${root}/src/api/v${1 + Math.floor(r() * 3)}/${pick(r, DOMAINS)}/${pick(r, ['get', 'list', 'create', 'update', 'delete'])}.ts`);
  }
  if (r() < 0.4) {
    const fixtures = 3 + Math.floor(r() * 20);
    for (let i = 0; i < fixtures; i++) out.push(`${root}/tests/fixtures/${pick(r, DOMAINS)}-${i + 1}.json`);
  }
}

/** A monorepo of exactly `count` files: apps, packages, services, docs, infra. */
export function hugeMonorepo(count = 100_000): Dataset {
  const r = rng(2196);
  const out: string[] = [
    'package.json', 'README.md', 'LICENSE', 'tsconfig.base.json', 'turbo.json', 'pnpm-workspace.yaml', '.gitignore', '.editorconfig', '.nvmrc',
    '.github/CODEOWNERS', '.github/pull_request_template.md',
  ];
  for (const w of ['ci', 'release', 'deploy-web', 'deploy-api', 'e2e', 'lint', 'codeql', 'renovate']) out.push(`.github/workflows/${w}.yml`);
  // Docs: sections with nested pages.
  for (const d of DOMAINS) {
    const pages = 5 + Math.floor(r() * 25);
    for (let i = 0; i < pages; i++) out.push(`docs/${d}/${pick(r, ['guide', 'reference', 'how-to', 'concepts'])}/${pick(r, NOUNS).toLowerCase()}-${i + 1}.md`);
  }
  // Infra.
  for (const env of ['dev', 'staging', 'prod']) {
    for (const d of DOMAINS) out.push(`infra/terraform/envs/${env}/${d}.tf`);
  }
  for (let i = 0; i < 40; i++) out.push(`infra/terraform/modules/${pick(r, DOMAINS)}-${pick(r, KINDS)}/${pick(r, ['main', 'variables', 'outputs'])}.tf`);
  // Apps, services, then packages until the count is reached.
  for (const d of DOMAINS.slice(0, 18)) addPackage(out, r, `apps/${d}-web`);
  for (const d of DOMAINS) addPackage(out, r, `services/${d}-service`);
  let n = 0;
  while (out.length < count * 1.2) {
    const d = DOMAINS[n % DOMAINS.length];
    const k = KINDS[Math.floor(n / DOMAINS.length) % KINDS.length];
    const gen = Math.floor(n / (DOMAINS.length * KINDS.length));
    addPackage(out, r, `packages/${d}/${k}${gen > 0 ? `-${gen + 1}` : ''}`);
    n++;
  }
  const unique = [...new Set(out)].slice(0, count);
  return { paths: unique, status: new Map(), expanded: [], note: `${unique.length.toLocaleString()} files, generated (seed 2196)` };
}

// ------------------------------------------------------------------ worst cases

export function worstCases(): Dataset {
  const out: string[] = [];
  // Very long names, a file and a folder.
  out.push(
    `long-names/${'a-really-long-file-name-that-keeps-going-'.repeat(5)}end.ts`,
    `long-names/${'Supercalifragilisticexpialidocious'.repeat(6)}.md`,
    `long-names/${'x'.repeat(240)}.txt`,
    `long-names/${'a-folder-whose-name-is-far-too-long-to-fit-'.repeat(4)}/inside.ts`,
    'long-names/short.ts',
  );
  // Unicode and emoji (right-to-left, combining marks, ZWJ sequences, flags).
  out.push(
    'unicode/ドキュメント/設計書.md',
    'unicode/ドキュメント/とても長い日本語のファイル名がここに続いていきますよ本当に長いです.txt',
    'unicode/Ελληνικά/αρχείο.txt',
    'unicode/العربية/ملف التكوين.json',
    'unicode/עברית/קובץ.md',
    'unicode/हिन्दी/फ़ाइल.txt',
    'unicode/한국어/파일.ts',
    'unicode/中文/文件名称.tsx',
    'unicode/café/naïve résumé.md',
    'unicode/combining/été.txt',
    'unicode/emoji 🎉/party 🎈🎊.md',
    'unicode/emoji 🎉/👨‍👩‍👧‍👦 family.txt',
    'unicode/emoji 🎉/🇯🇵🇧🇷🇰🇪 flags.json',
    'unicode/emoji 🎉/🔥.ts',
    'unicode/🚀 launch/checklist ✅.md',
    'unicode/spaces/  two leading spaces.txt',
    'unicode/spaces/name with    many   spaces.txt',
    'unicode/quotes/"quoted" and \'single\'.md',
    'unicode/symbols/#hash & ampersand <angle> (paren) [bracket] {brace}.txt',
  );
  // Deep nesting: 35 levels, with a few siblings on the way down.
  let deep = 'deep';
  for (let i = 1; i <= 35; i++) {
    deep += `/level-${String(i).padStart(2, '0')}`;
    if (i % 7 === 0) out.push(`${deep}-notes.md`);
  }
  out.push(`${deep}/the-bottom.txt`, `${deep}/also-at-the-bottom.ts`);
  // Dotfiles and dot folders.
  out.push(
    '.env', '.env.local', '.env.production', '.gitignore', '.gitattributes', '.npmrc', '.prettierrc', '.eslintrc.cjs', '..double-dot',
    '.github/workflows/ci.yml', '.github/dependabot.yml', '.vscode/settings.json', '.vscode/extensions.json', '.husky/pre-commit',
    '.hidden-folder/.also-hidden', '.hidden-folder/visible.txt',
  );
  // Many siblings: 5,000 files in one folder (natural order: 2 before 10).
  for (let i = 1; i <= 5000; i++) out.push(`many-siblings/file-${i}.ts`);
  // Natural order and case.
  out.push('order/a1.ts', 'order/a2.ts', 'order/a10.ts', 'order/a20.ts', 'order/A3.ts', 'order/b.ts', 'order/README.md', 'order/readme.md', 'order/_underscore.ts', 'order/-dash.ts', 'order/0-zero.ts');
  // Empty folders (a folder entry ends in "/").
  out.push('empty-folder/', 'has-only-empty/inner-empty/');
  out.push('README.md');
  return {
    paths: out,
    status: new Map(),
    expanded: ['long-names', 'unicode', 'unicode/emoji 🎉', 'unicode/العربية', 'empty-folder', 'has-only-empty'],
    note: 'long names, unicode, 35 levels, dotfiles, 5,000 siblings, empty folders',
  };
}

// ---------------------------------------------------------------------- badges

/** FNV-1a: a stable number per path, so the same files get the same marks. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Git marks (M, A, D, untracked) and comment counts on a stable sample of
 * files, plus the set's real status (this repo). Built once per set and
 * toggle change.
 */
export function buildBadges(paths: readonly string[], real: ReadonlyMap<string, FileTreeBadge>, opts: { git: boolean; comments: boolean }): Map<string, FileTreeBadge> | null {
  if (!opts.git && !opts.comments) return null;
  const out = new Map<string, FileTreeBadge>();
  for (const path of paths) {
    if (path.endsWith('/')) continue;
    const h = hash(path);
    let badge: FileTreeBadge | undefined;
    if (opts.git) {
      const r = real.get(path);
      if (r) badge = { ...r };
      else if (h % 41 === 0) badge = { letter: 'M', tone: 'modified', label: 'Modified', additions: 1 + (h % 37), deletions: h % 13 };
      else if (h % 67 === 1) badge = { letter: 'A', tone: 'added', label: 'Added', additions: 5 + (h % 120) };
      else if (h % 97 === 2) badge = { letter: 'D', tone: 'deleted', label: 'Deleted', deletions: 3 + (h % 60), struck: true };
      else if (h % 89 === 3) badge = { letter: 'U', tone: 'untracked', label: 'Untracked' };
    }
    if (opts.comments && (h >>> 8) % 31 === 0) {
      const count = 1 + ((h >>> 16) % 4);
      badge = { ...badge, count, label: [badge?.label, `${count} comment${count === 1 ? '' : 's'}`].filter(Boolean).join(', ') };
    }
    if (badge) out.set(path, badge);
  }
  return out;
}
