import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Crosshair, Keyboard } from 'lucide-react';
import type { VimSelectionActionId, VimSelectionHudContext } from '../shortcuts';
import type { SemanticTarget } from '../utils/blockTargeting';
import {
  createVimHudCommand,
  getVimHudPhase,
} from '../utils/vimHud';
import type { VimRestorableState } from '../utils/vimNavigation';
import { getVimReticleLabel } from '../utils/vimReticle';

interface VimModeAnnouncementDialogProps {
  readonly isOpen: boolean;
  readonly vimModeEnabled: boolean;
  readonly vimHudEnabled: boolean;
  readonly onVimModeChange: (enabled: boolean) => void;
  readonly onVimHudChange: (enabled: boolean) => void;
  readonly onDismiss: () => void;
}

interface SwitchRowProps {
  readonly checked: boolean;
  readonly title: string;
  readonly description: string;
  readonly icon: React.ReactNode;
  readonly recommended?: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}

type ShowcaseTarget = Pick<SemanticTarget, 'kind' | 'label'>;

interface ShowcaseStepSpec {
  readonly actionId: VimSelectionActionId;
  readonly rawKey: string;
  readonly commandContext: VimSelectionHudContext;
  readonly resultContext: VimSelectionHudContext;
  readonly reticleState: VimRestorableState;
  readonly target: ShowcaseTarget | null;
}

const DEMO_BLOCK_TARGET: ShowcaseTarget = {
  kind: 'block',
  label: 'paragraph: "Keep collaboration responsive"',
};
const DEMO_INLINE_TARGET: ShowcaseTarget = {
  kind: 'inline',
  label: 'code: "operationBatchSize: 32"',
};
const DEMO_TEXT_START = { blockId: 'demo-inline-code', textOffset: 0 };
const DEMO_VALUE_START = { blockId: 'demo-inline-code', textOffset: 20 };
const DEMO_VALUE_END = { blockId: 'demo-inline-code', textOffset: 22 };

const SHOWCASE_STEP_SPECS: readonly ShowcaseStepSpec[] = [
  {
    actionId: 'moveDown',
    rawKey: 'j',
    commandContext: 'block',
    resultContext: 'block',
    reticleState: { phase: 'block', targetKey: 'demo-block' },
    target: DEMO_BLOCK_TARGET,
  },
  {
    actionId: 'refine',
    rawKey: 'l',
    commandContext: 'block',
    resultContext: 'inline',
    reticleState: { phase: 'inline', targetKey: 'demo-inline-code' },
    target: DEMO_INLINE_TARGET,
  },
  {
    actionId: 'refine',
    rawKey: 'l',
    commandContext: 'inline',
    resultContext: 'text',
    reticleState: {
      phase: 'text',
      targetKey: 'demo-inline-code',
      cursor: DEMO_TEXT_START,
    },
    target: null,
  },
  {
    actionId: 'wordForward',
    rawKey: 'w',
    commandContext: 'text',
    resultContext: 'text',
    reticleState: {
      phase: 'text',
      targetKey: 'demo-inline-code',
      cursor: DEMO_VALUE_START,
    },
    target: null,
  },
  {
    actionId: 'visual',
    rawKey: 'v',
    commandContext: 'text',
    resultContext: 'visual',
    reticleState: {
      phase: 'visual',
      targetKey: 'demo-inline-code',
      anchor: DEMO_VALUE_START,
      cursor: DEMO_VALUE_START,
    },
    target: null,
  },
  {
    actionId: 'wordEnd',
    rawKey: 'e',
    commandContext: 'visual',
    resultContext: 'visual',
    reticleState: {
      phase: 'visual',
      targetKey: 'demo-inline-code',
      anchor: DEMO_VALUE_START,
      cursor: DEMO_VALUE_END,
    },
    target: null,
  },
  {
    actionId: 'comment',
    rawKey: 'c',
    commandContext: 'visual',
    resultContext: 'action',
    reticleState: {
      phase: 'visual',
      targetKey: 'demo-inline-code',
      anchor: DEMO_VALUE_START,
      cursor: DEMO_VALUE_END,
    },
    target: null,
  },
];

const SHOWCASE_STEPS = SHOWCASE_STEP_SPECS.map((spec, index) => {
  const command = createVimHudCommand(
    index + 1,
    spec.actionId,
    spec.rawKey,
    spec.commandContext,
  );
  return {
    ...command,
    phase: getVimHudPhase(spec.resultContext, spec.actionId),
    reticleLabel: getVimReticleLabel(
      spec.reticleState,
      spec.target,
      command,
    ),
  };
});

function SwitchRow({
  checked,
  title,
  description,
  icon,
  recommended = false,
  disabled = false,
  onChange,
}: SwitchRowProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (disabled) return;
        onChange(!checked);
      }}
      className={`vim-announcement-switch w-full min-h-24 rounded-xl border border-border bg-muted/25 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card${
        disabled ? ' cursor-not-allowed opacity-50' : ''
      }`}
    >
      <span className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border ${
            checked
              ? 'border-primary/40 bg-primary/15 text-primary'
              : 'border-border bg-background/60 text-muted-foreground'
          }`}
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{title}</span>
            {recommended && (
              <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-primary">
                Recommended
              </span>
            )}
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
            {description}
          </span>
        </span>
        <span
          aria-hidden="true"
          className={`vim-announcement-switch__track mt-1 ${
            checked ? 'vim-announcement-switch__track--checked' : ''
          }`}
        >
          <span className="vim-announcement-switch__thumb" />
        </span>
      </span>
    </button>
  );
}

function ShowcaseReticle({
  step,
  label,
  className,
}: {
  readonly step: number;
  readonly label: string;
  readonly className: string;
}) {
  return (
    <span
      className={`vim-announcement-step vim-announcement-step--${step} vim-announcement-reticle ${className}`}
    >
      <span className="vim-announcement-reticle__corner vim-announcement-reticle__corner--top-left" />
      <span className="vim-announcement-reticle__corner vim-announcement-reticle__corner--top-right" />
      <span className="vim-announcement-reticle__corner vim-announcement-reticle__corner--bottom-left" />
      <span className="vim-announcement-reticle__corner vim-announcement-reticle__corner--bottom-right" />
      <span className="vim-announcement-reticle__label">
        <span className="vim-announcement-reticle__dot" />
        {label}
      </span>
    </span>
  );
}

function VimShowcase() {
  const [isPlaying, setIsPlaying] = useState(() => (
    typeof document === 'undefined' || document.visibilityState !== 'hidden'
  ));

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsPlaying(document.visibilityState !== 'hidden');
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  return (
    <div
      className="vim-announcement-showcase relative h-full min-h-[350px] overflow-hidden rounded-xl border border-white/10 bg-[#111019] min-[821px]:min-h-[430px]"
      data-playing={isPlaying ? 'true' : 'false'}
      aria-hidden="true"
    >
      <div className="vim-announcement-showcase__canvas absolute inset-0">
        <div className="absolute inset-x-0 top-0 flex h-10 items-center gap-1.5 border-b border-white/[0.07] bg-white/[0.025] px-4">
          <span className="h-2 w-2 rounded-full bg-white/10" />
          <span className="h-2 w-2 rounded-full bg-white/10" />
          <span className="h-2 w-2 rounded-full bg-white/10" />
          <span className="ml-2 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-white/35">
            vim-mode-demo.md
          </span>
        </div>

        <div className="absolute inset-x-0 bottom-0 top-10 px-7 pb-24 pt-6 text-[#cbc7d4]">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8b8398]">
            Vim mode demo
          </div>
          <div className="mt-2 text-[21px] font-semibold tracking-[-0.02em] text-[#f3eff9]">
            This is a demo
          </div>
          <p className="mt-4 max-w-[430px] text-[12px] leading-[1.75] text-[#aaa4b4]">
            Watch Vim mode move through a sample document, refine into exact text,
            select a value, and open a comment.
          </p>

          <p
            data-vim-demo-target="block"
            className="relative mt-5 rounded-lg border border-white/[0.07] bg-[#1b1923] px-4 py-4 text-[12px] leading-7 text-[#bdb6c9]"
          >
            <ShowcaseReticle
              step={1}
              label={SHOWCASE_STEPS[0].reticleLabel}
              className="vim-announcement-reticle--block"
            />
            Keep collaboration responsive by setting{' '}
            <code
              data-vim-demo-target="inline"
              className="relative inline-flex rounded bg-[#25222e] px-1.5 font-mono text-[11px] text-[#79c0ff]"
            >
              <ShowcaseReticle
                step={2}
                label={SHOWCASE_STEPS[1].reticleLabel}
                className="vim-announcement-reticle--inline"
              />
              <span
                data-vim-demo-target="word"
                className="relative inline-block"
              >
                operationBatchSize
                <ShowcaseReticle
                  step={3}
                  label={SHOWCASE_STEPS[2].reticleLabel}
                  className="vim-announcement-reticle--cursor-start"
                />
              </span>
              <span className="text-[#bdb6c9]">: </span>
              <span
                data-vim-demo-target="selection"
                className="relative inline-block"
              >
                <span className="vim-announcement-code-selection rounded-[3px] px-0.5 text-[#d2a8ff]">
                  32
                </span>
                <ShowcaseReticle
                  step={4}
                  label={SHOWCASE_STEPS[3].reticleLabel}
                  className="vim-announcement-reticle--selection"
                />
                <ShowcaseReticle
                  step={5}
                  label={SHOWCASE_STEPS[4].reticleLabel}
                  className="vim-announcement-reticle--selection"
                />
                <ShowcaseReticle
                  step={6}
                  label={SHOWCASE_STEPS[5].reticleLabel}
                  className="vim-announcement-reticle--selection"
                />
                <ShowcaseReticle
                  step={7}
                  label={SHOWCASE_STEPS[6].reticleLabel}
                  className="vim-announcement-reticle--selection"
                />
                <span className="vim-announcement-step vim-announcement-step--7 vim-announcement-comment">
                  <span className="block text-[10px] font-semibold text-[#f3eff9]">
                    Comment on “32”
                  </span>
                  <span className="mt-1 block text-[9px] text-[#9e96aa]">
                    Explain why this batch size is safe…
                  </span>
                </span>
              </span>
            </code>
            . One <kbd className="font-mono text-[#c4b5fd]">w</kbd> jumps from the
            variable to its value.
          </p>
        </div>

        <div className="absolute bottom-5 right-5 z-20 flex h-[62px] w-[250px] items-center gap-3 rounded-xl border border-[#c4b5fd]/20 bg-[#16121f]/70 px-3.5 shadow-[0_16px_40px_rgba(0,0,0,0.42)] backdrop-blur-md">
          <div className="relative h-10 w-10 shrink-0">
            {SHOWCASE_STEPS.map((item, index) => (
              <kbd
                key={`${item.key}-${index}`}
                className={`vim-announcement-step vim-announcement-step--${index + 1} absolute inset-0 grid place-items-center rounded-lg border border-[#ddd4ff]/70 border-b-[3px] border-b-[#6750a4] bg-gradient-to-b from-[#eee9ff] to-[#a78bfa] font-mono text-xl font-black text-[#1b1427] shadow-[0_0_24px_rgba(167,139,250,0.52)]`}
              >
                {item.key}
              </kbd>
            ))}
          </div>
          <div className="relative h-9 min-w-0 flex-1">
            {SHOWCASE_STEPS.map((item, index) => (
              <div
                key={`${item.phase}-${index}`}
                className={`vim-announcement-step vim-announcement-step--${index + 1} absolute inset-0 flex flex-col justify-center`}
              >
                <div className="font-mono text-[9px] font-black tracking-[0.16em] text-[#d8ccff]">
                  {item.phase}
                </div>
                <div className="mt-1 truncate text-[11px] font-semibold text-[#f5f0ff]">
                  {item.description}
                </div>
              </div>
            ))}
          </div>
          <div className="font-mono text-[9px] font-bold text-[#817989]">1 / 1</div>
        </div>
      </div>
    </div>
  );
}

/**
 * Introduces Vim navigation and lets the user persist the real Vim and HUD settings.
 */
export function VimModeAnnouncementDialog({
  isOpen,
  vimModeEnabled,
  vimHudEnabled,
  onVimModeChange,
  onVimHudChange,
  onDismiss,
}: VimModeAnnouncementDialogProps) {
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

      const dialog = document.querySelector<HTMLElement>('[data-vim-announcement-dialog]');
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

  const primaryLabel = !vimModeEnabled
    ? 'Close'
    : vimHudEnabled
      ? 'Start with Vim + HUD'
      : 'Start with Vim';

  return createPortal(
    <div className="vim-announcement-backdrop fixed inset-0 z-[100] flex items-center justify-center bg-background/90 p-4 backdrop-blur-sm">
      <div
        data-vim-announcement-dialog
        role="dialog"
        aria-modal="true"
        aria-labelledby="vim-announcement-title"
        aria-describedby="vim-announcement-description"
        className="vim-announcement-dialog flex h-[760px] max-h-[calc(100dvh-2rem)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl max-[820px]:h-[calc(100dvh-2rem)]"
      >
        <header className="border-b border-border px-7 py-6">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex items-center rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.13em] text-primary">
              New · Keyboard navigation
            </span>
          </div>
          <h2 id="vim-announcement-title" className="mt-3 text-2xl font-semibold tracking-tight">
            Vim keys, if you want them
          </h2>
          <p
            id="vim-announcement-description"
            className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted-foreground"
          >
            Plannotator now has optional Vim-style keyboard navigation for moving through a
            document, selecting text, and annotating without the mouse. It stays off unless you
            turn it on. If that's not how you work, close this and nothing changes.
          </p>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[1.35fr_0.85fr] gap-6 overflow-y-auto px-7 py-6 max-[820px]:grid-cols-1">
          <section aria-label="Vim controls preview" className="min-h-[350px] min-[821px]:min-h-[430px]">
            <VimShowcase />
          </section>

          <section aria-label="Vim controls settings" className="flex min-w-0 flex-col">
            <div>
              <div className="text-sm font-semibold">Turn it on now, or never</div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                These are the real saved settings. You can change them anytime.
              </p>
            </div>

            <div className="mt-4 space-y-3">
              <SwitchRow
                checked={vimModeEnabled}
                title="Vim controls"
                description="Use J/K to move by block, L/H to move in or out, then W/B/E and V for precise text selection."
                icon={<Keyboard className="h-[18px] w-[18px]" />}
                onChange={onVimModeChange}
              />
              <SwitchRow
                checked={vimModeEnabled && vimHudEnabled}
                title="Vim HUD"
                description={
                  vimModeEnabled
                    ? 'Adds the four-corner target reticle, live keypress feedback, and a complete ? key map.'
                    : 'Turn on Vim controls first.'
                }
                icon={<Crosshair className="h-[18px] w-[18px]" />}
                recommended={vimModeEnabled}
                disabled={!vimModeEnabled}
                onChange={onVimHudChange}
              />
            </div>

            <div className="mt-auto rounded-xl border border-primary/20 bg-primary/[0.06] p-4">
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
                  <span className="font-mono text-xs font-black">?</span>
                </span>
                <div>
                  <div className="text-xs font-semibold text-foreground">Learn as you navigate</div>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    With HUD enabled, press <kbd className="rounded border border-border bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-foreground">?</kbd>{' '}
                    in the document to expand the complete command map.
                  </p>
                </div>
              </div>
            </div>
          </section>
        </div>

        <footer className="flex items-center justify-between gap-4 border-t border-border px-7 py-5">
          <p className="text-xs text-muted-foreground">
            Change this anytime in Settings → Vim.
          </p>
          <div className="flex items-center gap-2">
            <button
              ref={primaryActionRef}
              type="button"
              onClick={onDismiss}
              className="vim-announcement-primary-action min-h-10 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              {primaryLabel}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
