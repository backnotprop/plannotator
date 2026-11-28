/**
 * The Pull requests board's Close, hard to hit by mistake and easy to undo (approval "inbox-pr-board-close-safe"),
 * in a real browser against the compiled binary under a temp PLANNOTATOR_DATA_DIR and HOME. The board's list and the
 * close and reopen routes are answered by the spec (made-up repositories and PRs), so no forge is reached; `gh` and
 * `glab` are fakes first on PATH that answer nothing, so the real CLIs never run.
 *
 * What only a browser shows:
 *  1. One PR picked (a contributor's, which can't merge): the field stays in its place, the actions at the right in
 *     one row, Close last and outside the field's box, Done where it was before the pick, Merge's note under the bar.
 *  2. An own PR picked, Merge shown: Close at the same place.
 *  3. Close: the toast names the PR ("Closed #2039" and its title); the Undo line under the bar says the same.
 *  4. Two minutes later the toast is gone and the line stays; at five minutes its Undo goes, and its words once the
 *     pointer leaves the board, so the grid never moves under the pointer (nor when Merge's note comes and goes, 1-2).
 *  5. Three closed: "Closed 3: …"; the line's Undo reopens exactly those three.
 *  6. The board as Reviews' right pane, three picked with Merge: still one row, Close outside the field.
 *  7. A phone: one row in the sheet, Close last, short of the right corner where Clear was; still so with Merge shown
 *     and on Merge's second tap (shot 09); two Undo lines, each Undo its own 44 px target (10). At 360 and 375 px,
 *     fourteen picked with Merge armed: one row, every word whole, nothing past the sheet's edge (11).
 *  8. Light theme of 1. Close in the warning colour in both, unlike the other actions.
 *
 * Shots land in PLANNOTATOR_E2E_PROOF_DIR/inbox-pr-board-close, `01-…png` to `11-…png`.
 */
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'inbox-pr-board-close');

const UPDATED = '2026-11-20T09:00:00.000Z';
type Fields = Record<string, unknown>;
function pull(repoName: string, number: number, title: string, fields: Fields = {}) {
  const fullRepo = `northwind/${repoName}`;
  return {
    key: `github.com/${fullRepo}#${number}`,
    platform: 'github',
    host: 'github.com',
    repo: fullRepo,
    number,
    url: `https://github.com/${fullRepo}/pull/${number}`,
    title,
    author: 'ada-novak',
    mine: false,
    requested: true,
    state: 'open',
    base: 'main',
    head: `b${number}`,
    head_repo: fullRepo,
    head_sha: String(number).padStart(40, 'a'),
    additions: 12,
    deletions: 3,
    files: 2,
    review: 'review_required',
    approved_by: null,
    reviewers: [],
    checks: 'success',
    conflicts: false,
    updated_at: UPDATED,
    merged_at: null,
    ...fields,
  };
}
const mine = { author: 'charlie-dunn', mine: true, requested: false, review: 'approved', approved_by: 'bob-tully', reviewers: ['bob-tully'] };
const PULLS = [
  pull('web-app', 2050, 'Show the plan name in the billing header', mine),
  pull('web-app', 2047, 'Cache the avatar sprites'),
  pull('web-app', 2041, 'Move the date picker to the shared kit'),
  pull('web-app', 2039, 'Retry sync when the token expires'),
  pull('web-app', 2033, 'Draft: a new empty state', { state: 'draft' }),
  pull('web-app', 2028, 'Speed up the search index', { checks: 'failure' }),
  pull('billing-svc', 409, 'Round refunds to the cent', mine),
  pull('billing-svc', 405, 'Log the retry count', { checks: 'pending' }),
  pull('mobile-app', 391, 'Bigger tap targets in settings'),
  pull('mobile-app', 388, 'Keep the draft when the app sleeps', { checks: 'pending' }),
  pull('mobile-app', 384, 'Fix the crash on rotate', { checks: 'failure' }),
  // Enough for two-digit counts on a phone: with web-app's six, fourteen picked.
  pull('docs-site', 77, 'Explain the retry settings', mine),
  ...[76, 75, 74, 73, 72, 71, 70].map((n) => pull('docs-site', n, `Docs fix ${n}`)),
];
const ANSWER = {
  fetched_at: UPDATED,
  hosts: [{ cli: 'gh', host: 'github.com', login: 'charlie-dunn' }],
  pulls: PULLS,
  links: {},
  projects: { 'github.com/northwind/web-app': ['prj_web'], 'github.com/northwind/billing-svc': ['prj_billing'], 'github.com/northwind/mobile-app': ['prj_mobile'], 'github.com/northwind/docs-site': ['prj_docs'] },
  cards: {},
  clis: { gh: 'signed_in' },
  unsigned: [],
};
const key = (repoName: string, n: number) => `github.com/northwind/${repoName}#${n}`;

let url = '';
/** The close and reopen presses the window sent, in order: "close <key>". */
let presses: string[] = [];

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-pr-board-close-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  // gh and glab that answer nothing, first on PATH: the runner's real gh never runs.
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const cli of ['gh', 'glab']) {
    writeFileSync(join(bin, cli), '#!/bin/sh\necho "not signed in" >&2\nexit 1\n');
    chmodSync(join(bin, cli), 0o755);
  }
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: root,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
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
  url = started.stdout.trim();
});

test.afterAll(async () => {
  await removeInboxScratch();
});

/** A window whose board reads the made-up list, and whose Close and Undo are answered here. */
async function open(browser: Browser, options: { width: number; height: number; scheme: 'light' | 'dark'; phone?: boolean; hash: string }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    colorScheme: options.scheme,
    reducedMotion: 'reduce',
    ...(options.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  const page = await context.newPage();
  const settings = await page.request.post(`${url}api/inbox/settings`, { data: { code_review: { on: true } } });
  expect(settings.status()).toBe(200);
  await page.route((u) => u.pathname === '/api/inbox/pulls', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: ANSWER }) : route.continue()));
  await page.route(
    (u) => /^\/api\/inbox\/pulls\/(close|reopen)$/.test(u.pathname),
    async (route) => {
      const act = new URL(route.request().url()).pathname.endsWith('/close') ? 'close' : 'reopen';
      const { key: pressed } = route.request().postDataJSON() as { key: string };
      presses.push(`${act} ${pressed}`);
      await route.fulfill({ json: { ok: true, key: pressed, url: '' } });
    },
  );
  await page.clock.install();
  await page.goto(`${url}${options.hash}`);
  await expect(page.locator('[data-prs-page] [data-pr-tile]').first()).toBeVisible({ timeout: 30_000 });
  return { context, page };
}

const box = async (locator: Locator) => (await locator.boundingBox())!;
async function shot(page: Page, name: string) {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(proofDir, name) });
}

/** The bar's buttons are one row; Close is the last action, right of the field and clear of its box. */
async function expectOneRow(page: Page) {
  const bar = page.locator('[data-prs-page] .ib-prs-bar');
  const field = await box(bar.locator('.ib-prs-field'));
  const buttons = bar.locator('button.ib-prs-btn');
  const tops = new Set<number>();
  for (const b of await buttons.all()) tops.add(Math.round((await box(b)).y));
  expect([...tops], 'every button of the bar on one row').toHaveLength(1);
  const close = await box(bar.locator('[data-pr-close]'));
  expect(close.x, 'Close right of the field, outside its box').toBeGreaterThanOrEqual(field.x + field.width);
  expect(await bar.locator('.ib-prs-acts > :last-child').getAttribute('data-pr-close')).toBe('');
  const barBox = await box(bar);
  expect(close.x + close.width).toBeLessThanOrEqual(barBox.x + barBox.width);
}

test('desktop: one PR picked, then an own one; Close, its toast, the Undo line two minutes on and gone at five; three closed and undone', async ({ browser }) => {
  presses = [];
  const { context, page } = await open(browser, { width: 1440, height: 900, scheme: 'dark', hash: '#prs' });
  try {
    const board = page.locator('[data-prs-page]');
    const field = board.locator('.ib-prs-field');
    await board.locator('[data-pr-select="select"]').click();
    const doneBefore = await box(board.locator('[data-pr-select="done"]'));
    const fieldBefore = await box(field);

    // 1. A contributor's PR, which can't merge yet.
    await board.locator(`[data-pr-tile="${key('web-app', 2039)}"]`).click();
    await expect(board.locator('[data-pr-picked]')).toHaveText('1 selected');
    await expect(board.locator('[data-pr-merge]')).toHaveCount(0);
    await expect(board.locator('[data-pr-view]')).toHaveCount(0);
    expect(await box(field)).toEqual(fieldBefore);
    expect(await box(board.locator('[data-pr-select="done"]'))).toEqual(doneBefore);
    await expectOneRow(page);
    await expect(board.locator('.ib-prs-under [data-pr-merge-hint]')).toHaveText('#2039 can’t merge now: it still needs a review.');
    const grid = board.locator('.ib-prs-body');
    const gridTop = (await box(grid)).y;
    // Close in the warning colour, unlike Hide and Start review thread.
    const colorOf = (selector: string) => board.locator(selector).evaluate((el) => getComputedStyle(el).color);
    const closeColor = await colorOf('[data-pr-close]');
    expect(closeColor).not.toBe(await colorOf('[data-pr-hide]'));
    expect(closeColor).not.toBe(await colorOf('[data-pr-review]'));
    const closeAt = await box(board.locator('[data-pr-close]'));
    await shot(page, '01-contributor-picked-dark.png');
    await page.emulateMedia({ colorScheme: 'light' });
    expect(await colorOf('[data-pr-close]')).not.toBe(await colorOf('[data-pr-hide]'));
    await shot(page, '08-contributor-picked-light.png');
    await page.emulateMedia({ colorScheme: 'dark' });

    // 2. An own PR, which can merge: Merge shows, Close is where it was.
    await board.locator(`[data-pr-tile="${key('web-app', 2039)}"]`).click();
    await board.locator(`[data-pr-tile="${key('web-app', 2050)}"]`).click();
    await expect(board.locator('[data-pr-merge]')).toHaveText('Merge 1');
    await expectOneRow(page);
    expect(await box(board.locator('[data-pr-close]'))).toEqual(closeAt);
    // Merge's note went with the pick that needed it: nothing below the bar moved.
    await expect(board.locator('[data-pr-merge-hint]')).toHaveCount(0);
    expect((await box(grid)).y, 'the grid stays put as the note comes and goes').toBe(gridTop);
    await shot(page, '02-own-picked-merge-dark.png');

    // 3. Close #2039: the toast names it, the line under the bar says it with Undo.
    await board.locator(`[data-pr-tile="${key('web-app', 2050)}"]`).click();
    await board.locator(`[data-pr-tile="${key('web-app', 2039)}"]`).click();
    await board.locator('[data-pr-close]').click();
    const toast = page.locator('.ib-toast');
    await expect(toast).toContainText('Closed #2039');
    await expect(toast).toContainText('Retry sync when the token expires');
    const lines = board.locator('[data-pr-closed-line]');
    await expect(lines).toHaveCount(1);
    await expect(lines.first()).toHaveText('Closed #2039 Retry sync when the token expires.Undo');
    expect(presses).toEqual([`close ${key('web-app', 2039)}`]);
    await shot(page, '03-closed-toast-dark.png');

    // 4. Two minutes on: the toast is gone, the line stays.
    await page.clock.fastForward('02:00');
    await expect(toast).toHaveCount(0);
    await expect(lines).toHaveCount(1);
    await shot(page, '04-undo-line-two-minutes-dark.png');
    // Past five minutes from the close, the pointer on a tile: Undo goes at once, the words stay so nothing moves under
    // the pointer; they go once it leaves the board.
    await board.locator(`[data-pr-tile="${key('web-app', 2047)}"]`).hover();
    const gridAtEnd = (await box(grid)).y;
    await page.clock.fastForward('03:01');
    await expect(lines.first().locator('[data-pr-closed-undo]')).toHaveCount(0);
    await expect(lines).toHaveCount(1);
    expect((await box(grid)).y, 'nothing moves under the pointer at the end of the window').toBe(gridAtEnd);
    await board.dispatchEvent('pointerleave');
    await expect(lines).toHaveCount(0);

    // 5. Three closed: one line; its Undo reopens exactly those three.
    for (const n of [2050, 2041, 2047]) await board.locator(`[data-pr-tile="${key('web-app', n)}"]`).click();
    await board.locator('[data-pr-close]').click();
    await expect(lines).toHaveCount(1);
    await expect(lines.first()).toContainText('Closed 3:');
    await expect(toast).toContainText('Closed 3');
    await shot(page, '05-closed-three-dark.png');
    presses = [];
    await lines.first().locator('[data-pr-closed-undo]').focus();
    await page.keyboard.press('Enter');
    // The line goes at the press; the three reopens follow one at a time, and the toast says when all went.
    await expect(lines).toHaveCount(0);
    await expect(toast).toContainText('Reopened 3');
    expect(presses.map((p) => p.split(' ')[0])).toEqual(['reopen', 'reopen', 'reopen']);
    expect(presses.map((p) => p.split(' ')[1]).sort()).toEqual([key('web-app', 2041), key('web-app', 2047), key('web-app', 2050)].sort());
  } finally {
    await context.close();
  }
});

test("the board as Reviews' right pane: three picked with Merge, one row, Close outside the field", async ({ browser }) => {
  const { context, page } = await open(browser, { width: 1280, height: 860, scheme: 'dark', hash: '#reviews' });
  try {
    const board = page.locator('[data-prs-page]');
    await board.locator('[data-pr-select="select"]').click();
    for (const [r, n] of [['web-app', 2050], ['web-app', 2041], ['billing-svc', 409]] as const) await board.locator(`[data-pr-tile="${key(r, n)}"]`).click();
    await expect(board.locator('[data-pr-merge]')).toHaveText('Merge 2');
    const barWidth = (await box(board.locator('.ib-prs-bar'))).width;
    expect(barWidth, 'the pane is narrow, as beside Reviews').toBeLessThan(900);
    await expectOneRow(page);
    await shot(page, '06-narrow-pane-dark.png');
  } finally {
    await context.close();
  }
});

test('a phone: one row in the sheet, Close last and short of the corner where Clear was', async ({ browser }) => {
  const { context, page } = await open(browser, { width: 390, height: 844, scheme: 'light', phone: true, hash: '#prs' });
  try {
    const board = page.locator('[data-prs-page]');
    await board.locator('[data-pr-select="select"]').click();
    await board.locator(`[data-pr-tile="${key('web-app', 2039)}"]`).click();
    const sheet = page.locator('.ib-prs-picksheet');
    await expect(sheet.locator('[data-pr-picked]')).toHaveText('1 selected');
    const buttons = sheet.locator('.ib-prs-pickrow > button');
    const tops = new Set<number>();
    for (const b of await buttons.all()) tops.add(Math.round((await box(b)).y));
    expect([...tops]).toHaveLength(1);
    expect(await sheet.locator('.ib-prs-pickrow > :last-child').getAttribute('data-pr-close')).toBe('');
    const close = await box(sheet.locator('[data-pr-close]'));
    expect(close.x + close.width, 'Close ends well short of the right corner').toBeLessThan(390 - 80);
    await expect(sheet.locator('[data-pr-select], [data-pr-clear]')).toHaveCount(0);
    await shot(page, '07-phone-sheet-light.png');

    // An own PR too: Merge shows, and on its first tap asks again; the row stays one row inside the sheet, Close last
    // and still clear of the corner.
    await board.locator(`[data-pr-tile="${key('web-app', 2050)}"]`).click();
    await expect(sheet.locator('[data-pr-merge]')).toHaveText('Merge 1');
    const oneRowClearOfCorner = async (what: string) => {
      const tops = new Set<number>();
      for (const b of await buttons.all()) tops.add(Math.round((await box(b)).y));
      expect([...tops], `${what}: one row`).toHaveLength(1);
      expect(await sheet.locator('.ib-prs-pickrow > :last-child').getAttribute('data-pr-close'), `${what}: Close last`).toBe('');
      const end = await box(sheet.locator('[data-pr-close]'));
      expect(end.x + end.width, `${what}: Close short of the corner`).toBeLessThanOrEqual(390 - 36);
      expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth), `${what}: nothing past the sheet's edge`).toBe(true);
    };
    await oneRowClearOfCorner('Merge shown');
    await sheet.locator('[data-pr-merge]').click();
    await expect(sheet.locator('[data-pr-merge="confirm"]')).toBeVisible();
    await oneRowClearOfCorner("Merge's second tap");
    await shot(page, '09-phone-sheet-merge-confirm-light.png');

    // Two Closes, two lines: on a finger each Undo is its own 44 px target, and the two never overlap.
    await page.keyboard.press('Escape');
    await board.locator(`[data-pr-tile="${key('web-app', 2050)}"]`).click();
    await sheet.locator('[data-pr-close]').click();
    await expect(page.locator('[data-pr-closed-line]')).toHaveCount(1);
    await board.locator(`[data-pr-tile="${key('web-app', 2041)}"]`).click();
    await sheet.locator('[data-pr-close]').click();
    const undos = page.locator('[data-pr-closed-undo]');
    await expect(undos).toHaveCount(2);
    const [first, second] = [await box(undos.nth(0)), await box(undos.nth(1))];
    for (const b of [first, second]) expect(b.height, 'an Undo a finger can hit').toBeGreaterThanOrEqual(44);
    expect(second.y, 'the second Undo starts where the first ends, or below').toBeGreaterThanOrEqual(first.y + first.height);
    await shot(page, '10-phone-two-undo-lines-light.png');
  } finally {
    await context.close();
  }
});

for (const width of [360, 375]) {
  test(`a ${width} px phone: fourteen picked, Merge armed, one row inside the sheet, every word whole`, async ({ browser }) => {
    const { context, page } = await open(browser, { width, height: 780, scheme: 'dark', phone: true, hash: '#prs' });
    try {
      const board = page.locator('[data-prs-page]');
      await board.locator('[data-pr-select="select"]').click();
      // Each repository's own box (dispatched: the second may sit under the sheet the first brought up).
      for (const repoName of ['web-app', 'docs-site']) await board.getByRole('checkbox', { name: `Select all in ${repoName}` }).dispatchEvent('click');
      const sheet = page.locator('.ib-prs-picksheet');
      await expect(sheet.locator('[data-pr-picked]')).toHaveText('14 selected');
      await expect(sheet.locator('[data-pr-close]')).toHaveText('Close 14');
      await expect(sheet.locator('[data-pr-hide]')).toHaveText('Hide 14');
      await sheet.locator('[data-pr-merge]').click();
      await expect(sheet.locator('[data-pr-merge="confirm"]')).toHaveText('Confirm');
      const buttons = sheet.locator('.ib-prs-pickrow > button');
      const tops = new Set<number>();
      for (const b of await buttons.all()) {
        tops.add(Math.round((await box(b)).y));
        expect(await b.evaluate((el) => el.scrollWidth <= el.clientWidth), 'its words whole').toBe(true);
      }
      expect([...tops], 'one row').toHaveLength(1);
      expect(await sheet.locator('.ib-prs-pickrow > :last-child').getAttribute('data-pr-close')).toBe('');
      const close = await box(sheet.locator('[data-pr-close]'));
      expect(close.x + close.width, 'Close inside the sheet').toBeLessThanOrEqual(width - 12);
      expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth), "nothing past the sheet's edge").toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll').toBe(true);
      await shot(page, `11-phone-${width}-fourteen-confirm-dark.png`);
    } finally {
      await context.close();
    }
  });
}
