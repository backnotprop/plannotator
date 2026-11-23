/**
 * Files on a file's own comment row (the owner, 2026-11-22: "I need to be able to attach images to this comment box
 * on top of files/artifacts"; packages/inbox/commentFiles.tsx), proved in a real browser against the compiled binary.
 * Nothing is mocked: `plannotator inbox --background` runs under a temp PLANNOTATOR_DATA_DIR and HOME
 * (PLANNOTATOR_INBOX_CONNECT=0, no browser, a tailscale trap first on PATH); one agent sends a picture through
 * `plannotator inbox mcp`; Chromium drives the window.
 *
 * Proves: the picture in full screen, on the card's Comment tab, has the reply box's paperclip after the pencil; a
 * picture chosen with it shows as the reply box's tile before Comment; Comment keeps it on the comment, whose card
 * in the file's comments shows it; the Send carries it to the agent as an attachment of the reply, named under the
 * comment; at 390 px (a phone) the paperclip is a 44 px button beside the pencil.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-comment-box-attach.spec.ts`.
 * PNGs land in <PLANNOTATOR_E2E_PROOF_DIR or .local/proof>/comment-box-attach/.
 */

import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { forgetFileViewChoice } from './file-view';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'comment-box-attach');

/** A made-up board for the agent's picture, and a small coloured square for the person's. */
const BOARD = `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:600 28px system-ui;background:#eef1f6;color:#1c2333}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:48px}.c{height:220px;border-radius:18px;background:#fff;box-shadow:0 2px 8px #0001;padding:24px}
.c:nth-child(2){background:#ffe7c2}.c:nth-child(5){background:#d8f0e3}</style><div class="grid"><div class="c">Ada Novak</div><div class="c">Bob Tully</div>
<div class="c">Charlie Dunn</div><div class="c">Backlog</div><div class="c">Shipped</div><div class="c">Notes</div></div>`;
const SWATCH = '<!doctype html><style>body{margin:0;background:#e2563b}</style>';

interface World {
  root: string;
  url: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threadId: string;
  ids: Record<string, string>;
  swatch: Buffer;
}

let world: World;

async function shot(page: Page, name: string, schemes: readonly ('light' | 'dark')[]): Promise<void> {
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(proofDir, `${name}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

const pane = (page = world.page) => page.locator('[data-attachment-pane]');
const card = (page = world.page) => page.locator('[data-fcomp]');
const commentClip = (page = world.page) => card(page).locator('label:has(input[data-comment-attach])');
const commentTiles = (page = world.page) => card(page).locator('[data-comment-files] [data-compose-file]');
const fileUrl = (name: string, full = true) => `${world.url}#thread=${world.threadId}&file=${world.ids[name]}${full ? '&view=full' : ''}`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-comment-box-attach-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const trap = join(root, 'trap');
  mkdirSync(home);
  mkdirSync(trap);
  // Nothing here may reach the real tailscale CLI.
  writeFileSync(join(trap, 'tailscale'), '#!/bin/sh\necho "inbox-comment-box-attach: tailscale must not run" >&2\nexit 97\n');
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = {
    PATH: `${trap}:${process.env.PATH ?? ''}`,
    HOME: home,
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

  const project = scratchProject(join(root, 'src'), 'board');
  mkdirSync(join(project, 'shots'));
  const maker = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const makerPage = await maker.newPage();
  await makerPage.setContent(BOARD);
  writeFileSync(join(project, 'shots', 'board.png'), await makerPage.screenshot());
  await makerPage.setViewportSize({ width: 160, height: 120 });
  await makerPage.setContent(SWATCH);
  const swatch = await makerPage.screenshot();
  await maker.close();

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
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
    swatch,
  };
  const sent = await world.claude.send({ project_path: project, subject: 'The team board, new columns', body: 'The board with the new columns. Anything off?', attachments: ['shots/board.png'] });
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

test('the Comment tab has the reply box’s paperclip after the pencil, at the pencil’s size', async () => {
  const page = world.page;
  await page.goto(fileUrl('board.png'));
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await expect(card().getByRole('radio', { name: 'Comment on this image' })).toHaveAttribute('aria-checked', 'true');
  const clip = commentClip();
  await expect(clip).toBeVisible();
  await expect(clip).toHaveAttribute('aria-label', 'Attach files');
  const pencil = (await card().locator('[data-markup-open]').boundingBox())!;
  const box = (await clip.boundingBox())!;
  // On the pencil's row, just after it, the same 30 px.
  expect(Math.abs(box.y + box.height / 2 - (pencil.y + pencil.height / 2))).toBeLessThan(2);
  expect(box.x).toBeGreaterThan(pencil.x + pencil.width - 1);
  expect(box.x - (pencil.x + pencil.width)).toBeLessThan(12);
  expect(Math.round(box.height)).toBe(Math.round(pencil.height));
  await page.mouse.move(200, 300);
  await shot(page, '01-comment-box-light', ['light']);
  await shot(page, '02-comment-box-dark', ['dark']);
});

test('a picture chosen with the paperclip shows as the reply box’s tile before Comment; Comment keeps it on the comment, and its card shows it', async () => {
  const page = world.page;
  await card().locator('input[data-comment-attach]').setInputFiles({ name: 'board-fix.png', mimeType: 'image/png', buffer: world.swatch });
  await expect(commentTiles()).toHaveCount(1);
  await expect(commentTiles().first()).toHaveAttribute('data-compose-file', 'done');
  await expect(commentTiles().first()).toHaveAttribute('data-compose-file-name', 'board-fix.png');
  const field = card().getByRole('textbox', { name: 'Comment on board.png' });
  await field.fill('The Bob Tully column should be this colour.');
  await page.mouse.move(200, 300);
  await shot(page, '03-picture-attached', ['light']);

  await card().locator('[data-image-comment-save]').click();
  await expect(commentTiles()).toHaveCount(0);
  await expect(field).toHaveValue('');
  // Beside the thread, the file's comments: the card shows the picture, from the upload it names.
  await page.goto(fileUrl('board.png', false));
  const comment = pane().locator('[data-annotation-id]').filter({ hasText: 'The Bob Tully column should be this colour.' });
  await expect(comment).toBeVisible();
  const picture = comment.locator('img[src*="/uploads/upl_"]');
  await expect(picture).toBeVisible();
  expect(await picture.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await comment.scrollIntoViewIfNeeded();
  await page.mouse.move(10, 10);
  await shot(page, '04-sent-comment-card', ['light']);
});

test('the Send carries the picture to the agent: an attachment of the reply, named under the comment', async () => {
  const page = world.page;
  await page.goto(fileUrl('board.png'));
  await card().getByRole('radio', { name: 'Reply to Claude Code' }).click();
  await card().locator('[data-fcomp-field] textarea').fill('One comment on the board.');
  await card().locator('[data-fcomp-send]').click();
  const reply = (await world.claude.nextReply(world.threadId, 40)) as { body: string; attachments?: { name: string; path: string }[] };
  expect(reply.body).toContain('> The Bob Tully column should be this colour.\n**Attached images:**\n- [board-fix] `board-fix.png`\n');
  const attached = (reply.attachments ?? []).find((a) => a.name === 'board-fix.png');
  expect(attached).toBeTruthy();
  // What the agent reads, kept with the screenshots (made-up names; the Inbox's sandbox paths).
  writeFileSync(join(proofDir, '06-agent-reads.txt'), `${reply.body}\n\n${(reply.attachments ?? []).map((a) => `Attached: ${a.name} (${a.path})`).join('\n')}\n`);
  expect(world.errors).toEqual([]);
});

test('a phone (390 px): the paperclip is a 44 px button beside the pencil on the Comment tab', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' });
  try {
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(fileUrl('board.png'));
    await expect(pane(page)).toHaveAttribute('data-full-view', '');
    await card(page).getByRole('radio', { name: 'Comment' }).click();
    const clip = commentClip(page);
    await expect(clip).toBeVisible();
    const box = (await clip.boundingBox())!;
    expect(Math.round(box.width)).toBe(44);
    expect(Math.round(box.height)).toBe(44);
    const pencil = (await card(page).locator('[data-markup-open]').boundingBox())!;
    expect(box.x).toBeGreaterThan(pencil.x + pencil.width - 1);
    await card(page).locator('input[data-comment-attach]').setInputFiles({ name: 'phone-fix.png', mimeType: 'image/png', buffer: world.swatch });
    await expect(commentTiles(page).first()).toHaveAttribute('data-compose-file', 'done');
    await shot(page, '05-phone', ['light']);
  } finally {
    await context.close();
  }
});

/** A real ClipboardEvent on the focused element carrying one picture, as a screenshot arrives (image.png, no text). */
async function pastePicture(page: Page, png: Buffer): Promise<boolean> {
  return page.evaluate((b64) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'image.png', { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    (document.activeElement ?? document.body).dispatchEvent(event);
    return event.defaultPrevented;
  }, png.toString('base64'));
}

const NOTES = { name: 'board-notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Board\n\nThe Backlog column needs a limit.\n') };

/** One tile's look and where it sits against its field: what must read the same in both boxes. */
async function tileLook(tile: Locator, field: Locator) {
  const look = await tile.evaluate((el) => {
    const s = getComputedStyle(el);
    const px = (sel: string, prop: 'fontSize' | 'width' | 'height') => getComputedStyle(el.querySelector(sel)!)[prop];
    return {
      height: Math.round(el.getBoundingClientRect().height),
      padding: s.padding,
      radius: s.borderRadius,
      gap: s.gap,
      name: px('.ib-nm', 'fontSize'),
      kind: px('.ib-kd', 'fontSize'),
      icon: `${px('.ib-fi', 'width')} × ${px('.ib-fi', 'height')}`,
    };
  });
  const t = (await tile.boundingBox())!;
  const f = (await field.boundingBox())!;
  return { ...look, underField: t.y >= f.y + f.height - 1 };
}

test('beside the thread, the comment box’s tiles are the reply box’s: the same pasted picture and file look the same, under the words', async () => {
  const page = world.page;
  await page.goto(fileUrl('board.png', false));
  const thread = page.locator('section.ib-pane');
  await thread.getByRole('button', { name: 'Reply', exact: true }).last().click();
  const box = thread.locator('.ib-rbox');
  const replyField = box.getByRole('textbox');
  await expect(replyField).toBeFocused();
  expect(await pastePicture(page, world.swatch)).toBe(true);
  await box.locator('[data-reply-attach]').setInputFiles(NOTES);
  await expect(box.locator('[data-compose-file="done"]')).toHaveCount(2);

  const row = pane().locator('[data-image-composer] .ib-ccard');
  const commentField = row.locator('textarea');
  await commentField.focus();
  expect(await pastePicture(page, world.swatch)).toBe(true);
  await row.locator('input[data-comment-attach]').setInputFiles(NOTES);
  await expect(row.locator('[data-compose-file="done"]')).toHaveCount(2);

  for (const index of [0, 1]) {
    const reply = await tileLook(box.locator('.ib-cp-file').nth(index), replyField);
    const comment = await tileLook(row.locator('.ib-cp-file').nth(index), commentField);
    expect(comment, `tile ${index + 1}`).toEqual(reply);
    expect(comment.underField, `tile ${index + 1} under the words`).toBe(true);
  }
  await page.mouse.move(10, 10);
  await shot(page, '07-reply-and-comment-light', ['light']);
  await shot(page, '08-reply-and-comment-dark', ['dark']);
  expect(world.errors).toEqual([]);
  await discardReply();
});

/** The reply box's draft (its files) goes, so the next test's box starts empty. */
async function discardReply() {
  const page = world.page;
  await page.goto(`${world.url}#thread=${world.threadId}`);
  const thread = page.locator('section.ib-pane');
  const box = thread.locator('.ib-rbox');
  if ((await box.count()) === 0) await thread.getByRole('button', { name: /^(Reply|Edit draft)$/ }).last().click();
  await box.locator('[data-reply-discard]').click();
  await expect(box).toHaveCount(0);
}

for (const width of [390, 320])
  test(`a phone (${width} px): the reply box and the comment box hold the same picture and file as the same tiles`, async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' });
    try {
      const page = await context.newPage();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      // The comment box: the picture in full screen, its Comment tab.
      await page.goto(fileUrl('board.png'));
      await expect(pane(page)).toHaveAttribute('data-full-view', '');
      await card(page).getByRole('radio', { name: 'Comment' }).click();
      const field = card(page).getByRole('textbox', { name: 'Comment on board.png' });
      await field.focus();
      expect(await pastePicture(page, world.swatch)).toBe(true);
      await card(page).locator('input[data-comment-attach]').setInputFiles(NOTES);
      await expect(card(page).locator('[data-comment-files] [data-compose-file="done"]')).toHaveCount(2);
      // The field keeps room to write in beside the row's controls.
      expect((await field.boundingBox())!.width).toBeGreaterThanOrEqual(120);
      await shot(page, `09-phone-${width}-comment`, ['light']);
      // The reply box with the same two.
      await page.goto(`${world.url}#thread=${world.threadId}`);
      const thread = page.locator('section.ib-pane');
      await thread.getByRole('button', { name: 'Reply', exact: true }).last().click();
      const box = thread.locator('.ib-rbox');
      await box.getByRole('textbox').focus();
      expect(await pastePicture(page, world.swatch)).toBe(true);
      await box.locator('[data-reply-attach]').setInputFiles(NOTES);
      await expect(box.locator('[data-compose-file="done"]')).toHaveCount(2);
      await shot(page, `10-phone-${width}-reply`, ['light']);
    } finally {
      await context.close();
    }
    await discardReply();
  });
