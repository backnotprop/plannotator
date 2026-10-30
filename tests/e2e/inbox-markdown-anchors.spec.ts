/** Heading links scroll the attachment, without replacing the Inbox route (#2229). */
import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { forgetFileViewChoice } from './file-view';

const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? '.local/plannotator');
const markdown = [
  '# Attachment preview',
  '[Jump to target](#target-section)',
  '[Missing target](#missing%22%5D)',
  '[Encoded target](#2026-caf%C3%A9)',
  ...Array.from({ length: 65 }, (_, i) => `Filler paragraph ${i + 1}. The destination is below the fold.`),
  '## Target section',
  'Target marker.',
  '[Back to top](#attachment-preview)',
  '## 2026 Café',
].join('\n\n');

for (const layout of ['side', 'full', 'phone'] as const) {
  test(`${layout}: heading links scroll inside the Markdown attachment`, async ({ browser }) => {
    const root = inboxScratch('plannotator-markdown-anchors-');
    const home = join(root, 'home');
    mkdirSync(home);
    const env = {
      PATH: process.env.PATH ?? '', HOME: home, PLANNOTATOR_DATA_DIR: join(root, 'data'),
      PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER,
      PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_TAILSCALE: '0', PLANNOTATOR_INBOX_PHONES: '0',
      PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_NOTES: '0',
    };
    const context = await browser.newContext({
      viewport: layout === 'phone' ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    let agent: SimAgent | undefined;
    try {
      const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
      expect(started.status, started.stderr).toBe(0);
      const url = started.stdout.trim();
      const project = scratchProject(join(root, 'src'), 'anchors');
      writeFileSync(join(project, 'guide.md'), markdown);
      agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
      const sent = await agent.send({
        project_path: project, subject: 'Review the guide',
        // A matching heading in the thread must not shadow the attachment's target.
        body: '## Target section\n\nReview the attached guide.', attachments: ['guide.md'],
      });
      const model = await (await fetch(new URL(`/api/inbox/threads/${sent.thread_id}/attachments`, url))).json() as {
        attachments: { id: string }[];
      };
      const page = await context.newPage();
      await page.goto(`${url}#thread=${sent.thread_id}&file=${model.attachments[0]!.id}&view=${layout === 'side' ? 'side' : 'full'}`);
      const pane = page.locator('[data-attachment-pane]');
      const scroller = pane.locator('.ib-docscroll');
      const target = pane.locator('#target-section');
      await expect(target).toHaveCount(1);
      await expect(page.locator('[id="target-section"]')).toHaveCount(2);
      const route = page.url();
      await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
      const bounds = (await scroller.boundingBox())!;
      expect((await target.boundingBox())!.y).toBeGreaterThan(bounds.y + bounds.height);
      await pane.getByRole('link', { name: 'Missing target', exact: true }).click();
      expect(page.url()).toBe(route);
      await pane.getByRole('link', { name: 'Jump to target', exact: true }).click();
      await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await expect.poll(async () => {
        const heading = (await target.boundingBox())!;
        return heading.y >= bounds.y && heading.y + heading.height <= bounds.y + bounds.height;
      }).toBe(true);
      expect(page.url()).toBe(route);
      await pane.getByRole('link', { name: 'Back to top', exact: true }).click();
      await expect.poll(async () => {
        const heading = (await pane.locator('#attachment-preview').boundingBox())!;
        return heading.y >= bounds.y && heading.y < bounds.y + bounds.height;
      }).toBe(true);
      expect(page.url()).toBe(route);
      await pane.getByRole('link', { name: 'Encoded target', exact: true }).click();
      await expect.poll(async () => {
        const heading = (await pane.locator('[id="2026-café"]').boundingBox())!;
        return heading.y >= bounds.y && heading.y + heading.height <= bounds.y + bounds.height;
      }).toBe(true);
      expect(page.url()).toBe(route);
      await forgetFileViewChoice(page);
    } finally {
      try {
        await agent?.close();
        await context.close();
      } finally {
        await removeInboxScratch(root);
      }
    }
  });
}
