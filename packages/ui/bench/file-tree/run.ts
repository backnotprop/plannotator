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
 * Every number is the median of `--runs` fresh pages. Long tasks come from a
 * PerformanceObserver; scroll frame times are requestAnimationFrame deltas
 * while scrollTop moves 40 px a frame for 3 s ("scroll") and jumps to a random
 * place every frame for 2 s ("jump").
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
  let impls = opt('impls', 'new,new-tips,pl-browser,pierre')!.split(',');
  if (!process.env.PIERRE_TREES_DIR) impls = impls.filter((i) => i !== 'pierre');
  await build();
  const server = serve(pathsFile);
  const browser = await chromium.launch({ headless: true });
  const out: Record<string, any> = { paths: pathsFile, folder, runs, at: new Date().toISOString(), impls: {} };
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
      await page.goto(`http://127.0.0.1:${server.port}/?mode=bench&impl=${impl}&theme=light`);
      await page.waitForFunction(() => (window as any).__h?.ready === true, null, { timeout: 300000 });
      const longest = () =>
        page.evaluate(() => {
          const lt = (window as any).__long as { s: number; d: number }[];
          return { total: lt.reduce((a, b) => a + b.d, 0), longest: Math.max(0, ...lt.map((x) => x.d)) };
        });
      const reset = () => page.evaluate(() => { (window as any).__long.length = 0; });
      const heap = async () => {
        await cdp.send('HeapProfiler.collectGarbage');
        const m = await cdp.send('Performance.getMetrics');
        const g = (n: string) => m.metrics.find((x: any) => x.name === n)?.value ?? 0;
        return { jsHeapMB: g('JSHeapUsedSize') / 1048576, nodes: g('Nodes') };
      };
      const first = await page.evaluate(() => {
        const h = (window as any).__h;
        const lt = ((window as any).__long as { s: number; d: number }[]).filter((x) => x.s + x.d >= h.marks.dataReceived);
        return { renderMs: h.marks.painted - h.marks.dataReceived, rows: h.rowCount(), domNodes: h.domNodes(), longest: Math.max(0, ...lt.map((x) => x.d)) };
      });
      const heapLoad = await heap();
      await reset();
      const expandOne = await page.evaluate(async (p) => {
        const h = (window as any).__h;
        const parts = p.split('/');
        let ms = 0;
        for (let i = 1; i <= parts.length; i++) ms = await h.expand(parts.slice(0, i).join('/'));
        return { ms, rows: h.rowCount() };
      }, folder);
      await reset();
      const expandAll = await page.evaluate(async (p) => {
        const h = (window as any).__h;
        const r = await h.expandAllUnder(`${p}/`);
        return { ...r, work: h.lastWork ?? null, rows: h.rowCount(), domNodes: h.domNodes() };
      }, folder);
      const expandAllTasks = await longest();
      const heapExpanded = await heap();
      await reset();
      const scroll = await page.evaluate(async () => (window as any).__h.scrollTest(3000, 40, false));
      const scrollTasks = await longest();
      await reset();
      const jump = await page.evaluate(async () => (window as any).__h.scrollTest(2000, 0, true));
      const jumpTasks = await longest();
      await reset();
      const collapse = await page.evaluate(async (p) => {
        const h = (window as any).__h;
        h.scroller().scrollTop = 0;
        const ms = await h.collapse(p);
        return { ms, work: h.lastWork ?? null, rows: h.rowCount() };
      }, folder);
      const collapseTasks = await longest();
      let everything: any = null;
      if (impl !== 'pl-browser') {
        await reset();
        const exp = await page.evaluate(async () => ({ ...(await (window as any).__h.expandEverything()), work: (window as any).__h.lastWork ?? null }));
        const expTasks = await longest();
        await reset();
        const scrollAll = await page.evaluate(async () => (window as any).__h.scrollTest(2000, 0, true));
        await reset();
        const col = await page.evaluate(async () => ({ ...(await (window as any).__h.collapseEverything()), work: (window as any).__h.lastWork ?? null }));
        const colTasks = await longest();
        everything = { expand: exp, expandTasks: expTasks, jump: scrollAll, collapse: col, collapseTasks: colTasks };
      }
      per.push({ first, heapLoad, expandOne, expandAll, expandAllTasks, heapExpanded, scroll, scrollTasks, jump, jumpTasks, collapse, collapseTasks, everything, errors: errors.slice(0, 3) });
      await ctx.close();
      console.log(impl, run, JSON.stringify({ first: round(first.renderMs), expandAll: round(expandAll.ms), rows: expandAll.rows, scrollP95: round(scroll.p95), errors: errors.length }));
    }
    const pick = (f: (x: any) => number | null | undefined) => round(median(per.map((x) => f(x) ?? NaN)));
    out.impls[impl] = {
      median: {
        firstPaintMs: pick((x) => x.first.renderMs),
        firstLongestTaskMs: pick((x) => x.first.longest),
        heapAfterLoadMB: pick((x) => x.heapLoad.jsHeapMB),
        expandOneMs: pick((x) => x.expandOne.ms),
        expandAllMs: pick((x) => x.expandAll.ms),
        expandAllLongestTaskMs: pick((x) => x.expandAllTasks.longest),
        expandAllWorkMs: pick((x) => x.expandAll.work),
        visibleRowsAfterExpandAll: per[0].expandAll.visible,
        domRowsAfterExpandAll: per[0].expandAll.rows,
        domNodesAfterExpandAll: pick((x) => x.expandAll.domNodes),
        heapExpandedMB: pick((x) => x.heapExpanded.jsHeapMB),
        scrollP50FrameMs: pick((x) => x.scroll.p50),
        scrollP95FrameMs: pick((x) => x.scroll.p95),
        scrollMaxFrameMs: pick((x) => x.scroll.max),
        scrollFramesOver33: pick((x) => x.scroll.over33),
        scrollLongestTaskMs: pick((x) => x.scrollTasks.longest),
        jumpP95FrameMs: pick((x) => x.jump.p95),
        jumpMaxFrameMs: pick((x) => x.jump.max),
        jumpLongestTaskMs: pick((x) => x.jumpTasks.longest),
        collapseMs: pick((x) => x.collapse.ms),
        collapseLongestTaskMs: pick((x) => x.collapseTasks.longest),
        collapseWorkMs: pick((x) => x.collapse.work),
        everythingExpandMs: pick((x) => x.everything?.expand.ms),
        everythingExpandLongestTaskMs: pick((x) => x.everything?.expandTasks.longest),
        everythingExpandWorkMs: pick((x) => x.everything?.expand.work),
        everythingVisibleRows: per[0].everything?.expand.visible ?? null,
        everythingJumpP95FrameMs: pick((x) => x.everything?.jump.p95),
        everythingJumpMaxFrameMs: pick((x) => x.everything?.jump.max),
        everythingCollapseMs: pick((x) => x.everything?.collapse.ms),
        everythingCollapseLongestTaskMs: pick((x) => x.everything?.collapseTasks.longest),
        everythingCollapseWorkMs: pick((x) => x.everything?.collapse.work),
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
