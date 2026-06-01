import { useState, useCallback } from 'react';
import type { PRMetadata } from '@plannotator/shared/pr-types';
import type { PRDiffScope, PRDiffScopeOption, PRStackInfo, PRStackTree } from '@plannotator/shared/pr-stack';

export interface PRSessionState {
  prMetadata: PRMetadata | null;
  prStackInfo: PRStackInfo | null;
  prStackTree: PRStackTree | null;
  prDiffScope: PRDiffScope;
  prDiffScopeOptions: PRDiffScopeOption[];
}

export interface PRSessionUpdate {
  prMetadata?: PRMetadata | null;
  prStackInfo?: PRStackInfo | null;
  prStackTree?: PRStackTree | null;
  prDiffScope?: PRDiffScope;
  prDiffScopeOptions?: PRDiffScopeOption[];
}

export function usePRSession() {
  const [state, setState] = useState<PRSessionState>({
    prMetadata: null,
    prStackInfo: null,
    prStackTree: null,
    prDiffScope: 'layer',
    prDiffScopeOptions: [],
  });

  const updatePRSession = useCallback((update: PRSessionUpdate) => {
    setState(prev => {
      const next = { ...prev };
      if (update.prMetadata !== undefined) next.prMetadata = update.prMetadata;
      if (update.prStackInfo !== undefined) next.prStackInfo = update.prStackInfo;
      if (update.prStackTree !== undefined) next.prStackTree = update.prStackTree;
      if (update.prDiffScope !== undefined) next.prDiffScope = update.prDiffScope;
      if (update.prDiffScopeOptions !== undefined) next.prDiffScopeOptions = update.prDiffScopeOptions;
      return next;
    });
  }, []);

  return { ...state, updatePRSession };
}
