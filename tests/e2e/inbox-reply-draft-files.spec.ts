/**
 * Files attached to a reply draft sync to every device and go with whichever
 * one sends (the owner, 2026-11-02: "ideally it just syncs"), proved against
 * the compiled binary under a temp PLANNOTATOR_DATA_DIR (PLANNOTATOR_INBOX_CONNECT=0,
 * no browser opened by the Inbox, no update check):
 *
 * - At a desktop viewport the person writes a reply and attaches a picture and
 *   a notes file with the paperclip, then leaves (the page closes).
 * - At an iPhone viewport the same thread opens with the draft's words and
 *   both file tiles back in the reply box; each tile's × has a 44 px target.
 * - Send on the phone carries the words and both files: the agent reads them
 *   as the reply's attachments, the picture byte for byte, and the draft is done.
 *
 * Agents write through `plannotator inbox mcp` (scripts/inbox-sim.ts). Build the
 * binary first (see inbox.spec.ts). PLANNOTATOR_E2E_SHOTS_DIR names a folder for
 * the pictures (default .local/proof/reply-draft-files).
 */

import { devices, expect, test, type Browser } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { InboxReplyDraft } from '../../packages/core/inbox-types';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { png } from './phone-touch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/reply-draft-files'));

const WORDS = 'The header still jumps on the smallest phones. Screenshot and my notes attached.';
const PICTURE = png(640, 400, [64, 132, 220]);
const NOTES = '# Header jump\n\n- iPhone SE: 12 px jump when the promo field opens\n- Pixel 7: none\n';

let world: { url: string; agent: SimAgent; thread: string };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-reply-draft-files-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const env = {
    PATH: process.env.PATH ?? '',
    PLANNOTATOR_DATA_DIR: dataDir,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: root,
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const project = scratchProject(join(root, 'src'), 'fernway-checkout');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const sent = await agent.send({ project_path: project, subject: 'Checkout: the sticky header', body: 'The sticky header is in. Does it still jump for you?' });
  world = { url: started.stdout.trim(), agent, thread: sent.thread_id as string };
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

test('a draft started on the computer with a picture and a file opens on the phone with its tiles, and the phone sends them', async ({ browser }: { browser: Browser }) => {
  const draftUrl = new URL(`/api/inbox/threads/${world.thread}/draft`, world.url).href;

  // The computer: words and two files, attached with the paperclip; then the page goes.
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await desk.newPage();
  await page.goto(`${world.url}#thread=${world.thread}`);
  const pane = page.locator('section.ib-pane');
  await pane.locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
  await pane.locator('.ib-rbox textarea').fill(WORDS);
  await pane.locator('input[type="file"][data-reply-attach]').setInputFiles([
    { name: 'header-jump.png', mimeType: 'image/png', buffer: PICTURE },
    { name: 'header-notes.md', mimeType: 'text/markdown', buffer: Buffer.from(NOTES) },
  ]);
  const deskTiles = pane.locator('[data-reply-files] [data-compose-file="done"]');
  await expect(deskTiles).toHaveCount(2);
  await expect
    .poll(async () => {
      const draft = ((await (await page.request.get(draftUrl)).json()) as { draft: InboxReplyDraft | null }).draft;
      return draft ? `${draft.body}|${(draft.files ?? []).map((f) => f.name).join(',')}` : null;
    })
    .toBe(`${WORDS}|header-jump.png,header-notes.md`);
  await page.screenshot({ path: join(shotsDir, 'desktop-draft-with-files-1440.png') });
  await desk.close();

  // The phone: the same thread opens with the words and both tiles in the reply box.
  const phone = await browser.newContext({ ...devices['iPhone 13'], colorScheme: 'light' });
  const mobile = await phone.newPage();
  await mobile.goto(`${world.url}#thread=${world.thread}`);
  const box = mobile.locator('section.ib-pane .ib-rbox');
  await expect(box.locator('textarea')).toHaveValue(WORDS);
  const tiles = box.locator('[data-reply-files] [data-compose-file="done"]');
  await expect(tiles).toHaveCount(2);
  await expect(tiles.nth(0)).toHaveAttribute('data-compose-file-name', 'header-jump.png');
  await expect(tiles.nth(1)).toHaveAttribute('data-compose-file-name', 'header-notes.md');
  // Each tile's × is a finger's target on a phone: its drawn 26 px grows to a
  // 44 px hit area, so a tap 8 px outside the drawn box still lands on it.
  for (const tile of await tiles.all()) {
    const hits = await tile.locator('.ib-cp-fx').evaluate((button) => {
      const r = button.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const at = (x: number, y: number) => document.elementFromPoint(x, y)?.closest('.ib-cp-fx') === button;
      return [at(cx, r.top - 8), at(cx, r.bottom + 8), at(r.left - 8, cy), at(r.right + 8, cy)];
    });
    expect(hits).toEqual([true, true, true, true]);
  }
  await tiles.nth(1).scrollIntoViewIfNeeded();
  await mobile.screenshot({ path: join(shotsDir, 'phone-draft-tiles-390.png') });
  await box.screenshot({ path: join(shotsDir, 'phone-draft-tiles-box-390.png') });

  // Send on the phone: the agent gets the words and both files, and the draft is done.
  await mobile.locator('section.ib-pane .ib-acts').getByRole('button', { name: 'Send' }).click();
  const reply = (await world.agent.nextReply(world.thread)) as { body: string; attachments?: { name: string; path: string }[] };
  expect(reply.body.startsWith(WORDS)).toBe(true);
  expect((reply.attachments ?? []).map((a) => a.name)).toEqual(['header-jump.png', 'header-notes.md']);
  expect(readFileSync(reply.attachments![0]!.path).equals(PICTURE)).toBe(true);
  expect(readFileSync(reply.attachments![1]!.path, 'utf8')).toBe(NOTES);
  await expect.poll(async () => ((await (await mobile.request.get(draftUrl)).json()) as { draft: unknown }).draft).toBeNull();
  await expect(mobile.locator('section.ib-pane .ib-rbox')).toHaveCount(0);
  await mobile.screenshot({ path: join(shotsDir, 'phone-sent-390.png') });
  await phone.close();
});
