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
  WORK_THREAD,
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

async function seed(w: World): Promise<void> {
  const sim = await agent(w);
  await sim.send({ project_path: w.project, thread: WORK_THREAD, body: 'Starting on the billing work.' });
}

async function sendSome(w: World, count: number): Promise<void> {
  const sim = w.agents[0]!;
  for (let i = 0; i < count; i++) await sim.send({ project_path: w.project, thread: WORK_THREAD, body: `Update ${Date.now()}-${i}` });
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
  expect(Math.max(...loads)).toBeLessThan(5000);
  results.tabs = { loadsMs: loads, steps };
});

test('the code before this change stalls the seventh tab; the shared stream loads a ninth at once', async ({ browser }) => {
  test.skip(!baselineBinary, 'PLANNOTATOR_E2E_BASELINE_BINARY names the old build');
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
  const freed = Date.now();
  await old.pages[0]!.close();
  forget(old, old.pages[0]!);
  await expect(seventh.locator('.ib-lbody [data-thread-id]').first()).toBeVisible({ timeout: 15_000 });
  const afterFreeMs = Date.now() - freed;
  await closeWorld(old);

  const now = await world(browser);
  await seed(now);
  const newLoads: number[] = [];
  for (let i = 0; i < 8; i++) newLoads.push((await openTab(now)).ms);
  const ninth = await openTab(now, { timeout: 8000 });
  expect(ninth.ms).toBeLessThan(3000);
  expect(await streams(now)).toBe(1);
  results.stall = { oldLoadsMs: oldLoads, oldSeventhStalledForMs: stalledMs, oldSeventhLoadedAfterOneClosedMs: afterFreeMs, newLoadsMs: newLoads, newNinthMs: ninth.ms };
});

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

async function handover(browser: Browser, how: 'close' | 'reload' | 'crash' | 'freeze' | 'stall'): Promise<Record<string, unknown>> {
  const w = await world(browser);
  await seed(w);
  for (let i = 0; i < 4; i++) await openTab(w);
  const [leader] = await leaders(w.pages);
  expect(leader).toBeDefined();
  const others = w.pages.filter((p) => p !== leader);
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
    cdp = await w.context.newCDPSession(leader!);
    resumeMainThread = await holdMainThread(cdp);
  } else {
    cdp = await w.context.newCDPSession(leader!);
    await leader!.evaluate(() => document.dispatchEvent(new Event('freeze')));
    resumeMainThread = await holdMainThread(cdp);
  }
  const streamSamples: number[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      streamSamples.push(await streams(w));
      await new Promise((done) => setTimeout(done, 100));
    }
  })();
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
  await new Promise((done) => setTimeout(done, how === 'stall' ? Math.max(1500, 8000 - (Date.now() - at)) : 1500));
  const sent = await sender.stop();
  const resumedAt = Date.now();
  if (how === 'freeze') {
    await expect.poll(() => streams(w)).toBe(1);
    await resumeMainThread!();
    await leader!.evaluate(() => document.dispatchEvent(new Event('resume')));
  }
  if (how === 'stall') {
    await resumeMainThread!();
    const rejoin = await waitFor(
      async () => (await logOf(leader!)).filter((e) => e.at >= at).map((e) => e.type),
      (types) => types.includes('stolen') && types.includes('step-down'),
      5000,
    );
    await expect.poll(() => streams(w)).toBe(1);
    expect((await leaders(w.pages)).includes(leader!)).toBe(false);
    results.stallRejoinMs = rejoin.ms;
    results.stallOldLeaderLearnedAtMs = (await logOf(leader!)).find((e) => e.type === 'stolen' && e.at >= at)!.at - at;
    expect(results.stallOldLeaderLearnedAtMs as number).toBeGreaterThan(7000);
    await sendSome(w, 3);
  }
  sampling = false;
  await sampler;
  const frontRecords = (await logOf(front)).filter((e) => e.type === 'record' && e.at >= at - 1000).map((e) => e.at);
  const frontGaps = frontRecords.slice(1).map((t, i) => t - frontRecords[i]!);
  const frontLongestGapMs = Math.max(0, frontRecords[0]! - at, ...frontGaps.filter((_, i) => frontRecords[i + 1]! <= resumedAt));
  if (how === 'reload') await expect(leader!.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
  const checked = await expectEveryRecordOnce(w, w.pages, { exact: false });
  await expect.poll(() => streams(w)).toBe(1);
  expect(await leaders(w.pages)).toHaveLength(1);
  const bound = how === 'stall' || how === 'crash' ? 7000 : how === 'freeze' ? 2000 : 1000;
  expect(takeover.value!).toBeLessThan(bound);
  expect(frontLongestGapMs).toBeLessThan(bound + 500);
  expect(Math.max(...streamSamples)).toBeLessThanOrEqual(how === 'stall' || how === 'crash' ? 2 : 1);
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

  await followers[0]!.close();
  forget(w, followers[0]!);
  timeline.followerClosedMs = (await waitFor(windows, (r) => r.windows === 3)).ms;

  const cdp = await w.context.newCDPSession(followers[1]!);
  void cdp.send('Page.crash').catch(() => {});
  forget(w, followers[1]!);
  timeline.followerCrashedMs = (await waitFor(windows, (r) => r.windows === 2)).ms;

  [leader] = await leaders(w.pages);
  await leader!.close();
  forget(w, leader!);
  timeline.leaderClosedMs = (await waitFor(windows, (r) => r.windows === 1)).ms;
  await new Promise((done) => setTimeout(done, 17_000));
  expect((await windows()).windows).toBe(1);
  expect(await streams(w)).toBe(1);
  await openTab(w);
  timeline.tabOpenedMs = (await waitFor(windows, (r) => r.windows === 2)).ms;
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
  const origins = await Promise.all((await leaders(w.pages)).map((p) => p.evaluate(() => location.origin)));
  expect(origins.sort()).toEqual([new URL(w.url).origin, other.origin].sort());
  results.origins = { streams: 2, leaders: origins };
});

test('without Web Locks each tab holds its own stream, as before, and still gets every record once', async ({ browser }) => {
  const w = await world(browser, { noLocks: true });
  await seed(w);
  for (let i = 0; i < 3; i++) await openTab(w);
  await sendSome(w, 3);
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
  const stallSamples: number[] = [];
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
  const over = streamSamples.filter((n) => n > 1).length;
  expect(Math.max(...streamSamples)).toBeLessThanOrEqual(2);
  expect(over / streamSamples.length).toBeLessThan(0.05);
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
