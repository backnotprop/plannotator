/**
 * Video attachments (design record "inbox-video"), proved in a real browser
 * against the compiled binary. Nothing is mocked: `plannotator inbox
 * --background` runs under a temp PLANNOTATOR_DATA_DIR and HOME; the film is
 * made in the test by Playwright's own screen recorder (a VP8 WebM, which
 * every Chromium plays; no binary is committed); an agent attaches it through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts); Chromium drives the window.
 *
 * Proves: the film is kind `video` and its tile offers Play; it plays in the
 * pane's native `<video>` from the `video` route by HTTP Range (a 206 is
 * seen); typing pauses it and pins the moment; Comment keeps the paused
 * frame (a real JPEG in the Inbox's markups) and lists the comment with its
 * time; a dot on the rail and the panel's time pill seek back to it; Send
 * carries "At 0:02 (…)" and the frame's path, read back by wait_for_reply;
 * and the pane on a phone (the comments under the rail, "Comment at").
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-video.spec.ts`.
 * PNGs land in PLANNOTATOR_E2E_SHOTS_DIR (default .local/proof/video).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/video'));

/** A page that changes every frame, so a seek lands on a different picture. */
const FILM_PAGE = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;font:600 54px system-ui,sans-serif;color:#fff}
body{display:flex;align-items:center;justify-content:center;background:#312e81}
#t{font-variant-numeric:tabular-nums}small{display:block;font-size:20px;font-weight:500;opacity:.8}
</style><body><div><small>Plannotator launch cut</small><span id="t">0.0 s</span></div>
<script>const start=performance.now();const hues=[230,280,330,20,150];
function tick(){const s=(performance.now()-start)/1000;document.getElementById('t').textContent=s.toFixed(1)+' s';
document.body.style.background='hsl('+hues[Math.floor(s)%hues.length]+' 55% 32%)';requestAnimationFrame(tick)}tick();</script>`;

interface World {
  dataDir: string;
  url: string;
  project: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  ranges: { range: string | null; status: number }[];
  threadId: string;
  filmId: string;
}

let world: World;

async function shot(name: string, page: Page = world.page): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(shotsDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** The pane's video element, once it has its metadata. */
async function videoReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('video[data-video-player]');
    return !!video && video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0;
  }, undefined, { timeout: 30_000 });
}

/** Seek the pane's video and wait for the frame there. */
async function seekTo(page: Page, time: number): Promise<void> {
  await page.evaluate(
    (t) =>
      new Promise<void>((done) => {
        const video = document.querySelector<HTMLVideoElement>('video[data-video-player]')!;
        video.addEventListener('seeked', () => done(), { once: true });
        video.currentTime = t;
      }),
    time,
  );
}

const currentTime = (page: Page) => page.evaluate(() => document.querySelector<HTMLVideoElement>('video[data-video-player]')!.currentTime);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-video-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(home);
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
  };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();

  // The film: Playwright records a page for about four seconds (VP8 WebM, with its length written at the end).
  const project = scratchProject(join(root, 'src'), 'launch-site');
  mkdirSync(join(project, 'film'));
  const recordings = join(root, 'recordings');
  const recorder = await browser.newContext({ viewport: { width: 640, height: 360 }, recordVideo: { dir: recordings, size: { width: 640, height: 360 } } });
  const recordingPage = await recorder.newPage();
  await recordingPage.setContent(FILM_PAGE);
  await recordingPage.waitForTimeout(4200);
  const video = recordingPage.video()!;
  await recorder.close();
  copyFileSync(await video.path(), join(project, 'film', 'launch-cut-v3.webm'));

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  const ranges: World['ranges'] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (/\/api\/inbox\/attachments\/[^/]+\/video$/.test(path)) ranges.push({ range: response.request().headers()['range'] ?? null, status: response.status() });
    if (response.status() >= 400 && response.status() !== 416) errors.push(`HTTP ${response.status()} ${path}`);
  });
  world = {
    dataDir,
    url,
    project,
    claude: await SimAgent.connect({ binary: builtBinary, env, name: 'Claude Code', host: 'claude-code' }),
    context,
    page,
    errors,
    ranges,
    threadId: '',
    filmId: '',
  };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.claude.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('an agent attaches a film: kind video, a tile that offers Play', async () => {
  const sent = await world.claude.send({
    project_path: world.project,
    subject: 'Launch film: a cut to review',
    body: 'The cut is rendered from the edit. Comment at the moments that need changes; I will re-cut from your notes.',
    attachments: ['film/launch-cut-v3.webm'],
  });
  const film = (sent.attachments as { id: string; kind: string; media_type?: string }[])[0]!;
  expect(film.kind).toBe('video');
  world.threadId = sent.thread_id as string;
  world.filmId = film.id;

  const page = world.page;
  await page.goto(`${world.url}#thread=${world.threadId}`);
  const tile = page.locator(`button[data-attachment-id="${film.id}"]`);
  await expect(tile).toHaveAttribute('data-attachment-kind', 'video');
  await expect(tile.locator('.ib-kd')).toHaveText(/^WebM video · /);
  await expect(tile.locator('.ib-open')).toHaveText('Play');
  await shot('1-thread-video-tile');
});

test('the film plays in the pane by HTTP Range; typing pauses it and pins the moment; Comment keeps the frame', async () => {
  const page = world.page;
  await page.locator(`button[data-attachment-id="${world.filmId}"]`).click();
  const pane = page.locator(`[data-attachment-pane="${world.filmId}"]`);
  await expect(pane.locator('video[data-video-player]')).toBeVisible();
  await videoReady(page);
  // Chromium's media loader asked for byte ranges and got 206s.
  await expect.poll(() => world.ranges.some((r) => r.status === 206 && r.range !== null)).toBe(true);
  await shot('2-player-beside-the-thread');

  await page.evaluate(() => document.querySelector<HTMLVideoElement>('video[data-video-player]')!.play());
  await page.waitForTimeout(500);
  await seekTo(page, 2.2);
  const box = pane.getByRole('textbox', { name: /^Comment on launch-cut-v3\.webm at / });
  await box.fill('The title holds too long here. Cut it to about a second.');
  // Typing paused the film, and the moment is pinned.
  expect(await page.evaluate(() => document.querySelector<HTMLVideoElement>('video[data-video-player]')!.paused)).toBe(true);
  const chip = pane.locator('[data-video-composer] [data-video-time]');
  await expect(chip).toHaveAttribute('data-pinned', '');
  await expect(chip).toHaveText('0:02');
  await expect(pane.locator('[data-video-frame] img')).toBeVisible();
  await expect(pane.locator('[data-video-draft-dot]')).toBeVisible();
  await shot('3-compose-at-a-moment');

  await pane.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(pane.locator('.ib-apanel')).toContainText('The title holds too long here');
  await expect(pane.locator('.ib-apanel [data-video-card-time]')).toHaveText('0:02');
  await expect(pane.locator('[data-video-dot]')).toHaveCount(1);
  // The comment row is clear and follows the film again.
  await expect(chip).not.toHaveAttribute('data-pinned', '');
  await shot('4-comment-listed-by-time');
});

test('a dot on the rail and the panel time pill seek back to the comment', async () => {
  const page = world.page;
  const pane = page.locator(`[data-attachment-pane="${world.filmId}"]`);
  await seekTo(page, 0.3);
  await pane.locator('[data-video-dot]').click();
  await expect.poll(() => currentTime(page)).toBeGreaterThan(2.1);
  expect(await currentTime(page)).toBeLessThan(2.4);
  await seekTo(page, 3.5);
  await pane.locator('.ib-apanel [data-video-card-time]').click();
  await expect.poll(() => currentTime(page)).toBeLessThan(2.4);
  await shot('5-seeked-to-the-comment');
});

test('Mark up draws on the paused frame; the marked-up copy rides the comment, listed by time', async () => {
  const page = world.page;
  const pane = page.locator(`[data-attachment-pane="${world.filmId}"]`);
  await seekTo(page, 3.4);
  await pane.locator('[data-video-composer] [data-markup-open]').click();
  const stage = page.locator('[data-pn-image-annotator-stage] canvas').first();
  await expect(stage).toBeVisible();
  const box = (await stage.boundingBox())!;
  await page.locator('[data-pn-image-annotator-toolbar] button[title="Circle (3)"]').click();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await shot('6-mark-up-the-frame');
  await page.keyboard.press('Enter');
  await expect(pane.locator('[data-video-frame] .ib-vpen')).toBeVisible();
  await expect(pane.locator('[data-video-composer] [data-video-time]')).toHaveText('0:03');
  await pane.getByRole('textbox', { name: /^Comment on launch-cut-v3\.webm at / }).fill('The counter jumps here; hold the colour change.');
  await pane.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(pane.locator('.ib-apanel [data-video-card-time]')).toHaveText(['0:02', '0:03']);
  await expect(pane.locator('[data-video-dot]')).toHaveCount(2);
  await shot('7-two-comments-by-time');
});

test('Send carries the moment and the frame; the agent reads both', async () => {
  const page = world.page;
  await page.locator('[data-attachment-pane]').getByRole('button', { name: /^Close / }).click();
  const waiting = world.claude.waitForReply(world.threadId, 40);
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Edit the reply' }).click();
  await page.getByRole('textbox', { name: 'Reply to Claude Code' }).fill('One note on the cut.');
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  const reply = await waiting;
  expect(reply.status).toBe('replied');
  const body = (reply.reply as { body: string }).body;
  expect(body).toContain('## film/launch-cut-v3.webm');
  expect(body).toMatch(/Feedback on: "launch-cut-v3\.webm at 0:02"\nAt 0:02 \(2\.2 s\)\n> The title holds too long here/);
  const frame = /- \[launch-cut-v3 at 0:02\] `([^`]+)`/.exec(body);
  expect(frame).not.toBeNull();
  // The agent can Read the frame: a real JPEG in the Inbox's markups.
  expect(frame![1]!.startsWith(join(world.dataDir, 'inbox', 'markups'))).toBe(true);
  expect([...readFileSync(frame![1]!).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  // The second comment, after the first by time, with the marked-up copy (a PNG).
  expect(body).toMatch(/### 2\. Feedback on: "launch-cut-v3\.webm at 0:03"\nAt 0:03 \(3\.4 s\)\n> The counter jumps here/);
  const marked = /- \[launch-cut-v3 at 0:03, marked up\] `([^`]+)`/.exec(body);
  expect(marked).not.toBeNull();
  expect(readFileSync(marked![1]!).subarray(1, 4).toString()).toBe('PNG');
  expect(world.errors).toEqual([]);
});

test('on a phone: the film on top, the comments under the rail, and "Comment at" opens the row', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' });
  const page = await context.newPage();
  try {
    const sent = await world.claude.send({ project_path: world.project, subject: 'The cut, again', body: 'One more look.', attachments: ['film/launch-cut-v3.webm'] });
    const film = (sent.attachments as { id: string }[])[0]!;
    await page.goto(`${world.url}#thread=${sent.thread_id}&file=${film.id}`);
    const pane = page.locator(`[data-attachment-pane="${film.id}"]`);
    await expect(pane.locator('video[data-video-player]')).toBeVisible();
    await videoReady(page);
    await expect(pane.locator('[data-video-meta]')).toContainText('0 comments');
    await shot('8-phone-player', page);
    await pane.locator('[data-video-compose]').click();
    await expect(pane.locator('[data-video-composer] textarea')).toBeFocused();
    await shot('9-phone-compose', page);
  } finally {
    await context.close();
  }
});
