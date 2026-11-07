/**
 * The world the shared-event-stream proofs run in (inbox-shared-events.spec.ts
 * in Chromium, inbox-shared-events-webkit.spec.ts in WebKit): a compiled
 * Inbox under a scratch data dir, one browser context (one browser profile,
 * so one connection pool and one origin's Web Locks and BroadcastChannel), an
 * agent writing through `plannotator inbox mcp`, and per-tab logs.
 *
 * Each tab logs what sharedEvents.ts did (`window.__plannotatorInboxEventLog`:
 * the cursor it subscribed at, each record it handled and how it came, when it
 * led). Two ground truths:
 * - the reference: one plain event stream (no window) the test holds from
 *   the start, which sees every line as it is written;
 * - the server's replay (`once=1`), which holds each record's LATEST line only
 *   (a record rewritten, a message looked at, keeps its newest line).
 * A tab is exact when its records are the reference's lines after its cursor,
 * once each and in order. A tab that took part in a handover may have
 * received a replay, which (exactly like an EventSource reconnect before this
 * change) skips the superseded lines of a record; it is right when its records
 * are in order, never twice, all real lines, and include every latest line
 * after its cursor (`expectEveryRecordOnce(..., { exact: false })`).
 * `streams(world)` is the server's count of open streams less the reference.
 *
 * Notifications are fully stubbed (no OS notification is ever raised), the
 * sound is counted (oscillators), and whether a tab is in front is set by the
 * test (`visibilityState`, `hasFocus`), every tab starting in the background.
 */

import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf } from './inbox-scratch';
import { clearSidebarPeek } from './sidebar-peek';

export const repo = resolve(__dirname, '../..');
export const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
/** A build of the code before this change (origin/main), for the proof that it stalls; that proof is skipped without it. */
export const baselineBinary = process.env.PLANNOTATOR_E2E_BASELINE_BINARY ? resolve(process.env.PLANNOTATOR_E2E_BASELINE_BINARY) : null;
export const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'shared-events');

export interface LogEntry {
  type: 'subscribe' | 'record' | 'lead' | 'step-down' | 'steal' | 'stolen' | 'catch-up-failed';
  at: number;
  seq?: number;
  via?: 'stream' | 'channel' | 'catch-up';
  cursor?: number;
  window?: string;
  /** For `lead`: the lock came in line (`queue`) or was taken from a leader that did not answer (`steal`). */
  how?: 'queue' | 'steal';
}

declare global {
  interface Window {
    __plannotatorInboxEventLog: LogEntry[];
    __notified: { title: string; silent: boolean; at: number }[];
    __sound: { oscillators: number };
    __front: { visible: boolean; focused: boolean };
  }
}

/** Runs in every page before its own code. */
export function stubPage(options: { noLocks?: boolean } = {}): void {
  window.__plannotatorInboxEventLog = [];
  if (options.noLocks) {
    Object.defineProperty(Navigator.prototype, 'locks', { configurable: true, get: () => undefined });
  }
  // Notifications: a stand-in, never the browser's (nothing reaches the OS).
  const notified: { title: string; silent: boolean; at: number }[] = [];
  window.__notified = notified;
  class FakeNotification {
    static permission: NotificationPermission = 'granted';
    static requestPermission(): Promise<NotificationPermission> {
      return Promise.resolve('granted');
    }
    onclick: (() => void) | null = null;
    constructor(title: string, opts: NotificationOptions = {}) {
      notified.push({ title, silent: opts.silent === true, at: Date.now() });
    }
    close(): void {}
  }
  (window as unknown as { Notification: unknown }).Notification = FakeNotification;
  // The sound: counted, never played.
  const sound = { oscillators: 0 };
  window.__sound = sound;
  const param = () => ({ value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  class CountingAudioContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    resume() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
    createGain() {
      return { gain: param(), connect: (to: unknown) => to };
    }
    createOscillator() {
      sound.oscillators++;
      return { type: 'sine', frequency: param(), connect: (to: unknown) => to, start() {}, stop() {} };
    }
  }
  (window as unknown as { AudioContext: unknown }).AudioContext = CountingAudioContext;
  // Every tab starts in the background; a test brings one to the front.
  const front = { visible: false, focused: false };
  window.__front = front;
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => (front.visible ? 'visible' : 'hidden') });
  Document.prototype.hasFocus = () => front.focused;
}

export interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  project: string;
  binary: string;
  context: BrowserContext;
  pages: Page[];
  agents: SimAgent[];
  errors: string[];
  /** The reference stream's lines, in order. */
  reference: number[];
  stopReference: () => void;
}

export async function newWorld(browser: Browser, options: { binary?: string; noLocks?: boolean; prefix?: string } = {}): Promise<World> {
  const root = inboxScratch(options.prefix ?? 'plannotator-inbox-shared-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
  };
  const chosen = options.binary ?? binary;
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, colorScheme: 'light' });
  await context.addInitScript(stubPage, { noLocks: options.noLocks === true });
  const world: World = {
    root,
    dataDir,
    env,
    url: '',
    project: scratchProject(join(root, 'src'), 'billing-svc'),
    binary: chosen,
    context,
    pages: [],
    agents: [],
    errors: [],
    reference: [],
    stopReference: () => {},
  };
  world.url = startInbox(world);
  world.stopReference = observe(world);
  return world;
}

/**
 * The reference: a plain event stream from the start (cursor 0, no window, as
 * the phone's door reads it), reconnecting from its last line if the Inbox
 * restarts. Every line written while it is connected, in order.
 */
function observe(world: World): () => void {
  const abort = new AbortController();
  void (async () => {
    while (!abort.signal.aborted) {
      const last = world.reference.at(-1) ?? 0;
      try {
        const res = await fetch(new URL(`/api/inbox/events?cursor=${last}`, world.url), { signal: abort.signal });
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const id = /^id: (\d+)$/m.exec(frame);
            if (id && /^event: record$/m.test(frame)) {
              const seq = Number(id[1]);
              if (seq > (world.reference.at(-1) ?? 0)) world.reference.push(seq);
            }
          }
        }
      } catch {
        // Stopped, or the Inbox restarting: try again below.
      }
      if (!abort.signal.aborted) await new Promise((done) => setTimeout(done, 300));
    }
  })();
  return () => abort.abort();
}

/** The server's open event streams, less the test's own reference stream. */
export async function streams(world: World): Promise<number> {
  return (await health(world)).event_streams - 1;
}

export function startInbox(world: World): string {
  const started = spawnSync(world.binary, ['inbox', '--background'], { env: world.env, encoding: 'utf8', timeout: 60_000 });
  rememberInboxOf(world.dataDir);
  expect(started.status, started.stderr).toBe(0);
  return started.stdout.trim();
}

export async function closeWorld(world: World): Promise<void> {
  world.stopReference();
  await Promise.all(world.agents.map((a) => a.close().catch(() => {})));
  await world.context.close().catch(() => {});
}

export async function agent(world: World, name = 'Claude Code', host = 'claude-code'): Promise<SimAgent> {
  const sim = await SimAgent.connect({ binary: world.binary, env: world.env, name, host });
  world.agents.push(sim);
  return sim;
}

/** Open a tab at `url` (the world's by default) and wait for the list; answers the tab and how long it took. */
export async function openTab(world: World, options: { url?: string; timeout?: number } = {}): Promise<{ page: Page; ms: number }> {
  const page = await world.context.newPage();
  // WebKit reports a read cut off by a tab's reload or close as "… due to access control checks": not an error of the page.
  page.on('pageerror', (error) => {
    if (!/due to access control checks/.test(error.message)) world.errors.push(error.message);
  });
  const started = Date.now();
  await page.goto(options.url ?? world.url, { timeout: options.timeout ?? 30_000 });
  await clearSidebarPeek(page);
  await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible({ timeout: options.timeout ?? 30_000 });
  const ms = Date.now() - started;
  world.pages.push(page);
  return { page, ms };
}

export function forget(world: World, page: Page): void {
  world.pages = world.pages.filter((p) => p !== page);
}

export async function logOf(page: Page): Promise<LogEntry[]> {
  return page.evaluate(() => window.__plannotatorInboxEventLog.slice());
}

export interface Health {
  event_streams: number;
  notify_reach: { enabled: boolean; windows: number; allowed: number; allowed_origins: string[] };
}

export async function health(world: World): Promise<Health> {
  const res = await fetch(new URL('/api/inbox/health', world.url));
  return (await res.json()) as Health;
}

/** Every line the server holds, by seq (the ground truth). */
export async function serverSeqs(world: World): Promise<number[]> {
  const res = await fetch(new URL('/api/inbox/events?cursor=0&once=1', world.url));
  const text = await res.text();
  return [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
}

/** The tabs that lead now (by their own logs): exactly one when the stream is shared. */
export async function leaders(pages: Page[]): Promise<Page[]> {
  const out: Page[] = [];
  for (const page of pages) {
    const log = await logOf(page);
    const last = log.filter((e) => e.type === 'lead' || e.type === 'step-down').at(-1);
    if (last?.type === 'lead') out.push(page);
  }
  return out;
}

/**
 * Wait until every tab has handled the lines after the cursor it subscribed
 * at (see the header for `exact`), then check none was handled twice.
 */
export async function expectEveryRecordOnce(
  world: World,
  pages: Page[] = world.pages,
  options: { timeout?: number; exact?: boolean } = {},
): Promise<{ total: number; perTab: number[]; exactTabs: number }> {
  const exact = options.exact ?? true;
  let latest: number[] = [];
  let exactTabs = 0;
  const perTab: number[] = [];
  await expect
    .poll(
      async () => {
        latest = await serverSeqs(world);
        const reference = world.reference.slice();
        // The reference has caught up with the store first.
        if ((reference.at(-1) ?? 0) < (latest.at(-1) ?? 0)) return 'reference behind';
        exactTabs = 0;
        for (const page of pages) {
          const log = await logOf(page);
          const cursor = log.find((e) => e.type === 'subscribe')?.cursor;
          if (cursor === undefined) return 'no subscription yet';
          const got = log.filter((e) => e.type === 'record').map((e) => e.seq!);
          const full = reference.filter((s) => s > cursor);
          const isExact = JSON.stringify(got) === JSON.stringify(full);
          if (isExact) {
            exactTabs += 1;
            continue;
          }
          if (exact) return `tab ${pages.indexOf(page)}: ${got.length} records, want ${full.length}`;
          const known = new Set(reference);
          const have = new Set(got);
          if (got.some((s, i) => i > 0 && s <= got[i - 1]!)) return `tab ${pages.indexOf(page)}: out of order or twice`;
          if (got.some((s) => !known.has(s))) return `tab ${pages.indexOf(page)}: a seq the server never wrote`;
          const missing = latest.filter((s) => s > cursor && !have.has(s));
          if (missing.length > 0) return `tab ${pages.indexOf(page)}: missing ${missing.length} latest lines (${missing.slice(0, 5).join(',')})`;
        }
        return 'ok';
      },
      { timeout: options.timeout ?? 20_000, intervals: [100, 200, 300, 500] },
    )
    .toBe('ok');
  for (const page of pages) {
    const log = await logOf(page);
    const seqs = log.filter((e) => e.type === 'record').map((e) => e.seq!);
    expect(new Set(seqs).size, 'no record handled twice').toBe(seqs.length);
    perTab.push(seqs.length);
  }
  return { total: world.reference.length, perTab, exactTabs };
}

/** Write messages continuously until stopped (each one a few store lines); answers how many went. */
export function keepSending(sim: SimAgent, project: string, everyMs = 60): { stop: () => Promise<number> } {
  let running = true;
  let sent = 0;
  const loop = (async () => {
    while (running) {
      await sim.send({ project_path: project, body: `Progress note ${sent + 1}: still going.` });
      sent += 1;
      await new Promise((done) => setTimeout(done, everyMs));
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return sent;
    },
  };
}

export const question = (prompt: string) => ['One call before I go on.', '', ':::question', prompt, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');

export async function setFront(page: Page, visible: boolean, focused: boolean): Promise<void> {
  await page.evaluate(
    ([v, f]) => {
      Object.assign(window.__front, { visible: v, focused: f });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event(f ? 'focus' : 'blur'));
    },
    [visible, focused] as const,
  );
}

export async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeout = 10_000): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (ok(value)) return { value, ms: Date.now() - started };
    if (Date.now() - started > timeout) throw new Error(`timed out after ${timeout} ms; last: ${JSON.stringify(value)}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}
