/**
 * File tree benchmark and screenshots, in headless Chromium. Not run by
 * `bun test` (no .test. in the name) and not in CI: it needs a big path list
 * and, for the Pierre column, an installed @pierre/trees.
 *
 *   bun packages/ui/bench/file-tree/run.ts bench --paths <paths.json> --folder <folder> \
 *     [--impls new,new-tips,pl-browser,pierre] [--runs 3] [--out results.json]
 *   bun packages/ui/bench/file-tree/run.ts shots --out <dir>
 *
 * `paths.json` is a JSON array of relative file paths (a folder walk, `.git`
 * left out). `--folder` is the folder expand-all opens (its ancestors first,
 * then every folder under it), the step the first harness measured.
 * PIERRE_TREES_DIR points the Pierre column at an installed @pierre/trees
 * (1.0.0-beta.6 measured); without it the column is skipped.
 *
 * Every number is the median of `--runs` fresh pages. Each change is timed two
 * ways, the same for every tree: wall time from the call until the DOM has
 * been quiet for two frames (so ~33 ms is the floor), and main-thread work (the change in CDP's
 * TaskDuration across it: script, style, layout and paint the change cost).
 * "Cold" is the first time in a page; "warm" repeats the folder's close-all /
 * open-all `--warm` times (default 3) in the same page. Long tasks come from a
 * PerformanceObserver; scroll frame times are requestAnimationFrame deltas
 * while scrollTop moves 40 px a frame for 3 s ("scroll") and jumps to a random
 * place every frame for 2 s ("jump"). The new tree loads the way useFileTree
 * loads it (sliced: top-level rows first, the full index between tasks).
 */
import { chromium, devices } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const here = import.meta.dir;
const uiDir = resolve(here, '../..');
const dist = resolve(opt('dist', '/tmp/file-tree-bench-dist')!);

async function build() {
  const proc = Bun.spawn(['bunx', 'vite', 'build', '--config', 'bench/file-tree/vite.config.ts'], {
    cwd: uiDir,
    env: { ...process.env, BENCH_OUT: dist },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  if ((await proc.exited) !== 0) throw new Error('vite build failed');
}

function serve(dataFile?: string) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === '/data.json' && dataFile) return new Response(Bun.file(dataFile));
      return new Response(Bun.file(join(dist, p === '/' ? 'index.html' : p)));
    },
  });
}

const median = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const round = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);

async function bench() {
  const pathsFile = resolve(opt('paths')!);
  const folder = opt('folder')!;
  const runs = Number(opt('runs', '3'));
  const warmCycles = Number(opt('warm', '3'));
  let impls = opt('impls', 'new,new-tips,pl-browser,pierre')!.split(',');
  if (!process.env.PIERRE_TREES_DIR) impls = impls.filter((i) => i !== 'pierre');
  await build();
  const server = serve(pathsFile);
  const browser = await chromium.launch({ headless: true });
  const out: Record<string, any> = { paths: pathsFile, folder, runs, warmCycles, at: new Date().toISOString(), impls: {} };
  for (const impl of impls) {
    const per: any[] = [];
    for (let run = 0; run < runs; run++) {
      const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      const page = await ctx.newPage();
      await page.addInitScript(() => {
        (window as any).__long = [];
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) (window as any).__long.push({ s: e.startTime, d: e.duration });
        }).observe({ type: 'longtask', buffered: true });
      });
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Performance.enable');
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      const metrics = async () => {
        const m = await cdp.send('Performance.getMetrics');
        const g = (n: string) => m.metrics.find((x: any) => x.name === n)?.value ?? 0;
        return { task: g('TaskDuration') * 1000, script: g('ScriptDuration') * 1000, heapMB: g('JSHeapUsedSize') / 1048576, nodes: g('Nodes') };
      };
      const longTasks = () =>
        page.evaluate(() => {
          const lt = (window as any).__long as { s: number; d: number }[];
          (window as any).__long = [];
          return { longest: Math.max(0, ...lt.map((x) => x.d)), over50: lt.length };
        });
      /** One change: wall time until the DOM is quiet, main-thread work (CDP TaskDuration), longest task. */
      const op = async (expr: string, arg?: unknown) => {
        await longTasks();
        const m0 = await metrics();
        const r = await page.evaluate(([e, a]) => (window as any).__h[e as string](a), [expr, arg] as const);
        const m1 = await metrics();
        const lt = await longTasks();
        const ms = typeof r === 'number' ? r : r.ms;
        return { wall: ms, work: m1.task - m0.task, script: m1.script - m0.script, longest: lt.longest, visible: typeof r === 'number' ? null : r.visible, rows: await page.evaluate(() => (window as any).__h.rowCount()) };
      };

      await page.goto(`http://127.0.0.1:${server.port}/?mode=bench&impl=${impl}&theme=light`);
      await page.waitForFunction(() => (window as any).__h?.ready === true, null, { timeout: 300000 });
      if (impl.startsWith('new')) await page.waitForFunction(() => (window as any).__h?.fullReady === true, null, { timeout: 300000 });
      const first = await page.evaluate(() => {
        const h = (window as any).__h;
        const end = h.marks.fullReady ?? h.marks.painted;
        const lt = ((window as any).__long as { s: number; d: number }[]).filter((x) => x.s + x.d >= h.marks.dataReceived);
        return {
          renderMs: h.marks.painted - h.marks.dataReceived,
          readyMs: end - h.marks.dataReceived,
          rows: h.rowCount(),
          longest: Math.max(0, ...lt.map((x) => x.d)),
          over50: lt.length,
        };
      });
      await page.evaluate(() => { (window as any).__long = []; });
      const heapLoad = await (async () => { await cdp.send('HeapProfiler.collectGarbage'); return metrics(); })();

      // Cold: open the folder's ancestors one by one, then everything under it.
      const parts = folder.split('/');
      let expandOne: any = null;
      for (let i = 1; i <= parts.length; i++) expandOne = await op('expand', parts.slice(0, i).join('/'));
      const expandAll = await op('expandAllUnder', `${folder}/`);
      await cdp.send('HeapProfiler.collectGarbage');
      const heapExpanded = await metrics();
      const domNodes = await page.evaluate(() => (window as any).__h.domNodes());
      await longTasks();
      const scroll = await page.evaluate(async () => (window as any).__h.scrollTest(3000, 40, false));
      const scrollTasks = await longTasks();
      const jump = await page.evaluate(async () => (window as any).__h.scrollTest(2000, 0, true));
      const jumpTasks = await longTasks();
      await page.evaluate(() => { (window as any).__h.scroller().scrollTop = 0; });
      const collapse = await op('collapse', folder);

      // Warm: the same page, the folder's subtree closed and opened again.
      const warm: any[] = [];
      await op('expand', folder);
      for (let i = 0; i < warmCycles; i++) {
        const c = await op('collapseAllUnder', `${folder}/`);
        const e = await op('expandAllUnder', `${folder}/`);
        warm.push({ collapse: c, expand: e });
      }

      let everything: any = null;
      if (impl !== 'pl-browser') {
        const exp = await op('expandEverything');
        await longTasks();
        const j = await page.evaluate(async () => (window as any).__h.scrollTest(2000, 0, true));
        const jTasks = await longTasks();
        const col = await op('collapseEverything');
        const exp2 = await op('expandEverything');
        const col2 = await op('collapseEverything');
        everything = { expand: exp, jump: j, jumpTasks: jTasks, collapse: col, expandWarm: exp2, collapseWarm: col2 };
      }
      let filter: any = null;
      if (impl.startsWith('new')) {
        const keys: any[] = [];
        for (const q of ['p', 'pl', 'ple', 'plex', 'plex w', 'plex wo', 'plex wof', 'plex woff']) keys.push(await op('filter', q));
        const clear = await op('filter', '');
        filter = { keys, clear };
      }
      per.push({ first, heapLoad, expandOne, expandAll, heapExpanded, domNodes, scroll, scrollTasks, jump, jumpTasks, collapse, warm, everything, filter, errors: errors.slice(0, 3) });
      await ctx.close();
      console.log(impl, run, JSON.stringify({ first: round(first.renderMs), ready: round(first.readyMs), loadLongest: round(first.longest), expandAllWall: round(expandAll.wall), expandAllWork: round(expandAll.work), errors: errors.length }));
    }
    const pick = (f: (x: any) => number | null | undefined) => round(median(per.map((x) => f(x) ?? NaN)));
    const warmPick = (f: (w: any) => number) => round(median(per.flatMap((x) => x.warm.map(f))));
    out.impls[impl] = {
      median: {
        firstPaintMs: pick((x) => x.first.renderMs),
        fullIndexReadyMs: pick((x) => x.first.readyMs),
        loadLongestTaskMs: pick((x) => x.first.longest),
        loadTasksOver50: pick((x) => x.first.over50),
        heapAfterLoadMB: pick((x) => x.heapLoad.heapMB),
        expandOneWallMs: pick((x) => x.expandOne.wall),
        expandOneWorkMs: pick((x) => x.expandOne.work),
        expandAllWallMs: pick((x) => x.expandAll.wall),
        expandAllWorkMs: pick((x) => x.expandAll.work),
        expandAllLongestTaskMs: pick((x) => x.expandAll.longest),
        expandAllWarmWallMs: warmPick((w) => w.expand.wall),
        expandAllWarmWorkMs: warmPick((w) => w.expand.work),
        collapseWallMs: pick((x) => x.collapse.wall),
        collapseWorkMs: pick((x) => x.collapse.work),
        collapseAllWarmWallMs: warmPick((w) => w.collapse.wall),
        collapseAllWarmWorkMs: warmPick((w) => w.collapse.work),
        visibleRowsAfterExpandAll: per[0].expandAll.visible,
        domRowsAfterExpandAll: per[0].expandAll.rows,
        domNodesAfterExpandAll: pick((x) => x.domNodes),
        heapExpandedMB: pick((x) => x.heapExpanded.heapMB),
        scrollP50FrameMs: pick((x) => x.scroll.p50),
        scrollP95FrameMs: pick((x) => x.scroll.p95),
        scrollMaxFrameMs: pick((x) => x.scroll.max),
        scrollFramesOver33: pick((x) => x.scroll.over33),
        scrollLongestTaskMs: pick((x) => x.scrollTasks.longest),
        jumpP95FrameMs: pick((x) => x.jump.p95),
        jumpMaxFrameMs: pick((x) => x.jump.max),
        jumpLongestTaskMs: pick((x) => x.jumpTasks.longest),
        everythingExpandWallMs: pick((x) => x.everything?.expand.wall),
        everythingExpandWorkMs: pick((x) => x.everything?.expand.work),
        everythingExpandWarmWorkMs: pick((x) => x.everything?.expandWarm.work),
        everythingExpandLongestTaskMs: pick((x) => x.everything?.expand.longest),
        everythingVisibleRows: per[0].everything?.expand.visible ?? null,
        everythingJumpP95FrameMs: pick((x) => x.everything?.jump.p95),
        everythingJumpMaxFrameMs: pick((x) => x.everything?.jump.max),
        everythingCollapseWallMs: pick((x) => x.everything?.collapse.wall),
        everythingCollapseWorkMs: pick((x) => x.everything?.collapse.work),
        everythingCollapseWarmWorkMs: pick((x) => x.everything?.collapseWarm.work),
        everythingCollapseLongestTaskMs: pick((x) => x.everything?.collapse.longest),
        filterKeystrokeMaxWorkMs: pick((x) => (x.filter ? Math.max(...x.filter.keys.map((k: any) => k.work)) : null)),
        filterKeystrokeMedianWorkMs: pick((x) => (x.filter ? median(x.filter.keys.map((k: any) => k.work)) : null)),
        filterKeystrokeLongestTaskMs: pick((x) => (x.filter ? Math.max(...x.filter.keys.map((k: any) => k.longest)) : null)),
        filterClearWorkMs: pick((x) => x.filter?.clear.work),
      },
      runs: per,
    };
  }
  const outFile = opt('out');
  if (outFile) writeFileSync(outFile, JSON.stringify(out, null, 2));
  for (const [impl, r] of Object.entries(out.impls)) console.log(impl, JSON.stringify((r as any).median));
  await browser.close();
  server.stop(true);
}

async function shots() {
  const dir = resolve(opt('out', '/tmp/file-tree-lib/shots')!);
  mkdirSync(dir, { recursive: true });
  await build();
  const server = serve();
  const browser = await chromium.launch({ headless: true });
  const base = `http://127.0.0.1:${server.port}/?mode=shots`;
  const shoot = async (name: string, url: string, ctxOpts: Parameters<typeof browser.newContext>[0], act?: (page: any) => Promise<void>, clip?: { x: number; y: number; width: number; height: number }) => {
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForFunction(() => (window as any).__h?.ready === true);
    await page.waitForTimeout(150);
    if (act) await act(page);
    await page.screenshot({ path: join(dir, `${name}.png`), clip });
    await ctx.close();
    console.log('wrote', name);
  };
  const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
  const hoverAndKeys = async (page: any) => {
    await page.click('[role="tree"] [data-path="packages/ui/components/file-tree/store.ts"]');
    await page.keyboard.press('ArrowDown');
    await page.mouse.move(150, 300);
  };
  for (const theme of ['light', 'dark']) {
    await shoot(`small-1440-${theme}`, `${base}&set=small&theme=${theme}`, desktop, undefined, { x: 0, y: 0, width: 320, height: 520 });
    await shoot(`small-1440-${theme}-hover-focus`, `${base}&set=small&theme=${theme}`, desktop, hoverAndKeys, { x: 0, y: 0, width: 320, height: 520 });
    await shoot(`deep-1440-${theme}-hover`, `${base}&set=deep&theme=${theme}`, desktop, async (page) => page.mouse.move(100, 200), { x: 0, y: 0, width: 320, height: 760 });
    await shoot(`parity-${theme}`, `${base}&set=parity&theme=${theme}`, desktop, undefined, { x: 0, y: 0, width: 680, height: 660 });
  }
  // A long name cut with an ellipsis, its whole name in the component tooltip.
  await shoot(
    'deep-1440-light-tooltip',
    `${base}&set=deep&theme=light`,
    desktop,
    async (page) => {
      const name = page.locator('[role="treeitem"][data-path$="sidebar-20.config.json"] span.truncate');
      await name.hover();
      await page.waitForSelector('[data-pn-tooltip]', { timeout: 3000 });
      await page.waitForTimeout(250);
    },
    { x: 0, y: 380, width: 760, height: 380 },
  );
  // Depth 20: scroll the deepest rows into view.
  await shoot(`deep-1440-light-depth20`, `${base}&set=deep&theme=light`, desktop, async (page) => {
    await page.evaluate(() => { const t = document.querySelector('[role="tree"]')!; t.scrollTop = t.scrollHeight; });
    await page.mouse.move(100, 400);
    await page.waitForTimeout(100);
  }, { x: 0, y: 0, width: 320, height: 760 });
  for (const theme of ['light', 'dark']) {
    await shoot(`phone-${theme}`, `${base}&set=small&theme=${theme}&phone=1`, { ...devices['iPhone 13'] }, undefined);
  }
  await browser.close();
  server.stop(true);
}

if (cmd === 'bench') await bench();
else if (cmd === 'shots') await shots();
else {
  console.error('usage: run.ts bench --paths <json> --folder <folder> | run.ts shots --out <dir>');
  process.exit(2);
}
