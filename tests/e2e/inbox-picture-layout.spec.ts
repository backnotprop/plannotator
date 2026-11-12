/**
 * How a question's picture choices are laid out (approval
 * "picture-choices-layout", Adaptive), proved in Chromium against the compiled
 * binary: a Claude Code agent asks through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts) with real PNGs of known sizes beside the project, and
 * the Inbox records each picture's size when the message is sent.
 *
 * What regresses if this fails:
 * - the card moves when its pictures load (every picture is held back 1.5 s:
 *   the tiles' boxes and the card's height are the same before and after);
 * - two wide pictures stop sharing the width, or a phone screenshot set stops
 *   getting narrow columns (three across in a 726 px card, two in a 390 px
 *   window, one in a 320 px one);
 * - two choices where one has no picture stop going to Rows, or in a
 *   right-to-left page its zoom button leaves the picture; three pictures and
 *   a choice without one (the tour's picture step) leave columns, or the bare
 *   choice draws a picture-tall empty box;
 * - three choices with pictures of mixed shapes go Rows;
 * - a recorded picture that fails to load re-lays out its set;
 * - phone screenshots stop going one a row under a 360 px window, or a long
 *   strip is drawn too thin to see, under the zoom button;
 * - one choice stops taking the full width, a small icon is blown up past
 *   its own size, or a picture that failed to load stops saying so;
 * - a panorama set stops taking the full width.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-picture-layout.spec.ts`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { png } from './test-png';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const question = (prompt: string, choices: string[]) => [':::question', prompt, '', ...choices.map((c) => `- [ ] ${c}`), ':::'].join('\n');

const QUESTIONS = {
  wide: question('Which filter?', ['A · Header button — ![Header](shots/wide-a.png) shows while the sidebar is closed.', 'B · Menu group — ![Menu](shots/wide-b.png) right after Refresh.']),
  phones: question('Which phone header?', ['A · Title — ![A](shots/phone-a.png) back arrow and subject.', 'B · Project — ![B](shots/phone-b.png) project under it.', 'C · Dark — ![C](shots/phone-a.png) on a dark bar.', 'D · Large — ![D](shots/phone-b.png) large title.', 'E · None — ![E](shots/phone-a.png) a floating button.', 'F · Tabs — ![F](shots/phone-b.png) tabs under it.']),
  bare: question('Which reply box?', ['A · Laptop — ![Laptop](shots/wide-a.png) pinned under the thread.', 'B · Neither — keep today\'s box.']),
  one: question('Ship the header button?', ['A · Header button — ![Header](shots/wide-a.png) shows while the sidebar is closed.']),
  odd: question('Which empty-state picture?', ['A · Icon — ![Icon](shots/icon.png) the 48 px icon.', 'B · Gone — ![Gone](shots/not-there.png) last week\'s.', 'C · List — ![List](shots/wide-b.png) the list.']),
  pano: question('Which terminal strip?', ['A · Full — ![Full](shots/pano.png) every line.', 'B · Short — ![Short](shots/pano.png) the last lines.']),
  bare3: question('Which direction?', ['A · Tabs — ![A](shots/wide-a.png) one tab.', 'B · Split — ![B](shots/wide-b.png) beside the diff.', 'C · Panel — ![C](shots/wide-a.png) in a panel.', 'D · Ship as is now.']),
  mixed3: question('Which header?', ['A · Laptop — ![A](shots/wide-a.png) wide.', 'B · Phone — ![B](shots/phone-a.png) narrow.', 'C · Menu — ![C](shots/wide-b.png) wide.']),
  fails: question('Which phone list?', ['A · Cards — ![A](shots/phone-a.png) cards.', 'B · Rows — ![B](shots/phone-fails.png) rows.']),
  strip: question('Which status line?', ['A · Full — ![A](shots/strip.png) every field.', 'B · Short — ![B](shots/strip.png) the branch only.']),
};

let context: BrowserContext;
let page: Page;
let threads: Record<keyof typeof QUESTIONS, string>;
let url: string;
let claude: SimAgent;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-picture-layout-e2e-');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'shop');
  mkdirSync(join(project, 'shots'), { recursive: true });
  writeFileSync(join(project, 'shots', 'wide-a.png'), png(1200, 500, [37, 99, 235]));
  writeFileSync(join(project, 'shots', 'wide-b.png'), png(1200, 500, [22, 163, 74]));
  writeFileSync(join(project, 'shots', 'phone-a.png'), png(390, 844, [217, 119, 6]));
  writeFileSync(join(project, 'shots', 'phone-b.png'), png(390, 844, [147, 51, 234]));
  writeFileSync(join(project, 'shots', 'icon.png'), png(48, 48, [190, 18, 60]));
  writeFileSync(join(project, 'shots', 'pano.png'), png(1800, 300, [15, 23, 42]));
  writeFileSync(join(project, 'shots', 'phone-fails.png'), png(390, 844, [8, 145, 178]));
  writeFileSync(join(project, 'shots', 'strip.png'), png(2400, 60, [15, 23, 42]));
  claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  threads = {} as typeof threads;
  for (const [name, body] of Object.entries(QUESTIONS)) {
    const sent = await claude.send({ project_path: project, subject: `Pictures ${name}`, thread: `layout-${name}`, body: `Pictures.\n\n${body}` });
    threads[name as keyof typeof QUESTIONS] = sent.thread_id as string;
  }
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
  page = await context.newPage();
});

test.afterAll(async () => {
  try {
    await claude?.close().catch(() => {});
    await context?.close();
  } finally {
    await removeInboxScratch();
  }
});

interface Box { x: number; y: number; w: number; h: number }
interface Layout { card: number; room: number; tiles: { tile: Box; picture: Box | null; img: Box | null; caption: Box; zoom: Box | null; natural: number }[]; loaded: number }

/** The open card's tiles, the room their grid has, and how many pictures have loaded. */
function layout(p: Page): Promise<Layout> {
  return p.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const card = document.querySelector('section.ib-pane fieldset.question-block')!;
    const grid = card.querySelector('[data-question-tiles]')!;
    const imgs = [...grid.querySelectorAll('img')];
    return {
      card: Math.round(card.getBoundingClientRect().height),
      room: Math.round(grid.getBoundingClientRect().width),
      loaded: imgs.filter((img) => img.complete && img.naturalWidth > 0).length,
      tiles: [...grid.querySelectorAll('[data-question-tile]')].map((tile) => ({
        tile: box(tile)!,
        picture: box(tile.querySelector('[data-question-tile-picture]')),
        img: box(tile.querySelector('img')),
        caption: box(tile.querySelector('[data-question-tile-caption]'))!,
        zoom: box(tile.querySelector('[data-question-zoom]')),
        natural: tile.querySelector('img')?.naturalWidth ?? 0,
      })),
    };
  });
}

async function open(name: keyof typeof QUESTIONS): Promise<void> {
  await page.goto(`${url}#thread=${threads[name]}`);
  await expect(page.locator('section.ib-pane fieldset.question-block [data-question-tile]').first()).toBeVisible();
}

async function loaded(count: number): Promise<Layout> {
  await expect.poll(async () => (await layout(page)).loaded).toBe(count);
  await page.waitForTimeout(200);
  return layout(page);
}

const rows = (l: Layout) => [...new Set(l.tiles.map((t) => t.tile.y))].map((y) => l.tiles.filter((t) => t.tile.y === y).length);
const inside = (a: Box, b: Box) => a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.w <= b.x + b.w + 1 && a.y + a.h <= b.y + b.h + 1;

test('nothing moves when the pictures load: two wide pictures share the width, boxed before they arrive', async () => {
  const isPicture = (u: URL) => u.pathname.endsWith('/image');
  await page.route(isPicture, async (route) => {
    await new Promise((done) => setTimeout(done, 1500));
    await route.continue();
  });
  try {
    await open('wide');
    const before = await layout(page);
    expect(before.loaded).toBe(0);
    const after = await loaded(2);
    expect(after.card).toBe(before.card);
    expect(after.tiles.map((t) => [t.tile, t.picture])).toEqual(before.tiles.map((t) => [t.tile, t.picture]));
    // Halves, side by side, the picture at its own shape (1200 x 500, not the 16:10 box a picture of unknown size gets).
    expect(rows(after)).toEqual([2]);
    expect(after.tiles[0]!.tile.w).toBeGreaterThan(after.room * 0.45);
    const img = after.tiles[0]!.img!;
    expect(Math.abs(img.w / img.h - 2.4)).toBeLessThan(0.05);
  } finally {
    await page.unroute(isPicture);
  }
});

test('phone screenshots: narrow columns, three across in a 726 px card, two in a 390 px window, one in a 320 px one', async () => {
  await open('phones');
  await page.locator('.ib-listcol .ib-handle-hit').first().click();
  let l = await loaded(6);
  expect(rows(l)).toEqual([3, 3]);
  expect(Math.max(...l.tiles.map((t) => t.tile.w))).toBeLessThanOrEqual(320);
  // Two across from a 360 px window; one a row below it.
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(300);
    l = await layout(page);
    expect(rows(l)).toEqual([2, 2, 2]);
  }
  await page.setViewportSize({ width: 359, height: 1000 });
  await page.waitForTimeout(300);
  l = await layout(page);
  expect(rows(l)).toEqual([1, 1, 1, 1, 1, 1]);
  await page.setViewportSize({ width: 320, height: 1000 });
  await page.waitForTimeout(300);
  l = await layout(page);
  expect(rows(l)).toEqual([1, 1, 1, 1, 1, 1]);
  await page.setViewportSize({ width: 1440, height: 1000 });
});

test('a choice without a picture: Rows, the picture at the start; right to left, the zoom stays on the picture', async () => {
  await open('bare');
  for (const dir of ['ltr', 'rtl'] as const) {
    await page.evaluate((d) => document.documentElement.setAttribute('dir', d), dir);
    await page.waitForTimeout(200);
    const l = await loaded(1);
    expect(rows(l)).toEqual([1, 1]);
    const [pictured] = l.tiles;
    const { picture, caption, zoom } = pictured!;
    if (dir === 'ltr') expect(picture!.x + picture!.w).toBeLessThanOrEqual(caption.x + 1);
    else expect(caption.x + caption.w).toBeLessThanOrEqual(picture!.x + 1);
    expect(inside(zoom!, picture!)).toBe(true);
    // At the picture's top corner on the words' side, never in its middle.
    const gap = dir === 'ltr' ? picture!.x + picture!.w - (zoom!.x + zoom!.w) : zoom!.x - picture!.x;
    expect(gap).toBeLessThanOrEqual(12);
    expect(zoom!.y - picture!.y).toBeLessThanOrEqual(12);
  }
  await page.evaluate(() => document.documentElement.removeAttribute('dir'));
});

test('one choice takes the full width; a set of panoramas takes the full width', async () => {
  await open('one');
  let l = await loaded(1);
  expect(Math.abs(l.tiles[0]!.tile.w - l.room)).toBeLessThanOrEqual(1);
  await open('pano');
  l = await loaded(2);
  expect(rows(l)).toEqual([1, 1]);
  for (const t of l.tiles) expect(Math.abs(t.tile.w - l.room)).toBeLessThanOrEqual(1);
});

test('a small icon is never drawn past its own size; a picture that did not load says so, in a picture-sized box', async () => {
  await open('odd');
  const l = await loaded(2);
  const icon = l.tiles[0]!;
  expect(icon.natural).toBe(48);
  expect(icon.img!.w).toBeLessThanOrEqual(48);
  const failed = page.locator('section.ib-pane fieldset.question-block [data-question-picture-failed]');
  await expect(failed).toHaveCount(1);
  expect((await failed.boundingBox())!.height).toBeGreaterThanOrEqual(120);
  expect(await failed.evaluate((el) => getComputedStyle(el, '::before').content)).toContain('Picture didn’t load');
  // The words stay out of the choice's name.
  const card = page.locator('section.ib-pane fieldset.question-block');
  await expect(card.getByRole('radio', { name: /B · Gone/ })).toHaveCount(1);
  await expect(card.getByRole('radio', { name: /Picture didn/ })).toHaveCount(0);
});

/** The "No picture" panel a bare choice draws (null: none), and its height. */
const panelOf = (p: Page) => p.evaluate(() => {
  const label = document.querySelector('section.ib-pane fieldset.question-block [data-question-tile-no-picture] > label')!;
  const before = getComputedStyle(label, '::before');
  return before.content === 'none' || before.content === 'normal' ? null : { content: before.content, height: Math.round(parseFloat(before.height)) };
});

test('three pictures and a choice without one stay columns (the tour\'s picture step); the bare choice holds a short panel', async () => {
  await open('bare3');
  let l = await loaded(3);
  expect(l.room).toBeGreaterThanOrEqual(560);
  expect(rows(l)).toEqual([2, 2]);
  const [, , pictured, bare] = l.tiles;
  // Side by side, captions level (the row shares its picture height), the panel 120 px, never picture tall.
  expect(Math.abs(bare!.caption.y - pictured!.caption.y)).toBeLessThanOrEqual(1);
  const panel = await panelOf(page);
  expect(panel?.content).toContain('No picture');
  expect(panel!.height).toBe(120);
  // A phone: one column, and the bare choice draws no panel.
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.waitForTimeout(300);
  l = await layout(page);
  expect(rows(l)).toEqual([1, 1, 1, 1]);
  expect(await panelOf(page)).toBeNull();
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Two choices where one has no picture: Rows, no panel.
  await open('bare');
  await loaded(1);
  expect(await panelOf(page)).toBeNull();
});

test('three choices with pictures of mixed shapes stay columns in a middling room', async () => {
  await open('mixed3');
  await page.setViewportSize({ width: 1000, height: 1000 });
  await page.waitForTimeout(300);
  const l = await loaded(3);
  expect(l.room).toBeGreaterThanOrEqual(560);
  expect(l.room).toBeLessThan(900);
  expect(rows(l)).toEqual([2, 1]);
  await page.setViewportSize({ width: 1440, height: 1000 });
});

test('a recorded picture that fails to load leaves its set laid out as it was', async () => {
  await open('fails');
  // Both measured after a reload, so the window around the card is the same.
  const reload = async () => {
    await page.reload();
    await expect(page.locator('section.ib-pane fieldset.question-block [data-question-tile]').first()).toBeVisible();
  };
  await reload();
  const whole = await loaded(2);
  expect(whole.tiles.length).toBe(2);
  expect(rows(whole)).toEqual([2]);
  const fails = (u: URL) => u.href.includes('phone-fails');
  await page.route(fails, (route) => route.abort());
  try {
    await reload();
    await expect(page.locator('section.ib-pane fieldset.question-block [data-question-picture-failed]')).toHaveCount(1);
    const broken = await loaded(1);
    expect(broken.tiles.map((t) => t.tile)).toEqual(whole.tiles.map((t) => t.tile));
  } finally {
    await page.unroute(fails);
  }
});

test('a long strip on a phone: its box is tall enough to see, and the zoom stays on it', async () => {
  await page.setViewportSize({ width: 390, height: 1000 });
  try {
    await open('strip');
    const l = await loaded(2);
    for (const t of l.tiles) {
      expect(t.picture!.h).toBeGreaterThanOrEqual(40);
      expect(inside(t.zoom!, t.picture!)).toBe(true);
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
});
