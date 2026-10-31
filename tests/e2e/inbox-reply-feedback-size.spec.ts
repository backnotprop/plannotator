/**
 * The feedback a Send wrote after the person's words reads as part of their
 * reply, not as page headings (replyFeedback.ts; the owner's ask, 2026-10-31:
 * "Is there a reason the inline comments appear like so big? Like a header?
 * … A little smaller would be nice."). Proved against the compiled binary:
 * Claude Code sends a message with its own `#` and `##` headings, a picture
 * and a plan attached, then a question; the person sends two replies, one
 * with comments on the agent's message and on the files, one answering the
 * question with comments on a file (the sent reply drawn as words, answers,
 * then the rest). In both, "Feedback on …", each file's or message's name
 * and each "Feedback on: …" draw no larger than the reply's own text, and
 * the file's name still links to the file; the agent's own headings still
 * draw large, and the text the agent got is unchanged. Desktop and a phone's
 * width, light and dark.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * Full-window PNGs (1440 by 900 at 2x, light and dark, and a 390 px phone)
 * land in .local/proof/reply-feedback-size/ (or PLANNOTATOR_E2E_PROOF_DIR/reply-feedback-size).
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'reply-feedback-size');

const NOTES = [
  '# Checkout redesign',
  '',
  'The new checkout is attached: a screenshot of the page and the rollout plan.',
  '',
  '## What changed',
  '',
  'The retry button moved under the total, and the total is bold.',
].join('\n');

/** The window's export (attachments.ts `attachmentFeedback`), as a Send writes it: comments on a message, then on the files. */
const feedbackFor = (messageId: string) =>
  [
    '# Feedback on your messages',
    '',
    'The following feedback is on the text of your messages in this thread, one section per message. Each quote is the words I selected (as shown on screen) in your message.',
    '',
    `## Feedback on your message from 10:37 AM (${messageId})`,
    '',
    "I've reviewed this message and have 1 piece of feedback:",
    '',
    '### 1. Feedback on: "The retry button moved under the total"',
    '> Say why it moved.',
    '',
    '---',
    '',
    '# Feedback on the attached files',
    '',
    'The following feedback is on the files you attached, one section per file and version.',
    '',
    '## design/checkout.png',
    '',
    "I've reviewed this document and have 1 piece of feedback:",
    '',
    '### 1. Feedback on: "checkout.png"',
    '> The total needs more weight.',
    '',
    '## docs/rollout-plan.md',
    '',
    "I've reviewed this document and have 1 piece of feedback:",
    '',
    '### 1. Feedback on: "Ship to 10% of stores first."',
    '> Which stores?',
    '',
    '---',
  ].join('\n');

const FILE_ONLY = [
  '# Feedback on the attached files',
  '',
  'The following feedback is on the files you attached, one section per file and version.',
  '',
  '## docs/rollout-plan.md',
  '',
  "I've reviewed this document and have 1 piece of feedback:",
  '',
  '### 1. Feedback on: "Roll back by flag."',
  '> Name the flag.',
  '',
  '---',
].join('\n');

const px = (locator: Locator) => locator.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

/** Each heading of the reply's feedback draws no larger than the reply's own text; the file names stay links. */
async function expectTextSized(reply: Locator, label: string) {
  const words = await px(reply.locator('p').first());
  const title = reply.locator('h1', { hasText: label });
  await expect(title).toBeVisible();
  expect(await px(title), `"${label}" draws at most at text size`).toBeLessThanOrEqual(words);
  const names = reply.locator('h2');
  const comments = reply.locator('h3');
  expect(await names.count()).toBeGreaterThan(0);
  expect(await comments.count()).toBeGreaterThan(0);
  for (const heading of [...(await names.all()), ...(await comments.all())]) {
    expect(await px(heading), `"${await heading.textContent()}" draws at most at text size`).toBeLessThanOrEqual(words);
  }
}

async function shoot(page: Page, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

test('the feedback in a sent reply reads at text size; an agent message keeps its headings', async ({ browser }) => {
  test.setTimeout(120_000);
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-feedback-size-e2e-');
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
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status, `POST ${path}: ${await response.clone().text()}`).toBe(200);
    return (await response.json()) as Record<string, any>;
  };
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' });
  try {
    await post('/api/inbox/settings', { notifications: { dismissed: true } });
    const project = scratchProject(join(root, 'src'), 'shop');
    mkdirSync(join(project, 'design'), { recursive: true });
    mkdirSync(join(project, 'docs'), { recursive: true });
    const painter = await desktop.newPage();
    await painter.setViewportSize({ width: 320, height: 200 });
    await painter.setContent('<body style="margin:0;background:#eef2ff;font:600 24px system-ui">Checkout</body>');
    writeFileSync(join(project, 'design', 'checkout.png'), await painter.screenshot());
    await painter.close();
    writeFileSync(join(project, 'docs', 'rollout-plan.md'), '# Rollout plan\n\nShip to 10% of stores first.\n\nRoll back by flag.\n');

    type Sent = { message_id: string; thread_id: string; questions: { key: string; prompt: string; kind: string }[] };
    const notes = (await agent.send({ project_path: project, subject: 'Checkout redesign', body: NOTES, attachments: ['design/checkout.png', 'docs/rollout-plan.md'] })) as Sent;
    const first = await post(`/api/inbox/messages/${notes.message_id}/reply`, {
      idempotency_key: 'r1',
      words: 'Close. Notes on your message and on both files below.',
      feedback: feedbackFor(notes.message_id),
    });
    const ask = (await agent.send({
      project_path: project,
      reply_to: notes.message_id,
      body: 'Moved it. One call before I ship:\n\n:::question\nShip behind a flag?\n\n- [ ] Yes\n- [ ] No\n:::',
    })) as Sent;
    const q = ask.questions[0]!;
    const second = await post(`/api/inbox/messages/${ask.message_id}/reply`, {
      idempotency_key: 'r2',
      words: 'Yes. One more note on the plan.',
      questions: [{ key: q.key, revision: 0, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ['Yes'] } }],
      feedback: FILE_ONLY,
    });
    // What the agent gets is the feedback as written: the window's change is display only.
    const thread = (await (await fetch(`${url}/api/inbox/threads/${notes.thread_id}`)).json()) as { thread: { messages: { id: string; body: string }[] } };
    const bodyOf = (id: string) => thread.thread.messages.find((m) => m.id === id)!.body;
    expect(bodyOf(first.reply.id)).toContain(feedbackFor(notes.message_id));
    expect(bodyOf(second.reply.id)).toContain(FILE_ONLY);

    // Both widths first, their shots taken before any check, so a failing run still leaves its pictures.
    const pages: Page[] = [];
    for (const [context, name] of [[desktop, 'desktop'], [phone, 'phone']] as const) {
      const page = await context.newPage();
      pages.push(page);
      await page.goto(`${url}/#thread=${notes.thread_id}`);
      // Read messages fold to lines: open them all (on a phone the button may sit in a menu, so open each line).
      await expect(page.locator(`[data-message-article="${second.reply.id}"]`)).toBeVisible();
      const expand = page.getByRole('button', { name: 'Expand all messages' });
      if (await expand.isVisible()) await expand.click();
      else {
        for (const id of [notes.message_id, first.reply.id, ask.message_id]) {
          const fold = page.locator(`[data-message-article="${id}"] [data-fold-head]`);
          if (await fold.isVisible()) await fold.click();
        }
      }
      await expect(page.locator(`.ib-body[data-message-id="${first.reply.id}"] h1`, { hasText: 'Feedback on the attached files' })).toBeVisible();
      await page.locator(`[data-message-article="${first.reply.id}"]`).evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await page.mouse.move(0, 0);
      await shoot(page, name);
    }

    for (const page of pages) {
      const message = (id: string) => page.locator(`.ib-body[data-message-id="${id}"]`);
      const reply = message(first.reply.id);
      // Comments on the agent's message, and on the files (a plain reply).
      await expectTextSized(reply, 'Feedback on your messages');
      await expectTextSized(reply, 'Feedback on the attached files');
      await expect(reply.locator('h2', { hasText: 'design/checkout.png' }).getByRole('link')).toBeVisible();
      // A reply that answered a question: words, the answers list, then the feedback.
      await expectTextSized(message(second.reply.id), 'Feedback on the attached files');

      // The agent's own headings still draw as headings.
      const agentBody = message(notes.message_id);
      const agentText = await px(agentBody.locator('p').first());
      expect(await px(agentBody.locator('h1', { hasText: 'Checkout redesign' }))).toBeGreaterThan(agentText * 1.3);
      expect(await px(agentBody.locator('h2', { hasText: 'What changed' }))).toBeGreaterThan(agentText * 1.15);
    }
  } finally {
    await agent.close().catch(() => {});
    await desktop.close().catch(() => {});
    await phone.close().catch(() => {});
    await removeInboxScratch(root);
  }
});
