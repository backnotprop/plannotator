/**
 * A text selection made with a finger in `plannotator annotate <file.md>`
 * (issue #1041), proved in a real browser against the compiled binary on an
 * iPhone 15 (WebKit), a Pixel 7 (Chromium) and a desktop that does not change.
 *
 * On a touch screen the selection used to be painted as a highlight 400 ms
 * after it rested, and the toolbar took over before the person could drag a
 * handle. Now a resting selection stays the system's and the same selection
 * toolbar waits above it; a button of it takes the selection, then does what
 * it does on a painted one (Comment opens the composer, Delete deletes, Looks
 * good applies the label, Cancel dismisses the toolbar).
 *
 * What each engine can show, and what is forced here (as in
 * inbox-html-phone.spec.ts):
 * - WebKit has no channel for a finger's long press, and Chromium on Linux (CI)
 *   recognizes none from DevTools touches. So the selection is set by script;
 *   the browser announces it with `selectionchange` as it announces a finger's.
 *   Those tests say FORCED in their names.
 * - Chromium on macOS makes a real long press (`longPress`), which selects the
 *   word under it, as on Android. That test runs there only.
 * - A tap is Playwright's `tap` (a touch in Chromium, a tap event in WebKit).
 *
 * The annotate CLI runs under a temp PLANNOTATOR_DATA_DIR and HOME and is
 * closed with /api/exit. Build the binary first (see inbox.spec.ts), then
 * `bun run test:sandbox tests/e2e/annotate-touch-selection.spec.ts`.
 */

import { chromium, devices, expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { longPress } from './phone-touch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

/** The wait the hook leaves a selection before it offers it (utils/touchSelection.ts), and a margin. */
const REST_MS = 400 + 400;

const MARKDOWN = [
  '# Latency plan',
  '',
  'The scheduler retries a failed job three times before it gives up on the whole batch.',
  '',
  'The second paragraph says one plain thing about the report, in a sentence long enough to select some words out of it with a finger.',
  '',
  'A third paragraph closes the plan with a short note.',
  '',
].join('\n');

const iPhone = (() => {
  const { defaultBrowserType: _ignored, ...device } = devices['iPhone 15'];
  return device;
})();
const pixel = (() => {
  const { defaultBrowserType: _ignored, ...device } = devices['Pixel 7'];
  return device;
})();

/** `plannotator annotate <file.md>` in a scratch folder; resolves its session URL. */
async function annotate() {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-annotate-touchsel-e2e-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const file = join(root, 'plan.md');
  writeFileSync(file, MARKDOWN);
  const readyFile = join(root, 'ready.jsonl');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_READY_FILE: readyFile,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_SKIP_BROWSER_OPEN: '1',
    PLANNOTATOR_REMOTE: '0',
    PLANNOTATOR_INBOX_CONNECT: '0',
  };
  const child: ChildProcess = spawn(binary, ['annotate', file], { env, cwd: root, stdio: 'ignore' });
  await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
  const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
  const close = async () => {
    await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
    if (child.exitCode === null) {
      await new Promise((done) => {
        const timer = setTimeout(done, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          done(undefined);
        });
      });
      // inbox-guard: own child (the annotate CLI this test spawned, never an Inbox)
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await removeInboxScratch(root);
  };
  return { url, close };
}

const launch = (engine: 'webkit' | 'chromium'): Promise<Browser> => (engine === 'webkit' ? webkit.launch({ args: [] }) : chromium.launch());

/** The annotate page in a fresh context of `options`, the first-run dialogs already answered. */
async function withPage(engine: 'webkit' | 'chromium', options: Record<string, unknown>, run: (page: Page) => Promise<void>) {
  const { url, close } = await annotate();
  const browser = await launch(engine);
  try {
    const context = await browser.newContext(options);
    await context.addCookies(
      [
        ['plannotator-plan-look-choice-resolved', 'true'],
        ['plannotator-announce-tui-herdr-seen', '1'],
        ['plannotator-announce-inbox-seen', '1'],
        ['plannotator-announce-ask-session-seen', '1'],
        ['plannotator-announce-agent-tool-seen', '1'],
      ].map(([name, value]) => ({ name: name!, value: value!, url })),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url);
    await expect(page.getByText('retries a failed job')).toBeVisible();
    await run(page);
    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await browser.close().catch(() => {});
    await close();
  }
}

/** The selection toolbar of a resting touch selection (the painted one has no such mark), and its buttons by name. */
const offer = (page: Page) => page.locator('.annotation-toolbar[data-pn-touch-selection-offer]');
// By title: the toolbar's icon buttons are named by it, and "Looks good" shows a thumb, so its accessible name is the emoji.
const toolbarButton = (page: Page, name: string) => offer(page).locator(`button[title="${name}"]`);
const comment = (page: Page) => toolbarButton(page, 'Comment');
const composer = (page: Page) => page.locator('[data-comment-popover]');
const marks = (page: Page) => page.locator('mark');
const selected = (page: Page) => page.evaluate(() => window.getSelection()?.toString() ?? '');

/** FORCED: words of the paragraph holding `anchor`, from `from` to `to` (script, not a finger). */
function forceSelection(page: Page, anchor: string, from: string, to: string) {
  return page.evaluate(
    ([anchorText, fromText, toText]) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null = walker.nextNode();
      while (node && !(node.textContent ?? '').includes(anchorText!)) node = walker.nextNode();
      if (!node) throw new Error(`no text holds "${anchorText}"`);
      const text = node.textContent ?? '';
      const range = document.createRange();
      range.setStart(node, text.indexOf(fromText!));
      range.setEnd(node, text.indexOf(toText!) + toText!.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    },
    [anchor, from, to],
  );
}

for (const phone of [
  { name: 'iPhone 15 (WebKit)', engine: 'webkit', device: iPhone },
  { name: 'Pixel 7 (Chromium)', engine: 'chromium', device: pixel },
] as const) {
  test(`${phone.name}, FORCED selection: a selection that rests gets the selection toolbar, is not painted, and stays the system's`, async () => {
    await withPage(phone.engine, phone.device, async (page) => {
      await forceSelection(page, 'second paragraph says', 'plain thing', 'the report');
      await page.waitForTimeout(REST_MS);

      await expect(comment(page)).toBeVisible();
      await expect(marks(page)).toHaveCount(0);
      await expect(composer(page)).toHaveCount(0);
      // The handles are still the person's to drag: the page's selection is untouched.
      expect(await selected(page)).toBe('plain thing about the report');
    });
  });

  test(`${phone.name}, FORCED selection: the toolbar is gone while the selection moves, and back once it rests on the new words`, async () => {
    await withPage(phone.engine, phone.device, async (page) => {
      await forceSelection(page, 'second paragraph says', 'plain thing', 'the report');
      await page.waitForTimeout(REST_MS);
      await expect(comment(page)).toBeVisible();

      // A handle dragged: the selection grows by a few words.
      await forceSelection(page, 'second paragraph says', 'plain thing', 'in a sentence');
      await expect(offer(page)).toHaveCount(0);
      await expect(marks(page)).toHaveCount(0);

      await page.waitForTimeout(REST_MS);
      await expect(comment(page)).toBeVisible();
      await comment(page).tap();
      await expect(composer(page)).toBeVisible();
      await expect(composer(page)).toContainText('plain thing about the report, in a sentence');
    });
  });

  test(`${phone.name}, FORCED selection: Comment takes the selection, opens the composer, and the comment is kept`, async () => {
    await withPage(phone.engine, phone.device, async (page) => {
      await forceSelection(page, 'scheduler retries', 'retries a failed job', 'three times');
      await page.waitForTimeout(REST_MS);

      await comment(page).tap();
      await expect(composer(page)).toBeVisible();
      await expect(offer(page)).toHaveCount(0);
      await expect(marks(page).first()).toBeVisible();
      // The system selection is cleared: the marks are the selection now.
      expect(await selected(page)).toBe('');

      await composer(page).locator('textarea').fill('Why three?');
      await composer(page).locator('textarea').press('ControlOrMeta+Enter');
      await expect(composer(page)).toHaveCount(0);
      await expect(marks(page).first()).toBeVisible();
    });
  });

  test(`${phone.name}, FORCED selection: Delete takes the selection and deletes it, Looks good applies the label, neither opens a composer`, async () => {
    await withPage(phone.engine, phone.device, async (page) => {
      await forceSelection(page, 'scheduler retries', 'retries a failed job', 'three times');
      await page.waitForTimeout(REST_MS);
      await toolbarButton(page, 'Delete').tap();
      await expect(page.locator('mark.deletion')).toHaveCount(1);
      await expect(offer(page)).toHaveCount(0);
      await expect(composer(page)).toHaveCount(0);

      await forceSelection(page, 'second paragraph says', 'plain thing', 'the report');
      await page.waitForTimeout(REST_MS);
      await toolbarButton(page, 'Looks good').tap();
      await expect(page.locator('mark.comment')).toHaveCount(1);
      await expect(composer(page)).toHaveCount(0);
    });
  });

  test(`${phone.name}, FORCED selection: Cancel dismisses the toolbar and leaves the selection and the page as they were`, async () => {
    await withPage(phone.engine, phone.device, async (page) => {
      await forceSelection(page, 'second paragraph says', 'plain thing', 'the report');
      await page.waitForTimeout(REST_MS);
      await toolbarButton(page, 'Cancel').tap();
      await expect(offer(page)).toHaveCount(0);
      await page.waitForTimeout(REST_MS);
      await expect(offer(page)).toHaveCount(0);
      await expect(marks(page)).toHaveCount(0);
      expect(await selected(page)).toBe('plain thing about the report');
    });
  });

  test(`${phone.name}, FORCED selection: no toolbar for a blank selection (the break between two blocks)`, async () => {
    await withPage(phone.engine, phone.device, async (page) => {
      // The break between two blocks: what a double-click past a block's end selects.
      await page.evaluate(() => {
        const paragraphs = Array.from(document.querySelectorAll('p'));
        const first = paragraphs.find((p) => (p.textContent ?? '').includes('scheduler retries'))!;
        const second = paragraphs.find((p) => (p.textContent ?? '').includes('second paragraph says'))!;
        const range = document.createRange();
        range.setStart(first.lastChild!, (first.lastChild!.textContent ?? '').length);
        range.setEnd(second.firstChild!, 0);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      });
      await page.waitForTimeout(REST_MS);
      await expect(offer(page)).toHaveCount(0);
      await expect(marks(page)).toHaveCount(0);
    });
  });
}

// (A later tap does not clear Chromium's emulated long-press selection, so closing by a tap on the page is left to a real phone.)
test('Pixel 7 (Chromium), real long press: a finger selects a word, nothing is painted, and the selection toolbar waits', async () => {
  // Chromium on Linux (CI) recognizes no long press from DevTools touches: a held
  // synthesizeTapGesture ends as pointerup and touchend with no contextmenu and no
  // selection. The forced-selection tests above cover the hook there; this one runs on macOS.
  test.skip(process.platform === 'linux', 'Chromium on Linux makes no long press from DevTools touches');
  await withPage('chromium', pixel, async (page) => {
    const box = (await page.getByText('plain thing about the report').boundingBox())!;
    await longPress(page, { x: box.x + 60, y: box.y + 8 });
    await expect(comment(page)).toBeVisible({ timeout: 4_000 });
    await expect(marks(page)).toHaveCount(0);
    expect(await selected(page)).not.toBe('');
    await comment(page).tap();
    await expect(composer(page)).toBeVisible();
  });
});

test('desktop (fine pointer): a mouse drag is painted at the release and Select\'s toolbar opens, as before', async () => {
  await withPage('chromium', { viewport: { width: 1280, height: 860 } }, async (page) => {
    const box = (await page.getByText('retries a failed job').boundingBox())!;
    await page.mouse.move(box.x + 120, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 320, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect(marks(page).first()).toBeVisible();
    await expect(page.locator('.annotation-toolbar')).toBeVisible();
    await page.waitForTimeout(REST_MS);
    await expect(offer(page)).toHaveCount(0);
  });
});
