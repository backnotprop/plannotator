import { chromium, expect, test, webkit, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { E2E_LAUNCH_OFF, inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/fullscreen-keyboard'));

const KEYBOARD = 336;
const VIEWPORT = { width: 390, height: 844 };

const PAGE = `<!doctype html><meta charset="utf-8"><title>Fernway checkout</title><style>
body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f4f2ed;color:#1d1b18}
header{padding:22px 64px;background:#fff;border-bottom:1px solid #e6e2da;font:700 26px Georgia,serif}
main{display:grid;grid-template-columns:1fr 1fr;gap:40px;padding:46px 64px}
.card{background:#fff;border:1px solid #e6e2da;border-radius:16px;padding:28px 32px;min-height:260px}
h1{font:700 56px/1.05 Georgia,serif;margin:0 0 26px}footer{position:fixed;left:0;right:0;bottom:0;padding:22px 64px;background:#1f1d1a;color:#b9b3a8}
</style><header>Fernway</header><main><div><h1>Almost yours.</h1><div class="card">Shipping address</div></div><div class="card">Order summary · $104.00</div></main>
<footer>Continue to review →</footer>`;

const BODY = [
  'The checkout on a phone, as a screenshot and as the page itself.',
  '',
  ':::question',
  'Keep the footer sticky on phones?',
  '',
  '- [ ] Yes',
  '- [ ] No',
  ':::',
  '',
  ':::question',
  'Show the promo code field?',
  '',
  '- [ ] Yes',
  '- [ ] No',
  ':::',
].join('\n');

interface World {
  url: string;
  claude: SimAgent;
  threadId: string;
  ids: Record<string, string>;
}

let world: World;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-fullscreen-keyboard-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const trap = join(root, 'trap');
  mkdirSync(home);
  mkdirSync(trap);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ...E2E_LAUNCH_OFF, experimental: { decisionMode: true }, inboxBoard: true, inboxBoardIntro: { shownAt: new Date().toISOString() } }));
  writeFileSync(join(trap, 'tailscale'), '#!/bin/sh\necho "inbox-fullscreen-keyboard: tailscale must not run" >&2\nexit 97\n');
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = {
    PATH: `${trap}:${process.env.PATH ?? ''}`,
    HOME: home,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_FEEDBACK_URL: 'http://127.0.0.1:9/feedback',
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
  writeFileSync(join(project, 'shots', 'checkout.html'), PAGE);
  const maker = await browser.newContext({ viewport: { width: 1170, height: 2532 }, deviceScaleFactor: 1 });
  const makerPage = await maker.newPage();
  await makerPage.setContent(PAGE);
  writeFileSync(join(project, 'shots', 'checkout.png'), await makerPage.screenshot());
  await maker.close();

  world = { url, claude: await SimAgent.connect({ binary: builtBinary, env, name: 'Claude Code', host: 'claude-code' }), threadId: '', ids: {} };
  const sent = await world.claude.send({ project_path: project, subject: 'Checkout: the sticky footer on phones', body: BODY, attachments: ['shots/checkout.png', 'shots/checkout.html'] }, { wakes: true });
  world.threadId = sent.thread_id as string;
  const model = (await (await fetch(new URL(`/api/inbox/threads/${world.threadId}/attachments`, url))).json()) as { attachments: { id: string; name: string }[] };
  for (const a of model.attachments) world.ids[a.name] = a.id;
});

test.afterAll(async () => {
  try {
    if (world) await world.claude.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const fileUrl = (name: string) => `${world.url}#thread=${world.threadId}&file=${world.ids[name]}&view=full`;

async function keyboardUp(page: Page): Promise<number> {
  await page.evaluate((keyboard) => {
    const vv = window.visualViewport!;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => window.innerHeight - keyboard });
    vv.dispatchEvent(new Event('resize'));
  }, KEYBOARD);
  const visible = VIEWPORT.height - KEYBOARD;
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--ib-vvh'))).toBe(`${visible}px`);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  return visible;
}

const keyboardTop = (page: Page) => page.evaluate(() => window.visualViewport!.offsetTop + window.visualViewport!.height);

async function clearOfKeyboard(page: Page, parts: Record<string, Locator>): Promise<void> {
  const top = await keyboardTop(page);
  for (const [name, part] of Object.entries(parts)) {
    const box = await part.boundingBox();
    expect(box, `${name} is drawn`).not.toBeNull();
    expect.soft(box!.y, `${name} starts on screen`).toBeGreaterThanOrEqual(-0.5);
    expect.soft(box!.y + box!.height, `${name} ends above the keyboard (at ${top})`).toBeLessThanOrEqual(top + 0.5);
  }
}

async function shot(page: Page, tag: string, name: string): Promise<void> {
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.evaluate((keyboard) => {
      const box = document.createElement('div');
      box.id = 'e2e-keyboard';
      box.textContent = 'keyboard';
      box.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${keyboard}px;z-index:2147483647;pointer-events:none;background:rgba(120,120,128,0.92);color:#fff;font:600 15px system-ui;display:grid;place-items:center`;
      document.body.appendChild(box);
    }, KEYBOARD);
    await page.screenshot({ path: join(shotsDir, `${tag}-${name}-${scheme}.png`) });
    await page.evaluate(() => document.getElementById('e2e-keyboard')?.remove());
  }
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
}

for (const phone of [{ browserName: 'webkit' as const }, { browserName: 'chromium' as const }]) {
  test.describe(`a phone in ${phone.browserName}`, () => {
    let browser: Browser | null = null;
    let contexts: BrowserContext[] = [];
    const tag = phone.browserName;
    test.beforeAll(async () => {
      browser = phone.browserName === 'webkit' ? await webkit.launch({ args: [] }) : await chromium.launch();
    });
    test.afterEach(async () => {
      await Promise.all(contexts.map((c) => c.close()));
      contexts = [];
    });
    test.afterAll(async () => {
      await browser?.close();
    });
    async function open(): Promise<Page> {
      const context = await browser!.newContext({ viewport: VIEWPORT, deviceScaleFactor: 3, isMobile: phone.browserName === 'chromium', hasTouch: true, colorScheme: 'dark', reducedMotion: 'reduce' });
      contexts.push(context);
      return context.newPage();
    }

    test("Decision mode's card: its note stays above the keyboard", async () => {
      const page = await open();
      await page.goto(`${world.url}#thread=${world.threadId}`);
      const decide = page.locator('[data-thread-decide]');
      await expect(async () => {
        if (!(await decide.isVisible())) await page.locator('section.ib-pane [data-open-questions]').first().click({ timeout: 2_000 });
        await expect(decide).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
      await decide.click();
      const dialog = page.locator('[data-decision-mode]');
      await expect(dialog).toBeVisible();
      await dialog.locator('[data-decision-note]').click();
      const note = dialog.locator('textarea.ib-dm-ta');
      await expect(note).toBeFocused();
      await keyboardUp(page);
      await note.evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
      await shot(page, tag, 'decision-note');
      await clearOfKeyboard(page, { 'the note': note, 'the dialog': dialog });
    });

    test("an image in full screen: the composer's Comment and Reply sit on the keyboard, the image shrinks above, the toolbar stays", async () => {
      const page = await open();
      await page.goto(fileUrl('checkout.png'));
      const card = page.locator('[data-fcomp]');
      await expect(card).toBeVisible();
      await card.getByRole('radio', { name: 'Comment' }).click();
      const comment = card.getByRole('textbox', { name: 'Comment on checkout.png' });
      await comment.focus();
      await comment.fill('The second picture first, then the other two');
      const top = await keyboardUp(page);
      await shot(page, tag, 'image-comment');
      await clearOfKeyboard(page, {
        'the comment field': comment,
        'the Comment button': card.locator('.ib-csave'),
        'the toolbar': page.locator('[data-full-view-bar]'),
        'the image': page.locator('.ib-imgstage'),
      });
      const cardBox = (await card.boundingBox())!;
      expect.soft(top - (cardBox.y + cardBox.height), 'the card sits on the keyboard').toBeLessThanOrEqual(24);
      const bar = (await page.locator('[data-full-view-bar]').boundingBox())!;
      expect.soft(bar.y + bar.height, 'the toolbar ends above the card').toBeLessThanOrEqual(cardBox.y + 1);

      await card.getByRole('radio', { name: 'Reply' }).click();
      const reply = card.locator('[data-fcomp-field] textarea');
      await expect(reply).toBeFocused();
      await reply.fill('The second picture first, then the other two');
      await shot(page, tag, 'image-reply');
      await clearOfKeyboard(page, {
        'the reply field': reply,
        'Send': card.locator('[data-fcomp-send]'),
        'the toolbar': page.locator('[data-full-view-bar]'),
        'the image': page.locator('.ib-imgstage'),
      });
      await reply.fill('');
    });

    test('an HTML page in full screen: its Reply sits on the keyboard', async () => {
      const page = await open();
      await page.goto(fileUrl('checkout.html'));
      await page.locator('[data-fcomp-pill]').click();
      const card = page.locator('[data-fcomp]');
      await expect(card).toBeVisible();
      await card.locator('[data-fcomp-mode="reply"]').click();
      const reply = card.locator('[data-fcomp-field] textarea');
      await reply.focus();
      await keyboardUp(page);
      await shot(page, tag, 'html-reply');
      await clearOfKeyboard(page, { 'the reply field': reply, 'Send': card.locator('[data-fcomp-send]'), 'the toolbar': page.locator('[data-full-view-bar]') });
    });

    test("the reply's comments list: editing a comment stays above the keyboard", async () => {
      const page = await open();
      await page.goto(fileUrl('checkout.png'));
      const card = page.locator('[data-fcomp]');
      await expect(card).toBeVisible();
      await card.getByRole('radio', { name: 'Comment' }).click();
      await card.getByRole('textbox', { name: 'Comment on checkout.png' }).fill(`Crop the header (${tag})`);
      await card.locator('.ib-csave').click();
      await page.goto(`${world.url}#thread=${world.threadId}`);
      const line = page.locator('section.ib-pane .ib-rbox [data-reply-line] [data-foot-summary]');
      if (!(await line.isVisible())) await page.locator('section.ib-pane .ib-pfoot').getByRole('button', { name: /Reply|Edit draft/ }).first().click();
      await line.click();
      if ((await line.getAttribute('data-foot-summary')) === 'sheet')
        await page.getByRole('dialog', { name: 'Goes with this reply' }).getByRole('button', { name: 'Review comments' }).click();
      const sheet = page.locator('.ib-annpop');
      await expect(sheet).toBeVisible();
      await sheet.locator(`[data-annotation-row]`, { hasText: `Crop the header (${tag})` }).getByRole('button', { name: 'Edit' }).click();
      const field = sheet.locator('.ib-aed');
      await expect(field).toBeFocused();
      await keyboardUp(page);
      await shot(page, tag, 'comments-edit');
      await clearOfKeyboard(page, { 'the comment being edited': field, 'Save': sheet.locator('.ib-abt').getByRole('button', { name: 'Save' }) });
    });

    test("the Board's New card: its notes and Add stay above the keyboard", async () => {
      const page = await open();
      await page.goto(`${world.url}#board`);
      await page.locator('[data-board-new]').click();
      const dialog = page.locator('[data-dialog="new-card"]');
      await expect(dialog).toBeVisible();
      const notes = dialog.locator('[data-new-card-notes]');
      await notes.focus();
      await keyboardUp(page);
      await shot(page, tag, 'new-card');
      await clearOfKeyboard(page, { 'the title': dialog.locator('[data-new-card-title]'), 'the notes': notes, 'the dialog': dialog });
      await expect(dialog.locator('[data-new-card-add]').first()).toBeInViewport();
    });

    test('the Feedback sheet: its message and Send stay above the keyboard', async () => {
      const page = await open();
      await page.goto(world.url);
      await page.locator('.ib-lhead .ib-sb-trigger').click();
      await page.locator('[data-feedback-nav]').click();
      const message = page.locator('[data-feedback-message]');
      await expect(message).toBeVisible();
      await message.focus();
      await keyboardUp(page);
      await shot(page, tag, 'feedback');
      await clearOfKeyboard(page, { 'the message': message, 'the contact field': page.locator('[data-feedback-contact]'), 'Send': page.locator('[data-feedback-send]') });
    });
  });
}
