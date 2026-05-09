import { useState, useCallback, type RefObject } from 'react';
import type { PRDiffScope } from '@plannotator/shared/pr-stack';

export interface PRSwitchResponse {
  rawPatch: string;
  gitRef: string;
  prMetadata?: unknown;
  prStackInfo?: unknown;
  prStackTree?: unknown;
  prDiffScope?: PRDiffScope;
  prDiffScopeOptions?: unknown[];
  repoInfo?: unknown;
  viewedFiles?: string[];
  error?: string;
}

export interface PRStackCallbacks {
  applyPRResponse: (data: PRSwitchResponse) => void;
  onError: (message: string) => void;
}

export function usePRStack(callbacksRef: RefObject<PRStackCallbacks | null>) {
  const [isSwitchingPRScope, setIsSwitchingPRScope] = useState(false);

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
    handleScopeSelect,
    handlePRSwitch,
  };
}
