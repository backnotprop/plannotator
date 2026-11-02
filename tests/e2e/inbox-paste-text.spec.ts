/**
 * A long paste is a file (approval "inbox-paste-attachment", option A), proved
 * in a real browser against the compiled binary. The binary runs
 * `plannotator inbox --background` under a temp PLANNOTATOR_DATA_DIR (and temp
 * agent config dirs), an agent writes through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts), a connection's long-poll keeps one session live for
 * compose, and Chromium pastes real ClipboardEvents carrying 40 KB of text.
 *
 *  1. The reply box: the paste becomes a tile with Undo; the platform's undo
 *     (a real ⌘Z / Ctrl+Z) puts it back where it was, caret after it; after
 *     another edit it stands down; after 10 s hover shows Put back in box,
 *     which puts it back; Send carries the file, the agent reads its bytes.
 *  2. New message: a tile and no words sends; the thread shows the file.
 *  3. A phone (390 and 320 px): Undo, then Put back, beside the ×; the tile
 *     fits; Put back works.
 *
 * Build the binary first (see inbox.spec.ts). PNGs land in
 * .local/proof/paste-text/ (and PASTE_TEXT_SHOTS_DIR when set).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_POLL_PATH } from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'paste-text');
const extraShots = process.env.PASTE_TEXT_SHOTS_DIR ? resolve(process.env.PASTE_TEXT_SHOTS_DIR) : null;
const PASTED = /^pasted-text-\d{4}-\d\d-\d\d-\d{4}(-\d+)?\.txt$/;
const UNDO_KEY = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';

/** About 40 KB of a worker's log: over the 32 KB threshold. */
const LOG = Array.from({ length: 700 }, (_, i) => `2026-11-01T21:${String(10 + (i % 50)).padStart(2, '0')}:04Z worker-3 retry ${i % 4} job=${4100 + i} status=failed\n`).join('');

interface World {
  root: string;
  dataDir: string;
  url: string;
  ledger: string;
  agent: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  stopPoll: () => Promise<void>;
}

let world: World;

function registry(dataDir: string): { port: number; token: string } {
  return JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8'));
}

/** A connection's long-poll, saying where the session works: it stays live for compose. */
function keepLive(dataDir: string, session: string, host: string, project: string): () => Promise<void> {
  let stopped = false;
  const startedAt = Date.now() - 20 * 60_000;
  const loop = (async () => {
    while (!stopped) {
      const { port, token } = registry(dataDir);
      await fetch(`http://127.0.0.1:${port}${INBOX_BRIDGE_POLL_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session, host, waitMs: 1_000, project_path: project, started_at: startedAt, busy: false, idle_since: startedAt }),
      }).catch(() => null);
    }
  })();
  return async () => {
    stopped = true;
    await loop;
  };
}

async function shot(page: Page, name: string, schemes: readonly ('light' | 'dark')[] = ['light', 'dark']): Promise<void> {
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    const file = join(proofDir, `${name}-${scheme}.png`);
    await page.screenshot({ path: file });
    if (extraShots) copyFileSync(file, join(extraShots, `${name}-${scheme}.png`));
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** A real ClipboardEvent of text on the focused element. True when the browser's own paste was prevented. */
async function pasteText(page: Page, text: string): Promise<boolean> {
  return page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    (document.activeElement ?? document.body).dispatchEvent(event);
    return event.defaultPrevented;
  }, text);
}

/** The field's value and caret. */
async function field(page: Page, selector: string): Promise<{ value: string; caret: number; end: number; focused: boolean }> {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector) as HTMLTextAreaElement;
    return { value: el.value, caret: el.selectionStart, end: el.selectionEnd, focused: document.activeElement === el };
  }, selector);
}

async function caretAt(page: Page, selector: string, at: number): Promise<void> {
  await page.evaluate(({ selector, at }) => {
    const el = document.querySelector(selector) as HTMLTextAreaElement;
    el.focus();
    el.setSelectionRange(at, at);
  }, { selector, at });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  if (extraShots) mkdirSync(extraShots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-paste-text-e2e-');
  const dataDir = join(root, 'data');
  for (const dir of ['claude', 'codex', 'opencode']) mkdirSync(join(root, dir), { recursive: true });
  const env = {
    PATH: process.env.PATH ?? '',
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    OPENCODE_CONFIG_DIR: join(root, 'opencode'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const ledger = scratchProject(join(root, 'src'), 'ledger');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const stopPoll = keepLive(dataDir, 'ses-pi', 'pi', ledger);
  world = { root, dataDir, url, ledger, agent, context, page, errors, stopPoll };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.stopPoll();
    await world.agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

async function newThread(subject: string): Promise<string> {
  const sent = await world.agent.send({ project_path: world.ledger, subject, body: 'The nightly import failed on worker-3. Can you send me the log?' });
  return sent.thread_id as string;
}

const BOX = 'section.ib-pane .ib-rbox textarea';
const BEFORE = 'Here is the log.';
const AFTER = ' It fails on the third retry.';

test('the reply box: Undo and ⌘Z put the paste back where it was, ⌘Z stands down after another edit, Put back after 10 s; Send carries the file', async () => {
  const { page, agent } = world;
  const threadId = await newThread('Nightly import failed');
  await page.goto(`${world.url}#thread=${threadId}`);
  const pane = page.locator('section.ib-pane');
  await pane.getByRole('button', { name: 'Reply', exact: true }).last().click();
  const box = pane.locator('.ib-rbox');
  const text = box.getByRole('textbox');
  await expect(text).toBeFocused();
  await text.pressSequentially(`${BEFORE}${AFTER}`);
  await caretAt(page, BOX, BEFORE.length);

  // The paste is a file: the browser's own paste is prevented, the words stay as they were.
  expect(await pasteText(page, LOG)).toBe(true);
  const tile = box.locator('[data-pasted-text]');
  await expect(tile).toHaveCount(1);
  expect(await tile.getAttribute('data-compose-file-name')).toMatch(PASTED);
  await expect(tile).toHaveAttribute('data-pasted-fresh', '');
  await expect(tile.locator('[data-pasted-undo]')).toBeVisible();
  expect((await field(page, BOX)).value).toBe(`${BEFORE}${AFTER}`);
  await shot(page, '01-reply-tile-undo');

  // The platform's undo, as the very next edit: the exact text back between the words, the caret after it.
  await page.keyboard.press(UNDO_KEY);
  await expect(tile).toHaveCount(0);
  let now = await field(page, BOX);
  expect(now.value).toBe(`${BEFORE}${LOG}${AFTER}`);
  expect(now.caret).toBe(BEFORE.length + LOG.length);
  expect(now.end).toBe(now.caret);
  expect(now.focused).toBe(true);

  // Again, then another edit: undo is the browser's again (the typing goes), the tile stays.
  await text.fill(`${BEFORE}${AFTER}`);
  await caretAt(page, BOX, BEFORE.length);
  expect(await pasteText(page, LOG)).toBe(true);
  await expect(tile).toHaveCount(1);
  await page.keyboard.type(' See below.');
  expect((await field(page, BOX)).value).toBe(`${BEFORE} See below.${AFTER}`);
  await page.keyboard.press(UNDO_KEY);
  await expect(tile).toHaveCount(1);
  expect((await field(page, BOX)).value).not.toContain(LOG);

  // After 10 s the line is the size; hover swaps it in place for Put back in box, with no layout shift.
  await expect(tile).not.toHaveAttribute('data-pasted-fresh', /.*/, { timeout: 15_000 });
  await page.mouse.move(0, 0);
  await expect(tile.locator('[data-pasted-put-back]')).toHaveCSS('opacity', '0');
  const rest = await tile.boundingBox();
  await shot(page, '02-reply-tile');
  await tile.hover();
  await expect(tile.locator('[data-pasted-put-back]')).toHaveCSS('opacity', '1');
  expect(await tile.boundingBox()).toEqual(rest);
  await shot(page, '03-reply-tile-hover');
  // What the browser's undo left of the typing stays after the paste's place: words typed at the
  // caret right after a paste come after it, so Put back puts the paste ahead of them.
  const typed = (await field(page, BOX)).value;
  expect(typed.startsWith(BEFORE)).toBe(true);
  expect(typed.endsWith(AFTER)).toBe(true);
  await tile.locator('[data-pasted-put-back]').click();
  await expect(tile).toHaveCount(0);
  now = await field(page, BOX);
  expect(now.value).toBe(`${BEFORE}${LOG}${typed.slice(BEFORE.length)}`);
  expect(now.caret).toBe(BEFORE.length + LOG.length);

  // A paste that goes: Send carries it, the agent reads the exact bytes.
  await text.fill(`${BEFORE}${AFTER}`);
  await caretAt(page, BOX, BEFORE.length);
  expect(await pasteText(page, LOG)).toBe(true);
  await expect(box.locator('[data-compose-file="done"][data-pasted-text]')).toHaveCount(1);
  const name = (await tile.getAttribute('data-compose-file-name'))!;
  await pane.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(box).toHaveCount(0);
  await expect(pane.locator('article.ib-message').last().locator(`.ib-att-t[data-attachment-name="${name}"]`)).toBeVisible();
  const answer = await agent.nextReply(threadId, 10);
  expect(answer.body).toContain(`${BEFORE}${AFTER}`);
  const attached = answer.attachments as { name: string; path: string }[];
  expect(attached.map((a) => a.name)).toEqual([name]);
  expect(readFileSync(attached[0]!.path, 'utf8')).toBe(LOG);
  expect(world.errors).toEqual([]);
});

test('New message: a pasted tile and no words sends; the new thread shows the file', async () => {
  const { page } = world;
  await page.goto(world.url);
  await page.locator('.ib-side [data-open-compose]').click();
  const dialog = page.locator('dialog[data-compose]');
  const to = dialog.locator('.ib-cp-tobtn');
  await expect(to).not.toHaveAttribute('data-loading', /.*/, { timeout: 15_000 });
  await to.click();
  await dialog.locator('[data-compose-session="ses-pi"]').click();
  const text = dialog.getByRole('textbox', { name: 'Message' });
  await expect(text).toBeFocused();
  expect(await pasteText(page, LOG)).toBe(true);
  const tile = dialog.locator('[data-compose-file="done"][data-pasted-text]');
  await expect(tile).toHaveCount(1);
  await expect(text).toHaveValue('');
  const name = (await tile.getAttribute('data-compose-file-name'))!;
  expect(name).toMatch(PASTED);
  await shot(page, '04-new-message-only-tile');
  await dialog.locator('[data-compose-send]').click();
  await expect(dialog).toHaveCount(0);
  await page.locator('[data-inbox-toast] [data-toast-action]').click();
  await expect(page.locator(`section.ib-pane .ib-att-t[data-attachment-name="${name}"]`)).toBeVisible();
  expect(world.errors).toEqual([]);
});

test('a phone: Undo, then Put back, beside the × with a 44 px target; the tile fits at 390 and 320 px; Put back works', async () => {
  const threadId = await newThread('Import log on a phone');
  const phone = await world.context.browser()!.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' });
  const mobile = await phone.newPage();
  try {
    await mobile.goto(`${world.url}#thread=${threadId}`);
    const pane = mobile.locator('section.ib-pane');
    const reply = pane.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true });
    await reply.click();
    const box = pane.locator('.ib-rbox');
    await box.getByRole('textbox').fill(`${BEFORE}${AFTER}`);
    await caretAt(mobile, BOX, BEFORE.length);
    expect(await pasteText(mobile, LOG)).toBe(true);
    const tile = box.locator('[data-pasted-text]');
    await expect(tile).toHaveCount(1);
    const side = tile.locator('[data-pasted-side]');
    await expect(side).toBeVisible();
    await expect(side).toHaveText('Undo');
    // The line keeps the size; the link is beside the ×.
    await expect(tile.locator('[data-pasted-undo]')).toBeHidden();
    const target = await side.evaluate((el) => {
      const after = getComputedStyle(el, '::after');
      const r = el.getBoundingClientRect();
      return { width: Math.max(r.width, parseFloat(after.width) || 0), height: Math.max(r.height, parseFloat(after.height) || 0) };
    });
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
    await shot(mobile, '05-phone-390-undo');
    await mobile.setViewportSize({ width: 320, height: 700 });
    await shot(mobile, '06-phone-320-undo');

    await expect(tile).not.toHaveAttribute('data-pasted-fresh', /.*/, { timeout: 15_000 });
    await expect(side).toHaveText('Put back');
    for (const width of [320, 390]) {
      await mobile.setViewportSize({ width, height: width === 320 ? 700 : 844 });
      const [outer, inner] = await Promise.all([box.boundingBox(), tile.boundingBox()]);
      expect(inner!.x).toBeGreaterThanOrEqual(outer!.x);
      expect(inner!.x + inner!.width).toBeLessThanOrEqual(outer!.x + outer!.width + 0.5);
      expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await shot(mobile, `0${width === 320 ? 7 : 8}-phone-${width}-put-back`);
    }
    await side.tap();
    await expect(tile).toHaveCount(0);
    const now = await field(mobile, BOX);
    expect(now.value).toBe(`${BEFORE}${LOG}${AFTER}`);
    expect(now.caret).toBe(BEFORE.length + LOG.length);
  } finally {
    await phone.close();
  }
});
