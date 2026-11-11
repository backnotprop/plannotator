/** Fuzzy path matcher for Go to File. Every query term's characters must appear in the path in order; the best-scoring alignment wins. */

export interface FuzzyPathMatch {
  path: string;
  score: number;
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
/** Enough to win a tie, never a real gap. */
const PREFERRED = 0.5;
const MAX_STARTS = 4;

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

function fits(lower: string, term: string, from: number, at: number): boolean {
  let cursor = at;
  for (let i = from; i < term.length; i++) {
    cursor = lower.indexOf(term[i], cursor);
    if (cursor === -1) return false;
    cursor++;
  }
  return true;
}

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
  preferred?: ReadonlySet<string>;
  lowerPaths?: readonly string[];
}

interface Ranked {
  match: FuzzyPathMatch;
  order: number;
}

function ranksBelow(a: Ranked, b: Ranked): boolean {
  return a.match.score < b.match.score || (a.match.score === b.match.score && a.order > b.order);
}

/** Min-heap on rank: the root is the weakest kept entry. */
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

  get bar(): number {
    return this.heap.length < this.limit ? -Infinity : this.heap[0].match.score;
  }

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

export function fuzzySearchPaths(paths: readonly string[], query: string, options: FuzzyPathSearchOptions = {}): FuzzyPathMatch[] {
  const terms = prepareFuzzyQuery(query);
  const limit = options.limit ?? 50;
  if (limit <= 0 || terms.length === 0) return [];
  const top = new TopRanked(limit);
  paths.forEach((path, order) => {
    if (path.charCodeAt(path.length - 1) === 47) return;
    const match = scoreFuzzyPath(path, terms, options.lowerPaths?.[order]);
    if (match === null) return;
    if (options.preferred?.has(path)) match.score += PREFERRED;
    if (match.score < top.bar) return;
    top.offer({ match, order });
  });
  return top.drain();
}
