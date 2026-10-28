/**
 * One viewer for a thread's images and files (approval "inbox-image-viewer",
 * 2026-10-15), proved in a real browser against the compiled binary under a
 * temp data dir: an agent sends three messages whose text shows images and
 * which attach files; the store captures the images at send; a click on an
 * image in a message opens it full screen in the file viewer; `]` `[` step
 * through everything in reading order (each message's images in text order,
 * then its attached files), keeping the frame and replacing the route (one
 * Back to the thread); the peek opens a picture list under full screen's
 * toolbar (above the bar beside the thread; one row per message, the open
 * file ringed) and owns the keys while open; an inline
 * image takes a comment and a markup and rides the Send under its path and
 * message; an image the agent overwrites says "Changed since Claude sent it"
 * and opens the version it sent; a typed comment asks before a step; on an
 * iPhone (WebKit) the toolbar's ⋯ opens the peek as a bottom sheet; and plan
 * review's annotate surface gets the light version (full screen, ← →, the
 * peek, no pen), whose Actual size shows an image at its real size.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-image-viewer.spec.ts`.
 * PNGs, light and dark, land in PLANNOTATOR_E2E_SHOTS_DIR (default .local/proof/image-viewer).
 */

import { expect, test, webkit, devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/image-viewer'));

/** A small checkout screen, drawn by the browser into a real PNG. */
function screen(title: string, tag: string, accent: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:15px system-ui,sans-serif;background:#f4f3ef;color:#18181b}
header{display:flex;justify-content:space-between;align-items:center;padding:14px 22px;background:#fff;border-bottom:1px solid #e4e4e7}
.tag{background:#18181b;color:#fff;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600}
main{max-width:560px;margin:28px auto;background:#fff;border-radius:12px;padding:22px;box-shadow:0 1px 3px #0001}
.f{border:1px solid #d4d4d8;border-radius:8px;padding:10px;margin:8px 0;color:#71717a}
button{width:100%;padding:13px;border:0;border-radius:9px;background:${accent};color:#fff;font:600 15px system-ui;margin-top:10px}
</style><header><b>Plantshop · ${title}</b><span class="tag">${tag}</span></header><main>${body}<button>Continue</button></main>`;
}
const FIELDS = '<h3>Where should we send it?</h3><div class="f">Dana Whitfield</div><div class="f">418 Larch St</div><div class="f">dana@example.com</div>';

const EMPTY_STATES = ['# Empty states', '', 'What the orders page says before the first order.', '', '## Copy', '', 'No orders yet. Start your first jungle.', ''].join('\n');

const PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 44 >> stream
BT /F1 18 Tf 24 70 Td (Receipt spec) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF
`;

interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  project: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threadId: string;
  /** File name to its att_ id (inline images and attachments alike). */
  ids: Record<string, string>;
}

let world: World;

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(shotsDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

async function png(browser: Browser, html: string, width: number, height: number): Promise<Buffer> {
  const maker = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await maker.newPage();
  await page.setContent(html);
  const bytes = await page.screenshot();
  await maker.close();
  return bytes;
}

const pane = () => world.page.locator('[data-attachment-pane]');
/** The position: the stepper's label beside the thread, the toolbar's N/M in full screen (both name it the same way). */
const label = () => world.page.locator('[data-step-label], [data-full-view-position]');

/** "2 of 7, checkout-b.png": the open file as the stepper (or full screen's N/M) names it. */
async function expectAt(page: Page, position: number, name: string): Promise<void> {
  await expect(page.locator('[data-step-label], [data-full-view-position]')).toHaveAttribute('aria-label', `${position} of 7, ${name}. Show every file in this thread`);
  await expect(page.locator('[data-attachment-pane]')).toHaveAttribute('data-attachment-pane', world.ids[name]!);
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-image-viewer-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const trap = join(root, 'trap');
  mkdirSync(home);
  mkdirSync(trap);
  // Nothing here may reach the real tailscale CLI.
  writeFileSync(join(trap, 'tailscale'), '#!/bin/sh\necho "inbox-image-viewer: tailscale must not run" >&2\nexit 97\n');
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = { PATH: `${trap}:${process.env.PATH ?? ''}`, HOME: home, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9' };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();

  const project = scratchProject(join(root, 'src'), 'plantshop');
  for (const dir of ['design', 'docs', 'shots']) mkdirSync(join(project, dir));
  writeFileSync(join(project, 'design', 'checkout-a-single-page.png'), await png(browser, screen('Checkout', 'A · One page', '#2f6f5e', FIELDS), 1200, 760));
  writeFileSync(join(project, 'design', 'checkout-b-steps.png'), await png(browser, screen('Checkout', 'B · Three steps', '#2f6f5e', `<p>① Shipping ② Payment ③ Review</p>${FIELDS}`), 1200, 760));
  writeFileSync(join(project, 'design', 'checkout-c-drawer.png'), await png(browser, screen('Checkout', 'C · Drawer', '#2f6f5e', '<h3>Your cart</h3><div class="f">Monstera · $34</div><div class="f">Fiddle leaf · $52</div>'), 1200, 760));
  writeFileSync(join(project, 'design', 'empty-orders.png'), await png(browser, screen('Orders', 'Empty', '#2f6f5e', '<h3>No orders yet</h3><p>Start your first jungle.</p>'), 1200, 760));
  writeFileSync(join(project, 'shots', 'checkout-mobile.png'), await png(browser, screen('Checkout', 'Mobile', '#2f6f5e', FIELDS), 390, 760));
  writeFileSync(join(project, 'docs', 'empty-states.md'), EMPTY_STATES);
  writeFileSync(join(project, 'docs', 'receipt-spec.pdf'), PDF);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
  });
  world = {
    root,
    dataDir,
    env,
    url,
    project,
    claude: await SimAgent.connect({ binary: builtBinary, env, name: 'Claude', host: 'claude-code' }),
    context,
    page,
    errors,
    threadId: '',
    ids: {},
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

test('an agent sends three messages: images in their text are captured at send, attachments as before', async () => {
  const first = await world.claude.send({
    project_path: world.project,
    subject: 'Checkout: three directions',
    body: ['Three directions for checkout.', '', '![A: one page](design/checkout-a-single-page.png)', '', '![B: three steps](design/checkout-b-steps.png)', '', '![C: a drawer](design/checkout-c-drawer.png)', '', 'I lean to B.'].join('\n'),
  });
  const second = await world.claude.send({
    project_path: world.project,
    body: ['The empty orders page, and its copy:', '', '![Empty orders](design/empty-orders.png)'].join('\n'),
    attachments: ['docs/empty-states.md'],
  });
  const third = await world.claude.send({
    project_path: world.project,
    body: 'The phone checkout and the receipt spec.',
    attachments: ['shots/checkout-mobile.png', 'docs/receipt-spec.pdf'],
  });
  expect(second.thread_id).toBe(first.thread_id);
  expect(third.thread_id).toBe(first.thread_id);
  world.threadId = first.thread_id;
  await world.page.goto(`${world.url}#thread=${world.threadId}`);
  const thread = await world.page.evaluate(async (id) => (await (await fetch(`/api/inbox/threads/${id}`)).json()).thread, world.threadId);
  for (const message of thread.messages) {
    for (const file of [...(message.inline_images ?? []), ...(message.attachments ?? [])] as { name: string; id: string }[]) world.ids[file.name] = file.id;
  }
  expect(thread.messages[0].inline_images.map((i: { ref: string }) => i.ref)).toEqual([
    'design/checkout-a-single-page.png',
    'design/checkout-b-steps.png',
    'design/checkout-c-drawer.png',
  ]);
  expect(Object.keys(world.ids)).toEqual(['checkout-a-single-page.png', 'checkout-b-steps.png', 'checkout-c-drawer.png', 'empty-orders.png', 'empty-states.md', 'checkout-mobile.png', 'receipt-spec.pdf']);
});

test('a click on an image in a message opens it full screen in the file viewer; ] and [ step in reading order, keep the frame, and one Back returns', async () => {
  const page = world.page;
  const inlineB = page.locator(`.ib-body img[data-inline-image="${world.ids['checkout-b-steps.png']}"]`);
  await expect(inlineB).toBeVisible();
  // A captured image is a button for the keyboard too.
  await expect(inlineB).toHaveAttribute('role', 'button');
  await inlineB.click();
  await expect(pane()).toHaveClass(/ib-full/);
  await expectAt(page, 2, 'checkout-b-steps.png');
  // Full screen: no header, one toolbar.
  await expect(pane().locator('[data-header-from]')).toHaveCount(0);
  await expect(page.locator('[data-full-view-bar]')).toBeVisible();
  await expect(pane().locator('.ib-imgstage img')).toBeVisible();
  await shot(page, '01-inline-image-full-screen');
  for (const [position, name] of [
    [3, 'checkout-c-drawer.png'],
    [4, 'empty-orders.png'],
    [5, 'empty-states.md'],
    [6, 'checkout-mobile.png'],
    [7, 'receipt-spec.pdf'],
  ] as const) {
    await page.keyboard.press(']');
    await expectAt(page, position, name);
    // A step keeps the frame the person is in.
    await expect(pane()).toHaveClass(/ib-full/);
  }
  await page.keyboard.press(']');
  await expect(page.locator('[data-full-view-chip]')).toContainText('Last file in this thread');
  await page.keyboard.press('[');
  await expectAt(page, 6, 'checkout-mobile.png');
  // Stepping replaced the route: one Back returns to the thread.
  await page.goBack();
  await expect(pane()).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#thread=${world.threadId}$`));
  // Enter on a captured image opens it too.
  await page.locator(`.ib-body img[data-inline-image="${world.ids['checkout-a-single-page.png']}"]`).focus();
  await page.keyboard.press('Enter');
  await expectAt(page, 1, 'checkout-a-single-page.png');
  await expect(pane()).toHaveClass(/ib-full/);
});

test('the peek: a picture list above the pill, one row per message, the open file ringed; keys only while open; Enter opens and focus returns to the pill', async () => {
  const page = world.page;
  await label().click();
  const peek = page.getByRole('grid', { name: 'Files in this thread' });
  await expect(peek).toBeVisible();
  await expect(peek.getByRole('row')).toHaveCount(3);
  await expect(peek.getByRole('gridcell')).toHaveCount(7);
  await expect(peek.locator('[aria-selected="true"]')).toHaveAttribute('data-peek-item', world.ids['checkout-a-single-page.png']!);
  // Images show their picture; other files a type tile; attached files carry a paperclip.
  await expect(peek.locator(`[data-peek-item="${world.ids['checkout-b-steps.png']}"] img`)).toBeVisible();
  await expect(peek.locator(`[data-peek-item="${world.ids['empty-states.md']}"]`)).toContainText('MD');
  await expect(peek.locator('[data-peek-attached]')).toHaveCount(3);
  // It floats under full screen's toolbar and moves nothing under it.
  const placement = await page.evaluate(() => {
    const grid = document.querySelector('[data-step-list]')!.getBoundingClientRect();
    const bar = document.querySelector('[data-full-view-bar]')!.getBoundingClientRect();
    return { gridTop: grid.top, barBottom: bar.bottom };
  });
  expect(placement.gridTop).toBeGreaterThanOrEqual(placement.barBottom);
  await page.keyboard.press('ArrowRight');
  await expect(peek.locator(`[data-peek-item="${world.ids['checkout-b-steps.png']}"]`)).toBeFocused();
  // ] is not a step while the peek is open.
  await page.keyboard.press(']');
  await expectAt(page, 1, 'checkout-a-single-page.png');
  await page.keyboard.press('ArrowRight');
  await shot(page, '02-peek-open-full-screen');
  await page.keyboard.press('ArrowDown');
  await expect(peek.locator(`[data-peek-item="${world.ids['empty-states.md']}"]`)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(peek.locator(`[data-peek-item="${world.ids['empty-orders.png']}"]`)).toBeFocused();
  await page.keyboard.press('Enter');
  await expectAt(page, 4, 'empty-orders.png');
  await expect(peek).toBeHidden();
  await expect(label()).toBeFocused();
  await expect(page.locator('[data-step-live]')).toHaveText(/^4 of 7, empty-orders\.png, PNG image, in Claude's .* message$/);
  // Esc closes it and hands focus back.
  await page.keyboard.press('ArrowDown');
  await expect(peek).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(peek).toBeHidden();
  await expect(label()).toBeFocused();
  await expect(pane()).toBeVisible();
});

test('an image in a message takes a comment and a markup, like an attached image', async () => {
  const page = world.page;
  await label().click();
  await page.getByRole('gridcell', { name: /^checkout-b-steps\.png/ }).click();
  await expectAt(page, 2, 'checkout-b-steps.png');
  await pane().getByRole('button', { name: 'Mark up' }).last().click();
  const stage = page.locator('[data-pn-image-annotator-stage] canvas').first();
  await expect(stage).toBeVisible();
  const box = (await stage.boundingBox())!;
  await page.locator('[data-pn-image-annotator-toolbar] button[title="Circle (3)"]').click();
  const at = (x: number, y: number) => ({ x: box.x + box.width * x, y: box.y + box.height * y });
  await page.mouse.move(at(0.36, 0.11).x, at(0.36, 0.11).y);
  await page.mouse.down();
  await page.mouse.move(at(0.5, 0.15).x, at(0.5, 0.15).y, { steps: 8 });
  await page.mouse.move(at(0.64, 0.19).x, at(0.64, 0.19).y, { steps: 8 });
  await page.mouse.up();
  // Enter adds the drawing to the reply at once; the words after it are its note.
  await page.keyboard.press('Enter');
  await expect(pane().locator('[data-image-composer] [data-markup-kept] img')).toBeVisible();
  await pane().getByRole('textbox', { name: 'A note with your drawing on checkout-b-steps.png' }).fill('Make step 1 bold, and say which step you are on.');
  await shot(page, '03-inline-image-comment-and-markup');
  await pane().getByRole('button', { name: 'Add note', exact: true }).click();
  await expect(pane().locator('.ib-apanel')).toContainText('Make step 1 bold');
  await shot(page, '04-inline-image-comment-saved');
});

test('an image the agent overwrites says it changed since it was sent, and opens the version it sent', async ({ browser }) => {
  const page = world.page;
  writeFileSync(join(world.project, 'design', 'checkout-c-drawer.png'), await png(browser, screen('Checkout', 'C · Drawer v2', '#7c3aed', '<h3>Your cart (v2)</h3>'), 1200, 760));
  // Back to the window: the files are read again.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.keyboard.press(']');
  await expectAt(page, 3, 'checkout-c-drawer.png');
  // Full screen: the changed line is the chip at the top left; the whole sentence is its tooltip (ui's Tooltip, never a native title).
  const line = pane().locator('[data-full-view-changed]');
  await expect(line).toContainText('Changed since sent');
  await expect(line).not.toHaveAttribute('title', /./);
  await line.locator('.ib-fvver-t').hover();
  await expect(page.locator('[data-side].bg-popover')).toHaveText(/^Changed since Claude sent it/);
  await page.mouse.move(700, 600);
  await expect(page.locator('[data-side].bg-popover')).toHaveCount(0);
  await shot(page, '05-inline-image-changed');
  await line.getByRole('button', { name: 'Open the version it sent' }).click();
  await expect(pane()).toHaveAttribute('data-version', 'sent');
});

test('a typed comment on an image asks before a step', async () => {
  const page = world.page;
  await pane().getByRole('textbox', { name: 'Comment on checkout-c-drawer.png' }).fill('The drawer hides the total.');
  await pane().locator('.ib-imgstage').click();
  await page.keyboard.press(']');
  const guard = page.locator('[data-step-guard]');
  await expect(guard).toBeVisible();
  await expect(guard.getByRole('button', { name: 'Discard and go to empty-orders.png' })).toBeVisible();
  await shot(page, '06-guard');
  await guard.getByRole('button', { name: 'Discard and go to empty-orders.png' }).click();
  await expectAt(page, 4, 'empty-orders.png');
});

test('beside the thread a document keeps its frame, and the peek opens over it', async () => {
  const page = world.page;
  await page.goto(`${world.url}#thread=${world.threadId}`);
  await page.getByRole('button', { name: 'Open empty-states.md' }).first().click();
  await expect(pane()).toBeVisible();
  await expect(pane()).not.toHaveClass(/ib-full/);
  await label().click();
  await expect(page.getByRole('grid', { name: 'Files in this thread' })).toBeVisible();
  await shot(page, '07-peek-beside-the-thread');
  await page.keyboard.press('Escape');
});

test('Send carries the comment on the image in the message, named by its path and its message', async () => {
  const page = world.page;
  await pane().getByRole('button', { name: /^Close / }).click();
  const waiting = world.claude.waitForReply(world.threadId, 40);
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Edit draft' }).click();
  await page.getByRole('textbox', { name: /^Reply to / }).fill('One note on B.');
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  const reply = await waiting;
  expect(reply.status).toBe('replied');
  const body = reply.reply.body as string;
  expect(body).toContain('the images your messages showed');
  expect(body).toMatch(/## design\/checkout-b-steps\.png \(image in your \d{1,2}:\d{2} [AP]M message\)/);
  expect(body).toContain('Make step 1 bold');
  const markup = /`([^`]+\/inbox\/markups\/[0-9a-f]{64}\.png)`/.exec(body);
  expect(markup).not.toBeNull();
  expect(readFileSync(markup![1]!).subarray(1, 4).toString()).toBe('PNG');
  expect(world.errors.filter((e) => !/HTTP 404 \/favicon/.test(e))).toEqual([]);
});

test('on an iPhone (WebKit) an image in a message opens full screen and the toolbar\'s ⋯ opens the peek as a bottom sheet', async () => {
  const { defaultBrowserType: _ignored, ...device } = devices['iPhone 15'];
  const browser = await webkit.launch({ args: [] });
  try {
    const context = await browser.newContext(device);
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${world.url}#thread=${world.threadId}`);
    // After the reply the first message is folded to one line: open it.
    const folded = page.locator(`[data-message-article="${world.threadId}"][data-folded] [data-fold-head]`);
    await expect(page.locator(`[data-message-article="${world.threadId}"]`)).toBeVisible();
    if (await folded.count()) await folded.click();
    const inline = page.locator(`.ib-body img[data-inline-image="${world.ids['checkout-b-steps.png']}"]`);
    await inline.scrollIntoViewIfNeeded();
    await inline.click();
    await expect(page.locator('[data-attachment-pane]')).toHaveAttribute('data-attachment-pane', world.ids['checkout-b-steps.png']!);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotsDir, '08-phone-inline-image-light.png') });
    // One tap on the toolbar's pill.
    await page.locator('[data-full-view-bar] [data-full-view-position]').click();
    const sheet = page.locator('[data-image-peek-sheet]');
    await expect(sheet).toBeVisible();
    // Three across.
    const columns = await sheet.locator('[role="row"]').first().evaluate((row) => getComputedStyle(row.querySelector('[role="presentation"]')!).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(3);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotsDir, '09-phone-peek-sheet-light.png') });
    await sheet.getByRole('gridcell', { name: /^checkout-c-drawer\.png/ }).click();
    await expect(sheet).toBeHidden();
    await expect(page.locator('[data-attachment-pane]')).toHaveAttribute('data-attachment-pane', world.ids['checkout-c-drawer.png']!);
    await context.close();
  } finally {
    await browser.close();
  }
});

test('plan review and annotate get the light version: full screen, ← → across the document\'s images, the same peek, no pen', async ({ browser }) => {
  const root = join(world.root, 'annotate');
  mkdirSync(root, { recursive: true });
  for (const name of ['checkout-a-single-page.png', 'checkout-b-steps.png', 'checkout-c-drawer.png']) writeFileSync(join(root, name), readFileSync(join(world.project, 'design', name)));
  writeFileSync(join(root, 'checkout-mobile.png'), readFileSync(join(world.project, 'shots', 'checkout-mobile.png')));
  const doc = join(root, 'PLAN.md');
  writeFileSync(
    doc,
    ['# Checkout plan', '', '## Options', '', '![A: one page](checkout-a-single-page.png)', '', '![B: three steps](checkout-b-steps.png)', '', '![C: a drawer](checkout-c-drawer.png)', '', '## Mobile', '', '![Phone](checkout-mobile.png)', ''].join('\n'),
  );
  const readyFile = join(root, 'ready.jsonl');
  const env = { PATH: process.env.PATH ?? '', HOME: join(world.root, 'home'), PLANNOTATOR_DATA_DIR: world.dataDir, PLANNOTATOR_READY_FILE: readyFile, PLANNOTATOR_SKIP_BROWSER_OPEN: '1', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_REMOTE: '0' };
  let child: ChildProcess | undefined;
  let url = '';
  try {
    child = spawn(builtBinary, ['annotate', doc], { env, cwd: root, stdio: 'ignore' });
    await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
    url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies(
      [
        ['plannotator-plan-look-choice-resolved', 'true'],
        ['plannotator-announce-tui-herdr-seen', '1'],
        ['plannotator-announce-inbox-seen', '1'],
        ['plannotator-announce-ask-session-seen', '1'],
        ['plannotator-announce-agent-tool-seen', '1'],
      ].map(([name, value]) => ({ name: name!, value: value!, url })),
    );
    const page = await context.newPage();
    await page.goto(url);
    const images = page.locator('article img.cursor-zoom-in');
    await expect(images.nth(3)).toBeVisible();
    await images.nth(1).click();
    const box = page.locator('[data-image-lightbox-stepping]');
    await expect(box).toBeVisible();
    await expect(box.locator('[data-lightbox-count]')).toHaveText('2 of 4');
    await expect(box.locator('[data-lightbox-section]')).toHaveText('in “Options”');
    // No pen, no comment box: annotate the document itself.
    await expect(box.getByRole('button', { name: 'Mark up' })).toHaveCount(0);
    await shot(page, '10-plan-light-version');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(box.locator('[data-lightbox-count]')).toHaveText('4 of 4');
    await expect(box.locator('[data-lightbox-section]')).toHaveText('in “Mobile”');
    await page.keyboard.press('ArrowRight');
    await expect(box.locator('[data-lightbox-end-note]')).toHaveText('Last image in this document');
    await box.locator('[data-lightbox-pill]').click();
    const peek = box.getByRole('grid', { name: 'Images in this document' });
    await expect(peek).toBeVisible();
    await expect(peek.getByRole('row')).toHaveCount(2);
    await shot(page, '11-plan-peek');
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await expect(box.locator('[data-lightbox-count]')).toHaveText('1 of 4');
    await expect(box.locator('[data-lightbox-pill]')).toBeFocused();
    // Esc closes the peek first, then the viewer.
    await box.locator('[data-lightbox-pill]').click();
    await page.keyboard.press('Escape');
    await expect(peek).toBeHidden();
    await expect(box).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(box).toBeHidden();
    await context.close();
  } finally {
    if (url) await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
    if (child && child.exitCode === null) {
      await new Promise((done) => {
        const timer = setTimeout(done, 5_000);
        child!.once('exit', () => {
          clearTimeout(timer);
          done(undefined);
        });
      });
      // inbox-guard: own child (the annotate CLI this test spawned, never an Inbox)
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  }
});

test('Actual size shows an image at its real size: a tall one scrolls, a small one sits centred (#2067)', async ({ browser }) => {
  const root = join(world.root, 'actual-size');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'tall.png'), await png(browser, screen('Checkout', 'Tall', '#2f6f5e', FIELDS.repeat(30)), 1640, 3470));
  writeFileSync(join(root, 'small.png'), await png(browser, '<body style="margin:0;background:#2f6f5e"></body>', 160, 100));
  const doc = join(root, 'PLAN.md');
  writeFileSync(doc, ['# Sizes', '', '![Tall](tall.png)', '', '![Small](small.png)', ''].join('\n'));
  const readyFile = join(root, 'ready.jsonl');
  const env = { PATH: process.env.PATH ?? '', HOME: join(world.root, 'home'), PLANNOTATOR_DATA_DIR: world.dataDir, PLANNOTATOR_READY_FILE: readyFile, PLANNOTATOR_SKIP_BROWSER_OPEN: '1', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_REMOTE: '0' };
  let child: ChildProcess | undefined;
  let url = '';
  try {
    child = spawn(builtBinary, ['annotate', doc], { env, cwd: root, stdio: 'ignore' });
    await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
    url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies(
      [
        ['plannotator-plan-look-choice-resolved', 'true'],
        ['plannotator-announce-tui-herdr-seen', '1'],
        ['plannotator-announce-inbox-seen', '1'],
        ['plannotator-announce-ask-session-seen', '1'],
        ['plannotator-announce-agent-tool-seen', '1'],
      ].map(([name, value]) => ({ name: name!, value: value!, url })),
    );
    const page = await context.newPage();
    await page.goto(url);
    const images = page.locator('article img.cursor-zoom-in');
    await expect(images.nth(1)).toBeVisible();
    await images.nth(0).click();
    const box = page.locator('[data-image-lightbox-stepping]');
    const stage = box.locator('[data-lightbox-stage]');
    const image = box.locator('[data-lightbox-image]');
    // The image is moved with a transform (zoom, #2067), so its box on screen is what is measured.
    const measure = () =>
      image.evaluate((img: HTMLImageElement) => {
        const r = img.getBoundingClientRect();
        const s = img.parentElement!.getBoundingClientRect();
        return {
          width: Math.round(r.width),
          height: Math.round(r.height),
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          left: r.left - s.left,
          right: s.right - r.right,
          top: r.top - s.top,
          bottom: s.bottom - r.bottom,
          stageWidth: s.width,
          stageHeight: s.height,
        };
      });
    // Fit: the tall image fits inside the stage.
    await expect.poll(async () => (await measure()).naturalWidth).toBe(1640);
    await expect.poll(async () => { const m = await measure(); return m.height > 0 && m.height <= m.stageHeight; }).toBe(true);
    await shot(page, '12-actual-size-fit');
    // Actual size: its own pixels, read from its top-left corner.
    await box.locator('[data-lightbox-fit]').click();
    await expect(stage).toHaveAttribute('data-lightbox-stage', 'actual');
    await expect.poll(async () => (await measure()).height).toBe(3470);
    const actual = await measure();
    expect([actual.width, actual.height]).toEqual([1640, 3470]);
    expect(Math.round(actual.top)).toBe(0);
    expect(Math.round(actual.left)).toBe(0);
    await expect(box.locator('[data-lightbox-zoom]')).toHaveText('Zoom 100%');
    await shot(page, '13-actual-size-tall');
    // A plain wheel scrolls it to every edge, as a page scrolls, and never past one.
    const stageBox = (await stage.boundingBox())!;
    await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
    await page.mouse.wheel(0, 20_000);
    await page.mouse.wheel(20_000, 0);
    await expect.poll(async () => Math.round((await measure()).bottom)).toBe(0);
    const end = await measure();
    expect(Math.round(end.right)).toBe(0);
    expect(end.height).toBe(3470);
    // A small image at Actual size sits in the middle of the stage, not in a corner.
    await page.keyboard.press('ArrowRight');
    await box.locator('[data-lightbox-fit]').click();
    await expect(stage).toHaveAttribute('data-lightbox-stage', 'actual');
    await expect.poll(async () => (await measure()).naturalWidth).toBe(160);
    const small = await measure();
    expect([small.width, small.height]).toEqual([160, 100]);
    expect(Math.abs(small.left - small.right)).toBeLessThanOrEqual(1);
    expect(Math.abs(small.top - small.bottom)).toBeLessThanOrEqual(1);
    await shot(page, '14-actual-size-small');
    await context.close();
  } finally {
    if (url) await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
    if (child && child.exitCode === null) {
      await new Promise((done) => {
        const timer = setTimeout(done, 5_000);
        child!.once('exit', () => {
          clearTimeout(timer);
          done(undefined);
        });
      });
      // inbox-guard: own child (the annotate CLI this test spawned, never an Inbox)
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  }
});

test('the lightbox zooms: Ctrl + wheel about the pointer, drag pans, a double click toggles Fit and 2×, Fit and stepping reset it (#2067)', async ({ browser }) => {
  const root = join(world.root, 'zoom');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'wide.png'), await png(browser, screen('Checkout', 'Wide', '#2f6f5e', FIELDS), 2400, 1500));
  writeFileSync(join(root, 'other.png'), await png(browser, screen('Checkout', 'Other', '#7c3aed', FIELDS), 1200, 800));
  const doc = join(root, 'PLAN.md');
  writeFileSync(doc, ['# Zoom', '', '![Wide](wide.png)', '', '![Other](other.png)', ''].join('\n'));
  const readyFile = join(root, 'ready.jsonl');
  const env = { PATH: process.env.PATH ?? '', HOME: join(world.root, 'home'), PLANNOTATOR_DATA_DIR: world.dataDir, PLANNOTATOR_READY_FILE: readyFile, PLANNOTATOR_SKIP_BROWSER_OPEN: '1', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_REMOTE: '0' };
  let child: ChildProcess | undefined;
  let url = '';
  try {
    child = spawn(builtBinary, ['annotate', doc], { env, cwd: root, stdio: 'ignore' });
    await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
    url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies(
      [
        ['plannotator-plan-look-choice-resolved', 'true'],
        ['plannotator-announce-tui-herdr-seen', '1'],
        ['plannotator-announce-inbox-seen', '1'],
        ['plannotator-announce-ask-session-seen', '1'],
        ['plannotator-announce-agent-tool-seen', '1'],
      ].map(([name, value]) => ({ name: name!, value: value!, url })),
    );
    const page = await context.newPage();
    await page.goto(url);
    const images = page.locator('article img.cursor-zoom-in');
    await expect(images.nth(1)).toBeVisible();
    await images.nth(0).click();
    const box = page.locator('[data-image-lightbox-stepping]');
    const stage = box.locator('[data-lightbox-stage]');
    const image = box.locator('[data-lightbox-image]');
    const zoom = box.locator('[data-lightbox-zoom]');
    const rect = () =>
      image.evaluate((img: HTMLImageElement) => {
        const r = img.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height, naturalWidth: img.naturalWidth };
      });
    await expect.poll(async () => (await rect()).naturalWidth).toBe(2400);
    await expect.poll(async () => Math.round((await rect()).width)).toBeLessThan(2400);
    const fit = await rect();
    const fitPct = await zoom.textContent();
    // Ctrl + wheel near the image's top-left corner: the image pixel under the pointer stays under it.
    const px = Math.round(fit.left + fit.width * 0.2);
    const py = Math.round(fit.top + fit.height * 0.2);
    const imageX = ((px - fit.left) / fit.width) * 2400;
    const imageY = ((py - fit.top) / fit.height) * 1500;
    await page.mouse.move(px, py);
    await page.keyboard.down('Control');
    for (let i = 0; i < 4; i += 1) await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await expect(stage).toHaveAttribute('data-lightbox-stage', 'zoom');
    const zoomed = await rect();
    expect(zoomed.width / fit.width).toBeGreaterThan(2.5);
    expect(Math.abs(zoomed.left + (imageX / 2400) * zoomed.width - px)).toBeLessThanOrEqual(1);
    expect(Math.abs(zoomed.top + (imageY / 1500) * zoomed.height - py)).toBeLessThanOrEqual(1);
    expect(await zoom.textContent()).not.toBe(fitPct);
    await expect(box.locator('[data-lightbox-fit]')).toHaveText('Fit');
    await shot(page, '15-zoom-ctrl-wheel');
    // A drag pans.
    await page.mouse.move(700, 450);
    await page.mouse.down();
    await page.mouse.move(600, 400, { steps: 4 });
    await page.mouse.up();
    const panned = await rect();
    expect(Math.round(panned.left - zoomed.left)).toBe(-100);
    expect(Math.round(panned.top - zoomed.top)).toBe(-50);
    // A double click on the image goes back to Fit, another zooms to twice Fit.
    await page.mouse.dblclick(720, 450);
    await expect(stage).toHaveAttribute('data-lightbox-stage', 'fit');
    await expect.poll(async () => Math.round((await rect()).width)).toBe(Math.round(fit.width));
    await page.mouse.dblclick(fit.left + fit.width / 2, fit.top + fit.height / 2);
    await expect.poll(async () => Math.round((await rect()).width)).toBe(Math.round(fit.width * 2));
    // Fit resets it; stepping to the next image starts at Fit.
    await box.locator('[data-lightbox-fit]').click();
    await expect(stage).toHaveAttribute('data-lightbox-stage', 'fit');
    await expect.poll(async () => Math.round((await rect()).width)).toBe(Math.round(fit.width));
    await page.mouse.move(720, 450);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await expect(stage).toHaveAttribute('data-lightbox-stage', 'zoom');
    await page.keyboard.press('ArrowRight');
    await expect(box.locator('[data-lightbox-count]')).toHaveText('2 of 2');
    await expect(stage).toHaveAttribute('data-lightbox-stage', 'fit');
    await expect(box.locator('[data-lightbox-fit]')).toHaveText('Actual size');
    // Escape still closes it.
    await page.keyboard.press('Escape');
    await expect(box).toBeHidden();
    await context.close();
  } finally {
    if (url) await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
    if (child && child.exitCode === null) {
      await new Promise((done) => {
        const timer = setTimeout(done, 5_000);
        child!.once('exit', () => {
          clearTimeout(timer);
          done(undefined);
        });
      });
      // inbox-guard: own child (the annotate CLI this test spawned, never an Inbox)
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  }
});

test('on an iPhone (WebKit) a tap beside the image closes the single overlay, and the tap never reaches the page beneath (#2067)', async ({ browser }) => {
  const root = join(world.root, 'ghost-tap');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'small.png'), await png(browser, '<body style="margin:0;background:#2f6f5e"></body>', 160, 100));
  const doc = join(root, 'PLAN.md');
  // A link high on the page, where the tap beside the image lands once the overlay is open.
  writeFileSync(doc, ['# Ghost tap', '', '[Go somewhere else](https://example.com/ghost) and [another link](https://example.com/ghost-2)', '', '![Small](small.png)', ''].join('\n'));
  const readyFile = join(root, 'ready.jsonl');
  const env = { PATH: process.env.PATH ?? '', HOME: join(world.root, 'home'), PLANNOTATOR_DATA_DIR: world.dataDir, PLANNOTATOR_READY_FILE: readyFile, PLANNOTATOR_SKIP_BROWSER_OPEN: '1', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_REMOTE: '0' };
  let child: ChildProcess | undefined;
  let url = '';
  const { defaultBrowserType: _ignored, ...device } = devices['iPhone 15'];
  const phone = await webkit.launch({ args: [] });
  try {
    child = spawn(builtBinary, ['annotate', doc], { env, cwd: root, stdio: 'ignore' });
    await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
    url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
    const context = await phone.newContext(device);
    await context.addCookies(
      [
        ['plannotator-plan-look-choice-resolved', 'true'],
        ['plannotator-announce-tui-herdr-seen', '1'],
        ['plannotator-announce-inbox-seen', '1'],
        ['plannotator-announce-ask-session-seen', '1'],
        ['plannotator-announce-agent-tool-seen', '1'],
      ].map(([name, value]) => ({ name: name!, value: value!, url })),
    );
    const page = await context.newPage();
    const popups: string[] = [];
    context.on('page', (p) => popups.push(p.url()));
    await page.goto(url);
    const link = page.getByRole('link', { name: 'Go somewhere else' });
    await expect(link).toBeVisible();
    const target = (await link.boundingBox())!;
    // Every click the page receives from here on, and whether it was on a link.
    await page.evaluate(() => {
      const w = window as unknown as { __clicks: string[] };
      w.__clicks = [];
      document.addEventListener('click', (e) => w.__clicks.push((e.target as Element).closest('a')?.getAttribute('href') ?? (e.target as Element).tagName), true);
    });
    await page.locator('article img.cursor-zoom-in').first().tap();
    const overlay = page.locator('[data-image-lightbox]');
    await expect(overlay).toBeVisible();
    await expect(page.locator('[data-image-lightbox-stepping]')).toHaveCount(0);
    await page.waitForTimeout(400);
    await page.evaluate(() => { (window as unknown as { __clicks: string[] }).__clicks = []; });
    // The overlay covers the link; tap right where it was.
    await page.touchscreen.tap(target.x + target.width / 2, target.y + target.height / 2);
    await expect(overlay).toHaveCount(0);
    await page.waitForTimeout(800);
    const clicks = await page.evaluate(() => (window as unknown as { __clicks: string[] }).__clicks);
    expect(clicks.filter((c) => c.startsWith('https://'))).toEqual([]);
    expect(popups).toEqual([]);
    expect(page.url()).toBe(new URL(url).href);
    await context.close();
  } finally {
    await phone.close();
    if (url) await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
    if (child && child.exitCode === null) {
      await new Promise((done) => {
        const timer = setTimeout(done, 5_000);
        child!.once('exit', () => {
          clearTimeout(timer);
          done(undefined);
        });
      });
      // inbox-guard: own child (the annotate CLI this test spawned, never an Inbox)
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  }
});

test('the Inbox\'s file viewer zooms like the lightbox: Ctrl + wheel keeps the pixel under the pointer, drag pans, ← steps while zoomed, a drawing stays on the image', async ({ browser }) => {
  const page = world.page;
  const zoomShots = resolve(process.env.PLANNOTATOR_E2E_ZOOM_SHOTS ?? join(shotsDir, 'zoom'));
  mkdirSync(zoomShots, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  writeFileSync(join(world.project, 'design', 'wide.png'), await png(browser, screen('Checkout', 'Wide', '#2f6f5e', FIELDS), 2400, 1200));
  writeFileSync(join(world.project, 'design', 'summary.png'), await png(browser, screen('Checkout', 'Summary', '#7c3aed', '<h3>Order summary</h3><div class="f">Total · $86</div>'), 1200, 760));
  const sent = await world.claude.send({
    project_path: world.project,
    subject: 'Zoom into the checkout',
    thread: 'zoom-checkout',
    body: ['The wide screen and the summary:', '', '![Wide](design/wide.png)', '', '![Summary](design/summary.png)'].join('\n'),
  });
  const thread = sent.thread_id as string;
  await page.goto(`${world.url}#thread=${thread}`);
  const ids = await page.evaluate(async (id) => {
    const t = (await (await fetch(`/api/inbox/threads/${id}`)).json()).thread;
    return Object.fromEntries((t.messages[0].inline_images as { name: string; id: string }[]).map((i) => [i.name, i.id]));
  }, thread);
  await page.locator(`.ib-body img[data-inline-image="${ids['summary.png']}"]`).click();
  await expect(pane()).toHaveAttribute('data-attachment-pane', ids['summary.png']!);
  // Beside the thread: leave full screen.
  await page.locator('[data-full-view-exit="exit"]').click();
  await expect(pane()).not.toHaveClass(/ib-full/);
  const zoomStage = pane().locator('[data-image-zoom-stage]');
  const image = zoomStage.locator('img[data-lightbox-image]');
  await expect(zoomStage).toHaveAttribute('data-image-zoom-stage', 'fit');
  await expect(pane().locator('[data-image-zoom]')).toHaveText(/^Zoom \d+%$/);
  // The image's box relative to the stage, so a stage that moves (a layout settling) is not read as a pan.
  const rect = () =>
    zoomStage.evaluate((stage) => {
      const r = stage.querySelector('img[data-lightbox-image]')!.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      return { left: r.left - s.left, top: r.top - s.top, width: r.width, height: r.height, stageWidth: s.width, stageHeight: s.height };
    });
  // Leaving full screen gives the list (and maybe the sidebar) back with a spring: wait until the stage holds still.
  const stageBox = async () => JSON.stringify(await zoomStage.boundingBox());
  await expect
    .poll(async () => {
      const first = await stageBox();
      await page.waitForTimeout(150);
      return first === (await stageBox());
    })
    .toBe(true);
  const box = (await zoomStage.boundingBox())!;
  const px = box.x + box.width * 0.55;
  const py = box.y + box.height * 0.45;
  await page.mouse.move(px, py);
  await page.keyboard.down('Control');
  for (let i = 0; i < 4; i += 1) await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await expect(zoomStage).toHaveAttribute('data-image-zoom-stage', 'zoom');
  // mouse.wheel returns before the page handles the event: let the notches land.
  await page.waitForTimeout(300);
  // One more notch: the image pixel under the pointer stays under it, on both axes.
  const before = await rect();
  const u = (px - box.x - before.left) / before.width;
  const v = (py - box.y - before.top) / before.height;
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await rect()).width).toBeGreaterThan(before.width);
  await page.waitForTimeout(200);
  const after = await rect();
  expect(Math.abs(box.x + after.left + u * after.width - px)).toBeLessThan(1);
  expect(Math.abs(box.y + after.top + v * after.height - py)).toBeLessThan(1);
  // The page itself never zoomed.
  expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
  // A drag pans the image with the pointer. The image never leaves the stage (an edge stops the pan), so the
  // drag stays within the room the image has on each side.
  const roomLeft = after.left + after.width - after.stageWidth;
  const roomUp = after.top + after.height - after.stageHeight;
  expect(roomLeft).toBeGreaterThan(60);
  expect(roomUp).toBeGreaterThan(40);
  const dx = -Math.min(120, Math.floor(roomLeft - 20));
  const dy = -Math.min(80, Math.floor(roomUp - 20));
  await page.mouse.down();
  await page.mouse.move(px + dx, py + dy, { steps: 6 });
  await page.mouse.up();
  // The last move can land a frame after mouse.up resolves on a slow machine.
  await expect.poll(async () => Math.round((await rect()).left - after.left)).toBe(dx);
  const panned = await rect();
  expect(panned.left - after.left).toBeCloseTo(dx, 0);
  expect(panned.top - after.top).toBeCloseTo(dy, 0);
  await page.mouse.move(box.x + 10, box.y + box.height - 10);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(zoomShots, 'zoomed-beside-thread-1280.png') });
  // ← steps while zoomed (the image no longer keeps the arrows); the next file opens at Fit.
  await expect(zoomStage).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(pane()).toHaveAttribute('data-attachment-pane', ids['wide.png']!);
  await expect(pane().locator('[data-image-zoom-stage]')).toHaveAttribute('data-image-zoom-stage', 'fit');
  // A panorama at Actual size starts at its left edge and pans to its right.
  await pane().locator('.ib-imgbar').getByRole('button', { name: 'Actual size' }).click();
  await expect(pane().locator('[data-image-zoom-stage]')).toHaveAttribute('data-image-zoom-stage', 'actual');
  const edges = () =>
    pane().locator('[data-image-zoom-stage]').evaluate((el) => {
      const r = el.querySelector('img')!.getBoundingClientRect();
      const s = el.getBoundingClientRect();
      return { width: Math.round(r.width), left: r.left - s.left, right: s.right - r.right };
    });
  await expect.poll(async () => (await edges()).width).toBe(2400);
  expect(Math.abs((await edges()).left)).toBeLessThan(1);
  await pane().locator('[data-image-zoom-stage]').hover();
  await page.mouse.wheel(4000, 0);
  await expect.poll(async () => Math.abs((await edges()).right)).toBeLessThan(1);
  await page.keyboard.press('ArrowRight');
  await expect(pane()).toHaveAttribute('data-attachment-pane', ids['summary.png']!);

  // Full screen, a comment with a drawing selected, zoomed: the drawing lies on the image in its transform.
  await pane().locator('[data-full-screen-toggle]').click();
  await expect(pane()).toHaveClass(/ib-full/);
  await pane().getByRole('button', { name: 'Mark up' }).last().click();
  const canvas = page.locator('[data-pn-image-annotator-stage] canvas').first();
  await expect(canvas).toBeVisible();
  // The canvas starts at the 300 × 150 default and takes the image's shape once the annotator's image has loaded: draw only then.
  await expect
    .poll(async () => {
      const b = await canvas.boundingBox();
      return b && b.width > 300 && Math.abs(b.width / b.height - 1200 / 760) < 0.02;
    })
    .toBe(true);
  await expect.poll(() => page.locator('[data-pn-image-annotator-stage] img').first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  const c = (await canvas.boundingBox())!;
  // A circle around the "Total" field: the annotator centres it between the drag's ends.
  const target = { u: 0.5, v: 0.22 };
  const reach = 0.1;
  await page.locator('[data-pn-image-annotator-toolbar] button[title="Circle (3)"]').click();
  await page.mouse.move(c.x + c.width * (target.u - reach), c.y + c.height * target.v);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width * (target.u + reach), c.y + c.height * target.v, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.press('Enter');
  await expect(pane().locator('[data-image-composer] [data-markup-kept] img')).toBeVisible();
  await pane().getByRole('textbox', { name: 'A note with your drawing on summary.png' }).fill('Circle the total; it should be bigger.');
  await pane().getByRole('button', { name: 'Add note', exact: true }).click();
  await page.locator('[data-full-view-comments]').click();
  const drawer = pane().locator('[data-comments-drawer="open"]');
  await expect(drawer).toBeVisible();
  await drawer.getByText('Circle the total; it should be bigger.').click();
  const overlay = pane().locator('[data-zoom-overlay] img[data-markup-overlay]');
  await expect(overlay).toBeVisible();
  await expect.poll(() => overlay.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  // The kept drawing: where its pixels differ from the image, in the image's own pixels.
  const ink = await pane().locator('[data-image-zoom-stage]').evaluate(async (el) => {
    const read = async (src: string) => {
      const bitmap = await createImageBitmap(await (await fetch(src)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    };
    const base = await read(el.querySelector<HTMLImageElement>('img[data-lightbox-image]')!.src);
    const drawn = await read(el.querySelector<HTMLImageElement>('img[data-markup-overlay]')!.src);
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, r = 0, g = 0, b = 0, n = 0;
    for (let y = 0; y < base.height; y += 1) {
      for (let x = 0; x < base.width; x += 1) {
        const i = (y * base.width + x) * 4;
        const d = Math.abs(base.data[i]! - drawn.data[i]!) + Math.abs(base.data[i + 1]! - drawn.data[i + 1]!) + Math.abs(base.data[i + 2]! - drawn.data[i + 2]!);
        if (d < 120) continue;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        r += drawn.data[i]!; g += drawn.data[i + 1]!; b += drawn.data[i + 2]!; n += 1;
      }
    }
    return { width: base.width, height: base.height, minX, minY, maxX, maxY, color: [r / n, g / n, b / n] };
  });
  expect(ink.width).toBe(1200);
  // The circle's centre is where it was drawn, to within 3 image pixels; its radius is the drag's half-length.
  expect(Math.abs((ink.minX + ink.maxX) / 2 - target.u * 1200)).toBeLessThan(3);
  expect(Math.abs((ink.minY + ink.maxY) / 2 - target.v * 760)).toBeLessThan(3);
  expect(Math.abs((ink.maxX - ink.minX) / 2 - reach * 1200)).toBeLessThan(8);

  /** Where the drawing's colour is on the screen, inside the stage, in page pixels. */
  const inkOnScreen = async () => {
    const box = (await pane().locator('[data-image-zoom-stage]').boundingBox())!;
    const shotPng = await page.screenshot({ clip: box });
    const found = await page.evaluate(async ({ data, color }) => {
      // The window's CSP lets images load data: URLs (connect-src does not).
      const pic = new Image();
      pic.src = `data:image/png;base64,${data}`;
      await pic.decode();
      const bitmap = await createImageBitmap(pic);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
      for (let y = 0; y < bitmap.height; y += 1) {
        for (let x = 0; x < bitmap.width; x += 1) {
          const i = (y * bitmap.width + x) * 4;
          if (Math.abs(px[i]! - color[0]!) + Math.abs(px[i + 1]! - color[1]!) + Math.abs(px[i + 2]! - color[2]!) > 60) continue;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
      }
      return { minX, minY, maxX, maxY };
    }, { data: shotPng.toString('base64'), color: ink.color });
    return { cx: box.x + (found.minX + found.maxX) / 2, cy: box.y + (found.minY + found.maxY) / 2, radius: (found.maxX - found.minX) / 2 };
  };
  /** Where the target is on the screen now, from the image as it is placed on the stage. */
  const targetOnScreen = async () => {
    const r = await image.evaluate((img) => img.getBoundingClientRect());
    return { x: r.left + target.u * r.width, y: r.top + target.v * r.height, scale: r.width / 1200 };
  };
  const full = (await pane().locator('[data-image-zoom-stage]').boundingBox())!;
  await page.mouse.move(full.x + 20, full.y + full.height - 20);
  for (const zoomed of [false, true]) {
    if (zoomed) {
      // Zoom in about the circle: it grows on screen and stays on the field.
      const at = await targetOnScreen();
      await page.mouse.move(at.x, at.y);
      await page.keyboard.down('Control');
      for (let i = 0; i < 2; i += 1) await page.mouse.wheel(0, -100);
      await page.keyboard.up('Control');
      await expect(pane().locator('[data-image-zoom-stage]')).toHaveAttribute('data-image-zoom-stage', 'zoom');
      await page.mouse.move(full.x + 20, full.y + full.height - 20);
    }
    await page.waitForTimeout(300);
    const seen = await inkOnScreen();
    const want = await targetOnScreen();
    expect(Math.abs(seen.cx - want.x), `circle across, ${zoomed ? 'zoomed' : 'at Fit'}`).toBeLessThan(4);
    expect(Math.abs(seen.cy - want.y), `circle down, ${zoomed ? 'zoomed' : 'at Fit'}`).toBeLessThan(4);
    expect(Math.abs(seen.radius - reach * 1200 * want.scale), `circle size, ${zoomed ? 'zoomed' : 'at Fit'}`).toBeLessThan(6);
  }
  const aligned = await pane().locator('[data-image-zoom-stage]').evaluate((el) => {
    const img = el.querySelector<HTMLElement>('img[data-lightbox-image]')!;
    const layer = el.querySelector<HTMLElement>('[data-zoom-overlay]')!;
    const a = img.getBoundingClientRect();
    const b = layer.getBoundingClientRect();
    return { same: img.style.transform === layer.style.transform, dx: Math.abs(a.left - b.left) + Math.abs(a.width - b.width), dy: Math.abs(a.top - b.top) + Math.abs(a.height - b.height) };
  });
  expect(aligned).toEqual({ same: true, dx: 0, dy: 0 });
  await page.mouse.move(full.x + 20, full.y + full.height - 20);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(zoomShots, 'full-screen-zoomed-with-drawing-1280.png') });
  await page.keyboard.press('Escape');

  // On a phone: a double tap zooms, one finger pans it, the size bar says how far.
  const { defaultBrowserType: _ignored, ...device } = devices['iPhone 15'];
  const phoneBrowser = await webkit.launch({ args: [] });
  try {
    const context = await phoneBrowser.newContext(device);
    const phone = await context.newPage();
    await phone.emulateMedia({ reducedMotion: 'reduce' });
    await phone.goto(`${world.url}#thread=${thread}`);
    const inline = phone.locator(`.ib-body img[data-inline-image="${ids['summary.png']}"]`);
    await inline.scrollIntoViewIfNeeded();
    await inline.click();
    const stage = phone.locator('[data-attachment-pane] [data-image-zoom-stage]');
    await expect(stage).toHaveAttribute('data-image-zoom-stage', 'fit');
    const p = (await stage.boundingBox())!;
    await phone.touchscreen.tap(p.x + p.width / 2, p.y + p.height / 2);
    await phone.touchscreen.tap(p.x + p.width / 2, p.y + p.height / 2);
    await expect(stage).toHaveAttribute('data-image-zoom-stage', 'zoom');
    await phone.waitForTimeout(300);
    await phone.screenshot({ path: join(zoomShots, 'phone-zoomed.png') });
    await context.close();
  } finally {
    await phoneBrowser.close();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(world.errors.filter((e) => !/HTTP 404 \/favicon/.test(e))).toEqual([]);
});

// #2127: after a plain wheel zooms an image past the screen, the wheel scrolls
// it instead (#2067 keeps trackpad two-finger scrolling); the viewer now says
// how to zoom ("Use ⌘ + scroll to zoom", Ctrl off macOS) the moment it starts
// scrolling, once per viewer open.
const wheelHintShots = resolve(process.env.PLANNOTATOR_WHEEL_HINT_SHOTS ?? join(shotsDir, 'wheel-hint'));

/** A context whose navigator says macOS or Windows, so the hint names ⌘ or Ctrl. */
async function platformContext(browser: Browser, platform: 'MacIntel' | 'Win32', viewport: { width: number; height: number }): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport });
  await context.addInitScript((value) => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => value, configurable: true });
  }, platform);
  return context;
}

/** The image's scale, read from its transform. */
const scaleOf = (image: ReturnType<Page['locator']>) => image.evaluate((img: HTMLElement) => Number(/scale\(([\d.]+)\)/.exec(img.style.transform)![1]));

/** Five wheel notches about 60 ms apart (one wheel gesture), as the issue's steps send them. */
async function notches(page: Page, deltaY: number): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(60);
  }
}

/** Light and dark, with the hint on screen (one more scroll keeps it there; a long one shows the top of the image). */
async function hintShots(page: Page, name: string, deltaY: number): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.mouse.wheel(0, deltaY);
    await expect(page.locator('[data-wheel-hint="shown"]')).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(wheelHintShots, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('#2127: in annotate, a plain wheel zooms in, a pause, then the wheel scrolls and the viewer says how to zoom', async ({ browser }) => {
  mkdirSync(wheelHintShots, { recursive: true });
  const root = join(world.root, 'wheel-hint');
  mkdirSync(root, { recursive: true });
  // The issue's image: 1640 × 1400 in a 1440 × 1000 window.
  writeFileSync(join(root, 'big.png'), await png(browser, screen('Checkout', 'Big', '#2f6f5e', FIELDS), 1640, 1400));
  const doc = join(root, 'NOTES.md');
  writeFileSync(doc, ['# Notes', '', '![Big](big.png)', ''].join('\n'));
  const readyFile = join(root, 'ready.jsonl');
  const env = { PATH: process.env.PATH ?? '', HOME: join(world.root, 'home'), PLANNOTATOR_DATA_DIR: world.dataDir, PLANNOTATOR_READY_FILE: readyFile, PLANNOTATOR_SKIP_BROWSER_OPEN: '1', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_REMOTE: '0' };
  let child: ChildProcess | undefined;
  let url = '';
  try {
    child = spawn(builtBinary, ['annotate', doc], { env, cwd: root, stdio: 'ignore' });
    await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
    url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
    for (const [platform, key, spoken] of [
      ['MacIntel', '⌘', 'Command'],
      ['Win32', 'Ctrl', 'Control'],
    ] as const) {
      const context = await platformContext(browser, platform, { width: 1440, height: 1000 });
      await context.addCookies(
        [
          ['plannotator-plan-look-choice-resolved', 'true'],
          ['plannotator-announce-tui-herdr-seen', '1'],
          ['plannotator-announce-inbox-seen', '1'],
          ['plannotator-announce-ask-session-seen', '1'],
          ['plannotator-announce-agent-tool-seen', '1'],
        ].map(([name, value]) => ({ name: name!, value: value!, url })),
      );
      const page = await context.newPage();
      await page.goto(url);
      await page.locator('article img.cursor-zoom-in').first().click();
      const overlay = page.locator('[data-image-lightbox]');
      const stage = overlay.locator('[data-lightbox-stage]');
      const image = overlay.locator('[data-lightbox-image]');
      await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1640);
      await expect(stage).toHaveAttribute('data-lightbox-stage', 'fit');
      const fit = await scaleOf(image);
      // The pointer near the image's centre, away from the toolbar.
      await page.mouse.move(720, 500);
      await notches(page, -100);
      const zoomed = await scaleOf(image);
      expect(zoomed).toBeGreaterThan(fit * 2);
      await expect(page.locator('[data-wheel-hint]')).toHaveCount(0);
      await page.waitForTimeout(400);
      await notches(page, 100);
      // The wheel scrolls now (the issue's report): the scale stays, and the viewer says how to zoom.
      expect(await scaleOf(image)).toBe(zoomed);
      const hint = page.locator('[data-wheel-hint]');
      await expect(hint).toHaveAttribute('data-wheel-hint', 'shown');
      await expect(hint.locator('kbd')).toHaveText(key);
      await expect(hint).toHaveText(new RegExp(`Use\\s+${key === '⌘' ? '⌘' : 'Ctrl'}\\s+\\+ scroll to zoom`));
      await expect(page.locator('[data-wheel-hint-live]')).toHaveText(`Scrolling moves the image. To zoom, hold ${spoken} and scroll.`);
      // It takes no pointer: a drag through it still pans.
      expect(await hint.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
      await hintShots(page, `annotate-${key === '⌘' ? 'mac-cmd' : 'ctrl'}`, -2000);
      // Doing what it says zooms out and hides it.
      const before = await scaleOf(image);
      await page.keyboard.down(key === '⌘' ? 'Meta' : 'Control');
      await page.mouse.wheel(0, 100);
      await page.keyboard.up(key === '⌘' ? 'Meta' : 'Control');
      await expect.poll(() => scaleOf(image)).toBeLessThan(before);
      await expect(hint).toHaveAttribute('data-wheel-hint', 'hidden');
      await expect(page.locator('[data-wheel-hint-live]')).toHaveText('');
      // The next time the wheel scrolls in this open viewer: no hint again.
      await page.waitForTimeout(400);
      await notches(page, 100);
      await expect(hint).toHaveAttribute('data-wheel-hint', 'hidden');
      await page.keyboard.press('Escape');
      await expect(overlay).toBeHidden();
      // A new open says it once more.
      await page.locator('article img.cursor-zoom-in').first().click();
      await page.mouse.move(720, 500);
      await notches(page, -100);
      await page.waitForTimeout(400);
      await page.mouse.wheel(0, 100);
      await expect(page.locator('[data-wheel-hint]')).toHaveAttribute('data-wheel-hint', 'shown');
      await context.close();
    }
  } finally {
    if (url) await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
    if (child && child.exitCode === null) {
      await new Promise((done) => {
        const timer = setTimeout(done, 5_000);
        child!.once('exit', () => {
          clearTimeout(timer);
          done(undefined);
        });
      });
      // inbox-guard: own child (the annotate CLI this test spawned, never an Inbox)
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  }
});

test('#2127: the Inbox image view says it too, once while the file viewer is open', async ({ browser }) => {
  mkdirSync(wheelHintShots, { recursive: true });
  for (const platform of ['MacIntel', 'Win32'] as const) {
    const context = await platformContext(browser, platform, { width: 1440, height: 900 });
    const page = await context.newPage();
    await page.goto(`${world.url}#thread=${world.threadId}&file=${world.ids['checkout-a-single-page.png']}`);
    const stage = page.locator('[data-attachment-pane] [data-image-zoom-stage]');
    await expect(stage).toHaveAttribute('data-image-zoom-stage', 'fit');
    const box = (await stage.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await notches(page, -100);
    await expect(stage).toHaveAttribute('data-image-zoom-stage', 'zoom');
    await expect(page.locator('[data-wheel-hint]')).toHaveCount(0);
    await page.waitForTimeout(400);
    await page.mouse.wheel(0, 100);
    await expect(stage.locator('[data-wheel-hint]')).toHaveAttribute('data-wheel-hint', 'shown');
    await expect(stage.locator('[data-wheel-hint] kbd')).toHaveText(platform === 'MacIntel' ? '⌘' : 'Ctrl');
    await hintShots(page, `inbox-${platform === 'MacIntel' ? 'mac-cmd' : 'ctrl'}`, -2000);
    // Another image of the same viewer: no second hint.
    await stage.focus();
    await page.keyboard.press(']');
    await expect(page.locator('[data-attachment-pane]')).toHaveAttribute('data-attachment-pane', world.ids['checkout-b-steps.png']!);
    const next = page.locator('[data-attachment-pane] [data-image-zoom-stage]');
    await expect(next).toHaveAttribute('data-image-zoom-stage', 'fit');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await notches(page, -100);
    await page.waitForTimeout(400);
    await notches(page, 100);
    await expect(next.locator('[data-wheel-hint]')).toHaveCount(0);
    await context.close();
  }
});
