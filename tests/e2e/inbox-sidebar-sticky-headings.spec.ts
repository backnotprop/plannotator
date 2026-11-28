/**
 * The sidebar's section headings stay at the top of its one scroll while their own rows pass under them, and the next
 * heading pushes them off (approval "inbox-sidebar-sticky-headings"), on a computer as on a phone's sheet. Proved in a
 * real Chromium against the compiled binary under a temp HOME and data dir, with enough projects and stars to scroll:
 * a heading stuck at the top is opaque on the sidebar's ground with its hairline; all the way down and back, two
 * headings never overlap, a heading leaving is pushed by the next, and the stuck heading's line and the header's line
 * never show at once; a heading pressed while stuck folds its section and stays at the top. When everything fits,
 * nothing sticks and no line shows (the spacing itself: inbox-sidebar-spacing.spec.ts). Nothing scrolls sideways; a
 * row Shift+Tab reaches comes out below the stuck heading, never under it; the scrollbar's strip is clear of the
 * sidebar's resize edge, so pressing and dragging there never resizes or closes the sidebar; and dark mode keeps the
 * stuck heading opaque on its own ground (screenshots in the proof folder, `sidebar-sticky/`).
 *
 * Build the binary first (see inbox.spec.ts).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'sidebar-sticky');
const CLOSED_COOKIE = 'plannotator-inbox-sidebar-closed';
const NAMES = ['harbor', 'fern-api', 'quill-docs', 'ledger', 'harbor-web', 'fern-docs', 'quill-api', 'ledger-sync', 'harbor-ios', 'fern-tests', 'quill-cli', 'ledger-perf', 'harbor-e2e', 'fern-bot', 'quill-ui', 'ledger-tests'];

interface World {
  url: string;
  agent: SimAgent;
  context: BrowserContext;
  page: Page;
}
let world: World;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  const root = inboxScratch('plannotator-inbox-sticky-e2e-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(home);
  mkdirSync(proofDir, { recursive: true });
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    NO_ANON_PING: '1',
  };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim();
  const agent = await SimAgent.connect({ binary: builtBinary, env, name: 'Claude Code', host: 'claude-code' });
  const threads: string[] = [];
  for (const name of NAMES) {
    const sent = await agent.send({ project_path: scratchProject(join(root, 'src'), name), subject: `Status of ${name}`, body: 'The build passed.' });
    threads.push(sent.thread_id as string);
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 600 } });
  const page = await context.newPage();
  await page.goto(url);
  // Eight stars: Starred is long enough to scroll under its own heading.
  const statuses = await page.evaluate(async (ids) => {
    const list = (await (await fetch('/api/inbox/threads?archived=exclude')).json()) as { serverSession: string };
    const out: number[] = [];
    for (const id of ids) {
      const res = await fetch(`/api/inbox/threads/${id}/pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: list.serverSession, pinned: true }) });
      out.push(res.status);
    }
    return out;
  }, threads.slice(0, 8));
  for (const status of statuses) expect(status).toBeLessThan(300);
  world = { url, agent, context, page };
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
    await world?.context.close();
  } finally {
    await removeInboxScratch();
  }
});

async function open(phone: boolean, size?: { width: number; height: number }): Promise<string> {
  const { context, page, url } = world;
  await context.clearCookies({ name: CLOSED_COOKIE });
  await page.setViewportSize(size ?? (phone ? { width: 390, height: 844 } : { width: 1280, height: 600 }));
  await page.goto('about:blank');
  await page.goto(url);
  const scope = phone ? '[role="dialog"]' : '[aria-label="Inbox navigation"]';
  if (phone) await page.locator('.ib-lhead').getByRole('button', { name: 'Toggle Sidebar' }).click();
  await expect(page.locator(`${scope} [data-sidebar-section="pinned"]`)).toBeVisible();
  await expect(page.locator(`${scope} .ib-projs .ib-proj`)).toHaveCount(NAMES.length);
  return scope;
}

interface Heading {
  name: string;
  top: number;
  bottom: number;
  stuck: boolean;
}
interface Frame {
  at: number;
  edge: boolean;
  heads: Heading[];
}

/** Scrolls the sidebar to each place in turn and reads, after the browser has drawn it, where each heading is and what is marked. */
const sweep = (page: Page, scope: string, places: number[] | 'all') =>
  page.evaluate(
    async ({ selector, places }) => {
      const scroll = document.querySelector<HTMLElement>(`${selector} .ib-sidescroll`)!;
      const max = scroll.scrollHeight - scroll.clientHeight;
      const list = places === 'all' ? [...Array.from({ length: Math.ceil(max / 3) + 1 }, (_, i) => Math.min(i * 3, max)), ...Array.from({ length: Math.ceil(max / 3) + 1 }, (_, i) => Math.max(max - i * 3, 0))] : places;
      const frames: Frame[] = [];
      for (const place of list) {
        scroll.scrollTop = place;
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        const top = scroll.getBoundingClientRect().top;
        frames.push({
          at: scroll.scrollTop,
          edge: scroll.hasAttribute('data-edge'),
          heads: [...scroll.querySelectorAll<HTMLElement>('.ib-secrow')].map((row) => ({
            name: row.querySelector('[data-sidebar-section]')!.getAttribute('data-sidebar-section')!,
            top: row.getBoundingClientRect().top - top,
            bottom: row.getBoundingClientRect().bottom - top,
            stuck: row.hasAttribute('data-stuck'),
          })),
        });
      }
      return { max, frames };
    },
    { selector: scope, places },
  );

for (const [device, phone] of [['computer', false], ['phone', true]] as const) {
  test(`${device}: a heading stays at the top, opaque with its hairline, while its rows pass under it`, async () => {
    const { page } = world;
    const scope = await open(phone);
    const { max, frames } = await sweep(page, scope, [0]);
    expect(max).toBeGreaterThan(200);
    // At rest: nothing stuck, no line.
    expect(frames[0]!.heads.some((head) => head.stuck)).toBe(false);
    expect(frames[0]!.edge).toBe(false);
    // All the way down: Projects at the top, stuck, and the projects' rows under it.
    const end = (await sweep(page, scope, [max])).frames[0]!;
    const projects = end.heads.find((head) => head.name === 'projects')!;
    expect(Math.abs(projects.top)).toBeLessThanOrEqual(1);
    expect(end.heads.filter((head) => head.stuck).map((head) => head.name)).toEqual(['projects']);
    expect(end.edge).toBe(false);
    const look = await page.evaluate((selector) => {
      const row = document.querySelector(`${selector} .ib-sidescroll .ib-secrow:has([data-sidebar-section="projects"])`)!;
      const quiet = document.querySelector(`${selector} .ib-sidescroll .ib-secrow:has([data-sidebar-section="pinned"])`)!;
      const ground = getComputedStyle(row, '::before');
      return {
        position: getComputedStyle(row).position,
        ground: ground.backgroundColor,
        side: getComputedStyle(document.querySelector(`${selector}.ib-side, ${selector} .ib-side`)!).backgroundColor,
        line: ground.boxShadow,
        quietLine: getComputedStyle(quiet, '::before').boxShadow,
        // Computer names scroll with the rows: only section headings stick.
        captions: [...document.querySelectorAll(`${selector} .ib-agents-cap`)].map((cap) => getComputedStyle(cap).position),
      };
    }, scope);
    expect(look.position).toBe('sticky');
    expect(look.ground).toBe(look.side);
    expect(look.ground).not.toMatch(/rgba\(.*, 0\)|transparent/);
    expect(look.line).not.toBe('none');
    expect(look.quietLine).toBe('none');
    for (const position of look.captions) expect(position).not.toBe('sticky');
  });

  test(`${device}: down and back, headings never overlap, the next one pushes a heading off, and the two lines never show at once`, async () => {
    const { page } = world;
    const scope = await open(phone);
    const { frames } = await sweep(page, scope, 'all');
    let pushed = 0;
    for (const frame of frames) {
      const marks = frame.heads.filter((head) => head.stuck).length + (frame.edge ? 1 : 0);
      // Scrolled, exactly one line under the header (a heading's or the header's own); at rest, none.
      expect(marks, `at ${frame.at}`).toBe(frame.at > 0 ? 1 : 0);
      for (let i = 1; i < frame.heads.length; i++) {
        const before = frame.heads[i - 1]!;
        const next = frame.heads[i]!;
        expect(before.bottom, `at ${frame.at}: ${before.name} over ${next.name}`).toBeLessThanOrEqual(next.top + 0.5);
        // Half off the top: the next heading is what pushes it.
        if (before.top < -1 && before.bottom > 1) {
          pushed++;
          expect(next.top - before.bottom, `at ${frame.at}: ${before.name} pushed by ${next.name}`).toBeLessThanOrEqual(12.5);
        }
      }
    }
    expect(pushed).toBeGreaterThan(0);
  });

  test(`${device}: a heading pressed while stuck folds its section and stays at the top`, async () => {
    const { page } = world;
    const scope = await open(phone);
    // Down into Starred, 60 px past its heading: its heading stuck, its rows under it.
    const into = await page.evaluate((selector) => {
      const scroll = document.querySelector<HTMLElement>(`${selector} .ib-sidescroll`)!;
      const block = document.querySelector(`${selector} .ib-sidescroll .ib-secrow:has([data-sidebar-section="pinned"])`)!.parentElement!;
      return Math.round(block.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop + 60);
    }, scope);
    const { frames } = await sweep(page, scope, [into]);
    const starred = frames[0]!.heads.find((head) => head.name === 'pinned')!;
    expect(starred.stuck).toBe(true);
    const heading = page.locator(`${scope} [data-sidebar-section="pinned"]`);
    await heading.click({ position: { x: 30, y: 12 } });
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
    await expect
      .poll(() => page.evaluate((selector) => {
        const scroll = document.querySelector(`${selector} .ib-sidescroll`)!;
        const row = document.querySelector(`${selector} .ib-sidescroll .ib-secrow:has([data-sidebar-section="pinned"])`)!;
        return Math.round(row.getBoundingClientRect().top - scroll.getBoundingClientRect().top);
      }, scope))
      .toBe(0);
  });

  test(`${device}: nothing scrolls sideways, at rest or with a heading stuck`, async () => {
    const { page } = world;
    const scope = await open(phone);
    const { max } = await sweep(page, scope, [0]);
    for (const place of [0, Math.round(max / 2), max]) {
      const { frames } = await sweep(page, scope, [place]);
      const sides = await page.evaluate((selector) => {
        const scroll = document.querySelector<HTMLElement>(`${selector} .ib-sidescroll`)!;
        return { scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth };
      }, scope);
      expect(sides.scrollWidth, `at ${frames[0]!.at}`).toBe(sides.clientWidth);
    }
  });

  test(`${device}: a row Shift+Tab reaches comes out below the stuck heading, never under it`, async () => {
    const { page } = world;
    const scope = await open(phone);
    // The fifth project's top 15 px into the scroll's top: under the stuck Projects heading.
    const into = await page.evaluate((selector) => {
      const scroll = document.querySelector<HTMLElement>(`${selector} .ib-sidescroll`)!;
      const row = document.querySelectorAll<HTMLElement>(`${selector} .ib-projs .ib-proj`)[4]!;
      return Math.round(row.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop + 15);
    }, scope);
    const { frames } = await sweep(page, scope, [into]);
    const projects = frames[0]!.heads.find((head) => head.name === 'projects')!;
    expect(projects.stuck).toBe(true);
    const hidden = await page.evaluate((selector) => {
      const scroll = document.querySelector<HTMLElement>(`${selector} .ib-sidescroll`)!;
      const top = scroll.getBoundingClientRect().top;
      const head = scroll.querySelector('.ib-secrow:has([data-sidebar-section="projects"])')!.getBoundingClientRect().bottom - top;
      const rows = [...document.querySelectorAll<HTMLElement>(`${selector} .ib-projs .ib-proj`)];
      const under = rows.findIndex((row) => row.getBoundingClientRect().top - top < head && row.getBoundingClientRect().bottom - top > 0);
      rows[under + 1]!.focus({ preventScroll: true });
      return { under, name: rows[under]!.textContent };
    }, scope);
    expect(hidden.under).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('Shift+Tab');
    await expect
      .poll(() =>
        page.evaluate((selector) => {
          const scroll = document.querySelector<HTMLElement>(`${selector} .ib-sidescroll`)!;
          const box = scroll.getBoundingClientRect();
          const focused = document.activeElement as HTMLElement;
          const row = (focused.closest('.ib-projrow') ?? focused.closest('.ib-proj') ?? focused).getBoundingClientRect();
          // Whole inside the scroll, and no heading over it.
          const covered = [...scroll.querySelectorAll('.ib-secrow')].some((head) => {
            const r = head.getBoundingClientRect();
            return r.bottom > box.top && r.bottom - 0.5 > row.top && r.top + 0.5 < row.bottom;
          });
          return { name: focused.closest('.ib-projrow, .ib-proj')?.textContent ?? '', inside: row.top >= box.top - 0.5 && row.bottom <= box.bottom + 0.5, covered };
        }, scope),
      )
      .toEqual({ name: expect.stringContaining(hidden.name!.trim()), inside: true, covered: false });
  });
}

test('computer: the scrollbar strip is clear of the resize edge: pressing and dragging there never resizes or closes the sidebar', async () => {
  const { page } = world;
  const scope = await open(false);
  const strip = await page.evaluate((selector) => {
    const side = document.querySelector<HTMLElement>(`${selector}.ib-side, ${selector} .ib-side`)!.getBoundingClientRect();
    const scroll = document.querySelector<HTMLElement>(`${selector} .ib-sidescroll`)!;
    const box = scroll.getBoundingClientRect();
    // The sidebar's own edge: the hit zone nearest its right side.
    const hit = [...document.querySelectorAll('.ib-handle-hit')].map((el) => el.getBoundingClientRect()).sort((a, b) => Math.abs(a.left + a.width / 2 - side.right) - Math.abs(b.left + b.width / 2 - side.right))[0]!;
    // A classic scrollbar is up to 16 px wide: every point of that strip belongs to the scroll, none to the edge.
    const handles: number[] = [];
    for (let x = Math.floor(box.right) - 16; x < box.right; x++) {
      for (const y of [box.top + 20, box.top + box.height / 2, box.bottom - 20]) {
        if (document.elementFromPoint(x, y)?.closest('.ib-handle-hit')) handles.push(x);
      }
    }
    // Where to press: the scroll's own strip at its right side (where its scrollbar's thumb is drawn), not a row.
    let y = box.top + 30;
    for (let at = box.top + 10; at < box.bottom - 10; at += 4) {
      if (document.elementFromPoint(box.right - 1, at) === scroll) {
        y = at;
        break;
      }
    }
    return { right: box.right, hitLeft: hit.left, handles, width: side.width, x: box.right - 1, y };
  }, scope);
  expect(strip.right).toBeLessThanOrEqual(strip.hitLeft);
  expect(strip.handles).toEqual([]);
  await page.mouse.move(strip.x, strip.y);
  await page.mouse.down();
  await page.mouse.move(strip.x + 30, strip.y + 80, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(`${scope} .ib-sidescroll`)).toBeVisible();
  const width = await page.evaluate((selector) => document.querySelector<HTMLElement>(`${selector}.ib-side, ${selector} .ib-side`)!.getBoundingClientRect().width, scope);
  expect(width).toBe(strip.width);
});

for (const [device, phone] of [['computer', false], ['phone', true]] as const) {
  test(`${device}, dark: a stuck heading is opaque on the dark ground, with its hairline`, async () => {
    const { page } = world;
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    try {
      const scope = await open(phone);
      const into = await page.evaluate((selector) => {
        const scroll = document.querySelector<HTMLElement>(`${selector} .ib-sidescroll`)!;
        const block = document.querySelector(`${selector} .ib-sidescroll .ib-secrow:has([data-sidebar-section="pinned"])`)!.parentElement!;
        return Math.round(block.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop + 60);
      }, scope);
      const { frames } = await sweep(page, scope, [into]);
      expect(frames[0]!.heads.find((head) => head.name === 'pinned')!.stuck).toBe(true);
      const look = await page.evaluate((selector) => {
        const row = document.querySelector(`${selector} .ib-sidescroll .ib-secrow:has([data-sidebar-section="pinned"])`)!;
        const ground = getComputedStyle(row, '::before');
        return { ground: ground.backgroundColor, side: getComputedStyle(document.querySelector(`${selector}.ib-side, ${selector} .ib-side`)!).backgroundColor, line: ground.boxShadow, dark: matchMedia('(prefers-color-scheme: dark)').matches };
      }, scope);
      expect(look.dark).toBe(true);
      expect(look.ground).toBe(look.side);
      expect(look.ground).not.toMatch(/rgba\(.*, 0\)|transparent/);
      expect(look.line).not.toBe('none');
      if (!phone) await page.mouse.move(1000, 500);
      await page.screenshot({ path: join(proofDir, `${device}-starred-stuck-dark.png`) });
    } finally {
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    }
  });
}

test('computer: when everything fits nothing sticks and no line shows', async () => {
  const { page } = world;
  const scope = await open(false, { width: 1280, height: 1800 });
  const { max, frames } = await sweep(page, scope, [0]);
  expect(max).toBeLessThanOrEqual(0);
  expect(frames[0]!.edge).toBe(false);
  expect(frames[0]!.heads.some((head) => head.stuck)).toBe(false);
  const line = await page.evaluate((selector) => getComputedStyle(document.querySelector(`${selector} .ib-sidescroll`)!, '::before').backgroundColor, scope);
  expect(line).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
});
