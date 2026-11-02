/**
 * Voice dictation (approval "inbox-voice", 2026-10-31) in a real Chromium, recording from Chromium's fake capture
 * device through the real AudioWorklet (served from the Inbox's own origin, under the real CSP), against a real Inbox
 * with a fake `codex` and a fake of both OpenAI endpoints (tests/e2e/voice-inbox.ts). No real Codex, no OpenAI.
 *
 *  - Off: no mic anywhere, no Codex started. Settings turns it on, and it lands between Machines and Capabilities.
 *  - Hold and tap: words land at the cursor, in one piece, with the wash; Send is off meanwhile; nothing ever sends by
 *    itself, not even Mod+Enter while it runs.
 *  - Cancel, and Esc while running: nothing posted, the box stays open. Esc at rest still closes the box.
 *  - Failures: a 403 and a challenge page post once and stop; Retry is a press, and resends the same clip; a network
 *    failure keeps the clip; an expired login says so; not signed in dims the mic with a line and a link.
 *  - Phones only uses the touch query: no mic on a narrow desktop window, a mic on a touch screen.
 *  - A hold ends where the pointer comes up, on the button or off it, with one transcription. Cancel stays on screen,
 *    and a touch the system takes away ends the take with nothing sent.
 *  - Reply box, compose, and full screen's composer.
 *  - New message dictates as the reply box does, in Chromium and in WebKit (WebKit has no fake capture device, so a tone
 *    through a real MediaStream stands in for the microphone), at 320 to 390 px, the keyboard a stand-in: the mic at the
 *    row's right end and still when it starts, the level drawn and moving, nothing over the clock. Words land where they
 *    did; Cancel and the draft question leave no microphone open; To ends a take and keeps its words; a save waits for
 *    a take on its way. On a desktop Save draft stays put when listening starts.
 *  - The announcement: once, on a computer with a ChatGPT login only, its Phones only option saved by Turn on voice.
 *  - A file or the artifacts opening over the box closes the microphone.
 *
 * Build the apps first (bun run --cwd apps/review build && bun run build:hook), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-voice.spec.ts`. PNGs land in
 * PLANNOTATOR_E2E_SHOTS_DIR, or .local/proof/inbox-voice.
 */
import { chromium, devices, expect, test, webkit, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/inbox-voice'));
const html = join(repo, 'apps/hook/dist/inbox.html');
const CHATGPT_LOGIN = { account: { type: 'chatgpt', email: 'someone@example.com', planType: 'pro' }, authMethod: 'chatgpt', token: 'fake-token', refreshedToken: 'fake-token-2' };

interface World {
  root: string;
  dataDir: string;
  url: string;
  threads: string[];
  filed: { thread: string; attachment: string | null };
  send(command: Record<string, unknown>): void;
  upstreamCalls(): { path: string; bytes: number; riff: string; rate: number; model: string | null; userAgent: string }[];
  codexStarts(): number;
  stop(): Promise<void>;
}

const worlds: World[] = [];
let scratch = '';

/** Bursts of a voiced tone at the level of speech: the gate's business, and Chromium's noise suppression leaves it. */
function speechWav(path: string, seconds: number, loud: boolean) {
  const rate = 48_000;
  const samples = new Int16Array(rate * seconds);
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate;
    if (!loud) {
      samples[i] = (Math.random() - 0.5) * 6;
      continue;
    }
    const envelope = Math.max(0, Math.sin(2 * Math.PI * 2.5 * t)) ** 0.5;
    const voice = Math.sin(2 * Math.PI * 170 * t) + 0.6 * Math.sin(2 * Math.PI * 340 * t) + 0.4 * Math.sin(2 * Math.PI * 720 * t) + 0.2 * Math.sin(2 * Math.PI * 1500 * t);
    samples[i] = Math.max(-1, Math.min(1, envelope * voice * 0.35)) * 32767;
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.byteLength, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.from(samples.buffer)]));
}

async function startWorld(options: { version?: string; config?: Record<string, unknown>; used?: boolean; fresh?: boolean; codex?: Record<string, unknown> | null } = {}): Promise<World> {
  const root = join(scratch, `world-${worlds.length}`);
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  if (options.used) writeFileSync(join(dataDir, 'update-state.json'), JSON.stringify({ inboxVersion: '0.29.0' }));
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({
      inboxTour: { version: 2, seen_at: '2026-10-01T10:00:00.000Z', skipped_at: '2026-10-01T10:00:00.000Z' },
      // A notification setting means someone used an Inbox here (inboxUsedBefore).
      ...(options.fresh ? {} : { inboxNotifications: { dismissed: true } }),
      inboxAgentNotes: { offered: true },
      inboxSound: { dialogShownFor: '0.29.0' },
      inboxListIntro: { shownAt: '2026-10-01T10:00:00.000Z' },
      ...options.config,
    }),
  );
  const child: ChildProcessWithoutNullStreams = spawn('bun', [join(repo, 'tests/e2e/voice-inbox.ts'), root, JSON.stringify({ html, version: options.version, codex: options.codex })], {
    cwd: repo,
    env: { PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? '/tmp', HOME: join(root, 'home'), PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_PHONES: '0' },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  const first = await new Promise<string>((done, fail) => {
    createInterface({ input: child.stdout }).once('line', done);
    child.once('exit', () => fail(new Error(`voice-inbox.ts exited: ${stderr}`)));
  });
  const started = JSON.parse(first) as { url: string; threads: string[]; filed: World['filed'] };
  const read = (name: string) => {
    const path = join(root, name);
    return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  };
  const world: World = {
    root,
    dataDir,
    ...started,
    send: (command) => child.stdin.write(`${JSON.stringify(command)}\n`),
    upstreamCalls: () => read('upstream.jsonl'),
    codexStarts: () => read('bin/calls.jsonl').filter((call: { event: string }) => call.event === 'start').length,
    stop: () =>
      new Promise((done) => {
        child.once('exit', () => done());
        child.stdin.write('{"stop":true}\n');
      }),
  };
  worlds.push(world);
  return world;
}

let main: World | null = null;
/** The world most tests share, voice on. */
async function mainWorld(): Promise<World> {
  if (!main) {
    main = await startWorld();
    await turnOn(main);
  }
  return main;
}

const saved = (w: World) => JSON.parse(readFileSync(join(w.dataDir, 'config.json'), 'utf8')) as { inboxVoice?: { on?: boolean; phonesOnly?: boolean }; inboxVoiceIntro?: { shownAt?: string } };

let speech: Browser;
let silence: Browser;

async function open(browser: Browser, w: World, options: { phone?: boolean; grant?: boolean; viewport?: { width: number; height: number } } = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: options.viewport ?? (options.phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }),
    ...(options.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  if (options.grant !== false) await context.grantPermissions(['microphone'], { origin: new URL(w.url).origin });
  return { context, page: await context.newPage() };
}

async function turnOn(w: World, change: Record<string, unknown> = {}) {
  const settings = (await (await fetch(new URL('/api/inbox/settings', w.url))).json()) as { serverSession: string };
  const answer = await fetch(new URL('/api/inbox/settings', w.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(w.url).origin },
    body: JSON.stringify({ serverSession: settings.serverSession, voice: { on: true, ...change } }),
  });
  expect(answer.status).toBe(200);
}

const pane = (page: Page) => page.locator('section.ib-pane');
const mic = (scope: Page | Locator) => scope.locator('[data-voice-mic]');
const line = (scope: Page | Locator, state: string) => scope.locator(`[data-voice-line="${state}"]`);
const note = (scope: Page | Locator, trouble: string) => scope.locator(`[data-voice-note="${trouble}"]`);
const sendButton = (page: Page) => pane(page).locator('.ib-acts .ib-btn.ib-pri');

async function openReply(page: Page, w: World, thread: string): Promise<Locator> {
  await page.goto(`${w.url}#thread=${thread}`);
  const box = pane(page).locator('.ib-rbox textarea');
  const button = page.locator('.ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)$/ });
  for (let attempt = 0; attempt < 20 && !(await box.isVisible()); attempt += 1) await button.click({ timeout: 1_000 }).catch(() => {});
  await expect(box).toBeVisible();
  await box.focus();
  return box;
}

async function press(page: Page, target: Locator) {
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}

/** Hold the button through some speech. */
async function hold(page: Page, ms = 1500) {
  await press(page, mic(pane(page)));
  await expect(line(pane(page), 'hold')).toBeVisible();
  await page.waitForTimeout(ms);
}

const consoleErrors = (page: Page) => {
  const seen: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|worklet/i.test(message.text())) seen.push(message.text());
  });
  return seen;
};

const shot = async (page: Page, name: string) => {
  mkdirSync(shotsDir, { recursive: true });
  // Past the button's color fade, so a screen shows the state and not the way into it.
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
};

test.beforeAll(async () => {
  expect(existsSync(html), 'build the apps first').toBe(true);
  scratch = inboxScratch('plannotator-inbox-voice-');
  speechWav(join(scratch, 'speech.wav'), 40, true);
  speechWav(join(scratch, 'silence.wav'), 40, false);
  const launch = (file: string) =>
    chromium.launch({ args: ['--use-mock-keychain', '--password-store=basic', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${join(scratch, file)}`] });
  speech = await launch('speech.wav');
  silence = await launch('silence.wav');
});

test.afterAll(async () => {
  try {
    await speech?.close();
    await silence?.close();
    await Promise.all(worlds.map((w) => w.stop()));
  } finally {
    await removeInboxScratch();
  }
});

test('off: no mic in any composer and no Codex started; Settings turns it on between Machines and Capabilities', async () => {
  const w = await startWorld();
  const { context, page } = await open(speech, w);
  await openReply(page, w, w.threads[0]!);
  await expect(page.locator('[data-voice-foot]')).toHaveCount(0);
  await page.locator('.ib-side [data-open-compose]').click();
  await expect(page.locator('dialog[data-compose] textarea')).toBeVisible();
  await expect(page.locator('[data-voice-mic]')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.goto(`${w.url}#settings/voice`);
  const section = page.locator('[data-settings-voice]');
  await expect(section).toBeVisible();
  await expect(section).toContainText('Nothing runs while this is off.');
  expect(w.codexStarts()).toBe(0);
  await shot(page, 'settings-off');

  await section.getByRole('switch', { name: 'Voice' }).click();
  await expect(page.locator('[data-voice-status="ready"]')).toContainText('Signed in with ChatGPT');
  await expect(page.locator('[data-voice-status="ready"]')).toContainText('Pro plan');
  await expect(page.locator('main.ib-main')).toContainText('OpenAI’s terms for your ChatGPT account apply.');
  expect(saved(w).inboxVoice?.on).toBe(true);
  await shot(page, 'settings');

  // A reload keeps it, and the mic is there.
  await openReply(page, w, w.threads[0]!);
  await expect(mic(pane(page))).toBeVisible();
  await context.close();
});

test('a hold: words land at the cursor, Send waits, nothing sends itself', async () => {
  const w = await mainWorld();
  const { context, page } = await open(speech, w);
  const errors = consoleErrors(page);
  const box = await openReply(page, w, w.threads[1]!);
  await box.fill('Cards. and more');
  await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 6));
  await expect(sendButton(page)).toBeEnabled();

  w.send({ upstream: [{ text: 'Keep the totals.', hold: true }] });
  await hold(page);
  await expect(sendButton(page)).toBeDisabled();
  await expect(line(pane(page), 'hold')).toContainText('Esc cancels');
  await shot(page, 'listening');
  // Mod+Enter is a send everywhere else.
  await box.press('Meta+Enter');
  await box.press('Control+Enter');
  await page.mouse.up();

  await expect(line(pane(page), 'sending')).toBeVisible();
  await expect(sendButton(page)).toBeDisabled();
  await expect(pane(page).locator('.ib-vcaret.ib-vstill')).toBeVisible();
  await expect(box).toHaveValue('Cards. and more');
  await shot(page, 'transcribing');
  w.send({ release: true });

  await expect(box).toHaveValue('Cards. Keep the totals. and more');
  await expect(pane(page).locator('mark.ib-vmark')).toHaveText(/Keep the totals\./);
  await expect(sendButton(page)).toBeEnabled();
  await shot(page, 'landed');
  await expect(pane(page).locator('mark.ib-vmark')).toHaveCount(0, { timeout: 5_000 });

  // One undo step, as if typed.
  await box.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(box).toHaveValue('Cards. and more');

  const calls = w.upstreamCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ path: '/backend-api/transcribe', riff: 'RIFF', rate: 24_000 });
  expect(calls[0]!.bytes).toBeGreaterThan(24_000);
  expect(calls[0]!.userAgent).toMatch(/^Plannotator\//);
  // Nothing went: the thread still has no reply from the person.
  await expect(pane(page).locator('.ib-rbox')).toBeVisible();
  const { thread } = (await (await fetch(new URL(`/api/inbox/threads/${w.threads[1]}`, w.url))).json()) as { thread: { messages: { author: { kind: string } }[] } };
  expect(thread.messages.filter((message) => message.author.kind !== 'agent')).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});

test('a tap: runs with no finger on it, Cancel is there, a second tap stops it', async () => {
  const w = await mainWorld();
  const { context, page } = await open(speech, w);
  const box = await openReply(page, w, w.threads[2]!);
  const before = w.upstreamCalls().length;
  await box.fill('Start: ');
  await mic(pane(page)).click();
  await expect(line(pane(page), 'tap')).toBeVisible();
  await expect(mic(pane(page))).toHaveAttribute('aria-label', 'Stop dictating');

  await page.locator('[data-voice-cancel]').click();
  await expect(line(pane(page), 'tap')).toHaveCount(0);
  await expect(mic(pane(page))).toHaveAttribute('data-state', 'idle');
  await expect(box).toHaveValue('Start: ');
  expect(w.upstreamCalls()).toHaveLength(before);

  w.send({ upstream: [{ text: 'Second take.' }] });
  await mic(pane(page)).click();
  await expect(line(pane(page), 'tap')).toBeVisible();
  await page.waitForTimeout(1500);
  await mic(pane(page)).click();
  await expect(box).toHaveValue('Start: Second take.');
  await context.close();
});

test('the keyboard: Space on the focused button toggles, with no new shortcut', async () => {
  const w = await mainWorld();
  const { context, page } = await open(speech, w);
  const box = await openReply(page, w, w.threads[2]!);
  await box.fill('');
  await mic(pane(page)).focus();
  await page.keyboard.press('Space');
  await expect(line(pane(page), 'tap')).toBeVisible();
  await expect(mic(pane(page))).toBeFocused();
  await page.waitForTimeout(1200);
  await page.keyboard.press('Space');
  await expect(box).toHaveValue('Second take.');
  await context.close();
});

test('Esc: cancels only what runs, in the reply box and in compose; at rest it is the box’s as ever', async () => {
  const w = await mainWorld();
  const { context, page } = await open(speech, w);
  const box = await openReply(page, w, w.threads[3]!);
  await box.fill('Kept words');
  const before = w.upstreamCalls().length;

  await hold(page, 600);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(box).toBeVisible();
  await expect(box).toHaveValue('Kept words');
  await expect(mic(pane(page))).toHaveAttribute('data-state', 'idle');
  expect(w.upstreamCalls()).toHaveLength(before);

  w.send({ upstream: [{ text: 'Never lands.', hold: true }] });
  await hold(page, 800);
  await page.mouse.up();
  await expect(line(pane(page), 'sending')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(line(pane(page), 'sending')).toHaveCount(0);
  w.send({ release: true });
  await page.waitForTimeout(300);
  await expect(box).toHaveValue('Kept words');
  await expect(box).toBeVisible();

  // Compose: the dialog stays, and it does not ask about a draft.
  await page.locator('.ib-side [data-open-compose]').click();
  const dialog = page.locator('dialog[data-compose]');
  await expect(mic(dialog)).toBeVisible();
  await mic(dialog).click();
  await expect(line(dialog, 'tap')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(line(dialog, 'tap')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-compose-keep]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await context.close();
});

test('compose: the words land, and Send waits', async () => {
  const w = await mainWorld();
  const { context, page } = await open(speech, w);
  await page.goto(w.url);
  await page.locator('.ib-side [data-open-compose]').click();
  const dialog = page.locator('dialog[data-compose]');
  w.send({ upstream: [{ text: 'A new idea.', hold: true }] });
  await mic(dialog).click();
  await expect(line(dialog, 'tap')).toBeVisible();
  await expect(dialog.locator('[data-compose-send]')).toBeDisabled();
  await page.waitForTimeout(1200);
  await mic(dialog).click();
  await expect(line(dialog, 'sending')).toBeVisible();
  await shot(page, 'compose-transcribing');
  w.send({ release: true });
  await expect(dialog.locator('textarea')).toHaveValue('A new idea.');
  // The real `disabled` is voice's. This world has no agent to send to, so the button stays aria-disabled for that.
  await expect(dialog.locator('[data-compose-send]')).toHaveJSProperty('disabled', false);
  await context.close();
});

test('full screen’s composer: the words land in the reply', async () => {
  const w = await mainWorld();
  const { context, page } = await open(speech, w);
  await page.goto(`${w.url}#thread=${w.filed.thread}&file=${w.filed.attachment}&view=full`);
  const card = page.locator('[data-fcomp]');
  await expect(card).toBeVisible();
  await card.getByRole('radio', { name: 'Reply to Claude Code' }).click();
  const field = card.locator('[data-fcomp-field] textarea');
  await expect(field).toBeFocused();
  w.send({ upstream: [{ text: 'Looks right.' }] });
  await mic(card).click();
  await expect(line(card, 'tap')).toBeVisible();
  await expect(card.locator('[data-fcomp-send]')).toBeDisabled();
  // The card is narrow: the clock, the button and Open in thread each keep their own room.
  const [clock, button, link] = await Promise.all(['.ib-dttime', '[data-voice-mic]', '[data-fcomp-open-thread]'].map((part) => card.locator(part).boundingBox()));
  expect(clock!.x + clock!.width).toBeLessThanOrEqual(button!.x);
  expect(button!.x + button!.width).toBeLessThanOrEqual(link!.x);
  await page.waitForTimeout(1200);
  await shot(page, 'fullscreen-listening');
  await mic(card).click();
  await expect(field).toHaveValue('Looks right.');
  await context.close();
});

/** The microphone itself, not the window's idea of it: answers how many of its tracks are open. */
async function watchMic(page: Page): Promise<() => Promise<number>> {
  await page.addInitScript(() => {
    const media = navigator.mediaDevices;
    const real = media.getUserMedia.bind(media);
    const streams: MediaStream[] = [];
    (window as unknown as { micStreams: MediaStream[] }).micStreams = streams;
    media.getUserMedia = async (constraints) => {
      const stream = await real(constraints);
      streams.push(stream);
      return stream;
    };
  });
  return () => page.evaluate(() => (window as unknown as { micStreams: MediaStream[] }).micStreams.flatMap((stream) => stream.getTracks()).filter((track) => track.readyState === 'live').length);
}

test('a file or the artifacts over the box: the mic closes and nothing is posted', async () => {
  const w = await mainWorld();
  const { context, page } = await open(speech, w);
  const open_ = await watchMic(page);
  const posts = w.upstreamCalls().length;
  for (const cover of [`#thread=${w.filed.thread}&file=${w.filed.attachment}&view=full`, `#thread=${w.filed.thread}&artifacts`]) {
    await openReply(page, w, w.filed.thread);
    await mic(pane(page)).click();
    await expect(line(pane(page), 'tap')).toBeVisible();
    await expect.poll(open_).toBe(1);
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, cover);
    await expect.poll(open_).toBe(0);
  }
  await openReply(page, w, w.filed.thread);
  await expect(line(pane(page), 'tap')).toHaveCount(0);
  expect(w.upstreamCalls()).toHaveLength(posts);
  await context.close();
});

test('a 403 and a challenge page: posted once, the drawn line, and only a press retries the same clip', async () => {
  const w = await mainWorld();
  const { context, page } = await open(speech, w);
  const box = await openReply(page, w, w.threads[4]!);
  await box.fill('');
  const before = w.upstreamCalls().length;
  w.send({ upstream: [{ status: 403 }, { html: true }, { text: 'Third time.' }] });
  await hold(page, 900);
  await page.mouse.up();
  const refused = note(pane(page), 'refused');
  await expect(refused).toContainText('ChatGPT turned this clip down');
  await shot(page, 'failure-refused');
  await page.waitForTimeout(1200);
  expect(w.upstreamCalls()).toHaveLength(before + 1);
  await expect(sendButton(page)).toBeEnabled();

  await refused.locator('[data-voice-retry]').click();
  await expect(note(pane(page), 'refused')).toBeVisible();
  await expect.poll(() => w.upstreamCalls().length).toBe(before + 2);
  await note(pane(page), 'refused').locator('[data-voice-retry]').click();
  await expect(box).toHaveValue('Third time.');
  const calls = w.upstreamCalls();
  expect(calls).toHaveLength(before + 3);
  expect(new Set(calls.slice(before).map((call) => call.bytes)).size).toBe(1);
  await context.close();
});

test('the network: the clip is kept, Discard drops it; an expired login says what to run', async () => {
  const w = await mainWorld();
  const { context, page } = await open(speech, w);
  const box = await openReply(page, w, w.threads[4]!);
  await box.fill('');
  w.send({ upstream: [{ status: 503 }] });
  await hold(page, 900);
  await page.mouse.up();
  const offline = note(pane(page), 'offline');
  await expect(offline).toContainText('Your clip is kept until you close this box.');
  await offline.locator('[data-voice-discard]').click();
  await expect(note(pane(page), 'offline')).toHaveCount(0);

  w.send({ upstream: [{ status: 401 }] });
  await hold(page, 900);
  await page.mouse.up();
  await expect(note(pane(page), 'expired')).toContainText('codex login');
  await context.close();
});

test('no voice heard: says so, then posts nothing', async () => {
  const w = await mainWorld();
  const { context, page } = await open(silence, w);
  const box = await openReply(page, w, w.threads[5]!);
  await box.fill('');
  const before = w.upstreamCalls().length;
  await press(page, mic(pane(page)));
  await expect(line(pane(page), 'quiet')).toBeVisible();
  await shot(page, 'no-voice-yet');
  await page.mouse.up();
  await expect(note(pane(page), 'notheard')).toBeVisible();
  expect(w.upstreamCalls()).toHaveLength(before);
  await context.close();
});

test('the browser’s prompt: says so, and the press becomes a tap; a block says how to allow it', async () => {
  const w = await mainWorld();
  const { context, page } = await open(speech, w, { grant: false });
  await page.addInitScript(() => {
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    (window as unknown as { answerPrompt: (allow: boolean) => void }).answerPrompt = () => {};
    navigator.mediaDevices.getUserMedia = (constraints) =>
      new Promise((resolve, reject) => {
        (window as unknown as { answerPrompt: (allow: boolean) => void }).answerPrompt = (allow) => (allow ? resolve(real(constraints)) : reject(new DOMException('no', 'NotAllowedError')));
      });
    navigator.permissions.query = (async () => ({ state: 'prompt' })) as unknown as typeof navigator.permissions.query;
  });
  await openReply(page, w, w.threads[5]!);
  await mic(pane(page)).click();
  await expect(line(pane(page), 'asking')).toBeVisible();
  await expect(line(pane(page), 'asking').locator('[data-voice-cancel]')).toBeVisible();
  await shot(page, 'asking');
  await page.evaluate(() => (window as unknown as { answerPrompt: (allow: boolean) => void }).answerPrompt(false));
  await expect(note(pane(page), 'blocked')).toBeVisible();
  await mic(pane(page)).click();
  await page.evaluate(() => (window as unknown as { answerPrompt: (allow: boolean) => void }).answerPrompt(true));
  await expect(line(pane(page), 'tap')).toBeVisible();
  await page.locator('[data-voice-cancel]').click();
  await context.close();
});

test('not signed in: the mic stays, dimmed, with a line and a way to Settings; Check again brings it back', async () => {
  const w = await startWorld({ config: { inboxVoice: { on: true } }, codex: { account: null } });
  const { context, page } = await open(speech, w);
  await openReply(page, w, w.threads[0]!);
  await expect(mic(pane(page))).toHaveAttribute('aria-disabled', 'true');
  const line2 = note(pane(page), 'notready');
  await expect(line2).toContainText('Voice needs Codex signed in with ChatGPT on this computer.');
  await shot(page, 'not-ready');
  const starts = w.codexStarts();
  await mic(pane(page)).click({ force: true });
  await expect(line(pane(page), 'tap')).toHaveCount(0);
  expect(w.codexStarts()).toBe(starts);

  await line2.locator('[data-voice-settings]').click();
  const status = page.locator('[data-voice-status="signedout"]');
  await expect(status).toContainText('Codex isn’t signed in');
  w.send({ codex: CHATGPT_LOGIN });
  await page.locator('[data-voice-check]').click();
  await expect(page.locator('[data-voice-status="ready"]')).toBeVisible();
  await context.close();
});

test('the API key: pasted once, last 4 after that, used in place of Codex', async () => {
  const w = await startWorld({ config: { inboxVoice: { on: true, engine: 'api' } } });
  const { context, page } = await open(speech, w);
  await page.goto(`${w.url}#settings/voice`);
  const input = page.locator('#ib-vkey');
  await expect(input).toBeVisible();
  await input.fill('sk-test-key-never-shown-4f2a');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('[data-voice-key="saved"]')).toContainText('Key saved, ending in 4f2a');
  await shot(page, 'settings-key-saved');
  await page.reload();
  await expect(page.locator('[data-voice-key="saved"]')).toBeVisible();
  expect(await page.content()).not.toContain('sk-test-key-never-shown');

  w.send({ upstream: [{ text: 'By key.' }] });
  const box = await openReply(page, w, w.threads[0]!);
  await hold(page, 900);
  await page.mouse.up();
  await expect(box).toHaveValue('By key.');
  expect(w.upstreamCalls().at(-1)).toMatchObject({ path: '/v1/audio/transcriptions', model: 'gpt-transcribe' });
  expect(w.codexStarts()).toBe(0);
  await context.close();
});

test('Phones only is the touch query: a narrow desktop window has no mic, a touch screen does', async () => {
  const w = await startWorld();
  await turnOn(w, { phones_only: true });
  const desktop = await open(speech, w);
  await openReply(desktop.page, w, w.threads[0]!);
  await expect(desktop.page.locator('[data-settings-link], .ib-rbox').first()).toBeVisible();
  await expect(desktop.page.locator('[data-voice-mic]')).toHaveCount(0);
  await desktop.context.close();

  const narrow = await open(speech, w, { viewport: { width: 390, height: 800 } });
  await openReply(narrow.page, w, w.threads[0]!);
  await expect(narrow.page.locator('[data-voice-mic]')).toHaveCount(0);
  await narrow.context.close();

  const phone = await open(speech, w, { phone: true });
  await openReply(phone.page, w, w.threads[0]!);
  await expect(mic(pane(phone.page))).toBeVisible();
  await phone.context.close();
});

test('a hold let go off the button transcribes once, as one let go on it does', async () => {
  const w = await mainWorld();
  const { context, page } = await open(speech, w);
  const box = await openReply(page, w, w.threads[6]!);
  const before = w.upstreamCalls().length;
  w.send({ upstream: [{ text: 'Let go elsewhere.' }] });
  await hold(page, 1000);
  await page.mouse.move(200, 200, { steps: 5 });
  await expect(line(pane(page), 'hold').locator('[data-voice-cancel]')).toBeVisible();
  await page.mouse.up();
  await expect(box).toHaveValue('Let go elsewhere.');
  expect(w.upstreamCalls()).toHaveLength(before + 1);
  await context.close();
});

test('a phone: hold to talk, the keyboard stays down, Cancel on screen, and a take ends however the finger does', async () => {
  const w = await mainWorld();
  const { context, page } = await open(speech, w, { phone: true });
  const cdp: CDPSession = await context.newCDPSession(page);
  const box = await openReply(page, w, w.threads[7]!);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const target = (await mic(pane(page)).boundingBox())!;
  const x = target.x + target.width / 2;
  const y = target.y + target.height / 2;
  expect(target.width).toBeGreaterThanOrEqual(36);
  const touch = (type: string, at?: [number, number]) => cdp.send('Input.dispatchTouchEvent', { type: type as 'touchStart', touchPoints: at ? [{ x: at[0], y: at[1] }] : [] });

  w.send({ upstream: [{ text: 'From the phone.', hold: true }] });
  await touch('touchStart', [x, y]);
  await expect(line(pane(page), 'hold').locator('[data-voice-cancel]')).toBeVisible();
  await page.waitForTimeout(1000);
  await shot(page, 'phone-listening');
  expect(await box.evaluate((el) => el === document.activeElement)).toBe(false);
  // Nothing runs past the box, and the row never wraps.
  const row = await pane(page).locator('.ib-rfoot').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, height: el.clientHeight }));
  expect(row.scroll).toBeLessThanOrEqual(row.client);
  await touch('touchEnd');
  await expect(line(pane(page), 'sending')).toBeVisible();
  await shot(page, 'phone-transcribing');
  w.send({ release: true });
  await expect(box).toHaveValue('From the phone.');
  await shot(page, 'phone-landed');

  // The finger comes up well off the button: the words land, once.
  const before = w.upstreamCalls().length;
  w.send({ upstream: [{ text: 'Off the button.' }] });
  await touch('touchStart', [x, y]);
  await expect(line(pane(page), 'hold')).toBeVisible();
  await page.waitForTimeout(1000);
  await touch('touchMove', [x - 120, y - 120]);
  await expect(line(pane(page), 'hold')).toBeVisible();
  await touch('touchEnd');
  await expect(box).toHaveValue('From the phone. Off the button.');
  expect(w.upstreamCalls()).toHaveLength(before + 1);

  // Cancel with the finger still down: nothing goes, and the finger coming up after it changes nothing.
  await touch('touchStart', [x, y]);
  await expect(line(pane(page), 'hold')).toBeVisible();
  await page.waitForTimeout(600);
  await line(pane(page), 'hold').locator('[data-voice-cancel]').click();
  await expect(mic(pane(page))).toHaveAttribute('data-state', 'idle');
  await touch('touchEnd');
  await page.waitForTimeout(400);
  expect(w.upstreamCalls()).toHaveLength(before + 1);

  // The system takes the touch (pointercancel): no take is left running, nothing goes, and the mic works again.
  await touch('touchStart', [x, y]);
  await expect(line(pane(page), 'hold')).toBeVisible();
  await page.waitForTimeout(600);
  await touch('touchCancel');
  await expect(mic(pane(page))).toHaveAttribute('data-state', 'idle');
  await expect(line(pane(page), 'hold')).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(w.upstreamCalls()).toHaveLength(before + 1);
  await expect(box).toHaveValue('From the phone. Off the button.');

  w.send({ upstream: [{ text: 'Still free.' }] });
  await touch('touchStart', [x, y]);
  await expect(line(pane(page), 'hold')).toBeVisible();
  await page.waitForTimeout(1000);
  await touch('touchEnd');
  await expect(box).toHaveValue('From the phone. Off the button. Still free.');
  expect(w.upstreamCalls()).toHaveLength(before + 2);
  await context.close();
});

test.describe('New message dictates as the reply box does', () => {
  const SESSION = 'ses-voice-compose';
  /** One live agent, told to the page: this world's sessions never poll. Sending is answered by the page too. */
  const liveAgent = {
    serverSession: 'voice',
    home: '/tmp',
    projects: [{ project: { id: 'prj_voice', name: 'billing', root: '/tmp/billing' }, sessions: [{ host: 'claude-code', session: SESSION, root: '/tmp/billing', started_at: '2026-11-01T10:00:00.000Z', last_seen_at: '2026-11-01T10:00:00.000Z' }] }],
  };
  const sheet = (page: Page) => page.locator('dialog[data-compose]');
  const field = (page: Page) => sheet(page).locator('[data-compose-text] textarea');

  async function openCompose(page: Page, w: World, options: { pick?: boolean; agent?: boolean } = {}) {
    if (options.agent !== false) await page.route('**/api/inbox/sessions*', (route) => route.fulfill({ json: liveAgent }));
    await page.goto(w.url);
    await page.locator('.ib-lhead [data-open-compose], .ib-side [data-open-compose]').filter({ visible: true }).first().click();
    await expect(sheet(page).locator('.ib-cp-tobtn, .ib-cp-none-to').first()).toBeVisible();
    await expect(sheet(page).locator('[data-loading]')).toHaveCount(0);
    if (options.pick) {
      await sheet(page).locator('.ib-cp-tobtn').click();
      await sheet(page).locator(`[data-compose-session="${SESSION}"]`).click();
    }
  }

  interface Row {
    mic: { left: number; right: number };
    row: { left: number; right: number; height: number };
    /** Where the row's end is for the mic: Send's left edge, or the row's right edge with no Send on it. */
    end: number;
    bars: number;
    level: string;
  }

  /** The row as drawn. `bars`: the level's strokes with room to show. */
  const readRow = (scope: Locator) =>
    scope.evaluate((box) => {
      const row = box.querySelector('.ib-rfoot, .ib-cp-foot')!.getBoundingClientRect();
      const mic = box.querySelector('[data-voice-mic]')!.getBoundingClientRect();
      const send = box.querySelector('.ib-cp-foot [data-compose-send]')?.getBoundingClientRect();
      const strip = box.querySelector('.ib-vbars');
      const room = strip?.getBoundingClientRect();
      const strokes = strip ? [...strip.children] : [];
      const shown = strokes.filter((stroke) => {
        const at = stroke.getBoundingClientRect();
        return room !== undefined && at.left >= room.left - 0.5 && at.right <= room.right + 0.5;
      });
      return {
        mic: { left: mic.left, right: mic.right },
        row: { left: row.left, right: row.right, height: row.height },
        end: send?.left ?? row.right,
        bars: shown.length,
        level: shown.map((stroke) => (stroke as HTMLElement).style.transform).join(' '),
      };
    }) as Promise<Row>;

  /** Listening, the level on screen and moving, the mic where it was, nothing drawn over the words. */
  async function listensWell(page: Page, scope: Locator, row: Row, name: string) {
    await expect.poll(async () => (await readRow(scope)).mic.left, { message: `${name}: the mic stays under the finger` }).toBeCloseTo(row.mic.left, 0);
    const first = await readRow(scope);
    // A floor, not a reply's count: a phone row that also carries Send draws fewer strokes, and none at all is the fault.
    expect(first.bars, `${name}: the level is drawn`).toBeGreaterThanOrEqual(4);
    await expect.poll(async () => (await readRow(scope)).level, { message: `${name}: the level moves` }).not.toBe(first.level);
    const parts = await scope.evaluate((box) => ['[data-voice-line] b', '[data-voice-cancel]', '.ib-vbars', '.ib-dttime', '[data-voice-mic]', '.ib-cp-status'].flatMap((selector) => {
      const el = box.querySelector(selector);
      const at = el?.getBoundingClientRect();
      return at && at.width > 0 && el!.checkVisibility() ? [{ selector, left: at.left, right: at.right }] : [];
    }));
    for (let i = 1; i < parts.length; i++) expect(parts[i]!.left, `${name}: ${parts[i]!.selector} clear of ${parts[i - 1]!.selector}`).toBeGreaterThanOrEqual(parts[i - 1]!.right - 0.5);
    expect(parts.map((part) => part.selector), `${name}: in the reply box's order, and nothing else`).toEqual(['[data-voice-line] b', '[data-voice-cancel]', '.ib-vbars', '.ib-dttime', '[data-voice-mic]']);
  }

  const onTheRight = (row: Row, name: string) => {
    // Soft: the side and the level are two faults, and the run should show both.
    expect.soft(row.end - row.mic.right, `${name}: the mic is at the row's right end`).toBeLessThanOrEqual(24);
    expect.soft(row.end - row.mic.right, `${name}: and clear of what comes after it`).toBeGreaterThanOrEqual(0);
  };

  const keyboardUp = (page: Page, ios: boolean, height: number) =>
    page.evaluate(
      ({ ios, height }) => {
        const vv = window.visualViewport!;
        const full = window.innerHeight;
        Object.defineProperty(vv, 'height', { configurable: true, get: () => full - height });
        if (ios) Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => full - height });
        vv.dispatchEvent(new Event('resize'));
        if (ios) {
          window.scrollTo(0, height);
          window.dispatchEvent(new Event('scroll'));
        }
      },
      { ios, height },
    );

  /** WebKit has no fake capture device: a tone that comes and goes, through a real MediaStream. Nothing is heard. */
  const toneForAMicrophone = () => {
    const Real = window.AudioContext;
    let last: AudioContext | null = null;
    window.AudioContext = class extends Real {
      constructor(...args: ConstructorParameters<typeof AudioContext>) {
        super(...args);
        last = this;
      }
    };
    Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
      configurable: true,
      writable: true,
      value: async () => {
        const context = last!;
        const tone = context.createOscillator();
        tone.frequency.value = 220;
        const gain = context.createGain();
        gain.gain.value = 0.3;
        const swell = context.createOscillator();
        swell.frequency.value = 2.5;
        const depth = context.createGain();
        depth.gain.value = 0.3;
        swell.connect(depth).connect(gain.gain);
        const out = context.createMediaStreamDestination();
        tone.connect(gain).connect(out);
        tone.start();
        swell.start();
        return out.stream;
      },
    });
  };

  const ENGINES = [
    { name: 'Chromium', device: devices['Pixel 7'], ios: false },
    { name: 'WebKit', device: devices['iPhone 15'], ios: true },
  ] as const;
  const SIZES = [
    { width: 390, height: 660, keyboard: 403 },
    { width: 320, height: 568, keyboard: 353 },
    // The tightest: Send is the bare arrow under 360, so 360 to 389 have the least room for the status.
    { width: 360, height: 640, keyboard: 383 },
    { width: 375, height: 667, keyboard: 410 },
    { width: 389, height: 660, keyboard: 403 },
  ] as const;

  for (const engine of ENGINES) {
    test(`${engine.name} as a phone: the mic on the same side, the level drawn and moving, keyboard down and up`, async () => {
      const w = await mainWorld();
      const browser = engine.ios ? await webkit.launch({ args: [] }) : speech;
      try {
        for (const size of SIZES) {
          for (const keyboard of [false, true]) {
            const start = async () => {
              const context = await browser.newContext({ userAgent: engine.device.userAgent, isMobile: true, hasTouch: true, deviceScaleFactor: 2, viewport: { width: size.width, height: size.height } });
              if (!engine.ios) await context.grantPermissions(['microphone'], { origin: new URL(w.url).origin });
              const page = await context.newPage();
              if (engine.ios) await page.addInitScript(toneForAMicrophone);
              return { context, page };
            };
            const where = `${size.width} px, keyboard ${keyboard ? 'up' : 'down'}`;

            const reply = await start();
            const box = await openReply(reply.page, w, w.threads[0]!);
            await box.focus();
            await expect(mic(pane(reply.page))).toBeVisible();
            if (keyboard) await keyboardUp(reply.page, engine.ios, size.keyboard);
            onTheRight(await readRow(pane(reply.page)), `reply, ${where}`);
            await mic(pane(reply.page)).tap();
            await expect(line(pane(reply.page), 'tap')).toBeVisible();
            expect((await readRow(pane(reply.page))).bars, `reply, ${where}: the level is drawn`).toBeGreaterThanOrEqual(4);
            await reply.context.close();

            for (const pick of [false, true]) {
              const name = `New message, ${pick ? 'an agent chosen' : 'none chosen'}, ${where}`;
              const { context, page } = await start();
              await openCompose(page, w, { pick });
              await field(page).focus();
              await expect(mic(sheet(page))).toBeVisible();
              if (keyboard) {
                await keyboardUp(page, engine.ios, size.keyboard);
                await expect(page.locator('html')).toHaveAttribute('data-ib-keyboard', '');
              }
              const rest = await readRow(sheet(page));
              onTheRight(rest, name);
              await mic(sheet(page)).tap();
              await expect(line(sheet(page), 'tap')).toBeVisible();
              await listensWell(page, sheet(page), rest, name);
              const seen = await sheet(page).locator('.ib-cp-foot').boundingBox();
              expect(seen!.height, `${name}: still one row`).toBeLessThanOrEqual(rest.row.height + 0.5);
              expect(seen!.y + seen!.height, `${name}: the row is above the keyboard`).toBeLessThanOrEqual(size.height - (keyboard ? size.keyboard : 0) + 0.5);
              await expect(sheet(page).locator('[data-compose-send]')).toBeDisabled();
              await context.close();
            }
          }
        }
      } finally {
        if (engine.ios) await browser.close();
      }
    });
  }

  test('a desktop: the mic on the same side, with room for the level, and Send still last', async () => {
    const w = await mainWorld();
    const { context, page } = await open(speech, w);
    await openReply(page, w, w.threads[0]!);
    onTheRight(await readRow(pane(page)), 'reply');
    await openCompose(page, w);
    await field(page).fill('Words already here');
    // Past the dialog's opening scale, so the place read is where it stays.
    await page.waitForTimeout(250);
    const rest = await readRow(sheet(page));
    onTheRight(rest, 'New message');
    const save = sheet(page).locator('[data-compose-save]');
    const saveAtRest = (await save.boundingBox())!;
    await mic(sheet(page)).click();
    await expect(line(sheet(page), 'tap')).toBeVisible();
    await expect.poll(async () => (await readRow(sheet(page))).mic.left).toBeCloseTo(rest.mic.left, 0);
    expect((await save.boundingBox())!.x, 'starting to listen moves Save draft nowhere').toBeCloseTo(saveAtRest.x, 0);
    await page.waitForTimeout(1200);
    const live = await readRow(sheet(page));
    expect(live.bars, 'the level has its room').toBeGreaterThanOrEqual(20);
    const send = (await sheet(page).locator('[data-compose-send]').boundingBox())!;
    expect(send.x, 'Send is after the mic').toBeGreaterThanOrEqual(live.mic.right);
    const bars = (await sheet(page).locator('.ib-vbars').boundingBox())!;
    expect(bars.x + bars.width, 'the status stops short of Save draft').toBeLessThanOrEqual(saveAtRest.x + 0.5);
    await page.locator('[data-voice-cancel]').click();
    await expect(line(sheet(page), 'tap')).toHaveCount(0);
    expect((await save.boundingBox())!.x, 'nor does stopping').toBeCloseTo(saveAtRest.x, 0);
    await context.close();
  });

  test('a desktop: a failed microphone’s note sits on the dialog, with no band of its own', async () => {
    const w = await mainWorld();
    const { context, page } = await open(speech, w);
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('no', 'NotAllowedError'));
    });
    await openCompose(page, w);
    await mic(sheet(page)).click();
    await expect(note(sheet(page), 'blocked')).toBeVisible();
    await expect(note(sheet(page), 'blocked')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await context.close();
  });

  test('a phone: words land at the cursor with the keyboard down, Send waits, then sends them', async () => {
    const w = await mainWorld();
    const { context, page } = await open(speech, w, { phone: true });
    let sent: { body?: string } | null = null;
    await page.route('**/api/inbox/messages', async (route) => {
      sent = route.request().postDataJSON() as { body?: string };
      await route.fulfill({ json: { thread_id: w.threads[0], message: {}, replayed: false } });
    });
    await openCompose(page, w, { pick: true });
    const text = field(page);
    await text.fill('Cards. and more');
    await text.evaluate((el: HTMLTextAreaElement) => {
      el.setSelectionRange(6, 6);
      el.blur();
    });
    const send = sheet(page).locator('[data-compose-send]');
    await expect(send).toBeEnabled();

    w.send({ upstream: [{ text: 'Keep the totals.', hold: true }] });
    await mic(sheet(page)).tap();
    await expect(line(sheet(page), 'tap')).toBeVisible();
    await expect(send).toBeDisabled();
    await page.waitForTimeout(1200);
    await mic(sheet(page)).tap();
    await expect(line(sheet(page), 'sending')).toBeVisible();
    await expect(sheet(page).locator('.ib-vcaret.ib-vstill')).toBeVisible();
    await expect(send).toBeDisabled();
    await expect(text).toHaveValue('Cards. and more');
    w.send({ release: true });
    await expect(text).toHaveValue('Cards. Keep the totals. and more');
    await expect(sheet(page).locator('mark.ib-vmark')).toHaveText(/Keep the totals\./);
    expect(await text.evaluate((el) => el === document.activeElement), 'the keyboard stays down').toBe(false);
    await expect(send).toBeEnabled();
    await send.click();
    await expect.poll(() => sent?.body).toBe('Cards. Keep the totals. and more');
    await context.close();
  });

  test('a phone: Cancel keeps the words, and the draft question leaves no microphone open', async () => {
    const w = await mainWorld();
    const { context, page } = await open(speech, w, { phone: true });
    const mics = await watchMic(page);
    await openCompose(page, w);
    const text = field(page);
    await text.fill('Kept words');
    await text.blur();
    const posts = w.upstreamCalls().length;

    await mic(sheet(page)).tap();
    await expect(line(sheet(page), 'tap')).toBeVisible();
    await sheet(page).locator('[data-voice-cancel]').tap();
    await expect(line(sheet(page), 'tap')).toHaveCount(0);
    await expect.poll(mics).toBe(0);
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).locator('[data-compose-question]')).toHaveCount(0);
    await expect(text).toHaveValue('Kept words');

    await mic(sheet(page)).tap();
    await expect(line(sheet(page), 'tap')).toBeVisible();
    await sheet(page).locator('[data-compose-cancel]').tap();
    await expect(sheet(page).locator('[data-compose-question]')).toBeVisible();
    await expect.poll(mics, { message: 'the question took the status and Cancel: no microphone stays open behind it' }).toBe(0);
    await sheet(page).getByRole('button', { name: 'Keep writing' }).tap();
    await expect(mic(sheet(page))).toHaveAttribute('data-state', 'idle');
    await expect(text).toHaveValue('Kept words');
    expect(w.upstreamCalls()).toHaveLength(posts);
    await context.close();
  });

  test('a phone: To in the middle of a take stops the microphone and keeps the words', async () => {
    const w = await mainWorld();
    const { context, page } = await open(speech, w, { phone: true });
    const mics = await watchMic(page);
    await openCompose(page, w);
    await field(page).fill('Before.');
    await field(page).blur();
    w.send({ upstream: [{ text: 'After.', hold: true }] });
    await mic(sheet(page)).tap();
    await expect(line(sheet(page), 'tap')).toBeVisible();
    await page.waitForTimeout(1200);
    await sheet(page).locator('.ib-cp-tobtn').tap();
    await expect(page.locator(`[data-compose-session="${SESSION}"]`)).toBeVisible();
    await expect.poll(mics, { message: 'the To sheet took the status and Cancel: no microphone stays open behind it' }).toBe(0);
    w.send({ release: true });
    await page.locator(`[data-compose-session="${SESSION}"]`).tap();
    await expect(field(page)).toHaveValue('Before. After.');
    await expect(sheet(page).locator('[data-compose-send]')).toBeEnabled();
    await context.close();
  });

  const savedDrafts = async (w: World) => ((await (await fetch(new URL('/api/inbox/drafts', w.url))).json()) as { drafts: { body: string }[] }).drafts.map((draft) => draft.body);

  /** Stopped, the answer held: the take is on its way and its words are not in. */
  async function takeOnItsWay(page: Page, w: World) {
    await openCompose(page, w, { agent: false });
    await field(page).fill('Before.');
    await field(page).blur();
    w.send({ upstream: [{ text: 'After.', hold: true }] });
    await mic(sheet(page)).tap();
    await expect(line(sheet(page), 'tap')).toBeVisible();
    await page.waitForTimeout(1200);
    await mic(sheet(page)).tap();
    await expect(line(sheet(page), 'sending')).toBeVisible();
  }

  test('a phone: Keep draft pressed before the answer waits for the words, and keeps them', async () => {
    const w = await mainWorld();
    const { context, page } = await open(speech, w, { phone: true });
    await takeOnItsWay(page, w);
    await sheet(page).locator('[data-compose-cancel]').tap();
    const keep = sheet(page).locator('[data-compose-keep]');
    await expect(keep).toBeVisible();
    await expect(keep, 'Keep draft waits, as Send does').toBeDisabled();
    await keep.evaluate((button: HTMLButtonElement) => button.click());
    await page.waitForTimeout(300);
    await expect(sheet(page), 'the press before the answer did not leave').toBeVisible();
    w.send({ release: true });
    await expect(field(page)).toHaveValue('Before. After.');
    await keep.tap();
    await expect(sheet(page)).toHaveCount(0);
    await expect.poll(() => savedDrafts(w)).toContain('Before. After.');
    await context.close();
  });

  test('a phone: the bar’s Save draft waits for the words too', async () => {
    const w = await mainWorld();
    const { context, page } = await open(speech, w, { phone: true });
    await takeOnItsWay(page, w);
    const save = sheet(page).locator('[data-compose-save]');
    await expect(save, 'Save draft waits, as Send does').toBeDisabled();
    await save.evaluate((button: HTMLButtonElement) => button.click());
    await page.waitForTimeout(300);
    await expect(sheet(page), 'the press before the answer did not leave').toBeVisible();
    w.send({ release: true });
    await expect(field(page)).toHaveValue('Before. After.');
    await save.tap();
    await expect(sheet(page)).toHaveCount(0);
    await expect.poll(() => savedDrafts(w)).toContain('Before. After.');
    await context.close();
  });

  test('a phone with the keyboard up: a refused clip and a blocked microphone say so where they can be read', async () => {
    const w = await mainWorld();
    const { context, page } = await open(speech, w, { phone: true, viewport: { width: 390, height: 660 } });
    await page.addInitScript(() => {
      const media = navigator.mediaDevices;
      const real = media.getUserMedia.bind(media);
      media.getUserMedia = (constraints) => ((window as unknown as { blockMic?: boolean }).blockMic ? Promise.reject(new DOMException('no', 'NotAllowedError')) : real(constraints));
    });
    await openCompose(page, w, { pick: true });
    await field(page).focus();
    await keyboardUp(page, false, 403);
    await expect(page.locator('html')).toHaveAttribute('data-ib-keyboard', '');
    const inSight = async (name: string) => {
      const foot = (await sheet(page).locator('.ib-cp-foot').boundingBox())!;
      const shown = await sheet(page).locator('[data-voice-note]').evaluate((el) => {
        const at = el.getBoundingClientRect();
        const body = el.closest('.ib-cp-body')!.getBoundingClientRect();
        return { top: at.top, bodyBottom: body.bottom };
      });
      expect(shown.top, `${name}: the first line is above the row`).toBeLessThan(Math.min(foot.y, shown.bodyBottom) - 12);
    };

    w.send({ upstream: [{ status: 403 }, { text: 'Second try.' }] });
    await mic(sheet(page)).tap();
    await expect(line(sheet(page), 'tap')).toBeVisible();
    await page.waitForTimeout(1200);
    await mic(sheet(page)).tap();
    await expect(note(sheet(page), 'refused')).toBeVisible();
    await inSight('refused');
    await note(sheet(page), 'refused').locator('[data-voice-retry]').click();
    await expect(field(page)).toHaveValue('Second try.');

    await page.evaluate(() => {
      (window as unknown as { blockMic?: boolean }).blockMic = true;
    });
    await mic(sheet(page)).tap();
    await expect(note(sheet(page), 'blocked')).toBeVisible();
    await inSight('blocked');
    await context.close();
  });
});

test.describe('the announcement', () => {
  const dialog = (page: Page) => page.locator('[data-dialog="voice-intro"]');
  const SETTLE = 6_000;

  test('on a computer with a ChatGPT login: once; Phones only is saved by Turn on voice, which asks for no microphone', async () => {
    const w = await startWorld({ version: '0.30.0', used: true });
    const { context, page } = await open(speech, w, { grant: false });
    await page.addInitScript(() => {
      (window as unknown as { micAsked: number }).micAsked = 0;
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (constraints) => {
        (window as unknown as { micAsked: number }).micAsked += 1;
        return real(constraints);
      };
    });
    await page.goto(w.url);
    await expect(dialog(page)).toBeVisible({ timeout: 15_000 });
    await expect(dialog(page).getByRole('switch', { name: 'Phones only' })).toHaveAttribute('aria-checked', 'false');
    await shot(page, 'dialog');
    await dialog(page).getByRole('switch', { name: 'Phones only' }).click();
    await shot(page, 'dialog-phones-only');
    await dialog(page).locator('[data-voice-intro-on]').click();
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => saved(w).inboxVoice).toEqual({ on: true, phonesOnly: true });
    expect(await page.evaluate(() => (window as unknown as { micAsked: number }).micAsked)).toBe(0);
    await page.reload();
    await page.waitForTimeout(SETTLE);
    await expect(dialog(page)).toHaveCount(0);
    await context.close();
  });

  test('a Turn on voice that was not saved says so and points to Settings: the dialog won’t come back', async () => {
    const w = await startWorld({ version: '0.30.0', used: true });
    const { context, page } = await open(speech, w);
    await page.route('**/api/inbox/settings', (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 500, json: { error: 'Not saved.', code: 'config_not_saved' } }) : route.continue()));
    await page.goto(w.url);
    await expect(dialog(page)).toBeVisible({ timeout: 15_000 });
    await dialog(page).locator('[data-voice-intro-on]').click();
    const toast = page.locator('.ib-toast');
    await expect(toast).toContainText('Voice isn’t on');
    await toast.getByRole('button', { name: 'Voice settings' }).click();
    await expect(page).toHaveURL(/#settings\/voice$/);
    await context.close();
  });

  test('Not now changes nothing and retires it, and over a reply being written it waits', async () => {
    const w = await startWorld({ version: '0.30.0', used: true });
    const { context, page } = await open(speech, w);
    const box = await openReply(page, w, w.threads[0]!);
    await box.fill('Words in the box');
    await page.waitForTimeout(SETTLE);
    await expect(dialog(page)).toHaveCount(0);
    expect(saved(w).inboxVoiceIntro?.shownAt).toBeUndefined();
    await box.fill('');
    await pane(page).locator('.ib-acts .ib-btn.ib-ghost').click();
    await expect(dialog(page)).toBeVisible({ timeout: 15_000 });
    await dialog(page).locator('[data-voice-intro-keep]').click();
    await expect(dialog(page)).toHaveCount(0);
    expect(saved(w).inboxVoice).toBeUndefined();
    expect(saved(w).inboxVoiceIntro?.shownAt).toBeTruthy();
    await context.close();
  });

  test('no ChatGPT login: never shown, and not spent', async () => {
    const w = await startWorld({ version: '0.30.0', used: true, codex: { account: { type: 'apiKey' } } });
    const { context, page } = await open(speech, w);
    await page.goto(w.url);
    await page.waitForTimeout(SETTLE);
    await expect(dialog(page)).toHaveCount(0);
    expect(saved(w).inboxVoiceIntro?.shownAt).toBeUndefined();
    await context.close();
  });

  test('a fresh install, and a load with the list options dialog due: not shown', async () => {
    const fresh = await startWorld({ version: '0.30.0', fresh: true });
    const first = await open(speech, fresh);
    await first.page.goto(fresh.url);
    await first.page.waitForTimeout(SETTLE);
    await expect(dialog(first.page)).toHaveCount(0);
    expect(saved(fresh).inboxVoiceIntro?.shownAt).toBeTruthy();
    expect(fresh.codexStarts()).toBe(0);
    await first.context.close();

    const queued = await startWorld({ version: '0.30.0', used: true, config: { inboxListIntro: { dueAt: '2026-10-30T10:00:00.000Z' } } });
    const second = await open(speech, queued);
    await second.page.goto(queued.url);
    await expect(second.page.locator('[data-dialog="list-look-intro"]')).toBeVisible({ timeout: 15_000 });
    await second.page.keyboard.press('Escape');
    await second.page.waitForTimeout(SETTLE);
    await expect(dialog(second.page)).toHaveCount(0);
    await second.page.reload();
    await expect(dialog(second.page)).toBeVisible({ timeout: 15_000 });
    await second.context.close();
  });
});
