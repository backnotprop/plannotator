import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const ASK = [
  'Two choices about the layout.',
  '',
  ':::question',
  'Which layout for the report?',
  '',
  '- [ ] Cards',
  '- [ ] A dense table',
  'Recommended: Cards',
  ':::',
  '',
  ':::question',
  'Ship it behind a flag?',
  '',
  '- [ ] Yes',
  '- [ ] No',
  ':::',
].join('\n');

const AGAIN = ['Never mind the layout, I will ask again.', '', ':::question', 'Cards or table, now with numbers?', '', '- [ ] Cards', '- [ ] Table', ':::'].join('\n');

const BOTH = ['Two things for you.', '', ':::action', 'Sign in to npm', 'The token expired.', '', 'Run: `npm login`', 'Holds up: the publish', ':::', '', ':::question', 'Publish as latest?', '', '- [ ] latest', '- [ ] next', ':::'].join('\n');

let world: { context: BrowserContext; page: Page; claude: SimAgent; project: string; threadId: string; messageId: string };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-supersede-read-');
  const trap = join(root, 'bin');
  mkdirSync(trap);
  writeFileSync(join(trap, 'tailscale'), "#!/bin/sh\necho 'inbox-supersede-read-webkit.spec: tailscale must not run' >&2\nexit 97\n");
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = { PATH: `${trap}:${process.env.PATH ?? ''}`, HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const project = scratchProject(join(root, 'src'), 'report-svc');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  for (let i = 0; i < 6; i++) await claude.send({ project_path: project, subject: `Other ${i}`, body: `Another thread ${i}.` });
  const first = (await claude.send({ project_path: project, subject: 'Superseded soon', thread: 'super', body: ASK }, { wakes: true })) as { thread_id: string; message_id: string };
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  const page = await context.newPage();
  await page.goto(started.stdout.trim());
  world = { context, page, claude, project, threadId: first.thread_id, messageId: first.message_id };
});

test.afterAll(async () => {
  try {
    await world?.claude.close().catch(() => {});
    await world?.context.close();
  } finally {
    await removeInboxScratch();
  }
});

interface Watch {
  split: number;
  before: number;
  least: number;
}

async function watchArrivals(page: Page, needs: string[]): Promise<() => Promise<Watch>> {
  await page.evaluate((needs) => {
    const known = new Set([...document.querySelectorAll('article.ib-message')].map((el) => el.getAttribute('data-message-article')));
    const body = document.querySelector<HTMLElement>('section.ib-pane .ib-pbody')!;
    const watch = { split: 0, before: body.scrollTop, least: body.scrollTop };
    (window as unknown as { __watch: typeof watch }).__watch = watch;
    const look = () => {
      watch.least = Math.min(watch.least, body.scrollTop);
      for (const article of document.querySelectorAll('article.ib-message')) {
        if (!known.has(article.getAttribute('data-message-article')) && needs.some((need) => !article.querySelector(need))) watch.split += 1;
      }
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true });
    body.addEventListener('scroll', look);
  }, needs);
  return () => page.evaluate(() => (window as unknown as { __watch: Watch }).__watch);
}

test('the agent replaces the questions of the thread being read: one draw, the view kept, seen, not bold', async () => {
  const { page, threadId, messageId } = world;
  const row = page.locator(`.ib-lbody [data-thread-id="${threadId}"]`).first();
  await row.click();
  const pane = page.locator(`section.ib-pane[data-thread-id="${threadId}"]`);
  await pane.locator('fieldset[data-question-key]').first().locator('[data-question-option]').first().click();
  await expect(row).not.toHaveClass(/\bib-u\b/);
  await page.waitForTimeout(1500);
  const seen: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith(`/threads/${threadId}/seen`)) seen.push(request.url());
  });
  const watched = await watchArrivals(page, ['fieldset[data-question-key]']);

  await world.claude.send({ project_path: world.project, thread: 'super', body: AGAIN, supersedes: [messageId] }, { wakes: true });

  await expect(pane.getByRole('group', { name: 'Cards or table, now with numbers?' })).toBeVisible();
  await expect(pane.locator(`[data-message-id="${messageId}"] [data-question-state="superseded"]`).first()).toBeVisible();
  await page.waitForTimeout(2500);
  const watch = await watched();
  expect(watch.split, 'the new message drew without its question card first').toBe(0);
  expect(watch.least, 'the view jumped up while the old cards closed').toBeGreaterThanOrEqual(watch.before - 2);
  expect(seen.length, 'the new message was never counted as seen').toBeGreaterThan(0);
  await expect(row).not.toHaveClass(/\bib-u\b/);
});

test('a message with an action item and a question arrives in the open thread whole: never a raw block before its checklist and card', async () => {
  const { page, threadId } = world;
  const pane = page.locator(`section.ib-pane[data-thread-id="${threadId}"]`);
  if ((await pane.count()) === 0) await page.locator(`.ib-lbody [data-thread-id="${threadId}"]`).first().click();
  await pane.waitFor();
  await page.waitForTimeout(1500);
  const watched = await watchArrivals(page, ['fieldset[data-question-key]', '[data-action-tick]']);

  await world.claude.send({ project_path: world.project, thread: 'super', body: BOTH }, { wakes: true });

  await expect(pane.getByRole('group', { name: 'Publish as latest?' })).toBeVisible();
  await page.waitForTimeout(1500);
  expect((await watched()).split, 'the message drew before its action checklist and question card').toBe(0);
});
