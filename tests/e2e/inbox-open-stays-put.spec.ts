/**
 * The row you open stays put (design record "inbox-open-stays-put", variant
 * B, approved 2026-10-12; not in this repo), proved in real browsers against
 * the compiled binary, with agents writing through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts):
 *
 * - Desktop (Chromium, 1440 by 900): opening a "New since you looked" row
 *   unbolds it in place, with keyboard focus kept on it, and no frame moves
 *   it; opening the next row moves nothing; an agent's message that arrives
 *   meanwhile waits behind "1 new". Closing the thread widens the list, then,
 *   after the beat, the rows slide (sampled every frame: nothing moves in the
 *   beat, a row passes through positions between where it was and where it
 *   lands, every settle animation and fading copy is gone by the end), focus
 *   lands on the row now in the read row's slot, and the agent's message
 *   still waits for Show.
 * - Reduced motion: the close settles in one frame with no animation.
 * - A phone (WebKit, iPhone 15) and a stacked window (Chromium, 900 px):
 *   Back shows the list exactly as it was left, with focus on the row read;
 *   it settles while the next thread covers it.
 * - A phone and a stacked window: questions an agent asked while the list was
 *   held, read and left with Back, land in Holding up work, never in Quiet.
 * - A stacked window: questions that arrive while the thread is open, seen on
 *   sight, and a thread opened wide whose window narrows to stacked: Back puts
 *   the row in Holding up work, never in Quiet (after Escape, focus on the row).
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * Proof (frames of the settle slowed tenfold, a video of it at full speed,
 * light and dark PNGs) lands in .local/proof/open-stays-put/.
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'open-stays-put');

/** settle.ts: the beat after the list widens, and the slide. */
const BEAT_MS = 160;

const NEWS = ['Search index built', 'Install page links fixed', 'Changelog drafted', 'Docs deploy finished'];

type ProjectKey = 'desk' | 'reduce' | 'phone' | 'stacked' | 'framesDark' | 'framesLight' | 'mouse' | 'held' | 'seen' | 'phoneAsks' | 'stackedAsks' | 'stackedSeen' | 'resized';

interface World {
  root: string;
  env: Record<string, string>;
  url: string;
  agent: SimAgent;
  projects: Record<ProjectKey, { path: string; id: string; threads: string[] }>;
}

let world: World;

async function seed(agent: SimAgent, path: string, key: string): Promise<string[]> {
  const threads: string[] = [];
  for (const [n, subject] of NEWS.entries()) {
    // One agent session per thread, so each message starts its own thread (no name chips).
    const sent = await agent.send({ project_path: path, subject, body: `${subject}. Nothing to answer.`, agent_session: `ses_${key}_${n}` } as Parameters<SimAgent['send']>[0]);
    threads.push(String(sent.thread_id));
    await new Promise((r) => setTimeout(r, 15));
  }
  return threads;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-staysput-e2e-');
  // Never a real agent's CLI: no connection runs (PLANNOTATOR_INBOX_CONNECT=0), and stubs that refuse come first on PATH.
  const stubs = join(root, 'bin');
  mkdirSync(stubs, { recursive: true });
  for (const name of ['claude', 'codex', 'opencode', 'pi', 'gemini', 'cursor-agent', 'amp']) writeFileSync(join(stubs, name), '#!/bin/sh\necho "this stub never runs" >&2\nexit 1\n', { mode: 0o755 });
  const env = { PATH: `${stubs}:${process.env.PATH ?? ''}`, HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const projects = {} as World['projects'];
  for (const key of ['desk', 'reduce', 'phone', 'stacked', 'framesDark', 'framesLight', 'mouse', 'held', 'seen', 'phoneAsks', 'stackedAsks', 'stackedSeen', 'resized'] as const) {
    const path = scratchProject(join(root, 'src'), key === 'desk' ? 'docs-site' : `docs-${key}`);
    const threads = await seed(agent, path, key);
    if (key === 'held') {
      // Newest, so first in New: a thread with a file, for the sidebar #1871 holds closed beside it.
      writeFileSync(join(path, 'notes.md'), '# Notes\n\nThe plan, in short.\n');
      const filed = await agent.send({ project_path: path, subject: 'Notes attached', body: 'The notes are attached.', attachments: ['notes.md'], agent_session: 'ses_held_file' } as Parameters<SimAgent['send']>[0]);
      threads.unshift(String(filed.thread_id));
    }
    projects[key] = { path, id: '', threads };
  }
  const url = started.stdout.trim();
  const list = (await (await fetch(`${url.replace(/\/$/, '')}/api/inbox/projects`)).json()) as { projects: { id: string; root: string }[] };
  for (const project of Object.values(projects)) project.id = list.projects.find((p) => p.root === project.path)!.id;
  world = { root, env, url: url.replace(/\/$/, ''), agent, projects };
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const rowsOf = (page: Page) => page.locator('.ib-listcol .ib-lbody [data-thread-id]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-thread-id')!));
const sectionOf = (page: Page, id: string) =>
  page.locator(`.ib-listcol .ib-lbody [data-thread-id="${id}"]`).evaluateAll((rows) => rows[0]?.closest('[data-section-id]')?.getAttribute('data-section-id') ?? null);
const focused = (page: Page) => page.evaluate(() => document.activeElement?.closest('[data-thread-id]')?.getAttribute('data-thread-id') ?? document.activeElement?.tagName ?? null);
const isBold = (page: Page, id: string) => page.locator(`.ib-listcol .ib-lbody [data-thread-id="${id}"]`).evaluate((r) => r.classList.contains('ib-u'));

/** Open a row the keyboard's way, and wait for the look to be recorded and the list read again. */
async function openWithKeyboard(page: Page, id: string): Promise<void> {
  const row = page.locator(`.ib-listcol .ib-lbody [data-thread-id="${id}"]`);
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await expect.poll(() => isBold(page, id)).toBe(false);
}

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
}

interface Frame {
  t: number;
  order: string[];
  tops: Record<string, number>;
  anims: number;
  ghosts: number;
  /** A thread pane is on screen. */
  pane: boolean;
  listWidth: number;
}

/** Sample every frame for `ms` from now (rows' tops, settle animations, fading copies). */
async function sampleFrames(page: Page, ms: number): Promise<void> {
  await page.evaluate((duration) => {
    const frames: Frame[] = [];
    (window as unknown as { __frames: Frame[] }).__frames = frames;
    const start = performance.now();
    const tick = () => {
      const rows = [...document.querySelectorAll<HTMLElement>('.ib-listcol .ib-lbody > .ib-group > .ib-rw[data-row]')];
      frames.push({
        t: performance.now() - start,
        order: rows.map((r) => r.dataset.row!),
        tops: Object.fromEntries(rows.map((r) => [r.dataset.row!, r.getBoundingClientRect().top])),
        anims: document.getAnimations().filter((a) => a.id === 'ib-settle' && a.playState === 'running').length,
        ghosts: document.querySelectorAll('.ib-settle-ghost').length,
        pane: document.querySelector('section.ib-pane') !== null,
        listWidth: document.querySelector('.ib-listcol')?.getBoundingClientRect().width ?? 0,
      });
      if (performance.now() - start < duration) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, ms);
}

const framesOf = (page: Page) => page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames);

test('desktop: opening rows moves nothing; closing settles with a slide; agent news waits for Show', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', recordVideo: { dir: proofDir, size: { width: 1440, height: 900 } } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { id, threads, path } = world.projects.desk;
  await page.goto(`${world.url}/#project=${id}`);
  await expect(page.locator('[data-section-id="new"] [data-thread-id]')).toHaveCount(4);
  const before = await rowsOf(page);
  await shot(page, '01-before-open');

  // Open the top row: sample every frame for 600 ms; it never leaves New, the order never changes.
  const first = before[0]!;
  await sampleFrames(page, 600);
  await openWithKeyboard(page, first);
  await page.waitForTimeout(650);
  for (const frame of await framesOf(page)) expect(frame.order.length === 0 || JSON.stringify(frame.order) === JSON.stringify(before)).toBe(true);
  expect(await sectionOf(page, first)).toBe('new');
  expect(await focused(page)).toBe(first);
  await expect(page.locator(`.ib-lbody [data-thread-id="${first}"]`)).toHaveAttribute('aria-current', 'true');
  await shot(page, '02-opened-stays-unbold');

  // The next row: nothing moves.
  const second = before[1]!;
  await openWithKeyboard(page, second);
  expect(await rowsOf(page)).toEqual(before);
  expect(await sectionOf(page, first)).toBe('new');

  // An agent writes while the person reads: it waits behind "1 new".
  const late = await world.agent.send({ project_path: path, subject: 'Payout export', body: 'The payout export is ready to review.', agent_session: 'ses_desk_late' } as Parameters<SimAgent['send']>[0]);
  await expect(page.locator('[data-inbox-notice]')).toContainText('1 new in docs-site');
  expect(await rowsOf(page)).toEqual(before);
  await shot(page, '03-two-read-and-an-agent-wrote');

  // Close: sample every frame of the settle.
  await sampleFrames(page, 1000);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1100);
  const sampled = await framesOf(page);
  // From the first frame after the close (the pane gone), in ms since then.
  const closedAt = sampled.find((f) => !f.pane)!.t;
  const frames = sampled.filter((f) => !f.pane).map((f) => ({ ...f, t: f.t - closedAt }));
  // In the beat the list has widened and nothing moves.
  for (const frame of frames.filter((f) => f.t < BEAT_MS - 30)) {
    expect(frame.anims).toBe(0);
    if (frame.order.length) expect(frame.order).toEqual(before);
  }
  // Then the rows slide: settle animations run, and a row passes between where it was and where it lands.
  expect(frames.some((f) => f.anims > 0)).toBe(true);
  const last = frames.at(-1)!;
  const moved = last.order.find((rowId) => {
    const from = frames.find((f) => f.t < BEAT_MS - 30 && f.tops[rowId] !== undefined)?.tops[rowId];
    return from !== undefined && Math.abs(from - last.tops[rowId]!) > 20;
  })!;
  expect(moved, 'a row that changed place').toBeTruthy();
  const from = frames.find((f) => f.t < BEAT_MS - 30 && f.tops[moved] !== undefined)!.tops[moved]!;
  const to = last.tops[moved]!;
  const between = frames.filter((f) => f.tops[moved] !== undefined && Math.min(from, to) + 2 < f.tops[moved]! && f.tops[moved]! < Math.max(from, to) - 2);
  expect(between.length, 'frames between the old place and the new one').toBeGreaterThan(2);
  expect(frames.some((f) => f.ghosts > 0), 'the read rows fade where they were').toBe(true);
  expect(last.anims).toBe(0);
  expect(last.ghosts).toBe(0);
  // Settled: the two read rows are in folded Quiet, focus is on the row now in the slot, the agent's message still waits.
  expect(await sectionOf(page, first)).toBeNull();
  expect(await sectionOf(page, second)).toBeNull();
  const slot = before.slice(before.indexOf(second) + 1).find((rowId) => last.order.includes(rowId))!;
  expect(await focused(page)).toBe(slot);
  await expect(page.locator('[data-inbox-notice]')).toContainText('1 new in docs-site');
  expect(await sectionOf(page, String(late.thread_id))).toBeNull();
  await shot(page, '04-after-close');

  // Show from the keyboard brings the agent's message in; its line goes away and focus goes to that row,
  // whose Mark read action shows for the keyboard.
  await page.locator('[data-inbox-notice]').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => sectionOf(page, String(late.thread_id))).toBe('new');
  await expect.poll(() => focused(page)).toBe(String(late.thread_id));
  await expect(page.locator(`.ib-lbody [data-row="${late.thread_id}"] [data-row-mark-read]`)).toBeVisible();
  expect(errors).toEqual([]);
  const video = page.video();
  await context.close();
  if (video) renameSync(await video.path(), join(proofDir, 'settle-full-speed.webm'));
});

test('desktop: the settle frame by frame, slowed tenfold', async ({ browser }: { browser: Browser }) => {
  for (const scheme of ['dark', 'light'] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    const { id } = world.projects[scheme === 'dark' ? 'framesDark' : 'framesLight'];
    await page.goto(`${world.url}/#project=${id}`);
    await expect(page.locator('[data-section-id="new"] [data-thread-id]')).toHaveCount(4);
    const news = await rowsOf(page);
    await openWithKeyboard(page, news[0]!);
    await openWithKeyboard(page, news[1]!);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.1 });
    await page.keyboard.press('Escape');
    await page.screenshot({ path: join(proofDir, `frame-${scheme}-0-widened.png`) });
    await page.waitForTimeout(BEAT_MS + 40);
    for (const [n, at] of [400, 900, 1500, 2200].entries()) {
      await page.waitForTimeout(n === 0 ? at : at - [400, 900, 1500, 2200][n - 1]!);
      await page.screenshot({ path: join(proofDir, `frame-${scheme}-${n + 1}-slide-${at}ms.png`) });
    }
    await context.close();
  }
});

test('reduced motion: the close settles in one frame, with nothing animated', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const { id } = world.projects.reduce;
  await page.goto(`${world.url}/#project=${id}`);
  await expect(page.locator('[data-section-id="new"] [data-thread-id]')).toHaveCount(4);
  const first = (await rowsOf(page))[0]!;
  await openWithKeyboard(page, first);
  await sampleFrames(page, 500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  const frames = (await framesOf(page)).filter((f) => !f.pane);
  expect(frames.length).toBeGreaterThan(5);
  expect(frames.every((f) => f.anims === 0 && f.ghosts === 0)).toBe(true);
  // Settled from the first frame after the close.
  expect(frames.every((f) => f.order.length > 0 && !f.order.includes(first))).toBe(true);
  expect(await focused(page)).not.toBe('BODY');
  await context.close();
});

for (const layout of [
  { name: 'phone (WebKit, iPhone 15)', key: 'phone' as const, back: '[data-phone-back]' },
  { name: 'stacked window (Chromium, 900 px)', key: 'stacked' as const, back: '[data-stack-back]' },
]) {
  test(`${layout.name}: Back shows the list as left; it settles while the next thread covers it`, async ({ browser }: { browser: Browser }) => {
    let own: Browser | null = null;
    let context: BrowserContext;
    if (layout.key === 'phone') {
      own = await webkit.launch({ args: [] });
      context = await own.newContext({ ...devices['iPhone 15'], colorScheme: 'dark' });
    } else {
      context = await browser.newContext({ viewport: { width: 900, height: 900 }, colorScheme: 'dark' });
    }
    try {
      const page = await context.newPage();
      const { id } = world.projects[layout.key];
      await page.goto(`${world.url}/#project=${id}`);
      await expect(page.locator('[data-section-id="new"] [data-thread-id]').first()).toBeVisible();
      const before = await rowsOf(page);
      const news = await page.locator('[data-section-id="new"] [data-thread-id]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-thread-id')!));
      expect(news.length).toBeGreaterThanOrEqual(2);
      const [first, second] = news;
      // A tap on a phone, the mouse on the stacked window (a keyboard path is the desktop test's).
      if (layout.key === 'phone') await page.locator(`.ib-lbody [data-thread-id="${first}"]`).tap();
      else await page.locator(`.ib-lbody [data-thread-id="${first}"]`).click();
      await expect(page.locator('section.ib-pane')).toBeVisible();
      await expect.poll(() => isBold(page, first!)).toBe(false);
      await shot(page, `05-${layout.key}-thread`);
      await page.locator(`section.ib-pane ${layout.back}`).click();
      await expect(page.locator('section.ib-pane')).toHaveCount(0);
      await page.waitForTimeout(BEAT_MS + 300);
      // As left: same order, the read row in New, no longer bold.
      expect(await rowsOf(page)).toEqual(before);
      expect(await sectionOf(page, first!)).toBe('new');
      expect(await isBold(page, first!)).toBe(false);
      // A tap hands no row focus. The stacked window returns focus to the row (as it did before), but a
      // mouse Back is no keyboard focus: the row's Mark read action stays hidden.
      if (layout.key === 'phone') expect(await focused(page)).not.toBe(first);
      else {
        expect(await focused(page)).toBe(first);
        await page.mouse.move(2, 450);
        await expect(page.locator('.ib-lbody [data-row-mark-read]:visible')).toHaveCount(0);
      }
      await shot(page, `06-${layout.key}-after-back`);
      // The next thread covers the list, and the first read row settles behind it.
      if (layout.key === 'phone') await page.locator(`.ib-lbody [data-thread-id="${second}"]`).tap();
      else await page.locator(`.ib-lbody [data-thread-id="${second}"]`).click();
      await expect(page.locator('section.ib-pane')).toBeVisible();
      await expect.poll(() => isBold(page, second!)).toBe(false);
      await page.locator(`section.ib-pane ${layout.back}`).click();
      await expect(page.locator('section.ib-pane')).toHaveCount(0);
      expect(await sectionOf(page, first!)).toBeNull();
      expect(await sectionOf(page, second!)).toBe('new');
      await shot(page, `07-${layout.key}-after-second-back`);
    } finally {
      await context.close();
      await own?.close();
    }
  });
}

/** Four open questions, each with Stakes before its choices, then Recommended and Holds up after them (the shape the owner saw land in Quiet). */
const HOLDING_QUESTIONS = [
  'I read the channel code. Four decisions before I go on.',
  ...[1, 2, 3, 4].flatMap((n) => [
    '',
    ':::question',
    `Which wire format should shape ${n} use?`,
    `Stakes: shape ${n} decides the format every client reads.`,
    '',
    '- [ ] JSON lines',
    '- [ ] One JSON document',
    'Recommended: JSON lines',
    'Holds up: the channel, and with it shapes 2 and 3',
    ':::',
  ]),
].join('\n');

for (const layout of [
  { name: 'phone (WebKit, iPhone 15)', key: 'phoneAsks' as const, back: '[data-phone-back]' },
  { name: 'stacked window (Chromium, 900 px)', key: 'stackedAsks' as const, back: '[data-stack-back]' },
]) {
  test(`${layout.name}: questions an agent asked while the list was held, read and left with Back, put the row in Holding up work, never in Quiet`, async ({ browser }: { browser: Browser }) => {
    let own: Browser | null = null;
    let context: BrowserContext;
    if (layout.key === 'phoneAsks') {
      own = await webkit.launch({ args: [] });
      context = await own.newContext({ ...devices['iPhone 15'], colorScheme: 'dark' });
    } else {
      context = await browser.newContext({ viewport: { width: 900, height: 900 }, colorScheme: 'dark' });
    }
    const open = async (page: Page, id: string) => {
      if (layout.key === 'phoneAsks') await page.locator(`.ib-lbody [data-thread-id="${id}"]`).tap();
      else await page.locator(`.ib-lbody [data-thread-id="${id}"]`).click();
      await expect(page.locator('section.ib-pane')).toBeVisible();
    };
    const back = async (page: Page) => {
      await page.locator(`section.ib-pane ${layout.back}`).click();
      await expect(page.locator('section.ib-pane')).toHaveCount(0);
      await page.waitForTimeout(BEAT_MS + 300);
    };
    try {
      const page = await context.newPage();
      const { id, path, threads } = world.projects[layout.key];
      // The newest thread (the seed's last), top of New, and the session that wrote it.
      const first = threads[threads.length - 1]!;
      await page.goto(`${world.url}/#project=${id}`);
      await expect(page.locator(`[data-section-id="new"] [data-thread-id="${first}"]`)).toBeVisible();
      // Read, then Back: the list as left, the row in New, no longer bold.
      await open(page, first);
      await expect.poll(() => isBold(page, first)).toBe(false);
      await back(page);
      expect(await sectionOf(page, first)).toBe('new');
      // The agent asks four questions there that hold up work: the list holds still, the news waits behind "1 new".
      await world.agent.send({ project_path: path, reply_to: first, body: HOLDING_QUESTIONS, agent_session: `ses_${layout.key}_${NEWS.length - 1}` } as Parameters<SimAgent['send']>[0]);
      await expect(page.locator('[data-inbox-notice]')).toContainText('1 new');
      expect(await sectionOf(page, first)).toBe('new');
      // The person opens it and reads the questions (the look is recorded), then goes Back.
      await open(page, first);
      await expect(page.locator('section.ib-pane fieldset[data-question-key]')).toHaveCount(4);
      await expect.poll(() => serverRow(first)).toEqual({ section: 'holding', unseen: 0 });
      await back(page);
      // Where its open questions put it: Holding up work, as the server says; not folded away in Quiet.
      expect(await sectionOf(page, first)).toBe('holding');
      // The stacked window's mouse Back hands focus to the row (#1866), which keeps it as the row moves; a phone's tap hands none.
      if (layout.key === 'stackedAsks') expect(await focused(page)).toBe(first);
      else expect(await focused(page)).not.toBe(first);
      await shot(page, `08-${layout.key}-questions-read-after-back`);
    } finally {
      await context.close();
      await own?.close();
    }
  });
}

/** The thread's row as the server reads it. */
async function serverRow(id: string): Promise<{ section: string; unseen: number } | null> {
  const list = (await (await fetch(`${world.url}/api/inbox/threads?archived=exclude`)).json()) as { sections: { id: string; threads: { thread_id: string; unseen: number }[] }[] };
  for (const section of list.sections) for (const row of section.threads) if (row.thread_id === id) return { section: section.id, unseen: row.unseen };
  return null;
}

/** The group a row is drawn in, unfolding Quiet first when the row is not drawn (folded Quiet draws no rows). */
async function drawnIn(page: Page, id: string): Promise<string | null> {
  const section = await sectionOf(page, id);
  if (section) return section;
  const band = page.locator('.ib-lbody [data-section-id="quiet"] button.ib-band');
  if ((await band.count()) === 1 && (await band.getAttribute('aria-expanded')) !== 'true') await band.click();
  return sectionOf(page, id);
}

// Chromium only: seen on sight needs the page focused and visible, which headless WebKit does not report.
test('stacked window (Chromium, 900 px): questions that arrive while the thread is open, seen on sight, put the row in Holding up work on a keyboard Back, focus with it, never in Quiet', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 900, height: 900 }, colorScheme: 'dark' });
  try {
    const page = await context.newPage();
    const { id, path, threads } = world.projects.stackedSeen;
    const first = threads[threads.length - 1]!;
    const second = threads[threads.length - 2]!;
    const open = async (thread: string) => {
      await page.locator(`.ib-lbody [data-thread-id="${thread}"]`).click();
      await expect(page.locator('section.ib-pane')).toBeVisible();
    };
    const back = async () => {
      await page.locator('section.ib-pane [data-stack-back]').click();
      await expect(page.locator('section.ib-pane')).toHaveCount(0);
      await page.waitForTimeout(BEAT_MS + 300);
    };
    await page.goto(`${world.url}/#project=${id}`);
    await expect(page.locator(`[data-section-id="new"] [data-thread-id="${first}"]`)).toBeVisible();
    // Read the first, Back; read the second (the first settles behind it, to Quiet), Back.
    await open(first);
    await expect.poll(() => serverRow(first)).toEqual({ section: 'quiet', unseen: 0 });
    await back();
    await open(second);
    await expect.poll(() => serverRow(second)).toEqual({ section: 'quiet', unseen: 0 });
    await back();
    expect(await drawnIn(page, first)).toBe('quiet');
    // Open the first from Quiet; the agent asks there while it is open; the questions are seen on sight.
    await open(first);
    await world.agent.send({ project_path: path, reply_to: first, body: HOLDING_QUESTIONS, agent_session: `ses_stackedSeen_${NEWS.length - 1}` } as Parameters<SimAgent['send']>[0]);
    await expect(page.locator('section.ib-pane fieldset[data-question-key]')).toHaveCount(4);
    await page.locator('section.ib-pane fieldset[data-question-key]').first().scrollIntoViewIfNeeded();
    await expect.poll(() => serverRow(first), { timeout: 15_000 }).toEqual({ section: 'holding', unseen: 0 });
    // Back with the keyboard (Escape).
    await page.keyboard.press('Escape');
    await expect(page.locator('section.ib-pane')).toHaveCount(0);
    await page.waitForTimeout(BEAT_MS + 300);
    // Where its open questions put it, as the server says; not left drawn in Quiet. Focus moved with the row
    // (redrawn in Holding up work), never dropped to the page.
    expect(await sectionOf(page, first)).toBe('holding');
    expect(await focused(page)).toBe(first);
    await shot(page, '09-stackedSeen-arrival-while-open-after-back');
  } finally {
    await context.close();
  }
});

test('a thread opened wide, its window narrowed to stacked while it is open: Back puts a row with questions in Holding up work, never in Quiet', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    const { id, path, threads } = world.projects.resized;
    const first = threads[threads.length - 1]!;
    await page.goto(`${world.url}/#project=${id}`);
    await expect(page.locator(`[data-section-id="new"] [data-thread-id="${first}"]`)).toBeVisible();
    // Read it wide and close it: it settles to Quiet.
    await page.locator(`.ib-lbody [data-thread-id="${first}"]`).click();
    await expect(page.locator('section.ib-pane')).toBeVisible();
    await expect.poll(() => serverRow(first)).toEqual({ section: 'quiet', unseen: 0 });
    await expect.poll(() => isBold(page, first)).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.locator('section.ib-pane')).toHaveCount(0);
    await page.waitForTimeout(BEAT_MS + 300);
    expect(await drawnIn(page, first)).toBe('quiet');
    // The agent asks there: held behind "1 new". The person opens it from Quiet, wide, and reads it.
    await world.agent.send({ project_path: path, reply_to: first, body: HOLDING_QUESTIONS, agent_session: `ses_resized_${NEWS.length - 1}` } as Parameters<SimAgent['send']>[0]);
    await expect(page.locator('[data-inbox-notice]')).toContainText('1 new');
    await page.locator(`.ib-lbody [data-thread-id="${first}"]`).click();
    await expect(page.locator('section.ib-pane fieldset[data-question-key]')).toHaveCount(4);
    await expect.poll(() => serverRow(first)).toEqual({ section: 'holding', unseen: 0 });
    // The window narrows: the thread now covers the list. Back.
    await page.setViewportSize({ width: 900, height: 900 });
    await page.locator('section.ib-pane [data-stack-back]').click();
    await expect(page.locator('section.ib-pane')).toHaveCount(0);
    await page.waitForTimeout(BEAT_MS + 300);
    expect(await sectionOf(page, first)).toBe('holding');
    // A mouse Back in a stacked window hands focus to the row (#1866); redrawn in Holding up work, it keeps it.
    expect(await focused(page)).toBe(first);
    await shot(page, '10-resized-after-back');
  } finally {
    await context.close();
  }
});

test('desktop, the mouse: a close hands no row focus, no Mark read action shows, and E marks nothing', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const marked: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/read')) marked.push(request.url());
  });
  const { id, threads } = world.projects.mouse;
  await page.goto(`${world.url}/#project=${id}`);
  await expect(page.locator('[data-section-id="new"] [data-thread-id]')).toHaveCount(4);
  // Clicked, never by position: the row opened is named.
  await page.locator(`.ib-lbody [data-thread-id="${threads[0]}"]`).click();
  await expect.poll(() => isBold(page, threads[0]!)).toBe(false);
  await page.locator('section.ib-pane [aria-label="Close the thread"]').click();
  await expect(page.locator('section.ib-pane')).toHaveCount(0);
  await expect.poll(() => sectionOf(page, threads[0]!)).toBeNull();
  await page.mouse.move(2, 450);
  await expect(page.locator('.ib-lbody [data-row-mark-read]:visible')).toHaveCount(0);
  expect(threads).not.toContain(await focused(page));
  await page.keyboard.press('e');
  await page.waitForTimeout(300);
  expect(marked).toEqual([]);
  await context.close();
});

// A plain update the person opened: Quiet on the server (the look), still drawn in New while the thread is
// open. Mark read stays on it (the header, the row's hover action, E) and moves the row to Quiet now.
test('desktop: a seen update held in New keeps Mark read; it moves the row to Quiet now, and Undo puts it back', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const written: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/(read|unread)$/.test(request.url())) written.push(request.url());
  });
  const { id } = world.projects.seen;
  await page.goto(`${world.url}/#project=${id}`);
  await expect(page.locator('[data-section-id="new"] [data-thread-id]')).toHaveCount(4);
  const before = await rowsOf(page);
  const first = before[0]!;
  const row = page.locator(`.ib-lbody [data-thread-id="${first}"]`);
  const header = page.locator('section.ib-pane [data-mark-read]');
  const quietCount = page.locator('[data-section-id="quiet"] .ib-n');
  await openWithKeyboard(page, first);
  expect(await sectionOf(page, first)).toBe('new');
  await page.locator(`.ib-lbody [data-row="${first}"]`).hover();
  await shot(page, 'seen-held-01-opened');
  await expect(header).toBeEnabled();
  await expect(page.locator(`.ib-lbody [data-row="${first}"] [data-row-mark-read]`)).toBeVisible();

  // The header: the row moves to Quiet now, the toast says so with Undo.
  await header.click();
  await expect(row).toHaveCount(0);
  await expect(quietCount).toHaveText('1');
  await expect(page.locator('[data-inbox-toast]')).toContainText('Moved to Quiet');
  await expect(page.locator('[data-toast-undo]')).toBeVisible();
  await expect(header).toBeDisabled();
  await shot(page, 'seen-held-02-moved');
  // Undo: back between the same neighbours.
  await page.locator('[data-toast-undo]').click();
  await expect.poll(() => sectionOf(page, first)).toBe('new');
  expect(await rowsOf(page)).toEqual(before);
  await expect(header).toBeEnabled();
  await shot(page, 'seen-held-03-undone');

  // E, then Z.
  await page.locator('section.ib-pane h2.ib-subject').click();
  await page.keyboard.press('e');
  await expect(row).toHaveCount(0);
  await page.keyboard.press('z');
  await expect.poll(() => sectionOf(page, first)).toBe('new');
  expect(await rowsOf(page)).toEqual(before);

  // The row's hover action. It is drawn only while the mouse is on the row (display: none
  // otherwise), and an action waits with no time limit: on CI this test twice hung here to its
  // 4-minute timeout (the shots stop at 03-undone), the action never shown to the click, as when
  // the row is still settling back from the Undo as the mouse arrives. Hover until the action
  // shows (each try bounded, all tries within 15 s: toPass has no limit of its own), then click it.
  const rowMarkRead = page.locator(`.ib-lbody [data-row="${first}"] [data-row-mark-read]`);
  await expect(async () => {
    await page.locator(`.ib-lbody [data-row="${first}"]`).hover({ timeout: 2_000 });
    await expect(rowMarkRead).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await rowMarkRead.click({ timeout: 5_000 });
  await expect(row).toHaveCount(0);
  await expect(quietCount).toHaveText('1');

  // Nothing was written (the thread was already Quiet), and the close settles it where it is.
  expect(written).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.locator('section.ib-pane')).toHaveCount(0);
  await page.waitForTimeout(BEAT_MS + 400);
  await expect(row).toHaveCount(0);
  await expect(quietCount).toHaveText('1');
  expect(errors).toEqual([]);
  await context.close();
});

test('a window of about 1000 px with the sidebar held closed beside a file: the rows slide only once the sidebar is back, from the final column width', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const { id, threads } = world.projects.held;
  const filed = threads[0]!;
  await page.goto(`${world.url}/#project=${id}`);
  await expect(page.locator(`.ib-lbody [data-thread-id="${filed}"]`)).toBeVisible();
  await page.locator(`.ib-lbody [data-thread-id="${filed}"]`).click();
  await page.locator('section.ib-pane [data-attachment-name="notes.md"]').first().click();
  await page.locator('section.ib-pane [data-file-back]').click();
  // The file closed; the list is beside the thread, the sidebar held closed.
  await expect(page.locator('.ib-listcol')).toBeVisible();
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await page.waitForTimeout(700);
  await sampleFrames(page, 1600);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1700);
  const frames = (await framesOf(page)).filter((f) => !f.pane);
  const last = frames.at(-1)!;
  const firstSlide = frames.find((f) => f.anims > 0);
  expect(firstSlide, 'the rows slid').toBeTruthy();
  // The slide starts from the column's final width: the sidebar's spring is over.
  expect(Math.abs(firstSlide!.listWidth - last.listWidth)).toBeLessThan(1.5);
  expect(await sectionOf(page, filed)).toBeNull();
  await context.close();
});
