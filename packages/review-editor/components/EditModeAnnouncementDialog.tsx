import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Ban, MessageSquarePlus, Pencil, Send } from 'lucide-react';
import { TextShimmer } from '@plannotator/ui/components/TextShimmer';
import { EDIT_MODE_DEMO_POSTER_SRC, EDIT_MODE_DEMO_VIDEO_SRC } from './editModeDemoMedia';

/**
 * One-time Edit Mode (edit-to-suggest) announcement. Same big-format shell as
 * LookAndFeelAnnouncementDialog, with the Vim-announcement ask: introduce the
 * feature and let the user turn the real setting on now or keep it off.
 * Either action marks the announcement seen; the App owns both callbacks.
 *
 * LAST in the first-run dialog chain (guide intro, look-and-feel, review
 * setup, analysis chooser, then this). The App gates rendering through
 * editModeAnnouncementCanShow so the chain dialogs never stack.
 */

interface EditModeAnnouncementDialogProps {
  readonly isOpen: boolean;
  /** Persist editSuggestions=true and mark seen. */
  readonly onEnable: () => void;
  /** Just mark seen. Also wired to Escape. */
  readonly onDismiss: () => void;
  /** Test seam; defaults to the build-time inlined recording (or null). */
  readonly demoVideoSrc?: string | null;
  /** Test seam; defaults to the build-time inlined poster still. */
  readonly demoPosterSrc?: string;
}

interface FactRowProps {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly description: string;
}

function FactRow({ icon, title, description }: FactRowProps) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/25 p-3.5">
      <span
        aria-hidden="true"
        className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-primary/25 bg-primary/10 text-primary"
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
    </div>
  );
}

/**
 * Static stand-in for the screen recording: a mock split of the all-files
 * diff mid-edit, with the resulting suggestion comment underneath. Replaced
 * wholesale by the <video> once EDIT_MODE_DEMO_VIDEO_SRC is set.
 */
function EditModeDemoPlaceholder() {
  return (
    <div
      data-edit-mode-demo-placeholder
      className="flex h-full min-h-[300px] flex-col overflow-hidden rounded-xl border border-border bg-muted/20"
      aria-hidden="true"
    >
      {/* Mock file header with the Edit entry + session strip */}
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3.5 py-2">
        <span className="font-mono text-[11px] font-medium text-foreground/80">src/retry.ts</span>
        <span className="ml-auto inline-flex items-center gap-1 rounded border border-border bg-background/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          <Pencil className="h-2.5 w-2.5" />
          Edit
        </span>
      </div>
      <div className="flex items-center gap-2 border-b border-warning/25 bg-warning/10 px-3.5 py-1">
        <span className="text-[10px] font-semibold text-warning">Editing</span>
        <span className="rounded border border-border/60 px-1 py-px text-[8px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Experimental
        </span>
        <span className="text-[10px] text-muted-foreground">1 change</span>
      </div>

      {/* Mock diff lines with an in-place edit */}
      <div className="flex-1 space-y-px px-3.5 py-3 font-mono text-[11px] leading-5">
        <div className="text-muted-foreground/70">
          <span className="mr-3 select-none text-muted-foreground/40">41</span>
          {'export function retry(fn, attempts) {'}
        </div>
        <div className="rounded bg-destructive/10 text-destructive/90 line-through decoration-destructive/50">
          <span className="mr-3 select-none text-muted-foreground/40">42</span>
          {'  const delay = 1000;'}
        </div>
        <div className="rounded bg-success/10 text-success">
          <span className="mr-3 select-none text-muted-foreground/40">42</span>
          {'  const delay = baseDelay * 2 ** attempt;'}
          <span className="ml-0.5 inline-block h-3.5 w-px animate-pulse bg-foreground align-middle" />
        </div>
        <div className="text-muted-foreground/70">
          <span className="mr-3 select-none text-muted-foreground/40">43</span>
          {'  return schedule(fn, delay);'}
        </div>
      </div>

      {/* The resulting suggestion comment */}
      <div className="border-t border-border bg-background/60 px-3.5 py-3">
        <div className="rounded-lg border border-primary/25 bg-primary/[0.06] p-2.5">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
            <MessageSquarePlus className="h-3 w-3" />
            Suggestion
          </div>
          <div className="mt-1 font-mono text-[10px] leading-4 text-muted-foreground">
            <span className="block text-destructive/80">- const delay = 1000;</span>
            <span className="block text-success">+ const delay = baseDelay * 2 ** attempt;</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function EditModeAnnouncementDialog({
  isOpen,
  onEnable,
  onDismiss,
  demoVideoSrc = EDIT_MODE_DEMO_VIDEO_SRC,
  demoPosterSrc = EDIT_MODE_DEMO_POSTER_SRC,
}: EditModeAnnouncementDialogProps) {
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onDismissRef = useRef(onDismiss);
  const [enableChoice, setEnableChoice] = useState(false);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!isOpen) return;

    // A reopened dialog must not remember a previously flipped switch.
    setEnableChoice(false);
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

      const dialog = document.querySelector<HTMLElement>('[data-edit-mode-announcement-dialog]');
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
        data-edit-mode-announcement-dialog
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-mode-announcement-title"
        aria-describedby="edit-mode-announcement-description"
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <header className="border-b border-border px-7 py-6">
          <span className="inline-flex items-center rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.13em] text-primary">
            New · Experimental
          </span>
          <h2 id="edit-mode-announcement-title" className="mt-3 text-2xl font-semibold tracking-tight">
            Edit code to suggest
          </h2>
          <p
            id="edit-mode-announcement-description"
            className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted-foreground"
          >
            A new way to give review feedback: make the change you want to see, right in the
            diff. It is experimental and off by default. Turn it on with the switch below, or
            leave it off, and nothing else changes.
          </p>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[1.1fr_1fr] gap-6 overflow-y-auto px-7 py-6 max-[820px]:grid-cols-1">
          <section aria-label="Edit Mode demo" className="min-h-[300px]">
            {demoVideoSrc ? (
              <video
                src={demoVideoSrc}
                poster={demoPosterSrc}
                autoPlay
                loop
                muted
                playsInline
                aria-hidden="true"
                // Recording is 1100x700; matching the aspect ratio means no
                // cropping and no letterboxing inside the rounded frame.
                className="aspect-[11/7] w-full rounded-xl border border-border bg-muted/20 object-cover"
              />
            ) : (
              <EditModeDemoPlaceholder />
            )}
          </section>

          <section aria-label="How Edit Mode works" className="flex min-w-0 flex-col gap-3">
            <FactRow
              icon={<Pencil className="h-4 w-4" />}
              title="Edit in the diff"
              description="Click Edit on a file in the all-files review view, then type your change directly into the diff in your browser. One file at a time."
            />
            <FactRow
              icon={<Send className="h-4 w-4" />}
              title="Edits become suggestions"
              description="When you finish, your net changes become ordinary suggestion annotations, the same kind the suggestion editor creates, and flow into your review feedback."
            />
            <FactRow
              icon={<Ban className="h-4 w-4" />}
              title="Your files stay untouched"
              description="The browser never writes to your files on disk. The agent applies the suggestions from your feedback."
            />
            <FactRow
              icon={<MessageSquarePlus className="h-4 w-4" />}
              title="Annotate mid-edit"
              description="You can also select text inside the diff while editing and turn the selection into an annotation."
            />
          </section>
        </div>

        <footer className="flex items-center justify-between gap-4 border-t border-border px-7 py-5">
          <p className="text-xs text-muted-foreground">
            Change this anytime in Settings → Editor → Edit Code to Suggest.
          </p>
          {/* The enable decision is an explicit switch, deliberately separate from the
              dismiss action: a primary "Turn it on" button reads as a generic continue
              and gets clicked blind. Done applies whatever the switch says; with the
              switch untouched it is a plain dismissal. */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-3.5 py-2">
              <span id="edit-mode-enable-label">
                <TextShimmer className="text-sm font-medium" duration={2.5} spread={1.5}>
                  Enable Edit Mode
                </TextShimmer>
              </span>
              <button
                type="button"
                role="switch"
                aria-labelledby="edit-mode-enable-label"
                aria-checked={enableChoice}
                onClick={() => setEnableChoice((value) => !value)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card ${
                  enableChoice ? 'bg-primary' : 'bg-muted'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                    enableChoice ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
            <button
              ref={primaryActionRef}
              type="button"
              onClick={() => (enableChoice ? onEnable() : onDismiss())}
              className="min-h-10 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              Done
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
