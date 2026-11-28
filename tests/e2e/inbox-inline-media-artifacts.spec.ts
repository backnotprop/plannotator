/**
 * A sound or video a message's text plays in place is an artifact of the
 * thread, as its pictures are (inbox-messages.md "A thread's Artifacts"): on
 * the compiled binary, a made-up thread whose message shows a picture and
 * plays a video in its text, draws an html block, and attaches one ordinary
 * file. After the thread is read the Inbox keeps the video as a file of the
 * thread, so the header's count, the thread's Artifacts grid, the viewer,
 * a pin and the Artifacts wall all hold it. The html block stays a live page
 * in the text and is an artifact of its own, not a file (its own spec:
 * inbox-html-artifacts.spec.ts). "Open" under the
 * player in the body opens the viewer, where a comment takes its moment and a
 * frame is drawn on; Send carries both under "(video in your … message)".
 *
 * Whole-window PNGs, 1440 × 900 light and dark and a 390 × 844 phone, land in
 * PLANNOTATOR_E2E_SHOTS_DIR (default `.local/proof/inline-artifacts`).
 */
import { chromium, expect, test, type Browser, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** A ship moving between berths, a new picture every frame, so a seek lands on another frame. */
const CLIP_PAGE = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0f3b57;font:600 22px system-ui,sans-serif;color:#fff}
#s{position:absolute;top:150px;width:90px;height:56px;border-radius:8px;background:#f2c14e}
h1{margin:0;padding:22px 26px;font-size:22px}</style><h1>Harbor · berth 4</h1><div id="s"></div>
<script>const start=performance.now();function tick(){const t=(performance.now()-start)/1000;
document.getElementById('s').style.left=(30+(t*120)%480)+'px';requestAnimationFrame(tick)}tick();</script>`;

/**
 * About three seconds of that page, recorded by Playwright (a VP8 WebM with its length written at the end, as
 * inbox-video.spec.ts makes its film): the tile and the viewer have real frames, and the viewer can seek.
 */
async function recordClip(browser: Browser, dir: string): Promise<Buffer> {
  const recorder = await browser.newContext({ viewport: { width: 640, height: 360 }, recordVideo: { dir, size: { width: 640, height: 360 } } });
  const page = await recorder.newPage();
  await page.setContent(CLIP_PAGE);
  await page.waitForTimeout(3200);
  const video = page.video()!;
  await recorder.close();
  return readFileSync(await video.path());
}

const PANE_VIDEO = '[data-attachment-pane] video[data-video-player]';

/** The viewer's video, once it has its metadata. */
async function filmReady(page: Page): Promise<void> {
  await page.waitForFunction(
    (selector) => {
      const video = document.querySelector<HTMLVideoElement>(selector);
      return !!video && video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0;
    },
    PANE_VIDEO,
    { timeout: 30_000 },
  );
}

/** Seek the viewer's video and wait for the frame there. */
async function seekFilm(page: Page, time: number): Promise<void> {
  await page.evaluate(
    ([selector, t]) =>
      new Promise<void>((done) => {
        const video = document.querySelector<HTMLVideoElement>(selector as string)!;
        video.addEventListener('seeked', () => done(), { once: true });
        video.currentTime = t as number;
      }),
    [PANE_VIDEO, time] as const,
  );
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

test('a video played in a message is an artifact: the count, the grid, the viewer, a pin, the wall, and a comment and a drawing from the body', async ({ browserName }) => {
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
    writeFileSync(join(harbor, 'media', 'walkthrough.webm'), await recordClip(browser, join(root, 'recordings')));
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
    // The picture (captured at send), the video (captured once the thread is read), the html block and the attached notes.
    await expect(button).toHaveAttribute('aria-label', 'Artifacts, 4', { timeout: 20_000 });
    await expect(page.locator(`[data-message-id="${sent.message_id}"] video[data-inline-media="video"]`)).toBeVisible();
    await shot(page, '01-thread-with-count-desktop');

    await button.click();
    const tiles = page.locator('[data-artifacts-view] [data-artifact-tile]');
    await expect(tiles).toHaveCount(4);
    await expect(tiles.nth(0)).toContainText('berths.png');
    await expect(tiles.nth(1)).toContainText('walkthrough.webm');
    await expect(tiles.nth(1)).toContainText('in text');
    await expect(tiles.nth(2)).toContainText('HTML block');
    await expect(tiles.nth(3)).toContainText('notes.md');
    await shot(page, '02-thread-artifacts-grid-desktop');

    await tiles.nth(1).click();
    const pane = page.locator('[data-attachment-pane]');
    await expect(pane).toBeVisible();
    await expect(pane.locator('video')).toHaveCount(1);
    await shot(page, '03-video-open-desktop');
    // A file from a message's text opens full screen (fileView.ts), whose × is named for where it goes.
    await pane.getByRole('button', { name: 'Back to the thread', exact: true }).click();
    await expect(pane).toHaveCount(0);

    const filmCard = page.locator('[data-artifacts-view] li').filter({ has: page.locator('[data-artifact-tile]', { hasText: 'walkthrough.webm' }) });
    await filmCard.hover();
    await filmCard.locator('[data-artifact-pin]').click();
    await expect(page.locator('[data-artifacts-group="pinned"]')).toContainText('walkthrough.webm');
    await shot(page, '04-video-pinned-desktop');

    await page.goto(`${url}#artifacts`);
    const wall = page.locator('[data-wall-artifact]');
    await expect(wall).toHaveCount(5, { timeout: 20_000 });
    await expect(wall.filter({ hasText: 'walkthrough.webm' })).toHaveCount(1);
    await shot(page, '05-artifacts-wall-desktop');

    // Commented on and drawn on as an attached film is: "Open" under the player in the body opens the viewer
    // (the player's own controls keep their clicks).
    await page.goto(`${url}#thread=${sent.thread_id}`);
    const body = page.locator(`[data-message-id="${sent.message_id}"]`);
    const openFilm = body.getByRole('button', { name: 'Open walkthrough.webm' });
    await expect(openFilm).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-attachment-pane]')).toHaveCount(0);
    await openFilm.scrollIntoViewIfNeeded();
    await shot(page, '09-body-open-under-the-video-desktop');
    await openFilm.click();
    const viewer = page.locator('[data-attachment-pane]');
    await expect(viewer.locator('video[data-video-player]')).toBeVisible();
    await filmReady(page);
    await shot(page, '10-viewer-from-the-body-desktop');

    await seekFilm(page, 0.6);
    await viewer.getByRole('textbox', { name: /^Comment on walkthrough\.webm at / }).fill('Hold on the berth change a beat longer.');
    await viewer.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(viewer.locator('.ib-apanel [data-video-card-time]')).toHaveText(['0:00']);
    await shot(page, '11-time-comment-desktop');

    await seekFilm(page, 1.6);
    await viewer.locator('[data-video-composer] [data-markup-open]').click();
    const stage = page.locator('[data-pn-image-annotator-stage] canvas').first();
    await expect(stage).toBeVisible();
    const frame = (await stage.boundingBox())!;
    await page.locator('[data-pn-image-annotator-toolbar] button[title="Circle (3)"]').click();
    await page.mouse.move(frame.x + frame.width * 0.3, frame.y + frame.height * 0.35);
    await page.mouse.down();
    await page.mouse.move(frame.x + frame.width * 0.6, frame.y + frame.height * 0.65, { steps: 8 });
    await page.mouse.up();
    await shot(page, '12-frame-drawing-desktop');
    // Enter adds the marked-up frame at the pinned moment; the words after it are its note.
    await page.keyboard.press('Enter');
    await expect(viewer.locator('[data-video-composer] [data-markup-kept] img')).toBeVisible();
    await viewer.getByRole('textbox', { name: /^A note with your drawing at / }).fill('Quill Star crosses into B2 here.');
    await viewer.getByRole('button', { name: 'Add note', exact: true }).click();
    await expect(viewer.locator('.ib-apanel [data-video-card-time]')).toHaveText(['0:00', '0:01']);
    await shot(page, '13-time-comment-and-drawing-listed-desktop');

    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    const small = await phone.newPage();
    await small.goto(`${url}#thread=${sent.thread_id}`);
    await expect(small.locator('[data-artifacts-button]')).toBeVisible({ timeout: 20_000 });
    await shot(small, '06-thread-phone');
    // The same way in on a phone, and the comment at a moment and the drawing made on the computer, listed by time.
    const openOnPhone = small.locator(`[data-message-id="${sent.message_id}"]`).getByRole('button', { name: 'Open walkthrough.webm' });
    await expect(openOnPhone).toBeVisible({ timeout: 20_000 });
    await openOnPhone.scrollIntoViewIfNeeded();
    await shot(small, '14-body-open-under-the-video-phone');
    await openOnPhone.tap();
    await expect(small.locator(PANE_VIDEO)).toBeVisible();
    await filmReady(small);
    await shot(small, '15-viewer-from-the-body-phone');
    // A phone lists them under the rail (VideoAttachmentView's `data-video-list`); the side panel stays closed.
    const cards = small.locator('[data-attachment-pane] [data-video-list] [data-video-card]');
    await expect(cards.locator('.ib-vtime')).toHaveText(['0:00', '0:01']);
    await cards.nth(0).scrollIntoViewIfNeeded();
    await shot(small, '16-time-comment-phone');
    await cards.nth(1).scrollIntoViewIfNeeded();
    await shot(small, '17-frame-drawing-phone');
    await small.goto(`${url}#thread=${sent.thread_id}&artifacts`);
    await expect(small.locator('[data-artifacts-view] [data-artifact-tile]').filter({ hasText: 'walkthrough.webm' })).toHaveCount(1);
    await shot(small, '07-thread-artifacts-phone');
    await small.goto(`${url}#artifacts`);
    await expect(small.locator('[data-wall-artifact]').filter({ hasText: 'walkthrough.webm' })).toHaveCount(1, { timeout: 20_000 });
    await shot(small, '08-artifacts-wall-phone');
    await phone.close();

    // Send: the agent reads both under the video's own heading, each at its moment.
    await viewer.getByRole('button', { name: 'Back to the thread', exact: true }).click();
    await expect(viewer).toHaveCount(0);
    await page.locator('.ib-pfoot').getByRole('button', { name: 'Edit draft' }).click();
    await page.getByRole('textbox', { name: /^Reply to / }).fill('Two notes on the walkthrough.');
    await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
    const reply = await agent.nextReply(sent.thread_id, 40);
    const feedback = reply.body as string;
    expect(feedback).toMatch(/^## media\/walkthrough\.webm \(video in your [^()]*message\)/m);
    expect(feedback).not.toMatch(/walkthrough\.webm \(image in /);
    expect(feedback).toMatch(/\nAt 0:00 \(0\.6 s/);
    expect(feedback).toMatch(/\nAt 0:01 \(1\.6 s/);
    expect(feedback).toContain('Hold on the berth change a beat longer.');
    expect(feedback).toMatch(/- \[walkthrough at 0:01, marked up\] `[^`]+`/);
    await context.close();
  } finally {
    await agent.close().catch(() => {});
    await browser.close().catch(() => {});
    await removeInboxScratch(root);
  }
});
