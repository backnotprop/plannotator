import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const FOLDER = 'add-refund-flow';

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

interface HeaderFit {
  text: string;
  last: string;
  lastCut: boolean;
  foldersCut: boolean;
  inOrder: boolean;
}

async function headerFit(page: Page): Promise<HeaderFit> {
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const name = document.querySelector<HTMLElement>('[data-header-document-name]');
    const folders = name?.querySelector<HTMLElement>('[data-start-cut-path-folders]');
    const last = name?.querySelector<HTMLElement>('[data-start-cut-path-last]');
    if (!name || !folders || !last) throw new Error('Expected the header to name a path, in its two parts');
    const text = document.createTreeWalker(folders, NodeFilter.SHOW_TEXT).nextNode()!;
    const all = text.textContent ?? '';
    const range = document.createRange();
    const charRight = (i: number) => { range.setStart(text, i); range.setEnd(text, i + 1); return range.getBoundingClientRect().right; };
    const lastRight = charRight(all.length - 1);
    const inOrder = Array.from({ length: all.length }, (_, i) => charRight(i)).every((r) => r <= lastRight + 0.5)
      && Math.abs(lastRight - last.getBoundingClientRect().left) <= 1;
    return {
      text: name.textContent ?? '',
      last: last.textContent ?? '',
      lastCut: last.scrollWidth > last.clientWidth,
      foldersCut: folders.scrollWidth > folders.clientWidth,
      inOrder,
    };
  });
}

test('annotate a folder: the header names the folder, cut from the start, and the tab names the open file', async ({ browser }) => {
  expect(existsSync(binary), 'build the scratch binary first').toBe(true);
  const root = inboxScratch('plannotator-folder-session-header-e2e-');
  mkdirSync(join(root, 'data'), { recursive: true });
  const folder = join(root, FOLDER);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'proposal.md'), '# Proposal: add the refund flow\n\nWhy and what.\n');
  const ready = join(root, 'ready.jsonl');
  const child: ChildProcess = spawn(binary, ['annotate', folder], {
    cwd: root,
    stdio: 'ignore',
    env: {
      PATH: process.env.PATH ?? '', HOME: root,
      PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_READY_FILE: ready,
      PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER,
      PLANNOTATOR_SKIP_BROWSER_OPEN: '1', PLANNOTATOR_REMOTE: '0', PLANNOTATOR_INBOX_CONNECT: '0',
    },
  });
  let url: string | null = null;
  try {
    await expect.poll(() => existsSync(ready) ? readFileSync(ready, 'utf8') : '', { timeout: 30_000 }).toContain('"url"');
    url = JSON.parse(readFileSync(ready, 'utf8').trim().split('\n')[0]!).url as string;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    await context.addCookies(COOKIES.map(([name, value]) => ({ name, value, url })));
    const page = await context.newPage();
    await page.goto(url);
    await page.getByText('proposal', { exact: true }).first().click();
    await expect(page.locator('article[data-print-region="article"]:visible h1')).toHaveText(/^Proposal/);

    let f = await headerFit(page);
    expect(f.text, '1440: the header names the folder, as its path').toBe(folder);
    expect(f.last).toBe(FOLDER);
    expect(f.lastCut, '1440: the folder name is whole').toBe(false);
    expect(f.inOrder, '1440: the path reads in order').toBe(true);
    await expect(page).toHaveTitle(/^proposal\.md · /);

    await page.setViewportSize({ width: 560, height: 800 });
    f = await headerFit(page);
    expect(f.foldersCut, '560: the parent folders give way').toBe(true);
    expect(f.lastCut, '560: the folder name is whole').toBe(false);
    expect(f.inOrder, '560: the path reads in order up to the folder name').toBe(true);
    await context.close();
  } finally {
    if (url) await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
    if (child.exitCode === null) {
      await new Promise((done) => { const timer = setTimeout(done, 5_000); child.once('exit', () => { clearTimeout(timer); done(undefined); }); });
      // inbox-guard: own child (the annotate CLI this test spawned, never an Inbox).
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await removeInboxScratch(root);
  }
});
