import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2, Send } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Tooltip } from './Tooltip';
import { ActionMenuDivider, ActionMenuItem } from './ActionMenu';
import { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog';
import { useDismissablePopover } from '../hooks/useDismissablePopover';
import { useCompactTouchLayout } from '../hooks/useIsMobile';
import { submitHint } from '../utils/platform';
import { cn } from '../lib/utils';
import type {
  DecisionActionId,
  DecisionComposer,
  DecisionMenuItem,
  DecisionSpec,
  DecisionTone,
} from '../utils/decisionSpec';

/**
 * The unified header decision control: one joined split pill — the incumbent
 * primary on the left, a caret on the right whose popover carries the
 * alternate decisions and the in-place note composer. Rendered entirely from a
 * `DecisionSpec` (see `utils/decisionSpec.ts`); the host owns the handlers.
 *
 * NOT host-supported surface (like ActionMenu/ConfirmDialog): session/transport
 * chrome for Plannotator's own decision endpoints, deliberately absent from
 * the README supported-import list.
 *
 * Interaction contract (the load-bearing rules):
 * - The left segment never opens the popover and never changes meaning within
 *   a state; the caret owns the popover.
 * - Choosing a composer item MORPHS the same popover into the note composer —
 *   same element, children swap, never a second popover.
 * - Esc ladder: composer → back to the menu keeping the draft; menu → close,
 *   focus returns to the caret. The event is consumed (stopPropagation) on
 *   exactly those two rungs; with nothing open the host app's own Escape
 *   ladder still runs.
 * - Mod+Enter in the note field fires the composer's labelled action; plain
 *   Enter is a newline, always.
 * - An empty note never submits and never grays the action: the click
 *   refocuses the field instead.
 */
export type DecisionHandler = (note?: string) => void;

export interface DecisionControlProps {
  spec: DecisionSpec;
  handlers: Record<DecisionActionId, DecisionHandler>;
  /** isSubmitting || isExiting || isApproving — disables both segments and
   *  closes an open popover. */
  busy: boolean;
  /** Spinner on the primary only. */
  isLoading: boolean;
  labelBreakpoint?: 'md' | 'lg';
  /** The host says the surface is framed (raw-HTML srcdoc / live-app proxy):
   *  clicks inside the iframe never reach the parent document, so iframe
   *  focus dismisses the popover instead. */
  dismissOnIframeFocus?: boolean;
  /** Confirm surface override; defaults to the ui ConfirmDialog. */
  confirmDialog?: React.ComponentType<ConfirmDialogProps>;
}

const NOTE_MAX_HEIGHT_PX = 144;

const ICONS: Record<'check' | 'send', React.ReactNode> = {
  check: <Check className="size-3.5" />,
  send: <Send className="size-3.5" />,
};

function toneButtonVariant(tone: Exclude<DecisionTone, 'destructive'>): 'success' | 'default' {
  return tone === 'success' ? 'success' : 'default';
}

function itemToneClass(tone: DecisionTone): string | undefined {
  if (tone === 'destructive') return 'text-destructive';
  if (tone === 'success') return 'text-success';
  return undefined;
}

function useAutoGrow(text: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, NOTE_MAX_HEIGHT_PX)}px`;
  }, [text]);
  return ref;
}

export interface DecisionNoteFieldProps {
  text: string;
  onTextChange: (value: string) => void;
  /** Mod+Enter / the labelled action. The owner enforces the empty-note
   *  no-op-and-refocus rule, so this fires for any text. */
  onSubmit: () => void;
  /** Escape. Consumes the event; the owner decides what "back" means. */
  onCancel: () => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

/**
 * The shared multi-line note field: two rows at rest, grows to 144px, then
 * scrolls. Controlled — the owner keeps the text so stepping back does not
 * discard a half-typed note. Exported separately because a third consumer
 * (the review sidebar's "+ General comment") composes it outside the control.
 */
export const DecisionNoteField: React.FC<DecisionNoteFieldProps> = ({
  text,
  onTextChange,
  onSubmit,
  onCancel,
  placeholder = 'Add a note...',
  disabled = false,
  autoFocus = true,
}) => {
  const ref = useAutoGrow(text);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Escape') {
        // A consuming rung of the Esc ladder: the host apps run their own
        // Escape ladders and must not also see this event.
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        if (!disabled) onSubmit();
      }
      // Plain Enter falls through: the field is multi-line and Enter's job is
      // a newline.
    },
    [disabled, onCancel, onSubmit],
  );

  return (
    <textarea
      ref={ref}
      rows={2}
      value={text}
      onChange={(event) => onTextChange(event.target.value)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      aria-label={placeholder}
      data-decision-note-input="true"
      data-pn-mobile-editable
      disabled={disabled}
      className="block w-full resize-none overflow-y-auto rounded-md border border-border bg-background px-2.5 py-1.5 text-sm leading-snug text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring/40"
      style={{ maxHeight: NOTE_MAX_HEIGHT_PX }}
    />
  );
};

/**
 * The compact/touch note composer. The desktop composer morphs inside the
 * caret popover, which is the wrong shape on touch (the header menu popup
 * closes on outside pointerdown and its max-height fights the soft keyboard),
 * so compact rows open this dialog instead.
 */
export const DecisionNoteDialog: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  composer: DecisionComposer;
  onSubmit: (note: string) => void;
  disabled?: boolean;
  /** Free prose under the title, e.g. what the note rides along with. */
  subtitle?: string;
}> = ({ isOpen, onClose, composer, onSubmit, disabled = false, subtitle }) => {
  const isCompactTouchLayout = useCompactTouchLayout();
  const [text, setText] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);

  // If the surface goes busy while the dialog is open, close it rather than
  // leaving an editable field whose action can no longer do anything.
  useEffect(() => {
    if (disabled && isOpen) onClose();
  }, [disabled, isOpen, onClose]);

  const submit = useCallback(() => {
    if (disabled) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      // Same contract as the popover composer: the action stays full-strength
      // and an empty-note tap refocuses the field — on touch this also raises
      // the keyboard, which is what the tap was asking for.
      contentRef.current
        ?.querySelector<HTMLTextAreaElement>('[data-decision-note-input]')
        ?.focus();
      return;
    }
    onSubmit(trimmed);
    setText('');
    onClose();
  }, [disabled, onClose, onSubmit, text]);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        ref={contentRef}
        data-decision-note-composer="dialog"
        // Opening the sheet must not raise the touch keyboard on its own.
        initialFocus={isCompactTouchLayout ? false : undefined}
        className="max-w-md rounded-xl bg-card p-4 text-foreground"
      >
        <DialogTitle className="font-semibold mb-1">{composer.title}</DialogTitle>
        {subtitle ? (
          <DialogDescription className="text-sm text-muted-foreground mb-3">
            {subtitle}
          </DialogDescription>
        ) : null}
        <DecisionNoteField
          text={text}
          onTextChange={setText}
          onSubmit={submit}
          onCancel={onClose}
          placeholder={composer.placeholder}
          disabled={disabled}
          autoFocus={!isCompactTouchLayout}
        />
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[11px] leading-snug text-muted-foreground">{submitHint}</span>
          <Button
            variant={toneButtonVariant(composer.tone)}
            size="xs"
            data-decision-composer-send="true"
            onClick={submit}
            disabled={disabled}
            title={composer.actionLabel}
            iconLeft={composer.icon ? ICONS[composer.icon] : undefined}
          >
            {composer.actionLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

type PopoverState = null | 'menu' | 'composer';

export const DecisionControl: React.FC<DecisionControlProps> = ({
  spec,
  handlers,
  busy,
  isLoading,
  labelBreakpoint = 'md',
  dismissOnIframeFocus = false,
  confirmDialog,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);
  const [popover, setPopover] = useState<PopoverState>(null);
  const [activeItemId, setActiveItemId] = useState<DecisionMenuItem['id'] | null>(null);
  // Drafts are keyed per item so stepping back from a composer (Esc, back
  // button, even closing the popover) keeps the half-typed note.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // L2: only the ID is state — the confirm's title/message/handler resolve
  // from the LIVE spec at render, so a spec update while the dialog is up
  // can never confirm stale copy (e.g. an outdated count).
  const [confirmItemId, setConfirmItemId] = useState<DecisionMenuItem['id'] | null>(null);
  const confirmItem =
    confirmItemId !== null
      ? spec.items.find((item) => item.id === confirmItemId && item.confirm) ?? null
      : null;

  const activeItem =
    popover === 'composer' && activeItemId
      ? spec.items.find((item) => item.id === activeItemId) ?? null
      : null;

  const closePopover = useCallback((options?: { focusCaret?: boolean }) => {
    setPopover(null);
    setActiveItemId(null);
    if (options?.focusCaret) caretRef.current?.focus();
  }, []);

  // Outside-dismissal (outside pointerdown, iframe focus, or an Escape whose
  // focus has already left the control) closes the WHOLE popover, composer
  // included: the user's attention has left the control, so restoring the
  // intermediate menu rung would fight where they are — and the draft is kept
  // in `drafts` either way. The three-rung Esc ladder applies only while
  // focus is inside the popover (handlePopoverKeyDown / the note field).
  const dismiss = useCallback(() => closePopover(), [closePopover]);

  useDismissablePopover({
    enabled: popover !== null,
    ref: rootRef,
    onDismiss: dismiss,
    dismissOnIframeFocus,
  });

  // Busy = a decision is in flight: nothing in the popover can do anything
  // anymore, so it must not hang over a disabled pill.
  useEffect(() => {
    if (busy) {
      setPopover(null);
      setActiveItemId(null);
      setConfirmItemId(null);
    }
  }, [busy]);

  // F6: the spec is live — an annotation delete (or an external write) can
  // remove the item the open composer or confirm belongs to. Morph gracefully
  // instead of rendering a dead surface: both step back to the menu (the
  // composer draft is kept, keyed by item id, in case the item returns).
  // buildDecisionSpec guarantees at least one item, so the menu is always a
  // valid fallback (L4 ruling: no empty-menu branch for a spec shape that
  // cannot occur). Lives in the control rather than the adopting apps so the
  // annotate and review wirings cannot diverge on it.
  useEffect(() => {
    if (popover !== 'composer') return;
    const stillPresent =
      activeItemId !== null &&
      spec.items.some((item) => item.id === activeItemId && item.composer);
    if (stillPresent) return;
    setPopover('menu');
    setActiveItemId(null);
  }, [activeItemId, popover, spec]);

  useEffect(() => {
    if (confirmItemId === null) return;
    if (spec.items.some((item) => item.id === confirmItemId && item.confirm)) return;
    setConfirmItemId(null);
    setPopover('menu');
  }, [confirmItemId, spec]);

  // Roving focus entry point: whenever the menu (re)appears — caret click,
  // back from the composer, confirm cancel — focus its first row.
  useEffect(() => {
    if (popover !== 'menu') return;
    // :not(:disabled) — a muted (platform self-approval) row cannot take
    // focus, so land on the first live row instead.
    popoverRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
  }, [popover]);

  const selectItem = useCallback((item: DecisionMenuItem) => {
    if (item.composer) {
      setActiveItemId(item.id);
      setPopover('composer');
      return;
    }
    if (item.confirm) {
      // The confirm replaces the popover; cancel reopens the menu so one
      // decision stays one click away.
      setConfirmItemId(item.id);
      setPopover(null);
      return;
    }
    closePopover();
    handlers[item.id]?.();
  }, [closePopover, handlers]);

  const submitComposer = useCallback(() => {
    if (!activeItem) return;
    const trimmed = (drafts[activeItem.id] ?? '').trim();
    if (trimmed.length === 0) {
      // Empty note: the action stays visually enabled and the click puts the
      // cursor back in the field — never a disabled-gray submit.
      popoverRef.current
        ?.querySelector<HTMLTextAreaElement>('[data-decision-note-input]')
        ?.focus();
      return;
    }
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[activeItem.id];
      return next;
    });
    closePopover();
    handlers[activeItem.id]?.(trimmed);
  }, [activeItem, closePopover, drafts, handlers]);

  const backToMenu = useCallback(() => {
    setPopover('menu');
    setActiveItemId(null);
  }, []);

  const handlePopoverKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        // The two consuming rungs of the Esc ladder. (The note field consumes
        // its own Escape before it reaches here — same first rung.)
        event.preventDefault();
        event.stopPropagation();
        if (popover === 'composer') backToMenu();
        else closePopover({ focusCaret: true });
        return;
      }
      if (popover !== 'menu') return;
      const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      const items = Array.from(
        popoverRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
      );
      if (items.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      let next = 0;
      if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
      else if (event.key === 'ArrowUp') next = current <= 0 ? items.length - 1 : current - 1;
      else if (event.key === 'Home') next = 0;
      else next = items.length - 1;
      items[next]?.focus();
    },
    [backToMenu, closePopover, popover],
  );

  const primaryVariant = toneButtonVariant(spec.primary.tone);
  const Confirm = confirmDialog ?? ConfirmDialog;
  const mutedReasonId = useId();

  // Left segment — the incumbent primary. It never opens the popover and,
  // deliberately, never fades or disables while the popover is open: the
  // popover holds only ALTERNATE decisions, so the primary keeps its
  // meaning and stays clickable (reverses the held branches' fade, which
  // existed because their panel duplicated the primary's own action).
  const primaryButton = (
      <Button
        variant={primaryVariant}
        size="xs"
        onClick={() => {
          // Muted (platform self-approval, PR6 §3.4): the click is a no-op.
          // Deliberately NOT `disabled` — a disabled button would also lose
          // hover/focus, and the Tooltip below carries the reason.
          if (spec.primary.muted) return;
          handlers.primary?.();
        }}
        disabled={busy}
        aria-disabled={spec.primary.muted || undefined}
        // Muted: the reason renders as a real Tooltip (hover + keyboard
        // focus) and as an aria-describedby description — a native title on
        // top of that would double the tooltip.
        title={spec.primary.muted ? undefined : spec.primary.title}
        aria-describedby={spec.primary.muted ? mutedReasonId : undefined}
        data-decision-primary="true"
        iconLeft={
          isLoading
            ? <Loader2 className="size-3.5 animate-spin" />
            : spec.primary.icon ? ICONS[spec.primary.icon] : undefined
        }
        className={cn(
          'rounded-r-none border-r-0',
          // Same mute treatment the old platform ApproveButton wore.
          spec.primary.muted && 'opacity-40 cursor-not-allowed bg-muted text-muted-foreground hover:bg-muted',
        )}
      >
        {spec.primary.shortLabel ? (
          <>
            {/* Responsive spans copied from FeedbackButton so the toolbar
                width below xl is unchanged in review. */}
            <span className={labelBreakpoint === 'lg' ? 'hidden lg:inline xl:hidden' : 'hidden md:inline lg:hidden'}>
              {spec.primary.shortLabel}
            </span>
            <span className={labelBreakpoint === 'lg' ? 'hidden xl:inline' : 'hidden lg:inline'}>
              {spec.primary.label}
            </span>
          </>
        ) : (
          <span className={labelBreakpoint === 'lg' ? 'hidden lg:inline' : 'hidden md:inline'}>
            {spec.primary.label}
          </span>
        )}
        {typeof spec.primary.count === 'number' && (
          // The count is the state indicator, not decoration: present at every
          // breakpoint, unlike the labels.
          <span
            data-decision-count="true"
            className="rounded-full bg-white/25 px-1.5 text-[10px] font-bold leading-4"
          >
            {spec.primary.count}
          </span>
        )}
      </Button>
  );

  return (
    <div ref={rootRef} className="relative inline-flex">
      {spec.primary.muted ? (
        <>
          {/* The self-approval reason must be reachable by keyboard and AT,
              not just mouse hover: the Tooltip opens on hover AND
              focus-visible (Base UI wires floating-ui's useFocus on the
              trigger), and the hidden span makes the same sentence the
              button's persistent accessible description. */}
          <Tooltip content={spec.primary.title} side="bottom" wide>
            {primaryButton}
          </Tooltip>
          <span id={mutedReasonId} hidden>
            {spec.primary.title}
          </span>
        </>
      ) : (
        primaryButton
      )}

      {/* Right segment — the caret. */}
      <Button
        ref={caretRef}
        variant={primaryVariant}
        size="xs"
        onClick={() => {
          if (popover) closePopover();
          else setPopover('menu');
        }}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={popover !== null}
        aria-label="More decisions"
        data-decision-caret="true"
        className="rounded-l-none px-1.5"
      >
        <ChevronDown
          className={cn('size-3.5 transition-transform duration-150', popover && 'rotate-180')}
          aria-hidden="true"
        />
      </Button>

      {popover !== null && (
        // One popover element for both states: choosing a composer item swaps
        // the children in place (morph), never mounts a second popover.
        <div
          ref={popoverRef}
          role={popover === 'menu' ? 'menu' : undefined}
          data-decision-popover={popover}
          data-pn-dismissable-popover="true"
          onKeyDown={handlePopoverKeyDown}
          className="absolute right-0 top-full z-[70] mt-1.5 w-[22rem] max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover shadow-xl"
        >
          {popover === 'menu' ? (
            <div className="py-1">
              {spec.items.map((item) => (
                <React.Fragment key={item.id}>
                  {item.dividerBefore ? <ActionMenuDivider /> : null}
                  <ActionMenuItem
                    role="menuitem"
                    icon={item.icon ? ICONS[item.icon] : undefined}
                    label={item.label}
                    subtitle={item.subtitle}
                    // Muted (platform self-approval): the row disables with
                    // the reason already in its subtitle; sibling rows stay
                    // live so the menu is never a dead end.
                    disabled={item.muted}
                    className={itemToneClass(item.tone)}
                    onClick={() => selectItem(item)}
                  />
                </React.Fragment>
              ))}
            </div>
          ) : activeItem?.composer ? (
            <div className="p-2">
              <button
                type="button"
                data-decision-composer-back="true"
                onClick={backToMenu}
                className="mb-1.5 flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronDown className="size-3 rotate-90" aria-hidden="true" />
                {activeItem.composer.title}
              </button>
              <DecisionNoteField
                text={drafts[activeItem.id] ?? ''}
                onTextChange={(value) =>
                  setDrafts((prev) => ({ ...prev, [activeItem.id]: value }))
                }
                onSubmit={submitComposer}
                onCancel={backToMenu}
                placeholder={activeItem.composer.placeholder}
              />
              <div className="mt-2 flex items-center justify-between gap-2 px-0.5">
                <span className="text-[11px] leading-snug text-muted-foreground">
                  {submitHint} send · Esc back, note kept
                </span>
                <Button
                  variant={toneButtonVariant(activeItem.composer.tone)}
                  size="xs"
                  data-decision-composer-send="true"
                  onClick={submitComposer}
                  title={activeItem.composer.actionLabel}
                  iconLeft={activeItem.composer.icon ? ICONS[activeItem.composer.icon] : undefined}
                >
                  {activeItem.composer.actionLabel}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {confirmItem?.confirm && (
        <Confirm
          isOpen
          onClose={() => {
            setConfirmItemId(null);
            setPopover('menu');
          }}
          onConfirm={() => {
            const id = confirmItem.id;
            setConfirmItemId(null);
            handlers[id]?.();
          }}
          title={confirmItem.confirm.title}
          message={confirmItem.confirm.message}
          confirmText={confirmItem.confirm.confirmText}
          cancelText="Cancel"
          variant="warning"
          showCancel
        />
      )}
    </div>
  );
};
