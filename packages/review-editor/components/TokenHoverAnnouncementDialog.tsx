import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { configStore, useConfigValue } from '@plannotator/ui/config';
import { modKeyWord } from '@plannotator/ui/utils/platform';
import {
  TOKEN_HOVER_TRIGGERS,
  type TokenHoverTrigger,
} from '@plannotator/shared/token-hover';

/**
 * One-time hover card announcement, in the same big-format shell as
 * EditModeAnnouncementDialog and LookAndFeelAnnouncementDialog: a worked
 * example on the left, the decision on the right.
 *
 * LAST in the first-run dialog chain (guide intro, look-and-feel, review
 * setup, edit mode, then this). The App gates rendering through
 * tokenHoverAnnouncementCanShow so the chain dialogs never stack.
 *
 * The example is built from JSX and theme tokens rather than a screenshot: it
 * stays crisp at any DPI, follows the active palette in both light and dark,
 * and cannot go stale against a card whose anatomy changes. It is purely
 * illustrative, so it is aria-hidden and every fact it shows is also stated in
 * the prose around it.
 *
 * The radio group writes the real setting on selection, so Done and Escape
 * both mean "accept what is selected" and a choice can never be lost by
 * dismissing.
 */

interface TokenHoverAnnouncementDialogProps {
  readonly isOpen: boolean;
  /** Mark seen and close. Also wired to Escape. */
  readonly onDismiss: () => void;
}

const TRIGGER_COPY: Record<TokenHoverTrigger, { label: string; description: string }> = {
  hover: {
    label: 'On hover',
    description: 'Rest the pointer on a symbol and the card appears. This is the default.',
  },
  modifier: {
    label: 'While holding Alt (Option)',
    description: 'Cards stay out of the way until you hold Alt. Nothing is searched while the key is up.',
  },
  off: {
    label: 'Off',
    description: 'No cards, no listeners, no searches.',
  },
};

/**
 * The illustration: a short strip of diff with one token under the pointer,
 * and the card that opens for it. Mirrors the real card's anatomy in the same
 * order the component renders it (name + kind, signature, doc, Defined at,
 * references sample) using the same theme tokens, so it reads as the product
 * rather than as marketing art.
 */
function HoverCardExample() {
  return (
    <div
      aria-hidden="true"
      data-token-hover-example
      className="flex h-full flex-col gap-3 overflow-hidden rounded-xl border border-border bg-muted/20 p-4"
    >
      {/* Mock file header */}
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] font-medium text-foreground/80">
          src/checkout/order.ts
        </span>
      </div>

      {/* Diff strip. One token carries the hovered treatment. */}
      <div className="overflow-hidden rounded-lg border border-border bg-background/70 py-2 font-mono text-[11.5px] leading-6">
        <div className="flex gap-3 px-3 text-muted-foreground/80">
          <span className="w-5 shrink-0 select-none text-right text-muted-foreground/40">41</span>
          <span className="truncate">
            <span className="text-primary/70">const</span> client = <span className="text-primary/70">new</span> PaymentClient(config);
          </span>
        </div>
        <div className="flex gap-3 bg-success/10 px-3">
          <span className="w-5 shrink-0 select-none text-right text-success/60">42</span>
          <span className="truncate text-foreground">
            <span className="text-primary/70">const</span> receipt = <span className="text-primary/70">await</span>{' '}
            {/* The hovered token: a soft plate plus the dotted underline the
                real diff paints, with the pointer resting on it. */}
            <span className="relative rounded-[3px] bg-primary/20 px-0.5 underline decoration-primary/60 decoration-dotted underline-offset-[3px]">
              charge
              <span className="absolute -bottom-1.5 left-1/2 text-[13px] leading-none text-foreground/70">
                {'▲'}
              </span>
            </span>
            (order.total);
          </span>
        </div>
        <div className="flex gap-3 px-3 text-muted-foreground/80">
          <span className="w-5 shrink-0 select-none text-right text-muted-foreground/40">43</span>
          <span className="truncate">
            <span className="text-primary/70">return</span> receipt;
          </span>
        </div>
      </div>

      {/* The card itself, anchored below the token like the real one. */}
      <div className="ml-6 w-full max-w-[380px] rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl">
        <div className="flex items-center gap-2 px-3.5 pt-3">
          <span className="font-mono text-sm font-bold text-primary">charge</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
            function
          </span>
        </div>

        <div className="mx-3.5 mt-2 overflow-hidden whitespace-pre rounded-md border border-border bg-muted/40 px-2.5 py-2 font-mono text-[11px] text-foreground">
          {'export async function charge(amount) {'}
          <span className="text-muted-foreground">{' // matched line'}</span>
        </div>

        <p className="mx-3.5 mt-2 text-xs leading-relaxed text-muted-foreground">
          Charges the card on file and returns the settled receipt.
        </p>

        <div className="mt-2.5 px-3.5 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-1.5">
            <span>{'→'}</span>
            <span>Defined at</span>
            <span className="font-mono text-[11px] text-success">src/billing/charge.ts:18</span>
          </div>
        </div>

        <div className="mt-2.5 border-t border-border px-3.5 py-2.5">
          <div className="mb-1.5 text-xs text-muted-foreground">7 references</div>
          {['src/checkout/order.ts:42', 'src/billing/retry.ts:114'].map((location) => (
            <div key={location} className="flex gap-1.5 py-0.5 font-mono text-[11px]">
              <span className="text-muted-foreground/60">{'❯'}</span>
              <span className="truncate text-primary">{location}</span>
            </div>
          ))}
          <div className="py-0.5 text-[11px] text-muted-foreground">
            {'… 5 more in the References panel'}
          </div>
        </div>
      </div>
    </div>
  );
}

export function TokenHoverAnnouncementDialog({
  isOpen,
  onDismiss,
}: TokenHoverAnnouncementDialogProps) {
  const trigger = useConfigValue('tokenHoverTrigger');
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!isOpen) return;

    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    primaryActionRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDismissRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = document.querySelector<HTMLElement>('[data-token-hover-announcement-dialog]');
      const focusable = Array.from(
        dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')
          ?? [],
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [isOpen]);

  /**
   * Arrow keys move selection within the group, per the WAI-ARIA radiogroup
   * pattern: both axes are accepted because the group is a vertical list of
   * horizontally-laid-out rows, and both wrap. Selection follows focus, which
   * is what makes the group a single Tab stop that still reaches every option.
   */
  const handleOptionKeyDown = (event: React.KeyboardEvent, index: number) => {
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const backward = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    if (!forward && !backward) return;
    event.preventDefault();
    const count = TOKEN_HOVER_TRIGGERS.length;
    const next = (index + (forward ? 1 : -1) + count) % count;
    configStore.set('tokenHoverTrigger', TOKEN_HOVER_TRIGGERS[next]);
    optionRefs.current[next]?.focus();
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/90 p-4 backdrop-blur-sm">
      <div
        data-token-hover-announcement-dialog
        role="dialog"
        aria-modal="true"
        aria-labelledby="token-hover-announcement-title"
        aria-describedby="token-hover-announcement-description"
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <header className="border-b border-border px-7 py-6">
          <span className="inline-flex items-center rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.13em] text-primary">
            New
          </span>
          <h2 id="token-hover-announcement-title" className="mt-3 text-2xl font-semibold tracking-tight">
            Hover cards
          </h2>
          <p
            id="token-hover-announcement-description"
            className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted-foreground"
          >
            Rest the pointer on a symbol in a diff and Plannotator shows you where it is
            defined, an approximate signature, its doc comment, and a sample of its
            references. Every location on the card opens in the References panel.
          </p>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[1.1fr_1fr] gap-6 overflow-y-auto px-7 py-6 max-[820px]:grid-cols-1">
          <section aria-label="Hover card example" className="min-h-[300px]">
            <HoverCardExample />
          </section>

          <section className="flex min-w-0 flex-col gap-3">
            <div
              role="radiogroup"
              aria-labelledby="token-hover-announcement-choice-label"
              className="space-y-2"
            >
              <div
                id="token-hover-announcement-choice-label"
                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                Show cards
              </div>
              {TOKEN_HOVER_TRIGGERS.map((value, index) => {
                const selected = trigger === value;
                return (
                  <button
                    key={value}
                    ref={(node) => { optionRefs.current[index] = node; }}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    // Roving tabindex (WAI-ARIA radiogroup): Tab enters and
                    // leaves the group as one stop, arrows move within it. The
                    // dialog's own focus trap collects [tabindex]:not([tabindex="-1"]),
                    // so the unselected options fall out of the Tab cycle for free.
                    tabIndex={selected ? 0 : -1}
                    onKeyDown={(event) => handleOptionKeyDown(event, index)}
                    data-token-hover-trigger-option={value}
                    onClick={() => configStore.set('tokenHoverTrigger', value)}
                    className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                      selected
                        ? 'border-primary bg-primary/[0.06]'
                        : 'border-border hover:bg-muted/30'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border-2 ${
                        selected ? 'border-primary' : 'border-muted-foreground/40'
                      }`}
                    >
                      {selected && <span className="h-2 w-2 rounded-full bg-primary" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{TRIGGER_COPY[value].label}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {TRIGGER_COPY[value].description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            <p className="rounded-lg border border-border bg-muted/25 p-3 text-xs leading-relaxed text-muted-foreground">
              {modKeyWord}+click on a symbol still opens the References panel, whichever option
              you pick. Hover cards need ripgrep and a local checkout, and nothing appears when
              the search comes back empty.
            </p>
          </section>
        </div>

        <footer className="flex items-center justify-between gap-4 border-t border-border px-7 py-5">
          <p className="text-xs text-muted-foreground">
            Change this anytime in Settings, in the Editor tab.
          </p>
          <button
            ref={primaryActionRef}
            type="button"
            onClick={onDismiss}
            className="min-h-10 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          >
            Done
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
