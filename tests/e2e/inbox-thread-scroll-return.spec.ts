/**
 * Coming back from a file keeps your place in the thread (packages/inbox/threadPlace.ts),
 * proved in a real browser against the compiled binary.
 *
 * The owner's report: "When I view an attachment in a thread, but then go
 * back to the thread, I'm scrolled to the top." Three causes, each covered:
 * on a phone the thread is `display: none` under the file and WebKit drops
 * its scrollTop; beside a file (or under a full-screen one) the thread is a
 * 440 px column, so its messages reflow and the same scrollTop shows other
 * lines, and the docked sidebar and list come back with a spring on close,
 * reflowing them again; `‹ Inbox` focused the thread's subject heading, and
 * the focus scrolled the thread to its top.
 *
 * Nothing is mocked: `plannotator inbox --background` runs under a temp
 * PLANNOTATOR_DATA_DIR and HOME, one agent writes a three-message thread
 * through `plannotator inbox mcp` whose last message shows a screenshot in its
 * text and carries an HTML page and a markdown plan; Chromium (and WebKit as
 * an iPhone) drives the window. Each case scrolls the thread so what it opens
 * from sits a third of the way down the view, opens the file from the foot
 * tiles, the header's attachments band or the image in the text, returns one
 * way, and checks the opener sits where it sat and the scrollTop is the same.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-thread-scroll-return.spec.ts`.
 * PNG frames of two returns land in PLANNOTATOR_SCROLL_RETURN_SHOTS when set.
 */

import { devices, expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = process.env.PLANNOTATOR_SCROLL_RETURN_SHOTS ? resolve(process.env.PLANNOTATOR_SCROLL_RETURN_SHOTS) : null;

const html = `<!doctype html><meta charset="utf-8"><title>Layout</title><style>body{margin:0;font:18px system-ui;background:#f6f3ee}main{padding:64px}</style><main><h1 id="headline">One page to pay</h1></main>`;
const para = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => `Paragraph ${i + from}. The checkout keeps the basket, the payment and the receipt on one page so nobody loses their place while paying.`).join('\n\n');

interface World {
  url: string;
  claude: SimAgent;
  threadId: string;
  firstId: string;
  lastId: string;
  ids: Record<string, string>;
}
let world: World;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-scroll-return-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const trap = join(root, 'trap');
  mkdirSync(home);
  mkdirSync(trap);
  writeFileSync(join(trap, 'tailscale'), '#!/bin/sh\necho "inbox-thread-scroll-return: tailscale must not run" >&2\nexit 97\n');
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = { PATH: `${trap}:${process.env.PATH ?? ''}`, HOME: home, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_TAILSCALE: '0', PLANNOTATOR_INBOX_PHONES: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_NOTES: '0' };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();

  const project = scratchProject(join(root, 'src'), 'checkout');
  for (const folder of ['site', 'docs', 'shots']) mkdirSync(join(project, folder));
  writeFileSync(join(project, 'site', 'layout.html'), html);
  writeFileSync(join(project, 'docs', 'rollout.md'), `# Rollout\n\n${para(4)}\n`);
  const maker = await browser.newContext({ viewport: { width: 900, height: 560 } });
  const makerPage = await maker.newPage();
  await makerPage.setContent(html);
  writeFileSync(join(project, 'shots', 'checkout.png'), await makerPage.screenshot());
  await maker.close();

  const claude = await SimAgent.connect({ binary: builtBinary, env, name: 'Claude', host: 'claude-code' });
  const question = [':::question', 'Which layout ships first?', '', '- [ ] One page', '- [ ] Three steps', ':::'].join('\n');
  const first = await claude.send({ project_path: project, subject: 'Checkout: the layouts', body: [para(10), '', question].join('\n') });
  const second = await claude.send({ project_path: project, reply_to: first.message_id as string, body: para(10, 11) });
  const last = await claude.send({
    project_path: project,
    reply_to: second.message_id as string,
    body: [para(8, 21), '', '![Single-page checkout](shots/checkout.png)', '', para(12, 29)].join('\n'),
    attachments: ['site/layout.html', 'docs/rollout.md'],
  });
  world = { url, claude, threadId: first.thread_id as string, firstId: first.message_id as string, lastId: last.message_id as string, ids: {} };
});

test.afterAll(async () => {
  try {
    await world?.claude.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const BODY = 'section.ib-pane .ib-pbody:not(.ib-artbody)';
const pane = (p: Page) => p.locator('[data-attachment-pane]');
const isFull = async (p: Page) => ((await pane(p).getAttribute('class')) ?? '').includes('ib-full');

type Opener = 'foot' | 'header' | 'inline';
type Return = 'close' | 'escape' | 'back-to-thread' | 'inbox' | 'browser-back' | 'step';

const openerSelector = (opener: Opener, file: string) => {
  const id = world.ids[file]!;
  const scope = `[data-message-article="${world.lastId}"]`;
  if (opener === 'inline') return `${scope} img[data-inline-image="${id}"]`;
  if (opener === 'header') return `${scope} .ib-hatts-tiles [data-attachment-id="${id}"]`;
  return `${scope} .ib-attachments:not(.ib-hatts-tiles) [data-attachment-id="${id}"]`;
};

/** Where the opener sits in the thread's view, the view's scrollTop, and whether it has focus. */
function where(p: Page, selector: string) {
  return p.evaluate(
    ([bodySel, sel]) => {
      const body = document.querySelector<HTMLElement>(bodySel)!;
      const target = document.querySelector<HTMLElement>(sel)!;
      return { scrollTop: body.scrollTop, top: target.getBoundingClientRect().top - body.getBoundingClientRect().top, focused: document.activeElement === target };
    },
    [BODY, selector] as const,
  );
}

async function loadThread(p: Page) {
  await p.goto('about:blank');
  await p.goto(`${world.url}#thread=${world.threadId}`);
  await expect(p.locator(BODY)).toBeVisible();
  if (Object.keys(world.ids).length === 0) {
    const thread = await p.evaluate(async (id) => (await (await fetch(`/api/inbox/threads/${id}`)).json()).thread, world.threadId);
    for (const message of thread.messages) for (const f of [...(message.inline_images ?? []), ...(message.attachments ?? [])] as { name: string; id: string }[]) world.ids[f.name] = f.id;
  }
  await p.waitForTimeout(300);
}

/** Leave the file one way; a full-screen file on a desktop first comes beside the thread for the ways that need it. */
async function leave(p: Page, how: Return, narrow: boolean): Promise<void> {
  if (how === 'browser-back') {
    await p.goBack();
    return;
  }
  if (how === 'step') {
    // One step to another file (it replaces the route), then out by the file's own way.
    // Keys from inside the file: focus on one of its buttons (a click on the page would pin it for a comment).
    const start = await pane(p).getAttribute('data-attachment-pane');
    await pane(p).locator('button:visible').first().focus();
    await p.keyboard.press('[');
    await p.waitForTimeout(250);
    if ((await pane(p).getAttribute('data-attachment-pane')) === start) await p.keyboard.press(']');
    await expect(pane(p)).not.toHaveAttribute('data-attachment-pane', start!);
    await pane(p).locator('button:visible').first().focus();
    await p.keyboard.press(']');
    await p.waitForTimeout(250);
    return leave(p, narrow ? 'back-to-thread' : 'close', narrow);
  }
  if (how === 'escape') {
    // Escape's ladder: on a desktop its last rung puts the file beside the thread, and the × closes it;
    // where the file can only be full screen, the last rung goes back to the thread.
    for (let i = 0; i < 6 && (await pane(p).count()) > 0 && (narrow || (await isFull(p))); i++) {
      await p.keyboard.press('Escape');
      await p.waitForTimeout(150);
    }
    if ((await pane(p).count()) > 0) await pane(p).getByRole('button', { name: /^Close / }).first().click();
    return;
  }
  if (how === 'back-to-thread') {
    await p.locator('[data-full-view-exit="back"]').click();
    return;
  }
  for (let i = 0; i < 5 && (await isFull(p)); i++) {
    await p.keyboard.press('Escape');
    await p.waitForTimeout(120);
  }
  if (how === 'inbox') await p.locator('[data-file-back]').click();
  else await pane(p).getByRole('button', { name: /^Close / }).first().click();
}

async function roundTrip(p: Page, { file, opener, how, narrow = false, shot }: { file: string; opener: Opener; how: Return; narrow?: boolean; shot?: string }) {
  await loadThread(p);
  const selector = openerSelector(opener, file);
  if (opener === 'header') await p.locator(`[data-header-files="${world.lastId}"]`).click();
  // The opener a third of the way down the thread's view (the header band, near the thread's top, just under it).
  await p.evaluate(
    ([bodySel, sel, near]) => {
      const body = document.querySelector<HTMLElement>(bodySel)!;
      const target = document.querySelector<HTMLElement>(sel)!;
      body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top - (near ? 40 : body.clientHeight / 3);
    },
    [BODY, selector, opener === 'header'] as const,
  );
  await p.waitForTimeout(500);
  const before = await where(p, selector);
  expect(before.scrollTop, 'the thread is scrolled before the file opens').toBeGreaterThan(40);
  if (shot && shotsDir) await p.screenshot({ path: join(shotsDir, `${shot}-1-thread.png`) });
  await p.locator(selector).click();
  await expect(pane(p)).toBeVisible();
  await p.waitForTimeout(300);
  if (shot && shotsDir) await p.screenshot({ path: join(shotsDir, `${shot}-2-file.png`) });
  await leave(p, how, narrow);
  await expect(pane(p)).toHaveCount(0);
  // The sidebar's and the list's spring back, and a beat more.
  await p.waitForTimeout(800);
  const after = await where(p, selector);
  if (shot && shotsDir) await p.screenshot({ path: join(shotsDir, `${shot}-3-back.png`) });
  const label = `${opener} ${file}, back by ${how}`;
  expect.soft(Math.abs(after.top - before.top), `${label}: the opener moved from ${before.top} to ${after.top}`).toBeLessThanOrEqual(2);
  expect.soft(Math.abs(after.scrollTop - before.scrollTop), `${label}: scrollTop went from ${before.scrollTop} to ${after.scrollTop}`).toBeLessThanOrEqual(2);
  return after;
}

test('desktop 1440: side by side and full screen, every way back keeps the thread where it was', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await context.newPage();
  const errors: string[] = [];
  p.on('pageerror', (error) => errors.push(error.message));
  // A markdown plan opens beside the thread; an HTML page and an image in the text open full screen.
  for (const how of ['close', 'inbox', 'browser-back', 'step'] as const) await roundTrip(p, { file: 'rollout.md', opener: 'foot', how });
  for (const how of ['close', 'escape', 'inbox', 'browser-back', 'step'] as const) await roundTrip(p, { file: 'layout.html', opener: 'foot', how });
  for (const how of ['close', 'browser-back'] as const) await roundTrip(p, { file: 'rollout.md', opener: 'header', how });
  for (const how of ['escape', 'inbox', 'browser-back', 'step'] as const) await roundTrip(p, { file: 'checkout.png', opener: 'inline', how, shot: how === 'escape' ? 'desktop-full-screen' : undefined });
  // A pointer open and close moves no focus to the tile.
  const after = await roundTrip(p, { file: 'rollout.md', opener: 'foot', how: 'close' });
  expect(after.focused).toBe(false);
  expect(errors).toEqual([]);
  await context.close();
});

test('desktop 1440: opened by keyboard, focus comes back to the tile or the image', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await context.newPage();
  for (const [file, opener] of [
    ['rollout.md', 'foot'],
    ['checkout.png', 'inline'],
  ] as const) {
    await loadThread(p);
    const selector = openerSelector(opener, file);
    await p.locator(selector).focus();
    await p.waitForTimeout(400);
    const before = await where(p, selector);
    await p.keyboard.press('Enter');
    await expect(pane(p)).toBeVisible();
    await p.waitForTimeout(300);
    // Out by the keyboard: Escape to beside the thread, then the file's × pressed with Enter.
    for (let i = 0; i < 5 && (await isFull(p)); i++) {
      await p.keyboard.press('Escape');
      await p.waitForTimeout(120);
    }
    await pane(p).getByRole('button', { name: /^Close / }).first().focus();
    await p.keyboard.press('Enter');
    await expect(pane(p)).toHaveCount(0);
    await p.waitForTimeout(800);
    const after = await where(p, selector);
    expect(after.focused, `${opener} ${file}: focus back on what opened it`).toBe(true);
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2);
  }
  await context.close();
});

/**
 * Whether `selector` sits inside the thread's view, and whether it covers the view's middle line (where a landing
 * that centres it puts it: a message taller than the view is centred with its top above the view).
 */
function inView(p: Page, selector: string) {
  return p.evaluate(
    ([bodySel, sel]) => {
      const body = document.querySelector<HTMLElement>(bodySel)!.getBoundingClientRect();
      const r = document.querySelector<HTMLElement>(sel)!.getBoundingClientRect();
      const middle = body.top + body.height / 2;
      return { top: r.top - body.top, bottom: r.bottom - body.top, inView: r.top >= body.top - 2 && r.top < body.bottom - 20, overMiddle: r.top <= middle && r.bottom >= middle };
    },
    [BODY, selector] as const,
  );
}

test("the app's own scrolls are not pulled back by the place held after a file (#2208 review)", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await context.newPage();
  const firstArticle = `[data-message-article="${world.firstId}"]`;

  // A file beside the thread, then a search result in the same thread (`msg=` drops `file`): the message lands
  // centred in the view, not back at the tile the place was held on. The first message is taller than the view,
  // so centred means its top sits above the view: the check is that it covers the view's middle.
  await loadThread(p);
  const tile = openerSelector('foot', 'rollout.md');
  await p.locator(tile).scrollIntoViewIfNeeded();
  await p.locator(tile).click();
  await expect(pane(p)).toBeVisible();
  await p.waitForTimeout(300);
  await p.evaluate(([thread, msg]) => (location.hash = `thread=${thread}&msg=${msg}`), [world.threadId, world.firstId] as const);
  await expect(pane(p)).toHaveCount(0);
  await p.waitForTimeout(1500);
  const landed = await inView(p, firstArticle);
  expect(landed.overMiddle, `the search result landed at ${landed.top}..${landed.bottom}`).toBe(true);

  // A file closed, then (inside the hold's window) a jump from the open-questions menu: the card lands in view.
  await loadThread(p);
  await p.locator(tile).scrollIntoViewIfNeeded();
  await p.locator(tile).click();
  await expect(pane(p)).toBeVisible();
  await p.waitForTimeout(300);
  await pane(p).getByRole('button', { name: /^Close / }).first().click();
  await expect(pane(p)).toHaveCount(0);
  await p.locator('.ib-pfoot [data-open-questions]').click();
  await p.locator('[data-open-questions-list] .ib-oq-row').first().click();
  await p.waitForTimeout(1500);
  const card = await inView(p, `[data-message-id="${world.firstId}"] [data-question-key]`);
  expect(card.inView, `the card landed at ${card.top}`).toBe(true);

  // A scroll the person makes during the hold (PageDown with focus on the page) is not pulled back.
  await loadThread(p);
  await p.locator(tile).scrollIntoViewIfNeeded();
  await p.locator(tile).click();
  await expect(pane(p)).toBeVisible();
  await p.waitForTimeout(300);
  await pane(p).getByRole('button', { name: /^Close / }).first().click();
  await expect(pane(p)).toHaveCount(0);
  // Read and scrolled in one step: the hold may put the place back again between two steps (the thread grows a
  // frame after the file closes), and the scroll is measured from where it started.
  const held = await p.evaluate((sel) => {
    const body = document.querySelector<HTMLElement>(sel)!;
    const top = body.scrollTop;
    body.scrollTop = top - 600;
    return top;
  }, BODY);
  await p.waitForTimeout(1500);
  // The list and sidebar still reflow the thread a little as they spring back; the place is never put back over the scroll.
  const final = await p.evaluate((sel) => document.querySelector<HTMLElement>(sel)!.scrollTop, BODY);
  expect(held - final, `scrollTop ${held}, scrolled up 600, ended at ${final}`).toBeGreaterThan(450);
  await context.close();
});

test("a comment opened from the reply box's list right after a file closes lands its passage in view", async ({ browser }) => {
  // The list and sidebar spring back as the file closes (a resize every frame) while the list's scroll starts.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await context.newPage();
  await loadThread(p);
  // A comment on the first words of the last message (open, far above the foot tiles), saved as the window saves one.
  const id = 'scroll-return-comment';
  const saved = await p.evaluate(
    async ([message, annotation]) => (await fetch(`/api/inbox/messages/${message}/annotations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ annotation }) })).status,
    [world.lastId, { id, blockId: '', startOffset: 0, endOffset: 0, type: 'COMMENT', text: 'Say how long the receipt takes.', originalText: 'Paragraph 21. The checkout keeps the basket', createdA: Date.now() }] as const,
  );
  expect(saved).toBe(200);
  await loadThread(p);
  // The reply box open first, so nothing scrolls the thread between the close and the comment.
  await p.locator('section.ib-pane .ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)$/ }).first().click();
  await expect(p.locator('[data-annotations-chip]')).toBeVisible();
  const tile = openerSelector('foot', 'rollout.md');
  await p.locator(tile).scrollIntoViewIfNeeded();
  await p.waitForTimeout(300);
  await p.locator(tile).click();
  await expect(pane(p)).toBeVisible();
  await p.waitForTimeout(300);
  // The file's ×, then (frames later, while the list and sidebar spring back) the list in the foot and the comment.
  await p.evaluate(async (comment) => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
    const until = async (find: () => HTMLElement | null) => {
      for (let i = 0; i < 60; i++) {
        const el = find();
        if (el) return el;
        await frame();
      }
      throw new Error('not found');
    };
    document.querySelector<HTMLElement>('[data-attachment-pane] button[aria-label^="Close "]')!.click();
    await until(() => (document.querySelector('[data-attachment-pane]') ? null : document.body));
    await frame();
    (await until(() => document.querySelector<HTMLElement>('[data-annotations-chip]'))).click();
    const row = await until(() => document.querySelector<HTMLElement>(`.ib-annpop [data-annotation-row="${comment}"] button.ib-af`));
    row.click();
  }, id);
  await expect(pane(p)).toHaveCount(0);
  await p.waitForTimeout(1500);
  // The passage the list brings into view: its highlight.
  const passage = `[data-message-id="${world.lastId}"] [data-bind-id="${id}"], [data-message-id="${world.lastId}"] [data-highlight-id="${id}"]`;
  await expect(p.locator(passage).first()).toBeAttached();
  const where = await p.evaluate(
    ([bodySel, sel]) => {
      const body = document.querySelector<HTMLElement>(bodySel)!.getBoundingClientRect();
      const r = document.querySelector<HTMLElement>(sel)!.getBoundingClientRect();
      return { top: r.top - body.top, inView: r.top >= body.top - 2 && r.bottom <= body.bottom + 2 };
    },
    [BODY, passage] as const,
  );
  expect(where.inView, `the passage landed at ${where.top}`).toBe(true);
  // The comment goes, so the thread the later tests measure is as it was (a comment waiting changes the foot).
  expect(await p.evaluate(async (comment) => (await fetch(`/api/inbox/annotations/${comment}/remove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, id)).toBe(200);
  await context.close();
});

test('a control pressed by keyboard a moment before a file opens some other way does not take focus on the way back', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await context.newPage();
  await loadThread(p);
  const count = p.locator(`[data-header-files="${world.lastId}"]`);
  await count.focus();
  await p.keyboard.press('Enter');
  await p.keyboard.press('Enter');
  // The file opens by its link (an agent's deep link, a comment card), not from the control just pressed.
  await p.evaluate(([thread, file]) => (location.hash = `thread=${thread}&file=${file}&view=side`), [world.threadId, world.ids['rollout.md']!] as const);
  await expect(pane(p)).toBeVisible();
  await pane(p).getByRole('button', { name: /^Close / }).first().click();
  await expect(pane(p)).toHaveCount(0);
  await p.waitForTimeout(500);
  await expect(count).not.toBeFocused();
  await context.close();
});

test('a stacked window (900 px): the file covers the thread; every way back keeps the place', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
  const p = await context.newPage();
  for (const how of ['escape', 'back-to-thread', 'browser-back', 'step'] as const) {
    await roundTrip(p, { file: 'rollout.md', opener: 'foot', how, narrow: true });
    await roundTrip(p, { file: 'checkout.png', opener: 'inline', how, narrow: true });
  }
  await roundTrip(p, { file: 'layout.html', opener: 'header', how: 'back-to-thread', narrow: true });
  await context.close();
});

test('an iPhone (WebKit): the thread is hidden under the file and comes back where it was', async () => {
  const { defaultBrowserType: _ignored, ...device } = devices['iPhone 15'];
  const browser = await webkit.launch({ args: [] });
  try {
    const context = await browser.newContext(device);
    const p = await context.newPage();
    await p.emulateMedia({ reducedMotion: 'reduce' });
    for (const how of ['back-to-thread', 'browser-back'] as const) {
      await roundTrip(p, { file: 'rollout.md', opener: 'foot', how, narrow: true });
      await roundTrip(p, { file: 'checkout.png', opener: 'inline', how, narrow: true, shot: how === 'back-to-thread' ? 'phone' : undefined });
    }
    await roundTrip(p, { file: 'layout.html', opener: 'header', how: 'back-to-thread', narrow: true });
    await context.close();
  } finally {
    await browser.close();
  }
});
