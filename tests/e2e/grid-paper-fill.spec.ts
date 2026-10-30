/**
 * The Grid look's paper reaches the bottom of the view. Before, the plan card
 * on the grid sized to its content, so a short plan or file showed a card that
 * stopped halfway down the screen with empty grid below it (owner, 2026-10-27:
 * "the grid paper is never full size"). Now the card runs down to the
 * document area's bottom padding when the content is short; a long document
 * is unchanged (the card is as long as the document and scrolls). The plan
 * diff's card fills the same way, so toggling Diff does not halve the paper.
 *
 * Plan review and annotate, a short and a long document, at 1440 by 900, a
 * 390 by 844 narrow desktop window and a 390 by 844 touch phone (the compact
 * layout: the document scrolls and "Ready to finish?" follows the card), and
 * a short plan's diff at 1440 and on the phone. Against the compiled binary
 * under a temp HOME and PLANNOTATOR_DATA_DIR, headless. Build the binary
 * first (see inbox.spec.ts).
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const SHORT = '# Add retry to the uploader\n\nA short plan.\n\n## Steps\n\n1. Wrap the upload in a retry loop.\n2. Log each failed attempt.\n';
// The same plan, revised: the second submission is version 2, so it has a diff.
const SHORT_REVISED = '# Add retry to the uploader\n\nA short plan.\n\n## Steps\n\n1. Wrap the upload in a retry loop.\n2. Log each failed attempt with its error.\n3. Give up after three tries.\n';
const LONG = '# Migrate the settings store\n\n' + Array.from({ length: 16 }, (_, i) =>
  `## Step ${i + 1}\n\nThis step is long enough that the whole document runs well past one screen.\n\n- First point\n- Second point\n`).join('\n');

// Grid chosen, and every first-run dialog already seen, so the page opens on the plan.
const COOKIES: [string, string][] = [
  ['plannotator-plan-look-choice-resolved', 'true'],
  ['plannotator-plan-look-v2', 'resolved'],
  ['plannotator-grid-enabled', 'true'],
  ['plannotator-look-feel-announcement-seen', '2'],
  ['plannotator-announce-tui-herdr-seen', '1'],
  ['plannotator-announce-ask-session-seen', '1'],
  ['plannotator-announce-agent-tool-seen', '1'],
  ['plannotator-announce-inbox-seen', '1'],
  ['plannotator-vim-mode-announcement-seen', '2'],
  ['plannotator-plan-ai-announcement-seen', '1'],
  ['plannotator-permission-mode-configured', 'true'],
  ['plannotator-guide-intro-seen', '1'],
  ['plannotator-edit-mode-announcement-seen', '1'],
  ['plannotator-token-hover-announcement-seen', '1'],
];

type Kind = 'plan' | 'annotate';
type View = { width: number; height: number; touch?: boolean };
const DESKTOP: View = { width: 1440, height: 900 };
const NARROW: View = { width: 390, height: 844 };
const PHONE: View = { width: 390, height: 844, touch: true };

async function start(root: string, kind: Kind, doc: string, run: number): Promise<{ child: ChildProcess; url: string }> {
  const ready = join(root, `ready-${run}.jsonl`);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '', HOME: root,
    PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_READY_FILE: ready,
    PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER,
    PLANNOTATOR_SKIP_BROWSER_OPEN: '1', PLANNOTATOR_REMOTE: '0', PLANNOTATOR_INBOX_CONNECT: '0',
  };
  let child: ChildProcess;
  if (kind === 'annotate') {
    const file = join(root, `doc-${run}.md`);
    writeFileSync(file, doc);
    child = spawn(binary, ['annotate', file], { cwd: root, stdio: 'ignore', env });
  } else {
    child = spawn(binary, [], { cwd: root, stdio: ['pipe', 'ignore', 'ignore'], env });
    child.stdin!.end(JSON.stringify({
      session_id: 'e2e', transcript_path: join(root, 'transcript.jsonl'), cwd: root, permission_mode: 'plan',
      hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_input: { plan: doc },
    }));
  }
  await expect.poll(() => existsSync(ready) ? readFileSync(ready, 'utf8') : '', { timeout: 30_000 }).toContain('"url"');
  return { child, url: JSON.parse(readFileSync(ready, 'utf8').trim().split('\n')[0]!).url };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  // inbox-guard: own child (the plan review / annotate CLI this test spawned).
  child.kill('SIGKILL');
  await exited;
}

/**
 * The document scroll area, the visible paper card, the page, and the phone's
 * "Ready to finish?" panel, in viewport pixels. The card is the visible
 * article on the grid: the plan's (Viewer) or the diff's (PlanDiffViewer).
 */
async function geometry(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('main[data-print-region="document"]')!;
    const card = [...main.querySelectorAll<HTMLElement>('article')].find((a) => a.getClientRects().length > 0)!;
    const completion = document.querySelector<HTMLElement>('[data-pn-compact-plan-completion]');
    const m = main.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const scroller = document.scrollingElement!;
    return {
      grid: main.classList.contains('bg-grid'),
      mainBottom: m.bottom,
      mainScrollHeight: main.scrollHeight,
      mainClientHeight: main.clientHeight,
      cardBottom: c.bottom,
      cardHeight: c.height,
      // The card sits in the filling column (the hooks App.tsx and the card set).
      inFillColumn: !!card.closest('[data-grid-paper-column] [data-viewer-fill-height]'),
      pageScrollHeight: scroller.scrollHeight,
      viewHeight: window.innerHeight,
      completionTop: completion ? completion.getBoundingClientRect().top : null,
      completionBottom: completion ? completion.getBoundingClientRect().bottom : null,
    };
  });
}

async function check(browser: Browser, url: string, view: View, opts: { long?: boolean; diff?: boolean } = {}): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height }, colorScheme: 'light',
    ...(view.touch ? { isMobile: true, hasTouch: true } : {}),
  });
  try {
    await context.addCookies(COOKIES.map(([name, value]) => ({ name, value, url })));
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.locator('article[data-print-region="article"]')).toBeVisible();
    if (opts.diff) {
      // The diff badge in the card (the sticky header lane has a hidden copy).
      await page.locator('article[data-print-region="article"]').getByRole('button', { name: /^\+\d+\s*\/\s*-\d+/ }).click({ timeout: 10_000 });
      await expect(page.getByTitle('Back to plan view')).toBeVisible();
    }
    await page.waitForTimeout(300); // fonts and the sticky header lane settle
    const g = await geometry(page);
    const where = `${view.width}x${view.height}${view.touch ? ' touch' : ''}${opts.diff ? ' diff' : ''}`;
    expect(g.grid, 'the Grid look is on').toBe(true);
    if (opts.long) {
      // A long document is as long as its content: the area (or, on a touch
      // phone, the page) scrolls.
      if (view.touch) expect(g.pageScrollHeight).toBeGreaterThan(g.viewHeight + 200);
      else expect(g.mainScrollHeight).toBeGreaterThan(g.mainClientHeight + 200);
      expect(g.cardHeight).toBeGreaterThan(view.height);
      return;
    }
    if (view.touch && !opts.diff) {
      // The touch phone: the page scrolls, not the area, and "Ready to finish?"
      // follows the card. The card ends above the panel and grows until the
      // panel sits at the bottom of the view, with no empty grid below it
      // (before, the panel ended about 100px above the bottom); the page does
      // not overflow.
      expect(g.completionTop, `${where}: "Ready to finish?" is shown`).not.toBeNull();
      expect(g.cardBottom, `${where}: the card ends above "Ready to finish?"`).toBeLessThanOrEqual(g.completionTop!);
      expect(g.mainBottom - g.completionBottom!, `${where}: the panel ends ${Math.round(g.mainBottom - g.completionBottom!)}px above the bottom`).toBeLessThanOrEqual(20);
      expect(g.pageScrollHeight, `${where}: the page does not overflow`).toBeLessThanOrEqual(g.viewHeight + 1);
    } else {
      // A short document's card runs to the area's bottom padding (32px on a
      // desktop, 12px on a phone), and does not make the area or page scroll.
      expect(g.mainBottom - g.cardBottom, `${where}: card ends ${Math.round(g.mainBottom - g.cardBottom)}px above the bottom`).toBeLessThanOrEqual(40);
      expect(g.cardBottom).toBeLessThanOrEqual(g.mainBottom);
      expect(g.mainScrollHeight).toBeLessThanOrEqual(g.mainClientHeight + 1);
      expect(g.pageScrollHeight, `${where}: the page does not overflow`).toBeLessThanOrEqual(g.viewHeight + 1);
    }
    expect(g.inFillColumn, `${where}: the card sits in the filling column`).toBe(true);
  } finally {
    await context.close();
  }
}

for (const kind of ['plan', 'annotate'] as const) {
  test(`${kind}: the Grid paper reaches the bottom of the view for a short document, a long one still scrolls`, async ({ browser }) => {
    expect(existsSync(binary), 'build the scratch binary first').toBe(true);
    const root = inboxScratch(`plannotator-grid-paper-${kind}-e2e-`);
    mkdirSync(join(root, 'data'), { recursive: true });
    const children: ChildProcess[] = [];
    try {
      const short = await start(root, kind, SHORT, 1);
      children.push(short.child);
      await check(browser, short.url, DESKTOP);
      await check(browser, short.url, NARROW);
      await check(browser, short.url, PHONE);
      await stop(short.child);

      const long = await start(root, kind, LONG, 2);
      children.push(long.child);
      await check(browser, long.url, DESKTOP, { long: true });
      await check(browser, long.url, NARROW, { long: true });
      await check(browser, long.url, PHONE, { long: true });
    } finally {
      for (const child of children) await stop(child);
      await removeInboxScratch(root);
    }
  });
}

test('plan: a short plan diff keeps the Grid paper full height', async ({ browser }) => {
  expect(existsSync(binary), 'build the scratch binary first').toBe(true);
  const root = inboxScratch('plannotator-grid-paper-diff-e2e-');
  mkdirSync(join(root, 'data'), { recursive: true });
  const children: ChildProcess[] = [];
  try {
    // Version 1, then the revised plan as version 2 in the same project.
    const first = await start(root, 'plan', SHORT, 1);
    children.push(first.child);
    await stop(first.child);
    const revised = await start(root, 'plan', SHORT_REVISED, 2);
    children.push(revised.child);
    await check(browser, revised.url, DESKTOP, { diff: true });
    await check(browser, revised.url, PHONE, { diff: true });
  } finally {
    for (const child of children) await stop(child);
    await removeInboxScratch(root);
  }
});
