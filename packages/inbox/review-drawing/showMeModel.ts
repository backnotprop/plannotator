/**
 * Show me in the Inbox's code review (approval "shape-in-code-review", mock
 * ac2): the pure parts. Which chapter a picture's part opens, the part's name
 * for the corner card, the words of the sheet's line, and which parts of a
 * redrawn Overview changed.
 */
import { parseShapeCodeTarget, shapeHtmlMarks, type ShapeCodeTarget } from '@plannotator/core/shape';
import { inboxReviewLines } from '@plannotator/core/inbox-review';

/** A path's last part: "retry-worker.ts". */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Whether a Show me asked on `asked` is about `place`: the whole review both, or the same file with lines that overlap. */
export function showMeAbout(
  asked: { file: string | null; lines: readonly [number, number] | null },
  place: { file: string | null; lines: readonly [number, number] | null },
): boolean {
  if (place.file === null || place.lines === null) return asked.file === null && asked.lines === null;
  return asked.file === place.file && !!asked.lines && asked.lines[0] <= place.lines[1] && place.lines[0] <= asked.lines[1];
}

/** "retry-worker.ts lines 16–18", or "the whole review" for the Overview's. */
export function showMePlace(file: string | null, lines: readonly [number, number] | null): string {
  if (!file) return 'the whole review';
  return lines ? `${baseName(file)} lines ${inboxReviewLines(lines)}` : baseName(file);
}

/**
 * Where a part's code is: the walkthrough's chapter that holds the file, or
 * null when no chapter does (it opens in All files).
 */
export function chapterOf(chapters: readonly { diffs: readonly { file: string }[] }[], path: string): number | null {
  const at = chapters.findIndex((chapter) => chapter.diffs.some((ref) => ref.file === path));
  return at < 0 ? null : at;
}

/** One key per place a part opens. */
export function codeKey(target: ShapeCodeTarget): string {
  return `${target.path}#${target.line}-${target.lineEnd ?? target.line}`;
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
 * Round 2 for Show me: a picture stays as asked, and each part that opens
 * code is anchored again on this round's diff. Its lines, as the earlier
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
 * Every part of an earlier round's picture that opens code, anchored on this
 * round: its target (by `codeKey`) → where it opens now, and the `data-mark` ids of the
 * parts whose lines changed since.
 */
export function anchorDrawing(
  html: readonly string[],
  before: ReadonlyMap<string, ReadonlyMap<number, string>>,
  after: ReadonlyMap<string, ReadonlyMap<number, string>>,
): { moved: Map<string, ShapeCodeTarget>; stale: Set<string> } {
  const moved = new Map<string, ShapeCodeTarget>();
  const stale = new Set<string>();
  if (typeof DOMParser === 'undefined') return { moved, stale };
  for (const source of html) {
    if (!source) continue;
    const doc = new DOMParser().parseFromString(`<body>${source}</body>`, 'text/html');
    for (const el of doc.querySelectorAll('[data-code]')) {
      const code = el.getAttribute('data-code') ?? '';
      const target = parseShapeCodeTarget(code);
      if (!target) continue;
      const anchor = anchorPart(target, before.get(target.path), after.get(target.path));
      moved.set(codeKey(target), anchor.now);
      const mark = el.closest('[data-mark]')?.getAttribute('data-mark');
      if (anchor.changed && mark) stale.add(mark);
    }
  }
  return { moved, stale };
}
