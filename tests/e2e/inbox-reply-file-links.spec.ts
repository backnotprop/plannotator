/**
 * The files named in the person's own sent reply are links (replyFileLinks.ts;
 * the owner's ask, 2026-10-29: "When I comment on an image… or any
 * attachment in the same way… the reply body should ideally make a link for
 * me to click"). Proved against the compiled binary: an agent attaches an
 * image, code, Markdown, an HTML page and a video and shows an image in its
 * text; the person comments on each, draws on the image, and sends from the
 * window. In the sent reply each file's heading opens THAT file beside the
 * thread, the drawing's name shows the drawing, and a file deleted on disk
 * since links to the version that was sent. What the agent got is unchanged
 * (no link in its text). Also at a phone's width.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { mp4 } from '../helpers/video-fixtures';
import { codeCommentAnnotation, imageCommentAnnotation, videoCommentAnnotation } from '../../packages/inbox/attachments';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

test('each file the sent reply commented on opens from its heading; a drawing shows; a deleted file opens the version sent', async ({ browser }) => {
  test.setTimeout(120_000);
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-reply-links-e2e-');
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
    expect(response.status, `POST ${path}`).toBe(200);
    return (await response.json()) as Record<string, any>;
  };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  try {
    await post('/api/inbox/settings', { notifications: { dismissed: true } });
    const project = scratchProject(join(root, 'src'), 'shop');
    for (const dir of ['design', 'src', 'docs', 'proto', 'media']) mkdirSync(join(project, dir), { recursive: true });
    const painter = await context.newPage();
    await painter.setViewportSize({ width: 320, height: 200 });
    await painter.setContent('<body style="margin:0;background:#eef2ff;font:600 24px system-ui">Checkout</body>');
    writeFileSync(join(project, 'design', 'checkout.png'), await painter.screenshot());
    await painter.setContent('<body style="margin:0;background:#fde68a;font:700 24px system-ui">Spring sale</body>');
    writeFileSync(join(project, 'design', 'hero.png'), await painter.screenshot());
    await painter.setContent('<body style="margin:0;background:#fff"><svg width="320" height="200"><circle cx="160" cy="100" r="60" fill="none" stroke="red" stroke-width="5"/></svg></body>');
    const drawing = await painter.screenshot();
    await painter.close();
    writeFileSync(join(project, 'src', 'retry.ts'), 'export async function retry() {\n  try {\n    await run();\n  } catch {}\n}\n');
    writeFileSync(join(project, 'docs', 'plan.md'), '# Plan\n\nPro plan, billed yearly.\n');
    writeFileSync(join(project, 'proto', 'admin.html'), '<!doctype html><html><head><title>Admin</title></head><body><button>Retry all</button></body></html>');
    writeFileSync(join(project, 'media', 'walkthrough.mp4'), mp4());

    const sent = (await agent.send({
      project_path: project,
      subject: 'Checkout redesign, first pass',
      body: 'The new hero:\n\n![The hero](design/hero.png)\n\nThe rest is attached.',
      attachments: ['design/checkout.png', 'src/retry.ts', 'docs/plan.md', 'proto/admin.html', 'media/walkthrough.mp4'],
    })) as Record<string, any>;
    const model = (await (await fetch(`${url}/api/inbox/threads/${sent.thread_id}/attachments`)).json()) as { attachments: { id: string; name: string }[]; inline_images?: { id: string; name: string }[] };
    const idOf = (name: string) => [...model.attachments, ...(model.inline_images ?? [])].find((a) => a.name === name)!.id;
    const markup = (await (await fetch(`${url}/api/inbox/markups`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: drawing })).json()) as { path: string; name: string };
    const save = (name: string, annotation: object) => post('/api/inbox/annotations', { attachment_id: idOf(name), version: 'current', annotation });
    await save('checkout.png', imageCommentAnnotation({ id: 'c-img', name: 'checkout.png', text: 'The total needs more weight.', markup: { path: markup.path, name: 'checkout markup' } }));
    await save('hero.png', imageCommentAnnotation({ id: 'c-hero', name: 'hero.png', text: 'Softer, please.' }));
    await save('retry.ts', codeCommentAnnotation({ id: 'c-code', lineStart: 4, lineEnd: 4, text: 'Do not swallow errors.', code: '  } catch {}' }));
    await save('plan.md', { id: 'c-md', type: 'COMMENT', text: 'Say it once.', originalText: 'Pro plan, billed yearly.', blockId: 'block-1', startOffset: 0, endOffset: 0, createdA: 1 });
    await save('admin.html', { id: 'c-html', type: 'COMMENT', text: 'Ask first.', originalText: 'Retry all', blockId: 'block-0', startOffset: 0, endOffset: 0, createdA: 2 });
    await save('walkthrough.mp4', videoCommentAnnotation({ id: 'c-vid', name: 'walkthrough.mp4', time: 4.2, text: 'Cut the pause.' }));

    // The person sends from the window: the window writes the feedback text.
    const page = await context.newPage();
    await page.goto(`${url}/#thread=${sent.thread_id}`);
    await expect(page.locator('.ib-pfoot [data-draft-foot], .ib-pfoot').first()).toBeVisible();
    const waiting = agent.waitForReply(sent.thread_id, 40);
    await page.locator('.ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)/ }).first().click();
    await page.getByRole('textbox', { name: 'Reply to Claude Code' }).fill('Notes on the files below.');
    await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
    const reply = await waiting;
    const body = reply.reply.body as string;
    // The agent's text is unchanged: the headings name the files, no link the window draws.
    expect(body).toContain('## design/checkout.png\n');
    expect(body).not.toContain('.inbox-reply/');
    const messages = ((await (await fetch(`${url}/api/inbox/threads/${sent.thread_id}`)).json()) as { thread: { messages: { id: string; body: string }[] } }).thread.messages;
    const replyId = messages.find((m) => m.body === body)!.id;

    const sentReply = page.locator(`[data-message-id="${replyId}"]`);
    const heading = (name: string) => sentReply.locator('h2', { hasText: name }).getByRole('link');
    const hrefs: Record<string, string> = {
      'design/checkout.png': idOf('checkout.png'),
      'src/retry.ts': idOf('retry.ts'),
      'docs/plan.md': idOf('plan.md'),
      'proto/admin.html': idOf('admin.html'),
      'media/walkthrough.mp4': idOf('walkthrough.mp4'),
      'design/hero.png (image in your': idOf('hero.png'),
    };
    // Each heading's link is the window's own deep link to THAT file.
    for (const [name, id] of Object.entries(hrefs)) {
      await expect(heading(name)).toHaveAttribute('href', `#thread=${sent.thread_id}&file=${id}`);
    }

    // A click opens the file beside the thread: the image, then the image the agent's text showed.
    await heading('design/checkout.png').click();
    await expect(page.locator(`[data-attachment-pane="${idOf('checkout.png')}"]`)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`file=${idOf('checkout.png')}`));
    await heading('design/hero.png').click();
    await expect(page.locator(`[data-attachment-pane="${idOf('hero.png')}"]`)).toBeVisible();
    // Back to the thread alone (the image may have opened full screen).
    await page.goto(`${url}/#thread=${sent.thread_id}`);
    await expect(page.locator('[data-attachment-pane]')).toHaveCount(0);

    // The drawing on the image: its name shows it.
    const drawn = sentReply.getByRole('link', { name: 'checkout markup' });
    await expect(drawn).toHaveAttribute('href', `/api/inbox/markups/${markup.name}`);
    // The drawing's data-dir path is the agent's: in its text, not drawn in the window once the name links.
    expect(body).toContain(markup.path);
    await expect(sentReply).not.toContainText(markup.path);
    await drawn.click();
    await expect(page.locator(`img[src="/api/inbox/markups/${markup.name}"]`).last()).toBeVisible();
    await page.keyboard.press('Escape');

    // The code file is deleted on disk: its heading opens the version that was sent, never a dead link.
    rmSync(join(project, 'src', 'retry.ts'));
    await page.reload();
    await expect(heading('src/retry.ts')).toHaveAttribute('href', `#thread=${sent.thread_id}&file=${idOf('retry.ts')}&v=sent`);
    await heading('src/retry.ts').click();
    await expect(page.locator(`[data-attachment-pane="${idOf('retry.ts')}"]`)).toBeVisible();
    await expect(page).toHaveURL(/v=sent/);
    await expect(page.locator(`[data-attachment-pane="${idOf('retry.ts')}"]`)).toContainText('run()');

    // A phone's width: the same link opens the file over the thread.
    await page.goto(`${url}/#thread=${sent.thread_id}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await heading('docs/plan.md').scrollIntoViewIfNeeded();
    await heading('docs/plan.md').click();
    await expect(page.locator(`[data-attachment-pane="${idOf('plan.md')}"]`)).toBeVisible();
  } finally {
    await agent.close().catch(() => {});
    await context.close().catch(() => {});
    await removeInboxScratch(root);
  }
});
