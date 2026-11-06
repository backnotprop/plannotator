/**
 * The List view's one-time choice, Smart groups or Simple list (approval "inbox-list-view", the owner's ask, 2026-11-05) in Chromium against
 * a release build of the binary: a dev or test build never shows it (reveal.ts `releaseVersion`), so this spec runs
 * only with PLANNOTATOR_E2E_RELEASE_BINARY naming one, built with the root package.json's version (a newer one puts
 * the page's "Inbox updated" line in the pictures), for example:
 *
 *   bun build apps/hook/server/index.ts --compile --no-compile-autoload-bunfig \
 *     --define '__CLI_VERSION__="0.28.50"' --outfile .local/plannotator-release
 *
 * A grouped list of six threads, a page a minute old, a thread opened, read and left: the dialog opens over the list
 * (1440 px and a 390 px phone, light and dark); "Use Simple list" switches the list at once and is remembered; "Use Smart groups"
 * keeps the groups; neither browser sees it again. HOME and the data dir are temp folders. PNGs land in
 * PLANNOTATOR_LIST_VIEW_SHOTS; with PLANNOTATOR_LIST_VIEW_VIDEO set, the desktop page is recorded (list-view-intro.webm).
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEMO_MESSAGES, SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = process.env.PLANNOTATOR_E2E_RELEASE_BINARY ? resolve(process.env.PLANNOTATOR_E2E_RELEASE_BINARY) : null;
const shots = resolve(process.env.PLANNOTATOR_LIST_VIEW_SHOTS ?? join(repo, '.local/proof/list-view'));

test.describe.configure({ mode: 'serial' });
test.skip(!binary, 'set PLANNOTATOR_E2E_RELEASE_BINARY to a release build');

let url = '';
let first = '';
let second = '';

test.beforeAll(async () => {
  expect(existsSync(binary!), `build the release binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-list-view-intro-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    NO_ANON_PING: '1',
  };
  const started = spawnSync(binary!, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  url = started.stdout.trim().replace(/\/$/, '');
  expect(new URL(url).port).not.toBe('59812');
  const src = join(root, 'src');
  const billing = scratchProject(src, 'billing-svc');
  const docs = scratchProject(src, 'docs-site');
  const claude = await SimAgent.connect({ binary: binary!, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary: binary!, env, name: 'Codex', host: 'codex' });
  const send = (agent: SimAgent, project: string, subject: string, body: string) => agent.send({ project_path: project, thread: subject, subject, body });
  first = String((await send(claude, billing, 'Nightly build is green', 'All 412 tests pass on main.')).thread_id);
  await send(codex, docs, 'Install page: detect agents?', DEMO_MESSAGES.holding);
  await send(claude, billing, 'Refund events: webhook or polling?', DEMO_MESSAGES.named);
  await send(codex, docs, 'Broken links sweep done', DEMO_MESSAGES.news);
  await send(claude, billing, 'Webhook retries tuned', 'Webhook retries back off up to an hour now.');
  second = String((await send(codex, docs, 'Search index rebuilt', 'The search index is rebuilt with the new pages.')).thread_id);
  await claude.close();
  await codex.close();
});

test.afterAll(async () => {
  await removeInboxScratch();
});

const dialog = (page: Page) => page.locator('dialog[data-dialog="list-view-intro"]');

/** Headless Chromium's "blocks notifications" line: hidden first, as a person would. */
async function settled(page: Page): Promise<void> {
  await expect(page.locator('.ib-listcol .ib-lbody [data-thread-id]').first()).toBeVisible();
  const hide = page.locator('.ib-listcol').getByRole('button', { name: 'Hide', exact: true });
  await hide.waitFor({ timeout: 5000 }).catch(() => {});
  if (await hide.count()) await hide.click();
}

/** Read a thread for six seconds, then back to the list. */
async function readAndLeave(page: Page, phone: boolean, id = first): Promise<void> {
  const row = page.locator(`.ib-listcol .ib-lbody [data-thread-id="${id}"]`);
  await (phone ? row.tap({ timeout: 10_000 }) : row.click({ timeout: 10_000 }));
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await page.waitForTimeout(6000);
  if (phone) await page.locator('[data-phone-back]').first().tap({ timeout: 10_000 });
  else await page.keyboard.press('Escape');
  await expect(page.locator('section.ib-pane')).toHaveCount(0);
}

async function both(page: Page, name: string): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, `${name}-${colorScheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('a minute in, back on the grouped list after reading a thread: the choice, once; Use Simple list on a desktop, Use Smart groups on a phone', async ({ browser }: { browser: Browser }) => {
  test.setTimeout(420_000);
  const video = process.env.PLANNOTATOR_LIST_VIEW_VIDEO ? { dir: join(shots, 'video'), size: { width: 1280, height: 800 } } : undefined;
  const desk = await browser.newContext({ viewport: video ? { width: 1280, height: 800 } : { width: 1440, height: 900 }, colorScheme: 'light', recordVideo: video });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' });
  const page = await desk.newPage();
  const phone = await phoneContext.newPage();
  try {
    await page.goto(`${url}/`);
    await phone.goto(`${url}/`);
    await settled(page);
    await settled(phone);
    // Grouped, as every browser starts.
    await expect(page.locator('.ib-listcol .ib-lbody [data-section-id="waiting"]')).toBeVisible();
    // Never at load: a minute passes with nothing.
    await page.waitForTimeout(61_000);
    await expect(dialog(page)).toHaveCount(0);
    await expect(dialog(phone)).toHaveCount(0);
    // Desktop: read a thread, back to the list.
    await readAndLeave(page, false);
    await expect(dialog(page)).toBeVisible({ timeout: 10_000 });
    await expect(dialog(page)).toHaveAccessibleName('Smart groups or a simple list?');
    // Focus on the question; Smart groups is marked In use (the list is grouped) and its button is the primary one.
    await expect(dialog(page).locator('#ib-lvc-title')).toBeFocused();
    await expect(dialog(page).locator('[data-list-view-in-use]')).toHaveCount(1);
    await expect(dialog(page).locator('.ib-lvc-col').first().locator('[data-list-view-in-use]')).toHaveText('In use');
    await expect(dialog(page).locator('[data-list-view-choice="smart"]')).toHaveClass(/ib-pri/);
    await page.waitForTimeout(2600);
    if (!video) await both(page, 'intro-1440');
    // Phone: the same moment.
    await readAndLeave(phone, true);
    await expect(dialog(phone)).toBeVisible({ timeout: 10_000 });
    for (const button of ['[data-list-view-choice="smart"]', '[data-list-view-choice="simple"]']) {
      await expect(dialog(phone).locator(button)).toBeInViewport({ ratio: 1 });
      expect((await dialog(phone).locator(button).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await phone.waitForTimeout(2600);
    await both(phone, 'intro-390');
    // Use Simple list: the list is List at once, remembered as the ⋮ menu's choice.
    await page.locator('[data-list-view-choice="simple"]').click({ timeout: 10_000 });
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('.ib-listcol .ib-lbody [data-flat-list]')).toBeVisible();
    await expect(page.locator('.ib-listcol .ib-lbody [data-section-id="waiting"]')).toHaveCount(0);
    expect((await desk.cookies()).find((c) => c.name === 'plannotator-inbox-list-view')?.value).toBe('list');
    expect((await desk.cookies()).some((c) => c.name === 'plannotator-inbox-list-view-intro')).toBe(true);
    await page.mouse.move(1200, 780);
    await page.waitForTimeout(800);
    if (!video) await both(page, 'list-after-choosing');
    // Use Smart groups: the groups stay, and the choice is not written.
    await phone.locator('[data-list-view-choice="smart"]').tap({ timeout: 10_000 });
    await expect(dialog(phone)).toHaveCount(0);
    await expect(phone.locator('.ib-listcol .ib-lbody [data-section-id="waiting"]')).toBeVisible();
    expect((await phoneContext.cookies()).some((c) => c.name === 'plannotator-inbox-list-view')).toBe(false);
    // Once: a reload and the same moment again show nothing.
    await phone.reload();
    await settled(phone);
    await phone.waitForTimeout(61_000);
    await readAndLeave(phone, true, second); // the first thread is read now, folded into Quiet
    await phone.waitForTimeout(5000);
    await expect(dialog(phone)).toHaveCount(0);
  } finally {
    const recording = page.video();
    await desk.close();
    await phoneContext.close();
    if (recording) renameSync(await recording.path(), join(shots, 'list-view-intro.webm'));
  }
});
