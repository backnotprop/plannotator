/**
 * The stale page notice (packages/inbox/stalePage.ts), proved in WebKit: on 2026-11-02 the owner's iPhone Safari
 * restored a cached 0.28.44 page against a 0.28.45 Inbox, nothing noticed, and a bug 0.28.45 had fixed came back.
 *
 * The Inbox runs from source as this repo's release (tests/e2e/stale-page-inbox.ts), serving the built window. The
 * first page load is served as an older release served it: the build's one release literal (stalePage.ts
 * `pageBuild`, in the entry script) is rewritten to the release before. What is proved:
 * - a phone (390 x 844) shows "Inbox updated to X · Reload" at the list's top, and at the thread's top once a thread
 *   covers the list;
 * - Reload pressed inside the reply box's 500 ms pause saves the reply draft before the page goes (the save answered
 *   before the reload's request), and the Inbox's own page comes back with the words in the box and no notice;
 * - on a desktop the notice is at the list's top only (the list is beside the thread); its × hides it, focus goes to
 *   the list's first row, and the tab shown again (`visibilitychange`) asks the Inbox again but keeps that release
 *   hidden (a newer release showing again is proved in packages/inbox/stalePage.test.ts).
 *
 * PNGs (phone and desktop, light and dark) land in .local/proof/stale-page/, or in PLANNOTATOR_STALE_PAGE_SHOTS when
 * it names a folder. Runs in the playwright config's `webkit` project; needs the built apps (`bun run build:hook`).
 */

import { expect, test, devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const shots = resolve(process.env.PLANNOTATOR_STALE_PAGE_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'stale-page'));
const WORDS = 'Ship the retry worker, then write the ledger migration and stop there.';

let inbox: ChildProcessWithoutNullStreams | null = null;
let url = '';
let thread = '';
/** The release the Inbox runs (package.json), and the one before it, which the first page load claims. */
let version = '';
let older = '';
const contexts: BrowserContext[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(join(repo, 'apps/hook/dist/inbox.html')), 'build the apps first (bun run build:hook)').toBe(true);
  mkdirSync(shots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-stale-page-e2e-');
  const dataDir = join(root, 'data');
  inbox = spawn('bun', [join(repo, 'tests/e2e/stale-page-inbox.ts'), root], {
    cwd: repo,
    env: {
      PATH: process.env.PATH ?? '',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      HOME: join(root, 'home'),
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_INBOX_CONNECT: '0',
      PLANNOTATOR_UPDATE_CHECK: '0',
      PLANNOTATOR_INBOX_PHONES: '0',
      PLANNOTATOR_TEST_SANDBOX: root,
    },
  });
  let stderr = '';
  inbox.stderr.on('data', (chunk) => (stderr += String(chunk)));
  const first = await new Promise<string>((done, fail) => {
    createInterface({ input: inbox!.stdout }).once('line', done);
    inbox!.once('exit', () => fail(new Error(`stale-page-inbox.ts exited: ${stderr}`)));
  });
  ({ url, thread, version } = JSON.parse(first) as { url: string; thread: string; version: string });
  rememberInboxOf(dataDir);
  const [major, minor, patch] = version.split('.').map(Number) as [number, number, number];
  older = patch > 0 ? `${major}.${minor}.${patch - 1}` : minor > 0 ? `${major}.${minor - 1}.0` : '0.0.1';
});

test.afterAll(async () => {
  try {
    for (const context of contexts.splice(0)) await context.close().catch(() => {});
    if (inbox && inbox.exitCode === null) {
      const exited = new Promise((done) => inbox!.once('exit', done));
      inbox.stdin.write('{"stop":true}\n');
      await exited;
    }
  } finally {
    await removeInboxScratch();
  }
});

const { defaultBrowserType: _webkit, ...iphone } = devices['iPhone 13'];
const pane = (page: Page) => page.locator('section.ib-pane');

async function open(browser: Browser, phone: boolean, colorScheme: 'light' | 'dark' = 'light'): Promise<Page> {
  const base = phone ? { ...iphone, viewport: { width: 390, height: 844 } } : { viewport: { width: 1440, height: 900 } };
  const context = await browser.newContext({ ...base, colorScheme, reducedMotion: 'reduce' });
  contexts.push(context);
  return context.newPage();
}

/**
 * The next page load is served as the release before served it: the build's one release literal says `older`. The
 * literal is in the window's entry script, which the page names (`/assets/<name>`, build/pack-inbox.ts), not in the page.
 */
async function serveOlderPageOnce(page: Page) {
  let entry: string | null = null;
  let served = false;
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (served) return route.fallback();
    if (request.resourceType() === 'document') {
      const response = await route.fetch();
      const html = await response.text();
      entry = /<script[^>]*\bsrc="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? null;
      expect(entry, 'the page names its entry script').not.toBeNull();
      return route.fulfill({ response, body: html });
    }
    if (new URL(request.url()).pathname !== entry) return route.fallback();
    const response = await route.fetch();
    served = true;
    const script = await response.text();
    const literal = JSON.stringify(version);
    expect(script.split(literal).length - 1, 'the build names its release once (stalePage.ts pageBuild)').toBe(1);
    await route.fulfill({ response, body: script.replace(literal, JSON.stringify(older)) });
  });
}

/** A shot of the page as it is: each colour scheme is its own page load (WebKit does not restyle inherited text when the scheme is switched on an open page). */
async function shot(page: Page, name: string, scheme: 'light' | 'dark') {
  await page.screenshot({ path: join(shots, `${name}-${scheme}.png`) });
}

async function serverDraft(): Promise<string | null> {
  const res = await fetch(new URL(`/api/inbox/threads/${thread}/draft`, url));
  return ((await res.json()) as { draft: { body: string } | null }).draft?.body ?? null;
}

test('a phone tab from an older release: the notice, and Reload saves the reply before the Inbox page loads', async ({ browser }) => {
  const page = await open(browser, true);
  await serveOlderPageOnce(page);
  await page.goto(url);
  const inList = page.locator('.ib-lbody [data-stale-page]');
  await expect(inList).toBeVisible();
  await expect(inList).toContainText(version);

  // A thread covers the list on a phone: the notice is at the thread's top.
  await page.locator(`[data-thread-id="${thread}"]`).first().tap();
  const inThread = pane(page).locator('[data-stale-page]');
  await expect(inThread).toBeVisible();

  await pane(page).locator('.ib-pfoot [data-reply-button]').first().tap();
  await pane(page).locator('textarea').fill(WORDS);
  // Inside the reply box's 500 ms pause: no save has gone yet. Reload must save the words before the page goes.
  const order: string[] = [];
  page.on('requestfinished', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/inbox/threads/${thread}/draft`) order.push('draft saved');
  });
  page.on('request', (request) => {
    if (request.resourceType() === 'document') order.push('reload');
  });
  const reloaded = page.waitForEvent('load');
  await inThread.locator('.ib-stale-go').tap();
  await reloaded;
  expect(order.slice(0, 2)).toEqual(['draft saved', 'reload']);

  // The Inbox's own page: the thread with the words back in its box, and no notice.
  await expect(pane(page).locator('textarea')).toHaveValue(WORDS);
  await expect(page.locator('[data-stale-page]')).toHaveCount(0);
  expect(await serverDraft()).toBe(WORDS);
});

test('a desktop: the notice beside the thread is the list\'s, and × hides it for that release, the tab shown again included', async ({ browser }) => {
  const page = await open(browser, false);
  await serveOlderPageOnce(page);
  await page.goto(`${url}#thread=${thread}`);
  await expect(pane(page)).toBeVisible();
  const notice = page.locator('[data-stale-page]');
  await expect(page.locator('.ib-lbody [data-stale-page]')).toBeVisible();
  // One notice: the list is beside the thread.
  await expect(notice).toHaveCount(1);

  // From the keyboard (WebKit does not focus a clicked button, so a click leaves focus where it was).
  await notice.locator('.ib-stale-x').focus();
  await page.keyboard.press('Enter');
  await expect(notice).toHaveCount(0);
  // Focus goes to the list's first row, not to the page.
  await expect(page.locator(`.ib-lbody button[data-thread-id="${thread}"]`)).toBeFocused();
  // Shown again (the person comes back to the tab): the Inbox is asked again, and the dismissed release stays hidden.
  const asked = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/inbox/health');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await asked;
  await page.waitForTimeout(200);
  await expect(notice).toHaveCount(0);
});

/** The next page load is the page of a release whose entry script the Inbox no longer has. */
async function servePageWithGoneEntry(page: Page, times: number): Promise<{ documents: number }> {
  const seen = { documents: 0 };
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.fallback();
    seen.documents += 1;
    if (seen.documents > times) return route.fallback();
    const response = await route.fetch();
    const html = await response.text();
    const gone = html.replace(/(<script type="module"[^>]*\ssrc=")\/assets\/[^"]+\.js"/, '$1/assets/index-gone.js"');
    expect(gone, 'the page names its entry script').not.toBe(html);
    await route.fulfill({ response, body: gone });
  });
  return seen;
}

test('an older page whose entry script is gone reloads by itself onto the Inbox\'s own page, never blank', async ({ browser }) => {
  const page = await open(browser, false);
  const seen = await servePageWithGoneEntry(page, 1);
  await page.goto(`${url}#thread=${thread}`);
  await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
  expect(seen.documents).toBe(2);
  await expect(page.locator('[data-stale-page]')).toHaveCount(0);
  // Where the person was: the reload keeps the address's thread.
  expect(new URL(page.url()).hash).toBe(`#thread=${thread}`);
});

test('the same old page coming back after a page that loaded reloads again (a rollback, then forward)', async ({ browser }) => {
  const page = await open(browser, false);
  await servePageWithGoneEntry(page, 1);
  await page.goto(url);
  await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' });
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('plannotator-entry-gone'))).toBeNull();
  const again = await servePageWithGoneEntry(page, 1);
  await page.goto(url);
  await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
  expect(again.documents).toBe(2);
});

test('a page that keeps coming back with its entry script gone reloads once, not in a loop', async ({ browser }) => {
  const page = await open(browser, false);
  const seen = await servePageWithGoneEntry(page, Number.MAX_SAFE_INTEGER);
  await page.goto(url);
  await expect.poll(() => seen.documents).toBe(2);
  await page.waitForTimeout(2000);
  expect(seen.documents).toBe(2);
});

test('the shots: a phone (the list, then a thread) and a desktop, light and dark', async ({ browser }) => {
  for (const scheme of ['light', 'dark'] as const) {
    const phone = await open(browser, true, scheme);
    await serveOlderPageOnce(phone);
    await phone.goto(url);
    await expect(phone.locator('.ib-lbody [data-stale-page]')).toBeVisible();
    await shot(phone, 'phone-list', scheme);
    await phone.locator(`[data-thread-id="${thread}"]`).first().tap();
    await expect(pane(phone).locator('[data-stale-page]')).toBeVisible();
    await shot(phone, 'phone-thread', scheme);

    const desk = await open(browser, false, scheme);
    await serveOlderPageOnce(desk);
    await desk.goto(`${url}#thread=${thread}`);
    await expect(desk.locator('.ib-lbody [data-stale-page]')).toBeVisible();
    await expect(pane(desk)).toBeVisible();
    await shot(desk, 'desktop', scheme);
  }
});
