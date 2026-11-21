import type { ReviewSummary } from '@plannotator/sem-jiff/summary';

export type SemanticFileState =
  | { status: 'working' }
  | { status: 'semantic'; summary: ReviewSummary }
  | { status: 'off'; summary: ReviewSummary };

const KINDS: Array<[keyof ReviewSummary['counts'], string]> = [
  ['moved', 'moved'],
  ['movedWithEdit', 'moved & edited'],
  ['renamed', 'renamed'],
  ['reformatted', 'reformatted'],
  ['extractedFunction', 'extracted'],
  ['inlinedFunction', 'inlined'],
  ['reordered', 'reordered'],
];

export function semanticNoteParts(summary: ReviewSummary): string[] {
  return KINDS.filter(([kind]) => (summary.counts[kind] ?? 0) > 0).map(([kind, word]) => `${summary.counts[kind]} ${word}`);
}

export function semanticNoteCount(summary: ReviewSummary): number {
  return KINDS.reduce((sum, [kind]) => sum + (summary.counts[kind] ?? 0), 0);
}
