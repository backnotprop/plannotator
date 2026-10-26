/**
 * FileTreeStore's sliced build: the preview is exactly what the full tree
 * shows with nothing open, no slice runs long, and every change made while the
 * index is still building lands on the final tree as if the tree had been
 * ready all along.
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { FileTreeStore } from './store';

const PATHS = [
  ...Array.from({ length: 60_000 }, (_, i) => `pkg${i % 30}/src/m${i % 400}/f${i}.ts`),
  'README.md',
  'docs/guide.md',
  'empty/',
];

function listing(store: FileTreeStore): string[] {
  const m = store.model;
  return m.rows(0, m.rowCount).map((r) => `${'  '.repeat(r.depth)}${r.name}${r.isDir ? (r.expanded ? '/ open' : '/') : ''}`);
}

/**
 * Let the build run to the end and return the gaps a message posted between
 * tasks saw: a long task shows as a long gap. The probe runs one more turn
 * after the index lands, so the task that swapped it in is counted too.
 */
async function buildGaps(store: FileTreeStore): Promise<number[]> {
  const gaps: number[] = [];
  let last = performance.now();
  let ready = false;
  let finish = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const ch = new MessageChannel();
  ch.port1.onmessage = () => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
    if (!ready) {
      ch.port2.postMessage(null);
      return;
    }
    ch.port1.close();
    finish();
  };
  ch.port2.postMessage(null);
  await store.whenReady();
  ready = true;
  await done;
  return gaps;
}

describe('FileTreeStore sliced build', () => {
  test('the preview is the collapsed tree, and the build lands in short slices', async () => {
    const sliced = new FileTreeStore(PATHS, { sliced: true });
    const whole = new FileTreeStore(PATHS);
    expect(sliced.loading).toBe(true);
    expect(listing(sliced)).toEqual(listing(whole));
    const gaps = await buildGaps(sliced);
    expect(sliced.loading).toBe(false);
    expect(listing(sliced)).toEqual(listing(whole));
    expect(gaps.length).toBeGreaterThan(2);
    // A slice is 8 ms plus at most one build step (a few ms): far under 50.
    expect(Math.max(...gaps)).toBeLessThan(40);
  });

  test('changes made while the index builds land on the final tree', async () => {
    const ops = (s: FileTreeStore) => {
      s.expand('pkg3');
      s.expandAll('pkg7/src/m7');
      s.add('pkg3/new/file.ts');
      s.remove('docs');
      s.setBadges(new Map([['pkg3/new/file.ts', { letter: 'A', additions: 4 }]]));
      s.setFilter('new');
      s.setFilter('');
      s.toggle('pkg9');
    };
    const sliced = new FileTreeStore(PATHS, { sliced: true });
    ops(sliced);
    const whole = new FileTreeStore(PATHS);
    ops(whole);
    await sliced.whenReady();
    expect(listing(sliced)).toEqual(listing(whole));
    const id = sliced.model.find('pkg3');
    expect(sliced.model.totals(id)).toEqual(whole.model.totals(whole.model.find('pkg3')));
  });

  test('a new snapshot while building lands on the full index', async () => {
    const sliced = new FileTreeStore(PATHS, { sliced: true });
    const next = PATHS.filter((p) => !p.startsWith('pkg1/')).concat('fresh.ts');
    sliced.setPaths(next);
    await sliced.whenReady();
    expect(listing(sliced)).toEqual(listing(new FileTreeStore(next)));
  });

  test('a snapshot while building keeps the opens and closes made before it', async () => {
    const ops = (s: FileTreeStore) => {
      s.expand('pkg3');
      s.expand('pkg3/src');
      s.collapse('pkg3/src');
      s.expand('pkg4');
      s.toggle('pkg4');
      s.expandAll('pkg7/src/m7');
    };
    const sliced = new FileTreeStore(PATHS, { sliced: true });
    ops(sliced);
    const next = PATHS.filter((p) => !p.startsWith('pkg1/')).concat('fresh.ts');
    sliced.setPaths(next);
    await sliced.whenReady();
    const whole = new FileTreeStore(next);
    ops(whole);
    expect(listing(sliced)).toEqual(listing(whole));
    expect(sliced.isExpanded('pkg3')).toBe(true);
    expect(sliced.isExpanded('pkg7/src/m7')).toBe(true);
  });

  test('a toggle while building does what the person saw, with folders open at the start', async () => {
    const sliced = new FileTreeStore(PATHS, { sliced: true, expanded: ['pkg2', 'pkg2/src'] });
    const whole = new FileTreeStore(PATHS, { expanded: ['pkg2', 'pkg2/src'] });
    // The preview already shows what the full tree shows at the start.
    expect(listing(sliced)).toEqual(listing(whole));
    expect(sliced.isExpanded('pkg2')).toBe(true);
    sliced.toggle('pkg2');
    whole.toggle('pkg2');
    expect(sliced.isExpanded('pkg2')).toBe(false);
    await sliced.whenReady();
    expect(sliced.isExpanded('pkg2')).toBe(false);
    expect(listing(sliced)).toEqual(listing(whole));
  });

  test('ten filter keystrokes while building cost one filter pass, no task over 50 ms (the swap included)', async () => {
    const big = Array.from({ length: 150_000 }, (_, i) => `pkg${i % 40}/src/dir${i % 900}/file${i}.ts`);
    const sliced = new FileTreeStore(big, { sliced: true });
    sliced.subscribe(() => {});
    for (const q of ['f', 'fi', 'fil', 'file', 'file1', 'file12', 'file123', 'file12', 'file1', 'file1/']) sliced.setFilter(q);
    expect(sliced.filterPending).toBe(true);
    const gaps = await buildGaps(sliced);
    expect(sliced.filterPending).toBe(false);
    const whole = new FileTreeStore(big);
    whole.setFilter('file1/');
    expect(listing(sliced)).toEqual(listing(whole));
    expect(Math.max(...gaps)).toBeLessThan(50);
  });

  test('a filter set while building shows nothing until the index lands', async () => {
    const sliced = new FileTreeStore(PATHS, { sliced: true });
    const preview = listing(sliced);
    sliced.setFilter('guide');
    expect(sliced.filterPending).toBe(true);
    // The preview is left as it was: it has no filtered rows to show.
    expect(listing(sliced)).toEqual(preview);
    sliced.expand('pkg5');
    sliced.setFilter('');
    expect(sliced.filterPending).toBe(false);
    await sliced.whenReady();
    const whole = new FileTreeStore(PATHS);
    whole.setFilter('guide');
    whole.expand('pkg5');
    whole.setFilter('');
    expect(listing(sliced)).toEqual(listing(whole));
  });

  test('a snapshot changing over a quarter of the paths builds in slices, open folders and filter kept', async () => {
    const big = Array.from({ length: 60_000 }, (_, i) => `pkg${i % 30}/src/m${i % 400}/f${i}.ts`);
    const store = new FileTreeStore(big, { sliced: true });
    await store.whenReady();
    store.expand('pkg3');
    store.expand('pkg3/src');
    const next = big.filter((_, i) => i % 2 === 0).concat(Array.from({ length: 2_000 }, (_, i) => `pkg3/src/new${i}.ts`));
    const t0 = performance.now();
    expect(store.setPaths(next)).toBe(true);
    const syncMs = performance.now() - t0;
    expect(store.loading).toBe(true);
    // The rows shown meanwhile are the new snapshot's, with the same folders open.
    const whole = new FileTreeStore(next, { expanded: ['pkg3', 'pkg3/src'] });
    expect(listing(store)).toEqual(listing(whole));
    expect(syncMs).toBeLessThan(150);
    await store.whenReady();
    expect(listing(store)).toEqual(listing(whole));
    store.setFilter('new12');
    const t1 = performance.now();
    store.setPaths(big);
    expect(performance.now() - t1).toBeLessThan(150);
    expect(store.filterPending).toBe(true);
    await store.whenReady();
    const back = new FileTreeStore(big, { expanded: ['pkg3', 'pkg3/src'] });
    back.setFilter('new12');
    expect(listing(store)).toEqual(listing(back));
  });

  test('reveal of a path the filter hides opens nothing', () => {
    const store = new FileTreeStore(['src/a.ts', 'src/deep/b.ts', 'docs/c.md']);
    store.setFilter('a.ts');
    const before = store.expandedPaths();
    expect(store.reveal('src/deep/b.ts')).toBe(-1);
    expect(store.expandedPaths()).toEqual(before);
    store.setFilter('');
    expect(store.isExpanded('src/deep')).toBe(false);
    expect(store.isExpanded('src')).toBe(false);
  });

  test('the build waits for someone to use the store, and a disposed store lets waiters go', async () => {
    const idle = new FileTreeStore(PATHS, { sliced: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(idle.loading).toBe(true);
    const store = new FileTreeStore(PATHS, { sliced: true });
    const ready = store.whenReady();
    store.dispose();
    let settled = false;
    void ready.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(true);
    // A dispose followed at once by resume (React's StrictMode) is not the end.
    const twice = new FileTreeStore(PATHS, { sliced: true });
    const done = twice.whenReady();
    twice.dispose();
    twice.resume();
    await done;
    expect(twice.loading).toBe(false);
  });
});

describe('FileTreeStore sliced against built at once', () => {
  // Over SLICE_MIN_PATHS, so the sliced store really builds in slices.
  const BULK = Array.from({ length: 4_200 }, (_, i) => `bulk/d${i % 60}/f${i}.ts`);
  const SMALL = ['pkg1/a.ts', 'pkg1/sub/b.ts', 'pkg2/c.ts', 'docs/x.md', 'top.md'];
  const TARGET = fc.constantFrom('pkg1', 'pkg1/sub', 'pkg1/a.ts', 'pkg2', 'docs', 'bulk', 'bulk/d3', 'new', 'new/n.ts');
  /** One change, made on the sliced store and on the store built at once. */
  type StoreOp = (sliced: FileTreeStore, whole: FileTreeStore) => void;
  const both =
    (change: (s: FileTreeStore) => unknown): StoreOp =>
    (sliced, whole) => {
      change(sliced);
      change(whole);
    };
  const OP: fc.Arbitrary<StoreOp> = fc.oneof(
    TARGET.map((p) => both((s) => s.expand(p))),
    TARGET.map((p) => both((s) => s.collapse(p))),
    // A toggle on a row the person sees is the open or close they saw, even
    // where the preview has not yet opened what a host's change opens deeper down.
    TARGET.map((p): StoreOp => (sliced, whole) => {
      const seen = sliced.loading && !sliced.filterPending && sliced.model.find(p) > 0;
      const open = sliced.isExpanded(p);
      sliced.toggle(p);
      if (!seen) whole.toggle(p);
      else if (open) whole.collapse(p);
      else whole.expand(p);
    }),
    fc.option(TARGET, { nil: undefined }).map((p) => both((s) => s.expandAll(p))),
    fc.option(TARGET, { nil: undefined }).map((p) => both((s) => s.collapseAll(p))),
    TARGET.map((p) => both((s) => s.reveal(p))),
    TARGET.map((p) => both((s) => s.add(p.includes('.') ? p : `${p}/added.ts`))),
    TARGET.map((p) => both((s) => s.remove(p))),
    fc.constantFrom('', 'a', 'pkg1/', 'f12', 'zz').map((q) => both((s) => s.setFilter(q))),
    // A snapshot: some of the small paths, the bulk whole or (a rebuild) halved.
    fc
      .tuple(fc.subarray(SMALL), fc.boolean(), fc.boolean())
      .map(([small, half, extra]) => {
        const list = [...(half ? BULK.filter((_, i) => i % 2 === 0) : BULK), ...small, ...(extra ? ['new/n.ts'] : [])];
        return both((s) => s.setPaths(list));
      }),
  );

  function state(store: FileTreeStore) {
    return { rows: listing(store), expanded: [...store.expandedPaths()].sort() };
  }

  test('a folder removed while building, then brought back by a snapshot, comes back closed', async () => {
    const ops = (s: FileTreeStore) => {
      s.toggle('pkg1');
      s.remove('pkg1');
      s.setPaths([...BULK, ...SMALL]);
    };
    const sliced = new FileTreeStore([...BULK, ...SMALL], { sliced: true });
    expect(sliced.loading).toBe(true);
    ops(sliced);
    await sliced.whenReady();
    const whole = new FileTreeStore([...BULK, ...SMALL]);
    ops(whole);
    expect(whole.isExpanded('pkg1')).toBe(false);
    expect(sliced.isExpanded('pkg1')).toBe(false);
    expect(state(sliced)).toEqual(state(whole));
  });

  test('any changes made while the index builds end as they do on a store built at once', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(OP, { maxLength: 12 }), async (ops) => {
        const sliced = new FileTreeStore([...BULK, ...SMALL], { sliced: true });
        const whole = new FileTreeStore([...BULK, ...SMALL]);
        for (const op of ops) op(sliced, whole);
        await sliced.whenReady();
        expect(state(sliced)).toEqual(state(whole));
      }),
      { numRuns: 60 },
    );
  });
});
