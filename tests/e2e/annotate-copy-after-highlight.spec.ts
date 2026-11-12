import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

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

const SENTINEL = 'clipboard before the copy';

async function copied(page: Page): Promise<string> {
  await page.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL);
  await page.keyboard.press('ControlOrMeta+c');
  await page.waitForTimeout(200);
  return page.evaluate(() => navigator.clipboard.readText());
}

test('annotate: Ctrl+C copies the highlighted words with the comment composer open', async ({ browser }) => {
  expect(existsSync(binary), 'build the scratch binary first').toBe(true);
  const root = inboxScratch('plannotator-copy-after-highlight-e2e-');
  mkdirSync(join(root, 'data'), { recursive: true });
  const file = join(root, 'notes.md');
  writeFileSync(file, '# Refund flow notes\n\nThe refund service retries a failed payout three times.\n');
  const ready = join(root, 'ready.jsonl');
  const child: ChildProcess = spawn(binary, ['annotate', file], {
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
    await context.addCookies(COOKIES.map(([name, value]) => ({ name, value, url })));
    const page = await context.newPage();
    await page.goto(url);

    const para = page.getByText('The refund service retries', { exact: false }).first();
    const box = (await para.boundingBox())!;
    await page.mouse.move(box.x + 1, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + 160, box.y + 8, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('.annotation-toolbar')).toBeVisible();
    const selected = await copied(page);
    expect(selected, 'toolbar up: the highlighted words').not.toBe(SENTINEL);
    expect('The refund service retries a failed payout'.startsWith(selected), `a prefix of the line: ${selected}`).toBe(true);

    await page.locator('.annotation-toolbar button.text-annotation-comment').click();
    const area = page.locator('[data-comment-popover] textarea');
    await expect(area).toBeFocused();
    expect(await copied(page), 'composer open, empty textarea: the same words').toBe(selected);

    await area.fill('Why three times?');
    await area.evaluate((t: HTMLTextAreaElement) => t.setSelectionRange(4, 15));
    expect(await copied(page), 'typed text selected: native copy').toBe('three times');
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
