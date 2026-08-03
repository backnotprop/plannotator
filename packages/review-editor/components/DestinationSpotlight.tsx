import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { altKey } from '@plannotator/ui/utils/platform';

interface DestinationSpotlightProps {
  /** The destination-switcher button to highlight. */
  targetRef: React.RefObject<HTMLElement | null>;
  /** "GitHub" | "GitLab" — platform-aware label for the copy. */
  platformLabel: string;
  /** "PR" | "MR" — platform-aware merge-request label. */
  mrLabel: string;
  onDismiss: () => void;
}

const PAD = 6;

/**
 * First-time coachmark for the PR feedback-destination switcher. A driver.js
 * style spotlight built with zero dependencies: a rounded cutout positioned
 * over the target whose oversized box-shadow dims the rest of the screen,
 * plus an anchored card explaining the Agent / platform toggle. Clicking
 * anywhere (or "Got it") dismisses; the caller persists the seen-flag.
 */
export function DestinationSpotlight({ targetRef, platformLabel, mrLabel, onDismiss }: DestinationSpotlightProps) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  // Measure the target after layout; re-measure on resize AND on a short
  // interval — header siblings (error banners, partial-diff notices) mount
  // async and shift the button horizontally without any window resize, and
  // ResizeObserver can't see position-only changes. The overlay is transient
  // (one-time coachmark), so a 250ms poll is bounded and cheap; setRect with
  // an unchanged DOMRect still re-renders, but only while the overlay is up.
  useLayoutEffect(() => {
    const measure = () => {
      const el = targetRef.current;
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    window.addEventListener('resize', measure);
    const interval = window.setInterval(measure, 250);
    return () => {
      window.removeEventListener('resize', measure);
      window.clearInterval(interval);
    };
  }, [targetRef]);

  // Escape dismisses like every other one-time dialog (capture + stop, so the
  // topmost overlay is the only thing one Escape closes). Any OTHER
  // non-modifier keypress means the user has moved on to real work (search,
  // shortcuts, typing) — dismiss too, but let the event proceed so the
  // shortcut still fires and its surface never opens under the dim.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onDismiss();
        return;
      }
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
      onDismiss();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onDismiss]);

  if (!rect || typeof document === 'undefined') return null;

  const kbd = (label: string) => (
    <kbd className="inline-flex items-center justify-center min-w-[18px] h-[16px] px-1 rounded bg-muted border border-border/60 border-b-[2px] text-[9px] font-mono leading-none text-foreground/70 shadow-sm">
      {label}
    </kbd>
  );

  return createPortal(
    <div data-print-hide className="fixed inset-0 z-[90]" onClick={onDismiss} role="presentation">
      {/* Cutout: the oversized shadow dims everything except the target. */}
      <div
        className="absolute rounded-lg ring-2 ring-primary pointer-events-none"
        style={{
          left: rect.left - PAD,
          top: rect.top - PAD,
          width: rect.width + PAD * 2,
          height: rect.height + PAD * 2,
          boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.55)',
        }}
      />
      {/* Card, hung below the target and right-aligned with it (the switcher
          lives in the header's top-right cluster). */}
      <div
        className="absolute w-[320px] max-w-[calc(100vw-24px)] rounded-lg border border-border bg-popover p-4 shadow-xl"
        style={{
          top: rect.bottom + PAD + 12,
          right: Math.max(12, window.innerWidth - rect.right - PAD),
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-foreground">Where should your review go?</div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          You're reviewing {/^[AEIOUM]/.test(mrLabel) ? 'an' : 'a'} {mrLabel}, so your feedback
          can go two ways: post review comments straight to {platformLabel}, or send them to your
          agent session. Use this switcher to change the destination at any point — per review,
          no setup.
        </p>
        <p className="mt-2 text-[11px] text-muted-foreground/70">
          Tip: double-tap {kbd(altKey)} {kbd(altKey)} to switch quickly.
        </p>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onDismiss}
            className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
          >
            Got it
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
