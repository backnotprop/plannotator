import React from 'react';
import { RepoIcon } from '@plannotator/ui/components/RepoIcon';
import { HeaderTotals } from './HeaderTotals';

const BRANCH_TAIL = 8;

export function headerBranchTooltip(branch: string | undefined, repo: string, files: ReadonlyArray<{ additions: number; deletions: number }>): string {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return [branch, repo, additions || deletions ? `+${additions} −${deletions}` : ''].filter(Boolean).join(' · ');
}

export const HeaderBranch: React.FC<{
  branch?: string;
  repo: string;
  repoTitle: string;
  files: ReadonlyArray<{ additions: number; deletions: number }>;
  compact: boolean;
}> = ({ branch, repo, repoTitle, files, compact }) => (
  <div
    className={compact ? 'min-w-0 flex items-center justify-center gap-2 overflow-hidden px-1' : 'min-w-0 flex shrink items-center gap-2 lg:gap-3 overflow-hidden'}
    title={headerBranchTooltip(branch, repoTitle, files)}
    data-header-branch=""
  >
    {branch && (
      <span className="min-w-0 flex text-xs font-mono text-foreground" data-header-branch-name="">
        <span className="truncate">{branch.length > BRANCH_TAIL * 2 ? branch.slice(0, -BRANCH_TAIL) : branch}</span>
        {branch.length > BRANCH_TAIL * 2 && <span className="flex-none">{branch.slice(-BRANCH_TAIL)}</span>}
      </span>
    )}
    <span className="text-xs text-muted-foreground inline-flex items-center gap-1 truncate max-w-[220px] flex-none" data-header-shed="">
      <RepoIcon className="w-3 h-3 flex-shrink-0" />
      {repo}
    </span>
    {!compact && <span className="flex-none" data-header-shed=""><HeaderTotals files={files} /></span>}
  </div>
);
