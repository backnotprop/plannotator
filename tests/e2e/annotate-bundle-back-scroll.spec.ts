/**
 * Back in a review of several files keeps the reader's place (#2128, the
 * bundle follow-up of #2082), proved in a real browser against the compiled
 * binary. `plannotator annotate review-alpha.md review-beta.md` (the issue's
 * fixture): from the middle of review-alpha.md, follow a link to a linked
 * markdown document and use the sidebar's "Back to review-alpha.md", then
 * follow a link to a local HTML page and use the header's Back. Both times
 * the bundle file comes back where it was left, not at its top.
 *
 * Each annotate CLI runs under a temp PLANNOTATOR_DATA_DIR and HOME and is
 * closed with /api/exit. Build the binary first (see inbox.spec.ts), then
 * `bun run test:e2e:inbox`.
 */

import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

/** The issue's fixture: a long bundle file whose every section links out. */
function writeFixture(dir: string) {
  mkdirSync(dir, { recursive: true });
  const sections = ['# Review document\n\n'];
  for (let i = 1; i <= 80; i++) {
    sections.push(
      `## Section ${i}\n\n[Open linked Markdown](linked.md) · [Open HTML module](module.html)\n\n${'Plain sample text for a long document. '.repeat(12)}\n\n`,
    );
  }
  writeFileSync(join(dir, 'review-alpha.md'), sections.join(''));
  writeFileSync(join(dir, 'review-beta.md'), '# Second document\n\nSample text.\n');
  writeFileSync(join(dir, 'linked.md'), '# Linked document\n\nSample text.\n');
  writeFileSync(
    join(dir, 'module.html'),
    '<!doctype html><html><head><title>Sample module</title></head><body><h1>Sample module</h1><p>Sample text.</p></body></html>',
  );
}

async function annotateBundle() {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-annotate-bundle-back-e2e-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const fixture = join(root, 'scroll-back-repro');
  writeFixture(fixture);
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
  const child: ChildProcess = spawn(
    binary,
    ['annotate', join(fixture, 'review-alpha.md'), join(fixture, 'review-beta.md')],
    { env, cwd: root, stdio: 'ignore' },
  );
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

/** The document's scroll container (`<main>` on desktop). */
const scrollTop = (page: Page) => page.evaluate(() => document.querySelector('main')!.scrollTop);

/** Where "Section 40" sits from the top of the scroll container. */
const section40Offset = (page: Page) =>
  page.evaluate(() => {
    const main = document.querySelector('main')!;
    const heading = Array.from(main.querySelectorAll('h2')).find((h) => h.textContent?.trim() === 'Section 40')!;
    return heading.getBoundingClientRect().top - main.getBoundingClientRect().top;
  });

async function scrollToSection40(page: Page) {
  await page.evaluate(() => {
    const main = document.querySelector('main')!;
    const heading = Array.from(main.querySelectorAll('h2')).find((h) => h.textContent?.trim() === 'Section 40')!;
    main.scrollTop += heading.getBoundingClientRect().top - main.getBoundingClientRect().top - 120;
  });
  await page.waitForTimeout(300);
}

test('Back to a bundle file restores the reading position, from a linked markdown and from a linked HTML page', async ({ browser }) => {
  const session = await annotateBundle();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    await context.addCookies(
      [
        ['plannotator-plan-look-choice-resolved', 'true'],
        ['plannotator-announce-tui-herdr-seen', '1'],
        ['plannotator-announce-inbox-seen', '1'],
        ['plannotator-announce-ask-session-seen', '1'],
        ['plannotator-announce-agent-tool-seen', '1'],
      ].map(([name, value]) => ({ name: name!, value: value!, url: session.url })),
    );
    const page = await context.newPage();
    await page.goto(session.url);
    await expect(page.locator('main h2', { hasText: 'Section 80' })).toBeAttached();

    // 1. Linked markdown, sidebar Back.
    await scrollToSection40(page);
    const before = await scrollTop(page);
    const offsetBefore = await section40Offset(page);
    expect(before).toBeGreaterThan(5_000);
    await page.locator('main a', { hasText: 'Open linked Markdown' }).nth(39).click();
    await expect(page.locator('main h1', { hasText: 'Linked document' })).toBeVisible();
    await page.getByRole('button', { name: /Back to review-alpha\.md/ }).first().click();
    await expect(page.locator('main h2', { hasText: 'Section 80' })).toBeAttached();
    await page.waitForTimeout(3_000);
    const afterMarkdown = await scrollTop(page);
    console.log(`markdown: before ${before}px, after Back ${afterMarkdown}px`);
    expect(Math.abs(afterMarkdown - before)).toBeLessThan(80);
    expect(Math.abs((await section40Offset(page)) - offsetBefore)).toBeLessThan(80);

    // 2. Linked HTML page, header Back.
    await scrollToSection40(page);
    const beforeHtml = await scrollTop(page);
    const offsetBeforeHtml = await section40Offset(page);
    await page.locator('main a', { hasText: 'Open HTML module' }).nth(39).click();
    const back = page.locator('[data-html-back]');
    await expect(back).toBeVisible();
    await back.click();
    await expect(page.locator('main h2', { hasText: 'Section 80' })).toBeAttached();
    await page.waitForTimeout(3_000);
    const afterHtml = await scrollTop(page);
    console.log(`html: before ${beforeHtml}px, after Back ${afterHtml}px`);
    expect(Math.abs(afterHtml - beforeHtml)).toBeLessThan(80);
    expect(Math.abs((await section40Offset(page)) - offsetBeforeHtml)).toBeLessThan(80);
  } finally {
    await context.close();
    await session.close();
  }
});
