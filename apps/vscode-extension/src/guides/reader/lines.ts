/**
 * Lines of the reader's diffs: which side a selection asks about, and the
 * row of a line (for a jump to it). Pierre's `deletions` are base lines,
 * `additions` and unchanged lines head lines. No React.
 */

import type { SelectedLineRange } from "@pierre/diffs";

/** One row of a file's patch, in the order the unified view draws them. */
interface PatchRow {
  kind: "context" | "deletion" | "addition";
  old?: number;
  new?: number;
}

function patchRows(filePatch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of filePatch.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      oldLine = Number(h[1]);
      newLine = Number(h[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("diff --git")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith(" ")) rows.push({ kind: "context", old: oldLine++, new: newLine++ });
    else if (line.startsWith("-")) rows.push({ kind: "deletion", old: oldLine++ });
    else if (line.startsWith("+")) rows.push({ kind: "addition", new: newLine++ });
  }
  return rows;
}

/**
 * The lines a selection asks about, on one side of the diff: Pierre's
 * `deletions` are base lines, `additions` (and unchanged lines) head lines.
 * A selection across removed and added lines is not asked (the lines would
 * not be one stretch of either version).
 *
 * With the file's patch, the patch rows between the two ends decide, whatever
 * side Pierre names for each end: in the unified view an unchanged row is
 * reported as an `additions` line (its new number), so a selection whose ends
 * are both unchanged rows can still hold removed lines between them. Removed
 * lines with unchanged ones are the old version's lines, numbered on that
 * side; removed and added lines together are refused; anything else is the
 * new side. An end the patch does not have is not guessed at (unless neither
 * end is in it and both name the same side).
 */
export function askLines(range: SelectedLineRange, filePatch?: string): { side: "old" | "new"; start: number; end: number } | null {
  const startSide = range.side === "deletions" ? "old" : "new";
  const endSide = (range.endSide ?? range.side) === "deletions" ? "old" : "new";
  const plain = startSide === endSide ? { side: startSide, start: Math.min(range.start, range.end), end: Math.max(range.start, range.end) } : null;
  if (!filePatch) return plain;
  const rows = patchRows(filePatch);
  const indexOf = (side: "old" | "new", n: number): number => {
    const changed = rows.findIndex((r) => r.kind === (side === "old" ? "deletion" : "addition") && r[side] === n);
    return changed >= 0 ? changed : rows.findIndex((r) => r.kind === "context" && r[side] === n);
  };
  const a = indexOf(startSide, range.start);
  const b = indexOf(endSide, range.end);
  if (a < 0 && b < 0) return plain;
  if (a < 0 || b < 0) return null;
  const slice = rows.slice(Math.min(a, b), Math.max(a, b) + 1);
  const hasDeletion = slice.some((r) => r.kind === "deletion");
  const hasAddition = slice.some((r) => r.kind === "addition");
  if (hasDeletion && hasAddition) return null;
  const side: "old" | "new" = hasDeletion ? "old" : "new";
  const numbers = slice.map((r) => r[side]).filter((n): n is number => n !== undefined);
  if (!numbers.length) return null;
  return { side, start: Math.min(...numbers), end: Math.max(...numbers) };
}

/** Every root under `shell`, Pierre's shadow roots included. */
function diffRoots(shell: Element): ParentNode[] {
  const roots: ParentNode[] = [];
  const stack: ParentNode[] = [shell];
  while (stack.length) {
    const root = stack.pop()!;
    roots.push(root);
    for (const el of Array.from(root.querySelectorAll("*"))) if (el.shadowRoot) stack.push(el.shadowRoot);
  }
  return roots;
}

/**
 * A row's number on one side, or null when the row has none there. A changed
 * row carries its own side's number (`data-line`). An unchanged row carries
 * both, and which attribute is which depends on where Pierre drew it: in the
 * split view's removed column (`[data-deletions]`) `data-line` is the old
 * number and `data-alt-line` the new; elsewhere (the unified view, the split
 * view's added column) `data-line` is the new number and `data-alt-line` the
 * old.
 */
function rowNumber(el: HTMLElement, side: "old" | "new"): number | null {
  const type = el.getAttribute("data-line-type") ?? "";
  const num = (attr: string) => {
    const v = el.getAttribute(attr);
    return v === null || v === "" ? null : Number(v);
  };
  if (type === "addition" || type === "change-addition") return side === "new" ? num("data-line") : null;
  if (type === "deletion" || type === "change-deletion") return side === "old" ? num("data-line") : null;
  if (!type.startsWith("context")) return null;
  const lineIsOld = !!el.closest("[data-deletions]");
  return (side === "old") === lineIsOld ? num("data-line") : num("data-alt-line");
}

/**
 * A line row of a file's diff, on one side. A changed row of that side wins;
 * else an unchanged row whose number on that side is the line (in the split
 * view, preferably in that side's own column).
 */
export function findDiffLine(shell: Element, side: "old" | "new", line: number): HTMLElement | null {
  const roots = diffRoots(shell);
  let context: HTMLElement | null = null;
  let contextOtherColumn: HTMLElement | null = null;
  for (const root of roots) {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[data-line="${line}"], [data-alt-line="${line}"]`))) {
      if (rowNumber(el, side) !== line) continue;
      const type = el.getAttribute("data-line-type") ?? "";
      if (!type.startsWith("context")) return el;
      const inDeletions = !!el.closest("[data-deletions]");
      const ownColumn = side === "old" ? inDeletions : !inDeletions;
      if (ownColumn) context ??= el;
      else contextOtherColumn ??= el;
    }
  }
  return context ?? contextOtherColumn;
}

let jumpGeneration = 0;

/** Stop any line jump still waiting for its row (another jump, a chapter jump, Back). */
export function cancelDiffLineJump(): void {
  jumpGeneration++;
}

/** What the reader does that means it has moved on: a pending jump then gives up. */
const MOVED_ON_EVENTS = ["wheel", "keydown", "pointerdown"] as const;

/**
 * Scroll a file's line into the middle of the tab once its diff is drawn (it
 * mounts as it comes into view). Only the latest jump lands: a jump still
 * waiting when another starts (or `cancelDiffLineJump`) gives up, and so does
 * one still waiting when the reader scrolls, presses a key or clicks, so a
 * late row never pulls the view away from where the reader went since.
 */
export async function scrollToDiffLine(path: string, side: "old" | "new", line: number, opts: { tries?: number; everyMs?: number; firstMs?: number } = {}): Promise<boolean> {
  const generation = ++jumpGeneration;
  const tries = opts.tries ?? 40;
  const movedOn = () => {
    if (generation === jumpGeneration) jumpGeneration++;
  };
  for (const type of MOVED_ON_EVENTS) window.addEventListener(type, movedOn, { capture: true, passive: true });
  try {
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? (opts.firstMs ?? 120) : (opts.everyMs ?? 100)));
      if (generation !== jumpGeneration) return false;
      const shell = document.querySelector(`[data-guide-file-shell="${CSS.escape(path)}"]`);
      const row = shell ? findDiffLine(shell, side, line) : null;
      if (row) {
        row.scrollIntoView({ block: "center" });
        row.animate?.([{ outline: "2px solid var(--vscode-focusBorder, #007fd4)" }, { outline: "2px solid transparent" }], { duration: 1400 });
        return true;
      }
    }
    return false;
  } finally {
    for (const type of MOVED_ON_EVENTS) window.removeEventListener(type, movedOn, { capture: true });
  }
}
