/**
 * The annotation toolstrip (Select / Pinpoint / Markup) always paints above
 * the document it annotates, proved in a real Chromium against the compiled
 * binary. Stacking order cannot be checked in a DOM test (happy-dom does not
 * paint), so this asks the browser itself: after scrolling each kind of block
 * under the strip, `document.elementFromPoint` at points across the strip
 * must land on the strip, never on a table cell, a code block, a callout, a
 * diagram or the document card.
 *
 * Two surfaces:
 *  - The Inbox: a markdown file an agent attached, open beside the thread, full
 *    screen, in a window narrow enough that the file covers the thread, and on
 *    a phone. The Inbox draws its own floating strip (`.ib-toolstrip`) over the
 *    scrolling document; ui's Viewer wraps every document in a `relative z-50`
 *    layer, which used to escape the scroller and paint over the strip's
 *    `z-index: 3` (the owner's report, 2026-10-12: a table's rows drawn over
 *    the strip in DESIGN.md).
 *  - Annotate (the editor app, which plan review shares): the strip rides
 *    StickyHeaderLane, sticky above the Viewer's layer, at several widths.
 *
 * Nothing is mocked: `plannotator inbox --background` and `plannotator
 * annotate` run under a temp PLANNOTATOR_DATA_DIR and HOME. Build the binary
 * first (see inbox.spec.ts), then `bun run test:e2e:inbox`. Screenshots of
 * each checked state land in .local/proof/toolstrip-stacking/ (or
 * $PLANNOTATOR_E2E_PROOF_DIR/toolstrip-stacking).
 */

import { devices, expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'toolstrip-stacking');

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => `| ${i + 1} | Notifications ${i + 1} | Switch, browser permission, blocked note |`).join('\n');

/** A long design document with every block kind that has its own chrome or layer. */
const DOC = [
  '# Inbox design',
  '',
  'Intro paragraph. '.repeat(30),
  '',
  '## Screens',
  '',
  '| # | Screen | What it holds |',
  '|---|--------|---------------|',
  rows(14),
  '',
  'Between the blocks. '.repeat(20),
  '',
  '```ts',
  ...Array.from({ length: 16 }, (_, i) => `const line${i} = "a code line that is long enough to reach across the strip ${i}";`),
  '```',
  '',
  '> [!WARNING]',
  '> A GitHub alert that runs across several lines so it can sit under the strip.',
  '> Second line of the alert.',
  '> Third line of the alert.',
  '',
  ':::note',
  'A directive callout with enough words in it to cover the strip area when scrolled under it.',
  'Another line of the callout.',
  ':::',
  '',
  '```mermaid',
  'flowchart TD',
  '  A[Open the Inbox] --> B[Pick a thread]',
  '  B --> C{Has a file?}',
  '  C -- yes --> D[Open it beside]',
  '  C -- no --> E[Reply]',
  '  D --> F[Comment]',
  '  E --> F',
  '```',
  '',
  ':::question',
  'Which layout should the file pane use?',
  '',
  '- [ ] Beside the thread',
  '- [ ] Full screen',
  ':::',
  '',
  'Closing words. '.repeat(40),
  '',
  ...Array.from({ length: 30 }, (_, i) => `Trailing paragraph ${i} so every block above can scroll to the top.`).flatMap((p) => [p, '']),
].join('\n');

/** Each block kind, by a selector inside the scrolling document. */
const BLOCKS: Array<{ name: string; selector: string }> = [
  { name: 'table', selector: 'table' },
  { name: 'code', selector: 'pre' },
  { name: 'alert', selector: '[data-alert-kind], blockquote' },
  { name: 'diagram', selector: '[data-diagram-block]' },
  { name: 'question', selector: '[data-question-key], [data-question-card]' },
];

interface Probe {
  /** Points across the strip whose topmost element is not inside the strip. */
  covered: string[];
  /** Whether the block's box crossed the strip's box (the probe tested something). */
  overlapped: boolean;
  found: boolean;
}

/**
 * Scroll `scroller` so the first `blockSelector` sits under `stripSelector`,
 * then ask the browser what is on top at points across the strip.
 */
async function probe(page: Page, scrollerSelector: string, stripSelector: string, blockSelector: string): Promise<Probe> {
  const placed = await page.evaluate(
    ({ scrollerSelector, stripSelector, blockSelector }) => {
      const scroller = scrollerSelector === 'window' ? document.scrollingElement! : document.querySelector(scrollerSelector);
      const strip = document.querySelector(stripSelector);
      if (!scroller || !strip) return { found: false };
      const block = [...scroller.querySelectorAll(blockSelector)].find((el) => el.getBoundingClientRect().height > 30);
      if (!block) return { found: false };
      // Twice: a sticky strip moves on the first scroll.
      for (let i = 0; i < 2; i++) {
        const s = strip.getBoundingClientRect();
        const b = block.getBoundingClientRect();
        scroller.scrollTop += b.top - (s.top - 6);
      }
      return { found: true };
    },
    { scrollerSelector, stripSelector, blockSelector },
  );
  if (!placed.found) return { covered: [], overlapped: false, found: false };
  // Let a sticky header settle and any scroll-driven state paint.
  await page.waitForTimeout(150);
  return page.evaluate(
    ({ scrollerSelector, stripSelector, blockSelector }) => {
      const scroller = scrollerSelector === 'window' ? document.scrollingElement! : document.querySelector(scrollerSelector)!;
      const strip = document.querySelector(stripSelector)!;
      const block = [...scroller.querySelectorAll(blockSelector)].find((el) => el.getBoundingClientRect().height > 30)!;
      const s = strip.getBoundingClientRect();
      const b = block.getBoundingClientRect();
      const overlapped = b.left < s.right && b.right > s.left && b.top < s.bottom && b.bottom > s.top;
      const covered: string[] = [];
      for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        for (const fy of [0.3, 0.7]) {
          const x = s.left + s.width * fx;
          const y = s.top + s.height * fy;
          const top = document.elementFromPoint(x, y);
          if (!top || !strip.contains(top)) {
            covered.push(`(${Math.round(x)},${Math.round(y)}) ${top ? `${top.tagName.toLowerCase()}.${String(top.className).slice(0, 60)}` : 'nothing'}`);
          }
        }
      }
      return { covered, overlapped, found: true };
    },
    { scrollerSelector, stripSelector, blockSelector },
  );
}

/** Every block kind under the strip, one screenshot each; the table and the card must have crossed it. */
async function checkSurface(page: Page, label: string, scroller: string, strip: string): Promise<void> {
  await expect(page.locator(strip)).toBeVisible();
  for (const block of BLOCKS) {
    const result = await probe(page, scroller, strip, block.selector);
    expect(result.found, `${label}: a ${block.name} is in the document`).toBe(true);
    await page.screenshot({ path: join(proofDir, `${label}-${block.name}.png`) });
    if (block.name === 'table') expect(result.overlapped, `${label}: the table crossed the strip`).toBe(true);
    expect.soft(result.covered, `${label}: the ${block.name} painted over the strip`).toEqual([]);
  }
}

/** A dialog still covers the strip: the table popout, which the Viewer portals into its own article. */
async function checkTablePopoutCovers(page: Page, label: string, scroller: string, strip: string): Promise<void> {
  await probe(page, scroller, strip, 'table');
  // The table's own toolbar floats above it: in full screen (no header) the probe leaves the table at the window's
  // top edge, so give the toolbar room inside the window, and hover its first row (hovering a table taller than the
  // window would scroll it back to the top).
  await page.locator(scroller).first().evaluate((el) => {
    el.scrollTop -= 80;
  });
  const table = page.locator(`${scroller} table`).first();
  await table.locator('tr').first().hover();
  await page.getByTitle('Expand table').first().click();
  const popout = page.locator('[data-popout]');
  await expect(popout).toBeVisible();
  const onTop = await page.evaluate((stripSelector) => {
    const s = document.querySelector(stripSelector)!.getBoundingClientRect();
    const top = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
    return { inStrip: !!top && document.querySelector(stripSelector)!.contains(top), tag: top ? `${top.tagName.toLowerCase()}.${String(top.className).slice(0, 60)}` : 'nothing' };
  }, strip);
  await page.screenshot({ path: join(proofDir, `${label}-table-popout.png`) });
  expect.soft(onTop.inStrip, `${label}: the table popout covers the strip (top: ${onTop.tag})`).toBe(false);
  await page.keyboard.press('Escape');
  await expect(popout).toHaveCount(0);
}

/** The stepping bar's list of files opens up over the document and stays above it. */
async function checkStepListAbove(page: Page, label: string): Promise<void> {
  // Beside the thread the stepper's label opens it; in full screen, the toolbar's N/M.
  await page.locator('[data-attachment-stepper] [aria-haspopup="grid"], [data-full-view-position]').first().click();
  const list = page.locator('[data-step-list]');
  await expect(list).toBeVisible();
  const covered = await page.evaluate(() => {
    const el = document.querySelector('[data-step-list]')!;
    const r = el.getBoundingClientRect();
    const misses: string[] = [];
    for (const fy of [0.15, 0.5, 0.85]) {
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height * fy);
      if (!top || !el.contains(top)) misses.push(top ? `${top.tagName.toLowerCase()}.${String(top.className).slice(0, 60)}` : 'nothing');
    }
    return misses;
  });
  await page.screenshot({ path: join(proofDir, `${label}-step-list.png`) });
  expect.soft(covered, `${label}: the document painted over the stepping list`).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
}

/**
 * The move to (400, 400) before goto does not always survive the navigation: on CI's Linux Chromium the new
 * document can still take the pointer to be at (0, 0), on the peek's edge strip, and once the file closes the
 * sidebar the peek opens 600 ms later and floats over everything, a full-screen file included (seen on CI: the
 * sidebar's logo and title "painted over" the full-screen strip, and the peek over the thread beside a file).
 * The peek closes only when the pointer leaves it, so enter it and leave, then make sure it is gone.
 */
async function closeSidebarPeek(page: Page): Promise<void> {
  const peek = page.locator('[data-sidebar-peek][data-visible]');
  // Park the pointer away from the edge first, then outlast the peek's 600 ms rest, so a peek that was about to
  // open has opened (or never will) before it is checked; then enter and leave it until it is gone.
  await page.mouse.move(700, 450);
  await page.waitForTimeout(800);
  await expect(async () => {
    if ((await peek.count()) > 0) {
      await page.mouse.move(60, 450);
      await page.mouse.move(700, 450);
    }
    await expect(peek).toHaveCount(0, { timeout: 1000 });
  }, 'the sidebar peek is closed before the strip is probed').toPass({ timeout: 10_000 });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
});

test('Inbox: the attached document never paints over the toolstrip, beside the thread, full screen, narrow and on a phone', async ({ browser }: { browser: Browser }) => {
  const root = inboxScratch('plannotator-toolstrip-inbox-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'inbox-design');
  writeFileSync(join(project, 'DESIGN.md'), DOC);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
  try {
    writeFileSync(join(project, 'NOTES.md'), '# Notes\n\nA second file, so the stepping bar and its list show.\n');
    const sent = await agent.send({ project_path: project, subject: 'The design', body: 'The design doc, attached.', attachments: ['DESIGN.md', 'NOTES.md'] });
    const fileUrl = `${url}#thread=${sent.thread_id}&file=${sent.attachments[0].id as string}`;
    const layouts: Array<{ label: string; options: BrowserContextOptions; full?: boolean }> = [
      { label: 'inbox-beside-1440', options: { viewport: { width: 1440, height: 900 } } },
      { label: 'inbox-full-1440', options: { viewport: { width: 1440, height: 900 } }, full: true },
      { label: 'inbox-beside-1280', options: { viewport: { width: 1280, height: 800 } } },
      { label: 'inbox-narrow-1000', options: { viewport: { width: 1000, height: 800 } } },
      { label: 'inbox-phone', options: { ...devices['Pixel 7'] } },
    ];
    for (const layout of layouts) {
      const context = await browser.newContext(layout.options);
      try {
        const page = await context.newPage();
        // Playwright's pointer starts at (0, 0), on the sidebar peek's edge strip: once a file closes the
        // sidebar, resting there 600 ms opens the peek over everything, full screen included. Rest it in the
        // middle, where a person reading the file would.
        await page.mouse.move(400, 400);
        await page.goto(fileUrl);
        await expect(page.locator('[data-attachment-pane] .ib-docscroll table')).toBeVisible();
        if (layout.full) {
          await page.getByRole('button', { name: 'Full screen' }).click();
          await expect(page.locator('.ib-view.ib-full')).toBeVisible();
          // The comments drawer open beside the page, so the centred document reaches under the toolstrip.
          await page.locator('[data-full-view-comments]').click();
          await expect(page.locator('.ib-view.ib-drawer')).toBeVisible();
        }
        await closeSidebarPeek(page);
        await checkSurface(page, layout.label, '[data-attachment-pane] .ib-docscroll', '[data-attachment-pane] .ib-toolstrip');
        await checkTablePopoutCovers(page, layout.label, '[data-attachment-pane] .ib-docscroll', '[data-attachment-pane] .ib-toolstrip');
        if (!layout.options.isMobile) await checkStepListAbove(page, layout.label);
      } finally {
        await context.close();
      }
    }
  } finally {
    await agent.close().catch(() => {});
    // This test's Inbox, then its folder (inbox-scratch.ts).
    await removeInboxScratch(root);
  }
});

test('Annotate (the editor plan review shares): the document never paints over the sticky toolstrip at any width', async ({ browser }: { browser: Browser }) => {
  const root = inboxScratch('plannotator-toolstrip-annotate-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const doc = join(root, 'DESIGN.md');
  writeFileSync(doc, DOC);
  const readyFile = join(root, 'ready.jsonl');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_READY_FILE: readyFile,
    PLANNOTATOR_SKIP_BROWSER_OPEN: '1',
    PLANNOTATOR_REMOTE: '0',
  };
  let child: ChildProcess | undefined;
  let url = '';
  try {
    child = spawn(binary, ['annotate', doc], { env, cwd: root, stdio: 'ignore' });
    await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
    url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
    const layouts: Array<{ label: string; options: BrowserContextOptions }> = [
      { label: 'annotate-1440', options: { viewport: { width: 1440, height: 900 } } },
      { label: 'annotate-1024', options: { viewport: { width: 1024, height: 800 } } },
      { label: 'annotate-820', options: { viewport: { width: 820, height: 900 } } },
    ];
    for (const layout of layouts) {
      const context = await browser.newContext(layout.options);
      try {
        // The first-run dialogs (plan look, terminal tools, Ask this session, the agent tool) already answered.
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
        await page.goto(url);
        await expect(page.locator('article table')).toBeVisible();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        // The document scrolls inside the app's scroll viewport, the ancestor of the article that scrolls.
        const scroller = await page.evaluate(() => {
          let el = document.querySelector('article')?.parentElement ?? null;
          while (el && !(el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
          if (!el) return 'window';
          el.setAttribute('data-test-doc-scroller', '');
          return '[data-test-doc-scroller]';
        });
        await checkSurface(page, layout.label, scroller, '[data-sticky-header-lane] > div');
        await checkTablePopoutCovers(page, layout.label, scroller, '[data-sticky-header-lane] > div');
      } finally {
        await context.close();
      }
    }
  } finally {
    // Close the session the way the reviewer's Close does, so the CLI exits by itself.
    if (url) await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
    if (child && child.exitCode === null) {
      await new Promise((done) => {
        const timer = setTimeout(done, 5_000);
        child!.once('exit', () => {
          clearTimeout(timer);
          done(undefined);
        });
      });
      // inbox-guard: own child (the annotate CLI this test spawned, never an Inbox)
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await removeInboxScratch(root);
  }
});
