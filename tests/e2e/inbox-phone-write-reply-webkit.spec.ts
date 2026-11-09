/**
 * "Write the reply" in a phone's Comments sheet, in iPhone WebKit against the
 * compiled binary: the file closes, the thread's reply box takes focus, and the
 * words typed in the file's card are still there. It used to leave full screen
 * in the address only, so nothing moved on screen.
 */
import { expect, test, devices } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(__dirname, '../../.local/plannotator'));
const { defaultBrowserType: _webkit, ...iphone } = devices['iPhone 15'];
// A real 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('Write the reply closes the file on a phone and keeps the typed words: HTML, image, Markdown', async ({ browser }) => {
  const root = inboxScratch('plannotator-inbox-phone-write-reply-');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: join(root, 'home'),
    PLANNOTATOR_TEST_SANDBOX: root,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    OPENCODE_CONFIG_DIR: join(root, 'opencode'),
    PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
  };
  mkdirSync(env.HOME);
  try {
    const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(started.status, started.stderr).toBe(0);
    rememberInboxOf(env.PLANNOTATOR_DATA_DIR);
    const url = started.stdout.trim();
    const project = scratchProject(join(root, 'src'), 'phone-reply');
    writeFileSync(join(project, 'page.html'), '<!doctype html><h1>Hello</h1>');
    writeFileSync(join(project, 'pic.png'), PNG);
    writeFileSync(join(project, 'plan.md'), '# Plan\n\nWords.\n');
    const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
    const sent = await agent.send({ project_path: project, subject: 'Phone reply', body: 'Files.', attachments: ['page.html', 'pic.png', 'plan.md'] });
    const thread = sent.thread_id as string;
    const model = (await (await fetch(new URL(`/api/inbox/threads/${thread}/attachments`, url))).json()) as { attachments: { id: string; name: string }[] };
    const context = await browser.newContext({ ...iphone, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const box = page.locator('.ib-rbox textarea');
    let words = '';
    for (const name of ['page.html', 'pic.png', 'plan.md']) {
      const id = model.attachments.find((a) => a.name === name)!.id;
      await page.goto('about:blank');
      await page.goto(`${url}#thread=${thread}&file=${id}&view=full`);
      const pane = page.locator('[data-attachment-pane]');
      await expect(pane).toHaveAttribute('data-full-view', '');
      await page.waitForTimeout(500);
      // Markdown has no card: the words from the file before it are the draft.
      if (name !== 'plan.md') {
        const pill = page.locator('[data-fcomp-pill]');
        if (await pill.isVisible()) await pill.tap();
        const tab = page.locator('[data-fcomp-mode="reply"]');
        if (await tab.isVisible()) await tab.tap();
        words = `Reply from ${name}`;
        await page.locator('[data-fcomp] [data-fcomp-field] textarea').fill(words);
        await expect
          .poll(async () => ((await (await fetch(new URL(`/api/inbox/threads/${thread}/draft`, url))).json()) as { draft: { body: string } | null }).draft?.body)
          .toBe(words);
      }
      await page.locator('[data-full-view-comments]').first().tap();
      await page.locator('[data-full-view-foot]').getByRole('button', { name: 'Write the reply' }).tap();
      await expect(pane).toHaveCount(0);
      await expect(box).toBeVisible();
      await expect(box).toBeFocused();
      await expect(box).toHaveValue(words);
    }
    await context.close();
    await agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});
