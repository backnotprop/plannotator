/**
 * Add a file already in the Inbox to the message being written, proved in a
 * real browser against the compiled binary (approval "reuse-attachments"). Two
 * sandboxed Inboxes, linked as machines; agents are SimAgent over each one's
 * own `inbox mcp`, never a real agent.
 *
 * Proves: the button on a tile, a big preview and a picture in the text moves
 * nothing when it shows; one click adds, the place in the thread and the focus
 * stay, the check shows wherever those bytes show, and a second click or the
 * tile's × undoes it; Tab reaches it and Enter adds; a draft keeps it; Send
 * writes no bytes, and the fake agent reads the same bytes at a read-only path
 * of its own; the version on screen is the one fixed; deleting the original
 * touches nothing; a phone adds from the viewer's toolbar and only a download
 * tile, which opens no viewer, has the button rest on it; full screen's card
 * shows the file under Reply; a linked machine's thread offers none of it. The
 * next thread: New message over an open thread offers that thread's files, sends
 * to an agent in another project with no word of the first; an archived thread's
 * button opens New message with the file. A picture copied from this Inbox pastes
 * as that file, and anything else as a plain paste.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, parseInboxBridgeCommands, type InboxReplyCommand } from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { fakeTailscale } from './fake-tailscale';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const CLOSED = 'http://127.0.0.1:9';

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 10_000 });

interface Machine {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
}

function machine(name: string): Machine {
  const root = inboxScratch(`plannotator-reuse-${name.toLowerCase()}-`);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  fakeTailscale(bin);
  const dataDir = join(root, 'data');
  // A PATH of the stand-in and the system's git, never an agent; PLANNOTATOR_TEST_SANDBOX: no agent lookups at all.
  const env = {
    HOME: root,
    PATH: `${bin}:/usr/bin:/bin`,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_TEST_SANDBOX: root,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_MACHINE_NAME: name,
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_RELAY_URL: CLOSED,
    PLANNOTATOR_UPDATE_API_URL: `${CLOSED}/releases/latest`,
  };
  return { root, dataDir, env, url: '' };
}

const cli = (m: Machine, ...args: string[]) => spawnSync(binary, ['inbox', ...args], { env: m.env, cwd: m.root, encoding: 'utf8', timeout: 60_000 });
const base = (m: Machine) => `http://127.0.0.1:${(JSON.parse(readFileSync(join(m.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number }).port}`;

/** A real PNG of one colour, large enough to be a picture. */
function png(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer) => {
    let c = 0xffffffff;
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const blobsOf = (m: Machine) => readdirSync(join(m.dataDir, 'inbox', 'blobs')).filter((n) => /^[0-9a-f]{64}$/.test(n)).sort();

/** A live session, as a connection plays one: it polls, and what it is woken with lands in `commands`. */
class LiveSession {
  readonly commands: InboxReplyCommand[] = [];
  private stopped = false;
  private readonly loop: Promise<void>;
  constructor(private readonly m: Machine, readonly session: string, readonly host: string, private readonly projectPath: string) {
    this.loop = this.run();
  }
  private bridge(path: string, body: Record<string, unknown>) {
    const { port, token } = JSON.parse(readFileSync(join(this.m.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
    return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ session: this.session, host: this.host, ...body }) });
  }
  private async run() {
    while (!this.stopped) {
      const response = await this.bridge(INBOX_BRIDGE_POLL_PATH, { waitMs: 500, project_path: this.projectPath, started_at: Date.now() - 60_000, busy: false, idle_since: Date.now() - 1000 });
      for (const command of parseInboxBridgeCommands(await response.text())) {
        if (this.commands.some((known) => known.id === command.id)) continue;
        this.commands.push(command);
        await this.bridge(INBOX_BRIDGE_EVENT_PATH, { type: 'delivered', id: command.id });
      }
    }
  }
  async stop() {
    this.stopped = true;
    await this.loop;
  }
}

let billingSession: LiveSession;
let studio: Machine;
let macbook: Machine;
let harbor: string;
let agent: SimAgent;
let macbookAgent: SimAgent;
let macbookThread: string;
let page: Page;
const errors: string[] = [];
let threadCount = 0;

const REF_A = 'ref-a.png';
const REF_B = 'ref-b.png';
const SHEET = 'brand-sheet.pdf';

function art(name: string, bytes: Buffer | string): string {
  const dir = join(harbor, 'art');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), bytes);
  return join(dir, name);
}

/** A new thread of the agent's, so each test starts with an empty reply box. */
async function threadWithFiles(extra: { body?: string; attachments?: string[] } = {}): Promise<{ thread_id: string; id: string }> {
  threadCount += 1;
  const sent = await agent.send({
    project_path: harbor,
    thread: `Thread ${threadCount}`,
    body: extra.body ?? 'Three directions for the hero.',
    attachments: extra.attachments ?? [join(harbor, 'art', REF_A), join(harbor, 'art', REF_B), join(harbor, 'art', SHEET)],
  });
  return sent as { thread_id: string; id: string };
}

async function open(p: Page, threadId: string, url = studio.url): Promise<void> {
  await p.goto(`${url}/#thread=${threadId}`);
  await p.locator('section.ib-pane').first().waitFor();
  await p.locator('[data-attachment-name], img[data-inline-image]').first().waitFor();
  const band = p.getByRole('region', { name: 'Desktop notifications' }).getByRole('button', { name: 'Hide' });
  if (await band.isVisible().catch(() => false)) await band.click();
  await expect(p.getByText('Tell your agents')).toHaveCount(0);
}

const preview = (p: Page, name: string) => p.locator(`[data-gallery-image][data-attachment-name="${name}"]`).first();
const tile = (p: Page, name: string) => p.locator(`.ib-attachments:not(.ib-hatts-tiles) .ib-att-t[data-attachment-name="${name}"]`).first();
const button = (p: Page, surface: string, name: string) => p.locator(`[data-reuse-surface="${surface}"][data-reuse][aria-label*="${name}"]`).first();
const replyTiles = (p: Page) => p.locator('[data-reply-files] [data-compose-file]');
const sendReply = (p: Page) => p.locator('section.ib-pane .ib-rbox [data-reply-send]').click();
/**
 * The thread's draft on the Inbox holds the box's file. A computer saves without a word (approval "inbox-reply-box",
 * T6: no "Saved" under the box), so the draft itself is read.
 */
const draftSaved = (threadId: string, url = studio.url) =>
  expect
    .poll(async () => ((await (await fetch(`${url}/api/inbox/threads/${threadId}/draft`)).json()) as { draft: { files?: unknown[] } | null }).draft?.files?.length ?? 0, { timeout: 10_000 })
    .toBeGreaterThan(0);

/** Where every element of the pane's attachments and text is. */
const boxes = (p: Page) =>
  p.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll('section.ib-pane .ib-body, section.ib-pane .ib-body *, section.ib-pane .ib-attachments, section.ib-pane .ib-attachments *')) {
      if (el.closest('[data-reuse], .ib-reuse-layer')) continue;
      const box = el.getBoundingClientRect();
      out.push(`${el.tagName}.${el.getAttribute('class') ?? ''}:${box.x},${box.y},${box.width},${box.height}`);
    }
    return out;
  });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  studio = machine('Studio');
  macbook = machine('MacBook');
  for (const m of [studio, macbook]) {
    const started = cli(m, '--background');
    rememberInboxOf(m.dataDir);
    expect(started.status, started.stderr).toBe(0);
    m.url = started.stdout.trim().replace(/\/+$/, '');
    expect(m.url).not.toContain(':59812');
  }
  harbor = scratchProject(join(studio.root, 'src'), 'harbor-web');
  art(REF_A, png(800, 400, [40, 60, 120]));
  art(REF_B, png(600, 800, [120, 60, 40]));
  art(SHEET, '%PDF-1.4\n1 0 obj <</Type/Catalog>> endobj\ntrailer <</Root 1 0 R>>\n%%EOF\n');
  art('inline-a.png', png(500, 260, [20, 120, 80]));
  agent = await SimAgent.connect({ binary, env: studio.env, name: 'Claude Code', host: 'claude-code', cwd: studio.root });

  const offered = cli(macbook, 'link', '--offer');
  expect(offered.status, offered.stderr).toBe(0);
  const linked = cli(studio, 'link', offered.stdout.trim(), '--address', base(macbook), '--back', base(studio));
  expect(linked.status, linked.stderr).toBe(0);
  const macbookProject = scratchProject(join(macbook.root, 'src'), 'macbook-svc');
  mkdirSync(join(macbookProject, 'art'), { recursive: true });
  writeFileSync(join(macbookProject, 'art', 'away.png'), png(800, 400, [90, 90, 20]));
  writeFileSync(join(macbookProject, 'art', 'inline-away.png'), png(500, 260, [90, 20, 90]));
  macbookAgent = await SimAgent.connect({ binary, env: macbook.env, name: 'Claude Code', host: 'claude-code', cwd: macbook.root });
  macbookThread = ((await macbookAgent.send({ project_path: macbookProject, thread: 'On the other machine', body: 'From over there.\n\n![Away](art/inline-away.png)', attachments: [join(macbookProject, 'art', 'away.png')] })) as { thread_id: string }).thread_id;

  billingSession = new LiveSession(studio, 'ses-billing', 'pi', scratchProject(join(studio.root, 'src'), 'billing-svc'));
  const context = await (browser as Browser).newContext({ viewport: { width: 1440, height: 900 }, permissions: browser.browserType().name() === 'chromium' ? ['notifications'] : [] });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterAll(async () => {
  await page?.context().close();
  await billingSession?.stop();
  await agent?.close();
  await macbookAgent?.close();
  await removeInboxScratch();
  expect(errors).toEqual([]);
});

test('the button shows on hover and moves nothing, on a tile, a big preview and a picture in the text', async () => {
  const { thread_id } = await threadWithFiles({ body: 'Here it is.\n\n![Inline](art/inline-a.png)\n\nAnd the rest of the words.' });
  await open(page, thread_id);
  /** Scrolled to it and at rest, then hovered: every box is where it was. */
  const hoverMovesNothing = async (target: ReturnType<Page['locator']>) => {
    await target.scrollIntoViewIfNeeded();
    await page.mouse.move(2, 2);
    await page.waitForTimeout(250);
    const rest = await boxes(page);
    await target.hover();
    await page.waitForTimeout(250);
    expect(await boxes(page)).toEqual(rest);
  };

  await page.mouse.move(2, 2);
  await expect(button(page, 'gallery', REF_A)).toHaveCSS('opacity', '0');
  await expect(button(page, 'tile', REF_A)).toHaveCSS('opacity', '0');
  await hoverMovesNothing(tile(page, REF_A));
  await expect(button(page, 'tile', REF_A)).toHaveCSS('opacity', '1');
  await hoverMovesNothing(preview(page, REF_A));
  await expect(button(page, 'gallery', REF_A)).toHaveCSS('opacity', '1');

  const inline = page.locator('section.ib-pane img[data-inline-image]').first();
  await hoverMovesNothing(inline);
  const onPicture = page.locator('[data-reuse-surface="inline"]').first();
  await expect(onPicture.locator('xpath=ancestor::*[contains(@class,"ib-reuse-spot")]')).toHaveCSS('opacity', '1');
  const picture = (await inline.boundingBox())!;
  const spot = (await onPicture.boundingBox())!;
  expect(spot.x + spot.width).toBeLessThanOrEqual(picture.x + picture.width);
  expect(spot.y).toBeGreaterThanOrEqual(picture.y);
  // Each opens what it did: the frame and the tile still open the file.
  await preview(page, REF_A).click();
  await expect(page.locator('[data-reuse-surface="pane"]').first()).toBeVisible();
});

test('one click adds, the place and the focus stay, the check shows everywhere; a second click or the × undoes it', async () => {
  const { thread_id } = await threadWithFiles();
  await open(page, thread_id);
  const pane = page.locator('section.ib-pane').first();
  await preview(page, REF_B).hover();
  const top = await page.evaluate(() => document.querySelector('section.ib-pane .ib-scroll, section.ib-pane [data-thread-scroll]')?.scrollTop ?? 0);
  await button(page, 'gallery', REF_B).click();
  await expect(replyTiles(page)).toHaveCount(1);
  await expect(page.locator('[data-reply-files] [data-compose-file="done"]')).toHaveCount(1);
  await expect(page.locator(`[data-compose-file-name="${REF_B}"]`)).toBeVisible();
  // Focus did not jump to the box, so the next file is one more click (Safari focuses no button on a click at all).
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA');
  expect(await page.evaluate(() => document.querySelector('section.ib-pane .ib-scroll, section.ib-pane [data-thread-scroll]')?.scrollTop ?? 0)).toBe(top);
  // Both of this file's buttons turn; another file's does not.
  await expect(pane.locator(`[data-reuse-state="added"][aria-label*="${REF_B}"]`)).toHaveCount(2);
  await expect(pane.locator(`[data-reuse-state="added"][aria-label*="${REF_A}"]`)).toHaveCount(0);
  await expect(button(page, 'tile', REF_B)).toHaveAttribute('aria-pressed', 'true');
  await expect(button(page, 'tile', REF_B)).toHaveCSS('opacity', '1');

  // The second click: from the tile, a different surface for the same bytes.
  await tile(page, REF_B).hover();
  await button(page, 'tile', REF_B).click();
  await expect(replyTiles(page)).toHaveCount(0);
  await expect(pane.locator('[data-reuse-state="added"]')).toHaveCount(0);

  // The tile's ×.
  await preview(page, REF_A).hover();
  await button(page, 'gallery', REF_A).click();
  await expect(replyTiles(page)).toHaveCount(1);
  await page.locator('[data-reply-files] [data-compose-file]').first().getByRole('button').last().click();
  await expect(replyTiles(page)).toHaveCount(0);
  await expect(pane.locator('[data-reuse-state="added"]')).toHaveCount(0);
});

test('the keyboard: Tab from a tile reaches the button, Enter adds; no new shortcut', async () => {
  const { thread_id } = await threadWithFiles();
  await open(page, thread_id);
  await tile(page, REF_A).focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(`Add ${REF_A} to your reply`);
  await expect(button(page, 'tile', REF_A)).toHaveCSS('opacity', '1');
  await page.keyboard.press('Enter');
  await expect(replyTiles(page)).toHaveCount(1);
  await expect(button(page, 'tile', REF_A)).toHaveAttribute('data-reuse-state', 'added');
});

test('a draft keeps it through a reload, with its check', async () => {
  const { thread_id } = await threadWithFiles();
  await open(page, thread_id);
  await tile(page, REF_A).hover();
  await button(page, 'tile', REF_A).click();
  await expect(page.locator('[data-reply-files] [data-compose-file="done"]')).toHaveCount(1);
  await draftSaved(thread_id);
  await page.reload();
  await expect(replyTiles(page)).toHaveCount(1, { timeout: 10_000 });
  await expect(button(page, 'tile', REF_A)).toHaveAttribute('data-reuse-state', 'added');
});

test('Send writes no bytes; the agent reads the same bytes at a read-only path of its own, with no word of the original', async () => {
  const { thread_id } = await threadWithFiles({ body: 'With a picture.\n\n![Inline](art/inline-a.png)' });
  await open(page, thread_id);
  const before = blobsOf(studio);
  await tile(page, REF_A).scrollIntoViewIfNeeded();
  await tile(page, REF_A).hover();
  await button(page, 'tile', REF_A).click();
  await tile(page, SHEET).hover();
  await button(page, 'tile', SHEET).click();
  const inline = page.locator('section.ib-pane img[data-inline-image]').first();
  await inline.scrollIntoViewIfNeeded();
  await inline.hover();
  await page.locator('[data-reuse-surface="inline"]').first().click();
  await expect(page.locator('[data-reply-files] [data-compose-file="done"]')).toHaveCount(3);
  expect(blobsOf(studio)).toEqual(before);

  await sendReply(page);
  const reply = await agent.nextReply(thread_id);
  expect(blobsOf(studio)).toEqual(before);
  const files = reply.attachments as { name: string; kind: string; size: number; path: string }[];
  expect(files.map((f) => f.name).sort()).toEqual(['brand-sheet.pdf', 'inline-a.png', 'ref-a.png']);
  const inThread = await agent.readThread(thread_id);
  const original = (inThread.messages as { author: { kind: string }; attachments?: { id?: string; path: string }[] }[]).find((m) => m.author.kind === 'agent')!;
  const sources = original.attachments!.map((a) => a.path);
  for (const file of files) {
    expect(sha(readFileSync(file.path))).toBe(sha(readFileSync(join(harbor, 'art', file.name))));
    expect(statSync(file.path).mode & 0o777).toBe(0o400);
    expect(file.path.startsWith(join(studio.dataDir, 'inbox', 'uploads'))).toBe(true);
    expect(sources).not.toContain(file.path);
    for (const source of sources) expect(JSON.stringify(file)).not.toContain(source);
  }
  await expect(replyTiles(page)).toHaveCount(0);
  // An ordinary message, whose files can be added again.
  await expect(page.locator(`[data-reuse-surface="tile"][aria-label="Add ${REF_A} to your reply"]`)).toHaveCount(2);
});

test("an agent's changed file: the version on screen goes, and stays that version", async () => {
  const path = art('layout.png', png(400, 300, [200, 200, 200]));
  const v1 = sha(readFileSync(path));
  const { thread_id } = await threadWithFiles({ attachments: [path] });
  const v2Bytes = png(400, 300, [10, 80, 200]);
  writeFileSync(path, v2Bytes);
  await open(page, thread_id);
  await expect(tile(page, 'layout.png')).toContainText('Changed');
  const before = blobsOf(studio);
  await tile(page, 'layout.png').hover();
  await button(page, 'tile', 'layout.png').click();
  await expect(page.locator('[data-reply-files] [data-compose-file="done"]')).toHaveCount(1);
  expect(blobsOf(studio).filter((b) => !before.includes(b))).toEqual([sha(v2Bytes)]);
  await sendReply(page);
  const reply = await agent.nextReply(thread_id);
  const copy = (reply.attachments as { path: string }[])[0]!.path;
  expect(sha(readFileSync(copy))).toBe(sha(v2Bytes));
  writeFileSync(path, png(400, 300, [200, 10, 10]));
  expect(sha(readFileSync(copy))).toBe(sha(v2Bytes));
  expect(sha(readFileSync(copy))).not.toBe(v1);
});

test('deleting the original touches nothing of the new message', async () => {
  const name = 'to-delete.png';
  const bytes = png(420, 300, [70, 70, 200]);
  const path = art(name, bytes);
  const { thread_id: original } = await threadWithFiles({ attachments: [path] });
  const session = (JSON.parse(readFileSync(join(studio.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { serverSession: string }).serverSession;
  const post = (route: string, body: Record<string, unknown>) => fetch(`${studio.url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: session, ...body }) });
  // The reply goes to a second thread, added while the first is open: the draft's tile is what the window holds.
  await open(page, original);
  await tile(page, name).hover();
  await button(page, 'tile', name).click();
  await expect(page.locator('[data-reply-files] [data-compose-file="done"]')).toHaveCount(1);
  await sendReply(page);
  const copy = ((await agent.nextReply(original)).attachments as { path: string }[])[0]!.path;
  // Another thread reuses the same bytes through the route the window calls; then the original's thread goes.
  const sourceId = (await (await fetch(`${studio.url}/api/inbox/threads/${original}`)).json() as { thread: { messages: { attachments?: { id: string }[] }[] } }).thread.messages[0]!.attachments![0]!.id;
  const held = (await (await post('/api/inbox/uploads/reuse', { attachment_id: sourceId, version: 'sent' })).json()) as { upload: { upload_id: string; sha256: string } };
  expect((await post(`/api/inbox/threads/${original}/delete`, {})).status).toBe(200);
  // That thread's own file went; the blob stays, held by the pending upload, and the draft-to-be still has its bytes.
  expect(() => statSync(copy)).toThrow();
  expect(blobsOf(studio)).toContain(sha(bytes));
  expect(held.upload.sha256).toBe(sha(bytes));
});

test('full screen: the toolbar has the button, and the card shows the file under Reply', async () => {
  const { thread_id } = await threadWithFiles();
  await open(page, thread_id);
  await preview(page, REF_A).click();
  await page.locator('[data-full-screen-toggle]').first().click();
  const bar = page.locator('[data-reuse-surface="bar"]').first();
  await expect(bar).toBeVisible();
  await bar.click();
  await expect(bar).toHaveAttribute('data-reuse-state', 'added');
  await expect(page.locator('[data-fcomp-mode-on="reply"]')).toBeVisible();
  await expect(page.locator(`[data-fcomp-mode-on="reply"] [data-compose-file-name="${REF_A}"]`)).toBeVisible();
});

test('a phone: nothing new on a file that opens; the viewer holds a 44 px button; the file shows at once and stays in the reply', async ({ browser, browserName }) => {
  test.skip(browserName === 'firefox', 'Firefox has no mobile emulation');
  const { thread_id } = await threadWithFiles();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const phone = await context.newPage();
  try {
    await open(phone, thread_id);
    await expect(phone.locator('section.ib-pane [data-reuse-surface="gallery"]:visible, section.ib-pane [data-reuse-surface="inline"]:visible')).toHaveCount(0);
    // Only the file that opens no viewer: the same tiles, drawn in the foot and the header's band.
    const resting = phone.locator('section.ib-pane [data-reuse-surface="tile"]:visible');
    await expect(resting.first()).toHaveAttribute('aria-label', `Add ${SHEET} to your reply`);
    for (const label of await resting.evaluateAll((all) => all.map((el) => el.getAttribute('aria-label')))) expect(label).toBe(`Add ${SHEET} to your reply`);
    await preview(phone, REF_A).tap();
    const bar = phone.locator('[data-reuse-surface="bar"]').first();
    await expect(bar).toBeVisible();
    const box = (await bar.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    await bar.tap();
    await expect(bar).toHaveAttribute('data-reuse-state', 'added');
    await expect(phone.locator(`[data-fcomp-mode-on="reply"] [data-compose-file-name="${REF_A}"]`)).toBeVisible();
    await phone.locator('[data-full-view-exit]').first().tap();
    await expect(replyTiles(phone)).toHaveCount(1);
    await expect(phone.locator('section.ib-pane [data-reuse-surface="gallery"][data-reuse-state="added"]:visible')).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test("a phone's HTML page opens clear: the pill keeps its room; the button comes with the card", async ({ browser, browserName }) => {
  test.skip(browserName === 'firefox', 'Firefox has no mobile emulation');
  const page_ = 'page.html';
  const { thread_id } = await threadWithFiles({ attachments: [art(page_, '<!doctype html><title>Page</title><h1>A page</h1>')] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const phone = await context.newPage();
  try {
    await open(phone, thread_id);
    await phone.getByRole('button', { name: `Open ${page_}` }).tap();
    const pill = phone.locator('[data-fcomp-pill]');
    await expect(pill).toBeVisible();
    const bar = phone.locator('[data-reuse-surface="bar"]').first();
    // Not drawn, not merely hidden: every button in the bar stays a 44 px target (inbox-phone-stepping.spec.ts).
    await expect(phone.locator('[data-reuse-surface="bar"]')).toHaveCount(0);
    const pillBox = (await pill.boundingBox())!;
    const toolbar = (await phone.locator('[data-full-view-bar]').boundingBox())!;
    expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(toolbar.x);
    await pill.tap();
    await expect(bar).toBeVisible();
    await bar.tap();
    await expect(phone.locator(`[data-fcomp-mode-on="reply"] [data-compose-file-name="${page_}"]`)).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a phone's tiles keep their place: Open sits at the tile's edge, a size is whole; the check takes room only once it rests there", async ({ browser, browserName }) => {
  test.skip(browserName === 'firefox', 'Firefox has no mobile emulation');
  const { thread_id } = await threadWithFiles();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const phone = await context.newPage();
  const cue = (name: string) => tile(phone, name).locator('.ib-open');
  /** How far the tile's word sits from its right edge. Today's tile, before reuse: 20 px, at any width. */
  const gap = async (name: string) => {
    const box = (await tile(phone, name).boundingBox())!;
    const word = (await cue(name).boundingBox())!;
    return box.x + box.width - (word.x + word.width);
  };
  try {
    await open(phone, thread_id);
    await tile(phone, REF_A).scrollIntoViewIfNeeded();
    expect(await gap(REF_A)).toBeLessThanOrEqual(24);
    for (const name of [REF_A, SHEET]) {
      const detail = tile(phone, name).locator('.ib-kd');
      expect(await detail.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await preview(phone, REF_A).tap();
    const bar = phone.locator('[data-reuse-surface="bar"]').first();
    await bar.tap();
    await expect(bar).toHaveAttribute('data-reuse-state', 'added');
    await phone.locator('[data-full-view-exit]').first().tap();
    const check = phone.locator(`section.ib-pane [data-reuse-surface="tile"][aria-label^="${REF_A} is in your reply"]`).first();
    await check.scrollIntoViewIfNeeded();
    await expect(check).toBeVisible();
    const checkBox = (await check.boundingBox())!;
    const word = (await cue(REF_A).boundingBox())!;
    expect(word.x + word.width).toBeLessThanOrEqual(checkBox.x);
  } finally {
    await context.close();
  }
});

test("a phone, a thread with only a PDF: its tile holds a 44 px button clear of Download; a tap adds with no download, and the tile still downloads", async ({ browser, browserName }) => {
  test.skip(browserName === 'firefox', 'Firefox has no mobile emulation');
  const { thread_id } = await threadWithFiles({ body: 'Only the sheet.', attachments: [join(harbor, 'art', SHEET)] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
  const phone = await context.newPage();
  const downloads: string[] = [];
  phone.on('download', (download) => downloads.push(download.suggestedFilename()));
  try {
    await open(phone, thread_id);
    await tile(phone, SHEET).scrollIntoViewIfNeeded();
    const add = phone.locator(`section.ib-pane .ib-attachments:not(.ib-hatts-tiles) [data-reuse-surface="tile"][aria-label="Add ${SHEET} to your reply"]`);
    await expect(add).toBeVisible();
    await expect(add).toHaveCSS('opacity', '1');
    const box = (await add.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    const tileBox = (await tile(phone, SHEET).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(tileBox.x + tileBox.width);
    const word = (await tile(phone, SHEET).locator('.ib-open').boundingBox())!;
    expect(word.x + word.width).toBeLessThanOrEqual(box.x);
    await add.tap();
    await expect(phone.locator(`[data-reply-files] [data-compose-file="done"][data-compose-file-name="${SHEET}"]`)).toBeVisible();
    const added = phone.locator(`section.ib-pane .ib-attachments:not(.ib-hatts-tiles) [data-reuse-surface="tile"][aria-label^="${SHEET} is in your reply"]`);
    await expect(added).toHaveAttribute('data-reuse-state', 'added');
    const check = (await added.boundingBox())!;
    expect(check.width).toBeGreaterThanOrEqual(44);
    const after = (await tile(phone, SHEET).locator('.ib-open').boundingBox())!;
    expect(after.x + after.width).toBeLessThanOrEqual(check.x);
    expect(downloads).toEqual([]);

    await added.tap();
    await expect(replyTiles(phone)).toHaveCount(0);
    await expect(add).toBeVisible();
    expect(downloads).toEqual([]);

    const download = phone.waitForEvent('download');
    await tile(phone, SHEET).locator('.ib-nm').tap();
    expect((await download).suggestedFilename()).toBe(SHEET);
  } finally {
    await context.close();
  }
});

for (const [width, height, more] of [[320, 700, false], [1366, 900, true]] as const) {
  test(`a touch screen at ${width}: a download tile's size is whole beside the 44 px button, a long one, a very long kind, a name that was tight`, async ({ browser, browserName }) => {
    test.skip(browserName === 'firefox', 'Firefox has no mobile emulation');
    const big = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(Math.round(12.4 * 1024 * 1024) - 4, 0)]);
    const sheet = 'budget-2026-planning.xlsx';
    const long = 'report.averyveryverylongextensionforafile';
    const { thread_id } = await threadWithFiles({ body: 'The numbers.', attachments: [art(sheet, big), art(long, big), join(harbor, 'art', SHEET)] });
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const touch = await context.newPage();
    try {
      await open(touch, thread_id);
      for (const name of [sheet, long]) {
        const item = tile(touch, name);
        await item.scrollIntoViewIfNeeded();
        const size = item.locator('.ib-kd-n');
        await expect(size).toHaveText(', 12.4 MB');
        // The number is drawn whole: nothing clips it, and it ends before the word Download.
        const [line, number, word] = [(await item.locator('.ib-kd').boundingBox())!, (await size.boundingBox())!, (await item.locator('.ib-open').boundingBox())!];
        expect(number.x + number.width).toBeLessThanOrEqual(line.x + line.width + 0.5);
        expect(number.x + number.width).toBeLessThanOrEqual(word.x);
        expect(await size.evaluate((el) => el.scrollWidth <= el.getBoundingClientRect().width + 0.5)).toBe(true);
        const add = touch.locator(`section.ib-pane .ib-attachments:not(.ib-hatts-tiles) [data-reuse-surface="tile"][aria-label="Add ${name} to your reply"]`);
        const box = (await add.boundingBox())!;
        expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
        expect(word.x + word.width).toBeLessThanOrEqual(box.x);
        expect(await add.locator('xpath=..').evaluate((el) => el.classList.contains('ib-att-w-more'))).toBe(more);
      }
      // A kind no tile holds: its words give way and show that they did, and the comma stays with the number.
      const words = tile(touch, long).locator('.ib-kd-w');
      expect(await words.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      expect((await tile(touch, long).locator('.ib-kd').textContent())).toBe(`${long.split('.')[1]!.toUpperCase()} file, 12.4 MB`);
      // The tight names: the long one keeps a start before its end, and at 320 the short one is whole, extension and all.
      const start = tile(touch, sheet).locator('.ib-fname-h');
      expect(await start.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(width === 320 ? 20 : 14);
      if (width === 320) {
        const short = tile(touch, SHEET).locator('.ib-fname-h');
        expect(await short.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
    } finally {
      await context.close();
    }
  });
}

test("a phone reaches a file that downloads through the viewer's steps: the button is on its card's toolbar", async ({ browser, browserName }) => {
  test.skip(browserName === 'firefox', 'Firefox has no mobile emulation');
  const { thread_id } = await threadWithFiles();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const phone = await context.newPage();
  try {
    await open(phone, thread_id);
    await preview(phone, REF_A).tap();
    await phone.locator('[data-full-view-position].ib-fvpill').tap();
    await phone.getByRole('gridcell', { name: new RegExp(SHEET.replace('.', '\\.')) }).first().tap();
    await expect(phone.locator('[data-download-card]')).toBeVisible();
    const bar = phone.locator(`[data-reuse-surface="bar"][aria-label="Add ${SHEET} to your reply"]`).first();
    await expect(bar).toBeVisible();
    await bar.tap();
    await expect(phone.locator('[data-reuse-surface="bar"]').first()).toHaveAttribute('data-reuse-state', 'added');
    await phone.locator('[data-full-view-exit]').first().tap();
    await expect(phone.locator(`[data-reply-files] [data-compose-file="done"][data-compose-file-name="${SHEET}"]`)).toBeVisible();
  } finally {
    await context.close();
  }
});

for (const width of [1440, 390]) {
  test(`New message at ${width}: a tile's size is whole, a long one or a large one; a kind too long gives way first`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const compose = await context.newPage();
    const kb = 1024;
    const jpeg = (bytes: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(bytes - 4, 0x20)]);
    const file = (name: string, buffer: Buffer, mimeType: string) => ({ name, mimeType, buffer });
    try {
      await compose.goto(studio.url);
      const band = compose.getByRole('region', { name: 'Desktop notifications' }).getByRole('button', { name: 'Hide' });
      if (await band.isVisible().catch(() => false)) await band.click();
      await compose.locator(`${width < 768 ? '.ib-lhead' : '.ib-side'} [data-open-compose]`).first().click();
      const dialog = compose.locator('dialog[data-compose]');
      await dialog.locator('[data-compose-attach]').setInputFiles([
        file('hero-direction-long-name.jpg', jpeg(329 * kb), 'image/jpeg'),
        file('hero-direction-large.jpg', jpeg(Math.round(12.4 * kb * kb)), 'image/jpeg'),
        file('report.averyveryverylongextensionforafile', Buffer.alloc(Math.round(12.4 * kb * kb), 0x1), 'application/octet-stream'),
      ]);
      const done = dialog.locator('[data-compose-file="done"]');
      await expect(done).toHaveCount(3, { timeout: 30_000 });
      const line = (name: string) => dialog.locator(`[data-compose-file-name="${name}"] .ib-kd-split`);
      await expect(line('hero-direction-long-name.jpg')).toHaveText('JPEG image, 329.0 KB');
      await expect(line('hero-direction-large.jpg')).toHaveText('JPEG image, 12.4 MB');
      // Neither the kind nor the size is cut, and each tile holds a line of this length with room to spare.
      for (const name of ['hero-direction-long-name.jpg', 'hero-direction-large.jpg']) {
        const words = line(name).locator('.ib-kd-w');
        expect(await words.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(await line(name).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      // A kind no tile can hold: the words give way, and the number stays whole and clear of the ×.
      const long = 'report.averyveryverylongextensionforafile';
      const words = line(long).locator('.ib-kd-w');
      expect(await words.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      const size = line(long).locator('.ib-kd-n');
      await expect(size).toHaveText(', 12.4 MB');
      const sizeBox = (await size.boundingBox())!;
      const x = (await dialog.locator(`[data-compose-file-name="${long}"] .ib-cp-fx`).boundingBox())!;
      expect(sizeBox.x + sizeBox.width).toBeLessThanOrEqual(x.x);
      expect(sizeBox.width).toBeGreaterThanOrEqual(await size.evaluate((el) => el.scrollWidth));
    } finally {
      await context.close();
    }
  });
}

test('a refused add shows no check; the button tries again in its place', async () => {
  const { thread_id } = await threadWithFiles();
  await open(page, thread_id);
  await page.route('**/api/inbox/uploads/reuse', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'upload_not_found', error: 'That file is no longer in the Inbox.' }) }));
  await tile(page, REF_A).hover();
  await button(page, 'tile', REF_A).click();
  await expect(page.locator('[data-reply-files] [data-compose-file="refused"]')).toContainText('no longer in the Inbox');
  const add = page.locator(`[data-reuse="${await tile(page, REF_A).getAttribute('data-attachment-id')}"]`);
  for (const one of await add.all()) {
    await expect(one).toHaveAttribute('data-reuse-state', 'idle');
    await expect(one).toHaveAttribute('aria-pressed', 'false');
    await expect(one).toHaveAttribute('aria-label', `Add ${REF_A} to your reply`);
  }
  await page.unroute('**/api/inbox/uploads/reuse');
  await tile(page, REF_A).hover();
  await button(page, 'tile', REF_A).click();
  await expect(page.locator('[data-reply-files] [data-compose-file="done"]')).toHaveCount(1);
  await expect(page.locator('[data-reply-files] [data-compose-file="refused"]')).toHaveCount(0);
  await expect(add.first()).toHaveAttribute('data-reuse-state', 'added');
});

test('a tab that read the thread before the agent changed the file adds what it showed', async () => {
  const path = art('stale.png', png(400, 300, [200, 200, 200]));
  const v1 = sha(readFileSync(path));
  const { thread_id } = await threadWithFiles({ attachments: [path] });
  await open(page, thread_id);
  await tile(page, 'stale.png').scrollIntoViewIfNeeded();
  await expect(tile(page, 'stale.png')).not.toContainText('Changed');
  // This tab misses every later read of the thread's files: what it shows now is what it keeps showing.
  const reads = /\/api\/inbox\/threads\/[^/]+\/attachments/;
  await page.route(reads, (route) => route.abort());
  writeFileSync(path, png(400, 300, [10, 80, 200]));
  await tile(page, 'stale.png').hover();
  await button(page, 'tile', 'stale.png').click();
  await expect(page.locator('[data-reply-files] [data-compose-file="done"]')).toHaveCount(1);
  await page.unroute(reads);
  await sendReply(page);
  const reply = await agent.nextReply(thread_id);
  expect(sha(readFileSync((reply.attachments as { path: string }[])[0]!.path))).toBe(v1);
});

test('the viewer adds the version on screen: the version it sent stays the version it sent', async () => {
  const path = art('versions.png', png(400, 300, [200, 200, 200]));
  const v1 = sha(readFileSync(path));
  const { thread_id } = await threadWithFiles({ attachments: [path] });
  writeFileSync(path, png(400, 300, [10, 80, 200]));
  await open(page, thread_id);
  await tile(page, 'versions.png').scrollIntoViewIfNeeded();
  await tile(page, 'versions.png').click();
  const pane = page.locator('[data-attachment-pane]').first();
  await expect(pane).toHaveAttribute('data-version', 'current');
  await pane.getByRole('button', { name: 'Open the version it sent' }).click();
  await expect(pane).toHaveAttribute('data-version', 'sent');
  const before = blobsOf(studio);
  await pane.locator('[data-reuse-surface="pane"], [data-reuse-surface="bar"]').first().click();
  await expect(page.locator('[data-reply-files] [data-compose-file="done"]').first()).toBeAttached();
  expect(blobsOf(studio)).toEqual(before);
  await page.locator('[data-full-view-close]').first().click();
  await sendReply(page);
  const reply = await agent.nextReply(thread_id);
  expect(sha(readFileSync((reply.attachments as { path: string }[])[0]!.path))).toBe(v1);
});

test('a reload keeps the check: the restored tile is known by its bytes, and the button still takes it out', async () => {
  const { thread_id } = await threadWithFiles();
  await open(page, thread_id);
  await tile(page, REF_A).hover();
  await button(page, 'tile', REF_A).click();
  await expect(page.locator('[data-reply-files] [data-compose-file="done"]')).toHaveCount(1);
  // The draft has saved it.
  await draftSaved(thread_id);
  await page.reload();
  await expect(page.locator('[data-reply-files] [data-compose-file="done"]')).toHaveCount(1);
  await tile(page, REF_A).hover();
  const held = page.locator(`[data-reuse-surface="tile"][aria-label^="${REF_A} is in your reply"]`).first();
  await expect(held).toHaveAttribute('aria-pressed', 'true');
  await held.click();
  await expect(replyTiles(page)).toHaveCount(0);
});

/**
 * A big changed file. Once the add has read it the Inbox caches its hash, so only an Inbox started since lists it by
 * its stat again: `listedByStat` draws that listing for this tab, the stat name the Inbox itself answered before the read.
 */
async function bigChanged(name: string, tint: [number, number, number]) {
  const path = art(name, png(400, 300, [200, 200, 200]));
  const { thread_id } = await threadWithFiles({ attachments: [path] });
  writeFileSync(path, Buffer.concat([png(400, 300, tint), Buffer.alloc(9 * 1024 * 1024)]));
  const listed = (await (await fetch(`${studio.url}/api/inbox/threads/${thread_id}/attachments`)).text());
  const stat = /stat:\d+:[\d.]+/.exec(listed)![0];
  const hash = sha(readFileSync(path));
  return {
    thread_id,
    listedByStat: () =>
      page.route(/\/api\/inbox\/threads\/[^/]+\/attachments/, async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replaceAll(`"sha256":"${hash}"`, `"sha256":"${stat}"`) });
      }),
    notListedByStat: () => page.unroute(/\/api\/inbox\/threads\/[^/]+\/attachments/),
  };
}

test('a big changed file, listed by its stat after a reload: the check stays, and the button takes it out', async () => {
  const name = 'big-after-reload.png';
  const big = await bigChanged(name, [10, 80, 200]);
  await big.listedByStat();
  await open(page, big.thread_id);
  await tile(page, name).hover();
  await button(page, 'tile', name).click();
  await expect(page.locator('[data-reply-files] [data-compose-file="done"]')).toHaveCount(1);
  await draftSaved(big.thread_id);
  await page.reload();
  await expect(page.locator('[data-reply-files] [data-compose-file="done"]')).toHaveCount(1);
  await tile(page, name).hover();
  const held = page.locator(`[data-reuse-surface="tile"][aria-label^="${name} is in your reply"]`).first();
  await expect(held).toHaveAttribute('aria-pressed', 'true');
  await held.click();
  await expect(replyTiles(page)).toHaveCount(0);
  await big.notListedByStat();
});

test('the draft already holds those bytes under another name: one tile, and the button knows it', async () => {
  const name = 'big-held.png';
  const big = await bigChanged(name, [90, 10, 200]);
  await open(page, big.thread_id);
  // A tile that knows only the bytes, as one pasted has.
  const reuse = '**/api/inbox/uploads/reuse';
  await page.route(reuse, async (route) => {
    const { sha256: _shown, ...body } = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue({ postData: JSON.stringify(body) });
  });
  await tile(page, name).hover();
  await button(page, 'tile', name).click();
  await expect(page.locator('[data-reply-files] [data-compose-file="done"]')).toHaveCount(1);
  await page.unroute(reuse);
  await draftSaved(big.thread_id);
  await big.listedByStat();
  await page.reload();
  await expect(page.locator('[data-reply-files] [data-compose-file="done"]')).toHaveCount(1);
  await tile(page, name).hover();
  const add = page.locator(`[data-reuse-surface="tile"][aria-label="Add ${name} to your reply"]`).first();
  const asked = page.waitForResponse(reuse);
  await add.click();
  await asked;
  await expect(page.locator(`[data-reuse-surface="tile"][aria-label^="${name} is in your reply"]`).first()).toHaveAttribute('aria-pressed', 'true');
  await expect(replyTiles(page)).toHaveCount(1);
  await big.notListedByStat();
});

test('a very small picture in the text has no button; a big one has', async () => {
  art('tiny.png', png(40, 40, [120, 20, 20]));
  const { thread_id } = await threadWithFiles({ body: 'Small and big.\n\n![Tiny](art/tiny.png)\n\n![Big](art/inline-a.png)', attachments: [] });
  await page.goto(`${studio.url}/#thread=${thread_id}`);
  await expect(page.locator('section.ib-pane img[data-inline-image]')).toHaveCount(2);
  await expect(page.locator('section.ib-pane [data-reuse-surface="inline"]')).toHaveCount(1);
  await expect(page.locator('section.ib-pane [data-reuse-surface="inline"]')).toHaveAttribute('aria-label', 'Add inline-a.png to your reply');
});

test('an Artifacts card has the button: it adds to the reply and stays on the view', async () => {
  const { thread_id } = await threadWithFiles();
  await open(page, thread_id);
  await page.locator('[data-artifacts-button]').click();
  const view = page.locator('[data-artifacts-view]');
  await expect(view).toBeVisible();
  const card = view.locator(`[data-reuse-surface="card"][aria-label="Add ${SHEET} to your reply"]`);
  await card.locator('xpath=..').hover();
  await card.click();
  await expect(view).toBeVisible();
  await expect(view.locator(`[data-reuse-surface="card"][aria-label^="${SHEET} is in your reply"]`)).toBeVisible();
  await page.locator('[data-artifacts-button]').click();
  await expect(page.locator(`[data-reply-files] [data-compose-file="done"][data-compose-file-name="${SHEET}"]`)).toBeVisible();
});

test('the reply box closed with its draft: adding those bytes again opens the box with one tile, not two', async () => {
  const { thread_id } = await threadWithFiles();
  await open(page, thread_id);
  await tile(page, REF_A).hover();
  await button(page, 'tile', REF_A).click();
  await expect(page.locator('[data-reply-files] [data-compose-file="done"]')).toHaveCount(1);
  await page.locator('section.ib-pane .ib-rbox [data-reply-close]').click();
  await expect(replyTiles(page)).toHaveCount(0);
  await tile(page, REF_A).hover();
  await button(page, 'tile', REF_A).click();
  await expect(page.locator('[data-reply-files] [data-compose-file="done"]')).toHaveCount(1);
  await expect(replyTiles(page)).toHaveCount(1);
});

test("a linked machine's thread offers no button, on any surface", async () => {
  await open(page, macbookThread);
  await expect(page.getByText('away.png').first()).toBeVisible();
  await preview(page, 'away.png').hover();
  await expect(page.locator('[data-reuse]')).toHaveCount(0);
  await preview(page, 'away.png').click();
  await expect(page.locator('[data-attachment-pane], [data-full-view-bar]').first()).toBeVisible();
  await expect(page.locator('[data-reuse]')).toHaveCount(0);
});

const composeDialog = (p: Page) => p.locator('dialog[data-compose]');
/**
 * Leaves New message with files in it, keeping nothing: Escape closes it and keeps a draft (approval
 * "inbox-compose-escape-keeps"), so the toast's Reopen and the draft's Delete draft throw it away.
 */
const discardCompose = async (p: Page) => {
  await p.keyboard.press('Escape');
  await expect(composeDialog(p)).toHaveCount(0);
  await p.locator('[data-inbox-toast] [data-toast-action]', { hasText: 'Reopen' }).click();
  await expect(composeDialog(p)).toBeVisible();
  await composeDialog(p).locator('[data-compose-delete]').click();
  await expect(composeDialog(p)).toHaveCount(0);
};
const openNewMessage = async (p: Page) => {
  await p.getByRole('button', { name: /New message/ }).first().click();
  await expect(composeDialog(p)).toBeVisible();
};
const post = (route: string, body: Record<string, unknown>) => {
  const { serverSession } = JSON.parse(readFileSync(join(studio.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { serverSession: string };
  return fetch(`${studio.url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession, ...body }) });
};

/** A paste as a browser's Copy image writes it: `html` beside a re-encoded PNG. The native menu cannot be driven headless. */
const paste = (p: Page, selector: string, html: string | null, name = 'image.png') =>
  p.evaluate(
    async ({ selector, html, name }) => {
      const canvas = document.createElement('canvas');
      canvas.width = 40;
      canvas.height = 40;
      canvas.getContext('2d')!.fillRect(0, 0, 20, 20);
      const png = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), 'image/png'));
      const data = new DataTransfer();
      if (html !== null) data.setData('text/html', html.replaceAll('ORIGIN', location.origin));
      data.items.add(new File([png], name, { type: 'image/png' }));
      const field = document.querySelector(selector) as HTMLTextAreaElement;
      field.focus();
      // Firefox's constructor ignores `clipboardData`, so the data is set on the event itself.
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: data });
      field.dispatchEvent(event);
    },
    { selector, html, name },
  );
const REPLY_FIELD = 'section.ib-pane textarea';
const openReply = async (p: Page) => {
  await p.locator('section.ib-pane .ib-pfoot').getByRole('button', { name: 'Reply' }).click();
  await p.locator(REPLY_FIELD).first().waitFor();
};
const idOf = async (threadId: string, name: string) =>
  ((await (await fetch(`${studio.url}/api/inbox/threads/${threadId}`)).json()) as { thread: { messages: { attachments?: { id: string; name: string }[] }[] } }).thread.messages.flatMap((m) => m.attachments ?? []).find((a) => a.name === name)!.id;

test("New message with a file: the next thread's agent gets the same bytes and no word of the first", async () => {
  const { thread_id } = await threadWithFiles();
  expect((await post(`/api/inbox/messages/${thread_id}/resolve`, { resolved: true })).status).toBe(200);
  await open(page, thread_id);
  const before = blobsOf(studio);
  await tile(page, REF_B).hover();
  await button(page, 'tile', REF_B).click();
  await expect(composeDialog(page).locator(`[data-compose-file="done"][data-compose-file-name="${REF_B}"]`)).toBeVisible();

  await composeDialog(page).locator('textarea').first().fill('Use this for the invoice header.');
  await composeDialog(page).locator('.ib-cp-tobtn').click();
  await composeDialog(page).locator('[data-compose-session="ses-billing"]').click();
  await composeDialog(page).locator('[data-compose-send]').click();
  await expect(composeDialog(page)).toHaveCount(0);
  await expect.poll(() => billingSession.commands.length, { timeout: 15_000 }).toBeGreaterThan(0);
  const wake = billingSession.commands.at(-1)!.body!;
  expect(blobsOf(studio)).toEqual(before);
  const attached = [...wake.matchAll(/Attached: (\S+) \((.+)\)/g)].map((m) => [m[1]!, m[2]!] as const);
  expect(attached.map(([name]) => name)).toEqual([REF_B]);
  for (const [name, path] of attached) {
    // A fake agent, a process of its own and on a Mac inside a sandbox that can write nothing: it reads the path it was
    // given and its own copy is read-only.
    const script = `const fs = require('fs'); const b = fs.readFileSync(process.argv[1]); let wrote = true; try { fs.writeFileSync(process.argv[1], 'x'); } catch { wrote = false; } process.stdout.write(require('crypto').createHash('sha256').update(b).digest('hex') + ' ' + wrote);`;
    const node = [process.execPath, '-e', script, path];
    const run = process.platform === 'darwin' ? spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny file-write*)', ...node], { encoding: 'utf8' }) : spawnSync(node[0]!, node.slice(1), { encoding: 'utf8' });
    expect(run.stdout.trim()).toBe(`${sha(readFileSync(join(harbor, 'art', name)))} false`);
    expect(statSync(path).mode & 0o777).toBe(0o400);
  }
  expect(wake).not.toContain('harbor-web');
  expect(wake).not.toContain(thread_id);
});

test("an archived thread's button opens New message with the file, To empty", async () => {
  const { thread_id } = await threadWithFiles();
  expect((await post(`/api/inbox/messages/${thread_id}/resolve`, { resolved: true })).status).toBe(200);
  await open(page, thread_id);
  await tile(page, REF_B).hover();
  const add = button(page, 'tile', REF_B);
  await expect(add).toHaveAttribute('aria-label', `New message with ${REF_B}`);
  await add.click();
  await expect(composeDialog(page)).toBeVisible();
  await expect(composeDialog(page).locator(`[data-compose-file="done"][data-compose-file-name="${REF_B}"]`)).toBeVisible();
  await expect(composeDialog(page).locator('.ib-cp-tobtn')).toHaveAttribute('data-compose-to', 'choose');
  // The archived thread itself did not change.
  await expect(replyTiles(page)).toHaveCount(0);
  await discardCompose(page);
});

test('paste: a picture copied from this Inbox is that file, its name and no new bytes; pasted again, one tile', async () => {
  const { thread_id } = await threadWithFiles();
  await open(page, thread_id);
  await openReply(page);
  const id = await idOf(thread_id, REF_A);
  const before = blobsOf(studio);
  const html = `<meta charset="utf-8"><img src="ORIGIN/api/inbox/attachments/${id}/image" alt="">`;
  await paste(page, REPLY_FIELD, html);
  await expect(page.locator(`[data-reply-files] [data-compose-file="done"][data-compose-file-name="${REF_A}"]`)).toBeVisible();
  expect(blobsOf(studio)).toEqual(before);
  await expect(button(page, 'tile', REF_A)).toHaveAttribute('data-reuse-state', 'added');
  await paste(page, REPLY_FIELD, html);
  await page.waitForTimeout(400);
  await expect(replyTiles(page)).toHaveCount(1);
});

test('paste into New message: the same file under its own name, no new bytes', async () => {
  const { thread_id } = await threadWithFiles();
  await open(page, thread_id);
  const id = await idOf(thread_id, REF_B);
  const before = blobsOf(studio);
  await openNewMessage(page);
  await paste(page, 'dialog[data-compose] textarea', `<meta charset="utf-8"><img src="ORIGIN/api/inbox/attachments/${id}/image" alt="">`);
  await expect(composeDialog(page).locator(`[data-compose-file="done"][data-compose-file-name="${REF_B}"]`)).toBeVisible();
  expect(blobsOf(studio)).toEqual(before);
  await discardCompose(page);
});

test('paste falls back to a plain paste: no <img>, words around it, or a file that is gone', async () => {
  const { thread_id } = await threadWithFiles();
  await open(page, thread_id);
  await openReply(page);
  const id = await idOf(thread_id, REF_A);
  await paste(page, REPLY_FIELD, null);
  await expect(page.locator('[data-reply-files] [data-compose-file="done"]')).toHaveCount(1);
  await page.locator('[data-reply-files] [data-compose-file]').first().getByRole('button').last().click();
  await expect(replyTiles(page)).toHaveCount(0);
  const gone = `<img src="ORIGIN/api/inbox/attachments/att_00000000000000000000000000/image">`;
  await paste(page, REPLY_FIELD, gone);
  await expect(page.locator('[data-reply-files] [data-compose-file="done"]')).toHaveCount(1);
  await expect(page.locator('[data-reply-files] [data-compose-file]')).not.toHaveAttribute('data-compose-file-name', REF_A);
  await page.locator('[data-reply-files] [data-compose-file]').first().getByRole('button').last().click();
  await expect(replyTiles(page)).toHaveCount(0);
  await paste(page, REPLY_FIELD, `<p>See <img src="ORIGIN/api/inbox/attachments/${id}/image"> here</p>`);
  await expect(page.locator('[data-reply-files] [data-compose-file="done"]')).toHaveCount(1);
  await expect(page.locator(`[data-reply-files] [data-compose-file-name="${REF_A}"]`)).toHaveCount(0);
});

test("a linked machine's thread: a paste there is a plain paste", async () => {
  const seen: string[] = [];
  const watch = (request: { url: () => string }) => {
    if (request.url().includes('/uploads/reuse')) seen.push(request.url());
  };
  page.on('request', watch);
  // A local thread's file, so a paste there would have something to point at.
  const { thread_id } = await threadWithFiles();
  await open(page, thread_id);
  await page.goto(`${studio.url}/#thread=${macbookThread}`);
  await expect(page.locator('[data-attachment-name="away.png"]').first()).toBeVisible();
  await openReply(page);
  await paste(page, REPLY_FIELD, `<img src="ORIGIN/api/inbox/attachments/${await idOf(thread_id, REF_A)}/image">`);
  await expect(page.locator('[data-reply-files] [data-compose-file]')).toHaveCount(1);
  await expect(page.locator(`[data-reply-files] [data-compose-file-name="${REF_A}"]`)).toHaveCount(0);
  page.off('request', watch);
  expect(seen).toEqual([]);
});
