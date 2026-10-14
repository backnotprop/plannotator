/**
 * The list column beside an open thread has the sidebar's resize edge
 * (packages/inbox/shell/ListColumnEdge.tsx), proved in a real Chromium against
 * the compiled binary under a temp PLANNOTATOR_DATA_DIR: the column opens at
 * 380px with two-line rows; a drag widens it, the rows switch to the wide
 * shape exactly once as it crosses 900px (sampled every frame); it never
 * leaves the thread pane less than 480px; the width survives a reload; the
 * keyboard resizes it; a narrower window draws it clamped; and the full list
 * and a phone get no edge.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * The PNGs land in .local/proof/list-resize/.
 */

import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEMO_MESSAGES, SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'list-resize');
// Wide enough that a widened list can pass the wide rows' 900px beside the sidebar.
const VIEWPORT = { width: 1920, height: 1000 };
const SIDEBAR = 232;
const LIST_MIN = 380;
const PANE_MIN = 480;
const WIDE_ROWS = 900;

interface World {
  root: string;
  dataDir: string;
  url: string;
  agent: SimAgent;
  /** The thread that carries a guided review. */
  guideThread: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
}

let world: World;

function registry(): { pid: number } {
  return JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
}

const list = (page: Page) => page.locator('.ib-listcol');
const edge = (page: Page) => page.getByRole('separator', { name: 'List width' });
const width = (page: Page, selector: string) => page.locator(selector).evaluate((el) => el.getBoundingClientRect().width);

async function cookie(page: Page, name: string): Promise<string | undefined> {
  return (await page.context().cookies()).find((c) => c.name === name)?.value;
}

async function shot(name: string): Promise<void> {
  const page = world.page;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  for (const file of readdirSync(proofDir)) rmSync(join(proofDir, file), { recursive: true, force: true });
  const root = inboxScratch('plannotator-inbox-list-resize-e2e-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { PATH: process.env.PATH ?? '', HOME: home, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER };
  // The data dir this run hands the binary is its own temp folder, never the person's.
  expect(env.PLANNOTATOR_DATA_DIR.startsWith(root)).toBe(true);
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const agent = await SimAgent.connect({ binary: builtBinary, env, name: 'Claude Code', host: 'claude-code' });
  const billing = scratchProject(join(root, 'src'), 'billing-svc');
  const docs = scratchProject(join(root, 'src'), 'docs-site');
  await agent.send({ project_path: billing, subject: 'Stripe 409', body: DEMO_MESSAGES.stopped });
  await agent.send({ project_path: docs, subject: 'Install page', body: DEMO_MESSAGES.holding });
  await agent.send({ project_path: billing, subject: 'Refund events', thread: 'refund-webhooks', body: DEMO_MESSAGES.named });
  await agent.send({ project_path: docs, subject: 'Build finished', body: DEMO_MESSAGES.news });
  const { example } = await agent.guideBrief();
  const guide = await agent.submitGuide({ project_path: billing, ...example, subject: 'Token refresh guide', thread: 'token-refresh' });
  const guideThread = String(guide.thread_id);
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  world = { root, dataDir, url, agent, guideThread, context, page, errors };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.agent.close().catch(() => {});
    await world.context.close();
  } finally {
    // Every Inbox this spec started, then its folders (inbox-scratch.ts).
    await removeInboxScratch();
  }
});

test('the full list has no edge; an open thread narrows it to 380px with the edge and two-line rows', async () => {
  const { page, url } = world;
  await page.goto(url);
  await expect(page.locator('.ib-lbody .ib-row').first()).toBeVisible();
  await expect(edge(page)).toHaveCount(0);
  await shot('full-list');
  // The first aria-valuemax the separator ever carries: measured before paint, not corrected after it.
  await page.evaluate(() => {
    const w = window as unknown as { firstMax?: string | null };
    const observer = new MutationObserver(() => {
      const sep = document.querySelector('[role="separator"][aria-label="List width"]');
      if (!sep || w.firstMax !== undefined) return;
      w.firstMax = sep.getAttribute('aria-valuemax');
      observer.disconnect();
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  await page.locator('.ib-lbody [data-thread-id]').first().click();
  await expect(page.locator('.ib-pane')).toBeVisible();
  await expect(edge(page)).toHaveAttribute('aria-valuenow', String(LIST_MIN));
  await expect(edge(page)).toHaveAttribute('aria-valuemin', String(LIST_MIN));
  await expect(edge(page)).toHaveAttribute('aria-valuemax', String(VIEWPORT.width - SIDEBAR - PANE_MIN));
  expect(await page.evaluate(() => (window as unknown as { firstMax?: string }).firstMax)).toBe(String(VIEWPORT.width - SIDEBAR - PANE_MIN));
  // Each edge names the panel it resizes.
  const listId = await list(page).getAttribute('id');
  expect(listId).toBeTruthy();
  await expect(edge(page)).toHaveAttribute('aria-controls', listId!);
  const panelId = await page.locator('.ib-sb-panel').getAttribute('id');
  expect(panelId).toBeTruthy();
  await expect(page.getByRole('separator', { name: 'Sidebar width' })).toHaveAttribute('aria-controls', panelId!);
  expect(await width(page, '.ib-listcol')).toBe(LIST_MIN);
  expect(await page.locator('.ib-lbody .ib-row').count()).toBe(0);
  expect(await page.locator('.ib-lbody .ib-nrow').count()).toBeGreaterThan(0);
  // The handle's grab area starts on the column's right edge and lies over the
  // pane's side, with the sidebar's col-resize cursor.
  const hit = page.locator('.ib-listedge .ib-handle-hit');
  const box = (await hit.boundingBox())!;
  expect(Math.abs(box.x - (SIDEBAR + LIST_MIN - 1))).toBeLessThanOrEqual(1);
  expect(box.width).toBe(12);
  expect(await page.locator('.ib-listedge .ib-handle').evaluate((el) => getComputedStyle(el).cursor)).toBe('col-resize');
  await shot('thread-open');
});

test('a drag widens it; the rows switch to the wide shape once, as it crosses 900px', async () => {
  const { page } = world;
  const x0 = SIDEBAR + LIST_MIN + 4;
  const target = 1000;
  // Every frame of the drag: the list's width and which row shape is drawn.
  const sampling = page.evaluate(
    () =>
      new Promise<Array<[number, boolean]>>((done) => {
        const out: Array<[number, boolean]> = [];
        const t0 = performance.now();
        const tick = () => {
          const el = document.querySelector('.ib-listcol');
          if (el) out.push([el.getBoundingClientRect().width, el.querySelector('.ib-lbody .ib-row') !== null]);
          if (performance.now() - t0 < 2500) requestAnimationFrame(tick);
          else done(out);
        };
        requestAnimationFrame(tick);
      }),
  );
  await page.mouse.move(x0, 500);
  await page.mouse.down();
  await page.mouse.move(SIDEBAR + target + 4, 500, { steps: 60 });
  await page.mouse.up();
  const samples = await sampling;
  const flips = samples.filter((s, i) => i > 0 && s[1] !== samples[i - 1]![1]).length;
  expect(flips).toBe(1);
  // Two-line rows the whole way below the boundary (one frame of lag at the crossing is allowed).
  for (const [w, wide] of samples) if (w < WIDE_ROWS - 20) expect(wide).toBe(false);
  expect(samples.at(-1)).toEqual([target, true]);

  await expect(edge(page)).toHaveAttribute('aria-valuenow', String(target));
  expect(await cookie(page, 'plannotator-inbox-list-width')).toBe(String(target));
  // The open thread stays marked in the wide rows.
  await expect(page.locator('.ib-lbody .ib-row.ib-sel')).toHaveCount(1);
  expect(await width(page, '.ib-pane')).toBe(VIEWPORT.width - SIDEBAR - target);
  await shot('widened');
});

test('it never leaves the thread pane less than 480px', async () => {
  const { page } = world;
  const max = VIEWPORT.width - SIDEBAR - PANE_MIN;
  await page.mouse.move(SIDEBAR + 1000 + 4, 500);
  await page.mouse.down();
  await page.mouse.move(VIEWPORT.width - 20, 500, { steps: 20 });
  await page.mouse.up();
  await expect(edge(page)).toHaveAttribute('aria-valuenow', String(max));
  expect(await width(page, '.ib-listcol')).toBe(max);
  expect(await width(page, '.ib-pane')).toBe(PANE_MIN);
  expect(await cookie(page, 'plannotator-inbox-list-width')).toBe(String(max));
});

test('the width survives a reload; the keyboard resizes it within the range', async () => {
  const { page } = world;
  await page.reload();
  await expect(page.locator('.ib-pane')).toBeVisible();
  const max = VIEWPORT.width - SIDEBAR - PANE_MIN;
  await expect(edge(page)).toHaveAttribute('aria-valuenow', String(max));
  expect(await width(page, '.ib-listcol')).toBe(max);
  expect(await width(page, '.ib-pane')).toBe(PANE_MIN);
  await expect(page.locator('.ib-lbody .ib-row').first()).toBeVisible();

  await edge(page).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(edge(page)).toHaveAttribute('aria-valuenow', String(max - 10));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(edge(page)).toHaveAttribute('aria-valuenow', String(max));
  await page.keyboard.press('Home');
  await expect(edge(page)).toHaveAttribute('aria-valuenow', String(LIST_MIN));
  expect(await width(page, '.ib-listcol')).toBe(LIST_MIN);
  await expect(page.locator('.ib-lbody .ib-nrow').first()).toBeVisible();
  await page.keyboard.press('End');
  await expect(edge(page)).toHaveAttribute('aria-valuenow', String(max));
  await edge(page).evaluate((el) => (el as HTMLElement).blur());
});

test('a narrower window draws it clamped, keeping the thread pane its 480px', async () => {
  const { page } = world;
  await page.setViewportSize({ width: 1280, height: 900 });
  const room = 1280 - SIDEBAR;
  await expect.poll(() => width(page, '.ib-pane')).toBe(PANE_MIN);
  expect(await width(page, '.ib-listcol')).toBe(room - PANE_MIN);
  await expect(edge(page)).toHaveAttribute('aria-valuenow', String(room - PANE_MIN));
  // The stored preference is kept for a wider window.
  expect(await cookie(page, 'plannotator-inbox-list-width')).toBe(String(VIEWPORT.width - SIDEBAR - PANE_MIN));
  // A drag starts from the drawn width: the first pixels move the edge.
  await page.mouse.move(SIDEBAR + room - PANE_MIN + 4, 500);
  await page.mouse.down();
  await page.mouse.move(SIDEBAR + room - PANE_MIN - 96, 500, { steps: 10 });
  await page.mouse.up();
  await expect(edge(page)).toHaveAttribute('aria-valuenow', String(room - PANE_MIN - 100));
  await page.setViewportSize(VIEWPORT);
});

test('a window that leaves no room to widen into shows no separator', async () => {
  const { page } = world;
  // 232 + 380 + 480 = 1092: at 1080 there is nothing to drag.
  await page.setViewportSize({ width: 1080, height: 900 });
  await expect(edge(page)).toHaveCount(0);
  expect(await width(page, '.ib-listcol')).toBe(LIST_MIN);
  await page.setViewportSize(VIEWPORT);
  // Back with the room (the separator itself is a zero-width line).
  await expect(edge(page)).toHaveCount(1);
});

test('with a classic scrollbar on the list, the whole scrollbar stays the list’s, and the grab area is beside it', async () => {
  // Headless Chromium hides scrollbars (--hide-scrollbars) and macOS draws
  // overlay ones: this browser keeps them, and the list gets a classic 15px
  // scrollbar (the app's `scrollbar-width: thin` would win over the
  // ::-webkit-scrollbar rules, so it is set back to auto here).
  const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
  try {
    const page = await browser.newPage({ viewport: { width: VIEWPORT.width, height: 300 } });
    await page.goto(world.url);
    await page.locator('.ib-lbody [data-thread-id]').first().click();
    await expect(page.locator('.ib-pane')).toBeVisible();
    await page.addStyleTag({
      content:
        '.ib-listcol .ib-lbody { scrollbar-width: auto; scrollbar-color: auto; } .ib-listcol .ib-lbody::-webkit-scrollbar { width: 15px; background: #ddd; } .ib-listcol .ib-lbody::-webkit-scrollbar-thumb { background: #888; }',
    });
    const bar = await page.locator('.ib-listcol .ib-lbody').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { right: r.right, top: r.top, width: (el as HTMLElement).offsetWidth - (el as HTMLElement).clientWidth, scrolls: el.scrollHeight > el.clientHeight };
    });
    expect(bar.scrolls).toBe(true);
    expect(bar.width).toBe(15);
    expect(bar.right).toBe(SIDEBAR + LIST_MIN - 1);
    const y = Math.round(bar.top + 40);
    const at = (x: number) => page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className, [x, y] as const);
    for (let x = bar.right - bar.width; x < bar.right; x += 1) expect(await at(x), `x=${x}`).toBe('ib-lbody');
    // Just past the line, over the thread pane's side, the edge takes the pointer.
    expect(await at(bar.right + 5)).toBe('ib-handle-hit');
  } finally {
    await browser.close();
  }
});

test('a guided review card fits a 480px thread pane', async () => {
  const { page, guideThread } = world;
  await page.locator(`.ib-lbody [data-thread-id="${guideThread}"]`).click();
  const card = page.locator('[data-guide-card]');
  await expect(card).toBeVisible();
  await edge(page).focus();
  await page.keyboard.press('End');
  await expect.poll(() => width(page, '.ib-pane')).toBe(PANE_MIN);
  const fit = await card.evaluate((el) => {
    const pane = el.closest('.ib-pane')!.getBoundingClientRect();
    const parent = el.parentElement!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { right: r.right, parentRight: parent.right, paneRight: pane.right };
  });
  expect(fit.right).toBeLessThanOrEqual(fit.parentRight + 0.5);
  expect(fit.right).toBeLessThanOrEqual(fit.paneRight);
  await shot('guide-card-480');
  await edge(page).evaluate((el) => (el as HTMLElement).blur());
});

test('closing the thread gives the list its full width back; a phone gets no edge', async () => {
  const { page } = world;
  await page.getByRole('button', { name: 'Close the thread' }).click();
  await expect(page.locator('.ib-pane')).toHaveCount(0);
  await expect(edge(page)).toHaveCount(0);
  expect(await width(page, '.ib-listcol')).toBe(VIEWPORT.width - SIDEBAR);
  expect(await list(page).evaluate((el) => (el as HTMLElement).style.width)).toBe('');

  await page.setViewportSize({ width: 600, height: 900 });
  await page.locator('.ib-lbody [data-thread-id]').first().click();
  await expect(page.locator('.ib-pane')).toBeVisible();
  await expect(edge(page)).toHaveCount(0);
  expect(await list(page).evaluate((el) => (el as HTMLElement).style.width)).toBe('');
  await page.setViewportSize(VIEWPORT);
  expect(world.errors).toEqual([]);
});
