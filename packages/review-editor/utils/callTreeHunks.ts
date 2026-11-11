import {
  callTreeAt,
  findCallTreeRoot,
  type CallTreeDoc,
  type CallTreeFunctionRange,
  type CallTreeHunk,
  type CallTreeSourceTree,
} from '@plannotator/shared/call-tree';
import type { SemanticDiffChange } from '@plannotator/shared/semantic-diff-types';

/** One hunk of a file's patch, with the line its "Call tree" entry is drawn under. */
export interface PatchHunk extends CallTreeHunk {
  index: number;
  /** The first changed line (old side for a deletion). */
  firstChange: { side: 'new' | 'old'; line: number };
  /** Drawn under this line: the last context line before the first change, else the first change itself. */
  anchor: { side: 'new' | 'old'; line: number };
}

/** The hunks of one file's unified patch. */
export function listPatchHunks(file: { path: string; oldPath?: string; patch: string }): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let lastContextNew: number | null = null;
  let seenChange = false;
  for (const line of file.patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      const oldStart = Number(header[1]);
      const oldCount = Number(header[2] ?? '1');
      const newStart = Number(header[3]);
      const newCount = Number(header[4] ?? '1');
      current = {
        index: hunks.length,
        file: file.path,
        ...(file.oldPath && file.oldPath !== file.path ? { oldFile: file.oldPath } : {}),
        newStart,
        newEnd: newStart + Math.max(newCount, 1) - 1,
        oldStart,
        oldEnd: oldStart + Math.max(oldCount, 1) - 1,
        firstChange: { side: 'new', line: newStart },
        anchor: { side: 'new', line: newStart },
      };
      hunks.push(current);
      oldLine = oldStart;
      newLine = newStart;
      lastContextNew = null;
      seenChange = false;
      continue;
    }
    if (!current) continue;
    const marker = line[0];
    if (marker === ' ') {
      if (!seenChange) lastContextNew = newLine;
      oldLine += 1;
      newLine += 1;
    } else if (marker === '+' || marker === '-') {
      if (!seenChange) {
        seenChange = true;
        current.firstChange = marker === '+' ? { side: 'new', line: newLine } : { side: 'old', line: oldLine };
        current.anchor = lastContextNew !== null ? { side: 'new', line: lastContextNew } : { ...current.firstChange };
      }
      if (marker === '+') newLine += 1;
      else oldLine += 1;
    }
  }
  return hunks;
}

/**
 * The innermost changed entity from `sem` around a hunk's first change, as a
 * line range on both sides. Undefined without sem data or when none covers it.
 */
export function functionAroundHunk(
  changes: readonly SemanticDiffChange[],
  hunk: PatchHunk,
): CallTreeFunctionRange | undefined {
  let best: { change: SemanticDiffChange; size: number } | null = null;
  for (const change of changes) {
    const fileMatches = change.filePath === hunk.file
      || (hunk.oldFile !== undefined && (change.oldFilePath === hunk.oldFile || change.filePath === hunk.oldFile));
    if (!fileMatches) continue;
    const { side, line } = hunk.firstChange;
    const start = side === 'new' ? change.startLine : change.oldStartLine;
    const end = side === 'new' ? change.endLine : change.oldEndLine;
    if (start == null || end == null || line < start || line > end) continue;
    const size = end - start;
    if (!best || size < best.size) best = { change, size };
  }
  if (!best) return undefined;
  const { change } = best;
  return {
    name: change.entityName,
    ...(change.startLine != null && change.endLine != null ? { newStart: change.startLine, newEnd: change.endLine } : {}),
    ...(change.oldStartLine != null && change.oldEndLine != null ? { oldStart: change.oldStartLine, oldEnd: change.oldEndLine } : {}),
  };
}

export interface CallTreeHunkTarget {
  readonly filePath: string;
  readonly hunk: PatchHunk;
  readonly doc: CallTreeDoc;
}

/** Every hunk the analysis can draw a Call tree for, with that tree. Hunks it cannot are left out. */
export function callTreeHunkTargets(
  files: ReadonlyArray<{ path: string; oldPath?: string; patch: string }>,
  trees: readonly CallTreeSourceTree[],
  semChanges: readonly SemanticDiffChange[],
  range: { from?: string; to?: string } = {},
): CallTreeHunkTarget[] {
  if (trees.length === 0) return [];
  const targets: CallTreeHunkTarget[] = [];
  for (const file of files) {
    for (const hunk of listPatchHunks(file)) {
      const fn = functionAroundHunk(semChanges, hunk);
      const location = findCallTreeRoot(trees, hunk, fn);
      if (!location) continue;
      targets.push({ filePath: file.path, hunk, doc: callTreeAt(trees, location, { ...range, ...(fn ? { title: fn.name } : {}) }) });
    }
  }
  return targets;
}
