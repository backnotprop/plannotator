/**
 * FileTreeModel against a naive reference. The reference keeps the listed
 * files and folders as plain sets and derives everything on each read: it
 * normalizes paths and orders names with its own code (not the model's), sorts
 * each folder's children and flattens recursively. For random path sets and
 * random sequences of expand, collapse, expand-all, collapse-all, add, remove,
 * unlist, snapshot replacement, host values and filters, every row
 * (`rowAt(i)` for each i), every `indexOf(path)`, each row's level, set size
 * and position, expansion, and the folder roll-ups must equal the reference.
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { FileTreeModel, compareTreeNames, normalizeTreePath, ROOT } from './model';

// ---------------------------------------------------------------- reference

/** The reference's own reading of a path: split on `/`, drop empty and `.` segments; `..` is a name. */
function refKey(path: string): { key: string; dir: boolean } | null {
  const parts: string[] = [];
  for (const s of path.split('/')) if (s.length > 0 && s !== '.') parts.push(s);
  return parts.length === 0 ? null : { key: parts.join('/'), dir: path[path.length - 1] === '/' };
}

/** The reference's own order: localeCompare with the same options, then code units. */
function refCompare(a: string, b: string): number {
  const c = a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  if (c !== 0) return c;
  return a === b ? 0 : a < b ? -1 : 1;
}

const refName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const refParent = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : null);

type Values = { mark?: boolean; additions?: number; deletions?: number; count?: number };

class Reference {
  files = new Set<string>();
  dirs = new Set<string>();
  baseExpanded = new Set<string>();
  filterExpanded: Set<string> | null = null;
  tokens: string[] | null = null;
  values = new Map<string, Values>();

  constructor(paths: string[]) {
    this.setPaths(paths);
  }

  get expanded(): Set<string> {
    return this.filterExpanded ?? this.baseExpanded;
  }

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

  private matches(path: string): boolean {
    const lc = path.replace(/\\/g, '/').toLowerCase();
    return this.tokens!.every((t) => lc.includes(t));
  }

  /** Under a filter: listed paths that match, and every folder above one. */
  shown(nodes = this.nodes()): Set<string> {
    if (!this.tokens) return nodes;
    const out = new Set<string>();
    for (const p of [...this.files, ...this.dirs]) {
      if (!this.matches(p)) continue;
      const parts = p.split('/');
      for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join('/'));
    }
    return out;
  }

  children(path: string | null, nodes: Set<string>, within: Set<string>): string[] {
    const kids = [...within].filter((n) => refParent(n) === path);
    const dir = new Map(kids.map((k) => [k, this.isDir(k, nodes)]));
    return kids.sort((a, b) => {
      if (dir.get(a) !== dir.get(b)) return dir.get(a) ? -1 : 1;
      return refCompare(refName(a), refName(b));
    });
  }

  totals(k: string, nodes: Set<string>) {
    const t = { additions: 0, deletions: 0, count: 0, marked: 0 };
    for (const [m, v] of this.values) {
      if (!nodes.has(m) || (m !== k && !m.startsWith(`${k}/`))) continue;
      t.additions += v.additions ?? 0;
      t.deletions += v.deletions ?? 0;
      t.count += v.count ?? 0;
      t.marked += v.mark ? 1 : 0;
    }
    return t;
  }

  rows() {
    const nodes = this.nodes();
    const shown = this.shown(nodes);
    const out: Array<{ path: string; level: number; setSize: number; posInSet: number; isDir: boolean; expanded: boolean; markedBelow: boolean; totals: ReturnType<Reference['totals']> }> = [];
    const walk = (parent: string | null, level: number) => {
      const kids = this.children(parent, nodes, shown);
      kids.forEach((k, i) => {
        const isDir = this.isDir(k, nodes);
        const expanded = isDir && this.expanded.has(k);
        const markedBelow = [...this.values].some(([m, v]) => v.mark && nodes.has(m) && m.startsWith(`${k}/`));
        out.push({ path: k, level, setSize: kids.length, posInSet: i + 1, isDir, expanded, markedBelow, totals: this.totals(k, nodes) });
        if (expanded) walk(k, level + 1);
      });
    };
    walk(null, 1);
    return out;
  }

  /** Expansion only lives on folders: drop it where the folder went or became a file. */
  private settle(): void {
    const nodes = this.nodes();
    for (const set of [this.baseExpanded, this.filterExpanded]) {
      if (!set) continue;
      for (const e of [...set]) if (!nodes.has(e) || !this.isDir(e, nodes)) set.delete(e);
    }
  }

  private isListed(key: string, dir: boolean) {
    return (dir ? this.dirs : this.files).has(key);
  }

  /** A new match under a filter opens every folder above it. */
  private openAbove(key: string) {
    if (!this.tokens || !this.shown().has(key)) return;
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) this.filterExpanded!.add(parts.slice(0, i).join('/'));
  }

  add(path: string) {
    const n = refKey(path);
    if (!n || this.isListed(n.key, n.dir)) return;
    (n.dir ? this.dirs : this.files).add(n.key);
    this.settle();
    this.openAbove(n.key);
  }

  remove(path: string) {
    const n = refKey(path);
    if (!n || !this.nodes().has(n.key)) return;
    const under = (p: string) => p === n.key || p.startsWith(`${n.key}/`);
    for (const set of [this.files, this.dirs]) for (const p of [...set]) if (under(p)) set.delete(p);
    this.settle();
  }

  unlist(path: string) {
    const n = refKey(path);
    if (!n) return;
    (n.dir ? this.dirs : this.files).delete(n.key);
    this.settle();
  }

  setPaths(paths: string[]) {
    const added: string[] = [];
    const files = new Set<string>();
    const dirs = new Set<string>();
    for (const p of paths) {
      const n = refKey(p);
      if (!n) continue;
      (n.dir ? dirs : files).add(n.key);
      if (!this.isListed(n.key, n.dir)) added.push(n.key);
    }
    this.files = files;
    this.dirs = dirs;
    this.settle();
    for (const k of added) this.openAbove(k);
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
    if (!this.nodes().has(path)) return;
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) this.expanded.add(parts.slice(0, i).join('/'));
  }

  setValues(values: Map<string, Values>) {
    this.values = new Map();
    for (const [p, v] of values) {
      const k = refKey(p)?.key;
      if (k) this.values.set(k, v);
    }
  }

  setFilter(tokens: string[] | null) {
    if (!tokens || tokens.length === 0) {
      this.tokens = null;
      this.filterExpanded = null;
      return;
    }
    this.tokens = tokens;
    const nodes = this.nodes();
    const shown = this.shown(nodes);
    this.filterExpanded = new Set([...shown].filter((s) => [...shown].some((c) => refParent(c) === s)));
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
    const r = got[i];
    expect({ path: model.pathOf(r.id), level: r.depth + 1, setSize: r.setSize, posInSet: r.posInSet, isDir: r.isDir, expanded: r.expanded, markedBelow: r.markedBelow, totals: model.totals(r.id) }).toEqual(w);
    expect(r.index).toBe(i);
    expect(model.indexOf(w.path)).toBe(i);
    expect(model.indexOfId(id)).toBe(i);
    expect(model.rowFor(id)).toEqual(r);
  });
  expect(model.rowAt(want.length)).toBe(-1);
  expect(model.rowAt(-1)).toBe(-1);
  const shown = new Set(want.map((w) => w.path));
  for (const n of ref.nodes()) {
    if (!shown.has(n)) expect(model.indexOf(n)).toBe(-1);
    expect(model.find(n)).toBeGreaterThan(ROOT);
  }
  if (want.length > 0) {
    const start = Math.floor(want.length / 2);
    expect(model.rows(start, 3).map((r) => model.pathOf(r.id))).toEqual(want.slice(start, start + 3).map((w) => w.path));
  }
  expect(model.expandedPaths()).toEqual(new Set([...ref.expanded]));
  expect(model.nodeCount).toBe(ref.nodes().size);
  // The listed set a snapshot diffs against holds exactly the listed entries.
  const listed = [...ref.files, ...[...ref.dirs].map((d) => `${d}/`)].sort();
  expect(model.listedCount).toBe(listed.length);
  expect([...model.listedPaths()].sort()).toEqual(listed);
  expect(model.diff(listed)).toEqual({ adds: [], removes: [], size: listed.length });
}

// ---------------------------------------------------------------- generators

// A small alphabet so paths collide, share folders, sort by number and case,
// and a file named like a folder shows up. 'é' and 'é' are the composed and
// decomposed spellings (two different names: names are not normalized).
const SEG = fc.constantFrom('a', 'A', 'b', 'a1', 'a2', 'a10', 'B10', 'x y', 'é', 'é', 'e', '_z', '.git', 'src', '日本', '..', 'Readme', 'README', 'x\\y');
const JOIN = fc.constantFrom('/', '/', '/', '/', '//', '/./');
const PATH = fc
  .tuple(fc.array(fc.tuple(SEG, JOIN), { minLength: 1, maxLength: 4 }), fc.integer({ min: 0, max: 9 }), fc.constantFrom('', '', '', '/', './'))
  .map(([parts, roll, lead]) => `${lead}${parts.map(([s, j], i) => (i === 0 ? s : `${j}${s}`)).join('')}${roll === 0 ? '/' : ''}`);
const PATHS = fc.array(PATH, { maxLength: 30 });
const QUERY = fc.array(fc.constantFrom('a', 'e', 'x', 'src', 'readme', '1', 'x\\y', 'b10', '/', 'é', 'zz'), { maxLength: 2 });

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
  | { t: 'values'; vs: Map<string, Values> }
  | { t: 'filter'; tokens: string[] };

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
  { weight: 2, arbitrary: QUERY.map((tokens) => ({ t: 'filter' as const, tokens })) },
);

const tokenTest = (tokens: string[]) => (tokens.length === 0 ? null : (lc: string) => tokens.every((t) => lc.includes(t)));

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
    case 'filter': model.setFilter(tokenTest(op.tokens)); ref.setFilter(op.tokens); break;
  }
}

describe('the reference reads paths and orders names as the tree does', () => {
  test('a table of paths', () => {
    const table: Array<[string, string | null, boolean]> = [
      ['a/b', 'a/b', false],
      ['/a//b/', 'a/b', true],
      ['./a/./b', 'a/b', false],
      ['a/../b', 'a/../b', false],
      ['x\\y', 'x\\y', false],
      ['', null, false],
      ['/', null, true],
      ['./.', null, false],
      ['é', 'é', false],
    ];
    for (const [input, key, dir] of table) {
      const n = normalizeTreePath(input);
      expect(n ? n.key : null).toBe(key);
      if (n) expect(n.dir).toBe(dir);
      const r = refKey(input);
      expect(r ? r.key : null).toBe(key);
    }
  });

  test('a table of name orders', () => {
    const sorted = ['_z', '1', '2', '10', 'a', 'A', 'a1', 'a2', 'a10', 'B10', 'b2', 'e', 'é', 'é', 'Readme', 'README', 'readme', 'x y', 'z'];
    const byTree = [...sorted].reverse().sort(compareTreeNames);
    const byRef = [...sorted].reverse().sort(refCompare);
    expect(byTree).toEqual(byRef);
    // Numbers by value, case ignored first, then a stable tie-break.
    expect(byTree.indexOf('a2')).toBeLessThan(byTree.indexOf('a10'));
    expect(byTree.indexOf('B10')).toBeGreaterThan(byTree.indexOf('a10'));
    expect(compareTreeNames('README', 'Readme')).toBe(-compareTreeNames('Readme', 'README'));
    expect(compareTreeNames('é', 'é')).not.toBe(0);
  });
});

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

  test('random sequences of expand, collapse, expand-all, collapse-all, add, remove, snapshots, values and filters', () => {
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
      { numRuns: 500 },
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

  test('built in steps, the model is the one built at once', () => {
    const paths = Array.from({ length: 9000 }, (_, i) => `d${i % 37}/s${i % 11}/f${i}.ts`);
    const whole = new FileTreeModel(paths, { expanded: ['d3', 'd3/s4'] });
    const stepped = new FileTreeModel(paths, { expanded: ['d3', 'd3/s4'], deferBuild: true });
    let steps = 0;
    for (const _ of stepped.build()) steps++;
    expect(steps).toBeGreaterThan(4);
    expect(stepped.rows(0, 500).map((r) => stepped.pathOf(r.id))).toEqual(whole.rows(0, 500).map((r) => whole.pathOf(r.id)));
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

  test('a live add under a filter shows the new match with its folders open', () => {
    const model = new FileTreeModel(['src/a.ts', 'src/b.ts', 'lib/zz.ts']);
    model.setFilter((lc) => lc.includes('new'));
    expect(model.rowCount).toBe(0);
    model.add('lib/deep/er/new-file.ts');
    expect(model.rows(0, 10).map((r) => model.pathOf(r.id))).toEqual(['lib', 'lib/deep', 'lib/deep/er', 'lib/deep/er/new-file.ts']);
    model.remove('lib/deep/er/new-file.ts');
    expect(model.rowCount).toBe(0);
  });

  test('under a filter, a new match inside a folder the user closed opens it again', () => {
    const paths = ['src/new-a.ts', 'src/old.ts'];
    const model = new FileTreeModel(paths);
    const ref = new Reference(paths);
    model.setFilter(tokenTest(['new']));
    ref.setFilter(['new']);
    model.collapse(model.find('src'));
    ref.collapse('src');
    check(model, ref);
    model.add('src/new-b.ts');
    ref.add('src/new-b.ts');
    check(model, ref);
    expect(model.isExpanded(model.find('src'))).toBe(true);
  });

  test('under a filter, a folder that lost its matches and gets a new one counts its rows once', () => {
    const paths = ['top/mid/new-a.ts', 'top/mid/old.ts', 'top/other.ts', 'z.ts'];
    const model = new FileTreeModel(paths);
    const ref = new Reference(paths);
    for (const [m, r] of [[model, ref]] as const) {
      m.setFilter(tokenTest(['new']));
      r.setFilter(['new']);
    }
    // top/mid stays open in the filter's expansion while it is hidden.
    model.remove('top/mid/new-a.ts');
    ref.remove('top/mid/new-a.ts');
    check(model, ref);
    model.add('top/mid/new-b.ts');
    ref.add('top/mid/new-b.ts');
    check(model, ref);
    model.setFilter(null);
    ref.setFilter(null);
    check(model, ref);
  });
});
