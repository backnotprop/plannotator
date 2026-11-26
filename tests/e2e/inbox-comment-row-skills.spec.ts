/**
 * The `/` skill list in an image's and a film's comment row (the owner: "calling skills from floating comment box is
 * something I want"), proved in a real browser against the compiled binary. Nothing is mocked: `plannotator inbox
 * --background` under a temp data dir and a scratch HOME holding two global skills (one human-only), an agent that
 * attaches a picture and a film (recorded here by Playwright, as inbox-video.spec.ts does) through
 * `plannotator inbox mcp`.
 *
 * Proves, on a computer (1440×900) and a phone (390×844): the empty row is the height it was; typing `/` in the
 * image row and in the video row opens the skill list over the window; a pick writes the skill's name, painted, with
 * "Includes skill instructions" for the human-only one; the video row still pauses the film and pins the moment;
 * Comment keeps the words; and the reply that carries those comments shows the Skills line, and the agent reads the
 * skill's instructions in it.
 *
 * Whole-window shots, light and dark, land in .local/proof/comment-row-skills/ (PLANNOTATOR_E2E_PROOF_DIR).
 * CI runs it; build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-comment-row-skills.spec.ts`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { png } from './phone-touch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'comment-row-skills');

/** A page that changes every frame, so the film has moments to pin. */
const FILM_PAGE = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;font:600 54px system-ui,sans-serif;color:#fff}
body{display:flex;align-items:center;justify-content:center;background:#1e3a5f}
#t{font-variant-numeric:tabular-nums}small{display:block;font-size:20px;font-weight:500;opacity:.8}
</style><body><div><small>harbor walkthrough</small><span id="t">0.0 s</span></div>
<script>const start=performance.now();function tick(){const s=(performance.now()-start)/1000;
document.getElementById('t').textContent=s.toFixed(1)+' s';requestAnimationFrame(tick)}tick();</script>`;

interface World {
  url: string;
  project: string;
  agent: SimAgent;
}

let world: World;

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

async function videoReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('video[data-video-player]');
    return !!video && video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0;
  }, undefined, { timeout: 30_000 });
}

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

const paused = (page: Page) => page.evaluate(() => document.querySelector<HTMLVideoElement>('video[data-video-player]')!.paused);

/** The thread with the picture and the film, and their ids. */
async function seed(subject: string): Promise<{ threadId: string; image: string; film: string }> {
  const sent = await world.agent.send({
    project_path: world.project,
    subject,
    body: 'The checkout screen and the walkthrough film, for your notes.',
    attachments: ['shots/checkout.png', 'film/walkthrough.webm'],
  });
  const files = sent.attachments as { id: string; kind: string }[];
  return { threadId: String(sent.thread_id), image: files.find((f) => f.kind === 'image')!.id, film: files.find((f) => f.kind === 'video')!.id };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-comment-row-skills-');
  const dataDir = join(root, 'data');
  // The list reads the global skill folders under HOME: only this scratch HOME's.
  const skill = (name: string, description: string, humanOnly: boolean) => {
    const dir = join(root, '.claude', 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${humanOnly ? 'disable-model-invocation: true\n' : ''}---\n\n# ${name}\n\nRead the comment back in one sentence before you change anything.\n`);
  };
  skill('readback', 'Read the request back before acting on it', false);
  skill('write-better', 'Tighten the words on the screen', true);
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    CLAUDE_CONFIG_DIR: join(root, '.claude'),
    CODEX_HOME: join(root, '.codex'),
    XDG_CONFIG_HOME: join(root, '.config'),
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    NO_ANON_PING: '1',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const project = scratchProject(join(root, 'src'), 'harbor');
  mkdirSync(join(project, 'shots'));
  writeFileSync(join(project, 'shots', 'checkout.png'), png(1600, 1000, [60, 120, 200]));
  mkdirSync(join(project, 'film'));
  const recorder = await browser.newContext({ viewport: { width: 640, height: 360 }, recordVideo: { dir: join(root, 'recordings'), size: { width: 640, height: 360 } } });
  const recording = await recorder.newPage();
  await recording.setContent(FILM_PAGE);
  await recording.waitForTimeout(4200);
  const video = recording.video()!;
  await recorder.close();
  copyFileSync(await video.path(), join(project, 'film', 'walkthrough.webm'));
  world = { url: started.stdout.trim(), project, agent: await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' }) };
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

let sentThread = '';

test('a computer: / in the image row and the video row lists the skills; the reply shows the Skills line', async ({ browser }: { browser: Browser }) => {
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { threadId, image, film } = await seed('Checkout notes');
    sentThread = threadId;
    await page.goto(`${world.url}#thread=${threadId}`);
    await page.locator(`button[data-attachment-id="${image}"]`).click();
    const pane = page.locator(`[data-attachment-pane="${image}"]`);
    const field = pane.locator('[data-image-composer] textarea');
    await expect(field).toBeVisible();
    // Empty, the row is the one-line field it was (34 px), with its words.
    await expect(field).toHaveAttribute('placeholder', 'Comment on this image…');
    const empty = (await field.boundingBox())!;
    expect(empty.height).toBeGreaterThan(33);
    expect(empty.height).toBeLessThan(36);

    await field.click();
    await page.keyboard.type('/');
    const menu = page.locator('[data-skill-menu]');
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-skill-item="readback"]')).toBeVisible();
    await expect(menu.locator('[data-skill-item="write-better"]')).toBeVisible();
    const imageMenuWidth = (await menu.boundingBox())!.width;
    await shot(page, '1-image-menu');

    await menu.locator('[data-skill-item="write-better"]').click();
    await expect(menu).toHaveCount(0);
    await expect(field).toHaveValue('/write-better ');
    await expect(pane.locator('[data-image-composer] [data-skill-ref-token="write-better"]')).toBeVisible();
    await expect(pane.locator('[data-image-composer] [data-skill-human-only-notice]')).toContainText('Includes skill instructions');
    await page.keyboard.type('the total line is cut off.');
    await shot(page, '2-image-chip');
    await pane.locator('[data-image-comment-save]').click();
    await expect(field).toHaveValue('');
    await pane.getByRole('button', { name: /^Close / }).click();

    await page.locator(`button[data-attachment-id="${film}"]`).click();
    const filmPane = page.locator(`[data-attachment-pane="${film}"]`);
    await videoReady(page);
    await seekTo(page, 1.6);
    const row = filmPane.locator('[data-video-composer] textarea');
    await row.click();
    await page.keyboard.type('/');
    await expect(menu).toBeVisible();
    // The first key paused the film and pinned the moment, as typing always did.
    expect(await paused(page)).toBe(true);
    await expect(filmPane.locator('[data-video-composer] [data-video-time]')).toHaveAttribute('data-pinned', '');
    // The film's row also holds the time chip and the frame: its list still spans the card, as wide as the
    // picture's, so a skill's whole name reads (it was cut to "write-be…" at the field's width).
    const videoMenuWidth = (await menu.boundingBox())!.width;
    expect(videoMenuWidth).toBeGreaterThanOrEqual(imageMenuWidth - 1);
    expect(videoMenuWidth).toBeGreaterThanOrEqual(280);
    const name = menu.locator('[data-skill-item="write-better"] [data-skill-item-part="name"]');
    await expect(name).toBeVisible();
    const cut = await name.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(cut.scroll).toBeLessThanOrEqual(cut.client);
    await shot(page, '3-video-menu');
    await menu.locator('[data-skill-item="readback"]').click();
    await expect(row).toHaveValue('/readback ');
    await page.keyboard.type('the intro runs long.');
    await filmPane.locator('[data-video-comment-save]').click();
    await expect(row).toHaveValue('');
    await filmPane.getByRole('button', { name: /^Close / }).click();

    await page.locator('.ib-pfoot').getByRole('button', { name: 'Edit draft' }).click();
    await page.getByRole('textbox', { name: 'Reply to Claude Code' }).fill('Two notes on the files.');
    await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
    const reply = await world.agent.nextReply(threadId, 40);
    const body = reply.body as string;
    // The comments' skills reach the agent: the human-only one with its instructions.
    expect(body).toContain('/write-better the total line is cut off.');
    expect(body).toContain('Read the comment back in one sentence before you change anything.');
    const line = page.locator('[data-skills-line]').last();
    await expect(line).toContainText('write-better');
    await expect(line).toContainText('readback');
    await line.scrollIntoViewIfNeeded();
    await shot(page, '4-sent-skills-line');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('a phone: the full-screen comment card takes / in the image row and the video row', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' });
  const page = await context.newPage();
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { threadId, image, film } = await seed('Checkout notes, on the go');
    await page.goto(`${world.url}#thread=${threadId}&file=${image}&view=full`);
    const card = page.locator('[data-fcomp]');
    await card.waitFor();
    await page.locator('[data-fcomp-mode="comment"]').tap();
    const field = card.locator('[data-image-composer] textarea');
    await expect(field).toBeVisible();
    const empty = (await field.boundingBox())!;
    expect(empty.height).toBeGreaterThan(43);
    expect(empty.height).toBeLessThan(47);
    await field.tap();
    await page.keyboard.type('/');
    const menu = page.locator('[data-skill-menu]');
    await expect(menu).toBeVisible();
    await shot(page, 'phone-1-image-menu');
    await menu.locator('[data-skill-item="write-better"]').tap();
    await expect(field).toHaveValue('/write-better ');
    await expect(card.locator('[data-image-composer] [data-skill-ref-token="write-better"]')).toBeVisible();
    await page.keyboard.type('the button is too low.');
    await shot(page, 'phone-2-image-chip');
    await card.locator('[data-image-comment-save]').tap();
    await expect(field).toHaveValue('');

    await page.goto('about:blank');
    await page.goto(`${world.url}#thread=${threadId}&file=${film}&view=full`);
    await card.waitFor();
    await videoReady(page);
    await seekTo(page, 2.1);
    await page.locator('[data-fcomp-mode="comment"]').tap();
    const row = card.locator('[data-video-composer] textarea');
    // A tap in the field pauses the film and pins the moment, as before.
    await row.tap();
    await expect(card.locator('[data-video-composer] [data-video-time]')).toHaveAttribute('data-pinned', '');
    expect(await paused(page)).toBe(true);
    await page.keyboard.type('/');
    await expect(menu).toBeVisible();
    await shot(page, 'phone-3-video-menu');
    await menu.locator('[data-skill-item="readback"]').tap();
    await expect(row).toHaveValue('/readback ');

    // The computer's sent reply, on the phone: the Skills line under it.
    await page.goto('about:blank');
    await page.goto(`${world.url}#thread=${sentThread}`);
    const line = page.locator('[data-skills-line]').last();
    await expect(line).toContainText('write-better');
    await line.scrollIntoViewIfNeeded();
    await shot(page, 'phone-4-sent-skills-line');
  } finally {
    await context.close();
  }
});
