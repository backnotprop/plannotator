/// <reference path="../globals.d.ts" />
import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import lookGridImg from '../assets/look-grid.png';
import lookFlatImg from '../assets/look-flat.png';

interface LookAndFeelAnnouncementDialogProps {
  isOpen: boolean;
  /** Current value of the singleton configStore 'gridEnabled' key. */
  gridEnabled: boolean;
  /** App owns this: it calls configStore.set('gridEnabled', value). */
  onToggleGrid: (value: boolean) => void;
  /** Persists the current choice and closes the dialog. */
  onDismiss: () => void;
}

const LOOK_OPTIONS: {
  key: string;
  /** gridEnabled value this option selects. */
  value: boolean;
  img: string;
  title: string;
  desc: string;
}[] = [
  {
    key: 'grid',
    value: true,
    img: lookGridImg,
    title: 'Grid',
    desc: 'A floating plan card on grid paper.',
  },
  {
    key: 'clean',
    value: false,
    img: lookFlatImg,
    title: 'Clean',
    desc: 'A simple, edge-to-edge document.',
  },
];

/**
 * First-use plan appearance choice. The version announcement that previously
 * wrapped this decision is intentionally gone: startup asks only for the
 * preference Plannotator cannot infer, and Settings remains the long-term home.
 */
export const LookAndFeelAnnouncementDialog: React.FC<LookAndFeelAnnouncementDialogProps> = ({
  isOpen,
  gridEnabled,
  onToggleGrid,
  onDismiss,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
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
    continueRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDismissRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
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
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-background/90 backdrop-blur-sm"
      style={{
        paddingTop: 'max(0.75rem, var(--pn-safe-top, 0px))',
        paddingRight: 'max(0.75rem, var(--pn-safe-right, 0px))',
        paddingBottom: 'max(0.75rem, var(--pn-safe-bottom, 0px))',
        paddingLeft: 'max(0.75rem, var(--pn-safe-left, 0px))',
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-look-choice-title"
        aria-describedby="plan-look-choice-description"
        className="flex w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        style={{
          maxHeight:
            'calc(var(--pn-viewport-height, 100vh) - max(0.75rem, var(--pn-safe-top, 0px)) - max(0.75rem, var(--pn-safe-bottom, 0px)))',
        }}
      >
        <header className="border-b border-border px-4 py-4 sm:px-6 sm:py-5">
          <h2
            id="plan-look-choice-title"
            className="text-balance text-xl font-semibold tracking-tight sm:text-2xl"
          >
            Choose how plans look
          </h2>
          <p
            id="plan-look-choice-description"
            className="mt-1 text-sm leading-relaxed text-muted-foreground"
          >
            Pick a starting view. You can change it anytime in Settings.
          </p>
        </header>

        <div className="min-h-0 overflow-y-auto p-3 sm:p-5">
          <div className="grid grid-cols-2 gap-2.5 sm:gap-4" role="group" aria-label="Plan appearance">
            {LOOK_OPTIONS.map((option) => {
              const selected = gridEnabled === option.value;
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => onToggleGrid(option.value)}
                  aria-pressed={selected}
                  className={`plan-look-choice-option min-h-11 min-w-0 rounded-xl border p-2 text-left outline-none transition-[background-color,border-color,box-shadow] motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card active:bg-muted/35 sm:p-3 ${
                    selected
                      ? 'border-primary bg-primary/[0.06] shadow-sm'
                      : 'border-border bg-muted/20'
                  }`}
                >
                  <img
                    src={option.img}
                    alt=""
                    aria-hidden="true"
                    className="aspect-[1000/626] w-full rounded-lg border border-border/70 object-cover object-top select-none"
                    draggable={false}
                  />
                  <span className="mt-2.5 flex min-w-0 items-center justify-between gap-2 px-0.5">
                    <span className="truncate text-sm font-semibold sm:text-base">{option.title}</span>
                    <span
                      aria-hidden="true"
                      className={`h-4 w-4 shrink-0 rounded-full border-2 p-[3px] ${
                        selected ? 'border-primary' : 'border-muted-foreground/35'
                      }`}
                    >
                      {selected && <span className="block h-full w-full rounded-full bg-primary" />}
                    </span>
                  </span>
                  <span className="mt-0.5 block px-0.5 text-xs leading-snug text-muted-foreground sm:text-sm">
                    {option.desc}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <footer className="border-t border-border px-4 py-3 sm:flex sm:justify-end sm:px-6 sm:py-4">
          <button
            ref={continueRef}
            type="button"
            onClick={onDismiss}
            className="min-h-11 w-full rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground outline-none transition-opacity motion-reduce:transition-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card sm:w-auto"
          >
            Continue
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
};
