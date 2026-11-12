/**
 * Who is in a thread with two or more sessions (issue #3108), in a real browser against the compiled binary: the
 * header's line shows the sessions' marks and "N sessions", and a mouse resting on it, a tap or keyboard focus opens
 * it in place into each session's name and state.
 *
 * Nothing is mocked: the binary runs `plannotator inbox --background` under a temp PLANNOTATOR_DATA_DIR and HOME; the
 * threads are written through the Inbox's own /mcp and the live sessions poll its bridge with their titles, as the
 * Claude Code mod does (tests/helpers/inbox-session-names-world.ts).
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-thread-sessions.spec.ts`.
 */
import { expect, test, type Browser, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LONG_TITLE, seedSessionNamesWorld, type SessionNamesWorld } from '../helpers/inbox-session-names-world';
import { NO_BROWSER } from '../helpers/no-browser';
import { E2E_LAUNCH_OFF, inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(resolve(__dirname, '../..'), '.local/plannotator'));
let url = '';
let world: SessionNamesWorld | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('inbox-thread-sessions-');
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'config.json'), JSON.stringify(E2E_LAUNCH_OFF));
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: data, PLANNOTATOR_TEST_SANDBOX: root, PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_TAILSCALE: '0', PLANNOTATOR_INBOX_PHONES: '0', PLANNOTATOR_INBOX_NOTES: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(data);
  url = started.stdout.trim().replace(/\/$/, '');
  const { token } = JSON.parse(readFileSync(join(data, 'inbox', 'inbox.json'), 'utf8')) as { token: string };
  world = await seedSessionNamesWorld(url, token, join(root, 'projects'));
});

test.afterAll(async () => {
  try {
    await world?.stop();
  } finally {
    await removeInboxScratch();
  }
});

const line = (page: Page) => page.locator('section.ib-pane [data-thread-sessions]');
const names = (page: Page) => line(page).locator('.ib-ss-item');

async function open(page: Page, thread: string): Promise<void> {
  await page.goto(`${url}#thread=${thread}`);
  await expect(page.locator('section.ib-pane h2.ib-subject')).toBeVisible({ timeout: 30_000 });
}

test('three Claude Code sessions: one mark and "3 sessions"; resting the mouse on it names each one, with its state', async ({ page }) => {
  await open(page, world!.three);
  await expect(line(page)).toHaveAttribute('data-thread-sessions', '3');
  await expect(line(page).locator('.ib-ss-tog')).toHaveText('3 sessions');
  await expect(line(page).locator('[data-pile]')).toHaveAttribute('data-pile', '1');
  await expect(names(page)).toHaveCount(0);

  const box = (await line(page).locator('.ib-ss-tog').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(names(page)).toHaveText([/^Billing refactor\s*waiting on you$/, /^Retry worker\s*working$/, /^Ledger export\s*idle$/]);
  // The opened line stays on one line with the count and time beside it, inside the pane.
  const pane = (await page.locator('section.ib-pane').boundingBox())!;
  const opened = (await line(page).boundingBox())!;
  expect(opened.x + opened.width).toBeLessThanOrEqual(pane.x + pane.width);
  await page.mouse.move(5, 5);
  await expect(names(page)).toHaveCount(0);
});

test('the keyboard: focus on it opens it, Escape closes it and the thread stays open', async ({ page }) => {
  await open(page, world!.three);
  await line(page).locator('.ib-ss-tog').focus();
  await expect(names(page)).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(names(page)).toHaveCount(0);
  await expect(page.locator('section.ib-pane h2.ib-subject')).toBeVisible();
  await expect(line(page).locator('.ib-ss-tog')).toBeFocused();
});

test('six sessions of five agents: four marks at most, an ended session says so, a long title is cut and whole in its tooltip', async ({ page }) => {
  await open(page, world!.six);
  await expect(line(page)).toHaveAttribute('data-thread-sessions', '6');
  await expect(line(page).locator('[data-pile]')).toHaveAttribute('data-pile', '4');
  // A mouse resting on it opens it, and the opened band then lies over the button, so a click lands on the band
  // (its left padding here, not a name, which would filter the list) and keeps it open.
  await line(page).locator('.ib-ss-tog').hover();
  await expect(names(page)).toHaveCount(6);
  await line(page).locator('.ib-ss-band').click({ position: { x: 2, y: 14 } });
  await expect(names(page)).toHaveCount(6);
  await expect(names(page).filter({ hasText: 'Cursor' })).toHaveAttribute('data-state', 'ended');
  const long = names(page).first().locator('.ib-ss-nm');
  await expect(long).toHaveText(LONG_TITLE);
  expect(await long.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  // A click outside closes it.
  await page.locator('section.ib-pane h2.ib-subject').click();
  await expect(names(page)).toHaveCount(0);
});

test('one session: no line of sessions in the header', async ({ page }) => {
  await open(page, world!.one);
  await expect(page.locator('section.ib-pane [data-thread-meta]')).toBeVisible();
  await expect(line(page)).toHaveCount(0);
});

test('a phone: the first tap opens it, one session per line, and nothing runs off the screen', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await open(page, world!.six);
    await line(page).locator('.ib-ss-tog').tap();
    await expect(names(page)).toHaveCount(6);
    const tops = await names(page).locator('.ib-ss-txt').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(6);
    const right = await line(page).evaluate((el) => el.getBoundingClientRect().right);
    expect(right).toBeLessThanOrEqual(390);
    await line(page).locator('.ib-ss-tog').tap();
    await expect(names(page)).toHaveCount(0);
  } finally {
    await context.close();
  }
});
