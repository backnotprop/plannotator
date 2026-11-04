/**
 * The Inbox window's memory and responsiveness over a long session (issue
 * #2593, fix 6). A very large store, the window open on it with a thread in
 * the pane, and a stream of agent messages. It fails when the window's JS
 * heap creeps up or the window stops answering, so CI catches a leak or a
 * hang and nobody has to measure by hand.
 *
 * The world: scripts/inbox-large-store.ts seeds 4,000 threads, 30,000
 * messages and about 66 MB of text into a scratch data dir (about 2,200 rows
 * in the list). The compiled binary serves it with every sandbox switch on:
 * PLANNOTATOR_TEST_SANDBOX, no update check, no notes, no ping, no tailnet,
 * and NO_BROWSER. Three agents (Claude Code, Pi, Codex) write through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts). They send MESSAGES
 * messages over THREADS threads in three scratch projects. The first round
 * starts the threads, and every later round puts one reply in each thread.
 * The first thread stays open in the pane the whole time, so one message of
 * every round arrives in the open thread. Every tenth message the person
 * presses Show, which brings in the replies held behind "N new".
 *
 * Measured over raw CDP (tests/e2e/raw-cdp.ts), never through a Playwright
 * page. Playwright turns on the Network domain, and DevTools then keeps
 * every response body in the renderer. That inflated the heap we measured
 * before. Each sample is the JS heap in use after two forced full
 * collections.
 *
 * It fails when:
 *  - the heap after the last message is more than GROWTH_BUDGET_MB over the
 *    heap after the first round (the warm-up, which loads the thread view's
 *    code and fills its caches once);
 *  - the heap right after the window opens is over OPEN_CEILING_MB;
 *  - a main-thread task takes over LONG_TASK_LIMIT_MS while messages arrive
 *    after the warm-up (PerformanceObserver `longtask`). Two kinds of task
 *    are left out: the forced collections, and every task during the page
 *    load and the first WARMUP messages. Those first tasks parse the large
 *    list and load the thread view's code once, so a slow first load is not
 *    a hang. The frame and response checks below still cover the warm-up;
 *  - the window draws no frame within FRAME_TIMEOUT_MS of a request;
 *  - a new thread's row (after Show), or a message in the open thread, is
 *    not on screen within RESPONSE_TIMEOUT_MS of the agent's send returning;
 *  - the "Tell your agents" dialog appears (PLANNOTATOR_INBOX_NOTES=0 must
 *    keep it away).
 *
 * The budgets come from measured runs (2026-11-04, Apple M-series, macOS,
 * Playwright's Chromium 1248, this spec unchanged; the PR that added it has
 * the tables). The heap is the same from run to run within a few tenths of
 * a MB, because the store is seeded the same way and the heap is read after
 * full collections. Machine speed does not change it. Timing does depend
 * on speed, so the timing limits leave room for a CI runner several times
 * slower.
 *  - Growth with #2604 (list delta), five runs: 6.3 to 7.0 MB. On main
 *    before #2604 (52858d1), five runs: 25.2 to 27.4 MB, about 90 KB per
 *    agent message while a thread is open. GROWTH_BUDGET_MB is 14: twice
 *    the fixed growth, and 11 MB under the lowest run of the creep it must
 *    catch. Every main run failed it, and every #2604 run passed.
 *  - At open: 89.2 MB in all ten runs. OPEN_CEILING_MB is 135, 1.5 times that.
 *  - Longest task while messages arrived: 91 to 108 ms. LONG_TASK_LIMIT_MS
 *    is 2,000: still more than six times the worst run on a runner three
 *    times slower.
 *  - Slowest response: 487 to 648 ms. Slowest frame: 11 to 17 ms. The
 *    timeouts are 15 s and 5 s.
 *
 * Build the binary first (see inbox.spec.ts), then run
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-memory-soak`.
 * Another binary: PLANNOTATOR_E2E_BINARY. The samples land in
 * .local/proof/memory-soak/samples.json.
 */

import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { seedInboxSearchWorld, WORST_CASE } from '../../scripts/inbox-large-store';
import { scratchProject, SimAgent } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { launchRawChromium, type RawPage } from './raw-cdp';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'memory-soak');

/** Agent messages in the run. */
const MESSAGES = 300;
/** The agents' threads; message i goes to thread i % THREADS. */
const THREADS = 30;
/** Messages before the baseline sample: the round that starts every thread. */
const WARMUP = THREADS;
/** A heap sample after every round. */
const SAMPLE_EVERY = THREADS;
/** The pause between two sends. */
const SEND_GAP_MS = 120;

const MB = 1024 * 1024;
/** The most the heap may grow from the warm-up sample to the last sample. */
const GROWTH_BUDGET_MB = 14;
/** The most the heap may hold right after the window opens on the large store. */
const OPEN_CEILING_MB = 135;
/** The longest main-thread task allowed while messages arrive. */
const LONG_TASK_LIMIT_MS = 2_000;
/** A frame must be drawn within this time of a request. */
const FRAME_TIMEOUT_MS = 5_000;
/** A sent message must be on screen within this time. */
const RESPONSE_TIMEOUT_MS = 15_000;

/** Records every long task (startTime, duration) from the page's first script. */
const LONG_TASK_RECORDER = `(() => {
  const soak = (window.__soak = { long: [] });
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) soak.long.push([e.startTime, e.duration]);
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
})();`;

interface Sample {
  messages: number;
  heapMB: number;
  nodes: number;
  listeners: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

test.afterAll(async () => {
  await removeInboxScratch();
});

test('the window keeps its memory flat and keeps answering through a long run of agent messages on a large store', async () => {
  test.setTimeout(15 * 60_000);
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });

  const root = inboxScratch('plannotator-inbox-memory-soak-e2e-');
  const dataDir = join(root, 'data');
  seedInboxSearchWorld(dataDir, WORST_CASE);
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

  const projects = ['checkout-web', 'ledger-api', 'docs-site'].map((name) => scratchProject(join(root, 'src'), name));
  const agents: SimAgent[] = [];
  let page: RawPage | undefined;
  try {
    // Inside the try: when one connect fails, the shims that did start are closed in the finally below.
    const connected = await Promise.allSettled(
      [
        { name: 'Claude Code', host: 'claude-code' },
        { name: 'Pi', host: 'pi' },
        { name: 'Codex', host: 'codex' },
      ].map((a) => SimAgent.connect({ binary, env, ...a })),
    );
    for (const c of connected) if (c.status === 'fulfilled') agents.push(c.value);
    const refused = connected.find((c): c is PromiseRejectedResult => c.status === 'rejected');
    if (refused) throw refused.reason;

    page = await launchRawChromium();
    await page.call('Page.addScriptToEvaluateOnNewDocument', { source: LONG_TASK_RECORDER });
    const p = page;
    const samples: Sample[] = [];
    const gcWindows: [number, number][] = [];
    const responses: number[] = [];
    const frames: number[] = [];

    const noAgentNote = async () => {
      expect(await p.evaluate<boolean>(`!!document.querySelector('[data-dialog="agent-note"]')`), 'the "Tell your agents" dialog appeared').toBe(false);
    };
    /** One frame, timed from the request. A hung main thread never answers. */
    const frame = async (what: string) => {
      const ms = await p
        .evaluate<number>(`new Promise((done) => { const t = performance.now(); requestAnimationFrame(() => done(performance.now() - t)); })`, FRAME_TIMEOUT_MS)
        .catch(() => Number.POSITIVE_INFINITY);
      expect(ms, `no frame within ${FRAME_TIMEOUT_MS} ms ${what}`).toBeLessThan(FRAME_TIMEOUT_MS);
      frames.push(ms);
    };
    /** The heap after forced collections. The time spent collecting is left out of the long-task check. */
    const sample = async (messages: number) => {
      const before = await p.evaluate<number>('performance.now()');
      const heap = await p.heapAfterGc();
      const after = await p.evaluate<number>('performance.now()');
      gcWindows.push([before, after]);
      const s = { messages, heapMB: round1(heap.jsHeapUsed / MB), nodes: heap.nodes, listeners: heap.listeners };
      samples.push(s);
      console.log(`soak sample ${JSON.stringify(s)}`);
      await noAgentNote();
      return s;
    };
    /** Poll `check` (an expression; it may press Show) until it is true. Fails after RESPONSE_TIMEOUT_MS. */
    const onScreen = async (check: string, what: string) => {
      const t = Date.now();
      const ok = await p.waitFor(check, RESPONSE_TIMEOUT_MS).catch(() => false);
      expect(ok, `${what} was not on screen within ${RESPONSE_TIMEOUT_MS} ms`).toBe(true);
      responses.push(Date.now() - t);
    };
    const shown = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`;

    await page.goto(`${url}/`);
    expect(await page.waitFor(shown('.ib-lbody [data-thread-id]'), 60_000), 'the list showed no row').toBe(true);
    await pause(5_000);
    await noAgentNote();
    const opened = await sample(0);

    let open: string | null = null;
    let baseline: Sample | undefined;
    let soakStart = 0;
    for (let i = 0; i < MESSAGES; i++) {
      const k = i % THREADS;
      const first = i < THREADS;
      const lines = [
        `Step ${i + 1}: ${first ? 'started on' : 'more on'} part ${k + 1}. The \`ledger\` export now streams rows instead of loading them all; memory stays flat on the 2 GB fixture.`,
        '',
        `- Changed \`src/export/rows-${k}.ts\` and its test.`,
        `- Ran the suite: ${200 + i} passed, 0 failed.`,
        '',
        '```ts',
        `for await (const row of stream(${i})) out.write(row);`,
        '```',
      ];
      if (i % 7 === 3) lines.push('', ':::question', `Ship part ${k + 1} now, or wait for review?`, '', '- [ ] Ship it', '- [ ] Wait for review', ':::');
      const sent = await agents[i % 3]!.send({
        project_path: projects[i % 3]!,
        thread: `soak-${k}`,
        ...(first ? { subject: `Soak part ${k + 1}: stream the ledger export` } : {}),
        body: lines.join('\n'),
        idempotency_key: `soak-${i}`,
      });
      const threadId = String(sent.thread_id);
      if (first) {
        // A new thread waits behind "N new · Show" (rows never move under the reader). The person presses Show until its row is drawn.
        const row = `.ib-lbody [data-thread-id="${threadId}"]`;
        await onScreen(`${shown(row)} || void document.querySelector('[data-inbox-notice]')?.click()`, `the new thread ${k + 1}'s row`);
      }
      if (i === 0) {
        // The pane stays on this thread for the whole run, as a click on its row opens it.
        open = threadId;
        await p.evaluate(`void (window.location.hash = ${JSON.stringify(`thread=${threadId}`)})`);
        await onScreen(shown(`section.ib-pane[data-thread-id="${threadId}"]`), 'the opened thread');
      } else if (threadId === open) {
        // A message in the open thread is drawn in place, without Show.
        await onScreen(shown(`section.ib-pane [data-message-id="${String(sent.message_id)}"]`), `message ${i + 1} in the open thread`);
      }
      if (i % 10 === 9) {
        // The person keeps up with the rest: Show brings in every held reply.
        await p.evaluate(`void document.querySelector('[data-inbox-notice]')?.click()`);
        await frame(`after message ${i + 1}`);
      }
      const done = i + 1;
      if (done === WARMUP || (done > WARMUP && (done - WARMUP) % SAMPLE_EVERY === 0)) {
        await pause(2_000);
        const s = await sample(done);
        if (done === WARMUP) {
          baseline = s;
          soakStart = await p.evaluate<number>('performance.now()');
        }
      }
      await pause(SEND_GAP_MS);
    }
    await frame('at the end');

    const longTasks = (await p.evaluate<[number, number][]>('window.__soak.long'))
      .filter(([start]) => start >= soakStart)
      .filter(([start, duration]) => !gcWindows.some(([a, b]) => start + duration >= a && start <= b));
    const longest = Math.round(longTasks.reduce((m, [, d]) => Math.max(m, d), 0));
    const last = samples[samples.length - 1]!;
    const growth = round1(last.heapMB - baseline!.heapMB);
    const summary = {
      openHeapMB: opened.heapMB,
      baselineHeapMB: baseline!.heapMB,
      lastHeapMB: last.heapMB,
      growthMB: growth,
      nodes: { baseline: baseline!.nodes, last: last.nodes },
      longTasksOver50ms: longTasks.length,
      longestTaskMs: longest,
      slowestResponseMs: Math.max(...responses),
      slowestFrameMs: Math.round(Math.max(...frames)),
      samples,
    };
    console.log(`soak summary ${JSON.stringify({ ...summary, samples: undefined })}`);
    writeFileSync(join(proofDir, 'samples.json'), `${JSON.stringify(summary, null, 2)}\n`);

    expect(opened.heapMB, `JS heap right after the window opened (MB); ceiling ${OPEN_CEILING_MB}`).toBeLessThanOrEqual(OPEN_CEILING_MB);
    expect(growth, `JS heap growth over ${MESSAGES - WARMUP} messages (MB); budget ${GROWTH_BUDGET_MB}`).toBeLessThanOrEqual(GROWTH_BUDGET_MB);
    expect(longest, `longest main-thread task while messages arrived (ms); limit ${LONG_TASK_LIMIT_MS}`).toBeLessThanOrEqual(LONG_TASK_LIMIT_MS);
  } finally {
    await page?.close();
    await Promise.all(agents.map((a) => a.close().catch(() => {})));
    // Now, not in afterAll: a repeated run (--repeat-each) must not leave a large Inbox running beside the next one.
    await removeInboxScratch(root);
  }
});
