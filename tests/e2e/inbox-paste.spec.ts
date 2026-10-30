/**
 * Paste to attach (the owner: "When I'm writing a new message or even a
 * reply, I need to be able to paste in images"), proved in a real browser
 * against the compiled binary. Nothing is mocked: the binary runs
 * `plannotator inbox --background` under a temp PLANNOTATOR_DATA_DIR and
 * HOME, an agent writes through `plannotator inbox mcp` (scripts/inbox-sim.ts),
 * a connection's long-poll keeps one session live for compose, and Chromium
 * pastes real ClipboardEvents whose clipboardData carries an image (a
 * screenshot of the window itself).
 *
 *  1. Compose: a pasted screenshot attaches as `pasted-image-<date>-<time>.png`
 *     and rides the Send; a text paste is left to the browser.
 *  2. The reply box: two pasted images (one held mid-upload for the picture),
 *     Send carries both; the agent's wait_for_reply names them; the sent reply
 *     shows them in the thread's tiles.
 *  3. The reply box's paperclip and drops (approval "inbox-reply-attach"):
 *     files dropped on the thread with the reply closed open it holding them,
 *     the paperclip and a drop on the box add more with their own names, a
 *     text drag is not taken, and Send carries them all to the agent.
 *  4. A phone: the tiles fit the reply box at 390 and 320 px.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs land in .local/proof/paste-images/ (and PASTE_SHOTS_DIR when set).
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
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'paste-images');
const extraShots = process.env.PASTE_SHOTS_DIR ? resolve(process.env.PASTE_SHOTS_DIR) : null;
const PASTED = /^pasted-image-\d{4}-\d\d-\d\d-\d{4}(-\d+)?\.png$/;

const QUESTION = [
  'The revenue chart is rendered on the dashboard.',
  '',
  ':::question',
  'Does the legend read right next to the axis?',
  '',
  '- [ ] Yes, ship it',
  '- [ ] No, move it',
  ':::',
].join('\n');

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
  threadId: string;
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

/**
 * A real ClipboardEvent on the focused element, its clipboardData carrying
 * the image (as a screenshot arrives: a file named image.png, no text) and,
 * when given, text. Returns whether the browser's own paste was prevented.
 */
async function paste(page: Page, content: { png?: Buffer; text?: string }): Promise<boolean> {
  return page.evaluate(
    ({ b64, text }) => {
      const data = new DataTransfer();
      if (b64) {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        data.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
      }
      if (text !== null) data.setData('text/plain', text);
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      (document.activeElement ?? document.body).dispatchEvent(event);
      return event.defaultPrevented;
    },
    { b64: content.png ? content.png.toString('base64') : null, text: content.text ?? null },
  );
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  if (extraShots) mkdirSync(extraShots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-paste-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const ledger = scratchProject(join(root, 'src'), 'ledger');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const sent = await agent.send({ project_path: ledger, subject: 'Revenue chart is rendered', body: QUESTION });
  const stopPoll = keepLive(dataDir, 'ses-pi', 'pi', ledger);
  world = { root, dataDir, url, ledger, agent, context, page, errors, stopPoll, threadId: sent.thread_id as string };
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

/** A screenshot of part of the window: a real picture to paste. */
async function screenshotBytes(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
  return page.screenshot({ clip });
}

test('compose: a pasted screenshot attaches with a dated name and rides the Send; a text paste is left to the browser', async () => {
  const { page } = world;
  await page.goto(world.url);
  await expect(page.locator(`[data-thread-id="${world.threadId}"]`).first()).toBeVisible();
  const picture = await screenshotBytes(page, { x: 0, y: 0, width: 760, height: 420 });
  await page.locator('.ib-side [data-open-compose]').click();
  const dialog = page.locator('dialog[data-compose]');
  // A plain New message opens with To empty and focus on To: pick the session; focus moves to the message.
  const to = dialog.locator('.ib-cp-tobtn');
  await expect(to).toBeFocused();
  await expect(to).not.toHaveAttribute('data-loading', /.*/, { timeout: 15_000 });
  await to.click();
  await dialog.locator('[data-compose-session="ses-pi"]').click();
  await expect(dialog.locator('[data-compose-to="ses-pi"]')).toBeVisible();
  const text = dialog.getByRole('textbox', { name: 'Message' });
  await expect(text).toBeFocused();
  await text.fill('The list header wraps on a narrow window. This is what I see:');

  // Text alone: the browser's own paste, never prevented.
  expect(await paste(page, { text: 'plain words' })).toBe(false);
  await expect(dialog.locator('[data-compose-file]')).toHaveCount(0);
  // A spreadsheet cell: its text plus the picture of it, a file named image.png. The text is the paste.
  expect(await paste(page, { png: picture, text: 'Q3\t1,204\t+8%' })).toBe(false);
  await page.waitForTimeout(300);
  await expect(dialog.locator('[data-compose-file]')).toHaveCount(0);
  // A screenshot: the window takes it.
  expect(await paste(page, { png: picture })).toBe(true);
  const tile = dialog.locator('[data-compose-file="done"]');
  await expect(tile).toHaveCount(1);
  const name = (await tile.getAttribute('data-compose-file-name'))!;
  expect(name).toMatch(PASTED);
  await expect(tile).toContainText('PNG image');
  await shot(page, '01-compose-pasted-image');

  await dialog.locator('[data-compose-send]').click();
  await expect(dialog).toHaveCount(0);
  const pane = page.locator('section.ib-pane');
  await page.locator('[data-inbox-toast] [data-toast-action]').click();
  await expect(pane.locator(`.ib-att-t[data-attachment-name="${name}"]`)).toBeVisible();
  expect(world.errors).toEqual([]);
});

test('the reply box: two pasted images (one still uploading), Send carries both on the reply; the agent reads them; the thread shows them', async () => {
  const { page, agent } = world;
  await page.goto(`${world.url}#thread=${world.threadId}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.locator('fieldset[data-question-key]')).toHaveCount(1);
  const pictureA = await screenshotBytes(page, { x: 0, y: 0, width: 640, height: 360 });
  const pictureB = await screenshotBytes(page, { x: 600, y: 120, width: 520, height: 520 });
  await pane.getByRole('button', { name: 'Reply', exact: true }).last().click();
  const box = pane.locator('.ib-rbox');
  const text = box.getByRole('textbox');
  await expect(text).toBeFocused();
  await text.fill('The legend sits on top of the axis labels. Two shots: the full chart, and the corner.');

  // The second upload is held until its picture is taken, so one tile shows as uploading.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  let uploads = 0;
  await page.route('**/api/inbox/uploads?**', async (route) => {
    uploads += 1;
    if (uploads === 2) await held;
    await route.continue();
  });
  expect(await paste(page, { png: pictureA })).toBe(true);
  await expect(box.locator('[data-compose-file="done"]')).toHaveCount(1);
  expect(await paste(page, { png: pictureB })).toBe(true);
  await expect(box.locator('[data-compose-file="uploading"]')).toHaveCount(1);
  await shot(page, '02-reply-two-pasted-one-uploading');
  // Send while it uploads: nothing goes yet.
  await pane.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(pane.locator('.ib-error')).toContainText('Wait for the files to finish uploading');
  release();
  await expect(box.locator('[data-compose-file="done"]')).toHaveCount(2);
  await page.unroute('**/api/inbox/uploads?**');
  const names = await box.locator('[data-compose-file]').evaluateAll((els) => els.map((el) => el.getAttribute('data-compose-file-name')!));
  expect(names.every((n) => PASTED.test(n))).toBe(true);
  expect(new Set(names).size).toBe(2);
  await shot(page, '02b-reply-two-pasted');

  await pane.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(box).toHaveCount(0);
  const reply = pane.locator('article.ib-message').last();
  for (const name of names) await expect(reply.locator(`.ib-att-t[data-attachment-name="${name}"]`)).toBeVisible();
  await reply.scrollIntoViewIfNeeded();
  await shot(page, '03-sent-reply-in-thread');

  const answer = await agent.waitForReply(world.threadId, 10);
  const body = (answer.reply as { body: string }).body;
  expect(body).toContain('The legend sits on top of the axis labels.');
  for (const name of names) expect(body).toMatch(new RegExp(`\\nAttached: ${name.replace(/\./g, '\\.')} \\(/.+/inbox/uploads/att_[0-9A-Z]+/${name.replace(/\./g, '\\.')}\\)`));
  expect(world.errors).toEqual([]);
});

/**
 * A real DragEvent of `type` on the first element `selector` matches, its
 * dataTransfer carrying `files` (as the file manager hands them over) or text.
 * Returns whether the page took it.
 */
async function dragOn(page: Page, selector: string, type: 'dragenter' | 'dragover' | 'drop', content: { files?: { name: string; type: string; b64: string }[]; text?: string }): Promise<boolean> {
  return page.evaluate(
    ({ selector, type, files, text }) => {
      const data = new DataTransfer();
      for (const file of files) data.items.add(new File([Uint8Array.from(atob(file.b64), (c) => c.charCodeAt(0))], file.name, { type: file.type }));
      if (text !== null) data.setData('text/plain', text);
      const target = document.querySelector(selector)!;
      const r = target.getBoundingClientRect();
      const event = new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { selector, type, files: content.files ?? [], text: content.text ?? null },
  );
}

test('the reply box: files dropped on the thread open the reply holding them; the paperclip and a drop on the box add more; Send carries them all', async () => {
  const { page, agent } = world;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${world.url}#thread=${world.threadId}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('button', { name: 'Reply', exact: true }).last()).toBeVisible();
  await expect(pane.locator('.ib-rbox')).toHaveCount(0);
  const picture = await screenshotBytes(page, { x: 0, y: 0, width: 640, height: 360 });
  const png = { name: 'ledger-q3-export.png', type: 'image/png', b64: picture.toString('base64') };

  // A link dragged over the thread: not taken, no target.
  expect(await dragOn(page, 'section.ib-pane .ib-pbody', 'dragover', { text: 'https://example.com/q3' })).toBe(false);
  await expect(pane.locator('[data-pane-drop]')).toHaveCount(0);
  // Files over the thread: the whole pane is the target.
  expect(await dragOn(page, 'section.ib-pane .ib-pbody', 'dragenter', { files: [png] })).toBe(true);
  expect(await dragOn(page, 'section.ib-pane .ib-pbody', 'dragover', { files: [png] })).toBe(true);
  await expect(pane.locator('[data-pane-drop]')).toBeVisible();
  await shot(page, '05-reply-dragover-pane', ['dark']);
  expect(await dragOn(page, 'section.ib-pane .ib-pbody', 'drop', { files: [png] })).toBe(true);
  await expect(pane.locator('[data-pane-drop]')).toHaveCount(0);
  // The drop opened the reply box with the file.
  const box = pane.locator('.ib-rbox');
  await expect(box.locator('[data-compose-file="done"][data-compose-file-name="ledger-q3-export.png"]')).toHaveCount(1);

  // The paperclip, first in the box's toolbar: any file, its own name kept.
  const clip = box.locator('.ib-rfoot > label:first-child');
  await expect(clip).toHaveAccessibleName('Attach files');
  await box.locator('[data-reply-attach]').setInputFiles({ name: 'currency-notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Currency\n\nEUR rows lose the column.\n') });
  await expect(box.locator('[data-compose-file="done"][data-compose-file-name="currency-notes.md"]')).toHaveCount(1);

  // A drop on the box itself: a dashed "Drop to attach", the pane's target off.
  const zip = { name: 'exports-2026-10.zip', type: 'application/zip', b64: Buffer.from('PK\u0005\u0006' + '\u0000'.repeat(18), 'binary').toString('base64') };
  expect(await dragOn(page, 'section.ib-pane .ib-rbox textarea', 'dragover', { files: [zip] })).toBe(true);
  await expect(box).toHaveAttribute('data-drop-over', '');
  await expect(box.locator('[data-box-drop]')).toBeVisible();
  await expect(pane.locator('[data-pane-drop]')).toHaveCount(0);
  await shot(page, '06-reply-dragover-box', ['dark']);
  expect(await dragOn(page, 'section.ib-pane .ib-rbox textarea', 'drop', { files: [zip] })).toBe(true);
  await expect(box).not.toHaveAttribute('data-drop-over', /.*/);
  await expect(box.locator('[data-compose-file="done"]')).toHaveCount(3);
  await box.getByRole('textbox').fill('Here is the Q3 export, my notes and the raw files.');
  await shot(page, '07-reply-attached-chips', ['dark']);

  await pane.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(box).toHaveCount(0);
  const names = ['ledger-q3-export.png', 'currency-notes.md', 'exports-2026-10.zip'];
  const reply = pane.locator('article.ib-message').last();
  for (const name of names) await expect(reply.locator(`.ib-att-t[data-attachment-name="${name}"]`)).toBeVisible();
  // The agent may not have read the earlier test's reply yet: read on until this one.
  let body = '';
  let cursor: number | undefined;
  for (let i = 0; i < 3 && !body.includes('Here is the Q3 export'); i++) {
    const answer = await agent.waitForReply(world.threadId, 10, cursor);
    body = (answer.reply as { body: string }).body;
    cursor = answer.cursor as number | undefined;
  }
  for (const name of names) expect(body).toContain(`Attached: ${name} (`);
  expect(world.errors).toEqual([]);
});

test('a phone: a pasted image fits the reply box at 390 and 320 px, and the sent reply shows it', async () => {
  const phone = await world.context.browser()!.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' });
  const mobile = await phone.newPage();
  try {
    await mobile.goto(`${world.url}#thread=${world.threadId}`);
    const pane = mobile.locator('section.ib-pane');
    const reply = pane.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true });
    await expect(reply).toBeVisible();
    const picture = await mobile.screenshot({ clip: { x: 0, y: 0, width: 390, height: 600 } });
    await reply.click();
    const box = pane.locator('.ib-rbox');
    await box.getByRole('textbox').fill('On my phone too.');
    expect(await paste(mobile, { png: picture })).toBe(true);
    await expect(box.locator('[data-compose-file="done"]')).toHaveCount(1);
    for (const width of [390, 320]) {
      await mobile.setViewportSize({ width, height: 700 });
      const [outer, tile] = await Promise.all([box.boundingBox(), box.locator('[data-compose-file]').boundingBox()]);
      expect(tile!.x).toBeGreaterThanOrEqual(outer!.x);
      expect(tile!.x + tile!.width).toBeLessThanOrEqual(outer!.x + outer!.width + 0.5);
      expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await mobile.setViewportSize({ width: 390, height: 844 });
    await shot(mobile, '04-phone-reply-pasted-image');
    await pane.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(box).toHaveCount(0);
    const sentReply = pane.locator('article.ib-message').last();
    await expect(sentReply.locator('.ib-att-t[data-attachment-name]')).toHaveCount(1);
    await sentReply.scrollIntoViewIfNeeded();
    await shot(mobile, '05-phone-sent-reply');
  } finally {
    await phone.close();
  }
});
