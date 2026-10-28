/**
 * A question's choice label is the agent's inline markdown: a link to a file
 * it attached (`- [ ] [15% off](forecast-15.html)`), inline code, bold. The
 * live card draws it as markdown (the link opens the file beside the thread);
 * every line or row that draws a pick as text shows its words ("15% off"),
 * never the markdown: the folded line, the answers a sent reply carried, the
 * open questions list's Draft, the answers that go with the reply. The reply
 * the agent reads keeps each label exactly as written, so the agent matches it
 * to its choice.
 *
 * Proved in a real browser against the compiled binary: Claude Code asks
 * through `plannotator inbox mcp` (scripts/inbox-sim.ts), the person answers
 * through the window's routes. Build the binary first (see inbox.spec.ts),
 * then `bun run test:e2e:inbox`. PNGs light and dark at 1440 by 900, and on a
 * phone, land in .local/proof/choice-labels/ (or
 * PLANNOTATOR_E2E_PROOF_DIR/choice-labels).
 */

import { expect, test, devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'choice-labels');

const LINK = '[15% off](forecast-15.html)';
const ASK = [
  'Two calls on the spring promo before I build the forecast.',
  '',
  ':::question',
  'Which discount should the promo run?',
  '',
  `- [ ] ${LINK}`,
  '- [ ] `FLAT10` code',
  '- [ ] **20%** for members',
  '- [ ] No discount',
  ':::',
  '',
  ':::question-multi',
  'Which channels announce it?',
  '',
  '- [ ] **Email**',
  '- [ ] `push` notification',
  '- [ ] [In-app banner](forecast-15.html)',
  '- [ ] Blog post',
  ':::',
].join('\n');
const PICKS = [[LINK], ['**Email**', '`push` notification', '[In-app banner](forecast-15.html)']];
/** The answers as a line shows them: the labels' words. */
const ANSWERS_LINE = 'Which discount should the promo run → 15% off · Which channels announce it → Email, push notification, In-app banner';

const LATEST = [
  'The forecast is updated for 15% off.',
  '',
  ':::question',
  'Who gets the first send?',
  '',
  '- [ ] [Beta list](forecast-15.html)',
  '- [ ] `everyone`',
  ':::',
].join('\n');

interface World {
  url: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threadId: string;
  ids: string[];
}

let world: World;

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

async function post(path: string, body: unknown): Promise<Record<string, any>> {
  const response = await fetch(`${world.url.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Record<string, any>;
}

type Sent = { message_id: string; thread_id: string; questions: { key: string; prompt: string; kind: string }[] };
const answer = (q: Sent['questions'][number], selected: string[]) => ({ key: q.key, revision: 0, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected } });

const pane = (page: Page = world.page) => page.locator('section.ib-pane');
const article = (id: string, page?: Page) => pane(page).locator(`[data-message-article="${id}"]`);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-choice-labels-e2e-');
  // Nothing here may reach the real tailscale CLI: a trap fails loudly first on PATH.
  const trap = join(root, 'bin');
  mkdirSync(trap);
  writeFileSync(join(trap, 'tailscale'), "#!/bin/sh\necho 'inbox-choice-labels.spec: tailscale must not run' >&2\nexit 97\n");
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = {
    PATH: `${trap}:${process.env.PATH ?? ''}`,
    HOME: root,
    PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const project = scratchProject(join(root, 'src'), 'promo');
  writeFileSync(join(project, 'forecast-15.html'), '<!doctype html><title>Forecast at 15% off</title><h1>Forecast at 15% off</h1><p>Revenue +8%.</p>\n');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  world = { url, claude, context, page, errors, threadId: '', ids: [] };

  // 1. Claude Code asks; 2. the person answers both, no words of their own (the reply's line shows the answers).
  const ask = (await claude.send({ project_path: project, subject: 'Spring promo', body: ASK, attachments: ['forecast-15.html'] })) as Sent;
  world.threadId = ask.thread_id;
  const reply = await post(`/api/inbox/messages/${ask.message_id}/reply`, {
    idempotency_key: 'r1',
    questions: ask.questions.map((q, i) => answer(q, PICKS[i]!)),
  });
  await claude.readThread(ask.thread_id);
  // The person looks; 3. one more message arrives, its question picked and not sent.
  await post(`/api/inbox/threads/${ask.thread_id}/seen`, {});
  const latest = (await claude.send({ project_path: project, body: LATEST, reply_to: ask.message_id, attachments: ['forecast-15.html'] })) as Sent;
  await post(`/api/inbox/messages/${latest.message_id}/picks`, { questions: [answer(latest.questions[0]!, ['[Beta list](forecast-15.html)'])] });
  world.ids = [ask.message_id, reply.reply.id, latest.message_id];
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.claude.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('the folded lines show the picked labels as words, never their markdown', async () => {
  const { page, ids } = world;
  await page.goto(world.url);
  await page.locator(`.ib-lbody [data-thread-id="${world.threadId}"]`).click();
  await expect(article(ids[0]!)).toHaveAttribute('data-folded', '');
  await expect(article(ids[1]!)).toHaveAttribute('data-folded', '');
  await shot(page, '1-folded-lines');
  // The asking message and the reply that answered it: both lines show the answers.
  for (const id of [ids[0]!, ids[1]!]) {
    await expect(article(id).locator('[data-snippet="answers"]')).toHaveText(ANSWERS_LINE);
    // The line's screen-reader label and tooltip read the same words.
    await expect(article(id).locator('[data-fold-head]')).toHaveAttribute('aria-label', /Which discount should the promo run: 15% off; Which channels announce it: Email, push notification, In-app banner$/);
  }
  await article(ids[0]!).locator('[data-snippet="answers"]').hover();
  await expect(page.locator('[data-side].bg-popover')).toHaveText('Which discount should the promo run: 15% off; Which channels announce it: Email, push notification, In-app banner');
  await page.mouse.move(1, 1);
});

test('the answers a sent reply carried show the labels as words', async () => {
  const { page, ids } = world;
  await article(ids[1]!).locator('[data-fold-head]').click();
  await expect(article(ids[1]!)).toHaveAttribute('data-open', '');
  const rows = article(ids[1]!).locator('[data-sent-answer]');
  await expect(rows).toHaveCount(2);
  await rows.first().scrollIntoViewIfNeeded();
  await shot(page, '2-sent-answers');
  await expect(rows).toHaveText([/^Q1\s+Which discount should the promo run\?\s+15% off$/, /^Q2\s+Which channels announce it\?\s+Email, push notification, In-app banner$/]);
});

test('the live card draws the label as markdown: the link opens the attached file', async () => {
  const { ids } = world;
  const card = article(ids[2]!).locator('fieldset[data-question-key]');
  const link = card.locator('[data-question-option]').filter({ hasText: 'Beta list' }).locator('a');
  await expect(link).toHaveText('Beta list');
  await expect(link).toHaveAttribute('data-local-link', 'open');
  await expect(card.locator('[data-question-option]').filter({ hasText: 'everyone' }).locator('code')).toHaveText('everyone');
  await link.click();
  // The second message's own copy of the file (the thread holds two).
  await expect(world.page.locator('[data-attachment-pane]')).toHaveAttribute('aria-label', /^forecast-15\.html, file 2 of 2$/);
});

test("the open questions list's Draft and the reply's answers show the pick as words", async () => {
  const { page } = world;
  // The thread alone again, without the file beside it.
  await page.goto(`${world.url}#thread=${world.threadId}`);
  await expect(page.locator('[data-attachment-pane]')).toHaveCount(0);
  const foot = pane().locator('.ib-pfoot');
  await foot.locator('[data-open-questions]').click();
  const list = page.locator('[data-open-questions-list]');
  await expect(list).toBeVisible();
  await shot(page, '3-open-questions');
  await expect(list.locator('.ib-oq-row').first()).toContainText('Draft · Beta list');
  await expect(list.locator('.ib-oq-row').first()).not.toContainText('](');
  await page.keyboard.press('Escape');
  await foot.getByRole('button', { name: /^(Edit draft|Edit the reply|Reply)$/ }).first().click();
  const answers = pane().locator('[data-reply-answers]');
  await expect(answers).toBeVisible();
  await answers.scrollIntoViewIfNeeded();
  await shot(page, '4-reply-answers');
  await expect(answers.locator('[data-reply-answer]')).toHaveText([/^Q1\s+Who gets the first send\?\s+Beta list$/]);
});

test('the reply the agent reads keeps each label exactly as written', async () => {
  const response = await fetch(`${world.url.replace(/\/$/, '')}/api/inbox/threads/${world.threadId}`);
  const { thread } = (await response.json()) as { thread: { messages: { id: string; body: string }[] } };
  const body = thread.messages.find((m) => m.id === world.ids[1])!.body;
  expect(body).toContain(`Answer: ${LINK}`);
  expect(body).toContain('- **Email**\n- `push` notification\n- [In-app banner](forecast-15.html)');
  const read = JSON.stringify(await world.claude.readThread(world.threadId));
  expect(read).toContain(JSON.stringify(LINK).slice(1, -1));
  expect(world.errors).toEqual([]);
});

test('phone: the folded line shows the words', async ({ browser }: { browser: Browser }) => {
  const { defaultBrowserType: _browser, ...phone } = devices['iPhone 15'];
  const context = await browser.newContext({ ...phone, colorScheme: 'light' });
  try {
    const page = await context.newPage();
    await page.goto(`${world.url}#thread=${world.threadId}`);
    const line = article(world.ids[0]!, page).locator('[data-snippet="answers"]');
    await expect(line).toBeVisible();
    await shot(page, '5-phone-folded');
    await expect(line).toHaveText(ANSWERS_LINE);
    await article(world.ids[1]!, page).locator('[data-fold-head]').click();
    const rows = article(world.ids[1]!, page).locator('[data-sent-answer]');
    await expect(rows).toHaveCount(2);
    await rows.first().scrollIntoViewIfNeeded();
    await shot(page, '6-phone-sent-answers');
    await expect(rows.first()).toContainText('15% off');
    await expect(rows.first()).not.toContainText('](');
  } finally {
    await context.close();
  }
});
