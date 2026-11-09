/**
 * Plan review with linked documents keeps every document's comments across a
 * reload (#1545), proved in Chromium against the compiled binary.
 *
 * The plan links two documents. The reviewer comments on the plan and on the
 * first document, then opens the second one, which has no comments, and
 * reloads. Draft Recovered offers both comments; after Restore the plan's
 * comment is on the plan and the document's comment is on that document, and
 * the feedback the agent receives says so. Before the fix, opening the empty
 * document deleted the plan's draft and the reload offered nothing.
 *
 * Every CLI runs under a temp PLANNOTATOR_DATA_DIR and HOME, opens no browser,
 * and is closed by this test. Build the binary first (see inbox.spec.ts), then
 * `bun run test:e2e:inbox`.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

test.use({ actionTimeout: 15_000 });

const PLAN_NOTE = 'PLAN_NOTE: split the migration into two steps';
const DESIGN_NOTE = 'DESIGN_NOTE: the cache section is out of date';

const PLAN = [
  '# Move the cache to Redis',
  '',
  'Read [the design](docs/design.md) first, then [the empty page](docs/empty.md).',
  '',
  '## Steps',
  '',
  '1. Add the Redis client.',
  '2. Move reads, then writes.',
  '',
].join('\n');

interface Session {
  url: string;
  stdout: () => string;
  close: () => Promise<void>;
}

/** Plan review (`plannotator` reading a PermissionRequest on stdin) in a scratch project. */
async function startPlanReview(): Promise<Session> {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-plan-linked-drafts-e2e-');
  const dataDir = join(root, 'data');
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(root, 'docs', 'design.md'), '# Design\n\nThe cache lives in process memory today.\n');
  writeFileSync(join(root, 'docs', 'empty.md'), '# Empty page\n\nNothing to review here.\n');
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
  let out = '';
  const child: ChildProcess = spawn(binary, [], { env, cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
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
  child.stdout!.on('data', (chunk) => {
    out += String(chunk);
  });
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
  return { url, stdout: () => out, close };
}

async function openReview(browser: Browser, url: string): Promise<Page> {
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
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

async function addGlobalComment(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'Global comment', exact: true }).click();
  const composer = page.locator('[data-comment-popover]');
  await composer.getByPlaceholder('Add a global comment...').fill(text);
  await composer.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText(text).first()).toBeVisible();
}

const openLinked = async (page: Page, name: string, heading: string) => {
  await page.locator('article').getByRole('link', { name }).click();
  await expect(page.locator('article').getByRole('heading', { name: heading })).toBeVisible();
};

const backToPlan = async (page: Page) => {
  await page.getByRole('button', { name: /Back to plan/ }).first().click();
  await expect(page.locator('article').getByRole('heading', { name: 'Move the cache to Redis' })).toBeVisible();
};

test('plan review: comments on the plan and a linked document survive opening an empty document and a reload', async ({ browser }) => {
  const session = await startPlanReview();
  try {
    const page = await openReview(browser, session.url);
    await expect(page.locator('article').getByRole('heading', { name: 'Move the cache to Redis' })).toBeVisible();

    await addGlobalComment(page, PLAN_NOTE);
    await openLinked(page, 'the design', 'Design');
    await addGlobalComment(page, DESIGN_NOTE);
    await backToPlan(page);
    await openLinked(page, 'the empty page', 'Empty page');
    // Past both draft writers' 500ms debounce.
    await page.waitForTimeout(1_500);

    await page.reload();
    await expect(page.getByText('Draft Recovered')).toBeVisible();
    await expect(page.getByText('Found 2 annotations (including comments on 1 linked document)')).toBeVisible();
    await page.getByRole('button', { name: 'Restore' }).click();

    // The plan's comment is back on the plan.
    await expect(page.getByText(PLAN_NOTE).first()).toBeVisible();
    // The design's comment is back on the design.
    await openLinked(page, 'the design', 'Design');
    await expect(page.getByText(DESIGN_NOTE).first()).toBeVisible();
    await backToPlan(page);

    // The agent receives each comment under its own document.
    await page.getByRole('button', { name: 'Send Feedback', exact: true }).first().click();
    await expect.poll(session.stdout, { timeout: 15_000 }).toContain('Linked Document Feedback');
    const output = session.stdout();
    const linkedSection = output.indexOf('Linked Document Feedback');
    expect(output.indexOf('PLAN_NOTE')).toBeGreaterThan(-1);
    expect(output.indexOf('PLAN_NOTE')).toBeLessThan(linkedSection);
    expect(output.indexOf('DESIGN_NOTE')).toBeGreaterThan(linkedSection);
    expect(output.slice(linkedSection)).toContain('design.md');
  } finally {
    await session.close();
  }
});
