/**
 * The Recommended tag's pill stays on the tag. With the Soft card switch on, a choice's
 * Recommended tag is a 999px pill; the rule used to match every `.rounded` inside the
 * choice, so an image in the choice's text became an oval and inline code a pill. Proved
 * in a real browser against the compiled binary: an agent asks two questions through
 * `plannotator inbox mcp` (a picture choice whose text holds a second image and inline
 * code, and a plain choice with inline code), and the image and the code keep ui's 4px
 * radius while each Recommended tag keeps its pill.
 *
 * Screenshots land in PLANNOTATOR_CHOICE_PILL_SHOTS (default .local/proof/choice-pill/).
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(process.env.PLANNOTATOR_CHOICE_PILL_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'choice-pill'));

/** A real PNG of `w` x `h` px in one colour. */
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
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
  const rows = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const BODY = [
  'Two questions.',
  '',
  ':::question',
  'Which drawer should ship?',
  '',
  '- [ ] A · Total on top — ![Drawer A](shots/a.png) closest to today',
  '- [ ] B · Total pinned — ![Drawer B](shots/b.png) see ![Detail](shots/detail.png) and `pinTotal()`',
  '',
  'Recommended: B · Total pinned',
  ':::',
  '',
  ':::question',
  'How should CI install packages?',
  '',
  '- [ ] Use `npm ci`',
  '- [ ] Use `npm install`',
  '',
  'Recommended: Use `npm ci`',
  ':::',
].join('\n');

let page: Page;
let context: BrowserContext;
let claude: SimAgent;
let url: string;
let project: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-choice-pill-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  url = started.stdout.trim();
  project = scratchProject(join(root, 'src'), 'shop');
  mkdirSync(join(project, 'shots'), { recursive: true });
  writeFileSync(join(project, 'shots', 'a.png'), png(320, 240, [37, 99, 235]));
  writeFileSync(join(project, 'shots', 'b.png'), png(320, 240, [22, 163, 74]));
  writeFileSync(join(project, 'shots', 'detail.png'), png(160, 60, [217, 119, 6]));
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  page = await context.newPage();
  claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const port = (JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number }).port;
  await fetch(`http://127.0.0.1:${port}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });
});

test.afterAll(async () => {
  try {
    await claude?.close().catch(() => {});
    await context?.close();
  } finally {
    await removeInboxScratch();
  }
});

const radius = (el: Element) => getComputedStyle(el).borderTopLeftRadius;

test('an image and inline code in a choice keep 4px; the Recommended tag keeps its pill', async () => {
  const sent = await claude.send({ project_path: project, subject: 'Choice radii', body: BODY }, { wakes: true });
  await page.goto(`${url}#thread=${sent.thread_id as string}`);
  const cards = page.locator('section.ib-pane fieldset.question-block');
  await expect(cards).toHaveCount(2);

  const tile = cards.nth(0).locator('[data-question-tile]').nth(1);
  const detail = tile.locator('[data-question-part="choice"] img[alt="Detail"]');
  await expect.poll(() => detail.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(160);
  await cards.nth(0).scrollIntoViewIfNeeded();
  await cards.nth(0).screenshot({ path: join(proofDir, 'picture-choice.png') });
  await cards.nth(1).screenshot({ path: join(proofDir, 'plain-choice.png') });

  expect(await detail.evaluate(radius)).toBe('4px');
  expect(await tile.locator('[data-question-part="choice"] code').evaluate(radius)).toBe('4px');
  expect(await cards.nth(1).locator('[data-question-part="choice"] code').first().evaluate(radius)).toBe('4px');

  // Both Recommended tags: the pill (Soft card on) and the tag's letter spacing, as before.
  for (const tag of [tile.locator('[data-question-tag="rec"]'), cards.nth(1).locator('[data-question-part="choice"] [data-question-tag="rec"]')]) {
    await expect(tag).toHaveText('Recommended');
    expect(await tag.evaluate(radius)).toBe('999px');
  }
  // The eyebrow's Open tag keeps its own rule's pill, unchanged.
  const open = cards.nth(1).locator('[data-question-tag="open"]');
  await expect(open).toHaveText('Open');
  expect(await open.evaluate(radius)).toBe('999px');
});
