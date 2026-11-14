import React from 'react';
import type { CompactReviewAction } from './ReviewHeaderMenu';

const PRIMARY_IDS: ReadonlySet<CompactReviewAction['id']> = new Set(['approve', 'feedback', 'copy']);

export function compactPrimaryAction(actions: readonly CompactReviewAction[]): CompactReviewAction | undefined {
  return actions.find((action) => PRIMARY_IDS.has(action.id));
}

export const CompactPrimaryAction: React.FC<{ action: CompactReviewAction | undefined }> = ({ action }) => {
  if (!action) return null;
  return (
    <button
      type="button"
      onClick={action.onSelect}
      disabled={action.disabled}
      data-pn-touch-target=""
      data-compact-primary={action.id}
      title={action.subtitle ? `${action.label} · ${action.subtitle}` : action.label}
      className="flex-none max-w-[9rem] h-8 px-3 rounded-md bg-primary text-primary-foreground text-[13px] font-medium truncate disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
    >
      {action.label}
    </button>
  );
};
