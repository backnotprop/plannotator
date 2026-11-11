/**
 * The Inbox's live behaviour, verified and measured from the outside.
 *
 * Every check drives the public surface only: an agent through the MCP shim (SimAgent), another window or phone
 * through the HTTP API or a real page, and the result read off the window's DOM (and the HTTP API for the
 * server's side). Nothing imports window or server internals, so this file runs unchanged against a rebuilt store
 * or data layer: point PLANNOTATOR_E2E_BINARY at the new build.
 *
 * Pages: A and B are two tabs of one desktop browser (one shared event stream). C is a second desktop "device"
 * (its own browser context, its own stream) left on the list. P is a phone layout (390 px, touch, its own context).
 *
 * Sandboxed: a scratch root from tests/e2e/inbox-scratch.ts (HOME, data dir), PLANNOTATOR_TEST_SANDBOX, NO_BROWSER,
 * an Inbox on a port it picks (refuses 49606 and 59812), stopped only through the scratch helpers. Run it through
 * `bun scripts/inbox-live-verify.ts run`, never directly: that script makes the sandbox and merges the results.
 *
 * Env: LIVE_SIZE small|10k|100k|wide · LIVE_PROFILE local|throttled|hotel (hotel: the hotel WiFi checks, hotel.ts, and
 *      LV-24..27) · LIVE_RUNS (samples per stat) · LIVE_OUT (json path) · LIVE_QUERY (appended to the page address,
 *      e.g. `?data=db`) · LIVE_LOG (progress lines) · LIVE_CPU_PROFILE (a directory: a CPU profile of the list window C
 *      over the first agent-message probe is written there, for spike work)
 */
import { chromium, test, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, release, platform, arch, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { LIVE_SIZES, seedLiveWorld, type LiveSize } from '../../scripts/inbox-live-verify-seed';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from '../e2e/inbox-scratch';
import { runDeepChecks } from './deep';
import { eventSplit, pageBytes, type EventSplit } from './windowCost';
import { HOTEL, hotelLink, runHotel } from './hotel';
import { LinkProxy } from './linkProxy';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const SIZE = (process.env.LIVE_SIZE ?? 'small') as LiveSize;
const PROFILE = (process.env.LIVE_PROFILE ?? 'local') as keyof typeof PROFILES;
const RUNS = Math.max(1, Number(process.env.LIVE_RUNS ?? 5));
/** Appended to the page address, e.g. `?data=db` for the TanStack DB prototype's window (`proto/inbox-tanstack-db`). */
const QUERY = process.env.LIVE_QUERY ?? '';
const OUT = resolve(process.env.LIVE_OUT ?? join(repo, `.local/live-verify/${SIZE}-${PROFILE}.json`));

/** Store sizes: the seeded history the live checks run on top of (scripts/inbox-live-verify-seed.ts). */
const SIZES = LIVE_SIZES;
if (!(SIZE in SIZES)) throw new Error(`LIVE_SIZE: one of ${Object.keys(SIZES).join(', ')}`);
/**
 * Links: loopback, or Chromium's throttle (40 ms each way, 10 Mbit) on every page, as a remote tailnet device, or hotel
 * WiFi (hotel.ts: 400 ms with jitter, 1 Mbit, 3 % loss, one drop), which runs only its own three checks.
 */
const PROFILES = { local: null, throttled: { latency: 40, mbit: 10 }, hotel: { latency: HOTEL.latency, mbit: HOTEL.mbit } } as const;
/** Pass budget for "a change made elsewhere paints here", per link. A check fails past it. */
const BUDGET_MS = PROFILE === 'local' ? 1000 : 2500;

const pause = (ms: number) => new Promise((d) => setTimeout(d, ms));
const QUESTIONS = (tag: string) =>
  [`Two choices (${tag}).`, '', ':::question', `Which layout ${tag}?`, '', '- [ ] Cards', '- [ ] A dense table', ':::', '', ':::question', `Sort overdue first ${tag}?`, '', '- [ ] Yes', '- [ ] No', ':::', ''].join('\n');

interface Rule {
  id: string;
  title: string;
  pass: boolean;
  ms?: number | null;
  detail?: unknown;
}
interface Stat {
  unit: 'ms' | 'count' | 'bytes' | 'MB';
  samples: number[];
  median: number | null;
  p95: number | null;
}

function summarize(unit: Stat['unit'], samples: number[]): Stat {
  const ok = samples.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  const at = (p: number) => (ok.length ? ok[Math.min(ok.length - 1, Math.ceil(p * ok.length) - 1)]! : null);
  return { unit, samples, median: ok.length ? (ok.length % 2 ? ok[(ok.length - 1) / 2]! : Math.round((ok[ok.length / 2 - 1]! + ok[ok.length / 2]!) / 2)) : null, p95: at(0.95) };
}

/** Arm a waiter in the page: Date.now() at the first frame where `cond` holds (-1 past `timeout`). */
async function arm(page: Page, key: string, cond: string, timeout = 20_000) {
  await page.evaluate(
    ({ key, cond, timeout }) => {
      const w = window as any;
      w.__lv = w.__lv ?? {};
      const ok = new Function(cond) as () => boolean;
      const start = Date.now();
      w.__lv[key] = null;
      const tick = () => {
        let v = false;
        try {
          v = !!ok();
        } catch {}
        if (v) w.__lv[key] = Date.now();
        else if (Date.now() - start > timeout) w.__lv[key] = -1;
        else requestAnimationFrame(tick);
      };
      tick();
    },
    { key, cond, timeout },
  );
}
/** ms from t0 to the armed paint; -1: never within its timeout. */
async function landed(page: Page, key: string, t0: number, timeout = 22_000): Promise<number> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await page.evaluate((key) => (window as any).__lv?.[key], key).catch(() => -1);
    if (v !== null && v !== undefined) return v === -1 ? -1 : Math.max(0, v - t0);
    if (Date.now() > end) return -1;
    await pause(20);
  }
}

/** Requests (not the event stream) each page made, with their sizes once finished. */
class Traffic {
  private reqs: { page: string; t: number; url: string; bytes: number }[] = [];
  /** API requests out now, on every page (the event stream left out). */
  private out = new Set<Request>();
  /**
   * Until no page has an API request out for `quietMs` (at most `maxMs`): a check starts on windows that finished
   * what the last one set off, so one build's faster check does not leave its reads to count in the next.
   */
  async settled(quietMs = 250, maxMs = 10_000): Promise<void> {
    const end = Date.now() + maxMs;
    let quietSince = this.out.size === 0 ? Date.now() : 0;
    while (Date.now() < end) {
      if (this.out.size > 0) quietSince = 0;
      else if (quietSince === 0) quietSince = Date.now();
      else if (Date.now() - quietSince >= quietMs) return;
      await pause(25);
    }
  }
  attach(page: Page, name: string) {
    const api = (r: Request) => {
      const url = r.url().replace(/^https?:\/\/[^/]+/, '');
      return url.startsWith('/api/') && !(url.startsWith('/api/inbox/events') && !url.includes('once=1'));
    };
    page.on('request', (r: Request) => void (api(r) && this.out.add(r)));
    page.on('requestfailed', (r: Request) => void this.out.delete(r));
    page.on('requestfinished', (r: Request) => void this.out.delete(r));
    page.on('requestfinished', async (r: Request) => {
      const url = r.url().replace(/^https?:\/\/[^/]+/, '');
      if (!url.startsWith('/api/') || (url.startsWith('/api/inbox/events') && !url.includes('once=1'))) return;
      const t = Date.now();
      let bytes = 0;
      try {
        const s = await r.sizes();
        bytes = s.responseBodySize + s.responseHeadersSize + s.requestBodySize + s.requestHeadersSize;
      } catch {}
      this.reqs.push({ page: name, t, url, bytes });
    });
  }
  between(t0: number, t1: number, pages?: string[]) {
    const list = this.reqs.filter((r) => r.t >= t0 && r.t <= t1 && (!pages || pages.includes(r.page)));
    const path = (url: string) => url.replace(/\?.*$/, '').replace(/msg_[A-Z0-9]+/g, ':id');
    // Which window made which request, and how many of each (`A /api/inbox/threads: 2`): where an event's cost goes.
    const byPage: Record<string, number> = {};
    for (const r of list) byPage[`${r.page} ${path(r.url)}`] = (byPage[`${r.page} ${path(r.url)}`] ?? 0) + 1;
    return { count: list.length, bytes: list.reduce((n, r) => n + r.bytes, 0), urls: [...new Set(list.map((r) => path(r.url)))], byPage };
  }
}

const rowSel = (id: string) => `.ib-lbody [data-thread-id="${id}"]`;
const paneSel = (id: string) => `section.ib-pane[data-thread-id="${id}"]`;
const msgCount = (id: string) => `document.querySelectorAll('${paneSel(id)} [data-message-article]').length`;

function rssMB(pid: number): number | null {
  try {
    return Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024);
  } catch {
    return null;
  }
}
function machine() {
  const sha = (() => {
    try {
      return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  })();
  let binarySha: string | null = null;
  try {
    binarySha = createHash('sha256').update(readFileSync(binary)).digest('hex').slice(0, 16);
  } catch {}
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 20_000 }).stdout?.trim() ?? null;
  return { platform: `${platform()} ${release()} ${arch()}`, cpu: cpus()[0]?.model ?? null, cores: cpus().length, memGB: Math.round(totalmem() / 2 ** 30), verifierCommit: sha, binary, binarySha, binaryVersion: version };
}

test(`inbox live behaviour: ${SIZE} store, ${PROFILE} link`, async () => {
  const rules: Record<string, Rule> = {};
  const samples: Record<string, { unit: Stat['unit']; xs: number[] }> = {};
  const add = (name: string, unit: Stat['unit'], x: number) => ((samples[name] ??= { unit, xs: [] }).xs.push(x));
  const out: any = { meta: { ...machine(), size: SIZE, sizeShape: SIZES[SIZE], profile: PROFILE, query: QUERY, runs: RUNS, budgetMs: BUDGET_MS, startedAt: new Date().toISOString(), loadAtStart: loadavg().map((x) => Math.round(x * 10) / 10) } };
  mkdirSync(dirname(OUT), { recursive: true });
  const log = (s: string) => {
    const line = `${new Date().toISOString()} [live-verify ${SIZE}/${PROFILE}] ${s}\n`;
    process.stdout.write(line);
    if (process.env.LIVE_LOG) appendFileSync(process.env.LIVE_LOG, line);
  };
  /** One check: its own timeout, an exception is a failure with the reason. */
  let settleWindows: (() => Promise<void>) | null = null;
  const check = async (id: string, title: string, fn: () => Promise<{ pass: boolean; ms?: number | null; detail?: unknown }>) => {
    log(`${id} ${title}`);
    // Every window done with what the last check set off (see Traffic.settled).
    await settleWindows?.();
    try {
      const r = await Promise.race([fn(), pause(90_000).then(() => ({ pass: false, detail: 'check timed out (90 s)' }))]);
      rules[id] = { id, title, ...r };
    } catch (e) {
      rules[id] = { id, title, pass: false, detail: `error: ${(e as Error).message.split('\n')[0]}` };
    }
    log(`  -> ${rules[id]!.pass ? 'pass' : 'FAIL'} ${rules[id]!.ms ?? ''} ${rules[id]!.pass ? '' : JSON.stringify(rules[id]!.detail ?? '').slice(0, 200)}`);
  };

  const root = inboxScratch('plannotator-live-verify-');
  const dataDir = join(root, 'data');
  let browser: Browser | null = null;
  let agent: SimAgent | null = null;
  let linkProxy: LinkProxy | null = null;
  try {
    let t = Date.now();
    const world = seedLiveWorld(dataDir, SIZE);
    out.setup = { seedMs: Date.now() - t, sections: world.sections };
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
      PLANNOTATOR_INBOX_PHONES: '0',
      PLANNOTATOR_TEST_SANDBOX: '1',
      ...(process.env.X1_LOG ? { X1_LOG: process.env.X1_LOG } : {}),
    };
    t = Date.now();
    const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 600_000 });
    if (started.status !== 0) throw new Error(`Inbox start failed: ${started.stderr}`);
    rememberInboxOf(dataDir);
    const reg = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8'));
    const port: number = reg.port;
    if ([49606, 59812].includes(port)) throw new Error(`refusing a real Inbox port ${port}`);
    const pid: number = reg.pid;
    out.setup.startMs = Date.now() - t;
    const base = `http://127.0.0.1:${port}`;
    // The page whose link drops (C on a good link, A in hotel WiFi) reaches the Inbox through a proxy that can cut it.
    linkProxy = await new LinkProxy(port).start();
    const proxied = `http://127.0.0.1:${linkProxy.port}`;
    const post = async (path: string, body: unknown) => {
      const r = await fetch(`${base}/api/inbox${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, text: await r.text() };
    };
    const get = async (path: string) => (await fetch(`${base}/api/inbox${path}`)).json() as Promise<any>;
    const LIST = '/threads?archived=exclude&snoozed=exclude&machines=1&since=';
    const serverRow = async (id: string) => {
      const m = await get(LIST);
      for (const s of m.sections ?? []) for (const r of s.threads ?? []) if (r.thread_id === id) return r;
      return null;
    };
    // Notifications on for the desktop's origin, as after the person's Allow (LV-22 counts them).
    await post('/settings', { notifications: { dismissed: true, enabled: true, allowed_origin: base } });
    out.memory = { rssAfterStartMB: rssMB(pid) };

    const project = scratchProject(join(root, 'src'), 'billing');
    agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
    const ag = agent;
    const T: Record<string, string> = {};
    const newThread = async (key: string, body: string) => {
      const r = await ag.send({ project_path: project, subject: `Live ${key}`, thread: `live-${key}`, body }, { wakes: true });
      T[key] = r.thread_id as string;
      return r.thread_id as string;
    };
    if (PROFILE === 'hotel') await newThread('hotel', QUESTIONS('hotel'));
    for (const k of ['open', 'rowc', 'pins2', 'arch', 'read', 'pins', 'snooze', 'resolve', 'race', 'scroll', 'type', 'held', 'sent', 'snz']) await newThread(k, k === 'race' || k === 'held' ? QUESTIONS(k) : `Hello from ${k}.`);
    for (let i = 0; i < RUNS; i++) await newThread(`pick${i}`, QUESTIONS(`pick${i}`));
    for (let i = 0; i < Math.min(RUNS, 3); i++) await newThread(`draft${i}`, `Draft target ${i}.`);
    for (let i = 0; i < 14; i++) await ag.send({ project_path: project, reply_to: T.scroll!, body: `Long message ${i}.\n\n${'A paragraph of text that takes room. '.repeat(30)}` });

    // Chromium's new headless (`channel: 'chromium'`): the old headless shell denies notifications whatever is granted.
    browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-mock-keychain', '--password-store=basic'] });
    const desk: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true });
    const other: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true });
    const phone: BrowserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, bypassCSP: true });
    await desk.grantPermissions(['notifications']);
    // Count notifications the desktop's tabs raise (LV-22), through the browser's own API.
    await desk.addInitScript(() => {
      const w = window as any;
      w.__notes = [];
      const Real = w.Notification;
      if (!Real) return;
      class Counted extends Real {
        constructor(title: string, options?: unknown) {
          super(title, options);
          w.__notes.push({ title, at: Date.now() });
        }
      }
      Object.defineProperty(Counted, 'permission', { get: () => Real.permission });
      (Counted as any).requestPermission = Real.requestPermission?.bind(Real);
      w.Notification = Counted;
    });
    const A = await desk.newPage();
    const B = await desk.newPage();
    const C = await other.newPage();
    const P = await phone.newPage();
    const pages = { A, B, C, P };
    const dropping = PROFILE === 'hotel' ? A : C;
    const traffic = new Traffic();
    settleWindows = () => traffic.settled();
    const errors: string[] = [];
    for (const [n, p] of Object.entries(pages)) {
      p.setDefaultTimeout(15_000);
      p.on('pageerror', (e) => errors.push(`${n}: ${e.message.slice(0, 200)}`));
      traffic.attach(p, n);
    }
    const cdps = new Map<Page, import('@playwright/test').CDPSession>();
    /** The latency each page's throttle has now (hotel WiFi moves it: jitter), and whether its link is down. */
    const latencyNow = new Map<Page, number>();
    const offlineNow = new Map<Page, boolean>();
    const conditions = (offline: boolean, latency?: number) => {
      const prof = PROFILES[PROFILE];
      const bps = prof ? (prof.mbit * 1_000_000) / 8 : -1;
      return { offline, latency: latency ?? prof?.latency ?? 0, downloadThroughput: bps, uploadThroughput: bps };
    };
    // Every page gets the throttle, unthrottled on loopback: its `offline` cuts the open event stream too, where the
    // context's own offline leaves it up (a window that draws records in place then misses nothing, and LV-16's drop
    // would not hold).
    const throttle = async (p: Page) => {
      const cdp = await p.context().newCDPSession(p);
      cdps.set(p, cdp);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', conditions(false));
    };
    /** The page's link down or up: through its throttle when it has one (the throttle's own `offline: false` wins over the context's). */
    const setLink = async (p: Page, offline: boolean) => {
      offlineNow.set(p, offline);
      if (p === dropping) {
        if (offline) linkProxy!.down();
        else linkProxy!.up();
      }
      const cdp = cdps.get(p);
      if (cdp) await cdp.send('Network.emulateNetworkConditions', conditions(offline, latencyNow.get(p)));
      else await p.context().setOffline(offline);
    };
    const setLatency = async (p: Page, ms: number) => {
      latencyNow.set(p, ms);
      await cdps.get(p)?.send('Network.emulateNetworkConditions', conditions(offlineNow.get(p) ?? false, ms));
    };
    for (const p of Object.values(pages)) await throttle(p);
    const go = async (p: Page) => {
      await p.goto(`${p === dropping ? proxied : base}/${QUERY}`, { waitUntil: 'commit', timeout: 300_000 });
      await p.waitForSelector('.ib-lbody [data-thread-id]', { timeout: 300_000 });
    };
    /** A cold tab's bytes until its list painted: everything (page, scripts, reads), and the API reads alone. */
    const addFirstPaintBytes = async (bytes: ReturnType<typeof pageBytes>) => {
      const b = await bytes.until(Date.now());
      add('firstPaintBytes', 'bytes', b.all);
      add('firstPaintApiBytes', 'bytes', b.api);
    };
    const openThread = async (p: Page, id: string) => {
      await p.evaluate((id) => (location.hash = `#thread=${encodeURIComponent(id)}`), id);
      await p.waitForSelector(`${paneSel(id)} [data-message-article]`, { timeout: 60_000 });
    };
    const toList = async (p: Page) => {
      await p.evaluate(() => (location.hash = ''));
      await p.waitForFunction(() => !document.querySelector('section.ib-pane'), null, { timeout: 15_000 }).catch(() => {});
    };
    /** Bring held news in (the notice's Show), so the next check starts from a settled list. */
    const showNews = async (p: Page) => {
      const n = await p.$('[data-inbox-notice]');
      if (n) await n.click().catch(() => {});
      await pause(300);
    };
    const deepDeps = {
      A,
      log,
      check,
      add,
      get,
      post,
      listPath: LIST,
      newThread,
      threads: { snz: T.snz!, long: world.longThread },
      arm,
      landed,
      traffic,
      aName: 'A',
      rowSel,
      paneSel,
      toList,
      showNews,
    };
    const rowOrder = (p: Page) => p.evaluate(() => [...document.querySelectorAll('.ib-lbody [data-thread-id]')].map((e) => e.getAttribute('data-thread-id')));
    const markCards = (p: Page, id: string) =>
      p.evaluate((sel) => {
        const cards = [...document.querySelectorAll(`${sel} fieldset[data-question-key]`)];
        cards.forEach((c, i) => c.setAttribute('data-lv-card', String(i)));
        return cards.length;
      }, paneSel(id));
    const clickOption = (p: Page, id: string, card: number, n: number) =>
      p.evaluate(({ sel, card, n }) => (document.querySelectorAll(`${sel} [data-lv-card="${card}"] [data-question-option]`)[n] as HTMLElement | undefined)?.click() !== undefined, { sel: paneSel(id), card, n });
    const checkedIndex = (id: string, card: number) => `[...document.querySelectorAll('${paneSel(id)} [data-lv-card="${card}"] [data-question-option]')].findIndex((o) => !!o.querySelector('input:checked'))`;

    if (PROFILE === 'hotel') {
      // Hotel WiFi: one desktop page, its three checks (hotel.ts); the other checks' budgets are for good links.
      t = Date.now();
      const bytesA = pageBytes(A);
      await go(A);
      add('firstListPaint', 'ms', Date.now() - t);
      await addFirstPaintBytes(bytesA);
      await runHotel({
        A,
        base,
        log,
        check,
        add,
        get,
        post,
        agentSend: (threadId, body) => ag.send({ project_path: project, reply_to: threadId, body }),
        threads: { hotel: T.hotel!, open: T.open!, read: T.read!, arch: T.arch! },
        setLink,
        setLatency,
        openThread,
        paneSel,
        rowSel,
      });
      // LV-24..27 on the same bad link (jitter and loss again), on A alone: a link opens in place (a reload would
      // fetch the whole page again over 1 Mbit).
      const stop = await hotelLink(A, { setLatency }, 9);
      try {
        await runDeepChecks({ ...deepDeps, L: A, C: A, freshLoad: null, budgetMs: 10_000, longOpenMs: 15_000 });
      } finally {
        await stop();
      }
    } else {
      log('setup done; first paint and thread open');
      // ---- First paint and thread open (stats only) ----
      for (const [n, p] of Object.entries(pages)) {
        t = Date.now();
        const bytes = pageBytes(p);
        await go(p);
        if (n === 'A') {
          add('firstListPaint', 'ms', Date.now() - t);
          await addFirstPaintBytes(bytes);
        }
      }
      for (let i = 1; i < RUNS; i++) {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const p = await ctx.newPage();
        await throttle(p);
        t = Date.now();
        const bytes = pageBytes(p);
        await go(p);
        add('firstListPaint', 'ms', Date.now() - t);
        await addFirstPaintBytes(bytes);
        await ctx.close();
      }
      for (let i = 0; i < RUNS; i++) {
        const id = i % 2 ? T.open! : T.scroll!;
        await toList(A);
        await pause(300);
        t = Date.now();
        const row = await A.$(rowSel(id));
        if (row) await row.click();
        else await A.evaluate((id) => (location.hash = `#thread=${encodeURIComponent(id)}`), id);
        await A.waitForSelector(`${paneSel(id)} [data-message-article]`, { timeout: 60_000 });
        add('threadOpen', 'ms', Date.now() - t);
      }
      await toList(A);
      await showNews(A);
      await showNews(B);
      await showNews(C);
      await showNews(P);

      log('stats: agent messages');
      // ---- Stats: agent message → second window, list row, unread count; requests and bytes per event ----
      await openThread(A, T.open!);
      await openThread(B, T.open!);
      await openThread(P, T.open!);
      await pause(1000);
      for (let i = 0; i < RUNS; i++) {
        const token = `zebra-${i}-${Date.now() % 100000}`;
        const n = await A.evaluate(new Function(`return ${msgCount(T.open!)}`) as () => number);
        for (const p of [A, B, P]) await arm(p, `m${i}`, `return ${msgCount(T.open!)} > ${n}`);
        // An agent message in a thread C lists: by design the row waits and "N new" says so (held list).
        await showNews(C);
        await arm(C, `m${i}`, `return !!document.querySelector('[data-inbox-notice]')`);
        const t0 = Date.now();
        // The same agent writes into the thread open in A, B and P, and into one that C's list shows (an unread row stays in view).
        await Promise.all([ag.send({ project_path: project, reply_to: T.open!, body: `Note ${token}.` }), ag.send({ project_path: project, reply_to: T.rowc!, body: `Row note ${token}.` })]);
        add('agentMsgToOpenThreadSameTab', 'ms', await landed(A, `m${i}`, t0));
        add('agentMsgToOpenThreadSecondTab', 'ms', await landed(B, `m${i}`, t0));
        add('agentMsgToOpenThreadPhone', 'ms', await landed(P, `m${i}`, t0));
        add('agentMsgToOtherDeviceNotice', 'ms', await landed(C, `m${i}`, t0));
        await pause(1500);
      }
      // Requests and bytes one agent message costs: every window's reads in the 2.5 s after it (A, B and P show that thread; C lists it).
      // Where one event's time goes in the list window C (and A, the thread beside its list): main-thread work while
      // the record is applied and the list read lands (spike X1, plan B6's "list commit ms per event").
      const splits: EventSplit[] = [];
      for (let i = 0; i < RUNS; i++) {
        await pause(1500);
        const cpu = i === 0 ? process.env.LIVE_CPU_PROFILE : undefined;
        const probeC = await eventSplit(C, cdps.get(C)!, cpu ? join(cpu, `${SIZE}-${PROFILE}-C.cpuprofile`) : undefined);
        const probeA = await eventSplit(A, cdps.get(A)!);
        const t0 = Date.now();
        await ag.send({ project_path: project, reply_to: T.open!, body: `Cost probe ${i}.` });
        await pause(2500);
        const tr = traffic.between(t0, t0 + 2500);
        add('requestsPerAgentMsg_4windows', 'count', tr.count);
        add('bytesPerAgentMsg_4windows', 'bytes', tr.bytes);
        if (i === 0) out.trafficExample = tr;
        const c = await probeC.end(t0);
        const a = await probeA.end(t0);
        splits.push({ ...c, window: 'C' }, { ...a, window: 'A' });
        add('listCommitMsPerEvent', 'ms', c.longTaskMs);
        add('listBusyMsPerEvent', 'ms', c.taskMs);
        add('listReadWaitMsPerEvent', 'ms', c.listReads.reduce((n, r) => n + r.waitMs, 0));
      }
      out.eventSplit = splits;
      log('stats: new threads');
      // New unread thread → the tab count of a list window (C), and the held notice.
      for (let i = 0; i < RUNS; i++) {
        await showNews(C);
        const title = await C.title();
        await arm(C, `t${i}`, `return document.title !== ${JSON.stringify(title)}`);
        await arm(C, `h${i}`, `return !!document.querySelector('[data-inbox-notice]')`);
        const t0 = Date.now();
        await newThread(`count${i}`, `Count ${i}.`);
        add('agentNewThreadToTabCount', 'ms', await landed(C, `t${i}`, t0));
        add('agentNewThreadToHeldNotice', 'ms', await landed(C, `h${i}`, t0));
        await pause(600);
      }

      // ---- Rules ----
      await check('LV-01', 'An agent message reaches the open thread in this tab, a second tab and a phone, within budget', async () => {
        const s = (k: string) => samples[k]!.xs;
        const worst = Math.max(...s('agentMsgToOpenThreadSameTab'), ...s('agentMsgToOpenThreadSecondTab'), ...s('agentMsgToOpenThreadPhone'));
        const missed = [...s('agentMsgToOpenThreadSameTab'), ...s('agentMsgToOpenThreadSecondTab'), ...s('agentMsgToOpenThreadPhone')].filter((x) => x < 0).length;
        return { pass: missed === 0 && worst <= BUDGET_MS, ms: worst, detail: { missed } };
      });
      await check('LV-02', 'An agent message in a listed thread shows on another device as "N new" (the row waits, by design), within budget', async () => {
        const xs = samples.agentMsgToOtherDeviceNotice!.xs;
        const worst = Math.max(...xs);
        return { pass: !xs.some((x) => x < 0) && worst <= BUDGET_MS, ms: worst };
      });
      await check('LV-04', 'A new unread thread changes the tab title count of a list window, within budget', async () => {
        const xs = samples.agentNewThreadToTabCount!.xs;
        return { pass: !xs.some((x) => x < 0) && Math.max(...xs) <= BUDGET_MS, ms: Math.max(...xs), detail: { title: await C.title() } };
      });

      await check('LV-03', 'News never reorders the list on screen: a new thread waits behind "N new", the rows keep their order, Show brings it in', async () => {
        await showNews(C);
        await pause(800);
        const before = await rowOrder(C);
        await arm(C, 'h3', `return !!document.querySelector('[data-inbox-notice]')`);
        const t0 = Date.now();
        const id = await newThread('heldcheck', 'Held check.');
        const ms = await landed(C, 'h3', t0);
        await pause(600);
        const after = await rowOrder(C);
        const shownEarly = after.includes(id);
        const sameOrder = JSON.stringify(before) === JSON.stringify(after);
        await showNews(C);
        await pause(500);
        const brought = (await rowOrder(C)).includes(id);
        return { pass: ms >= 0 && ms <= BUDGET_MS && sameOrder && !shownEarly && brought, ms, detail: { sameOrder, shownEarly, brought } };
      });

      log('stats: picks');
      // Picks across tabs (stat + rule).
      for (let i = 0; i < RUNS; i++) {
        const id = T[`pick${i}`]!;
        await openThread(A, id);
        await openThread(B, id);
        await pause(500);
        await markCards(A, id);
        await markCards(B, id);
        await arm(B, `p${i}`, `return ${checkedIndex(id, 0)} === 1`);
        await arm(A, `pa${i}`, `return ${checkedIndex(id, 0)} === 1`);
        const t0 = Date.now();
        await clickOption(A, id, 0, 1);
        add('pickPaintSameTab', 'ms', await landed(A, `pa${i}`, t0));
        add('pickToSecondTab', 'ms', await landed(B, `p${i}`, t0));
      }
      await check('LV-05', 'A pick in one tab shows in the other tab, within budget', async () => {
        const xs = samples.pickToSecondTab!.xs;
        return { pass: !xs.some((x) => x < 0) && Math.max(...xs) <= BUDGET_MS, ms: Math.max(...xs) };
      });

      await check('LV-06', 'Words typed in "Other" in one tab reach the other tab and never go backwards there', async () => {
        const id = T.pick0!;
        const sel = `${paneSel(id)} [data-lv-card="1"] [aria-label^="Other answer"]`;
        await openThread(A, id);
        await openThread(B, id);
        await markCards(A, id);
        await markCards(B, id);
        if (!(await A.$(sel))) return { pass: false, detail: 'no Other box on the card' };
        const WORDS = 'keep the totals pinned at the bottom';
        await B.evaluate((sel) => {
          const w = window as any;
          w.__vals = [];
          let last: string | null = null;
          const tick = () => {
            const v = (document.querySelector(sel) as HTMLInputElement | null)?.value ?? '';
            if (v !== last) w.__vals.push(v), (last = v);
            if (w.__vals.length < 500) requestAnimationFrame(tick);
          };
          tick();
        }, sel);
        await arm(B, 'o6', `return document.querySelector('${sel}')?.value === ${JSON.stringify(WORDS)}`);
        await A.click(sel);
        await A.keyboard.type(WORDS, { delay: 35 });
        const lastKey = Date.now();
        const ms = await landed(B, 'o6', lastKey);
        const vals: string[] = await B.evaluate(() => (window as any).__vals);
        const backwards = vals.filter((v, i) => i > 0 && !v.startsWith(vals[i - 1]!)).length;
        return { pass: ms >= 0 && ms <= BUDGET_MS && backwards === 0, ms, detail: { backwards, steps: vals.length } };
      });

      log('stats: drafts');
      // Reply draft: typed in A, saved on the server, shown in B (stat + rule).
      for (let i = 0; i < Math.min(RUNS, 3); i++) {
        const id = T[`draft${i}`]!;
        await openThread(A, id);
        await openThread(B, id);
        await pause(400);
        const foot = A.locator('.ib-pfoot');
        const edit = foot.getByRole('button', { name: /^(Reply|Edit draft)$/ });
        if (await edit.count()) await edit.first().click();
        const box = A.getByRole('textbox', { name: /^Reply to/ });
        await box.waitFor({ timeout: 10_000 });
        const words = `draft ${i} from tab A ${Date.now() % 10000}`;
        await box.fill('');
        // B (the thread open, its box closed) shows the foot's Edit draft; C's list row says Draft.
        await arm(B, `d${i}`, `return [...document.querySelectorAll('.ib-pfoot button')].some((b) => b.textContent?.trim() === 'Edit draft') || [...document.querySelectorAll('${paneSel(id)} textarea')].some((x) => x.value === ${JSON.stringify(words)})`);
        await arm(C, `dc${i}`, `return /Draft/.test(document.querySelector('${rowSel(id)}')?.textContent ?? '')`);
        await box.pressSequentially(words, { delay: 20 });
        const lastKey = Date.now();
        let saved = -1;
        for (let k = 0; k < 200; k++) {
          const d = await get(`/threads/${encodeURIComponent(id)}/draft`).catch(() => null);
          if (d?.draft?.body === words) {
            saved = Date.now() - lastKey;
            break;
          }
          await pause(25);
        }
        add('draftSavedOnServerAfterLastKey', 'ms', saved);
        add('draftShownInSecondTabAfterLastKey', 'ms', await landed(B, `d${i}`, lastKey, 8000));
        add('draftShownInOtherDeviceRowAfterLastKey', 'ms', await landed(C, `dc${i}`, lastKey, 8000));
        await A.keyboard.press('Escape').catch(() => {});
      }
      await check('LV-07', 'A reply draft typed in one tab is saved and shows in the other tab (pause + budget)', async () => {
        const s = samples.draftSavedOnServerAfterLastKey!.xs;
        const b = [...samples.draftShownInSecondTabAfterLastKey!.xs, ...samples.draftShownInOtherDeviceRowAfterLastKey!.xs];
        // The box saves after a typing pause (500 ms): the budget counts from the last key and includes it.
        const worst = Math.max(...s, ...b);
        return { pass: !s.some((x) => x < 0) && !b.some((x) => x < 0) && worst <= 500 + BUDGET_MS, ms: worst, detail: { saved: s, shown: b } };
      });

      await check('LV-08', 'Words being typed in the reply box are never moved or overwritten by an agent message arriving in that thread', async () => {
        const id = T.type!;
        await openThread(A, id);
        const edit = A.locator('.ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)$/ });
        if (await edit.count()) await edit.first().click();
        const box = A.getByRole('textbox', { name: /^Reply to/ });
        await box.waitFor({ timeout: 10_000 });
        const words = 'I am typing a long reply while the agent keeps writing in this very thread';
        const typing = box.pressSequentially(words, { delay: 30 });
        await pause(400);
        await ag.send({ project_path: project, reply_to: id, body: 'An interruption one.' });
        await pause(300);
        await ag.send({ project_path: project, reply_to: id, body: 'An interruption two.' });
        await typing;
        await pause(1500);
        const value = await box.inputValue();
        const focused = await A.evaluate(() => document.activeElement?.tagName === 'TEXTAREA');
        return { pass: value === words && focused, detail: { value, focused } };
      });

      await check('LV-21', 'Scrolled up in a long thread, an arriving message does not move the words on screen; at the end, it is brought into view', async () => {
        // Two cases. Scrolled up, away from the end: the words on screen stay put. At the end: the window follows the
        // arrival (Thread.tsx scrolls just far enough to show its first lines), so a move there is right; the check is
        // that the new message is in view.
        const id = T.scroll!;
        const pane = paneSel(id);
        const body = `${pane} .ib-pbody`;
        await openThread(A, id);
        await pause(800);
        // Read messages open folded (a run of them behind "Show all", each one a line); unfold them so the thread is longer
        // than the view and has room to scroll up.
        for (let i = 0; i < 40; i++) {
          const opened = await A.evaluate((sel) => {
            const next = document.querySelector(`${sel} [data-fold-all], ${sel} button.ib-fline[aria-expanded="false"]`) as HTMLElement | null;
            next?.click();
            return !!next;
          }, pane);
          if (!opened) break;
          await pause(150);
        }
        await pause(600);
        const fromEnd = () =>
          A.evaluate((sel) => {
            const b = document.querySelector(sel) as HTMLElement | null;
            return b ? Math.round(b.scrollHeight - b.scrollTop - b.clientHeight) : null;
          }, body);
        const arrive = async (text: string) => {
          const n = await A.evaluate(new Function(`return ${msgCount(id)}`) as () => number);
          await ag.send({ project_path: project, reply_to: id, body: text });
          await A.waitForFunction(new Function(`return ${msgCount(id)} > ${n}`) as () => boolean, null, { timeout: 15_000 }).catch(() => {});
          await pause(2000);
        };
        // The wheel goes to the thread's own scroller.
        const box = await A.locator(body).boundingBox();
        if (!box) return { pass: false, detail: 'no thread body' };
        await A.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

        // 1. Scrolled up by hand (a wheel), away from the end, left still: an arrival below moves nothing on screen.
        await A.evaluate((sel) => {
          const b = document.querySelector(sel) as HTMLElement;
          b.scrollTop = b.scrollHeight;
        }, body);
        await pause(600);
        await A.mouse.wheel(0, -600);
        await pause(2000);
        const awayFromEnd = await fromEnd();
        await A.evaluate((sel) => {
          const b = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
          const arts = [...document.querySelectorAll(`${sel} [data-message-article]`)] as HTMLElement[];
          const mid = b.top + b.height / 2;
          const inView = arts.find((a) => a.getBoundingClientRect().top <= mid && a.getBoundingClientRect().bottom >= mid) ?? arts[0];
          document.querySelector('[data-lv-anchor]')?.removeAttribute('data-lv-anchor');
          inView?.setAttribute('data-lv-anchor', '');
        }, body);
        const top = () => A.evaluate(() => (document.querySelector('[data-lv-anchor]') as HTMLElement | null)?.getBoundingClientRect().top ?? null);
        const still1 = await top();
        await pause(1000);
        const before = await top();
        await arrive('Arrives below while the person reads above.');
        const after = await top();
        // Away from the end means past the window's own "at the end" line (seenOnSight.ts AT_END_PX, 24 px).
        const away = awayFromEnd !== null && awayFromEnd > 24;
        const steady = still1 !== null && before !== null && Math.abs(still1 - before) < 2;
        const upHeld = away && steady && after !== null && Math.abs(after - before!) < 2;

        // 2. At the end: the arrival is brought into view (its first lines inside the thread's box).
        await A.mouse.wheel(0, 100_000);
        await pause(1500);
        const endBefore = await fromEnd();
        await arrive('Arrives while the person is at the end.');
        const shown = await A.evaluate((sel) => {
          const b = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
          const arts = [...document.querySelectorAll(`${sel} [data-message-article]`)] as HTMLElement[];
          const last = arts[arts.length - 1]?.getBoundingClientRect();
          return last ? { top: Math.round(last.top), viewTop: Math.round(b.top), viewBottom: Math.round(b.bottom) } : null;
        }, body);
        const atEnd = endBefore !== null && endBefore <= 24;
        const followed = atEnd && !!shown && shown.top >= shown.viewTop && shown.top + 24 <= shown.viewBottom;
        return { pass: upHeld && followed, detail: { up: { awayFromEnd, still1, before, after, steady }, end: { endBefore, shown } } };
      });

      await check('LV-20', 'A message that arrives in view in the open thread counts as seen by itself (the server says so)', async () => {
        const id = T.open!;
        await openThread(A, id);
        await A.bringToFront();
        await pause(800);
        const t0 = Date.now();
        await ag.send({ project_path: project, reply_to: id, body: 'Seen on sight check.' });
        let ms = -1;
        for (let k = 0; k < 160; k++) {
          const r = await serverRow(id);
          if (r && r.unseen === 0 && Date.now() - t0 > 100) {
            ms = Date.now() - t0;
            break;
          }
          await pause(50);
        }
        return { pass: ms >= 0 && ms <= 4000, ms };
      });

      // Actions made elsewhere (HTTP: what another window or the phone sends), seen on the other device's list (C) and the phone (P).
      await toList(A);
      await toList(B);
      await toList(P);
      await showNews(C);
      await showNews(P);
      await pause(800);
      const firstMessageId = async (id: string) => (await get(`/threads/${encodeURIComponent(id)}`)).thread.messages[0].id as string;

      await check('LV-09', 'Archive in another window shows on another device and the phone (row gone or shown archived), within budget', async () => {
        // Gone from the list, or shown archived in place (the held list keeps the row): either tells the person.
        const gone = `return !document.querySelector('${rowSel(T.arch!)}') || document.querySelector('${rowSel(T.arch!)}')?.hasAttribute('data-archived') === true`;
        await arm(C, 'a9', gone);
        await arm(P, 'a9', gone);
        const mid = await firstMessageId(T.arch!);
        const t0 = Date.now();
        const r = await post(`/messages/${mid}/resolve`, { resolved: true });
        const c = await landed(C, 'a9', t0);
        const p = await landed(P, 'a9', t0);
        return { pass: r.status === 200 && c >= 0 && p >= 0 && Math.max(c, p) <= BUDGET_MS, ms: Math.max(c, p), detail: { status: r.status, C: c, P: p } };
      });
      await check('LV-10', 'Mark read in another window unbolds the row on another device, within budget', async () => {
        const bold = await C.evaluate((s) => document.querySelector(s)?.classList.contains('ib-u') ?? null, rowSel(T.read!));
        await arm(C, 'r10', `return document.querySelector('${rowSel(T.read!)}')?.classList.contains('ib-u') === false`);
        const t0 = Date.now();
        const r = await post(`/threads/${T.read}/read`, {});
        const ms = await landed(C, 'r10', t0);
        return { pass: bold === true && r.status === 200 && ms >= 0 && ms <= BUDGET_MS, ms, detail: { boldBefore: bold, status: r.status } };
      });
      await check('LV-11', 'A pin made in another window shows on another device, within budget', async () => {
        // The sidebar's Pinned section names the thread (its thread name).
        await arm(C, 'p11', `return (document.querySelector('[data-pinned-section]')?.textContent ?? '').includes('live-pins')`);
        const t0 = Date.now();
        const r = await post(`/threads/${T.pins}/pin`, { pinned: true });
        const ms = await landed(C, 'p11', t0);
        return { pass: r.status === 200 && ms >= 0 && ms <= BUDGET_MS, ms, detail: { status: r.status } };
      });
      await check('LV-12', 'A snooze made in another window moves that row on another device, within budget', async () => {
        const where = `(document.querySelector('${rowSel(T.snooze!)}')?.getAttribute('data-section') ?? 'gone')`;
        const before = await C.evaluate(new Function(`return ${where}`) as () => string);
        await arm(C, 's12', `return ${where} !== ${JSON.stringify(before)}`);
        const t0 = Date.now();
        const r = await post(`/threads/${T.snooze}/snooze`, { until: new Date(Date.now() + 3 * 3600_000).toISOString() });
        const ms = await landed(C, 's12', t0);
        return { pass: r.status === 200 && ms >= 0 && ms <= BUDGET_MS, ms, detail: { before, after: await C.evaluate(new Function(`return ${where}`) as () => string) } };
      });
      await check('LV-13', 'An agent archiving its own thread shows on another device and the phone (row gone or shown archived), within budget', async () => {
        // Gone from the list, or shown archived in place (the held list keeps the row): either tells the person.
        const gone = `return !document.querySelector('${rowSel(T.resolve!)}') || document.querySelector('${rowSel(T.resolve!)}')?.hasAttribute('data-archived') === true`;
        await arm(C, 'x13', gone);
        await arm(P, 'x13', gone);
        const mid = await firstMessageId(T.resolve!);
        const t0 = Date.now();
        await ag.resolve(mid);
        const c = await landed(C, 'x13', t0);
        const p = await landed(P, 'x13', t0);
        return { pass: c >= 0 && p >= 0 && Math.max(c, p) <= BUDGET_MS, ms: Math.max(c, p), detail: { C: c, P: p } };
      });
      await check('LV-14', 'A capability switched on in another window (the Board) appears on another device without a reload', async () => {
        const has = `[...document.querySelectorAll('a,button,[role="link"],[role="button"]')].some((e) => /^Board\\b/.test(e.textContent?.trim() ?? ''))`;
        const before = await C.evaluate(new Function(`return ${has}`) as () => boolean);
        await arm(C, 'c14', `return ${has} !== ${before}`);
        const t0 = Date.now();
        const r = await post('/settings', { board: { on: !before } });
        const ms = await landed(C, 'c14', t0, 8000);
        await post('/settings', { board: { on: before } });
        return { pass: r.status === 200 && ms >= 0 && ms <= BUDGET_MS, ms, detail: { status: r.status, body: r.text.slice(0, 120), boardBefore: before } };
      });
      await check('LV-15', "A rows look saved in another window (Roomy) reaches another device's list at once", async () => {
        const look = `[...(document.querySelector('.ib-listcol')?.classList ?? [])].includes('ib-lk-roomy')`;
        const before = await C.evaluate(new Function(`return ${look}`) as () => boolean);
        await arm(C, 'l15', `return ${look}`);
        const t0 = Date.now();
        const r = await post('/settings', { rows: ['roomy'] });
        const ms = await landed(C, 'l15', t0, 8000);
        await post('/settings', { rows: [] });
        return { pass: before === false && r.status === 200 && ms >= 0 && ms <= BUDGET_MS, ms, detail: { status: r.status, roomyBefore: before } };
      });
      await check('LV-23', "A reply's row follows the agent reading it, in place, on another device (Sent: saved → read)", async () => {
        const id = T.sent!;
        await openThread(A, id);
        const edit = A.locator('.ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)$/ });
        if (await edit.count()) await edit.first().click();
        const box = A.getByRole('textbox', { name: /^Reply to/ });
        await box.waitFor({ timeout: 10_000 });
        await box.fill('Here is my answer for the row check.');
        await A.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
        const tick = `(document.querySelector('${rowSel(id)} .ib-tick')?.getAttribute('data-tick') ?? null)`;
        // Wait for C to show the Sent row with its saved tick (the person's own Send, from another window).
        await C.waitForFunction(new Function(`return ${tick} !== null`) as () => boolean, null, { timeout: 15_000 }).catch(() => {});
        const before = await C.evaluate(new Function(`return ${tick}`) as () => string | null);
        await arm(C, 'd23', `return ${tick} !== ${JSON.stringify(before)}`);
        const t0 = Date.now();
        await ag.readThread(id);
        const ms = await landed(C, 'd23', t0, 8000);
        return { pass: before !== null && ms >= 0 && ms <= BUDGET_MS, ms, detail: { before, after: await C.evaluate(new Function(`return ${tick}`) as () => string | null) } };
      });
      await toList(A);

      await check('LV-22', 'A new question raises exactly one notification across two tabs of one browser', async () => {
        await A.evaluate(() => ((window as any).__notes = []));
        await B.evaluate(() => ((window as any).__notes = []));
        await newThread('notify', QUESTIONS('notify'));
        await pause(4000);
        const a = await A.evaluate(() => (window as any).__notes.length);
        const b = await B.evaluate(() => (window as any).__notes.length);
        return { pass: a + b === 1, detail: { A: a, B: b } };
      });

      // ---- Consistency ----
      await check('LV-17', 'Two tabs picking different answers on one question 50 ms apart end showing the same answer as the server', async () => {
        const id = T.race!;
        await openThread(A, id);
        await openThread(B, id);
        await pause(600);
        await markCards(A, id);
        await markCards(B, id);
        await clickOption(A, id, 0, 0);
        await pause(50);
        await clickOption(B, id, 0, 1);
        await pause(4000);
        const a = await A.evaluate(new Function(`return ${checkedIndex(id, 0)}`) as () => number);
        const b = await B.evaluate(new Function(`return ${checkedIndex(id, 0)}`) as () => number);
        const q = (await get(`/threads/${encodeURIComponent(id)}`)).thread.messages[0].questions?.[0];
        const label = q?.answer?.selected?.[0] ?? null;
        const server = label === null ? -1 : /Cards/i.test(String(label)) || label === 0 ? 0 : 1;
        const errA = await A.evaluate((sel) => document.querySelector(sel)?.textContent?.match(/changed since you read it[^.]*\./)?.[0] ?? null, paneSel(id));
        const errB = await B.evaluate((sel) => document.querySelector(sel)?.textContent?.match(/changed since you read it[^.]*\./)?.[0] ?? null, paneSel(id));
        return { pass: a === b && a === server, detail: { A: a, B: b, server, serverAnswer: q?.answer ?? null, errA, errB } };
      });
      await check('LV-18', 'Rapid alternating pin and unpin from several writers: every window ends on the server state', async () => {
        await toList(A);
        await toList(B);
        for (let i = 0; i < 7; i++) void post(`/threads/${T.pins2}/pin`, { pinned: i % 2 === 0 });
        await pause(3500);
        const pins = (await get(LIST)).pins?.map((p: any) => p.thread_id) ?? [];
        const serverPinned = pins.includes(T.pins2);
        const shown = async (p: Page) => p.evaluate(() => (document.querySelector('[data-pinned-section]')?.textContent ?? '').includes('live-pins2'));
        const counts = { A: await shown(A), B: await shown(B), C: await shown(C) };
        // Every window's Pinned section agrees with the server.
        return { pass: Object.values(counts).every((x) => x === serverPinned), detail: { serverPinned, shownPinned: counts } };
      });

      log('stats: reconnect');
      // Reconnect after the stream drops (stat + rule): C goes offline, the agent writes, C comes back.
      for (let i = 0; i < Math.min(RUNS, 3); i++) {
        await showNews(C);
        await openThread(C, T.open!);
        await pause(500);
        const n = await C.evaluate(new Function(`return ${msgCount(T.open!)}`) as () => number);
        await setLink(C, true);
        await ag.send({ project_path: project, reply_to: T.open!, body: `While away ${i}.` });
        await pause(8000);
        // The drop must have held: the message is not on screen yet (a 0 ms catch-up would mean the link never went down).
        add('reconnectDropHeld', 'count', (await C.evaluate(new Function(`return ${msgCount(T.open!)}`) as () => number)) === n ? 1 : 0);
        await arm(C, `g${i}`, `return ${msgCount(T.open!)} > ${n}`, 120_000);
        const t0 = Date.now();
        await setLink(C, false);
        add('reconnectCatchUp', 'ms', await landed(C, `g${i}`, t0, 125_000));
      }
      await toList(C);
      await check('LV-16', 'After the stream drops and comes back, a window catches up on what it missed with no reload (within 10 s)', async () => {
        const xs = samples.reconnectCatchUp!.xs;
        const held = samples.reconnectDropHeld!.xs.every((x) => x === 1);
        return { pass: held && !xs.some((x) => x < 0) && Math.max(...xs) <= 10_000, ms: Math.max(...xs), detail: held ? undefined : 'the link drop did not hold: nothing was missed' };
      });

      // Network held: every API write from tab A is left unanswered.
      await check('LV-19a', 'With every write held unanswered, a typed key and a pick still paint at once (under 100 ms)', async () => {
        const id = T.held!;
        await openThread(A, id);
        await pause(500);
        await markCards(A, id);
        const held: { route: any }[] = [];
        await A.route('**/api/inbox/**', (route) => (route.request().method() === 'POST' ? held.push({ route }) : route.continue()));
        try {
          // Three picks (first, second, first choice): the median, so one slow frame does not decide.
          const picks: number[] = [];
          for (const [k, n] of [0, 1, 0].entries()) {
            await arm(A, `k19-${k}`, `return ${checkedIndex(id, 0)} === ${n}`);
            const t0 = Date.now();
            await clickOption(A, id, 0, n);
            picks.push(await landed(A, `k19-${k}`, t0));
            await pause(150);
          }
          const pick = picks.includes(-1) ? -1 : [...picks].sort((x, y) => x - y)[1]!;
          const sel = `${paneSel(id)} [data-lv-card="1"] [aria-label^="Other answer"]`;
          let key = -1;
          if (await A.$(sel)) {
            await A.click(sel);
            await arm(A, 'k19b', `return document.querySelector('${sel}')?.value === 'x'`);
            const t1 = Date.now();
            await A.keyboard.type('x');
            key = await landed(A, 'k19b', t1);
          }
          return { pass: pick >= 0 && pick <= 100 && key >= 0 && key <= 100, ms: Math.max(pick, key), detail: { picks, key, held: held.length } };
        } finally {
          await A.unroute('**/api/inbox/**');
          for (const h of held) await h.route.continue().catch(() => {});
        }
      });
      await check('LV-19b', 'With every write held unanswered, Send shows the sent message in the thread at once (under 200 ms)', async () => {
        const id = T.held!;
        await openThread(A, id);
        const edit = A.locator('.ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)$/ });
        if (await edit.count()) await edit.first().click();
        const box = A.getByRole('textbox', { name: /^Reply to/ });
        await box.waitFor({ timeout: 10_000 });
        const words = `held send ${Date.now() % 10000}`;
        await box.fill(words);
        await pause(800);
        const held: { route: any }[] = [];
        await A.route('**/api/inbox/**', (route) => (route.request().method() === 'POST' ? held.push({ route }) : route.continue()));
        try {
          await arm(A, 's19', `return [...document.querySelectorAll('${paneSel(id)} [data-message-article]')].some((m) => m.textContent?.includes(${JSON.stringify(words)}))`, 3000);
          const t0 = Date.now();
          await A.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
          const ms = await landed(A, 's19', t0, 4000);
          return { pass: ms >= 0 && ms <= 200, ms, detail: { held: held.length } };
        } finally {
          await A.unroute('**/api/inbox/**');
          for (const h of held) await h.route.continue().catch(() => {});
          await pause(1500);
        }
      });

      // LV-24..27 last, so the rows Quiet draws once opened (every one of them today) weigh on no earlier number. D is
      // a desktop of its own (its own context: Quiet's open state is a cookie), on the list.
      log('deep checks');
      const deepCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true });
      const D = await deepCtx.newPage();
      D.setDefaultTimeout(15_000);
      D.on('pageerror', (e) => errors.push(`D: ${e.message.slice(0, 200)}`));
      traffic.attach(D, 'D');
      await throttle(D);
      await go(D);
      try {
        await runDeepChecks({
          ...deepDeps,
          L: D,
          C,
          freshLoad: async (p, hash) => {
            await p.goto('about:blank');
            await p.goto(`${base}/${QUERY}${hash}`, { waitUntil: 'commit', timeout: 300_000 });
          },
          budgetMs: BUDGET_MS,
          longOpenMs: PROFILE === 'local' ? 5000 : 15_000,
        });
      } finally {
        await deepCtx.close();
      }
    }
    out.memory.rssEndMB = rssMB(pid);
    out.errors = errors;
  } finally {
    const stats: Record<string, Stat> = {};
    for (const [k, v] of Object.entries(samples)) stats[k] = summarize(v.unit, v.xs);
    if (out.memory) {
      if (out.memory.rssAfterStartMB !== null) stats.serverRssAfterStart = summarize('MB', [out.memory.rssAfterStartMB]);
      if (out.memory.rssEndMB) stats.serverRssEnd = summarize('MB', [out.memory.rssEndMB]);
    }
    out.rules = rules;
    out.stats = stats;
    out.meta.finishedAt = new Date().toISOString();
    out.meta.loadAtEnd = loadavg().map((x) => Math.round(x * 10) / 10);
    // Timings taken on a busy machine are not a baseline: a 1-minute load above the core count's 80 % marks the run.
    out.meta.provisional = Math.max(out.meta.loadAtStart[0], out.meta.loadAtEnd[0]) > cpus().length * 0.8;
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(out, null, 2));
    await agent?.close().catch(() => {});
    await linkProxy?.stop().catch(() => {});
    await browser?.close().catch(() => {});
    await removeInboxScratch();
  }
});
