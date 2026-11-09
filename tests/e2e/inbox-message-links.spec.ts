/**
 * Links in a message to the files it attached, proved in a real browser
 * against the compiled binary. Nothing is mocked: `plannotator inbox
 * --background` runs under a temp PLANNOTATOR_DATA_DIR and HOME, an agent
 * sends through `plannotator inbox mcp` (scripts/inbox-sim.ts) a question
 * whose context links `design/mock.html`, which it attached, by its bare name,
 * and Chromium opens the thread: the link's tooltip names the file's path in
 * the project, its href is the window's deep link to the file (a new tab opens
 * it there), and it opens the mock beside the thread (HTML, so full screen)
 * from a click and from Enter; a link to a file it did not attach is inert text
 * and the window never requests it; an external link keeps opening in a new
 * tab.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const MOCK = '<!doctype html><html><head><meta charset="utf-8"><title>settings mock</title></head><body><h1>Settings, two columns</h1></body></html>';

test('a link to an attached file opens it beside the thread; an unattached one opens read only; an external one is unchanged', async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-links-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'shop');
  mkdirSync(join(project, 'design'));
  writeFileSync(join(project, 'design', 'mock.html'), MOCK);
  writeFileSync(join(project, 'notes.md'), '# notes\n');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
  const context = await browser.newContext();
  try {
    const sent = await agent.send({
      project_path: project,
      subject: 'Settings layout',
      attachments: ['design/mock.html'],
      body: [
        ':::question',
        'Which layout should the settings page use?',
        '',
        'Two columns keep the preview in view while you edit. See [the mock](mock.html).',
        '',
        '- [ ] Two columns',
        '- [ ] One column',
        '',
        'Recommended: Two columns',
        ':::',
        '',
        'My [working notes](notes.md) are not attached. The [style guide](https://example.com/style) is public.',
      ].join('\n'),
    });
    const id = sent.message_id as string;
    const page = await context.newPage();
    await page.goto(`${url}#thread=${sent.thread_id}`);
    const body = page.locator(`[data-message-id="${id}"]`);

    // Attached: a real link; a click opens the mock in the side pane.
    const mock = body.getByRole('link', { name: 'the mock' });
    await expect(mock).toHaveAttribute('data-local-link', 'open');
    // The tooltip names the file by its path in the project: ui's Tooltip, never a native title.
    await expect(mock).not.toHaveAttribute('title', /./);
    await mock.hover();
    await expect(page.locator('[data-side].bg-popover')).toHaveText('Open design/mock.html beside the thread');
    await page.mouse.move(1, 1);
    // Its href is the window's deep link to the file: a new tab opens the same file there.
    const deepLink = await mock.getAttribute('href');
    expect(deepLink).toMatch(new RegExp(`^#thread=${sent.thread_id}&file=att_[0-9A-Z]+$`));
    const tab = await context.newPage();
    await tab.goto(new URL(deepLink!, url).href);
    await expect(tab.locator('[data-attachment-pane]')).toHaveAttribute('aria-label', 'mock.html');
    await tab.close();
    await mock.click();
    const pane = page.locator('[data-attachment-pane]');
    await expect(pane).toBeVisible();
    await expect(pane).toHaveAttribute('aria-label', 'mock.html');
    await expect(page).toHaveURL(/file=att_/);
    // Focus moved into the pane.
    expect(await pane.evaluate((el) => el === document.activeElement)).toBe(true);

    // HTML opens full screen (approval "inbox-one-fullscreen"): Side by side puts it beside the thread, with its header.
    await expect(pane).toHaveAttribute('data-full-view', '');
    await page.getByRole('button', { name: 'Side by side' }).click();
    await expect(pane).not.toHaveAttribute('data-full-view', '');
    // Close it, then Enter on the focused link opens it again: side by side, the view just chosen.
    await page.getByRole('button', { name: 'Close mock.html' }).click();
    await expect(pane).toHaveCount(0);
    await mock.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-attachment-pane]')).toBeVisible();
    await expect(page.locator('[data-attachment-pane]')).not.toHaveAttribute('data-full-view', '');
    await page.getByRole('button', { name: 'Close mock.html' }).click();

    // Not attached (approval "inbox-file-refs-open-viewer"): an agent's link to a file of the project is a link too;
    // a click opens it read only beside the thread, never as an attachment.
    const notes = body.getByRole('link', { name: 'working notes' });
    await expect(notes).toHaveAttribute('data-local-link', 'open');
    await expect(notes).not.toHaveAttribute('title', /./);
    await notes.hover();
    await expect(page.locator('[data-side].bg-popover')).toHaveText('Open notes.md beside the thread');
    await page.mouse.move(1, 1);
    await notes.click();
    const named = page.locator('[data-referenced-file="notes.md"]');
    await expect(named).toBeVisible();
    await expect(named).toHaveAttribute('aria-label', 'notes.md');
    await expect(page.locator('[data-attachment-pane]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Close notes.md' }).click();
    await expect(named).toHaveCount(0);

    // External: a new tab without an opener, as before.
    const external = body.getByRole('link', { name: 'style guide' });
    await expect(external).toHaveAttribute('target', '_blank');
    await expect(external).toHaveAttribute('rel', 'noopener noreferrer');
  } finally {
    await agent.close().catch(() => {});
    await context.close().catch(() => {});
    // This test's Inbox, then its folder (inbox-scratch.ts).
    await removeInboxScratch(root);
  }
});
