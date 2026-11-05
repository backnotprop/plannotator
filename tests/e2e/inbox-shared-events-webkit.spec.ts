/**
 * The tabs' shared event stream (packages/inbox/sharedEvents.ts) in WebKit,
 * with real tabs in one browser context: Safari has Web Locks and
 * BroadcastChannel (15.4+), so the same leader and followers run there. The
 * cases that need Chromium's DevTools protocol (a renderer crash, the frozen
 * page) are proved in inbox-shared-events.spec.ts.
 *
 * Runs in the playwright config's `webkit` project.
 */

import { expect, test, type Browser } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeInboxScratch } from './inbox-scratch';
import {
  agent,
  closeWorld,
  expectEveryRecordOnce,
  forget,
  health,
  keepSending,
  leaders,
  logOf,
  newWorld,
  openTab,
  proofDir,
  setFront,
  streams,
  waitFor,
  type World,
} from './inbox-shared-events-world';

const results: Record<string, unknown> = {};
const worlds: World[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  mkdirSync(proofDir, { recursive: true });
});

test.afterAll(async () => {
  try {
    for (const world of worlds) await closeWorld(world);
  } finally {
    writeFileSync(join(proofDir, 'results-webkit.json'), `${JSON.stringify(results, null, 2)}\n`);
    await removeInboxScratch();
  }
});

async function world(browser: Browser, options: Parameters<typeof newWorld>[1] = {}): Promise<World> {
  const w = await newWorld(browser, options);
  worlds.push(w);
  const sim = await agent(w);
  await sim.send({ project_path: w.project, body: 'Starting on the billing work.' });
  return w;
}

async function sendSome(w: World, count: number): Promise<void> {
  for (let i = 0; i < count; i++) await w.agents[0]!.send({ project_path: w.project, body: `Update ${Date.now()}-${i}` });
}

test('WebKit has Web Locks and BroadcastChannel: 1, 3 and 8 tabs share one stream, every record once, a ninth tab loads at once', async ({ browser }) => {
  const w = await world(browser);
  const loads: number[] = [];
  const steps: Record<string, unknown>[] = [];
  for (const target of [1, 3, 8]) {
    while (w.pages.length < target) loads.push((await openTab(w)).ms);
    expect(await w.pages[0]!.evaluate(() => typeof navigator.locks?.request === 'function' && typeof BroadcastChannel === 'function')).toBe(true);
    await sendSome(w, 3);
    const checked = await expectEveryRecordOnce(w);
    await expect.poll(() => streams(w)).toBe(1);
    await expect.poll(async () => (await health(w)).notify_reach.windows).toBe(target);
    expect(await leaders(w.pages)).toHaveLength(1);
    steps.push({ tabs: target, streams: await streams(w), lines: checked.total });
  }
  const ninth = await openTab(w, { timeout: 8000 });
  expect(ninth.ms).toBeLessThan(3000);
  expect(await streams(w)).toBe(1);
  results.tabs = { loadsMs: loads, ninthMs: ninth.ms, steps };
});

test('WebKit: the leader closes while an agent writes; another tab leads within a second; nothing missed or twice', async ({ browser }) => {
  const w = await world(browser);
  for (let i = 0; i < 4; i++) await openTab(w);
  const [leader] = await leaders(w.pages);
  const sender = keepSending(w.agents[0]!, w.project, 40);
  await new Promise((done) => setTimeout(done, 600));
  const others = w.pages.filter((p) => p !== leader);
  const at = Date.now();
  await leader!.close();
  forget(w, leader!);
  const takeover = await waitFor(
    async () => {
      for (const page of others) {
        const lead = (await logOf(page)).find((e) => e.type === 'lead' && e.at >= at);
        if (lead) return lead.at - at;
      }
      return null;
    },
    (v) => v !== null,
    5000,
  );
  await new Promise((done) => setTimeout(done, 1500));
  await sender.stop();
  const checked = await expectEveryRecordOnce(w, w.pages, { exact: false });
  await expect.poll(() => streams(w)).toBe(1);
  expect(takeover.value!).toBeLessThan(1000);
  results.closeLeader = { takeoverMs: takeover.value, lines: checked.total, tabsExactlyEveryLine: `${checked.exactTabs}/${w.pages.length}` };
});

test('WebKit: the leader reloads while an agent writes; one stream; every tab gets every record once', async ({ browser }) => {
  const w = await world(browser);
  for (let i = 0; i < 3; i++) await openTab(w);
  const [leader] = await leaders(w.pages);
  const sender = keepSending(w.agents[0]!, w.project, 40);
  await new Promise((done) => setTimeout(done, 500));
  await leader!.reload();
  await expect(leader!.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
  await new Promise((done) => setTimeout(done, 1500));
  await sender.stop();
  const checked = await expectEveryRecordOnce(w, w.pages, { exact: false });
  await expect.poll(() => streams(w)).toBe(1);
  expect(await leaders(w.pages)).toHaveLength(1);
  results.reloadLeader = { lines: checked.total, tabsExactlyEveryLine: `${checked.exactTabs}/${w.pages.length}` };
});

test('WebKit: a long script in an attached page stalls the leader (no freeze); the follower in front takes over within seconds; the old leader follows when the script ends', async ({ browser }) => {
  const w = await world(browser);
  // An attached HTML page whose script holds the main thread for eight seconds (its frame shares the tab's thread).
  writeFileSync(
    join(w.project, 'busy-report.html'),
    '<!doctype html><title>Busy report</title><h1>Report</h1><script>const until = Date.now() + 8000; while (Date.now() < until) {}</script><p>Done.</p>\n',
  );
  const sent = (await w.agents[0]!.send({ project_path: w.project, body: 'The report is attached.', attachments: ['busy-report.html'] })) as { thread_id?: string; message_id?: string };
  const threadId = sent.thread_id ?? sent.message_id!;
  const listed = (await (await fetch(new URL(`/api/inbox/threads/${threadId}/attachments`, w.url))).json()) as { attachments: { id: string }[] };
  const attachment = listed.attachments[0]!.id;
  for (let i = 0; i < 3; i++) await openTab(w);
  const [leader] = await leaders(w.pages);
  const others = w.pages.filter((p) => p !== leader);
  const front = others[0]!;
  await setFront(front, true, true);
  const sender = keepSending(w.agents[0]!, w.project, 40);
  await new Promise((done) => setTimeout(done, 600));
  const at = Date.now();
  // The leader opens the page: the script starts, the leader stops answering.
  void leader!.evaluate(([thread, file]) => {
    location.hash = `thread=${thread}&file=${file}`;
  }, [threadId, attachment] as const);
  const streamSamples: number[] = [];
  const takeover = await waitFor(
    async () => {
      streamSamples.push(await streams(w));
      for (const page of others) {
        const lead = (await logOf(page)).find((e) => e.type === 'lead' && e.at >= at);
        if (lead) return lead.at - at;
      }
      return null;
    },
    (v) => v !== null,
    10_000,
  );
  while (Date.now() - at < 9000) {
    streamSamples.push(await streams(w));
    await new Promise((done) => setTimeout(done, 100));
  }
  await sender.stop();
  // The script ended: the old leader learns its lock was taken and follows.
  const rejoin = await waitFor(
    async () => (await logOf(leader!)).filter((e) => e.at >= at).map((e) => e.type),
    (types) => types.includes('stolen') && types.includes('step-down'),
    10_000,
  );
  await expect.poll(() => streams(w)).toBe(1);
  expect((await leaders(w.pages)).includes(leader!)).toBe(false);
  await sendSome(w, 3);
  const checked = await expectEveryRecordOnce(w, w.pages, { exact: false });
  const frontRecords = (await logOf(front)).filter((e) => e.type === 'record' && e.at >= at - 1000).map((e) => e.at);
  const frontLongestGapMs = Math.max(frontRecords[0]! - at, ...frontRecords.slice(1).map((t, i) => t - frontRecords[i]!));
  // The old leader learned it lost the lock only when the script let go (about eight seconds in): it was stopped all along.
  const stolenAtMs = (await logOf(leader!)).find((e) => e.type === 'stolen' && e.at >= at)!.at - at;
  expect(stolenAtMs).toBeGreaterThan(7000);
  // The check every 3 s, no answer in 2 s, and room for a busy CI runner (7.1 s and 7.3 s seen): still while the
  // eight-second script holds the old leader, which is what makes this a takeover.
  expect(takeover.value!).toBeLessThan(8000);
  expect(frontLongestGapMs).toBeLessThan(8500);
  expect(Math.max(...streamSamples)).toBeLessThanOrEqual(2);
  results.stallLeader = {
    takeoverMs: takeover.value,
    frontLongestGapMs,
    rejoinAfterScriptMs: rejoin.ms,
    oldLeaderLearnedAtMs: stolenAtMs,
    streamsPeak: Math.max(...streamSamples),
    lines: checked.total,
    tabsExactlyEveryLine: `${checked.exactTabs}/${w.pages.length}`,
  };
});

test('WebKit: notify_reach follows tabs opening and closing', async ({ browser }) => {
  const w = await world(browser);
  for (let i = 0; i < 3; i++) await openTab(w);
  await expect.poll(async () => (await health(w)).notify_reach.windows).toBe(3);
  const [leader] = await leaders(w.pages);
  const follower = w.pages.find((p) => p !== leader)!;
  await follower.close();
  forget(w, follower);
  const followerGone = await waitFor(async () => (await health(w)).notify_reach.windows, (n) => n === 2);
  await leader!.close();
  forget(w, leader!);
  const leaderGone = await waitFor(async () => (await health(w)).notify_reach.windows, (n) => n === 1);
  await expect.poll(() => streams(w)).toBe(1);
  results.reach = { followerClosedMs: followerGone.ms, leaderClosedMs: leaderGone.ms };
});

test('WebKit without Web Locks: each tab its own stream, as before', async ({ browser }) => {
  const w = await world(browser, { noLocks: true });
  for (let i = 0; i < 3; i++) await openTab(w);
  await expect.poll(() => streams(w)).toBe(3);
  expect((await logOf(w.pages[0]!)).length).toBe(0);
  results.noLocks = { streams: 3 };
});

test('WebKit: no page errors', () => {
  for (const w of worlds) expect(w.errors).toEqual([]);
});
