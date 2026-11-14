/**
 * Live review threads at 390 px in WebKit (iPhone size), the whole journey against the compiled binary: the person's comment goes
 * from the review window to the agent that opened the review through a sandboxed Inbox, the agent (a bridge
 * connection, never a real CLI) is woken with the comment's lines, its answer appears under those lines while the page
 * is open, the person tags a second agent in the reply box and that agent is woken too, and Resolve folds the thread.
 * `plannotator inbox` and `plannotator review` run under a temp HOME and PLANNOTATOR_DATA_DIR. Build the binary first.
 */
import { expect, test } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TagConnection } from '../helpers/inbox-tag-world';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { buildRepo, FIRST_RUN, liveEnv } from './review-live-world';

const repoRoot = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repoRoot, '.local/plannotator'));
const OWNER = 'cc-live-owner-1';
const SECOND = 'pi-live-second-2';

test('on an iPhone-sized screen: the comment reaches its agent, the answer lands on the lines, a tag wakes another, resolve folds it', async ({ browser }) => {
  test.skip(!existsSync(binary), `build the binary first: ${binary}`);
  const root = inboxScratch('plannotator-review-live-webkit-');
  const dataDir = join(root, 'data');
  const env = liveEnv(root, dataDir);
  const connections: TagConnection[] = [];
  let review: ChildProcess | undefined;
  try {
    const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(started.status, started.stderr).toBe(0);
    rememberInboxOf(dataDir);
    const inboxUrl = started.stdout.trim().replace(/\/$/, '');
    const { token } = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { token: string };
    const repo = buildRepo(root);
    const state = { busy: false, tags: true, sendNow: true, startedAt: Date.now() - 600_000 };
    const owner = new TagConnection(inboxUrl, token, OWNER, 'claude-code', repo, state);
    const second = new TagConnection(inboxUrl, token, SECOND, 'pi', repo, state);
    connections.push(owner, second);

    const readyFile = join(root, 'ready.jsonl');
    review = spawn(binary, ['review'], { env: { ...env, PLANNOTATOR_READY_FILE: readyFile, PLANNOTATOR_SESSION_TAG: `claude-code:${OWNER}` }, cwd: repo, stdio: 'ignore' });
    await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
    const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;

    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    await context.addCookies(Object.entries(FIRST_RUN).map(([name, value]) => ({ name, value, url })));
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.locator('[data-line-type]').first()).toBeVisible({ timeout: 30_000 });

    const sent = await page.evaluate(async () => {
      const res = await fetch('/api/live/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comments: [{ anchor: { file: 'src/billing.ts', side: 'new', line_start: 2, line_end: 2, code: ['  if (amount < 0) throw new Error("bad");'] }, words: 'Can this say why?' }], idempotency_key: 'e2e-1' }),
      });
      return (await res.json()) as { sent: string[] };
    });
    const commentId = sent.sent[0]!;
    await expect.poll(() => owner.commands.find((c) => c.id === commentId)?.body ?? '').toContain('Answer it with reply_to');
    expect(owner.commands.find((c) => c.id === commentId)!.body).toContain('if (amount < 0) throw new Error("bad");');
    await owner.deliver(commentId);

    const card = page.locator(`[data-live-thread="${commentId}"]`);
    await expect(card).toBeVisible();
    await expect(card.locator('[data-live-delivery]')).toHaveText('· Delivered');

    const mcp = await fetch(`${inboxUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { project_path: repo, reply_to: commentId, body: 'It throws RangeError("amount must be positive") now.', agent_session: OWNER, agent_host: 'claude-code' } } }),
    });
    expect(mcp.status).toBe(200);
    await expect(card.locator('[data-live-message][data-author="agent"]')).toContainText('RangeError');
    await expect(card.locator('[data-live-delivery]')).toHaveText('· Read');

    await card.locator('[data-live-reply]').click();
    const box = card.locator('[data-live-composer] textarea');
    await box.click();
    await box.pressSequentially('Pi, can you add a test? @Pi');
    await box.press('ArrowDown');
    await box.press('Enter');
    await expect(box).toHaveValue(/@Pi /);
    await card.locator('[data-live-composer] button', { hasText: 'Reply' }).click();
    await expect.poll(() => second.commands.length).toBe(1);
    expect(second.commands[0]!.body).toContain('Pi, can you add a test?');

    await card.locator('[data-live-resolve]').click();
    await expect(card).toHaveAttribute('data-resolved');
    await context.close();
  } finally {
    for (const connection of connections) await connection.stop();
    if (review && review.exitCode === null) review.kill('SIGTERM');
    await removeInboxScratch(root);
  }
});

