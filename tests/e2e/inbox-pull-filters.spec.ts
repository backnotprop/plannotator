/**
 * The Pull requests list's filter (approval "pr-list-filters", take B Joined), proved in a real browser against the
 * compiled binary. The same sandbox as inbox-pull-requests.spec.ts: `plannotator inbox --background` under a temp
 * PLANNOTATOR_DATA_DIR, `gh` and `glab` sh fakes first on PATH (nothing reaches GitHub or GitLab; the real CLIs never
 * run), simulated agents through `plannotator inbox mcp`. HOME is never changed.
 *
 * What is proved, in order:
 *  1. The read: one gh query with the person's searches, the assigned one, and one Others search scoped to the
 *     projects' repositories (never unscoped); one glab query with the assigned list and the project's open MRs.
 *  2. At 1440: "PRs", and "5 on you │ [filter]" in one control on the right (its tooltip says what "on you" means);
 *     the menu's views and projects with their counts; a view and a project narrow the rows, the count follows the
 *     project only, the head says both, and the address keeps them over a reload; × clears both. Light and dark.
 *  3. At 390 (a phone): the filter's sheet titled "Filter", 48px rows; with both picked the view keeps its icon only
 *     and the project its name; every target 44px.
 *  4. At 320: both picked, the picks keep their icons only; "on you" is never cut; one line, nothing past the edge.
 *
 * Shots land in PLANNOTATOR_E2E_PROOF_DIR/pull-filters (1440 rest, both, menu and dark; 390 rest and both with the
 * sheet open; 320 both; and sheet.png, the contact sheet). Fails if a "Tell your agents" dialog appears.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'pull-filters');

/** The real person's Inbox port: a spec's Inbox never takes it. */
const OWNER_INBOX_PORT = '59812';

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

function project(parent: string, name: string, origin: string): string {
  const dir = scratchProject(parent, name);
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  };
  git('checkout', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), `${name}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('remote', 'add', 'origin', origin);
  return dir;
}

/** The fake gh / glab (list answers only): each list read is one line in `calls`, with its arguments. */
function writeForge(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'calls'), '');
  const gh = [
    '#!/bin/sh',
    `dir='${dir}'`,
    'calls="$dir/calls"',
    'if [ "$1" = auth ] && [ "$2" = status ]; then',
    '  echo \'{"hosts":{"github.com":[{"login":"dana","active":true,"state":"success","tokenSource":"keyring"}]}}\'',
    '  exit 0',
    'fi',
    'if [ "$1" = api ] && [ "$2" = graphql ]; then',
    '  case "$*" in *"requested: search"*) echo "gh pulls $*" | tr "\\n" " " >> "$calls"; echo >> "$calls"; cat "$dir/gh-pulls.json"; exit 0;; esac',
    '  echo "gh graphql-other" >> "$calls"; echo \'{"data":null}\'; exit 1',
    'fi',
    'echo "gh other $1" >> "$calls"; exit 1',
    '',
  ].join('\n');
  const glab = [
    '#!/bin/sh',
    `dir='${dir}'`,
    'calls="$dir/calls"',
    'if [ "$1" = auth ] && [ "$2" = status ]; then',
    '  echo "gitlab.com"; echo "  ✓ Logged in to gitlab.com as dana (keyring)"; exit 0',
    'fi',
    'if [ "$1" = api ] && [ "$4" = graphql ]; then',
    '  case "$*" in *reviewRequestedMergeRequests*) echo "glab pulls $*" | tr "\\n" " " >> "$calls"; echo >> "$calls"; cat "$dir/glab-pulls.json"; exit 0;; esac',
    '  echo "glab graphql-other" >> "$calls"; echo \'{"data":null}\'; exit 1',
    'fi',
    'echo "glab other $1" >> "$calls"; exit 1',
    '',
  ].join('\n');
  for (const [file, body] of [['gh', gh], ['glab', glab]] as const) {
    writeFileSync(join(dir, file), body);
    chmodSync(join(dir, file), 0o755);
  }
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const BILLING = 'northwind/billing-svc';
const WEB = 'northwind/web-app';
const PORTAL = 'northwind/customer-billing-portal-v2';

function ghPull(repoName: string, number: number, fields: Record<string, unknown>) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/${repoName}/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    updatedAt: ago(30),
    mergedAt: null,
    baseRefName: 'main',
    headRefName: `b${number}`,
    headRefOid: String(number).padStart(40, '0'),
    additions: 40,
    deletions: 12,
    changedFiles: 3,
    reviewDecision: 'REVIEW_REQUIRED',
    repository: { nameWithOwner: repoName },
    headRepository: { nameWithOwner: repoName },
    author: { login: 'dana' },
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    ...fields,
  };
}

const requestedOf = (who: string) => ({ reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: who } }] } });

/** The person's own PRs: Claude Code's stack of three on a merged layer, Codex's approved Vite 8, one waiting on Jun. */
const MINE = [
  ghPull(BILLING, 412, { title: 'Retry schedule table and next-attempt time', headRefName: 'retry/schedule', baseRefName: 'retry/charge-client', updatedAt: ago(9), additions: 58, deletions: 0, changedFiles: 3 }),
  ghPull(BILLING, 413, { title: 'Jitter on the retry backoff', headRefName: 'retry/backoff', baseRefName: 'retry/schedule', updatedAt: ago(8), additions: 4, deletions: 2, changedFiles: 1 }),
  ghPull(BILLING, 414, { title: 'Dunning emails for the last attempts', headRefName: 'retry/dunning', baseRefName: 'retry/backoff', isDraft: true, updatedAt: ago(7), commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } }),
  ghPull(WEB, 872, { title: 'Upgrade to Vite 8', headRefName: 'codex/vite-8', reviewDecision: 'APPROVED', latestReviews: { nodes: [{ state: 'APPROVED', author: { login: 'priya' } }] }, updatedAt: ago(52) }),
  ghPull(WEB, 869, { title: 'Fall back to English for missing strings', headRefName: 'locale-fallback', ...requestedOf('jun'), updatedAt: ago(180) }),
];
const MERGED = [ghPull(BILLING, 411, { title: 'Idempotency keys on the charge client', state: 'MERGED', headRefName: 'retry/charge-client', mergedAt: ago(26 * 60), updatedAt: ago(26 * 60) })];
/** Review asked of the person: Tomas directly, Mara through the payments team, Sam in the portal. */
const REQUESTED = [
  ghPull(WEB, 880, { title: 'RTL layout for the settings pages', author: { login: 'tomas' }, headRefName: 'tomas/rtl-settings', updatedAt: ago(4), ...requestedOf('dana') }),
  ghPull(BILLING, 905, { title: 'Retry refunds when the webhook answers 5xx', author: { login: 'mara-lee' }, headRefName: 'mara/refund-retry', updatedAt: ago(41), reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'payments' } }] } }),
  ghPull(PORTAL, 77, { title: 'Show unpaid invoices first', author: { login: 'sam' }, headRefName: 'sam/unpaid-first', updatedAt: ago(12), ...requestedOf('dana') }),
];
/** Assigned to the person, review asked of Priya. */
const ASSIGNED = [ghPull(WEB, 891, { title: 'Keyboard support in the date picker', author: { login: 'jun' }, headRefName: 'jun/datepicker-keys', updatedAt: ago(95), ...requestedOf('priya') })];
/** Teammates' PRs in the projects' repositories: a stack of two, a draft, an approved one, one waiting on review. */
const TEAMMATES = [
  ghPull(WEB, 902, { title: 'Chart colors for dark mode', author: { login: 'mara-lee' }, headRefName: 'mara/chart-dark', updatedAt: ago(22), ...requestedOf('jun') }),
  ghPull(BILLING, 903, { title: 'Invoice PDF: line items', author: { login: 'sam' }, headRefName: 'sam/invoice-lines', updatedAt: ago(130), ...requestedOf('priya') }),
  ghPull(BILLING, 904, { title: 'Invoice PDF: tax summary', author: { login: 'sam' }, headRefName: 'sam/invoice-tax', baseRefName: 'sam/invoice-lines', updatedAt: ago(125), ...requestedOf('priya') }),
  ghPull(WEB, 898, { title: 'Remove the old onboarding modal', author: { login: 'tomas' }, headRefName: 'tomas/no-onboarding-modal', isDraft: true, updatedAt: ago(300) }),
  ghPull(BILLING, 907, { title: 'Currency on invoice exports', author: { login: 'priya' }, headRefName: 'priya/invoice-currency', reviewDecision: 'APPROVED', latestReviews: { nodes: [{ state: 'APPROVED', author: { login: 'sam' } }] }, updatedAt: ago(16 * 60) }),
];
const OPEN = [...MINE, ...REQUESTED, ...ASSIGNED, ...TEAMMATES];

const GH_ANSWER = {
  data: {
    viewer: { login: 'dana' },
    rateLimit: { cost: 9, remaining: 4980, resetAt: ago(-40) },
    requested: { issueCount: REQUESTED.length, nodes: REQUESTED },
    assigned: { issueCount: ASSIGNED.length, nodes: ASSIGNED },
    authored: { issueCount: MINE.length, nodes: MINE },
    merged: { nodes: MERGED },
    // Every open PR in the projects' repositories, the person's own and the asked ones among them.
    others0: { issueCount: OPEN.length, nodes: OPEN },
  },
};

const mr = (iid: number, fields: Record<string, unknown>) => ({
  iid: String(iid),
  title: `MR ${iid}`,
  webUrl: `https://gitlab.com/northwind/ledger/-/merge_requests/${iid}`,
  state: 'opened',
  draft: false,
  updatedAt: ago(20),
  mergedAt: null,
  targetBranch: 'main',
  sourceBranch: `b${iid}`,
  diffHeadSha: String(iid).padStart(40, '0'),
  approved: false,
  detailedMergeStatus: 'NOT_APPROVED',
  diffStatsSummary: { additions: 30, deletions: 4, fileCount: 2 },
  headPipeline: { status: 'SUCCESS' },
  project: { fullPath: 'northwind/ledger' },
  sourceProject: { fullPath: 'northwind/ledger' },
  author: { username: 'dana' },
  approvedBy: { nodes: [] },
  reviewers: { nodes: [] },
  ...fields,
});
const CSV = mr(61, { title: 'Export the ledger to CSV', sourceBranch: 'csv-export', headPipeline: { status: 'RUNNING' }, updatedAt: ago(15) });
const GL_TEAM = [
  mr(58, { title: 'Round cents half to even', author: { username: 'priya' }, sourceBranch: 'priya/rounding', updatedAt: ago(75), reviewers: { nodes: [{ username: 'sam' }] } }),
  mr(64, { title: 'Import bank statements from OFX', author: { username: 'sam' }, sourceBranch: 'sam/ofx', draft: true, updatedAt: ago(240) }),
];
const GL_ANSWER = {
  data: {
    currentUser: { username: 'dana', requested: { count: 0, nodes: [] }, assigned: { count: 0, nodes: [] }, authored: { count: 1, nodes: [CSV] }, merged: { nodes: [] } },
    p0: { mergeRequests: { count: 3, nodes: [CSV, ...GL_TEAM] } },
  },
};

interface World {
  url: string;
  forge: string;
  claude: SimAgent;
  codex: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
}
let world: World;

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-pull-filters-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const configFile = join(dataDir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), inboxBoard: false }));
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  const forge = join(root, 'forge');
  writeForge(forge);
  writeFileSync(join(forge, 'gh-pulls.json'), JSON.stringify(GH_ANSWER));
  writeFileSync(join(forge, 'glab-pulls.json'), JSON.stringify(GL_ANSWER));
  const src = join(root, 'src');
  const billing = project(src, 'billing-svc', 'https://github.com/northwind/billing-svc.git');
  const web = project(src, 'web-app', 'https://github.com/northwind/web-app.git');
  const ledger = project(src, 'ledger', 'git@gitlab.com:northwind/ledger.git');
  // A project with a long name, for the fit at narrow widths.
  const portal = project(src, 'customer-billing-portal-v2', 'https://github.com/northwind/customer-billing-portal-v2.git');

  const env: Record<string, string> = {
    PATH: `${forge}:${process.env.PATH ?? ''}`,
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim();
  expect(new URL(url).port).not.toBe(OWNER_INBOX_PORT);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  await claude.send({ project_path: billing, thread: 'retries', subject: 'Retry failed charges', body: 'The stack is up: three layers on top of the charge client. Start at #412.\n\nhttps://github.com/northwind/billing-svc/pull/412' });
  await codex.send({ project_path: web, thread: 'vite-8', subject: 'Vite 8', body: 'Priya approved the Vite 8 upgrade and the checks passed: https://github.com/northwind/web-app/pull/872' });
  await codex.send({ project_path: ledger, thread: 'csv', subject: 'Ledger CSV export', body: 'The CSV export is up; its pipeline is running. https://gitlab.com/northwind/ledger/-/merge_requests/61' });
  await codex.send({ project_path: portal, thread: 'portal', subject: 'Portal invoices', body: 'Looking at the portal invoices page next.' });
  const on = await page.request.post(`${url}api/inbox/settings`, { data: { code_review: { on: true } } });
  expect(on.status()).toBe(200);
  world = { url, forge, claude, codex, context, page, errors };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.claude.close().catch(() => {});
    await world.codex.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

/** Fails the run when the "Tell your agents" dialog shows. */
async function noAgentsDialog(page: Page): Promise<void> {
  if ((await page.getByText('Tell your agents', { exact: false }).count()) > 0) throw new Error('"Tell your agents" dialog appeared');
}

async function snap(page: Page, name: string, scheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await page.waitForTimeout(400);
  await noAgentsDialog(page);
  await page.screenshot({ path: join(proofDir, `${name}.png`) });
}

const TRIGGER = '[data-pulls-filter-trigger]';
const MENU = '[data-pulls-filter-menu]';
const TIP = "On you: a review requested from you, changes requested or checks failed on your own PR, your agent's PR, or one assigned to you";

/** Opens the filter's menu and picks a row by its words (a row's name is its words and its count, "To review 4"). */
async function choose(page: Page, item: string): Promise<void> {
  const menu = page.locator(MENU);
  await page.locator(TRIGGER).click();
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitemradio', { name: new RegExp(`^${item.replace(/[-]/g, '\\-')} \\d+$`) }).click();
  await expect(menu).toHaveCount(0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** The menu's rows, as "words count" (✓ on the chosen one). */
async function menuRows(page: Page, selector: string): Promise<string[]> {
  return page.locator(`${MENU} ${selector}`).evaluateAll((rows) =>
    rows.map((r) => `${r.querySelector('.ib-pmi-l')!.textContent} ${r.querySelector('.ib-pmi-n')!.textContent}${r.getAttribute('aria-checked') === 'true' ? ' ✓' : ''}`),
  );
}

/** Every row the list shows, the folded ones opened. */
async function rows(page: Page): Promise<string[]> {
  const fold = page.locator('[data-pulls-waiting-toggle]');
  if ((await fold.count()) > 0 && (await fold.getAttribute('aria-expanded')) === 'false') await fold.click();
  return (await page.locator('[data-pulls-row]').evaluateAll((els) => els.map((el) => el.getAttribute('data-pulls-row')!))).sort();
}

/** The head now: whether "on you" is clipped, the control over the title or past the edge, one line, the targets. */
async function head(page: Page) {
  return page.evaluate(() => {
    const lhead = document.querySelector('[data-pulls-list] .ib-lhead')!;
    const h1 = document.querySelector('[data-pulls-heading]')!;
    const pc = document.querySelector('.ib-pc') as HTMLElement;
    const l = lhead.getBoundingClientRect();
    const t = h1.getBoundingClientRect();
    const c = pc.getBoundingClientRect();
    const you = pc.querySelector<HTMLElement>('.ib-pc-you');
    const btn = pc.querySelector<HTMLElement>('.ib-pc-btn')!.getBoundingClientRect();
    const y = you?.getBoundingClientRect();
    return {
      words: (lhead as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
      shown_words: [...pc.querySelectorAll<HTMLElement>('.ib-pc-w')].filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.textContent),
      on_you_clipped: !!y && (y.right > btn.right + 0.5 || y.left < btn.left - 0.5),
      overlaps_title: c.left < t.right - 0.5,
      past_edge: c.right > l.right + 0.5 || pc.scrollWidth > pc.clientWidth + 1,
      one_line: c.top >= l.top && c.bottom <= l.bottom,
      targets: [...pc.querySelectorAll<HTMLElement>('button')].map((el) => {
        const r = el.getBoundingClientRect();
        return { name: el.getAttribute('aria-label'), w: Math.round(r.width), h: Math.round(r.height) };
      }),
    };
  });
}

function fits(h: Awaited<ReturnType<typeof head>>, phone: boolean): void {
  expect(h.on_you_clipped, '"on you" clipped').toBe(false);
  expect(h.overlaps_title, 'over the title').toBe(false);
  expect(h.past_edge, 'past the edge').toBe(false);
  expect(h.one_line, 'one line').toBe(true);
  if (phone) {
    for (const t of h.targets) {
      expect(t.h, `${t.name} height`).toBeGreaterThanOrEqual(44);
      expect(t.w, `${t.name} width`).toBeGreaterThanOrEqual(44);
    }
  }
}

test('the read: the assigned search and one Others search scoped to the projects; GitLab the assigned list and the project', async () => {
  const { page } = world;
  await page.goto(`${world.url}#pulls`);
  await expect(page.locator('[data-pulls-row]').first()).toBeVisible();
  const calls = readFileSync(join(world.forge, 'calls'), 'utf8').split('\n').filter(Boolean);
  const gh = calls.filter((c) => c.startsWith('gh pulls'));
  const glab = calls.filter((c) => c.startsWith('glab pulls'));
  expect(gh).toHaveLength(1);
  expect(glab).toHaveLength(1);
  expect(gh[0]).toContain('assigned=is:pr is:open archived:false assignee:@me');
  expect(gh[0]).toContain('others0=is:pr is:open archived:false sort:updated-desc repo:northwind/billing-svc repo:northwind/customer-billing-portal-v2 repo:northwind/web-app');
  expect(gh[0]).not.toContain('others1=');
  expect(gh[0]).toContain('rateLimit { cost remaining resetAt }');
  expect(glab[0]).toContain('assignedMergeRequests(state: opened');
  expect(glab[0]).toContain('p0: project(fullPath: "northwind/ledger")');
});

test('1440: the count and the filter in one control; the menu; a view and a project narrow the list and stay in the address', async () => {
  const { page } = world;
  await page.goto(`${world.url}#pulls`);
  const list = page.locator('[data-pulls-list]');
  await expect(list.locator('[data-pulls-row]').first()).toBeVisible();
  await expect(list.locator('[data-pulls-heading]')).toHaveText('PRs');
  const trigger = list.locator(TRIGGER);
  await expect(trigger).toHaveAccessibleName('5 on you. Filter');
  await expect(list.locator('[data-pulls-on-you]')).toHaveText('5 on you');
  fits(await head(page), false);
  await page.mouse.move(1438, 898);
  await snap(page, '1440-rest', 'light');
  await snap(page, '1440-dark', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await rows(page)).toHaveLength(14);

  // The count's tooltip says what "on you" means.
  await list.locator('[data-pulls-on-you]').hover();
  await expect(page.getByText(TIP)).toBeVisible();
  await page.mouse.move(1438, 898);
  await expect(page.getByText(TIP)).toHaveCount(0);

  await trigger.click();
  await expect(page.locator(MENU)).toBeVisible();
  expect(await menuRows(page, '[data-pulls-filter]')).toEqual(['All 14 ✓', 'Mine 4', 'To review 4', 'Others 6']);
  expect(await menuRows(page, '[data-pulls-filter-project-option]')).toEqual(['All projects 14 ✓', 'billing-svc 4', 'web-app 6', 'ledger 3', 'customer-billing-portal-v2 1']);
  await expect(page.locator(`${MENU} [data-pulls-filter-clear-item]`)).toHaveCount(0);
  await snap(page, '1440-menu', 'light');
  await page.keyboard.press('Escape');
  await expect(page.locator(MENU)).toHaveCount(0);

  await choose(page, 'web-app');
  await choose(page, 'To review');
  await expect(list.locator('[data-pulls-on-you]')).toHaveText('2 on you');
  await expect(trigger).toHaveAccessibleName('2 on you. Filter: To review, web-app');
  expect(await rows(page)).toEqual(['github.com/northwind/web-app#880', 'github.com/northwind/web-app#891']);
  await expect(list.locator('[data-pulls-row="github.com/northwind/web-app#891"]')).toContainText('assigned to you');
  const both = await head(page);
  fits(both, false);
  expect(both.shown_words).toEqual(['To review', 'web-app']);
  await page.mouse.move(1438, 898);
  await snap(page, '1440-both', 'light');

  // The address keeps both: a reload draws the same list.
  expect(await page.evaluate(() => location.hash)).toMatch(/^#pulls&project=prj_[^&]+&view=review$/);
  await page.reload();
  await expect(list.locator('[data-pulls-row]').first()).toBeVisible();
  await expect(trigger).toHaveAccessibleName('2 on you. Filter: To review, web-app');
  expect(await rows(page)).toHaveLength(2);

  // × clears both in one step.
  await list.locator('[data-pulls-filter-clear]').click();
  await expect(trigger).toHaveAccessibleName('5 on you. Filter');
  expect(await page.evaluate(() => location.hash)).toBe('#pulls');
  expect(await rows(page)).toHaveLength(14);
  expect(world.errors).toEqual([]);
});

test('390 (a phone): the sheet titled Filter; both picked, the view keeps its icon and the project its name', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light', deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${world.url}#pulls`);
    await expect(page.locator('[data-pulls-row]').first()).toBeVisible();
    await expect(page.locator('[data-pulls-on-you]')).toHaveText('5 on you');
    fits(await head(page), true);
    await snap(page, '390-rest', 'light');

    await choose(page, 'web-app');
    await choose(page, 'To review');
    const both = await head(page);
    fits(both, true);
    expect(both.shown_words).toEqual(['web-app']);
    await page.locator(TRIGGER).click();
    const menu = page.locator(MENU);
    await expect(menu).toBeVisible();
    await expect(menu.locator('.ib-pm-title')).toHaveText('Filter');
    await expect(page.locator('.ib-pm-pos[data-phone]')).toBeVisible();
    for (const box of await menu.locator('[role="menuitemradio"], [role="menuitem"]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) {
      expect(box).toBeGreaterThanOrEqual(48);
    }
    await expect(menu.locator('[data-pulls-filter-clear-item]')).toBeVisible();
    await snap(page, '390-both-sheet', 'light');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('320: both picked, the picks keep their icons only; "on you" is never cut', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true, colorScheme: 'light', deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${world.url}#pulls`);
    await expect(page.locator('[data-pulls-row]').first()).toBeVisible();
    fits(await head(page), true);
    await choose(page, 'customer-billing-portal-v2');
    await choose(page, 'To review');
    await expect(page.locator('[data-pulls-on-you]')).toHaveText('1 on you');
    const both = await head(page);
    fits(both, true);
    expect(both.shown_words).toEqual([]);
    await expect(page.locator(TRIGGER)).toHaveAccessibleName('1 on you. Filter: To review, customer-billing-portal-v2');
    await snap(page, '320-both', 'light');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('the contact sheet', async ({ browser }) => {
  const img = (file: string, width: number) => `<img style="width:${width}px" src="data:image/png;base64,${readFileSync(join(proofDir, `${file}.png`)).toString('base64')}">`;
  const fig = (file: string, label: string, width: number) => `<figure><figcaption>${label}</figcaption>${img(file, width)}</figure>`;
  const context = await browser.newContext({ viewport: { width: 1640, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    await page.setContent(
      `<style>body{margin:0;padding:24px;background:#f4f4f5;font:500 14px system-ui;color:#3f3f46}h2{font:600 18px system-ui;color:#18181b;margin:0 0 12px}.row{display:flex;gap:16px;align-items:flex-start;margin-bottom:20px;flex-wrap:wrap}figure{margin:0}figcaption{margin:0 0 6px}img{display:block;border-radius:8px;box-shadow:0 0 0 1px #d4d4d8}</style>` +
        `<h2>PR list filter (take B, Joined)</h2>` +
        `<div class="row">${fig('1440-rest', '1440, rest', 790)}${fig('1440-both', '1440, To review + web-app', 790)}</div>` +
        `<div class="row">${fig('1440-menu', '1440, the menu', 790)}${fig('1440-dark', '1440, dark', 790)}</div>` +
        `<div class="row">${fig('390-rest', '390, rest', 260)}${fig('390-both-sheet', '390, both picked, the sheet', 260)}${fig('320-both', '320, both picked', 214)}</div>`,
    );
    await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
    await page.screenshot({ path: join(proofDir, 'sheet.png'), fullPage: true });
  } finally {
    await context.close();
  }
  expect(world.errors).toEqual([]);
});
