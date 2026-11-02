/**
 * Comments on the text of an agent's message (approval
 * "inbox-message-comments", 2026-10-19), proved in a real browser against the
 * compiled binary, with an agent writing through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts):
 *
 *  - words dragged across in an agent's message open the comment-only
 *    toolbar (Comment and 👍, no Delete); Escape closes it, not the thread;
 *  - Comment opens the composer; ⌘↵ saves; the passage keeps a light
 *    highlight; the reply box's chip counts it and lists it under the message;
 *  - Send carries it, and the agent's read_thread returns the quote and the
 *    comment under "Feedback on your message from <time> (<message id>)";
 *  - the person's own message and a question card's words open no toolbar;
 *  - on a phone-wide window (390 px) the same, and the toolbar stays in the window.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs land in <PLANNOTATOR_E2E_PROOF_DIR or .local/proof>/message-comments/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'message-comments');

const BODY = [
  'I moved the retry loop into the API client, so every call gets it.',
  '',
  'The backoff is now **two, four and eight seconds**, and a 429 waits for its `Retry-After` header before it tries again. After the third failure the job goes to the dead-letter queue.',
  '',
  'Run this once after you pull:',
  '',
  '```bash',
  '# Feedback on the attached files',
  'echo ```hi',
  '```',
  '',
  'Nothing needs you yet. I will wire the admin retry view next.',
].join('\n');

const QUESTION = ['One thing before I merge:', '', ':::question', 'Which currency rounding rule wins?', '', '- [ ] Banker\'s rounding', '- [ ] Half up', ':::'].join('\n');

interface World {
  root: string;
  url: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  project: string;
}

let world: World;

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** Drag across `phrase` in the message the way a person does, from its first letter to its last. */
async function dragSelect(page: Page, messageId: string, phrase: string, to?: string): Promise<void> {
  // A pane may still be sliding in: measure once nothing moves.
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  const points = await page.evaluate(
    ({ id, words, until }) => {
      const root = document.querySelector(`[data-message-id="${id}"]`);
      if (!root) return null;
      // The phrase may span inline elements (bold, code): walk the text and find where it starts and ends.
      const nodes: Text[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
      const whole = nodes.map((n) => n.data).join('');
      const start = whole.indexOf(words);
      if (start < 0) return null;
      const stop = until ? whole.indexOf(until, start) : start;
      if (stop < 0) return null;
      const lastIndex = until ? stop + until.length - 1 : start + words.length - 1;
      const at = (offset: number): [Text, number] => {
        let left = offset;
        for (const node of nodes) {
          if (left < node.data.length) return [node, left];
          left -= node.data.length;
        }
        return [nodes.at(-1)!, nodes.at(-1)!.data.length];
      };
      const rectOf = (offset: number) => {
        const [node, index] = at(offset);
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        return range.getBoundingClientRect();
      };
      const first = rectOf(start);
      const last = rectOf(lastIndex);
      return { x1: first.left + 1, y1: first.top + first.height / 2, x2: last.right - 1, y2: last.top + last.height / 2 };
    },
    { id: messageId, words: phrase, until: to ?? null },
  );
  expect(points, `"${phrase}" in ${messageId}`).not.toBeNull();
  await page.mouse.move(points!.x1, points!.y1);
  await page.mouse.down();
  await page.mouse.move(points!.x2, points!.y2, { steps: 8 });
  await page.mouse.up();
}

const toolbar = (page: Page) => page.locator('.annotation-toolbar');

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-message-comments-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
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
  const project = scratchProject(join(root, 'src'), 'billing');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  world = { root, url, claude, context, page, errors, project };
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

test("a comment on words in an agent's message: toolbar, composer, highlight, chip, Send; the agent reads the quote", async () => {
  const { page, claude, project } = world;
  const sent = await claude.send({ project_path: project, subject: 'Retry loop moved into the client', thread: 'retries', body: BODY });
  const id = sent.message_id as string;
  await page.goto(`${world.url}#thread=${sent.thread_id}`);
  await expect(page.locator(`[data-message-id="${id}"]`)).toContainText('dead-letter queue');

  // The comment-only toolbar: Comment and 👍, no Delete.
  await dragSelect(page, id, 'two, four and eight seconds');
  await expect(toolbar(page)).toBeVisible();
  await expect(toolbar(page).getByRole('button', { name: 'Comment' })).toBeVisible();
  await expect(toolbar(page).getByRole('button', { name: 'Looks good' })).toBeVisible();
  await expect(toolbar(page).getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await shot(page, '01-desktop-selected');
  // Escape closes the toolbar, never the thread.
  await page.keyboard.press('Escape');
  await expect(toolbar(page)).toHaveCount(0);
  await expect(page.locator(`[data-message-id="${id}"]`)).toBeVisible();

  // Comment: the composer, then ⌘↵ saves it.
  await dragSelect(page, id, 'two, four and eight seconds');
  await toolbar(page).getByRole('button', { name: 'Comment' }).click();
  const composer = page.locator('[data-comment-popover] textarea');
  await expect(composer).toBeVisible();
  await composer.fill('Cap the total wait too, say 30 seconds.');
  await shot(page, '02-desktop-composer');
  await composer.press('ControlOrMeta+Enter');
  await expect(page.locator('[data-comment-popover]')).toHaveCount(0);
  const mark = page.locator(`[data-message-id="${id}"] mark.annotation-highlight`);
  await expect(mark).toHaveText('two, four and eight seconds');
  await page.mouse.click(5, 5);
  await shot(page, '03-desktop-highlighted');

  // Words across three blocks (a paragraph, a code block holding "# Feedback on the attached files" and
  // "echo ```hi", another paragraph): the agent gets them fenced, nothing in them read as markdown.
  await dragSelect(page, id, 'Run this once', 'Nothing needs you');
  await toolbar(page).getByRole('button', { name: 'Comment' }).click();
  await page.locator('[data-comment-popover] textarea').fill('Why a manual step? Put it in the setup script.');
  await page.locator('[data-comment-popover] textarea').press('ControlOrMeta+Enter');
  await expect(page.locator('[data-comment-popover]')).toHaveCount(0);
  await page.mouse.click(5, 5);

  // The reply box's chip lists them under the message.
  await page.locator('section.ib-pane .ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)$/ }).first().click();
  const chip = page.locator('[data-annotations-chip]');
  await expect(chip).toHaveText('2 comments');
  await chip.click();
  const row = page.locator('.ib-annpop [data-annotation-row]').filter({ hasText: 'two, four and eight seconds' });
  await expect(row).toContainText("Claude Code's message, ");
  await expect(row).toContainText('"two, four and eight seconds"');
  await expect(row).toContainText('Cap the total wait too, say 30 seconds.');
  await shot(page, '04-desktop-chip');
  await page.locator('.ib-annpop').getByRole('button', { name: 'Close the list' }).click();

  // Send: the agent reads the quote and the comment.
  await page.locator('.ib-rbox textarea').fill('One note on the backoff.');
  await page.locator('section.ib-pane').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.ib-rbox')).toHaveCount(0);
  const answer = await claude.nextReply(sent.thread_id as string, 10);
  const body = answer.body as string;
  expect(body).toContain('One note on the backoff.');
  expect(body).toContain('# Feedback on your messages');
  expect(body).toMatch(new RegExp(`## Feedback on your message from \\d{1,2}:\\d{2} [AP]M \\(${id}\\)`));
  expect(body).toContain('Feedback on: "two, four and eight seconds"');
  expect(body).toContain('> Cap the total wait too, say 30 seconds.');
  // The words across blocks: under "Feedback on:", in a fence longer than any backtick run in them.
  const across = /### \d\. Feedback on:\n(`{4,})\n([\s\S]*?)\n\1\n> Why a manual step\? Put it in the setup script\./.exec(body);
  expect(across, body).not.toBeNull();
  expect(across![2]).toContain('Run this once after you pull:');
  expect(across![2]).toContain('# Feedback on the attached files');
  expect(across![2]).toContain('echo ```hi');
  expect(across![2]).toContain('Nothing needs you');
  // Outside the fence, the only top-level headings are the export's own.
  const outside = body.replace(across![0], '');
  expect(outside.split('\n').filter((line) => /^# /.test(line))).toEqual(['# Feedback on your messages']);
  await renderReceived(page, body, '05-desktop-agent-received');
  await page.reload();
  // Sent: the comment no longer waits (no chip), and no highlight is drawn any more.
  await expect(page.locator('article[data-author="person"]')).toContainText('One note on the backoff.');
  await page.locator(`[data-message-article="${id}"] [data-fold-head]`).first().click();
  await expect(page.locator(`[data-message-id="${id}"]`)).toContainText('dead-letter queue');
  await expect(page.locator(`[data-message-id="${id}"] mark.annotation-highlight`)).toHaveCount(0);
  await expect(page.locator('[data-annotations-chip]')).toHaveCount(0);
  expect(world.errors).toEqual([]);
});

test("the person's own message and a question card's words open no toolbar", async () => {
  const { page, claude, project } = world;
  const sent = await claude.send({ project_path: project, subject: 'Rounding', thread: 'rounding', body: QUESTION });
  await page.goto(`${world.url}#thread=${sent.thread_id}`);
  const prompt = page.locator('[data-question-part="prompt"]').first();
  await expect(prompt).toBeVisible();
  const box = (await prompt.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect(toolbar(page)).toHaveCount(0);
  // The agent's own words above the card still take a comment.
  await dragSelect(page, sent.message_id as string, 'before I merge');
  await expect(toolbar(page)).toBeVisible();
  await page.keyboard.press('Escape');

  // The person's own reply: no toolbar.
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
  await page.locator('.ib-rbox textarea').fill('Holding this one until Monday.');
  await page.locator('section.ib-pane').getByRole('button', { name: 'Send', exact: true }).click();
  const mine = page.locator('article[data-author="person"] [data-message-id]');
  await expect(mine).toContainText('Holding this one');
  const id = await mine.getAttribute('data-message-id');
  await dragSelect(page, id!, 'Holding this one');
  await page.waitForTimeout(300);
  await expect(toolbar(page)).toHaveCount(0);
});

test('on a phone-wide window: the same toolbar, composer, highlight and chip, inside the window', async ({ browser }) => {
  const { claude, project } = world;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
  const page = await context.newPage();
  try {
    const sent = await claude.send({ project_path: project, subject: 'Retry loop moved into the client', thread: 'retries-phone', body: BODY });
    const id = sent.message_id as string;
    await page.goto(`${world.url}#thread=${sent.thread_id}`);
    await expect(page.locator(`[data-message-id="${id}"]`)).toContainText('dead-letter queue');
    await dragSelect(page, id, 'dead-letter queue');
    await expect(toolbar(page)).toBeVisible();
    const bar = (await toolbar(page).boundingBox())!;
    expect(bar.x).toBeGreaterThanOrEqual(0);
    expect(bar.x + bar.width).toBeLessThanOrEqual(390);
    await shot(page, '06-phone-selected');
    await toolbar(page).getByRole('button', { name: 'Comment' }).click();
    const composer = page.locator('[data-comment-popover] textarea');
    await composer.fill('Say how long a job stays there.');
    await shot(page, '07-phone-composer');
    await composer.press('ControlOrMeta+Enter');
    await expect(page.locator(`[data-message-id="${id}"] mark.annotation-highlight`)).toHaveText('dead-letter queue');
    await page.locator('.ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)$/ }).first().click();
    await shot(page, '08-phone-highlighted');
    await page.locator('[data-annotations-chip]').click();
    await expect(page.locator('.ib-annpop [data-annotation-row]')).toContainText('"dead-letter queue"');
    await shot(page, '09-phone-chip');
    await page.locator('.ib-annpop').getByRole('button', { name: 'Close the list' }).click();
    await page.locator('section.ib-pane').getByRole('button', { name: 'Send', exact: true }).click();
    const answer = await claude.nextReply(sent.thread_id as string, 10);
    const body = answer.body as string;
    expect(body).toContain('Feedback on: "dead-letter queue"');
    await renderReceived(page, body, '10-phone-agent-received');
  } finally {
    await context.close();
  }
});

/** The reply as the agent receives it (read_thread's body), drawn as plain text for the screenshots. */
async function renderReceived(page: Page, body: string, name: string): Promise<void> {
  const html = (dark: boolean) => `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:24px;font:13px/1.5 ui-monospace,Menlo,monospace;background:${dark ? '#16181d' : '#fafafa'};color:${dark ? '#e6e6e6' : '#1d1d1f'}"><div style="font:600 12px system-ui;opacity:.6;margin-bottom:12px">What Claude Code receives (read_thread)</div><pre style="white-space:pre-wrap;margin:0"></pre></body>`;
  // Its own tab, so the Inbox's tab keeps its page.
  const tab = await page.context().newPage();
  try {
    for (const scheme of ['light', 'dark'] as const) {
      await tab.setContent(html(scheme === 'dark'));
      await tab.locator('pre').evaluate((el, text) => {
        el.textContent = text;
      }, body);
      await tab.screenshot({ path: join(proofDir, `${name}-${scheme}.png`), fullPage: true });
    }
  } finally {
    await tab.close();
  }
}
