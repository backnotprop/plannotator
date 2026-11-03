/**
 * The skill (/) list in the reply box is always whole on screen, proved in
 * WebKit as an iPhone with the keyboard simulated (the owner's report: a
 * thread open on an iPhone, the keyboard up, `/big` typed; the list opened
 * above the reply box and only the bottom of its last row showed, cut at the
 * reply foot's top edge, behind the thread and the header).
 *
 * The keyboard is simulated as tests/e2e/inbox-ios-keyboard-shell.spec.ts
 * does (the owner's iOS 26 probe): the visual viewport loses the keyboard's
 * height and `innerHeight` follows it; phone.ts then pins the page and the
 * reply foot scrolls in its own box. The skills come from a route stub, so
 * nothing is read from a home folder.
 *
 * For each case the list is measured in the page: no ancestor cuts it, it lies
 * inside the visual viewport and under the thread's header, and the point at
 * the middle of every row that shows hits that row (nothing covers it).
 *
 * - an iPhone 16 Pro, keyboard 330 px, `/b` then `/big` typed at the end of a
 *   sentence (it opens above, between the header and the box);
 * - an iPhone 15, keyboard 403 px (257 px left), one match (it opens below);
 * - the keyboard opening after the list is open (it moves with it);
 * - a name wider than a phone's row: the icon, the name (cut with an ellipsis)
 *   and its source stay on one line, the row two lines tall;
 * - full view opening over the reply box while the list is open (desktop):
 *   the list goes with the box it belongs to (at the Inbox's root it is above
 *   the whole shell, and it stayed over the document, its rows still pressable).
 *
 * What emulation cannot prove: a headless WebKit has no keyboard and no Safari
 * bars, and cannot pan its page; only an iPhone shows Safari's own behaviour.
 *
 * Build the binary first (see inbox.spec.ts). PLANNOTATOR_E2E_SHOTS_DIR names
 * a folder for the pictures (default .local/proof/skill-list).
 */

import { devices, expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/skill-list'));

const LONG = 'Write or rewrite technical text with the rules of ASD-STE100 Simplified Technical English so it is clear, unambiguous, and free of AI slop.';
const SKILLS = [
  { name: 'asd-ste100', description: LONG, root: 'claude', humanOnly: false },
  { name: 'big-picture', description: 'Step back and summarize the big picture of a long thread before answering.', root: 'codex', humanOnly: false },
  { name: 'break-ui', description: 'Try to break a piece of UI by feeding it worst-case data: long names, unbreakable emails, huge counts.', root: 'universal', humanOnly: false },
  { name: 'build-mcp-server', description: 'Design, scaffold, audit, and upgrade Model Context Protocol servers.', root: 'claude', humanOnly: false },
  { name: 'benachrichtigungseinstellungen-überprüfen', description: 'Überprüft die Benachrichtigungseinstellungen aller Arbeitsbereiche.', root: 'codex', humanOnly: false },
  { name: 'arbeitsbereichsbenachrichtigungseinstellungenueberpruefung', description: 'Wider than a phone row on its own.', root: 'claude', humanOnly: false },
  ...Array.from({ length: 80 }, (_, i) => ({ name: `bulk-skill-${String(i).padStart(2, '0')}`, description: `Skill ${i}: ${LONG}`, root: 'universal', humanOnly: false })),
];

const PARAGRAPH =
  'Wake time matters much less. Turning on a laptop from sleep before the run starts takes a few seconds, so the run waits for the network and ' +
  'the disk to settle before it measures, and the numbers it reports are steadier from one run to the next.';

interface World {
  url: string;
  thread: string;
  agent: SimAgent;
  /** A thread with an HTML page attached, to open in full view. */
  page: { thread: string; file: string };
}

let world: World;
let browser: Browser;

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-skill-list-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  markTourDecided(dataDir);
  const env = {
    PATH: process.env.PATH ?? '',
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    NO_ANON_PING: '1',
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
  const project = scratchProject(join(root, 'src'), 'compute-research');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const body = ['# Compute research catch-up', '', ...Array.from({ length: 10 }, (_, i) => `${i + 1}. ${PARAGRAPH}`)].join('\n\n');
  const sent = await agent.send({ project_path: project, subject: 'Compute research catch-up: wake time and the long runs', thread: 'compute', body }, { wakes: true });
  mkdirSync(join(project, 'pages'));
  writeFileSync(join(project, 'pages', 'page.html'), '<!doctype html><meta charset="utf-8"><title>Page</title><body style="margin:0;font:16px system-ui;padding:12px 24px"><h1>Checkout</h1>' + '<p>Body text that fills the page.</p>'.repeat(40) + '</body>');
  const withPage = await agent.send({ project_path: project, subject: 'The checkout page', thread: 'page', body: 'The page as it is now.', attachments: ['pages/page.html'] });
  const url = started.stdout.trim();
  const files = (await (await fetch(new URL(`/api/inbox/threads/${withPage.thread_id}/attachments`, url))).json()) as { attachments: { id: string; name: string }[] };
  world = { url, thread: sent.thread_id as string, agent, page: { thread: withPage.thread_id as string, file: files.attachments[0]!.id } };
  browser = await webkit.launch({ args: [] });
});

test.afterAll(async () => {
  try {
    await browser?.close();
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

async function phone(device: 'iPhone 15' | 'iPhone 16 Pro'): Promise<Page> {
  const { userAgent, deviceScaleFactor, isMobile, hasTouch, viewport } = devices[device];
  const context = await browser.newContext({ userAgent, deviceScaleFactor, isMobile, hasTouch, viewport, colorScheme: 'light', reducedMotion: 'reduce' });
  await context.route(/\/api\/inbox\/skills(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ skills: SKILLS }) }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  (page as Page & { errors?: string[] }).errors = errors;
  return page;
}

/** iOS 26 Safari's keyboard (inbox-ios-keyboard-shell.spec.ts): the visual viewport and innerHeight lose `keyboard` px. */
async function iosKeyboardUp(page: Page, keyboard: number): Promise<void> {
  await page.evaluate((keyboard) => {
    const vv = window.visualViewport!;
    const full = window.innerHeight;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => full - keyboard });
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => full - keyboard });
    vv.dispatchEvent(new Event('resize'));
    window.scrollTo(0, keyboard);
    window.dispatchEvent(new Event('scroll'));
  }, keyboard);
  await frames(page);
  await frames(page);
}

async function openReply(page: Page, thread = world.thread) {
  await page.goto(`${world.url}#thread=${thread}`);
  const pane = page.locator('section.ib-pane');
  const box = pane.locator('.ib-pfoot textarea').first();
  const open = pane.locator('.ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)$/ });
  await expect(box.or(open).first()).toBeVisible();
  await expect(async () => {
    if (!(await box.isVisible())) await open.click({ timeout: 2_000 });
    await expect(box).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.getByText(/Tell your agents/i)).toHaveCount(0);
  return box;
}

async function typeAtEnd(page: Page, field: ReturnType<Page['locator']>, before: string, typed: string) {
  await field.fill(before);
  await field.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await field.pressSequentially(typed, { delay: 20 });
  await frames(page);
}

/** A grey box where the keyboard is, for the picture only. */
async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => {
    const vv = window.visualViewport!;
    const box = document.createElement('div');
    box.id = 'e2e-keyboard';
    box.style.cssText = `position:fixed;left:0;right:0;top:${vv.offsetTop + vv.height}px;height:2000px;z-index:2147483647;pointer-events:none;background:rgba(60,60,67,0.94)`;
    document.body.appendChild(box);
  });
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
  await page.evaluate(() => document.getElementById('e2e-keyboard')?.remove());
}

/** The list, measured: what cuts it, where it is against the visible part and the header, and which shown rows are covered. */
async function expectWhole(page: Page, name: string): Promise<{ placement: string; shown: number }> {
  await frames(page);
  const m = await page.evaluate(() => {
    const menu = document.querySelector<HTMLElement>('[data-skill-menu]');
    if (!menu) return null;
    const list = menu.querySelector<HTMLElement>('[data-skill-menu-list]')!;
    const vv = window.visualViewport!;
    const r = menu.getBoundingClientRect();
    const cutBy: string[] = [];
    for (let n = menu.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const c = n.getBoundingClientRect();
      if (c.top > r.top + 0.5 || c.bottom < r.bottom - 0.5) cutBy.push(n.className);
    }
    const lr = list.getBoundingClientRect();
    let shown = 0;
    const covered: string[] = [];
    for (const row of list.querySelectorAll<HTMLElement>('[data-skill-item]')) {
      const b = row.getBoundingClientRect();
      if (b.bottom <= lr.top + 1 || b.top >= lr.bottom - 1) continue;
      shown += 1;
      const y = (Math.max(b.top, lr.top) + Math.min(b.bottom, lr.bottom)) / 2;
      const hit = document.elementFromPoint(b.left + 30, y);
      if (!hit || hit.closest('[data-skill-item]') !== row) covered.push(row.dataset.skillItem ?? '');
    }
    const head = document.querySelector('section.ib-pane .ib-phead')!.getBoundingClientRect();
    return { placement: menu.dataset.skillMenuPlacement ?? '', top: r.top, bottom: r.bottom, seenTop: vv.offsetTop, seenBottom: vv.offsetTop + vv.height, headBottom: head.bottom, cutBy, shown, covered };
  });
  expect(m, `${name}: the list is open`).not.toBeNull();
  expect.soft(m!.cutBy, `${name}: nothing cuts the list`).toEqual([]);
  expect.soft(m!.top, `${name}: the list starts under the header`).toBeGreaterThanOrEqual(m!.headBottom - 0.5);
  expect.soft(m!.top, `${name}: the list starts on screen`).toBeGreaterThanOrEqual(m!.seenTop - 0.5);
  expect.soft(m!.bottom, `${name}: the list ends above the keyboard`).toBeLessThanOrEqual(m!.seenBottom + 0.5);
  expect.soft(m!.shown, `${name}: a row shows`).toBeGreaterThan(0);
  expect.soft(m!.covered, `${name}: nothing covers a row that shows`).toEqual([]);
  return { placement: m!.placement, shown: m!.shown };
}

test('the owner case: an iPhone, the keyboard up, "/b" then "/big" typed in the reply', async () => {
  const page = await phone('iPhone 16 Pro');
  const field = await openReply(page);
  await field.focus();
  await iosKeyboardUp(page, 330);
  await typeAtEnd(page, field, 'Yea. Sharpen and refine and present a ', '/b');
  await shot(page, 'iphone-owner-b');
  const b = await expectWhole(page, '/b');
  expect.soft(b.placement, 'with room between the header and the box, it opens above').toBe('above');
  expect.soft(b.shown, 'more than two rows show').toBeGreaterThanOrEqual(2);
  await field.pressSequentially('ig', { delay: 20 });
  await shot(page, 'iphone-owner-big');
  await expectWhole(page, '/big');
  // A tap on a row inserts it, the keyboard (focus) stays.
  await page.locator('[data-skill-item="big-picture"]').dispatchEvent('pointerdown');
  await expect(field).toHaveValue('Yea. Sharpen and refine and present a /big-picture ');
  await expect(field).toBeFocused();
  await expect(page.locator('[data-skill-menu]')).toHaveCount(0);
  expect((page as Page & { errors?: string[] }).errors).toEqual([]);
  await page.context().close();
});

test('257 px left (iPhone 15, keyboard 403): one match shows whole, so do 84', async () => {
  const page = await phone('iPhone 15');
  const field = await openReply(page);
  await field.focus();
  await iosKeyboardUp(page, 403);
  await typeAtEnd(page, field, '', '/big-pic');
  await expect(page.locator('[data-skill-item]')).toHaveCount(1);
  await shot(page, 'iphone-tight-one');
  await expectWhole(page, 'one match');
  await typeAtEnd(page, field, 'Yea. ', '/');
  await shot(page, 'iphone-tight-all');
  await expectWhole(page, 'all skills');
  // Escape closes the list, not the box (with a query typed: a bare `/` leaves Escape to the box, as before).
  await field.pressSequentially('b', { delay: 20 });
  await expect(page.locator('[data-skill-menu]')).toHaveCount(1);
  await field.press('Escape');
  await expect(page.locator('[data-skill-menu]')).toHaveCount(0);
  await expect(field).toBeVisible();
  await page.context().close();
});

test('the keyboard opening after the list is open: the list follows into what is left', async () => {
  const page = await phone('iPhone 15');
  const field = await openReply(page);
  await typeAtEnd(page, field, 'Yea. ', '/b');
  await expectWhole(page, 'keyboard down');
  await iosKeyboardUp(page, 403);
  await shot(page, 'iphone-keyboard-after');
  await expectWhole(page, 'keyboard up after the list opened');
  await page.context().close();
});

test('a name wider than a phone row: icon, name and source stay on one line, the row two lines tall', async () => {
  const page = await phone('iPhone 15');
  const field = await openReply(page);
  await field.focus();
  await iosKeyboardUp(page, 403);
  await typeAtEnd(page, field, '', '/arbeitsbereichs');
  await expect(page.locator('[data-skill-item]')).toHaveCount(1);
  await shot(page, 'iphone-long-name');
  await expectWhole(page, 'long name');
  const m = await page.locator('[data-skill-item]').evaluate((row) => {
    const top = (part: string) => row.querySelector(`[data-skill-item-part="${part}"]`)!.getBoundingClientRect();
    const icon = row.querySelector('svg')!.getBoundingClientRect();
    const name = top('name');
    const root = top('root');
    const r = row.getBoundingClientRect();
    return { iconMid: (icon.top + icon.bottom) / 2, nameMid: (name.top + name.bottom) / 2, rootMid: (root.top + root.bottom) / 2, nameRight: name.right, rootLeft: root.left, rowRight: r.right, height: r.height, cut: (row.querySelector('[data-skill-item-part="name"]') as HTMLElement).scrollWidth > name.width + 1 };
  });
  // One first line: the name used to drop to a line of its own (icon / name… / source / description, 83 px).
  expect.soft(Math.abs(m.nameMid - m.iconMid), 'the name sits on the icon\'s line').toBeLessThanOrEqual(3);
  expect.soft(Math.abs(m.rootMid - m.nameMid), 'the source sits on the name\'s line').toBeLessThanOrEqual(3);
  expect.soft(m.nameRight, 'the name stops before its source').toBeLessThanOrEqual(m.rootLeft + 0.5);
  expect.soft(m.cut, 'the name is cut (an ellipsis), not wrapped').toBe(true);
  expect.soft(m.height, 'two lines: the name\'s, then the description').toBeLessThan(60);
  await page.context().close();
});

test('full view opening over the reply box takes the open list away (desktop)', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
  await context.route(/\/api\/inbox\/skills(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ skills: SKILLS }) }));
  const page = await context.newPage();
  const field = await openReply(page, world.page.thread);
  await field.focus();
  await typeAtEnd(page, field, 'Hi ', '/b');
  await expect(page.locator('[data-skill-menu]')).toHaveCount(1);
  const row = await page.locator('[data-skill-item]').first().boundingBox();
  await page.evaluate(({ thread, file }) => {
    window.location.hash = `thread=${thread}&file=${file}&view=full`;
  }, world.page);
  await expect(page.locator('.ib-view.ib-full')).toBeVisible();
  await frames(page);
  await shot(page, 'desktop-full-view-over-list');
  await expect(page.locator('[data-skill-menu]')).toHaveCount(0);
  // Where the first row was, the full view is what a press reaches: nothing writes into the hidden reply.
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-skill-item], .ib-view.ib-full') ? (document.elementFromPoint(x, y)!.closest('[data-skill-item]') ? 'row' : 'full view') : 'other', { x: row!.x + 40, y: row!.y + row!.height / 2 });
  expect(hit).not.toBe('row');
  await expect(field).toHaveValue('Hi /b');
  await context.close();
});
