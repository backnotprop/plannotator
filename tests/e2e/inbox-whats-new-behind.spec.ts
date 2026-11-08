/**
 * What's new when you are behind, in a real browser against the CLI from
 * source, run as 0.28.50 (bun --define __CLI_VERSION__) under a temp
 * PLANNOTATOR_DATA_DIR and HOME. GitHub is a small fake in this spec, reached
 * through PLANNOTATOR_UPDATE_API_URL: 0.28.53 is the latest, and the release
 * list names 0.28.53 back to 0.28.50 (the real GitHub is never asked).
 *
 * Proved:
 * - 1440: "You have 0.28.50 · 2 releases in between" (0.28.51 and 0.28.52)
 *   takes the panel's list to your row and leaves the notes where they are.
 * - 390 with touch: the bar holds back, the version picker, GitHub and Update,
 *   all inside the screen, with "Inbox" whole (it was squeezed to "I…" and
 *   Update ran off the edge); the meta opens the sheet at your row.
 *
 * Needs the built apps (apps/hook/dist), as the other specs do; then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-whats-new-behind.spec.ts`.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const entry = join(repo, 'apps/hook/server/index.ts');
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'whats-new-behind');

const RUNNING = '0.28.50';
const LISTED = ['0.28.53', '0.28.52', '0.28.51', '0.28.50'];

const body = (v: string) =>
  [`## What's New in v${v}`, '', '### TL;DR', '', `- **New:** The first thing in ${v}`, `- **Fixed:** The second thing in ${v}`, '', `Opening line of ${v}.`, '', ...Array.from({ length: 30 }, (_, n) => `- Item ${n + 1} of ${v}.`)].join('\n');
const release = (v: string, i: number) => ({ tag_name: `v${v}`, draft: false, prerelease: false, published_at: `2026-11-0${8 - i}T10:00:00Z`, body: body(v) });

let inbox: ChildProcess | undefined;
let github: Server;
let url: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(join(repo, 'apps/hook/dist/inbox.html')), 'build the apps first: apps/hook/dist').toBe(true);
  mkdirSync(proofDir, { recursive: true });
  github = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const send = (value: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (path.endsWith('/releases/latest')) return send(release(LISTED[0]!, 0));
    if (path.endsWith('/releases')) return send(LISTED.map(release));
    const tag = /\/releases\/tags\/v(\d+\.\d+\.\d+)$/.exec(path)?.[1];
    if (tag && LISTED.includes(tag)) return send(release(tag, LISTED.indexOf(tag)));
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => github.listen(0, '127.0.0.1', done));
  const api = `http://127.0.0.1:${(github.address() as { port: number }).port}/repos/backnotprop/plannotator/releases/latest`;

  const root = inboxScratch('plannotator-inbox-whatsnew-behind-e2e-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  // Someone who has used 0.28.50 here: no tour, no first-run asks.
  writeFileSync(join(dataDir, 'update-state.json'), JSON.stringify({ inboxVersion: RUNNING }));
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({
      inboxTour: { version: 2, seen_at: '2026-10-01T10:00:00.000Z', skipped_at: '2026-10-01T10:00:00.000Z' },
      inboxNotifications: { dismissed: true },
      inboxAgentNotes: { offered: true },
      inboxSound: { dialogShownFor: RUNNING },
      inboxListIntro: { shownAt: '2026-10-01T10:00:00.000Z' },
    }),
  );
  const bun = realpathSync(process.env.BUN_BINARY ?? execSync('command -v bun').toString().trim());
  const env = {
    PATH: `${dirname(bun)}:${dirname(process.execPath)}:/usr/bin:/bin`,
    PLANNOTATOR_TEST_SANDBOX: root,
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    NO_ANON_PING: '1',
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_AUTO_UPDATE: '0',
    PLANNOTATOR_UPDATE_API_URL: api,
  };
  inbox = spawn(bun, ['--define', `__CLI_VERSION__="${RUNNING}"`, entry, 'inbox', '--no-open'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  inbox.stderr!.on('data', (c) => (err += c));
  const deadline = Date.now() + 60_000;
  while (!/Plannotator Inbox: (\S+)/.test(err) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const found = /Plannotator Inbox: (\S+)/.exec(err);
  expect(found, 'the Inbox did not start').not.toBeNull();
  rememberInboxOf(dataDir);
  url = found![1]!;
});

test.afterAll(async () => {
  try {
    github?.close();
  } finally {
    await removeInboxScratch();
  }
});

async function openLatest(page: Page) {
  await page.goto(`${url}#whats-new=${LISTED[0]}`);
  await expect(page.locator('.ib-wn')).toContainText(`Opening line of ${LISTED[0]}.`);
  await expect(page.locator('[data-whats-new-standing="behind"]')).toHaveText(`You have ${RUNNING} · 2 releases in between`);
  await expect(page.locator('[data-whats-new-update]')).toBeVisible();
}

test('1440: the meta takes the panel to your row and leaves the notes where they are', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 600 } });
  const page = await context.newPage();
  try {
    await openLatest(page);
    const mine = page.locator(`[data-whats-new-panel] [data-whats-new-release="${RUNNING}"]`);
    await expect(mine).toContainText('You have this');
    const pageTop = () => page.evaluate(() => (document.querySelector('.ib-wn') as HTMLElement).scrollTop + document.scrollingElement!.scrollTop);
    const before = await pageTop();
    await page.locator('[data-whats-new-standing="behind"]').click();
    await expect(mine).toBeFocused();
    await expect(mine).toBeInViewport();
    expect(await pageTop()).toBe(before);
    await page.screenshot({ path: join(proofDir, 'behind-1440.png') });
  } finally {
    await context.close();
  }
});

test('390: the bar fits with Update, "Inbox" stays whole, and the meta opens the sheet at your row', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  try {
    await openLatest(page);
    await expect(page.locator('[data-whats-new-picker]')).toBeVisible();
    const bar = await page.evaluate(() => {
      const el = document.querySelector('.ib-wn-bar')!;
      const label = el.querySelector('.ib-pback-l') as HTMLElement;
      return {
        rights: [...el.querySelectorAll<HTMLElement>('button, a')].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect().right),
        backWhole: label.scrollWidth <= label.clientWidth,
        width: window.innerWidth,
      };
    });
    for (const right of bar.rights) expect(right).toBeLessThanOrEqual(bar.width);
    expect(bar.backWhole).toBe(true);
    await page.screenshot({ path: join(proofDir, 'behind-390-bar.png') });

    await page.locator('[data-whats-new-standing="behind"]').click();
    const sheet = page.locator('[data-dialog="whats-new-releases"]');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(`[data-whats-new-release="${RUNNING}"]`)).toBeInViewport();
    await page.screenshot({ path: join(proofDir, 'behind-390-sheet.png') });
  } finally {
    await context.close();
  }
});
