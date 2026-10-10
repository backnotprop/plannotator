/**
 * Links in a message to the files it attached, proved in a real browser
 * against the compiled binary. Nothing is mocked: `plannotator inbox
 * --background` runs under a temp PLANNOTATOR_DATA_DIR and HOME, an agent
 * sends through `plannotator inbox mcp` (scripts/inbox-sim.ts) a question
 * whose context links `mock.html`, which it attached, and Chromium opens the
 * thread: the link opens the mock beside the thread (HTML, so full screen) from
 * a click and from Enter; a link to a file it did not attach is inert text and
 * the window never requests it; an external link keeps opening in a new tab.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const MOCK = '<!doctype html><html><head><meta charset="utf-8"><title>settings mock</title></head><body><h1>Settings, two columns</h1></body></html>';

test('a link to an attached file opens it beside the thread; an unattached one is inert; an external one is unchanged', async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-links-e2e-')));
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: 'none' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'shop');
  writeFileSync(join(project, 'mock.html'), MOCK);
  writeFileSync(join(project, 'notes.md'), '# notes\n');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
  const context = await browser.newContext();
  try {
    const sent = await agent.send({
      project_path: project,
      subject: 'Settings layout',
      attachments: ['mock.html'],
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
    const requested: string[] = [];
    page.on('request', (request) => requested.push(new URL(request.url()).pathname + new URL(request.url()).search));
    await page.goto(`${url}#thread=${sent.thread_id}`);
    const body = page.locator(`[data-message-id="${id}"]`);

    // Attached: a real link; a click opens the mock in the side pane.
    const mock = body.getByRole('link', { name: 'the mock' });
    await expect(mock).toHaveAttribute('data-local-link', 'open');
    await mock.click();
    const pane = page.locator('[data-attachment-pane]');
    await expect(pane).toBeVisible();
    await expect(pane).toHaveAttribute('aria-label', 'mock.html');
    await expect(page).toHaveURL(/file=att_/);
    // Focus moved into the pane.
    expect(await pane.evaluate((el) => el === document.activeElement)).toBe(true);

    // Close it, then Enter on the focused link opens it again.
    await page.getByRole('button', { name: 'Close mock.html' }).click();
    await expect(pane).toHaveCount(0);
    await mock.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-attachment-pane]')).toBeVisible();
    await page.getByRole('button', { name: 'Close mock.html' }).click();

    // Not attached: inert text with its reason, never requested.
    const notes = body.locator('[data-local-link="unavailable"]', { hasText: 'working notes' });
    await expect(notes).toHaveAttribute('title', /Not attached/);
    expect(await notes.evaluate((el) => el.tagName)).toBe('SPAN');
    await notes.click();
    await expect(page.locator('[data-attachment-pane]')).toHaveCount(0);
    expect(requested.filter((path) => path.includes('notes.md'))).toEqual([]);

    // External: a new tab without an opener, as before.
    const external = body.getByRole('link', { name: 'style guide' });
    await expect(external).toHaveAttribute('target', '_blank');
    await expect(external).toHaveAttribute('rel', 'noopener noreferrer');
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
