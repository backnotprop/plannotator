import { chromium, expect, test, webkit, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const CHROMIUM_ARGS = ['--use-mock-keychain', '--password-store=basic', '--mute-audio', '--autoplay-policy=no-user-gesture-required'];

function tone(seconds = 1): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(rate * 2 * seconds);
  for (let i = 0; i < rate * seconds; i++) data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function recordClip(): Promise<Buffer> {
  const browser = await chromium.launch({ args: CHROMIUM_ARGS });
  try {
    const page = await browser.newPage();
    const base64 = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 90;
      document.body.append(canvas);
      const ctx = canvas.getContext('2d')!;
      const recorder = new MediaRecorder(canvas.captureStream(15), { mimeType: 'video/webm;codecs=vp8' });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      const stopped = new Promise((done) => (recorder.onstop = done));
      let frame = 0;
      const draw = () => {
        ctx.fillStyle = `hsl(${(frame * 24) % 360} 70% 50%)`;
        ctx.fillRect(0, 0, 160, 90);
        ctx.fillStyle = '#fff';
        ctx.fillRect((frame * 8) % 160, 30, 30, 30);
        frame++;
      };
      draw();
      recorder.start(100);
      const timer = setInterval(draw, 66);
      await new Promise((done) => setTimeout(done, 1200));
      clearInterval(timer);
      recorder.stop();
      await stopped;
      const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
      let s = '';
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s);
    });
    return Buffer.from(base64, 'base64');
  } finally {
    await browser.close();
  }
}

async function overflow(page: Page, messageId: string) {
  return page.evaluate((id) => {
    const message = document.querySelector(`[data-message-id="${id}"]`)!.getBoundingClientRect();
    const players = [...document.querySelectorAll<HTMLElement>(`[data-message-id="${id}"] [data-inline-media]`)].map((el) => {
      const r = el.getBoundingClientRect();
      return { kind: el.dataset.inlineMedia, left: r.left, right: r.right, width: r.width };
    });
    return { message: { left: message.left, right: message.right }, players, scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth };
  }, messageId);
}

test('a sound and a video named in a message body play in place, beside a picture', async ({ browserName }, testInfo) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const scratch = inboxScratch('plannotator-inbox-inline-media-e2e-');
  const root = realpathSync(scratch);
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'sounds');
  mkdirSync(join(project, 'media'), { recursive: true });
  const wavPath = join(project, 'media', 'tone.wav');
  const webmPath = join(project, 'media', 'clip.webm');
  writeFileSync(wavPath, tone());
  writeFileSync(webmPath, await recordClip());
  writeFileSync(join(project, 'media', 'shot.png'), PNG);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
  const browser = browserName === 'webkit' ? await webkit.launch() : await chromium.launch({ args: CHROMIUM_ARGS });
  try {
    const sent = await agent.send({
      project_path: project,
      subject: 'The new notification sound',
      body: ['Here is the tone the notification plays:', '', `![A test tone](${wavPath})`, '', 'And the animation it goes with:', '', `![A test clip](${webmPath})`, '', '![A screenshot](media/shot.png)'].join('\n'),
    });
    const id = sent.message_id as string;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce' });
    const page = await context.newPage();
    const ranged: { range: string; status: number }[] = [];
    page.on('response', async (r) => {
      if (!r.url().includes('/image?') || !r.url().includes(encodeURIComponent('tone.wav'))) return;
      const range = await r.request().headerValue('range');
      if (range) ranged.push({ range, status: r.status() });
    });
    await page.goto(`${url}#thread=${sent.thread_id}`);
    const body = page.locator(`[data-message-id="${id}"]`);
    const audio = body.locator('audio[data-inline-media="audio"]');
    const video = body.locator('video[data-inline-media="video"]');
    await expect(audio).toHaveCount(1);
    await expect(audio).toHaveAttribute('controls', '');
    await expect(video).toHaveAttribute('controls', '');
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.duration), { timeout: 30_000 }).toBeCloseTo(1, 1);
    expect(await audio.evaluate((a: HTMLAudioElement) => ({ paused: a.paused, autoplay: a.autoplay, time: a.currentTime }))).toEqual({ paused: true, autoplay: false, time: 0 });
    for (const r of ranged) expect(r.status, `Range ${r.range}`).toBe(206);
    const slice = await audio.evaluate(async (a: HTMLAudioElement) => {
      const res = await fetch(a.currentSrc, { headers: { Range: 'bytes=100-199' } });
      return { status: res.status, range: res.headers.get('content-range'), bytes: (await res.arrayBuffer()).byteLength };
    });
    expect(slice).toEqual({ status: 206, range: 'bytes 100-199/16044', bytes: 100 });
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 30_000 }).toBeGreaterThan(0);
    const picture = body.locator('img[alt="A screenshot"]');
    await expect.poll(() => picture.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1);
    await expect(body.locator('[data-image-unavailable]')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('inline-media-desktop-1280-dark.png'), fullPage: false });
    await body.screenshot({ path: testInfo.outputPath('inline-media-desktop-1280-dark-message.png') });

    await audio.evaluate(async (a: HTMLAudioElement) => {
      a.muted = true;
      await a.play();
    });
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.1);
    const seeked = await audio.evaluate(
      (a: HTMLAudioElement) =>
        new Promise<number>((done) => {
          a.pause();
          a.addEventListener('seeked', () => done(a.currentTime), { once: true });
          a.currentTime = 0.5;
        }),
    );
    expect(seeked).toBeCloseTo(0.5, 1);

    await audio.scrollIntoViewIfNeeded();
    const box = (await audio.boundingBox())!;
    const target = browserName === 'chromium' ? { x: box.x + 20, y: box.y + box.height / 2 } : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(500);
    await expect(page.locator('.annotation-toolbar')).toHaveCount(0);
    await expect(page.locator('[data-comment-popover]')).toHaveCount(0);
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
    if (browserName === 'chromium') await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.paused)).toBe(false);
    await audio.evaluate((a: HTMLAudioElement) => a.pause());
    await context.close();

    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', reducedMotion: 'reduce', hasTouch: true, isMobile: browserName === 'chromium' });
    const phonePage = await phone.newPage();
    await phonePage.goto(`${url}#thread=${sent.thread_id}`);
    const phoneBody = phonePage.locator(`[data-message-id="${id}"]`);
    await expect.poll(() => phoneBody.locator('video[data-inline-media]').evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(() => phoneBody.locator('audio[data-inline-media]').evaluate((a: HTMLAudioElement) => a.readyState), { timeout: 30_000 }).toBeGreaterThan(0);
    const fit = await overflow(phonePage, id);
    expect(fit.players).toHaveLength(2);
    for (const p of fit.players) {
      expect(p.width, `${p.kind} has a width`).toBeGreaterThan(0);
      expect(p.left, `${p.kind} left edge`).toBeGreaterThanOrEqual(fit.message.left - 0.5);
      expect(p.right, `${p.kind} right edge`).toBeLessThanOrEqual(fit.message.right + 0.5);
    }
    expect(fit.scroll, 'no horizontal scroll').toBeLessThanOrEqual(fit.client);
    await phonePage.screenshot({ path: testInfo.outputPath('inline-media-phone-390-dark.png') });
    await phoneBody.locator('audio[data-inline-media]').scrollIntoViewIfNeeded();
    await phonePage.screenshot({ path: testInfo.outputPath('inline-media-phone-390-dark-players.png') });
    await phone.close();
  } finally {
    await agent.close().catch(() => {});
    await browser.close().catch(() => {});
    await removeInboxScratch(scratch);
  }
});

function crc32(bytes: Buffer): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function widePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x80);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

type Player = ReturnType<Page['locator']>;
const WAIT = { timeout: 15_000 };

async function playMarked(player: Player): Promise<void> {
  await player.evaluate(
    (m: HTMLMediaElement) =>
      new Promise<void>((done, fail) => {
        m.muted = true;
        m.loop = m.tagName === 'VIDEO';
        m.dataset.marked = 'before-redraw';
        m.addEventListener('emptied', () => (m.dataset.reset = 'emptied'));
        m.addEventListener('loadstart', () => (m.dataset.reset = 'loadstart'));
        setTimeout(() => fail(new Error('play() did not settle in 10 s')), 10_000);
        m.play().then(done, fail);
      }),
  );
}

function advances(player: Player): Promise<{ from: number; to: number; paused: boolean }> {
  return player.evaluate(
    (m: HTMLMediaElement) =>
      new Promise((done) => {
        const from = m.currentTime;
        setTimeout(() => done({ from, to: m.currentTime, paused: m.paused }), 1500);
      }),
  );
}

test('a raw <img> naming a sound or a video plays in place and keeps playing when the message redraws; in WebKit the looping video advances after it exactly when an untouched copy does', async ({ browserName }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const scratch = inboxScratch('plannotator-inbox-inline-media-raw-e2e-');
  const root = realpathSync(scratch);
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'raw-media');
  mkdirSync(join(project, 'media'), { recursive: true });
  const wavPath = join(project, 'media', 'long-tone.wav');
  const webmPath = join(project, 'media', 'clip.webm');
  const controlPath = join(project, 'media', 'control.webm');
  const clip = await recordClip();
  writeFileSync(wavPath, tone(30));
  writeFileSync(webmPath, clip);
  writeFileSync(controlPath, clip);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
  const browser = browserName === 'webkit' ? await webkit.launch() : await chromium.launch({ args: CHROMIUM_ARGS });
  try {
    const sent = await agent.send({
      project_path: project,
      subject: 'Raw players',
      body: [`<p>The run: <img src="${webmPath}" alt="Raw clip"> and the tone: <img src="${wavPath}" alt="Raw tone"></p>`, '', '![Later](media/later.png)'].join('\n'),
    });
    const id = sent.message_id as string;
    const control = await agent.send({ project_path: project, reply_to: id, body: `<p>The same clip, untouched: <img src="${controlPath}" alt="Control clip"></p>` });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto(`${url}#thread=${sent.thread_id}`);
    const body = page.locator(`[data-message-id="${id}"]`);
    const players: [string, Player][] = [
      ['video', body.locator('video[data-inline-media="video"]')],
      ['sound', body.locator('audio[data-inline-media="audio"]')],
      ['control video', page.locator(`[data-message-id="${control.message_id}"] video[data-inline-media="video"]`)],
    ];
    const chips = page.locator('[data-message-id] [data-image-unavailable]', { hasText: /^(Raw clip|Raw tone|Control clip)$/ });

    for (const [name, player] of players) {
      await test.step(`${name}: drawn as a player with controls, loads metadata, does not start by itself`, async () => {
        await expect(player, name).toBeVisible(WAIT);
        await expect(player, name).toHaveAttribute('controls', '', WAIT);
        await expect.poll(() => player.evaluate((m: HTMLMediaElement) => m.readyState), { ...WAIT, message: `${name} readyState` }).toBeGreaterThanOrEqual(1);
        expect(await player.evaluate((m: HTMLMediaElement) => ({ paused: m.paused, autoplay: m.autoplay, time: m.currentTime })), name).toEqual({ paused: true, autoplay: false, time: 0 });
      });
    }
    await expect(chips).toHaveCount(0, WAIT);

    for (const [name, player] of players) {
      await test.step(`${name}: play() advances it`, async () => {
        await playMarked(player);
        await expect.poll(() => player.evaluate((m: HTMLMediaElement) => m.currentTime), { ...WAIT, message: `${name} currentTime` }).toBeGreaterThan(0.1);
      });
    }

    let soundBefore = 0;
    await test.step('the message redraws once its late picture is captured', async () => {
      soundBefore = await players[1]![1].evaluate((m: HTMLMediaElement) => m.currentTime);
      writeFileSync(join(project, 'media', 'later.png'), widePng(2000, 4));
      const note = await agent.send({ project_path: project, reply_to: id, body: 'One more note.' });
      await expect(page.locator(`[data-message-id="${note.message_id}"]`)).toBeVisible(WAIT);
      await expect
        .poll(async () => {
          const thread = (await (await fetch(new URL(`/api/inbox/threads/${sent.thread_id}`, url))).json()) as { thread: { messages: { id: string; inline_images?: { ref: string }[] }[] } };
          return thread.thread.messages.find((m) => m.id === id)?.inline_images?.map((image) => image.ref) ?? [];
        }, { ...WAIT, message: 'later.png captured' })
        .toContain('media/later.png');
      await expect(body.locator('img[alt="Later"]')).toBeVisible(WAIT);
      await expect.poll(() => body.locator('img[alt="Later"]').evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { ...WAIT, message: 'Later drawn' }).toBeGreaterThan(0);
    });

    const startedWithin = (player: Player) =>
      expect
        .poll(() => player.evaluate((m: HTMLMediaElement) => m.currentTime), WAIT)
        .toBeGreaterThan(0)
        .then(() => true, () => false);
    for (const [name, player] of players) {
      await test.step(`${name}: the same element after the redraw, not paused, not reset`, async () => {
        const now = await player.evaluate((m: HTMLMediaElement) => ({ marked: m.dataset.marked ?? null, reset: m.dataset.reset ?? null, paused: m.paused }));
        expect(now, name).toEqual({ marked: 'before-redraw', reset: null, paused: false });
      });
    }
    await test.step('sound: started after the redraw', async () => {
      expect(await players[1]![1].evaluate((m: HTMLMediaElement) => m.currentTime), 'sound currentTime').toBeGreaterThan(0);
    });
    await test.step('video: started after the redraw as the untouched copy has', async () => {
      if (browserName === 'chromium') {
        expect(await players[0]![1].evaluate((m: HTMLMediaElement) => m.currentTime), 'video currentTime').toBeGreaterThan(0);
        expect(await players[2]![1].evaluate((m: HTMLMediaElement) => m.currentTime), 'untouched copy currentTime').toBeGreaterThan(0);
        return;
      }
      const copyStarted = await startedWithin(players[2]![1]);
      const videoStarted = copyStarted ? await startedWithin(players[0]![1]) : null;
      console.log(`webkit after redraw: untouched copy started ${copyStarted}; video started ${videoStarted}`);
      if (copyStarted) expect(videoStarted, 'video started as the untouched copy did').toBe(true);
    });
    await test.step('sound: still advancing after the redraw, past where it was before it', async () => {
      const sound = await advances(players[1]![1]);
      expect(sound.from, 'sound not reset').toBeGreaterThan(soundBefore);
      expect(sound.to, 'sound advancing').toBeGreaterThan(sound.from);
    });
    await test.step('video: advancing after the redraw as the untouched copy is', async () => {
      const [video, copy] = await Promise.all([advances(players[0]![1]), advances(players[2]![1])]);
      console.log(`${browserName} video after redraw ${JSON.stringify(video)}; untouched copy ${JSON.stringify(copy)}`);
      const moving = (m: { from: number; to: number; paused: boolean }) => !m.paused && m.to !== m.from;
      if (browserName === 'chromium') {
        expect(moving(video), `video ${JSON.stringify(video)}`).toBe(true);
        expect(moving(copy), `copy ${JSON.stringify(copy)}`).toBe(true);
      } else {
        expect(moving(video), `video ${JSON.stringify(video)} vs untouched copy ${JSON.stringify(copy)}`).toBe(moving(copy));
      }
    });
    await expect(chips).toHaveCount(0, WAIT);
    await context.close();
  } finally {
    await agent.close().catch(() => {});
    await browser.close().catch(() => {});
    await removeInboxScratch(scratch);
  }
});

// The test above draws its late picture through `![Later](media/later.png)` too, but 2000 px wide: once captured it is
// asked for as a smaller copy (`?w=1600`), a new URL, so it loaded again by itself. A picture no wider than a message
// keeps its URL, and the window kept it failed until a reload (QA F1 on 0.29.1 and 0.29.2).
test('a small picture named before it is written shows in the open thread without a reload: with the next message, and with no message at all', async ({ browserName }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const scratch = inboxScratch('plannotator-inbox-late-picture-e2e-');
  const root = realpathSync(scratch);
  // The debug log on: the window then marks each try of a failed picture with what asked for it (PictureRetry.tsx).
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_DEBUG: '1' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'late-pictures');
  mkdirSync(join(project, 'media'), { recursive: true });
  const agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
  const browser = browserName === 'webkit' ? await webkit.launch() : await chromium.launch({ args: CHROMIUM_ARGS });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const drawn = (img: Player) => img.evaluate((el: HTMLImageElement) => !el.hidden && el.complete && el.naturalWidth);
    /** What asked for each try of a message's failed pictures since `since` (the page's clock). */
    const triesSince = (message: string, since: number) =>
      page.evaluate(
        ({ message, since }) =>
          performance
            .getEntriesByName('pn:picture-retry')
            .filter((entry) => entry.startTime >= since && (entry as PerformanceMark).detail?.message === message)
            .map((entry) => (entry as PerformanceMark).detail.why as string),
        { message, since },
      );

    await test.step('with the next message: shows when it arrives', async () => {
      const sent = await agent.send({ project_path: project, subject: 'Export chart', body: 'The export chart:\n\n![Export chart](media/late-a.png)' });
      expect(JSON.stringify(sent)).toContain('not_yet');
      await page.goto(`${url}#thread=${sent.thread_id}`);
      await page.evaluate(() => ((window as unknown as { stayed: boolean }).stayed = true));
      const body = page.locator(`[data-message-id="${sent.message_id}"]`);
      await expect(body.locator('[data-image-unavailable]', { hasText: 'Export chart' })).toBeVisible(WAIT);
      // Past the window's second try on its own (about 6 s after the failure), 8 s before its third: what shows it
      // now is the next message.
      await page.waitForTimeout(6500);
      const since = await page.evaluate(() => performance.now());
      writeFileSync(join(project, 'media', 'late-a.png'), PNG);
      const note = await agent.send({ project_path: project, reply_to: sent.message_id as string, body: 'Written now.' });
      await expect(page.locator(`[data-message-id="${note.message_id}"]`)).toBeVisible(WAIT);
      const img = body.locator('img[alt="Export chart"]');
      await expect.poll(() => drawn(img), { timeout: 5000, message: 'drawn soon after the next message' }).toBe(1);
      await expect(body.locator('[data-image-unavailable]')).toHaveCount(0);
      // The first try since the file was written was the new message's: no timer's try came before it (on a slow
      // runner the next timer's try may still follow it).
      expect((await triesSince(sent.message_id as string, since))[0], 'first tried because the thread gained a message').toBe('thread');
      await expect(img).toHaveAttribute('role', 'button');
      expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed), 'no reload').toBe(true);
    });

    await test.step('with no message: shows on its own within 20 s', async () => {
      const sent = await agent.send({ project_path: project, subject: 'Latency chart', body: 'The latency chart:\n\n![Latency chart](media/late-b.png)' });
      await page.goto(`${url}#thread=${sent.thread_id}`);
      await page.evaluate(() => ((window as unknown as { stayed: boolean }).stayed = true));
      const body = page.locator(`[data-message-id="${sent.message_id}"]`);
      await expect(body.locator('[data-image-unavailable]', { hasText: 'Latency chart' })).toBeVisible(WAIT);
      writeFileSync(join(project, 'media', 'late-b.png'), PNG);
      const img = body.locator('img[alt="Latency chart"]');
      await expect.poll(() => drawn(img), { timeout: 20_000, message: 'drawn with no new message' }).toBe(1);
      await expect(body.locator('[data-image-unavailable]')).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed), 'no reload').toBe(true);
    });
    await context.close();
  } finally {
    await agent.close().catch(() => {});
    await browser.close().catch(() => {});
    await removeInboxScratch(scratch);
  }
});
