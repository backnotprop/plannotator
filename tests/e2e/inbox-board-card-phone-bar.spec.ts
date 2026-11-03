/**
 * A phone's opened Board card keeps its top bar on one line with nothing cut
 * (the owner, 2026-11-02, from a phone: the status pill read "● In / progress ⌄"
 * on two lines and "+ Create thread" ran off the right edge; at 320 px it ended
 * at 350.8 px). The bar is "‹ Board", the column pill and the card's thread
 * action (Create thread, or Open thread). When the row is short it gives way
 * (cardTopFit.ts): the action shows its icon alone ("Create thread" stays its
 * name), then the way back its chevron alone ("Board" stays its name). The
 * pill's label is never broken.
 *
 * Proved against the compiled binary at 320, 360, 375, 390 and 430 px, at the
 * default text size and the largest (15), on an In progress card with no
 * thread (Create thread), one with a thread (Open thread) and a sent card (the
 * pill "Todo · sent"); at 280 and 240 px, where the way back gives way too; on
 * a phone resized 320 → 430 → 320 (the bar gives way, takes its words back,
 * gives way again); and at 1440 px, where nothing gives way. Build the binary first (see inbox.spec.ts). PNGs
 * land in .local/proof/card-panel-phone/ (PLANNOTATOR_E2E_PROOF_DIR).
 */

import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_POLL_PATH } from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'card-panel-phone');

interface World {
  url: string;
  claude: SimAgent;
  /** An In progress card with no thread: Create thread. */
  create: string;
  /** An In progress card with a thread: Open thread. */
  open: string;
  /** A Todo card sent to the agent: the pill reads "Todo · sent". */
  sent: string;
  /** The live session's poll, so Create thread has somewhere to go. */
  stop: boolean;
  loop: Promise<void> | null;
}

let world: World;

test.describe.configure({ mode: 'serial' });

async function post(path: string, body: object): Promise<void> {
  const res = await fetch(new URL(`/api/inbox/${path}`, world.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status, await res.clone().text()).toBe(200);
}

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-card-bar-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(env.PLANNOTATOR_DATA_DIR);
  const url = started.stdout.trim();
  world = { url, claude: undefined as unknown as SimAgent, create: '', open: '', sent: '', stop: false, loop: null };
  await post('settings', { board: { on: true } });
  await post('board/intro', {});
  const project = scratchProject(join(root, 'src'), 'plannotator');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  world.claude = claude;
  // One live session in the project, as the mod's connection holds it: Create thread is enabled.
  const { port, token } = JSON.parse(readFileSync(join(env.PLANNOTATOR_DATA_DIR, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
  const startedAt = Date.now() - 45 * 60_000;
  world.loop = (async () => {
    while (!world.stop) {
      await fetch(`http://127.0.0.1:${port}${INBOX_BRIDGE_POLL_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session: 'ses-card-bar', host: 'claude-code', waitMs: 1_000, project_path: project, started_at: startedAt, busy: false, idle_since: startedAt }),
      }).catch(() => null);
    }
  })();
  // A message makes the project; the second card links its thread (Open thread), the first none (Create thread).
  const sent = await claude.send({ project_path: project, subject: 'Checkout drawer', thread: 'drawer', body: 'Starting on the drawer.' });
  const make = async (title: string, fields: Record<string, unknown> = {}) =>
    ((await claude.card({ op: 'create', project_path: project, title, column: 'in_progress', say: 'Option 3 of 6 rendered', ...fields })).card as { id: string }).id;
  world.create = await make('Hero scene timers, easing');
  world.open = await make('Checkout drawer redesign', { thread_id: sent.thread_id });
  // Sent from the window: the person starts a thread to the live session (compose's Send) and the card is sent in it,
  // so it waits in Todo, "· sent" on its pill.
  world.sent = await make('Promo field on the cart', { column: 'todo' });
  let personThread = '';
  await expect
    .poll(async () => {
      const res = await fetch(new URL('/api/inbox/messages', url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: { host: 'claude-code', session: 'ses-card-bar' }, body: 'Promo field on the cart', idempotency_key: 'card-bar-sent' }),
      });
      if (res.ok) personThread = ((await res.json()) as { thread_id: string }).thread_id;
      return res.status;
    })
    .toBe(200);
  await post(`cards/${world.sent}`, { op: 'send', thread_id: personThread });
});

test.afterAll(async () => {
  try {
    if (world) {
      world.stop = true;
      await world.loop;
    }
    await world?.claude?.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

async function phone(browser: Browser, width: number, colorScheme: 'light' | 'dark'): Promise<BrowserContext> {
  const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 7'] as (typeof devices)['Pixel 7'] & { defaultBrowserType?: string };
  return browser.newContext({ ...pixel, viewport: { width, height: 760 }, colorScheme, reducedMotion: 'reduce' });
}

/** The bar as the person sees it: its overflow, the pill label's lines, and every control's box. */
async function readBar(page: Page) {
  return page.locator('[data-card-panel] .ib-crdp-top').evaluate((top) => {
    const box = top.getBoundingClientRect();
    const style = getComputedStyle(top);
    const end = box.right - (parseFloat(style.paddingRight) || 0);
    const controls = [...top.querySelectorAll<HTMLElement>('button')]
      .map((b) => ({ el: b, r: b.getBoundingClientRect() }))
      .filter((b) => b.r.width > 0)
      .sort((a, b) => a.r.x - b.r.x)
      .map(({ el, r }) => ({ name: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '', left: r.left, right: r.right, top: r.top, w: r.width, h: r.height }));
    // The pill's words ("In progress", "Todo · sent"): one line box per line they are drawn on.
    const pill = top.querySelector<HTMLElement>('.ib-crdp-col');
    const tops = new Set<number>();
    const walker = document.createTreeWalker(pill ?? top, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (r.width > 0) tops.add(Math.round(r.top));
    }
    const lines = tops.size;
    const label = top.querySelector<HTMLElement>('.ib-crdp-col b');
    const labelCut = label !== null && label.scrollWidth > label.clientWidth + 0.5;
    return { scrollWidth: top.scrollWidth, clientWidth: top.clientWidth, end, controls, lines, labelCut, fit: top.getAttribute('data-fit') };
  });
}

type Bar = Awaited<ReturnType<typeof readBar>>;

/** One line with nothing past its edge, none over another, each control a 44 px target; the pill's words on one line (and whole, unless the bar is narrower than any phone). */
function expectOneLine(m: Bar, { pillWhole }: { pillWhole: boolean }): void {
  expect(m.scrollWidth, `the bar scrolls ${m.scrollWidth} in ${m.clientWidth} (${JSON.stringify(m.controls)})`).toBeLessThanOrEqual(m.clientWidth);
  expect(m.controls.at(-1)!.right, 'the last control ends inside the bar').toBeLessThanOrEqual(m.end + 0.5);
  expect(m.lines, 'the column label is on one line').toBe(1);
  if (pillWhole) expect(m.labelCut, 'the column label is whole, not cut to "…"').toBe(false);
  for (let i = 1; i < m.controls.length; i++) expect(m.controls[i].left, `${m.controls[i - 1].name} overlaps ${m.controls[i].name}`).toBeGreaterThanOrEqual(m.controls[i - 1].right - 0.5);
  for (const c of m.controls) {
    expect(c.h, `${c.name} is ${Math.round(c.w)}x${Math.round(c.h)}`).toBeGreaterThanOrEqual(43.9);
    expect(c.w, `${c.name} is ${Math.round(c.w)}x${Math.round(c.h)}`).toBeGreaterThanOrEqual(43.9);
    expect(Math.abs(c.top + c.h / 2 - (m.controls[0].top + m.controls[0].h / 2)), `${c.name} is on the bar's line`).toBeLessThan(1);
  }
}

/** Opens a card on the page and waits for its bar to be drawn at the text size asked. */
async function openCard(page: Page, id: string, size: number) {
  await page.goto(`${world.url}#board&card=${id}`);
  const panel = page.locator(`[data-card-panel="${id}"]`);
  await expect(panel.locator('[data-card-back]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--inbox-text-size').trim())).toBe(size === 14 ? '' : String(size));
  await page.evaluate(() => document.fonts.ready);
  return panel;
}

for (const size of [14, 15]) {
  for (const width of [320, 360, 375, 390, 430]) {
    for (const which of ['create', 'open'] as const) {
      const scheme = size === 15 || width === 390 ? 'dark' : 'light';
      test(`${width} px, text ${size}, ${which === 'create' ? 'Create thread' : 'Open thread'}: one line, nothing cut, the pill whole`, async ({ browser }) => {
        await post('settings', { text_size: size });
        const context = await phone(browser, width, scheme);
        try {
          const page = await context.newPage();
          const id = world[which];
          await page.goto(`${world.url}#board&card=${id}`);
          const panel = page.locator(`[data-card-panel="${id}"]`);
          await expect(panel.locator('[data-card-back]')).toBeVisible();
          await expect(panel.locator('[data-card-column="in_progress"]')).toBeVisible();
          const action = panel.locator(which === 'create' ? '[data-card-create-thread]' : '[data-card-open-thread]');
          await expect(action).toBeVisible();
          await expect(action).toBeEnabled();
          await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--inbox-text-size').trim())).toBe(size === 14 ? '' : '15');
          await page.evaluate(() => document.fonts.ready);
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          for (const shotScheme of ['light', 'dark'] as const) {
            await page.emulateMedia({ colorScheme: shotScheme });
            await page.waitForTimeout(150);
            await page.screenshot({ path: join(proofDir, `${width}-text${size}-${which}-${shotScheme}.png`), clip: { x: 0, y: 0, width, height: 240 } });
          }
          await page.emulateMedia({ colorScheme: scheme });

          expectOneLine(await readBar(page), { pillWhole: true });
          // Whatever gave way keeps its name.
          await expect(action).toHaveAccessibleName(which === 'create' ? 'Create thread' : 'Open thread');
          await expect(panel.locator('[data-card-back]')).toHaveAccessibleName(/Board/);
        } finally {
          await context.close();
        }
      });
    }
  }
}

// The longest pill a card shows: its column and "· sent".
for (const size of [14, 15]) {
  for (const width of [320, 390]) {
    test(`${width} px, text ${size}, a sent card: "Todo · sent" on one line, nothing cut`, async ({ browser }) => {
      await post('settings', { text_size: size });
      const context = await phone(browser, width, 'light');
      try {
        const page = await context.newPage();
        const panel = await openCard(page, world.sent, size);
        await expect(panel.locator('[data-card-column="todo"] .ib-crdp-colsent')).toHaveText('· sent');
        await page.screenshot({ path: join(proofDir, `${width}-text${size}-sent-light.png`), clip: { x: 0, y: 0, width, height: 240 } });
        expectOneLine(await readBar(page), { pillWhole: true });
        await expect(panel.locator('[data-card-column="todo"]')).toHaveAccessibleName('Column: Todo, sent. Move');
      } finally {
        await context.close();
      }
    });
  }
}

// Narrower than a phone in portrait: the second step, the way back's chevron alone; at 240 px every control still 44 px.
for (const width of [280, 240]) {
  test(`${width} px, text 15: the way back gives way too, every control 44 px`, async ({ browser }) => {
    await post('settings', { text_size: 15 });
    const context = await phone(browser, width, 'light');
    try {
      const page = await context.newPage();
      const panel = await openCard(page, world.open, 15);
      await page.screenshot({ path: join(proofDir, `${width}-text15-open-light.png`), clip: { x: 0, y: 0, width, height: 240 } });
      await expect(panel.locator('.ib-crdp-top')).toHaveAttribute('data-fit', 'icon back');
      expectOneLine(await readBar(page), { pillWhole: width >= 280 });
      await expect(panel.locator('[data-card-back]')).toHaveAccessibleName('Board');
      await expect(panel.locator('[data-card-open-thread]')).toHaveAccessibleName('Open thread');
    } finally {
      await context.close();
    }
  });
}

test('a phone resized 320 → 430 → 320: the bar gives way, takes its words back, and gives way again', async ({ browser }) => {
  await post('settings', { text_size: 14 });
  const context = await phone(browser, 320, 'light');
  try {
    const page = await context.newPage();
    const panel = await openCard(page, world.create, 14);
    const top = panel.locator('.ib-crdp-top');
    const label = panel.locator('[data-card-create-thread] .ib-crdp-open-l');
    const drawn = () => label.evaluate((el) => el.getBoundingClientRect().width > 1);
    await expect(top).toHaveAttribute('data-fit', 'icon');
    expectOneLine(await readBar(page), { pillWhole: true });
    await page.setViewportSize({ width: 430, height: 760 });
    await expect(top).not.toHaveAttribute('data-fit', /./);
    await expect.poll(drawn).toBe(true);
    expectOneLine(await readBar(page), { pillWhole: true });
    await page.setViewportSize({ width: 320, height: 760 });
    await expect(top).toHaveAttribute('data-fit', 'icon');
    await expect.poll(drawn).toBe(false);
    expectOneLine(await readBar(page), { pillWhole: true });
  } finally {
    await context.close();
  }
});

test('the widest phone keeps every word: "‹ Board", "In progress" and "Create thread"', async ({ browser }) => {
  await post('settings', { text_size: 14 });
  const context = await phone(browser, 430, 'light');
  try {
    const page = await context.newPage();
    await page.goto(`${world.url}#board&card=${world.create}`);
    const top = page.locator(`[data-card-panel="${world.create}"] .ib-crdp-top`);
    await expect(top.locator('[data-card-create-thread]')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect(top).not.toHaveAttribute('data-fit', /./);
    // Each word drawn whole, not kept only for a screen reader.
    const drawn = await top.evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>('button')].map((b) => ({ text: b.textContent?.trim(), shown: [...b.querySelectorAll('span, b')].every((s) => s.getBoundingClientRect().width > 1) })),
    );
    expect(drawn).toEqual([
      { text: 'Board', shown: true },
      { text: 'In progress', shown: true },
      { text: 'Create thread', shown: true },
    ]);
  } finally {
    await context.close();
  }
});

// The phone's rules stay on the phone: in a narrow desktop window the pill is drawn as before, never cut to "● … ⌄".
test('a narrow desktop window, text 15: the pill keeps its words', async ({ browser }) => {
  await post('settings', { text_size: 15 });
  const context = await browser.newContext({ viewport: { width: 800, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.goto(`${world.url}#board&card=${world.open}`);
    const top = page.locator(`[data-card-panel="${world.open}"] .ib-crdp-top`);
    await expect(top.locator('[data-card-open-thread]')).toBeVisible();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--inbox-text-size').trim())).toBe('15');
    await page.evaluate(() => document.fonts.ready);
    await expect(top).not.toHaveAttribute('data-fit', /./);
    const label = await top.locator('.ib-crdp-col-l').evaluate((el) => ({ shown: el.clientWidth, whole: el.scrollWidth }));
    expect(label.shown, `the pill shows ${label.shown} of ${label.whole} px of its words`).toBeGreaterThanOrEqual(label.whole - 0.5);
  } finally {
    await context.close();
  }
});

test('a desktop panel is untouched: nothing gives way', async ({ browser }) => {
  await post('settings', { text_size: 14 });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.goto(`${world.url}#board&card=${world.create}`);
    const top = page.locator(`[data-card-panel="${world.create}"] .ib-crdp-top`);
    const create = top.locator('[data-card-create-thread]');
    await expect(create).toBeVisible();
    await expect(create).toBeEnabled();
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(10, 890);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(proofDir, '1440-create-light.png') });
    await expect(top).not.toHaveAttribute('data-fit', /./);
    await expect(create).toHaveText('Create thread');
    const m = await readBar(page);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
    expect(m.lines).toBe(1);
  } finally {
    await context.close();
  }
});
