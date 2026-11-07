/**
 * An attachment tile does not move when it is hovered or keyboard-focused
 * (owner, 2026-11-01: "on hover layoutshift and jumpy"). Proved in a real
 * browser against the compiled binary under a temp PLANNOTATOR_DATA_DIR:
 *
 *  - three image tiles (`1-one-pager-2x.png` ...) and a worst-case long name
 *    are sent as real PNG attachments; the tile, its name, its size line, its
 *    shortcut keycap and the tiles beside it keep exactly their boxes (and the
 *    thread keeps its scroll height) from rest to hover and to keyboard focus,
 *    in 3 columns, 2 columns, 1 column and beside an open file;
 *  - Open and the ⋯ show over the tile's right edge, inside it, while it is
 *    hovered or focused;
 *  - a name that fits at rest gets no full-name tooltip when hovered;
 *  - a screen without hover (a phone) shows Open with no hover at all.
 *
 * Rests and hovers are compared in the same run (the fonts differ between
 * machines), never against fixed pixels. Build the binary first (see
 * inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-attachment-hover.spec.ts`.
 * PNGs land in PLANNOTATOR_E2E_SHOTS_DIR (default .local/proof/attachment-hover).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/attachment-hover'));

const NAMES = ['1-one-pager-2x.png', '2-one-pager-2x.png', '3-one-pager-2x.png'];
const WORST = 'screenshot-2026-10-28-at-14.41.07-checkout-retry-banner-dark-mode-final-v3-annotated-2x.png';
const SIZES: [number, number][] = [
  [2200, 4054],
  [2200, 5890],
  [2200, 5684],
];

/** A real grey PNG of this size (a solid fill compresses to a few KB; the Inbox reads the dimensions from it). */
function png(width: number, height: number, grey: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8; // bit depth
  head[9] = 0; // grey
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, grey)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

interface World {
  url: string;
  context: BrowserContext;
  page: Page;
  claude: SimAgent;
  three: string;
  worst: string;
  beside: string;
}

let world: World;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-att-hover-');
  const dataDir = join(root, 'data');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'billing');
  mkdirSync(join(project, 'shots'), { recursive: true });
  mkdirSync(join(project, 'docs'), { recursive: true });
  NAMES.forEach((name, i) => writeFileSync(join(project, 'shots', name), png(SIZES[i]![0], SIZES[i]![1], 200 + i * 10)));
  writeFileSync(join(project, 'shots', WORST), png(1280, 800, 190));
  writeFileSync(join(project, 'shots', 'short.png'), png(640, 480, 180));
  writeFileSync(join(project, 'docs', 'retry-plan.md'), '# Retry plan\n\nRetry once with the same key.\n');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const three = await claude.send({ project_path: project, subject: 'Three one-pagers', thread: 'one-pagers', body: 'The three one-pagers, as images.', attachments: NAMES.map((n) => `shots/${n}`) });
  await new Promise((r) => setTimeout(r, 15));
  const worst = await claude.send({ project_path: project, subject: 'Worst-case names', thread: 'worst-names', body: 'A long name between short ones.', attachments: ['shots/short.png', `shots/${WORST}`, `shots/${NAMES[0]}`] });
  await new Promise((r) => setTimeout(r, 15));
  const beside = await claude.send({ project_path: project, subject: 'A plan beside images', thread: 'plan-beside', body: 'The plan, and its images.', attachments: ['docs/retry-plan.md', `shots/${NAMES[0]}`, `shots/${WORST}`] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  world = { url, context, page, claude, three: three.thread_id as string, worst: worst.thread_id as string, beside: beside.thread_id as string };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.claude.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface TileState {
  id: string;
  tile: Box;
  name: Box | null;
  kind: Box | null;
  chip: Box | null;
  /** The name's start is cut at rest (its tooltip is for that). */
  open: { box: Box; opacity: number; position: string } | null;
  more: { box: Box; opacity: number } | null;
}
interface Snapshot {
  tiles: TileState[];
  scrollHeight: number;
  scroll: [number, number];
  columns: number;
  kindLines: number[];
}

/** Every file tile of the thread in view: its boxes and the thread's scroll height. */
async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const box = (el: Element | null | undefined): Box | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const containers = [...document.querySelectorAll('.ib-atts.ib-tiles')].filter((c) => (c as HTMLElement).offsetParent !== null);
    const container = containers[containers.length - 1]!;
    const tiles = [...container.querySelectorAll<HTMLElement>('.ib-att-t[data-attachment-id]')].map((tile) => {
      const open = tile.querySelector<HTMLElement>('.ib-open');
      const wrap = tile.closest('.ib-att-w');
      const more = wrap?.querySelector<HTMLElement>('.ib-att-more') ?? null;
      return {
        id: tile.dataset.attachmentId!,
        tile: box(tile)!,
        name: box(tile.querySelector('.ib-fname')),
        kind: box(tile.querySelector('.ib-kd')),
        chip: box(tile.querySelector('.ib-att-kbd')),
        open: open ? { box: box(open)!, opacity: Number(getComputedStyle(open).opacity), position: getComputedStyle(open).position } : null,
        more: more ? { box: box(more)!, opacity: Number(getComputedStyle(more).opacity) } : null,
      };
    });
    const first = tiles[0]?.tile.y ?? 0;
    const body = container.closest('.ib-pbody') as HTMLElement | null;
    return {
      tiles,
      scrollHeight: body?.scrollHeight ?? document.documentElement.scrollHeight,
      scroll: [body?.scrollLeft ?? 0, body?.scrollTop ?? 0] as [number, number],
      columns: tiles.filter((t) => Math.abs(t.tile.y - first) < 2).length,
      kindLines: [...container.querySelectorAll<HTMLElement>('.ib-att-t .ib-kd')].map((k) => Math.round(k.getBoundingClientRect().height / parseFloat(getComputedStyle(k).lineHeight || '16'))),
    };
  });
}

const within = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;
const same = (a: Box | null, b: Box | null) => (a === null || b === null ? a === b : within(a.x, b.x) && within(a.y, b.y) && within(a.w, b.w) && within(a.h, b.h));

async function park(page: Page): Promise<void> {
  // The far corner: the window's left edge reveals the hidden sidebar over the tiles.
  const size = page.viewportSize()!;
  await page.mouse.move(size.width - 6, size.height - 6);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Compares the tile `index` hovered, and focused from the keyboard, with rest: nothing moved, nothing resized. */
async function proveStill(page: Page, index: number, label: string): Promise<{ rest: Snapshot; hover: Snapshot }> {
  await park(page);
  const id = (await snapshot(page)).tiles[index]!.id;
  const tileLoc = page.locator(`.ib-atts.ib-tiles [data-attachment-id="${id}"]`).last();
  // In view, clear of the reply box at the pane's foot.
  await tileLoc.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(250);
  const rest = await snapshot(page);
  // The pointer goes to the tile where it stands (no scrolling it into view: a scroll would move every tile alike and hide a shift).
  const at = (await tileLoc.boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.waitForTimeout(450);
  const hover = await snapshot(page);
  const shifts = (a: Snapshot, b: Snapshot) => {
    const out: string[] = [];
    a.tiles.forEach((t, i) => {
      const u = b.tiles[i]!;
      for (const part of ['tile', 'name', 'kind', 'chip'] as const) if (!same(t[part], u[part])) out.push(`${i}.${part} ${JSON.stringify(t[part])} -> ${JSON.stringify(u[part])}`);
    });
    if (a.scrollHeight !== b.scrollHeight) out.push(`scrollHeight ${a.scrollHeight} -> ${b.scrollHeight}`);
    if (a.scroll.join() !== b.scroll.join()) out.push(`scroll ${a.scroll} -> ${b.scroll}`);
    return out;
  };
  expect(shifts(rest, hover), `${label}: hovering tile ${index} moved something`).toEqual([]);
  // Open sits inside the hovered tile, shown.
  const t = hover.tiles[index]!;
  expect(t.open, label).not.toBeNull();
  const under = await page.evaluate(([x, y]) => {
    const e = document.elementFromPoint(x!, y!);
    return `${e?.tagName}.${e?.className} in ${e?.closest('[data-attachment-id]')?.getAttribute('data-attachment-id')} (viewport ${innerHeight})`;
  }, [at.x + at.width / 2, at.y + at.height / 2]);
  expect(t.open!.opacity, `${label}: Open shows on hover (the pointer is on ${under}; the tile is ${id})`).toBe(1);
  expect(t.open!.box.x + t.open!.box.w, label).toBeLessThanOrEqual(t.tile.x + t.tile.w + 0.5);
  expect(t.open!.box.x, label).toBeGreaterThanOrEqual(t.tile.x);
  if (t.more) expect(t.more.opacity, `${label}: the ⋯ shows on hover`).toBe(1);
  // The name that fits at rest has no tooltip; one that is cut at rest does.
  const cutAtRest = await tileLoc.evaluate((tile) => {
    const h = tile.querySelector('.ib-fname-h') as HTMLElement | null;
    return !!h && h.scrollWidth > h.clientWidth;
  });
  const tips = page.locator('[data-pn-tooltip]').filter({ hasText: /\.png/ });
  if (!cutAtRest) expect(await tips.count(), `${label}: no tooltip for a name that fits`).toBe(0);
  // The keyboard: Tab-style focus shows Open the same way.
  await park(page);
  await page.keyboard.press('Shift');
  await tileLoc.focus({ timeout: 5000 });
  await expect(tileLoc).toBeFocused();
  await page.waitForTimeout(450);
  const focus = await snapshot(page);
  expect(shifts(rest, focus), `${label}: focusing tile ${index} moved something`).toEqual([]);
  expect(focus.tiles[index]!.open!.opacity, `${label}: Open shows on focus`).toBe(1);
  await park(page);
  return { rest, hover };
}

async function openThread(page: Page, id: string, width: number, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(`${world.url}#thread=${id}`);
  await expect(page.locator('.ib-atts.ib-tiles .ib-att-t').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

for (const [label, width, columns] of [
  ['3 columns', 1670, 3],
  ['2 columns', 1330, 2],
] as const) {
  test(`${label}: hovering or focusing a tile moves and resizes nothing, the tiles beside it included`, async () => {
    const { page } = world;
    await openThread(page, world.three, width);
    const rest = await snapshot(page);
    expect(rest.columns, 'the layout this test means').toBe(columns);
    console.log(`[${label}] tile ${JSON.stringify(rest.tiles[0]!.tile)} name ${JSON.stringify(rest.tiles[0]!.name)} kind ${JSON.stringify(rest.tiles[0]!.kind)} chip ${JSON.stringify(rest.tiles[0]!.chip)}`);
    for (let i = 0; i < rest.tiles.length; i++) await proveStill(page, i, `${label} (${NAMES[i]})`);
    await park(page);
    await page.screenshot({ path: join(shotsDir, `${width}-rest.png`) });
    await page.locator(`.ib-atts.ib-tiles [data-attachment-id="${rest.tiles[0]!.id}"]`).last().hover();
    await page.waitForTimeout(450);
    await page.screenshot({ path: join(shotsDir, `${width}-hover.png`) });
  });
}

test('one column: hovering moves nothing', async () => {
  const { page } = world;
  await openThread(page, world.three, 1150);
  const rest = await snapshot(page);
  expect(rest.columns).toBe(1);
  for (let i = 0; i < rest.tiles.length; i++) await proveStill(page, i, `one column (${NAMES[i]})`);
});

test('the worst-case long name: hovering moves nothing, and its tooltip is for the cut it has at rest', async () => {
  const { page } = world;
  await openThread(page, world.worst, 1640);
  const rest = await snapshot(page);
  const loc = page.locator(`.ib-atts.ib-tiles [data-attachment-name="${WORST}"]`).last();
  const target = await loc.getAttribute('data-attachment-id');
  const at = rest.tiles.findIndex((t) => t.id === target);
  expect(at).toBeGreaterThanOrEqual(0);
  const cut = await loc.evaluate((tile) => {
    const h = tile.querySelector('.ib-fname-h') as HTMLElement;
    return h.scrollWidth > h.clientWidth;
  });
  expect(cut, 'the long name is cut at rest').toBe(true);
  await proveStill(page, at, 'worst-case name');
  await park(page);
  await loc.hover();
  await expect(page.locator('[data-pn-tooltip]').filter({ hasText: WORST }).first()).toBeVisible();
  await page.screenshot({ path: join(shotsDir, 'long-name-hover.png') });
});

test('beside an open file (the side-by-side pane): hovering another tile moves nothing', async () => {
  const { page } = world;
  await page.setViewportSize({ width: 1640, height: 1400 });
  await page.goto(`${world.url}#thread=${world.beside}`);
  await page.locator('.ib-atts.ib-tiles [data-attachment-name="retry-plan.md"]').last().click();
  await expect(page.locator('.ib-pane.ib-withfile')).toBeVisible();
  await expect(page.locator('.ib-pane.ib-withfile .ib-att-t[data-attachment-id]').first()).toBeVisible();
  // The pane slides open: rest is after it has settled (two reads alike).
  await expect
    .poll(async () => {
      const a = await snapshot(page);
      await page.waitForTimeout(150);
      const b = await snapshot(page);
      return same(a.tiles[0]!.tile, b.tiles[0]!.tile);
    })
    .toBe(true);
  const rest = await snapshot(page);
  const images = rest.tiles.map((t, i) => [t, i] as const).filter(([, i]) => i > 0);
  expect(images.length).toBeGreaterThan(0);
  for (const [, i] of images) await proveStill(page, i, `beside a file (tile ${i})`);
  await page.screenshot({ path: join(shotsDir, 'side-by-side-rest.png') });
});

test('a screen without hover shows Open with no hover at all', async ({ browser }) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  try {
    const page = await phone.newPage();
    await page.goto(`${world.url}#thread=${world.three}`);
    await expect(page.locator('.ib-atts.ib-tiles .ib-att-t').first()).toBeVisible();
    const rest = await snapshot(page);
    expect(rest.columns).toBe(1);
    for (const t of rest.tiles) {
      expect(t.open!.opacity).toBe(1);
      expect(t.open!.box.x + t.open!.box.w).toBeLessThanOrEqual(t.tile.x + t.tile.w + 0.5);
    }
    await page.screenshot({ path: join(shotsDir, 'phone.png') });
  } finally {
    await phone.close();
  }
});
