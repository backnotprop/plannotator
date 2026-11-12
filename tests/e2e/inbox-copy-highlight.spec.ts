/**
 * Ctrl+C / Cmd+C on words highlighted in an agent's message, proved in a real
 * browser against the compiled binary, with an agent writing through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts).
 *
 * web-highlighter clears the browser's selection on mouseup, and the
 * composer's textarea takes the focus once Comment is pressed; the page puts
 * the words on the clipboard itself (utils/highlightCopy). Failures to catch:
 * the toolbar or composer stage leaving the clipboard as it was (a sentinel
 * written first tells "nothing" from "empty"), and words the person typed and
 * selected in the composer losing to the highlight.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const BODY = [
  'I moved the retry loop into the API client, so every call gets it.',
  '',
  'After the third failure the job goes to the dead-letter queue, where it waits a day.',
].join('\n');

const SENTINEL = 'clipboard before the copy';

/** Seeds the clipboard, presses Ctrl+C (Cmd+C on a Mac) and reads it back. */
async function copied(page: Page): Promise<string> {
  await page.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL);
  await page.keyboard.press('ControlOrMeta+c');
  await page.waitForTimeout(200);
  return page.evaluate(() => navigator.clipboard.readText());
}

/** Drag across `phrase` in the message the way a person does, from its first letter to its last. */
async function dragSelect(page: Page, messageId: string, phrase: string): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  const points = await page.evaluate(({ id, words }) => {
    const root = document.querySelector(`[data-message-id="${id}"]`);
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n as Text;
      const start = text.data.indexOf(words);
      if (start < 0) continue;
      const rectOf = (offset: number) => {
        const range = document.createRange();
        range.setStart(text, offset);
        range.setEnd(text, offset + 1);
        return range.getBoundingClientRect();
      };
      const first = rectOf(start);
      const last = rectOf(start + words.length - 1);
      return { x1: first.left + 1, y1: first.top + first.height / 2, x2: last.right - 1, y2: last.top + last.height / 2 };
    }
    return null;
  }, { id: messageId, words: phrase });
  expect(points, `"${phrase}" in ${messageId}`).not.toBeNull();
  await page.mouse.move(points!.x1, points!.y1);
  await page.mouse.down();
  await page.mouse.move(points!.x2, points!.y2, { steps: 8 });
  await page.mouse.up();
}

test('Inbox thread message: Ctrl+C copies the highlighted words with the toolbar up and with the composer open', async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-copy-highlight-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  let claude: SimAgent | null = null;
  try {
    const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(started.status, started.stderr).toBe(0);
    const url = started.stdout.trim();
    claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
    const sent = await claude.send({ project_path: scratchProject(join(root, 'src'), 'billing'), subject: 'Retry loop moved into the client', thread: 'retries', body: BODY });
    const id = sent.message_id as string;

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
    const page = await context.newPage();
    await page.goto(`${url}#thread=${sent.thread_id}`);
    await expect(page.locator(`[data-message-id="${id}"]`)).toContainText('dead-letter queue');

    await dragSelect(page, id, 'dead-letter queue');
    const toolbar = page.locator('.annotation-toolbar');
    await expect(toolbar).toBeVisible();
    expect(await copied(page), 'toolbar up').toBe('dead-letter queue');

    await toolbar.getByRole('button', { name: 'Comment' }).click();
    const composer = page.locator('[data-comment-popover] textarea');
    await expect(composer).toBeFocused();
    expect(await copied(page), 'composer open, empty textarea').toBe('dead-letter queue');

    // A caret after typed words still copies the highlight; typed words selected copy natively.
    await composer.fill('How long does a job stay there?');
    expect(await copied(page), 'caret after typed words').toBe('dead-letter queue');
    await composer.evaluate((t: HTMLTextAreaElement) => t.setSelectionRange(0, 8));
    expect(await copied(page), 'typed words selected').toBe('How long');
    await context.close();
  } finally {
    await claude?.close().catch(() => {});
    await removeInboxScratch();
  }
});
