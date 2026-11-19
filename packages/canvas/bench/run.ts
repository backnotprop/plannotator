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
 * Scrolling is driven by setting scrollTop each frame, which a frame rate alone would flatter (a real scroll
 * runs off the main thread and shows a late figure as an empty box, not a slow frame), so the scroll rows
 * also count frames in which a figure is on screen with nothing drawn in it.
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
  // Said as it is measured, so a run that stops early still shows how far it got.
  console.error(`${ok ? 'met    ' : 'NOT met'}  ${name}: ${measured}`);
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

  // `--skip-plan` leaves the plan rows out, for a quicker run while working on the canvas rows.
  if (!args.includes('--skip-plan')) {
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

  /**
   * A scroll, watched for the fault a frame rate cannot show: a figure that is on screen with nothing drawn
   * in it yet. Counted per frame, as the person would see it.
   */
  const scrollWatchingFigures = (ms: number, pxPerSecond: number) =>
    page.evaluate(
      ([duration, speed]) => {
        const pane = document.querySelector<HTMLElement>('.demo-plan')!;
        const views = [...document.querySelectorAll<HTMLElement>('.pcv-figure-view')];
        const span = pane.scrollHeight - pane.clientHeight;
        let frames = 0;
        let emptyFrames = 0;
        let worst = 0;
        return (window as unknown as { __frames: (ms: number, step: (t: number) => void) => Promise<number[]> })
          .__frames(duration, (t) => {
            const travelled = (t / 1000) * speed;
            const lap = Math.floor(travelled / span);
            pane.scrollTop = lap % 2 === 0 ? travelled % span : span - (travelled % span);
            const box = pane.getBoundingClientRect();
            let empty = 0;
            for (const view of views) {
              const at = view.getBoundingClientRect();
              if (at.bottom > box.top && at.top < box.bottom && !view.firstElementChild) empty++;
            }
            frames++;
            if (empty) emptyFrames++;
            worst = Math.max(worst, empty);
          })
          .then(() => ({ frames, emptyFrames, worst }));
      },
      [ms, pxPerSecond],
    );
  await scrollPass(passMs);
  const base = await memory(cdp);
  frameRow('Plan with 50 materialized snapshots: scroll', await scrollPass(passMs), interval);
  for (const speed of [2400, 12000]) {
    const seen = await scrollWatchingFigures(4000, speed);
    results[`emptyFigures@${speed}`] = seen;
    row(`Plan with 50 snapshots: a figure on screen with nothing drawn yet, scrolling at ${speed.toLocaleString('en')} px/s`, 'never', `${seen.emptyFrames} of ${seen.frames} frames (at most ${seen.worst} at once)`, seen.emptyFrames === 0);
  }
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

  // ── Opening a snapshot, and coming back ─────────────────────────────────
  interface Opened { toFrame: number; moved: boolean; slow: number; frames: number; ghost: boolean; scrollMoved: number; figureMoved: number }
  const openAndBack = async (i: number): Promise<Opened> => {
    const figure = page.locator('.pcv-figure-hit').nth(i);
    await figure.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    const where = () =>
      page.evaluate((n) => {
        const box = document.querySelectorAll('.pcv-figure-view')[n as number].getBoundingClientRect();
        return { scroll: document.querySelector<HTMLElement>('.demo-plan')!.scrollTop, x: box.left, y: box.top, w: box.width, h: box.height };
      }, i);
    const before = await where();
    await page.evaluate(() => {
      const w = window as unknown as { __open: unknown };
      w.__open = null;
      addEventListener(
        'click',
        (event) => {
          const t0 = event.timeStamp;
          const times: number[] = [];
          let first: { at: number; moved: boolean; ghost: boolean } | null = null;
          const tick = (t: number) => {
            times.push(t);
            const stage = document.querySelector<HTMLElement>('.pcv-stage');
            if (!first) first = { at: t - t0, moved: stage?.dataset.motion === 'started' && !!stage.querySelector<HTMLElement>('.pcv-stage-clip')?.style.clipPath, ghost: !!stage?.querySelector('.pcv-stage-ghost') };
            if (stage && stage.dataset.busy === undefined && times.length > 3) w.__open = { toFrame: first.at, moved: first.moved, ghost: first.ghost, times };
            else if (times.length < 300) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        },
        { capture: true, once: true },
      );
    });
    await figure.click();
    await page.waitForFunction(() => (window as unknown as { __open: unknown }).__open !== null, undefined, { timeout: 5000 });
    const opened = (await page.evaluate(() => (window as unknown as { __open: unknown }).__open)) as { toFrame: number; moved: boolean; ghost: boolean; times: number[] };
    // Coming back is measured too: the same frames, the other way.
    const closing = page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const times: number[] = [];
          const tick = (t: number) => {
            times.push(t);
            if (!document.querySelector('.pcv-stage') || times.length > 300) resolve(times);
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
    await page.getByRole('button', { name: 'Back to plan' }).click();
    const back = await closing;
    await page.waitForSelector('.pcv-stage', { state: 'detached' });
    const after = await where();
    const s = stats([...opened.times], Math.max(interval, 1000 / 60));
    const sBack = stats(back, Math.max(interval, 1000 / 60));
    return {
      toFrame: Math.round(opened.toFrame * 100) / 100,
      moved: opened.moved,
      ghost: opened.ghost,
      slow: s.slow + sBack.slow,
      frames: s.frames + sBack.frames,
      scrollMoved: Math.abs(after.scroll - before.scroll),
      figureMoved: Math.max(Math.abs(after.x - before.x), Math.abs(after.y - before.y), Math.abs(after.w - before.w), Math.abs(after.h - before.h)),
    };
  };
  const openRows = (label: string, opens: Opened[]) => {
    results[label] = opens;
    row(
      `${label}: click to the first frame that has moved`,
      `within ${BUDGET.openFrames} frames at 60 fps (${(SIXTY * BUDGET.openFrames).toFixed(1)} ms), and that frame has moved`,
      `${opens.map((o) => o.toFrame).join(', ')} ms over ${opens.length} opens; moved in the first frame: ${opens.every((o) => o.moved) ? 'every time' : 'NOT every time'}`,
      Math.max(...opens.map((o) => o.toFrame)) <= SIXTY * BUDGET.openFrames && opens.every((o) => o.moved),
    );
    const slow = opens.reduce((sum, o) => sum + o.slow, 0);
    const frames = opens.reduce((sum, o) => sum + o.frames, 0);
    row(`${label}: frames during the motion in and back`, 'at most 1% slow', `${slow} of ${frames} frames slow`, slow / Math.max(1, frames) <= BUDGET.slowFrameShare);
    row(
      `${label}: back at the same place`,
      'the plan has not scrolled and the figure has not moved (within 0.5 px)',
      `scroll moved ${Math.max(...opens.map((o) => o.scrollMoved))} px, figure moved ${Math.max(...opens.map((o) => o.figureMoved)).toFixed(2)} px`,
      opens.every((o) => o.scrollMoved < 0.5 && o.figureMoved < 0.5),
    );
  };
  const current: Opened[] = [];
  for (let i = 0; i < 5; i++) current.push(await openAndBack(i));
  openRows('Opening a snapshot', current);

  // Now the canvas moves on: every box shifts and a third are recoloured, so every snapshot is behind.
  await page.evaluate(() => {
    const { store } = (window as unknown as { __canvas: { store: { dispatch(c: unknown): unknown; getDocument(): { order: string[] } } } }).__canvas;
    const boxes = store.getDocument().order.filter((id) => id.startsWith('b'));
    store.dispatch({ type: 'move', ids: boxes, dx: 14, dy: 9 });
    store.dispatch({ type: 'recolor', ids: boxes.filter((_, i) => i % 3 === 0), color: 'red' });
  });
  await page.waitForTimeout(300);
  const behindOpens: Opened[] = [];
  for (let i = 5; i < 10; i++) behindOpens.push(await openAndBack(i));
  openRows('Opening a snapshot that is behind', behindOpens);
  row('Opening a snapshot: the capture is drawn over the canvas from the first frame, to dissolve into it', 'every time, behind or not', [...current, ...behindOpens].every((o) => o.ghost) ? 'every time' : 'NOT every time', [...current, ...behindOpens].every((o) => o.ghost));
  // 50 times in and back, turned round mid-flight each time, watching what is left behind.
  await page.locator('.pcv-figure-hit').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const cycle = async () => {
    await page.locator('.pcv-figure-hit').first().click();
    await page.waitForTimeout(220);
    await page.getByRole('button', { name: 'Back to plan' }).click();
    await page.waitForSelector('.pcv-stage', { state: 'detached' });
  };
  for (let i = 0; i < 5; i++) await cycle();
  const beforeCycles = await memory(cdp);
  for (let i = 0; i < 50; i++) await cycle();
  const afterCycles = await memory(cdp);
  results.openCloseMemory = { before: beforeCycles, after: afterCycles };
  row('Opening and closing 50 times: heap', `grows at most ${BUDGET.heapGrowthMb} MB`, `${beforeCycles.heapMb} MB to ${afterCycles.heapMb} MB (${(afterCycles.heapMb - beforeCycles.heapMb).toFixed(2)} MB)`, afterCycles.heapMb - beforeCycles.heapMb <= BUDGET.heapGrowthMb);
  row('Opening and closing 50 times: DOM nodes', `grow at most ${BUDGET.nodeGrowthShare * 100}%`, `${beforeCycles.nodes} to ${afterCycles.nodes}`, afterCycles.nodes <= beforeCycles.nodes * (1 + BUDGET.nodeGrowthShare));

  // The canvas being edited while the plan and its 50 figures are on the page: every commit reaches every figure.
  const editing = await page.evaluate(() => {
    const { store } = (window as unknown as { __canvas: { store: { dispatch(c: unknown, o?: unknown): unknown; getDocument(): { order: string[] } } } }).__canvas;
    const moving = store.getDocument().order.filter((id) => id.startsWith('b')).slice(0, 20);
    return (window as unknown as { __frames: (ms: number, step: (t: number) => void) => Promise<number[]> }).__frames(3000, (t) => {
      store.dispatch({ type: 'move', ids: moving, dx: Math.cos(t / 300) * 3, dy: Math.sin(t / 300) * 3 }, { gesture: 'bench-edit' });
    });
  });
  frameRow('Plan with 50 snapshots: the canvas edited 60 times a second behind it', editing, interval);

  const behindScroll = await scrollPass(passMs);
  frameRow('Plan with 50 snapshots, all behind: scroll', behindScroll, interval);
  }

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
  /**
   * To 100% about the middle of the board. Fitted first, because a pan that dropped frames does not come back
   * to where it started, and far out a few hundred pixels of drift is the whole board.
   */
  const zoomTo100 = async () => {
    await page.getByRole('button', { name: 'Zoom to fit' }).first().click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Zoom to 100%' }).click();
  };
  const countMounted = () => page.evaluate(() => document.querySelectorAll('.pcv-obj, .pcv-arrow').length);
  /** How many objects are mounted, once that number has stopped changing (a big board takes a moment to re-cull after a zoom). */
  const mounted = async (): Promise<number> => {
    let last = -1;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(250);
      const now = await countMounted();
      if (now === last && now > 0) return now;
      last = now;
    }
    return last;
  };

  // Fitted: the whole board on screen, every object mounted, far level of detail.
  const mountedFit = await mounted();
  frameRow(`Canvas, ${count} objects, whole board in view (${mountedFit} mounted): pan`, await wheel(4000, 'const a = (t / duration) * Math.PI * 4; send({ deltaX: Math.cos(a) * 18, deltaY: Math.sin(a) * 18 });'), interval);
  frameRow(`Canvas, ${count} objects: zoom in and out through every level of detail`, await wheel(5000, 'send({ ctrlKey: true, deltaY: Math.sin(t / 5000 * Math.PI * 4) > 0 ? -4 : 4 });'), interval);

  // At 100%: a screenful mounted, the render window turning over as it pans.
  await zoomTo100();
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

  /**
   * A drag the way a person makes one: pointer events on an object, one move a frame, through hit-testing and
   * the gesture code, at 100% where text and shadows are drawn. Returns frame times.
   */
  const pointerDrag = () =>
    page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.pcv-root')!;
      const view = root.getBoundingClientRect();
      const boxes = [...root.querySelectorAll<HTMLElement>('.pcv-box, .pcv-shape')];
      const inMiddle = (el: HTMLElement) => {
        const box = el.getBoundingClientRect();
        return box.left > view.left + 300 && box.right < view.right - 300 && box.top > view.top + 200 && box.bottom < view.bottom - 250;
      };
      const onScreen = (el: HTMLElement) => {
        const box = el.getBoundingClientRect();
        return box.left > view.left && box.right < view.right && box.top > view.top + 80 && box.bottom < view.bottom - 80;
      };
      const target = boxes.find(inMiddle) ?? boxes.find(onScreen);
      if (!target) throw new Error(`no box on screen to drag (${boxes.length} boxes mounted)`);
      const box = target.getBoundingClientRect();
      const start = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      const fire = (type: string, x: number, y: number) => root.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }));
      fire('pointerdown', start.x, start.y);
      return (window as unknown as { __frames: (ms: number, step: (t: number) => void) => Promise<number[]> })
        .__frames(3000, (t) => fire('pointermove', start.x + Math.cos(t / 350) * 180 + 10, start.y + Math.sin(t / 350) * 120))
        .then((times) => {
          fire('pointerup', start.x, start.y);
          return times;
        });
    });
  await zoomTo100();
  await page.waitForTimeout(300);
  frameRow(`Canvas, ${count} objects, at 100%: drag an object with the pointer`, await pointerDrag(), interval);

  // The measurement behind a rule in the guide: the board's element is not promoted to its own layer.
  await page.getByRole('button', { name: 'Zoom to fit' }).first().click();
  await page.waitForTimeout(300);
  const fitPan = 'const a = (t / duration) * Math.PI * 4; send({ deltaX: Math.cos(a) * 18, deltaY: Math.sin(a) * 18 });';
  const plain = stats(await wheel(3000, fitPan), Math.max(interval, SIXTY));
  const style = await page.addStyleTag({ content: '.pcv-world { will-change: transform; }' });
  await page.waitForTimeout(300);
  const promoted = stats(await wheel(3000, fitPan), Math.max(interval, SIXTY));
  await style.evaluate((el) => (el as Element).remove());
  results.willChange = { plain, promoted };
  row(
    `Canvas, ${count} objects, whole board in view: why the board is not given its own layer`,
    'without will-change it holds 60 fps; with it, it is recorded here',
    `without: ${plain.meanFps} fps, worst ${plain.worst} ms. With will-change: transform: ${promoted.meanFps} fps, worst ${promoted.worst} ms`,
    plain.slowShare <= BUDGET.slowFrameShare && plain.worst <= BUDGET.worstFrameMs,
  );

  // ── The heavy kinds: pictures, HTML items, cards, long notes ────────────
  await open(page, `${server.url}/?bench=canvas&n=2000&rich`);
  await page.waitForTimeout(600);
  const kinds = await page.evaluate(() => {
    const objects = Object.values((window as unknown as { __canvas: { store: { getDocument(): { objects: Record<string, { type: string }> } } } }).__canvas.store.getDocument().objects);
    const of = (type: string) => objects.filter((object) => object.type === type).length;
    return `${of('image')} pictures, ${of('html')} HTML items, ${of('reference')} cards, ${of('note')} long notes`;
  });
  results.richKinds = kinds;
  frameRow(`Canvas, 2000 objects with ${kinds}, whole board in view: pan`, await wheel(4000, fitPan), interval);
  await zoomTo100();
  await page.waitForTimeout(500);
  frameRow('Same board at 100% (pictures and HTML items drawn): pan across it', await wheel(5000, 'const dir = Math.floor(t / 1250) % 2 ? -1 : 1; send({ deltaX: 26 * dir, deltaY: 9 * dir });'), interval);
  frameRow('Same board at 100%: drag an object with the pointer', await pointerDrag(), interval);

  // ── Typed shapes and routed connectors ──────────────────────────────────
  await open(page, `${server.url}/?bench=canvas&n=2000&typed&connectors=1500`);
  await page.waitForTimeout(600);
  const typed = await page.evaluate(() => {
    const objects = Object.values((window as unknown as { __canvas: { store: { getDocument(): { objects: Record<string, { type: string }> } } } }).__canvas.store.getDocument().objects);
    return `${objects.filter((object) => object.type === 'box').length} typed shapes and ${objects.filter((object) => object.type === 'arrow').length} connectors`;
  });
  frameRow(`Canvas, ${typed}, whole board in view (far: lines straight): pan`, await wheel(4000, fitPan), interval);
  frameRow(`Canvas, ${typed}: zoom in and out through every level of detail`, await wheel(5000, 'send({ ctrlKey: true, deltaY: Math.sin(t / 5000 * Math.PI * 4) > 0 ? -4 : 4 });'), interval);
  // In to where connectors are drawn routed, with as much of the board on screen as that allows.
  await page.getByRole('button', { name: 'Zoom to fit' }).first().click();
  for (let i = 0; i < 7; i++) await page.getByRole('button', { name: 'Zoom in' }).click();
  const routedAt = await page.evaluate(() => document.querySelector('.pcv-bar-zoom span')?.textContent ?? '');
  const routedCount = await mounted();
  frameRow(`Canvas, ${typed}, at ${routedAt} with routes drawn (${routedCount} mounted): pan across the board`, await wheel(5000, 'const dir = Math.floor(t / 1250) % 2 ? -1 : 1; send({ deltaX: 22 * dir, deltaY: 8 * dir });'), interval);
  const dragRouted = (ids: number) =>
    page.evaluate(
      ([n]) => {
        const { store } = (window as unknown as { __canvas: { store: { dispatch(c: unknown, o: unknown): unknown } } }).__canvas;
        // The shapes on screen, so the connectors that re-route are ones being drawn.
        const moving = [...document.querySelectorAll<HTMLElement>('.pcv-obj')].map((el) => el.dataset.id ?? '').filter((id) => id.startsWith('b')).slice(0, n as number);
        const gesture = `bench-routed-${n}-${Math.random()}`;
        return (window as unknown as { __frames: (ms: number, step: (t: number) => void) => Promise<number[]> }).__frames(3000, (t) => {
          const a = t / 300;
          store.dispatch({ type: 'move', ids: moving, dx: Math.cos(a) * 4, dy: Math.sin(a) * 4 }, { gesture });
        });
      },
      [ids],
    );
  frameRow(`Canvas, ${typed}, at ${routedAt}: drag 1 shape, its connectors re-routing`, await dragRouted(1), interval);
  frameRow(`Canvas, ${typed}, at ${routedAt}: drag 300 shapes together, their connectors re-routing`, await dragRouted(300), interval);
  await zoomTo100();
  await page.waitForTimeout(500);
  frameRow(`Canvas, ${typed}, at 100% (${await mounted()} mounted, hops drawn): pan across the board`, await wheel(5000, 'const dir = Math.floor(t / 1250) % 2 ? -1 : 1; send({ deltaX: 26 * dir, deltaY: 9 * dir });'), interval);
  frameRow(`Canvas, ${typed}, at 100%: drag a shape with the pointer`, await pointerDrag(), interval);

  // ── 10,000 objects: past what the budgets were set for; measured so the number is known ──
  await open(page, `${server.url}/?bench=canvas&n=10000`);
  await page.waitForTimeout(800);
  const big = await page.evaluate(() => Object.keys((window as unknown as { __canvas: { store: { getDocument(): { objects: object } } } }).__canvas.store.getDocument().objects).length);
  frameRow(`Canvas, ${big} objects, whole board in view (${await mounted()} mounted): pan`, await wheel(4000, fitPan), interval);
  await zoomTo100();
  await page.waitForTimeout(500);
  frameRow(`Canvas, ${big} objects, at 100% (${await mounted()} mounted): pan across the board`, await wheel(5000, 'const dir = Math.floor(t / 1250) % 2 ? -1 : 1; send({ deltaX: 26 * dir, deltaY: 9 * dir });'), interval);
  frameRow(`Canvas, ${big} objects, at 100%: drag an object with the pointer`, await pointerDrag(), interval);
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
