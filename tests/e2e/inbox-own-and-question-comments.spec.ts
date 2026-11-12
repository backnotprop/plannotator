/**
 * Comments on the person's own messages and on questions (approval "inbox-annotate-own-and-questions"), in a real
 * Chromium against the compiled binary, with an agent writing through `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 *  - words selected in the person's own earlier reply open the same toolbar (no Delete) and composer, and the
 *    comment is listed as "Your message, <time>";
 *  - words in a question's prompt and in a choice's label take comments; a drag across a choice's words never picks
 *    it, a plain click on a choice picks it at once;
 *  - Send: the agent reads the own-message notes under "# Feedback on my messages", and each question comment with
 *    its "In question 1…" line; the question is still open (a comment never answers it).
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const QUESTION = [
  'The machines page is drafted. One call before I move it:',
  '',
  ':::question',
  'Should the machines page sit under Accounts, or get its own entry in the sidebar?',
  '',
  '- [ ] Under Accounts',
  '- [ ] Its own top-level entry',
  ':::',
].join('\n');

/** Drag across `phrase` inside `scope` the way a person does, from its first letter to its last. */
async function dragAcross(page: Page, scope: string, phrase: string): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  const points = await page.evaluate(
    ({ scope, words }) => {
      const root = document.querySelector(scope);
      if (!root) return null;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        const at = n.data.indexOf(words);
        if (at < 0) continue;
        const rect = (offset: number) => {
          const range = document.createRange();
          range.setStart(n!, offset);
          range.setEnd(n!, offset + 1);
          return range.getBoundingClientRect();
        };
        const first = rect(at);
        const last = rect(at + words.length - 1);
        return { x1: first.left + 1, y1: first.top + first.height / 2, x2: last.right - 1, y2: last.top + last.height / 2 };
      }
      return null;
    },
    { scope, words: phrase },
  );
  expect(points, `"${phrase}" in ${scope}`).not.toBeNull();
  await page.mouse.move(points!.x1, points!.y1);
  await page.mouse.down();
  await page.mouse.move(points!.x2, points!.y2, { steps: 8 });
  await page.mouse.up();
}

const toolbar = (page: Page) => page.locator('.annotation-toolbar');

/**
 * Opens a message the thread drew folded (an older one lands as a one-line fold) until its body shows. Only a folded
 * article's head is pressed: an open message's head folds it again.
 */
async function openMessage(page: Page, id: string) {
  await expect(async () => {
    const folded = page.locator(`[data-message-article="${id}"][data-folded] [data-fold-head]`);
    if ((await folded.count()) > 0) await folded.first().click();
    await expect(page.locator(`[data-message-id="${id}"]`)).toBeVisible({ timeout: 1000 });
  }).toPass();
}

async function comment(page: Page, scope: string, phrase: string, words: string) {
  await dragAcross(page, scope, phrase);
  await expect(toolbar(page)).toBeVisible();
  await toolbar(page).getByRole('button', { name: 'Comment' }).click();
  const box = page.locator('[data-comment-popover] textarea');
  await expect(box).toBeVisible();
  await box.fill(words);
  await box.press('ControlOrMeta+Enter');
  await expect(page.locator('[data-comment-popover]')).toHaveCount(0);
  await page.mouse.click(5, 5);
}

test('comments on my own message and on a question: the toolbar, the list, what the agent reads; a click still picks', async ({ browser }) => {
  test.setTimeout(180_000);
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-own-question-comments-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim().replace(/\/$/, '');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  try {
    const health = (await (await fetch(`${url}/api/inbox/health`)).json()) as { serverSession: string };
    const project = scratchProject(join(root, 'src'), 'docs');
    const first = (await claude.send({ project_path: project, subject: 'How the parts fit', body: 'Here is the plan for the docs pages.' })) as { message_id: string; thread_id: string };
    const mine = (await (
      await fetch(`${url}/api/inbox/messages/${first.message_id}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: health.serverSession, idempotency_key: 'r1', words: 'Keep the old URL for the projects page.' }) })
    ).json()) as { reply: { id: string } };
    const asked = (await claude.send({ project_path: project, reply_to: mine.reply.id, body: QUESTION })) as { message_id: string };

    const page = await context.newPage();
    await page.goto(`${url}/#thread=${first.thread_id}`);
    await openMessage(page, mine.reply.id);
    await openMessage(page, asked.message_id);
    await expect(page.locator(`[data-message-id="${mine.reply.id}"]`)).toContainText('Keep the old URL');

    // My own message: the toolbar (no Delete), the composer, the highlight.
    await dragAcross(page, `[data-message-id="${mine.reply.id}"]`, 'Keep the old URL');
    await expect(toolbar(page).getByRole('button', { name: 'Comment' })).toBeVisible();
    await expect(toolbar(page).getByRole('button', { name: 'Delete' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await comment(page, `[data-message-id="${mine.reply.id}"]`, 'Keep the old URL', 'I meant the machines page too.');
    await expect(page.locator(`[data-message-id="${mine.reply.id}"] mark.annotation-highlight`)).toHaveText('Keep the old URL');

    // The question: its prompt, then a choice's label; the drag never picks the choice.
    const card = `[data-message-id="${asked.message_id}"] [data-question-key]`;
    await comment(page, card, 'own entry in the sidebar', 'Top-level, but below Projects.');
    await comment(page, card, 'Its own top-level entry', 'Call it Machines.');
    const radio = (label: string) => page.locator(`${card} [data-question-option]`).filter({ hasText: label }).locator('input');
    await expect(radio('Its own top-level entry')).not.toBeChecked();
    await expect(radio('Under Accounts')).not.toBeChecked();

    // The list names my own message as mine.
    await page.locator('section.ib-pane .ib-pfoot').getByRole('button', { name: /^Reply$|Edit draft$/ }).first().click();
    const chip = page.locator('[data-annotations-chip]');
    await expect(chip).toHaveText('3 comments');
    await chip.click();
    await expect(page.locator('.ib-annpop [data-annotation-row]').filter({ hasText: 'Keep the old URL' })).toContainText('Your message, ');
    await page.locator('.ib-annpop').getByRole('button', { name: 'Close the list' }).click();

    // Send: what the agent reads.
    await page.locator('.ib-rbox textarea').fill('Notes below.');
    await page.locator('section.ib-pane').getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.ib-rbox')).toHaveCount(0);
    const answer = await claude.nextReply(first.thread_id, 15);
    const body = answer.body as string;
    expect(body).toContain('# Feedback on your messages');
    expect(body).toContain('In question 1: "Should the machines page sit under Accounts, or get its own entry in the sidebar?"\n> Top-level, but below Projects.');
    expect(body).toContain('In question 1, choice "Its own top-level entry":\n> Call it Machines.');
    expect(body).toContain('# Feedback on my messages');
    expect(body).toContain('The following are notes on what I wrote earlier in this thread, one section per message. Each quote is the words I selected in my own message.');
    expect(body).toMatch(new RegExp(`## Feedback on my message from \\d{1,2}:\\d{2} [AP]M \\(${mine.reply.id}\\)`));
    expect(body).toContain('### 1. Note on: "Keep the old URL"\n> I meant the machines page too.');
    expect(body.indexOf('# Feedback on my messages')).toBeGreaterThan(body.indexOf('# Feedback on your messages'));

    // The comment answered nothing: the question is still open.
    const thread = (await (await fetch(`${url}/api/inbox/threads/${first.thread_id}`)).json()) as { thread: { messages: { id: string; questions?: { state: string }[] }[] } };
    expect(thread.thread.messages.find((m) => m.id === asked.message_id)!.questions!.map((q) => q.state)).toEqual(['open']);

    // A plain click on a choice picks it, in one press.
    await openMessage(page, asked.message_id);
    await page.locator(`${card} [data-question-option]`).filter({ hasText: 'Under Accounts' }).locator('[data-question-part="choice"]').click();
    await expect(radio('Under Accounts')).toBeChecked();
  } finally {
    await claude.close().catch(() => {});
    await context.close().catch(() => {});
    await removeInboxScratch(root);
  }
});
