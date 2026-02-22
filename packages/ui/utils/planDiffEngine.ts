/**
 * Plan Diff Engine
 *
 * Computes line-level diffs between two plan versions.
 * Wraps the `diff` library's diffLines() and groups adjacent
 * add/remove changes into "modified" blocks for cleaner rendering.
 */

import { diffLines, type Change } from "diff";

export interface PlanDiffBlock {
  /** What kind of change this block represents */
  type: "added" | "removed" | "modified" | "unchanged";
  /** The content for this block (new content for added/modified, old content for removed, full content for unchanged) */
  content: string;
  /** For 'modified' blocks: the old content that was replaced */
  oldContent?: string;
  /** Number of lines in this block */
  lines: number;
}

export interface PlanDiffStats {
  additions: number;
  deletions: number;
  modifications: number;
}

/**
 * Count lines in a string (handles trailing newline correctly).
 */
function countLines(text: string): number {
  const lines = text.split("\n");
  // diffLines often includes a trailing empty string from the final newline
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    return lines.length - 1;
  }
  return lines.length;
}

/**
 * Compute the diff between two plan versions.
 *
 * Groups consecutive remove+add changes into "modified" blocks for
 * better rendering (showing what was replaced rather than separate
 * remove and add blocks).
 */
export function computePlanDiff(
  oldText: string,
  newText: string
): { blocks: PlanDiffBlock[]; stats: PlanDiffStats } {
  const changes: Change[] = diffLines(oldText, newText);

  const blocks: PlanDiffBlock[] = [];
  const stats: PlanDiffStats = { additions: 0, deletions: 0, modifications: 0 };

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    const next = changes[i + 1];

    if (change.removed && next?.added) {
      // Adjacent remove + add = modification
      blocks.push({
        type: "modified",
        content: next.value,
        oldContent: change.value,
        lines: countLines(next.value),
      });
      stats.modifications++;
      stats.additions += countLines(next.value);
      stats.deletions += countLines(change.value);
      i++; // skip the next (add) since we consumed it
    } else if (change.added) {
      blocks.push({
        type: "added",
        content: change.value,
        lines: countLines(change.value),
      });
      stats.additions += countLines(change.value);
    } else if (change.removed) {
      blocks.push({
        type: "removed",
        content: change.value,
        lines: countLines(change.value),
      });
      stats.deletions += countLines(change.value);
    } else {
      blocks.push({
        type: "unchanged",
        content: change.value,
        lines: countLines(change.value),
      });
    }
  }

  return { blocks, stats };
}
