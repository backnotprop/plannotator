import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { ImageAttachment } from '../types';
import { AttachmentsButton } from './AttachmentsButton';
import { submitHint } from '../utils/platform';
import { useDraggable } from '../hooks/useDraggable';
import { SparklesIcon } from './SparklesIcon';
import { hasUnsavedCommentContent } from '../utils/commentContent';
import { useSkillReferenceAutocomplete } from '../hooks/useSkillReferenceAutocomplete';
import { HumanOnlySkillNotice, SkillReferenceMenu } from './SkillReferenceMenu';
import type { SkillReferenceToken } from '../utils/skillReferences';

export interface CommentAskAIContext {
  kind: 'general' | 'selection';
  label?: string;
  text?: string;
  sourcePath?: string;
}

export type CommentAskAIHandler = (
  question: string,
  context: CommentAskAIContext,
) => boolean | void | Promise<boolean | void>;

/** One selected target of a multi-target draft comment (HTML pinpoint multi-select). */
export interface CommentTargetChip {
  key: string;
  /** Semantic label (hover-label cascade), e.g. "Button" / "rowchip". */
  label?: string;
  /** Short text excerpt of the target element. */
  excerpt: string;
}

/** Composer-yield stage while the user is shift-selecting (see composerYield.ts). */
export type CommentPopoverYieldState = 'none' | 'near' | 'over';

interface CommentPopoverProps {
  /** Element to anchor the popover near (re-reads position on scroll) */
  anchorEl?: HTMLElement;
  /** Static viewport rect to anchor near when no stable DOM element exists */
  anchorRect?: DOMRect;
  /** Truncated selected text shown in header, or empty for global */
  contextText: string;
  /** Whether this is a global comment */
  isGlobal: boolean;
  /** Pre-filled text (for type-to-comment) */
  initialText?: string;
  /** Called on submit with comment text and optional images */
  onSubmit: (text: string, images?: ImageAttachment[]) => void;
  /** Optional live draft observer for submit paths outside the popover. */
  onDraftChange?: (text: string, images?: ImageAttachment[]) => void;
  /** Called when popover is closed/cancelled */
  onClose: () => void;
  /** Opt-in: persist text + images across close/reopen, keyed by this string. Cleared on submit. */
  draftKey?: string;
  /** Whether image attachments are available in this comment surface. */
  allowImages?: boolean;
  /** Whether submitting empty text is allowed, for editors that support clearing. */
  allowEmptySubmit?: boolean;
  /** Optional Ask AI action. Absent by default so existing comment surfaces are unchanged. */
  onAskAI?: CommentAskAIHandler;
  askAIContext?: CommentAskAIContext;
  askAIDisabled?: boolean;
  /** Opt-in: `/` and `$` skill-reference autocomplete (document UI surfaces). Off by default. */
  skillReferences?: boolean;
  /** Opt-in (HTML multi-select): selected targets rendered as horizontally
   *  scrollable chips above the textarea. Absent → byte-identical composer. */
  targetChips?: CommentTargetChip[];
  /** Remove a chip's target while composing. */
  onRemoveTargetChip?: (key: string) => void;
  /** Chip hover — host flashes the corresponding element in the page. */
  onHoverTargetChip?: (key: string) => void;
  /** Opt-in: bump to return focus to the textarea (after a shift-click add/remove). */
  refocusToken?: number;
  /** Opt-in: while open, a window-level printable keydown that would otherwise
   *  go nowhere (focus on <body>) routes into the textarea, so the first
   *  keystroke after a shift-click is never lost. */
  captureStrayKeys?: boolean;
  /** Opt-in composer yield while shift-selecting: 'near' fades the composer,
   *  'over' makes it near-invisible and click-through. Undefined → no-op. */
  yieldState?: CommentPopoverYieldState;
}

const MAX_POPOVER_WIDTH = 384;
const GAP = 8;

// Module-level draft store: survives popover unmount so reopening the same key restores in-progress text.
const draftStore = new Map<string, { text: string; images: ImageAttachment[] }>();

/** Mirrors the latest text + images into `draftStore[draftKey]` so they outlive popover unmount. No-op without a key. */
function useCommentDraftSync(draftKey: string | undefined, text: string, images: ImageAttachment[]) {
  useEffect(() => {
    if (!draftKey) return;
    if (hasUnsavedCommentContent(text, images)) {
      draftStore.set(draftKey, { text, images });
    } else {
      draftStore.delete(draftKey);
    }
  }, [draftKey, text, images]);
}

function computePosition(anchorRect: DOMRect): { top: number; left: number; flipAbove: boolean; width: number } {
  const spaceBelow = window.innerHeight - anchorRect.bottom;
  const flipAbove = spaceBelow < 280;
  const width = Math.min(MAX_POPOVER_WIDTH, window.innerWidth - 32);

  const top = flipAbove
    ? anchorRect.top - GAP
    : anchorRect.bottom + GAP;

  let left = anchorRect.left + anchorRect.width / 2 - width / 2;
  left = Math.max(16, Math.min(left, window.innerWidth - width - 16));

  return { top, left, flipAbove, width };
}

export const CommentPopover: React.FC<CommentPopoverProps> = ({
  anchorEl,
  anchorRect,
  contextText,
  isGlobal,
  initialText = '',
  onSubmit,
  onDraftChange,
  onClose,
  draftKey,
  allowImages = true,
  allowEmptySubmit = false,
  onAskAI,
  askAIContext,
  askAIDisabled = false,
  skillReferences = false,
  targetChips,
  onRemoveTargetChip,
  onHoverTargetChip,
  refocusToken,
  captureStrayKeys = false,
  yieldState,
}) => {
  const [mode, setMode] = useState<'popover' | 'dialog'>('popover');
  const initialDraft = draftKey ? draftStore.get(draftKey) : undefined;
  const [text, setText] = useState(initialDraft?.text ?? initialText);
  const [images, setImages] = useState<ImageAttachment[]>(allowImages ? initialDraft?.images ?? [] : []);
  const [position, setPosition] = useState<{ top: number; left: number; flipAbove: boolean; width: number } | null>(null);
  // Direction of an open popover that has scrolled out of view, or null when on-screen.
  const [offscreen, setOffscreen] = useState<'above' | 'below' | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const hasUnsavedContent = hasUnsavedCommentContent(text, allowImages ? images : []);
  const hasUnsavedContentRef = useRef(hasUnsavedContent);
  hasUnsavedContentRef.current = hasUnsavedContent;
  const { dragPosition, dragHandleProps, wasDragged, reset: resetDrag } = useDraggable(popoverRef);

  useEffect(() => {
    const nextDraft = draftKey ? draftStore.get(draftKey) : undefined;
    setText(nextDraft?.text ?? initialText);
    setImages(allowImages ? nextDraft?.images ?? [] : []);
  }, [draftKey, initialText, allowImages]);

  useCommentDraftSync(draftKey, text, allowImages ? images : []);

  useEffect(() => {
    onDraftChange?.(text, allowImages ? images : undefined);
  }, [allowImages, images, onDraftChange, text]);

  // Reset drag when anchor changes (new annotation) or mode switches
  useEffect(() => { resetDrag(); }, [anchorEl, anchorRect, resetDrag]);
  useEffect(() => { if (mode === 'popover') resetDrag(); }, [mode, resetDrag]);

  // Track anchor position on scroll/resize (popover mode only, not after user drag)
  useEffect(() => {
    if (mode !== 'popover' || wasDragged) return;

    const update = () => {
      const rect = anchorEl?.getBoundingClientRect() ?? anchorRect;
      if (rect) setPosition(computePosition(rect));
    };

    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [anchorEl, anchorRect, mode, wasDragged]);

  // Surface a "jump back" arrow when an open popover scrolls out of view.
  // Re-measures whenever the popover repositions (position updates every scroll
  // step in tracked mode) so the indicator is accurate at rest, plus on resize.
  useEffect(() => {
    if (mode !== 'popover') { setOffscreen(null); return; }
    const measure = () => {
      const el = popoverRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.bottom < 8) setOffscreen('above');
      else if (rect.top > window.innerHeight - 8) setOffscreen('below');
      else setOffscreen(null);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [position, dragPosition, mode]);

  const scrollToPopover = useCallback(() => {
    anchorEl?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [anchorEl]);

  // Focus the textarea when it mounts (initial open and popover/dialog switches).
  // A ref callback rather than a mount effect: in popover mode the textarea only
  // renders after `position` is measured, and WebKit fires 0ms timers ahead of
  // that commit, so an effect keyed on mode alone can run before the textarea
  // exists and never focus it (e.g. in WKWebView hosts like Glimpse).
  const focusOnMountRef = useCallback((el: HTMLTextAreaElement | null) => {
    textareaRef.current = el;
    if (!el) return;
    setTimeout(() => {
      if (!el.isConnected) return;
      el.focus();
      el.selectionStart = el.selectionEnd = el.value.length;
    }, 0);
  }, []);

  // Click-outside for popover mode
  useEffect(() => {
    if (mode !== 'popover') return;

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      // Don't close if clicking inside a child portal (AttachmentsButton, ImageAnnotator, etc.)
      const el = target as HTMLElement;
      if (el.closest?.('[data-popover-layer]')) return;
      if (hasUnsavedContentRef.current) return;
      onClose();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [mode, onClose]);

  // Focus choreography (multi-select): after a shift-click adds/removes a
  // target, focus returns to the textarea so typing continues uninterrupted.
  // Focus only — the caret stays wherever the user left it mid-edit.
  const refocusSeenRef = useRef(refocusToken);
  useEffect(() => {
    if (refocusToken === undefined || refocusToken === refocusSeenRef.current) return;
    refocusSeenRef.current = refocusToken;
    textareaRef.current?.focus();
  }, [refocusToken]);

  // First-keystroke guard: while the draft is open, a printable keydown that
  // lands nowhere (focus fell back to <body> after an iframe interaction)
  // routes into the textarea instead of vanishing. Runs in capture phase so
  // it claims the key before the app's shortcut dispatcher; the character
  // lands at the textarea's remembered caret. Note that preventDefault here
  // does not stop the dispatcher (it deliberately ignores defaultPrevented,
  // see shortcuts/runtime.ts) — this guard is only safe because the
  // plan-review scopes bind no bare printable single key. Any future single-
  // key binding on this surface must be reconciled with this handler.
  useEffect(() => {
    if (!captureStrayKeys) return;
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!e.key || e.key.length !== 1) return;
      const target = e.target;
      const strayed =
        target === null
        || target === document.body
        || target === document.documentElement;
      if (!strayed) return;
      const el = textareaRef.current;
      if (!el || document.activeElement === el) return;
      e.preventDefault();
      const key = e.key;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      setText((prev) => prev.slice(0, start) + key + prev.slice(end));
      el.focus();
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + 1;
      });
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [captureStrayKeys]);

  // Composer yield (multi-select): fade near the pointer, click-through over
  // it. Class-driven so prefers-reduced-motion can kill the transition.
  const yieldClass = yieldState === undefined
    ? ''
    : ` pn-composer-yieldable${yieldState === 'over' ? ' pn-composer-yield-over' : yieldState === 'near' ? ' pn-composer-yield-near' : ''}`;
  const yieldStyleBlock = yieldState === undefined ? null : (
    <style>{`
      .pn-composer-yieldable { transition: opacity 180ms ease; }
      @media (prefers-reduced-motion: reduce) {
        .pn-composer-yieldable { transition: none; }
      }
      .pn-composer-yield-near { opacity: 0.4; }
      .pn-composer-yield-over { opacity: 0.05; pointer-events: none; }
    `}</style>
  );

  // Selected-target chips (multi-select): horizontally scrollable, primary
  // first; each removable while composing.
  const chipsRow = targetChips && targetChips.length > 0 ? (
    <div
      data-target-chips="true"
      className="flex items-center gap-1.5 px-3 pt-2 overflow-x-auto whitespace-nowrap"
    >
      {targetChips.map((chip, i) => (
        <span
          key={chip.key}
          data-target-chip={chip.key}
          data-target-chip-primary={i === 0 ? 'true' : undefined}
          onMouseEnter={() => onHoverTargetChip?.(chip.key)}
          className={`inline-flex items-center gap-1 shrink-0 max-w-[180px] rounded-full border px-2 py-0.5 text-[10px] ${
            i === 0
              ? 'border-primary/50 bg-primary/10 text-foreground'
              : 'border-border bg-muted/50 text-muted-foreground'
          }`}
        >
          <span className="font-semibold text-primary">{chip.label || 'Element'}</span>
          <span className="truncate">{chip.excerpt}</span>
          {onRemoveTargetChip && (
            <button
              type="button"
              data-target-chip-remove={chip.key}
              onClick={() => onRemoveTargetChip(chip.key)}
              title="Remove this target"
              className="shrink-0 rounded-full p-0.5 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </span>
      ))}
    </div>
  ) : null;

  const handleSubmit = useCallback(() => {
    const canSubmitEmpty = allowEmptySubmit && initialText.trim().length > 0;
    if (hasUnsavedContent || canSubmitEmpty) {
      if (draftKey) draftStore.delete(draftKey);
      onSubmit(text, allowImages && images.length > 0 ? images : undefined);
    }
  }, [text, images, onSubmit, draftKey, allowImages, allowEmptySubmit, initialText, hasUnsavedContent]);

  const handleAskAI = useCallback(async () => {
    const question = text.trim();
    if (!question || !onAskAI) {
      textareaRef.current?.focus();
      return;
    }
    let accepted: boolean | void;
    try {
      accepted = await onAskAI(question, askAIContext ?? {
        kind: isGlobal ? 'general' : 'selection',
        text: contextText,
      });
    } catch (error) {
      console.error('Ask AI action failed:', error);
      textareaRef.current?.focus();
      return;
    }
    if (accepted === false) {
      textareaRef.current?.focus();
      return;
    }
    if (draftKey) draftStore.delete(draftKey);
    onDraftChange?.('', allowImages ? [] : undefined);
    onClose();
  }, [allowImages, askAIContext, contextText, draftKey, isGlobal, onAskAI, onClose, onDraftChange, text]);

  const skillAc = useSkillReferenceAutocomplete({
    text,
    setText,
    textareaRef,
    enabled: skillReferences,
  });

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (skillAc.onKeyDown(e)) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (mode === 'dialog') {
        setMode('popover');
      } else {
        onClose();
      }
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const headerLabel = isGlobal
    ? 'Global Comment'
    : contextText
      ? `"${contextText.length > 50 ? contextText.slice(0, 50) + '...' : contextText}"`
      : 'Comment';

  const canSubmit =
    hasUnsavedContent ||
    (allowEmptySubmit && initialText.trim().length > 0);
  const canAskAI = !!onAskAI && !askAIDisabled && text.trim().length > 0;

  if (mode === 'dialog') {
    return createPortal(
      <div data-comment-popover="true" className="fixed inset-0 z-[100] flex items-center justify-center p-4">
        {/* Backdrop */}
        <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" />

        {/* Dialog card */}
        {/* The expanded dialog deliberately does not yield: it is an explicit
            full-screen compose surface, and its backdrop wrapper (which carries
            data-comment-popover) spans the viewport, so proximity is
            meaningless there. */}
        <div
          ref={popoverRef}
          className="relative w-full max-w-xl bg-popover border border-border rounded-xl shadow-2xl flex flex-col"
          style={{
            animation: 'comment-dialog-in 0.15s ease-out',
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <style>{`
            @keyframes comment-dialog-in {
              from { opacity: 0; transform: scale(0.95); }
              to { opacity: 1; transform: scale(1); }
            }
          `}</style>

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
            <span className="text-xs text-muted-foreground truncate max-w-[400px]">
              {headerLabel}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setMode('popover')}
                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                title="Collapse"
              >
                <CollapseIcon />
              </button>
              <button
                onClick={onClose}
                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                title="Close"
              >
                <CloseIcon />
              </button>
            </div>
          </div>

          {chipsRow}

          {/* Textarea */}
          <div className="relative px-4 py-3 flex-1">
            {skillAc.menu && (
              <SkillReferenceMenu
                items={skillAc.menu.items}
                activeIndex={skillAc.menu.activeIndex}
                onSelect={skillAc.select}
              />
            )}
            <ComposerTextarea
              textareaRef={focusOnMountRef}
              value={text}
              onChange={(e) => { setText(e.target.value); skillAc.onSelect(); }}
              onKeyDown={handleKeyDown}
              onSelectCaret={skillAc.onSelect}
              placeholder={isGlobal ? 'Add a global comment...' : 'Add a comment...'}
              sizeClassName="min-h-48 max-h-96"
              skillReferences={skillReferences}
              tokens={skillAc.referenceTokens}
            />
            <HumanOnlySkillNotice skills={skillAc.humanOnlyReferences} />
          </div>

          {/* Footer — DOM order sets tab order (Save first); row-reverse keeps the visual layout unchanged */}
          <div className="flex flex-row-reverse items-center justify-between px-4 py-3 border-t border-border/50">
            <div className="flex flex-row-reverse items-center gap-3">
              <button
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
              >
                {isGlobal ? 'Add' : 'Save'}
              </button>
              <span className="text-[10px] text-muted-foreground">{submitHint}</span>
              {onAskAI && (
                <button
                  onClick={handleAskAI}
                  disabled={!canAskAI}
                  className="inline-flex items-center gap-1 px-2 py-1.5 text-xs font-medium rounded-md text-muted-foreground hover:text-primary hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  title={canAskAI ? 'Ask AI this question' : 'Type a question to ask AI'}
                >
                  <SparklesIcon className="w-3 h-3" />
                  Ask AI
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {allowImages && (
                <AttachmentsButton
                  images={images}
                  onAdd={(img) => setImages((prev) => [...prev, img])}
                  onRemove={(path) => setImages((prev) => prev.filter((i) => i.path !== path))}
                  variant="inline"
                />
              )}
            </div>
          </div>
        </div>
      </div>,
      document.body
    );
  }

  // Popover mode
  if (!position) return null;

  return createPortal(
    <>
      {offscreen && (
        <button
          type="button"
          data-popover-layer="true"
          onClick={scrollToPopover}
          title="Scroll back to your open comment"
          className={`fixed left-1/2 -translate-x-1/2 z-[101] flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-popover border border-border shadow-lg text-xs text-muted-foreground hover:text-foreground transition-colors ${offscreen === 'above' ? 'top-3' : 'bottom-3'}`}
        >
          {offscreen === 'above' ? <ChevronUpIcon /> : <ChevronDownIcon />}
          <span>Open comment</span>
        </button>
      )}
      <div
        ref={popoverRef}
        data-comment-popover="true"
      className={`fixed z-[100] bg-popover border border-border rounded-xl shadow-2xl flex flex-col${yieldClass}`}
      style={dragPosition
        ? { top: dragPosition.top, left: dragPosition.left, width: position.width }
        : {
            top: position.top,
            left: position.left,
            width: position.width,
            ...(position.flipAbove ? { transform: 'translateY(-100%)' } : {}),
            animation: position.flipAbove
              ? 'comment-popover-in-above 0.15s ease-out'
              : 'comment-popover-in 0.15s ease-out',
          }
      }
      onPointerDown={(e) => e.stopPropagation()}
    >
      <style>{`
        @keyframes comment-popover-in {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes comment-popover-in-above {
          from { opacity: 0; transform: translateY(-100%) translateY(8px); }
          to { opacity: 1; transform: translateY(-100%); }
        }
      `}</style>
      {yieldStyleBlock}

      {/* Header (draggable) */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/50" {...dragHandleProps}>
        <span className="text-xs text-muted-foreground truncate max-w-[260px]">
          {headerLabel}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setMode('dialog')}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="Expand"
          >
            <ExpandIcon />
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="Close"
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      {chipsRow}

      {/* Textarea */}
      <div className="relative px-3 py-2">
        {skillAc.menu && (
          <SkillReferenceMenu
            items={skillAc.menu.items}
            activeIndex={skillAc.menu.activeIndex}
            onSelect={skillAc.select}
          />
        )}
        <ComposerTextarea
          textareaRef={focusOnMountRef}
          value={text}
          onChange={(e) => { setText(e.target.value); skillAc.onSelect(); }}
          onKeyDown={handleKeyDown}
          onSelectCaret={skillAc.onSelect}
          placeholder={isGlobal ? 'Add a global comment...' : 'Add a comment...'}
          sizeClassName="max-h-64 min-h-[4.5rem]"
          skillReferences={skillReferences}
          tokens={skillAc.referenceTokens}
        />
        <HumanOnlySkillNotice skills={skillAc.humanOnlyReferences} />
      </div>

      {/* Footer — same DOM-order/row-reverse pattern as the dialog footer above */}
      <div className="flex flex-row-reverse items-center justify-between px-3 py-2 border-t border-border/50">
        <div className="flex flex-row-reverse items-center gap-3">
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
          >
            {isGlobal ? 'Add' : 'Save'}
          </button>
          <span className="text-[10px] text-muted-foreground">{submitHint}</span>
          {onAskAI && (
            <button
              onClick={handleAskAI}
              disabled={!canAskAI}
              className="inline-flex items-center gap-1 px-2 py-1.5 text-xs font-medium rounded-md text-muted-foreground hover:text-primary hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title={canAskAI ? 'Ask AI this question' : 'Type a question to ask AI'}
            >
              <SparklesIcon className="w-3 h-3" />
              Ask AI
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {allowImages && (
            <AttachmentsButton
              images={images}
              onAdd={(img) => setImages((prev) => [...prev, img])}
              onRemove={(path) => setImages((prev) => prev.filter((i) => i.path !== path))}
              variant="inline"
            />
          )}
        </div>
      </div>
      </div>
    </>,
    document.body
  );
};

// ---------------------------------------------------------------------------
// Composer textarea with skill-reference token highlighting
// ---------------------------------------------------------------------------

/** Classes shared by the textarea and its highlight mirror — font, size,
 * and box metrics MUST stay identical or the overlay drifts out of alignment. */
const COMPOSER_TEXT_CLASSES = 'w-full bg-transparent text-sm px-1 py-0.5';

interface ComposerTextareaProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Caret observer (skill autocomplete). */
  onSelectCaret: () => void;
  placeholder: string;
  /** Mode-specific min/max height classes. */
  sizeClassName: string;
  textareaRef: (el: HTMLTextAreaElement | null) => void;
  /** Positioned skill-reference occurrences to highlight. */
  tokens: SkillReferenceToken[];
  /** Off → render the plain pre-feature textarea, byte-for-byte. */
  skillReferences: boolean;
}

/**
 * The composer's textarea. With `skillReferences` off this is exactly the
 * pre-feature `<textarea>`; with it on, inserted skill-reference tokens are
 * highlighted via a mirrored, aria-hidden overlay rendered BEHIND a
 * transparent-text textarea (a textarea cannot style substrings). The overlay
 * shares the exact font/padding/wrapping metrics and mirrors scroll position,
 * and token spans change ONLY color/background (never font or weight), so the
 * glyphs the browser lays out in the textarea and the glyphs the overlay
 * paints coincide. During IME composition the overlay hides and the textarea
 * text becomes visible again (`.pn-ref-composing`), keeping native
 * composition rendering (underlines, candidate highlights) intact.
 */
const ComposerTextarea: React.FC<ComposerTextareaProps> = ({
  value,
  onChange,
  onKeyDown,
  onSelectCaret,
  placeholder,
  sizeClassName,
  textareaRef,
  tokens,
  skillReferences,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [composing, setComposing] = useState(false);

  const syncScroll = useCallback((el: HTMLTextAreaElement) => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.scrollTop = el.scrollTop;
    overlay.scrollLeft = el.scrollLeft;
  }, []);

  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const attachRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      innerRef.current = el;
      textareaRef(el);
    },
    [textareaRef],
  );

  // Keep the mirror aligned when the value changes without a scroll event
  // (e.g. programmatic insertion moving the caret into a scrolled region).
  useEffect(() => {
    if (innerRef.current) syncScroll(innerRef.current);
  }, [value, syncScroll]);

  if (!skillReferences) {
    return (
      <textarea
        ref={attachRef}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onSelect={onSelectCaret}
        placeholder={placeholder}
        className={`${COMPOSER_TEXT_CLASSES} placeholder:text-muted-foreground resize-none focus:outline-none ${sizeClassName}`}
        style={{ fieldSizing: 'content' } as React.CSSProperties}
      />
    );
  }

  const segments: React.ReactNode[] = [];
  let pos = 0;
  tokens.forEach((token, i) => {
    if (token.start < pos || token.end > value.length) return; // stale tokens for a different value
    if (token.start > pos) segments.push(value.slice(pos, token.start));
    // Human-only tokens carry a quiet dotted underline as their inline marker
    // (text-decoration never affects glyph layout, so overlay alignment is
    // safe). The accessible explanation lives in HumanOnlySkillNotice below
    // the textarea — this overlay is aria-hidden.
    segments.push(
      <span
        key={`${token.start}-${i}`}
        data-skill-ref-token={token.entry.name}
        data-skill-ref-human-only={token.entry.humanOnly ? 'true' : undefined}
        className={`text-primary bg-primary/10 rounded-[3px] ${
          token.entry.humanOnly
            ? 'underline decoration-dotted decoration-primary/60 underline-offset-2'
            : ''
        }`}
      >
        {value.slice(token.start, token.end)}
      </span>,
    );
    pos = token.end;
  });
  segments.push(value.slice(pos));

  return (
    <div className="relative">
      <div
        ref={overlayRef}
        aria-hidden="true"
        data-skill-ref-overlay="true"
        className={`${COMPOSER_TEXT_CLASSES} ${sizeClassName} pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words`}
        style={composing ? { visibility: 'hidden' } : undefined}
      >
        {segments}
        {'\n'}
      </div>
      <textarea
        ref={attachRef}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onSelect={onSelectCaret}
        onScroll={(e) => syncScroll(e.currentTarget)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        placeholder={placeholder}
        className={`${COMPOSER_TEXT_CLASSES} placeholder:text-muted-foreground resize-none focus:outline-none relative pn-ref-input ${
          composing ? 'pn-ref-composing' : ''
        } ${sizeClassName}`}
        style={{ fieldSizing: 'content' } as React.CSSProperties}
      />
    </div>
  );
};

// Icons

const ChevronUpIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
  </svg>
);

const ChevronDownIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
  </svg>
);

const ExpandIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
  </svg>
);

const CollapseIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
  </svg>
);

const CloseIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
  </svg>
);
