import React from 'react';
import type { ReviewSummary } from '@plannotator/sem-diff/summary';

export type SemanticFileState =
  | { status: 'working' }
  | { status: 'semantic'; summary: ReviewSummary }
  | { status: 'off'; summary: ReviewSummary };

const KIND_LABEL: Record<string, string> = {
  moved: 'moved',
  movedWithEdit: 'moved and edited',
  renamed: 'renamed',
  reordered: 'reordered',
  reformatted: 'reformatted',
  extractedFunction: 'extracted',
  inlinedFunction: 'inlined',
};

export function semanticNoteTitle(summary: ReviewSummary): string {
  const parts = Object.entries(summary.counts)
    .filter(([kind]) => kind in KIND_LABEL)
    .map(([kind, n]) => `${n} ${KIND_LABEL[kind]}`);
  return parts.join(', ');
}

export const SemanticFileNote: React.FC<{ state: SemanticFileState; onToggle: () => void }> = ({ state, onToggle }) => {
  if (state.status === 'working') {
    return (
      <span data-semantic-note="working" className="text-[11px] text-muted-foreground/60 px-1 select-none" title="Looking for moved and renamed code">
        reading…
      </span>
    );
  }
  const skim = state.summary.skim.length + (state.summary.counts.movedWithEdit ?? 0);
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
      title={on ? `${semanticNoteTitle(state.summary)}. Click to show the plain diff.` : `Plain diff. Click to show ${semanticNoteTitle(state.summary)}.`}
    >
      {skim} to skim
    </button>
  );
};
