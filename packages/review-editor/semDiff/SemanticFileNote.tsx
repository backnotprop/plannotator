import React from 'react';
import type { ReviewSummary } from '@plannotator/sem-diff/summary';

export type SemanticFileState =
  | { status: 'working' }
  | { status: 'semantic'; summary: ReviewSummary }
  | { status: 'off'; summary: ReviewSummary };

const KINDS: Array<[string, string]> = [
  ['moved', 'moved'],
  ['movedWithEdit', 'moved & edited'],
  ['renamed', 'renamed'],
  ['reformatted', 'reformatted'],
  ['extractedFunction', 'extracted'],
  ['inlinedFunction', 'inlined'],
  ['reordered', 'reordered'],
];

export function semanticNoteParts(summary: ReviewSummary): string[] {
  return KINDS.filter(([kind]) => (summary.counts[kind as keyof typeof summary.counts] ?? 0) > 0).map(
    ([kind, word]) => `${summary.counts[kind as keyof typeof summary.counts]} ${word}`,
  );
}

export function semanticNoteLabel(summary: ReviewSummary): string {
  const parts = semanticNoteParts(summary);
  return parts.length > 2 ? `${parts.slice(0, 2).join(' · ')} · +${parts.length - 2}` : parts.join(' · ');
}

export const SemanticFileNote: React.FC<{ state: SemanticFileState; onToggle: () => void }> = ({ state, onToggle }) => {
  if (state.status === 'working') {
    return (
      <span data-semantic-note="working" className="text-[11px] text-muted-foreground/60 px-1 select-none" title="Looking for moved and renamed code">
        reading…
      </span>
    );
  }
  const all = semanticNoteParts(state.summary).join(', ');
  const on = state.status === 'semantic';
  return (
    <button
      type="button"
      data-semantic-note={state.status}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={`text-[11px] px-1.5 py-0.5 rounded transition-colors hover:bg-muted ${on ? 'text-muted-foreground' : 'text-muted-foreground/50 line-through'}`}
      title={on ? `${all}. Click to show the plain diff.` : `Plain diff. Click to show ${all}.`}
    >
      {semanticNoteLabel(state.summary)}
    </button>
  );
};
