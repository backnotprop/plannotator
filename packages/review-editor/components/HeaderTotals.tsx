import React from 'react';
import { formatCount, plural } from '@plannotator/ui/utils/countFormat';

export const HeaderTotals: React.FC<{ files: ReadonlyArray<{ additions: number; deletions: number }> }> = ({ files }) => {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  if (additions === 0 && deletions === 0) return null;
  return (
    <span
      className="flex-shrink-0 flex items-center gap-1.5 text-[12px] tabular-nums"
      data-header-totals=""
      title={`${plural(files.length, 'file')}: ${plural(additions, 'line')} added, ${formatCount(deletions)} removed`}
    >
      {additions > 0 && <span className="text-success">+{formatCount(additions)}</span>}
      {deletions > 0 && <span className="text-destructive">−{formatCount(deletions)}</span>}
    </span>
  );
};
