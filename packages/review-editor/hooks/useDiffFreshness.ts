import { useCallback, useEffect, useRef, useState } from 'react';

const POLL_INTERVAL_MS = 5000;

export interface DiffFreshness {
  isStale: boolean;
  dismiss: () => void;
}

export function useDiffFreshness({
  enabled,
  resetKey,
  snapshotId,
  onAgentCwd,
  onBaseBehindRemote,
}: {
  enabled: boolean;
  resetKey: string;
  snapshotId?: string;
  onAgentCwd?: (cwd: string | null) => void;
  onBaseBehindRemote?: (behind: boolean) => void;
}): DiffFreshness {
  const [staleFingerprint, setStaleFingerprint] = useState<string | null>(null);
  const [dismissedFingerprint, setDismissedFingerprint] = useState<string | null>(null);
  const onAgentCwdRef = useRef(onAgentCwd);
  onAgentCwdRef.current = onAgentCwd;
  const onBaseBehindRemoteRef = useRef(onBaseBehindRemote);
  onBaseBehindRemoteRef.current = onBaseBehindRemote;

  useEffect(() => {
    setStaleFingerprint(null);
    setDismissedFingerprint(null);
  }, [resetKey, snapshotId]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    const tick = async () => {
      if (document.hidden) {
        schedule();
        return;
      }
      try {
        const res = await fetch(
          snapshotId
            ? `/api/diff/fresh?snapshot=${encodeURIComponent(snapshotId)}`
            : '/api/diff/fresh',
        );
        if (!cancelled && res.ok) {
          const data = (await res.json()) as {
            fresh: boolean;
            fingerprint?: string;
            agentCwd?: string | null;
            baseBehindRemote?: boolean;
          };
          setStaleFingerprint(data.fresh ? null : data.fingerprint ?? 'stale');
          if ('agentCwd' in data) onAgentCwdRef.current?.(data.agentCwd ?? null);
          onBaseBehindRemoteRef.current?.(data.baseBehindRemote === true);
        }
      } catch {
      }
      schedule();
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, resetKey, snapshotId]);

  const dismiss = useCallback(() => {
    setDismissedFingerprint(staleFingerprint);
  }, [staleFingerprint]);

  return {
    isStale: staleFingerprint != null && staleFingerprint !== dismissedFingerprint,
    dismiss,
  };
}
