import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { configStore, useConfigValue } from '@plannotator/ui/config';
import {
  TOKEN_HOVER_TRIGGERS,
  type TokenHoverTrigger,
} from '@plannotator/shared/token-hover';

/**
 * One-time token hover card announcement.
 *
 * LAST in the first-run dialog chain (guide intro, look-and-feel, review
 * setup, edit mode, then this). The App gates rendering through
 * tokenHoverAnnouncementCanShow so the chain dialogs never stack.
 *
 * Deliberately compact rather than the big-format shell the Edit Mode and
 * look-and-feel dialogs use: there is no demo to play, and the whole decision
 * is one three-way choice. The radio group writes the real setting on
 * selection, so Done and Escape both mean "accept what is selected" and a
 * choice can never be lost by dismissing.
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

export function TokenHoverAnnouncementDialog({
  isOpen,
  onDismiss,
}: TokenHoverAnnouncementDialogProps) {
  const trigger = useConfigValue('tokenHoverTrigger');
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

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/90 p-4 backdrop-blur-sm">
      <div
        data-token-hover-announcement-dialog
        role="dialog"
        aria-modal="true"
        aria-labelledby="token-hover-announcement-title"
        aria-describedby="token-hover-announcement-description"
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <header className="border-b border-border px-6 py-5">
          <span className="inline-flex items-center rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.13em] text-primary">
            New
          </span>
          <h2 id="token-hover-announcement-title" className="mt-3 text-xl font-semibold tracking-tight">
            Token hover cards
          </h2>
          <p
            id="token-hover-announcement-description"
            className="mt-1.5 text-sm leading-relaxed text-muted-foreground"
          >
            Rest the pointer on a symbol in a diff and Plannotator shows you where it is
            defined, an approximate signature, its doc comment, and a sample of its
            references. Every location on the card opens in the References panel.
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
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
            {TOKEN_HOVER_TRIGGERS.map((value) => {
              const selected = trigger === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
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

          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            Cmd+click on a symbol still opens the References panel, whichever option you pick.
          </p>
        </div>

        <footer className="flex items-center justify-between gap-4 border-t border-border px-6 py-4">
          <p className="text-xs text-muted-foreground">
            Change this anytime in Settings, under Review Display.
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
