import { expect, test, type Locator } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function expectLoaded(img: Locator): Promise<void> {
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1);
}

async function expectRefused(scope: Locator, alt: string): Promise<void> {
  await expect(scope.locator('[data-image-unavailable]', { hasText: alt })).toBeVisible();
  await expect(scope.locator(`img[alt="${alt}"]`)).toHaveCount(0);
}

test('an agent message shows images from its project and from outside it; the person reply only from the project; home hides its hidden folders', async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const scratch = inboxScratch('plannotator-inbox-images-e2e-');
  const root = realpathSync(scratch);
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'shop');
  mkdirSync(join(project, '.walkthrough', 'shots'), { recursive: true });
  writeFileSync(join(project, '.walkthrough', 'shots', 'after.png'), PNG);
  writeFileSync(join(root, 'src', 'outside.png'), PNG);
  mkdirSync(join(root, 'src', '.ops'), { recursive: true });
  writeFileSync(join(root, 'src', '.ops', 'explainer.png'), PNG);
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
    expect(sent.images_not_shown).toEqual([
      { ref: '.walkthrough/shots/not-yet.png', reason: 'does not exist yet; it will show if it is written there later', not_yet: true },
    ]);

    const atHome = await agent.send({ project_path: root, subject: 'From home', body: '![home hidden](.cache/thumb.png)' });
    expect(atHome.images_not_shown).toEqual([{ ref: '.cache/thumb.png', reason: 'a .env file, or in a hidden folder of the home folder such as ~/.ssh' }]);

    const page = await context.newPage();
    await page.goto(`${url}#thread=${sent.thread_id}`);
    const body = page.locator(`[data-message-id="${id}"]`);
    const route = `/api/inbox/messages/${id}/image?path=${encodeURIComponent('.walkthrough/shots/after.png')}`;
    for (const alt of ['after the fix', 'html image']) {
      const img = body.locator(`img[alt="${alt}"]`);
      await expect(img).toHaveAttribute('src', route);
      await expectLoaded(img);
    }
    const outside = body.locator('img[alt="outside"]');
    await expect(outside).toHaveAttribute('src', `/api/inbox/messages/${id}/image?path=${encodeURIComponent('../outside.png')}`);
    await expectLoaded(outside);
    await expectLoaded(body.locator('img[alt="beside"]'));

    const replied = await fetch(new URL(`/api/inbox/messages/${id}/reply`, url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotency_key: 'e2e-person-image', words: `Compare ![mine outside](${join(root, 'src', 'outside.png')}) with ![mine inside](.walkthrough/shots/after.png)` }),
    });
    expect(replied.status).toBe(200);
    const replyId = ((await replied.json()) as { reply: { id: string } }).reply.id;
    await page.reload();
    const reply = page.locator(`[data-message-id="${replyId}"]`);
    await expectLoaded(reply.locator('img[alt="mine inside"]'));
    await expectRefused(reply, 'mine outside');

    await page.goto(`${url}#thread=${atHome.thread_id}`);
    await expectRefused(page.locator(`[data-message-id="${atHome.message_id as string}"]`), 'home hidden');
  } finally {
    await agent.close().catch(() => {});
    await context.close().catch(() => {});
    await removeInboxScratch(scratch);
  }
});
