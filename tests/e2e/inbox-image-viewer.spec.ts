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
 * peek, no pen).
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
  await page.keyboard.press('Enter');
  await expect(pane().locator('.ib-imgcompose .ib-markup img')).toBeVisible();
  await pane().getByRole('textbox', { name: 'Comment on checkout-b-steps.png' }).fill('Make step 1 bold, and say which step you are on.');
  await shot(page, '03-inline-image-comment-and-markup');
  await pane().getByRole('button', { name: 'Comment', exact: true }).click();
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
  // Full screen: the changed line is the chip at the top left (its title the whole sentence).
  const line = pane().locator('[data-full-view-changed]');
  await expect(line).toContainText('Changed since sent');
  await expect(line).toHaveAttribute('title', /^Changed since Claude sent it/);
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
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Edit the reply' }).click();
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
    await page.locator('[data-full-view-more]').click();
    await page.locator('[data-full-view-menu-position]').click();
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
  const env = { PATH: process.env.PATH ?? '', HOME: join(world.root, 'home'), PLANNOTATOR_DATA_DIR: world.dataDir, PLANNOTATOR_READY_FILE: readyFile, PLANNOTATOR_SKIP_BROWSER_OPEN: '1', PLANNOTATOR_REMOTE: '0' };
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
