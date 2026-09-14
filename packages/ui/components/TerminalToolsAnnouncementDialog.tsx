import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Star } from 'lucide-react';

/**
 * One-time announcement for Plannotator's two terminal clients, Plannotator TUI
 * and Herdr Annotate. Same big-format shell as the other first-run
 * announcements (LookAndFeelAnnouncementDialog, EditModeAnnouncementDialog),
 * with one difference: it asks the user to decide nothing, so Escape, the
 * backdrop and the single "Got it" button all do the same thing.
 *
 * LAST in each app's first-run dialog chain. The Apps gate rendering through
 * terminalToolsAnnouncementCanShow so the chain dialogs never stack; see that
 * function for why last rather than first.
 */

const TUI_REPO = 'https://github.com/plannotator/plannotator-tui';
const HERDR_REPO = 'https://github.com/plannotator/herdr-annotate';
const PLANNOTATOR_REPO = 'https://github.com/backnotprop/plannotator';
const FULL_DEMO = 'https://x.com/plannotator/status/2093419561077154287';
const LITE_DEMO = 'https://x.com/plannotator/status/2092757422322627008';

interface TerminalToolsAnnouncementDialogProps {
  readonly isOpen: boolean;
  /** Marks the announcement seen and closes it. Also wired to Escape and the backdrop. */
  readonly onDismiss: () => void;
}

function OutboundLink({
  href,
  children,
  icon,
}: {
  readonly href: string;
  readonly children: React.ReactNode;
  readonly icon?: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-border bg-surface-1/30 px-2.5 text-xs font-medium text-foreground outline-none transition-colors motion-reduce:transition-none hover:bg-surface-1/60 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card"
    >
      {icon}
      {children}
    </a>
  );
}

function CommandRow({
  command,
  label,
  copied,
  onCopy,
}: {
  readonly command: string;
  /** Accessible name for the copy button; the command itself is long and noisy. */
  readonly label: string;
  readonly copied: boolean;
  readonly onCopy: (command: string) => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-surface-0 px-2.5 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-[11px] leading-relaxed text-foreground">
        {command}
      </code>
      <button
        type="button"
        onClick={() => onCopy(command)}
        aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
        className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors motion-reduce:transition-none hover:bg-surface-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card"
      >
        {copied ? (
          <Check className="size-3.5 text-success" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

/**
 * Mock of a Plannotator TUI review: a selected block with its comment bubble,
 * the annotation toolbar, and the status line. Built from theme tokens as real
 * elements rather than an ASCII block, so it cannot misalign on a font fallback
 * and it follows the active palette in both light and dark.
 */
function TuiPreview() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-xl border border-border bg-surface-0 font-mono text-[10.5px] leading-[1.7] text-muted-foreground"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-1.5">
        <span className="text-foreground">plan.md</span>
        <span className="text-primary">Send 2 to claude in w1:p1 ▸</span>
      </div>
      <div className="flex items-start gap-4 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate">Plugins are shareable, executable workflow packages.</p>
          <div className="my-1 border-l-2 border-primary bg-primary/[0.07] pl-2">
            <p className="truncate text-foreground">Herdr owns the host surface: installation,</p>
            <p className="truncate text-foreground">manifest validation, keybindings, panes.</p>
          </div>
          <p className="truncate">The plugin owns its implementation language.</p>
        </div>
        <div className="hidden w-44 shrink-0 rounded-md border border-border bg-card px-2 py-1.5 sm:block">
          <p className="text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground/70">
            comment 8d3e8
          </p>
          <p className="mt-0.5 text-foreground">Say which parts the plugin can override.</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/60 px-3 py-1.5">
        <span className="text-success">a looks good</span>
        <span className="text-primary">c comment</span>
        <span className="text-destructive">d delete</span>
        <span className="ml-auto hidden sm:inline">plan.md · 2 annotations · selected 36 chars</span>
      </div>
    </div>
  );
}

export function TerminalToolsAnnouncementDialog({
  isOpen,
  onDismiss,
}: TerminalToolsAnnouncementDialogProps) {
  const dismissRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onDismissRef = useRef(onDismiss);
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  const handleCopy = useCallback((command: string) => {
    // Clipboard access can be denied or missing (insecure context, older
    // browsers). The command stays selectable either way, so a failure is
    // silent rather than an error the reader cannot act on.
    void navigator.clipboard?.writeText(command).then(
      () => {
        setCopied(command);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(null), 2000);
      },
      () => {},
    );
  }, []);

  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dismissRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onDismissRef.current();
        return;
      }
      // Both apps submit their decision on Mod+Enter from a window-level
      // handler. This listener is registered on the capture phase, so
      // swallowing the chord here is what stops a keystroke aimed at the
      // announcement from approving a plan or posting a review behind it.
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = document.querySelector<HTMLElement>('[data-terminal-tools-announcement-dialog]');
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

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/90 p-4 backdrop-blur-sm"
      // Dismissing from the backdrop is safe here because the dialog collects
      // no decision: there is nothing to lose by closing it the impatient way.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismissRef.current();
      }}
    >
      <div
        data-terminal-tools-announcement-dialog
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-tools-announcement-title"
        aria-describedby="terminal-tools-announcement-description"
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <header className="border-b border-border px-5 py-5 sm:px-7 sm:py-6">
          <span className="inline-flex items-center rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.13em] text-primary">
            New
          </span>
          <h2
            id="terminal-tools-announcement-title"
            className="mt-3 text-balance text-xl font-semibold tracking-tight sm:text-2xl"
          >
            Plannotator now runs in the terminal
          </h2>
          <p
            id="terminal-tools-announcement-description"
            className="mt-1.5 max-w-3xl text-pretty text-sm leading-relaxed text-muted-foreground"
          >
            Two new tools for people who would rather review in a terminal than in a browser.
            Both turn your notes into feedback for your coding agent.
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
          <TuiPreview />

          <div className="mt-5 grid grid-cols-2 gap-4 max-[820px]:grid-cols-1">
            <section
              aria-labelledby="terminal-tools-tui-heading"
              className="flex min-w-0 flex-col rounded-xl border border-border bg-muted/25 p-4"
            >
              <h3 id="terminal-tools-tui-heading" className="text-sm font-semibold text-foreground">
                Plannotator TUI
              </h3>
              <p className="mt-0.5 text-xs font-medium text-muted-foreground">
                Markdown review in the terminal
              </p>
              <p className="mt-2 text-pretty text-xs leading-relaxed text-muted-foreground">
                Select text, comment, mark it looks good or delete, then hand the review to your
                agent as numbered feedback. Open a folder to get a file tree with per-file counts,
                or run <code className="font-mono text-foreground">plannotator-tui last</code> to
                annotate one of your agent&rsquo;s recent replies. One static binary, no runtime.
              </p>
              <div className="mt-3 flex flex-col gap-1.5">
                <CommandRow
                  command="brew trust plannotator/tap && brew install plannotator/tap/plannotator-tui"
                  label="the Homebrew install command"
                  copied={copied === 'brew trust plannotator/tap && brew install plannotator/tap/plannotator-tui'}
                  onCopy={handleCopy}
                />
                <CommandRow
                  command="cargo install plannotator-tui"
                  label="the Cargo install command"
                  copied={copied === 'cargo install plannotator-tui'}
                  onCopy={handleCopy}
                />
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                Prebuilt macOS, Linux and Windows binaries are on the{' '}
                <a
                  href={`${TUI_REPO}/releases`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  releases page
                </a>
                .
              </p>
              <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
                <OutboundLink href={FULL_DEMO}>See it in action</OutboundLink>
                <OutboundLink href={TUI_REPO} icon={<Star className="size-3.5" aria-hidden="true" />}>
                  Star on GitHub
                </OutboundLink>
                <OutboundLink href={`${TUI_REPO}/issues`}>Feedback</OutboundLink>
              </div>
            </section>

            <section
              aria-labelledby="terminal-tools-herdr-heading"
              className="flex min-w-0 flex-col rounded-xl border border-border bg-muted/25 p-4"
            >
              <h3 id="terminal-tools-herdr-heading" className="text-sm font-semibold text-foreground">
                Herdr Annotate
              </h3>
              <p className="mt-0.5 text-xs font-medium text-muted-foreground">
                Annotate inside Herdr
              </p>
              <p className="mt-2 text-pretty text-xs leading-relaxed text-muted-foreground">
                Comment on any terminal text, review Markdown documents and your agent&rsquo;s
                replies, and send the feedback back to the agent as its next message. Document
                review runs Plannotator TUI. Needs Herdr 0.8.0 or later, and you bind the keys in
                Herdr&rsquo;s config after installing.
              </p>
              <div className="mt-3 flex flex-col gap-1.5">
                <CommandRow
                  command="herdr plugin install plannotator/herdr-annotate"
                  label="the full install command"
                  copied={copied === 'herdr plugin install plannotator/herdr-annotate'}
                  onCopy={handleCopy}
                />
                <CommandRow
                  command="herdr plugin install plannotator/herdr-annotate/lite"
                  label="the Lite install command"
                  copied={copied === 'herdr plugin install plannotator/herdr-annotate/lite'}
                  onCopy={handleCopy}
                />
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                Full covers macOS and Linux. Lite is terminal notes only: select text, press your
                annotate key, comment in a popover.
              </p>
              <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
                <OutboundLink href={FULL_DEMO}>Full demo</OutboundLink>
                <OutboundLink href={LITE_DEMO}>Lite demo</OutboundLink>
                <OutboundLink href={HERDR_REPO} icon={<Star className="size-3.5" aria-hidden="true" />}>
                  Star on GitHub
                </OutboundLink>
                <OutboundLink href={`${HERDR_REPO}/issues`}>Feedback</OutboundLink>
              </div>
            </section>
          </div>
        </div>

        <footer className="flex flex-col gap-3 border-t border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7 sm:py-5">
          <p className="text-pretty text-xs leading-relaxed text-muted-foreground">
            We&rsquo;re enhancing these as much as we enhance this UI. Star them if they&rsquo;re
            useful, and open an issue when they&rsquo;re not.
          </p>
          <div className="flex items-center gap-2 sm:shrink-0">
            <OutboundLink
              href={PLANNOTATOR_REPO}
              icon={<Star className="size-3.5" aria-hidden="true" />}
            >
              Star Plannotator
            </OutboundLink>
            <button
              ref={dismissRef}
              type="button"
              onClick={onDismiss}
              className="min-h-9 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground outline-none transition-opacity motion-reduce:transition-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              Got it
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
