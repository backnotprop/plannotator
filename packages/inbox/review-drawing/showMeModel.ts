/**
 * Show me in the Inbox's code review (Show me makes a Shape: approval
 * "code-review-launch-build", item 1): the pure parts. Which chapter a board's
 * part opens, the part's name for the corner card, and which parts of a redrawn
 * Overview changed.
 */
import { shapeHtmlMarks, type ShapeCodeTarget } from '@plannotator/core/shape';
import { guideDiagramIsDrawn } from '@plannotator/core/guide-format';
import type { GuideOverviewDiagram } from '@plannotator/core/guide';

/** A path's last part: "retry-worker.ts". */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * The Overview's diagram as the review pane draws it, a Shape picture: only a
 * drawn one (snapshot version 3, checked by the Inbox when it came). Null for
 * anything else, a version-2 html diagram included, which keeps the guide
 * viewer's own rendering (its note), exactly as before Show me.
 */
export function overviewPicture(diagram: GuideOverviewDiagram | undefined): GuideOverviewDiagram | null {
  return diagram?.kind === 'html' && guideDiagramIsDrawn(diagram) ? diagram : null;
}

type Place = { file: string | null; lines: readonly [number, number] | null };

/**
 * Whether a Show me asked on `asked` (this round's, or an earlier round's) is
 * the one the person means by `place`, so it opens again rather than asking
 * anew: the whole review both;
 * or the same file with the selection inside the asked lines, or sharing at
 * least half of the lines the two cover together. Lines 1–200 are not a
 * picture of 16–18; 15–18 is.
 */
export function showMeSamePlace(asked: Place, place: Place): boolean {
  if (place.file === null || place.lines === null) return asked.file === null && asked.lines === null;
  if (asked.file !== place.file || !asked.lines) return false;
  const [a0, a1] = asked.lines;
  const [p0, p1] = place.lines;
  if (p0 >= a0 && p1 <= a1) return true;
  const shared = Math.min(a1, p1) - Math.max(a0, p0) + 1;
  const together = Math.max(a1, p1) - Math.min(a0, p0) + 1;
  return shared > 0 && shared * 2 >= together;
}

/** A Show me turn as the window reads it (packages/inbox/api.ts `InboxAskTurnWire`). */
interface ShowMeTurn {
  id: string;
  kind?: 'show_me';
  show_me?: { review: string; file: string | null; lines: [number, number] | null };
  shape?: string;
  answer?: string;
  stopped?: boolean;
  failure?: string;
}

/**
 * This review's Show me for `place` that the agent is drawing now: no board
 * and no answer yet, and actually running (the Inbox's running turn, or this
 * window's live stream). A turn the Inbox kept but nobody answers (no
 * connection when asked, or the session gone before a word) is not waiting:
 * Show me on its lines asks anew.
 */
export function waitingShowMe<T extends ShowMeTurn>(turns: readonly T[], reviewId: string, place: Place, running: string | null, live: string | null): T | undefined {
  return turns
    .filter((turn) => turn.kind === 'show_me' && turn.show_me?.review === reviewId && showMeSamePlace(turn.show_me, place))
    .filter((turn) => !turn.shape && turn.answer === undefined && !turn.stopped && turn.failure === undefined)
    .filter((turn) => turn.id === running || turn.id === live)
    .at(-1);
}

/**
 * Where a part's code is: the walkthrough's chapter that holds the file, or
 * null when no chapter does (it opens in All files).
 */
export function chapterOf(chapters: readonly { diffs: readonly { file: string }[] }[], path: string): number | null {
  const at = chapters.findIndex((chapter) => chapter.diffs.some((ref) => ref.file === path));
  return at < 0 ? null : at;
}

/** The lines a part opens, as a pair. */
export function targetLines(target: ShapeCodeTarget): [number, number] {
  return [target.line, target.lineEnd ?? target.line];
}

/**
 * A part's name for the corner card: its first heading or bold words, else
 * its first words. Read from the drawing as the reviewer sees it.
 */
export function partName(el: Element): string {
  const named = el.querySelector('h1, h2, h3, h4, h5, h6, b, strong, .tt, .title, text');
  const words = (named?.textContent ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(words);
  return chars.length > 48 ? `${chars.slice(0, 47).join('').trimEnd()}…` : words;
}

/** The `data-mark` of the part a click landed in, if it has one. */
export function markOf(el: Element): string | null {
  return el.closest('[data-mark]')?.getAttribute('data-mark') ?? null;
}

/**
 * The parts of a redrawn picture that changed: a `data-mark` whose words
 * differ from the earlier drawing's, or that is new. Parts that kept their
 * id and words are not changed.
 */
export function changedMarks(before: readonly string[], after: readonly string[]): Set<string> {
  const was = new Map<string, string>();
  for (const html of before) for (const mark of shapeHtmlMarks(html)) if (!was.has(mark.id)) was.set(mark.id, mark.text);
  const out = new Set<string>();
  const seen = new Set<string>();
  for (const html of after) {
    for (const mark of shapeHtmlMarks(html)) {
      if (seen.has(mark.id)) continue;
      seen.add(mark.id);
      if (was.get(mark.id) !== mark.text) out.add(mark.id);
    }
  }
  return out;
}

/** A file's new-side lines the patch shows (its hunks' context and additions), by line number. */
export function newSideLines(patch: string): Map<number, string> {
  const out = new Map<number, string>();
  let line = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw === '' || raw.startsWith('-') || raw.startsWith('\\')) continue;
    if (raw.startsWith('+') || raw.startsWith(' ')) {
      out.set(line, raw.slice(1));
      line += 1;
    } else {
      inHunk = false;
    }
  }
  return out;
}

/** What one earlier part opens now: its lines in this round, and whether they changed since it was drawn. */
export interface PartAnchor {
  now: ShapeCodeTarget;
  changed: boolean;
}

/**
 * A board drawn on an earlier review: each part that opens code is anchored
 * again on this review's diff. Its lines, as the earlier
 * round's diff showed them, are looked for in this round's: at the same
 * place, else the nearest place in the file (the part follows them there).
 * Lines no longer found changed since the picture was asked; the part keeps
 * opening the same line numbers. Lines the earlier diff did not show are
 * taken as they are.
 */
export function anchorPart(target: ShapeCodeTarget, before: ReadonlyMap<number, string> | undefined, after: ReadonlyMap<number, string> | undefined): PartAnchor {
  const [start, end] = targetLines(target);
  const block: string[] = [];
  for (let n = start; n <= end; n++) {
    const text = before?.get(n);
    if (text === undefined) return { now: target, changed: false };
    block.push(text);
  }
  const matchesAt = (at: number) => block.every((text, i) => after?.get(at + i) === text);
  if (matchesAt(start)) return { now: target, changed: false };
  const moved = [...(after?.keys() ?? [])].sort((a, b) => Math.abs(a - start) - Math.abs(b - start)).find(matchesAt);
  if (moved !== undefined) return { now: { ...target, line: moved, ...(target.lineEnd !== undefined ? { lineEnd: moved + (end - start) } : {}) }, changed: false };
  return { now: target, changed: true };
}

/**
 * Lines an earlier round asked about, where they are in this round: the same
 * text found at the same place or the nearest one (`anchorPart`). Null when
 * the earlier diff did not show them all, or they changed since.
 */
export function anchorLines(
  lines: readonly [number, number],
  before: ReadonlyMap<number, string> | undefined,
  after: ReadonlyMap<number, string> | undefined,
): [number, number] | null {
  for (let n = lines[0]; n <= lines[1]; n++) if (before?.get(n) === undefined) return null;
  const anchor = anchorPart({ path: '', line: lines[0], ...(lines[1] > lines[0] ? { lineEnd: lines[1] } : {}) }, before, after);
  return anchor.changed ? null : targetLines(anchor.now);
}

/**
 * Lines an earlier round asked about whose text changed since, where they
 * are in this round. Guides are lines both rounds' diffs show once, kept in
 * the same order on both sides. Each end of the block is found by its own
 * line when that is a guide, else by the nearest guide past it with the lines
 * between unchanged. A guide is needed above and below the block. The block
 * may change in size only when both its ends are guides: else lines were added
 * or removed beside it, and it is not known where. Null whenever it is not
 * known: a fresh Show me is always safe, an old picture on other code is not.
 */
export function shiftLines(
  lines: readonly [number, number],
  before: ReadonlyMap<number, string> | undefined,
  after: ReadonlyMap<number, string> | undefined,
): [number, number] | null {
  if (!before || !after) return null;
  const [first, last] = lines;
  for (let n = first; n <= last; n++) if (before.get(n) === undefined) return null;
  const kept = guideLines(before, after);
  const guide = new Map(kept);
  const above = kept.filter(([n]) => n < first).at(-1);
  const below = kept.find(([n]) => n > last);
  if (!above || !below) return null;
  const unchanged = (from: number, to: number, count: number) => {
    for (let i = 0; i < count; i++) {
      const text = before.get(from + i);
      if (text === undefined || after.get(to + i) !== text) return false;
    }
    return true;
  };
  const startFound = guide.get(first);
  const start = startFound ?? above[1] + (first - above[0]);
  if (startFound === undefined && !unchanged(above[0] + 1, above[1] + 1, first - above[0] - 1)) return null;
  const endFound = guide.get(last);
  const end = endFound ?? below[1] - (below[0] - last);
  if (endFound === undefined && !unchanged(last + 1, end + 1, below[0] - last - 1)) return null;
  if ((startFound === undefined || endFound === undefined) && end - start !== last - first) return null;
  if (start <= above[1] || end >= below[1] || start > end) return null;
  for (let n = start; n <= end; n++) if (after.get(n) === undefined) return null;
  return [start, end];
}

/** Lines both diffs show once (not blank), as [earlier, now] pairs kept in the same order on both sides (the longest such run). */
function guideLines(before: ReadonlyMap<number, string>, after: ReadonlyMap<number, string>): [number, number][] {
  const once = (side: ReadonlyMap<number, string>) => {
    const seen = new Map<string, number | null>();
    for (const [n, text] of side) if (text.trim()) seen.set(text, seen.has(text) ? null : n);
    return seen;
  };
  const now = once(after);
  const pairs: [number, number][] = [];
  for (const [text, n] of once(before)) {
    const m = now.get(text);
    if (n !== null && m !== undefined && m !== null) pairs.push([n, m]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  // A line that moved past others is no guide.
  const tails: number[] = [];
  const prev: number[] = [];
  for (let i = 0; i < pairs.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]!]![1] < pairs[i]![1]) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1]! : -1;
    tails[lo] = i;
  }
  const kept: [number, number][] = [];
  for (let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) kept.unshift(pairs[i]!);
  return kept;
}

/**
 * Where an earlier round's lines are in this round: the same text followed
 * (`anchorLines`), else, changed since, shifted with the code around them
 * (`shiftLines`). Null when neither can say: such a picture is not opened by
 * its old numbers.
 */
export function earlierLinesNow(
  lines: readonly [number, number],
  before: ReadonlyMap<number, string> | undefined,
  after: ReadonlyMap<number, string> | undefined,
): [number, number] | null {
  return anchorLines(lines, before, after) ?? shiftLines(lines, before, after);
}

/** A review's new-side lines by file (`newSideLines`). */
export type ReviewLines = ReadonlyMap<string, ReadonlyMap<number, string>>;

/** A review's files as `ReviewLines`. */
export function reviewLines(files: readonly { path: string; patch: string }[]): ReviewLines {
  return new Map(files.map((file) => [file.path, newSideLines(file.patch)] as const));
}

/**
 * Where a click on a board's part lands in this review's diff: the lines; null
 * when the diff does not show them (the board's own viewer opens the code);
 * 'changed' when the part was drawn on another review and these lines can't be
 * found here (never its old numbers: they hold other code now). `earlier`: the
 * review it was drawn on, when not this one; `lines` undefined until it is read.
 */
export function partLanding(target: ShapeCodeTarget, now: ReviewLines, earlier?: { lines: ReviewLines | undefined }): [number, number] | 'changed' | null {
  const after = now.get(target.path);
  if (!after) return null;
  const asked = targetLines(target);
  const numbers = Array.from({ length: asked[1] - asked[0] + 1 }, (_, i) => asked[0] + i);
  if (!earlier) return numbers.some((n) => after.has(n)) ? asked : null;
  if (!earlier.lines) return 'changed';
  const before = earlier.lines.get(target.path);
  if (!numbers.every((n) => before?.has(n))) return null;
  return earlierLinesNow(asked, before, after) ?? 'changed';
}

/**
 * A Show me that ended with no board and no answer: nothing is running or
 * waiting on a choice, and the person did not stop it. The box goes back to its words.
 */
export function showMeEnded(turn: { answer?: string; stopped?: boolean; shape?: string } | undefined, now: { running: boolean; busy: boolean }): boolean {
  return !now.running && !now.busy && !turn?.shape && !turn?.stopped && turn?.answer === undefined;
}
