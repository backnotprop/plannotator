/**
 * FileTreeStore's sliced build: the preview is exactly what the full tree
 * shows with nothing open, no slice runs long, and every change made while the
 * index is still building lands on the final tree as if the tree had been
 * ready all along.
 */
import { describe, expect, test } from 'bun:test';
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

describe('FileTreeStore sliced build', () => {
  test('the preview is the collapsed tree, and the build lands in short slices', async () => {
    const sliced = new FileTreeStore(PATHS, { sliced: true });
    const whole = new FileTreeStore(PATHS);
    expect(sliced.loading).toBe(true);
    expect(listing(sliced)).toEqual(listing(whole));
    // Measure the gaps the build leaves: a message posted between slices must get a turn quickly.
    const gaps: number[] = [];
    let last = performance.now();
    let probing = true;
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      if (probing) ch.port2.postMessage(null);
    };
    ch.port2.postMessage(null);
    await sliced.whenReady();
    probing = false;
    ch.port1.close();
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

  test('a new snapshot while building starts the build again from it', async () => {
    const sliced = new FileTreeStore(PATHS, { sliced: true });
    const next = PATHS.filter((p) => !p.startsWith('pkg1/')).concat('fresh.ts');
    sliced.setPaths(next);
    await sliced.whenReady();
    expect(listing(sliced)).toEqual(listing(new FileTreeStore(next)));
  });
});
