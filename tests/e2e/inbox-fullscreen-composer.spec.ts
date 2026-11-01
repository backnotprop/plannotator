/**
 * Full screen's composer (approval "inbox-fullscreen-composer", 2A, round 4),
 * proved in a real browser against the compiled binary. Nothing is mocked:
 * `plannotator inbox --background` runs under a temp PLANNOTATOR_DATA_DIR and
 * HOME (PLANNOTATOR_INBOX_CONNECT=0, no browser, a tailscale trap first on
 * PATH); one agent sends a screenshot and an HTML page with a question
 * through `plannotator inbox mcp`; Chromium drives the window.
 *
 * Proves: an image in full screen has one floating card at its foot with two
 * tabs (Comment on this image, Reply to Claude Code); Reply writes the
 * thread's reply draft (saved on the server, the thread's box holds the same
 * words); minimize leaves the "Reply draft" pill with focus on it; Hide (»)
 * hides the card and the pill with the toolbar; the pill gives the card back
 * with focus in the field; Send goes from full screen, which stays, the card
 * says it went and the draft is gone. An HTML page is Reply only. At 390 px
 * (a phone) the card spans the width under the toolbar, the tabs read Comment
 * and Reply, Send is the icon, and minimized the pill sits left of the
 * toolbar, never under it.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-fullscreen-composer.spec.ts`.
 * PNGs land in PLANNOTATOR_E2E_SHOTS_DIR (default .local/proof/fullscreen-composer).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { forgetFileViewChoice } from './file-view';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/fullscreen-composer'));

const CHECKOUT = `<!doctype html><meta charset="utf-8"><title>Fernway checkout</title><style>
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f4f2ed;color:#1d1b18}
header{display:flex;align-items:center;justify-content:space-between;padding:22px 64px;background:#fff;border-bottom:1px solid #e6e2da}
.logo{font:700 26px Georgia,serif}nav{display:flex;gap:36px;color:#8a857c}nav b{color:#1d1b18}
main{display:grid;grid-template-columns:1fr 580px;gap:52px;max-width:1240px;margin:0 auto;padding:46px 64px 140px}
h1{font:700 56px/1.05 Georgia,serif;margin:0 0 26px}.card{background:#fff;border:1px solid #e6e2da;border-radius:16px;padding:28px 32px;margin-bottom:22px}
h2{font-size:21px;margin:0 0 16px}label{display:block;color:#6b665e;font-size:15px;margin:10px 0 6px}.in{height:52px;border:1px solid #e0dbd2;border-radius:9px;background:#faf8f4}
.row{display:grid;grid-template-columns:1fr 1fr;gap:18px}.sum div{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #eee9e1;font-size:19px}
.total{font:700 30px Georgia,serif;border:0!important}.promo{background:#fbf2e2;border-color:#f1dcb5}
footer{position:fixed;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:space-between;padding:22px 64px;background:#1f1d1a;color:#b9b3a8}
footer b{background:#e8a33d;color:#1f1d1a;padding:14px 34px;border-radius:9px;font-size:20px}
</style><header><span class="logo">Fernway</span><nav><span>Cart</span><b>Shipping &amp; payment</b><span>Review</span></nav><span>🔒 Secure</span></header>
<main><div><h1>Almost yours.</h1><div class="card"><h2>Shipping address</h2><label>Full name</label><div class="in"></div><label>Street</label><div class="in"></div>
<div class="row"><div><label>City</label><div class="in"></div></div><div><label>Postcode</label><div class="in"></div></div></div></div>
<div class="card"><h2>Payment</h2><label>Card number</label><div class="in"></div><div class="row"><div><label>Expiry</label><div class="in"></div></div><div><label>CVC</label><div class="in"></div></div></div></div></div>
<div><div class="card sum"><h2>Order summary</h2><div><span>Linen throw, oat</span><span>$68.00</span></div><div><span>Stoneware mug ×2</span><span>$36.00</span></div><div><span>Shipping</span><span>Free</span></div><div class="total"><span>Total</span><span>$104.00</span></div></div>
<div class="card promo"><h2>Promo</h2>FERN10 applied at review.</div></div></main>
<footer><span>Free returns · 30 days &nbsp;&nbsp; Pay later with Klarna</span><b>Continue to review →</b></footer>`;

const BODY = [
  'The checkout at 1440 px, as a screenshot and as the page itself.',
  '',
  ':::question',
  'Keep the footer sticky on phones?',
  '',
  '- [ ] Yes',
  '- [ ] No',
  ':::',
].join('\n');

const WORDS = 'Yes, keep it sticky. But the footer covers the CVC field on a 375 px phone; add 96 px of bottom padding to the form';

interface World {
  root: string;
  url: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threadId: string;
  ids: Record<string, string>;
  project: string;
}

let world: World;

/** Dark and light (the approval's shots are dark, one light), with reduced motion so nothing moves. Ends dark. */
async function shot(page: Page, name: string, schemes: ('light' | 'dark')[] = ['dark', 'light']): Promise<void> {
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(shotsDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
}

const pane = (page = world.page) => page.locator('[data-attachment-pane]');
const card = (page = world.page) => page.locator('[data-fcomp]');
const pill = (page = world.page) => page.locator('[data-fcomp-pill]');
const replyField = (page = world.page) => card(page).locator('[data-fcomp-field] textarea');
const fileUrl = (name: string) => `${world.url}#thread=${world.threadId}&file=${world.ids[name]}&view=full`;

async function draftOnServer(): Promise<string | null> {
  const answer = (await (await fetch(new URL(`/api/inbox/threads/${world.threadId}/draft`, world.url))).json()) as { draft: { body: string } | null };
  return answer.draft?.body ?? null;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-fullscreen-composer-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const trap = join(root, 'trap');
  mkdirSync(home);
  mkdirSync(trap);
  // Nothing here may reach the real tailscale CLI.
  writeFileSync(join(trap, 'tailscale'), '#!/bin/sh\necho "inbox-fullscreen-composer: tailscale must not run" >&2\nexit 97\n');
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = {
    PATH: `${trap}:${process.env.PATH ?? ''}`,
    HOME: home,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
  };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim();

  const project = scratchProject(join(root, 'src'), 'fernway');
  mkdirSync(join(project, 'shots'));
  writeFileSync(join(project, 'shots', 'checkout.html'), CHECKOUT);
  const maker = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const makerPage = await maker.newPage();
  await makerPage.setContent(CHECKOUT);
  writeFileSync(join(project, 'shots', 'checkout.png'), await makerPage.screenshot());
  await maker.close();

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = {
    root,
    url,
    claude: await SimAgent.connect({ binary: builtBinary, env, name: 'Claude Code', host: 'claude-code' }),
    context,
    page,
    errors,
    threadId: '',
    ids: {},
    project,
  };
  const sent = await world.claude.send({
    project_path: project,
    subject: 'Checkout: the sticky footer on phones',
    body: BODY,
    attachments: ['shots/checkout.png', 'shots/checkout.html'],
  });
  world.threadId = sent.thread_id as string;
  const model = (await (await fetch(new URL(`/api/inbox/threads/${world.threadId}/attachments`, url))).json()) as { attachments: { id: string; name: string }[] };
  for (const a of model.attachments) world.ids[a.name] = a.id;
});

test.afterEach(async () => forgetFileViewChoice(world?.page));

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.claude.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('an image in full screen: one card at its foot, Comment and Reply as a radio group, Comment first with no draft', async () => {
  const page = world.page;
  await page.goto(fileUrl('checkout.png'));
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await expect(card()).toBeVisible();
  const radios = card().getByRole('radiogroup').getByRole('radio');
  await expect(radios).toHaveCount(2);
  await expect(card().getByRole('radio', { name: 'Comment on this image' })).toHaveAttribute('aria-checked', 'true');
  await expect(card().getByRole('radio', { name: 'Reply to Claude Code' })).toHaveAttribute('aria-checked', 'false');
  await expect(card().getByRole('button', { name: 'Hide the composer' })).toBeVisible();
  // The comment row is the image's own (its field, Mark up, Comment), inside the card; no old band at the foot.
  await expect(card().getByRole('textbox', { name: 'Comment on checkout.png' })).toBeVisible();
  await expect(pane().locator('.ib-imgcompose')).toHaveCount(0);
  // Bottom centre, 680 px wide, 20 px above the window's foot; the 30 px buttons and 24 px tabs.
  const box = (await card().boundingBox())!;
  expect(Math.round(box.width)).toBe(680);
  expect(Math.round(box.x + box.width / 2)).toBe(720);
  expect(Math.round(900 - (box.y + box.height))).toBe(20);
  expect(Math.round((await card().locator('[data-fcomp-minimize]').boundingBox())!.height)).toBe(30);
  expect(Math.round((await radios.first().boundingBox())!.height)).toBe(24);
  await page.mouse.move(200, 400);
  await shot(page, '2A-expanded-comment');
});

test('Reply writes the thread’s reply draft: saved on the server, and the thread’s box holds the same words', async () => {
  const page = world.page;
  await card().getByRole('radio', { name: 'Reply to Claude Code' }).click();
  await expect(replyField()).toBeFocused();
  await expect(replyField()).toHaveAttribute('placeholder', 'Reply to Claude Code…');
  // Empty: Send is dimmed.
  await expect(card().locator('[data-fcomp-send]')).toBeDisabled();
  await page.keyboard.type(WORDS);
  await expect(card().locator('[data-fcomp-send]')).toBeEnabled();
  await expect.poll(draftOnServer).toBe(WORDS);
  // What rides the Send: the open question, and the way to the thread.
  await expect(card().locator('[data-fcomp-foot]')).toContainText('1 open question');
  await expect(card().locator('[data-fcomp-open-thread]')).toBeVisible();
  // The thread's own box (behind full screen) holds the same words: one draft.
  await expect(page.locator('.ib-rbox textarea')).toHaveValue(WORDS);
  await page.mouse.move(200, 400);
  await shot(page, '2A-expanded-reply');
  await card().locator('[data-fcomp-minimize]').hover();
  await expect(page.getByRole('tooltip').or(page.locator('[data-pn-tooltip]')).first()).toContainText('Hide the composer');
  await shot(page, '2A-expanded-reply-hover', ['dark']);
});

test('minimize leaves the "Reply draft" pill with focus on it; Hide hides the pill too; the pill gives the card back, focus in the field', async () => {
  const page = world.page;
  await card().locator('[data-fcomp-minimize]').click();
  await expect(card()).toHaveCount(0);
  await expect(pill()).toBeFocused();
  await expect(pill()).toHaveText(/Reply draft/);
  await expect(pill()).toHaveAccessibleName('Show the composer: Reply draft');
  const box = (await pill().boundingBox())!;
  expect(Math.round(box.height)).toBe(30);
  expect(Math.round(box.x + box.width / 2)).toBe(720);
  // The pill is the file's foot now (the comment row is kept, hidden): the pane measures it, so the chip,
  // the notes and a film's controls keep above it.
  const foot = await pane().evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--ib-fvfoot')));
  const wrap = (await page.locator('[data-fcomp-pillwrap]').boundingBox())!;
  expect(foot).toBe(Math.round(wrap.height));
  expect(foot).toBeGreaterThanOrEqual(30);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(200, 400);
  await shot(page, '2A-min-draft');

  // Hide (») takes the pill away with the toolbar; showing the tools brings it back.
  await page.locator('[data-full-view-hide]').click();
  await expect(page.locator('[data-full-view-dock]')).toHaveAttribute('data-bar', 'tucked');
  await expect(pill()).toBeHidden();
  await expect(page.locator('[data-fcomp-pillwrap]')).toHaveJSProperty('inert', true);
  await page.locator('[data-full-view-handle]').click();
  await page.locator('[data-full-view-hide]').click();
  await page.mouse.move(200, 400);
  await expect(page.locator('[data-full-view-dock]')).toHaveAttribute('data-bar', 'pinned');
  await expect(pill()).toBeVisible();

  // Kept for the thread: leaving full screen and coming back finds the pill.
  await page.goto(`${world.url}#thread=${world.threadId}`);
  await page.goto(fileUrl('checkout.png'));
  await expect(pill()).toBeVisible();

  await pill().click();
  await expect(card()).toBeVisible();
  await expect(replyField()).toBeFocused();
  await expect(replyField()).toHaveValue(WORDS);
});

test('Hide (») hides the card and the size chip with the toolbar', async () => {
  const page = world.page;
  await page.locator('[data-full-view-hide]').click();
  await expect(card()).toBeHidden();
  await expect(card()).toHaveJSProperty('inert', true);
  await expect(pane().locator('.ib-imgbar')).toBeHidden();
  await page.locator('[data-full-view-handle]').click();
  await page.locator('[data-full-view-hide]').click();
  await page.mouse.move(200, 400);
  await expect(card()).toBeVisible();
});

test('the paperclip attaches to the reply; Send goes from full screen with the file: it stays, the card says it went, the reply is in the thread and the draft is gone', async () => {
  const page = world.page;
  // The reply box's paperclip, first in the card's toolbar (the card's 30 px button).
  const clip = card().locator('[data-fcomp-foot] > :first-child');
  await expect(clip).toHaveAccessibleName('Attach files');
  const clipBox = (await clip.boundingBox())!;
  expect(Math.round(clipBox.width)).toBe(30);
  expect(Math.round(clipBox.height)).toBe(30);
  const crop = await page.screenshot({ clip: { x: 60, y: 600, width: 400, height: 240 } });
  await card().locator('input[type="file"][data-fcomp-attach]').setInputFiles({ name: 'footer-over-cvc.png', mimeType: 'image/png', buffer: crop });
  await expect(card().locator('[data-fcomp-files] [data-compose-file="done"]')).toHaveCount(1);
  // One reply: the thread's box behind full screen holds the same file.
  await expect(page.locator('.ib-rbox [data-reply-files] [data-compose-file-name="footer-over-cvc.png"]')).toHaveCount(1);
  await replyField().focus();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(200, 400);
  await shot(page, '2A-reply-attached');
  await replyField().focus();
  await card().locator('[data-fcomp-send]').click();
  await expect(card().locator('[data-fcomp-sent]')).toHaveText('Sent to Claude Code');
  await expect(replyField()).toHaveValue('');
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await expect.poll(draftOnServer).toBeNull();
  const thread = (await world.claude.readThread(world.threadId)) as { messages: { author: { kind: string }; body: string }[] };
  expect(thread.messages.some((m) => m.author.kind === 'person' && m.body.includes('96 px of bottom padding'))).toBe(true);
  // The file went with the words, and left the card and the box.
  const mine = thread.messages.filter((m) => m.author.kind === 'person').at(-1) as { attachments?: { name: string }[] };
  expect(mine.attachments?.map((a) => a.name)).toEqual(['footer-over-cvc.png']);
  await expect(card().locator('[data-fcomp-files]')).toHaveCount(0);
  // Empty again: Send is dimmed, and minimized the pill says what the card is for.
  await expect(card().locator('[data-fcomp-send]')).toBeDisabled();
  await card().getByRole('radio', { name: 'Comment on this image' }).click();
  await card().locator('[data-fcomp-minimize]').click();
  await expect(pill()).toHaveText(/Comment on this image/);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(200, 400);
  await shot(page, '2A-min-nodraft');
  await pill().click();
  expect(world.errors).toEqual([]);
});

test('an HTML page is Reply only: no tabs, the reply field, and its pill', async () => {
  const page = world.page;
  await page.goto(fileUrl('checkout.html'));
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await expect(card()).toBeVisible();
  await expect(card().getByRole('radiogroup')).toHaveCount(0);
  await expect(card()).toContainText('Reply to Claude Code');
  await replyField().click();
  await page.keyboard.type('The footer should stay, with room under the form.');
  await expect.poll(draftOnServer).toBe('The footer should stay, with room under the form.');
  await card().locator('[data-fcomp-minimize]').click();
  await expect(pill()).toHaveText(/Reply draft/);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(700, 400);
  await shot(page, '2A-html-min');
  await pill().click();
  await expect(replyField()).toBeFocused();
});

test('a phone (390 px): the card spans the width under the toolbar, Comment and Reply, Send the icon; minimized, the pill sits left of the toolbar', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  try {
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(fileUrl('checkout.png'));
    await expect(pane(page)).toHaveAttribute('data-full-view', '');
    // The HTML page's draft is the thread's: the card opens on Reply with it.
    await expect(card(page)).toBeVisible();
    await expect(card(page).getByRole('radio', { name: 'Comment' })).toBeVisible();
    await expect(card(page).getByRole('radio', { name: 'Reply' })).toHaveAttribute('aria-checked', 'true');
    await expect(replyField(page)).toHaveValue('The footer should stay, with room under the form.');
    await replyField(page).fill(WORDS);
    const send = card(page).locator('[data-fcomp-send]');
    await expect(send).toHaveAccessibleName('Send to Claude Code');
    await expect(send).not.toContainText('Send');
    const cardBox = (await card(page).boundingBox())!;
    expect(Math.round(cardBox.x)).toBe(8);
    expect(Math.round(cardBox.width)).toBe(390 - 16);
    // The toolbar sits above the card.
    const barBox = (await page.locator('[data-full-view-bar]').boundingBox())!;
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(cardBox.y + 1);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await shot(page, '2A-phone-open');
    // The phone's paperclip: the card's 36 px button, first in its toolbar; a chosen picture is a tile in the card.
    const clip = card(page).locator('[data-fcomp-foot] > :first-child');
    await expect(clip).toHaveAccessibleName('Attach files');
    expect(Math.round((await clip.boundingBox())!.width)).toBe(36);
    const crop = await page.screenshot({ clip: { x: 0, y: 120, width: 390, height: 260 } });
    await card(page).locator('input[type="file"][data-fcomp-attach]').setInputFiles({ name: 'IMG_0412.png', mimeType: 'image/png', buffer: crop });
    await expect(card(page).locator('[data-fcomp-files] [data-compose-file="done"]')).toHaveCount(1);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await shot(page, '2A-phone-attached');
    await card(page).locator('[data-fcomp-files] [data-compose-file] button').first().tap();
    await expect(card(page).locator('[data-fcomp-files]')).toHaveCount(0);
    // Many files: the tiles scroll inside a capped area, so the card never pushes the toolbar off the top.
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `IMG_04${20 + i}.png`, mimeType: 'image/png', buffer: crop }));
    await card(page).locator('input[type="file"][data-fcomp-attach]').setInputFiles(many);
    await expect(card(page).locator('[data-fcomp-files] [data-compose-file="done"]')).toHaveCount(9);
    const files = card(page).locator('[data-fcomp-files]');
    expect(Math.round((await files.boundingBox())!.height)).toBeLessThanOrEqual(136);
    expect(await files.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await expect(page.locator('[data-full-view-bar]')).toBeInViewport({ ratio: 1 });
    for (let left = 9; left > 0; left--) await card(page).locator('[data-fcomp-files] [data-compose-file] button').first().tap();
    await expect(card(page).locator('[data-fcomp-files]')).toHaveCount(0);

    await card(page).locator('[data-fcomp-minimize]').click();
    await expect(pill(page)).toHaveText('Draft');
    const pillBox = (await pill(page).boundingBox())!;
    const bar = (await page.locator('[data-full-view-bar]').boundingBox())!;
    expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(bar.x);
    expect(Math.abs(pillBox.y + pillBox.height - (bar.y + bar.height))).toBeLessThanOrEqual(1);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await shot(page, '2A-phone-min');
    await pill(page).click();
    await expect(replyField(page)).toBeFocused();
  } finally {
    await context.close();
  }
});

/** The open questions pill in the card's foot: one line, inside the row, clear of its neighbours (owner's iPhone, 2026-11-01). */
async function pillLayout(page: Page) {
  return card(page).evaluate((root) => {
    const q = root.querySelector<HTMLElement>('[data-fcomp-questions]')!;
    const words = q.querySelector('[data-oq-words]')!.firstChild as Text;
    const range = document.createRange();
    range.selectNodeContents(words);
    const box = q.getBoundingClientRect();
    const chips = q.parentElement!.getBoundingClientRect();
    const link = root.querySelector('[data-fcomp-open-thread]')!.getBoundingClientRect();
    const mic = root.querySelector('[data-voice-mic]')?.getBoundingClientRect() ?? null;
    return {
      text: q.textContent!.trim(),
      form: q.getAttribute('data-label-form'),
      lines: range.getClientRects().length,
      height: Math.round(box.height),
      left: box.left,
      right: box.right,
      chipsLeft: chips.left,
      chipsRight: chips.right,
      next: Math.min(link.left, mic?.left ?? Infinity),
      mic: !!mic,
    };
  });
}

test('the open questions pill in the card’s foot never wraps: one line, inside the row, from 320 to 430 px, with and without the mic', async ({ browser }: { browser: Browser }) => {
  const manyBody = [
    ...Array.from({ length: 12 }, (_, i) => [':::question', `Question ${i + 1}: which way?`, '', '- [ ] This', '- [ ] That', ':::', ''].join('\n')),
    ':::action',
    'Run the migration',
    'Needs your badge.',
    ':::',
    '',
    ':::action',
    'Rotate the key',
    'Needs your badge.',
    ':::',
  ].join('\n');
  const oneAndAction = [BODY, '', ':::action', 'Run the migration', 'Needs your badge.', ':::'].join('\n');
  const send = async (subject: string, body: string) => {
    const sent = await world.claude.send({ project_path: world.project, subject, body, attachments: ['shots/checkout.png'] });
    const model = (await (await fetch(new URL(`/api/inbox/threads/${sent.thread_id}/attachments`, world.url))).json()) as { attachments: { id: string }[] };
    return `${world.url}#thread=${sent.thread_id}&file=${model.attachments[0]!.id}&view=full`;
  };
  const cases: { name: string; url: string; full: string }[] = [
    { name: 'one question', url: await send('Pill: one', BODY), full: '1 open question' },
    { name: 'one question, one action item', url: await send('Pill: one and one', oneAndAction), full: '1 question, 1 action item' },
    { name: 'twelve questions, two action items', url: await send('Pill: many', manyBody), full: '12 questions, 2 action items' },
  ];
  const settings = (await (await fetch(new URL('/api/inbox/settings', world.url))).json()) as { serverSession: string };
  const voice = async (on: boolean) => {
    const answer = await fetch(new URL('/api/inbox/settings', world.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: new URL(world.url).origin },
      body: JSON.stringify({ serverSession: settings.serverSession, voice: { on } }),
    });
    expect(answer.status).toBe(200);
  };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  try {
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await context.grantPermissions(['microphone'], { origin: new URL(world.url).origin });
    for (const withMic of [false, true]) {
      await voice(withMic);
      for (const c of cases) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(c.url);
        await page.reload();
        await expect(card(page)).toBeVisible();
        await expect(card(page).locator('[data-fcomp-questions]')).toBeVisible();
        for (const width of [430, 390, 360, 320]) {
          await page.setViewportSize({ width, height: 844 });
          await expect.poll(async () => (await pillLayout(page)).mic, { message: `mic ${withMic} at ${width}` }).toBe(withMic);
          const where = `${c.name}, ${width} px, mic ${withMic}`;
          // The fit runs on a resize: let it settle.
          await expect.poll(async () => (await pillLayout(page)).lines, { message: where }).toBe(1);
          const got = await pillLayout(page);
          expect(got.height, where).toBeLessThanOrEqual(24);
          expect(got.right, `${where}: past the row's end (${JSON.stringify(got)})`).toBeLessThanOrEqual(got.chipsRight + 1);
          expect(got.right, `${where}: over the next button (${JSON.stringify(got)})`).toBeLessThanOrEqual(got.next + 1);
          // Short words only when the long ones do not fit: with the room (no mic, 430) the whole words show.
          if (!withMic && width === 430 && c.name === 'one question') expect(got.text, where).toBe(c.full);
          if (got.form !== 'full') expect(await card(page).locator('[data-fcomp-questions]').getAttribute('aria-label'), where).toBe(c.full);
        }
      }
    }
  } finally {
    await voice(false);
    await context.close();
  }
});

test('on a computer the pill keeps its whole words', async () => {
  const sent = await world.claude.send({ project_path: world.project, subject: 'Pill: computer', body: BODY, attachments: ['shots/checkout.png'] });
  const model = (await (await fetch(new URL(`/api/inbox/threads/${sent.thread_id}/attachments`, world.url))).json()) as { attachments: { id: string }[] };
  await world.page.goto(`${world.url}#thread=${sent.thread_id}&file=${model.attachments[0]!.id}&view=full`);
  await expect(card()).toBeVisible();
  await expect(card().locator('[data-fcomp-questions]')).toHaveText('1 open question');
  await expect(card().locator('[data-fcomp-questions]')).toHaveAttribute('data-label-form', 'full');
});
