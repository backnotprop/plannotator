/**
 * A picture on a comment, against the compiled binary: added in the comment box, it shows there, and Send carries
 * it as an attachment of the reply, named under the comment in what the agent reads.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const BODY = 'The chart is rendered.\n\nThe legend sits at the right edge, and the totals row is bold.';

interface World {
  url: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  project: string;
}

let world: World;

/** Drag across `phrase` in the message the way a person does. */
async function dragSelect(page: Page, messageId: string, phrase: string): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  const points = await page.evaluate(
    ({ id, words }) => {
      const root = document.querySelector(`[data-message-id="${id}"]`);
      if (!root) return null;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n as Text;
        const at = text.data.indexOf(words);
        if (at < 0) continue;
        const rect = (from: number) => {
          const range = document.createRange();
          range.setStart(text, from);
          range.setEnd(text, from + 1);
          return range.getBoundingClientRect();
        };
        const first = rect(at);
        const last = rect(at + words.length - 1);
        return { x1: first.left + 1, y1: first.top + first.height / 2, x2: last.right - 1, y2: last.top + last.height / 2 };
      }
      return null;
    },
    { id: messageId, words: phrase },
  );
  expect(points, `"${phrase}" in ${messageId}`).not.toBeNull();
  await page.mouse.move(points!.x1, points!.y1);
  await page.mouse.down();
  await page.mouse.move(points!.x2, points!.y2, { steps: 8 });
  await page.mouse.up();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-comment-pictures-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const project = scratchProject(join(root, 'src'), 'charts');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  world = { url: started.stdout.trim(), claude, context, page, errors, project };
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

test('a picture added to a comment shows in the comment box, and Send carries it to the agent as an attachment', async () => {
  const { page, claude, project } = world;
  const sent = await claude.send({ project_path: project, subject: 'Chart', thread: 'chart', body: BODY });
  const id = sent.message_id as string;
  await page.goto(`${world.url}#thread=${sent.thread_id}`);
  await expect(page.locator(`[data-message-id="${id}"]`)).toContainText('totals row is bold');

  await dragSelect(page, id, 'legend sits at the right edge');
  await page.locator('.annotation-toolbar').getByRole('button', { name: 'Comment' }).click();
  const composer = page.locator('[data-comment-popover] textarea');
  await expect(composer).toBeVisible();
  await composer.fill('It is cut off on my screen.');

  const pictureButton = page.locator('[data-comment-popover] button[aria-label="Attachments"]');
  await pictureButton.click();
  await expect(page.getByPlaceholder('Paste path or URL...')).toHaveCount(0);
  const png = await page.screenshot({ type: 'png' });
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({ name: 'legend.png', mimeType: 'image/png', buffer: png });
  await page.locator('button[title^="Save"]').click();

  const thumb = pictureButton.locator('img');
  await expect(thumb).toHaveCount(1);
  await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.locator('[data-picture-status]')).toHaveCount(0);
  await composer.press('ControlOrMeta+Enter');
  await expect(page.locator('[data-comment-popover]')).toHaveCount(0);

  await page.locator('section.ib-pane .ib-pfoot').getByRole('button', { name: /^Reply$|Edit draft$/ }).first().click();
  await page.locator('.ib-rbox textarea').fill('See the picture.');
  await page.locator('section.ib-pane').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.ib-rbox')).toHaveCount(0);

  const answer = await claude.nextReply(sent.thread_id as string, 10);
  const body = answer.body as string;
  expect(body).toContain('> It is cut off on my screen.\n**Attached images:**\n- [legend] `legend.png`');
  const attachments = (answer.attachments ?? []) as { name: string; kind: string }[];
  expect(attachments.map((a) => [a.name, a.kind])).toEqual([['legend.png', 'image']]);
  await expect(page.locator('article[data-author="person"]')).toContainText('legend.png');
  expect(world.errors).toEqual([]);
});
