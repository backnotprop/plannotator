/**
 * A thread's Artifacts view (approval "inbox-thread-artifacts", 2026-10-23,
 * variant Swap), proved in a real browser against the compiled binary under a
 * temp data dir. An agent writes four messages and the person one reply into
 * one thread: images in the text (one of them also attached: one artifact),
 * Markdown (edited on disk after it was sent), HTML, a WebM, a PDF, a guided
 * review, SQL, Mermaid and a ZIP; the person pastes a sketch into their reply.
 *
 * - The header's right side is icons only with component tooltips:
 *   Artifacts with its count (11), Expand all, Archive, then the close; Mark
 *   read keeps its label and its E.
 * - On a desktop (approval "inbox-files-tabs", round 3) Artifacts opens the
 *   pane beside the thread on its Artifacts tab: one grid, newest message
 *   first, each tile with its preview, name, kind and size, sender and time,
 *   "in text", the changed chip and the comment count; the messages stay; the
 *   address carries `&artifacts`.
 * - A tile opens the same viewer in a tab; the viewer's stepping keeps thread
 *   order and counts the files only ("of 10").
 * - A thread with no artifact keeps the button on a desktop for its project
 *   folder (no count); a link to its grid says there is nothing yet.
 * - Closing the file returns to the Artifacts tab with focus on its tile;
 *   Escape and the pressed button close the pane with focus on the button; a
 *   reload keeps the pane; a guided review's Back returns to the grid.
 * - A thread with nothing: no button; a link to `&artifacts` says so.
 * - A phone (iPhone 15, WebKit): a screen of its own, two columns, Back.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-artifacts.spec.ts`.
 * PNGs, light and dark, desktop and phone, land in PLANNOTATOR_E2E_SHOTS_DIR
 * (default .local/proof/artifacts).
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/artifacts'));

/** A small checkout screen, drawn by the browser into a real PNG. */
function screen(title: string, accent: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:15px system-ui,sans-serif;background:#f4f3ef;color:#18181b}
header{padding:14px 22px;background:#fff;border-bottom:1px solid #e4e4e7;font-weight:600}
main{max-width:560px;margin:28px auto;background:#fff;border-radius:12px;padding:22px;box-shadow:0 1px 3px #0001}
.f{border:1px solid #d4d4d8;border-radius:8px;padding:10px;margin:8px 0;color:#71717a}
button{width:100%;padding:13px;border:0;border-radius:9px;background:${accent};color:#fff;font:600 15px system-ui;margin-top:10px}
</style><header>Plantshop · ${title}</header><main>${body}<button>Pay now</button></main>`;
}
const CART = '<h3>Your cart</h3><div class="f">Linen overshirt · $48</div><div class="f">Canvas tote · $48</div><div class="f">Wool socks · $48</div>';

const SPEC = ['# Checkout in one drawer', '', 'The three checkout pages become one drawer over the cart.', '', '## Steps', '', '1. Shipping address (autofilled when known)', '2. Payment (Stripe Payment Element)', '3. Review and pay', ''].join('\n');
const DRAWER = '<!doctype html><meta charset="utf-8"><title>Checkout drawer</title><style>body{font:16px system-ui;margin:24px}aside{border:1px solid #ccc;border-radius:12px;padding:16px;max-width:420px}button{background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:10px 16px}</style><h1>Checkout drawer</h1><aside><p>Prototype: the drawer slides over the cart.</p><button>Pay now</button></aside>';
const SQL = ['-- One row per open checkout drawer.', 'CREATE TABLE checkout_sessions (', '  id uuid PRIMARY KEY,', '  cart_id uuid NOT NULL,', '  step text NOT NULL,', '  created_at timestamptz', ');', ''].join('\n');
const FLOW = ['flowchart LR', '  Cart --> Drawer --> Shipping --> Payment --> Paid', ''].join('\n');
const PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 52 >> stream
BT /F1 18 Tf 24 70 Td (Checkout performance) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF
`;

interface World {
  url: string;
  project: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threadId: string;
  emptyThread: string;
  claude: SimAgent;
  other: SimAgent;
}
let world: World;

async function shot(page: Page, name: string, options: { reload?: boolean } = {}): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    // WebKit leaves some text in the old scheme's colour after a live switch: a reload paints the page fresh.
    if (options.reload) await page.reload();
    // The theme's colour crossfade.
    await page.waitForTimeout(1200);
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

const header = () => world.page.locator('section.ib-pane .ib-phead');
const artifactsButton = (page: Page = world.page) => page.locator('[data-artifacts-button]');
const tiles = (page: Page = world.page) => page.locator('[data-artifacts-view] [data-artifact-tile]');

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-artifacts-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const trap = join(root, 'trap');
  mkdirSync(home);
  mkdirSync(trap);
  // Nothing here may reach the real tailscale CLI.
  writeFileSync(join(trap, 'tailscale'), '#!/bin/sh\necho "inbox-artifacts: tailscale must not run" >&2\nexit 97\n');
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = {
    PATH: `${trap}:${process.env.PATH ?? ''}`,
    HOME: home,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_INBOX_CONNECT: '0',
    NO_BROWSER,
    PLANNOTATOR_BROWSER: NO_BROWSER,
  };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();

  const project = scratchProject(join(root, 'src'), 'checkout-web');
  for (const dir of ['design', 'docs', 'db', 'artifacts', 'reports', 'sketch']) mkdirSync(join(project, dir));
  writeFileSync(join(project, 'design', 'checkout-before.png'), await png(browser, screen('Checkout · today', '#71717a', '<h3>Shipping</h3><div class="f">Dana Whitfield</div><div class="f">418 Larch St</div>'), 1280, 800));
  writeFileSync(join(project, 'design', 'checkout-after.png'), await png(browser, screen('Checkout · drawer', '#4f46e5', CART), 1280, 800));
  writeFileSync(join(project, 'sketch', 'mobile-pay-sketch.png'), await png(browser, screen('Sketch', '#18181b', '<h3>Cart (3)</h3><p>items</p>'), 900, 1300));
  writeFileSync(join(project, 'docs', 'checkout-spec.md'), SPEC);
  writeFileSync(join(project, 'design', 'checkout-drawer.html'), DRAWER);
  writeFileSync(join(project, 'db', '0042_checkout_sessions.sql'), SQL);
  writeFileSync(join(project, 'docs', 'checkout-flow.mmd'), FLOW);
  writeFileSync(join(project, 'reports', 'checkout-perf.pdf'), PDF);
  writeFileSync(join(project, 'artifacts', 'e2e-traces.zip'), Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0xff, 0xfe]), Buffer.alloc(2048, 0)]));
  // A real WebM: Playwright records a page for about three seconds.
  const recordings = join(root, 'recordings');
  const recorder = await browser.newContext({ viewport: { width: 640, height: 360 }, recordVideo: { dir: recordings, size: { width: 640, height: 360 } } });
  const recordingPage = await recorder.newPage();
  await recordingPage.setContent(screen('Walkthrough', '#4f46e5', CART));
  await recordingPage.waitForTimeout(3000);
  const video = recordingPage.video()!;
  await recorder.close();
  copyFileSync(await video.path(), join(project, 'artifacts', 'checkout-walkthrough.webm'));

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
  });
  world = {
    url,
    project,
    context,
    page,
    errors,
    threadId: '',
    emptyThread: '',
    claude: await SimAgent.connect({ binary: builtBinary, env, name: 'Claude Code', host: 'claude-code' }),
    other: await SimAgent.connect({ binary: builtBinary, env, name: 'Codex', host: 'codex' }),
  };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.claude.close().catch(() => {});
    await world.other.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

/** One POST to the Inbox the way the window sends it (no Origin: the server answers a client without one). */
async function post(path: string, body: unknown): Promise<any> {
  const response = await fetch(new URL(path, world.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.ok, `${path} ${response.status} ${await response.clone().text()}`).toBe(true);
  return response.json();
}

test('an agent and the person fill one thread with eleven artifacts', async () => {
  const id = (r: any) => (r.message?.id ?? r.message_id) as string;
  const first = await world.claude.send({
    project_path: world.project,
    subject: 'Checkout in one drawer',
    // The screenshot is shown in the text AND attached: one artifact, opened either way.
    body: "Here is the spec and a first pass at the drawer. Today's checkout, for reference:\n\n![Today's checkout](design/checkout-before.png)\n\nThe spec and a clickable prototype are attached.",
    attachments: ['docs/checkout-spec.md', 'design/checkout-drawer.html', 'design/checkout-before.png'],
  });
  world.threadId = first.thread_id as string;
  // The person pastes a sketch into their reply.
  const health = await (await fetch(new URL('/api/inbox/health', world.url))).json();
  const uploaded = await (
    await fetch(new URL(`/api/inbox/uploads?name=mobile-pay-sketch.png&serverSession=${health.serverSession}`, world.url), {
      method: 'POST',
      body: readFileSync(join(world.project, 'sketch', 'mobile-pay-sketch.png')),
    })
  ).json();
  await post(`/api/inbox/messages/${id(first)}/reply`, { serverSession: health.serverSession, idempotency_key: 'r1', words: 'Love the drawer. The Pay button has to stay on screen, sketch attached.', uploads: [uploaded.upload.upload_id] });
  await world.claude.send({
    project_path: world.project,
    reply_to: id(first),
    body: 'Built it. The Pay button is sticky on phones.\n\n![The new drawer](design/checkout-after.png)\n\nA walkthrough and the Lighthouse runs are attached.',
    attachments: ['artifacts/checkout-walkthrough.webm', 'reports/checkout-perf.pdf'],
  });
  const { example } = (await world.claude.guideBrief()) as { example: Record<string, unknown> };
  await world.claude.submitGuide({ project_path: world.project, ...example, body: 'A guided review of the change, file by file.', reply_to: id(first) } as never);
  await world.claude.send({
    project_path: world.project,
    reply_to: id(first),
    body: 'The migration, the flow as a diagram, and the traces from the e2e run.\n\n:::question\nShip the drawer behind a flag?\n\n- [ ] Yes, 10% first\n- [ ] No, ship to everyone\n:::',
    attachments: ['db/0042_checkout_sessions.sql', 'docs/checkout-flow.mmd', 'artifacts/e2e-traces.zip'],
  });
  // The spec changes after it was sent.
  appendFileSync(join(world.project, 'docs', 'checkout-spec.md'), '\n## Gift cards\n\nBack in scope.\n');
  // Another agent's thread with no artifact at all.
  const empty = await world.other.send({ project_path: world.project, subject: 'Release notes drafted', body: 'The notes for 0.29 are drafted; nothing to look at yet.' });
  world.emptyThread = empty.thread_id as string;
  expect(empty.thread_id).not.toBe(world.threadId);
});

test('the header: icons on the right with component tooltips, the folder with its count; Mark read keeps its label', async () => {
  const page = world.page;
  await page.goto(`${world.url}#thread=${world.threadId}`);
  const button = artifactsButton();
  await expect(button).toBeVisible();
  // On a desktop the button is the Files pane's toggle (approval "inbox-files-tabs", 2026-10-30).
  await expect(button).toHaveAttribute('aria-label', 'Files (11)');
  await expect(button).not.toHaveAttribute('aria-pressed');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).not.toHaveAttribute('title');
  await expect(header().locator('[data-mark-read]')).toContainText('Mark read');
  // Expand all is an icon now, named by its label.
  const expand = header().locator('[data-expand-all]');
  await expect(expand).toHaveAttribute('aria-label', /Expand all messages|Fold the earlier messages/);
  await expect(expand).toHaveText('');
  // The order at the right: the folder, Expand, Archive, a hairline, the close (the thread's full screen and its
  // hairline lead the header, before Mark read).
  const order = await header().evaluate((head) =>
    [...head.querySelectorAll('[data-artifacts-button], [data-expand-all], [data-archive], .ib-vsep, [aria-label="Close the thread"]')].map(
      (el) => el.getAttribute('data-artifacts-button') !== null ? 'artifacts' : el.hasAttribute('data-expand-all') ? 'expand' : el.hasAttribute('data-archive') ? 'archive' : el.classList.contains('ib-vsep') ? '|' : 'close',
    ),
  );
  expect(order.slice(-5)).toEqual(['artifacts', 'expand', 'archive', '|', 'close']);
  await button.hover();
  await expect(page.locator('[data-pn-tooltip]')).toContainText('Open the files: every file, image and guided review in this thread');
  await shot(page, '01-thread-header-desktop');
  await page.mouse.move(10, 600);
});

test('Artifacts opens beside the thread on its tab: a grid, newest message first, with the address and focus moved to it; the messages stay', async () => {
  const page = world.page;
  await artifactsButton().click();
  await expect(page).toHaveURL(new RegExp(`#thread=${world.threadId}&artifacts$`));
  await expect(artifactsButton()).toHaveAttribute('aria-expanded', 'true');
  // Open, the folder is lit where the thread's × was, its name unchanged, with no count.
  await expect(artifactsButton()).toHaveAttribute('data-files-door', 'open');
  await expect(artifactsButton()).toHaveAccessibleName('Files (11)');
  await expect(artifactsButton()).toHaveText('');
  await expect(header().getByRole('button', { name: 'Close the thread' })).toHaveCount(0);
  await expect(page.locator('[data-artifacts-view] h2')).toBeFocused();
  // The thread column is always the thread: the grid is beside it, on the Artifacts tab.
  await expect(page.locator('section.ib-pane > .ib-pbody:not(.ib-artbody)')).toBeVisible();
  await expect(page.locator('[data-files-pane="artifacts"] [data-artifacts-view]')).toBeVisible();
  await expect(page.locator('[data-artifacts-tab]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-artifacts-summary]')).toHaveText('11 from 5 messages · newest first');
  await expect(tiles()).toHaveCount(11);
  const names = await tiles().evaluateAll((all) => all.map((t) => (t.getAttribute('aria-label') ?? '').replace(/^Download /, '').split(',')[0]));
  expect(names).toEqual([
    '0042_checkout_sessions.sql',
    'checkout-flow.mmd',
    'e2e-traces.zip',
    'Guided review: ' + names[3]!.replace(/^Guided review: /, ''),
    'checkout-after.png',
    'checkout-walkthrough.webm',
    'checkout-perf.pdf',
    'mobile-pay-sketch.png',
    'checkout-before.png',
    'checkout-spec.md',
    'checkout-drawer.html',
  ]);
  expect(names[3]).toMatch(/^Guided review: /);
  // Each tile's name says what it shows.
  await expect(tiles().nth(4)).toHaveAttribute('aria-label', /^checkout-after\.png, PNG image, 1280 × 800, [\d.]+ KB, from Claude Code at .+, shown in the message text$/);
  await expect(tiles().nth(7)).toHaveAttribute('aria-label', /^mobile-pay-sketch\.png, PNG image, 900 × 1300, .+, from you at /);
  await expect(tiles().nth(9)).toHaveAttribute('aria-label', /^checkout-spec\.md, Markdown, .+, changed since it was sent$/);
  await expect(tiles().nth(2)).toHaveAttribute('aria-label', /^Download e2e-traces\.zip, ZIP file/);
  // Previews: an image, the first lines of code, a diagram drawn, a page in a frame, a video's first frame, the changed chip.
  // (Previews load once a tile is near the screen: each is scrolled to first.)
  const near = async (i: number) => tiles().nth(i).scrollIntoViewIfNeeded();
  await near(0);
  await expect(tiles().nth(0).locator('.ib-art-code')).toContainText('CREATE TABLE checkout_sessions');
  await expect(tiles().nth(1).locator('.ib-art-svg[data-drawn] svg')).toHaveCount(1);
  await near(4);
  await expect(tiles().nth(4).locator('img')).toHaveJSProperty('complete', true);
  await expect(tiles().nth(5).locator('video')).toHaveCount(1);
  await near(10);
  await expect(tiles().nth(10).locator('iframe')).toHaveAttribute('sandbox', '');
  await expect(tiles().nth(9).locator('.ib-art-chg')).toHaveText('Changed since sent');
  await expect(tiles().nth(8)).toContainText('in text');
  await page.locator('[data-artifacts-view] h2').scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await shot(page, '02-artifacts-desktop');
  await near(10);
  await page.waitForTimeout(500);
  await shot(page, '02b-artifacts-desktop-end');
});

test('a tile opens the viewer in a tab; stepping keeps thread order over the files only; closing the last tab closes the pane', async () => {
  const page = world.page;
  const spec = tiles().nth(9);
  await spec.click();
  await expect(page.locator('[data-attachment-pane]')).toBeVisible();
  await expect(page).toHaveURL(/&file=/);
  // The file has its tab; the Artifacts tab stays in the row.
  await expect(page.locator('[data-file-tab]')).toHaveCount(1);
  await expect(page.locator('[data-file-tab]')).toContainText('checkout-spec.md');
  await expect(page.locator('[data-artifacts-tab]')).toHaveAttribute('aria-selected', 'false');
  // Stepping counts the files (the guide opens its own reader) in thread order: the screenshot first, then the spec.
  await expect(page.locator('[data-step-label]')).toHaveAttribute('aria-label', '2 of 10, checkout-spec.md. Show every file in this thread');
  await shot(page, '03-file-beside-grid-desktop');
  await page.locator('[data-attachment-pane]').click({ position: { x: 300, y: 300 } });
  await page.keyboard.press(']');
  await expect(page.locator('[data-step-label]')).toHaveAttribute('aria-label', /^3 of 10, checkout-drawer\.html/);
  // A step replaces the tab.
  await expect(page.locator('[data-file-tab]')).toHaveCount(1);
  await expect(page.locator('[data-file-tab]')).toContainText('checkout-drawer.html');
  // The last tab's close: the pane closes, back to the thread alone even though Artifacts was shown first (the review
  // of #2282), focus on the folder button.
  await page.locator('[data-attachment-pane]').getByRole('button', { name: 'Close checkout-drawer.html' }).click();
  await expect(page.locator('[data-attachment-pane]')).toHaveCount(0);
  await expect(page.locator('[data-files-pane]')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#thread=${world.threadId}$`));
  await expect(artifactsButton()).toBeFocused();
  // The folder opens the pane again, on Artifacts.
  await artifactsButton().click();
  await expect(tiles()).toHaveCount(11);
  await expect(page).toHaveURL(new RegExp(`#thread=${world.threadId}&artifacts$`));
});

test('Escape and the lit folder button close the pane, focus on the button; a reload keeps it', async () => {
  const page = world.page;
  await page.reload();
  await expect(tiles()).toHaveCount(11);
  await page.locator('[data-artifacts-view] h2').click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`#thread=${world.threadId}$`));
  await expect(page.locator('[data-artifacts-view]')).toHaveCount(0);
  await expect(artifactsButton()).toBeFocused();
  await expect(page.locator('section.ib-pane > .ib-pbody')).toBeVisible();
  // The button again, then the lit folder: the pane closes.
  await artifactsButton().click();
  await expect(tiles()).toHaveCount(11);
  await artifactsButton().click();
  await expect(page.locator('[data-artifacts-view]')).toHaveCount(0);
  await expect(artifactsButton()).toBeFocused();
  // One more Escape closes the thread, as before.
  await page.keyboard.press('Escape');
  await expect(page.locator('section.ib-pane')).toHaveCount(0);
});

test("a guided review opens its reader; the reader's Back returns to the grid", async () => {
  const page = world.page;
  await page.goto(`${world.url}#thread=${world.threadId}&artifacts`);
  await expect(tiles()).toHaveCount(11);
  await tiles().nth(3).click();
  await expect(page).toHaveURL(/&artifacts&guide=/);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`#thread=${world.threadId}&artifacts$`));
  await expect(tiles()).toHaveCount(11);
});

test('a thread with no artifact: the button is its project folder\'s (no count); a link to the view says so', async () => {
  const page = world.page;
  await page.goto(`${world.url}#thread=${world.emptyThread}`);
  await expect(page.locator('section.ib-pane [data-archive]')).toBeVisible();
  // On a desktop the thread's project folder keeps the button (owner, 2026-10-27): named for the folder, no count.
  await expect(artifactsButton()).toHaveAttribute('aria-label', 'Files');
  await page.goto(`${world.url}#thread=${world.emptyThread}&artifacts`);
  await expect(page.locator('[data-artifacts-empty]')).toContainText('No artifacts in this thread yet');
  await shot(page, '04-empty-desktop');
  expect(world.errors).toEqual([]);
});

test('a phone (iPhone 15, WebKit): a screen of its own, two columns, Back to the thread', async () => {
  let own: Browser | null = null;
  try {
    own = await webkit.launch({ args: [] });
    const context = await own.newContext({ ...devices['iPhone 15'], colorScheme: 'light' });
    const page = await context.newPage();
    await page.goto(`${world.url}#thread=${world.threadId}`);
    const button = artifactsButton(page);
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    await shot(page, '05-thread-header-phone', { reload: true });
    await button.tap();
    await expect(page.locator('[data-artifacts-phone-back]')).toBeVisible();
    await expect(page.locator('[data-mark-read]')).toHaveCount(0);
    await expect(tiles(page)).toHaveCount(11);
    const [a, b, c] = await Promise.all([0, 1, 2].map(async (i) => (await tiles(page).nth(i).boundingBox())!));
    expect(Math.abs(a!.y - b!.y)).toBeLessThanOrEqual(1);
    expect(c!.y).toBeGreaterThan(a!.y + a!.height - 1);
    await page.waitForTimeout(800);
    await shot(page, '06-artifacts-phone', { reload: true });
    // A tile opens the file full screen; Back returns to the grid, Back again to the thread.
    await tiles(page).nth(4).tap();
    await expect(page.locator('[data-attachment-pane]')).toBeVisible();
    await page.goBack();
    await expect(page.locator('[data-attachment-pane]')).toHaveCount(0);
    await expect(tiles(page)).toHaveCount(11);
    await page.locator('[data-artifacts-phone-back]').tap();
    await expect(page.locator('[data-artifacts-view]')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`#thread=${world.threadId}$`));
    await context.close();
  } finally {
    await own?.close();
  }
});
