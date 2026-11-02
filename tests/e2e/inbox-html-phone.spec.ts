/**
 * HTML attachments on a phone, first step (approval
 * "inbox-html-attachments-phone"), proved against the compiled binary under a
 * temp data dir, on an iPhone 15 (WebKit) and a Pixel 7 (Chromium), plus a
 * desktop that does not change.
 *
 * What each engine can show, and what is forced here:
 * - Chromium gets real fingers through the DevTools protocol: a real pinch, and
 *   a real long press that selects text in the frame.
 * - WebKit has no such channel. A tap (Playwright's `tap`) is its own tap event.
 *   It cannot pinch and it cannot make a touch selection, so on WebKit the
 *   selection is set by script and the zoom is a stubbed `visualViewport.scale`.
 *   Those two are FORCED, and the tests that use them say so in their names.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-html-phone.spec.ts`.
 */

import { chromium, devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { finger, pinch, png } from './phone-touch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const sections = Array.from(
  { length: 30 },
  (_, i) => `<section id="s${i}"><h2>Part ${i + 1}</h2><p id="p${i}">Part ${i + 1} says one plain thing about the report, in a sentence long enough to select some words out of it with a finger.</p><ul><li><span id="n${i}">${i * 37} ms</span> first hop</li></ul></section>`,
).join('');
const pageOf = (title: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:16px/1.5 system-ui;margin:20px;color:#18181b;background:#fafaf7}</style></head><body><h1>${title}</h1><button id="tap" onclick="this.textContent='tapped'">Tap me</button>${sections}</body></html>`;

const iPhone = (() => {
  const { defaultBrowserType: _ignored, ...device } = devices['iPhone 15'];
  return device;
})();
const pixel = (() => {
  const { defaultBrowserType: _ignored, ...device } = devices['Pixel 7'];
  return device;
})();

interface World {
  root: string;
  url: string;
  agent: SimAgent;
  thread: string;
  ids: Record<string, string>;
}

async function world(): Promise<World> {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-html-phone-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'report');
  const dir = join(project, 'files');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.html'), pageOf('Latency report'));
  writeFileSync(join(dir, 'second.html'), pageOf('Second page'));
  writeFileSync(join(dir, 'shot.png'), png(780, 1600, [70, 130, 240]));
  const agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
  const names = ['report.html', 'second.html', 'shot.png'];
  const sent = await agent.send({ project_path: project, subject: 'The report', attachments: names.map((n) => `files/${n}`), body: 'The report, a second page, and a picture.' });
  const ids = Object.fromEntries((sent.attachments as { id: string; name: string }[]).map((a) => [a.name, a.id])) as Record<string, string>;
  return { root, url, agent, thread: sent.thread_id as string, ids };
}

const launch = (engine: 'webkit' | 'chromium'): Promise<Browser> => (engine === 'webkit' ? webkit.launch({ args: [] }) : chromium.launch());

async function withPhone(engine: 'webkit' | 'chromium', run: (w: World, page: Page, context: BrowserContext) => Promise<void>, device: Record<string, unknown> = engine === 'webkit' ? iPhone : pixel) {
  const w = await world();
  const browser = await launch(engine);
  try {
    const context = await browser.newContext({ ...device });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await run(w, page, context);
    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await browser.close().catch(() => {});
    await w.agent.close().catch(() => {});
    await removeInboxScratch(w.root);
  }
}

async function open(w: World, page: Page, name: string) {
  await page.goto(`${w.url}#thread=${w.thread}&file=${w.ids[name]}`);
  await expect(pane(page)).toHaveAttribute('data-attachment-pane', w.ids[name]!);
  if (name.endsWith('.html')) await expect(frame(page).locator('#tap')).toBeVisible();
}

const pane = (page: Page) => page.locator('[data-attachment-pane]');
const frame = (page: Page) => page.frameLocator('.ib-htmlframe iframe');
const bar = (page: Page) => page.locator('[data-full-view-bar]');
const pen = (page: Page) => bar(page).locator('button[aria-pressed]').first();
const card = (page: Page) => page.locator('[data-html-comment]');
const field = (page: Page) => card(page).locator('textarea');
const target = (page: Page) => page.locator('[data-html-comment-target]');
const replyPill = (page: Page) => page.locator('[data-fcomp-pill]');
const composer = (page: Page) => page.locator('[data-fcomp]');
const tools = (page: Page) => pane(page).getAttribute('data-tools');
const scale = (page: Page) => page.evaluate(() => window.visualViewport!.scale);

/** Text set by script in the frame: a FORCED selection (no finger made it). */
const forceSelection = (page: Page, id: string, from: number, to: number) =>
  frame(page)
    .locator(`#${id}`)
    .evaluate(
      (el, [a, b]) => {
        const range = document.createRange();
        range.setStart(el.firstChild!, a!);
        range.setEnd(el.firstChild!, b!);
        const selection = getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      },
      [from, to],
    );

/** A real pinch over the frame, out from the middle. */
const pinchIn = (page: Page) => pinch(page, [{ x: 170, y: 300 }, { x: 230, y: 300 }], [{ x: 130, y: 300 }, { x: 270, y: 300 }]);
const pinchOut = (page: Page) => pinch(page, [{ x: 120, y: 300 }, { x: 280, y: 300 }], [{ x: 180, y: 300 }, { x: 220, y: 300 }]);

/** How much of the window's height stands clear above whatever floats on the page. */
const clearShare = async (page: Page) => {
  const height = page.viewportSize()!.height;
  const barBox = (await bar(page).boundingBox())!;
  const pillBox = (await replyPill(page).boundingBox())!;
  return Math.min(barBox.y, pillBox.y) / height;
};

for (const phone of [
  { name: 'iPhone 15 (WebKit)', engine: 'webkit' as const },
  { name: 'Pixel 7 (Chromium)', engine: 'chromium' as const },
]) {
  test(`${phone.name}: HTML opens clear, the reply in the pill on the toolbar's row, and a tap reaches the page`, async () => {
    await withPhone(phone.engine, async (w, page) => {
      await open(w, page, 'report.html');
      // The frame takes the window, nothing but the toolbar's row sits on it.
      await expect(replyPill(page)).toBeVisible();
      await expect(composer(page)).toHaveCount(0);
      const barBox = (await bar(page).boundingBox())!;
      const pillBox = (await replyPill(page).boundingBox())!;
      expect(Math.abs(pillBox.y + pillBox.height - (barBox.y + barBox.height))).toBeLessThanOrEqual(2);
      expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(barBox.x);
      expect(await clearShare(page)).toBeGreaterThan(0.88);

      // The pen starts off: the tap is the page's.
      await expect(pen(page)).toHaveAttribute('aria-pressed', 'false');
      await frame(page).locator('#tap').tap();
      await expect(frame(page).locator('#tap')).toHaveText('tapped');
      await expect(card(page)).toHaveCount(0);

      // The pill opens the reply; the card folds back to it.
      await replyPill(page).tap();
      await expect(composer(page)).toBeVisible();
      await page.locator('[data-fcomp-minimize]').tap();
      await expect(composer(page)).toHaveCount(0);
      await expect(replyPill(page)).toBeVisible();
    });
  });

  test(`${phone.name}: a pin opens the bottom card, with thumb-sized targets, focus in the field, and the page in sight`, async () => {
    await withPhone(phone.engine, async (w, page) => {
      await open(w, page, 'report.html');
      await pen(page).tap();
      await frame(page).locator('#n2').scrollIntoViewIfNeeded();
      await frame(page).locator('#n2').tap();

      await expect(card(page)).toBeVisible();
      await expect(card(page)).toHaveAttribute('data-html-comment', 'compose');
      await expect(target(page)).toHaveText('74 ms');
      await expect(page.locator('[data-fcomp-mode="comment"]')).toHaveAttribute('aria-checked', 'true');
      await expect(field(page)).toBeFocused();

      // No dimmed box over the page: the frame still has the window, the card takes the bottom.
      await expect(page.locator('.ib-htmlframe [role="dialog"]')).toHaveCount(0);
      const cardBox = (await composer(page).boundingBox())!;
      const height = page.viewportSize()!.height;
      expect(cardBox.y).toBeGreaterThan(height * 0.6);

      for (const control of ['[data-html-comment-step="parent"]', '[data-html-comment-step="child"]', '[data-html-comment-save]', '[data-fcomp-mode="comment"]', '[data-fcomp-mode="reply"]', '[data-fcomp-minimize]']) {
        const box = (await page.locator(control).boundingBox())!;
        expect(box.height, control).toBeGreaterThanOrEqual(44);
        expect(box.width, control).toBeGreaterThanOrEqual(44);
      }

      // The toolbar makes room for the card, and comes back after it.
      await expect(page.locator('[data-full-view-dock]')).toBeHidden();

      // Parent and Child move the pin, keep the words and keep focus in the field.
      await field(page).fill('This hop is slow');
      await page.locator('[data-html-comment-step="parent"]').tap();
      await expect(target(page)).not.toHaveText('74 ms');
      await expect(field(page)).toHaveValue('This hop is slow');
      await expect(field(page)).toBeFocused();
      await page.locator('[data-html-comment-step="child"]').tap();
      await expect(target(page)).toHaveText('74 ms');
      await expect(field(page)).toBeFocused();

      await page.locator('[data-html-comment-save]').tap();
      await expect(card(page)).toHaveCount(0);
      await expect(bar(page).getByRole('button', { name: /^Comments, 1/ })).toBeVisible();
      await expect(page.locator('[data-full-view-dock]')).toBeVisible();
      // Back as it found it: the page clear, the reply in the pill.
      await expect(composer(page)).toHaveCount(0);
      await expect(replyPill(page)).toBeVisible();
    });
  });

  test(`${phone.name}: a pin under the card comes up above it`, async () => {
    await withPhone(phone.engine, async (w, page) => {
      await open(w, page, 'report.html');
      await pen(page).tap();
      // At the foot of the window, with the page scrolled to put it there.
      await frame(page).locator('#p3').evaluate((el) => {
        const box = el.getBoundingClientRect();
        document.scrollingElement!.scrollTop += box.bottom - window.innerHeight + 6;
      });
      await frame(page).locator('#p3').tap({ position: { x: 20, y: 6 } });
      await expect(card(page)).toBeVisible();
      await expect.poll(async () => {
        const pinned = (await frame(page).locator('#p3').boundingBox())!;
        const cover = (await composer(page).boundingBox())!;
        return pinned.y + pinned.height <= cover.y;
      }).toBe(true);
    });
  });

  test(`${phone.name}: Hide on a comment with no words drops it, with words it stays`, async () => {
    await withPhone(phone.engine, async (w, page) => {
      await open(w, page, 'report.html');
      await pen(page).tap();
      await frame(page).locator('#n1').tap();
      await expect(card(page)).toBeVisible();
      await page.locator('[data-fcomp-minimize]').tap();
      await expect(card(page)).toHaveCount(0);
      await expect(composer(page)).toHaveCount(0);
      await expect(replyPill(page)).toBeVisible();

      await frame(page).locator('#n1').tap();
      await field(page).fill('Keep this');
      await page.locator('[data-fcomp-minimize]').tap();
      await expect(composer(page)).toHaveCount(0);
      await replyPill(page).tap();
      await page.locator('[data-fcomp-mode="comment"]').tap();
      await expect(field(page)).toHaveValue('Keep this');
    });
  });

  test(`${phone.name}: Show tools after Hide tools leaves the reply working (#2484)`, async () => {
    await withPhone(phone.engine, async (w, page) => {
      await open(w, page, 'report.html');
      await bar(page).getByRole('button', { name: 'Hide tools' }).tap();
      await expect.poll(() => tools(page)).toBe('tucked');
      await expect(replyPill(page)).toBeHidden();
      await page.locator('[data-full-view-handle]').tap();
      await expect.poll(() => tools(page)).toBe('pinned');
      await expect(page.locator('[data-fcomp-pillwrap]')).not.toHaveAttribute('inert', /.*/);
      await replyPill(page).tap();
      await expect(composer(page)).toBeVisible();
      await page.locator('[data-fcomp-field] textarea').fill('Still typing');
      await expect(page.locator('[data-fcomp-field] textarea')).toHaveValue('Still typing');
    });
  });

  test(`${phone.name}: forced selection (set by script): it opens the card once it rests, without taking focus`, async () => {
    await withPhone(phone.engine, async (w, page) => {
      await open(w, page, 'report.html');
      // Pen off on purpose: selecting works in Interact, as a drag does on a desktop.
      await expect(pen(page)).toHaveAttribute('aria-pressed', 'false');
      await forceSelection(page, 'p1', 5, 20);
      await page.waitForTimeout(250);
      await expect(card(page)).toHaveCount(0);
      await expect(card(page)).toBeVisible();
      await expect(card(page)).toHaveAttribute('data-html-comment', 'selection');
      await expect(target(page)).toHaveText('2 says one plai');
      await expect(page.locator('[data-html-comment-step]')).toHaveCount(0);
      await expect(field(page)).not.toBeFocused();
      await forceSelection(page, 'p1', 5, 30);
      await expect(target(page)).toHaveText('2 says one plain thing about');
      await field(page).fill('About these words');
      await page.locator('[data-html-comment-save]').tap();
      await expect(card(page)).toHaveCount(0);
      await expect(bar(page).getByRole('button', { name: /^Comments, 1/ })).toBeVisible();
    });
  });

  test(`${phone.name}: an image on the same thread keeps its card and its Comment tab`, async () => {
    await withPhone(phone.engine, async (w, page) => {
      await open(w, page, 'shot.png');
      await expect(composer(page)).toBeVisible();
      await expect(page.locator('[data-fcomp-mode="comment"]')).toHaveAttribute('aria-checked', 'true');
    });
  });
}

test('Pixel 7 (Chromium), real long press: a finger selects words and the card opens, and a tap on the page closes it while it has no words', async () => {
  await withPhone('chromium', async (w, page) => {
    await open(w, page, 'report.html');
    const box = (await frame(page).locator('#p1').boundingBox())!;
    const hold = await finger(page, 'chromium');
    await hold.down(box.x + 60, box.y + 12, 0, 0, 1);
    await page.waitForTimeout(900);
    await hold.up();
    await expect(card(page)).toBeVisible({ timeout: 4_000 });
    await expect(card(page)).toHaveAttribute('data-html-comment', 'selection');
    const words = await target(page).textContent();
    expect((words ?? '').length).toBeGreaterThan(0);
    await frame(page).locator('#tap').tap();
    await expect(card(page)).toHaveCount(0);
  });
});

test('Pixel 7 (Chromium), real pinch: the tools tuck while zoomed and come back, a pinch does not change the choice, and a comment stays', async () => {
  await withPhone('chromium', async (w, page) => {
    await open(w, page, 'report.html');
    expect(await tools(page)).toBe('pinned');
    await pinchIn(page);
    await expect.poll(() => scale(page)).toBeGreaterThan(1.05);
    await expect.poll(() => tools(page)).toBe('tucked');
    await pinchOut(page);
    await expect.poll(() => scale(page)).toBeLessThanOrEqual(1.05);
    await expect.poll(() => tools(page)).toBe('pinned');

    // Hidden by hand stays hidden through a pinch.
    await bar(page).getByRole('button', { name: 'Hide tools' }).tap();
    await pinchIn(page);
    await expect.poll(() => scale(page)).toBeGreaterThan(1.05);
    await pinchOut(page);
    await expect.poll(() => scale(page)).toBeLessThanOrEqual(1.05);
    await expect.poll(() => tools(page)).toBe('tucked');
    await page.locator('[data-full-view-handle]').tap();

    // Zoomed with a comment open, the card stays: the person is writing.
    await pen(page).tap();
    await frame(page).locator('#n1').tap();
    await expect(card(page)).toBeVisible();
    await pinchIn(page);
    await expect.poll(() => scale(page)).toBeGreaterThan(1.05);
    await expect(card(page)).toHaveCount(1);
    expect(await tools(page)).toBe('pinned');
  });
});

test('Pixel 7 (Chromium), real pinch: the next file opens at full view, and pinch still works there', async () => {
  await withPhone('chromium', async (w, page) => {
    await open(w, page, 'report.html');
    const before = await page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name=viewport]')!.content);
    await pinchIn(page);
    await expect.poll(() => scale(page)).toBeGreaterThan(1.05);
    // The tools are out of the view; the person reaches them and steps with the pill.
    await page.locator('[data-full-view-handle]').tap();
    await expect(bar(page).locator('[data-full-view-position]')).toBeVisible();
    await bar(page).locator('[data-full-view-position]').tap();
    await page.locator('[data-image-peek-sheet]').getByRole('gridcell', { name: /^second\.html/ }).tap();
    await expect(pane(page)).toHaveAttribute('data-attachment-pane', w.ids['second.html']!);
    await expect.poll(() => scale(page)).toBeLessThanOrEqual(1.05);
    await expect.poll(() => tools(page)).toBe('pinned');
    // The lever put the meta back: zoom is not switched off.
    await expect.poll(() => page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name=viewport]')!.content)).toBe(before);
    await pinchIn(page);
    await expect.poll(() => scale(page)).toBeGreaterThan(1.05);
  });
});

test('iPhone 15 (WebKit): forced zoom (a stubbed visualViewport.scale): the parent reads it and the tools tuck', async () => {
  await withPhone('webkit', async (w, page) => {
    await open(w, page, 'report.html');
    expect(await tools(page)).toBe('pinned');
    const zoom = (value: number) =>
      page.evaluate((v) => {
        Object.defineProperty(window.visualViewport!, 'scale', { configurable: true, get: () => v });
        window.visualViewport!.dispatchEvent(new Event('resize'));
      }, value);
    await zoom(1.04);
    await page.waitForTimeout(150);
    expect(await tools(page)).toBe('pinned');
    await zoom(1.5);
    await expect.poll(() => tools(page)).toBe('tucked');
    await zoom(1);
    await expect.poll(() => tools(page)).toBe('pinned');
  });
});

test('a page cannot forge the zoom: a bridge message from the frame does not tuck the tools', async () => {
  await withPhone('webkit', async (w, page) => {
    await open(w, page, 'report.html');
    await frame(page).locator('body').evaluate(() => {
      for (const type of ['plannotator-bridge-zoom', 'plannotator-bridge-scale', 'plannotator-bridge-pinch']) window.parent.postMessage({ type, scale: 4 }, '*');
    });
    await page.waitForTimeout(250);
    expect(await tools(page)).toBe('pinned');
  });
});

test('320 px phone: the card and its controls stay in the window', async () => {
  const small = { ...iPhone, viewport: { width: 320, height: 568 }, screen: { width: 320, height: 568 } };
  await withPhone(
    'webkit',
    async (w, page) => {
      await open(w, page, 'report.html');
      await pen(page).tap();
      await frame(page).locator('#n1').tap();
      await expect(card(page)).toBeVisible();
      for (const control of ['[data-html-comment-step="child"]', '[data-html-comment-save]', '[data-fcomp-minimize]']) {
        const box = (await page.locator(control).boundingBox())!;
        expect(box.x + box.width, control).toBeLessThanOrEqual(320);
        expect(box.y + box.height, control).toBeLessThanOrEqual(568);
      }
    },
    small,
  );
});

test('desktop: nothing changed: pen on, the reply card open, the selection bridge off, the comment in its popover', async () => {
  await withPhone(
    'chromium',
    async (w, page) => {
      await open(w, page, 'report.html');
      await expect(pen(page)).toHaveAttribute('aria-pressed', 'true');
      await expect(composer(page)).toBeVisible();
      expect(await frame(page).locator('body').evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false);
      await forceSelection(page, 'p1', 5, 20);
      await page.waitForTimeout(700);
      await expect(card(page)).toHaveCount(0);
      await frame(page).locator('#p2').click();
      await expect(page.locator('.ib-htmlframe').getByRole('textbox').first()).toBeVisible();
      await expect(card(page)).toHaveCount(0);
    },
    { viewport: { width: 1440, height: 900 } },
  );
});
