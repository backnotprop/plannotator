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

    expect(m.openedDrawn, 'the unread thread opened on more than its newest 20').toBe(21);
    expect(m.openedOpen, 'the unread thread opened more than its newest 20').toBe(20);
    expect(m.messages).toBe(MESSAGES);
    expect(m.open).toBe(MESSAGES);
    expect(m.loaded, 'a picture in the thread did not load').toBe(m.images);
    expect(m.widestInline, 'a screenshot in a message loaded wider than 1600 px').toBeLessThanOrEqual(MESSAGE_IMAGE_WIDTH);
    expect(m.widestGallery, 'a gallery picture loaded wider than 800 px').toBeLessThanOrEqual(GALLERY_IMAGE_WIDTH);
    expect(m.widestTile, 'a tile thumbnail loaded wider than 128 px').toBeLessThanOrEqual(TILE_IMAGE_WIDTH);
    expect(m.decodedMB, 'the loaded pictures take too much memory decoded').toBeLessThanOrEqual(DECODED_BUDGET_MB);
    expect(m.heapMB, 'the JS heap with the heavy thread open').toBeLessThanOrEqual(HEAP_BUDGET_MB);
    expect(m.listeners, 'event listeners with the heavy thread open').toBeLessThanOrEqual(LISTENER_BUDGET);
    expect(m.nodes, 'DOM nodes with the heavy thread open').toBeLessThanOrEqual(NODE_BUDGET);
    const live = MESSAGES + ARRIVALS;
    expect(m.messageCopies, 'the snapshot no longer shows one thread-name string per message record').toBeGreaterThanOrEqual(live);
    expect(m.messageCopies, 'a copy of the thread is kept per read').toBeLessThanOrEqual(MESSAGE_COPIES_PER_MESSAGE * live);
    expect(m.renderCopies, 'the first message drew no time label').toBeGreaterThan(0);
    expect(m.renderCopies, 'a render of the thread view is kept per read').toBeLessThanOrEqual(RENDER_COPIES_PER_MESSAGE * live);
    expect(m.arrivalsAfterMB - m.arrivalsBeforeMB, `the heap grew too much while ${ARRIVALS} messages came in`).toBeLessThanOrEqual(ARRIVALS_BUDGET_MB);
    expect(m.reclosedHeapMB - m.closedHeapMB, 'the heap grew with each open of the thread').toBeLessThanOrEqual(LEAK_BUDGET_MB);
  } finally {
    await agent?.close();
    await page?.close();
    await removeInboxScratch(root);
  }
});
