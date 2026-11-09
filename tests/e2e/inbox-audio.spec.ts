/**
 * Audio attachments (the owner's ask, 2026-11-09: "the ability to like
 * annotate an audio file … right now audio file is just download instead of
 * play"), proved in a real browser against the compiled binary. Nothing is
 * mocked: `plannotator inbox --background` runs under a temp
 * PLANNOTATOR_DATA_DIR and HOME; the recording is made in the test (a 2-second
 * 8 kHz PCM WAV of about 16 KB, tests/helpers/audio-fixtures.ts; no binary is
 * committed); an agent attaches it through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts); Chromium drives the window.
 *
 * Proves: the recording is kind `audio` with its length, and its tile offers
 * Play; it plays in the pane's player card from the `audio` route by HTTP
 * Range, with its waveform drawn from the decoded file; typing pauses it and
 * pins the moment; Comment lists the comment with its time and puts a dot on
 * the bar, which seeks back to it; Send carries "At 0:01 (1.2 s of 0:02)"
 * with no frame, read back by the agent; and on a phone the row sits in full
 * screen's composer, where a tap in the field pins the moment.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-audio.spec.ts`.
 * PNGs land in PLANNOTATOR_E2E_SHOTS_DIR (default .local/proof/audio).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { wav } from '../helpers/audio-fixtures';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/audio'));

interface World {
  url: string;
  project: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  ranges: { range: string | null; status: number }[];
  threadId: string;
  noteId: string;
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

/** The pane's audio element, once it has its metadata. */
async function audioReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const audio = document.querySelector<HTMLAudioElement>('audio[data-video-player]');
    return !!audio && audio.readyState >= 1 && Number.isFinite(audio.duration) && audio.duration > 0;
  }, undefined, { timeout: 30_000 });
}

/** Seek the pane's recording and wait until it is there. */
async function seekTo(page: Page, time: number): Promise<void> {
  await page.evaluate(
    (t) =>
      new Promise<void>((done) => {
        const audio = document.querySelector<HTMLAudioElement>('audio[data-video-player]')!;
        audio.addEventListener('seeked', () => done(), { once: true });
        audio.currentTime = t;
      }),
    time,
  );
}

const currentTime = (page: Page) => page.evaluate(() => document.querySelector<HTMLAudioElement>('audio[data-video-player]')!.currentTime);
const isPaused = (page: Page) => page.evaluate(() => document.querySelector<HTMLAudioElement>('audio[data-video-player]')!.paused);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-audio-');
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

  const project = scratchProject(join(root, 'src'), 'launch-site');
  mkdirSync(join(project, 'audio'));
  writeFileSync(join(project, 'audio', 'voice-note.wav'), wav({ seconds: 2, rate: 8000 }));

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  const ranges: World['ranges'] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (/\/api\/inbox\/attachments\/[^/]+\/audio$/.test(path)) ranges.push({ range: response.request().headers()['range'] ?? null, status: response.status() });
    if (response.status() >= 400 && response.status() !== 416) errors.push(`HTTP ${response.status()} ${path}`);
  });
  world = {
    url,
    project,
    claude: await SimAgent.connect({ binary: builtBinary, env, name: 'Claude Code', host: 'claude-code' }),
    context,
    page,
    errors,
    ranges,
    threadId: '',
    noteId: '',
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

test('an agent attaches a recording: kind audio with its length, a tile that offers Play', async () => {
  const sent = await world.claude.send({
    project_path: world.project,
    subject: 'Voice-over: take 2',
    body: 'The second take of the voice-over. Comment at the moments that need another read.',
    attachments: ['audio/voice-note.wav'],
  });
  const note = (sent.attachments as { id: string; kind: string }[])[0]!;
  expect(note.kind).toBe('audio');
  world.threadId = sent.thread_id as string;
  world.noteId = note.id;

  const page = world.page;
  await page.goto(`${world.url}#thread=${world.threadId}`);
  const tile = page.locator(`button[data-attachment-id="${note.id}"]`);
  await expect(tile).toHaveAttribute('data-attachment-kind', 'audio');
  await expect(tile.locator('.ib-kd')).toHaveText(/^WAV audio · 0:02 · /);
  await expect(tile.locator('.ib-open')).toHaveText('Play');
  await shot('1-thread-audio-tile');
});

test('it plays in the pane by HTTP Range, with its waveform; typing pauses it and pins the moment; Comment puts a dot on the bar', async () => {
  const page = world.page;
  await page.locator(`button[data-attachment-id="${world.noteId}"]`).click();
  const pane = page.locator(`[data-attachment-pane="${world.noteId}"]`);
  await expect(pane.locator('[data-audio-player]')).toBeVisible();
  await audioReady(page);
  // The waveform: the recording decoded in the window, drawn as bars.
  await expect(pane.locator('[data-audio-scrub][data-waveform] rect').first()).toBeAttached();
  // Chromium's media loader asked for a byte range and got a 206.
  await expect.poll(() => world.ranges.some((r) => r.status === 206 && r.range !== null)).toBe(true);

  const play = pane.locator('[data-audio-play]');
  await play.click();
  await expect(play).toHaveAttribute('aria-label', 'Pause');
  await expect.poll(() => currentTime(page), { timeout: 10_000 }).toBeGreaterThan(0.2);
  await shot('2-playing-beside-the-thread');

  await seekTo(page, 1.2);
  const box = pane.getByRole('textbox', { name: /^Comment on voice-note\.wav at / });
  await box.fill('Breathe before "three steps"; the word is clipped.');
  expect(await isPaused(page)).toBe(true);
  await expect(play).toHaveAttribute('aria-label', 'Play');
  const chip = pane.locator('[data-video-composer] [data-video-time]');
  await expect(chip).toHaveAttribute('data-pinned', '');
  await expect(chip).toHaveText('0:01');
  // A recording has no frame and nothing to draw on.
  await expect(pane.locator('[data-video-frame]')).toHaveCount(0);
  await expect(pane.locator('[data-markup-open]')).toHaveCount(0);
  await expect(pane.locator('[data-video-draft-dot]')).toBeVisible();
  await shot('3-compose-at-a-moment');

  await pane.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(pane.locator('.ib-apanel')).toContainText('the word is clipped');
  await expect(pane.locator('.ib-apanel [data-video-card-time]')).toHaveText('0:01');
  await expect(pane.locator('[data-video-dot]')).toHaveCount(1);
  await expect(chip).not.toHaveAttribute('data-pinned', '');
  await shot('4-marker-on-the-bar');
});

test('the dot on the bar and the panel time pill seek back to the comment; a press on the bar seeks', async () => {
  const page = world.page;
  const pane = page.locator(`[data-attachment-pane="${world.noteId}"]`);
  await seekTo(page, 0.1);
  await pane.locator('[data-video-dot]').click();
  await expect.poll(() => currentTime(page)).toBeGreaterThan(1.1);
  expect(await currentTime(page)).toBeLessThan(1.3);
  // A press near the end of the bar.
  const bar = (await pane.locator('[data-audio-scrub]').boundingBox())!;
  await page.mouse.click(bar.x + bar.width * 0.9, bar.y + bar.height / 2);
  await expect.poll(() => currentTime(page)).toBeGreaterThan(1.6);
  await pane.locator('.ib-apanel [data-video-card-time]').click();
  await expect.poll(() => currentTime(page)).toBeLessThan(1.3);
});

test("a narrow tile's line drops whole parts and never cuts one: the length and the comment count stay", async () => {
  const page = world.page;
  const tiles = page.locator('section.ib-pane .ib-attachments:not(.ib-hatts-tiles) .ib-tiles');
  const line = tiles.locator(`button[data-attachment-id="${world.noteId}"] .ib-kd`);
  await expect(line).toHaveText(/^WAV audio · 0:02 · 1 comment · [\d.]+ KB$/);
  // Each part of the line at this width: drawn whole ('whole'), out of sight ('gone'), or cut ('cut').
  const partsAt = (width: number) =>
    tiles.evaluate((grid, width) => {
      (grid.firstElementChild as HTMLElement).style.width = `${width}px`;
      const line = grid.querySelector('.ib-kd')!;
      const box = line.getBoundingClientRect();
      const parts = Array.from(line.querySelectorAll('span')).filter((part) => part.children.length === 0);
      return parts.map((part) => {
        const half = part.parentElement!.getBoundingClientRect();
        const r = part.getBoundingClientRect();
        const [left, right, bottom] = [Math.max(box.left, half.left), Math.min(box.right, half.right), Math.min(box.bottom, half.bottom)];
        if (r.top >= bottom - 1 || r.left >= right - 0.5) return 'gone';
        return r.left >= left - 0.5 && r.right <= right + 0.5 && r.bottom <= bottom + 0.5 && part.scrollWidth <= Math.ceil(r.width) ? 'whole' : 'cut';
      });
    }, width);
  try {
    const seen = new Set<string>();
    // From a tile wide enough for the whole line down to one that holds only the length and the count.
    for (let width = 560; width >= 300 && !seen.has('gone gone'); width -= 4) {
      const [kind, length, count, size] = await partsAt(width);
      expect([kind, size], `at ${width}px`).not.toContain('cut');
      expect([length, count], `at ${width}px`).toEqual(['whole', 'whole']);
      seen.add(`${kind} ${size}`);
    }
    // The size goes first, then the kind: never the kind while the size still shows.
    expect([...seen].sort()).toEqual(['gone gone', 'whole gone', 'whole whole']);
  } finally {
    await tiles.evaluate((grid) => (grid.firstElementChild as HTMLElement).style.removeProperty('width'));
  }
});

test('Send carries the moment; the agent reads it, with no frame', async () => {
  const page = world.page;
  await page.locator('[data-attachment-pane]').getByRole('button', { name: /^Close / }).click();
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Edit draft' }).click();
  await page.getByRole('textbox', { name: 'Reply to Claude Code' }).fill('One note on the take.');
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  const reply = await world.claude.nextReply(world.threadId, 40);
  const body = reply.body as string;
  expect(body).toContain('## audio/voice-note.wav');
  expect(body).toMatch(/Feedback on: "voice-note\.wav at 0:01"\nAt 0:01 \(1\.2 s of 0:02\)\n> Breathe before "three steps"; the word is clipped\./);
  expect(body).not.toContain('voice-note at 0:01]');
  expect(world.errors).toEqual([]);
});

test("on a phone: the player card on top, and the comment row in full screen's composer", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' });
  const page = await context.newPage();
  try {
    const sent = await world.claude.send({ project_path: world.project, subject: 'Take 3', body: 'One more read.', attachments: ['audio/voice-note.wav'] });
    const note = (sent.attachments as { id: string }[])[0]!;
    await page.goto(`${world.url}#thread=${sent.thread_id}&file=${note.id}`);
    const pane = page.locator(`[data-attachment-pane="${note.id}"]`);
    await expect(pane.locator('[data-audio-player]')).toBeVisible();
    await audioReady(page);
    await expect(pane.locator('[data-video-meta]')).toContainText('0 comments');
    // The play button is a 44 px target.
    const play = (await pane.locator('[data-audio-play]').boundingBox())!;
    expect(play.width).toBeGreaterThanOrEqual(44);
    expect(play.height).toBeGreaterThanOrEqual(44);
    await shot('5-phone-player', page);
    await expect(pane.locator('[data-fcomp] [role="radio"][data-fcomp-mode="comment"]')).toHaveAttribute('aria-checked', 'true');
    await seekTo(page, 1.5);
    const field = pane.locator('[data-fcomp] [data-video-composer] textarea');
    await field.tap();
    await expect(field).toBeFocused();
    const chip = pane.locator('[data-fcomp] [data-video-composer] [data-video-time]');
    await expect(chip).toHaveAttribute('data-pinned', '');
    await expect(chip).toHaveText('0:01');
    await field.fill('Softer here.');
    await shot('6-phone-compose', page);
    await pane.locator('[data-fcomp] [data-video-comment-save]').tap();
    await expect(pane.locator('[data-video-meta]')).toContainText('1 comment');
    await expect(pane.locator('[data-video-dot]')).toHaveCount(1);
    await shot('7-phone-marker', page);
  } finally {
    await context.close();
  }
});
