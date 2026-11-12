import { chromium } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

type Message = { id?: number; method?: string; params?: any; result?: any; error?: { message: string }; sessionId?: string };

export interface RawPage {
  call<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  evaluate<T = any>(expression: string, timeoutMs?: number): Promise<T>;
  goto(url: string, timeoutMs?: number): Promise<void>;
  waitFor(expression: string, timeoutMs?: number): Promise<boolean>;
  heapAfterGc(): Promise<{ jsHeapUsed: number; nodes: number; listeners: number }>;
  heapSnapshot(): Promise<string>;
  close(): Promise<void>;
}

const STDERR_LINES = 30;

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
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-field-trial-config',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--mute-audio',
      '--use-mock-keychain',
      '--password-store=basic',
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
  );
  const toBrowser = proc.stdio[3] as Writable;
  const fromBrowser = proc.stdio[4] as Readable;
  const stderrTail: string[] = [];
  proc.stderr!.setEncoding('utf8');
  proc.stderr!.on('data', (chunk: string) => {
    stderrTail.push(...chunk.split('\n').filter((line) => line.trim()));
    stderrTail.splice(0, Math.max(0, stderrTail.length - STDERR_LINES));
  });
  const withStderr = (message: string) => (stderrTail.length ? `${message}\nchromium stderr (last ${stderrTail.length} lines):\n${stderrTail.join('\n')}` : message);
  let next = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  const listeners = new Set<(m: Message) => void>();
  let exited = false;
  const gone = (why: string) => {
    exited = true;
    for (const p of pending.values()) p.reject(new Error(withStderr(`chromium ${why} during ${p.method}`)));
    pending.clear();
  };
  proc.on('exit', (code, signal) => gone(`exited (${signal ?? code})`));
  proc.on('error', (error) => gone(`failed to start (${error.message})`));
  toBrowser.on('error', () => {});
  fromBrowser.on('error', () => {});
  const stop = () => {
    if (!exited) proc.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
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
      if (exited) return reject(new Error(withStderr(`chromium is gone (${method})`)));
      const id = next++;
      pending.set(id, { resolve, reject, method });
      toBrowser.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });

  let sessionId: string;
  try {
    const { targetInfos } = await withTimeout(send<{ targetInfos: { type: string; targetId: string }[] }>('Target.getTargets'), 30_000, 'Target.getTargets');
    const target = targetInfos.find((t) => t.type === 'page');
    if (!target) throw new Error('chromium opened no page');
    ({ sessionId } = await send<{ sessionId: string }>('Target.attachToTarget', { targetId: target.targetId, flatten: true }));
    for (const [method, params] of [
      ['Page.enable', {}],
      ['Runtime.enable', {}],
      ['Performance.enable', {}],
      ['Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }],
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
    ] as const) {
      await send(method, params, sessionId);
    }
  } catch (error) {
    stop();
    throw new Error(withStderr(`could not start Chromium for raw CDP: ${error instanceof Error ? error.message : String(error)}`));
  }
  const call = <T = any>(method: string, params: Record<string, unknown> = {}) => send<T>(method, params, sessionId);

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
        if (await evaluate<boolean>(`!!(${expression})`, Math.max(1_000, deadline - Date.now()))) return true;
        await wait(100);
      }
      return false;
    },
    async heapAfterGc() {
      await withTimeout(call('HeapProfiler.collectGarbage'), 60_000, 'collectGarbage');
      await withTimeout(call('HeapProfiler.collectGarbage'), 60_000, 'collectGarbage');
      const { metrics } = await call<{ metrics: { name: string; value: number }[] }>('Performance.getMetrics');
      const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
      return { jsHeapUsed: m.JSHeapUsedSize ?? 0, nodes: m.Nodes ?? 0, listeners: m.JSEventListeners ?? 0 };
    },
    async heapSnapshot() {
      const chunks: string[] = [];
      const fn = (m: Message) => {
        if (m.method === 'HeapProfiler.addHeapSnapshotChunk' && m.sessionId === sessionId) chunks.push(m.params.chunk);
      };
      listeners.add(fn);
      try {
        await call('HeapProfiler.enable');
        await withTimeout(call('HeapProfiler.collectGarbage'), 60_000, 'collectGarbage');
        await withTimeout(call('HeapProfiler.takeHeapSnapshot', { reportProgress: false }), 180_000, 'takeHeapSnapshot');
      } finally {
        listeners.delete(fn);
      }
      return chunks.join('');
    },
    async close() {
      try {
        await withTimeout(send('Browser.close'), 5_000, 'Browser.close');
      } catch {
      }
      await wait(300);
      stop();
    },
  };
}
