import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2, Send } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Tooltip } from './Tooltip';
import { ActionMenuDivider, ActionMenuItem } from './ActionMenu';
import { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog';
import { useDismissablePopover } from '../hooks/useDismissablePopover';
import { useCompactTouchLayout } from '../hooks/useIsMobile';
import { cn } from '../lib/utils';
import { isCommentSubmitKey } from '../utils/commentSubmitKey';
import type {
  DecisionActionId,
  DecisionComposer,
  DecisionMenuItem,
  DecisionSpec,
  DecisionTone,
} from '../utils/decisionSpec';

/** The unified header decision control: one joined split pill — the incumbent primary on the left. */
export type DecisionHandler = (note?: string) => void;

export interface DecisionControlProps {
  spec: DecisionSpec;
  handlers: Record<DecisionActionId, DecisionHandler>;
  busy: boolean;
  isLoading: boolean;
  labelBreakpoint?: 'md' | 'lg';
  dismissOnIframeFocus?: boolean;
  confirmDialog?: React.ComponentType<ConfirmDialogProps>;
  menuFooter?: React.ReactNode | ((api: { closeMenu: () => void }) => React.ReactNode);
  drafts?: Record<string, string>;
  onDraftsChange?: (drafts: Record<string, string>) => void;
  openNoteRequest?: number;
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
  onSubmit: () => void;
  onCancel: () => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  enterSubmits?: boolean;
}

/**
 * Exported separately because a third consumer (the review sidebar's "+ Global comment")
 * composes it outside the control.
 */
export const DecisionNoteField: React.FC<DecisionNoteFieldProps> = ({
  text,
  onTextChange,
  onSubmit,
  onCancel,
  placeholder = 'Add a note...',
  disabled = false,
  autoFocus = true,
  enterSubmits = false,
}) => {
  const ref = useAutoGrow(text);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }
      if (enterSubmits ? isCommentSubmitKey(event, true) : event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        if (!disabled) onSubmit();
      }
      // Otherwise plain Enter falls through: the field is multi-line and
      // Enter's job is a newline.
    },
    [disabled, enterSubmits, onCancel, onSubmit],
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

/** The compact/touch note composer. */
export const DecisionNoteDialog: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  composer: DecisionComposer;
  onSubmit: (note: string) => void;
  disabled?: boolean;
  subtitle?: string;
}> = ({ isOpen, onClose, composer, onSubmit, disabled = false, subtitle }) => {
  const isCompactTouchLayout = useCompactTouchLayout();
  const [text, setText] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (disabled && isOpen) onClose();
  }, [disabled, isOpen, onClose]);

  const submit = useCallback(() => {
    if (disabled) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      // Same contract as the popover composer: the action stays full-strength and an empty-note
      // tap refocuses the field — on touch this also raises the keyboard, which is what the tap
      // was asking for.
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
        <div className="mt-3 flex items-center justify-end gap-2">
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
  menuFooter,
  drafts: hostDrafts,
  onDraftsChange,
  openNoteRequest,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);
  const [popover, setPopover] = useState<PopoverState>(null);
  const [activeItemId, setActiveItemId] = useState<DecisionMenuItem['id'] | null>(null);
  const [ownDrafts, setOwnDrafts] = useState<Record<string, string>>({});
  const hostHolds = hostDrafts !== undefined && onDraftsChange !== undefined;
  const drafts = hostHolds ? hostDrafts : ownDrafts;
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const setDrafts = useCallback(
    (next: (prev: Record<string, string>) => Record<string, string>) => {
      if (!hostHolds) {
        setOwnDrafts(next);
        return;
      }
      draftsRef.current = next(draftsRef.current);
      onDraftsChange(draftsRef.current);
    },
    [hostHolds, onDraftsChange],
  );
  // L2: only the ID is state — the confirm's title/message/handler resolve from the LIVE spec at
  // render, so a spec update while the dialog is up can never confirm stale copy (e.g. an outdated
  // count).
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
      setConfirmItemId(item.id);
      setPopover(null);
      return;
    }
    closePopover();
    handlers[item.id]?.();
  }, [closePopover, handlers]);

  useEffect(() => {
    if (!openNoteRequest || busy) return;
    const item = spec.items.find((candidate) => candidate.composer && !candidate.muted);
    if (item) selectItem(item);
    // Only a new request opens the composer, never a spec or busy change.
  }, [openNoteRequest]);

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
    if (!hostHolds) {
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[activeItem.id];
        return next;
      });
    }
    closePopover();
    handlers[activeItem.id]?.(trimmed);
  }, [activeItem, closePopover, drafts, handlers, hostHolds, setDrafts]);

  const backToMenu = useCallback(() => {
    setPopover('menu');
    setActiveItemId(null);
  }, []);

  const handlePopoverKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
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
        popoverRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)',
        ) ?? [],
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

  const primaryButton = (
      <Button
        variant={primaryVariant}
        size="xs"
        onClick={() => {
          // Deliberately NOT `disabled` — a disabled button would also lose hover/focus, and the
          // Tooltip below carries the reason.
          if (spec.primary.muted) return;
          handlers.primary?.();
        }}
        disabled={busy}
        aria-disabled={spec.primary.muted || undefined}
        // Muted: the reason renders as a real Tooltip (hover + keyboard focus) and as an
        // aria-describedby description — a native title on top of that would double the tooltip.
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
          // One control with its caret, which stays live: quiet words on the same fill, never half of a coloured pill.
          spec.primary.muted && 'cursor-not-allowed bg-muted text-muted-foreground [@media(hover:hover)_and_(pointer:fine)]:hover:bg-muted',
        )}
      >
        {spec.primary.shortLabel ? (
          <>
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
      </Button>
  );

  return (
    <div ref={rootRef} className="relative inline-flex">
      {spec.primary.muted ? (
        <>
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
        className={cn('rounded-l-none px-1.5', spec.primary.muted && 'bg-muted text-foreground [@media(hover:hover)_and_(pointer:fine)]:hover:bg-muted/70')}
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
                    disabled={item.muted}
                    className={itemToneClass(item.tone)}
                    onClick={() => selectItem(item)}
                  />
                </React.Fragment>
              ))}
              {typeof menuFooter === 'function'
                ? menuFooter({ closeMenu: () => closePopover() })
                : menuFooter}
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
              <div className="mt-2 flex items-center justify-end gap-2 px-0.5">
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
