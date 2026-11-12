import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

test.use({ actionTimeout: 15_000 });

const TOML = [
  '# Config for the notes-api service (version 1): one file for every environment,',
  '# each key named after its variable (`server.port` is `NOTES_SERVER_PORT`).',
  '',
  '[database]',
  'url = "postgres://localhost:5432/notes"',
  'pool_size = 10',
  '',
].join('\n');

const COMMENT = 'Should this come from the DATABASE_URL secret instead?';

const SEEN_COOKIES = [
  ['plannotator-plan-look-choice-resolved', 'true'],
  ['plannotator-announce-tui-herdr-seen', '1'],
  ['plannotator-announce-inbox-seen', '1'],
  ['plannotator-announce-ask-session-seen', '1'],
  ['plannotator-announce-agent-tool-seen', '1'],
  ['plannotator-look-feel-announcement-seen', '2'],
  ['plannotator-vim-mode-announcement-seen', '2'],
  ['plannotator-plan-ai-announcement-seen', '1'],
];

async function startAnnotate(root: string, target: string): Promise<{ child: ChildProcess; url: string }> {
  const readyFile = join(root, `ready-${Date.now()}.jsonl`);
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_READY_FILE: readyFile,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_SKIP_BROWSER_OPEN: '1',
    PLANNOTATOR_REMOTE: '0',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  const child = spawn(binary, ['annotate', target], { env, cwd: root, stdio: 'ignore' });
  await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
  const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
  return { child, url };
}

async function stop(child: ChildProcess, url: string): Promise<void> {
  await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
  if (child.exitCode !== null) return;
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

const documentCode = (page: Page) => page.locator('[data-block-id] pre code');

async function expectTomlCodeBlock(page: Page): Promise<void> {
  await expect(documentCode(page)).toHaveCount(1);
  await expect(documentCode(page)).toHaveClass(/language-toml/);
  await expect(documentCode(page)).toHaveText(TOML);
  await expect(documentCode(page).locator('span[style]').first()).toBeAttached();
  await expect(page.locator('[data-block-id] :is(h1, h2, h3, h4, h5, h6), :is(h1, h2, h3, h4, h5, h6)[data-block-id]')).toHaveCount(0);
}

async function selectInCode(page: Page, text: string): Promise<void> {
  const box = await documentCode(page).evaluate((code, wanted) => {
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(wanted) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + wanted.length);
      const rect = range.getBoundingClientRect();
      return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
    }
    return null;
  }, text);
  expect(box, `"${text}" is in the code block`).not.toBeNull();
  await page.mouse.move(box!.left + 1, box!.y);
  await page.mouse.down();
  await page.mouse.move(box!.right - 1, box!.y, { steps: 8 });
  await page.mouse.up();
}

test('a .toml opened on its own is one TOML code block, and a line in it takes a comment', async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-config-render-e2e-');
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'config.toml'), TOML);
  const { child, url } = await startAnnotate(root, join(root, 'config.toml'));
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await context.addCookies(SEEN_COOKIES.map(([name, value]) => ({ name: name!, value: value!, url })));
    const page = await context.newPage();
    await page.goto(url);
    await expectTomlCodeBlock(page);

    await selectInCode(page, 'localhost:5432');
    await page.locator('button[title="Comment"]').click();
    const composer = page.locator('[data-comment-popover]');
    await composer.getByPlaceholder('Add a comment...').fill(COMMENT);
    await composer.getByRole('button', { name: /^(Save|Add)$/ }).click();

    await expect(page.locator('[data-annotation-panel] [data-annotation-id]')).toHaveCount(1);
    await expect(page.locator('[data-annotation-panel]')).toContainText(COMMENT);
    await expect(documentCode(page).locator('mark')).toContainText('localhost:5432');
  } finally {
    await context.close();
    await stop(child, url);
    await removeInboxScratch(root);
  }
});

test('a .toml picked from a folder session is the same TOML code block', async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-config-render-folder-e2e-');
  const folder = join(root, 'notes-api');
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'README.md'), '# Notes API\n\nThe service config.\n');
  writeFileSync(join(folder, 'config.toml'), TOML);
  const { child, url } = await startAnnotate(root, folder);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await context.addCookies(SEEN_COOKIES.map(([name, value]) => ({ name: name!, value: value!, url })));
    const page = await context.newPage();
    await page.goto(url);
    await page.locator('button[title="config.toml"]').click();
    await expectTomlCodeBlock(page);
  } finally {
    await context.close();
    await stop(child, url);
    await removeInboxScratch(root);
  }
});

test('the version diff of a .toml is code in every rendered mode, and a changed block takes a comment', async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-config-render-diff-e2e-');
  mkdirSync(join(root, 'data'), { recursive: true });
  const file = join(root, 'config.toml');
  writeFileSync(file, TOML);
  const first = await startAnnotate(root, file);
  await stop(first.child, first.url);
  writeFileSync(file, TOML.replace('(version 1)', '(version 2)').replace('localhost:5432', 'db:5432'));
  const { child, url } = await startAnnotate(root, file);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await context.addCookies(SEEN_COOKIES.map(([name, value]) => ({ name: name!, value: value!, url })));
    const page = await context.newPage();
    await page.goto(url);
    await expect(documentCode(page)).toHaveClass(/language-toml/);
    await page.locator("button[title='Changes since you last reviewed this file']:visible").first().dispatchEvent('click');

    const diff = page.locator('article').filter({ has: page.locator('button[title="Block-level stacked diff (old above new)"]') });
    for (const mode of ['Word-level inline diff (experimental)', 'Block-level stacked diff (old above new)']) {
      await diff.locator(`button[title="${mode}"]`).click();
      await expect(diff.locator('pre[data-plan-diff-code]').first()).toBeVisible();
      await expect(diff.locator('h1, h2, h3, h4, h5, h6')).toHaveCount(0);
      await expect(diff).toContainText('# each key named after its variable');
    }

    const changed = diff.locator('.plan-diff-added').filter({ hasText: 'db:5432' }).first();
    await changed.click();
    const composer = page.locator('[data-comment-popover]');
    await composer.locator('textarea, [contenteditable]').first().fill(COMMENT);
    await composer.getByRole('button', { name: /^(Save|Add)$/ }).click();
    await expect(page.locator('[data-annotation-panel] [data-annotation-id]')).toHaveCount(1);
    await expect(page.locator('[data-annotation-panel]')).toContainText(COMMENT);
  } finally {
    await context.close();
    await stop(child, url);
    await removeInboxScratch(root);
  }
});
