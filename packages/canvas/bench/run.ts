/**
 * The canvas benchmark: real numbers from a real browser, against budgets.
 *
 *   bun run --cwd packages/canvas bench             build the demo, measure, print a table
 *   bun run --cwd packages/canvas bench --headed    the same in a visible window (GPU raster)
 *   ... --no-build                                  measure the demo/dist that is already there
 *   ... --json <file>                               also write the raw numbers
 *
 * Method. The demo page is built once and served from this process on a
 * loopback port. Chromium (Playwright's, driven as a measuring tool) opens
 * it at 1440 x 900. Every scenario is driven from inside the page, one step
 * per animation frame, and the time between frames is what is measured: a
 * frame that takes longer than the display's interval is a dropped frame,
 * whatever caused it (script, style, layout, paint). Heap and DOM node
 * counts come from the DevTools protocol after a forced collection.
 *
 * It is a measuring script, not a test: it exits 1 when a budget is missed
 * so a person running it sees that, but no CI lane runs it (a shared runner
 * has no stable frame rate to hold a budget against).
 */
import path from 'node:path';
import { type CDPSession, type Page, chromium } from '@playwright/test';

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const root = path.resolve(import.meta.dir, '..');
const dist = path.join(root, 'demo', 'dist');

/** The budgets, stated at 60 fps whatever the display's rate. */
const BUDGET = {
  /** Share of frames that may take longer than 1.5 display intervals. */
  slowFrameShare: 0.01,
  /** No frame may take longer than this, in ms. */
  worstFrameMs: 50,
  /** Mean rate, as a share of the display's rate. */
  meanRateShare: 0.97,
  /** Heap growth over ten scroll passes after the first, in MB. */
  heapGrowthMb: 2,
  /** DOM node growth over the same passes, as a share. */
  nodeGrowthShare: 0.02,
  /** Click to the first frame that has moved, in 60 fps frames. */
  openFrames: 1.5,
};

interface FrameStats {
  frames: number;
  meanFps: number;
  p50: number;
  p95: number;
  p99: number;
  worst: number;
  slow: number;
  slowShare: number;
}

function stats(times: number[], interval: number): FrameStats {
  const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
  const at = (q: number) => gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))] ?? 0;
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / Math.max(1, gaps.length);
  const slow = gaps.filter((gap) => gap > interval * 1.5).length;
  const round = (value: number) => Math.round(value * 100) / 100;
  return { frames: gaps.length, meanFps: round(1000 / mean), p50: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)), worst: round(gaps[gaps.length - 1] ?? 0), slow, slowShare: round(slow / Math.max(1, gaps.length)) };
}

/** In the page: run `step(elapsedMs)` once per frame for `ms`, return every frame's timestamp. */
const FRAMES = `
  window.__frames = (ms, step) => new Promise((resolve) => {
    const times = [];
    let start;
    const tick = (t) => {
      if (start === undefined) start = t;
      times.push(t);
      if (t - start >= ms) return resolve(times);
      step(t - start);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  window.__interval = () => new Promise((resolve) => {
    const times = [];
    const tick = (t) => { times.push(t); if (times.length < 40) requestAnimationFrame(tick); else {
      const gaps = times.slice(1).map((x, i) => x - times[i]).sort((a, b) => a - b);
      resolve(gaps[Math.floor(gaps.length / 2)]);
    } };
    requestAnimationFrame(tick);
  });
`;

async function serve(): Promise<{ url: string; stop: () => void }> {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      const file = Bun.file(path.join(dist, pathname === '/' ? 'index.html' : pathname));
      if (!path.join(dist, pathname).startsWith(dist) || !(await file.exists())) return new Response('not found', { status: 404 });
      return new Response(file);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

async function memory(cdp: CDPSession): Promise<{ heapMb: number; nodes: number }> {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const get = (name: string) => metrics.find((metric) => metric.name === name)?.value ?? 0;
  return { heapMb: Math.round((get('JSHeapUsedSize') / 1048576) * 100) / 100, nodes: get('Nodes') };
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.addScriptTag({ content: FRAMES });
  await page.waitForTimeout(800);
}

const results: Record<string, unknown> = {};
const rows: string[][] = [];
let failed = false;

function row(name: string, budget: string, measured: string, ok: boolean): void {
  rows.push([name, budget, measured, ok ? 'met' : 'NOT met']);
  if (!ok) failed = true;
}

/** The budget is 60 fps. On a faster display the same frames are also counted against its own rate, for the record. */
const SIXTY = 1000 / 60;

function frameRow(name: string, times: number[], interval: number): void {
  const budgetInterval = Math.max(interval, SIXTY);
  const s = stats(times, budgetInterval);
  const native = interval < SIXTY - 1 ? stats(times, interval) : null;
  results[name] = native ? { at60: s, atDisplayRate: native } : s;
  row(
    name,
    `60 fps: at most 1% of frames over ${(budgetInterval * 1.5).toFixed(1)} ms, none over ${BUDGET.worstFrameMs} ms`,
    `${s.meanFps} fps mean, p95 ${s.p95} ms, worst ${s.worst} ms, ${s.slow} of ${s.frames} frames slow` + (native ? ` (against ${Math.round(1000 / interval)} Hz: ${native.slow} over ${(interval * 1.5).toFixed(1)} ms)` : ''),
    s.slowShare <= BUDGET.slowFrameShare && s.worst <= BUDGET.worstFrameMs && s.meanFps >= 60 * BUDGET.meanRateShare,
  );
}

if (!args.includes('--no-build')) {
  const build = Bun.spawnSync(['bun', 'run', 'demo:build'], { cwd: root, stdout: 'ignore', stderr: 'inherit' });
  if (build.exitCode !== 0) throw new Error('the demo did not build');
}

const server = await serve();
const browser = await chromium.launch({ headless: !headed });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');

  // ── A plan with 50 snapshots ────────────────────────────────────────────
  await open(page, `${server.url}/?bench=plan&n=50`);
  const interval = (await page.evaluate('window.__interval()')) as number;
  results.displayIntervalMs = Math.round(interval * 100) / 100;
  results.mode = headed ? 'headed' : 'headless';

  const planInfo = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>('.demo-plan')!;
    return { figures: document.querySelectorAll('.pcv-figure').length, live: document.querySelectorAll('.pcv-figure .pcv-root').length, height: pane.scrollHeight };
  });
  results.plan = planInfo;

  /** Scroll the whole plan down and back at a steady 2,400 px a second. */
  const scrollPass = (ms: number) =>
    page.evaluate(
      ([duration]) => {
        const pane = document.querySelector<HTMLElement>('.demo-plan')!;
        const span = pane.scrollHeight - pane.clientHeight;
        return (window as unknown as { __frames: (ms: number, step: (t: number) => void) => Promise<number[]> }).__frames(duration, (t) => {
          const phase = (t / duration) * 2;
          pane.scrollTop = span * (phase <= 1 ? phase : 2 - phase);
        });
      },
      [ms],
    );
  const passMs = Math.round((planInfo.height / 2400) * 2 * 1000);
  await scrollPass(passMs);
  const base = await memory(cdp);
  frameRow('Plan with 50 snapshots: scroll', await scrollPass(passMs), interval);
  let peakLive = 0;
  for (let i = 0; i < 9; i++) {
    await scrollPass(Math.round(passMs / 2));
    peakLive = Math.max(peakLive, await page.evaluate(() => document.querySelectorAll('.pcv-figure .pcv-root').length));
  }
  const after = await memory(cdp);
  results.planMemory = { base, after, liveFiguresAtRest: planInfo.live };
  row('Plan with 50 snapshots: heap after 10 more scroll passes', `grows at most ${BUDGET.heapGrowthMb} MB`, `${base.heapMb} MB to ${after.heapMb} MB (${(after.heapMb - base.heapMb).toFixed(2)} MB)`, after.heapMb - base.heapMb <= BUDGET.heapGrowthMb);
  row('Plan with 50 snapshots: DOM nodes after the same passes', `grow at most ${BUDGET.nodeGrowthShare * 100}%`, `${base.nodes} to ${after.nodes}`, after.nodes <= base.nodes * (1 + BUDGET.nodeGrowthShare));
  row('Plan with 50 snapshots: figures drawing at once', 'only those near the screen', `${planInfo.live} of ${planInfo.figures} at rest`, planInfo.live < planInfo.figures / 2);

  // ── Opening a snapshot ──────────────────────────────────────────────────
  const opens: { toFrame: number; moved: boolean; slow: number; frames: number }[] = [];
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => {
      const w = window as unknown as { __open: unknown };
      w.__open = null;
      addEventListener(
        'click',
        (event) => {
          const t0 = event.timeStamp;
          const times: number[] = [];
          let first: { at: number; moved: boolean } | null = null;
          const tick = (t: number) => {
            times.push(t);
            const stage = document.querySelector<HTMLElement>('.pcv-stage');
            if (!first) first = { at: t - t0, moved: stage?.dataset.motion === 'started' && !!stage.querySelector<HTMLElement>('.pcv-stage-clip')?.style.clipPath };
            if (stage && stage.dataset.busy === undefined && times.length > 3) w.__open = { toFrame: first.at, moved: first.moved, times };
            else if (times.length < 300) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        },
        { capture: true, once: true },
      );
    });
    const figure = page.locator('.pcv-figure-hit').nth(i);
    await figure.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await figure.click();
    await page.waitForFunction(() => (window as unknown as { __open: unknown }).__open !== null, undefined, { timeout: 5000 });
    const opened = (await page.evaluate(() => (window as unknown as { __open: unknown }).__open)) as { toFrame: number; moved: boolean; times: number[] };
    const s = stats(opened.times, Math.max(interval, 1000 / 60));
    opens.push({ toFrame: Math.round(opened.toFrame * 100) / 100, moved: opened.moved, slow: s.slow, frames: s.frames });
    await page.getByRole('button', { name: 'Back to plan' }).click();
    await page.waitForSelector('.pcv-stage', { state: 'detached' });
  }
  results.open = opens;
  const worstOpen = Math.max(...opens.map((o) => o.toFrame));
  row(
    'Opening a snapshot: click to the first frame that has moved',
    `within ${BUDGET.openFrames} frames at 60 fps (${(SIXTY * BUDGET.openFrames).toFixed(1)} ms), and that frame has moved`,
    `${opens.map((o) => o.toFrame).join(', ')} ms over 5 opens; moved in the first frame: ${opens.every((o) => o.moved) ? 'every time' : 'NOT every time'}`,
    worstOpen <= SIXTY * BUDGET.openFrames && opens.every((o) => o.moved),
  );
  const openSlow = opens.reduce((sum, o) => sum + o.slow, 0);
  const openFrames = opens.reduce((sum, o) => sum + o.frames, 0);
  row('Opening a snapshot: frames during the motion', 'at most 1% slow', `${openSlow} of ${openFrames} frames slow`, openSlow / Math.max(1, openFrames) <= BUDGET.slowFrameShare);

  // ── A canvas with 2,000 objects ─────────────────────────────────────────
  await open(page, `${server.url}/?bench=canvas&n=2000`);
  const count = await page.evaluate(() => Object.keys((window as unknown as { __canvas: { store: { getDocument(): { objects: object } } } }).__canvas.store.getDocument().objects).length);
  results.canvasObjects = count;
  const wheel = (ms: number, script: string) =>
    page.evaluate(
      ([duration, body]) => {
        const root = document.querySelector<HTMLElement>('.pcv-root')!;
        const box = root.getBoundingClientRect();
        const send = (init: WheelEventInit) => root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, ...init }));
        const step = new Function('t', 'send', 'duration', body as string) as (t: number, send: (init: WheelEventInit) => void, duration: number) => void;
        return (window as unknown as { __frames: (ms: number, step: (t: number) => void) => Promise<number[]> }).__frames(duration as number, (t) => step(t, send, duration as number));
      },
      [ms, script],
    );
  const mounted = () => page.evaluate(() => document.querySelectorAll('.pcv-obj, .pcv-arrow').length);

  // Fitted: the whole board on screen, every object mounted, far level of detail.
  const mountedFit = await mounted();
  frameRow(`Canvas, ${count} objects, whole board in view (${mountedFit} mounted): pan`, await wheel(4000, 'const a = (t / duration) * Math.PI * 4; send({ deltaX: Math.cos(a) * 18, deltaY: Math.sin(a) * 18 });'), interval);
  frameRow(`Canvas, ${count} objects: zoom in and out through every level of detail`, await wheel(5000, 'send({ ctrlKey: true, deltaY: Math.sin(t / 5000 * Math.PI * 4) > 0 ? -4 : 4 });'), interval);

  // At 100%: a screenful mounted, the render window turning over as it pans.
  await page.getByRole('button', { name: 'Zoom to 100%' }).click();
  await page.waitForTimeout(300);
  const mountedNear = await mounted();
  frameRow(`Canvas, ${count} objects, at 100% (${mountedNear} mounted): pan across the board`, await wheel(5000, 'const dir = Math.floor(t / 1250) % 2 ? -1 : 1; send({ deltaX: 26 * dir, deltaY: 9 * dir });'), interval);
  results.mounted = { fitted: mountedFit, at100: mountedNear };

  // Dragging: one command a frame, as the pointer gesture sends them.
  const drag = (ids: number) =>
    page.evaluate(
      ([n]) => {
        const { store } = (window as unknown as { __canvas: { store: { dispatch(c: unknown, o: unknown): unknown; getDocument(): { order: string[] } } } }).__canvas;
        const moving = store.getDocument().order.filter((id) => id.startsWith('b')).slice(0, n as number);
        const gesture = `bench-${n}-${Math.random()}`;
        return (window as unknown as { __frames: (ms: number, step: (t: number) => void) => Promise<number[]> }).__frames(3000, (t) => {
          const a = t / 300;
          store.dispatch({ type: 'move', ids: moving, dx: Math.cos(a) * 4, dy: Math.sin(a) * 4 }, { gesture });
        });
      },
      [ids],
    );
  await page.getByRole('button', { name: 'Zoom to fit' }).first().click();
  await page.waitForTimeout(300);
  frameRow(`Canvas, ${count} objects: drag 1 object`, await drag(1), interval);
  frameRow(`Canvas, ${count} objects: drag 300 objects together`, await drag(300), interval);
} finally {
  await browser.close();
  server.stop();
}

const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i].length), ['Scenario', 'Budget', 'Measured', 'Result'][i].length));
const line = (cells: string[]) => `| ${cells.map((cell, i) => cell.padEnd(widths[i])).join(' | ')} |`;
console.log(`\nChromium ${results.mode}, 1440 x 900, display interval ${results.displayIntervalMs} ms\n`);
console.log(line(['Scenario', 'Budget', 'Measured', 'Result']));
console.log(line(widths.map((w) => '-'.repeat(w))));
for (const r of rows) console.log(line(r));
if (jsonOut) await Bun.write(jsonOut, JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
