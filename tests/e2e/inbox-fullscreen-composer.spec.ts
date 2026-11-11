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
 * words). The card's ⌄ and the toolbar's » do one thing (approval
 * "inbox-fullscreen-gather"): the card, the toolbar and the image's size bar
 * gather into one control in the bottom right corner, which says "Draft"
 * while a reply draft waits and takes focus; one press brings everything back
 * with focus in the field and the words kept. Send goes from full screen,
 * which stays, the card says it went and the draft is gone. An HTML page has
 * Comment (on the whole page) and Reply too. At 390 px (a phone) the card spans the width under the toolbar,
 * the tabs read Comment and Reply, Send is the icon, ⌄ gathers into a 44 px
 * corner control, and the reply comes back working after one tap.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-fullscreen-composer.spec.ts`.
 * PNGs land in PLANNOTATOR_E2E_SHOTS_DIR (default .local/proof/fullscreen-composer).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { forgetFileViewChoice } from './file-view';
import { finger } from './phone-touch';

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
  env: Record<string, string>;
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
const dock = (page = world.page) => page.locator('[data-full-view-dock]');
const toolbar = (page = world.page) => page.locator('[data-full-view-bar]');
/** The corner control everything gathers into (approval "inbox-fullscreen-gather"). */
const corner = (page = world.page) => page.locator('[data-full-view-handle]');
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
    // No agent lookups (the voice setting probes Codex otherwise), and no agent config of the real computer.
    PLANNOTATOR_TEST_SANDBOX: root,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    OPENCODE_CONFIG_DIR: join(root, 'opencode'),
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
    env,
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
  // ⌄ is named for what it does: it hides all the tools, as » does.
  await expect(card().getByRole('button', { name: 'Hide tools' })).toBeVisible();
  // The comment row is the image's own (its field, Mark up, Comment), inside the card; no old band at the foot.
  await expect(card().getByRole('textbox', { name: 'Comment on checkout.png' })).toBeVisible();
  await expect(pane().locator('.ib-imgcompose')).toHaveCount(0);
  // Bottom centre, 600 px wide (round 3), 20 px above the window’s foot; the 30 px buttons, the picked tab 32 px (carved into the tray).
  const box = (await card().boundingBox())!;
  expect(Math.round(box.width)).toBe(600);
  expect(Math.round(box.x + box.width / 2)).toBe(720);
  expect(Math.round(900 - (box.y + box.height))).toBe(20);
  expect(Math.round((await card().locator('[data-fcomp-minimize]').boundingBox())!.height)).toBe(30);
  expect(Math.round((await radios.first().boundingBox())!.height)).toBe(32);
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
  await expect(page.getByRole('tooltip').or(page.locator('[data-pn-tooltip]')).first()).toContainText('Hide tools');
  await shot(page, '2A-expanded-reply-hover', ['dark']);
});

test('⌄ gathers the card, the toolbar and the size bar into the bottom-right corner control, which says "Draft" and takes focus; one press brings everything back, focus in the field, the words kept', async () => {
  const page = world.page;
  // The file's foot (`--ib-fvfoot`, the card's height) holds still through the flight: the card scales down on its way
  // to the corner, and a measure taken then (any change in the pane re-measures) must not shrink the foot.
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' });
  const foot = () => pane().evaluate((el) => getComputedStyle(el).getPropertyValue('--ib-fvfoot').trim());
  const footBefore = await foot();
  expect(parseFloat(footBefore)).toBeGreaterThan(30);
  await card().locator('[data-fcomp-minimize]').click();
  await page.waitForTimeout(170);
  await pane().evaluate((el) => {
    const nudge = document.createElement('span');
    el.appendChild(nudge);
    nudge.remove();
  });
  await page.waitForTimeout(50);
  expect(await foot(), 'mid-flight').toBe(footBefore);
  await page.waitForTimeout(500);
  expect(await foot(), 'landed').toBe(footBefore);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await expect(dock()).toHaveAttribute('data-bar', 'tucked');
  // Everything went: the card (kept, inert: no pill of its own), the toolbar and the image's size bar.
  await expect(card()).toHaveJSProperty('inert', true);
  await expect(card()).toBeHidden();
  await expect(pill()).toHaveCount(0);
  await expect(toolbar()).toHaveJSProperty('inert', true);
  await expect(toolbar()).toBeHidden();
  await expect(pane().locator('.ib-imgbar')).toBeHidden();
  // The corner control: focused, bottom right, 32 px, and it says a reply draft waits.
  await expect(corner()).toBeFocused();
  await expect(corner()).toContainText('Draft');
  await expect(corner()).toHaveAccessibleName(/^Show tools, reply draft/);
  // Landed (it scales in from 0.6 after the tools leave): measured only once it has.
  await expect.poll(async () => Math.round((await corner().boundingBox())!.height)).toBe(32);
  const box = (await corner().boundingBox())!;
  expect(box.x + box.width).toBeGreaterThan(1440 - 40);
  expect(box.y + box.height).toBeGreaterThan(900 - 40);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(200, 400);
  await shot(page, '2A-gathered-draft');

  // One press: the card, the toolbar and the size bar come back; focus is back in the field it was gathered from.
  await corner().click();
  await expect(dock()).toHaveAttribute('data-bar', 'pinned');
  await expect(card()).toHaveJSProperty('inert', false);
  await expect(card()).toBeVisible();
  await expect(toolbar()).toBeVisible();
  await expect(pane().locator('.ib-imgbar')).toBeVisible();
  await expect(replyField()).toBeFocused();
  await expect(replyField()).toHaveValue(WORDS);

  // Gathered, then away and back: every opening of full screen starts with the tools showing, the draft kept.
  await card().locator('[data-fcomp-minimize]').click();
  await expect(dock()).toHaveAttribute('data-bar', 'tucked');
  await page.goto(`${world.url}#thread=${world.threadId}`);
  await page.goto(fileUrl('checkout.png'));
  await expect(dock()).toHaveAttribute('data-bar', 'pinned');
  await expect(card()).toBeVisible();
  await card().getByRole('radio', { name: 'Reply to Claude Code' }).click();
  await expect(replyField()).toHaveValue(WORDS);
});

test('Hide (») gathers the card and the size bar with the toolbar; one press brings them back, focus on »', async () => {
  const page = world.page;
  await page.locator('[data-full-view-hide]').click();
  await expect(dock()).toHaveAttribute('data-bar', 'tucked');
  await expect(card()).toBeHidden();
  await expect(card()).toHaveJSProperty('inert', true);
  await expect(pane().locator('.ib-imgbar')).toBeHidden();
  await expect(corner()).toBeFocused();
  await corner().click();
  await expect(dock()).toHaveAttribute('data-bar', 'pinned');
  await expect(page.locator('[data-full-view-hide]')).toBeFocused();
  await page.mouse.move(200, 400);
  await expect(card()).toBeVisible();
  await expect(card()).toHaveJSProperty('inert', false);
  await expect(pane().locator('.ib-imgbar')).toBeVisible();
});

test('the paperclip attaches to the reply; Send goes from full screen with the file: it stays, the card says it went, the reply is in the thread and the draft is gone', async () => {
  const page = world.page;
  // Round 3: Send first in the reply's row, then the reply box's paperclip (the card's 30 px button).
  await expect(card().locator('[data-fcomp-foot] > :first-child')).toHaveAttribute('data-fcomp-send', '');
  const clip = card().locator('[data-fcomp-foot] .ib-fcomp-clip');
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
  // Empty again: Send is dimmed, and gathered, the corner control no longer says "Draft".
  await expect(card().locator('[data-fcomp-send]')).toBeDisabled();
  await card().getByRole('radio', { name: 'Comment on this image' }).click();
  await card().locator('[data-fcomp-minimize]').click();
  await expect(dock()).toHaveAttribute('data-bar', 'tucked');
  await expect(corner()).not.toContainText('Draft');
  await expect(corner()).not.toHaveAccessibleName(/reply draft/);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(200, 400);
  await shot(page, '2A-gathered-nodraft');
  await corner().click();
  await expect(card()).toBeVisible();
  expect(world.errors).toEqual([]);
});

test('an HTML page: Comment on this page and Reply, as on an image; a comment is kept on the page; ⌄ gathers the card with the toolbar, and one press gives the field back', async () => {
  const page = world.page;
  await page.goto(fileUrl('checkout.html'));
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await expect(card()).toBeVisible();
  await expect(card().getByRole('radiogroup').getByRole('radio')).toHaveCount(2);
  await card().getByRole('radio', { name: 'Comment on this page' }).click();
  await expect(card().getByRole('radio', { name: 'Comment on this page' })).toHaveAttribute('aria-checked', 'true');
  const comment = card().getByRole('textbox', { name: 'Comment on checkout.html' });
  await comment.fill('The footer reads as part of the form.');
  await card().locator('[data-html-page-comment-save]').click();
  await expect(comment).toHaveValue('');
  // Kept on the page as a general comment (it rides the next Send); taken out again so the later tests' Sends carry none.
  const pageComment = async () => {
    const model = (await (await fetch(new URL(`/api/inbox/threads/${world.threadId}/attachments`, world.url))).json()) as { annotations: { id: string; attachment_id: string; annotation: { type: string; text: string } }[] };
    return model.annotations.find((r) => r.attachment_id === world.ids['checkout.html'] && r.annotation.type === 'GLOBAL_COMMENT' && r.annotation.text === 'The footer reads as part of the form.') ?? null;
  };
  await expect.poll(async () => (await pageComment()) !== null).toBe(true);
  const removed = await fetch(new URL(`/api/inbox/annotations/${(await pageComment())!.id}/remove`, world.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(removed.status).toBe(200);
  await card().getByRole('radio', { name: 'Reply to Claude Code' }).click();
  await replyField().click();
  await page.keyboard.type('The footer should stay, with room under the form.');
  await expect.poll(draftOnServer).toBe('The footer should stay, with room under the form.');
  await card().locator('[data-fcomp-minimize]').click();
  await expect(dock()).toHaveAttribute('data-bar', 'tucked');
  await expect(card()).toHaveJSProperty('inert', true);
  await expect(toolbar()).toHaveJSProperty('inert', true);
  await expect(pill()).toHaveCount(0);
  await expect(corner()).toBeFocused();
  await expect(corner()).toContainText('Draft');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(700, 400);
  await shot(page, '2A-html-gathered');
  await corner().click();
  await expect(dock()).toHaveAttribute('data-bar', 'pinned');
  await expect(replyField()).toBeFocused();
  await expect(replyField()).toHaveValue('The footer should stay, with room under the form.');
});

test('a phone (390 px): the card spans the width under the toolbar, Comment and Reply, Send the icon; ⌄ gathers everything into a 44 px corner control', async ({ browser }: { browser: Browser }) => {
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
    await expect(send).toHaveText('Send');
    const cardBox = (await card(page).boundingBox())!;
    expect(Math.round(cardBox.x)).toBe(8);
    expect(Math.round(cardBox.width)).toBe(390 - 16);
    // The toolbar sits above the card.
    const barBox = (await page.locator('[data-full-view-bar]').boundingBox())!;
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(cardBox.y + 1);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await shot(page, '2A-phone-open');
    // Send is at the row's right end, and last in the markup too: Tab follows the screen (WCAG 2.4.3).
    await expect(card(page).locator('[data-fcomp-foot] > :last-child')).toHaveAttribute('data-fcomp-send', '');
    const sendBox = (await card(page).locator('[data-fcomp-send]').boundingBox())!;
    const footBox = (await card(page).locator('[data-fcomp-foot]').boundingBox())!;
    expect(Math.round(footBox.x + footBox.width - (sendBox.x + sendBox.width))).toBeLessThanOrEqual(1);
    // The phone's paperclip: a 44 px button in the reply's row; a chosen picture is a tile in the card.
    const clip = card(page).locator('[data-fcomp-foot] .ib-fcomp-clip');
    await expect(clip).toHaveAccessibleName('Attach files');
    expect(Math.round((await clip.boundingBox())!.width)).toBe(44);
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
    await expect(dock(page)).toHaveAttribute('data-bar', 'tucked');
    await expect(card(page)).toBeHidden();
    await expect(toolbar(page)).toBeHidden();
    await expect(pill(page)).toHaveCount(0);
    await expect(corner(page)).toHaveAccessibleName(/^Show tools, reply draft/);
    await expect.poll(async () => Math.round((await corner(page).boundingBox())!.height)).toBeGreaterThanOrEqual(44);
    const cornerBox = (await corner(page).boundingBox())!;
    expect(cornerBox.width).toBeGreaterThanOrEqual(44);
    expect(cornerBox.height).toBeGreaterThanOrEqual(44);
    expect(cornerBox.x + cornerBox.width).toBeGreaterThan(390 - 40);
    expect(cornerBox.y + cornerBox.height).toBeGreaterThan(844 - 80);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await shot(page, '2A-phone-gathered');
    await corner(page).click();
    await expect(dock(page)).toHaveAttribute('data-bar', 'pinned');
    await expect(replyField(page)).toBeFocused();
    await expect(replyField(page)).toHaveValue(WORDS);
  } finally {
    await context.close();
  }
});

/** The open questions pill in the card's foot: one line, inside the row, clear of its neighbours (owner's iPhone, 2026-11-01). */
async function pillLayout(page: Page) {
  return card(page).evaluate((root) => {
    const q = root.querySelector<HTMLElement>('[data-fcomp-questions]')!;
    // The words are the text inside the pill, whatever wraps them.
    const range = document.createRange();
    const text = document.createTreeWalker(q, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent!.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) }).nextNode()!;
    range.selectNodeContents(text);
    const box = q.getBoundingClientRect();
    const chips = q.parentElement!.getBoundingClientRect();
    const link = root.querySelector('[data-fcomp-open-thread]')!.getBoundingClientRect();
    const mic = root.querySelector('[data-voice-mic]')?.getBoundingClientRect() ?? null;
    // Round 3 (#2846): the mic comes before what rides the Send, Open in thread after it. A neighbour on another row
    // (the chips stacked above, footFit.ts `stack`) is not in the pill's way.
    const sameRow = (r: DOMRect) => r.top < box.bottom - 1 && r.bottom > box.top + 1;
    const overlaps = (r: DOMRect) => sameRow(r) && r.left < box.right - 1 && r.right > box.left + 1;
    return {
      text: q.textContent!.trim(),
      form: q.getAttribute('data-label-form'),
      lines: range.getClientRects().length,
      height: Math.round(box.height),
      left: box.left,
      right: box.right,
      chipsLeft: chips.left,
      chipsRight: chips.right,
      next: link.width > 0 && sameRow(link) ? link.left : Infinity,
      overMic: !!mic && overlaps(mic),
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
    const sent = await world.claude.send({ project_path: world.project, thread: subject.toLowerCase().replace(/\W+/g, '-'), subject, body, attachments: ['shots/checkout.png'] });
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
        await card(page).getByRole('radio', { name: 'Reply' }).tap();
        await expect(card(page).locator('[data-fcomp-questions]')).toBeVisible();
        for (const width of [430, 390, 360, 320]) {
          await page.setViewportSize({ width, height: 844 });
          await expect.poll(async () => (await pillLayout(page)).mic, { message: `mic ${withMic} at ${width}` }).toBe(withMic);
          const where = `${c.name}, ${width} px, mic ${withMic}`;
          // The fit runs on a resize: let it settle.
          await expect
            .poll(async () => {
              const now = await pillLayout(page);
              return now.lines === 1 && now.right <= now.chipsRight + 1 && now.right <= now.next + 1 && !now.overMic;
            }, { message: where })
            .toBe(true);
          const got = await pillLayout(page);
          expect(got.height, where).toBeLessThanOrEqual(24);
          expect(got.right, `${where}: past the row's end (${JSON.stringify(got)})`).toBeLessThanOrEqual(got.chipsRight + 1);
          expect(got.right, `${where}: over the next button (${JSON.stringify(got)})`).toBeLessThanOrEqual(got.next + 1);
          expect(got.overMic, `${where}: over the mic (${JSON.stringify(got)})`).toBe(false);
          // Short words only when the long ones do not fit: with the room (no mic, 430) the whole words show.
          if (!withMic && width === 430 && c.name === 'one question') expect(got.text, where).toBe(c.full);
          if (got.form && got.form !== 'full') expect(await card(page).locator('[data-fcomp-questions]').getAttribute('aria-label'), where).toBe(c.full);
        }
      }
    }
  } finally {
    await voice(false);
    await context.close();
  }
});

test('on a computer the pill keeps its whole words', async () => {
  const sent = await world.claude.send({ project_path: world.project, thread: 'pill-computer', subject: 'Pill: computer', body: BODY, attachments: ['shots/checkout.png'] });
  const model = (await (await fetch(new URL(`/api/inbox/threads/${sent.thread_id}/attachments`, world.url))).json()) as { attachments: { id: string }[] };
  await world.page.goto(`${world.url}#thread=${sent.thread_id}&file=${model.attachments[0]!.id}&view=full`);
  await expect(card()).toBeVisible();
  await card().getByRole('radio', { name: 'Reply' }).click();
  await expect(card().locator('[data-fcomp-questions]')).toHaveText('1 open question');
  await expect(card().locator('[data-fcomp-questions]')).toHaveAttribute('data-label-form', 'full');
});

test('a phone: » or ⌄ gathers, then one tap on the corner control brings the reply back working', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  try {
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(fileUrl('checkout.png'));
    await expect(pane(page)).toHaveAttribute('data-full-view', '');
    for (const from of ['[data-full-view-hide]', '[data-fcomp-minimize]']) {
      await expect(card(page)).toBeVisible();
      await page.locator(from).tap({ timeout: 10_000 });
      await expect(dock(page)).toHaveAttribute('data-bar', 'tucked');
      // Gathered: the reply goes with the tools, whichever bar's button did it.
      await expect(card(page)).toHaveJSProperty('inert', true);
      await expect(toolbar(page)).toHaveJSProperty('inert', true);
      await corner(page).tap({ timeout: 10_000 });
      await expect(dock(page)).toHaveAttribute('data-bar', 'pinned');
      // The reply works as it is: not inert, and a tap in it types.
      await expect(card(page)).toHaveJSProperty('inert', false);
      // A tap, then a real finger (touch events from the DevTools protocol), each focus the field and leave the
      // tools out: nothing gathers them again but a press on » or ⌄.
      await replyField(page).tap({ timeout: 10_000 });
      await expect(replyField(page)).toBeFocused();
      await expect(dock(page)).toHaveAttribute('data-bar', 'pinned');
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const box = (await replyField(page).boundingBox())!;
      const touch = await finger(page, 'chromium');
      await touch.down(box.x + box.width / 2, box.y + box.height / 2, 0, 0, 0);
      await touch.up();
      await expect(replyField(page)).toBeFocused();
      await expect(dock(page)).toHaveAttribute('data-bar', 'pinned');
      await page.keyboard.type(' ok');
      // The words land where the finger put the caret.
      await expect(replyField(page)).toHaveValue(/ ok/);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    }
  } finally {
    await context.close();
  }
});

test('an HTML page: the reply box never runs over the drawer’s foot, at any width, with one line or many, and a phone’s sheet hides it', async ({ browser }: { browser: Browser }) => {
  const res = await fetch(new URL('/api/inbox/annotations', world.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ attachment_id: world.ids['checkout.html'], version: 'current', annotation: { id: 'foot-guard', type: 'COMMENT', text: 'A thought', originalText: 'Almost yours.', blockId: '', startOffset: 0, endOffset: 0, createdA: Date.now() } }),
  });
  expect(res.status).toBe(200);
  const long = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a long reply.`).join('\n');
  for (const width of [1440, 1280, 1100, 900, 768, 390]) {
    const phone = width === 390;
    const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 800 }, hasTouch: phone, isMobile: phone, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await page.goto(fileUrl('checkout.html'));
      await expect(pane(page)).toHaveAttribute('data-full-view', '');
      if (await pill(page).isVisible()) await pill(page).click();
      await card(page).locator('[data-fcomp-mode="reply"]').click();
      await replyField(page).fill(WORDS);
      await page.locator('[data-full-view-comments]').first().click();
      const foot = page.locator('[data-full-view-foot]');
      await expect(foot).toContainText('your next Send');
      for (const words of [WORDS, long]) {
        if (await replyField(page).isVisible()) await replyField(page).fill(words);
        // Hidden under a phone's sheet is fine; a box that shows must clear the foot.
        if (!(await card(page).isVisible())) {
          expect(phone, `${width}: a computer keeps its reply box beside the drawer`).toBe(true);
          continue;
        }
        expect(phone, `${width}: a phone's sheet hides the reply box`).toBe(false);
        const box = (await card(page).boundingBox())!;
        const footBox = (await foot.boundingBox())!;
        expect(box.x + box.width, `${width}: the reply box ends before the foot starts`).toBeLessThanOrEqual(footBox.x);
      }
      if (width <= 1100 && !phone) {
        // The comment list over the box: beside the drawer, centred over the box. Zero height by design; x and width are what it is placed by.
        await card(page).locator('[data-fcomp-comments]').click();
        const list = (await page.locator('.ib-anncard').boundingBox())!;
        const box = (await card(page).boundingBox())!;
        const footBox = (await foot.boundingBox())!;
        expect(list.x + list.width, `${width}: the list ends before the foot starts`).toBeLessThanOrEqual(footBox.x);
        expect(Math.abs(list.x + list.width / 2 - (box.x + box.width / 2)), `${width}: the list is centred over the box`).toBeLessThanOrEqual(1);
      }
    } finally {
      await context.close();
    }
  }
});

type Read = { id: string; author: { kind: string }; body: string; viewing?: string };

/** A thread of its own for what a floating box's Send tells the agent, and the steps those tests repeat. */
async function takes(name: string, attachments: string[], body = 'Takes of the checkout.') {
  const sent = await world.claude.send({ project_path: world.project, thread: name, body, attachments });
  const threadId = sent.thread_id as string;
  const model = (await (await fetch(new URL(`/api/inbox/threads/${threadId}/attachments`, world.url))).json()) as { attachments: { id: string; name: string }[] };
  const open = (file: string) => `${world.url}#thread=${threadId}&file=${model.attachments.find((a) => a.name === file)!.id}&view=full`;
  const people = async (): Promise<Read[]> => ((await world.claude.readThread(threadId)) as { messages: Read[] }).messages.filter((m) => m.author.kind === 'person');
  const newest = async (): Promise<Read> => ((await world.claude.readThread(threadId)) as { messages: Read[] }).messages.at(-1)!;
  /** Writes `words` in the card over what is on screen and sends them. */
  const send = async (target: Page, words: string): Promise<Read> => {
    await expect(card(target)).toBeVisible();
    const radio = card(target).getByRole('radio', { name: 'Reply', exact: false });
    if ((await radio.count()) > 0) await radio.click();
    await replyField(target).fill(words);
    await card(target).locator('[data-fcomp-send]').click();
    await expect(card(target).locator('[data-fcomp-sent]')).toBeVisible();
    await expect.poll(async () => (await newest()).body).toContain(words);
    return newest();
  };
  const reply = async (target: Page, file: string, words: string): Promise<Read> => {
    await target.goto(open(file));
    return send(target, words);
  };
  return { threadId, messageId: sent.message_id as string, open, people, newest, send, reply };
}

test('a Send from the floating box tells the agent which file was on screen, and only the agent; the Comment tab and the thread’s own box stay as they were', async ({ browser }: { browser: Browser }) => {
  const page = world.page;
  const { threadId, messageId, open, newest, reply } = await takes('Which take', ['shots/checkout.png', 'shots/checkout.html']);

  // An image: the words stay the person's, and the agent reads the name beside them.
  const onImage = await reply(page, 'checkout.png', 'This one reads best.');
  expect(onImage.viewing).toContain(`while viewing \`checkout.png\`, from the `);
  expect(onImage.viewing!.endsWith(` message ${messageId}.)`), onImage.viewing).toBe(true);
  // An HTML page: the same line, naming the page.
  expect((await reply(page, 'checkout.html', 'Or this page.')).viewing).toContain('`checkout.html`');

  // A comment on the file on screen, then the Reply tab: the comment names the file, so no second line.
  await page.goto(open('checkout.png'));
  await card().getByRole('radio', { name: 'Comment on this image' }).click();
  await card().getByRole('textbox', { name: 'Comment on checkout.png' }).fill('The footer is too tall.');
  await card().getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(card().getByRole('textbox', { name: 'Comment on checkout.png' })).toHaveValue('');
  await card().getByRole('radio', { name: 'Reply to Claude Code' }).click();
  await replyField().fill('And see my comment.');
  await card().locator('[data-fcomp-send]').click();
  await expect(card().locator('[data-fcomp-sent]')).toBeVisible();
  const commented = await newest();
  expect(commented.body).toContain('The footer is too tall.');
  expect(commented.viewing).toBeUndefined();

  // A phone's card: the same line.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  try {
    const phonePage = await phone.newPage();
    expect((await reply(phonePage, 'checkout.png', 'From the phone, this one.')).viewing).toContain('`checkout.png`');
  } finally {
    await phone.close();
  }

  // The thread's own box, with no file open and with one open beside it: exactly as it always was.
  const fromBox = async (url: string, words: string): Promise<Read> => {
    await page.goto(url);
    await page.getByRole('button', { name: 'Reply', exact: true }).first().click();
    await page.locator('.ib-rbox textarea').fill(words);
    await page.locator('.ib-rbox textarea').press('ControlOrMeta+Enter');
    await expect.poll(async () => (await newest()).body).toBe(words);
    return newest();
  };
  expect((await fromBox(`${world.url}#thread=${threadId}`, 'From the thread itself.')).viewing).toBeUndefined();
  expect((await fromBox(open('checkout.png').replace('view=full', 'view=side'), 'From the box beside the file.')).viewing).toBeUndefined();

  // The person's thread shows their words: the line is the agent's only.
  await page.goto(`${world.url}#thread=${threadId}`);
  await expect(page.getByText('This one reads best.').first()).toBeVisible();
  await expect(page.locator('body')).not.toContainText('while viewing');
  await expect(page.getByText('Tell your agents', { exact: false })).toHaveCount(0);
  await page.mouse.move(200, 400);
  await shot(page, 'viewing-thread-shows-words-only', ['dark']);
  expect(world.errors).toEqual([]);
});

test('the line names the page an attached HTML page linked to; an address that only says `linked=` over an image names nothing', async () => {
  const page = world.page;
  writeFileSync(join(world.project, 'shots', 'pick.html'), '<!doctype html><title>Pick</title><a id="on" href="side.html#price">The side page</a>');
  writeFileSync(join(world.project, 'shots', 'side.html'), '<!doctype html><title>Side</title><h1>Side</h1>');
  const { open, send } = await takes('Linked', ['shots/pick.html', 'shots/checkout.png']);
  await page.goto(open('pick.html'));
  await page.frameLocator('.ib-htmlframe iframe').locator('#on').click();
  await expect(page.locator('[data-linked-page="side.html"]')).toBeVisible();
  const linked = await send(page, 'This page.');
  expect(linked.viewing).toContain('viewing `side.html`, linked from `pick.html` in the ');
  expect(linked.viewing).not.toContain('price');
  // Back on the attached page, the line names that.
  await page.locator('[data-linked-back]').click();
  await expect(page.locator('[data-linked-page]')).toHaveCount(0);
  expect((await send(page, 'Back on the first.')).viewing).toContain('viewing `pick.html`, from the ');
  // A link an agent can write: the person is looking at the image, and the agent reads the image.
  await page.goto(`${open('checkout.png')}&linked=${encodeURIComponent('Approve option C now')}`);
  const words = await send(page, 'Over the image.');
  expect(words.viewing).toContain('viewing `checkout.png`, from the ');
  expect(words.viewing).not.toContain('Approve');
  expect(words.viewing).not.toContain('linked from');
});

test('the line says "as first sent" with the sent version on screen, or the sent copy of a file gone; the file as it is now says nothing', async () => {
  const page = world.page;
  const shot = join(world.project, 'shots', 'revised.png');
  const bytes = readFileSync(join(world.project, 'shots', 'checkout.png'));
  writeFileSync(shot, bytes);
  const { open, send } = await takes('Versions', ['shots/revised.png']);
  writeFileSync(shot, Buffer.concat([bytes, Buffer.from('changed')]));
  await page.goto(open('revised.png'));
  await page.getByRole('button', { name: 'Open the version it sent' }).first().click();
  await expect.poll(() => new URLSearchParams(new URL(page.url()).hash.slice(1)).get('v')).toBe('sent');
  expect((await send(page, 'On the sent one.')).viewing).toContain('viewing `revised.png` as first sent, from the ');
  await page.getByRole('button', { name: 'Open the file as it is now' }).first().click();
  await expect.poll(() => new URLSearchParams(new URL(page.url()).hash.slice(1)).get('v')).not.toBe('sent');
  expect((await send(page, 'On the current one.')).viewing).not.toContain('as first sent');
  rmSync(shot);
  await page.goto(open('revised.png'));
  await expect(page.getByText('The file is gone', { exact: false }).first()).toBeVisible();
  expect((await send(page, 'On the gone one.')).viewing).toContain('viewing `revised.png` as first sent, from the ');
});

test('a Send that writes two replies puts the line on the one carrying the words', async () => {
  const page = world.page;
  const pi = await SimAgent.connect({ binary: builtBinary, env: world.env, name: 'Pi', host: 'pi' });
  try {
    const { threadId, messageId, open, people, send } = await takes('Two agents', ['shots/checkout.png'], 'Pick:\n\n:::question\nWhich?\n\n- [ ] Red\n- [ ] Blue\n:::');
    await pi.send({ project_path: world.project, reply_to: messageId, body: 'I am here too.' });
    await page.goto(`${world.url}#thread=${threadId}`);
    await page.getByText('Red', { exact: true }).first().click();
    await expect.poll(async () => {
      const thread = (await world.claude.readThread(threadId)) as { messages: { questions?: { state: string }[] }[] };
      return thread.messages[0]!.questions?.[0]?.state;
    }).toBe('picked');
    await page.goto(open('checkout.png'));
    await send(page, 'Words for the last agent.');
    await expect.poll(async () => (await people()).length).toBe(2);
    const [picks, words] = await people();
    expect(picks!.body).not.toContain('Words for the last agent.');
    expect(picks!.viewing).toBeUndefined();
    expect(words!.body).toContain('Words for the last agent.');
    expect(words!.viewing).toContain('`checkout.png`');
  } finally {
    await pi.close().catch(() => {});
  }
});

test('the line says the time in the person’s own time zone, not the server’s', async ({ browser }: { browser: Browser }) => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone === 'Asia/Tokyo' ? 'Pacific/Honolulu' : 'Asia/Tokyo';
  const elsewhere = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: zone });
  try {
    const { threadId, reply } = await takes('Time zone', ['shots/checkout.png']);
    const read = await reply(await elsewhere.newPage(), 'checkout.png', 'From far away.');
    const thread = (await world.claude.readThread(threadId)) as { messages: { created_at: string }[] };
    const there = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone }).format(new Date(thread.messages[0]!.created_at)).replace(/\s/g, ' ');
    expect(read.viewing).toContain(`from the ${there} message`);
  } finally {
    await elsewhere.close();
  }
});
