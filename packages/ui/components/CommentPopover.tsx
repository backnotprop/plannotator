import React, { useState, useEffect, useMemo, useRef, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import type { ImageAttachment } from '../types';
import { AttachmentsButton } from './AttachmentsButton';
import { useDraggable } from '../hooks/useDraggable';
import { SparklesIcon } from './SparklesIcon';
import { Icon } from './inbox-thread/icons';
import { commentCardAimX, getCommentCardEnabled, getCommentCardLayout } from '../utils/commentCardPolicy';
import { hasUnsavedCommentContent } from '../utils/commentContent';
import { isCommentSubmitKey } from '../utils/commentSubmitKey';
import { useConfigValue } from '../config/useConfig';
import { useSkillReferenceAutocomplete } from '../hooks/useSkillReferenceAutocomplete';
import { HumanOnlySkillNotice, SkillReferenceMenu } from './SkillReferenceMenu';
import { ComposerTokenTextarea, type ComposerMentionChips } from './ComposerTokenTextarea';
import { useMentionAutocomplete } from '../hooks/useMentionAutocomplete';
import { MentionAutocompleteMenu, mentionActiveOptionId } from './MentionAutocomplete';
import type { MentionSource } from '../utils/mentions';
import {
  hasPrimaryCoarsePointer,
  shouldUseExpandedComposer,
  useVisibleViewportBounds,
  type VisibleViewportBounds,
} from '../hooks/useViewportEnvironment';

export type { ComposerMentionChips } from './ComposerTokenTextarea';

export interface CommentAskAIContext {
  kind: 'general' | 'selection';
  label?: string;
  text?: string;
  sourcePath?: string;
  /** Agent-facing identity of the selected element(s), for a pinpoint on a
   *  raw-HTML or live-app surface. Rides with the question; not displayed. */
  detail?: string;
  /** 1-based source lines of a markdown text selection (see
   *  `AIQuestion.scope.lineStart`). Rides with the question; not displayed. */
  lineStart?: number;
  lineEnd?: number;
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

/** A third action on the box: words optional. */
export interface CommentExtraAction {
  label: string;
  icon?: React.ReactNode;
  onAction: (words: string) => void;
}

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
  /**
   * Called on submit with comment text and optional images. The third
   * argument carries the mention ids the body still tags, and is passed ONLY
   * when a `mentionSource` is supplied — without one the call is the two
   * arguments it has always been.
   */
  onSubmit: (text: string, images?: ImageAttachment[], mentions?: readonly string[]) => void;
  /**
   * One-click 👍 "Looks good" (comment-only HTML / live-app surfaces, where a
   * pinpoint click opens this composer directly and never shows the selection
   * toolbar's 👍). Renders an emoji-only button beside Save, named "Looks
   * good" for assistive tech and in its tooltip; disabled once anything is
   * typed or attached so a click can never discard a draft. It takes no
   * keyboard shortcut: Enter / Mod+Enter still Save. Like Save, a click
   * clears the `draftKey` draft and returns focus to the opener. The parent
   * owns annotation creation and closing. Absent renders nothing.
   */
  onQuickLookGood?: () => void;
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
  /**
   * Opt-in: a third action at the footer's end, needing no words (Shape's Show me). It gets what was typed, and the
   * box closes. Absent: nothing changes.
   */
  extraAction?: CommentExtraAction;
  /** Opt-in: the primary action's label (Shape: "Change it"). Absent → "Add" / "Save", as always. */
  submitLabel?: string;
  /** Opt-in: the Ask AI action's label (Shape: "Ask"). Absent → "Ask AI", as always. */
  askAILabel?: string;
  /** Opt-in: more actions, drawn after the main one in this order (the right end; Tab reaches them last), each taking
   *  whatever is typed (Shape's box: "Show me", "Add to reply"). Absent or empty → nothing drawn. */
  extraActions?: readonly { label: string; onSelect: (text: string) => void; /** It takes the words for good: the `draftKey` draft is cleared, as a submit clears it. */ spends?: boolean }[];
  /**
   * False: always the popover as before, even where the host turned the comment card on (`configurePlannotatorUI({
   * commentCard })`): a surface with its own footer order (Shape's board: Ask, Change it, Show me). Absent or true:
   * the host's choice, as always.
   */
  allowCard?: boolean;
  /** Opt-in: `/` and `$` skill-reference autocomplete (document UI surfaces). Off by default. */
  skillReferences?: boolean;
  /**
   * Opt-in host capability: an `@` mention source for this composer. Supplies
   * the people, an optional honest-empty notice, and optional callbacks for
   * the surviving mention ids and for a picked person the host blocks.
   * Absent → no listener, no picker, no extra DOM: byte-identical composer.
   */
  mentionSource?: MentionSource;
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
  /** Opt-in: the header's text in place of the quoted `contextText` (an image
   *  region's "Region 3 · 356 × 486 px"). Absent → the quote, as always. */
  headerText?: string;
  /** Opt-in: why the last submit failed (Shape: a Change it that did not reach the server), shown under the
   *  header with `role="alert"` while the person's words stay in the box. Absent → nothing, as always. */
  errorText?: string;
  /** Opt-in: `side` opens the popover beside the anchor (right, else left),
   *  falling back to below/above when neither side has room (an image region
   *  in the image viewer). Absent → below/above, as always. */
  placement?: 'below' | 'side';
  /** Opt-in: the stacking level, for a composer over a surface that is
   *  itself above the page (the image viewer is z-200). Absent → 100. */
  zIndex?: number;
  /** Opt-out: `false` mounts the composer without taking focus (an HTML
   *  pin's composer shown again when its hidden target returns, so focus
   *  stays where the person is). Absent → focuses on mount, as always. */
  autoFocus?: boolean;
}

const MAX_POPOVER_WIDTH = 384;
const GAP = 8;

// Module-level draft store: survives popover unmount so reopening the same key restores in-progress text.
const draftStore = new Map<string, { text: string; images: ImageAttachment[] }>();

/**
 * Put words back as the `draftKey` draft after their save failed (the
 * popover clears the draft on submit), so the next open of that composer
 * shows them. A draft typed since is newer and is kept.
 */
export function restoreCommentDraft(draftKey: string, text: string, images: ImageAttachment[] = []): void {
  if (!draftStore.has(draftKey) && (text.trim() !== '' || images.length > 0)) draftStore.set(draftKey, { text, images });
}

/** Whether words (or images) wait as the `draftKey` draft: a closed composer that kept them. */
export function hasCommentDraft(draftKey: string): boolean {
  return draftStore.has(draftKey);
}

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

interface CommentPopoverPosition {
  top: number;
  left: number;
  flipAbove: boolean;
  width: number;
  maxHeight: number;
  requiresExpanded: boolean;
}

export function computeCommentPopoverPosition(
  anchorRect: Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left' | 'width'>,
  bounds: VisibleViewportBounds,
  placement: 'below' | 'side' = 'below',
): CommentPopoverPosition {
  if (placement === 'side') {
    const width = Math.min(MAX_POPOVER_WIDTH, bounds.width);
    const right = anchorRect.right + GAP * 1.75;
    const left = anchorRect.left - GAP * 1.75 - width;
    const sideLeft = right + width <= bounds.right ? right : left >= bounds.left ? left : null;
    if (sideLeft !== null) {
      const top = Math.max(bounds.top, Math.min(anchorRect.top, bounds.bottom - 280));
      const maxHeight = Math.max(0, bounds.bottom - top);
      if (maxHeight >= 280) return { top, left: sideLeft, flipAbove: false, width, maxHeight, requiresExpanded: false };
    }
  }
  const spaceBelow = Math.max(0, bounds.bottom - anchorRect.bottom - GAP);
  const spaceAbove = Math.max(0, anchorRect.top - bounds.top - GAP);
  const flipAbove = spaceBelow < 280 && spaceAbove > spaceBelow;
  const width = Math.min(MAX_POPOVER_WIDTH, bounds.width);

  const top = flipAbove
    ? anchorRect.top - GAP
    : anchorRect.bottom + GAP;

  let left = anchorRect.left + anchorRect.width / 2 - width / 2;
  left = Math.max(bounds.left, Math.min(left, bounds.right - width));
  const maxHeight = flipAbove ? spaceAbove : spaceBelow;

  return {
    top,
    left,
    flipAbove,
    width,
    maxHeight,
    requiresExpanded: maxHeight < 280,
  };
}

/** Where the comment card goes (`configurePlannotatorUI({ commentCard })`): `docked` at the foot of the pane, or by the
 *  words, under them (`above` false) or over them. */
export interface CommentCardGeometry { docked: boolean; above: boolean; style: React.CSSProperties }

/** The card's width by the words. */
export const COMMENT_CARD_WIDTH = 352;
/** The least room the card takes by the words; with less on both sides it docks. */
const CARD_NEED = 132;

/**
 * The comment card's place. It never sits on the words it is about: a card beside them (under, else over; with
 * `placement: 'side'`, right, else left, of them first), its Comment button under the pointer that opened it. A phone,
 * a card opened to full, or no room by the words: docked at the foot of the pane, above the keyboard and above the
 * pane's own foot (`footTop`), never over the whole page.
 */
export function computeCommentCardGeometry(
  anchor: Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left' | 'width'> | null,
  bounds: VisibleViewportBounds,
  opts: {
    phone: boolean;
    expanded: boolean;
    pane: Pick<DOMRect, 'left' | 'right' | 'bottom' | 'width'> | null;
    viewportHeight: number;
    footTop?: number | null;
    aimX?: number | null;
    placement?: 'below' | 'side';
  },
): CommentCardGeometry {
  // The pane's foot is never covered: the card ends above it. A short window keeps the room instead.
  if (opts.footTop != null && opts.footTop < bounds.bottom && opts.footTop - bounds.top >= 420) {
    bounds = { ...bounds, bottom: opts.footTop, height: opts.footTop - bounds.top };
  }
  const dock = (): CommentCardGeometry => {
    if (opts.phone) {
      return { docked: true, above: false, style: { left: bounds.left + 8, width: bounds.width - 16, bottom: opts.viewportHeight - bounds.bottom + 8, maxHeight: Math.max(160, bounds.height * 0.6) } };
    }
    const pane = opts.pane ?? { left: bounds.left, right: bounds.right, bottom: bounds.bottom, width: bounds.width };
    const width = Math.min(pane.width - 24, opts.expanded ? 760 : 680);
    const bottomEdge = Math.min(pane.bottom, bounds.bottom);
    return { docked: true, above: false, style: { left: pane.left + (pane.width - width) / 2, width, bottom: opts.viewportHeight - bottomEdge + 12, maxHeight: Math.max(160, bounds.height * (opts.expanded ? 0.7 : 0.5)) } };
  };
  if (!anchor || opts.phone || opts.expanded) return dock();
  const width = Math.min(COMMENT_CARD_WIDTH, bounds.width);
  if (opts.placement === 'side') {
    const right = anchor.right + GAP * 1.75;
    const left = anchor.left - GAP * 1.75 - width;
    const sideLeft = right + width <= bounds.right ? right : left >= bounds.left ? left : null;
    const top = Math.max(bounds.top, Math.min(anchor.top, bounds.bottom - 200));
    if (sideLeft !== null && bounds.bottom - top >= CARD_NEED) {
      return { docked: false, above: false, style: { left: sideLeft, width, top, maxHeight: bounds.bottom - top } };
    }
  }
  const below = Math.max(0, bounds.bottom - anchor.bottom - GAP);
  const aboveRoom = Math.max(0, anchor.top - bounds.top - GAP);
  if (below < CARD_NEED && aboveRoom < CARD_NEED) return dock();
  const above = below < CARD_NEED;
  let left = anchor.left + anchor.width / 2 - width / 2;
  // The Comment button sits at the row's right end (8 px in, about 92 px wide): its middle goes under the pointer.
  if (opts.aimX != null) left = opts.aimX - (width - 8 - 46);
  left = Math.max(bounds.left, Math.min(left, bounds.right - width));
  return {
    docked: false,
    above,
    style: above
      ? { left, width, bottom: opts.viewportHeight - (anchor.top - GAP), maxHeight: aboveRoom }
      : { left, width, top: anchor.bottom + GAP, maxHeight: below },
  };
}

/** The whole selection, not its first piece: a highlight is many marks with one id, and the card clears all of them
 *  (a long selection, one that wraps). A pinned part of an HTML page carries its size on its anchor. */
function cardAnchorRect(anchorEl: HTMLElement | null | undefined, anchorRect: DOMRect | null | undefined): DOMRect | null {
  const own = anchorEl?.getBoundingClientRect() ?? anchorRect ?? null;
  const pinW = Number(anchorEl?.dataset.pinWidth);
  const pinH = Number(anchorEl?.dataset.pinHeight);
  if (own && pinW > 0 && pinH > 0) return new DOMRect(own.left - pinW / 2, own.top, pinW, pinH + 20);
  const id = anchorEl?.getAttribute('data-highlight-id') ?? anchorEl?.getAttribute('data-bind-id');
  if (!anchorEl || !id || typeof document === 'undefined' || typeof CSS === 'undefined') return own;
  const root = anchorEl.getRootNode() as Document | ShadowRoot;
  const sel = `[data-highlight-id="${CSS.escape(id)}"], [data-bind-id="${CSS.escape(id)}"]`;
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const el of root.querySelectorAll(sel)) {
    for (const c of el.getClientRects()) {
      if (!c.width) continue;
      l = Math.min(l, c.left); t = Math.min(t, c.top); r = Math.max(r, c.right); b = Math.max(b, c.bottom);
    }
  }
  return l === Infinity ? own : new DOMRect(l, t, r - l, b - t);
}

export const CommentPopover: React.FC<CommentPopoverProps> = ({
  anchorEl,
  anchorRect,
  contextText,
  isGlobal,
  initialText = '',
  onSubmit,
  onQuickLookGood,
  onDraftChange,
  onClose,
  draftKey,
  allowImages = true,
  allowEmptySubmit = false,
  onAskAI,
  askAIContext,
  askAIDisabled = false,
  submitLabel,
  extraAction,
  askAILabel,
  extraActions,
  allowCard = true,
  skillReferences = false,
  mentionSource,
  targetChips,
  onRemoveTargetChip,
  onHoverTargetChip,
  refocusToken,
  captureStrayKeys = false,
  yieldState,
  headerText,
  errorText,
  placement = 'below',
  zIndex,
  autoFocus = true,
}) => {
  const visibleBounds = useVisibleViewportBounds(16);
  const coarsePointer = hasPrimaryCoarsePointer();
  const prefersExpandedComposer = shouldUseExpandedComposer({
    bounds: visibleBounds,
    coarsePointer,
  });
  // The comment card (opt-in, `configurePlannotatorUI({ commentCard })`): read once, so a box never changes look open.
  const [card] = useState(() => allowCard && getCommentCardEnabled());
  const [mode, setMode] = useState<'popover' | 'dialog'>(() =>
    prefersExpandedComposer && !card ? 'dialog' : 'popover'
  );
  // Dialog mode has two very different origins. Either the viewport PREFERS an
  // expanded composer (phones, small windows), or the anchor simply has no room
  // for a popover and the geometry FORCED it. Only the forced kind can bounce:
  // collapsing recomputes the same geometry and immediately re-expands, which
  // ate Escape and made the Collapse button a no-op. Track which one we are in.
  const [dialogIsForced, setDialogIsForced] = useState(false);
  // A preference-driven dialog is never the forced kind.
  const forcedDialog = dialogIsForced && !prefersExpandedComposer;
  const initialDraft = draftKey ? draftStore.get(draftKey) : undefined;
  const [text, setText] = useState(initialDraft?.text ?? initialText);
  const [images, setImages] = useState<ImageAttachment[]>(allowImages ? initialDraft?.images ?? [] : []);
  /** A picture still uploading, or one that failed (only under a host's CommentUploadContext): the comment waits for it. */
  const [picturesPending, setPicturesPending] = useState(false);
  const [position, setPosition] = useState<CommentPopoverPosition | null>(null);
  // Direction of an open popover that has scrolled out of view, or null when on-screen.
  const [offscreen, setOffscreen] = useState<'above' | 'below' | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const hasUnsavedContent = hasUnsavedCommentContent(text, allowImages ? images : []);
  const hasUnsavedContentRef = useRef(hasUnsavedContent);
  hasUnsavedContentRef.current = hasUnsavedContent;
  // The card (below) keeps the whole box inside the window; the popover keeps its own rule.
  const { dragPosition, dragHandleProps, wasDragged, reset: resetDrag } = useDraggable(popoverRef, { keepInside: card });
  const openingFocusRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined'
      && document.activeElement instanceof HTMLElement
      && document.activeElement !== document.body
      && document.activeElement !== document.documentElement
      ? document.activeElement
      : anchorEl ?? null,
  );

  useEffect(() => {
    if (prefersExpandedComposer && mode === 'popover' && !card) setMode('dialog');
  }, [card, mode, prefersExpandedComposer]);

  // The card: opened to full or not, and where it goes (computeCommentCardGeometry). A phone docks it at the foot.
  const [cardExpanded, setCardExpanded] = useState(false);
  const [cardGeo, setCardGeo] = useState<CommentCardGeometry | null>(null);
  const cardPhone = card && prefersExpandedComposer;
  const cardAim = useRef<number | null | undefined>(undefined);
  if (cardAim.current === undefined) cardAim.current = card ? commentCardAimX() : null;
  useEffect(() => {
    if (!card) return;
    const { pane: paneSel, foot: footSel } = getCommentCardLayout();
    const update = () => {
      const rect = cardAnchorRect(anchorEl, anchorRect);
      let paneEl: HTMLElement | null = null;
      if (paneSel) {
        paneEl = anchorEl?.closest<HTMLElement>(paneSel) ?? null;
        if (!paneEl && rect) paneEl = (document.elementFromPoint(rect.left + 1, rect.top + 1) as HTMLElement | null)?.closest<HTMLElement>(paneSel) ?? null;
      }
      const pane = paneEl?.getBoundingClientRect() ?? null;
      const feet = footSel && paneEl
        ? [...paneEl.querySelectorAll<HTMLElement>(footSel)].map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0 && r.width > 0)
        : [];
      const footTop = feet.length ? Math.min(...feet.map((r) => r.top)) - 4 : null;
      setCardGeo(computeCommentCardGeometry(rect, visibleBounds, {
        phone: cardPhone, expanded: cardExpanded, pane, viewportHeight: window.innerHeight, footTop, aimX: cardAim.current, placement,
      }));
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [card, anchorEl, anchorRect, visibleBounds, cardPhone, cardExpanded, placement]);
  // Docked at the foot: the words the comment is about are scrolled up above the card, never left under it.
  const cardDocked = cardGeo?.docked ?? false;
  useEffect(() => {
    if (!card || !cardDocked) return;
    const frame = requestAnimationFrame(() => {
      const box = popoverRef.current?.getBoundingClientRect();
      const rect = cardAnchorRect(anchorEl, anchorRect);
      if (!box || !rect || rect.bottom <= box.top - 8) return;
      let scroller: HTMLElement | null = anchorEl ?? null;
      while (scroller) {
        const cs = getComputedStyle(scroller);
        if (/(auto|scroll)/.test(cs.overflowY) && scroller.scrollHeight > scroller.clientHeight) break;
        scroller = scroller.parentElement;
      }
      const by = rect.bottom - (box.top - 24);
      const behavior: ScrollBehavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
      if (scroller) scroller.scrollBy({ top: by, behavior });
      else window.scrollBy({ top: by, behavior });
    });
    return () => cancelAnimationFrame(frame);
  }, [card, cardDocked, cardExpanded, anchorEl, anchorRect]);


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
  // The card opened to full docks at the foot again, wherever it was dragged.
  useEffect(() => { if (cardExpanded) resetDrag(); }, [cardExpanded, resetDrag]);

  // Track anchor position on scroll and observed viewport changes (popover
  // mode only, not after user drag).
  useEffect(() => {
    if (mode !== 'popover' || wasDragged || card) return;

    const update = () => {
      const rect = anchorEl?.getBoundingClientRect() ?? anchorRect;
      if (!rect) return;
      const nextPosition = computeCommentPopoverPosition(rect, visibleBounds, placement);
      if (nextPosition.requiresExpanded) {
        setDialogIsForced(true);
        setMode('dialog');
        return;
      }
      setPosition(nextPosition);
    };

    update();
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorEl, anchorRect, mode, visibleBounds, wasDragged, placement, card]);

  // Surface a "jump back" arrow when an open popover scrolls out of view.
  // Re-measures whenever the popover repositions (position updates every scroll
  // step in tracked mode) so the indicator is accurate at rest, plus on resize.
  useEffect(() => {
    if (mode !== 'popover') { setOffscreen(null); return; }
    const measure = () => {
      const el = popoverRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.bottom < visibleBounds.top) setOffscreen('above');
      else if (rect.top > visibleBounds.bottom) setOffscreen('below');
      else setOffscreen(null);
    };
    measure();
  }, [position, dragPosition, mode, visibleBounds, cardGeo]);

  const scrollToPopover = useCallback(() => {
    anchorEl?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [anchorEl]);

  // Focus the textarea when it mounts (initial open and popover/dialog switches).
  // A ref callback rather than a mount effect: in popover mode the textarea only
  // renders after `position` is measured, and WebKit fires 0ms timers ahead of
  // that commit, so an effect keyed on mode alone can run before the textarea
  // exists and never focus it (e.g. in WKWebView hosts like Glimpse).
  const shouldAutoFocus = autoFocus && (!coarsePointer || initialText.length > 0 || isGlobal);
  const focusOnMountRef = useCallback((el: HTMLTextAreaElement | null) => {
    textareaRef.current = el;
    if (!el || !shouldAutoFocus) return;
    setTimeout(() => {
      if (!el.isConnected) return;
      el.focus();
      el.selectionStart = el.selectionEnd = el.value.length;
    }, 0);
  }, [shouldAutoFocus]);

  // A touch-opened composer deliberately does not focus the textarea (and
  // summon the software keyboard), but hardware-keyboard users still need a
  // coherent focus target and Escape dismissal.
  useEffect(() => {
    if ((mode !== 'dialog' && !card) || shouldAutoFocus || !autoFocus) return;
    const timer = setTimeout(() => {
      if (!popoverRef.current?.isConnected) return;
      popoverRef.current.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [autoFocus, card, mode, shouldAutoFocus]);

  const restoreOpeningFocus = useCallback(() => {
    const target = openingFocusRef.current;
    requestAnimationFrame(() => {
      if (!target?.isConnected) return;
      target.focus({ preventScroll: true });
    });
  }, []);

  const handleClose = useCallback(
    (focusDisposition: 'restore-opener' | 'preserve-pointer-target' = 'restore-opener') => {
      if (draftKey) {
        if (hasUnsavedCommentContent(text, allowImages ? images : [])) {
          draftStore.set(draftKey, { text, images: allowImages ? images : [] });
        } else {
          draftStore.delete(draftKey);
        }
      }
      onClose();
      if (focusDisposition === 'restore-opener') restoreOpeningFocus();
    },
    [allowImages, draftKey, images, onClose, restoreOpeningFocus, text],
  );

  // Click-outside for popover mode
  useEffect(() => {
    if (mode !== 'popover') return;
    const shiftSelectionActive = Boolean(targetChips?.length);

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      // Don't close if clicking inside a child portal (AttachmentsButton, ImageAnnotator, etc.)
      const el = target as HTMLElement;
      if (el.closest?.('[data-popover-layer]')) return;
      if (hasUnsavedContentRef.current) return;
      // A same-document multi-select target receives pointerdown before click.
      // Preserve the existing draft so the following Shift-click can extend
      // it instead of silently replacing it with a new one.
      if (shiftSelectionActive && e.shiftKey) return;
      handleClose('preserve-pointer-target');
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [handleClose, mode, targetChips?.length]);

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

  const mentionAc = useMentionAutocomplete({
    text,
    setText,
    textareaRef,
    source: mentionSource,
  });

  // The mention half of the composer's highlight layer: present for the whole
  // life of a mention composer (so the first pick never swaps the textarea
  // element), null without a source (so the overlay does not exist at all).
  const mentionChipPeople = mentionAc.mentions;
  const mentionTokenClassName = mentionSource?.tokenClassName;
  const mentionChips: ComposerMentionChips | null = useMemo(
    () =>
      mentionSource
        ? { people: mentionChipPeople, tokenClassName: mentionTokenClassName }
        : null,
    [mentionSource, mentionChipPeople, mentionTokenClassName],
  );

  const runExtraAction = (action: NonNullable<CommentPopoverProps['extraActions']>[number]) => {
    if (action.spends && draftKey) draftStore.delete(draftKey);
    action.onSelect(text.trim());
  };

  const handleSubmit = useCallback(() => {
    const canSubmitEmpty = allowEmptySubmit && initialText.trim().length > 0;
    if (picturesPending) return;
    if (hasUnsavedContent || canSubmitEmpty) {
      if (draftKey) draftStore.delete(draftKey);
      const submitImages = allowImages && images.length > 0 ? images : undefined;
      // Without a mentionSource this is the two-argument call it always was.
      if (mentionSource) onSubmit(text, submitImages, mentionAc.mentionIds);
      else onSubmit(text, submitImages);
      restoreOpeningFocus();
    }
  }, [text, images, onSubmit, draftKey, allowImages, allowEmptySubmit, initialText, hasUnsavedContent, restoreOpeningFocus, mentionSource, mentionAc.mentionIds, picturesPending]);

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

  const handleExtra = useCallback(() => {
    if (!extraAction) return;
    extraAction.onAction(text.trim());
    if (draftKey) draftStore.delete(draftKey);
    onDraftChange?.('', allowImages ? [] : undefined);
    onClose();
  }, [allowImages, draftKey, extraAction, onClose, onDraftChange, text]);

  // After the primary action in the DOM, so Tab reaches it second; `order` keeps it at the footer's end on screen,
  // and Tab goes the way the eye reads the two: the primary, then this.
  const extraButton = extraAction ? (
    <button
      type="button"
      onClick={handleExtra}
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md text-primary border border-primary/40 hover:bg-primary/10 transition-colors"
      style={{ order: -1 }}
      data-comment-extra-action=""
    >
      {extraAction.icon}
      {extraAction.label}
    </button>
  ) : null;

  const skillAc = useSkillReferenceAutocomplete({
    text,
    setText,
    textareaRef,
    enabled: skillReferences,
  });
  const readComposerCaret = useCallback(() => {
    skillAc.onSelect();
    mentionAc.onSelect();
  }, [mentionAc, skillAc]);
  const skillListboxId = `skill-reference-listbox-${useId().replace(/:/g, '')}`;
  const mentionListboxId = `${skillListboxId}-mentions`;
  const activeSkillOptionId =
    skillAc.menu?.activeIndex === null || skillAc.menu?.activeIndex === undefined
      ? undefined
      : `${skillListboxId}-option-${skillAc.menu.activeIndex}`;
  // At most one of the two menus can be open (their triggers are disjoint), so
  // the textarea's ARIA relationship points at whichever one is. All three are
  // `undefined`/false with no menu open, which is every render Plannotator
  // makes without a `mentionSource`.
  const activeMentionOptionId = mentionActiveOptionId(mentionListboxId, mentionAc.menu);
  const composerListboxId = mentionAc.menu !== null ? mentionListboxId : skillListboxId;
  const composerListboxOpen = skillAc.menu !== null || mentionAc.menu !== null;
  const activeComposerOptionId = activeSkillOptionId ?? activeMentionOptionId;

  const enterSavesComment = useConfigValue('enterSavesComment');
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (skillAc.onKeyDown(e)) return;
    if (mentionAc.onKeyDown(e)) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      // The card: one layer per Escape. Opened to full goes back small first; then it closes and keeps the words.
      if (card) {
        if (cardExpanded) setCardExpanded(false);
        else handleClose();
        return;
      }
      if (mode === 'dialog') {
        // Collapsing a forced dialog is geometrically impossible, so Escape
        // closes it (draft-preserving) instead of being swallowed by the
        // re-expand.
        if (prefersExpandedComposer || forcedDialog) handleClose();
        else setMode('popover');
      } else {
        handleClose();
      }
      return;
    }
    if (isCommentSubmitKey(e, enterSavesComment)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const headerLabel = headerText ?? (isGlobal
    ? 'Global Comment'
    : contextText
      ? `"${contextText.length > 50 ? contextText.slice(0, 50) + '...' : contextText}"`
      : 'Comment');

  // Inline colour: no new utility class reaches the guides.show viewer CSS this file is scanned into.
  const errorRow = errorText ? (
    <p role="alert" data-comment-popover-error="true" className="px-3 pt-2 text-xs" style={{ color: 'var(--destructive)' }}>
      {errorText}
    </p>
  ) : null;

  const canSubmit =
    !picturesPending &&
    (hasUnsavedContent ||
    (allowEmptySubmit && initialText.trim().length > 0));
  const canAskAI = !!onAskAI && !askAIDisabled && text.trim().length > 0;
  const showsSkillMenu = skillAc.menu !== null;

  // Shared by both footers, sits beside Save. Emoji-only like the selection
  // toolbar's 👍 (same hover tint). Disabled once anything is typed or
  // attached so a click can never discard a draft; with content, Save is the
  // path. A plain click handler only: Enter / Mod+Enter stay on Save.
  // The grey-out is an inline filter, not a Tailwind filter utility: this
  // file is scanned into the pinned guides.show viewer CSS, and every class
  // below already exists there, so the 👍 adds nothing to that bundle.
  const handleQuickLookGood = () => {
    if (!onQuickLookGood || hasUnsavedContent) return;
    if (draftKey) draftStore.delete(draftKey);
    onQuickLookGood();
    restoreOpeningFocus();
  };
  const quickLookGoodButton = onQuickLookGood ? (
    <button
      type="button"
      onClick={handleQuickLookGood}
      disabled={hasUnsavedContent}
      aria-label="Looks good"
      title={hasUnsavedContent ? 'Looks good (clear the comment to use it)' : 'Looks good'}
      data-quick-look-good="true"
      data-pn-touch-target="true"
      data-pn-touch-target-icon="true"
      style={hasUnsavedContent ? { filter: 'grayscale(1)' } : undefined}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-sm leading-none hover:bg-green-500/10 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-colors"
    >
      <span aria-hidden="true">👍</span>
    </button>
  ) : null;

  // The comment card (opt-in): words first; a chevron at the top right closes it and keeps the words; one row with the
  // tools at the left, the bin, and a solid "Comment" at the right end (DOM order keeps Comment first for Tab). No
  // header line, no blurred page behind, nothing that fades between colours on hover (comment-card.css).
  if (card) {
    if (!cardGeo) return null;
    const quote = headerText ?? (isGlobal ? null : contextText.replace(/\s+/g, ' ').trim());
    const on = headerText ?? (quote ? `“${quote.length > 80 ? `${quote.slice(0, 80)}…` : quote}”` : null);
    // Dragged by its words (not on a phone, not opened to full: those dock at the foot): it stays where it was put,
    // whole inside the window, until other words are picked.
    const cardDraggable = !cardPhone && !cardExpanded;
    const cardDragged = cardDraggable && dragPosition !== null;
    const cardDragStyle: React.CSSProperties = cardDraggable && dragPosition
      ? { left: dragPosition.left, top: dragPosition.top, width: cardGeo.style.width, maxHeight: Math.max(CARD_NEED, window.innerHeight - dragPosition.top) }
      : {};
    const discard = () => {
      if (draftKey) draftStore.delete(draftKey);
      setText('');
      setImages([]);
      onDraftChange?.('', allowImages ? [] : undefined);
      onClose();
      restoreOpeningFocus();
    };
    return createPortal(
      <>
        {offscreen && !cardGeo.docked && (
          <button
            type="button"
            data-popover-layer="true"
            className="pn-cbox-back"
            data-at={offscreen}
            onClick={scrollToPopover}
            title="Scroll back to your open comment"
          >
            <Icon name={offscreen === 'above' ? 'chevU' : 'chevD'} size={14} />
            <span>Open comment</span>
          </button>
        )}
        <div
          ref={popoverRef}
          data-comment-popover="true"
          data-comment-card=""
          data-docked={cardGeo.docked ? '' : undefined}
          data-above={cardGeo.above ? '' : undefined}
          data-expanded={cardExpanded ? '' : undefined}
          data-phone={cardPhone ? '' : undefined}
          role="dialog"
          aria-label={isGlobal ? 'Global comment' : on ? `Comment on ${on}` : 'Comment'}
          tabIndex={-1}
          className={`pn-cbox${yieldClass}`}
          data-dragged={cardDragged ? '' : undefined}
          style={{ ...(cardDragged ? cardDragStyle : cardGeo.style), ...(zIndex !== undefined ? { zIndex } : {}), ...(showsSkillMenu ? { overflow: 'visible' } : {}) }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            e.preventDefault();
            e.stopPropagation();
            if (cardExpanded) setCardExpanded(false);
            else handleClose();
          }}
        >
          {yieldStyleBlock}
          <button
            type="button"
            className="pn-cbox-close"
            onClick={() => handleClose()}
            aria-label="Close (your words are kept)"
            title="Close (your words are kept)"
            data-comment-card-close=""
          >
            <Icon name="chevD" size={16} />
          </button>
          {/* The skill list hangs off the card itself, never off the field: the field scrolls, and would clip it. */}
          {skillAc.menu && (
            <SkillReferenceMenu
              id={skillListboxId}
              items={skillAc.menu.items}
              activeIndex={skillAc.menu.activeIndex}
              onSelect={skillAc.select}
              // On the side away from the words the comment is about, so the list never covers them.
              prefer={cardGeo.above || cardGeo.docked ? 'above' : 'below'}
            />
          )}
          {/* The words are the handle the card is dragged by (as the popover's header is). The press keeps the caret
              in the field and starts no selection of the page's text, which would close the card as a draft. */}
          <div
            className="pn-cbox-quote"
            title={quote ?? undefined}
            {...(cardDraggable ? { ...dragHandleProps, 'data-comment-card-handle': '', onMouseDown: (e: React.MouseEvent) => e.preventDefault() } : {})}
          >
            {isGlobal ? 'Global comment' : on ?? 'Comment'}
          </div>
          {errorRow}
          {chipsRow}
          <div className="pn-cbox-field">
            <ComposerTokenTextarea
              textareaRef={focusOnMountRef}
              value={text}
              onChange={(e) => { setText(e.target.value); readComposerCaret(); }}
              onKeyDown={handleKeyDown}
              onSelectCaret={readComposerCaret}
              placeholder={isGlobal ? 'Add a global comment…' : 'Comment…'}
              sizeClassName={cardExpanded ? 'pn-cbox-ta pn-cbox-ta-full' : 'pn-cbox-ta'}
              skillReferences={skillReferences}
              tokens={skillAc.referenceTokens}
              mentionChips={mentionChips}
              listboxId={composerListboxId}
              listboxOpen={composerListboxOpen}
              activeOptionId={activeComposerOptionId}
            />
            <HumanOnlySkillNotice skills={skillAc.humanOnlyReferences} />
            {mentionSource?.renderNotice?.(mentionChipPeople)}
            <MentionAutocompleteMenu id={mentionListboxId} menu={mentionAc.menu} onSelect={mentionAc.select} />
          </div>
          {/* Screen order is Tab order: the tools, the bin, then Comment at the right end. */}
          <div className="pn-cbox-row">
            {quickLookGoodButton}
            {allowImages && (
              <AttachmentsButton
                images={images}
                onAdd={(img) => setImages((prev) => [...prev, img])}
                onRemove={(path) => setImages((prev) => prev.filter((i) => i.path !== path))}
                onPendingChange={setPicturesPending}
                variant="inline"
              />
            )}
            {onAskAI && (
              <button type="button" className="pn-cbox-tool pn-cbox-word" onClick={handleAskAI} disabled={!canAskAI} title={canAskAI ? 'Ask AI this question' : 'Type a question to ask AI'}>
                <SparklesIcon className="w-3.5 h-3.5" />
                {askAILabel ?? 'Ask AI'}
              </button>
            )}
            {extraActions?.map((action) => (
              <button key={action.label} type="button" className="pn-cbox-tool pn-cbox-word" onClick={() => runExtraAction(action)}>{action.label}</button>
            ))}
            {extraAction && (
              <button type="button" className="pn-cbox-tool pn-cbox-word" onClick={handleExtra} data-comment-extra-action="">
                {extraAction.icon}
                {extraAction.label}
              </button>
            )}
            {!cardPhone && (
              <button
                type="button"
                className="pn-cbox-tool"
                onClick={() => setCardExpanded((v) => !v)}
                aria-label={cardExpanded ? 'Make it small again' : 'Open it to full'}
                title={cardExpanded ? 'Make it small again' : 'Open it to full'}
                aria-pressed={cardExpanded}
              >
                <Icon name={cardExpanded ? 'collapse' : 'expand'} size={15} />
              </button>
            )}
            <span className="pn-cbox-mid" />
            {hasUnsavedContent && (
              <button type="button" className="pn-cbox-tool pn-cbox-bin" onClick={discard} aria-label="Discard this comment" title="Discard this comment" data-comment-card-discard="">
                <Icon name="trash" size={15} />
              </button>
            )}
            <button type="button" className="pn-cbox-save" onClick={handleSubmit} disabled={!canSubmit} data-comment-card-submit="">
              {submitLabel ?? 'Comment'}
            </button>
          </div>
        </div>
      </>,
      document.body,
    );
  }


  if (mode === 'dialog') {
    return createPortal(
      <div
        data-comment-popover="true"
        className="pn-visible-viewport-overlay z-[100] flex items-center justify-center"
        style={zIndex !== undefined ? { zIndex } : undefined}
      >
        {/* Backdrop */}
        <button
          type="button"
          aria-label="Dismiss comment"
          className="absolute inset-0 bg-background/80 backdrop-blur-sm"
          onClick={() => handleClose()}
        />

        {/* Dialog card */}
        {/* The expanded dialog deliberately does not yield: it is an explicit
            full-screen compose surface, and its backdrop wrapper (which carries
            data-comment-popover) spans the viewport, so proximity is
            meaningless there. */}
        <div
          ref={popoverRef}
          role="dialog"
          aria-modal="true"
          aria-label={isGlobal ? 'Global comment' : 'Comment'}
          tabIndex={-1}
          className={`relative w-full max-w-xl max-h-full min-h-0 bg-popover border border-border rounded-xl shadow-2xl flex flex-col ${
            showsSkillMenu ? 'overflow-visible' : 'overflow-hidden'
          }`}
          style={{
            animation: 'comment-dialog-in 0.15s ease-out',
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            handleClose();
          }}
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
              {!prefersExpandedComposer && !forcedDialog && (
                <button
                  onClick={() => { setDialogIsForced(false); setMode('popover'); }}
                  className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  title="Collapse"
                >
                  <CollapseIcon />
                </button>
              )}
              <button
                onClick={() => handleClose()}
                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                title="Close"
              >
                <CloseIcon />
              </button>
            </div>
          </div>

          {errorRow}
          {chipsRow}

          {/* Textarea */}
          <div className={`relative px-4 py-3 min-h-0 flex-1 ${
            showsSkillMenu ? 'overflow-visible' : 'overflow-y-auto'
          }`}>
            {skillAc.menu && (
              <SkillReferenceMenu
                id={skillListboxId}
                items={skillAc.menu.items}
                activeIndex={skillAc.menu.activeIndex}
                onSelect={skillAc.select}
              />
            )}
            <ComposerTokenTextarea
              textareaRef={focusOnMountRef}
              value={text}
              onChange={(e) => { setText(e.target.value); readComposerCaret(); }}
              onKeyDown={handleKeyDown}
              onSelectCaret={readComposerCaret}
              placeholder={isGlobal ? 'Add a global comment...' : 'Add a comment...'}
              sizeClassName="min-h-32 max-h-full"
              skillReferences={skillReferences}
              tokens={skillAc.referenceTokens}
              mentionChips={mentionChips}
              listboxId={composerListboxId}
              listboxOpen={composerListboxOpen}
              activeOptionId={activeComposerOptionId}
            />
            <HumanOnlySkillNotice skills={skillAc.humanOnlyReferences} />
            {mentionSource?.renderNotice?.(mentionChipPeople)}
            <MentionAutocompleteMenu
              id={mentionListboxId}
              menu={mentionAc.menu}
              onSelect={mentionAc.select}
            />
          </div>

          {/* Footer — DOM order sets tab order (Save first); row-reverse keeps the visual layout unchanged */}
          <div className="flex flex-row-reverse flex-wrap items-center justify-between gap-2 px-4 py-3 border-t border-border/50">
            <div className="flex flex-row-reverse flex-wrap items-center gap-3">
              <button
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
              >
                {submitLabel ?? (isGlobal ? 'Add' : 'Save')}
              </button>
              {extraButton}
              {quickLookGoodButton}
              {onAskAI && (
                <button
                  onClick={handleAskAI}
                  disabled={!canAskAI}
                  className="inline-flex items-center gap-1 px-2 py-1.5 text-xs font-medium rounded-md text-muted-foreground hover:text-primary hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  title={canAskAI ? 'Ask AI this question' : 'Type a question to ask AI'}
                >
                  <SparklesIcon className="w-3 h-3" />
                  {askAILabel ?? 'Ask AI'}
                </button>
              )}
              {extraActions?.map((action, i) => (
                <button
                  key={action.label}
                  onClick={() => runExtraAction(action)}
                  style={{ order: -1 - i }}
                  className="px-2 py-1.5 text-xs font-medium rounded-md text-muted-foreground hover:text-primary hover:bg-muted transition-colors"
                >
                  {action.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              {allowImages && (
                <AttachmentsButton
                  images={images}
                  onAdd={(img) => setImages((prev) => [...prev, img])}
                  onRemove={(path) => setImages((prev) => prev.filter((i) => i.path !== path))}
                  onPendingChange={setPicturesPending}
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
        ? {
            ...(zIndex !== undefined ? { zIndex } : {}),
            top: dragPosition.top,
            left: dragPosition.left,
            width: position.width,
            maxHeight: visibleBounds.height,
            overflowY: showsSkillMenu ? 'visible' : 'auto',
          }
        : {
            ...(zIndex !== undefined ? { zIndex } : {}),
            top: position.top,
            left: position.left,
            width: position.width,
            maxHeight: position.maxHeight,
            overflowY: showsSkillMenu ? 'visible' : 'auto',
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
            onClick={() => { setDialogIsForced(false); setMode('dialog'); }}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="Expand"
          >
            <ExpandIcon />
          </button>
          <button
            onClick={() => handleClose()}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="Close"
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      {errorRow}
      {chipsRow}

      {/* Textarea */}
      <div className="relative px-3 py-2">
        {skillAc.menu && (
          <SkillReferenceMenu
            id={skillListboxId}
            items={skillAc.menu.items}
            activeIndex={skillAc.menu.activeIndex}
            onSelect={skillAc.select}
          />
        )}
        <ComposerTokenTextarea
          textareaRef={focusOnMountRef}
          value={text}
          onChange={(e) => { setText(e.target.value); readComposerCaret(); }}
          onKeyDown={handleKeyDown}
          onSelectCaret={readComposerCaret}
          placeholder={isGlobal ? 'Add a global comment...' : 'Add a comment...'}
          sizeClassName="max-h-64 min-h-[4.5rem]"
          skillReferences={skillReferences}
          tokens={skillAc.referenceTokens}
          mentionChips={mentionChips}
          listboxId={composerListboxId}
          listboxOpen={composerListboxOpen}
          activeOptionId={activeComposerOptionId}
        />
        <HumanOnlySkillNotice skills={skillAc.humanOnlyReferences} />
        {mentionSource?.renderNotice?.(mentionChipPeople)}
        <MentionAutocompleteMenu
          id={mentionListboxId}
          menu={mentionAc.menu}
          onSelect={mentionAc.select}
        />
      </div>

      {/* Footer — same DOM-order/row-reverse pattern as the dialog footer above */}
      <div className="flex flex-row-reverse items-center justify-between px-3 py-2 border-t border-border/50">
        {/* Wraps only with the opt-in third action, which can take the row past a narrow box. */}
        <div className={extraAction ? 'flex flex-row-reverse flex-wrap items-center gap-3' : 'flex flex-row-reverse items-center gap-3'}>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
          >
            {submitLabel ?? (isGlobal ? 'Add' : 'Save')}
          </button>
          {extraButton}
          {quickLookGoodButton}
          {onAskAI && (
            <button
              onClick={handleAskAI}
              disabled={!canAskAI}
              className="inline-flex items-center gap-1 px-2 py-1.5 text-xs font-medium rounded-md text-muted-foreground hover:text-primary hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title={canAskAI ? 'Ask AI this question' : 'Type a question to ask AI'}
            >
              <SparklesIcon className="w-3 h-3" />
              {askAILabel ?? 'Ask AI'}
            </button>
          )}
          {extraActions?.map((action, i) => (
            <button
              key={action.label}
              onClick={() => runExtraAction(action)}
              style={{ order: -1 - i }}
              className="px-2 py-1.5 text-xs font-medium rounded-md text-muted-foreground hover:text-primary hover:bg-muted transition-colors"
            >
              {action.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {allowImages && (
            <AttachmentsButton
              images={images}
              onAdd={(img) => setImages((prev) => [...prev, img])}
              onRemove={(path) => setImages((prev) => prev.filter((i) => i.path !== path))}
              onPendingChange={setPicturesPending}
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
