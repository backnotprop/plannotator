import React, { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { configStore, useConfigValue } from '@plannotator/ui/config';
import { modKeyWord } from '@plannotator/ui/utils/platform';
import type { CodeNavHoverResponse, CodeNavRequest } from '@plannotator/shared/code-nav';
import { TokenHoverCard } from './TokenHoverCard';
import { useTokenHover } from '../hooks/useTokenHover';
import { TOKEN_HOVER_UNDERLINE_STYLE } from './tokenHoverStyles';
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
 * The example is a TRY-IT: the token in the strip is genuinely hoverable and
 * opens the REAL card through the REAL hook, governed by whichever trigger and
 * delay the radio currently says. Only the answer is a fixture, so the demo
 * never searches the reviewer's repository. Nothing here is a redraw, so it
 * cannot drift from the surface it illustrates.
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
    label: `While holding ${modKeyWord}`,
    description: `Cards stay out of the way until you hold ${modKeyWord}. Nothing is searched while the key is up.`,
  },
  off: {
    label: 'Off',
    description: 'No cards, no listeners, no searches.',
  },
};

/**
 * The fixture the example card is rendered from. A realistic
 * CodeNavHoverResponse, nothing more: the card itself decides what to show.
 *
 * Exported so the DOM test can assert the rendered card against the SAME
 * fixture it was built from, which is what pins "the example is the real
 * card" rather than a copy of its markup.
 */
/** The symbol the try-it demonstrates. Named in the prompt line too. */
const EXAMPLE_SYMBOL = 'withRetry';

export const EXAMPLE_HOVER: CodeNavHoverResponse = {
  backend: 'search',
  source: 'search',
  symbol: EXAMPLE_SYMBOL,
  definition: {
    filePath: 'src/lib/retry.ts',
    line: 24,
    column: 22,
    confidence: 'likely',
    symbolKind: 'function',
    signature: 'export async function withRetry(fn, attempts = 3) {',
    signatureApproximate: true,
    doc: 'Runs fn, retrying with exponential backoff until attempts runs out.',
    preview: null,
    otherCandidateCount: 0,
  },
  alternateDefinition: null,
  references: [
    { filePath: 'src/checkout/order.ts', line: 42, column: 24 },
    { filePath: 'src/billing/settle.ts', line: 88, column: 11 },
  ],
  referenceCount: 7,
  capped: false,
  stats: { elapsedMs: 18 },
};

/**
 * The try-it's request, shaped exactly like one the diff pane would build.
 * Only the resolver is a fixture; everything downstream is the real pipeline.
 */
const EXAMPLE_REQUEST: CodeNavRequest = {
  symbol: EXAMPLE_SYMBOL,
  filePath: 'src/checkout/order.ts',
  line: 42,
  charStart: 24,
  side: 'new',
  language: 'typescript',
};

/**
 * The illustration is a TRY-IT, not an exhibit: the token below is genuinely
 * hoverable and opens the REAL card through the REAL hook, so the reviewer
 * feels the actual dwell, the leave grace and the modifier gate before
 * committing to a setting. The only thing that is not real is where the answer comes
 * from, and that is deliberate: a demo must not search the reviewer's
 * repository for a symbol they never asked about.
 *
 * The trigger and delay come from the LIVE setting, so flipping the radio to
 * the hold-modifier option makes the try-it behave that way immediately, and "Off"
 * makes it do nothing, which is the honest preview of that choice.
 */
function HoverCardTryIt({
  mode,
  delayMs,
  enabled,
}: {
  mode: 'hover' | 'modifier';
  delayMs: number;
  enabled: boolean;
}) {
  const tokenRef = useRef<HTMLSpanElement>(null);

  // No network, no LRU sharing with the app: this hook instance is its own.
  const resolve = useCallback(async () => EXAMPLE_HOVER, []);
  const tokenHover = useTokenHover('token-hover-announcement', { mode, delayMs, resolve });

  const { onTokenHoverEnter, onTokenHoverLeave, close } = tokenHover;

  // Turning the try-it off (the Off option) must take any open card with it;
  // no leave event arrives when the handlers simply stop being wired.
  useEffect(() => {
    if (!enabled) close();
  }, [enabled, close]);

  return (
    <div
      // Interactive, so it is labeled rather than hidden. The mock code inside
      // is decorative and stays hidden; the prompt line carries the meaning.
      role="group"
      aria-label="Try it: a live hover card demo"
      data-token-hover-example
      className="flex h-full flex-col gap-3 rounded-xl border border-border bg-muted/20 p-4"
    >
      <p className="text-xs text-muted-foreground" data-token-hover-tryit-prompt>
        Try it: rest your pointer on <span className="font-mono text-foreground">{EXAMPLE_SYMBOL}</span> below.
      </p>

      <div
        aria-hidden="true"
        data-token-hover-example-code
        className="overflow-hidden rounded-lg border border-border bg-background/70 py-2 font-mono text-[12px] leading-6"
      >
        <div className="flex gap-3 px-3 text-muted-foreground/80">
          <span className="w-5 shrink-0 select-none text-right text-muted-foreground/40">41</span>
          <span className="truncate">
            <span className="text-primary/70">const</span> client = <span className="text-primary/70">new</span> PaymentClient(config);
          </span>
        </div>
        <div className="flex gap-3 bg-success/10 px-3">
          <span className="w-5 shrink-0 select-none text-right text-success/60">42</span>
          <span className="truncate text-foreground">
            {/* The token leads the line on purpose: the card anchors at its
                left edge and is 400px wide, so a token sitting mid-line would
                open the card across the radio column beside it. */}
            <span className="text-primary/70">await</span>{' '}
            <span
              ref={tokenRef}
              data-token-hover-example-token
              style={TOKEN_HOVER_UNDERLINE_STYLE}
              onPointerEnter={() => {
                if (!enabled || !tokenRef.current) return;
                onTokenHoverEnter(EXAMPLE_REQUEST, tokenRef.current);
              }}
              onPointerLeave={() => {
                if (!enabled) return;
                onTokenHoverLeave();
              }}
            >
              {EXAMPLE_SYMBOL}
            </span>
            (() =&gt; charge(order.total));
          </span>
        </div>
        <div className="flex gap-3 px-3 text-muted-foreground/80">
          <span className="w-5 shrink-0 select-none text-right text-muted-foreground/40">43</span>
          <span className="truncate">
            <span className="text-primary/70">return</span> receipt;
          </span>
        </div>
      </div>

      {enabled && tokenHover.hover && (
        <TokenHoverCard
          hover={tokenHover.hover}
          onPointerEnter={tokenHover.onCardEnter}
          onPointerLeave={tokenHover.onCardLeave}
          // The try-it has no References panel behind it, so the locations
          // lead nowhere and stay out of the tab order.
          onSelectLocation={() => {}}
          inert
          // Above the modal this is demonstrated inside; the app's own default
          // layer sits under it.
          layerClassName="fixed z-[110]"
        />
      )}
    </div>
  );
}

export function TokenHoverAnnouncementDialog({
  isOpen,
  onDismiss,
}: TokenHoverAnnouncementDialogProps) {
  const trigger = useConfigValue('tokenHoverTrigger');
  const delayMs = useConfigValue('tokenHoverDelay');
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
        // `:not([tabindex="-1"])` has to apply to the BUTTONS too, not just the
        // [tabindex] arm: the roving radio group parks two unselected options
        // at -1 and neither belongs in the Tab cycle. (The try-it's card is
        // not a factor either way — it portals to <body>, so this query never
        // reaches it; its own locations leave the tab order via `inert`.)
        dialog?.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), [href], [tabindex]:not([tabindex="-1"])')
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
          <section className="min-h-[300px]">
            <HoverCardTryIt
              mode={trigger === 'modifier' ? 'modifier' : 'hover'}
              delayMs={delayMs}
              enabled={trigger !== 'off'}
            />
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
                    // focus trap's selector excludes [tabindex="-1"] on buttons
                    // too, so the unselected options stay out of the Tab cycle.
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
