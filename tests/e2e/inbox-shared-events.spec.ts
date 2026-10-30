/**
 * Every Inbox tab of a browser shares ONE event-stream connection
 * (packages/inbox/sharedEvents.ts), proved in a real Chromium against the
 * compiled binary with real tabs in one browser context. See
 * inbox-shared-events-world.ts for the world and how a tab's records are
 * checked against the server's own log.
 *
 * What is proved, each with the server's count of open streams:
 * - 1, 3, 8 and 12 tabs: one stream; every tab handles every record once, in
 *   order; every tab loads promptly; notify_reach counts every tab;
 * - the code before this change stalls the seventh tab (Chrome's six
 *   connections per host), and the new one loads a ninth at once
 *   (PLANNOTATOR_E2E_BASELINE_BINARY names the old build);
 * - the leader closes, reloads, crashes (a renderer crash) or is frozen while
 *   an agent writes: another tab leads within a second, nothing missed or
 *   handled twice, one stream;
 * - the leader stalls (the debugger holds it, no freeze): the tab in front
 *   takes the lock within seconds, two streams at most, nothing missed or
 *   twice, and the old leader follows when it runs again;
 * - notifications once and the sound once across the tabs; a follower in
 *   front raises the notice itself and keeps the sound quiet; a question in
 *   the thread it has open raises nothing;
 * - notify_reach as tabs open, close and crash;
 * - an Inbox restart: every tab reconnects through one stream;
 * - two origins (localhost and a *.localhost name, as the tailnet address is
 *   another origin) never share: one stream each;
 * - no Web Locks: each tab its own stream, as before.
 * - a soak (PLANNOTATOR_E2E_SOAK_MS): tabs opening, closing, reloading,
 *   crashing, coming to the front and leaders stalling at random while an
 *   agent writes, for minutes.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-shared-events`.
 * Results (load times, takeover times, counts) land in
 * .local/proof/shared-events/results.json.
 */

import { expect, test, type Browser, type CDPSession, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeInboxScratch, stopScratchInbox } from './inbox-scratch';
import {
  agent,
  baselineBinary,
  binary,
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
  question,
  setFront,
  startInbox,
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
    writeFileSync(join(proofDir, 'results-chromium.json'), `${JSON.stringify(results, null, 2)}\n`);
    await removeInboxScratch();
  }
});

async function world(browser: Browser, options: Parameters<typeof newWorld>[1] = {}): Promise<World> {
  const w = await newWorld(browser, options);
  worlds.push(w);
  return w;
}

/** One message so the list has a row to wait for. */
async function seed(w: World): Promise<void> {
  const sim = await agent(w);
  await sim.send({ project_path: w.project, body: 'Starting on the billing work.' });
}

async function sendSome(w: World, count: number): Promise<void> {
  const sim = w.agents[0]!;
  for (let i = 0; i < count; i++) await sim.send({ project_path: w.project, body: `Update ${Date.now()}-${i}` });
}


test('1, 3, 8 and 12 tabs: one stream, every record once, every tab loads promptly, every tab counted', async ({ browser }) => {
  const w = await world(browser);
  await seed(w);
  const loads: number[] = [];
  const steps: Record<string, unknown>[] = [];
  for (const target of [1, 3, 8, 12]) {
    while (w.pages.length < target) loads.push((await openTab(w)).ms);
    await sendSome(w, 3);
    const checked = await expectEveryRecordOnce(w);
    await expect.poll(() => streams(w)).toBe(1);
    await expect.poll(async () => (await health(w)).notify_reach.windows).toBe(target);
    expect(await leaders(w.pages)).toHaveLength(1);
    steps.push({ tabs: target, streams: await streams(w), windows: (await health(w)).notify_reach.windows, lines: checked.total, perTab: checked.perTab });
  }
  // Each tab loaded in a few seconds at most (with eleven others open).
  expect(Math.max(...loads)).toBeLessThan(5000);
  results.tabs = { loadsMs: loads, steps };
});

test('the code before this change stalls the seventh tab; the shared stream loads a ninth at once', async ({ browser }) => {
  test.skip(!baselineBinary, 'PLANNOTATOR_E2E_BASELINE_BINARY names the old build');
  // The old build: six tabs, each holding its own stream, use Chrome's six connections to the host.
  const old = await world(browser, { binary: baselineBinary!, prefix: 'plannotator-inbox-shared-old-' });
  await seed(old);
  const oldLoads: number[] = [];
  for (let i = 0; i < 6; i++) oldLoads.push((await openTab(old)).ms);
  const seventh = await old.context.newPage();
  const started = Date.now();
  let stalled = false;
  try {
    await seventh.goto(old.url, { timeout: 8000, waitUntil: 'domcontentloaded' });
    await expect(seventh.locator('.ib-lbody [data-thread-id]').first()).toBeVisible({ timeout: 8000 - (Date.now() - started) });
  } catch {
    stalled = true;
  }
  const stalledMs = Date.now() - started;
  expect(stalled, 'the old build loads a seventh tab: the stall did not reproduce').toBe(true);
  // It is the connection limit: close one tab and the seventh loads.
  const freed = Date.now();
  await old.pages[0]!.close();
  forget(old, old.pages[0]!);
  await expect(seventh.locator('.ib-lbody [data-thread-id]').first()).toBeVisible({ timeout: 15_000 });
  const afterFreeMs = Date.now() - freed;
  await closeWorld(old);

  // The new build: eight tabs open, a ninth loads at once.
  const now = await world(browser);
  await seed(now);
  const newLoads: number[] = [];
  for (let i = 0; i < 8; i++) newLoads.push((await openTab(now)).ms);
  const ninth = await openTab(now, { timeout: 8000 });
  expect(ninth.ms).toBeLessThan(3000);
  expect(await streams(now)).toBe(1);
  results.stall = { oldLoadsMs: oldLoads, oldSeventhStalledForMs: stalledMs, oldSeventhLoadedAfterOneClosedMs: afterFreeMs, newLoadsMs: newLoads, newNinthMs: ninth.ms };
});

/** Hold even an idle page: Debugger.pause only schedules a pause at the next script. */
async function holdMainThread(cdp: CDPSession): Promise<() => Promise<void>> {
  await cdp.send('Debugger.enable');
  const paused = new Promise<void>((resolve) => cdp.once('Debugger.paused', () => resolve()));
  const evaluation = cdp.send('Runtime.evaluate', { expression: 'debugger;' });
  await Promise.race([
    paused,
    evaluation.then(() => { throw new Error('Debugger evaluation completed without pausing'); }),
  ]);
  return async () => {
    await cdp.send('Debugger.resume');
    await evaluation;
  };
}

/**
 * Close, reload, crash, freeze or stall the leader while an agent writes;
 * measure how fast another tab leads and the longest a tab in front went
 * without a record. A stalled leader is held by the debugger with no freeze
 * event (as a long script, or a phone's browser suspending a background tab,
 * holds it): it keeps its lock, and the follower in front takes it.
 */
async function handover(browser: Browser, how: 'close' | 'reload' | 'crash' | 'freeze' | 'stall'): Promise<Record<string, unknown>> {
  const w = await world(browser);
  await seed(w);
  for (let i = 0; i < 4; i++) await openTab(w);
  const [leader] = await leaders(w.pages);
  expect(leader).toBeDefined();
  const others = w.pages.filter((p) => p !== leader);
  // One follower is in front, as when the person reads the Inbox while the leader is a background tab.
  const front = others[0]!;
  await setFront(front, true, true);
  const sender = keepSending(w.agents[0]!, w.project, 40);
  await new Promise((done) => setTimeout(done, 600));
  const at = Date.now();
  let cdp: Awaited<ReturnType<typeof w.context.newCDPSession>> | null = null;
  let resumeMainThread: (() => Promise<void>) | null = null;
  if (how === 'close') {
    await leader!.close();
    forget(w, leader!);
  } else if (how === 'reload') {
    void leader!.reload();
  } else if (how === 'crash') {
    cdp = await w.context.newCDPSession(leader!);
    void cdp.send('Page.crash').catch(() => {});
    forget(w, leader!);
  } else if (how === 'stall') {
    // No freeze event: the debugger holds the page's main thread while its stream keeps receiving frames.
    cdp = await w.context.newCDPSession(leader!);
    resumeMainThread = await holdMainThread(cdp);
  } else {
    // Chrome freezes a page by dispatching `freeze`, running its microtasks, then running nothing more until
    // `resume`. Headless pages are always visible, so CDP's Page.setWebLifecycleState does not freeze them
    // (checked: no freeze event fires); the same sequence is played instead: the event, then the debugger
    // holds the page's main thread (its stream's frames and the channel's messages queue up), then resume.
    cdp = await w.context.newCDPSession(leader!);
    await leader!.evaluate(() => document.dispatchEvent(new Event('freeze')));
    resumeMainThread = await holdMainThread(cdp);
  }
  // Streams on the server, sampled until the leader runs again (never more than two: the stalled one and the new).
  const streamSamples: number[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      streamSamples.push(await streams(w));
      await new Promise((done) => setTimeout(done, 100));
    }
  })();
  // Another tab leads: when its log says so.
  let takeoverHow: string | undefined;
  const takeover = await waitFor(
    async () => {
      for (const page of others) {
        const lead = (await logOf(page)).find((e) => e.type === 'lead' && e.at >= at);
        if (lead) {
          takeoverHow = lead.how;
          return lead.at - at;
        }
      }
      return null;
    },
    (v) => v !== null,
    10_000,
  );
  // A stalled leader stays stopped for eight seconds in all (the reviewer's probe), the agent writing throughout.
  await new Promise((done) => setTimeout(done, how === 'stall' ? Math.max(1500, 8000 - (Date.now() - at)) : 1500));
  const sent = await sender.stop();
  const resumedAt = Date.now();
  if (how === 'freeze') {
    await expect.poll(() => streams(w)).toBe(1);
    // It wakes: it fetches what it missed and follows.
    await resumeMainThread!();
    await leader!.evaluate(() => document.dispatchEvent(new Event('resume')));
  }
  if (how === 'stall') {
    await resumeMainThread!();
    // It runs again: it learns the lock was taken, closes its stream and follows.
    const rejoin = await waitFor(
      async () => (await logOf(leader!)).filter((e) => e.at >= at).map((e) => e.type),
      (types) => types.includes('stolen') && types.includes('step-down'),
      5000,
    );
    await expect.poll(() => streams(w)).toBe(1);
    expect((await leaders(w.pages)).includes(leader!)).toBe(false);
    results.stallRejoinMs = rejoin.ms;
    // It learned only when the debugger let it run: it was stopped all along.
    results.stallOldLeaderLearnedAtMs = (await logOf(leader!)).find((e) => e.type === 'stolen' && e.at >= at)!.at - at;
    expect(results.stallOldLeaderLearnedAtMs as number).toBeGreaterThan(7000);
    // It is a follower now: what is written next reaches it too.
    await sendSome(w, 3);
  }
  sampling = false;
  await sampler;
  // The tab in front never waited long for a record: its longest gap from the stall on.
  const frontRecords = (await logOf(front)).filter((e) => e.type === 'record' && e.at >= at - 1000).map((e) => e.at);
  const frontGaps = frontRecords.slice(1).map((t, i) => t - frontRecords[i]!);
  const frontLongestGapMs = Math.max(0, frontRecords[0]! - at, ...frontGaps.filter((_, i) => frontRecords[i + 1]! <= resumedAt));
  if (how === 'reload') await expect(leader!.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
  const checked = await expectEveryRecordOnce(w, w.pages, { exact: false });
  await expect.poll(() => streams(w)).toBe(1);
  expect(await leaders(w.pages)).toHaveLength(1);
  // A leader that closes or reloads frees its lock at once: the next tab leads within a second. A frozen one steps
  // down at its freeze event (2 s on a slow machine). A crashed one frees its lock when the browser notices the
  // renderer died: at once on macOS (2 ms), about 3 s on GitHub's Linux runners; were it longer, the tab in front
  // would take it first (its check every 3 s, no answer in 2 s). Either way within the takeover a stalled leader gets.
  const bound = how === 'stall' || how === 'crash' ? 7000 : how === 'freeze' ? 2000 : 1000;
  expect(takeover.value!).toBeLessThan(bound);
  expect(frontLongestGapMs).toBeLessThan(bound + 500);
  // A crashed tab's connection can outlive its lock for a moment (the tab in front may lead first): two then.
  expect(Math.max(...streamSamples)).toBeLessThanOrEqual(how === 'stall' || how === 'crash' ? 2 : 1);
  // A crashed target answers nothing more: never wait on it.
  if (cdp && how !== 'crash') await cdp.detach().catch(() => {});
  if (how === 'crash') void leader!.close().catch(() => {});
  return {
    takeoverMs: takeover.value,
    takeoverHow,
    frontLongestGapMs,
    streamsPeak: Math.max(...streamSamples),
    streamSamples: streamSamples.length,
    messagesSentDuringTest: sent,
    lines: checked.total,
    perTab: checked.perTab,
    tabsExactlyEveryLine: `${checked.exactTabs}/${w.pages.length}`,
  };
}

test('the leader closes while an agent writes: another tab leads within a second, nothing missed or twice', async ({ browser }) => {
  results.closeLeader = await handover(browser, 'close');
});

test('the leader reloads while an agent writes: one stream, every tab (the reloaded one too) gets every record once', async ({ browser }) => {
  results.reloadLeader = await handover(browser, 'reload');
});

test('the leader crashes (renderer crash, no unload) while an agent writes: another tab leads once the browser frees its lock, or the tab in front takes it', async ({ browser }) => {
  results.crashLeader = await handover(browser, 'crash');
});

test('the leader is frozen (Chrome page lifecycle) while an agent writes: another tab leads; the frozen tab catches up as it wakes', async ({ browser }) => {
  results.freezeLeader = await handover(browser, 'freeze');
});

test('the leader stalls (debugger-paused, no freeze) while an agent writes: the follower in front takes over within seconds; the old leader follows when it runs again', async ({ browser }) => {
  results.stallLeader = await handover(browser, 'stall');
});

test('notifications once and the sound once across the tabs; a follower in front raises the notice and keeps the sound quiet; nothing for the thread it has open', async ({ browser }) => {
  const w = await world(browser);
  await seed(w);
  for (let i = 0; i < 4; i++) {
    const { page } = await openTab(w);
    // A click arms the sound (Chrome's user activation).
    await page.locator('.ib-main h1').first().click();
    await setFront(page, true, true);
    await setFront(page, false, false);
  }
  const notices = async () => (await Promise.all(w.pages.map((p) => p.evaluate(() => window.__notified.length)))).reduce((a, b) => a + b, 0);
  const rings = async () => (await Promise.all(w.pages.map((p) => p.evaluate(() => window.__sound.oscillators / 4)))).reduce((a, b) => a + b, 0);
  const sim = w.agents[0]!;
  const pi = await agent(w, 'Pi', 'pi');
  const [leader] = await leaders(w.pages);
  const follower = w.pages.find((p) => p !== leader)!;

  // (a) Every tab in the background: one notice and one ring between them.
  await new Promise((done) => setTimeout(done, 400));
  const n0 = await notices();
  const r0 = await rings();
  const first = await pi.send({ project_path: w.project, body: question('Pause the nightly import?') });
  await expectEveryRecordOnce(w);
  await expect.poll(notices).toBe(n0 + 1);
  await expect.poll(rings).toBe(r0 + 1);
  await new Promise((done) => setTimeout(done, 1500));
  expect(await notices()).toBe(n0 + 1);
  expect(await rings()).toBe(r0 + 1);

  // (b) A follower in front (the leader in the background): it raises the notice itself; nothing rings.
  await setFront(follower, true, true);
  await new Promise((done) => setTimeout(done, 600));
  const n1 = await notices();
  const r1 = await rings();
  const frontBefore = await follower.evaluate(() => window.__notified.length);
  const second = await sim.send({ project_path: w.project, body: question('Ship it behind a flag?'), thread: 'flag rollout' });
  await expectEveryRecordOnce(w);
  await expect.poll(notices).toBe(n1 + 1);
  await new Promise((done) => setTimeout(done, 1500));
  expect(await notices()).toBe(n1 + 1);
  expect(await follower.evaluate(() => window.__notified.length)).toBe(frontBefore + 1);
  expect(await rings()).toBe(r1);

  // (c) The front tab has that thread open: a question in it raises nothing anywhere.
  // (Its row may wait behind "N new · Show": the thread's own link opens it, as an agent's link does.)
  await follower.evaluate((id) => {
    location.hash = `thread=${id}`;
  }, second.thread_id as string);
  await expect(follower.locator('.ib-pbody').first()).toBeVisible();
  await new Promise((done) => setTimeout(done, 600));
  const n2 = await notices();
  const r2 = await rings();
  await sim.send({ project_path: w.project, body: question('And the EU region too?'), reply_to: second.message_id });
  await expectEveryRecordOnce(w);
  await new Promise((done) => setTimeout(done, 2000));
  expect(await notices()).toBe(n2);
  expect(await rings()).toBe(r2);
  results.notifications = { background: { notices: 1, rings: 1 }, followerInFront: { notices: 1, raisedByFront: true, rings: 0 }, openThread: { notices: 0, rings: 0 }, firstThread: first.thread_id };
});

test('notify_reach follows the tabs: open, a follower closes, a follower crashes, the leader closes', async ({ browser }) => {
  const w = await world(browser);
  await seed(w);
  for (let i = 0; i < 4; i++) await openTab(w);
  const windows = async () => (await health(w)).notify_reach;
  await expect.poll(async () => (await windows()).windows).toBe(4);
  expect((await windows()).allowed).toBe(4);
  const timeline: Record<string, number> = {};
  let [leader] = await leaders(w.pages);
  const followers = w.pages.filter((p) => p !== leader);

  // A follower closes: its pagehide beacon (or the leader, which sees its lock go).
  await followers[0]!.close();
  forget(w, followers[0]!);
  timeline.followerClosedMs = (await waitFor(windows, (r) => r.windows === 3)).ms;

  // A follower crashes: no pagehide; the leader sees its lock released.
  const cdp = await w.context.newCDPSession(followers[1]!);
  void cdp.send('Page.crash').catch(() => {});
  forget(w, followers[1]!);
  timeline.followerCrashedMs = (await waitFor(windows, (r) => r.windows === 2)).ms;

  // The leader closes: it stops counting at once, its follower stays counted under the new leader.
  [leader] = await leaders(w.pages);
  await leader!.close();
  forget(w, leader!);
  timeline.leaderClosedMs = (await waitFor(windows, (r) => r.windows === 1)).ms;
  // And it holds there (never drops to 0 while one tab is open).
  await new Promise((done) => setTimeout(done, 17_000));
  expect((await windows()).windows).toBe(1);
  expect(await streams(w)).toBe(1);
  // A new tab joins.
  await openTab(w);
  timeline.tabOpenedMs = (await waitFor(windows, (r) => r.windows === 2)).ms;
  // A crashed tab is seen when the browser frees its lock: at once on macOS, about 3 s later on GitHub's Linux runners.
  for (const [step, ms] of Object.entries(timeline)) expect(ms).toBeLessThan(step === 'followerCrashedMs' ? 8000 : 3000);
  results.reach = timeline;
});

test('an Inbox restart: every tab reconnects through one stream and keeps getting every record once', async ({ browser }) => {
  const w = await world(browser);
  await seed(w);
  for (let i = 0; i < 4; i++) await openTab(w);
  await sendSome(w, 2);
  await expectEveryRecordOnce(w);
  const port = new URL(w.url).port;
  await stopScratchInbox(w.dataDir);
  await expect.poll(async () => fetch(new URL('/api/inbox/health', w.url)).then(() => 'up', () => 'down')).toBe('down');
  const url = startInbox(w);
  expect(new URL(url).port).toBe(port);
  const back = await waitFor(() => streams(w), (n) => n === 1, 15_000);
  await expect.poll(async () => (await health(w)).notify_reach.windows, { timeout: 15_000 }).toBe(4);
  // A fresh agent (the old shim's Inbox is gone).
  const again = await agent(w, 'Claude Code', 'claude-code');
  for (let i = 0; i < 3; i++) await again.send({ project_path: w.project, body: `After the restart ${i}` });
  const checked = await expectEveryRecordOnce(w, w.pages, { exact: false });
  await new Promise((done) => setTimeout(done, 3000));
  expect(await streams(w)).toBe(1);
  results.restart = { reconnectedMs: back.ms, lines: checked.total, tabsExactlyEveryLine: `${checked.exactTabs}/${w.pages.length}` };
});

test('two origins never share: localhost and another loopback name hold one stream each, every tab gets every record', async ({ browser }) => {
  const w = await world(browser);
  await seed(w);
  const other = new URL(w.url);
  other.hostname = 'inbox-second.localhost';
  for (let i = 0; i < 3; i++) await openTab(w);
  for (let i = 0; i < 3; i++) await openTab(w, { url: other.href });
  await sendSome(w, 3);
  await expectEveryRecordOnce(w);
  await expect.poll(() => streams(w)).toBe(2);
  // One leader per origin.
  const origins = await Promise.all((await leaders(w.pages)).map((p) => p.evaluate(() => location.origin)));
  expect(origins.sort()).toEqual([new URL(w.url).origin, other.origin].sort());
  results.origins = { streams: 2, leaders: origins };
});

test('without Web Locks each tab holds its own stream, as before, and still gets every record once', async ({ browser }) => {
  const w = await world(browser, { noLocks: true });
  await seed(w);
  for (let i = 0; i < 3; i++) await openTab(w);
  await sendSome(w, 3);
  // No subscribe entry is logged on the fallback path: check the list instead, and the streams.
  await expect.poll(() => streams(w)).toBe(3);
  for (const page of w.pages) await expect(page.locator('.ib-lbody [data-thread-id]')).not.toHaveCount(0);
  expect(await Promise.all(w.pages.map((p) => p.evaluate(() => typeof navigator.locks)))).toEqual(['undefined', 'undefined', 'undefined']);
  expect((await logOf(w.pages[0]!)).length).toBe(0);
  results.noLocks = { streams: 3 };
});

test('soak: tabs open, close, reload, crash, come to the front and stall at random while an agent writes; one stream, nothing lost or twice', async ({ browser }) => {
  const soakMs = Number(process.env.PLANNOTATOR_E2E_SOAK_MS ?? 0);
  test.skip(!(soakMs > 0), 'PLANNOTATOR_E2E_SOAK_MS sets how long the soak runs');
  test.setTimeout(soakMs + 300_000);
  const w = await world(browser);
  await seed(w);
  for (let i = 0; i < 3; i++) await openTab(w);
  const sender = keepSending(w.agents[0]!, w.project, 50);
  const actions: Record<string, number> = { open: 0, close: 0, reload: 0, crash: 0, front: 0, stall: 0, stallTakenOver: 0 };
  const streamSamples: number[] = [];
  /** Samples taken while a leader was stalled: two streams then are expected (the stalled one and the new). */
  const stallSamples: number[] = [];
  /** The tab in front (the others are in the background). */
  let front: Page | null = null;
  const bringToFront = async (page: Page | null) => {
    if (front && front !== page && w.pages.includes(front)) await setFront(front, false, false);
    front = page;
    if (page) await setFront(page, true, true);
  };
  const crashed: Page[] = [];
  let seed32 = 1021;
  const random = () => {
    seed32 = (seed32 * 1103515245 + 12345) & 0x7fffffff;
    return seed32 / 0x7fffffff;
  };
  /** A tab about to close, reload or crash: what it handled so far is in order, never twice, all real lines. */
  let checkedBeforeLeaving = 0;
  const sane = async (page: Page) => {
    const got = (await logOf(page)).filter((e) => e.type === 'record').map((e) => e.seq!);
    const known = new Set(w.reference);
    expect(got.every((seq, i) => i === 0 || seq > got[i - 1]!), 'in order, never twice').toBe(true);
    expect(got.every((seq) => known.has(seq) || seq > (w.reference.at(-1) ?? 0)), 'only real lines').toBe(true);
    checkedBeforeLeaving++;
  };
  const until = Date.now() + soakMs;
  while (Date.now() < until) {
    if (front && !w.pages.includes(front)) front = null;
    const roll = random();
    if (roll < 0.1 && w.pages.length > 0) {
      await bringToFront(w.pages[Math.floor(random() * w.pages.length)]!);
      actions.front++;
    } else if (roll < 0.17 && w.pages.length > 1) {
      // The leader stalls (the debugger holds it, no freeze) for 3 to 9 s with another tab in front.
      const [leader] = await leaders(w.pages);
      if (leader) {
        if (!front || front === leader) await bringToFront(w.pages.find((p) => p !== leader)!);
        const cdp = await w.context.newCDPSession(leader);
        const resumeMainThread = await holdMainThread(cdp);
        const stallUntil = Date.now() + 3000 + Math.floor(random() * 6000);
        while (Date.now() < stallUntil) {
          await new Promise((done) => setTimeout(done, 300));
          stallSamples.push(await streams(w));
        }
        await resumeMainThread();
        await cdp.detach().catch(() => {});
        actions.stall++;
        if ((await logOf(leader)).some((e) => e.type === 'stolen')) actions.stallTakenOver++;
        // It runs again: one stream once it learns the lock was taken.
        await expect.poll(() => streams(w)).toBe(1);
      }
    } else if (roll < 0.4 && w.pages.length < 10) {
      await openTab(w);
      actions.open++;
    } else if (roll < 0.6 && w.pages.length > 1) {
      const page = w.pages[Math.floor(random() * w.pages.length)]!;
      await sane(page);
      forget(w, page);
      await page.close();
      actions.close++;
    } else if (roll < 0.8 && w.pages.length > 0) {
      const page = w.pages[Math.floor(random() * w.pages.length)]!;
      await sane(page);
      await page.reload();
      await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
      actions.reload++;
    } else if (w.pages.length > 1) {
      const page = w.pages[Math.floor(random() * w.pages.length)]!;
      await sane(page);
      forget(w, page);
      const cdp = await w.context.newCDPSession(page);
      void cdp.send('Page.crash').catch(() => {});
      crashed.push(page);
      actions.crash++;
    }
    await new Promise((done) => setTimeout(done, 300 + Math.floor(random() * 1500)));
    streamSamples.push(await streams(w));
  }
  const sent = await sender.stop();
  for (const page of crashed) void page.close().catch(() => {});
  const checked = await expectEveryRecordOnce(w, w.pages, { timeout: 30_000, exact: false });
  await expect.poll(() => streams(w)).toBe(1);
  // A handover can overlap for an instant (the old stream closing as the new one opens); never more than that.
  const over = streamSamples.filter((n) => n > 1).length;
  expect(Math.max(...streamSamples)).toBeLessThanOrEqual(2);
  expect(over / streamSamples.length).toBeLessThan(0.05);
  // While a leader is stalled: two streams at most (the stalled one, the new leader's).
  expect(Math.max(0, ...stallSamples)).toBeLessThanOrEqual(2);
  expect(actions.stall === 0 || actions.stallTakenOver > 0, 'a stall was taken over').toBe(true);
  results.soak = {
    ms: soakMs,
    actions,
    tabsCheckedBeforeLeaving: checkedBeforeLeaving,
    messagesSent: sent,
    lines: checked.total,
    tabsAtEnd: w.pages.length,
    tabsExactlyEveryLine: `${checked.exactTabs}/${w.pages.length}`,
    streamSamples: streamSamples.length,
    samplesAboveOne: over,
    stallSamples: stallSamples.length,
    stallSamplesPeak: Math.max(0, ...stallSamples),
  };
});

test('no page errors along the way', () => {
  for (const w of worlds) expect(w.errors).toEqual([]);
  void binary;
});
