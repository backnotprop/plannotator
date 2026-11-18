/**
 * What the person is looking at in the review window stays where it is, frame by frame, while the semantic notes land
 * and the files change height; their own scroll and a jump they ask for are never undone. A table run in Chromium
 * (`review-keep-place.spec.ts`) and WebKit (`review-keep-place-webkit.spec.ts`) against the compiled binary's code
 * review on a scratch repository.
 */

import { expect, test, type Browser, type BrowserType, type Page } from '@playwright/test';
import { watch, watched } from './inbox-keep-place.cases';
import { grows, shrinks, totals } from './keep-place-fixtures';
import { reviewOf } from './review-scratch-session';

const FILES: [string, [string, string]][] = [
  ['src/a-money.ts', shrinks('money')],
  ['src/b-totals.ts', [totals('total', false), totals('total', true)]],
  ['src/c-validators.ts', grows('validators')],
];
const BASE = Object.fromEntries(FILES.map(([path, [base]]) => [path, base]));
const HEAD = Object.fromEntries(FILES.map(([path, [, head]]) => [path, head]));
const NOTES = 2;
export const SCROLLER = '[data-e2e-scroller]';

type Place = { label: number } | { totalsTop: number } | { moneyTop: number } | 'bottom';
interface Case {
  name: string;
  place: Place;
  open?: boolean;
  comment?: boolean;
}

const CASES: Case[] = [
  { name: 'a file opened low on screen', place: { label: 700 }, open: true },
  { name: 'opened at the bottom of the scroll', place: 'bottom', open: true },
  { name: 'a file crossing the top edge', place: { totalsTop: -100 } },
  { name: 'the shrinking file itself crossing the top edge', place: { moneyTop: -100 } },
  { name: 'the shrinking file itself crossing the top edge, a row opened below', place: { moneyTop: -450 }, open: true },
  { name: 'nothing opened, low on screen', place: { label: 700 } },
  { name: 'a comment box open when the notes land above', place: { label: 500 }, comment: true },
];

const read = new WeakMap<Page, Set<string>>();

async function open(browser: Browser) {
  const session = await reviewOf(`review-keep-place-${Math.random().toString(36).slice(2, 8)}`, BASE, HEAD);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const files = new Set<string>();
  read.set(page, files);
  page.on('requestfinished', (request) => {
    const found = /file-content.*(money|validators)/.exec(decodeURIComponent(request.url()));
    if (found) files.add(found[1]!);
  });
  await page.route('**/api/file-content?*', async (route) => {
    if (/money|validators/.test(route.request().url())) await new Promise((done) => setTimeout(done, 1_500));
    await route.continue().catch(() => {});
  });
  await page.route('**/assets/sem-diff/**', async (route) => {
    await new Promise((done) => setTimeout(done, 800));
    await route.continue().catch(() => {});
  });
  await page.goto(session.url);
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('diffs-container')].some((host) => host.shadowRoot?.textContent?.includes('total26'))), { timeout: 30_000 }).toBe(true);
  await page.evaluate(() => {
    let scroller: HTMLElement | null = document.querySelector('diffs-container')!.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    scroller!.setAttribute('data-e2e-scroller', '');
    const w = window as unknown as { __notes: Set<string>; __heights: number[] };
    w.__notes = new Set();
    w.__heights = [];
    const step = () => {
      for (const note of document.querySelectorAll('[data-semantic-note="semantic"]')) w.__notes.add(note.parentElement?.textContent?.slice(0, 80) ?? '');
      if (w.__heights.at(-1) !== scroller!.scrollHeight) w.__heights.push(scroller!.scrollHeight);
      requestAnimationFrame(step);
    };
    step();
  });
  return {
    page,
    close: async () => {
      await context.close();
      await session.close();
    },
  };
}

const totalsHost = 'diffs-container';
const label = (page: Page) =>
  page.evaluate((selector) => {
    for (const host of document.querySelectorAll(selector)) {
      if (!host.shadowRoot?.textContent?.includes('total26')) continue;
      const found = host.shadowRoot.querySelector('[data-unmodified-lines]');
      if (!found) return null;
      const box = found.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    return null;
  }, totalsHost);

async function place(page: Page, where: Place) {
  await expect.poll(() => label(page), { timeout: 30_000 }).not.toBeNull();
  await page.evaluate(
    ({ where, selector }) => {
      const scroller = document.querySelector(selector) as HTMLElement;
      if (where === 'bottom') {
        scroller.scrollTop = scroller.scrollHeight;
        return;
      }
      const host = [...document.querySelectorAll('diffs-container')].find((each) => each.shadowRoot?.textContent?.includes('total26'))!;
      const viewTop = scroller.getBoundingClientRect().top;
      if ('label' in where) scroller.scrollTop += host.shadowRoot!.querySelector('[data-unmodified-lines]')!.getBoundingClientRect().top - where.label;
      else if ('totalsTop' in where) scroller.scrollTop += host.getBoundingClientRect().top - viewTop - where.totalsTop;
      else {
        const money = [...document.querySelectorAll('diffs-container')].find((each) => each.shadowRoot?.textContent?.includes('moneyBig'))!;
        scroller.scrollTop += money.getBoundingClientRect().top - viewTop - where.moneyTop;
      }
    },
    { where, selector: SCROLLER },
  );
  await page.waitForTimeout(400);
}

const notesSeen = (page: Page) => page.evaluate(() => (window as unknown as { __notes: Set<string> }).__notes.size);
const notesLand = async (page: Page) => {
  await expect.poll(() => read.get(page)?.size ?? 0, { timeout: 45_000 }).toBe(NOTES);
  await page.waitForTimeout(2_000);
};

export function reviewCases(type: BrowserType) {
  let browser: Browser;
  test.beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  test.afterAll(async () => {
    await browser?.close();
  });

  for (const entry of CASES) {
    test(entry.name, async () => {
      const { page, close } = await open(browser);
      try {
        await place(page, entry.place);
        let key: string;
        if (entry.open) {
          const at = (await label(page))!;
          expect(at.y).toBeLessThan(880);
          await page.mouse.move(at.x, at.y);
          await page.mouse.click(at.x, at.y);
          await page.waitForTimeout(150);
          key = await watch(page, { y: at.y }, SCROLLER);
        } else if (entry.comment) {
          const at = (await label(page))!;
          const line = await page.evaluate((y) => {
            for (const host of document.querySelectorAll('diffs-container')) {
              for (const number of host.shadowRoot?.querySelectorAll('[data-column-number]') ?? []) {
                const box = number.getBoundingClientRect();
                if (box.height > 0 && box.top > y + 30 && box.top < y + 200) return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
              }
            }
            return null;
          }, at.y);
          await page.mouse.click(line!.x, line!.y);
          await expect.poll(() => page.evaluate(() => document.activeElement instanceof HTMLTextAreaElement || (document.activeElement as HTMLElement | null)?.isContentEditable === true)).toBe(true);
          await page.keyboard.type('Reading');
          key = await page.evaluate((selector) => {
            const box = document.activeElement!;
            const w = window as unknown as { __watch: { key: string; tops: number[]; scrolls: number[]; offsets: number[]; on: boolean } };
            const scroller = document.querySelector(selector) as HTMLElement;
            w.__watch = { key: 'comment box', tops: [], scrolls: [], offsets: [], on: true };
            const step = () => {
              if (!w.__watch.on) return;
              const top = box.getBoundingClientRect().top;
              w.__watch.tops.push(top);
              w.__watch.scrolls.push(scroller.scrollTop);
              w.__watch.offsets.push(top - scroller.getBoundingClientRect().top + scroller.scrollTop);
              requestAnimationFrame(step);
            };
            step();
            return 'comment box';
          }, SCROLLER);
        } else key = await watch(page, 'top', SCROLLER);
        const before = await notesSeen(page);
        await notesLand(page);
        const seen = await watched(page);
        console.log(`[keep-place] review ${entry.name} | ${key} | notes before watch ${before}/${NOTES} | ${JSON.stringify(seen)}`);
        expect(seen.lost ?? 0).toBe(0);
        expect(Math.abs(seen.worst)).toBeLessThanOrEqual(2);
      } finally {
        await close();
      }
    });
  }

  for (const how of ['wheel', 'space', 'pagedown', 'scrollbar', 'next change'] as const) {
    test(`a ${how} while the notes land is never pulled back`, async () => {
      const { page, close } = await open(browser);
      try {
        await place(page, { totalsTop: 0 });
        await expect.poll(() => read.get(page)?.size ?? 0, { timeout: 45_000 }).toBeGreaterThan(0);
        await page.waitForTimeout(800);
        const box = (await page.locator(SCROLLER).boundingBox())!;
        await watch(page, { y: box.y + box.height - 120 }, SCROLLER);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        if (how === 'wheel') for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 60);
        else if (how === 'space' || how === 'pagedown') {
          await page.evaluate((selector) => {
            const scroller = document.querySelector(selector) as HTMLElement;
            if (scroller.tabIndex < 0 && !scroller.hasAttribute('tabindex')) scroller.tabIndex = -1;
            scroller.focus({ preventScroll: true });
          }, SCROLLER);
          await page.keyboard.press(how === 'space' ? 'Space' : 'PageDown');
        }
        else if (how === 'next change') await page.keyboard.press('n');
        else if (await page.evaluate((selector) => { const scroller = document.querySelector(selector) as HTMLElement; return scroller.offsetWidth - scroller.clientWidth === 0; }, SCROLLER)) {
          await page.evaluate((selector) => void ((document.querySelector(selector) as HTMLElement).scrollTop += 300), SCROLLER);
        } else {
          await page.mouse.move(box.x + box.width - 4, box.y + 60);
          await page.mouse.down();
          for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + box.width - 4, box.y + 60 + i * 10);
          await page.mouse.up();
        }
        await notesLand(page);
        const tops = await page.evaluate(() => {
          const w = window as unknown as { __watch: { tops: number[]; on: boolean } };
          w.__watch.on = false;
          return w.__watch.tops.map(Math.round);
        });
        const moved = tops.findIndex((top) => top !== tops[0]);
        const way = moved < 0 ? 1 : Math.sign(tops[0]! - tops[moved]!);
        const progress = tops.map((top) => way * (tops[0]! - top));
        const back = Math.max(0, ...progress.map((value, i) => Math.max(...progress.slice(0, i + 1)) - value));
        console.log(`[keep-place] review ${how} | row from ${tops[0]} to ${tops.at(-1)} over ${tops.length} frames | largest step back ${back}`);
        expect(Math.abs(tops[0]! - tops.at(-1)!)).toBeGreaterThan(20);
        expect(back).toBeLessThanOrEqual(2);
      } finally {
        await close();
      }
    });
  }
}
