import { useState, useEffect, useCallback, useRef, type RefObject } from "react";
import { AnnotationType, type Annotation, type EditorMode, type HtmlAnnotationTarget, type HtmlElementAnchor, type ImageAttachment } from "../../types";
import type { QuickLabel } from "../../utils/quickLabels";
import { getIdentity } from "../../utils/identity";
import type {
  ToolbarState,
  CommentPopoverState,
  QuickLabelPickerState,
  UseAnnotationHighlighterReturn,
} from "../../hooks/useAnnotationHighlighter";

const PREFIX = "plannotator-bridge-";

// Collision-proof annotation ids. `Date.now()` alone repeats within a millisecond,
// so two quick annotations could share a data-bind-id and clobber each other.
let htmlAnnSeq = 0;
function nextHtmlAnnId(): string {
  return `html-ann-${Date.now().toString(36)}-${(htmlAnnSeq++).toString(36)}`;
}

interface BridgeSelectionMessage {
  type: `${typeof PREFIX}selection`;
  text: string;
  rect: BridgeRect;
  modeOverride?: EditorMode;
  /** Serialized element anchor (pinpoint clicks) — validated, size-capped. */
  anchor?: HtmlElementAnchor;
  /** True when the selection came from a pinpoint click on an element. */
  pinpoint?: boolean;
  /** Bridge-assigned key for the primary target (multi-select bookkeeping). */
  targetKey?: string;
  /** Semantic label from the pinpoint hover cascade (chips + export). */
  targetLabel?: string;
}

/** One draft target in an in-flight multi-select comment. Index 0 is primary. */
export interface HtmlDraftTarget {
  key: string;
  label?: string;
  text: string;
  anchor: HtmlElementAnchor | null;
}

interface BridgeMultiTargetAddedMessage {
  type: `${typeof PREFIX}multi-target-added`;
  key: string;
  label?: string;
  text: string;
  anchor?: HtmlElementAnchor;
}

interface BridgeRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

type BridgeMessage =
  | BridgeSelectionMessage
  | BridgeMultiTargetAddedMessage
  | { type: `${typeof PREFIX}multi-target-removed`; key: string }
  | { type: `${typeof PREFIX}pointer`; x: number; y: number; shift: boolean }
  | { type: `${typeof PREFIX}selection-clear` }
  | { type: `${typeof PREFIX}selection-rect`; rect: BridgeRect }
  | { type: `${typeof PREFIX}keytype`; key: string }
  | { type: `${typeof PREFIX}mark-click`; id: string }
  | { type: `${typeof PREFIX}unanchored`; ids: string[] }
  | { type: `${typeof PREFIX}resize`; height: number };

/** Dependencies and callbacks for the sandboxed HTML annotation bridge. */
export interface UseHtmlAnnotationOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  /** Whether selection bridge messages may open composers or create annotations. */
  enabled?: boolean;
  annotations: Annotation[];
  onAddAnnotation?: (ann: Annotation) => void;
  onSelectAnnotation?: (id: string | null) => void;
  selectedAnnotationId: string | null;
  mode: EditorMode;
  onResize?: (height: number) => void;
  /** Validated pointer positions relayed from inside the iframe while a
   *  pinpoint draft is open (iframe-local viewport coordinates), with the
   *  Shift state observed by the iframe (the parent cannot see modifiers
   *  held while the pointer lives in the sandbox). Drives the composer-yield
   *  fade in the host component. */
  onBridgePointer?: (x: number, y: number, shift: boolean) => void;
  /** Reports the full set of annotation ids that currently have NO live
   *  representation on the page — every target dead, or the restore never
   *  resolved (fail-closed anchors hide markers rather than guess). Called
   *  with the complete current set whenever it changes, including back to
   *  empty on recovery. Delivered in readOnly mode too: view-only surfaces
   *  are exactly where silently missing markers would go unnoticed. */
  onUnanchoredChange?: (ids: string[]) => void;
}

function postToIframe(iframe: HTMLIFrameElement | null, msg: Record<string, unknown>) {
  iframe?.contentWindow?.postMessage(msg, "*");
}

function parseEditorMode(value: unknown): EditorMode | undefined {
  return value === "selection"
    || value === "comment"
    || value === "redline"
    || value === "quickLabel"
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Size caps for the anchor DTO — the bridge script runs inside a sandboxed
// iframe rendering arbitrary HTML, so everything it posts is validated and
// bounded before it can reach React state or the annotation model.
const MAX_ANCHOR_SELECTOR_LENGTH = 1024;
const MAX_ANCHOR_TAG_LENGTH = 64;
const MAX_ANCHOR_TEXT_LENGTH = 400;
// Multi-select caps: the additional-target array is bounded at the trust
// boundary (a hostile page cannot grow a draft past this), and the bridge's
// short target keys / 40-char hover labels get generous-but-hard ceilings.
export const MAX_ADDITIONAL_TARGETS = 16;
const MAX_TARGET_KEY_LENGTH = 64;
const MAX_TARGET_LABEL_LENGTH = 64;
// Selection text is page-controlled too (a pinpoint click posts the element's
// entire textContent), so it gets the same treatment: truncated here — not
// rejected, a legitimate huge selection still annotates — before it can reach
// React state, drafts, exported feedback, or a share URL. Mirrors
// MAX_SELECTION_TEXT in bridge-script.ts; this side is the authoritative one.
export const MAX_SELECTION_TEXT_LENGTH = 10000;

/** Truncate to the cap without ever splitting a UTF-16 surrogate pair (a
 * lone high surrogate becomes U+FFFD once UTF-8-encoded downstream). */
export function capSelectionText(text: string): string {
  if (text.length <= MAX_SELECTION_TEXT_LENGTH) return text;
  let cut = MAX_SELECTION_TEXT_LENGTH;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

/**
 * Validate a bridge-posted normalized marker point. Fail-closed but additive:
 * a malformed point is DROPPED (the marker falls back to the target-rect
 * default) without rejecting the anchor it rides on; finite values are
 * clamped into the normalized 0..1 range.
 */
function parseAnchorPoint(value: unknown): { x: number; y: number } | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y } = value;
  if (
    typeof x !== "number" || !Number.isFinite(x)
    || typeof y !== "number" || !Number.isFinite(y)
  ) {
    return undefined;
  }
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
}

/** Validate a bridge-posted element anchor. Exported for protocol tests. */
export function parseHtmlElementAnchor(value: unknown): HtmlElementAnchor | null {
  if (!isRecord(value)) return null;
  const { selector, tagName, text } = value;
  if (
    typeof selector !== "string"
    || selector.length === 0
    || selector.length > MAX_ANCHOR_SELECTOR_LENGTH
    || typeof tagName !== "string"
    || tagName.length === 0
    || tagName.length > MAX_ANCHOR_TAG_LENGTH
  ) {
    return null;
  }
  const point = parseAnchorPoint(value.point);
  if (text === undefined) return { selector, tagName, ...(point ? { point } : {}) };
  if (typeof text !== "string" || text.length > MAX_ANCHOR_TEXT_LENGTH) return null;
  return { selector, tagName, text, ...(point ? { point } : {}) };
}

function parseTargetKey(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TARGET_KEY_LENGTH
    ? value
    : null;
}

function parseTargetLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Labels derive from page-controlled attributes (aria-label etc.), so a
  // hostile page can embed newlines that would become real markdown structure
  // in the exported feedback — collapse ALL whitespace at the trust boundary.
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > MAX_TARGET_LABEL_LENGTH
    ? collapsed.slice(0, MAX_TARGET_LABEL_LENGTH)
    : collapsed;
}

function parseBridgeRect(value: unknown): BridgeRect | null {
  if (!isRecord(value)) return null;
  const { top, left, width, height } = value;
  return typeof top === "number" && Number.isFinite(top)
    && typeof left === "number" && Number.isFinite(left)
    && typeof width === "number" && Number.isFinite(width)
    && typeof height === "number" && Number.isFinite(height)
    ? { top, left, width, height }
    : null;
}

/** Validate any bridge message. Exported for protocol tests. */
export function parseBridgeMessage(value: unknown): BridgeMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;

  switch (value.type) {
    case `${PREFIX}selection`: {
      const rect = parseBridgeRect(value.rect);
      if (typeof value.text !== "string" || !rect) return null;
      return {
        type: value.type,
        text: capSelectionText(value.text),
        rect,
        modeOverride: parseEditorMode(value.modeOverride),
        anchor: parseHtmlElementAnchor(value.anchor) ?? undefined,
        pinpoint: value.pinpoint === true,
        targetKey: parseTargetKey(value.targetKey) ?? undefined,
        targetLabel: parseTargetLabel(value.targetLabel),
      };
    }
    case `${PREFIX}multi-target-added`: {
      const key = parseTargetKey(value.key);
      if (!key || typeof value.text !== "string") return null;
      return {
        type: value.type,
        key,
        label: parseTargetLabel(value.label),
        text: capSelectionText(value.text),
        anchor: parseHtmlElementAnchor(value.anchor) ?? undefined,
      };
    }
    case `${PREFIX}multi-target-removed`: {
      const key = parseTargetKey(value.key);
      return key ? { type: value.type, key } : null;
    }
    case `${PREFIX}pointer`:
      return typeof value.x === "number" && Number.isFinite(value.x)
        && typeof value.y === "number" && Number.isFinite(value.y)
        ? { type: value.type, x: value.x, y: value.y, shift: value.shift === true }
        : null;
    case `${PREFIX}selection-clear`:
      return { type: value.type };
    case `${PREFIX}selection-rect`: {
      const rect = parseBridgeRect(value.rect);
      return rect ? { type: value.type, rect } : null;
    }
    case `${PREFIX}keytype`:
      return typeof value.key === "string"
        ? { type: value.type, key: value.key }
        : null;
    case `${PREFIX}mark-click`:
      // The id is page-controlled like every other bridge string: cap it like
      // the bridge's own sync validation does (256) so a hostile page cannot
      // ship an unbounded string into parent state via a forged mark-click.
      return typeof value.id === "string" && value.id.length <= 256
        ? { type: value.type, id: value.id }
        : null;
    case `${PREFIX}unanchored`: {
      // Bounded like the bridge's own emission (512 ids, 256 chars each); any
      // out-of-contract entry rejects the whole report — the real bridge
      // never sends one, so a violation means a forged message.
      if (!Array.isArray(value.ids) || value.ids.length > 512) return null;
      const unanchoredIds: string[] = [];
      for (const entry of value.ids) {
        if (typeof entry !== "string" || entry.length > 256) return null;
        unanchoredIds.push(entry);
      }
      return { type: value.type, ids: unanchoredIds };
    }
    case `${PREFIX}resize`:
      return typeof value.height === "number" && Number.isFinite(value.height)
        ? { type: value.type, height: value.height }
        : null;
    default:
      return null;
  }
}

/**
 * Adapt source-validated iframe messages to the existing annotation UI.
 *
 * Malformed bridge payloads are ignored; annotations are posted back through
 * the iframe protocol and reported through the supplied callbacks.
 */
export function useHtmlAnnotation({
  iframeRef,
  enabled = true,
  onAddAnnotation,
  onSelectAnnotation,
  selectedAnnotationId,
  mode,
  onResize,
  onBridgePointer,
  onUnanchoredChange,
}: UseHtmlAnnotationOptions): Omit<
  UseAnnotationHighlighterReturn,
  "highlighterRef" | "highlightRange" | "highlightMathElement"
> & {
  /** In-flight multi-select targets (index 0 = primary); empty outside pinpoint drafts. */
  draftTargets: HtmlDraftTarget[];
  /** Remove one draft target (chip X). Removing the last cancels the draft. */
  removeDraftTarget: (key: string) => void;
  /** Flash a draft target's pinned outline in the page (chip hover). */
  flashDraftTarget: (key: string) => void;
  /** Bumped after every target add/remove so the composer can refocus its textarea. */
  composerFocusToken: number;
} {
  const [toolbarState, setToolbarState] = useState<ToolbarState | null>(null);
  const [commentPopover, setCommentPopover] = useState<CommentPopoverState | null>(null);
  const [quickLabelPicker, setQuickLabelPicker] = useState<QuickLabelPickerState | null>(null);
  const [draftTargets, setDraftTargets] = useState<HtmlDraftTarget[]>([]);
  const [composerFocusToken, setComposerFocusToken] = useState(0);

  const pendingTextRef = useRef<string>("");
  // Element anchor for the pending pinpoint selection — committed onto the
  // annotation so restoration can resolve the exact element again.
  const pendingAnchorRef = useRef<HtmlElementAnchor | null>(null);
  const draftTargetsRef = useRef<HtmlDraftTarget[]>(draftTargets);
  draftTargetsRef.current = draftTargets;
  const onBridgePointerRef = useRef(onBridgePointer);
  onBridgePointerRef.current = onBridgePointer;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Mirror toolbar visibility into a ref so the (stable) message handler can gate
  // type-to-comment on "the markup toolbar is showing", like AnnotationToolbar does.
  const toolbarStateRef = useRef(toolbarState);
  toolbarStateRef.current = toolbarState;
  // Mirror the open comment/quick-label state so the selection-clear handler can
  // tell whether the user is mid-compose and must keep the captured text alive.
  const commentPopoverRef = useRef(commentPopover);
  commentPopoverRef.current = commentPopover;
  const quickLabelPickerRef = useRef(quickLabelPicker);
  quickLabelPickerRef.current = quickLabelPicker;

  const onAddRef = useRef(onAddAnnotation);
  onAddRef.current = onAddAnnotation;
  const onSelectRef = useRef(onSelectAnnotation);
  onSelectRef.current = onSelectAnnotation;
  const onUnanchoredChangeRef = useRef(onUnanchoredChange);
  onUnanchoredChangeRef.current = onUnanchoredChange;

  const anchorRef = useRef<HTMLDivElement | null>(null);

  /**
   * Remove one draft target. Removing the primary promotes the next remaining
   * target (the composer's context text and pending anchor follow it);
   * removing the final target cancels the draft. The bridge performs the same
   * deterministic update on its side, so `remove-target` is ALWAYS posted:
   * for chip removals it drives the bridge, and for bridge-echoed removals it
   * is an idempotent no-op — which also resyncs the two sides if a hostile
   * page forged the removal message the bridge never actually performed.
   */
  const applyTargetRemoval = useCallback(
    (key: string) => {
      const targets = draftTargetsRef.current;
      const index = targets.findIndex((t) => t.key === key);
      if (index < 0) return;
      postToIframe(iframeRef.current, { type: `${PREFIX}remove-target`, key });
      const remaining = targets.filter((t) => t.key !== key);
      if (remaining.length === 0) {
        // Final target removed — the draft is cancelled (bridge side already
        // tore down its pinned state via toggle-off or the remove-target post).
        setDraftTargets([]);
        setCommentPopover(null);
        pendingTextRef.current = "";
        pendingAnchorRef.current = null;
        return;
      }
      if (index === 0) {
        // Primary removed — promote the next target: the comment's quoted
        // text and restoration anchor now belong to it.
        const next = remaining[0]!;
        pendingTextRef.current = next.text;
        pendingAnchorRef.current = next.anchor;
        setCommentPopover((prev) =>
          prev ? { ...prev, contextText: next.text, selectedText: next.text } : prev,
        );
      }
      setDraftTargets(remaining);
      setComposerFocusToken((t) => t + 1);
    },
    [iframeRef],
  );

  const getOrCreateAnchor = useCallback(() => {
    if (!anchorRef.current) {
      const div = document.createElement("div");
      div.style.position = "fixed";
      div.style.pointerEvents = "none";
      div.style.width = "1px";
      div.style.height = "1px";
      document.body.appendChild(div);
      anchorRef.current = div;
    }
    return anchorRef.current;
  }, []);

  const positionAnchor = useCallback(
    (bridgeRect: { top: number; left: number; width: number; height: number }) => {
      const iframe = iframeRef.current;
      if (!iframe) return null;
      const iframeRect = iframe.getBoundingClientRect();
      // Fresh anchor per selection. The toolbar/popover recompute position only
      // when their `element` node identity changes, so reusing one anchor div
      // leaves them pinned to the previous selection. Drop the old one first.
      if (anchorRef.current) anchorRef.current.remove();
      anchorRef.current = null;
      const anchor = getOrCreateAnchor();
      anchor.style.top = `${iframeRect.top + bridgeRect.top}px`;
      anchor.style.left = `${iframeRect.left + bridgeRect.left + bridgeRect.width / 2}px`;
      return anchor;
    },
    [iframeRef, getOrCreateAnchor],
  );

  useEffect(() => {
    function handler(e: MessageEvent<unknown>) {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const message = parseBridgeMessage(e.data);
      if (!message) return;

      const type = message.type;

      if (
        !enabledRef.current
        && type !== `${PREFIX}mark-click`
        && type !== `${PREFIX}unanchored`
        && type !== `${PREFIX}resize`
      ) {
        return;
      }

      if (type === `${PREFIX}selection`) {
        pendingTextRef.current = message.text;
        pendingAnchorRef.current = message.anchor ?? null;
        setDraftTargets([]); // a new selection always starts a fresh draft
        const anchor = positionAnchor(message.rect);
        if (!anchor) return;

        const currentMode = message.modeOverride ?? modeRef.current;

        if (currentMode === "redline") {
          const id = nextHtmlAnnId();
          postToIframe(iframeRef.current, { type: `${PREFIX}create-mark`, id, annotationType: "deletion" });
          onAddRef.current?.({
            id,
            blockId: "",
            startOffset: 0,
            endOffset: 0,
            type: AnnotationType.DELETION,
            originalText: message.text,
            author: getIdentity(),
            createdA: Date.now(),
            htmlAnchor: message.anchor,
          });
          pendingTextRef.current = "";
          pendingAnchorRef.current = null;
        } else if (
          currentMode === "comment"
          // Pinpoint click-to-pin: the click already chose the target, so skip
          // the intermediate toolbar and go straight to the comment composer.
          || (message.pinpoint && currentMode === "selection")
        ) {
          // Release iframe focus so the popover's textarea autofocus lands in the
          // parent (otherwise the iframe keeps focus and swallows further keys).
          iframeRef.current?.blur();
          setCommentPopover({
            anchorEl: anchor,
            contextText: message.text,
            selectedText: message.text,
          });
          // Pinpoint drafts arm shift-click multi-select: the clicked element
          // becomes the primary target of the (single) draft comment. The
          // bridge only accepts shift-toggles once THIS explicit arm arrives,
          // so drafts the composer does not mirror (quickLabel, redline) can
          // never accumulate pins the saved annotation would not carry.
          if (message.pinpoint && message.targetKey) {
            setDraftTargets([
              {
                key: message.targetKey,
                label: message.targetLabel,
                text: message.text,
                anchor: message.anchor ?? null,
              },
            ]);
            postToIframe(iframeRef.current, {
              type: `${PREFIX}arm-multi-select`,
              key: message.targetKey,
            });
          }
        } else if (currentMode === "quickLabel") {
          setQuickLabelPicker({
            anchorEl: anchor,
            cursorHint: { x: parseFloat(anchor.style.left), y: parseFloat(anchor.style.top) },
          });
        } else {
          setToolbarState({
            element: anchor,
            source: null,
            selectionText: message.text,
          });
        }
      }

      if (type === `${PREFIX}multi-target-added`) {
        // Only meaningful while a pinpoint draft composer is open. The array
        // cap is enforced HERE, at the trust boundary — a hostile page cannot
        // grow the draft past MAX_ADDITIONAL_TARGETS extra targets.
        const targets = draftTargetsRef.current;
        if (
          commentPopoverRef.current
          && targets.length > 0
          && targets.length < 1 + MAX_ADDITIONAL_TARGETS
          && !targets.some((t) => t.key === message.key)
        ) {
          setDraftTargets([
            ...targets,
            {
              key: message.key,
              label: message.label,
              text: message.text,
              anchor: message.anchor ?? null,
            },
          ]);
          setComposerFocusToken((t) => t + 1);
        }
      }

      if (type === `${PREFIX}multi-target-removed`) {
        applyTargetRemoval(message.key);
      }

      if (type === `${PREFIX}pointer`) {
        onBridgePointerRef.current?.(message.x, message.y, message.shift);
      }

      if (type === `${PREFIX}selection-clear`) {
        setToolbarState(null);
        // Keep the captured text alive while a comment/quick-label is open: the user
        // is composing, and the selection collapsing or scrolling out of view must
        // not drop the annotation on submit. It's overwritten on the next selection.
        if (!commentPopoverRef.current && !quickLabelPickerRef.current) {
          pendingTextRef.current = "";
          pendingAnchorRef.current = null;
        }
      }

      if (type === `${PREFIX}selection-rect`) {
        // The iframe content scrolled — move the anchor to the selection's new
        // position and nudge the toolbar/popover (which listen to window scroll) to
        // recompute, so they stay attached to the selection.
        const iframe = iframeRef.current;
        const anchor = anchorRef.current;
        if (!iframe || !anchor) return;
        const r = message.rect;
        const iframeRect = iframe.getBoundingClientRect();
        anchor.style.top = `${iframeRect.top + r.top}px`;
        anchor.style.left = `${iframeRect.left + r.left + r.width / 2}px`;
        window.dispatchEvent(new Event("scroll"));
      }

      if (type === `${PREFIX}keytype`) {
        // Type-to-comment: only when the markup toolbar is showing (matches the
        // markdown path, where AnnotationToolbar owns this keydown). Open a comment
        // pre-filled with the typed char.
        if (!toolbarStateRef.current) return;
        const key = message.key;
        const text = pendingTextRef.current;
        if (!key || !text) return;
        const anchor = anchorRef.current ?? getOrCreateAnchor();
        // Release iframe focus so the popover textarea can take it (and the rest of
        // the typing) — otherwise the iframe keeps focus and the bridge eats keys.
        iframeRef.current?.blur();
        setToolbarState(null);
        setCommentPopover({ anchorEl: anchor, contextText: text, selectedText: text, initialText: key });
      }

      if (type === `${PREFIX}mark-click`) {
        onSelectRef.current?.(message.id);
      }

      if (type === `${PREFIX}unanchored`) {
        onUnanchoredChangeRef.current?.(message.ids);
      }

      if (type === `${PREFIX}resize`) {
        onResize?.(message.height);
      }
    }

    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      if (anchorRef.current) {
        anchorRef.current.remove();
        anchorRef.current = null;
      }
    };
  }, [iframeRef, positionAnchor, onResize, getOrCreateAnchor, applyTargetRemoval]);

  useEffect(() => {
    if (enabled) return;
    setToolbarState(null);
    setCommentPopover(null);
    setQuickLabelPicker(null);
    setDraftTargets([]);
    pendingTextRef.current = "";
    pendingAnchorRef.current = null;
    anchorRef.current?.remove();
    anchorRef.current = null;
    postToIframe(iframeRef.current, { type: `${PREFIX}cancel-selection` });
  }, [enabled, iframeRef]);

  useEffect(() => {
    if (selectedAnnotationId) {
      postToIframe(iframeRef.current, {
        type: `${PREFIX}scroll-to`,
        id: selectedAnnotationId,
      });
    } else {
      postToIframe(iframeRef.current, {
        type: `${PREFIX}focus-mark`,
        id: null,
      });
    }
  }, [selectedAnnotationId, iframeRef]);

  const handleAnnotate = useCallback(
    (type: AnnotationType) => {
      if (!enabledRef.current) return;
      const text = pendingTextRef.current;
      if (!text || type !== AnnotationType.DELETION) return;

      const id = nextHtmlAnnId();
      postToIframe(iframeRef.current, { type: `${PREFIX}create-mark`, id, annotationType: "deletion" });
      onAddRef.current?.({
        id,
        blockId: "",
        startOffset: 0,
        endOffset: 0,
        type: AnnotationType.DELETION,
        originalText: text,
        author: getIdentity(),
        createdA: Date.now(),
        htmlAnchor: pendingAnchorRef.current ?? undefined,
      });

      setToolbarState(null);
      pendingTextRef.current = "";
      pendingAnchorRef.current = null;
    },
    [iframeRef],
  );

  const handleRequestComment = useCallback(
    (initialChar?: string) => {
      if (!enabledRef.current) return;
      const text = pendingTextRef.current;
      if (!text) return;
      const anchor = anchorRef.current ?? getOrCreateAnchor();
      setToolbarState(null);
      setCommentPopover({ anchorEl: anchor, contextText: text, selectedText: text, initialText: initialChar });
    },
    [getOrCreateAnchor],
  );

  const handleCommentSubmit = useCallback(
    (comment: string, images?: ImageAttachment[]) => {
      if (!enabledRef.current) return;
      // Prefer the text captured when the popover opened — it can't be clobbered by
      // a later selection change or clear while the user is composing the comment.
      const text = commentPopoverRef.current?.selectedText || pendingTextRef.current;
      if (!text) return;

      // Multi-select: everything past the primary rides on the SAME comment.
      const targets = draftTargetsRef.current;
      const additionalTargets: HtmlAnnotationTarget[] | undefined =
        targets.length > 1
          ? targets.slice(1, 1 + MAX_ADDITIONAL_TARGETS).map((t) => ({
              label: t.label,
              text: t.text,
              anchor: t.anchor ?? undefined,
            }))
          : undefined;

      const id = nextHtmlAnnId();
      postToIframe(iframeRef.current, { type: `${PREFIX}create-mark`, id, annotationType: "comment" });
      onAddRef.current?.({
        id,
        blockId: "",
        startOffset: 0,
        endOffset: 0,
        type: AnnotationType.COMMENT,
        text: comment,
        originalText: text,
        author: getIdentity(),
        createdA: Date.now(),
        images,
        htmlAnchor: pendingAnchorRef.current ?? undefined,
        htmlAdditionalTargets: additionalTargets,
      });

      setCommentPopover(null);
      setDraftTargets([]);
      pendingTextRef.current = "";
      pendingAnchorRef.current = null;
    },
    [iframeRef],
  );

  const handleCommentClose = useCallback(() => {
    postToIframe(iframeRef.current, { type: `${PREFIX}cancel-selection` });
    setCommentPopover(null);
    setDraftTargets([]);
    pendingTextRef.current = "";
    pendingAnchorRef.current = null;
  }, [iframeRef]);

  const removeDraftTarget = useCallback(
    (key: string) => {
      if (!enabledRef.current) return;
      applyTargetRemoval(key);
    },
    [applyTargetRemoval],
  );

  const flashDraftTarget = useCallback(
    (key: string) => {
      postToIframe(iframeRef.current, { type: `${PREFIX}flash-target`, key });
    },
    [iframeRef],
  );

  const handleToolbarClose = useCallback(() => {
    postToIframe(iframeRef.current, { type: `${PREFIX}cancel-selection` });
    setToolbarState(null);
    pendingTextRef.current = "";
    pendingAnchorRef.current = null;
  }, [iframeRef]);

  const applyQuickLabel = useCallback(
    (label: QuickLabel, clearState: () => void) => {
      if (!enabledRef.current) return;
      const text = pendingTextRef.current;
      if (!text) return;
      const id = nextHtmlAnnId();
      postToIframe(iframeRef.current, { type: `${PREFIX}create-mark`, id, annotationType: "comment" });
      onAddRef.current?.({
        id,
        blockId: "",
        startOffset: 0,
        endOffset: 0,
        type: AnnotationType.COMMENT,
        text: label.text,
        originalText: text,
        isQuickLabel: true,
        quickLabelTip: label.tip,
        author: getIdentity(),
        createdA: Date.now(),
        htmlAnchor: pendingAnchorRef.current ?? undefined,
      });
      clearState();
      pendingTextRef.current = "";
      pendingAnchorRef.current = null;
    },
    [iframeRef],
  );

  const handleQuickLabel = useCallback(
    (label: QuickLabel) => applyQuickLabel(label, () => setToolbarState(null)),
    [applyQuickLabel],
  );

  const handleFloatingQuickLabel = useCallback(
    (label: QuickLabel) => applyQuickLabel(label, () => setQuickLabelPicker(null)),
    [applyQuickLabel],
  );

  const handleQuickLabelPickerDismiss = useCallback(() => {
    postToIframe(iframeRef.current, { type: `${PREFIX}cancel-selection` });
    setQuickLabelPicker(null);
    pendingTextRef.current = "";
    pendingAnchorRef.current = null;
  }, [iframeRef]);

  const removeHighlight = useCallback(
    (id: string) => {
      postToIframe(iframeRef.current, { type: `${PREFIX}remove-mark`, id });
    },
    [iframeRef],
  );

  const clearAllHighlights = useCallback(() => {
    postToIframe(iframeRef.current, { type: `${PREFIX}clear-marks` });
  }, [iframeRef]);

  const applyAnnotations = useCallback(
    (anns: Annotation[]) => {
      for (const ann of anns) {
        if (ann.type === AnnotationType.GLOBAL_COMMENT) continue;
        const annType = ann.type === AnnotationType.DELETION ? "deletion" : "comment";
        // Multi-target annotations restore every additional target as a pin
        // under the same id (same badge number). Anchor-only and capped.
        const additionalAnchors = (ann.htmlAdditionalTargets ?? [])
          .map((t) => t.anchor)
          .filter((a): a is HtmlElementAnchor => !!a)
          .slice(0, MAX_ADDITIONAL_TARGETS);
        postToIframe(iframeRef.current, {
          type: `${PREFIX}find-and-mark`,
          id: ann.id,
          originalText: ann.originalText,
          annotationType: annType,
          // Anchor-first restore: the bridge resolves the serialized element
          // and scopes the text search to it, falling back to document-wide.
          anchor: ann.htmlAnchor,
          additionalAnchors: additionalAnchors.length ? additionalAnchors : undefined,
        });
      }
    },
    [iframeRef],
  );

  return {
    toolbarState,
    commentPopover,
    quickLabelPicker,
    handleAnnotate,
    handleQuickLabel,
    handleToolbarClose,
    handleRequestComment,
    handleCommentSubmit,
    handleCommentClose,
    handleFloatingQuickLabel,
    handleQuickLabelPickerDismiss,
    removeHighlight,
    clearAllHighlights,
    applyAnnotations,
    draftTargets,
    removeDraftTarget,
    flashDraftTarget,
    composerFocusToken,
  };
}
