import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useSyncExternalStore } from "react";
import { AnnotationType } from "../types";
import { createPortal } from "react-dom";
import { useDismissOnOutsideAndEscape } from "../hooks/useDismissOnOutsideAndEscape";
import { type QuickLabel, getQuickLabels, quickLabelIndexForDigit, THUMBS_UP_LABEL } from "../utils/quickLabels";
import { copyTextToClipboard } from "../utils/clipboard";
import { copyRichSelection, richCopyOutcomeLabel, type RichCopyOutcome, type RichCopySource } from "../utils/richClipboard";
import { acquireTypeToCommentCapture } from "../shortcuts/plan-review/annotationMode.shortcuts";
import { FloatingQuickLabelPicker } from "./FloatingQuickLabelPicker";
import { FloatingSelectionActionsPicker } from "./SelectionActionsDropdown";
import { buildSelectionActionContext, type SelectionAction } from "../utils/selectionActions";
import { HostTitle } from './HostTitle';
import { TOUCH_PRIMARY_QUERY } from "../utils/touchSelection";
import {
  getTouchSelectionToolbar,
  placeTouchToolbar,
  readSafeAreaInsets,
  readVisibleViewport,
  TOUCH_TOOLBAR_SIZE_ESTIMATE,
  type ToolbarRect,
  type TouchToolbarPlacement,
} from "../utils/touchToolbarPlacement";

function subscribeTouchPrimary(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(TOUCH_PRIMARY_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function isTouchPrimary(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(TOUCH_PRIMARY_QUERY).matches;
}

/**
 * Touch placement is on when the host opted in (`touchSelectionToolbar`) and
 * the main pointer is a finger. The media query is not subscribed at all for
 * a host that did not opt in.
 */
function useTouchToolbar(): boolean {
  const optedIn = getTouchSelectionToolbar();
  const touch = useSyncExternalStore(
    optedIn ? subscribeTouchPrimary : noopSubscribe,
    optedIn ? isTouchPrimary : alwaysFalse,
    alwaysFalse,
  );
  return optedIn && touch;
}
const noopSubscribe = () => () => {};
const alwaysFalse = () => false;

type PositionMode = 'center-above' | 'top-right';

const isEditableElement = (node: EventTarget | Element | null): boolean => {
  if (!(node instanceof Element)) return false;
  if (node.matches('input, textarea, select, [role="textbox"]')) return true;
  if (node.closest('[contenteditable]:not([contenteditable="false"])')) return true;
  return (node as HTMLElement).isContentEditable;
};

interface AnnotationToolbarProps {
  element: HTMLElement;
  positionMode: PositionMode;
  onAnnotate: (type: AnnotationType) => void;
  onClose: () => void;
  /** Called when user wants to write a comment (opens CommentPopover in parent) */
  onRequestComment?: (initialChar?: string) => void;
  /** Called when a quick label chip is selected */
  onQuickLabel?: (label: QuickLabel) => void;
  /** Text to copy when the button is clicked */
  copyText?: string;
  /** Builds the captured text selection's sanitized HTML and plain text when
   *  Copy is pressed (never before). When present, Copy writes text/html plus
   *  text/plain in one clipboard write (a plain field still pastes plain
   *  text), and the Copy button shows even where hideCopyButton hides it.
   *  Absent: Copy copies plain text, exactly as before. No shortcut. */
  getRichCopy?: () => RichCopySource | Promise<RichCopySource>;
  /** Comment-only surfaces (HTML / live-app viewer): hide the Delete action,
   *  the quick-label picker, and the Alt+digit label shortcuts. A provided
   *  onQuickLabel then renders ONLY the hardcoded 👍 "Looks good" button —
   *  the one label affordance restored to these surfaces. Markdown surfaces
   *  keep the full toolbar. */
  commentOnly?: boolean;
  /**
   * Opt-in: offer Delete on a `commentOnly` toolbar too (the Inbox's agent
   * messages), in its usual place before Comment. The label picker and the
   * Alt+digit label shortcuts stay off. Absent → Delete follows commentOnly.
   */
  showDelete?: boolean;
  /**
   * Opt-in host capability: the host's own commands for this selection,
   * rendered as ONE wand button (`data-selection-actions`) that opens the
   * package's dropdown below it. Selecting an item calls `onSelect` with the
   * selection context and closes the toolbar, exactly as a quick label does;
   * the package creates no annotation — the host decides what an action means.
   * Absent or empty → no button, no dropdown: today's toolbar.
   */
  selectionActions?: SelectionAction[];
  /**
   * Opt-in host capability: the glyph on the `selectionActions` button, so a
   * host can match the wand it draws elsewhere. Absent → the package's own
   * wand. Nothing else about the button changes (name, data attribute, size).
   */
  selectionActionsIcon?: React.ReactNode;
  /**
   * Opt-in host capability: a "Side" button (two speech bubbles and the word
   * "Side") after the reactions, between a divider and the one before ×.
   * Pressing it hands the host the selected text, the same text Copy reads,
   * and closes the toolbar; the host opens its side conversation with it.
   * Absent → no button and no divider: today's toolbar. No shortcut.
   */
  onSide?: (text: string) => void;
  /**
   * Whether the package's own quick labels are offered (default true).
   * `false` hides the Zap picker button and the Alt+digit label shortcuts on
   * this toolbar. The one-click 👍 is a separate affordance and is unaffected.
   */
  quickLabels?: boolean;
  /** Hide the plain copy button (set when a keyboard copy handler exists) */
  hideCopyButton?: boolean;
  /**
   * The whole selection's rect, in viewport coordinates, when `element` is
   * only its start (the first of several marks; a 1px anchor over an HTML
   * frame). Read only by the touch placement (`touchSelectionToolbar`), which
   * puts the toolbar below the selection's bottom; desktop placement uses
   * `element` as before. Absent or null: `element`'s rect.
   */
  touchAnchorRect?: () => ToolbarRect | null;
  /** Close toolbar when element scrolls out of viewport */
  closeOnScrollOut?: boolean;
  /** Exit animation state */
  isExiting?: boolean;
  /** Hover callbacks for code block behavior */
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export const AnnotationToolbar: React.FC<AnnotationToolbarProps> = ({
  element,
  positionMode,
  onAnnotate,
  onClose,
  onRequestComment,
  onQuickLabel,
  selectionActions,
  selectionActionsIcon,
  onSide,
  quickLabels: quickLabelsEnabled = true,
  copyText,
  getRichCopy,
  commentOnly = false,
  showDelete,
  hideCopyButton = false,
  touchAnchorRect,
  closeOnScrollOut = false,
  isExiting = false,
  onMouseEnter,
  onMouseLeave,
}) => {
  const [position, setPosition] = useState<{ top: number; left?: number; right?: number; touch?: TouchToolbarPlacement; maxWidth?: number } | null>(null);
  const touchToolbar = useTouchToolbar();
  const [copied, setCopied] = useState(false);
  const [richCopied, setRichCopied] = useState<RichCopyOutcome | false>(false);
  const richCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const richCopySelectionRef = useRef({ element, getRichCopy });
  richCopySelectionRef.current = { element, getRichCopy };
  const [showQuickLabels, setShowQuickLabels] = useState(false);
  const [showSelectionActions, setShowSelectionActions] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const zapButtonRef = useRef<HTMLButtonElement>(null);
  const actionsButtonRef = useRef<HTMLButtonElement>(null);
  const quickLabels = useMemo(() => getQuickLabels(), []);

  // A picker counts as open only while the button that opens it is actually
  // rendered. Without this, a host whose `selectionActions` go empty (or who
  // flips `quickLabels` off) while its dropdown is open unmounts the dropdown
  // and its Escape handler, but leaves the flag set — and the flag is what
  // stands the toolbar's own Escape, type-to-comment and outside-dismiss
  // listeners down, wedging the toolbar until the ✕ is clicked. Both flags are
  // false whenever the props are absent, so Plannotator's toolbar is
  // unchanged.
  const hasSelectionActions = !!selectionActions && selectionActions.length > 0;
  const selectionActionsOpen = showSelectionActions && hasSelectionActions;
  const quickLabelsOpen = showQuickLabels && !commentOnly && quickLabelsEnabled;

  useEffect(() => {
    setCopied(false);
    setRichCopied(false);
  }, [element]);
  useEffect(() => {
    setRichCopied(false);
    if (richCopyTimeoutRef.current !== null) clearTimeout(richCopyTimeoutRef.current);
    richCopyTimeoutRef.current = null;
  }, [element, getRichCopy]);
  useEffect(() => () => {
    if (richCopyTimeoutRef.current !== null) clearTimeout(richCopyTimeoutRef.current);
  }, []);

  const handleCopy = async () => {
    let textToCopy = copyText;
    if (!textToCopy) {
      const codeEl = element.querySelector('code');
      textToCopy = codeEl?.textContent || element.textContent || '';
    }
    if (await copyTextToClipboard(textToCopy)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleRichCopy = async () => {
    setRichCopied(false);
    const build = getRichCopy;
    if (!build) return;
    const fallback = copyText || element.querySelector('code')?.textContent || element.textContent || '';
    const result = await copyRichSelection(build, fallback);
    const current = richCopySelectionRef.current;
    if (current.element !== element || current.getRichCopy !== build) return;
    if (result) {
      setRichCopied(result);
      if (richCopyTimeoutRef.current !== null) clearTimeout(richCopyTimeoutRef.current);
      richCopyTimeoutRef.current = setTimeout(() => {
        setRichCopied(false);
        richCopyTimeoutRef.current = null;
      }, 1500);
    }
  };

  const updatePositionRef = useRef<() => void>(() => {});
  const touchAnchorRectRef = useRef(touchAnchorRect);
  touchAnchorRectRef.current = touchAnchorRect;
  const measuredSizeRef = useRef<{ width: number; height: number } | null>(null);
  // Touch placement only: the selection is scrolled out of sight and the
  // toolbar hidden, so its keys act on nothing until it is back.
  const hiddenRef = useRef(false);

  // Update position on scroll/resize
  useEffect(() => {
    const updatePosition = () => {
      const rect = element.getBoundingClientRect();
      // Touch screens (host opt-in) place and close by the WHOLE selection,
      // not its first piece; elsewhere `element` alone, as before.
      const anchor = touchToolbar ? touchAnchorRectRef.current?.() ?? rect : rect;

      if (closeOnScrollOut && (anchor.bottom < 0 || anchor.top > window.innerHeight)) {
        onClose();
        return;
      }

      if (touchToolbar) {
        // Below the selection, where iOS's own edit menu does not go, and
        // kept inside the visible screen.
        const placed = placeTouchToolbar({
          anchor,
          toolbar: measuredSizeRef.current ?? TOUCH_TOOLBAR_SIZE_ESTIMATE,
          viewport: readVisibleViewport(),
          insets: readSafeAreaInsets(),
          mode: positionMode,
        });
        hiddenRef.current = placed.placement === 'hidden';
        setPosition({ top: placed.top, left: placed.left, touch: placed.placement, maxWidth: placed.maxWidth });
        return;
      }

      hiddenRef.current = false;
      if (positionMode === 'center-above') {
        setPosition({
          top: rect.top - 48,
          left: rect.left + rect.width / 2,
        });
      } else {
        setPosition({
          top: rect.top - 40,
          right: window.innerWidth - rect.right,
        });
      }
    };

    updatePositionRef.current = updatePosition;
    measuredSizeRef.current = null;
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    // The visible viewport moves on its own on a phone (pinch zoom, the
    // keyboard); only the touch placement reads it.
    const vv = touchToolbar ? window.visualViewport : null;
    vv?.addEventListener("resize", updatePosition);
    vv?.addEventListener("scroll", updatePosition);

    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
      vv?.removeEventListener("resize", updatePosition);
      vv?.removeEventListener("scroll", updatePosition);
    };
  }, [element, positionMode, closeOnScrollOut, onClose, touchToolbar]);

  // Touch placement needs the toolbar's real size to keep it inside the
  // screen. Its width does not depend on where it sits (width: max-content in
  // theme.css), so one measurement after the first render, before paint, is
  // enough; a ResizeObserver catches later changes (Copy turning into
  // Copied!). Scrolling re-places from the stored size, never re-measuring.
  const hasPosition = position !== null;
  useLayoutEffect(() => {
    if (!touchToolbar || measuredSizeRef.current) return;
    const el = toolbarRef.current;
    if (!el || el.offsetWidth === 0) return;
    measuredSizeRef.current = { width: el.offsetWidth, height: el.offsetHeight };
    updatePositionRef.current();
  });
  useEffect(() => {
    const el = toolbarRef.current;
    if (!touchToolbar || !hasPosition || !el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const last = measuredSizeRef.current;
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      if (width === 0 || (last && last.width === width && last.height === height)) return;
      measuredSizeRef.current = { width, height };
      updatePositionRef.current();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [touchToolbar, hasPosition]);

  // Type-to-comment + Alt+N / bare digit quick label shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (hiddenRef.current) return;
      if (isEditableElement(e.target) || isEditableElement(document.activeElement)) return;

      // When a picker is open, let it own all keyboard input
      if (quickLabelsOpen || selectionActionsOpen) return;

      if (e.key === "Escape") {
        onClose();
        return;
      }

      // Alt+N applies quick label (picker closed). Comment-only surfaces
      // suppress this path: their only label affordance is the 👍 button.
      const isDigit = (e.code >= 'Digit1' && e.code <= 'Digit9') || e.code === 'Digit0';
      if (isDigit && !e.ctrlKey && !e.metaKey && e.altKey) {
        e.preventDefault();
        if (!commentOnly && quickLabelsEnabled) {
          const digit = parseInt(e.code.slice(5), 10);
          const index = quickLabelIndexForDigit(digit);
          if (index < quickLabels.length) {
            onQuickLabel?.(quickLabels[index]);
          }
        }
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Tab" || e.key === "Enter") return;
      if (e.key.length !== 1) return;

      onRequestComment?.(e.key);
    };

    window.addEventListener("keydown", handleKeyDown);
    // While this listener owns printable keys, the Shift+1..4 annotation-mode
    // shortcuts must not fire: Shift+3 is "#", and a user typing "#" into a
    // starting comment must not silently arm Redline (#1244 follow-up).
    const releaseCapture = acquireTypeToCommentCapture();
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      releaseCapture();
    };
  }, [onClose, onRequestComment, onQuickLabel, quickLabels, quickLabelsOpen, selectionActionsOpen, commentOnly, quickLabelsEnabled]);

  useDismissOnOutsideAndEscape({
    enabled: !quickLabelsOpen && !selectionActionsOpen,
    ref: toolbarRef,
    onDismiss: onClose,
  });

  if (!position) return null;

  const handleTypeSelect = (type: AnnotationType) => {
    if (type === AnnotationType.DELETION) {
      onAnnotate(type);
    } else {
      onRequestComment?.();
    }
  };

  const isCentered = position.left !== undefined && !position.touch;
  const translateX = isCentered ? ' translateX(-50%)' : '';

  const style: React.CSSProperties & { '--pn-annotation-toolbar-anchor-x'?: string } = {
    top: position.top,
    '--pn-annotation-toolbar-anchor-x': isCentered ? `${position.left}px` : undefined,
    ...(position.touch
      ? {
          left: position.left,
          maxWidth: position.maxWidth,
          // Its selection is scrolled out of sight: hidden until it is back.
          ...(position.touch === 'hidden' ? { visibility: 'hidden' as const } : {}),
        }
      : isCentered
      ? { left: position.left, transform: 'translateX(-50%)' }
      : { right: position.right }),
    animation: isExiting
      ? 'annotation-toolbar-out 0.15s ease-in forwards'
      : 'annotation-toolbar-in 0.15s ease-out',
  };

  return createPortal(
    <div
      ref={toolbarRef}
      data-pn-annotation-toolbar-centered={isCentered ? 'true' : undefined}
      // Touch placement (host opt-in, finger pointer): which side of the
      // selection it took. theme.css sizes the buttons for a thumb here.
      data-pn-annotation-toolbar-touch={position.touch}
      className="annotation-toolbar fixed z-[100] bg-popover border border-border rounded-lg shadow-2xl"
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <style>{`
        @keyframes annotation-toolbar-in {
          from { opacity: 0; transform: translateY(12px)${translateX}; }
          to { opacity: 1; transform: translateY(0)${translateX}; }
        }
        @keyframes annotation-toolbar-out {
          from { opacity: 1; transform: translateY(0)${translateX}; }
          to { opacity: 0; transform: translateY(8px)${translateX}; }
        }
      `}</style>
      <div data-pn-annotation-toolbar-row="true" className="flex items-center p-1 gap-0.5">
        {(!hideCopyButton || getRichCopy) && (
          <>
            {getRichCopy ? (
              // One Copy button: rich text (text/html plus text/plain) where
              // the host turned rich copy on. "Copied!" for a rich copy; a
              // plain-text fallback says what went on the clipboard.
              <ToolbarButton
                onClick={handleRichCopy}
                icon={richCopied ? <CheckIcon /> : <CopyIcon />}
                label={!richCopied ? "Copy"
                  : richCopied.copied === 'rich' ? "Copied!"
                  : richCopyOutcomeLabel(richCopied)}
                className={richCopied ? "text-success" : "text-muted-foreground hover:bg-muted hover:text-foreground"}
              />
            ) : (
              <ToolbarButton
                onClick={handleCopy}
                icon={copied ? <CheckIcon /> : <CopyIcon />}
                label={copied ? "Copied!" : "Copy"}
                className={copied ? "text-success" : "text-muted-foreground hover:bg-muted hover:text-foreground"}
              />
            )}
            <div className="w-px h-5 bg-border mx-0.5" />
          </>
        )}
        {(showDelete ?? !commentOnly) && (
          <ToolbarButton
            onClick={() => handleTypeSelect(AnnotationType.DELETION)}
            icon={<TrashIcon />}
            label="Delete"
            className="text-destructive hover:bg-destructive/10"
          />
        )}
        <ToolbarButton
          onClick={() => handleTypeSelect(AnnotationType.COMMENT)}
          icon={<CommentIcon />}
          label="Comment"
          className="text-annotation-comment hover:bg-annotation-comment/10"
        />
        {hasSelectionActions && (
          <ToolbarButton
            ref={actionsButtonRef}
            onClick={() => setShowSelectionActions(prev => !prev)}
            icon={selectionActionsIcon ?? <WandIcon />}
            label="Actions"
            className={selectionActionsOpen ? "text-primary bg-primary/10" : "text-primary hover:bg-primary/10"}
            dataAttributes={{ 'data-selection-actions': 'true' }}
          />
        )}
        {selectionActionsOpen && actionsButtonRef.current && (
          <FloatingSelectionActionsPicker
            anchorEl={actionsButtonRef.current}
            actions={selectionActions!}
            onSelect={(action) => {
              setShowSelectionActions(false);
              // Read at invoke time, not on every render: a toolbar with no
              // host actions must not walk the element's text at all.
              const actionText = copyText
                ?? element.querySelector('code')?.textContent
                ?? element.textContent
                ?? '';
              action.onSelect(buildSelectionActionContext(element, actionText));
              onClose();
            }}
            onDismiss={() => setShowSelectionActions(false)}
          />
        )}
        {onQuickLabel && (
          <>
            {!commentOnly && quickLabelsEnabled && (
              <ToolbarButton
                ref={zapButtonRef}
                onClick={() => setShowQuickLabels(prev => !prev)}
                icon={<ZapIcon />}
                label="Quick label"
                className={showQuickLabels ? "text-amber-500 bg-amber-500/10" : "text-amber-500 hover:bg-amber-500/10"}
              />
            )}
            <ToolbarButton
              onClick={() => onQuickLabel(THUMBS_UP_LABEL)}
              icon={<span className="block w-4 h-4 text-sm leading-4 text-center">👍</span>}
              label="Looks good"
              className="hover:bg-green-500/10"
            />
            {quickLabelsOpen && zapButtonRef.current && (
              <FloatingQuickLabelPicker
                anchorEl={zapButtonRef.current}
                onSelect={(label) => {
                  setShowQuickLabels(false);
                  onQuickLabel(label);
                }}
                onDismiss={() => setShowQuickLabels(false)}
              />
            )}
          </>
        )}
        {onSide && (
          <>
            <div className="w-px h-5 bg-border mx-0.5" />
            {/* The word shows, so the name is the word: no tooltip. On a touch
                toolbar theme.css gives it the 44px height and the 20px glyph;
                its words are a bare text node, never a span (sized there as a
                glyph). */}
            <button
              type="button"
              data-pn-touch-target="true"
              data-annotation-side=""
              onClick={() => {
                // Read at press time, as the selection actions read it.
                onSide(copyText ?? element.querySelector('code')?.textContent ?? element.textContent ?? '');
                onClose();
              }}
              className="flex items-center gap-1.5 h-7 pl-2 pr-2.5 rounded-md text-foreground hover:bg-muted transition-colors text-[12.5px] font-medium whitespace-nowrap"
            >
              <MessagesSquareIcon />
              Side
            </button>
          </>
        )}
        <div className="w-px h-5 bg-border mx-0.5" />
        <ToolbarButton
          onClick={onClose}
          icon={<CloseIcon />}
          label="Cancel"
          className="text-muted-foreground hover:bg-muted"
        />
      </div>
    </div>,
    document.body
  );
};

// Icons
/** Lucide's messages-square (ISC): the Side button's two bubbles. */
const MessagesSquareIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    <path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1" />
  </svg>
);

const CopyIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
  </svg>
);

const CheckIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
  </svg>
);

const TrashIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

const CommentIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
  </svg>
);

const ZapIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
  </svg>
);

// One thick diagonal wand with a single four-point star at its tip: the
// earlier glyph carried six sparks and read as noise at 16px.
const WandIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 21L13.5 10.5M17 3v7M13.5 6.5h7" />
  </svg>
);

const CloseIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
  </svg>
);

const ToolbarButton = React.forwardRef<HTMLButtonElement, {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  className: string;
  /** Extra DOM attributes (e.g. data-selection-actions). Absent adds nothing. */
  dataAttributes?: Record<string, string>;
}>(({ onClick, icon, label, className, dataAttributes }, ref) => (
  // The label is the button's only name: as a component tooltip (HostTitle) it also becomes its aria-label.
  <HostTitle title={label} name>
    <button
      ref={ref}
      // Icon-only controls: the markers are inert outside the compact touch
      // scope, where theme.css grows them to var(--pn-touch-target). Desktop
      // geometry is unchanged.
      data-pn-touch-target="true"
      data-pn-touch-target-icon="true"
      onClick={onClick}
      className={`p-1.5 rounded-md transition-colors ${className}`}
      {...dataAttributes}
    >
      {icon}
    </button>
  </HostTitle>
));
