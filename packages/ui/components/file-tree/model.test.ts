/**
 * FileTreeModel against a naive reference: the reference keeps the listed
 * files and folders as plain sets, derives the tree from them on every read,
 * sorts each folder's children and flattens recursively. For random path sets
 * and random sequences of expand, collapse, expand-all, collapse-all, add,
 * remove, unlist and snapshot replacement, every row (`rowAt(i)` for each i),
 * every `indexOf(path)`, each row's level, set size and position, and the
 * folder roll-up marks must equal the reference.
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { FileTreeModel, compareTreeNames, normalizeTreePath, ROOT } from './model';

// ---------------------------------------------------------------- reference

class Reference {
  files = new Set<string>();
  dirs = new Set<string>();
  expanded = new Set<string>();
  values = new Map<string, { mark?: boolean; additions?: number; deletions?: number; count?: number }>();

  constructor(paths: string[]) {
    this.setPaths(paths);
  }

  private static list(path: string): { key: string; dir: boolean } | null {
    const n = normalizeTreePath(path);
    return n ? { key: n.key, dir: n.dir } : null;
  }

  /** All nodes: every listed path and every prefix of one. */
  nodes(): Set<string> {
    const out = new Set<string>();
    for (const p of [...this.files, ...this.dirs]) {
      const parts = p.split('/');
      for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join('/'));
    }
    return out;
  }

  isDir(path: string, nodes = this.nodes()): boolean {
    if (this.dirs.has(path)) return true;
    for (const n of nodes) if (n.startsWith(`${path}/`)) return true;
    return false;
  }

  children(path: string | null, nodes = this.nodes()): string[] {
    const depth = path === null ? 0 : path.split('/').length;
    const kids = [...nodes].filter((n) => {
      const parts = n.split('/');
      if (parts.length !== depth + 1) return false;
      return path === null || n.startsWith(`${path}/`);
    });
    const dir = new Map(kids.map((k) => [k, this.isDir(k, nodes)]));
    return kids.sort((a, b) => {
      if (dir.get(a) !== dir.get(b)) return dir.get(a) ? -1 : 1;
      return compareTreeNames(a.split('/').pop()!, b.split('/').pop()!);
    });
  }

  rows(): Array<{ path: string; level: number; setSize: number; posInSet: number; isDir: boolean; expanded: boolean; markedBelow: boolean; totals: { additions: number; deletions: number; count: number; marked: number } }> {
    const nodes = this.nodes();
    const out: ReturnType<Reference['rows']> = [];
    const walk = (parent: string | null, level: number) => {
      const kids = this.children(parent, nodes);
      kids.forEach((k, i) => {
        const isDir = this.isDir(k, nodes);
        const expanded = isDir && this.expanded.has(k);
        const markedBelow = [...this.values].some(([m, v]) => v.mark && nodes.has(m) && m.startsWith(`${k}/`));
        const totals = { additions: 0, deletions: 0, count: 0, marked: 0 };
        for (const [m, v] of this.values) {
          if (!nodes.has(m) || (m !== k && !m.startsWith(`${k}/`))) continue;
          totals.additions += v.additions ?? 0;
          totals.deletions += v.deletions ?? 0;
          totals.count += v.count ?? 0;
          totals.marked += v.mark ? 1 : 0;
        }
        out.push({ path: k, level, setSize: kids.length, posInSet: i + 1, isDir, expanded, markedBelow, totals });
        if (expanded) walk(k, level + 1);
      });
    };
    walk(null, 1);
    return out;
  }

  /** Expansion only lives on folders: drop it where the folder went or became a file. */
  private settle(): void {
    const nodes = this.nodes();
    for (const e of [...this.expanded]) if (!nodes.has(e) || !this.isDir(e, nodes)) this.expanded.delete(e);
  }

  add(path: string) {
    const n = Reference.list(path);
    if (!n) return;
    (n.dir ? this.dirs : this.files).add(n.key);
    this.settle();
  }

  remove(path: string) {
    const n = Reference.list(path);
    if (!n) return;
    const nodes = this.nodes();
    if (!nodes.has(n.key)) return;
    const under = (p: string) => p === n.key || p.startsWith(`${n.key}/`);
    for (const set of [this.files, this.dirs]) for (const p of [...set]) if (under(p)) set.delete(p);
    this.settle();
  }

  unlist(path: string) {
    const n = Reference.list(path);
    if (!n) return;
    (n.dir ? this.dirs : this.files).delete(n.key);
    this.settle();
  }

  setPaths(paths: string[]) {
    this.files = new Set();
    this.dirs = new Set();
    for (const p of paths) {
      const n = Reference.list(p);
      if (n) (n.dir ? this.dirs : this.files).add(n.key);
    }
    this.settle();
  }

  expand(path: string) {
    const nodes = this.nodes();
    if (nodes.has(path) && this.isDir(path, nodes)) this.expanded.add(path);
  }

  collapse(path: string) {
    this.expanded.delete(path);
  }

  expandAll(path: string | null) {
    const nodes = this.nodes();
    if (path !== null && (!nodes.has(path) || !this.isDir(path, nodes))) return;
    for (const n of nodes) if ((path === null || n === path || n.startsWith(`${path}/`)) && this.isDir(n, nodes)) this.expanded.add(n);
  }

  collapseAll(path: string | null) {
    for (const e of [...this.expanded]) if (path === null || e === path || e.startsWith(`${path}/`)) this.expanded.delete(e);
  }

  expandAncestors(path: string) {
    const nodes = this.nodes();
    if (!nodes.has(path)) return;
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) this.expanded.add(parts.slice(0, i).join('/'));
  }

  setValues(values: Map<string, { mark?: boolean; additions?: number; deletions?: number; count?: number }>) {
    this.values = new Map();
    for (const [p, v] of values) {
      const k = normalizeTreePath(p)?.key;
      if (k) this.values.set(k, v);
    }
  }
}

// ---------------------------------------------------------------- comparison

function check(model: FileTreeModel, ref: Reference) {
  const want = ref.rows();
  expect(model.rowCount).toBe(want.length);
  const got = model.rows(0, want.length + 5);
  expect(got.length).toBe(want.length);
  want.forEach((w, i) => {
    const id = model.rowAt(i);
    expect(id).toBe(got[i].id);
    expect(model.pathOf(id)).toBe(w.path);
    const r = got[i];
    expect({ path: model.pathOf(r.id), level: r.depth + 1, setSize: r.setSize, posInSet: r.posInSet, isDir: r.isDir, expanded: r.expanded, markedBelow: r.markedBelow, totals: model.totals(r.id) }).toEqual(w);
    expect(r.index).toBe(i);
    expect(model.indexOf(w.path)).toBe(i);
    expect(model.indexOfId(id)).toBe(i);
  });
  expect(model.rowAt(want.length)).toBe(-1);
  expect(model.rowAt(-1)).toBe(-1);
  // Every node that exists but is hidden answers -1.
  const shown = new Set(want.map((w) => w.path));
  for (const n of ref.nodes()) {
    if (!shown.has(n)) expect(model.indexOf(n)).toBe(-1);
    expect(model.find(n)).toBeGreaterThan(ROOT);
  }
  // Rows from any start agree with the full list.
  if (want.length > 0) {
    const start = Math.floor(want.length / 2);
    expect(model.rows(start, 3).map((r) => model.pathOf(r.id))).toEqual(want.slice(start, start + 3).map((w) => w.path));
  }
  expect(model.expandedPaths()).toEqual(new Set([...ref.expanded]));
}

// ---------------------------------------------------------------- generators

// A small alphabet so paths collide, share folders, sort by number and case,
// and a file named like a folder shows up.
const SEG = fc.constantFrom('a', 'A', 'b', 'a1', 'a2', 'a10', 'B10', 'x y', 'é', 'e', '_z', '.git', 'src', '日本');
const PATH = fc
  .tuple(fc.array(SEG, { minLength: 1, maxLength: 4 }), fc.integer({ min: 0, max: 9 }), fc.constantFrom('', '', '', '/', './'))
  .map(([segs, roll, lead]) => `${lead}${segs.join('/')}${roll === 0 ? '/' : ''}`);
const PATHS = fc.array(PATH, { maxLength: 30 });

type Op =
  | { t: 'add'; p: string }
  | { t: 'remove'; p: string }
  | { t: 'unlist'; p: string }
  | { t: 'set'; ps: string[] }
  | { t: 'expand'; p: string }
  | { t: 'collapse'; p: string }
  | { t: 'expandAll'; p: string | null }
  | { t: 'collapseAll'; p: string | null }
  | { t: 'reveal'; p: string }
  | { t: 'values'; vs: Map<string, { mark?: boolean; additions?: number; deletions?: number; count?: number }> };

/** Folder-ish targets (prefixes) are drawn from the same alphabet. */
const TARGET = fc.array(SEG, { minLength: 1, maxLength: 3 }).map((s) => s.join('/'));
const OP: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: PATH.map((p) => ({ t: 'add' as const, p })) },
  { weight: 3, arbitrary: TARGET.map((p) => ({ t: 'remove' as const, p })) },
  { weight: 2, arbitrary: PATH.map((p) => ({ t: 'unlist' as const, p })) },
  { weight: 1, arbitrary: PATHS.map((ps) => ({ t: 'set' as const, ps })) },
  { weight: 6, arbitrary: TARGET.map((p) => ({ t: 'expand' as const, p })) },
  { weight: 3, arbitrary: TARGET.map((p) => ({ t: 'collapse' as const, p })) },
  { weight: 2, arbitrary: fc.option(TARGET, { nil: null }).map((p) => ({ t: 'expandAll' as const, p })) },
  { weight: 2, arbitrary: fc.option(TARGET, { nil: null }).map((p) => ({ t: 'collapseAll' as const, p })) },
  { weight: 2, arbitrary: TARGET.map((p) => ({ t: 'reveal' as const, p })) },
  {
    weight: 2,
    arbitrary: fc
      .array(fc.tuple(TARGET, fc.record({ mark: fc.boolean(), additions: fc.nat(50), deletions: fc.nat(50), count: fc.nat(5) })), { maxLength: 5 })
      .map((entries) => ({ t: 'values' as const, vs: new Map(entries) })),
  },
);

function apply(model: FileTreeModel, ref: Reference, op: Op) {
  const id = (p: string) => model.find(p);
  switch (op.t) {
    case 'add': model.add(op.p); ref.add(op.p); break;
    case 'remove': model.remove(op.p); ref.remove(op.p); break;
    case 'unlist': model.unlist(op.p); ref.unlist(op.p); break;
    case 'set': model.setPaths(op.ps); ref.setPaths(op.ps); break;
    case 'expand': { const n = id(op.p); if (n > ROOT) model.expand(n); ref.expand(op.p); break; }
    case 'collapse': { const n = id(op.p); if (n > ROOT) model.collapse(n); ref.collapse(op.p); break; }
    case 'expandAll': {
      if (op.p === null) model.expandAll();
      else { const n = id(op.p); if (n > ROOT) model.expandAll(n); }
      ref.expandAll(op.p);
      break;
    }
    case 'collapseAll': {
      if (op.p === null) model.collapseAll();
      else { const n = id(op.p); if (n > ROOT) model.collapseAll(n); }
      ref.collapseAll(op.p);
      break;
    }
    case 'reveal': { const n = id(op.p); if (n > ROOT) model.expandAncestors(n); ref.expandAncestors(op.p); break; }
    case 'values': model.setValues(op.vs); ref.setValues(op.vs); break;
  }
}

describe('FileTreeModel matches the naive reference', () => {
  test('random path sets, fully expanded and fully collapsed', () => {
    fc.assert(
      fc.property(PATHS, (paths) => {
        const model = new FileTreeModel(paths);
        const ref = new Reference(paths);
        check(model, ref);
        model.expandAll();
        ref.expandAll(null);
        check(model, ref);
        model.collapseAll();
        ref.collapseAll(null);
        check(model, ref);
      }),
      { numRuns: 300 },
    );
  });

  test('random sequences of expand, collapse, expand-all, collapse-all, add, remove and snapshots', () => {
    fc.assert(
      fc.property(PATHS, fc.array(OP, { maxLength: 40 }), (paths, ops) => {
        const model = new FileTreeModel(paths);
        const ref = new Reference(paths);
        check(model, ref);
        for (const op of ops) {
          apply(model, ref, op);
          check(model, ref);
        }
      }),
      { numRuns: 400 },
    );
  });

  test('a snapshot that changes most of the list (the rebuild path) keeps expansion of folders that stay', () => {
    const before = Array.from({ length: 3000 }, (_, i) => `keep/f${i}.ts`);
    const model = new FileTreeModel([...before, 'gone/x.ts']);
    model.expand(model.find('keep'));
    const after = Array.from({ length: 3000 }, (_, i) => `keep/g${i}.ts`);
    model.setPaths(after);
    const ref = new Reference(after);
    ref.expand('keep');
    check(model, ref);
  });
});

describe('FileTreeModel build', () => {
  // reset() reuses the previous path's folders when a path repeats its prefix;
  // the order of the input must never change the tree.
  test('sorted, reversed and shuffled input build the same tree', () => {
    fc.assert(
      fc.property(PATHS, fc.integer(), (paths, seed) => {
        const shuffled = [...paths];
        let x = seed >>> 0;
        for (let i = shuffled.length - 1; i > 0; i--) {
          x = (x * 1103515245 + 12345) >>> 0;
          const j = x % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const listing = (m: FileTreeModel) => {
          m.expandAll();
          return m.rows(0, m.rowCount).map((r) => `${m.pathOf(r.id)}${r.isDir ? '/' : ''}`);
        };
        const want = listing(new FileTreeModel([...paths].sort()));
        expect(listing(new FileTreeModel([...paths].sort().reverse()))).toEqual(want);
        expect(listing(new FileTreeModel(shuffled))).toEqual(want);
        const ref = new Reference(paths);
        ref.expandAll(null);
        expect(want).toEqual(ref.rows().map((r) => `${r.path}${r.isDir ? '/' : ''}`));
      }),
      { numRuns: 400 },
    );
  });

  test('a file and the same name as a folder, in either order', () => {
    for (const paths of [['a/b', 'a/b/c', 'a/bc'], ['a/b/c', 'a/b', 'a/bc'], ['a/bc', 'a/b/c', 'a/b']]) {
      const m = new FileTreeModel(paths);
      m.expandAll();
      expect(m.rows(0, 10).map((r) => m.pathOf(r.id))).toEqual(['a', 'a/b', 'a/b/c', 'a/bc']);
    }
  });
});

describe('FileTreeModel details', () => {
  test('a file listed under a name that is also a folder shows as a folder, and becomes a file again', () => {
    const model = new FileTreeModel(['a', 'a/b', 'c']);
    expect(model.isDir(model.find('a'))).toBe(true);
    model.remove('a/b');
    const a = model.find('a');
    expect(a).toBeGreaterThan(ROOT);
    expect(model.isDir(a)).toBe(false);
  });

  test('folders first, then case-insensitive natural order', () => {
    const model = new FileTreeModel(['b.ts', 'A10.ts', 'a2.ts', 'a1.ts', 'Zed/x', 'alpha/x', 'a10.ts']);
    expect(model.rows(0, 20).map((r) => r.name)).toEqual(['alpha', 'Zed', 'a1.ts', 'a2.ts', 'A10.ts', 'a10.ts', 'b.ts']);
  });

  test('expanding a folder changes only its ancestors: a hidden folder opens without changing the row count', () => {
    const model = new FileTreeModel(['a/b/c/d.ts', 'a/b/e.ts']);
    const b = model.find('a/b');
    model.expand(b);
    expect(model.rowCount).toBe(1);
    model.expand(model.find('a'));
    expect(model.rowCount).toBe(4);
  });
});
