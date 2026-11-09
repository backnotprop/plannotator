/**
 * Images in a message (#1813), proved in a real browser against the
 * compiled binary. Nothing is mocked: `plannotator inbox --background` runs
 * under a temp PLANNOTATOR_DATA_DIR and HOME, an agent writes through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts), and Chromium opens the
 * thread. The rules (owner ruling 2026-10-16):
 *  - an agent's message shows images relative to its project, hidden folders
 *    inside the project included, AND images outside the project, a hidden
 *    folder beside it included (`../.ops/`), as attachments from there show;
 *  - the person's own reply shows images from the project only;
 *  - the home folder's own hidden folders never show, even to a project
 *    that IS the home folder;
 *  - send_message says which images will not show (`images_not_shown`).
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type Locator } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

/** A 1 x 1 PNG that decodes. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** The image loaded and decoded. */
async function expectLoaded(img: Locator): Promise<void> {
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1);
}

/** The image was asked for and refused: no broken image is left, its alt text shows in a quiet chip instead. */
async function expectRefused(scope: Locator, alt: string): Promise<void> {
  await expect(scope.locator('[data-image-unavailable]', { hasText: alt })).toBeVisible();
  await expect(scope.locator(`img[alt="${alt}"]`)).toHaveCount(0);
}

test('an agent message shows images from its project and from outside it; the person reply only from the project; home hides its hidden folders', async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const scratch = inboxScratch('plannotator-inbox-images-e2e-');
  const root = realpathSync(scratch);
  const dataDir = join(root, 'data');
  // `root` is the scratch HOME the Inbox runs under, never the real one.
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  // A project under the home folder: its hidden folders are its own.
  const project = scratchProject(join(root, 'src'), 'shop');
  mkdirSync(join(project, '.walkthrough', 'shots'), { recursive: true });
  writeFileSync(join(project, '.walkthrough', 'shots', 'after.png'), PNG);
  // Outside the project, as a screenshot tool would leave it.
  writeFileSync(join(root, 'src', 'outside.png'), PNG);
  // A hidden folder beside the project (not the home folder's own): shows, as an attachment from it would.
  mkdirSync(join(root, 'src', '.ops'), { recursive: true });
  writeFileSync(join(root, 'src', '.ops', 'explainer.png'), PNG);
  // A hidden folder of the home folder itself.
  mkdirSync(join(root, '.cache'), { recursive: true });
  writeFileSync(join(root, '.cache', 'thumb.png'), PNG);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
  const context = await browser.newContext();
  try {
    const sent = await agent.send({
      project_path: project,
      subject: 'The checkout page after the fix',
      body: [
        'Here is the page after the fix:',
        '',
        '![after the fix](.walkthrough/shots/after.png)',
        '',
        '<p><img src=".walkthrough/shots/after.png" alt="html image"></p>',
        '',
        '![outside](../outside.png)',
        '',
        '![beside](../.ops/explainer.png)',
        '',
        '![later](.walkthrough/shots/not-yet.png)',
      ].join('\n'),
    });
    const id = sent.message_id as string;
    // Every image shows but the one not written yet, which the send names apart.
    expect(sent.images_not_shown).toEqual([
      { ref: '.walkthrough/shots/not-yet.png', reason: 'does not exist yet; it will show if it is written there later', not_yet: true },
    ]);

    // An agent working in the home folder itself.
    const atHome = await agent.send({ project_path: root, subject: 'From home', body: '![home hidden](.cache/thumb.png)' });
    expect(atHome.images_not_shown).toEqual([{ ref: '.cache/thumb.png', reason: 'a .env file, or in a hidden folder of the home folder such as ~/.ssh' }]);

    const page = await context.newPage();
    await page.goto(`${url}#thread=${sent.thread_id}`);
    const body = page.locator(`[data-message-id="${id}"]`);
    const route = `/api/inbox/messages/${id}/image?path=${encodeURIComponent('.walkthrough/shots/after.png')}`;
    for (const alt of ['after the fix', 'html image']) {
      // A captured image is a button that opens the viewer (approval "inbox-image-viewer"): found by its alt text.
      const img = body.locator(`img[alt="${alt}"]`);
      await expect(img).toHaveAttribute('src', route);
      await expectLoaded(img);
    }
    // The agent's image outside the project loads.
    const outside = body.locator('img[alt="outside"]');
    await expect(outside).toHaveAttribute('src', `/api/inbox/messages/${id}/image?path=${encodeURIComponent('../outside.png')}`);
    await expectLoaded(outside);
    // So does the one in the hidden folder beside the project.
    await expectLoaded(body.locator('img[alt="beside"]'));

    // The person replies naming the same outside file, and one of the project.
    const replied = await fetch(new URL(`/api/inbox/messages/${id}/reply`, url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotency_key: 'e2e-person-image', words: `Compare ![mine outside](${join(root, 'src', 'outside.png')}) with ![mine inside](.walkthrough/shots/after.png)` }),
    });
    expect(replied.status).toBe(200);
    const replyId = ((await replied.json()) as { reply: { id: string } }).reply.id;
    // The reply is now the thread's last message (the agent's folds behind it): read it fresh.
    await page.reload();
    // The person's reply: the project's image loads, the outside one does not.
    const reply = page.locator(`[data-message-id="${replyId}"]`);
    await expectLoaded(reply.locator('img[alt="mine inside"]'));
    await expectRefused(reply, 'mine outside');

    // A project at the home folder: its hidden folder never shows.
    await page.goto(`${url}#thread=${atHome.thread_id}`);
    await expectRefused(page.locator(`[data-message-id="${atHome.message_id as string}"]`), 'home hidden');
  } finally {
    await agent.close().catch(() => {});
    await context.close().catch(() => {});
    // This test's Inbox, then its folder (inbox-scratch.ts).
    await removeInboxScratch(scratch);
  }
});
