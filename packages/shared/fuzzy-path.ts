/**
 * Fuzzy path matching for Go to File (⌘P / Ctrl+P) in code review.
 *
 * Plannotator's own matcher. A path matches a query when every term's
 * characters appear in the path in order. Each candidate alignment is built
 * greedily from a few starting points (word starts first) and scored; the
 * best one wins. Scores reward characters at word starts (after `/ . _ -`, a
 * space, or a lower-to-upper case change), runs of consecutive characters,
 * matches in the file name, and how much of the file name the query covers;
 * gaps and long paths cost a little. Linear in the path's length per
 * starting point, so a few hundred thousand paths fit a keystroke.
 */

export interface FuzzyPathMatch {
  path: string;
  score: number;
  /** Where each query character landed in the path (string indices), in order. */
  positions: number[];
}

const WORD_START = 8;
const RUN = 5;
const IN_NAME = 2;
const PER_CHAR = 1;
const GAP_COST = 0.2;
const GAP_COST_MAX = 3;
const NAME_IS_TERM = 50;
const NAME_STARTS_WITH_TERM = 25;
const NAME_COVERAGE = 30;
const LENGTH_COST = 0.03;
/** Added to a preferred path's score: enough to win a tie, never a real gap. */
const PREFERRED = 0.5;
/** Starting points tried per term (word starts, then the first occurrence). */
const MAX_STARTS = 4;

/**
 * The query's terms: runs of non-space characters, lowercased (Go to File
 * matches without case). "  Foo  bar" gives ["foo", "bar"].
 */
export function prepareFuzzyQuery(query: string): string[] {
  const terms: string[] = [];
  let current = '';
  for (const char of query) {
    if (/\s/.test(char)) {
      if (current) terms.push(current);
      current = '';
    } else {
      current += char.toLowerCase();
    }
  }
  if (current) terms.push(current);
  return terms;
}

function isWordStart(path: string, at: number): boolean {
  if (at === 0) return true;
  const before = path[at - 1];
  if (before === '/' || before === '.' || before === '_' || before === '-' || before === ' ') return true;
  const current = path[at];
  return current >= 'A' && current <= 'Z' && before >= 'a' && before <= 'z';
}

/** Whether `term` from `from` appears in `lower` from `at` onward, in order. */
function fits(lower: string, term: string, from: number, at: number): boolean {
  let cursor = at;
  for (let i = from; i < term.length; i++) {
    cursor = lower.indexOf(term[i], cursor);
    if (cursor === -1) return false;
    cursor++;
  }
  return true;
}

/**
 * One alignment from a first position: each next character is the very next
 * one when it matches (a run), else its next word-start occurrence when the
 * rest still fits after it, else its next occurrence.
 */
function align(path: string, lower: string, term: string, first: number): number[] | null {
  const positions = [first];
  let at = first + 1;
  for (let i = 1; i < term.length; i++) {
    const char = term[i];
    if (lower[at] === char) {
      positions.push(at++);
      continue;
    }
    let next = lower.indexOf(char, at);
    if (next === -1) return null;
    if (!isWordStart(path, next)) {
      let candidate = lower.indexOf(char, next + 1);
      while (candidate !== -1 && !isWordStart(path, candidate)) candidate = lower.indexOf(char, candidate + 1);
      if (candidate !== -1 && fits(lower, term, i + 1, candidate + 1)) next = candidate;
    }
    positions.push(next);
    at = next + 1;
  }
  return positions;
}

function scoreAlignment(path: string, positions: readonly number[], nameStart: number): number {
  let score = 0;
  for (let i = 0; i < positions.length; i++) {
    const at = positions[i];
    score += PER_CHAR;
    if (isWordStart(path, at)) score += WORD_START;
    if (at >= nameStart) score += IN_NAME;
    if (i > 0) {
      const gap = at - positions[i - 1] - 1;
      if (gap === 0) score += RUN;
      else score -= Math.min(GAP_COST_MAX, gap * GAP_COST);
    }
  }
  return score;
}

function scoreTerm(path: string, lower: string, term: string): { score: number; positions: number[] } | null {
  if (!fits(lower, term, 0, 0)) return null;
  const nameStart = path.lastIndexOf('/') + 1;
  // Starting points: word starts of the first character (file name first),
  // then its first occurrence in the file name and in the path.
  const starts: number[] = [];
  const add = (at: number) => {
    if (at !== -1 && !starts.includes(at) && starts.length < MAX_STARTS) starts.push(at);
  };
  for (let at = lower.indexOf(term[0], nameStart); at !== -1 && starts.length < MAX_STARTS - 2; at = lower.indexOf(term[0], at + 1)) {
    if (isWordStart(path, at)) add(at);
  }
  add(lower.indexOf(term[0], nameStart));
  for (let at = lower.indexOf(term[0]); at !== -1 && at < nameStart && starts.length < MAX_STARTS - 1; at = lower.indexOf(term[0], at + 1)) {
    if (isWordStart(path, at)) add(at);
  }
  add(lower.indexOf(term[0]));
  let best: { score: number; positions: number[] } | null = null;
  for (const first of starts) {
    const positions = align(path, lower, term, first);
    if (!positions) continue;
    const score = scoreAlignment(path, positions, nameStart);
    if (!best || score > best.score) best = { score, positions };
  }
  if (!best) return null;
  const name = lower.slice(nameStart);
  if (name === term) best.score += NAME_IS_TERM;
  else if (name.startsWith(term)) best.score += NAME_STARTS_WITH_TERM;
  return best;
}

/** Scores a path against prepared terms (every term must match), or null. */
export function scoreFuzzyPath(path: string, terms: readonly string[], lowerPath = path.toLowerCase()): FuzzyPathMatch | null {
  const nameStart = path.lastIndexOf('/') + 1;
  let positions: number[] = [];
  let score = 0;
  for (const term of terms) {
    const result = scoreTerm(path, lowerPath, term);
    if (!result) return null;
    score += result.score;
    positions = positions.length === 0 ? result.positions : positions.concat(result.positions);
  }
  if (terms.length > 1) positions = [...new Set(positions)].sort((a, b) => a - b);
  const nameLength = path.length - nameStart;
  if (nameLength > 0) {
    let inName = 0;
    for (const at of positions) if (at >= nameStart) inName++;
    score += NAME_COVERAGE * (inName / nameLength);
  }
  score -= path.length * LENGTH_COST;
  return { path, score, positions };
}

export interface FuzzyPathSearchOptions {
  limit?: number;
  /** Paths that win ties (code review: the files the diff changes). */
  preferred?: ReadonlySet<string>;
  /** `paths` lowercased, when the caller keeps them (a large list searched per keystroke). */
  lowerPaths?: readonly string[];
}

interface Ranked {
  match: FuzzyPathMatch;
  /** Position in the input: on equal scores the earlier path ranks first. */
  order: number;
}

/** True when `a` ranks below `b` (a lower score, or an equal one later in the input). */
function ranksBelow(a: Ranked, b: Ranked): boolean {
  return a.match.score < b.match.score || (a.match.score === b.match.score && a.order > b.order);
}

/**
 * The `limit` best entries seen so far, kept as a min-heap on rank: the
 * root is the weakest kept entry, so a new candidate either replaces it or
 * is dropped, in O(log limit).
 */
class TopRanked {
  private readonly heap: Ranked[] = [];
  constructor(private readonly limit: number) {}

  offer(entry: Ranked): void {
    const heap = this.heap;
    if (heap.length < this.limit) {
      heap.push(entry);
      this.siftUp(heap.length - 1);
    } else if (ranksBelow(heap[0], entry)) {
      heap[0] = entry;
      this.siftDown(0);
    }
  }

  /** The weakest score a candidate must beat once full (else -Infinity). */
  get bar(): number {
    return this.heap.length < this.limit ? -Infinity : this.heap[0].match.score;
  }

  /** Best first. */
  drain(): FuzzyPathMatch[] {
    return [...this.heap].sort((a, b) => (ranksBelow(a, b) ? 1 : ranksBelow(b, a) ? -1 : 0)).map((entry) => entry.match);
  }

  private siftUp(at: number): void {
    const heap = this.heap;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!ranksBelow(heap[at], heap[parent])) break;
      [heap[at], heap[parent]] = [heap[parent], heap[at]];
      at = parent;
    }
  }

  private siftDown(at: number): void {
    const heap = this.heap;
    for (;;) {
      const left = at * 2 + 1;
      const right = left + 1;
      let weakest = at;
      if (left < heap.length && ranksBelow(heap[left], heap[weakest])) weakest = left;
      if (right < heap.length && ranksBelow(heap[right], heap[weakest])) weakest = right;
      if (weakest === at) return;
      [heap[at], heap[weakest]] = [heap[weakest], heap[at]];
      at = weakest;
    }
  }
}

/** The best `limit` matches for `query` among `paths`, highest score first. */
export function fuzzySearchPaths(paths: readonly string[], query: string, options: FuzzyPathSearchOptions = {}): FuzzyPathMatch[] {
  const terms = prepareFuzzyQuery(query);
  const limit = options.limit ?? 50;
  if (limit <= 0 || terms.length === 0) return [];
  const top = new TopRanked(limit);
  paths.forEach((path, order) => {
    // Folder entries (a trailing slash) are never opened.
    if (path.charCodeAt(path.length - 1) === 47) return;
    const match = scoreFuzzyPath(path, terms, options.lowerPaths?.[order]);
    if (match === null) return;
    if (options.preferred?.has(path)) match.score += PREFERRED;
    if (match.score < top.bar) return;
    top.offer({ match, order });
  });
  return top.drain();
}
