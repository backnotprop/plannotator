import { useState, useCallback, type RefObject } from 'react';
import type { PRDiffScope } from '@plannotator/shared/pr-stack';
import type { SemanticDiffAdvert } from '@plannotator/shared/semantic-diff-types';

export interface PRSwitchResponse {
  rawPatch: string;
  gitRef: string;
  aiReviewContext?: string;
  prMetadata?: unknown;
  prStackInfo?: unknown;
  prStackTree?: unknown;
  prDiffScope?: PRDiffScope;
  prDiffScopeOptions?: unknown[];
  prPatchIncomplete?: boolean;
  prPatchUpgradeAvailable?: boolean;
  repoInfo?: unknown;
  viewedFiles?: string[];
  error?: string;
  semanticDiff?: SemanticDiffAdvert;
}

export interface PRStackCallbacks {
  applyPRResponse: (data: PRSwitchResponse) => void;
  onError: (message: string) => void;
}

export function usePRStack(callbacksRef: RefObject<PRStackCallbacks | null>) {
  const [isSwitchingPRScope, setIsSwitchingPRScope] = useState(false);
  const [isLoadingFullDiff, setIsLoadingFullDiff] = useState(false);

  const handleScopeSelect = useCallback(async (scope: PRDiffScope) => {
    const cb = callbacksRef.current;
    if (!cb) return;
    setIsSwitchingPRScope(true);
    try {
      const res = await fetch('/api/pr-diff-scope', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? 'Failed to switch PR diff scope');
      }
      cb.applyPRResponse(data);
    } catch (err) {
      cb.onError(err instanceof Error ? err.message : 'Failed to switch PR diff scope');
    } finally {
      setIsSwitchingPRScope(false);
    }
  }, [callbacksRef]);

  // Partial-diff upgrade: same layer re-POST as handleScopeSelect, but with
  // its own loading flag so the full-screen PRSwitchOverlay does NOT render.
  // The request can park for minutes behind the checkout warmup — the user
  // keeps reviewing the partial diff while the notice shows progress.
  const handleLoadFullDiff = useCallback(async () => {
    const cb = callbacksRef.current;
    if (!cb) return;
    setIsLoadingFullDiff(true);
    try {
      const res = await fetch('/api/pr-diff-scope', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'layer' }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? 'Failed to load the full diff');
      }
      cb.applyPRResponse(data);
    } catch (err) {
      cb.onError(err instanceof Error ? err.message : 'Failed to load the full diff');
    } finally {
      setIsLoadingFullDiff(false);
    }
  }, [callbacksRef]);

  const handlePRSwitch = useCallback(async (prUrl: string) => {
    const cb = callbacksRef.current;
    if (!cb) return;
    setIsSwitchingPRScope(true);
    try {
      const res = await fetch('/api/pr-switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: prUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? 'Failed to switch PR');
      }
      cb.applyPRResponse(data);
    } catch (err) {
      cb.onError(err instanceof Error ? err.message : 'Failed to switch PR');
    } finally {
      setIsSwitchingPRScope(false);
    }
  }, [callbacksRef]);

  return {
    isSwitchingPRScope,
    isLoadingFullDiff,
    handleScopeSelect,
    handleLoadFullDiff,
    handlePRSwitch,
  };
}
