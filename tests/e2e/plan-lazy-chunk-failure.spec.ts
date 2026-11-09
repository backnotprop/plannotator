/**
 * Since #1618 the plan page loads its diagram and embed components as chunks
 * from `/assets/*`, where they used to be inlined. A chunk that cannot load
 * (a flaky link, a server that stopped, a tab older than the server's build)
 * used to blank the whole app and take the reviewer's unsent comments and
 * edits off the screen. Proved in Chromium against the compiled binary:
 *
 *  - one aborted request for the Mermaid block's chunk leaves the app
 *    mounted: the diagram's source shows under "Couldn't load this view" with
 *    a Reload action, and a comment added before it is still there;
 *  - the chunk answered with 404 (an old tab after an upgrade on the same
 *    port) says "This page was updated" instead.
 *
 * Every CLI runs under a temp PLANNOTATOR_DATA_DIR and HOME, opens no browser,
 * and is closed by this test. Build the binary first (see inbox.spec.ts), then
 * `bun run test:e2e:inbox`.
 */
import { expect, test, type Browser, type Page, type Route } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

test.use({ actionTimeout: 15_000 });

const NOTE = 'LAZY_NOTE: keep this comment on screen';
const PLAN = ['# Lazy chunk plan', '', 'Prose before the diagram.', ''].join('\n');
const FENCE = '\n```mermaid\nflowchart LR\n  Kept-->Source\n```\n';
const MERMAID_CHUNK = /\/assets\/MermaidBlock-[^/]*\.js$/;

/** Plan review (`plannotator` reading a PermissionRequest on stdin) in a scratch project. */
async function startPlanReview(): Promise<{ url: string; close: () => Promise<void> }> {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-plan-lazy-chunk-e2e-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
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
  const child: ChildProcess = spawn(binary, [], { env, cwd: root, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin!.end(
    JSON.stringify({
      session_id: 'e2e',
      transcript_path: join(root, 'transcript.jsonl'),
      cwd: root,
      permission_mode: 'plan',
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: PLAN },
    }),
  );
  await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
  const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
  const close = async () => {
    if (child.exitCode === null) {
      // A plan review ends with a decision; deny what is left so the CLI exits.
      await fetch(new URL('/api/deny', url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: 'e2e teardown', planSave: { enabled: false } }),
      }).catch(() => {});
      await new Promise((done) => {
        const timer = setTimeout(done, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          done(undefined);
        });
      });
      // inbox-guard: own child (the CLI this test spawned, never an Inbox)
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await removeInboxScratch(root);
  };
  return { url, close };
}

/** The plan page, with the chunk requests for the Mermaid block sent to `onChunk`. */
async function openReview(browser: Browser, url: string, onChunk: (route: Route) => Promise<void>): Promise<{ page: Page; pageErrors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies(
    [
      ['plannotator-theme', 'light'],
      ['plannotator-plan-look-choice-resolved', 'true'],
      ['plannotator-announce-tui-herdr-seen', '1'],
      ['plannotator-announce-inbox-seen', '1'],
      ['plannotator-announce-ask-session-seen', '1'],
      ['plannotator-announce-agent-tool-seen', '1'],
      ['plannotator-permission-mode-configured', 'true'],
    ].map(([name, value]) => ({ name: name!, value: value!, url })),
  );
  await context.route(MERMAID_CHUNK, onChunk);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(url);
  await expect(page.locator('article').getByRole('heading', { name: 'Lazy chunk plan' })).toBeVisible();
  return { page, pageErrors };
}

/** A global comment, then a Mermaid fence typed in Edit mode: the diagram's chunk is asked for only now. */
async function commentThenAddDiagram(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Global comment', exact: true }).click();
  const composer = page.locator('[data-comment-popover]');
  await composer.getByPlaceholder('Add a global comment...').fill(NOTE);
  await composer.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText(NOTE).first()).toBeVisible();

  await page.getByText(/^Edit$/).first().click();
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText(FENCE);
  await page.getByText(/^Done$/).first().click();
}

async function expectAppKeptWithFallback(page: Page, pageErrors: string[], message: string, action: string): Promise<void> {
  const block = page.locator('[data-diagram-block="mermaid"]');
  const notice = block.locator('[data-lazy-load-failed]');
  await expect(notice).toContainText(message);
  const reload = notice.getByRole('button', { name: action, exact: true });
  await expect(reload).toBeVisible();
  // A tap target, not just the word: at least 24px tall (44px on touch screens).
  expect((await reload.boundingBox())!.height).toBeGreaterThanOrEqual(24);
  // The fence's source stands in for the diagram.
  await expect(block.locator('pre')).toHaveText(/flowchart LR\s+Kept-->Source/);
  // The rest of the app is still there, comment included.
  await expect(page.locator('article').getByRole('heading', { name: 'Lazy chunk plan' })).toBeVisible();
  await expect(page.getByText('Prose before the diagram.')).toBeVisible();
  await expect(page.getByText(NOTE).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Options/ })).toBeVisible();
  expect(pageErrors).toEqual([]);
}

test('plan review: an aborted diagram chunk shows the source with Reload and keeps the app and its comment', async ({ browser }) => {
  const session = await startPlanReview();
  try {
    let aborted = 0;
    const { page, pageErrors } = await openReview(browser, session.url, async (route) => {
      // One flaky request; anything after it (the notice's HEAD check) goes through.
      if (aborted++ === 0) await route.abort('connectionreset');
      else await route.continue();
    });
    await commentThenAddDiagram(page);
    await expectAppKeptWithFallback(page, pageErrors, "Couldn't load this view.", 'Reload');
    expect(aborted).toBeGreaterThanOrEqual(1);
  } finally {
    await session.close();
  }
});

test('plan review: a diagram chunk the server no longer has (404) says the page was updated', async ({ browser }) => {
  const session = await startPlanReview();
  try {
    const { page, pageErrors } = await openReview(browser, session.url, (route) =>
      route.fulfill({ status: 404, contentType: 'text/plain; charset=utf-8', body: 'Not found' }),
    );
    await commentThenAddDiagram(page);
    await expectAppKeptWithFallback(page, pageErrors, 'This page was updated.', 'Reload to see this');
  } finally {
    await session.close();
  }
});
