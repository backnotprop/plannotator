/**
 * Images in an agent's message (#1813), proved in a real browser against the
 * compiled binary. Nothing is mocked: `plannotator inbox --background` runs
 * under a temp PLANNOTATOR_DATA_DIR and HOME, an agent writes through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts) with a markdown image and an
 * HTML <img> relative to its project, and Chromium opens the thread: each
 * <img> loads from the message's own route and decodes; a reference outside
 * the project does not load.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

/** A 1 x 1 PNG that decodes. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('a relative image in a message loads from the message route; one outside the project does not', async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-images-e2e-')));
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: 'none' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'shop');
  mkdirSync(join(project, '.walkthrough', 'shots'), { recursive: true });
  writeFileSync(join(project, '.walkthrough', 'shots', 'after.png'), PNG);
  writeFileSync(join(root, 'src', 'outside.png'), PNG);
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
      ].join('\n'),
    });
    const id = sent.message_id as string;
    const page = await context.newPage();
    await page.goto(`${url}#thread=${sent.thread_id}`);
    const body = page.locator(`[data-message-id="${id}"]`);

    const route = `/api/inbox/messages/${id}/image?path=${encodeURIComponent('.walkthrough/shots/after.png')}`;
    for (const alt of ['after the fix', 'html image']) {
      const img = body.getByRole('img', { name: alt });
      await expect(img).toHaveAttribute('src', route);
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1);
    }

    const outside = body.getByRole('img', { name: 'outside' });
    await expect(outside).toHaveAttribute('src', `/api/inbox/messages/${id}/image?path=${encodeURIComponent('../outside.png')}`);
    await expect.poll(() => outside.evaluate((el: HTMLImageElement) => el.complete)).toBe(true);
    expect(await outside.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(0);
  } finally {
    await agent.close().catch(() => {});
    await context.close();
    try {
      process.kill(JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')).pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
    rmSync(root, { recursive: true, force: true });
  }
});
