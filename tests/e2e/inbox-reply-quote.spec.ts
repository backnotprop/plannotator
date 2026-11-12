/**
 * Reply with a quote (approval "inbox-reply-quote", issue #3109), against the compiled binary with Claude Code
 * writing through `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 *  - ↩ on an older message puts one line in the reply box naming it; Send stores the reply with `quote` and its
 *    words open with the lead the agent reads; the sent reply shows the line, not the lead, and a press on it goes
 *    back to the original;
 *  - words selected in the newest message, then its ↩: the line quotes those words, and the reply carries them;
 *  - × takes the line away: that reply is exactly the words typed;
 *  - a plain Reply has no line.
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

const FIRST = 'Here is how the three fit together. Accounts hold your sign-in. Machines run your agents. Projects are folders on a machine.';
const SECOND = 'I also linked the terms page from the footer. Want a PR?';

type Sent = { message_id: string; thread_id: string };
type Wire = { id: string; body: string; author: { kind: string }; quote?: { of: string; words?: string } };

const pane = (page: Page) => page.locator('section.ib-pane');
const box = (page: Page) => pane(page).locator('textarea:not([data-question-other])');

/**
 * Opens a message the thread drew folded (an older one lands as a one-line fold) until its ↩ shows. Only a folded
 * article's head is pressed: an open message's head folds it again.
 */
async function openMessage(page: Page, id: string) {
  await expect(async () => {
    const folded = page.locator(`[data-message-article="${id}"][data-folded] [data-fold-head]`);
    if ((await folded.count()) > 0) await folded.first().click();
    await expect(page.locator(`[data-message-reply="${id}"]`)).toBeVisible({ timeout: 1000 });
  }).toPass();
}

test('reply with a quote: the line in the box, the lead the agent reads, the sent line that goes back', async ({ browser }) => {
  test.setTimeout(120_000);
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-reply-quote-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim().replace(/\/$/, '');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  try {
    await fetch(`${url}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });
    const project = scratchProject(join(root, 'src'), 'docs');
    const first = (await agent.send({ project_path: project, subject: 'How the parts fit', body: FIRST })) as Sent;
    const second = (await agent.send({ project_path: project, reply_to: first.message_id, body: SECOND })) as Sent;
    const messages = async () => ((await (await fetch(`${url}/api/inbox/threads/${first.thread_id}`)).json()) as { thread: { messages: Wire[] } }).thread.messages;
    const replies = async () => (await messages()).filter((m) => m.author.kind === 'person');

    const page = await context.newPage();
    await page.goto(`${url}/#thread=${first.thread_id}`);
    await expect(page.locator(`[data-message-article="${second.message_id}"]`)).toBeVisible();
    await openMessage(page, first.message_id);

    // A plain Reply: no line.
    await pane(page).locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
    await expect(box(page)).toBeVisible();
    await expect(pane(page).locator('[data-reply-quote]')).toHaveCount(0);

    // ↩ on the older message: the line, in the box, naming it.
    await openMessage(page, first.message_id);
    await page.locator(`[data-message-reply="${first.message_id}"]`).click();
    const line = pane(page).locator(`.ib-rbox [data-reply-quote="${first.message_id}"]`);
    await expect(line).toBeVisible();
    await expect(line).toContainText('Here is how the three fit together.');
    await box(page).fill('Say the machines part again.');
    await pane(page).getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => (await replies()).length).toBe(1);
    const [quoted] = await replies();
    expect(quoted!.quote).toEqual({ of: first.message_id });
    expect(quoted!.body).toMatch(new RegExp(`^Replying to your message from [^\\n]+ \\(${first.message_id}\\):\\n> Here is how the three fit together\\.`));
    expect(quoted!.body.endsWith('Say the machines part again.')).toBe(true);

    // The sent reply shows the line, not the lead; a press on it goes to the original.
    const sentArticle = page.locator(`[data-message-article="${quoted!.id}"]`);
    await expect(sentArticle.locator(`[data-sent-quote="${first.message_id}"]`)).toBeVisible();
    await expect(sentArticle).toContainText('Say the machines part again.');
    await expect(sentArticle.locator('.ib-body')).not.toContainText(`(${first.message_id})`);
    await sentArticle.locator('[data-sent-quote]').click();
    await expect(page.locator(`[data-message-article="${first.message_id}"]`)).toBeInViewport();

    // Words selected in the newest message, then its ↩: the line quotes those words.
    const article = page.locator(`[data-message-article="${second.message_id}"] .ib-msg`);
    await article.evaluate((el, words) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        const at = node.data.indexOf(words);
        if (at < 0) continue;
        document.getSelection()!.setBaseAndExtent(node, at, node, at + words.length);
        return;
      }
      throw new Error('words not found');
    }, 'linked the terms page');
    await page.locator(`[data-message-reply="${second.message_id}"]`).click();
    const words = pane(page).locator(`.ib-rbox [data-reply-quote="${second.message_id}"][data-quote-words]`);
    await expect(words).toContainText('“linked the terms page”');
    await box(page).fill('Which terms?');
    await pane(page).getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => (await replies()).length).toBe(2);
    const selected = (await replies())[1]!;
    expect(selected.quote).toEqual({ of: second.message_id, words: 'linked the terms page' });
    expect(selected.body).toContain(`Replying to these words in your message from `);
    expect(selected.body).toContain('\n> linked the terms page\n\nWhich terms?');

    // × takes it away: the reply is the words typed, nothing more.
    await openMessage(page, first.message_id);
    await page.locator(`[data-message-reply="${first.message_id}"]`).click();
    await expect(pane(page).locator('.ib-rbox [data-reply-quote]')).toBeVisible();
    await pane(page).getByRole('button', { name: 'Remove quote' }).click();
    await expect(pane(page).locator('[data-reply-quote]')).toHaveCount(0);
    await expect(box(page)).toBeFocused();
    await box(page).fill('Never mind.');
    await pane(page).getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => (await replies()).length).toBe(3);
    const plain = (await replies())[2]!;
    expect(plain.quote).toBeUndefined();
    expect(plain.body).toBe('Never mind.');
  } finally {
    await agent.close().catch(() => {});
    await context.close().catch(() => {});
    await removeInboxScratch(root);
  }
});
