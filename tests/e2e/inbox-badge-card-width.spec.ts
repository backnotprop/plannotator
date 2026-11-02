/**
 * The list badge's hover card sizes to its content (owner, 2026-10-31: "The
 * holds up box needs to be wider. So that it doesn't line break."). It was a
 * fixed 296 px, so labels like "The channel, and with it shapes 2 and 3" wrapped
 * and the thread's name was cut at 130 px. Now it is as wide as its longest
 * line, between 296 px and 460 px, never past the viewport less its 16 px
 * gutter; only a line past the cap wraps.
 *
 *  - Three ~45-character items each sit on one line at desktop width, and the
 *    thread's name in the header gets room past the old 130 px.
 *  - A thread name longer than the room still ends in an ellipsis, with the
 *    full name in its title; the card stays inside the window.
 *  - A very long label wraps once the card is at its cap, never wider.
 *  - A narrow window (390 px) keeps the card inside the viewport.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * Plain full-window PNGs land in PLANNOTATOR_BADGE_CARD_SHOTS when it is set.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = process.env.PLANNOTATOR_BADGE_CARD_SHOTS ? resolve(process.env.PLANNOTATOR_BADGE_CARD_SHOTS) : null;

const THREAD_NAME = 'Inbox vision: Tag, chips and the superfans roadmap';
const ITEMS = ['The channel, and with it shapes 2 and 3', 'The next superfans step and the Tag-like roadmap', 'Whether the engine question stays closed'];
const LONG_ITEM = 'The whole migration of the ledger, the audit trail, the reconciliation jobs, the reports and every dashboard that reads them';

interface World {
  url: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  fits: string;
  long: string;
}
let world: World;

const card = (page: Page) => page.locator('[data-pn-tooltip]:not([data-closed]) [data-wait-card]');

function question(text: string, holds?: string): string {
  return [':::question', text, ...(holds ? [`Holds up: ${holds}.`] : []), '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');
}

async function hoverBadge(page: Page, threadId: string): Promise<void> {
  await page.mouse.move(5, 5);
  await expect(card(page)).toHaveCount(0);
  await page.locator(`[data-thread-id="${threadId}"] [data-row-badge]`).hover();
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(300);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${process.env.PLANNOTATOR_BADGE_CARD_SHOT_PREFIX ?? 'after'}-${name}.png`) });
}

/** What the open card looks like on screen: its box, and each row's lines. */
async function measure(page: Page) {
  return card(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const lines = (t: Element) => Math.round(t.getBoundingClientRect().height / parseFloat(getComputedStyle(t).lineHeight));
    const chip = el.querySelector<HTMLElement>('.ib-wc-chip');
    return {
      left: r.left,
      right: r.right,
      width: r.width,
      vw: document.documentElement.clientWidth,
      rows: [...el.querySelectorAll('.ib-wc-row .ib-wc-t')].map((t) => ({ text: t.textContent, lines: lines(t) })),
      chip: chip ? { width: chip.getBoundingClientRect().width, cut: chip.scrollWidth > chip.clientWidth + 0.5, text: chip.textContent, title: chip.getAttribute('title') } : null,
    };
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-badge-card-width-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'plannotator');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const fits = await claude.send({
    project_path: project,
    subject: 'Where the vision goes next',
    thread: THREAD_NAME,
    body: ['Four calls.', '', question('Which channel first?', ITEMS[0]), '', question('Ship the beta this week?'), '', question('What comes after superfans?', ITEMS[1]), '', question('Keep the engine question?', ITEMS[2])].join('\n'),
  });
  const long = await claude.send({
    project_path: project,
    subject: 'The ledger plan',
    thread: 'ledger-plan',
    body: ['Two calls.', '', question('Move everything now?', LONG_ITEM), '', question('Keep the old ledger?', 'The old ledger')].join('\n'),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await context.newPage();
  world = { url, agents: [claude], context, page, fits: fits.thread_id as string, long: long.thread_id as string };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    for (const agent of world.agents) await agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('desktop: three ~45-character items each on one line, the thread name given room', async () => {
  const { page } = world;
  await page.goto(world.url);
  await hoverBadge(page, world.fits);
  await expect(card(page).locator('.ib-wc-h')).toHaveText('Holds up 3');
  await shot(page, 'desktop');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await shot(page, 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(300);
  const m = await measure(page);
  expect(m.rows.map((r) => r.text)).toEqual(ITEMS);
  for (const r of m.rows) expect(r.lines, `"${r.text}" wraps`).toBe(1);
  expect(m.width).toBeGreaterThan(296);
  expect(m.width).toBeLessThanOrEqual(460);
  expect(m.right).toBeLessThanOrEqual(m.vw - 8 + 0.5);
  expect(m.chip!.width, 'the thread name is still capped at its old 130 px').toBeGreaterThan(130);
});

test('past the cap a label wraps; the card is never wider than 460 px', async () => {
  const { page } = world;
  await page.goto(world.url);
  await hoverBadge(page, world.long);
  const m = await measure(page);
  expect(m.width).toBeLessThanOrEqual(460.5);
  expect(m.rows[0]!.lines).toBeGreaterThan(1);
  expect(m.right).toBeLessThanOrEqual(m.vw - 8 + 0.5);
});

test('a window narrower than the card has room for: the card shifts in and stays inside', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, colorScheme: 'light', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.goto(world.url);
    await hoverBadge(page, world.fits);
    await shot(page, 'right-edge');
    const m = await measure(page);
    expect(m.left).toBeGreaterThanOrEqual(0);
    expect(m.right).toBeLessThanOrEqual(m.vw + 0.5);
    for (const r of m.rows) expect(r.lines, `"${r.text}" wraps`).toBe(1);
  } finally {
    await context.close();
  }
});

test('a narrow window (390): the card is capped to the viewport less its gutter', async ({ browser }) => {
  // The phone layout draws icons only and opens no card, so the cap is proved on the card's own CSS: a card
  // with the longest line, drawn with the real classes, at 390 px.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.goto(world.url);
    await page.locator('.pn-inbox').first().evaluate((root, text) => {
      const el = document.createElement('div');
      el.className = 'ib-wcard ib-wc-hold';
      el.dataset.probe = '';
      el.style.cssText = 'position:fixed;top:60px;right:8px;z-index:9999';
      el.innerHTML = `<div class="ib-wc-head"><span class="ib-wc-h">Holds up 3</span><span class="ib-wc-chip">${text}</span></div><div class="ib-wc-row"><span class="ib-wc-t">${text}</span></div>`;
      root.appendChild(el);
    }, LONG_ITEM + ' ' + LONG_ITEM);
    await page.waitForTimeout(200);
    await shot(page, 'phone-390');
    const m = await page.locator('[data-probe]').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, vw: document.documentElement.clientWidth };
    });
    expect(m.left).toBeGreaterThanOrEqual(0);
    expect(m.right).toBeLessThanOrEqual(m.vw + 0.5);
    expect(m.width).toBeLessThanOrEqual(m.vw - 16 + 0.5);
  } finally {
    await context.close();
  }
});
