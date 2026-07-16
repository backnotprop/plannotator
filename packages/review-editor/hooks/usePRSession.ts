import { useState, useCallback } from 'react';
import type { PRMetadata } from '@plannotator/shared/pr-types';
import type { PRDiffScope, PRDiffScopeOption, PRStackInfo, PRStackTree } from '@plannotator/shared/pr-stack';

export interface PRSessionState {
  prMetadata: PRMetadata | null;
  prStackInfo: PRStackInfo | null;
  prStackTree: PRStackTree | null;
  prDiffScope: PRDiffScope;
  prDiffScopeOptions: PRDiffScopeOption[];
  /**
   * The platform withheld per-file content for this PR (too large). Always
   * reported; cleared when a server response stops reporting the flag.
   */
  prPatchIncomplete: boolean;
  /**
   * A local checkout (worktree pool) exists, so the partial-diff notice can
   * offer the "Load full diff" recompute. Without it the notice is
   * informational only.
   */
  prPatchUpgradeAvailable: boolean;
}

export interface PRSessionUpdate {
  prMetadata?: PRMetadata | null;
  prStackInfo?: PRStackInfo | null;
  prStackTree?: PRStackTree | null;
  prDiffScope?: PRDiffScope;
  prDiffScopeOptions?: PRDiffScopeOption[];
  prPatchIncomplete?: boolean;
  prPatchUpgradeAvailable?: boolean;
}

export function usePRSession() {
  const [state, setState] = useState<PRSessionState>({
    prMetadata: null,
    prStackInfo: null,
    prStackTree: null,
    prDiffScope: 'layer',
    prDiffScopeOptions: [],
    prPatchIncomplete: false,
    prPatchUpgradeAvailable: false,
  });

  const updatePRSession = useCallback((update: PRSessionUpdate) => {
    setState(prev => {
      const next = { ...prev };
      if (update.prMetadata !== undefined) next.prMetadata = update.prMetadata;
      if (update.prStackInfo !== undefined) next.prStackInfo = update.prStackInfo;
      if (update.prStackTree !== undefined) next.prStackTree = update.prStackTree;
      if (update.prDiffScope !== undefined) next.prDiffScope = update.prDiffScope;
      if (update.prDiffScopeOptions !== undefined) next.prDiffScopeOptions = update.prDiffScopeOptions;
      if (update.prPatchIncomplete !== undefined) next.prPatchIncomplete = update.prPatchIncomplete;
      if (update.prPatchUpgradeAvailable !== undefined) next.prPatchUpgradeAvailable = update.prPatchUpgradeAvailable;
      return next;
    });
  }, []);

  return { ...state, updatePRSession };
}
