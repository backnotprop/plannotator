import { useCallback, useEffect, useState } from 'react';

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
}: {
  enabled: boolean;
  /** Identity of the current diff snapshot (e.g. the rawPatch string). A new
   * snapshot (refresh / switch) clears staleness + dismissal and resumes. */
  resetKey: string;
}): DiffFreshness {
  const [staleFingerprint, setStaleFingerprint] = useState<string | null>(null);
  const [dismissedFingerprint, setDismissedFingerprint] = useState<string | null>(null);

  // New snapshot → clean slate.
  useEffect(() => {
    setStaleFingerprint(null);
    setDismissedFingerprint(null);
  }, [resetKey]);

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
        const res = await fetch('/api/diff/fresh');
        if (!cancelled && res.ok) {
          const data = (await res.json()) as { fresh: boolean; fingerprint?: string };
          // Keep polling even while stale: a reverted edit flips back to
          // fresh, and a FURTHER change updates the fingerprint so a
          // dismissed notice can reappear.
          setStaleFingerprint(data.fresh ? null : data.fingerprint ?? 'stale');
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
  }, [enabled, resetKey]);

  const dismiss = useCallback(() => {
    setDismissedFingerprint(staleFingerprint);
  }, [staleFingerprint]);

  return {
    isStale: staleFingerprint != null && staleFingerprint !== dismissedFingerprint,
    dismiss,
  };
}
