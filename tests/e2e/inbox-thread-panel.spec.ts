/**
 * The thread panel view (packages/inbox/threadPanel.ts), proved in a real Chromium against the compiled binary under
 * a temp HOME and PLANNOTATOR_DATA_DIR. Agents write through the Inbox's own /mcp. Nothing is mocked.
 *
 *  - The default: no cookie, the wide list, a thread beside it, closing gives the wide list back.
 *  - The ⋮ menu's item: panel view at once, the menu stays open, a ✓, the cookie; a reload keeps it; off is wide again.
 *  - A reload: no frame of the wide list, with or without `#thread=`, and no frame of the empty panel under a thread.
 *  - A thread fills the panel and the list does not move; ×, Escape and a missing thread's Close return to the empty
 *    panel; focus lands where it does in the wide view; a hovered row moves nothing.
 *  - Full screen, the Artifacts view, a file beside the thread, the sidebar closed, project routes, the Board,
 *    Settings, search, J and K, a thread on a linked machine.
 *  - A window too narrow for two panes stacks and never shows the panel; a phone has neither the panel nor the item;
 *    the tour and an empty Inbox show neither.
 *  - Rows at the short width: agents against the project, the project cut with "…", one line.
 *  - The panel's art in the built single-file window, under its real CSP: the mask paints (read back from a
 *    screenshot) in the line's color, light and dark, by the app's mode against the computer's; click, Enter and Space
 *    turn it with no layout shift; it outlives a thread and a reload puts it back on the keycap.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-thread-panel.spec.ts`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const COOKIE = 'plannotator-inbox-thread-panel';
const LONG_PROJECT = 'northwind-industries-reconciliation-platform';
const CLOSED = 'http://127.0.0.1:9';

interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
}

let world: World;
const threads = { ledger: '', token: '', rate: '', spacing: '', files: '', csv: '', refund: '', release: '' };
let projects: Record<string, string> = {};

function startWorld(prefix: string, name?: string): World {
  const root = inboxScratch(prefix);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  // Never a real tailscale.
  writeFileSync(join(bin, 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'tailscale'), 0o755);
  const dataDir = join(root, 'data');
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_TEST_SANDBOX: root,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_RELAY_URL: CLOSED,
    ...(name ? { PLANNOTATOR_MACHINE_NAME: name } : {}),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, cwd: root, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  return { root, dataDir, env, url: started.stdout.trim() };
}

const base = (w: World) => `http://127.0.0.1:${(JSON.parse(readFileSync(join(w.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number }).port}`;

const agents = {
  claude: { agent_name: 'Claude Code', agent_host: 'claude-code', agent_session: 'ses_claude' },
  codex: { agent_name: 'Codex', agent_host: 'codex', agent_session: 'ses_codex' },
  pi: { agent_name: 'Pi', agent_host: 'pi', agent_session: 'ses_pi' },
  opencode: { agent_name: 'OpenCode', agent_host: 'opencode', agent_session: 'ses_opencode' },
};

/** An agent writes through the Inbox's own /mcp, as its plugin does. */
async function send(w: World, agent: keyof typeof agents, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${base(w)}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { ...agents[agent], ...args } } }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  expect(text).not.toContain('"isError":true');
  const id = /"thread_id"\s*:\s*\\?"(msg_[^"\\]+)/.exec(text)?.[1];
  expect(id, text).toBeTruthy();
  return id!;
}

const ask = (q: string) => [':::question', q, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  world = startWorld('plannotator-inbox-thread-panel-e2e-');
  const src = join(world.root, 'src');
  const project = (name: string) => scratchProject(src, name);
  const say = (agent: keyof typeof agents, name: string, thread: string, subject: string, body: string, extra: Record<string, unknown> = {}) =>
    send(world, agent, { project_path: project(name), thread, subject, body, ...extra });
  threads.release = await say('pi', 'plannotator', 'Release 0.28.41', 'Release notes for 0.28.41: check the contributor credits', 'Release notes are drafted.');
  threads.refund = await say('claude', 'billing-svc', 'Refund events', 'Trust the webhook or poll Stripe every 10 minutes?', 'Webhook or poll.');
  threads.csv = await say('codex', LONG_PROJECT, 'CSV export', 'Approve the CSV column order for the finance export', 'Column order attached.');
  writeFileSync(join(project('plannotator'), 'rollout.md'), '# Rollout\n\nStaged over two days.\n');
  threads.files = await say('claude', 'plannotator', 'Rollout plan', 'The rollout plan is attached', 'Have a read.', { attachments: ['rollout.md'] });
  threads.spacing = await say('codex', 'design-system-tokens', 'Spacing scale', 'Drop the 6 px step from the spacing scale?', ask('Drop the 6 px step?'));
  threads.rate = await say('pi', 'api', 'Raise the batch import rate limit', 'The import hits 429s at 400 requests a minute', ask('Raise it to 800?'));
  threads.token = await say('claude', 'workspaces-cli', 'Token refresh', 'Token refresh fails after the laptop sleeps', ask('Retry on wake?'));
  threads.ledger = await say('claude', LONG_PROJECT, 'Ledger reconciliation', 'Dry run the ledger reconciliation against last quarter', ask('Run it tonight?'));
  for (const agent of ['codex', 'pi', 'opencode'] as const) await send(world, agent, { project_path: project(LONG_PROJECT), reply_to: threads.ledger, body: `${agents[agent].agent_name} checked its part.` });
  const health = (await (await fetch(new URL('/api/inbox/health', world.url))).json()) as { serverSession: string };
  // Read rows: opening one changes nothing about it.
  for (const id of [threads.csv, threads.release, threads.refund, threads.files]) {
    const res = await fetch(new URL(`/api/inbox/threads/${id}/read`, world.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: health.serverSession }) });
    expect(res.ok).toBe(true);
  }
  const model = (await (await fetch(new URL('/api/inbox/projects', world.url))).json()) as { projects: { id: string; name: string }[] };
  projects = Object.fromEntries(model.projects.map((p) => [p.name, p.id]));
});

test.afterAll(async () => {
  await removeInboxScratch();
});

const desktop = (browser: Browser, width = 1440, height = 900): Promise<BrowserContext> => browser.newContext({ viewport: { width, height }, colorScheme: 'light', reducedMotion: 'reduce' });

async function panelOn(context: BrowserContext, w: World = world): Promise<void> {
  await context.addCookies([{ name: COOKIE, value: '1', url: w.url }]);
}

async function open(browser: Browser, opts: { panel?: boolean; hash?: string; width?: number; height?: number } = {}): Promise<Page> {
  const context = await desktop(browser, opts.width, opts.height);
  if (opts.panel !== false) await panelOn(context);
  const page = await context.newPage();
  await page.goto(`${world.url}${opts.hash ?? ''}`);
  await expect(page.locator('.ib-lbody')).toBeVisible();
  await expect(anyRow(page)).toBeVisible();
  // The read rows are in Quiet: unfolded, so every row is there to open.
  const quiet = page.locator('.ib-lbody [data-section-id="quiet"] button.ib-band');
  if ((await quiet.count()) > 0) await quiet.click();
  return page;
}

const list = (p: Page) => p.locator('section.ib-listcol');
const empty = (p: Page) => p.locator('[data-thread-panel-empty]');
const row = (p: Page, id: string) => p.locator(`.ib-lbody [data-thread-id="${id}"]:visible`);
const anyRow = (p: Page) => p.locator('.ib-lbody [data-thread-id]:visible, .ib-lbody button.ib-band:visible').first();
const subject = (p: Page) => p.locator('section.ib-pane h2.ib-subject');
const item = (p: Page) => p.locator('[data-tidy-menu-popup] [data-thread-panel-option]');
const openMenu = async (p: Page) => {
  await p.locator('[data-tidy-menu]').click();
  await expect(p.locator('[data-tidy-menu-popup]')).toBeVisible();
};
const cookie = async (p: Page) => (await p.context().cookies()).find((c) => c.name === COOKIE)?.value ?? null;
const width = (p: Page) => list(p).evaluate((el) => el.getBoundingClientRect().width);

/** Where the rows on screen are. */
const rowTops = (p: Page) =>
  p.locator('.ib-lbody').evaluate((body) => [...body.querySelectorAll<HTMLElement>('[data-thread-id]')].filter((el) => el.getClientRects().length > 0).map((el) => [el.getAttribute('data-thread-id'), Math.round(el.getBoundingClientRect().top * 10) / 10]));

/** What holds focus, in words a test can compare. */
const focusName = (p: Page) =>
  p.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return 'page';
    const row = el.closest('[data-thread-id]');
    if (row) return `row ${row.getAttribute('data-thread-id')}`;
    return `${el.tagName} ${el.className}`.trim();
  });

/** The list column's widths and what the panel held on every frame from the first paint. */
async function recordFrames(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const frames: { list: number; empty: boolean }[] = [];
    (window as unknown as { __frames: typeof frames }).__frames = frames;
    const tick = () => {
      const column = document.querySelector('.ib-listcol');
      if (column) frames.push({ list: column.getBoundingClientRect().width, empty: !!document.querySelector('[data-thread-panel-empty]') });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const frames = (p: Page) => p.evaluate(() => (window as unknown as { __frames: { list: number; empty: boolean }[] }).__frames);

const art = (p: Page) => p.getByRole('button', { name: 'Show another picture' });
const artBox = (p: Page) => art(p).evaluate((el) => {
  const { x, y, width, height } = el.getBoundingClientRect();
  return { x, y, width, height };
});

/** A window on the panel in one app mode, with the computer set to the other: the app's mode has to decide. */
async function themed(browser: Browser, theme: 'light' | 'dark'): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme === 'light' ? 'dark' : 'light', reducedMotion: 'reduce' });
  await panelOn(context);
  await context.addCookies([{ name: 'plannotator-theme', value: theme, url: world.url }]);
  const page = await context.newPage();
  await page.goto(world.url);
  await expect(art(page)).toBeVisible();
  return page;
}

/** The mask the window was built with, as the single-file build inlines it. */
const maskBytes = (name: string) => readFileSync(join(repo, 'packages/inbox/components/panel-art', `${name}.png`)).toString('base64');
const drawnMask = (p: Page) => p.locator('.ib-pempty-piece').evaluate((el) => (el as HTMLElement).style.getPropertyValue('--ib-pempty-mask'));

/**
 * What the screen shows in the art's box, read from a real screenshot, so a mask the CSP blocked (nothing drawn) or a
 * mask ignored (a solid square) both fail. The clip starts outside the box, so its first pixel is the pane.
 */
async function painted(p: Page): Promise<{ share: number; ink: boolean; bitmap: string }> {
  const box = await artBox(p);
  const margin = 4;
  const shot = await p.screenshot({ clip: { x: box.x - margin, y: box.y - margin, width: box.width + margin * 2, height: box.height + margin * 2 } });
  return p.evaluate(async ({ png, margin }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const draw = canvas.getContext('2d', { willReadFrequently: true })!;
    draw.drawImage(image, 0, 0);
    const { data } = draw.getImageData(0, 0, image.width, image.height);
    const at = (i: number) => [data[i]!, data[i + 1]!, data[i + 2]!];
    const distance = (a: number[], b: number[]) => Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!);
    const paper = at(0);
    // The line's color, as a pixel: the ink has to be that color, not merely some mark.
    draw.fillStyle = getComputedStyle(document.querySelector('[data-thread-panel-empty] p')!).color;
    draw.fillRect(0, 0, 1, 1);
    const ink = [...draw.getImageData(0, 0, 1, 1).data].slice(0, 3);
    let marked = 0;
    let closest = Number.POSITIVE_INFINITY;
    let bitmap = '';
    for (let y = margin; y < image.height - margin; y++) {
      for (let x = margin; x < image.width - margin; x++) {
        const pixel = at((y * image.width + x) * 4);
        const on = distance(pixel, paper) > 24;
        if (on) marked += 1;
        if (on) closest = Math.min(closest, distance(pixel, ink));
        bitmap += on ? '1' : '0';
      }
    }
    return { share: marked / (image.width - margin * 2) / (image.height - margin * 2), ink: closest < 12, bitmap };
  }, { png: shot.toString('base64'), margin });
}

for (const theme of ['light', 'dark'] as const) {
  test(`the art paints in the built window, ${theme}: its own mask, in the line's color, whatever the computer prefers`, async ({ browser }) => {
    const page = await themed(browser, theme);
    await expect(page.locator('html')).toHaveClass(theme === 'light' ? /\blight\b/ : /^(?!.*\blight\b)/);
    expect(await drawnMask(page)).toContain(`data:image/png;base64,${maskBytes(theme === 'light' ? 'keycap' : 'keycap-dark')}`);

    const keycap = await painted(page);
    expect(keycap.ink).toBe(true);
    expect(keycap.share).toBeGreaterThan(0.05);
    expect(keycap.share).toBeLessThan(0.8);
    await expect(page.locator('.ib-pempty-piece')).toHaveCSS('background-color', await page.locator('[data-thread-panel-empty] p').evaluate((el) => getComputedStyle(el).color));

    await art(page).click();
    await page.mouse.move(0, 0);
    await expect(art(page)).toHaveAttribute('data-piece', 'saturn');
    const saturn = await painted(page);
    expect(saturn.ink).toBe(true);
    expect(saturn.bitmap).not.toBe(keycap.bitmap);

    // Every other piece paints too, each its own picture.
    const seen = new Set([keycap.bitmap, saturn.bitmap]);
    for (let i = 2; i < 15; i++) {
      await art(page).click();
      await page.mouse.move(0, 0);
      const piece = await painted(page);
      expect(piece.share, await art(page).getAttribute('data-piece') ?? '').toBeGreaterThan(0.02);
      seen.add(piece.bitmap);
    }
    expect(seen.size).toBe(15);
    await page.context().close();
  });
}

test('the art turns by click, Enter and Space, with a pointer and a ring, and nothing moves', async ({ browser }) => {
  const page = await open(browser);
  await expect(art(page)).toHaveAttribute('data-piece', 'keycap');
  await expect(art(page)).toHaveCSS('cursor', 'pointer');
  const before = await artBox(page);
  expect(before).toMatchObject({ width: 96, height: 96 });
  const line = () => page.locator('[data-thread-panel-empty] p').evaluate((el) => el.getBoundingClientRect().top);
  const lineTop = await line();
  const rows = await rowTops(page);

  await art(page).click();
  await expect(art(page)).toHaveAttribute('data-piece', 'saturn');
  expect(await artBox(page)).toEqual(before);
  expect(await line()).toBe(lineTop);

  // Tab comes to it from the column's edge, the last stop before the panel, and draws the ring.
  await page.locator('section.ib-listcol [role="separator"]').focus();
  await page.keyboard.press('Tab');
  await expect(art(page)).toBeFocused();
  await expect(art(page)).toHaveCSS('outline-style', 'solid');
  await expect(art(page)).toHaveCSS('outline-width', '2px');

  await page.keyboard.press('Enter');
  await expect(art(page)).toHaveAttribute('data-piece', 'anvil');
  await page.keyboard.press('Space');
  await expect(art(page)).toHaveAttribute('data-piece', 'android');

  // The keys stayed on the button: no row opened and nothing moved.
  await expect(art(page)).toBeFocused();
  await expect(subject(page)).toHaveCount(0);
  await expect(empty(page)).toBeVisible();
  expect(await artBox(page)).toEqual(before);
  expect(await rowTops(page)).toEqual(rows);
  await page.context().close();
});

test('the art keeps its place while a thread is open, and a reload is back on the keycap with nothing saved', async ({ browser }) => {
  const page = await open(browser);
  const saved = await page.context().cookies();
  await art(page).click();
  await expect(art(page)).toHaveAttribute('data-piece', 'saturn');

  await row(page, threads.ledger).click();
  await expect(subject(page)).toBeVisible();
  await expect(art(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Close the thread' }).click();
  await expect(art(page)).toHaveAttribute('data-piece', 'saturn');

  expect((await page.context().cookies()).map((c) => c.name).sort()).toEqual(saved.map((c) => c.name).sort());
  await page.reload();
  await expect(art(page)).toHaveAttribute('data-piece', 'keycap');
  await page.context().close();
});

test('the default is the wide view: no cookie, a thread beside the list, closing gives the wide list back', async ({ browser }) => {
  const page = await open(browser, { panel: false });
  await expect(empty(page)).toHaveCount(0);
  await expect(list(page)).not.toHaveClass(/ib-narrow/);
  expect(await width(page)).toBeGreaterThan(900);
  expect(await cookie(page)).toBeNull();
  await openMenu(page);
  await expect(page.locator('[data-tidy-menu-popup] [role="menuitemcheckbox"]').last()).toHaveText('Keep thread panel open');
  await expect(item(page)).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');

  await row(page, threads.release).click();
  await expect(subject(page)).toBeVisible();
  await expect(list(page)).toHaveClass(/ib-narrow/);
  await page.getByRole('button', { name: 'Close the thread' }).click();
  await expect(list(page)).not.toHaveClass(/ib-narrow/);
  await expect(empty(page)).toHaveCount(0);
  expect(await width(page)).toBeGreaterThan(900);
  await page.context().close();
});

test('the ⋮ item: panel view at once, the menu stays open, a ✓, remembered; off is the wide list again', async ({ browser }) => {
  const page = await open(browser, { panel: false });
  await openMenu(page);
  await item(page).click();
  await expect(empty(page)).toBeVisible();
  await expect(empty(page)).toHaveText('No thread selected');
  await expect(item(page)).toBeVisible();
  await expect(item(page)).toHaveAttribute('aria-checked', 'true');
  await expect(item(page).locator('.ib-pmi-check')).toBeVisible();
  await expect(list(page)).toHaveClass(/ib-narrow/);
  expect(await width(page)).toBe(380);
  expect(await cookie(page)).toBe('1');

  await page.reload();
  await expect(page.locator('.ib-lbody')).toBeVisible();
  await expect(empty(page)).toBeVisible();
  expect(await width(page)).toBe(380);

  // By keyboard, as its neighbours: Space ticks it and the menu stays.
  await page.locator('[data-tidy-menu]').focus();
  await page.keyboard.press('Enter');
  await expect(item(page)).toHaveAttribute('aria-checked', 'true');
  await item(page).focus();
  await page.keyboard.press('Space');
  await expect(item(page)).toHaveAttribute('aria-checked', 'false');
  await expect(empty(page)).toHaveCount(0);
  expect(await width(page)).toBeGreaterThan(900);
  expect(await cookie(page)).toBeNull();
  await page.context().close();
});

test('a reload never draws the wide list first, and never the empty panel under a thread', async ({ browser }) => {
  const context = await desktop(browser);
  await panelOn(context);
  await recordFrames(context);
  const page = await context.newPage();
  await page.goto(world.url);
  await expect(anyRow(page)).toBeVisible();
  await expect(empty(page)).toBeVisible();
  const plain = await frames(page);
  expect(plain.length).toBeGreaterThan(0);
  expect(plain.filter((f) => f.list !== 380)).toEqual([]);

  await page.goto('about:blank');
  await page.goto(`${world.url}#thread=${threads.release}`);
  await expect(subject(page)).toBeVisible();
  const reading = await frames(page);
  expect(reading.length).toBeGreaterThan(0);
  expect(reading.filter((f) => f.list !== 380 || f.empty)).toEqual([]);
  await context.close();
});

test('a dragged column comes back at its width from the first frame', async ({ browser }) => {
  const context = await desktop(browser);
  await panelOn(context);
  await context.addCookies([{ name: 'plannotator-inbox-list-width', value: '460', url: world.url }]);
  await recordFrames(context);
  const page = await context.newPage();
  await page.goto(world.url);
  await expect(anyRow(page)).toBeVisible();
  const seen = await frames(page);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.filter((f) => f.list !== 460)).toEqual([]);
  await context.close();
});

test('a reload in a window that stacks never draws the short list or a panel', async ({ browser }) => {
  const context = await desktop(browser, 1000);
  await panelOn(context);
  await recordFrames(context);
  const page = await context.newPage();
  await page.goto(world.url);
  await expect(anyRow(page)).toBeVisible();
  const seen = await frames(page);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.filter((f) => f.list <= 380 || f.empty)).toEqual([]);
  await context.close();
});

test('a thread fills the panel, the list stays where it is; × and Escape return to the empty panel', async ({ browser }) => {
  const page = await open(browser, { height: 520 });
  const body = page.locator('.ib-lbody');
  await row(page, threads.release).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const scrolled = await body.evaluate((el) => el.scrollTop);
  expect(scrolled, 'the list is scrolled').toBeGreaterThan(0);
  const before = await rowTops(page);
  const box = await list(page).boundingBox();

  await row(page, threads.release).hover();
  expect(await rowTops(page), 'a hovered row moves nothing').toEqual(before);

  await row(page, threads.release).click();
  await expect(subject(page)).toBeVisible();
  await expect(empty(page)).toHaveCount(0);
  expect(await rowTops(page), 'opening moves no row').toEqual(before);
  expect(await list(page).boundingBox()).toEqual(box);
  expect(await body.evaluate((el) => el.scrollTop)).toBe(scrolled);

  await page.getByRole('button', { name: 'Close the thread' }).click();
  await expect(empty(page)).toBeVisible();
  expect(await rowTops(page), 'closing moves no row').toEqual(before);
  expect(await list(page).boundingBox()).toEqual(box);

  await row(page, threads.csv).click();
  await expect(subject(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(empty(page)).toBeVisible();
  await expect(list(page)).toHaveClass(/ib-narrow/);
  await page.context().close();
});

test('focus lands where it does in the wide view: into the thread, then back on its row', async ({ browser }) => {
  const journey = async (page: Page) => {
    await row(page, threads.release).focus();
    await page.keyboard.press('Enter');
    await expect(subject(page)).toBeVisible();
    await page.waitForTimeout(300);
    const opened = await focusName(page);
    await page.keyboard.press('Escape');
    await expect(subject(page)).toHaveCount(0);
    await page.waitForTimeout(300);
    return [opened, await focusName(page)];
  };
  const wide = await open(browser, { panel: false });
  const expected = await journey(wide);
  await wide.context().close();
  const panel = await open(browser);
  expect(await journey(panel)).toEqual(expected);
  expect(expected[1]).toBe(`row ${threads.release}`);
  await panel.context().close();
});

test('a thread that cannot be read: its Close returns to the empty panel', async ({ browser }) => {
  const page = await open(browser, { hash: '#thread=msg_01NOTINTHEINBOX0000000000' });
  await page.locator('[data-thread-wait-close]').click();
  await expect(empty(page)).toBeVisible();
  await page.context().close();
});

test('full screen, the Artifacts view and a file beside the thread all come back to the empty panel', async ({ browser }) => {
  const page = await open(browser);
  // Full screen: the list hides, Escape leaves it, the next Escape closes the thread.
  await row(page, threads.release).click();
  await expect(subject(page)).toBeVisible();
  await page.getByRole('button', { name: /^Hide the sidebar and the list/ }).click();
  await expect(page.locator('.pn-inbox[data-thread-full]')).toBeVisible();
  await expect(list(page)).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('.pn-inbox[data-thread-full]')).toHaveCount(0);
  await expect(list(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(empty(page)).toBeVisible();

  // The address leaving the thread while in full screen (Back, a link): the sidebar and the list come back with the empty panel.
  await row(page, threads.release).click();
  await page.getByRole('button', { name: /^Hide the sidebar and the list/ }).click();
  await expect(page.locator('.pn-inbox[data-thread-full]')).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = '';
  });
  await expect(empty(page)).toBeVisible();
  await expect(list(page)).toBeVisible();
  await expect(page.locator('.ib-sb')).toHaveAttribute('data-state', 'expanded');

  // The Artifacts view: a rung of Escape, the list still at its width.
  await row(page, threads.files).click();
  await expect(subject(page)).toBeVisible();
  await page.locator('[data-artifacts-button]').click();
  await expect(page).toHaveURL(/artifacts/);
  expect(await width(page)).toBe(380);
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/artifacts/);
  await expect(subject(page)).toBeVisible();

  // A file beside the thread: it takes the list's room, then the thread is beside the list again.
  await page.getByRole('button', { name: 'Open rollout.md' }).first().click();
  const pane = page.locator('[data-attachment-pane]');
  await expect(pane).toBeVisible();
  await expect(empty(page)).toHaveCount(0);
  await expect(list(page)).toHaveCount(0);
  await pane.getByRole('button', { name: /^Close / }).click();
  await expect(pane).toHaveCount(0);
  await expect(list(page)).toBeVisible();
  expect(await width(page)).toBe(380);
  await subject(page).focus();
  await page.keyboard.press('Escape');
  await expect(empty(page)).toBeVisible();
  await page.context().close();
});

test('the sidebar closed: the list keeps its width and the panel takes the room', async ({ browser }) => {
  const page = await open(browser);
  const before = (await empty(page).boundingBox())!;
  await page.locator('.ib-lhead button[aria-label^="Toggle Sidebar"]').first().click();
  await expect(page.locator('.ib-sb')).toHaveAttribute('data-state', 'collapsed');
  await expect.poll(async () => (await empty(page).boundingBox())!.width).toBeGreaterThan(before.width + 150);
  expect(await width(page)).toBe(380);
  await page.context().close();
});

test('a project route, Settings and the Board keep their own screens; the empty panel is back on the list', async ({ browser }) => {
  const page = await open(browser, { hash: `#project=${projects['billing-svc']}` });
  await expect(empty(page)).toBeVisible();
  await expect(list(page)).toHaveClass(/ib-narrow/);
  await expect(page.locator('.ib-lhead-tt')).toHaveText('billing-svc');
  await row(page, threads.refund).click();
  await expect(subject(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(empty(page)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`project=${projects['billing-svc']}`));

  await page.goto(`${world.url}#settings`);
  await expect(page.locator('.ib-spage')).toBeVisible();
  await expect(empty(page)).toHaveCount(0);

  await page.goto(`${world.url}#board`);
  await expect(page.locator('.ib-bpage, [data-board-off]').first()).toBeVisible();
  await expect(empty(page)).toHaveCount(0);

  await page.goto(`${world.url}#`);
  await expect(empty(page)).toBeVisible();
  await page.context().close();
});

test('search opens its thread in the panel, and closing it returns to the empty panel', async ({ browser }) => {
  const page = await open(browser);
  await page.locator('[data-open-search]:visible').first().click();
  const palette = page.locator('dialog[data-search-palette]');
  await palette.getByRole('combobox').fill('Stripe');
  await expect(palette.locator('[data-search-indexing]')).toHaveCount(0, { timeout: 30_000 });
  const hit = palette.locator('[role="option"]', { hasText: 'Refund events' }).first();
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(subject(page)).toContainText('Trust the webhook');
  expect(await width(page)).toBe(380);
  await page.keyboard.press('Escape');
  await expect(empty(page)).toBeVisible();
  await page.context().close();
});

test('J and K: with no thread they walk the rows and open nothing; with one they step the panel, the list holding still', async ({ browser }) => {
  const page = await open(browser);
  const rows = await rowTops(page);
  const [first, second] = [rows[0]![0]!, rows[1]![0]!];
  await row(page, first).focus();
  await page.keyboard.press('j');
  expect(await focusName(page)).toBe(`row ${second}`);
  await page.keyboard.press('k');
  expect(await focusName(page)).toBe(`row ${first}`);
  await expect(empty(page)).toBeVisible();
  expect(page.url()).not.toContain('thread=');

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`thread=${first}`));
  await expect(subject(page)).toBeVisible();
  const box = await list(page).boundingBox();
  await row(page, first).focus();
  await page.keyboard.press('j');
  await expect(page).toHaveURL(new RegExp(`thread=${second}`));
  await expect(subject(page)).toBeVisible();
  expect(await list(page).boundingBox()).toEqual(box);
  await expect(empty(page)).toHaveCount(0);
  await page.context().close();
});

test('a window too narrow for two panes stacks as today and never shows the panel alone', async ({ browser }) => {
  // 1000 px less the 232 px sidebar: the list and a thread do not both fit.
  const page = await open(browser, { width: 1000 });
  await expect(list(page)).not.toHaveClass(/ib-narrow/);
  await expect(empty(page)).toHaveCount(0);
  await expect(page.locator('.pn-inbox')).toHaveAttribute('data-stack', 'thread');
  // The choice stays reachable there, and applies where there is room.
  await openMenu(page);
  await expect(item(page)).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  await row(page, threads.release).click();
  await expect(subject(page)).toBeVisible();
  await expect(list(page)).toBeHidden();
  await expect(page.locator('section.ib-pane [data-stack-back]')).toBeVisible();
  await page.locator('section.ib-pane [data-stack-back]').click();
  await expect(subject(page)).toHaveCount(0);
  await expect(list(page)).toBeVisible();
  await expect(empty(page)).toHaveCount(0);

  // Widened past the stacking width: the panel comes; narrowed: it goes, with no pane left alone.
  await page.setViewportSize({ width: 1300, height: 900 });
  await expect(empty(page)).toBeVisible();
  expect(await width(page)).toBe(380);
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(empty(page)).toHaveCount(0);
  await expect(list(page)).not.toHaveClass(/ib-narrow/);

  // Closing the sidebar makes the room.
  await page.locator('.ib-lhead button[aria-label^="Toggle Sidebar"]').first().click();
  await expect(empty(page)).toBeVisible();
  await page.context().close();
});

test('a phone: no panel and no item, whatever the browser remembers', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'light', reducedMotion: 'reduce' });
  await panelOn(context);
  const page = await context.newPage();
  await page.goto(world.url);
  await expect(page.locator('.ib-lbody')).toBeVisible();
  await expect(empty(page)).toHaveCount(0);
  await page.locator('[data-tidy-menu]').tap();
  await expect(page.locator('[data-tidy-menu-popup]')).toContainText('Compact rows');
  await expect(item(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await context.close();
});

test('rows at the short width: the agents against the project, the project cut with "…", one line', async ({ browser }) => {
  const page = await open(browser);
  const lead = await row(page, threads.ledger).evaluate((el) => {
    const line = el.querySelector<HTMLElement>('.ib-l1')!;
    const tiles = line.querySelector<HTMLElement>('.ib-atiles')!;
    const project = [...line.querySelectorAll<HTMLElement>('*')].find((node) => node.textContent?.includes('northwind') && node.children.length === 0)!;
    const style = getComputedStyle(project);
    return {
      gap: project.getBoundingClientRect().left - tiles.getBoundingClientRect().right,
      projectWidth: project.getBoundingClientRect().width,
      cut: project.scrollWidth > project.clientWidth,
      overflow: style.textOverflow,
      wrap: style.whiteSpace,
      lineHeight: line.getBoundingClientRect().height,
    };
  });
  expect(lead.gap).toBe(6);
  expect(lead.projectWidth).toBeGreaterThan(120);
  expect(lead.cut).toBe(true);
  expect(lead.overflow).toBe('ellipsis');
  expect(lead.wrap).toBe('nowrap');
  expect(lead.lineHeight).toBeLessThan(24);
  await page.context().close();
});

test('the tour draws its own list: no panel, no item; leaving it, the panel is back', async ({ browser }) => {
  const page = await open(browser);
  await page.goto(`${world.url}#settings/general`);
  await page.locator('[data-settings-take-tour]').click();
  await expect(page.locator('[data-tour-bar]')).toBeVisible();
  await page.locator('[data-tour-intro-go]').click();
  await expect(page.locator('[data-tour-coach]')).toBeVisible();
  await expect(empty(page)).toHaveCount(0);
  await expect(item(page)).toHaveCount(0);
  await page.locator('[data-tour-exit]').click();
  await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
  await page.goto(`${world.url}#`);
  await expect(empty(page)).toBeVisible();
  await page.context().close();
});

test('an empty Inbox is the first-run screen, with no panel beside it', async ({ browser }) => {
  const fresh = startWorld('plannotator-inbox-thread-panel-empty-e2e-');
  const context = await desktop(browser);
  await panelOn(context, fresh);
  const page = await context.newPage();
  await page.goto(fresh.url);
  await expect(page.locator('.ib-main .ib-empty, .ib-main [data-tour-start]').first()).toBeVisible();
  await expect(empty(page)).toHaveCount(0);
  await expect(page.locator('[data-thread-panel-loading]')).toHaveCount(0);
  await context.close();
});

test('a thread on a linked machine opens in the panel and closes to the empty panel', async ({ browser }) => {
  const studio = startWorld('plannotator-inbox-thread-panel-studio-e2e-', 'Studio');
  const macbook = startWorld('plannotator-inbox-thread-panel-macbook-e2e-', 'MacBook');
  const cli = (w: World, ...args: string[]) => spawnSync(binary, ['inbox', ...args], { env: w.env, cwd: w.root, encoding: 'utf8', timeout: 60_000 });
  await send(studio, 'claude', { project_path: scratchProject(join(studio.root, 'src'), 'studio-app'), thread: 'Here', subject: 'On this machine', body: 'Local.' });
  await send(macbook, 'codex', { project_path: scratchProject(join(macbook.root, 'src'), 'macbook-app'), thread: 'There', subject: 'On the MacBook', body: 'Linked.' });
  const offered = cli(macbook, 'link', '--offer');
  expect(offered.status, offered.stderr).toBe(0);
  const linked = cli(studio, 'link', offered.stdout.trim(), '--address', base(macbook), '--back', base(studio));
  expect(linked.status, linked.stderr).toBe(0);

  const context = await desktop(browser);
  await panelOn(context, studio);
  const page = await context.newPage();
  await page.goto(studio.url);
  await expect(page.locator('.ib-lbody [data-thread-id]:visible').filter({ hasText: 'There' }).first()).toBeVisible({ timeout: 30_000 });
  await expect(empty(page)).toBeVisible();
  await page.locator('.ib-lbody [data-thread-id]:visible').filter({ hasText: 'There' }).first().click();
  await expect(subject(page)).toHaveText('On the MacBook');
  expect(await width(page)).toBe(380);
  await page.getByRole('button', { name: 'Close the thread' }).click();
  await expect(empty(page)).toBeVisible();
  await context.close();
});
