/**
 * What the person is looking at in the Inbox's review stays where it is, frame by frame, while the semantic notes
 * land and the files change height: the row they just opened, else a comment box being written, else the first row
 * at the top of the view. A table of layouts, run in Chromium (`inbox-keep-place.spec.ts`) and WebKit
 * (`inbox-keep-place-webkit.spec.ts`) against the compiled binary's Inbox, with a simulated agent submitting a review
 * of a scratch repository. The one shift allowed is the one a scroll limit forces, and the case proves it.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { grows, shrinks, totals } from './keep-place-fixtures';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

type Files = Record<string, string>;

function pr(entries: [string, [string, string]][]): { paths: string[]; base: Files; head: Files; swapping: string[] } {
  return {
    paths: entries.map(([path]) => path),
    base: Object.fromEntries(entries.map(([path, [base]]) => [path, base])),
    head: Object.fromEntries(entries.map(([path, [, head]]) => [path, head])),
    swapping: entries.filter(([path]) => !/totals|list/.test(path)).map(([path]) => path),
  };
}

const THREE = pr([
  ['src/money.ts', shrinks('money')],
  ['src/validators.ts', grows('validators')],
  ['src/totals.ts', [totals('total', false), totals('total', true)]],
]);
const SIX = pr([
  ['src/money.ts', shrinks('money')],
  ['src/validators.ts', grows('validators')],
  ['src/totals.ts', [totals('total', false), totals('total', true)]],
  ['src/dates.ts', shrinks('dates')],
  ['src/names.ts', grows('names')],
  ['src/a-list.ts', [totals('item', false), totals('item', true)]],
]);

type Place = { file: string; edge: 'top' | 'bottom' | 'label'; at: number } | { pageTop: number };
export interface Case {
  name: string;
  six?: boolean;
  viewport?: { width: number; height: number };
  zoom?: number;
  phone?: boolean;
  slow?: boolean;
  fast?: boolean;
  place: Place;
  open?: 'label' | 'arrow';
  limit?: boolean;
}

export const CASES: Case[] = [
  { name: 'label pressed before the notes, slow reads', slow: true, place: { file: 'src/totals.ts', edge: 'label', at: 640 }, open: 'label' },
  { name: 'arrow pressed before the notes, slow reads', slow: true, place: { file: 'src/totals.ts', edge: 'label', at: 640 }, open: 'arrow' },
  { name: 'label pressed at once, no delays', fast: true, place: { file: 'src/totals.ts', edge: 'label', at: 640 }, open: 'label' },
  { name: 'money.ts in the middle of a 1440x500 view, nothing opened', slow: true, viewport: { width: 1440, height: 500 }, place: { file: 'src/money.ts', edge: 'top', at: 200 } },
  { name: 'a growing file (names.ts) crossing the top edge', six: true, slow: true, place: { file: 'src/names.ts', edge: 'top', at: -60 } },
  { name: 'money.ts crossing the top edge', slow: true, place: { file: 'src/money.ts', edge: 'top', at: -120 } },
  { name: 'money.ts crossing the top edge, lines opened below it', slow: true, place: { file: 'src/money.ts', edge: 'top', at: -500 }, open: 'label' },
  { name: 'a 20 px sliver of a growing file (names.ts) showing', six: true, slow: true, place: { file: 'src/names.ts', edge: 'bottom', at: 20 } },
  { name: 'the swapping files wholly above', slow: true, place: { file: 'src/totals.ts', edge: 'top', at: -40 } },
  { name: 'the swapping files wholly below', slow: true, viewport: { width: 1440, height: 500 }, six: true, place: { file: 'src/a-list.ts', edge: 'top', at: 100 } },
  { name: 'near the top of the page, at its scroll limit', slow: true, place: { pageTop: 20 }, limit: true },
  { name: '6 files, middle of the page, zoom 110%', six: true, slow: true, zoom: 1.1, place: { file: 'src/totals.ts', edge: 'top', at: 300 } },
  { name: '6 files, middle of the page, zoom 90%', six: true, slow: true, zoom: 0.9, place: { file: 'src/totals.ts', edge: 'top', at: 300 } },
  { name: '6 files, a row inside a file that is itself swapping', six: true, slow: true, place: { file: 'src/dates.ts', edge: 'top', at: -60 } },
  { name: 'phone, a tap on the arrow', phone: true, slow: true, place: { file: 'src/totals.ts', edge: 'label', at: 500 }, open: 'arrow' },
];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

function commitAll(dir: string, files: Files, message: string) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', 'commit', '-q', '-m', message);
}

export interface World {
  url: string;
  root: string;
  browser: Browser;
  claude: SimAgent;
}

export function inboxWorld(): () => World {
  let world: World;
  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
    const root = inboxScratch('plannotator-inbox-keep-place-e2e-');
    const dataDir = join(root, 'data');
    markTourDecided(dataDir);
    for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: root,
      PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_INBOX_CONNECT: '0',
      PLANNOTATOR_UPDATE_CHECK: '0',
      PLANNOTATOR_BROWSER: NO_BROWSER,
      NO_ANON_PING: '1',
      PLANNOTATOR_INBOX_NOTES: '0',
      PLANNOTATOR_TEST_SANDBOX: '1',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CODEX_HOME: join(root, 'codex'),
      XDG_CONFIG_HOME: join(root, 'xdg'),
    };
    const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(started.status, started.stderr).toBe(0);
    rememberInboxOf(dataDir);
    const url = started.stdout.trim();
    const settings = await (await browser.newContext()).request.post(`${url}api/inbox/settings`, { data: { code_review: { on: true } } });
    expect(settings.ok()).toBe(true);
    world = { url, root, browser, claude: await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' }) };
  });
  test.afterAll(async () => {
    await world?.claude.close().catch(() => {});
    await removeInboxScratch();
  });
  return () => world;
}

let projects = 0;

export async function openReview(world: World, title: string, options: { six?: boolean; viewport?: Case['viewport']; phone?: boolean; slow?: boolean; zoom?: number }) {
  const shape = options.six ? SIX : THREE;
  const project = scratchProject(join(world.root, 'src'), `shop${++projects}`);
  git(project, 'checkout', '-q', '-b', 'main');
  commitAll(project, shape.base, 'base');
  git(project, 'checkout', '-q', '-b', 'change');
  commitAll(project, shape.head, 'change');
  const review = await world.claude.submitGuide({
    project_path: project,
    guide: {
      title,
      intent: 'Reading it.',
      sections: [{ title: 'All', overview: 'Every file.', diffs: shape.paths.map((file) => ({ file, summary: 'A change.' })) }],
      review: { gitRef: 'main...HEAD', base: 'main' },
      generator: { engine: 'claude-code', model: 'claude-opus-5' },
    },
    patch: git(project, 'diff', 'main...HEAD'),
    body: 'Reading it.',
    review: true,
  } as never);
  const context: BrowserContext = await world.browser.newContext(
    options.phone
      ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: world.browser.browserType().name() === 'chromium', colorScheme: 'light' }
      : options.zoom
        ? { viewport: { width: Math.round(1440 / options.zoom), height: Math.round(900 / options.zoom) }, deviceScaleFactor: options.zoom, colorScheme: 'light' }
        : { viewport: options.viewport ?? { width: 1440, height: 900 }, colorScheme: 'light' },
  );
  const page = await context.newPage();
  const swapping = new RegExp(shape.swapping.map((path) => path.replace(/^src\//, '').replace('.', '\\.')).join('|'));
  if (options.slow) {
    await page.route('**/guide/file?*', async (route) => {
      if (swapping.test(decodeURIComponent(route.request().url()))) await new Promise((done) => setTimeout(done, 1_500));
      await route.continue().catch(() => {});
    });
    await page.route('**/assets/sem-diff/**', async (route) => {
      await new Promise((done) => setTimeout(done, 800));
      await route.continue().catch(() => {});
    });
  }
  await page.goto(`${world.url}#thread=${review.thread_id}`);
  await page.locator('[data-review-card]').filter({ hasText: title }).first().getByRole('button', { name: 'Start review' }).click();
  const pane = page.locator('[data-review-message]');
  await expect(pane.locator('[data-guide-file-shell]')).toHaveCount(shape.paths.length, { timeout: 60_000 });
  if (!options.phone) {
    await pane.locator('[data-review-mode-choice="files"]').click();
    await expect(pane).toHaveAttribute('data-review-mode', 'files');
  }
  return { context, page, notes: shape.swapping.length };
}

export const PAGE = '.ib-gbody';

const opener = (page: Page, which: 'label' | 'arrow') =>
  page.evaluate((which) => {
    const host = document.querySelector('[data-guide-file-shell="src/totals.ts"] diffs-container');
    const found = host?.shadowRoot?.querySelector(which === 'label' ? '[data-unmodified-lines]' : '[data-expand-button]');
    if (!found) return null;
    const box = found.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, which);

export async function placePage(page: Page, place: Place) {
  if ('file' in place) await page.evaluate((path) => document.querySelector(`[data-guide-file-shell="${path}"]`)?.scrollIntoView({ block: 'center' }), place.file);
  if ('file' in place) await expect.poll(() => page.evaluate((path) => !!document.querySelector(`[data-guide-file-shell="${path}"] diffs-container`)?.shadowRoot?.querySelector('[data-line]'), place.file), { timeout: 30_000 }).toBe(true);
  if ('file' in place && place.edge === 'label') await expect.poll(() => opener(page, 'label'), { timeout: 30_000 }).not.toBeNull();
  await page.evaluate(
    ({ place, selector }) => {
      const scroller = document.querySelector(selector) as HTMLElement;
      if ('pageTop' in place) {
        scroller.scrollTop = place.pageTop;
        return;
      }
      const shell = document.querySelector(`[data-guide-file-shell="${place.file}"]`) as HTMLElement;
      const viewTop = scroller.getBoundingClientRect().top;
      const target =
        place.edge === 'label'
          ? shell.querySelector('diffs-container')!.shadowRoot!.querySelector('[data-unmodified-lines]')!.getBoundingClientRect().top - place.at
          : place.edge === 'top'
            ? shell.getBoundingClientRect().top - viewTop - place.at
            : shell.getBoundingClientRect().bottom - viewTop - place.at;
      scroller.scrollTop += target;
    },
    { place, selector: PAGE },
  );
}

export async function press(page: Page, which: 'label' | 'arrow', tap: boolean) {
  const at = (await opener(page, which))!;
  if (tap) await page.touchscreen.tap(at.x, at.y);
  else {
    await page.mouse.move(at.x, at.y);
    await page.mouse.click(at.x, at.y);
  }
  return at;
}

export const watch = (page: Page, how: { y: number } | 'top', selector: string) =>
  page.evaluate(
    ({ how, selector }) => {
      const scroller = document.querySelector(selector) as HTMLElement;
      const viewTop = scroller.getBoundingClientRect().top;
      const rows = () =>
        [...document.querySelectorAll('diffs-container')].flatMap((host) =>
          [...(host.shadowRoot?.querySelectorAll('[data-code] [data-line]') ?? [])].map((row) => {
            const code = row.closest('[data-code]')!;
            const file = host.closest('[data-guide-file-shell]')?.getAttribute('data-guide-file-shell') ?? host.shadowRoot?.querySelector('[data-title]')?.textContent ?? host.querySelector('[data-title]')?.textContent ?? '';
            const column = code.hasAttribute('data-deletions') ? 'd' : code.hasAttribute('data-additions') ? 'a' : 'u';
            const side = column === 'd' || (row.getAttribute('data-line-type') ?? '').includes('deletion') ? 'old' : 'new';
            return { row, key: `${file}|${column}|${side}|${row.getAttribute('data-line')}` };
          }),
        );
      const visible = rows().filter(({ row }) => row.getBoundingClientRect().height > 0);
      const chosen =
        how === 'top'
          ? visible.filter(({ row }) => row.getBoundingClientRect().top >= viewTop).sort((a, b) => a.row.getBoundingClientRect().top - b.row.getBoundingClientRect().top)[0]
          : visible.sort((a, b) => Math.abs(a.row.getBoundingClientRect().top + a.row.getBoundingClientRect().height / 2 - how.y) - Math.abs(b.row.getBoundingClientRect().top + b.row.getBoundingClientRect().height / 2 - how.y))[0];
      const w = window as unknown as { __watch: { key: string; tops: number[]; scrolls: number[]; offsets: number[]; on: boolean; lost?: number } };
      w.__watch = { key: chosen!.key, tops: [], scrolls: [], offsets: [], on: true };
      const host = chosen!.row.getRootNode() as ShadowRoot;
      const painted = new MessageChannel();
      painted.port1.onmessage = () => {
        const found = rows().find(({ row, key }) => key === w.__watch.key && (!host.host.isConnected || row.getRootNode() === host));
        if (!found) {
          w.__watch.lost = (w.__watch.lost ?? 0) + 1;
          return;
        }
        const top = found.row.getBoundingClientRect().top;
        w.__watch.tops.push(top);
        w.__watch.scrolls.push(scroller.scrollTop);
        w.__watch.offsets.push(top - scroller.getBoundingClientRect().top + scroller.scrollTop);
      };
      const step = () => {
        if (!w.__watch.on) return;
        painted.port2.postMessage(0);
        requestAnimationFrame(step);
      };
      step();
      return chosen!.key;
    },
    { how, selector },
  );

export const watched = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __watch: { key: string; tops: number[]; scrolls: number[]; offsets: number[]; on: boolean; lost?: number } };
    w.__watch.on = false;
    const { tops, scrolls, offsets, key, lost = 0 } = w.__watch;
    const signed = tops.map((top) => Math.round(top - tops[0]!));
    const worst = signed.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
    const path = signed.filter((value, i) => i === 0 || value !== signed[i - 1]);
    return {
      key,
      lost,
      frames: tops.length,
      worst,
      end: signed.at(-1) ?? 0,
      path: path.slice(0, 10).join(','),
      scrollBefore: Math.round(scrolls[0] ?? 0),
      scrollAfter: Math.round(scrolls.at(-1) ?? 0),
      offsetChange: Math.round((offsets.at(-1) ?? 0) - (offsets[0] ?? 0)),
    };
  });

export function runCase(world: () => World, entry: Case) {
  test(entry.name, async () => {
    const { context, page, notes } = await openReview(world(), entry.name, entry);
    try {
      await placePage(page, entry.place);
      if (!entry.fast) await page.waitForTimeout(300);
      let key: string;
      if (entry.open) {
        await expect.poll(() => opener(page, entry.open!), { timeout: 30_000 }).not.toBeNull();
        const at = await press(page, entry.open, !!entry.phone);
        expect(at.y).toBeLessThan((entry.phone ? 844 : (entry.viewport?.height ?? 900)) - 20);
        await expect.poll(() => page.evaluate((y) => [...document.querySelector('[data-guide-file-shell="src/totals.ts"] diffs-container')!.shadowRoot!.querySelectorAll('[data-line-type="context-expanded"]')].some((row) => Math.abs(row.getBoundingClientRect().top - y) < 40), at.y), { timeout: 10_000, intervals: [16] }).toBe(true);
        key = await watch(page, { y: at.y }, PAGE);
      } else key = await watch(page, 'top', PAGE);
      const landedBefore = await page.locator('[data-semantic-note="semantic"]').count();
      const shells = () => page.evaluate((selector) => { const top = document.querySelector(selector)!.getBoundingClientRect().top; return [...document.querySelectorAll('[data-guide-file-shell]')].map((shell) => { const box = shell.getBoundingClientRect(); return `${shell.getAttribute('data-guide-file-shell')!.replace('src/', '')}@${Math.round(box.top - top)}+${Math.round(box.height)}`; }).join(' '); }, PAGE);
      const shellsBefore = await shells();
      await expect(page.locator('[data-semantic-note="semantic"]')).toHaveCount(notes, { timeout: 45_000 });
      await page.waitForTimeout(700);
      const seen = await watched(page);
      console.log(`[keep-place] ${entry.name} | ${key} | notes before watch ${landedBefore}/${notes} | ${JSON.stringify(seen)} | ${shellsBefore} -> ${await shells()}`);
      expect(seen.lost).toBe(0);
      if (entry.limit && seen.scrollAfter === 0 && seen.scrollBefore + seen.offsetChange < 0) {
        expect(Math.abs(seen.end - (seen.offsetChange + seen.scrollBefore))).toBeLessThanOrEqual(2);
      } else expect(Math.abs(seen.worst)).toBeLessThanOrEqual(2);
    } finally {
      await context.close();
    }
  });
}

const scrollTopOf = (page: Page) => page.evaluate((selector) => Math.round(document.querySelector(selector)!.scrollTop), PAGE);

export function runScrollCases(world: () => World) {
  for (const how of ['wheel', 'keyboard', 'scrollbar', 'jump'] as const) {
    test(`a ${how} scroll while the notes land is never undone`, async () => {
      const { context, page, notes } = await openReview(world(), `Scrolled by ${how}`, { slow: true });
      try {
        await placePage(page, { file: 'src/totals.ts', edge: 'top', at: 200 });
        await page.waitForTimeout(300);
        await page.locator('[data-semantic-note="semantic"]').first().waitFor({ state: 'attached', timeout: 45_000 });
        await page.mouse.move(700, 600);
        const start = await scrollTopOf(page);
        if (how === 'wheel') await page.mouse.wheel(0, 300);
        else if (how === 'keyboard') {
          await page.evaluate((selector) => {
            const scroller = document.querySelector(selector) as HTMLElement;
            if (!scroller.hasAttribute('tabindex')) scroller.tabIndex = -1;
            scroller.focus({ preventScroll: true });
          }, PAGE);
          await page.keyboard.press('PageDown');
        } else if (how === 'scrollbar') await page.evaluate((selector) => void ((document.querySelector(selector) as HTMLElement).scrollTop += 300), PAGE);
        else await page.evaluate((selector) => document.querySelector(selector)!.querySelector('[data-guide-file-shell="src/money.ts"]')!.scrollIntoView({ block: 'start' }), PAGE);
        await page.waitForTimeout(200);
        const scrolled = await scrollTopOf(page);
        const moneyTop = () => page.evaluate((selector) => document.querySelector('[data-guide-file-shell="src/money.ts"]')!.getBoundingClientRect().top - document.querySelector(selector)!.getBoundingClientRect().top, PAGE);
        const landed = await moneyTop();
        await expect(page.locator('[data-semantic-note="semantic"]')).toHaveCount(notes, { timeout: 45_000 });
        await page.waitForTimeout(1_500);
        const end = await scrollTopOf(page);
        console.log(`[keep-place] ${how} | from ${start} to ${scrolled}, then ${end}`);
        if (how === 'jump') expect(Math.abs((await moneyTop()) - landed)).toBeLessThanOrEqual(2);
        else {
          expect(scrolled - start).toBeGreaterThan(150);
          expect(end - start).toBeGreaterThan(scrolled - start - 100);
        }
      } finally {
        await context.close();
      }
    });
  }
}
