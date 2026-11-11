import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { altKey } from '@plannotator/ui/utils/platform';

interface DestinationSpotlightProps {
  targetRef: React.RefObject<HTMLElement | null>;
  platformLabel: string;
  mrLabel: string;
  compactTouchLayout?: boolean;
  onDismiss: () => void;
}

const PAD = 6;

export function DestinationSpotlight({
  targetRef,
  platformLabel,
  mrLabel,
  compactTouchLayout = false,
  onDismiss,
}: DestinationSpotlightProps) {
  const [rect, setRect] = useState<DOMRect | null>(null);

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
      {}
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
      {compactTouchLayout ? (
        <div className="pn-visible-viewport-overlay pointer-events-none z-[91] flex items-end">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Review destination"
            className="pointer-events-auto max-h-full w-full overflow-y-auto rounded-xl border border-border bg-popover p-4 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="text-base font-semibold text-foreground">Choose where reviews go</div>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              Post comments to {platformLabel}, or send them to your agent. Tap the highlighted control any time to switch.
            </p>
            <div className="mt-3 flex justify-end">
              <button
                data-pn-touch-target
                type="button"
                onClick={onDismiss}
                className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      ) : (
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
      )}
    </div>,
    document.body,
  );
}
