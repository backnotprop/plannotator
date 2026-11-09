/**
 * A heavy thread stays within its memory budget (#2948). An Inbox tab crashed
 * ("Aw, Snap") on a thread of 245 messages with 89 full-size screenshots:
 * every screenshot was decoded at its full size (a 2880 × 1800 PNG is 20 MB
 * decoded, wherever it is drawn and however small), and every open message
 * mounted its tooltips and menus whether or not anyone pointed at them.
 *
 * The world (tests/e2e/heavy-thread-world.ts): one agent sends 120 messages in
 * one thread, every fourth with a 2880 × 1800 screenshot inline, the last
 * one with six of them attached (the gallery and the tiles). The thread is
 * unread; it opens on its newest 20 (approval "inbox-thread-fold-unread":
 * its first message a line, the rest behind the fold), and then Expand all
 * opens every message. The window scrolls through it
 * and back (every picture loads), and is measured over raw CDP (raw-cdp.ts:
 * no Network domain, the heap after two forced collections). Then 30 more
 * messages come in while it stays open (a window left open for days on a
 * busy thread), and it is closed, opened and closed twice more.
 *
 * It fails when:
 *  - a picture loads wider than its place draws it: 1600 px in a message,
 *    800 in the gallery, 128 in a tile (MESSAGE_IMAGE_WIDTH,
 *    GALLERY_IMAGE_WIDTH and TILE_IMAGE_WIDTH in packages/inbox/images.ts);
 *  - the loaded pictures take more than DECODED_BUDGET_MB decoded;
 *  - the JS heap with the thread open is over HEAP_BUDGET_MB, or the event
 *    listeners or DOM nodes over theirs (each open message mounting its
 *    tooltips and menus whether or not anyone points at them);
 *  - while ARRIVALS more messages come into the open thread, a copy of the
 *    thread is kept per read (the message records alive, counted in a heap
 *    snapshot, over MESSAGE_COPIES_PER_MESSAGE per message), or a render of
 *    the thread view is kept per read (the first message's time label over
 *    RENDER_COPIES_PER_MESSAGE per message), or the heap grows more than
 *    ARRIVALS_BUDGET_MB (a coarse catch-all: the counts are the exact guards);
 *  - closing the thread a third time leaves more than LEAK_BUDGET_MB more
 *    heap than closing it the first time (the thread view leaks per open).
 *
 * The budgets come from runs of this world (2026-11-08, Apple M-series,
 * macOS, Playwright's Chromium), measured with the same steps by hand
 * (`measureHeavyThread`). The heap is read after full collections, so it
 * moves by a MB or two between runs (which messages near the view have their
 * tooltips mounted); the widths, sizes and counts do not move.
 *
 * |                         | main (97ae3a2) | first #2948 commit | this budget's change |  budget |
 * | ----------------------- | -------------: | -----------------: | -------------------: | ------: |
 * | widest inline px        |          2,880 |              1,600 |                1,600 |   1,600 |
 * | decoded pictures        |       830.6 MB |           192.5 MB |             192.5 MB |  240 MB |
 * | JS heap, open           |        60.6 MB |            62.4 MB |      29.4 to 31.3 MB |   45 MB |
 * | event listeners         |          6,738 |              6,738 |                4,907 |   5,900 |
 * | DOM nodes               |          6,260 |              6,260 |                6,260 |   8,000 |
 * | message records alive   |          3,168 |              3,162 |                  163 |     300 |
 * | time labels alive       |          1,646 |              1,646 |                  373 |     750 |
 * | heap, 30 arrivals       |       +13.7 MB |           +12.0 MB |      +1.7 to +5.5 MB |   10 MB |
 * | closed 3rd − 1st        |         0.1 MB |             0.1 MB |               0.1 MB |    3 MB |
 *
 * A change that makes the window legitimately hold more: measure again
 * (`measureHeavyThread` on the new binary) and update the table and the
 * budget with it, never just raise a budget until the spec passes.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-heavy-thread-budget`.
 * Another binary: PLANNOTATOR_E2E_BINARY. The measure lands in
 * .local/proof/heavy-thread/measure.json.
 */

import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { scratchProject, SimAgent } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { ARRIVALS, arriveInHeavyThread, MESSAGES, measureHeavyThread, seedHeavyThread } from './heavy-thread-world';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { launchRawChromium, type RawPage } from './raw-cdp';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'heavy-thread');

/** The widest each place may load a picture: what it draws at most (packages/inbox/images.ts). */
const MESSAGE_IMAGE_WIDTH = 1600;
const GALLERY_IMAGE_WIDTH = 800;
const TILE_IMAGE_WIDTH = 128;
const DECODED_BUDGET_MB = 240;
const HEAP_BUDGET_MB = 45;
const LISTENER_BUDGET = 5_900;
const NODE_BUDGET = 8_000;
const MESSAGE_COPIES_PER_MESSAGE = 2;
const RENDER_COPIES_PER_MESSAGE = 5;
const ARRIVALS_BUDGET_MB = 10;
const LEAK_BUDGET_MB = 3;

test.afterAll(async () => {
  await removeInboxScratch();
});

test('a thread of 120 open messages and 30 full-size screenshots stays within its memory budget while the agent works, and gives it back when closed', async () => {
  test.setTimeout(10 * 60_000);
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });

  const root = inboxScratch('plannotator-inbox-heavy-thread-e2e-');
  const dataDir = join(root, 'data');
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 120_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim().replace(/\/+$/, '');
  // A scratch data dir never takes the person's Inbox port.
  expect(url).not.toContain(':59812');

  let page: RawPage | undefined;
  let agent: SimAgent | undefined;
  try {
    const project = scratchProject(join(root, 'src'), 'checkout-web');
    const threadId = await seedHeavyThread(binary, env, project);
    agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
    const working = agent;
    page = await launchRawChromium();
    const m = await measureHeavyThread(page, url, threadId, (i) => arriveInHeavyThread(working, project, i));
    writeFileSync(join(proofDir, 'measure.json'), `${JSON.stringify(m, null, 2)}\n`);
    console.log(`heavy thread ${JSON.stringify(m)}`);

    // Opened unread, it drew its first message's line and its newest 20 open, not all 120.
    expect(m.openedDrawn, 'the unread thread opened on more than its newest 20').toBe(21);
    expect(m.openedOpen, 'the unread thread opened more than its newest 20').toBe(20);
    // The world is what it says: every message open (Expand all), every picture loaded.
    expect(m.messages).toBe(MESSAGES);
    expect(m.open).toBe(MESSAGES);
    expect(m.loaded, 'a picture in the thread did not load').toBe(m.images);
    // Each picture comes no wider than its place draws it.
    expect(m.widestInline, 'a screenshot in a message loaded wider than 1600 px').toBeLessThanOrEqual(MESSAGE_IMAGE_WIDTH);
    expect(m.widestGallery, 'a gallery picture loaded wider than 800 px').toBeLessThanOrEqual(GALLERY_IMAGE_WIDTH);
    expect(m.widestTile, 'a tile thumbnail loaded wider than 128 px').toBeLessThanOrEqual(TILE_IMAGE_WIDTH);
    expect(m.decodedMB, 'the loaded pictures take too much memory decoded').toBeLessThanOrEqual(DECODED_BUDGET_MB);
    // What the open thread holds.
    expect(m.heapMB, 'the JS heap with the heavy thread open').toBeLessThanOrEqual(HEAP_BUDGET_MB);
    expect(m.listeners, 'event listeners with the heavy thread open').toBeLessThanOrEqual(LISTENER_BUDGET);
    expect(m.nodes, 'DOM nodes with the heavy thread open').toBeLessThanOrEqual(NODE_BUDGET);
    // Left open while the agent works, it holds what the new messages need and no copy of the earlier reads.
    const live = MESSAGES + ARRIVALS;
    // Every message record carries the thread's name: fewer strings than records means the count no longer counts them.
    expect(m.messageCopies, 'the snapshot no longer shows one thread-name string per message record').toBeGreaterThanOrEqual(live);
    expect(m.messageCopies, 'a copy of the thread is kept per read').toBeLessThanOrEqual(MESSAGE_COPIES_PER_MESSAGE * live);
    expect(m.renderCopies, 'the first message drew no time label').toBeGreaterThan(0);
    expect(m.renderCopies, 'a render of the thread view is kept per read').toBeLessThanOrEqual(RENDER_COPIES_PER_MESSAGE * live);
    expect(m.arrivalsAfterMB - m.arrivalsBeforeMB, `the heap grew too much while ${ARRIVALS} messages came in`).toBeLessThanOrEqual(ARRIVALS_BUDGET_MB);
    // Closed, it gives the memory back: opening it again does not pile up.
    expect(m.reclosedHeapMB - m.closedHeapMB, 'the heap grew with each open of the thread').toBeLessThanOrEqual(LEAK_BUDGET_MB);
  } finally {
    await agent?.close();
    await page?.close();
    await removeInboxScratch(root);
  }
});
