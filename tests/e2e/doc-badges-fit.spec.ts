/**
 * The badges at the top of an annotated document use the room the card has
 * and stop where the document's buttons start. A single file shows its
 * repository and branch; a folder session's open file and a linked document
 * show their file name, with the whole path on hover.
 *
 * Before, each chip had a fixed cap: the repository 140px, the branch 120px,
 * the file name 220px (200px for a linked document). A repository like `acme-corp/payments-service` was cut
 * with most of the row empty beside it. Now the chips grow to the buttons. When
 * the repository and branch do not both fit, the branch gives way first, down
 * to its icon and a letter or two, and only then the repository. The cluster's
 * room is measured against the buttons' place, and it is measured again when
 * the card narrows after first paint. Without that, a page opened at 1100px
 * ran the chips 50px under the buttons.
 *
 * Annotate, a single file in a git repository with a remote (and a document it
 * links to) and a folder of files, at 1440 by 900 (room for everything) and
 * 1100 by 900 (not enough), and a folder file on a 390px phone (the buttons
 * on a row of their own; the badges still stop inside the card).
 * Run against the compiled binary under a temp HOME and PLANNOTATOR_DATA_DIR,
 * headless. Build the binary first (see inbox.spec.ts).
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const BRANCH = 'fix/refund-partial-captures';
// Longer than the old 220px cap (200px for a linked document), short enough for the row at 1440.
const FOLDER_FILE = 'reconciling-refund-ledger-entries-design.md';
const DOC = `# Refund flow: partial captures\n\nHow a refund is split when the payment was captured in parts.\n\nSee the [ledger design](design/${FOLDER_FILE}).\n`;
// Too long for the row at 1100 by far.
const FOLDER_FILE_LONG = 'design-reconciling-refund-ledger-entries-with-the-provider.md';

// Every first-run dialog already seen, so the page opens on the document.
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

const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 1100, height: 900 };
const PHONE = { width: 390, height: 844 };

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

/** A repository with a GitHub remote, on BRANCH, holding one document. */
function buildRepo(root: string, name: string, remote: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['checkout', '-q', '-b', BRANCH]);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['remote', 'add', 'origin', `https://github.com/${remote}.git`]);
  writeFileSync(join(dir, 'refund-flow.md'), DOC);
  mkdirSync(join(dir, 'design'));
  writeFileSync(join(dir, 'design', FOLDER_FILE), '# Ledger design\n\nHow each entry is matched.\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

/** `plannotator annotate <target>` from `cwd` (the repository the chips name). */
async function annotate(root: string, cwd: string, target: string, run: number): Promise<{ child: ChildProcess; url: string }> {
  const ready = join(root, `ready-${run}.jsonl`);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '', HOME: root,
    PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_READY_FILE: ready,
    PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER,
    PLANNOTATOR_SKIP_BROWSER_OPEN: '1', PLANNOTATOR_REMOTE: '0', PLANNOTATOR_INBOX_CONNECT: '0',
  };
  const child = spawn(binary, ['annotate', target], { cwd, stdio: 'ignore', env });
  await expect.poll(() => existsSync(ready) ? readFileSync(ready, 'utf8') : '', { timeout: 30_000 }).toContain('"url"');
  return { child, url: JSON.parse(readFileSync(ready, 'utf8').trim().split('\n')[0]!).url };
}

async function stop(session: { child: ChildProcess; url: string }): Promise<void> {
  const { child } = session;
  await fetch(new URL('/api/exit', session.url), { method: 'POST' }).catch(() => {});
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => {
    const timer = setTimeout(done, 5_000);
    child.once('exit', () => { clearTimeout(timer); done(); });
  });
  await exited;
  // inbox-guard: own child (the annotate CLI this test spawned, never an Inbox).
  if (child.exitCode === null) child.kill('SIGKILL');
}

/** The session in a new window. A folder session opens on its file list, with no document yet. */
async function open(browser: Browser, url: string, view: { width: number; height: number }, folder = false): Promise<Page> {
  const context = await browser.newContext({ viewport: view, colorScheme: 'light' });
  await context.addCookies(COOKIES.map(([name, value]) => ({ name, value, url })));
  const page = await context.newPage();
  await page.goto(url);
  if (!folder) await expect(page.locator('article[data-print-region="article"]')).toBeVisible();
  return page;
}

interface Chip { width: number; cut: boolean }
interface Fit { chips: Record<string, Chip | null>; gapToActions: number | null }

/**
 * Each chip named by its hover text: its width and whether its text is cut
 * (wider than its box: the same test as packages/ui/utils/textCut.ts). And how
 * far the badge cluster ends before the document's buttons, when they share a
 * row (negative: under them; null: the buttons sit on a row of their own).
 */
async function fit(page: Page, titles: Record<string, string>): Promise<Fit> {
  await page.waitForTimeout(500); // fonts and the actions lane settle
  return page.evaluate((titles) => {
    // The document on screen (a folder session keeps others mounted, hidden).
    const article = Array.from(document.querySelectorAll<HTMLElement>('article[data-print-region="article"]'))
      .find((a) => a.getClientRects().length > 0)!;
    const cut = (el: HTMLElement) => {
      if (el.scrollWidth > el.clientWidth) return true;
      const range = document.createRange();
      range.selectNodeContents(el);
      const style = getComputedStyle(el);
      const inner = el.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return range.getBoundingClientRect().width > inner + 0.01;
    };
    const chips: Record<string, { width: number; cut: boolean } | null> = {};
    let cluster: HTMLElement | null = null;
    for (const [key, title] of Object.entries(titles)) {
      const chip = Array.from(article.querySelectorAll<HTMLElement>('[title]')).find((el) => el.title === title) ?? null;
      // The branch chip holds an icon and the name: the name's own span is what gets cut.
      const text = chip?.querySelector<HTMLElement>('span.truncate') ?? chip;
      chips[key] = chip && text ? { width: chip.getBoundingClientRect().width, cut: cut(text) } : null;
      cluster ??= chip?.closest<HTMLElement>('[data-print-hide]') ?? null;
    }
    const actions = article.querySelector<HTMLElement>('[data-sticky-actions-spacer]')
      ?? article.querySelector<HTMLElement>('[data-sticky-actions]');
    const c = cluster?.getBoundingClientRect();
    const a = actions?.getBoundingClientRect();
    const sharesRow = !!(a && c && a.top < c.bottom && a.bottom > c.top);
    return { chips, gapToActions: sharesRow ? a!.left - c!.right : null };
  }, titles);
}

/** The badge row on screen: its right edge, the card's, and each of its buttons' (the open-in button and its menu). */
async function badgeRow(page: Page): Promise<{ right: number; cardRight: number; buttons: { label: string; right: number }[] }> {
  return page.evaluate(() => {
    const article = Array.from(document.querySelectorAll<HTMLElement>('article[data-print-region="article"]'))
      .find((a) => a.getClientRects().length > 0)!;
    const row = article.querySelector<HTMLElement>('[data-print-hide]')!;
    return {
      right: row.getBoundingClientRect().right,
      cardRight: article.getBoundingClientRect().right,
      buttons: Array.from(row.querySelectorAll<HTMLElement>('button')).map((b) => ({
        label: b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '',
        right: b.getBoundingClientRect().right,
      })),
    };
  });
}

test('annotate a file: the repository and branch show whole when there is room, and the branch gives way first', async ({ browser }) => {
  expect(existsSync(binary), 'build the scratch binary first').toBe(true);
  const root = inboxScratch('plannotator-doc-badges-fit-e2e-');
  mkdirSync(join(root, 'data'), { recursive: true });
  const sessions: { child: ChildProcess; url: string }[] = [];
  try {
    const service = buildRepo(root, 'payments-service', 'acme-corp/payments-service');
    const session = await annotate(root, service, join(service, 'refund-flow.md'), 1);
    sessions.push(session);
    const titles = { repo: 'acme-corp/payments-service', branch: BRANCH };

    // Room for both: neither is cut (the old caps cut both).
    let page = await open(browser, session.url, WIDE);
    let f = await fit(page, titles);
    expect(f.chips.repo, 'the repository chip').not.toBeNull();
    expect(f.chips.branch, 'the branch chip').not.toBeNull();
    expect(f.chips.repo!.cut, `1440: the repository is whole (${f.chips.repo!.width}px)`).toBe(false);
    expect(f.chips.branch!.cut, `1440: the branch is whole (${f.chips.branch!.width}px)`).toBe(false);
    expect(f.gapToActions, '1440: the badges end before the buttons').toBeGreaterThanOrEqual(0);

    // The card narrows with the window unchanged (as when the first-run look
    // choice puts it on the grid): the buttons move left without changing
    // size, and the badges are measured again and stop before them.
    await page.evaluate(() => {
      const article = Array.from(document.querySelectorAll<HTMLElement>('article[data-print-region="article"]'))
        .find((a) => a.getClientRects().length > 0)!;
      article.parentElement!.style.maxWidth = `${article.getBoundingClientRect().width - 160}px`;
    });
    f = await fit(page, titles);
    expect(f.gapToActions, `a narrower card: the badges end ${f.gapToActions}px before the buttons`).toBeGreaterThanOrEqual(0);
    expect(f.chips.branch!.cut, 'a narrower card: the branch gives way').toBe(true);
    await page.context().close();

    // A linked document: its file name, with the whole path on hover (the chip
    // found by it). The name is cut only where the row ends at the buttons,
    // never at a fixed width (the old cap was 200px).
    page = await open(browser, session.url, WIDE);
    await page.locator('main a', { hasText: 'ledger design' }).first().click();
    await expect(page.locator('article[data-print-region="article"]:visible h1')).toHaveText(/^Ledger design/);
    f = await fit(page, { linked: join(service, 'design', FOLDER_FILE) });
    expect(f.chips.linked, 'the linked document chip, with its path on hover').not.toBeNull();
    expect(f.chips.linked!.width, '1440: the linked document chip is wider than the old 200px cap').toBeGreaterThan(201);
    const endsAtButtons = f.gapToActions !== null && f.gapToActions <= 12;
    expect(!f.chips.linked!.cut || endsAtButtons,
      `1440: the linked document's name is cut only at the buttons (${f.chips.linked!.width}px, ${f.gapToActions}px before them)`).toBe(true);
    expect(f.gapToActions, '1440: the badges end before the buttons').toBeGreaterThanOrEqual(0);
    await page.context().close();

    // Opened narrow: the branch is cut, the repository is not, and nothing runs under the buttons.
    page = await open(browser, session.url, NARROW);
    f = await fit(page, titles);
    expect(f.gapToActions, `1100: the badges end ${f.gapToActions}px before the buttons`).toBeGreaterThanOrEqual(0);
    expect(f.chips.branch!.cut, '1100: the branch gives way').toBe(true);
    expect(f.chips.repo!.cut, '1100: the repository stays whole while the branch gives way').toBe(false);
    await page.context().close();
    await stop(session);

    // A repository too long for the row: it is cut too, and the branch keeps its icon and a letter or two.
    const ledger = buildRepo(root, 'ledger', 'acme-corp/payments-service-refund-reconciliation-ledger');
    const long = await annotate(root, ledger, join(ledger, 'refund-flow.md'), 2);
    sessions.push(long);
    page = await open(browser, long.url, NARROW);
    f = await fit(page, { repo: 'acme-corp/payments-service-refund-reconciliation-ledger', branch: BRANCH });
    expect(f.gapToActions, `1100: the badges end ${f.gapToActions}px before the buttons`).toBeGreaterThanOrEqual(0);
    expect(f.chips.repo!.cut, '1100: the long repository is cut').toBe(true);
    expect(f.chips.branch!.width, `1100: the branch keeps its floor (${f.chips.branch!.width}px)`).toBeGreaterThanOrEqual(36);
    await page.context().close();
  } finally {
    for (const session of sessions) await stop(session);
    await removeInboxScratch(root);
  }
});

test('annotate a folder: the open file\'s name shows whole when there is room, and stops at the buttons', async ({ browser }) => {
  expect(existsSync(binary), 'build the scratch binary first').toBe(true);
  const root = inboxScratch('plannotator-doc-badges-fit-folder-e2e-');
  mkdirSync(join(root, 'data'), { recursive: true });
  const sessions: { child: ChildProcess; url: string }[] = [];
  try {
    const folder = join(root, 'add-refund-flow');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'proposal.md'), '# Proposal: add the refund flow\n\nWhy and what.\n');
    writeFileSync(join(folder, FOLDER_FILE), '# Reconciling refund ledger entries\n\nHow the ledger matches the provider.\n');
    writeFileSync(join(folder, FOLDER_FILE_LONG), '# Design: reconciling refund ledger entries\n\nWith the provider.\n');
    const session = await annotate(root, root, folder, 1);
    sessions.push(session);

    const page = await open(browser, session.url, WIDE, true);
    const pick = async (file: string, heading: RegExp) => {
      await page.getByText(file.replace(/\.md$/, ''), { exact: true }).first().click();
      await expect(page.locator('article[data-print-region="article"]:visible h1')).toHaveText(heading);
    };
    await pick(FOLDER_FILE, /^Reconciling/);
    let f = await fit(page, { file: join(folder, FOLDER_FILE) });
    expect(f.chips.file, 'the file name chip').not.toBeNull();
    expect(f.chips.file!.cut, `1440: the file name is whole (${f.chips.file!.width}px; the old cap was 220px)`).toBe(false);
    expect(f.gapToActions, '1440: the badges end before the buttons').toBeGreaterThanOrEqual(0);

    // A long name, narrowed in place: the name is cut where the buttons start.
    await pick(FOLDER_FILE_LONG, /^Design: reconciling/);
    await page.setViewportSize(NARROW);
    f = await fit(page, { file: join(folder, FOLDER_FILE_LONG) });
    expect(f.chips.file!.cut, '1100: the file name is cut').toBe(true);
    expect(f.gapToActions, `1100: the badges end ${f.gapToActions}px before the buttons`).toBeGreaterThanOrEqual(0);

    // A phone: the buttons drop to a row of their own, and the badges still
    // stop inside the card, so the name is cut and the open-in button stays on screen.
    await page.setViewportSize(PHONE);
    f = await fit(page, { file: join(folder, FOLDER_FILE_LONG) });
    expect(f.chips.file!.cut, '390: the file name is cut').toBe(true);
    const row = await badgeRow(page);
    expect(row.right, `390: the badge row ends at ${row.right}px, inside the card (${row.cardRight}px)`).toBeLessThanOrEqual(row.cardRight);
    expect(row.buttons.length, '390: the badge row has its buttons').toBeGreaterThan(0);
    for (const button of row.buttons) {
      expect(button.right, `390: "${button.label}" ends at ${button.right}px, inside the card (${row.cardRight}px)`).toBeLessThanOrEqual(row.cardRight);
    }
    await page.context().close();
  } finally {
    for (const session of sessions) await stop(session);
    await removeInboxScratch(root);
  }
});
