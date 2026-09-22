/**
 * Anchor text for PR review comments (#1590).
 *
 * A PR draft can be restored after the PR changed. Line numbers alone can't
 * tell whether a comment still points at the code it was written on, so each
 * line comment records the text of its anchored diff lines at creation, and a
 * restore against a different patch re-checks that text at the SAME side and
 * line numbers. Match → unchanged; anything else → `outdated`. Nothing is ever
 * dropped and nothing is ever moved to a guessed line.
 *
 * Pure; reads only the per-file patch text.
 */

import type { DiffFile } from '../types';
import type { CodeAnnotation } from '@plannotator/ui/types';

/** Upper bound on recorded anchor text; larger selections record nothing. */
export const MAX_ANCHOR_TEXT_CHARS = 20_000;

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

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
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null;
  const wanted = new Map<number, string>();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of filePatch.split('\n')) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const marker = raw[0];
    const body = raw.slice(1);
    if (marker === ' ') {
      const n = side === 'old' ? oldLine : newLine;
      if (n >= start && n <= end) wanted.set(n, body);
      oldLine += 1;
      newLine += 1;
    } else if (marker === '-') {
      if (side === 'old' && oldLine >= start && oldLine <= end) wanted.set(oldLine, body);
      oldLine += 1;
    } else if (marker === '+') {
      if (side === 'new' && newLine >= start && newLine <= end) wanted.set(newLine, body);
      newLine += 1;
    } else if (marker === '\\') {
      // "\ No newline at end of file" — not a line.
    } else {
      // Next file header or trailing blank: the hunk ended.
      inHunk = false;
    }
  }
  const lines: string[] = [];
  for (let n = start; n <= end; n += 1) {
    const line = wanted.get(n);
    if (line === undefined) return null;
    lines.push(line);
  }
  return lines.join('\n');
}

function isLineScoped(annotation: CodeAnnotation): boolean {
  return (annotation.scope ?? 'line') === 'line';
}

/**
 * The anchor text to record for a new line comment, or undefined when it
 * cannot be read from the current patch (file-/review-scoped comments, lines
 * outside the hunks, oversized selections).
 */
export function captureAnchorText(
  annotation: CodeAnnotation,
  files: readonly DiffFile[],
): string | undefined {
  if (!isLineScoped(annotation)) return undefined;
  const file = files.find((f) => f.path === annotation.filePath);
  if (!file) return undefined;
  const text = readPatchLines(file.patch, annotation.side, annotation.lineStart, annotation.lineEnd);
  if (text === null || text.length > MAX_ANCHOR_TEXT_CHARS) return undefined;
  return text;
}

/**
 * Re-check restored line comments against a patch that differs from the one
 * the draft was saved on. A comment whose file is still in the diff and whose
 * recorded anchor text still reads the same at its side/lines is returned
 * unchanged; every other line comment — including one with no recorded
 * anchor text, since nothing can vouch that its lines still hold the same
 * code — comes back with `outdated: true`. File- and review-scoped comments
 * (and comments already outdated) pass through untouched, as do comments
 * `belongsToCurrentDiff` rejects: a draft can carry comments bound to another
 * PR or diff scope (an earlier in-place switch), and those were never
 * anchored to the diff being checked.
 */
export function markOutdatedCodeAnnotations(
  annotations: readonly CodeAnnotation[],
  files: readonly DiffFile[],
  belongsToCurrentDiff: (annotation: CodeAnnotation) => boolean = () => true,
): CodeAnnotation[] {
  return annotations.map((annotation) => {
    if (!isLineScoped(annotation) || annotation.outdated || !belongsToCurrentDiff(annotation)) return annotation;
    const file = files.find((f) => f.path === annotation.filePath);
    const current = file
      ? readPatchLines(file.patch, annotation.side, annotation.lineStart, annotation.lineEnd)
      : null;
    const stillAnchored =
      annotation.anchorText !== undefined && current !== null && current === annotation.anchorText;
    return stillAnchored ? annotation : { ...annotation, outdated: true };
  });
}
