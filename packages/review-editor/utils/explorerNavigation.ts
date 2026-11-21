/**
 * Back and forward across jumps in code review (approved design record
 * "review-explorer", step 3): a review-local history, never the browser's, so
 * it never leaves the review. Only a jump records an entry: Go to File, Go to
 * Definition, a reference opened from the references panel. Opening a file
 * from the tree is not a jump.
 */

/** Where a jump starts or lands. `path: null` is the All files view. */
export interface NavLocation {
  path: string | null;
  line?: number;
  /** Going back here also puts this file back in this view (a jump flipped it to Whole file). */
  restoreView?: { path: string; view: 'changes' | 'whole' };
}

export interface NavHistory {
  back: readonly NavLocation[];
  forward: readonly NavLocation[];
}

export const EMPTY_NAV_HISTORY: NavHistory = { back: [], forward: [] };
export const MAX_NAV_HISTORY = 50;

export function sameNavLocation(a: NavLocation | null | undefined, b: NavLocation | null | undefined): boolean {
  if (!a || !b) return false;
  return a.path === b.path && (a.line ?? null) === (b.line ?? null) && !b.restoreView;
}

/** A jump from `from`: it becomes the newest Back entry; Forward is dropped. */
export function pushNavJump(history: NavHistory, from: NavLocation | null): NavHistory {
  if (!from) return { back: history.back, forward: [] };
  const last = history.back[history.back.length - 1];
  const back = sameNavLocation(last, from) ? history.back : [...history.back, from].slice(-MAX_NAV_HISTORY);
  return { back, forward: [] };
}

/** Back from `current`: the place to go and the history after it, or null at the start. */
export function navigateBack(history: NavHistory, current: NavLocation | null): { target: NavLocation; history: NavHistory } | null {
  const target = history.back[history.back.length - 1];
  if (!target) return null;
  return {
    target,
    history: {
      back: history.back.slice(0, -1),
      forward: current ? [...history.forward, current].slice(-MAX_NAV_HISTORY) : history.forward,
    },
  };
}

export function navigateForward(history: NavHistory, current: NavLocation | null): { target: NavLocation; history: NavHistory } | null {
  const target = history.forward[history.forward.length - 1];
  if (!target) return null;
  return {
    target,
    history: {
      back: current ? [...history.back, current].slice(-MAX_NAV_HISTORY) : history.back,
      forward: history.forward.slice(0, -1),
    },
  };
}

/** Recently opened paths, newest first, each once. */
export function pushRecentPath(recent: readonly string[], path: string, max = 20): string[] {
  return [path, ...recent.filter((entry) => entry !== path)].slice(0, max);
}

const IDENTIFIER_CHAR = /[\p{L}\p{N}_$]/u;

function lineHasSymbol(text: string, symbol: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(symbol, from);
    if (at === -1) return false;
    const before = at > 0 ? text[at - 1] : '';
    const after = text[at + symbol.length] ?? '';
    if (!IDENTIFIER_CHAR.test(before) && !IDENTIFIER_CHAR.test(after)) return true;
    from = at + 1;
  }
}

/**
 * Code navigation searches the working tree, so its line numbers are the
 * working tree's. A tab that shows another revision (staged, a commit, a
 * branch) looks for the symbol near that line in what it shows: the line
 * itself, else the nearest line within `radius` that has the symbol as a
 * whole word. Not found: null, and the tab opens at the top with a note.
 */
export function findSymbolLine(content: string, symbol: string | undefined, line: number, radius = 200): number | null {
  const lines = content.split('\n');
  if (!symbol) return line >= 1 && line <= lines.length ? line : null;
  const has = (n: number) => n >= 1 && n <= lines.length && lineHasSymbol(lines[n - 1], symbol);
  if (has(line)) return line;
  for (let step = 1; step <= radius; step += 1) {
    if (has(line - step)) return line - step;
    if (has(line + step)) return line + step;
  }
  return null;
}

/** A line to bring into view in a file tab (a jump's landing). */
export interface RevealTarget {
  path: string;
  line: number;
  /** The symbol jumped to, looked for near `line` when the tab shows another revision. */
  symbol?: string;
  /** Changes on every jump, so the same line can be revealed again. */
  token: number;
}

export type JumpVia = 'definition' | 'references' | 'file';

/** "From buildFileTree.ts:11 · Go to Definition (F12)" over the file a jump opened. */
export interface JumpCrumb {
  targetPath: string;
  from: NavLocation;
  via: JumpVia;
}

/** "buildFileTree.ts:11", "All changes". */
export function navLocationLabel(location: NavLocation): string {
  if (location.path == null) return 'All changes';
  const name = location.path.slice(location.path.lastIndexOf('/') + 1);
  return location.line ? `${name}:${location.line}` : name;
}
