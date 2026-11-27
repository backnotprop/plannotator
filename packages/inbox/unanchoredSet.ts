/**
 * The file pane's "Unanchored" set (components/AttachmentPane.tsx), fed by several restore reports: the Viewer's text
 * highlighter, each diagram block, the image-region check. Each one reports only the comments it tried, so a report
 * updates those ids and leaves the rest alone, as plan review does (packages/editor/App.tsx, handleRestoreReport).
 * Replacing the whole set with each report let the last reporter win: a diagram's comment that could not be placed
 * lost its chip as soon as the highlighter, or another diagram, reported with nothing missing.
 */
import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

/** What one restore report says: the comments it tried, and those of them it could not place. */
export interface UnanchoredReport {
  readonly attempted: readonly string[];
  readonly unanchored: readonly string[];
}

/** The set after one report: the ids it tried leave, the ones it could not place come back. Unchanged: `prev` itself. */
export function mergeUnanchoredReport(prev: ReadonlySet<string>, report: UnanchoredReport): ReadonlySet<string> {
  if (prev.size === 0 && report.unanchored.length === 0) return prev;
  const next = new Set(prev);
  for (const id of report.attempted) next.delete(id);
  for (const id of report.unanchored) next.add(id);
  if (next.size === prev.size && [...next].every((id) => prev.has(id))) return prev;
  return next;
}

/** The set, its setter (a whole new set: a file change, the code view's own check), and one stable report callback. */
export function useUnanchoredSet(): readonly [ReadonlySet<string>, Dispatch<SetStateAction<ReadonlySet<string>>>, (report: UnanchoredReport) => void] {
  const [unanchored, setUnanchored] = useState<ReadonlySet<string>>(() => new Set());
  const report = useCallback((next: UnanchoredReport) => setUnanchored((prev) => mergeUnanchoredReport(prev, next)), []);
  return [unanchored, setUnanchored, report] as const;
}
