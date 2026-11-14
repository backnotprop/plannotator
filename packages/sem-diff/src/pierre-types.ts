// Semantic diff types consumed by @pierre/diffs.
// Copied from pierrecomputer/pierre, branch amadeus/semantic-diffs, packages/diffs/src/types.ts
// (last matched at c78e4271, 2026-11-11). Licensed Apache-2.0 by The Pierre Computer Company.
// Kept verbatim in shape so our output type-checks against Pierre's renderer.
// `npm run pierre-drift` fetches the branch and fails if this copy no longer matches it.

export interface SemanticDiffTextPosition {
  /** Source line number, starting at 1. */
  line: number;
  /** Zero-based UTF-16 code-unit offset within the line; a tab counts as one. */
  character: number;
}

export interface SemanticDiffTextRange {
  start: SemanticDiffTextPosition;
  /** Exclusive end position. */
  end: SemanticDiffTextPosition;
}

export type SemanticDiffOperationType =
  | 'moved'
  | 'movedWithEdit'
  | 'edited'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'reordered'
  | 'reformatted'
  | 'extractedFunction'
  | 'inlinedFunction';

export type SemanticDiffSpanRole = 'root' | 'container' | 'body' | 'call' | 'focus';
export type SemanticDiffFocusKind = 'reformatted';

export interface SemanticDiffLineRegion {
  start: number;
  end: number;
}

export interface SemanticDiffFoldCounts {
  moved: number;
  edited: number;
  removed: number;
}

export interface SemanticDiffFold {
  old: SemanticDiffLineRegion;
  operations: number[];
  counts: SemanticDiffFoldCounts;
}

export interface SemanticDiffLinePair {
  old: SemanticDiffLineRegion;
  new: SemanticDiffLineRegion;
}

export interface SemanticDiffSpanAnchor {
  relation: 'before' | 'after' | 'inside';
  old?: SemanticDiffTextRange[];
  new?: SemanticDiffTextRange[];
  lineAnchor?: number;
}

export type SemanticDiffConnectorAttachment =
  | { line: number; edge: 'before' | 'after' }
  | { empty: true };

interface BaseSemanticDiffPairedSpan {
  relation: 'mapped' | 'moved' | 'replaced';
  old: SemanticDiffTextRange[];
  new: SemanticDiffTextRange[];
  linePairs: SemanticDiffLinePair[];
}

interface BaseSemanticDiffIntroducedSpan {
  relation: 'introduced';
  old?: never;
  new: SemanticDiffTextRange[];
  anchors?: SemanticDiffSpanAnchor[];
}

interface BaseSemanticDiffRemovedSpan {
  relation: 'removed';
  old: SemanticDiffTextRange[];
  new?: never;
  anchors?: SemanticDiffSpanAnchor[];
}

export interface SemanticDiffPairedStructuralSpan extends BaseSemanticDiffPairedSpan {
  role: Exclude<SemanticDiffSpanRole, 'focus'>;
  kind?: never;
}

export interface SemanticDiffPairedFocusSpan extends BaseSemanticDiffPairedSpan {
  role: 'focus';
  kind?: SemanticDiffFocusKind;
}

export interface SemanticDiffIntroducedStructuralSpan extends BaseSemanticDiffIntroducedSpan {
  role: Exclude<SemanticDiffSpanRole, 'focus'>;
  kind?: never;
}

export interface SemanticDiffIntroducedFocusSpan extends BaseSemanticDiffIntroducedSpan {
  role: 'focus';
  kind?: SemanticDiffFocusKind;
}

export interface SemanticDiffRemovedStructuralSpan extends BaseSemanticDiffRemovedSpan {
  role: Exclude<SemanticDiffSpanRole, 'focus'>;
  kind?: never;
}

export interface SemanticDiffRemovedFocusSpan extends BaseSemanticDiffRemovedSpan {
  role: 'focus';
  kind?: SemanticDiffFocusKind;
}

export type SemanticDiffSpan =
  | SemanticDiffPairedStructuralSpan
  | SemanticDiffPairedFocusSpan
  | SemanticDiffIntroducedStructuralSpan
  | SemanticDiffIntroducedFocusSpan
  | SemanticDiffRemovedStructuralSpan
  | SemanticDiffRemovedFocusSpan;

export interface SemanticDiffLineRange extends SemanticDiffLineRegion {
  spanIndex: number;
  anchorIndex?: number;
  attachment?: SemanticDiffConnectorAttachment;
}

export interface SemanticDiffOperation {
  type: SemanticDiffOperationType;
  lines: { old: SemanticDiffLineRange[]; new: SemanticDiffLineRange[] };
  spans: SemanticDiffSpan[];
}
