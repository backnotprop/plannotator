/**
 * Picture choices and the question contract lines (approval
 * "inbox-decision-mode", agent contract lines), proved in a real browser
 * against the compiled binary. Nothing is mocked: the binary runs
 * `plannotator inbox --background` under a temp PLANNOTATOR_DATA_DIR and
 * HOME, and a Claude Code agent asks through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts) with two real PNGs beside the project.
 *
 * Desktop (Chromium, 1440): the card shows Stakes, the Can't be undone tag,
 * the Shows chip and Why; the choices are picture tiles whose pictures load
 * from the message image route; the zoom button opens the thread's viewer
 * without picking; a click on a picture picks it; Send; the agent's
 * wait_for_reply gets the plain label. Then an iPhone 15 in WebKit does the
 * same on a second question. Last, images the Inbox refuses to serve (a
 * hidden folder of the home folder: 403 image_hidden; a missing file: 404)
 * show as their alt text, never a broken-image icon, and a card whose
 * pictures are refused falls back to text rows, on the desktop and on the
 * iPhone. Screenshots, light and dark, land in
 * PLANNOTATOR_QUESTION_CONTRACT_SHOTS (default .local/proof/question-contract/).
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(process.env.PLANNOTATOR_QUESTION_CONTRACT_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'question-contract'));

/** A real PNG of `w` x `h` px: a coloured frame on a light ground (so the tiles differ at a glance). */
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const edge = x < 12 || y < 12 || x >= w - 12 || y >= h - 12;
      const bar = y > h * 0.7 && y < h * 0.82 && x > w * 0.15 && x < w * 0.85;
      const [r, g, b] = edge || bar ? rgb : [244, 244, 240];
      row.set([r, g, b], 1 + x * 3);
    }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const DRAWERS = [
  'Two drawer designs for checkout.',
  '',
  ':::question',
  'Which checkout drawer should ship?',
  'Stakes: ships to all of checkout on Thursday; changing it later costs a week of QA.',
  'Shows: ![Both drawers side by side](shots/both.png)',
  'Reversible: no — the old drawer code is deleted with the release',
  'Holds up: checkout release',
  '',
  '- [ ] A · Total on top — ![Drawer A](shots/drawer-a.png) closest to today',
  '- [ ] B · Total pinned with Pay — ![Drawer B](shots/drawer-b.png) the total never scrolls away',
  '',
  'Recommended: B · Total pinned with Pay',
  '',
  'Why: on a 320 px screen only B keeps the total next to the button.',
  ':::',
].join('\n');

const LAYOUTS = [
  ':::question-multi',
  'Which layouts should the settings page offer?',
  'Stakes: decides how much of settings fits on a phone.',
  '',
  '- Tabs — ![Tabs layout](shots/drawer-a.png)',
  '- Sidebar — ![Sidebar layout](shots/drawer-b.png) more room',
  '',
  'Recommended: Sidebar',
  ':::',
].join('\n');

interface World {
  dataDir: string;
  url: string;
  env: Record<string, string>;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  project: string;
  root: string;
}

let world: World;

function registry(): { port: number } {
  return JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
}

async function shot(page: Page, name: string, target?: ReturnType<Page['locator']>): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    if (target) await target.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
    else await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-picture-choices-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'shop');
  mkdirSync(join(project, 'shots'), { recursive: true });
  writeFileSync(join(project, 'shots', 'drawer-a.png'), png(640, 480, [37, 99, 235]));
  writeFileSync(join(project, 'shots', 'drawer-b.png'), png(640, 480, [22, 163, 74]));
  writeFileSync(join(project, 'shots', 'both.png'), png(960, 400, [217, 119, 6]));
  // Refused images: a hidden folder of the home folder, HOME being `root` (the route answers 403 image_hidden).
  mkdirSync(join(root, '.secret'), { recursive: true });
  for (const name of ['shot.png', 'raw.png', 'both.png', 'a.png']) writeFileSync(join(root, '.secret', name), png(640, 480, [190, 18, 60]));
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  world = { dataDir, url, env, claude, context, page, errors, project, root };
  await fetch(`http://127.0.0.1:${registry().port}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });
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

test('desktop: tiles pick, zoom is separate, the contract lines show, and the agent gets the plain label', async () => {
  const { page, claude, project } = world;
  const sent = await claude.send({ project_path: project, subject: 'Checkout drawer', body: DRAWERS }, { wakes: true });
  const threadId = sent.thread_id as string;
  await page.goto(`${world.url}#thread=${threadId}`);
  const pane = page.locator('section.ib-pane');
  const card = pane.locator('fieldset.question-block');
  await expect(card).toBeVisible();

  await expect(card.locator('[data-question-part="stakes"]')).toHaveText('ships to all of checkout on Thursday; changing it later costs a week of QA.');
  await expect(card.locator('[data-question-irreversible]')).toContainText('Can’t be undone');
  await expect(card.locator('[data-question-part="why"]')).toHaveText('Why B · Total pinned with Pay: on a 320 px screen only B keeps the total next to the button.');
  await expect(card.locator('[data-question-shows-open]')).toContainText('Both drawers side by side');
  await expect(card).not.toContainText('![');

  const tiles = card.locator('[data-question-tile]');
  await expect(tiles).toHaveCount(2);
  // The pictures load from the message image route.
  for (const i of [0, 1]) {
    await expect.poll(() => tiles.nth(i).locator('img[data-question-picture]').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(640);
  }
  await shot(page, 'desktop-card', card);

  // Zoom opens the thread's viewer and does not pick.
  await tiles.nth(0).locator('[data-question-zoom]').click();
  await expect(page.locator('.ib-view')).toBeVisible();
  await shot(page, 'desktop-zoom');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.goto(`${world.url}#thread=${threadId}`);
  await expect(card.locator('input:checked')).toHaveCount(0);

  // The picture picks.
  await tiles.nth(1).locator('img[data-question-picture]').click();
  await expect(tiles.nth(1).locator('input')).toBeChecked();
  await expect(pane.locator('[data-foot-status] [data-draft-foot]')).toContainText('1 pick');
  await shot(page, 'desktop-picked', card);

  const waiting = claude.waitForReply(threadId, 40);
  await pane.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  const answer = await waiting;
  const body = String((answer.reply as { body: string }).body);
  expect(body).toContain('Answer: B · Total pinned with Pay (your recommendation)');
  expect(body).not.toContain('![');
  const questions = answer.questions as { answer: { selected: string[] } }[];
  expect(questions[0]!.answer.selected).toEqual(['B · Total pinned with Pay']);
  expect(world.errors).toEqual([]);
});

test('iPhone (WebKit): two tiles across, a tap picks, Send, the agent gets the labels', async () => {
  const { claude, project } = world;
  const sent = await claude.send({ project_path: project, subject: 'Settings layouts', body: LAYOUTS }, { wakes: true });
  const threadId = sent.thread_id as string;
  const own = await webkit.launch({ args: [] });
  try {
    const context = await own.newContext({ ...devices['iPhone 15'], colorScheme: 'light' });
    const page = await context.newPage();
    await page.goto(`${world.url}#thread=${threadId}`);
    const card = page.locator('fieldset.question-block');
    await expect(card).toBeVisible();
    const tiles = card.locator('[data-question-tile]');
    await expect(tiles).toHaveCount(2);
    const [a, b] = await Promise.all([tiles.nth(0).boundingBox(), tiles.nth(1).boundingBox()]);
    expect(Math.abs(a!.y - b!.y)).toBeLessThanOrEqual(1);
    for (const i of [0, 1]) {
      await expect.poll(() => tiles.nth(i).locator('img[data-question-picture]').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(640);
    }
    // The zoom button keeps a 44 px target.
    const zoom = await tiles.nth(0).locator('[data-question-zoom]').evaluate((el) => {
      const r = el.getBoundingClientRect();
      const before = getComputedStyle(el, '::before');
      return { w: r.width - parseFloat(before.left) - parseFloat(before.right), h: r.height - parseFloat(before.top) - parseFloat(before.bottom) };
    });
    expect(zoom.w).toBeGreaterThanOrEqual(44);
    expect(zoom.h).toBeGreaterThanOrEqual(44);
    await card.scrollIntoViewIfNeeded();
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(proofDir, `phone-card-${scheme}.png`) });
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await tiles.nth(0).locator('img[data-question-picture]').tap();
    await tiles.nth(1).locator('[data-question-part="choice"]').tap();
    await expect(tiles.nth(0).locator('input')).toBeChecked();
    await expect(tiles.nth(1).locator('input')).toBeChecked();
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(proofDir, `phone-picked-${scheme}.png`) });
    }
    const waiting = claude.waitForReply(threadId, 40);
    await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).tap();
    const answer = await waiting;
    const questions = answer.questions as { answer: { selected: string[] } }[];
    expect(questions[0]!.answer.selected).toEqual(['Tabs', 'Sidebar']);
    expect(String((answer.reply as { body: string }).body)).not.toContain('![');
    await context.close();
  } finally {
    await own.close();
  }
});

/** A body naming images the Inbox refuses: a hidden folder of the home folder, and a file that is not there. */
function refusedBody(root: string): string {
  const hidden = (name: string) => join(root, '.secret', name);
  return [
    'The screenshots are in my scratch folder.',
    '',
    `![Hidden screenshot](${hidden('shot.png')})`,
    '',
    `![Missing screenshot](${join(root, 'gone', 'missing.png')})`,
    '',
    `<p><img src="${hidden('raw.png')}" alt="Raw HTML screenshot"></p>`,
    '',
    ':::question',
    'Which drawer should ship?',
    `Shows: ![Both drawers](${hidden('both.png')})`,
    '',
    `- [ ] A · Total on top — ![Drawer A](${hidden('a.png')})`,
    `- [ ] B · Total pinned — ![Drawer B](${join(root, 'gone', 'b.png')})`,
    ':::',
  ].join('\n');
}

/** The message body the refused images are in. */
const bodyOf = (messageId: string) => `section.ib-pane .ib-body[data-message-id="${messageId}"]`;

/** Waits until every image the message drew has loaded or failed, and the window has drawn what follows. */
async function settled(page: Page, messageId: string): Promise<void> {
  await expect.poll(() => page.locator(bodyOf(messageId)).locator('img').evaluateAll((imgs) => imgs.every((img) => (img as HTMLImageElement).complete))).toBe(true);
  await page.waitForTimeout(400);
}

/** What a refused body must look like: no broken <img>, the alt text in chips, text rows on the card. */
async function expectQuiet(page: Page, messageId: string): Promise<void> {
  const body = page.locator(bodyOf(messageId));
  const broken = await body.locator('img').evaluateAll((imgs) => imgs.filter((img) => img.getClientRects().length > 0 && (img as HTMLImageElement).naturalWidth === 0).map((img) => (img as HTMLImageElement).alt || img.getAttribute('src')));
  expect(broken).toEqual([]);
  for (const text of ['Hidden screenshot', 'Missing screenshot', 'Raw HTML screenshot']) await expect(body.locator('[data-image-unavailable]', { hasText: text })).toBeVisible();
  const card = body.locator('fieldset.question-block');
  await expect(card.locator('[data-question-shows]')).toContainText('Both drawers');
  await expect(card.locator('[data-question-tile]')).toHaveCount(0);
  await expect(card.locator('label[data-question-option]')).toHaveCount(2);
}

test('refused images show as their alt text, never a broken image; the card falls back to text rows (desktop and iPhone)', async () => {
  const { page, claude, project, root } = world;
  const sent = await claude.send({ project_path: project, subject: 'Scratch screenshots', thread: 'scratch-screenshots', body: refusedBody(root) }, { wakes: true });
  const threadId = sent.thread_id as string;
  const messageId = (sent.message as { id?: string } | undefined)?.id ?? (sent.message_id as string);
  // The route really refuses them.
  const port = registry().port;
  const hiddenAnswer = await fetch(`http://127.0.0.1:${port}/api/inbox/messages/${messageId}/image?path=${encodeURIComponent(join(root, '.secret', 'shot.png'))}`);
  expect(hiddenAnswer.status).toBe(403);
  expect(((await hiddenAnswer.json()) as { code: string }).code).toBe('image_hidden');
  const goneAnswer = await fetch(`http://127.0.0.1:${port}/api/inbox/messages/${messageId}/image?path=${encodeURIComponent(join(root, 'gone', 'missing.png'))}`);
  expect(goneAnswer.status).toBe(404);

  await page.goto(`${world.url}#thread=${threadId}`);
  await expect(page.locator(bodyOf(messageId)).locator('fieldset.question-block')).toBeVisible();
  await settled(page, messageId);
  await shot(page, 'refused-desktop', page.locator(bodyOf(messageId)));
  await expectQuiet(page, messageId);
  expect(world.errors).toEqual([]);

  const own = await webkit.launch({ args: [] });
  try {
    const context = await own.newContext({ ...devices['iPhone 15'], colorScheme: 'light' });
    const phone = await context.newPage();
    await phone.goto(`${world.url}#thread=${threadId}`);
    await expect(phone.locator(bodyOf(messageId)).locator('fieldset.question-block')).toBeVisible();
    await settled(phone, messageId);
    for (const scheme of ['light', 'dark'] as const) {
      await phone.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await phone.waitForTimeout(300);
      await phone.screenshot({ path: join(proofDir, `refused-phone-${scheme}.png`), fullPage: true });
    }
    await expectQuiet(phone, messageId);
    await context.close();
  } finally {
    await own.close();
  }
});
