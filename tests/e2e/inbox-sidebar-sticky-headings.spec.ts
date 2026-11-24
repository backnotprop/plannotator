/**
 * The sidebar's section headings stay at the top of its one scroll while their own rows pass under them, and the next
 * heading pushes them off (approval "inbox-sidebar-sticky-headings"), on a computer as on a phone's sheet. Proved in a
 * real Chromium against the compiled binary under a temp HOME and data dir, with enough projects and stars to scroll:
 * a heading stuck at the top is opaque on the sidebar's ground with its hairline; all the way down and back, two
 * headings never overlap, a heading leaving is pushed by the next, and the stuck heading's line and the header's line
 * never show at once; a heading pressed while stuck folds its section and stays at the top. When everything fits,
 * nothing sticks and no line shows (the spacing itself: inbox-sidebar-spacing.spec.ts).
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
        side: getComputedStyle(document.querySelector(`${selector} .ib-side`)!).backgroundColor,
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
