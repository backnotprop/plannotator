/**
 * What a window pays, read from outside the page: bytes until its first list paint, and the main-thread work one
 * event costs (Chromium's own counters through CDP, long tasks and Resource Timing in the page). No window internals.
 */
import type { CDPSession, Page, Request } from '@playwright/test';
import { writeFileSync } from 'node:fs';

/** Bytes a page received (headers and encoded bodies), all and API reads alone, for requests finished by a moment. */
export function pageBytes(p: Page) {
  const done: { t: number; api: boolean; bytes: Promise<number> }[] = [];
  const on = (r: Request) => {
    const url = r.url().replace(/^https?:\/\/[^/]+/, '');
    done.push({ t: Date.now(), api: url.startsWith('/api/'), bytes: r.sizes().then((s) => s.responseBodySize + s.responseHeadersSize, () => 0) });
  };
  p.on('requestfinished', on);
  return {
    async until(t: number): Promise<{ all: number; api: number }> {
      p.off('requestfinished', on);
      let all = 0;
      let api = 0;
      for (const d of done.filter((x) => x.t <= t)) {
        const b = await d.bytes;
        all += b;
        if (d.api) api += b;
      }
      return { all, api };
    },
  };
}

export interface ListReadTiming {
  /** Request sent → first byte back: the server's work on it (on loopback; plus a round trip on a slow link). */
  waitMs: number;
  /** First byte → last byte: the transfer. */
  downloadMs: number;
  bytes: number;
  /** When it ended, ms after the event. */
  endAt: number;
}

export interface EventSplit {
  window?: string;
  t0: number;
  /** Chromium's TaskDuration over the window: all main-thread work. */
  taskMs: number;
  scriptMs: number;
  layoutMs: number;
  styleMs: number;
  /** Long tasks (over 50 ms) that started in the window, summed, and each one. */
  longTaskMs: number;
  longTasks: { at: number; ms: number }[];
  listReads: ListReadTiming[];
}

const LIST_READ = /\/api\/inbox\/threads(\?|$)/;

async function metrics(cdp: CDPSession): Promise<Record<string, number>> {
  const { metrics } = (await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] };
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

/**
 * Start watching page `p` before an event; `end(t0)` after it returns what the page's main thread did since.
 * `cpuProfile`: also a V8 CPU profile over the same window, written to that path.
 */
export async function eventSplit(p: Page, cdp: CDPSession, cpuProfile?: string) {
  await cdp.send('Performance.enable').catch(() => {});
  await p.evaluate(() => {
    const w = window as any;
    performance.setResourceTimingBufferSize(5000);
    performance.clearResourceTimings();
    w.__lvLong = [];
    if (!w.__lvLongObs && typeof PerformanceObserver !== 'undefined') {
      w.__lvLongObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__lvLong.push({ at: performance.timeOrigin + e.startTime, ms: e.duration });
      });
      try {
        w.__lvLongObs.observe({ type: 'longtask', buffered: false });
      } catch {}
    }
  });
  if (cpuProfile) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');
  }
  const m0 = await metrics(cdp);
  return {
    async end(t0: number): Promise<EventSplit> {
      const m1 = await metrics(cdp);
      if (cpuProfile) {
        const { profile } = (await cdp.send('Profiler.stop')) as { profile: unknown };
        writeFileSync(cpuProfile, JSON.stringify(profile));
      }
      const d = (k: string) => Math.round(((m1[k] ?? 0) - (m0[k] ?? 0)) * 1000);
      const page = await p.evaluate(
        ({ t0, src }) => {
          const w = window as any;
          const re = new RegExp(src);
          const reads = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
            .filter((e) => re.test(new URL(e.name).pathname + new URL(e.name).search) && performance.timeOrigin + e.startTime >= t0)
            .map((e) => ({ waitMs: Math.round(e.responseStart - e.requestStart), downloadMs: Math.round(e.responseEnd - e.responseStart), bytes: e.transferSize || e.encodedBodySize, endAt: Math.round(performance.timeOrigin + e.responseEnd - t0) }));
          const long = ((w.__lvLong ?? []) as { at: number; ms: number }[]).filter((x) => x.at >= t0).map((x) => ({ at: Math.round(x.at - t0), ms: Math.round(x.ms) }));
          return { reads, long };
        },
        { t0, src: LIST_READ.source },
      );
      return {
        t0,
        taskMs: d('TaskDuration'),
        scriptMs: d('ScriptDuration'),
        layoutMs: d('LayoutDuration'),
        styleMs: d('RecalcStyleDuration'),
        longTaskMs: page.long.reduce((n, x) => n + x.ms, 0),
        longTasks: page.long,
        listReads: page.reads,
      };
    },
  };
}
