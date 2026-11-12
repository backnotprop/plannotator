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
export const baselineBinary = process.env.PLANNOTATOR_E2E_BASELINE_BINARY ? resolve(process.env.PLANNOTATOR_E2E_BASELINE_BINARY) : null;
export const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'shared-events');

export interface LogEntry {
  type: 'subscribe' | 'record' | 'lead' | 'step-down' | 'steal' | 'stolen' | 'catch-up-failed';
  at: number;
  seq?: number;
  via?: 'stream' | 'channel' | 'catch-up';
  cursor?: number;
  window?: string;
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

export function stubPage(options: { noLocks?: boolean } = {}): void {
  window.__plannotatorInboxEventLog = [];
  if (options.noLocks) {
    Object.defineProperty(Navigator.prototype, 'locks', { configurable: true, get: () => undefined });
  }
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
      }
      if (!abort.signal.aborted) await new Promise((done) => setTimeout(done, 300));
    }
  })();
  return () => abort.abort();
}

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

export async function openTab(world: World, options: { url?: string; timeout?: number } = {}): Promise<{ page: Page; ms: number }> {
  const page = await world.context.newPage();
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

export async function serverSeqs(world: World): Promise<number[]> {
  const res = await fetch(new URL('/api/inbox/events?cursor=0&once=1', world.url));
  const text = await res.text();
  return [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
}

export async function leaders(pages: Page[]): Promise<Page[]> {
  const out: Page[] = [];
  for (const page of pages) {
    const log = await logOf(page);
    const last = log.filter((e) => e.type === 'lead' || e.type === 'step-down').at(-1);
    if (last?.type === 'lead') out.push(page);
  }
  return out;
}

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

export const WORK_THREAD = 'billing work';

export function keepSending(sim: SimAgent, project: string, everyMs = 60): { stop: () => Promise<number> } {
  let running = true;
  let sent = 0;
  const loop = (async () => {
    while (running) {
      await sim.send({ project_path: project, thread: WORK_THREAD, body: `Progress note ${sent + 1}: still going.` });
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
