import { useCallback, useEffect, useRef, useState } from 'react';

const POLL_INTERVAL_MS = 5000;

export interface DiffFreshness {
  /** True when the underlying files changed since the current diff snapshot
   * was computed AND the user hasn't dismissed this particular staleness. */
  isStale: boolean;
  /** Hide the notice for the CURRENT staleness. A further change (different
   * server fingerprint) re-shows it; a diff refresh resets everything. */
  dismiss: () => void;
}

/**
 * Polls `GET /api/diff/fresh` while the review is open. The server compares a
 * cheap VCS fingerprint captured when the diff snapshot was computed against
 * the repo's state NOW — files changing mid-review (the normal agent-editing-
 * while-you-review workflow) flips `fresh` to false.
 *
 * Polling is timer-based on purpose: in this product the files change while
 * the user is actively IN the review (an agent works underneath them), so a
 * focus/visibility trigger would miss the case that matters. Ticks are
 * skipped while the document is hidden, and the whole hook no-ops in demo
 * mode (`enabled: false`).
 */
export function useDiffFreshness({
  enabled,
  resetKey,
  snapshotId,
  onAgentCwd,
  onBaseBehindRemote,
}: {
  enabled: boolean;
  /** Identity of the current diff snapshot (e.g. the rawPatch string). A new
   * snapshot (refresh / switch) clears staleness + dismissal and resumes. */
  resetKey: string;
  /** Server snapshot id (draftKey) delivered with the diff this client is
   * rendering. Echoed on every probe so the server answers PER CLIENT: if
   * the server's snapshot has moved (startup base upgrade, another tab's
   * switch), THIS client goes stale even when the VCS fingerprint matches —
   * and a freshly-loaded tab holding the current snapshot stays fresh. */
  snapshotId?: string;
  /** Called when a probe re-advertises the PR-mode local checkout (or null when
   * none is usable yet), so the Open-in control tracks pool warmup / in-place PR
   * switches without a page reload. A probe that omits the field leaves the
   * current value untouched (non-PR sessions never send it). */
  onAgentCwd?: (cwd: string | null) => void;
  /** Called with the probe's baseBehindRemote flag (false when the field is
   * omitted) — the local origin/<default> tracking ref is behind the actual
   * remote, i.e. the baseline needs a fetch. */
  onBaseBehindRemote?: (behind: boolean) => void;
}): DiffFreshness {
  const [staleFingerprint, setStaleFingerprint] = useState<string | null>(null);
  const [dismissedFingerprint, setDismissedFingerprint] = useState<string | null>(null);
  // Latest callback in a ref so the polling effect never resubscribes for it.
  const onAgentCwdRef = useRef(onAgentCwd);
  onAgentCwdRef.current = onAgentCwd;
  const onBaseBehindRemoteRef = useRef(onBaseBehindRemote);
  onBaseBehindRemoteRef.current = onBaseBehindRemote;

  // New snapshot → clean slate. snapshotId is part of snapshot identity too:
  // a new snapshot can reuse the same patch TEXT with a different id (mode
  // switch with byte-identical patches), and stale/dismissed state from the
  // previous snapshot must not carry over to it.
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
      // Nobody is looking — don't burn VCS commands on a hidden window.
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
          // Keep polling even while stale: a reverted edit flips back to
          // fresh, and a FURTHER change updates the fingerprint so a
          // dismissed notice can reappear.
          setStaleFingerprint(data.fresh ? null : data.fingerprint ?? 'stale');
          // PR mode re-advertises the live local checkout each probe; non-PR
          // probes omit the field entirely (leave agentCwd untouched).
          if ('agentCwd' in data) onAgentCwdRef.current?.(data.agentCwd ?? null);
          // Baseline-behind flag: emitted as true or omitted (= false).
          onBaseBehindRemoteRef.current?.(data.baseBehindRemote === true);
        }
      } catch {
        // Transient/network/server-gone: ignore — staleness is best-effort.
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
