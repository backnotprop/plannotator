/**
 * FileTreeModel — the counted path index behind `<FileTree>`.
 *
 * Built once from a list of paths. Every path segment is interned (a folder
 * named `src` is one string however many times it appears) and every node is a
 * slot in a set of typed arrays: parent, name, depth, flags, and two counts.
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
 * off its ancestors, its ids freed for reuse. `setPaths` diffs a full snapshot
 * against what the index holds and applies only the difference, or rebuilds
 * when most of the list changed (a rebuild of 150k paths takes ~100 ms, about
 * what applying 50k single changes costs).
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
 * and deleted, a comment count); every node keeps their sums over its subtree,
 * updated by delta on add and remove, so a folder's "+12 -3", its comment count
 * and "this collapsed folder holds changes" are one read in render, never a
 * walk.
 */

export const ROOT = 0;

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

const F_ALIVE = 1;
/** Listed as a file. */
const F_FILE = 2;
/** Listed as a folder (the path ended in `/`). */
const F_DIR = 4;
/** The host marked this path. */
const F_MARK = 8;

const EMPTY: readonly number[] = Object.freeze([]) as readonly number[];
/** parent * 2^32 + nameId: unique while ids stay under 2^21. */
const KEY_SHIFT = 4294967296;

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
 * or `.` segments dropped, a trailing `/` marking a folder. Backslashes are
 * names, not separators (they are legal in POSIX file names). Null when
 * nothing is left.
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
function isPlainPath(path: string): boolean {
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
  /** Number of siblings, this node included (aria-setsize). */
  setSize: number;
  /** 1-based position among them (aria-posinset). */
  posInSet: number;
  /** The host marked a node below this one. */
  markedBelow: boolean;
}

export class FileTreeModel {
  private cap = 0;
  private parent = new Int32Array(0);
  private nameId = new Int32Array(0);
  private depthArr = new Int32Array(0);
  private flags = new Uint8Array(0);
  private inner = new Int32Array(0);
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
  private expandedSet = new Set<number>();
  /** Per-path values the host gave (marks and the numbers folders sum). */
  private values = new Map<string, FileTreeValues>();
  private live = 0;

  constructor(paths: Iterable<string> = [], options: { expanded?: Iterable<string>; values?: ReadonlyMap<string, FileTreeValues> } = {}) {
    if (options.values) this.values = normalizeValues(options.values);
    this.reset(paths, options.expanded);
  }

  // ---------------------------------------------------------------- storage

  private grow(min: number): void {
    if (min <= this.cap) return;
    let cap = Math.max(64, this.cap * 2);
    while (cap < min) cap *= 2;
    const g32 = (a: Int32Array) => { const b = new Int32Array(cap); b.set(a); return b; };
    this.parent = g32(this.parent);
    this.nameId = g32(this.nameId);
    this.depthArr = g32(this.depthArr);
    this.inner = g32(this.inner);
    this.marks = g32(this.marks);
    this.sumAdd = g32(this.sumAdd);
    this.sumDel = g32(this.sumDel);
    this.sumCount = g32(this.sumCount);
    this.pos = g32(this.pos);
    const f = new Uint8Array(cap); f.set(this.flags); this.flags = f;
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

  private alloc(p: number, nid: number): number {
    const id = this.freeIds.length > 0 ? this.freeIds.pop()! : this.nextId++;
    if (id >= this.cap) this.grow(id + 1);
    this.parent[id] = p;
    this.nameId[id] = nid;
    this.depthArr[id] = p === ROOT ? 0 : this.depthArr[p] + 1;
    this.flags[id] = F_ALIVE;
    this.inner[id] = 0;
    this.marks[id] = 0;
    this.sumAdd[id] = 0;
    this.sumDel[id] = 0;
    this.sumCount[id] = 0;
    this.pos[id] = -1;
    this.kids[id] = EMPTY as number[];
    this.pathCache[id] = undefined;
    this.childKey.set(p * KEY_SHIFT + nid, id);
    this.live++;
    return id;
  }

  // ---------------------------------------------------------------- reads

  /** Rows the tree shows (every visible node). */
  get rowCount(): number {
    return this.inner[ROOT] ?? 0;
  }

  /** Nodes in the index, folders included. */
  get nodeCount(): number {
    return this.live;
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

  childrenOf(id: number): readonly number[] {
    return this.kids[id];
  }

  pathOf(id: number): string {
    const cached = this.pathCache[id];
    if (cached !== undefined) return cached;
    const p = this.parent[id];
    const path = p === ROOT ? this.nameOf(id) : `${this.pathOf(p)}/${this.nameOf(id)}`;
    this.pathCache[id] = path;
    return path;
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

  /** Rows under `id` as shown now. */
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

  /** Rows under `id` as shown now (0 when collapsed). */
  rowsUnder(id: number): number {
    return this.vis(id);
  }

  /** Every ancestor of `id` is expanded. */
  isVisible(id: number): boolean {
    if (!this.isAlive(id)) return false;
    let p = this.parent[id];
    while (p !== ROOT) {
      if (!this.expandedSet.has(p)) return false;
      p = this.parent[p];
    }
    return true;
  }

  /** The row `id` shows on, or `id`'s highest collapsed ancestor's when it is hidden. */
  visibleAncestor(id: number): number {
    if (!this.isAlive(id)) return -1;
    let shown = id;
    let p = this.parent[id];
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
      for (let k = 0; k < at; k++) idx += 1 + this.vis(ch[k]);
      x = p;
    }
    return idx;
  }

  /** The row `path` is on, or -1. */
  indexOf(path: string): number {
    const id = this.find(path);
    return id < 0 ? -1 : this.indexOfId(id);
  }

  private row(c: number, index: number, depth: number, setSize: number, posInSet: number): FileTreeRow {
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

  /**
   * Calls `visit` for each visible row from `start` on, in order, until it
   * returns true or the rows run out. Finds `start` by counts, then walks
   * forward with a cursor (each next row is O(1) amortized).
   */
  scan(start: number, visit: (id: number, index: number, depth: number, setSize: number, posInSet: number) => boolean | void): void {
    if (start < 0) start = 0;
    if (start >= this.rowCount) return;
    const dirs: number[] = [];
    const at: number[] = [];
    let n = ROOT;
    let i = start;
    descend: for (;;) {
      const ch = this.kids[n];
      for (let k = 0; k < ch.length; k++) {
        const c = ch[k];
        const size = 1 + this.vis(c);
        if (i < size) {
          dirs.push(n);
          at.push(k);
          if (i === 0) break descend;
          i -= 1;
          n = c;
          continue descend;
        }
        i -= size;
      }
      return;
    }
    let index = start;
    while (dirs.length > 0) {
      const top = dirs.length - 1;
      const ch = this.kids[dirs[top]];
      const c = ch[at[top]];
      if (visit(c, index, top, ch.length, at[top] + 1) === true) return;
      index++;
      if (this.kids[c].length > 0 && this.expandedSet.has(c)) {
        dirs.push(c);
        at.push(0);
        continue;
      }
      while (dirs.length > 0) {
        const t = dirs.length - 1;
        if (++at[t] < this.kids[dirs[t]].length) break;
        dirs.pop();
        at.pop();
      }
    }
  }

  /** Up to `count` visible rows from `start`. */
  rows(start: number, count: number): FileTreeRow[] {
    const out: FileTreeRow[] = [];
    if (count <= 0) return out;
    this.scan(start, (id, index, depth, setSize, posInSet) => {
      out.push(this.row(id, index, depth, setSize, posInSet));
      return out.length >= count;
    });
    return out;
  }

  /** Paths of the expanded folders. */
  expandedPaths(): Set<string> {
    const out = new Set<string>();
    for (const id of this.expandedSet) out.add(this.pathOf(id));
    return out;
  }

  /** Every path the index holds as listed (folders listed with a trailing `/`), in tree order. */
  listedPaths(): string[] {
    const out: string[] = [];
    const walk = (n: number) => {
      for (const c of this.kids[n]) {
        const f = this.flags[c];
        if (f & F_DIR) out.push(`${this.pathOf(c)}/`);
        if (f & F_FILE) out.push(this.pathOf(c));
        walk(c);
      }
    };
    walk(ROOT);
    return out;
  }

  // ---------------------------------------------------------------- counts

  /** `inner[p]` changed by `delta`: pass it up while the folders are open. */
  private bump(p: number, delta: number): void {
    if (delta === 0) return;
    while (p >= 0) {
      this.inner[p] += delta;
      if (p !== ROOT && !this.expandedSet.has(p)) return;
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
    const m = this.marks[from], a = this.sumAdd[from], d = this.sumDel[from], c = this.sumCount[from];
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

  /** Recompute `inner` for every folder in `top`'s subtree, bottom-up. */
  private recount(top: number): void {
    const order: number[] = [top];
    for (let i = 0; i < order.length; i++) {
      const ch = this.kids[order[i]];
      for (let k = 0; k < ch.length; k++) if (this.kids[ch[k]].length > 0) order.push(ch[k]);
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const n = order[i];
      const ch = this.kids[n];
      let s = 0;
      for (let k = 0; k < ch.length; k++) {
        const c = ch[k];
        s += this.expandedSet.has(c) ? 1 + this.inner[c] : 1;
      }
      this.inner[n] = s;
    }
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
  }

  private detach(c: number): void {
    const p = this.parent[c];
    const ch = this.kids[p];
    const at = this.pos[c];
    ch.splice(at, 1);
    for (let k = at; k < ch.length; k++) this.pos[ch[k]] = k;
    if (ch.length === 0) this.kids[p] = EMPTY as number[];
  }

  /** `c` changed kind (file ↔ folder): move it to its place among its siblings. */
  private reposition(c: number): void {
    this.detach(c);
    this.insertChild(this.parent[c], c, this.isDir(c));
  }

  // ---------------------------------------------------------------- build

  /** The child of `n` named `seg`, made (unsorted) when missing. Only for `reset`. */
  private childOrNew(n: number, seg: string): number {
    const nid = this.intern(seg);
    let c = this.childKey.get(n * KEY_SHIFT + nid);
    if (c === undefined) {
      c = this.alloc(n, nid);
      let ch = this.kids[n];
      if (ch === EMPTY) {
        ch = [];
        this.kids[n] = ch;
      }
      ch.push(c);
    }
    return c;
  }

  /** Replace everything with `paths`. Expanded folders and marks given by path are kept where they still exist. */
  reset(paths: Iterable<string>, expanded?: Iterable<string>): void {
    const list = Array.isArray(paths) ? (paths as string[]) : [...paths];
    this.cap = 0;
    this.parent = new Int32Array(0);
    this.nameId = new Int32Array(0);
    this.depthArr = new Int32Array(0);
    this.flags = new Uint8Array(0);
    this.inner = new Int32Array(0);
    this.marks = new Int32Array(0);
    this.sumAdd = new Int32Array(0);
    this.sumDel = new Int32Array(0);
    this.sumCount = new Int32Array(0);
    this.pos = new Int32Array(0);
    this.grow(Math.max(64, Math.ceil(list.length * 1.25) + 16));
    this.kids = [EMPTY as number[]];
    this.freeIds = [];
    this.nextId = 1;
    this.names = [];
    this.nameIds = new Map();
    this.childKey = new Map();
    this.pathCache = [];
    this.expandedSet = new Set();
    this.live = 0;
    this.flags[ROOT] = F_ALIVE;
    this.parent[ROOT] = -1;
    this.depthArr[ROOT] = -1;

    // 1. Nodes, unsorted. A folder walk lists paths in order, so each path
    // shares a prefix with the one before it: the shared folders are taken
    // from the previous path's chain instead of being looked up again.
    let prev = '';
    const prevEnds: number[] = [];
    const prevIds: number[] = [];
    for (const path of list) {
      if (!isPlainPath(path)) {
        const norm = normalizeTreePath(path);
        prev = '';
        prevEnds.length = 0;
        prevIds.length = 0;
        if (!norm) continue;
        let n = ROOT;
        for (const seg of norm.segments) n = this.childOrNew(n, seg);
        this.flags[n] |= norm.dir ? F_DIR : F_FILE;
        continue;
      }
      // Shared folders: whole segments of `prev` that `path` repeats and goes on from.
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
    }

    // 2. Sort every folder's children once, by name rank (one collator sort of the unique names).
    const order = new Int32Array(this.names.length);
    for (let i = 0; i < order.length; i++) order[i] = i;
    const names = this.names;
    order.sort((a, b) => compareTreeNames(names[a], names[b]));
    const rank = new Int32Array(this.names.length);
    for (let i = 0; i < order.length; i++) rank[order[i]] = i;
    const nameId = this.nameId;
    const kids = this.kids;
    const flags = this.flags;
    const dirKey = (c: number) => (kids[c].length > 0 || (flags[c] & F_DIR) !== 0 ? 0 : 1);
    for (let n = 0; n < this.nextId; n++) {
      const ch = kids[n];
      if (ch.length === 0) continue;
      if (ch.length > 1) ch.sort((a, b) => dirKey(a) - dirKey(b) || rank[nameId[a]] - rank[nameId[b]]);
      for (let k = 0; k < ch.length; k++) this.pos[ch[k]] = k;
    }

    // 3. Expansion, marks, counts.
    if (expanded) {
      for (const p of expanded) {
        const id = this.find(p);
        if (id > ROOT && this.isDir(id)) this.expandedSet.add(id);
      }
    }
    for (const key of this.values.keys()) {
      const id = this.find(key);
      if (id > ROOT) this.attachValues(id, key);
    }
    this.recount(ROOT);
  }

  /** List one path (a trailing `/` lists a folder). True when anything changed. */
  add(path: string): boolean {
    const norm = normalizeTreePath(path);
    if (!norm) return false;
    const segs = norm.segments;
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
        c = this.alloc(n, nid);
        if (last) this.flags[c] |= norm.dir ? F_DIR : F_FILE;
        this.insertChild(n, c, !last || norm.dir);
        this.bump(n, 1);
        if (!parentWasDir) this.reposition(n);
        this.attachValues(c, prefix);
        changed = true;
      } else if (last) {
        const bit = norm.dir ? F_DIR : F_FILE;
        if ((this.flags[c] & bit) === 0) {
          const wasDir = this.isDir(c);
          this.flags[c] |= bit;
          if (this.isDir(c) !== wasDir) this.reposition(c);
          changed = true;
        }
      }
      n = c;
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
    if (this.kids[id].length > 0) return true;
    if ((this.flags[id] & (F_FILE | F_DIR)) === 0) {
      this.deleteSubtree(id);
      return true;
    }
    if (this.isDir(id) !== wasDir) {
      this.expandedSet.delete(id);
      this.reposition(id);
    }
    return true;
  }

  private deleteSubtree(id: number): void {
    const p = this.parent[id];
    this.detach(id);
    this.bump(p, -(1 + this.vis(id)));
    this.subtractTotals(p, id);
    const stack = [id];
    while (stack.length > 0) {
      const n = stack.pop()!;
      for (const c of this.kids[n]) stack.push(c);
      this.childKey.delete(this.parent[n] * KEY_SHIFT + this.nameId[n]);
      this.expandedSet.delete(n);
      this.flags[n] = 0;
      this.kids[n] = EMPTY as number[];
      this.pathCache[n] = undefined;
      this.freeIds.push(n);
      this.live--;
    }
    this.prune(p);
  }

  /** `p` lost a child: drop it when it is an empty folder nobody listed, or turn it back into a file. */
  private prune(p: number): void {
    if (p === ROOT || this.kids[p].length > 0) return;
    const f = this.flags[p];
    if (f & F_DIR) return;
    if (f & F_FILE) {
      this.expandedSet.delete(p);
      this.reposition(p);
      return;
    }
    this.deleteSubtree(p);
  }

  /**
   * Make the index hold exactly `paths`. Applies the difference (adds before
   * removes, so a folder that stays never empties and keeps its expansion), or
   * rebuilds when more than a quarter of the list changed.
   */
  setPaths(paths: Iterable<string>): boolean {
    const next = new Set<string>();
    for (const p of paths) {
      const key = treePathKey(p);
      if (key !== null) next.add(key);
    }
    const current = this.listedPaths();
    const currentSet = new Set(current);
    const adds: string[] = [];
    const removes: string[] = [];
    for (const p of next) if (!currentSet.has(p)) adds.push(p);
    for (const p of current) if (!next.has(p)) removes.push(p);
    if (adds.length === 0 && removes.length === 0) return false;
    if (adds.length + removes.length > Math.max(2000, next.size / 4)) {
      this.reset(next, this.expandedPaths());
      return true;
    }
    for (const p of adds) this.add(p);
    for (const p of removes) this.unlist(p);
    return true;
  }

  // ---------------------------------------------------------------- expansion

  expand(id: number): boolean {
    if (!this.isAlive(id) || !this.isDir(id) || this.expandedSet.has(id)) return false;
    this.expandedSet.add(id);
    this.bump(this.parent[id], this.inner[id]);
    return true;
  }

  collapse(id: number): boolean {
    if (!this.expandedSet.has(id)) return false;
    this.expandedSet.delete(id);
    this.bump(this.parent[id], -this.inner[id]);
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
      if (n !== ROOT && this.isDir(n) && !this.expandedSet.has(n)) { this.expandedSet.add(n); changed = true; }
      const ch = this.kids[n];
      for (let k = 0; k < ch.length; k++) if (this.isDir(ch[k])) stack.push(ch[k]);
    }
    if (!changed) return false;
    this.recount(top);
    if (top !== ROOT) this.bump(this.parent[top], this.vis(top) - before);
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
    this.bump(this.parent[top], this.vis(top) - before);
    return true;
  }

  // ---------------------------------------------------------------- marks

  /** Replace the host's per-path values. Values for paths not in the tree are kept for when they are added. */
  setValues(values: ReadonlyMap<string, FileTreeValues>): void {
    for (const [key, v] of this.values) {
      const id = this.find(key);
      if (id > ROOT) { this.flags[id] &= ~F_MARK; this.addUp(id, v, -1); }
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
