import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnalysisLayerToggle } from '@plannotator/ui/components/AnalysisLayerToggle';
import { TextShimmer } from '@plannotator/ui/components/TextShimmer';

interface ReviewAnalysisIntroDialogProps {
  readonly isOpen: boolean;
  readonly semanticChangesEnabled: boolean;
  readonly callFlowEnabled: boolean;
  readonly onSemanticChangesChange: (enabled: boolean) => void;
  readonly onCallFlowChange: (enabled: boolean) => void;
  readonly onDismiss: () => void;
}

/** A compact facsimile of the semantic Dock/Lens output. */
function SemanticChangesExample() {
  return (
    <figure
      role="img"
      aria-label="Example semantic analysis showing an added sendReceipt function and a modified completeOrder function in checkout.ts"
      className="mt-4 select-none overflow-hidden rounded-lg border border-border bg-background font-mono text-[11px] leading-none"
    >
      <div className="flex h-8 items-center justify-between gap-3 border-b border-border bg-muted/25 px-3">
        <span className="truncate font-semibold text-foreground">checkout.ts</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">2 symbols</span>
      </div>
      <div className="py-1.5" aria-hidden="true">
        <div className="grid min-h-8 grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 px-3">
          <span className="text-base text-success">⊕</span>
          <span className="truncate text-foreground">
            <span className="mr-2 text-muted-foreground">function</span>
            sendReceipt()
          </span>
          <span className="text-muted-foreground">added</span>
        </div>
        <div className="grid min-h-8 grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 px-3">
          <span className="text-primary">∆</span>
          <span className="truncate text-foreground">
            <span className="mr-2 text-muted-foreground">function</span>
            completeOrder()
          </span>
          <span className="text-muted-foreground">modified</span>
        </div>
      </div>
    </figure>
  );
}

/** A compact facsimile of the complete entry trees shown by Call flow. */
function CallFlowExample() {
  return (
    <figure
      role="img"
      aria-label="Example call-flow analysis showing the checkout entry path reaching a newly added sendReceipt call"
      className="mt-4 select-none overflow-hidden rounded-lg border border-border bg-background font-mono text-[11px] leading-none"
    >
      <div className="flex h-8 items-center justify-between gap-3 border-b border-border bg-muted/25 px-3">
        <span className="truncate font-semibold text-foreground">
          <span className="mr-2 text-primary">↳</span>
          checkout()
        </span>
        <span className="shrink-0 uppercase tracking-[0.08em] text-muted-foreground">entry path</span>
      </div>
      <div className="py-1.5" aria-hidden="true">
        <div className="grid min-h-8 grid-cols-[1rem_1rem_minmax(0,1fr)] items-center gap-1.5 px-3 text-foreground">
          <span className="text-muted-foreground">⌄</span>
          <span className="text-muted-foreground">·</span>
          <span className="truncate">checkout()</span>
        </div>
        <div className="ml-[1.15rem] border-l border-border pl-2">
          <div className="grid min-h-8 grid-cols-[1rem_1rem_minmax(0,1fr)] items-center gap-1.5 px-2 text-foreground">
            <span className="text-muted-foreground">⌄</span>
            <span className="text-muted-foreground">·</span>
            <span className="truncate">completeOrder()</span>
          </div>
          <div className="grid min-h-8 grid-cols-[1rem_1rem_minmax(0,1fr)_auto] items-center gap-1.5 bg-success/5 px-2 text-foreground">
            <span />
            <span className="font-semibold text-success">+</span>
            <span className="truncate">sendReceipt()</span>
            <span className="text-muted-foreground">checkout.ts:118</span>
          </div>
        </div>
      </div>
    </figure>
  );
}

/**
 * One-time chooser for the two independent code-review analysis layers.
 * Uses the same large announcement shell and spacing rhythm as Guide Intro,
 * Look & Feel, Review Setup, and Edit Mode.
 */
export function ReviewAnalysisIntroDialog({
  isOpen,
  semanticChangesEnabled,
  callFlowEnabled,
  onSemanticChangesChange,
  onCallFlowChange,
  onDismiss,
}: ReviewAnalysisIntroDialogProps) {
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
      const dialog = document.querySelector<HTMLElement>('[data-review-analysis-intro-dialog]');
      const focusable = Array.from(dialog?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []);
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
      data-review-analysis-intro-backdrop
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/90 p-4 backdrop-blur-sm"
    >
      <div
        data-review-analysis-intro-dialog
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-analysis-intro-title"
        aria-describedby="review-analysis-intro-description"
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <header className="border-b border-border p-7">
          <h3 id="review-analysis-intro-title" className="mb-1.5 text-2xl font-semibold">
            Choose your analysis layers
          </h3>
          <p
            id="review-analysis-intro-description"
            className="max-w-3xl text-sm leading-relaxed text-muted-foreground"
          >
            Add structural context to the ordinary code diff. Each analysis is independent,
            and you can change either choice later.
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-7">
          <div className="mb-3 text-sm font-medium">Analysis layers</div>
          <div className="grid grid-cols-2 gap-5 max-[820px]:grid-cols-1">
            <section
              aria-label="Semantic changes"
              className="flex min-w-0 flex-col rounded-lg border border-border bg-muted/30 p-5"
            >
              <AnalysisLayerToggle
                checked={semanticChangesEnabled}
                onChange={onSemanticChangesChange}
                label="Semantic changes"
                description="Groups added, changed, moved, and removed functions, classes, and other named code."
                className="items-start rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              />
              <SemanticChangesExample />
              <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
                Available in the Dock and each file Lens.
              </p>
            </section>
            <section
              aria-label="Call flow"
              className="relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-primary/35 bg-primary/[0.035] p-5"
            >
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-primary/70 to-transparent"
              />
              <AnalysisLayerToggle
                checked={callFlowEnabled}
                onChange={onCallFlowChange}
                label={(
                  <span className="flex items-center gap-2">
                    <span>Call flow</span>
                    <span
                      aria-hidden="true"
                      className="inline-flex text-[10px] font-semibold uppercase tracking-[0.11em]"
                    >
                      <TextShimmer duration={2.5} spread={1.5}>New</TextShimmer>
                    </span>
                  </span>
                )}
                description="Reconstructs complete entry paths containing added or removed calls. This is static analysis, not runtime tracing. Uses a separate local runtime installed on first use."
                className="items-start rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              />
              <CallFlowExample />
              <div className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
                <p>Available in the Dock and each file Lens.</p>
                <p className="mt-1.5">
                  Powered by CallDiff, created by{' '}
                  <a
                    href="https://github.com/tanishqkancharla"
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Tanishq Kancharla on GitHub (opens in a new tab)"
                    className="font-medium text-foreground underline decoration-border underline-offset-2 transition-colors motion-reduce:transition-none hover:decoration-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    Tanishq Kancharla ↗
                  </a>
                </p>
              </div>
            </section>
          </div>
        </div>

        <footer className="flex items-center justify-between gap-4 border-t border-border px-7 py-5">
          <p className="text-xs text-muted-foreground">
            Change these anytime in Settings → Analysis.
          </p>
          <button
            ref={primaryActionRef}
            type="button"
            onClick={onDismiss}
            className="min-h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity motion-reduce:transition-none hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          >
            Got it
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
