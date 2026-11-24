/**
 * A sound or video a message's text plays in place is an artifact of the
 * thread, as its pictures are (inbox-messages.md "A thread's Artifacts"): on
 * the compiled binary, a made-up thread whose message shows a picture and
 * plays a video in its text, draws an html block, and attaches one ordinary
 * file. After the thread is read the Inbox keeps the video as a file of the
 * thread, so the header's count, the thread's Artifacts grid, the viewer,
 * a pin and the Artifacts wall all hold it. The html block stays a live page
 * in the text and is not an artifact (it is not a file).
 *
 * Whole-window PNGs, 1440 × 900 light and dark and a 390 × 844 phone, land in
 * PLANNOTATOR_E2E_SHOTS_DIR (default `.local/proof/inline-artifacts`).
 */
import { chromium, expect, test, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/inline-artifacts'));
const CHROMIUM_ARGS = ['--use-mock-keychain', '--password-store=basic', '--mute-audio'];

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(shotsDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

/** A short WebM drawn and recorded by Chromium, so the tile and the viewer have real frames. */
async function recordClip(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext('2d')!;
    const recorder = new MediaRecorder(canvas.captureStream(15), { mimeType: 'video/webm;codecs=vp8' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((done) => (recorder.onstop = done));
    let frame = 0;
    const draw = () => {
      ctx.fillStyle = '#0f3b57';
      ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = '#f2c14e';
      ctx.fillRect(20 + ((frame * 9) % 240), 70, 60, 40);
      ctx.fillStyle = '#fff';
      ctx.font = '600 18px system-ui';
      ctx.fillText('Harbor · berth 4', 20, 36);
      frame++;
    };
    draw();
    recorder.start(100);
    const timer = setInterval(draw, 66);
    await new Promise((done) => setTimeout(done, 1500));
    clearInterval(timer);
    recorder.stop();
    await stopped;
    const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  });
  return Buffer.from(base64, 'base64');
}

async function drawnPng(page: Page, html: string): Promise<Buffer> {
  await page.setViewportSize({ width: 960, height: 600 });
  await page.setContent(html);
  return page.screenshot();
}

const BERTHS = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:15px system-ui,sans-serif;background:#eef3f6;color:#0f172a}
h1{font-size:20px;margin:24px 28px 8px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 28px}
.b{background:#fff;border-radius:10px;padding:18px;box-shadow:0 1px 3px #0002}.b b{display:block;font-size:22px}
.busy{background:#0f3b57;color:#fff}</style><h1>Harbor · berth plan, Thursday</h1>
<div class="grid"><div class="b busy"><b>B1</b>MV Fernwood</div><div class="b"><b>B2</b>free</div><div class="b busy"><b>B3</b>Quill Star</div><div class="b"><b>B4</b>free from 14:00</div></div>`;

test('a video played in a message is an artifact: the count, the grid, the viewer, a pin and the wall', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium records the clip');
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-inline-artifacts-');
  const home = join(root, 'home');
  const trap = join(root, 'trap');
  mkdirSync(home, { recursive: true });
  mkdirSync(trap, { recursive: true });
  writeFileSync(join(trap, 'tailscale'), '#!/bin/sh\necho "inline-artifacts: tailscale must not run" >&2\nexit 97\n');
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = {
    PATH: `${trap}:${process.env.PATH ?? ''}`,
    HOME: home,
    PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    NO_ANON_PING: '1',
    NO_BROWSER,
    PLANNOTATOR_BROWSER: NO_BROWSER,
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const browser = await chromium.launch({ args: CHROMIUM_ARGS });
  const agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
  try {
    const maker = await browser.newPage();
    const harbor = scratchProject(join(root, 'src'), 'harbor');
    const quill = scratchProject(join(root, 'src'), 'quill-docs');
    mkdirSync(join(harbor, 'media'), { recursive: true });
    writeFileSync(join(harbor, 'media', 'walkthrough.webm'), await recordClip(maker));
    writeFileSync(join(harbor, 'media', 'berths.png'), await drawnPng(maker, BERTHS));
    writeFileSync(join(harbor, 'notes.md'), '# Berth planner\n\nCharlie Dunn signs off the Thursday plan; Bob Tully runs the tide check.\n');
    mkdirSync(join(quill, 'shots'), { recursive: true });
    writeFileSync(join(quill, 'shots', 'toc.png'), await drawnPng(maker, '<!doctype html><body style="font:16px system-ui;margin:28px"><h2>Quill docs · contents</h2><ol><li>Install</li><li>Ledger export</li><li>Fern API keys</li></ol>'));
    await maker.close();

    await agent.send({ project_path: quill, subject: 'Quill docs: new contents page', body: 'The contents page now lists the Ledger export.\n\n![Contents](shots/toc.png)' });
    const sent = await agent.send({
      project_path: harbor,
      subject: 'Harbor: the berth planner walkthrough',
      body: [
        'Charlie Dunn asked for the Thursday plan. Here it is:',
        '',
        '![Berth plan](media/berths.png)',
        '',
        'And a short walkthrough of moving a ship between berths:',
        '',
        '![Walkthrough](media/walkthrough.webm)',
        '',
        'The tide table Bob Tully checks against:',
        '',
        '```html',
        '<table style="font:14px system-ui;border-collapse:collapse"><tr><th style="padding:4px 12px">High</th><th style="padding:4px 12px">Low</th></tr><tr><td style="padding:4px 12px">06:12</td><td style="padding:4px 12px">12:30</td></tr></table>',
        '```',
        '',
        'My notes are attached.',
      ].join('\n'),
      attachments: ['notes.md'],
    });

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto(`${url}#thread=${sent.thread_id}`);
    const button = page.locator('[data-artifacts-button]');
    // The picture (captured at send), the video (captured once the thread is read) and the attached notes.
    await expect(button).toHaveAttribute('aria-label', 'Artifacts, 3', { timeout: 20_000 });
    await expect(page.locator(`[data-message-id="${sent.message_id}"] video[data-inline-media="video"]`)).toBeVisible();
    await shot(page, '01-thread-with-count-desktop');

    await button.click();
    const tiles = page.locator('[data-artifacts-view] [data-artifact-tile]');
    await expect(tiles).toHaveCount(3);
    await expect(tiles.nth(0)).toContainText('berths.png');
    await expect(tiles.nth(1)).toContainText('walkthrough.webm');
    await expect(tiles.nth(1)).toContainText('in text');
    await expect(tiles.nth(2)).toContainText('notes.md');
    await shot(page, '02-thread-artifacts-grid-desktop');

    await tiles.nth(1).click();
    const pane = page.locator('[data-attachment-pane]');
    await expect(pane).toBeVisible();
    await expect(pane.locator('video')).toHaveCount(1);
    await shot(page, '03-video-open-desktop');
    await pane.getByRole('button', { name: 'Close walkthrough.webm' }).click();
    await expect(pane).toHaveCount(0);

    const filmCard = page.locator('[data-artifacts-view] li').filter({ has: page.locator('[data-artifact-tile]', { hasText: 'walkthrough.webm' }) });
    await filmCard.hover();
    await filmCard.locator('[data-artifact-pin]').click();
    await expect(page.locator('[data-artifacts-group="pinned"]')).toContainText('walkthrough.webm');
    await shot(page, '04-video-pinned-desktop');

    await page.goto(`${url}#artifacts`);
    const wall = page.locator('[data-wall-artifact]');
    await expect(wall).toHaveCount(4, { timeout: 20_000 });
    await expect(wall.filter({ hasText: 'walkthrough.webm' })).toHaveCount(1);
    await shot(page, '05-artifacts-wall-desktop');
    await context.close();

    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    const small = await phone.newPage();
    await small.goto(`${url}#thread=${sent.thread_id}`);
    await expect(small.locator('[data-artifacts-button]')).toBeVisible({ timeout: 20_000 });
    await shot(small, '06-thread-phone');
    await small.goto(`${url}#thread=${sent.thread_id}&artifacts`);
    await expect(small.locator('[data-artifacts-view] [data-artifact-tile]').filter({ hasText: 'walkthrough.webm' })).toHaveCount(1);
    await shot(small, '07-thread-artifacts-phone');
    await small.goto(`${url}#artifacts`);
    await expect(small.locator('[data-wall-artifact]').filter({ hasText: 'walkthrough.webm' })).toHaveCount(1, { timeout: 20_000 });
    await shot(small, '08-artifacts-wall-phone');
    await phone.close();
  } finally {
    await agent.close().catch(() => {});
    await browser.close().catch(() => {});
    await removeInboxScratch(root);
  }
});
