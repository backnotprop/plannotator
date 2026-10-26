/**
 * FileTreeModel — the counted path index behind `<FileTree>`.
 *
 * Built once from a list of paths. Every path segment is interned (a folder
 * named `src` is one string however many times it appears) and every node is a
 * slot in a set of typed arrays: parent, name, depth, flags, counts.
 *
 * `inner[n]` is the number of rows under `n` WHEN `n` IS EXPANDED, kept for
 * every folder whether it is open or not. A node's visible rows are
 * `expanded(n) ? inner[n] : 0`, so:
 *
 * - `rowAt(i)` walks down from the root and skips whole subtrees by their
 *   counts; the tree is never flattened.
 * - `indexOf(path)` sums the counts of the siblings before each ancestor.
 * - expanding or collapsing one folder changes its ancestors' counts by one
 *   delta, stopping at the first collapsed ancestor: O(depth).
 * - expand-all and collapse-all recompute the counts of one subtree in a
 *   single bottom-up pass.
 *
 * Adds and removes (a live folder watch) update the index in place: a new
 * node is inserted in its parent's sorted children (binary search) and the
 * delta goes up the ancestors; a removed subtree is detached, its counts taken
 * off its ancestors, its ids freed for reuse. Ids are only meaningful inside
 * one model: callers that keep a node across changes keep its path.
 *
 * Filter: a filter hides every node that neither matches nor holds a match
 * (FileBrowser's rule). Hidden nodes stay in the index and are skipped by the
 * counts, so setting a filter is one pass over the nodes, and adds and removes
 * under a filter stay incremental. While a filter is set the tree uses its own
 * expansion (every folder holding a match starts open; a new match opens its
 * folders) and the unfiltered expansion waits for the filter to clear.
 *
 * Kinds: a node is a folder when it has children or was listed with a trailing
 * `/`; otherwise it is a file. A path listed as a file that also prefixes other
 * paths shows as a folder, and turns back into a file when they go.
 *
 * Order: folders first, then names compared case-insensitively with numbers
 * by value (`Intl.Collator(undefined, { numeric: true, sensitivity: "base" })`,
 * VS Code's default explorer order), ties broken by code point so the order is
 * total.
 *
 * Roll-ups: the host attaches values to paths (a change mark, lines added
 * and deleted, a comment count); every node keeps their sums over its subtree
 * (hidden nodes included), updated by delta on add and remove, so a folder's
 * "+12 -3", its comment count and "this collapsed folder holds changes" are
 * one read in render, never a walk.
 *
 * Building can run in slices (`build()` is a generator; the constructor runs it
 * to the end), so a host can keep every task at load short.
 */

export const ROOT = 0;

const F_ALIVE = 1;
/** Listed as a file. */
const F_FILE = 2;
/** Listed as a folder (the path ended in `/`). */
const F_DIR = 4;
/** The host marked this path. */
const F_MARK = 8;
/** Hidden by the filter. */
const F_HIDE = 16;

const EMPTY: readonly number[] = Object.freeze([]) as readonly number[];
/** parent * 2^32 + nameId: unique while ids stay under 2^21. */
const KEY_SHIFT = 4294967296;

/** What the host attaches to one path; folders show the sums of these over their subtree. */
export interface FileTreeValues {
  /** Counts toward "this folder holds changes". */
  mark?: boolean;
  additions?: number;
  deletions?: number;
  count?: number;
}

function normalizeValues(values: ReadonlyMap<string, FileTreeValues>): Map<string, FileTreeValues> {
  const out = new Map<string, FileTreeValues>();
  for (const [path, v] of values) {
    const key = normalizeTreePath(path)?.key;
    if (key) out.set(key, v);
  }
  return out;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** The tree's name order: case-insensitive, numbers by value, ties by code point. */
export function compareTreeNames(a: string, b: string): number {
  if (a === b) return 0;
  return collator.compare(a, b) || (a < b ? -1 : 1);
}

export interface NormalizedTreePath {
  segments: string[];
  /** Listed as a folder (ended in `/`). */
  dir: boolean;
  /** Segments joined with `/`, the key the tree uses for this path. */
  key: string;
}

/**
 * A path as the tree reads it: `/` separated, leading `/` and `./` and empty
 * or `.` segments dropped, a trailing `/` marking a folder. `..` and
 * backslashes are names, not path syntax (both are legal in POSIX file names);
 * names are not Unicode-normalized. Null when nothing is left.
 */
export function normalizeTreePath(path: string): NormalizedTreePath | null {
  const dir = path.endsWith('/');
  const segments = path.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return null;
  return { segments, dir, key: segments.join('/') };
}

/**
 * A file path the tree reads as written: no leading or trailing `/`, no empty
 * or `.` segment. Most paths from a folder walk; they skip normalization.
 */
export function isPlainPath(path: string): boolean {
  const n = path.length;
  if (n === 0 || path.charCodeAt(0) === 47 || path.charCodeAt(n - 1) === 47) return false;
  if (path === '.' || path.startsWith('./') || path.endsWith('/.')) return false;
  return !path.includes('//') && !path.includes('/./');
}

/** The tree's key for `path` (`normalizeTreePath(path).key` plus `/` for a folder), without splitting a plain path. */
export function treePathKey(path: string): string | null {
  if (isPlainPath(path)) return path;
  const norm = normalizeTreePath(path);
  return norm ? (norm.dir ? `${norm.key}/` : norm.key) : null;
}

/** One visible row, as `rows()` returns it. */
export interface FileTreeRow {
  id: number;
  /** Row index from the top of the tree. */
  index: number;
  /** 0 for the root's children. */
  depth: number;
  name: string;
  isDir: boolean;
  expanded: boolean;
  /** Number of shown siblings, this node included (aria-setsize). */
  setSize: number;
  /** 1-based position among them (aria-posinset). */
  posInSet: number;
  /** The host marked a node below this one. */
  markedBelow: boolean;
}

export interface FileTreeModelOptions {
  /** Folders open at the start (paths). */
  expanded?: Iterable<string>;
  values?: ReadonlyMap<string, FileTreeValues>;
  /** Don't build in the constructor: the caller runs `build()` (in slices). */
  deferBuild?: boolean;
}

export class FileTreeModel {
  private cap = 0;
  private parent = new Int32Array(0);
  private nameId = new Int32Array(0);
  private depthArr = new Int32Array(0);
  private flags = new Uint8Array(0);
  private inner = new Int32Array(0);
  /** Children not hidden by the filter. */
  private shownKids = new Int32Array(0);
  private marks = new Int32Array(0);
  private sumAdd = new Int32Array(0);
  private sumDel = new Int32Array(0);
  private sumCount = new Int32Array(0);
  private pos = new Int32Array(0);
  private kids: number[][] = [];
  private freeIds: number[] = [];
  private nextId = 1;
  private names: string[] = [];
  private nameIds = new Map<string, number>();
  private childKey = new Map<number, number>();
  private pathCache: (string | undefined)[] = [];
  private lcCache: (string | undefined)[] = [];
  private lcNames: (string | undefined)[] = [];
  /** Every listed entry by key (a folder listed with `/` keeps its slash), so a snapshot diffs without walking the tree. */
  private listed = new Set<string>();
  private baseExpanded = new Set<number>();
  private filterExpanded: Set<number> | null = null;
  /** The expansion in use: the filter's while a filter is set. */
  private expandedSet = this.baseExpanded;
  private test: ((lowercasePath: string) => boolean) | null = null;
  /** Per-path values the host gave (marks and the numbers folders sum). */
  private values = new Map<string, FileTreeValues>();
  private live = 0;
  private pendingPaths: Iterable<string> | null;
  private pendingExpanded: Iterable<string> | undefined;

  constructor(paths: Iterable<string> = [], options: FileTreeModelOptions = {}) {
    if (options.values) this.values = normalizeValues(options.values);
    this.pendingPaths = paths;
    this.pendingExpanded = options.expanded;
    this.clear(0);
    if (!options.deferBuild) this.runBuild();
  }

  private runBuild(): void {
    const steps = this.build();
    while (!steps.next().done) {
      /* run to the end */
    }
  }

  // ---------------------------------------------------------------- storage

  private grow(min: number): void {
    if (min <= this.cap) return;
    let cap = Math.max(64, this.cap * 2);
    while (cap < min) cap *= 2;
    const g32 = (a: Int32Array) => {
      const b = new Int32Array(cap);
      b.set(a);
      return b;
    };
    this.parent = g32(this.parent);
    this.nameId = g32(this.nameId);
    this.depthArr = g32(this.depthArr);
    this.inner = g32(this.inner);
    this.shownKids = g32(this.shownKids);
    this.marks = g32(this.marks);
    this.sumAdd = g32(this.sumAdd);
    this.sumDel = g32(this.sumDel);
    this.sumCount = g32(this.sumCount);
    this.pos = g32(this.pos);
    const f = new Uint8Array(cap);
    f.set(this.flags);
    this.flags = f;
    this.cap = cap;
  }

  private intern(name: string): number {
    let id = this.nameIds.get(name);
    if (id === undefined) {
      id = this.names.length;
      this.names.push(name);
      this.nameIds.set(name, id);
    }
    return id;
  }

  private alloc(p: number, nid: number, hidden: boolean): number {
    const id = this.freeIds.length > 0 ? this.freeIds.pop()! : this.nextId++;
    if (id >= this.cap) this.grow(id + 1);
    this.parent[id] = p;
    this.nameId[id] = nid;
    this.depthArr[id] = p === ROOT ? 0 : this.depthArr[p] + 1;
    this.flags[id] = hidden ? F_ALIVE | F_HIDE : F_ALIVE;
    this.inner[id] = 0;
    this.shownKids[id] = 0;
    this.marks[id] = 0;
    this.sumAdd[id] = 0;
    this.sumDel[id] = 0;
    this.sumCount[id] = 0;
    this.pos[id] = -1;
    this.kids[id] = EMPTY as number[];
    this.pathCache[id] = undefined;
    this.lcCache[id] = undefined;
    this.childKey.set(p * KEY_SHIFT + nid, id);
    this.live++;
    return id;
  }

  // ---------------------------------------------------------------- reads

  /** Rows the tree shows (every visible node). */
  get rowCount(): number {
    return this.inner[ROOT] ?? 0;
  }

  /** Nodes in the index, folders included (hidden ones too). */
  get nodeCount(): number {
    return this.live;
  }

  /** A filter is set. */
  get filtered(): boolean {
    return this.test !== null;
  }

  /** The filter's test, or null. */
  get filterTest(): ((lowercasePath: string) => boolean) | null {
    return this.test;
  }

  isAlive(id: number): boolean {
    return id > ROOT && id < this.cap && (this.flags[id] & F_ALIVE) !== 0;
  }

  isDir(id: number): boolean {
    return this.kids[id].length > 0 || (this.flags[id] & F_DIR) !== 0;
  }

  isExpanded(id: number): boolean {
    return this.expandedSet.has(id);
  }

  /** Not hidden by the filter. */
  isShown(id: number): boolean {
    return (this.flags[id] & F_HIDE) === 0;
  }

  nameOf(id: number): string {
    return this.names[this.nameId[id]];
  }

  depthOf(id: number): number {
    return this.depthArr[id];
  }

  /** The parent's id, ROOT for a top-level node. */
  parentOf(id: number): number {
    return this.parent[id];
  }

  /** Children, hidden ones included. */
  childrenOf(id: number): readonly number[] {
    return this.kids[id];
  }

  /** Children not hidden by the filter. */
  shownChildCount(id: number): number {
    return this.shownKids[id];
  }

  pathOf(id: number): string {
    const cached = this.pathCache[id];
    if (cached !== undefined) return cached;
    // Walk up to the nearest ancestor with a cached path, then fill the cache on the way down.
    const chain: number[] = [];
    let n = id;
    while (n !== ROOT && this.pathCache[n] === undefined) {
      chain.push(n);
      n = this.parent[n];
    }
    let prefix = n === ROOT ? '' : this.pathCache[n]!;
    for (let i = chain.length - 1; i >= 0; i--) {
      const c = chain[i];
      prefix = prefix === '' ? this.nameOf(c) : `${prefix}/${this.nameOf(c)}`;
      this.pathCache[c] = prefix;
    }
    return prefix;
  }

  /** A name lowercased with backslashes read as `/`, once per interned name. */
  private lowercaseName(nid: number): string {
    let lc = this.lcNames[nid];
    if (lc === undefined) {
      lc = this.names[nid].replace(/\\/g, '/').toLowerCase();
      this.lcNames[nid] = lc;
    }
    return lc;
  }

  /** The path lowercased with backslashes read as `/` (what the filter matches): the parent's plus this name's. */
  private lowercasePath(id: number): string {
    let lc = this.lcCache[id];
    if (lc === undefined) {
      const p = this.parent[id];
      const name = this.lowercaseName(this.nameId[id]);
      lc = p === ROOT ? name : `${this.lowercasePath(p)}/${name}`;
      this.lcCache[id] = lc;
    }
    return lc;
  }

  /** The node at `path`, or -1. */
  find(path: string): number {
    const norm = normalizeTreePath(path);
    if (!norm) return -1;
    let n = ROOT;
    for (const seg of norm.segments) {
      const nid = this.nameIds.get(seg);
      if (nid === undefined) return -1;
      const c = this.childKey.get(n * KEY_SHIFT + nid);
      if (c === undefined) return -1;
      n = c;
    }
    return n;
  }

  /** Rows under `id` as shown now (0 when collapsed). */
  rowsUnder(id: number): number {
    return this.vis(id);
  }

  private vis(id: number): number {
    return this.expandedSet.has(id) ? this.inner[id] : 0;
  }

  /** The host marked a node strictly below `id`. */
  markedBelow(id: number): boolean {
    return this.marks[id] - ((this.flags[id] & F_MARK) !== 0 ? 1 : 0) > 0;
  }

  isMarked(id: number): boolean {
    return (this.flags[id] & F_MARK) !== 0;
  }

  /** The host's numbers summed over `id` and everything under it. */
  totals(id: number): { additions: number; deletions: number; count: number; marked: number } {
    return { additions: this.sumAdd[id], deletions: this.sumDel[id], count: this.sumCount[id], marked: this.marks[id] };
  }

  /** Shown, and every ancestor shown and expanded. */
  isVisible(id: number): boolean {
    if (!this.isAlive(id) || !this.isShown(id)) return false;
    let p = this.parent[id];
    while (p !== ROOT) {
      if (!this.expandedSet.has(p)) return false;
      p = this.parent[p];
    }
    return true;
  }

  /**
   * The row `id` shows on: itself when visible, else the highest collapsed
   * folder above it (or, when the filter hides it, above its nearest shown
   * ancestor). -1 when nothing above it shows.
   */
  visibleAncestor(id: number): number {
    if (!this.isAlive(id)) return -1;
    let n = id;
    while (n !== ROOT && !this.isShown(n)) n = this.parent[n];
    if (n === ROOT) return -1;
    let shown = n;
    let p = this.parent[n];
    while (p !== ROOT) {
      if (!this.expandedSet.has(p)) shown = p;
      p = this.parent[p];
    }
    return shown;
  }

  /** The node on row `i`, or -1. Walks down by counts: O(depth × siblings skipped). */
  rowAt(i: number): number {
    if (i < 0 || i >= this.rowCount) return -1;
    let n = ROOT;
    for (;;) {
      const ch = this.kids[n];
      let found = false;
      for (let k = 0; k < ch.length; k++) {
        const c = ch[k];
        if (this.flags[c] & F_HIDE) continue;
        const size = 1 + this.vis(c);
        if (i < size) {
          if (i === 0) return c;
          i -= 1;
          n = c;
          found = true;
          break;
        }
        i -= size;
      }
      if (!found) return -1;
    }
  }

  /** The row `id` is on, or -1 when it is hidden or gone. */
  indexOfId(id: number): number {
    if (!this.isVisible(id)) return -1;
    let idx = this.depthArr[id];
    let x = id;
    while (x !== ROOT) {
      const p = this.parent[x];
      const ch = this.kids[p];
      const at = this.pos[x];
      for (let k = 0; k < at; k++) {
        const c = ch[k];
        if ((this.flags[c] & F_HIDE) === 0) idx += 1 + this.vis(c);
      }
      x = p;
    }
    return idx;
  }

  /** The row `path` is on, or -1. */
  indexOf(path: string): number {
    const id = this.find(path);
    return id < 0 ? -1 : this.indexOfId(id);
  }

  /**
   * Calls `visit` for each visible row from `start` on, in order, until it
   * returns true or the rows run out. Finds `start` by counts, then walks
   * forward with a cursor (each next row is O(1) amortized).
   */
  scan(start: number, visit: (id: number, index: number, depth: number, setSize: number, posInSet: number) => boolean | void): void {
    if (start < 0) start = 0;
    if (start >= this.rowCount) return;
    const flags = this.flags;
    const dirs: number[] = [];
    const at: number[] = [];
    const nth: number[] = [];
    let n = ROOT;
    let i = start;
    descend: for (;;) {
      const ch = this.kids[n];
      let shownBefore = 0;
      for (let k = 0; k < ch.length; k++) {
        const c = ch[k];
        if (flags[c] & F_HIDE) continue;
        const size = 1 + this.vis(c);
        if (i < size) {
          dirs.push(n);
          at.push(k);
          nth.push(shownBefore);
          if (i === 0) break descend;
          i -= 1;
          n = c;
          continue descend;
        }
        i -= size;
        shownBefore++;
      }
      return;
    }
    let index = start;
    while (dirs.length > 0) {
      const top = dirs.length - 1;
      const parentId = dirs[top];
      const c = this.kids[parentId][at[top]];
      if (visit(c, index, top, this.shownKids[parentId], nth[top] + 1) === true) return;
      index++;
      if (this.shownKids[c] > 0 && this.expandedSet.has(c)) {
        const ch = this.kids[c];
        let k = 0;
        while (flags[ch[k]] & F_HIDE) k++;
        dirs.push(c);
        at.push(k);
        nth.push(0);
        continue;
      }
      while (dirs.length > 0) {
        const t = dirs.length - 1;
        const ch = this.kids[dirs[t]];
        let k = at[t] + 1;
        while (k < ch.length && flags[ch[k]] & F_HIDE) k++;
        if (k < ch.length) {
          at[t] = k;
          nth[t]++;
          break;
        }
        dirs.pop();
        at.pop();
        nth.pop();
      }
    }
  }

  /** Up to `count` visible rows from `start`. */
  rows(start: number, count: number): FileTreeRow[] {
    const out: FileTreeRow[] = [];
    if (count <= 0) return out;
    this.scan(start, (id, index, depth, setSize, posInSet) => {
      out.push(this.rowOf(id, index, depth, setSize, posInSet));
      return out.length >= count;
    });
    return out;
  }

  /** The row for a visible node (null when it does not show). */
  rowFor(id: number): FileTreeRow | null {
    const index = this.indexOfId(id);
    if (index < 0) return null;
    const p = this.parent[id];
    const ch = this.kids[p];
    let posInSet = 1;
    for (let k = 0; k < this.pos[id]; k++) if ((this.flags[ch[k]] & F_HIDE) === 0) posInSet++;
    return this.rowOf(id, index, this.depthArr[id], this.shownKids[p], posInSet);
  }

  private rowOf(c: number, index: number, depth: number, setSize: number, posInSet: number): FileTreeRow {
    const isDir = this.isDir(c);
    return {
      id: c,
      index,
      depth,
      name: this.names[this.nameId[c]],
      isDir,
      expanded: isDir && this.expandedSet.has(c),
      setSize,
      posInSet,
      markedBelow: this.markedBelow(c),
    };
  }

  /** Paths of the expanded folders (the filter's expansion while a filter is set). */
  expandedPaths(): Set<string> {
    const out = new Set<string>();
    for (const id of this.expandedSet) out.add(this.pathOf(id));
    return out;
  }

  /** Paths of the folders open without a filter. */
  baseExpandedPaths(): Set<string> {
    const out = new Set<string>();
    for (const id of this.baseExpanded) out.add(this.pathOf(id));
    return out;
  }

  /** Every path the index holds as listed (folders listed with a trailing `/`), in tree order, hidden ones included. */
  listedPaths(): string[] {
    const out: string[] = [];
    const stack: number[] = [];
    const root = this.kids[ROOT];
    for (let k = root.length - 1; k >= 0; k--) stack.push(root[k]);
    while (stack.length > 0) {
      const c = stack.pop()!;
      const f = this.flags[c];
      if (f & F_DIR) out.push(`${this.pathOf(c)}/`);
      if (f & F_FILE) out.push(this.pathOf(c));
      const ch = this.kids[c];
      for (let k = ch.length - 1; k >= 0; k--) stack.push(ch[k]);
    }
    return out;
  }

  // ---------------------------------------------------------------- counts

  /** `inner[p]` changed by `delta`: pass it up while the folders are shown and open. */
  private bump(p: number, delta: number): void {
    if (delta === 0) return;
    while (p >= 0) {
      this.inner[p] += delta;
      if (p === ROOT) return;
      if (this.flags[p] & F_HIDE || !this.expandedSet.has(p)) return;
      p = this.parent[p];
    }
  }

  /** Add one node's own values (times `sign`) to it and every ancestor. */
  private addUp(n: number, v: FileTreeValues, sign: 1 | -1): void {
    const m = v.mark ? sign : 0;
    const a = (v.additions ?? 0) * sign;
    const d = (v.deletions ?? 0) * sign;
    const c = (v.count ?? 0) * sign;
    if (m === 0 && a === 0 && d === 0 && c === 0) return;
    while (n >= 0) {
      this.marks[n] += m;
      this.sumAdd[n] += a;
      this.sumDel[n] += d;
      this.sumCount[n] += c;
      n = n === ROOT ? -1 : this.parent[n];
    }
  }

  /** Take a whole subtree's sums off `n` and its ancestors. */
  private subtractTotals(n: number, from: number): void {
    const m = this.marks[from];
    const a = this.sumAdd[from];
    const d = this.sumDel[from];
    const c = this.sumCount[from];
    while (n >= 0) {
      this.marks[n] -= m;
      this.sumAdd[n] -= a;
      this.sumDel[n] -= d;
      this.sumCount[n] -= c;
      n = n === ROOT ? -1 : this.parent[n];
    }
  }

  private attachValues(id: number, key: string): void {
    const v = this.values.get(key);
    if (!v) return;
    if (v.mark) this.flags[id] |= F_MARK;
    this.addUp(id, v, 1);
  }

  /** Every alive node under `top` (top included), parents before children. */
  private preorder(top: number): number[] {
    const order: number[] = [top];
    for (let i = 0; i < order.length; i++) {
      const ch = this.kids[order[i]];
      for (let k = 0; k < ch.length; k++) if (this.kids[ch[k]].length > 0) order.push(ch[k]);
    }
    return order;
  }

  /** Recompute `inner` for every folder in `top`'s subtree, bottom-up. */
  private recount(top: number): void {
    const order = this.preorder(top);
    const flags = this.flags;
    for (let i = order.length - 1; i >= 0; i--) {
      const n = order[i];
      const ch = this.kids[n];
      let s = 0;
      for (let k = 0; k < ch.length; k++) {
        const c = ch[k];
        if (flags[c] & F_HIDE) continue;
        s += this.expandedSet.has(c) ? 1 + this.inner[c] : 1;
      }
      this.inner[n] = s;
    }
  }

  // ---------------------------------------------------------------- filter

  private matchesItself(n: number): boolean {
    return this.test !== null && (this.flags[n] & (F_FILE | F_DIR)) !== 0 && this.test(this.lowercasePath(n));
  }

  /** Show or hide one node, keeping its parent's counts. */
  private setShown(n: number, show: boolean): void {
    const hidden = (this.flags[n] & F_HIDE) !== 0;
    if (hidden !== show) return;
    const p = this.parent[n];
    if (show) {
      this.flags[n] &= ~F_HIDE;
      this.shownKids[p]++;
      this.bump(p, 1 + this.vis(n));
    } else {
      this.shownKids[p]--;
      this.bump(p, -(1 + this.vis(n)));
      this.flags[n] |= F_HIDE;
    }
  }

  /**
   * Under a filter, `n` shows when it matches or holds a shown node: re-decide
   * it and its ancestors after a change at `n`. A folder that starts to show
   * opens (matches stay open).
   */
  private refreshShown(n: number): void {
    if (this.test === null) return;
    while (n !== ROOT && this.isAlive(n)) {
      const want = this.shownKids[n] > 0 || this.matchesItself(n);
      if (want === this.isShown(n)) return;
      if (want && this.shownKids[n] > 0) this.expand(n);
      this.setShown(n, want);
      n = this.parent[n];
    }
  }

  /**
   * Show only the nodes `test` keeps (it gets the lowercased path, backslashes
   * as `/`, of each listed path) and the folders that hold them, every such
   * folder open. Null clears the filter and brings back the unfiltered
   * expansion. One pass over the nodes.
   */
  setFilter(test: ((lowercasePath: string) => boolean) | null): void {
    const order = this.preorderAll();
    const flags = this.flags;
    if (test === null) {
      this.test = null;
      this.filterExpanded = null;
      this.expandedSet = this.baseExpanded;
      for (const n of order) {
        flags[n] &= ~F_HIDE;
        this.shownKids[n] = this.kids[n].length;
      }
      this.recount(ROOT);
      return;
    }
    this.test = test;
    const exp = new Set<number>();
    this.filterExpanded = exp;
    this.expandedSet = exp;
    for (let i = order.length - 1; i >= 0; i--) {
      const n = order[i];
      const ch = this.kids[n];
      let shown = 0;
      for (let k = 0; k < ch.length; k++) if ((flags[ch[k]] & F_HIDE) === 0) shown++;
      this.shownKids[n] = shown;
      if (n === ROOT) break;
      const show = shown > 0 || ((flags[n] & (F_FILE | F_DIR)) !== 0 && test(this.lowercasePath(n)));
      if (show) {
        flags[n] &= ~F_HIDE;
        if (shown > 0) exp.add(n);
      } else flags[n] |= F_HIDE;
    }
    this.recount(ROOT);
  }

  /** Every alive node, the root first, parents before children. */
  private preorderAll(): number[] {
    const order: number[] = [ROOT];
    for (let i = 0; i < order.length; i++) {
      const ch = this.kids[order[i]];
      for (let k = 0; k < ch.length; k++) order.push(ch[k]);
    }
    return order;
  }

  // ---------------------------------------------------------------- order

  private before(a: number, aDir: boolean, b: number): boolean {
    const bDir = this.isDir(b);
    if (aDir !== bDir) return aDir;
    return compareTreeNames(this.names[this.nameId[a]], this.names[this.nameId[b]]) < 0;
  }

  private insertChild(p: number, c: number, cDir: boolean): void {
    let ch = this.kids[p];
    if (ch === EMPTY) {
      ch = [];
      this.kids[p] = ch;
    }
    let lo = 0;
    let hi = ch.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.before(c, cDir, ch[mid])) hi = mid;
      else lo = mid + 1;
    }
    ch.splice(lo, 0, c);
    for (let k = lo; k < ch.length; k++) this.pos[ch[k]] = k;
    if ((this.flags[c] & F_HIDE) === 0) this.shownKids[p]++;
  }

  private detach(c: number): void {
    const p = this.parent[c];
    const ch = this.kids[p];
    const at = this.pos[c];
    ch.splice(at, 1);
    for (let k = at; k < ch.length; k++) this.pos[ch[k]] = k;
    if (ch.length === 0) this.kids[p] = EMPTY as number[];
    if ((this.flags[c] & F_HIDE) === 0) this.shownKids[p]--;
  }

  /** `c` changed kind (file ↔ folder): move it to its place among its siblings. */
  private reposition(c: number): void {
    this.detach(c);
    this.insertChild(this.parent[c], c, this.isDir(c));
  }

  // ---------------------------------------------------------------- build

  /** The child of `n` named `seg`, made (unsorted) when missing. Only for `build`. */
  private childOrNew(n: number, seg: string): number {
    const nid = this.intern(seg);
    let c = this.childKey.get(n * KEY_SHIFT + nid);
    if (c === undefined) {
      c = this.alloc(n, nid, false);
      let ch = this.kids[n];
      if (ch === EMPTY) {
        ch = [];
        this.kids[n] = ch;
      }
      ch.push(c);
    }
    return c;
  }

  private clear(capacity: number): void {
    this.cap = 0;
    this.parent = new Int32Array(0);
    this.nameId = new Int32Array(0);
    this.depthArr = new Int32Array(0);
    this.flags = new Uint8Array(0);
    this.inner = new Int32Array(0);
    this.shownKids = new Int32Array(0);
    this.marks = new Int32Array(0);
    this.sumAdd = new Int32Array(0);
    this.sumDel = new Int32Array(0);
    this.sumCount = new Int32Array(0);
    this.pos = new Int32Array(0);
    this.grow(Math.max(64, capacity));
    this.kids = [EMPTY as number[]];
    this.freeIds = [];
    this.nextId = 1;
    this.names = [];
    this.nameIds = new Map();
    this.childKey = new Map();
    this.pathCache = [];
    this.lcCache = [];
    this.lcNames = [];
    this.listed = new Set();
    this.baseExpanded = new Set();
    this.filterExpanded = null;
    this.expandedSet = this.baseExpanded;
    this.live = 0;
    this.flags[ROOT] = F_ALIVE;
    this.parent[ROOT] = -1;
    this.depthArr[ROOT] = -1;
  }

  /**
   * Build the index from the paths given to the constructor (or `reset`), as
   * steps: each `next()` does a bounded amount of work (~2,000 paths, or the
   * children of a few hundred folders), so a caller can yield between them.
   * The model is not usable until the generator finishes.
   */
  *build(): Generator<void, void, void> {
    const paths = this.pendingPaths ?? [];
    const expanded = this.pendingExpanded;
    const filter = this.test;
    this.pendingPaths = null;
    this.pendingExpanded = undefined;
    const list = Array.isArray(paths) ? (paths as string[]) : [...paths];
    this.clear(Math.ceil(list.length * 1.25) + 16);

    // 1. Nodes, unsorted. A folder walk lists paths in order, so each path
    // shares a prefix with the one before it: the shared folders are taken
    // from the previous path's chain instead of being looked up again.
    let prev = '';
    const prevEnds: number[] = [];
    const prevIds: number[] = [];
    for (let at = 0; at < list.length; at++) {
      if ((at & 2047) === 2047) yield;
      const path = list[at];
      if (!isPlainPath(path)) {
        const norm = normalizeTreePath(path);
        prev = '';
        prevEnds.length = 0;
        prevIds.length = 0;
        if (!norm) continue;
        let n = ROOT;
        for (const seg of norm.segments) n = this.childOrNew(n, seg);
        this.flags[n] |= norm.dir ? F_DIR : F_FILE;
        this.listed.add(norm.dir ? `${norm.key}/` : norm.key);
        continue;
      }
      const lim = Math.min(path.length, prev.length);
      let same = 0;
      while (same < lim && path.charCodeAt(same) === prev.charCodeAt(same)) same++;
      let k = 0;
      while (k < prevEnds.length && prevEnds[k] <= same && prevEnds[k] < path.length && path.charCodeAt(prevEnds[k]) === 47) k++;
      prevEnds.length = k;
      prevIds.length = k;
      let n = k === 0 ? ROOT : prevIds[k - 1];
      let start = k === 0 ? 0 : prevEnds[k - 1] + 1;
      for (;;) {
        const slash = path.indexOf('/', start);
        const end = slash < 0 ? path.length : slash;
        n = this.childOrNew(n, path.slice(start, end));
        prevEnds.push(end);
        prevIds.push(n);
        if (slash < 0) break;
        start = slash + 1;
      }
      prev = path;
      this.flags[n] |= F_FILE;
      this.listed.add(path);
    }
    yield;

    // 2. Sort each folder's children, a few hundred folders per step.
    const kids = this.kids;
    const flags = this.flags;
    const names = this.names;
    const nameId = this.nameId;
    const isDirKey = (c: number) => (kids[c].length > 0 || (flags[c] & F_DIR) !== 0 ? 0 : 1);
    const cmp = (a: number, b: number) => isDirKey(a) - isDirKey(b) || compareTreeNames(names[nameId[a]], names[nameId[b]]);
    let work = 0;
    for (let n = 0; n < this.nextId; n++) {
      const ch = kids[n];
      if (ch.length === 0) continue;
      if (ch.length > 1) ch.sort(cmp);
      for (let k = 0; k < ch.length; k++) this.pos[ch[k]] = k;
      this.shownKids[n] = ch.length;
      work += ch.length;
      if (work > 4000) {
        work = 0;
        yield;
      }
    }
    yield;

    // 3. Expansion, values, counts, filter.
    if (expanded) {
      for (const p of expanded) {
        const id = this.find(p);
        if (id > ROOT && this.isDir(id)) this.baseExpanded.add(id);
      }
    }
    for (const key of this.values.keys()) {
      const id = this.find(key);
      if (id > ROOT) this.attachValues(id, key);
    }
    this.recount(ROOT);
    if (filter) this.setFilter(filter);
  }

  /** Replace everything with `paths` (synchronously). Expanded folders given by path are kept where they still exist; a filter stays set. */
  reset(paths: Iterable<string>, expanded?: Iterable<string>): void {
    this.pendingPaths = paths;
    this.pendingExpanded = expanded;
    this.runBuild();
  }

  /** List one path (a trailing `/` lists a folder). True when anything changed. */
  add(path: string): boolean {
    const norm = normalizeTreePath(path);
    if (!norm) return false;
    const segs = norm.segments;
    const hidden = this.test !== null;
    let n = ROOT;
    let changed = false;
    let prefix = '';
    for (let i = 0; i < segs.length; i++) {
      const last = i === segs.length - 1;
      const nid = this.intern(segs[i]);
      prefix = i === 0 ? segs[i] : `${prefix}/${segs[i]}`;
      let c = this.childKey.get(n * KEY_SHIFT + nid);
      if (c === undefined) {
        const parentWasDir = n === ROOT || this.isDir(n);
        c = this.alloc(n, nid, hidden);
        if (last) {
          this.flags[c] |= norm.dir ? F_DIR : F_FILE;
          this.listed.add(norm.dir ? `${norm.key}/` : norm.key);
        }
        this.insertChild(n, c, !last || norm.dir);
        if (!hidden) this.bump(n, 1);
        if (!parentWasDir) this.reposition(n);
        this.attachValues(c, prefix);
        changed = true;
      } else if (last) {
        const bit = norm.dir ? F_DIR : F_FILE;
        if ((this.flags[c] & bit) === 0) {
          const wasDir = this.isDir(c);
          this.flags[c] |= bit;
          this.listed.add(norm.dir ? `${norm.key}/` : norm.key);
          if (this.isDir(c) !== wasDir) this.reposition(c);
          changed = true;
        }
      }
      n = c;
    }
    if (changed && this.test !== null) {
      this.refreshShown(n);
      if (this.isShown(n)) this.expandAncestors(n);
    }
    return changed;
  }

  /**
   * Remove `path` and everything under it (a folder deleted on disk). A file
   * path removes the file. Folders left empty that were never listed go too.
   */
  remove(path: string): boolean {
    const id = this.find(path);
    if (id <= ROOT) return false;
    this.deleteSubtree(id);
    return true;
  }

  /** Take one listed entry off (a file, or a folder's `/` listing) without touching what is under it. */
  unlist(path: string): boolean {
    const norm = normalizeTreePath(path);
    if (!norm) return false;
    const id = this.find(norm.key);
    if (id <= ROOT) return false;
    const bit = norm.dir ? F_DIR : F_FILE;
    if ((this.flags[id] & bit) === 0) return false;
    const wasDir = this.isDir(id);
    this.flags[id] &= ~bit;
    this.listed.delete(norm.dir ? `${norm.key}/` : norm.key);
    if (this.kids[id].length > 0) {
      this.refreshShown(id);
      return true;
    }
    if ((this.flags[id] & (F_FILE | F_DIR)) === 0) {
      this.deleteSubtree(id);
      return true;
    }
    if (this.isDir(id) !== wasDir) {
      this.forgetExpansion(id);
      this.reposition(id);
    }
    this.refreshShown(id);
    return true;
  }

  private forgetExpansion(id: number): void {
    this.baseExpanded.delete(id);
    this.filterExpanded?.delete(id);
  }

  private deleteSubtree(id: number): void {
    const p = this.parent[id];
    const shown = this.isShown(id);
    const rows = 1 + this.vis(id);
    this.detach(id);
    if (shown) this.bump(p, -rows);
    this.subtractTotals(p, id);
    const stack = [id];
    while (stack.length > 0) {
      const n = stack.pop()!;
      for (const c of this.kids[n]) stack.push(c);
      const f = this.flags[n];
      if (f & (F_FILE | F_DIR)) {
        const key = this.pathOf(n);
        if (f & F_FILE) this.listed.delete(key);
        if (f & F_DIR) this.listed.delete(`${key}/`);
      }
      this.childKey.delete(this.parent[n] * KEY_SHIFT + this.nameId[n]);
      this.forgetExpansion(n);
      this.flags[n] = 0;
      this.kids[n] = EMPTY as number[];
      this.pathCache[n] = undefined;
      this.lcCache[n] = undefined;
      this.freeIds.push(n);
      this.live--;
    }
    this.prune(p);
    if (this.isAlive(p)) this.refreshShown(p);
  }

  /** `p` lost a child: drop it when it is an empty folder nobody listed, or turn it back into a file. */
  private prune(p: number): void {
    if (p === ROOT || this.kids[p].length > 0) return;
    const f = this.flags[p];
    if (f & F_DIR) return;
    if (f & F_FILE) {
      this.forgetExpansion(p);
      this.reposition(p);
      return;
    }
    this.deleteSubtree(p);
  }

  /** The difference between what the index lists and `paths`. */
  diff(paths: Iterable<string>): { adds: string[]; removes: string[]; size: number } {
    const next = new Set<string>();
    for (const p of paths) {
      const key = treePathKey(p);
      if (key !== null) next.add(key);
    }
    const adds: string[] = [];
    const removes: string[] = [];
    for (const p of next) if (!this.listed.has(p)) adds.push(p);
    for (const p of this.listed) if (!next.has(p)) removes.push(p);
    return { adds, removes, size: next.size };
  }

  /**
   * Make the index hold exactly `paths`. Applies the difference (adds before
   * removes, so a folder that stays never empties and keeps its expansion), or
   * rebuilds when more than a quarter of the list changed.
   */
  setPaths(paths: Iterable<string>): boolean {
    const list = Array.isArray(paths) ? (paths as string[]) : [...paths];
    const diff = this.diff(list);
    if (diff.adds.length === 0 && diff.removes.length === 0) return false;
    if (FileTreeModel.rebuildFor(diff)) {
      this.reset(list, this.baseExpandedPaths());
      return true;
    }
    this.applyDiff(diff);
    return true;
  }

  /** A difference this large is cheaper as a rebuild than as single changes. */
  static rebuildFor(diff: { adds: string[]; removes: string[]; size: number }): boolean {
    return diff.adds.length + diff.removes.length > Math.max(2000, diff.size / 4);
  }

  /** Apply a difference from `diff` (adds before removes, so a folder that stays never empties). */
  applyDiff(diff: { adds: string[]; removes: string[] }): void {
    const steps = this.applyDiffSteps(diff);
    while (!steps.next().done) {
      /* run to the end */
    }
  }

  /** `applyDiff` in steps of a few hundred paths, for a large difference applied between tasks. */
  *applyDiffSteps(diff: { adds: string[]; removes: string[] }): Generator<void, void, void> {
    let n = 0;
    for (const p of diff.adds) {
      this.add(p);
      if ((++n & 255) === 0) yield;
    }
    for (const p of diff.removes) {
      this.unlist(p);
      if ((++n & 255) === 0) yield;
    }
  }

  /**
   * Fill the filter's lowercase paths in steps, so the first filter after a
   * build costs one pass and no task runs long. Each path is also searched
   * once here: JavaScriptCore keeps a joined string as pieces (a rope) until
   * its first search, and flattening 150k of them inside the first filter
   * pass took ~30 ms. The search's result is kept so the optimizer cannot
   * drop it.
   */
  *prepareFilter(): Generator<void, void, void> {
    const order = this.preorderAll();
    let flattened = 0;
    for (let i = 1; i < order.length; i++) {
      if ((i & 4095) === 0) yield;
      if (!this.lowercasePath(order[i]).includes('//')) flattened++;
    }
    this.flattenedPaths = flattened;
  }

  /** How many lowercase paths `prepareFilter` flattened (kept so that search is not optimized away). */
  flattenedPaths = 0;

  /** Listed entries (a folder listed with `/` keeps its slash). */
  get listedCount(): number {
    return this.listed.size;
  }

  // ---------------------------------------------------------------- expansion

  expand(id: number): boolean {
    if (!this.isAlive(id) || !this.isDir(id) || this.expandedSet.has(id)) return false;
    this.expandedSet.add(id);
    if (this.isShown(id)) this.bump(this.parent[id], this.inner[id]);
    return true;
  }

  collapse(id: number): boolean {
    if (!this.expandedSet.has(id)) return false;
    this.expandedSet.delete(id);
    if (this.isShown(id)) this.bump(this.parent[id], -this.inner[id]);
    return true;
  }

  /** Expand every ancestor of `id` so its row shows. */
  expandAncestors(id: number): boolean {
    if (!this.isAlive(id)) return false;
    const chain: number[] = [];
    for (let p = this.parent[id]; p !== ROOT; p = this.parent[p]) chain.push(p);
    let changed = false;
    for (let i = chain.length - 1; i >= 0; i--) changed = this.expand(chain[i]) || changed;
    return changed;
  }

  /** Expand `top` (ROOT: the whole tree) and every folder under it, in one pass. */
  expandAll(top: number = ROOT): boolean {
    if (top !== ROOT && (!this.isAlive(top) || !this.isDir(top))) return false;
    const before = top === ROOT ? 0 : this.vis(top);
    let changed = false;
    const stack = [top];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n !== ROOT && this.isDir(n) && !this.expandedSet.has(n)) {
        this.expandedSet.add(n);
        changed = true;
      }
      const ch = this.kids[n];
      for (let k = 0; k < ch.length; k++) if (this.isDir(ch[k])) stack.push(ch[k]);
    }
    if (!changed) return false;
    this.recount(top);
    if (top !== ROOT && this.isShown(top)) this.bump(this.parent[top], this.vis(top) - before);
    return true;
  }

  /** Collapse `top` (ROOT: the whole tree) and every folder under it, in one pass. */
  collapseAll(top: number = ROOT): boolean {
    if (top !== ROOT && !this.isAlive(top)) return false;
    if (top === ROOT) {
      if (this.expandedSet.size === 0) return false;
      this.expandedSet.clear();
      this.recount(ROOT);
      return true;
    }
    const before = this.vis(top);
    let changed = false;
    const stack = [top];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (this.expandedSet.delete(n)) changed = true;
      const ch = this.kids[n];
      for (let k = 0; k < ch.length; k++) if (this.isDir(ch[k])) stack.push(ch[k]);
    }
    if (!changed) return false;
    this.recount(top);
    if (this.isShown(top)) this.bump(this.parent[top], this.vis(top) - before);
    return true;
  }

  // ---------------------------------------------------------------- marks

  /** Replace the host's per-path values. Values for paths not in the tree are kept for when they are added. */
  setValues(values: ReadonlyMap<string, FileTreeValues>): void {
    for (const [key, v] of this.values) {
      const id = this.find(key);
      if (id > ROOT) {
        this.flags[id] &= ~F_MARK;
        this.addUp(id, v, -1);
      }
    }
    this.values = normalizeValues(values);
    for (const key of this.values.keys()) {
      const id = this.find(key);
      if (id > ROOT) this.attachValues(id, key);
    }
  }

  /** Shorthand: mark these paths, nothing else. */
  setMarked(paths: Iterable<string>): void {
    const values = new Map<string, FileTreeValues>();
    for (const p of paths) values.set(p, { mark: true });
    this.setValues(values);
  }
}
