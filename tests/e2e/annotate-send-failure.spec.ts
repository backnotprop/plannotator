/**
 * #1392: `plannotator annotate`, a global comment, the server process killed
 * with the page still open, then Send Feedback. Before, the POST failed with
 * ERR_CONNECTION_REFUSED and the page showed nothing, so the reviewer thought
 * it was sent. Now the page stays as it was and says "Feedback not sent",
 * with Retry and Copy feedback; the comment's autosaved draft comes back when
 * the same file is opened again. A send from a second window after the first
 * one decided says the review was already decided, with no Retry.
 *
 * Against the compiled binary (see inbox.spec.ts for the build), under a temp
 * HOME and PLANNOTATOR_DATA_DIR, headless. PNGs of the failure, light and
 * dark at 1440 by 900, land in .local/proof/ (PLANNOTATOR_E2E_PROOF_DIR).
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof'));

const SEEN_COOKIES = [
  ['plannotator-plan-look-choice-resolved', 'true'],
  ['plannotator-announce-tui-herdr-seen', '1'],
  ['plannotator-announce-inbox-seen', '1'],
  ['plannotator-announce-ask-session-seen', '1'],
  ['plannotator-announce-agent-tool-seen', '1'],
  ['plannotator-look-feel-announcement-seen', '2'],
  ['plannotator-vim-mode-announcement-seen', '2'],
  ['plannotator-plan-ai-announcement-seen', '1'],
  ['plannotator-permission-mode-configured', 'true'],
];

const COMMENT = 'Keep the second example, it is the clearest one';

function childEnv(root: string, ready: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '', HOME: root,
    PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_READY_FILE: ready,
    PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER,
    PLANNOTATOR_SKIP_BROWSER_OPEN: '1', PLANNOTATOR_REMOTE: '0', PLANNOTATOR_INBOX_CONNECT: '0',
  };
}

/** Starts `plannotator annotate sample.md` and answers its URL. */
async function startAnnotate(root: string, run: number): Promise<{ child: ChildProcess; url: string }> {
  const ready = join(root, `ready-${run}.jsonl`);
  const child = spawn(binary, ['annotate', 'sample.md'], { cwd: root, stdio: 'ignore', env: childEnv(root, ready) });
  await expect.poll(() => existsSync(ready) ? readFileSync(ready, 'utf8') : '', { timeout: 20_000 }).toContain('"url"');
  return { child, url: JSON.parse(readFileSync(ready, 'utf8').trim().split('\n')[0]!).url };
}

/** Kills the annotate server outright, the way the report ends it. */
async function killServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(done => child.once('exit', () => done()));
  // inbox-guard: own child (only the annotate CLI this test spawned).
  child.kill('SIGKILL');
  await exited;
}

async function open(browser: Browser, url: string, scheme: 'light' | 'dark'): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  await context.addCookies([['plannotator-theme', scheme], ...SEEN_COOKIES].map(([name, value]) => ({ name: name!, value: value!, url })));
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(url);
  return { context, page };
}

// A Retry dismisses the old toast as it shows the new one; sonner keeps the
// old one in the DOM (data-removed="true") through its exit animation.
const failureToast = (page: Page) => page.locator('[data-sonner-toast]:not([data-removed="true"])').filter({ hasText: 'Feedback not sent' });

/** Send Feedback against the dead server: the message, and nothing else changes. */
async function sendAndExpectFailure(page: Page): Promise<void> {
  const primary = page.locator('[data-decision-primary]');
  await expect(primary).toContainText('Send Feedback');
  await primary.click();
  const toast = failureToast(page);
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("isn't running");
  await expect(toast.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(toast.getByRole('button', { name: 'Copy feedback' })).toBeVisible();
  // Never a sent or closing state, and the session stays reviewable.
  await expect(page.locator('[data-completion-state]')).toHaveCount(0);
  await expect(primary).toBeEnabled();
  await expect(page.getByText(COMMENT).first()).toBeVisible();
}

test('annotate: the server killed under an open page, Send Feedback says it was not sent', async ({ browser }) => {
  expect(existsSync(binary), 'build the scratch binary first').toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-annotate-send-failure-e2e-');
  writeFileSync(join(root, 'sample.md'), '# Sample\n\nThe first example.\n\nThe second example.\n');
  const children: ChildProcess[] = [];
  try {
    // Light: comment, let the draft autosave, kill the server, send.
    const first = await startAnnotate(root, 1);
    children.push(first.child);
    const light = await open(browser, first.url, 'light');
    await light.page.getByRole('button', { name: 'Global comment', exact: true }).click();
    const composer = light.page.locator('[data-comment-popover]');
    await composer.getByPlaceholder('Add a global comment...').fill(COMMENT);
    const draftSaved = light.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/draft' && r.request().method() === 'POST');
    await composer.getByRole('button', { name: 'Add', exact: true }).click();
    expect((await draftSaved).ok()).toBe(true);

    await killServer(first.child);
    await sendAndExpectFailure(light.page);
    await light.page.waitForTimeout(500); // sonner's enter transition
    await light.page.screenshot({ path: join(proofDir, 'annotate-send-failure-light.png') });

    // Copy feedback copies the feedback, framed as the panel's Copy frames it.
    const toast = failureToast(light.page);
    await toast.getByRole('button', { name: 'Copy feedback' }).click();
    await expect(toast.getByRole('button', { name: 'Copied' })).toBeVisible();
    const copied = await light.page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(COMMENT);
    expect(copied).toContain('sample.md');

    // Retry against the still-dead server fails the same visible way.
    await toast.getByRole('button', { name: 'Retry' }).click();
    await expect(failureToast(light.page)).toBeVisible();
    await expect(light.page.locator('[data-completion-state]')).toHaveCount(0);
    await light.context.close();

    // Dark: the same file opened again offers the autosaved comment back.
    const second = await startAnnotate(root, 2);
    children.push(second.child);
    const dark = await open(browser, second.url, 'dark');
    await expect(dark.page.getByText('Draft Recovered')).toBeVisible();
    await dark.page.getByRole('button', { name: 'Restore' }).click();
    await expect(dark.page.getByText(COMMENT).first()).toBeVisible();

    await killServer(second.child);
    await sendAndExpectFailure(dark.page);
    await dark.page.waitForTimeout(500);
    await dark.page.screenshot({ path: join(proofDir, 'annotate-send-failure-dark.png') });
    await dark.context.close();
  } finally {
    for (const child of children) await killServer(child);
    await removeInboxScratch(root);
  }
});

test('annotate: a second window sending after the first one did says it was already decided, with no Retry', async ({ browser }) => {
  expect(existsSync(binary), 'build the scratch binary first').toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-annotate-send-decided-e2e-');
  writeFileSync(join(root, 'sample.md'), '# Sample\n\nThe first example.\n\nThe second example.\n');
  let child: ChildProcess | undefined;
  try {
    const started = await startAnnotate(root, 1);
    child = started.child;
    const first = await open(browser, started.url, 'light');
    const second = await first.context.newPage();
    second.setDefaultTimeout(15_000);
    await second.goto(started.url);

    for (const [page, text] of [[first.page, 'From the first window'], [second, COMMENT]] as const) {
      await page.getByRole('button', { name: 'Global comment', exact: true }).click();
      const composer = page.locator('[data-comment-popover]');
      await composer.getByPlaceholder('Add a global comment...').fill(text);
      await composer.getByRole('button', { name: 'Add', exact: true }).click();
    }

    // The first window sends; the server keeps answering for a moment after
    // the decision, and refuses the second window's send as already decided.
    await first.page.locator('[data-decision-primary]').click();
    await expect(first.page.locator('[data-completion-state]')).toBeVisible();
    await second.locator('[data-decision-primary]').click();
    const toast = failureToast(second);
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('already decided');
    await expect(toast.getByRole('button', { name: 'Copy feedback' })).toBeVisible();
    await expect(toast.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expect(second.locator('[data-completion-state]')).toHaveCount(0);
    await expect(second.getByText(COMMENT).first()).toBeVisible();
    await second.waitForTimeout(500); // sonner's enter transition
    await second.screenshot({ path: join(proofDir, 'annotate-send-already-decided-light.png') });
    await first.context.close();
  } finally {
    if (child) await killServer(child);
    await removeInboxScratch(root);
  }
});
