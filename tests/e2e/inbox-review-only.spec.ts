/**
 * The Inbox for code review only (docs/agent-guides/inbox-review-only.md; the owner's mocks, rounds 1-3, 2026-11-23),
 * proved in a real Chromium against a compiled binary with a release version (0.30.0): the shared e2e binary is
 * 0.0.0-dev, which never decides a one-time dialog, and the welcome is one (`review_welcome`, first in the line), so
 * the spec compiles its own, as inbox-code-review-offer.spec.ts does. Each case is its own sandbox: a temp HOME and
 * PLANNOTATOR_DATA_DIR, agents' homes inside it, every other one-time dialog behind the person, a `gh` sh fake first
 * on PATH answering the pull request lists (projects harbor and fern-api, people Charlie Dunn and Bob Tully, all made
 * up; the real gh never runs).
 *
 *  1. A first run of `plannotator inbox --review` (the Inbox never on here: PLANNOTATOR_TEST_INBOX_ON=0): config.json
 *     says Code review and code review only before anything else; the window opens on Reviews with the welcome over
 *     it once its claim (the line's `review_welcome` stamp) is spent, named by its title, with the four lines and the
 *     switch row off. Start reviewing closes it; the sidebar has no Inbox, Board, Projects, Artifacts or New message; a
 *     reload shows no welcome. A thread that is not a review, waiting on the person: the Inbox row comes back.
 *     Settings → Capabilities: the Full Inbox row off on top, no Code review, Board or Checklist row. Switching it on:
 *     the full Inbox at once, with no confirmation, the row still there, and Board, Checklist and Code review back.
 *  2. A 390 px phone: the welcome as a sheet; its switch's hit area is 44 px or more; Escape closes it; the sidebar
 *     drawer with only what code review needs.
 *  3. Someone who already uses the Inbox: `--review` turns Code review on and opens Reviews; the full Inbox stays.
 *
 * Pictures (whole window): the welcome in light and dark and on a phone; Reviews while code review only (desktop, and
 * the phone's drawer); the Inbox row while something waits; Settings with the switch; Settings and the Inbox after
 * switching back. Build the apps first (bun run --cwd apps/review build && bun run build:hook), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-review-only.spec.ts`. PNGs land in
 * PLANNOTATOR_E2E_PROOF_DIR/review-only, or .local/proof/review-only/.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { E2E_LAUNCH_OFF, inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { savedConfig } from '../helpers/saved-config';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';

const repo = resolve(__dirname, '../..');
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'review-only');
const VERSION = '0.30.0';
const DAY = 24 * 3600_000;
const OWNER_INBOX_PORT = '59812';
const WELCOME = 'dialog[data-dialog="review-welcome"]';
/** Long enough for the page's settling wait and a claim, were anything to open. */
const QUIET_MS = 8_000;

let binary = '';
let scratch = '';
const contexts: BrowserContext[] = [];

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
function pull(repoName: string, number: number, fields: Record<string, unknown>) {
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
    author: { login: 'charlie-dunn' },
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    ...fields,
  };
}
const HARBOR = 'harbor-labs/harbor';
const FERN = 'harbor-labs/fern-api';
const asked = { reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'charlie-dunn' } }] } };
const MINE = [
  pull(HARBOR, 214, { title: 'Retry dock bookings when the berth API times out', headRefName: 'charlie/berth-retry', updatedAt: ago(12), additions: 86, deletions: 9 }),
  pull(FERN, 58, { title: 'Paginate the fern list endpoint', headRefName: 'charlie/fern-pages', reviewDecision: 'APPROVED', latestReviews: { nodes: [{ state: 'APPROVED', author: { login: 'bob-tully' } }] }, updatedAt: ago(70) }),
];
const REQUESTED = [
  pull(HARBOR, 219, { title: 'Tide tables in the booking form', author: { login: 'bob-tully' }, headRefName: 'bob/tide-tables', updatedAt: ago(6), ...asked }),
  pull(FERN, 61, { title: 'Rate limits per API key', author: { login: 'bob-tully' }, headRefName: 'bob/rate-limits', isDraft: true, updatedAt: ago(45), ...asked }),
];
const GH_PULLS = {
  data: {
    viewer: { login: 'charlie-dunn' },
    rateLimit: { cost: 9, remaining: 4980, resetAt: ago(-40) },
    requested: { issueCount: REQUESTED.length, nodes: REQUESTED },
    assigned: { issueCount: 0, nodes: [] },
    authored: { issueCount: MINE.length, nodes: MINE },
    merged: { nodes: [] },
  },
};
const GH_OTHERS = { data: { viewer: { login: 'charlie-dunn' }, rateLimit: { cost: 3, remaining: 4977, resetAt: ago(-40) }, others0: { issueCount: 4, nodes: [...MINE, ...REQUESTED] } } };

/** The fake gh: the person's lists and Others; anything else fails. */
function writeGh(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'gh-pulls.json'), JSON.stringify(GH_PULLS));
  writeFileSync(join(dir, 'gh-others.json'), JSON.stringify(GH_OTHERS));
  const gh = [
    '#!/bin/sh',
    `dir='${dir}'`,
    'if [ "$1" = auth ] && [ "$2" = status ]; then',
    '  echo \'{"hosts":{"github.com":[{"login":"charlie-dunn","active":true,"state":"success","tokenSource":"keyring"}]}}\'',
    '  exit 0',
    'fi',
    'if [ "$1" = api ] && [ "$2" = graphql ]; then',
    '  case "$*" in *"query InboxPullsOthers"*) cat "$dir/gh-others.json"; exit 0;; esac',
    '  case "$*" in *"requested: search"*) cat "$dir/gh-pulls.json"; exit 0;; esac',
    '  echo \'{"data":null}\'; exit 1',
    'fi',
    'exit 1',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'gh'), gh);
  chmodSync(join(dir, 'gh'), 0o755);
}

function compileReleaseBinary(): string {
  const out = join(scratch, 'bin', 'plannotator');
  const built = spawnSync(
    'bun',
    ['build', 'apps/hook/server/index.ts', '--compile', '--no-compile-autoload-bunfig', '--define', `__CLI_VERSION__="${VERSION}"`, '--outfile', out],
    { cwd: repo, encoding: 'utf8', timeout: 180_000 },
  );
  expect(built.status, built.stderr).toBe(0);
  return out;
}

interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  run: (...args: string[]) => { status: number | null; stdout: string; stderr: string };
}

/**
 * A sandbox with every other one-time dialog behind the person (the last one 2.5 days ago, so the line's gap holds
 * nothing back), so the welcome is what the line has next. `firstRun`: the Inbox was never turned on here (else a test
 * run's data dir counts as on).
 */
function world(firstRun: boolean): World {
  const root = realpathSync(mkdtempSync(join(scratch, 'world-')));
  const dataDir = join(root, 'data');
  for (const dir of [dataDir, join(root, 'src'), join(root, 'claude'), join(root, 'codex'), join(root, 'xdg-config'), join(root, 'xdg-data')]) mkdirSync(dir, { recursive: true });
  const past = '2026-10-01T10:00:00.000Z';
  const lastShown = new Date(Date.now() - 2.5 * DAY).toISOString();
  writeFileSync(join(dataDir, 'update-state.json'), JSON.stringify({ inboxVersion: VERSION }));
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({
      ...E2E_LAUNCH_OFF,
      inboxTour: { version: 2, seen_at: past, skipped_at: past },
      inboxNotifications: { dismissed: true },
      inboxAgentNotes: { offered: true, asked: ['claude-code', 'codex', 'opencode', 'pi', 'gemini', 'qwen', 'cursor'] },
      inboxSound: { dialogShownFor: VERSION },
      inboxListIntro: { shownAt: past, version: 2 },
      inboxVoiceIntro: { shownAt: past },
      favicon: 'glass',
      inboxSnoozeIntro: { shownAt: lastShown },
      inboxPriorityIntro: { usedAt: lastShown },
      inboxReveals: { ...E2E_LAUNCH_OFF.inboxReveals, lastShownAt: lastShown, view_choice: { shownAt: past }, star: { shownAt: past }, sidebar_tip: { shownAt: past } },
    }),
  );
  const forge = join(root, 'forge');
  writeGh(forge);
  const env: Record<string, string> = {
    PATH: `${forge}:${process.env.PATH ?? ''}`,
    HOME: root,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_DATA_DIR: dataDir,
    // A release version: never the live daily ping (packages/shared/daily-ping.ts).
    NO_ANON_PING: '1',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_TEST_SANDBOX: root,
    ...(firstRun ? { PLANNOTATOR_TEST_INBOX_ON: '0' } : {}),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
  };
  const run = (...args: string[]) => {
    const r = spawnSync(binary, args, { env, encoding: 'utf8', timeout: 60_000 });
    rememberInboxOf(dataDir);
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { root, dataDir, env, run };
}

async function context(browser: Browser, phone = false): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });
  contexts.push(ctx);
  return ctx;
}

/** "Inbox updated to 0.30.0": this spec's release binary carries apps built as dev. Not this feature's; hidden, never clicked. */
async function hideStaleNotice(page: Page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-stale-page]')) el.style.display = 'none';
  });
}

async function shots(page: Page, name: string, schemes: readonly ('light' | 'dark')[] = ['light']) {
  await hideStaleNotice(page);
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(proofDir, `${name.replace('{s}', scheme)}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** A sidebar row as the person sees it (Settings draws a second sidebar copy, out of sight). */
const item = (page: Page, id: string) => page.locator(`[data-sidebar-item="${id}"]`).filter({ visible: true });
/** The sidebar's Projects section (a section, not a row: it has no `data-sidebar-item`), as the person sees it. */
const projects = (page: Page) => page.locator('[data-sheet-section="projects"]').filter({ visible: true });
/** The line's stamp for the welcome: its claim spent (packages/shared/inbox/reveals.ts `review_welcome`). */
const welcomeStamp = (dataDir: string) => (savedConfig(dataDir).inboxReveals as Record<string, { shownAt?: string } | undefined> | undefined)?.review_welcome?.shownAt ?? null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  expect(existsSync(join(repo, 'apps/hook/dist/inbox.html')), 'build the apps first (bun run --cwd apps/review build && bun run build:hook)').toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  scratch = inboxScratch('plannotator-inbox-review-only-');
  binary = compileReleaseBinary();
});

test.afterAll(async () => {
  try {
    for (const ctx of contexts) await ctx.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

test('a first run of --review: code review only, the welcome once over Reviews, the Inbox row while something waits, Settings with the switch, and switching back', async ({ browser }) => {
  test.setTimeout(300_000);
  const w = world(true);
  const ran = w.run('inbox', '--review');
  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.stderr).toContain('Code review is on.');
  const url = ran.stdout.trim();
  expect(url).toMatch(/#reviews$/);
  expect(new URL(url).port).not.toBe(OWNER_INBOX_PORT);
  expect(savedConfig(w.dataDir)).toMatchObject({ inboxCodeReview: true, inboxReviewOnly: true, inboxReviewWelcome: { dueAt: expect.any(String) } });
  expect(welcomeStamp(w.dataDir)).toBeNull();

  const page = await (await context(browser)).newPage();
  await page.goto(url);
  const welcome = page.getByRole('dialog', { name: 'Welcome to the code review Inbox' });
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  // It opened through the line: its claim is spent.
  expect(welcomeStamp(w.dataDir)).not.toBeNull();
  await expect(page.locator(`${WELCOME} #ib-rwel-feats li`)).toHaveCount(4);
  await expect(welcome.getByRole('switch', { name: 'The full Plannotator Inbox' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await shots(page, 'welcome-desktop-{s}', ['light', 'dark']);

  await welcome.getByRole('button', { name: 'Start reviewing' }).click();
  await expect(page.locator(WELCOME)).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe('#reviews');
  await expect(item(page, 'reviews')).toBeVisible();
  for (const id of ['inbox', 'board', 'artifacts', 'new-message']) await expect(item(page, id)).toHaveCount(0);
  await expect(projects(page)).toHaveCount(0);
  // The person's pull requests are in (the Pull requests board draws them as tiles; the titles are in its Table view).
  await expect(page.locator('[data-prs-page] [data-pr-tile]')).toHaveCount(4, { timeout: 20_000 });
  await page.mouse.move(4, 4);
  await shots(page, 'reviews-review-only-{s}', ['light', 'dark']);

  // A reload: no welcome (its claim is spent), still Reviews.
  await page.reload();
  await expect(item(page, 'reviews')).toBeVisible();
  await page.waitForTimeout(QUIET_MS);
  await expect(page.locator(WELCOME)).toHaveCount(0);

  // A thread that is not a review, waiting on the person (an agent connected before): the Inbox row shows while it waits.
  const agent = await SimAgent.connect({ binary, env: w.env, name: 'Claude Code', host: 'claude-code' });
  try {
    const project = scratchProject(join(w.root, 'src'), 'harbor');
    await agent.send({
      project_path: project,
      subject: 'Which berth timeout should the retry use?',
      thread: 'berth',
      body: ['Before I open the PR:', '', ':::question', 'Which berth timeout should the retry use?', '', '- [ ] 5 seconds', '- [ ] 15 seconds', ':::'].join('\n'),
    });
  } finally {
    await agent.close();
  }
  await expect(item(page, 'inbox')).toBeVisible({ timeout: 20_000 });
  await page.mouse.move(4, 4);
  await shots(page, 'reviews-inbox-row-waits-{s}');

  // Settings → Capabilities: Full Inbox off on top; no Code review, Board or Checklist row.
  await page.goto(`${url.replace(/#.*$/, '')}#settings/capabilities`);
  const row = page.locator('[data-settings-full-inbox]');
  await expect(row).toBeVisible();
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  for (const sel of ['[data-settings-board]', '[data-settings-steps]', '[data-settings-code-review]']) await expect(page.locator(sel)).toHaveCount(0);
  await shots(page, 'settings-review-only-{s}', ['light', 'dark']);

  // Switching back: at once, no confirmation; the row stays under the click.
  await row.getByRole('switch').click();
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => savedConfig(w.dataDir).inboxReviewOnly).toBe(false);
  expect(savedConfig(w.dataDir).inboxCodeReview).toBe(true);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(row).toBeVisible();
  await expect(page.locator('[data-settings-board]')).toBeVisible();
  await expect(page.locator('[data-settings-steps]')).toBeVisible();
  await expect(page.locator('[data-settings-code-review]')).toBeVisible();
  await expect(item(page, 'inbox')).toBeVisible();
  await shots(page, 'settings-switched-back-{s}');
  await page.goto(url.replace(/#.*$/, ''));
  await expect(item(page, 'inbox')).toBeVisible();
  await expect(projects(page)).toBeVisible();
  await page.mouse.move(4, 4);
  await shots(page, 'inbox-switched-back-{s}', ['light', 'dark']);
});

test('a 390 px phone: the welcome as a sheet with a 44 px switch target; Escape closes it; the drawer has only what code review needs', async ({ browser }) => {
  test.setTimeout(240_000);
  const w = world(true);
  const ran = w.run('inbox', '--review');
  expect(ran.status, ran.stderr).toBe(0);
  const page = await (await context(browser, true)).newPage();
  await page.goto(ran.stdout.trim());
  const welcome = page.getByRole('dialog', { name: 'Welcome to the code review Inbox' });
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  const sw = welcome.getByRole('switch', { name: 'The full Plannotator Inbox' });
  await expect(sw).toBeVisible();
  // The track and its knob drawn together (the knob inside the track), and a hit area of 44 px or more around it.
  const drawn = await sw.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const knob = getComputedStyle(el, '::after');
    const hit = (x: number, y: number) => document.elementFromPoint(x, y) === el;
    return {
      width: box.width,
      height: box.height,
      knobFits: parseFloat(knob.height) + 2 * parseFloat(knob.top) <= box.height,
      tall: hit(box.left + box.width / 2, box.top + box.height / 2 - 22) && hit(box.left + box.width / 2, box.top + box.height / 2 + 21.5),
    };
  });
  expect({ knobFits: drawn.knobFits, tall: drawn.tall }).toEqual({ knobFits: true, tall: true });
  // The phone's switch, as Settings draws it on a phone (50 × 30), not the desktop's 34 × 20.
  expect(drawn.width).toBeGreaterThanOrEqual(48);
  expect(drawn.height).toBeGreaterThanOrEqual(28);
  await shots(page, 'welcome-phone-{s}', ['light', 'dark']);
  await page.keyboard.press('Escape');
  await expect(page.locator(WELCOME)).toHaveCount(0);
  expect(savedConfig(w.dataDir).inboxReviewOnly).toBe(true);

  // The sidebar drawer: Reviews, no Inbox, Board, Projects or Artifacts.
  await page.getByRole('button', { name: /^Toggle Sidebar/ }).first().click();
  await expect(item(page, 'reviews').first()).toBeVisible();
  for (const id of ['inbox', 'board', 'artifacts']) await expect(item(page, id)).toHaveCount(0);
  await expect(projects(page)).toHaveCount(0);
  await shots(page, 'reviews-phone-drawer-{s}');
});

test('someone who already uses the Inbox: --review turns Code review on and opens Reviews; the full Inbox stays', async ({ browser }) => {
  test.setTimeout(180_000);
  const w = world(false);
  const started = w.run('inbox', '--background');
  expect(started.status, started.stderr).toBe(0);
  const ran = w.run('inbox', '--review');
  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.stderr).toContain('Code review is on.');
  expect(savedConfig(w.dataDir).inboxCodeReview).toBe(true);
  expect(savedConfig(w.dataDir).inboxReviewOnly).toBeUndefined();
  const page = await (await context(browser)).newPage();
  await page.goto(ran.stdout.trim());
  await expect(item(page, 'reviews')).toBeVisible({ timeout: 20_000 });
  await expect(item(page, 'inbox')).toBeVisible();
  await page.waitForTimeout(QUIET_MS);
  await expect(page.locator(WELCOME)).toHaveCount(0);
});
