// "Show me only the real edits": splits a file's operations into what a reviewer has to
// read and what they can skim, with counts for a header such as "1 edit, 4 skimmable".
import type { SemanticDiffOperation, SemanticDiffOperationType } from './pierre-types.ts';

/** Kinds of change that alter what the code does (or may): always shown. */
export const READ_KINDS: readonly SemanticDiffOperationType[] = ['edited', 'added', 'deleted', 'movedWithEdit'];
/** Kinds that leave the code's meaning alone: safe to collapse, never to remove from view. */
export const SKIM_KINDS: readonly SemanticDiffOperationType[] = ['moved', 'renamed', 'reordered', 'reformatted', 'extractedFunction', 'inlinedFunction'];

export interface ReviewSummary {
  /** Operations to read, in the engine's order. */
  read: SemanticDiffOperation[];
  /** Operations that can be collapsed to one row each. */
  skim: SemanticDiffOperation[];
  /** How many operations of each kind. */
  counts: Partial<Record<SemanticDiffOperationType, number>>;
  /** Changed lines (old side + new side) owned by each group. */
  lines: { read: number; skim: number };
}

const lineCount = (op: SemanticDiffOperation): number =>
  [...op.lines.old, ...op.lines.new].reduce((n, r) => n + (r.end - r.start + 1), 0);

export function reviewSummary(operations: SemanticDiffOperation[]): ReviewSummary {
  const out: ReviewSummary = { read: [], skim: [], counts: {}, lines: { read: 0, skim: 0 } };
  for (const op of operations) {
    out.counts[op.type] = (out.counts[op.type] ?? 0) + 1;
    const group = SKIM_KINDS.includes(op.type) ? 'skim' : 'read'; // an unknown kind is read, not hidden
    out[group].push(op);
    out.lines[group] += lineCount(op);
  }
  return out;
}
