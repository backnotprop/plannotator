/**
 * A live html block of a message is an artifact of its thread (the owner, 2026-11-25: "I want to render html inline
 * still and offer same UX there. Can annotate inline and all. Ideally it would show in artifacts"): on the compiled
 * binary, a made-up thread whose message shows a picture and two html blocks, neither loading anything from the
 * web. The blocks stay live in the message exactly as before (Code, Full screen, the pen). Each is also in the
 * header's count, the thread's Artifacts grid (a quiet tile: the page's heading, else "HTML block") and the
 * Artifacts wall; its tile opens the block's own page big, with Code and the pen, never the file viewer. A comment
 * made there is the message's own (the block in the text shows it, Send names "HTML block 1 in the message"), the
 * tile pins, the Wall's tile opens the same and closing goes back to the Wall, and a phone does the same. A block
 * that asks a made-up host for a picture, a stylesheet, a background and a prefetch asks it nothing from the grid
 * or the Wall. The block's own Full screen (unchanged) is shot beside the view opened from Artifacts.
 *
 * Whole-window PNGs, 1440 × 900 light and dark and a 390 × 844 phone, land in PLANNOTATOR_E2E_SHOTS_DIR (default
 * `.local/proof/html-artifacts`).
 */
import { chromium, expect, test, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/html-artifacts'));
const CHROMIUM_ARGS = ['--use-mock-keychain', '--password-store=basic', '--mute-audio'];

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(shotsDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

/** Every request a frame of the page makes (a tile's picture, a block's page) goes to the Inbox itself or stays in the page: nothing from the web. */
function offTheWeb(page: Page, origin: string): string[] {
  const out: string[] = [];
  page.on('request', (request) => {
    let framed = false;
    try {
      framed = request.frame() !== page.mainFrame();
    } catch {
      framed = false;
    }
    const url = request.url();
    // The window's own port, by either name (the embeds may be framed from 127.0.0.1 or localhost).
    const local = [origin, origin.replace('localhost', '127.0.0.1'), origin.replace('127.0.0.1', 'localhost')].some((own) => url.startsWith(own));
    if (framed && !local && !/^(?:data|blob|about):/.test(url)) out.push(url);
  });
  return out;
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const BERTH_PLAN = [
  '<h2 style="margin:0 0 12px;font:600 18px system-ui">Harbor · berth plan</h2>',
  '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;font:14px system-ui">',
  '<div id="b1" style="padding:14px;border-radius:10px;background:#0f3b57;color:#fff"><b>B1</b><br>MV Fernwood</div>',
  '<div id="b2" style="padding:14px;border-radius:10px;background:var(--muted,#eef3f6)"><b>B2</b><br>free</div>',
  '<div id="b3" style="padding:14px;border-radius:10px;background:#0f3b57;color:#fff"><b>B3</b><br>Quill Star</div>',
  '<div id="b4" style="padding:14px;border-radius:10px;background:var(--muted,#eef3f6)"><b>B4</b><br>free from 14:00</div>',
  '</div>',
].join('\n');

/** Drawn by its own script, as a chart an agent sends is: no heading, nothing loaded. */
const TIDE_CHART = [
  '<svg id="tides" viewBox="0 0 360 120" style="display:block;width:360px;height:120px"></svg>',
  '<script>',
  'const levels = [1.2, 2.8, 4.1, 3.0, 1.4, 0.6, 1.9, 3.6];',
  "const svg = document.getElementById('tides');",
  "levels.forEach((m, i) => { const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');",
  "  r.setAttribute('x', 12 + i * 44); r.setAttribute('y', 110 - m * 22); r.setAttribute('width', 28); r.setAttribute('height', m * 22);",
  "  r.setAttribute('rx', 4); r.setAttribute('fill', 'var(--chart-2, #2f7fb8)'); svg.appendChild(r); });",
  '</script>',
].join('\n');

/** Every way a page asks the web for something, all to a made-up host. */
const TRACKER = 'https://tracker.invalid';
const TRACKED_PAGE = [
  `<link rel="dns-prefetch" href="${TRACKER}"><link rel="preconnect" href="${TRACKER}">`,
  `<link rel="stylesheet" href="${TRACKER}/brand.css">`,
  '<h2 style="font:600 18px system-ui">Ledger · export</h2>',
  `<img src="${TRACKER}/pixel.png?seen=grid" alt="" width="1" height="1">`,
  `<div style="height:80px;border-radius:10px;background:#eef3f6 url(${TRACKER}/bg.png?seen=grid) center/cover"></div>`,
].join('\n');

test('an html block is an artifact: the count, the grid, opened big with its tools, a comment there, a pin, the wall, a phone', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium draws the proof');
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-html-artifacts-');
  const home = join(root, 'home');
  const trap = join(root, 'trap');
  mkdirSync(home, { recursive: true });
  mkdirSync(trap, { recursive: true });
  writeFileSync(join(trap, 'tailscale'), '#!/bin/sh\necho "html-artifacts: tailscale must not run" >&2\nexit 97\n');
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = {
    PATH: `${trap}:${process.env.PATH ?? ''}`,
    HOME: home,
    PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    NO_ANON_PING: '1',
    NO_BROWSER,
    PLANNOTATOR_BROWSER: NO_BROWSER,
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const origin = new URL(url).origin;
  const browser = await chromium.launch({ args: CHROMIUM_ARGS });
  const agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
  try {
    const harbor = scratchProject(join(root, 'src'), 'harbor');
    mkdirSync(join(harbor, 'media'), { recursive: true });
    writeFileSync(join(harbor, 'media', 'berths.png'), PNG);
    const sent = await agent.send({
      project_path: harbor,
      subject: 'Harbor: Thursday berths and tides',
      body: [
        'Charlie Dunn asked for the Thursday plan:',
        '',
        '![Berth plan](media/berths.png)',
        '',
        '```html',
        BERTH_PLAN,
        '```',
        '',
        'Bob Tully checks the tides against this:',
        '',
        '```html',
        TIDE_CHART,
        '```',
      ].join('\n'),
    });
    const ledger = await agent.send({
      project_path: scratchProject(join(root, 'src'), 'ledger'),
      subject: 'Ledger: the export page',
      body: ['The export page, as the brand team drew it:', '', '```html', TRACKED_PAGE, '```'].join('\n'),
    });

    // A block that asks the web for everything it can: its tile in the grid and its card on the Wall ask nothing.
    // (Its thread is opened on the grid, so the block in the text, under the grid, never draws.)
    const guard = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    // What left the browser (the route sees it), what the pages asked for, and what the window's policy stopped
    // before it left (Chromium reports those as requests that failed with "csp").
    const reached: string[] = [];
    const asked: string[] = [];
    const stopped: string[] = [];
    await guard.route(`${TRACKER}/**`, (route) => {
      reached.push(route.request().url());
      return route.abort();
    });
    guard.on('request', (request) => {
      if (request.url().includes('tracker.invalid')) asked.push(request.url());
    });
    guard.on('requestfailed', (request) => {
      if (request.url().includes('tracker.invalid') && request.failure()?.errorText === 'csp') stopped.push(request.url());
    });
    const watch = await guard.newPage();
    await watch.goto(`${url}#thread=${ledger.thread_id}&artifacts`);
    const ledgerTile = watch.locator('[data-artifacts-view] [data-artifact-tile]');
    await expect(ledgerTile).toHaveCount(1, { timeout: 20_000 });
    await expect(ledgerTile).toContainText('Ledger · export');
    const tileFrame = watch.locator('[data-artifacts-view] [data-face="html-block"] iframe');
    await expect(tileFrame).toHaveAttribute('sandbox', '');
    await expect(tileFrame).toHaveAttribute('srcdoc', /^<meta http-equiv="x-dns-prefetch-control" content="off">/);
    await watch.waitForTimeout(2000);
    await watch.goto(`${url}#artifacts`);
    await expect(watch.locator('[data-wall-artifact]').filter({ hasText: 'Ledger · export' })).toHaveCount(1, { timeout: 20_000 });
    await watch.waitForTimeout(2000);
    // Nothing reached the host; whatever the tile's page asked for, the window's policy stopped in the browser.
    expect(reached).toEqual([]);
    await expect.poll(() => asked.filter((asking) => !stopped.includes(asking))).toEqual([]);
    await guard.close();

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const web = offTheWeb(page, origin);
    await page.goto(`${url}#thread=${sent.thread_id}`);
    const button = page.locator('[data-artifacts-button]');
    // The picture and the two blocks.
    await expect(button).toHaveAttribute('aria-label', 'Artifacts, 3', { timeout: 20_000 });
    // The blocks in the message, as they always were: live, with Code, Full screen and the pen.
    const body = page.locator(`[data-message-id="${sent.message_id}"]`);
    const inline = body.locator('figure[data-html-embed]');
    await expect(inline).toHaveCount(2);
    await expect(inline.first()).toHaveAttribute('data-html-embed-phase', 'ready', { timeout: 20_000 });
    expect(await inline.first().locator('figcaption button').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim()))).toEqual(['Code', 'Full screen', 'Annotate']);
    await shot(page, '01-thread-with-count-desktop');
    // The block's own Full screen, unchanged, to set beside the one opened from Artifacts (03).
    await inline.first().locator('[data-html-embed-full]').click();
    const popout = page.locator('[data-popout]');
    await expect(popout).toBeVisible();
    await expect(page.locator('[data-html-embed-open]')).toHaveCount(0);
    await shot(page, '01b-inline-full-screen-desktop');
    await popout.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(popout).toHaveCount(0);

    await button.click();
    const tiles = page.locator('[data-artifacts-view] [data-artifact-tile]');
    await expect(tiles).toHaveCount(3);
    await expect(tiles.nth(0)).toContainText('berths.png');
    await expect(tiles.nth(1)).toContainText('Harbor · berth plan');
    await expect(tiles.nth(2)).toContainText('HTML block');
    for (const i of [1, 2]) {
      await expect(tiles.nth(i)).toHaveAttribute('data-artifact-kind', 'html-block');
      await expect(tiles.nth(i)).toContainText('in text');
    }
    await shot(page, '02-grid-with-html-tiles-desktop');

    // The tile opens the block's own page, big, with its tools; never the file viewer.
    await tiles.nth(1).click();
    const big = page.locator('[data-html-embed-open]');
    await expect(big).toBeVisible();
    await expect(big.locator('figure[data-html-embed]')).toHaveAttribute('data-html-embed-phase', 'ready', { timeout: 20_000 });
    await expect(page.locator('[data-attachment-pane]')).toHaveCount(0);
    const pen = big.locator('[data-html-embed-annotate]');
    await expect(pen).toHaveAccessibleName('Annotate');
    await expect(big.locator('[data-html-embed-code]')).toBeVisible();
    await expect(big.locator('[data-html-embed-full]')).toHaveCount(0);
    await shot(page, '03-block-open-from-grid-desktop');

    // A comment on an element, as under the block in the text.
    await pen.click();
    await expect(pen).toHaveAttribute('aria-pressed', 'true');
    const annotatable = big.locator('[data-html-embed-annotatable] iframe');
    await expect(annotatable).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
    const frame = (await (await annotatable.elementHandle())!.contentFrame())!;
    await frame.locator('#b2').click();
    const composer = page.locator('[data-comment-popover] textarea');
    await expect(composer).toBeVisible();
    await composer.fill('Hold B2 for the Quill Star until the tide check.');
    await shot(page, '04-comment-in-the-open-block-desktop');
    await composer.press('ControlOrMeta+Enter');
    await expect(page.locator('[data-comment-popover]')).toHaveCount(0);
    await expect(frame.locator('[data-plannotator-marker]')).toHaveCount(1);

    // Closing comes back to the grid, on the tile.
    await big.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(big).toHaveCount(0);
    await expect(page.locator('[data-artifacts-view]')).toBeVisible();
    await expect(tiles.nth(1)).toBeFocused();

    const card = page.locator('[data-artifacts-view] li').filter({ has: page.locator('[data-artifact-tile]', { hasText: 'Harbor · berth plan' }) });
    await card.hover();
    await card.locator('[data-artifact-pin]').click();
    await expect(page.locator('[data-artifacts-group="pinned"]')).toContainText('Harbor · berth plan');
    await shot(page, '05-html-block-pinned-desktop');

    // The same block in the text holds the comment made big.
    await page.goto(`${url}#thread=${sent.thread_id}`);
    await expect(inline.first()).toHaveAttribute('data-html-embed-comments', /\S/, { timeout: 20_000 });

    await page.goto(`${url}#artifacts`);
    const wall = page.locator('[data-wall-artifact]');
    // The harbor thread's three and the ledger page.
    await expect(wall).toHaveCount(4, { timeout: 20_000 });
    await expect(wall.filter({ hasText: 'Harbor · berth plan' })).toHaveCount(1);
    await expect(wall.filter({ hasText: 'HTML block' })).toHaveCount(1);
    await shot(page, '06-artifacts-wall-desktop');
    // The Wall's tile opens the same, over its thread; closing goes back to the Wall.
    await wall.filter({ hasText: 'HTML block' }).locator('.ib-wall-tile').click();
    await expect(big).toBeVisible({ timeout: 20_000 });
    await expect(big.locator('figure[data-html-embed]')).toHaveAttribute('data-html-embed-phase', 'ready', { timeout: 20_000 });
    await expect(big.locator('[data-html-embed-annotate]')).toBeVisible();
    await shot(page, '07-block-open-from-wall-desktop');
    await big.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(big).toHaveCount(0);
    await expect(page).toHaveURL(/#artifacts(?:=pinned)?$/);
    await expect(wall).toHaveCount(4);

    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    const small = await phone.newPage();
    const smallWeb = offTheWeb(small, origin);
    await small.goto(`${url}#thread=${sent.thread_id}&artifacts`);
    const smallTiles = small.locator('[data-artifacts-view] [data-artifact-tile]');
    await expect(smallTiles).toHaveCount(3, { timeout: 20_000 });
    await shot(small, '08-grid-phone');
    await smallTiles.filter({ hasText: 'HTML block' }).tap();
    const smallBig = small.locator('[data-html-embed-open]');
    await expect(smallBig.locator('figure[data-html-embed]')).toHaveAttribute('data-html-embed-phase', 'ready', { timeout: 20_000 });
    await expect(smallBig.locator('[data-html-embed-annotate]')).toBeVisible();
    await shot(small, '09-block-open-phone');
    await smallBig.getByRole('button', { name: 'Close', exact: true }).tap();
    await expect(smallBig).toHaveCount(0);
    await small.goto(`${url}#artifacts`);
    await expect(small.locator('[data-wall-artifact]').filter({ hasText: 'Harbor · berth plan' })).toHaveCount(1, { timeout: 20_000 });
    await shot(small, '10-artifacts-wall-phone');
    await phone.close();
    expect(smallWeb).toEqual([]);

    // Send: the comment made big is the text's block's, as one made under it.
    await page.goto(`${url}#thread=${sent.thread_id}`);
    await page.locator('section.ib-pane .ib-pfoot').getByRole('button', { name: /^Reply$|Edit draft$/ }).first().click();
    await page.locator('.ib-rbox textarea').fill('One note on the berths.');
    await page.locator('section.ib-pane').getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.ib-rbox')).toHaveCount(0);
    const reply = await agent.nextReply(sent.thread_id as string, 40);
    const feedback = reply.body as string;
    expect(feedback).toMatch(/HTML block 1 in the message, lines \d+–\d+/);
    expect(feedback).toContain('Hold B2 for the Quill Star until the tide check.');
    expect(web).toEqual([]);
    await context.close();
  } finally {
    await agent.close().catch(() => {});
    await browser.close().catch(() => {});
    await removeInboxScratch(root);
  }
});
