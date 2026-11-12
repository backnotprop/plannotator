import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const FOLDER = 'add-refund-flow';
const TITLE = 'add-refund-flow review';

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

test('annotate a folder with --title: the tab and the header show the title, whichever file is open', async ({ browser }) => {
  expect(existsSync(binary), 'build the scratch binary first').toBe(true);
  const root = inboxScratch('plannotator-session-title-e2e-');
  mkdirSync(join(root, 'data'), { recursive: true });
  const folder = join(root, FOLDER);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'proposal.md'), '# Proposal: add the refund flow\n\nWhy and what.\n');
  writeFileSync(join(folder, 'design.md'), '# Design: the refund flow\n\nHow.\n');
  const ready = join(root, 'ready.jsonl');
  const child: ChildProcess = spawn(binary, ['annotate', '--title', TITLE, folder], {
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
    const header = page.locator('[data-header-document-name]');

    await expect(page).toHaveTitle(TITLE);
    await expect(header).toHaveText(TITLE);

    await page.getByText('proposal', { exact: true }).first().click();
    await expect(page.locator('article[data-print-region="article"]:visible h1')).toHaveText(/^Proposal/);
    await expect(page).toHaveTitle(TITLE);
    await expect(header).toHaveText(TITLE);
    await page.getByText('design', { exact: true }).first().click();
    await expect(page.locator('article[data-print-region="article"]:visible h1')).toHaveText(/^Design/);
    await expect(page).toHaveTitle(TITLE);
    await expect(header).toHaveText(TITLE);

    const describedBy = await header.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(folder);
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
