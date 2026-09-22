/**
 * Anchors for PR review comments (#1590).
 *
 * A PR draft can be restored after the PR changed, and a PR session can move
 * between diffs in place. Line numbers alone can't tell whether a comment
 * still points at the code it was written on, so each line comment records:
 *  - `anchorText`: the text of its anchored diff lines,
 *  - `anchorContext`: up to two lines before and after on the same side, so a
 *    common line (`}`, `return null;`) is not "still valid" by coincidence,
 *  - `anchorSnapshot`: the review snapshot whose coordinates it uses.
 * Against a different diff, the comment keeps its position only when all of
 * the anchor text and context still read the same at the SAME side and line
 * numbers; otherwise it is marked `outdated`. Nothing is ever dropped and
 * nothing is ever moved to a guessed line. A false "outdated" is the safe
 * side.
 *
 * Pure; reads only the per-file patch text.
 */

import type { DiffFile } from '../types';
import type { CodeAnnotation } from '@plannotator/ui/types';

/** Upper bound on recorded anchor text; larger selections record nothing. */
export const MAX_ANCHOR_TEXT_CHARS = 20_000;
/** Lines of surrounding context recorded on each side of the anchor. */
export const ANCHOR_CONTEXT_LINES = 2;

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

/** Every line of one side of a single file's patch, keyed by line number,
 *  plus the function-context text of the hunk header each line sits under
 *  (`@@ ... @@ function f() {` → `function f() {`). */
function patchSideLines(filePatch: string, side: 'old' | 'new'): Map<number, string> & { hunkContext: Map<number, string> } {
  const lines = new Map<number, string>() as Map<number, string> & { hunkContext: Map<number, string> };
  lines.hunkContext = new Map<number, string>();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let context = '';
  const put = (n: number, body: string) => {
    lines.set(n, body);
    lines.hunkContext.set(n, context);
  };
  for (const raw of filePatch.split('\n')) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      context = header[3] ?? '';
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const marker = raw[0];
    const body = raw.slice(1);
    if (marker === ' ') {
      put(side === 'old' ? oldLine : newLine, body);
      oldLine += 1;
      newLine += 1;
    } else if (marker === '-') {
      if (side === 'old') put(oldLine, body);
      oldLine += 1;
    } else if (marker === '+') {
      if (side === 'new') put(newLine, body);
      newLine += 1;
    } else if (marker === '\\') {
      // "\ No newline at end of file" — not a line.
    } else {
      // Next file header or trailing blank: the hunk ended.
      inHunk = false;
    }
  }
  return lines;
}

function validRange(start: number, end: number): boolean {
  return Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start;
}

/**
 * The text of lines `start..end` on one side of a single file's patch, joined
 * with "\n", or null when any of those lines is not present in the patch hunks
 * (e.g. a line only visible through context expansion).
 */
export function readPatchLines(
  filePatch: string,
  side: 'old' | 'new',
  start: number,
  end: number,
): string | null {
  if (!validRange(start, end)) return null;
  const all = patchSideLines(filePatch, side);
  const lines: string[] = [];
  for (let n = start; n <= end; n += 1) {
    const line = all.get(n);
    if (line === undefined) return null;
    lines.push(line);
  }
  return lines.join('\n');
}

interface AnchorReading {
  text: string;
  context: { before: (string | null)[]; after: (string | null)[]; hunk?: string };
}

function readAnchor(file: DiffFile, annotation: CodeAnnotation): AnchorReading | null {
  const { side, lineStart: start, lineEnd: end } = annotation;
  if (!validRange(start, end)) return null;
  const all = patchSideLines(file.patch, side);
  const lines: string[] = [];
  for (let n = start; n <= end; n += 1) {
    const line = all.get(n);
    if (line === undefined) return null;
    lines.push(line);
  }
  const before: (string | null)[] = [];
  for (let n = start - ANCHOR_CONTEXT_LINES; n < start; n += 1) before.push(n >= 1 ? all.get(n) ?? null : null);
  const after: (string | null)[] = [];
  for (let n = end + 1; n <= end + ANCHOR_CONTEXT_LINES; n += 1) after.push(all.get(n) ?? null);
  const hunk = all.hunkContext.get(start);
  return { text: lines.join('\n'), context: { before, after, ...(hunk ? { hunk } : {}) } };
}

function sameContext(a: AnchorReading['context'], b: CodeAnnotation['anchorContext']): boolean {
  if (!b || !Array.isArray(b.before) || !Array.isArray(b.after)) return false;
  const eq = (x: (string | null)[], y: (string | null)[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  // The hunk's function-context header (when git printed one) must match
  // too: it separates repeated blocks (`}` / `return null;` in two
  // functions). A missing header on either side only matches a missing one,
  // so the comparison can make a comment outdated, never "valid".
  return eq(a.before, b.before) && eq(a.after, b.after) && (a.hunk ?? '') === (b.hunk ?? '');
}

function isLineScoped(annotation: CodeAnnotation): boolean {
  return (annotation.scope ?? 'line') === 'line';
}

/**
 * The anchor fields to record on a new line comment, or an empty object when
 * they cannot be read from the current patch (file-/review-scoped comments,
 * lines outside the hunks, oversized selections).
 */
export function captureAnchor(
  annotation: CodeAnnotation,
  files: readonly DiffFile[],
): Pick<CodeAnnotation, 'anchorText' | 'anchorContext'> {
  if (!isLineScoped(annotation)) return {};
  const file = files.find((f) => f.path === annotation.filePath);
  if (!file) return {};
  const reading = readAnchor(file, annotation);
  if (!reading || reading.text.length > MAX_ANCHOR_TEXT_CHARS) return {};
  return { anchorText: reading.text, anchorContext: reading.context };
}

/** Back-compat helper: just the anchor text. */
export function captureAnchorText(annotation: CodeAnnotation, files: readonly DiffFile[]): string | undefined {
  return captureAnchor(annotation, files).anchorText;
}

/** True when the recorded anchor text AND context still read the same. */
export function anchorStillMatches(annotation: CodeAnnotation, files: readonly DiffFile[]): boolean {
  if (annotation.anchorText === undefined) return false;
  const file = files.find((f) => f.path === annotation.filePath);
  if (!file) return false;
  const reading = readAnchor(file, annotation);
  return reading !== null && reading.text === annotation.anchorText && sameContext(reading.context, annotation.anchorContext);
}

export interface ReanchorOptions {
  /** Snapshot id of the diff `files` belong to. */
  currentSnapshot?: string;
  /** Comments this rejects (bound to another PR or diff scope) are left alone:
   *  they were never anchored to the diff being checked. */
  belongsToCurrentDiff?: (annotation: CodeAnnotation) => boolean;
  /** The comments come from a draft the server served for a DIFFERENT patch
   *  than it was saved on: comments without a snapshot stamp (older drafts)
   *  must be verified too, instead of being trusted as-is. */
  patchChanged?: boolean;
}

/**
 * Re-check line comments against the diff now on screen. For each line
 * comment that belongs to it and is not already outdated:
 *  - stamped with the current snapshot → unchanged;
 *  - unstamped, and the patch is not known to have changed → unchanged
 *    (older drafts on an unchanged patch restore exactly as before);
 *  - otherwise the anchor text and context must still match at the same
 *    side/lines: then it is re-stamped with the current snapshot, else it
 *    gets `outdated: true` and keeps its old line numbers.
 * File- and review-scoped comments always pass through.
 */
export function reanchorCodeAnnotations(
  annotations: readonly CodeAnnotation[],
  files: readonly DiffFile[],
  options: ReanchorOptions = {},
): CodeAnnotation[] {
  const { currentSnapshot, belongsToCurrentDiff = () => true, patchChanged = false } = options;
  let changed = false;
  const next = annotations.map((annotation) => {
    if (!isLineScoped(annotation) || annotation.outdated || !belongsToCurrentDiff(annotation)) return annotation;
    if (annotation.anchorSnapshot !== undefined && annotation.anchorSnapshot === currentSnapshot) return annotation;
    if (annotation.anchorSnapshot === undefined && !patchChanged) return annotation;
    changed = true;
    if (anchorStillMatches(annotation, files)) {
      return currentSnapshot === undefined ? annotation : { ...annotation, anchorSnapshot: currentSnapshot };
    }
    return { ...annotation, outdated: true };
  });
  return changed ? next : (annotations as CodeAnnotation[]);
}

/**
 * Restore-time wrapper kept for callers and tests: every in-scope line
 * comment is verified (the draft's patch changed).
 */
export function markOutdatedCodeAnnotations(
  annotations: readonly CodeAnnotation[],
  files: readonly DiffFile[],
  belongsToCurrentDiff: (annotation: CodeAnnotation) => boolean = () => true,
  currentSnapshot?: string,
): CodeAnnotation[] {
  return reanchorCodeAnnotations(annotations, files, { currentSnapshot, belongsToCurrentDiff, patchChanged: true });
}

/**
 * Viewed marks to restore from a draft. When the draft was saved on a
 * different patch (a push landed since), the draft cannot tell which files the
 * push touched, so a mark on any file still in the diff is dropped rather than
 * claiming the reviewer saw code they have not.
 */
export function restorableViewedFiles(
  viewedFiles: readonly string[],
  patchChanged: boolean,
  files: readonly DiffFile[],
): string[] {
  if (!patchChanged) return [...viewedFiles];
  const inDiff = new Set(files.map((f) => f.path));
  return viewedFiles.filter((path) => !inDiff.has(path));
}

/**
 * Whether a line comment may be posted INLINE on a PR. Not when it is
 * outdated, and not when the session knows a DIFFERENT snapshot for its PR
 * than the one it was stamped on (its coordinates belong to a diff that has
 * since been replaced). Absence of evidence is not evidence of a change: an
 * unstamped comment (older draft), or one for a PR whose snapshot this page
 * has not seen (after a reload only the PR on screen is known), is trusted
 * and posted inline, as before #1590.
 */
export function canPostInline(
  annotation: CodeAnnotation,
  knownSnapshots: ReadonlyMap<string, string> | undefined,
  currentPrUrl: string | undefined,
): boolean {
  if (annotation.outdated) return false;
  if (!knownSnapshots || annotation.anchorSnapshot === undefined) return true;
  const prUrl = annotation.prUrl ?? currentPrUrl;
  const known = prUrl === undefined ? undefined : knownSnapshots.get(prUrl);
  return known === undefined || known === annotation.anchorSnapshot;
}

/**
 * What a sidebar click on a comment should do. Call-Flow-native feedback
 * returns to the analysis surface; an outdated comment is not drawn on the
 * diff (#1590), so it opens its file and is selected without a scroll request
 * that could never resolve; everything else scrolls to its inline card.
 */
export function annotationNavigation(annotation: CodeAnnotation): 'call-flow' | 'select-file' | 'scroll' {
  if (annotation.callFlowTargets?.length && (annotation.scope ?? 'line') !== 'line') return 'call-flow';
  if (annotation.outdated) return 'select-file';
  return 'scroll';
}
