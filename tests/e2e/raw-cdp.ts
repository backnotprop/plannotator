/**
 * A headless Chromium driven over raw CDP, for measuring memory
 * (inbox-memory-soak.spec.ts). Not for ordinary specs: use Playwright's
 * `page` there.
 *
 * Why not Playwright's page: Playwright enables the Network domain on every
 * page, and DevTools then keeps every response body in the renderer. The
 * Inbox's list and thread payloads are large, so the JS heap read through a
 * Playwright page grew with every fetch and overstated what the window holds
 * (issue #2593). This driver enables only Page, Runtime and Performance on
 * the page and never Network.
 *
 * It runs Playwright's own Chromium (`chromium.executablePath()`, the build
 * the pinned @playwright/test installs) and talks over
 * `--remote-debugging-pipe` (fd 3 in, fd 4 out, NUL-terminated JSON), so it
 * needs no WebSocket client and works on any Node the runner has.
 */
import { chromium } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

type Message = { id?: number; method?: string; params?: any; result?: any; error?: { message: string }; sessionId?: string };

export interface RawPage {
  /** A CDP call on the page's session. */
  call<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Evaluate an expression in the page (promises awaited, value returned by value). Rejects after `timeoutMs`. */
  evaluate<T = any>(expression: string, timeoutMs?: number): Promise<T>;
  /** Navigate and wait for the load event. */
  goto(url: string, timeoutMs?: number): Promise<void>;
  /** Poll `expression` until it is truthy; false after `timeoutMs`. */
  waitFor(expression: string, timeoutMs?: number): Promise<boolean>;
  /** Two forced full collections, then the JS heap in use (bytes). */
  heapAfterGc(): Promise<{ jsHeapUsed: number; nodes: number; listeners: number }>;
  close(): Promise<void>;
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function launchRawChromium(options: { width?: number; height?: number } = {}): Promise<RawPage> {
  const { width = 1440, height = 900 } = options;
  const profile = mkdtempSync(join(tmpdir(), 'plannotator-raw-cdp-'));
  const proc: ChildProcess = spawn(
    chromium.executablePath(),
    [
      '--headless',
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
      // As Playwright launches it: CI runners have no user namespaces for the sandbox.
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-extensions',
      // A page the runner's scheduler briefly hides must not have its timers throttled into fake long gaps.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--mute-audio',
      '--use-mock-keychain',
      '--password-store=basic',
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );
  const toBrowser = proc.stdio[3] as Writable;
  const fromBrowser = proc.stdio[4] as Readable;
  let next = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  const listeners = new Set<(m: Message) => void>();
  let exited = false;
  proc.on('exit', () => {
    exited = true;
    for (const p of pending.values()) p.reject(new Error(`chromium exited during ${p.method}`));
    pending.clear();
  });
  let buffer = '';
  fromBrowser.setEncoding('utf8');
  fromBrowser.on('data', (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, end)) as Message;
      buffer = buffer.slice(end + 1);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else for (const l of listeners) l(msg);
    }
  });
  const send = <T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> =>
    new Promise((resolve, reject) => {
      if (exited) return reject(new Error(`chromium is gone (${method})`));
      const id = next++;
      pending.set(id, { resolve, reject, method });
      toBrowser.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });

  const { targetInfos } = await withTimeout(send<{ targetInfos: { type: string; targetId: string }[] }>('Target.getTargets'), 30_000, 'Target.getTargets');
  const target = targetInfos.find((t) => t.type === 'page');
  if (!target) throw new Error('chromium opened no page');
  const { sessionId } = await send<{ sessionId: string }>('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const call = <T = any>(method: string, params: Record<string, unknown> = {}) => send<T>(method, params, sessionId);
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Performance.enable');
  await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await call('Emulation.setFocusEmulationEnabled', { enabled: true });

  const evaluate = async <T = any>(expression: string, timeoutMs = 30_000): Promise<T> => {
    const r = await withTimeout(call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), timeoutMs, `evaluate ${expression.slice(0, 60)}`);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  };

  return {
    call,
    evaluate,
    async goto(url, timeoutMs = 60_000) {
      let off: (() => void) | undefined;
      const loaded = new Promise<void>((done) => {
        const fn = (m: Message) => {
          if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) done();
        };
        listeners.add(fn);
        off = () => listeners.delete(fn);
      });
      try {
        await call('Page.navigate', { url });
        await withTimeout(loaded, timeoutMs, `load ${url}`);
      } finally {
        off?.();
      }
    },
    async waitFor(expression, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        // A page that stops answering fails here at the deadline too, not after evaluate's own timeout.
        if (await evaluate<boolean>(`!!(${expression})`, Math.max(1_000, deadline - Date.now()))) return true;
        await wait(100);
      }
      return false;
    },
    async heapAfterGc() {
      // Two passes: the first can leave objects that a finalizer or weak callback frees for the second.
      await withTimeout(call('HeapProfiler.collectGarbage'), 60_000, 'collectGarbage');
      await withTimeout(call('HeapProfiler.collectGarbage'), 60_000, 'collectGarbage');
      const { metrics } = await call<{ metrics: { name: string; value: number }[] }>('Performance.getMetrics');
      const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
      return { jsHeapUsed: m.JSHeapUsedSize ?? 0, nodes: m.Nodes ?? 0, listeners: m.JSEventListeners ?? 0 };
    },
    async close() {
      try {
        await withTimeout(send('Browser.close'), 5_000, 'Browser.close');
      } catch {
        // Already gone, or hung: the kill below ends it.
      }
      await wait(300);
      // inbox-guard: own child (this driver's own Chromium, never an Inbox)
      if (!exited) proc.kill('SIGKILL');
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
