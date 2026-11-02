/**
 * A folder added under Settings → Files opens its documents (#2291), proved in
 * Chromium against the compiled binary. `plannotator annotate` runs on a file
 * in `demo-app`, and the Files sidebar lists `reference-docs`, a folder beside
 * the project (the issue's layout). Clicking a document there renders it.
 * Before the fix the sidebar listed the folder, and opening a document from
 * it answered 403 "Access denied: path is outside project root". An HTML page
 * there renders with no network: its fetch is refused by `connect-src 'none'`.
 *
 * The annotate CLI runs under a temp PLANNOTATOR_DATA_DIR and HOME, opens no
 * browser, and is closed with /api/exit. Build the binary first (see
 * inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

test.use({ actionTimeout: 15_000 });

test('a document in a folder added under Settings → Files opens from the Files sidebar', async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-added-folder-e2e-');
  const dataDir = join(root, 'data');
  const project = join(root, 'demo-app');
  const added = join(root, 'reference-docs');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(added, { recursive: true });
  writeFileSync(join(project, 'notes.md'), '# Project notes\n\nThe session document.\n');
  writeFileSync(join(added, 'intro.md'), '# Reference intro\n\nA document outside the project.\n');
  // An HTML page outside the project: its script tries the network, which the viewer's frame refuses.
  writeFileSync(
    join(added, 'page.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>Outside page</title><script>
      var seen = [];
      document.addEventListener('securitypolicyviolation', function (e) { seen.push(e.violatedDirective); });
      fetch('pic.png', { mode: 'no-cors' }).then(function () { return 'reached'; }, function () { return 'refused'; }).then(function (fetched) {
        setTimeout(function () { document.getElementById('net').textContent = 'fetch: ' + fetched + ' | violated: ' + seen.join(','); }, 100);
      });
    </script></head><body><h1>Outside page</h1><p id="net">probing</p></body></html>`,
  );
  writeFileSync(join(added, 'pic.png'), 'PNG-BYTES');
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
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  const child: ChildProcess = spawn(binary, ['annotate', join(project, 'notes.md')], { env, cwd: project, stdio: 'ignore' });
  let url = '';
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
    url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
    await context.addCookies(
      [
        ['plannotator-plan-look-choice-resolved', 'true'],
        ['plannotator-announce-tui-herdr-seen', '1'],
        ['plannotator-announce-inbox-seen', '1'],
        ['plannotator-announce-ask-session-seen', '1'],
        ['plannotator-announce-agent-tool-seen', '1'],
        // Settings → Files with one added folder, as the settings dialog saves it.
        ['plannotator-filebrowser-enabled', 'true'],
        ['plannotator-filebrowser-dirs', encodeURIComponent(JSON.stringify([added]))],
      ].map(([name, value]) => ({ name: name!, value: value!, url })),
    );
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.locator('main h1', { hasText: 'Project notes' })).toBeVisible();

    // The Files tab: in the open sidebar, or on the collapsed rail.
    await page
      .getByRole('button', { name: 'Files', exact: true })
      .or(page.getByTitle('File Browser', { exact: true }))
      .first()
      .click();
    await expect(page.getByTitle(added, { exact: true })).toBeVisible();
    const docRead = page.waitForResponse((res) => res.url().includes('/api/doc?') && res.url().includes('intro.md'));
    // A file row is titled with its path in the folder.
    await page.locator('button[title="intro.md"]').click();
    expect((await docRead).status()).toBe(200);
    await expect(page.locator('main h1', { hasText: 'Reference intro' })).toBeVisible();
    await expect(page.getByText('A document outside the project.')).toBeVisible();

    // An HTML page there renders in the viewer's frame with no network (connect-src 'none').
    await page.locator('button[title="page.html"]').click();
    const frame = page.frameLocator('iframe[srcdoc]').first();
    await expect(frame.getByRole('heading', { name: 'Outside page' })).toBeVisible();
    await expect(frame.locator('#net')).toHaveText(/^fetch: refused \| violated: connect-src/);
  } finally {
    await context.close();
    if (url) await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
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
  }
});
