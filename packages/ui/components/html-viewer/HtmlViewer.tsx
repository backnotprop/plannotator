import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useVimDocumentFocus } from "../../hooks/useVimDocumentFocus";
import {
  isVimSelectionActionId,
  type VimSelectionHudContext,
} from "../../shortcuts";
import type { Annotation, EditorMode, ImageAttachment, InputMethod } from "../../types";
import { AnnotationType } from "../../types";
import { copyTextPreservingFocus } from "../../utils/clipboard";
import { getIdentity } from "../../utils/identity";
import { THUMBS_UP_LABEL } from "../../utils/quickLabels";
import {
  createVimHudCommand,
  getVimHudPhase,
  type VimHudCommand,
} from "../../utils/vimHud";
import { AnnotationToolbar } from "../AnnotationToolbar";
import { AttachmentsButton } from "../AttachmentsButton";
import {
  CommentPopover,
  type CommentAskAIHandler,
  type CommentTargetChip,
} from "../CommentPopover";
import { VimKeyHud } from "../VimKeyHud";
import type { ViewerHandle } from "../Viewer";
import {
  computeComposerYield,
  distanceToRect,
  type ComposerYieldState,
} from "./composerYield";
import { buildSyncNumbering } from "./annotationNumbering";
import { mergeUnanchoredIds } from "./unanchored";
import {
  MAX_PAGE_URL_LENGTH,
  checkBridgeProtocolVersion,
  formatBridgeProtocolWarning,
  rejectsLiveMessage,
  useHtmlAnnotation,
  type HtmlLiveSession,
} from "./useHtmlAnnotation";
import {
  THEME_TOKENS,
  buildSrcdocInjection,
  buildThemeTokenPayload,
  hasHostThemeOptIn,
  injectIntoHead,
  resolveBridgeScriptUrl,
} from "./srcdoc";

const PREFIX = "plannotator-bridge-";

function readThemeTokens(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const key of THEME_TOKENS) {
    const val = style.getPropertyValue(key).trim();
    if (val) tokens[key] = val;
  }
  return tokens;
}

function isLightTheme(): boolean {
  return document.documentElement.classList.contains("light");
}

function isBridgeReadyMessage(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && "type" in value
    && value.type === `${PREFIX}ready`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseVimSelectionHudContext(
  value: unknown,
): VimSelectionHudContext | null {
  return value === "inactive"
    || value === "block"
    || value === "inline"
    || value === "text"
    || value === "visual"
    || value === "visual-block"
    || value === "action"
    ? value
    : null;
}

interface VimBridgeCommand {
  readonly actionId: Parameters<typeof createVimHudCommand>[1];
  readonly key: string;
  readonly context: VimSelectionHudContext;
}

function parseVimBridgeCommand(value: unknown): VimBridgeCommand | null {
  if (
    !isRecord(value)
    || value.type !== `${PREFIX}vim-command`
    || !isVimSelectionActionId(value.actionId)
    || typeof value.key !== "string"
  ) {
    return null;
  }
  const context = parseVimSelectionHudContext(value.context);
  return context
    ? { actionId: value.actionId, key: value.key, context }
    : null;
}

function parseVimBridgeState(value: unknown): VimSelectionHudContext | null {
  return isRecord(value) && value.type === `${PREFIX}vim-state`
    ? parseVimSelectionHudContext(value.phase)
    : null;
}

function parseVimBridgeHelp(value: unknown): boolean | null {
  return isRecord(value)
    && value.type === `${PREFIX}vim-help`
    && typeof value.open === "boolean"
    ? value.open
    : null;
}

const MAX_VIM_COPY_TEXT_LENGTH = 2 * 1024 * 1024;

/** Default wait for the bridge's `ready` on the `bridgeScriptUrl` path. */
export const DEFAULT_BRIDGE_READY_TIMEOUT_MS = 5000;

/**
 * Why the bridge could not be established on the `bridgeScriptUrl` path.
 * Never produced on the inline path (the bridge and the parent are one
 * bundle there, and no ready timer runs).
 */
export type BridgeUnavailableInfo =
  | {
      kind: "timeout";
      url: string;
      /** The wait that elapsed without a `ready`. */
      timeoutMs: number;
    }
  | {
      kind: "version-mismatch";
      url: string;
      expectedVersion: number;
      /** Absent when the ready carried no stamp (a pre-stamp asset). */
      reportedVersion?: number;
    };

/** User-facing message for the in-surface error banner. */
export function formatBridgeUnavailableMessage(info: BridgeUnavailableInfo): string {
  if (info.kind === "timeout") {
    return `Annotation tools did not load: the bridge script at ${info.url} sent no ready signal within ${info.timeoutMs} ms. The page is shown without annotation. Check that the URL is reachable and that your Content Security Policy allows script-src for that origin.`;
  }
  const reported = info.reportedVersion === undefined ? "no version" : `version ${info.reportedVersion}`;
  return `Annotation tools may not work: this viewer expects bridge protocol version ${info.expectedVersion}, but the script at ${info.url} reported ${reported}. Serve the bridge-script asset from the same @plannotator/ui version as the viewer.`;
}

function parseVimBridgeCopy(value: unknown): string | null {
  return isRecord(value)
    && value.type === `${PREFIX}vim-copy`
    && typeof value.text === "string"
    && value.text.length > 0
    && value.text.length <= MAX_VIM_COPY_TEXT_LENGTH
    ? value.text
    : null;
}

/** Inputs for the sandboxed raw-HTML viewer and its parent-side annotation UI. */
export interface HtmlViewerProps {
  rawHtml: string;
  /** Live proxied-app mode: render `src` (no sandbox, no srcdoc) instead of
   *  rawHtml. The caller must also set `fullViewport` and `liveSession`. */
  src?: string;
  /** Live session credentials paired with `src`: proxy origin + per-session
   *  token, validated on every inbound message and stamped on every post. */
  liveSession?: HtmlLiveSession;
  /** Current page (pathname + search) in a live multi-page session. Restore
   *  filters annotations to this page; changing it re-applies the filter. */
  currentPageUrl?: string;
  /** Live-mode page navigation reports (ready pageUrl + page-change). */
  onPageChange?: (pageUrl: string) => void;
  annotations: Annotation[];
  onAddAnnotation: (ann: Annotation) => void;
  onSelectAnnotation: (id: string | null) => void;
  selectedAnnotationId: string | null;
  mode: EditorMode;
  /** Input method: 'drag' = text selection, 'pinpoint' = click an element. */
  inputMethod: InputMethod;
  /** Interact/Annotate toggle for HTML and live-app surfaces. While false
   *  the bridge keeps clicks native (no pinpoint capture, no hover outline)
   *  and clicks/forms/navigation reach the page untouched. Text
   *  drag-selection commenting stays live in BOTH modes, and committed
   *  markers stay visible and clickable in BOTH modes. Default true (armed)
   *  on both surface kinds. */
  annotateModeActive?: boolean;
  /** Esc final rung (bridge-side or the parent-side listener here): the user
   *  asked to leave Annotate for Interact. The host owns the mode state. */
  onAnnotateModeExit?: () => void;
  /** Mod+Shift+A pressed while focus lived inside the iframe. */
  onAnnotateModeToggle?: () => void;
  /** Opt-in Vim-style keyboard selection. Default false for compatibility. */
  vimModeEnabled?: boolean;
  /** Replace the iframe-local compact badge with the shared live key HUD. */
  vimHudEnabled?: boolean;
  /** Show the parent key panel without affecting the iframe HUD reticle. */
  vimHudKeyPanelEnabled?: boolean;
  /** Persist a user request to hide the parent key panel. */
  onVimHudKeyPanelChange?: (enabled: boolean) => void;
  globalAttachments?: ImageAttachment[];
  onAddGlobalAttachment?: (image: ImageAttachment) => void;
  onRemoveGlobalAttachment?: (path: string) => void;
  maxWidth?: number | null;
  /** Render edge-to-edge: fill the viewport, drop the card chrome + action bar,
   *  and let the iframe own the full height instead of auto-resizing to content. */
  fullViewport?: boolean;
  /** Hide the floating doc-level controls (attachments + global comment) in
   *  full-viewport mode, so the user can read the page unobstructed. */
  hideControls?: boolean;
  /** A version diff (vs the previous version) is available to toggle. */
  diffAvailable?: boolean;
  /** Whether the diff-highlighted HTML is currently shown. */
  diffActive?: boolean;
  /** Toggle the diff-highlighted view on/off. */
  onToggleDiff?: () => void;
  onAskAI?: CommentAskAIHandler;
  /** Disable every annotation mutation entry point while preserving reading and navigation. */
  readOnly?: boolean;
  /** Reports the full set of annotation ids with no live representation on
   *  the page (fail-closed anchors hide markers rather than guess). Called
   *  with the complete current set whenever it changes, including back to
   *  empty on recovery. Fires in readOnly mode too. Complete over the
   *  `annotations` prop: page rows with nothing to restore by (no quoted
   *  text, no element anchor) are reported even though the bridge never
   *  sees them, and an id this viewer minted for a local comment that the
   *  host swapped out of `annotations` for its own id is not reported. */
  onUnanchoredChange?: (ids: string[]) => void;
  /** Product cap on additional (shift-click) targets per comment, 0..16.
   *  Enforced at the trust boundary, on submit and on restore, and carried
   *  to the bridge so the in-page toggle stops at the same number. Default
   *  16 (the package cap); absent leaves every message unchanged. */
  maxAdditionalTargets?: number;
  /** scrollIntoView behavior when a selected annotation is scrolled into
   *  view inside the page. Default 'smooth'; pass 'auto' to carry the
   *  parent's reduced-motion preference across the iframe boundary. */
  scrollBehavior?: 'smooth' | 'auto';
  /** Accessible iframe title. */
  title?: string;
  /**
   * Opt-in: load the annotation bridge into the srcdoc document through a
   * classic `<script src>` from this URL (the package's generated
   * `components/html-viewer/bridge-script.asset.js`, served by the host)
   * instead of inlining the 185 KB script into every document. Absent (the
   * default, and Plannotator's only path): inline, unchanged. The tag lands
   * where the inline script does, at the end of `<head>`, before the body.
   * The URL is resolved against THIS document's base (`document.baseURI`)
   * before it is written, never against the framed page, so a page's own
   * `<base href>` cannot redirect it. The srcdoc frame is an opaque origin,
   * so the script needs no CORS and no `crossorigin` attribute is set; a CSP
   * header on the host page is inherited by the frame and must allow
   * `script-src` for the asset origin, and the asset must not be served with
   * `Cross-Origin-Resource-Policy: same-origin`. Ignored in live (`src`)
   * mode, where the proxy injects the bridge.
   */
  bridgeScriptUrl?: string;
  /**
   * How long to wait for the bridge's `ready` after each document load on
   * the `bridgeScriptUrl` path before the surface shows an error state.
   * Default 5000 ms. No timer runs on the inline path.
   */
  bridgeReadyTimeoutMs?: number;
  /** The bridge could not be established on the `bridgeScriptUrl` path (no
   *  ready within the timeout, or a protocol version mismatch). The surface
   *  shows its own banner as well unless `bridgeErrorDisplay` is `'none'`;
   *  this lets the host react (telemetry, a retry affordance). Never called
   *  on the inline path. */
  onBridgeUnavailable?: (info: BridgeUnavailableInfo) => void;
  /**
   * Who renders the bridge-failure strip on the `bridgeScriptUrl` path.
   * `'banner'` (default): the package renders its `[data-bridge-error]`
   * strip over the frame, as in 0.33.0. `'none'`: no strip is rendered and
   * the host owns the display through `onBridgeUnavailable`, which fires
   * exactly as before (and a version mismatch still logs its one console
   * warning). Meaningless on the inline path, which never shows a strip.
   */
  bridgeErrorDisplay?: "banner" | "none";
}

/**
 * Render arbitrary HTML in a sandbox and adapt its validated bridge messages
 * to the same annotation controls used by the Markdown viewer.
 */
export const HtmlViewer = forwardRef<ViewerHandle, HtmlViewerProps>(
  (
    {
      rawHtml,
      src,
      liveSession,
      currentPageUrl,
      onPageChange,
      annotations,
      onAddAnnotation,
      onSelectAnnotation,
      selectedAnnotationId,
      mode,
      inputMethod,
      annotateModeActive = true,
      onAnnotateModeExit,
      onAnnotateModeToggle,
      vimModeEnabled = false,
      vimHudEnabled = false,
      vimHudKeyPanelEnabled = true,
      onVimHudKeyPanelChange,
      globalAttachments = [],
      onAddGlobalAttachment,
      onRemoveGlobalAttachment,
      maxWidth,
      fullViewport,
      hideControls,
      diffAvailable,
      diffActive,
      onToggleDiff,
      onAskAI,
      readOnly = false,
      onUnanchoredChange,
      maxAdditionalTargets,
      scrollBehavior,
      title = "HTML Plan Viewer",
      bridgeScriptUrl,
      bridgeReadyTimeoutMs = DEFAULT_BRIDGE_READY_TIMEOUT_MS,
      onBridgeUnavailable,
      bridgeErrorDisplay = "banner",
    },
    ref,
  ) => {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const globalCommentButtonRef = useRef<HTMLButtonElement>(null);
    const [iframeHeight, setIframeHeight] = useState(600);
    // Increment on every bridge-ready event so srcdoc navigations re-send
    // state even though the iframe element and its WindowProxy are reused.
    const [iframeReadyVersion, setIframeReadyVersion] = useState(0);
    const [iframeFocused, setIframeFocused] = useState(false);
    const [vimBridgePhase, setVimBridgePhase] =
      useState<VimSelectionHudContext>("inactive");
    const [vimHudCommand, setVimHudCommand] = useState<VimHudCommand | null>(null);
    const [vimHelpOpen, setVimHelpOpen] = useState(false);
    const vimHudSequenceRef = useRef(0);
    const vimHudActive = !readOnly && vimModeEnabled && vimHudEnabled;
    const [globalCommentPopover, setGlobalCommentPopover] = useState<{
      anchorEl: HTMLElement;
      contextText: string;
    } | null>(null);

    // Live proxied-app mode: the iframe navigates a real origin, so the
    // srcdoc pipeline is skipped entirely and its messages carry credentials.
    const liveMode = !!src;
    const liveSessionRef = useRef<HtmlLiveSession | null>(liveSession ?? null);
    liveSessionRef.current = liveSession ?? null;
    const onPageChangeRef = useRef(onPageChange);
    onPageChangeRef.current = onPageChange;
    const onAnnotateModeExitRef = useRef(onAnnotateModeExit);
    onAnnotateModeExitRef.current = onAnnotateModeExit;
    const onAnnotateModeToggleRef = useRef(onAnnotateModeToggle);
    onAnnotateModeToggleRef.current = onAnnotateModeToggle;

    /** Single choke point for direct-to-bridge posts: live sessions get the
     *  token + concrete targetOrigin, srcdoc keeps "*" and no token. */
    const postToBridge = useCallback((msg: Record<string, unknown>) => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      const live = liveSessionRef.current;
      if (live) {
        // Browsers silently drop posts whose targetOrigin does not match the
        // receiving window (mid-navigation frames); some DOM environments
        // throw instead, so align with the browser semantics explicitly.
        try {
          win.postMessage({ ...msg, token: live.token }, live.origin);
        } catch {
          // Dropped, matching browser behavior for unmatched target origins.
        }
      } else {
        win.postMessage(msg, "*");
      }
    }, []);

    // Host theming is opt-in per document (Plannotator-generated artifacts tag
    // themselves); arbitrary HTML renders untouched, like a standalone tab.
    const hostTheme = useMemo(() => !liveMode && hasHostThemeOptIn(rawHtml), [liveMode, rawHtml]);

    // The URL path is srcdoc-only: live mode has the proxy inject the bridge.
    // Resolved against THIS document's base before it is written into the
    // srcdoc, so a framed page's own <base href> can never re-anchor it.
    const bridgeUrl = useMemo(
      () => (!liveMode && bridgeScriptUrl
        ? resolveBridgeScriptUrl(bridgeScriptUrl, document.baseURI)
        : undefined),
      [liveMode, bridgeScriptUrl],
    );
    const bridgeUrlRef = useRef(bridgeUrl);
    bridgeUrlRef.current = bridgeUrl;

    const srcdoc = useMemo(() => {
      if (liveMode) return undefined; // src mode: the proxy injects the bridge
      const injection = buildSrcdocInjection({
        tokens: readThemeTokens(),
        isLight: isLightTheme(),
        hostTheme,
        diffActive: !!diffActive,
        bridgeScriptUrl: bridgeUrl,
      });
      return injectIntoHead(rawHtml, injection);
    }, [liveMode, rawHtml, hostTheme, diffActive, bridgeUrl]);

    // Error state for the bridgeScriptUrl path only: the inline path never
    // sets it (no timer, and a version mismatch there can only be a forged
    // message, which is warned about and otherwise ignored).
    const [bridgeError, setBridgeError] = useState<BridgeUnavailableInfo | null>(null);
    // A version-mismatch banner is dismissible (the older bridge keeps
    // working); reset whenever the error itself changes.
    const [bridgeErrorDismissed, setBridgeErrorDismissed] = useState(false);
    const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const onBridgeUnavailableRef = useRef(onBridgeUnavailable);
    onBridgeUnavailableRef.current = onBridgeUnavailable;
    // The timeout is read through a ref at arming time: the timer is armed
    // once per document load (URL or srcdoc change), never re-armed by a
    // later prop change, so a host adjusting bridgeReadyTimeoutMs after the
    // bridge is ready can never produce a false timeout.
    const bridgeReadyTimeoutMsRef = useRef(bridgeReadyTimeoutMs);
    bridgeReadyTimeoutMsRef.current = bridgeReadyTimeoutMs;
    useEffect(() => {
      if (!bridgeUrl || srcdoc === undefined) return;
      setBridgeError(null);
      setBridgeErrorDismissed(false);
      const url = bridgeUrl;
      const timeoutMs = bridgeReadyTimeoutMsRef.current;
      readyTimerRef.current = setTimeout(() => {
        readyTimerRef.current = null;
        setBridgeError({ kind: "timeout", url, timeoutMs });
      }, timeoutMs);
      return () => {
        if (readyTimerRef.current !== null) clearTimeout(readyTimerRef.current);
        readyTimerRef.current = null;
      };
    }, [bridgeUrl, srcdoc]);
    useEffect(() => {
      setBridgeErrorDismissed(false);
      if (bridgeError) onBridgeUnavailableRef.current?.(bridgeError);
    }, [bridgeError]);

    const handleResize = useCallback((height: number) => {
      if (liveMode) return; // live surfaces are full-viewport; height is ignored
      setIframeHeight(height);
    }, [liveMode]);

    // Composer yield while shift-selecting (multi-target drafts): fade the
    // composer as the pointer approaches, click-through when over it. Pointer
    // positions arrive from parent mousemoves AND from the bridge (the iframe
    // consumes moves over the page, so the bridge relays them).
    const [composerYield, setComposerYield] = useState<ComposerYieldState>("none");
    const composerYieldRef = useRef(composerYield);
    composerYieldRef.current = composerYield;
    const shiftHeldRef = useRef(false);

    const handleYieldPointer = useCallback((clientX: number, clientY: number) => {
      if (!shiftHeldRef.current) return;
      const popover = document.querySelector("[data-comment-popover]");
      if (!popover) return;
      const rect = popover.getBoundingClientRect();
      const next = computeComposerYield(
        composerYieldRef.current,
        distanceToRect(clientX, clientY, rect),
      );
      if (next !== composerYieldRef.current) setComposerYield(next);
    }, []);

    const handleBridgePointer = useCallback(
      (x: number, y: number, shift: boolean) => {
        // The bridge is the only observer of Shift while the pointer lives
        // inside the sandbox (parent keydowns don't fire there, and window
        // blur clears our local flag when focus enters the iframe) — so the
        // relayed shift state arms/disarms the yield directly.
        shiftHeldRef.current = shift;
        if (!shift) {
          setComposerYield("none");
          return;
        }
        const iframeRect = iframeRef.current?.getBoundingClientRect();
        if (!iframeRect) return;
        handleYieldPointer(iframeRect.left + x, iframeRect.top + y);
      },
      [handleYieldPointer],
    );

    // Unanchored union: the bridge reports ids with no live representation,
    // completed here with what the bridge cannot see (textless page rows it
    // was never asked to restore) and minus locally minted ids the host
    // swapped out of `annotations`. Bridge reports deliver as they arrive
    // (pass-through timing); a prop-side change delivers only when the union
    // actually changes, so a viewer with nothing to complete delivers exactly
    // the bridge list, exactly when the bridge posts it.
    const onUnanchoredChangeRef = useRef(onUnanchoredChange);
    onUnanchoredChangeRef.current = onUnanchoredChange;
    const annotationsRef = useRef(annotations);
    annotationsRef.current = annotations;
    const bridgeUnanchoredRef = useRef<readonly string[]>([]);
    const lastDeliveredUnanchoredRef = useRef("[]");
    const createdIdsRef = useRef<ReadonlySet<string>>(new Set());
    // The bridge's first report for the current document is the one that
    // follows the restore batch (the parent asks for it with
    // report-unanchored, and the bridge answers after its next complete
    // pass, empty set included). Nothing is delivered before it: a host
    // that acknowledges "the first report after a reload" must get the
    // post-restore set, never a prop-side set computed at mount.
    const bridgeReportedRef = useRef(false);
    // An in-place document swap (rawHtml or src changes on one instance):
    // the old document may still emit through the same contentWindow before
    // the new one is ready. From the swap until the next ready, bridge
    // reports belong to the old document and are dropped, and the
    // last-delivered key is reset so the new document's first answer is
    // delivered even when it equals the old one. First mount is not a swap.
    const awaitingReadyRef = useRef(false);
    const documentIdentityRef = useRef<{ rawHtml: string; src: string | undefined } | null>(null);
    const previousIdentity = documentIdentityRef.current;
    if (previousIdentity && (previousIdentity.rawHtml !== rawHtml || previousIdentity.src !== src)) {
      awaitingReadyRef.current = true;
      bridgeReportedRef.current = false;
      lastDeliveredUnanchoredRef.current = "[]";
      bridgeUnanchoredRef.current = [];
    }
    documentIdentityRef.current = { rawHtml, src };
    const deliverUnanchored = useCallback((ids: string[], onlyIfChanged: boolean) => {
      const key = JSON.stringify(ids);
      if (onlyIfChanged && key === lastDeliveredUnanchoredRef.current) return;
      lastDeliveredUnanchoredRef.current = key;
      onUnanchoredChangeRef.current?.(ids);
    }, []);
    const handleBridgeUnanchored = useCallback((ids: string[]) => {
      if (awaitingReadyRef.current) return;
      bridgeUnanchoredRef.current = ids;
      bridgeReportedRef.current = true;
      deliverUnanchored(
        mergeUnanchoredIds({
          bridgeIds: ids,
          annotations: annotationsRef.current,
          createdIds: createdIdsRef.current,
        }),
        false,
      );
    }, [deliverUnanchored]);

    const hook = useHtmlAnnotation({
      iframeRef,
      enabled: !readOnly,
      annotations,
      onAddAnnotation,
      onSelectAnnotation,
      selectedAnnotationId,
      mode,
      onResize: handleResize,
      live: liveSession,
      onPageChange,
      onBridgePointer: handleBridgePointer,
      onUnanchoredChange: handleBridgeUnanchored,
      maxAdditionalTargets,
      scrollBehavior,
    });
    createdIdsRef.current = hook.createdAnnotationIds;

    useEffect(() => {
      if (!bridgeReportedRef.current) return;
      deliverUnanchored(
        mergeUnanchoredIds({
          bridgeIds: bridgeUnanchoredRef.current,
          annotations,
          createdIds: hook.createdAnnotationIds,
        }),
        true,
      );
    }, [annotations, hook.createdAnnotationIds, deliverUnanchored]);

    const multiSelectActive = !readOnly && !!hook.commentPopover && hook.draftTargets.length > 0;

    // Track Shift while a multi-select draft composer is open; releasing it
    // (or losing window focus) always restores the composer.
    useEffect(() => {
      if (!multiSelectActive) {
        shiftHeldRef.current = false;
        setComposerYield("none");
        return;
      }
      const down = (e: KeyboardEvent) => {
        if (e.key === "Shift") shiftHeldRef.current = true;
      };
      const release = () => {
        shiftHeldRef.current = false;
        setComposerYield("none");
      };
      const up = (e: KeyboardEvent) => {
        if (e.key === "Shift") release();
      };
      const move = (e: MouseEvent) => {
        // Parent-side pointer (over app chrome or the composer itself).
        if (e.shiftKey) shiftHeldRef.current = true;
        handleYieldPointer(e.clientX, e.clientY);
      };
      window.addEventListener("keydown", down);
      window.addEventListener("keyup", up);
      window.addEventListener("blur", release);
      window.addEventListener("mousemove", move);
      return () => {
        window.removeEventListener("keydown", down);
        window.removeEventListener("keyup", up);
        window.removeEventListener("blur", release);
        window.removeEventListener("mousemove", move);
      };
    }, [multiSelectActive, handleYieldPointer]);

    // Chip data for the composer: semantic label + short excerpt per target.
    const targetChips = useMemo<CommentTargetChip[] | undefined>(() => {
      if (!hook.draftTargets.length) return undefined;
      return hook.draftTargets.map((t) => ({
        key: t.key,
        label: t.label,
        excerpt: t.text.replace(/\s+/g, " ").trim().slice(0, 80),
      }));
    }, [hook.draftTargets]);

    useEffect(() => {
      function handler(e: MessageEvent<unknown>) {
        if (e.source !== iframeRef.current?.contentWindow) return;
        // Live sessions verify origin + token before reading anything.
        const live = liveSessionRef.current;
        if (live && rejectsLiveMessage(live, e.origin, e.data)) return;
        if (isBridgeReadyMessage(e.data)) {
          // Protocol stamp: one console warning on drift, naming both
          // versions. The ready is still honored (an older bridge answers
          // every message shape it knows); on the bridgeScriptUrl path the
          // surface additionally shows its error banner, because there the
          // drift is a real deployment state (a cached asset from a previous
          // package version) rather than a forged message.
          const verdict = checkBridgeProtocolVersion(e.data);
          const url = bridgeUrlRef.current;
          if (!verdict.ok) {
            console.warn(formatBridgeProtocolWarning(verdict, url));
          }
          if (url) {
            if (readyTimerRef.current !== null) {
              clearTimeout(readyTimerRef.current);
              readyTimerRef.current = null;
            }
            setBridgeError(
              verdict.ok
                ? null
                : {
                    kind: "version-mismatch",
                    url,
                    expectedVersion: verdict.expected,
                    reportedVersion: verdict.reported,
                  },
            );
          }
          setIframeReadyVersion((version) => version + 1);
          setVimBridgePhase("inactive");
          setVimHudCommand(null);
          setVimHelpOpen(false);
          // Live ready carries the page identity (validated like page-change)
          // so reloads and cross-page navigations re-anchor the restore filter.
          if (live && isRecord(e.data)) {
            const pageUrl = e.data.pageUrl;
            if (
              typeof pageUrl === "string"
              && pageUrl.length > 0
              && pageUrl.length <= MAX_PAGE_URL_LENGTH
            ) {
              onPageChangeRef.current?.(pageUrl);
            }
          }
          return;
        }
        // Interact/Annotate mode messages ride the same authenticated path:
        // live sessions already rejected wrong-origin/tokenless data above.
        if (isRecord(e.data) && e.data.type === `${PREFIX}annotate-exit`) {
          onAnnotateModeExitRef.current?.();
          return;
        }
        if (isRecord(e.data) && e.data.type === `${PREFIX}annotate-toggle`) {
          onAnnotateModeToggleRef.current?.();
          return;
        }
        const vimCopy = parseVimBridgeCopy(e.data);
        if (vimCopy !== null) {
          const iframe = iframeRef.current;
          if (
            !readOnly
            && vimModeEnabled
            && iframe
            && document.activeElement === iframe
          ) {
            copyTextPreservingFocus(vimCopy, iframe);
          }
          return;
        }
        if (!vimHudActive) return;
        const vimHelp = parseVimBridgeHelp(e.data);
        if (vimHelp !== null) {
          setVimHelpOpen(vimHelp);
          return;
        }
        const vimState = parseVimBridgeState(e.data);
        if (vimState) {
          setVimBridgePhase(vimState);
          return;
        }
        const vimCommand = parseVimBridgeCommand(e.data);
        if (vimCommand) {
          vimHudSequenceRef.current += 1;
          setVimHudCommand(createVimHudCommand(
            vimHudSequenceRef.current,
            vimCommand.actionId,
            vimCommand.key,
            vimCommand.context,
          ));
        }
      }
      window.addEventListener("message", handler);
      return () => window.removeEventListener("message", handler);
    }, [readOnly, vimHudActive, vimModeEnabled]);

    useEffect(() => {
      if (vimHudActive) return;
      setVimBridgePhase("inactive");
      setVimHudCommand(null);
      setVimHelpOpen(false);
    }, [vimHudActive]);

    const handleVimHelpOpenChange = useCallback((open: boolean) => {
      setVimHelpOpen(open);
      postToBridge(
        { type: `${PREFIX}set-vim-help`, open },
      );
    }, []);

    const handleVimHudFocusLeave = useCallback(() => {
      if (iframeRef.current === document.activeElement) return;
      setIframeFocused(false);
    }, []);

    const focusVimDocument = useCallback((): boolean => {
      const iframe = iframeRef.current;
      if (readOnly || !vimModeEnabled || !iframe) return false;
      if (document.activeElement === iframe) return false;
      iframe.focus({ preventScroll: true });
      if (document.activeElement !== iframe) return false;
      postToBridge(
        { type: `${PREFIX}focus-vim` },
      );
      return true;
    }, [readOnly, vimModeEnabled]);

    useVimDocumentFocus({
      enabled: !readOnly && vimModeEnabled,
      blocked: !!hook.toolbarState || !!hook.commentPopover || !!hook.quickLabelPicker,
      focusDocument: focusVimDocument,
    });

    // Restore filter for live multi-page sessions: only annotations made on
    // the current page (or without page identity) are pushed for restoration.
    // Numbering (sync-annotations) still ships the FULL list: numbers are
    // parent-authoritative and global across pages, matching export.
    const forCurrentPage = useCallback(
      (anns: Annotation[]) =>
        anns.filter((a) => !a.pageUrl || a.pageUrl === currentPageUrl),
      [currentPageUrl],
    );

    useEffect(() => {
      if (iframeReadyVersion === 0) return;
      const restorable = forCurrentPage(annotations);
      if (restorable.length > 0) {
        hook.applyAnnotations(restorable);
      }
      // A fresh document: the bridge starts from an empty set and would stay
      // silent when everything restores. Ask for one complete report after
      // this restore batch (posted after it, so the answering pass sees it),
      // which becomes this document's first delivery, empty set included.
      awaitingReadyRef.current = false;
      bridgeReportedRef.current = false;
      postToBridge({ type: `${PREFIX}report-unanchored` });
    }, [iframeReadyVersion]); // eslint-disable-line react-hooks/exhaustive-deps

    // Live page navigation with a ready iframe: explicitly clear the previous
    // page's marks, then re-apply the filtered set. Relying on dead anchors to
    // hide pins would risk cross-page text-search false matches and waste
    // reconcile budget.
    const lastAppliedPageRef = useRef<string | undefined>(currentPageUrl);
    useEffect(() => {
      if (lastAppliedPageRef.current === currentPageUrl) return;
      lastAppliedPageRef.current = currentPageUrl;
      if (iframeReadyVersion === 0) return;
      postToBridge({ type: `${PREFIX}clear-marks` });
      const restorable = forCurrentPage(annotations);
      if (restorable.length > 0) {
        hook.applyAnnotations(restorable);
      }
      // clear-marks drops the bridge's synced numbering; re-establish it so
      // restored markers keep their export-matching global numbers.
      postToBridge({
        type: `${PREFIX}sync-annotations`,
        annotations: buildSyncNumbering(annotations),
      });
      // A new page is a new restore batch: report its complete set once, and
      // deliver nothing computed against the previous page's report until
      // that answer arrives.
      bridgeReportedRef.current = false;
      postToBridge({ type: `${PREFIX}report-unanchored` });
    }, [currentPageUrl, iframeReadyVersion]); // eslint-disable-line react-hooks/exhaustive-deps

    // Placed-marker numbering is parent-authoritative and matches the
    // numbers exportAnnotations writes into the submitted feedback: the full
    // list INCLUDING globals is numbered by ARRAY position (the export's
    // effective order — its sort keys tie for raw-HTML annotations), and
    // globals then ship no entry (no page location) — see buildSyncNumbering
    // for the contract. Renumbers on delete; the bridge's own registration
    // order is only a pre-sync fallback.
    useEffect(() => {
      if (iframeReadyVersion === 0) return;
      postToBridge(
        { type: `${PREFIX}sync-annotations`, annotations: buildSyncNumbering(annotations) },
      );
    }, [iframeReadyVersion, annotations]);

    // Tell the bridge the current input method (drag vs pinpoint). Re-posts on
    // ready (fresh iframe) and whenever the user switches it in the toolstrip.
    useEffect(() => {
      if (iframeReadyVersion === 0) return;
      postToBridge(
        { type: `${PREFIX}set-input-method`, method: inputMethod },
      );
    }, [iframeReadyVersion, inputMethod]);

    // Tell the bridge whether Annotate is armed. Same re-post pattern as
    // set-input-method, so the mode survives live page changes / HMR reloads
    // and bridge re-injection without ever reloading the iframe.
    useEffect(() => {
      if (iframeReadyVersion === 0) return;
      postToBridge(
        { type: `${PREFIX}set-annotate-mode`, active: annotateModeActive },
      );
    }, [iframeReadyVersion, annotateModeActive]);

    // Parent-side Esc rung: with focus outside the iframe the bridge never
    // sees the keydown. Any open composer/toolbar/picker still closes first —
    // their state is read from this render's closure, so an Esc that closed
    // one this same keydown is not double-consumed here.
    useEffect(() => {
      if (readOnly || !annotateModeActive || !onAnnotateModeExit) return;
      const overlayOpen =
        !!hook.toolbarState || !!hook.commentPopover || !!hook.quickLabelPicker || !!globalCommentPopover;
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        if (overlayOpen) return;
        // A text field or dialog owns its own Escape.
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
        if (document.querySelector('[data-plannotator-confirm-dialog="true"]')) return;
        onAnnotateModeExit();
      };
      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
    }, [
      readOnly,
      annotateModeActive,
      onAnnotateModeExit,
      hook.toolbarState,
      hook.commentPopover,
      hook.quickLabelPicker,
      globalCommentPopover,
    ]);

    useEffect(() => {
      if (iframeReadyVersion === 0) return;
      const iframe = iframeRef.current;
      postToBridge(
        {
          type: `${PREFIX}set-vim-mode`,
          enabled: !readOnly && vimModeEnabled,
          hudEnabled: vimHudEnabled,
          mode,
        },
      );
      if (!readOnly && vimModeEnabled && iframe && iframe === document.activeElement) {
        // The initial parent focus can land before the sandbox bridge is ready.
        // Reassert it after configuration so raw HTML enters BLOCK immediately,
        // matching the Markdown surface instead of waiting for the first key.
        postToBridge(
          { type: `${PREFIX}focus-vim` },
        );
      }
    }, [iframeReadyVersion, mode, readOnly, vimHudEnabled, vimModeEnabled]);

    const vimOverlayWasOpenRef = useRef(false);
    useEffect(() => {
      const overlayOpen = !!hook.toolbarState || !!hook.commentPopover || !!hook.quickLabelPicker;
      const wasOpen = vimOverlayWasOpenRef.current;
      vimOverlayWasOpenRef.current = overlayOpen;
      if (
        !readOnly
        && vimModeEnabled
        && wasOpen
        && !overlayOpen
        && (document.activeElement === document.body || document.activeElement === null)
      ) {
        iframeRef.current?.focus({ preventScroll: true });
        postToBridge(
          { type: `${PREFIX}focus-vim` },
        );
      }
    }, [hook.commentPopover, hook.quickLabelPicker, hook.toolbarState, readOnly, vimModeEnabled]);

    useEffect(() => {
      if (iframeReadyVersion === 0) return;
      function sendTheme() {
        postToBridge(
          {
            type: `${PREFIX}theme`,
            tokens: buildThemeTokenPayload(readThemeTokens(), hostTheme),
            isLight: isLightTheme(),
            hostTheme,
          },
        );
      }
      sendTheme();
      const observer = new MutationObserver(sendTheme);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
      return () => observer.disconnect();
    }, [iframeReadyVersion, hostTheme]);

    useImperativeHandle(ref, () => ({
      // Raw HTML pages have no markdown heading blocks, so there is nothing for
      // a `#Heading` reference in a comment to resolve to on this surface.
      scrollToAnchor: () => false,
      removeHighlight: hook.removeHighlight,
      clearAllHighlights: hook.clearAllHighlights,
      // Shared/draft restores respect the live page filter too.
      applySharedAnnotations: (anns: Annotation[]) =>
        hook.applyAnnotations(forCurrentPage(anns)),
    }));

    const handleGlobalCommentSubmit = useCallback(
      (text: string, images?: ImageAttachment[]) => {
        if (readOnly) return;
        onAddAnnotation({
          id: `global-${Date.now()}`,
          blockId: "",
          startOffset: 0,
          endOffset: 0,
          type: AnnotationType.GLOBAL_COMMENT,
          text: text.trim(),
          originalText: "",
          author: getIdentity(),
          createdA: Date.now(),
          images,
        });
        setGlobalCommentPopover(null);
      },
      [onAddAnnotation, readOnly],
    );

    useEffect(() => {
      if (readOnly) setGlobalCommentPopover(null);
    }, [readOnly]);

    const hasActionButtons = !readOnly || Boolean(diffAvailable && onToggleDiff);

    // Document-level controls (attachments + global comment). Shared between the
    // normal layout (bar above the card) and full-viewport (floating overlay), so
    // edge-to-edge HTML keeps these affordances rather than dropping them.
    const actionButtons = (
      <>
        {diffAvailable && onToggleDiff && (
          <button
            onClick={onToggleDiff}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${diffActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted"}`}
            title={diffActive ? "Hide changes vs previous version" : "Show changes vs previous version"}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-9L21 3m0 0l-4.5 4.5M21 3H7.5" />
            </svg>
            <span>{diffActive ? "Hide changes" : "Show changes"}</span>
          </button>
        )}
        {!readOnly && onAddGlobalAttachment && onRemoveGlobalAttachment && (
          <AttachmentsButton
            images={globalAttachments}
            onAdd={onAddGlobalAttachment}
            onRemove={onRemoveGlobalAttachment}
            variant="toolbar"
          />
        )}
        {!readOnly && (
          <button
            ref={globalCommentButtonRef}
            onClick={() => {
              const anchorEl = globalCommentButtonRef.current;
              if (!anchorEl) return;
              setGlobalCommentPopover({ anchorEl, contextText: "" });
            }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-md transition-colors cursor-pointer"
            title="Add global comment"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 011.037-.443 48.282 48.282 0 005.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
            </svg>
            <span>Comment</span>
          </button>
        )}
      </>
    );

    return (
      <>
        <div
          className={`relative w-full${fullViewport ? " h-full flex flex-col" : ""}`}
          style={fullViewport ? undefined : { maxWidth: maxWidth ?? undefined }}
        >
          {/* Action bar — above the iframe in normal mode (outside overflow:hidden). */}
          {!fullViewport && hasActionButtons && (
            <div data-print-hide className="flex justify-end gap-1 md:gap-2 mb-2">
              {actionButtons}
            </div>
          )}

          <article
            data-print-region="article"
            className={fullViewport ? "relative overflow-hidden w-full flex-1" : "relative bg-card rounded-xl shadow-xl overflow-hidden w-full"}
          >
            {/* Armed affordance: a subtle accent ring floats over the iframe
                while Annotate is armed (hosts that wire the toggle only).
                Overlaid + pointer-transparent, so it never shifts layout and
                never eats a click; an inset shadow on the article itself
                would paint UNDER the covering iframe. */}
            {!readOnly && annotateModeActive && (onAnnotateModeExit || onAnnotateModeToggle) && (
              <div
                aria-hidden
                data-print-hide
                data-annotate-armed-ring
                className="pointer-events-none absolute inset-0 z-10"
                style={{ boxShadow: "inset 0 0 0 2px color-mix(in srgb, var(--primary) 45%, transparent)" }}
              />
            )}
            {/* Full-viewport mode has no card chrome, so float the same controls
                over the top-right of the iframe (with a backdrop so they read over
                any HTML). The selection toolbar is portaled separately. */}
            {fullViewport && !hideControls && hasActionButtons && (
              <div
                data-print-hide
                className="absolute top-3 right-3 z-10 flex items-center gap-1 md:gap-2 rounded-lg border border-border/50 bg-background/80 px-1.5 py-1 shadow-md backdrop-blur-sm"
              >
                {actionButtons}
              </div>
            )}
            {/* bridgeScriptUrl path only: the bridge did not come up (no
                ready within the timeout, or a stale asset's version). Floated
                over the top of the iframe so it never changes the layout the
                page renders in; the page itself stays visible. A host that
                renders its own notice from onBridgeUnavailable passes
                bridgeErrorDisplay="none" and no strip is rendered at all. */}
            {bridgeError && !bridgeErrorDismissed && bridgeErrorDisplay !== "none" && (
              <div
                role="alert"
                data-print-hide
                data-bridge-error={bridgeError.kind}
                className="absolute inset-x-0 top-0 z-20 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive backdrop-blur-sm"
                style={{ display: "flex", alignItems: "flex-start", gap: 8 }}
              >
                <span style={{ flex: 1 }}>{formatBridgeUnavailableMessage(bridgeError)}</span>
                {/* Only the mismatch state is dismissible: the older bridge
                    still works there. A timeout leaves a dead surface, so
                    that banner stays. Inline styles on purpose: hosts that
                    build the guides.show viewer scan this file for utility
                    classes, and this banner must not grow that stylesheet. */}
                {bridgeError.kind === "version-mismatch" && (
                  <button
                    type="button"
                    data-bridge-error-dismiss
                    aria-label="Dismiss"
                    style={{ flexShrink: 0, borderRadius: 4, padding: "2px 6px", fontWeight: 500, cursor: "pointer", background: "transparent", border: "1px solid currentColor", color: "inherit" }}
                    onClick={() => setBridgeErrorDismissed(true)}
                  >
                    Dismiss
                  </button>
                )}
              </div>
            )}
            {/* Live proxied-app mode navigates a real loopback origin: no
                sandbox (the user's own app needs cookies, storage, and
                same-origin XHR) and no srcdoc. Srcdoc mode is unchanged. */}
            <iframe
              ref={iframeRef}
              {...(src ? { src } : { srcDoc: srcdoc, sandbox: "allow-scripts" })}
              style={{
                width: "100%",
                height: fullViewport ? "100%" : `${iframeHeight}px`,
                border: "none",
                display: "block",
                colorScheme: "auto",
                outline: !readOnly && vimModeEnabled ? "none" : undefined,
              }}
              title={title}
              onFocus={() => setIframeFocused(true)}
              onBlur={(event) => {
                if (
                  event.relatedTarget instanceof Element
                  && event.relatedTarget.closest('[data-vim-key-hud]')
                ) {
                  return;
                }
                setIframeFocused(false);
              }}
            />
          </article>
        </div>

        {vimHudActive
          && (vimHelpOpen || (
            vimHudKeyPanelEnabled
            && vimBridgePhase !== "inactive"
          ))
          && (iframeFocused || vimBridgePhase === "action" || vimHelpOpen)
          && createPortal(
            <VimKeyHud
              command={vimHudCommand}
              phase={getVimHudPhase(vimBridgePhase, vimHudCommand?.actionId)}
              inputMethod={inputMethod}
              expanded={vimHelpOpen}
              onExpandedChange={handleVimHelpOpenChange}
              onHide={
                onVimHudKeyPanelChange
                  ? () => {
                    handleVimHelpOpenChange(false);
                    onVimHudKeyPanelChange(false);
                  }
                  : undefined
              }
              onFocusLeave={handleVimHudFocusLeave}
            />,
            document.body,
          )}

        {/* Toolbar portal */}
        {!readOnly && hook.toolbarState &&
          createPortal(
            <AnnotationToolbar
              positionMode="center-above"
              element={hook.toolbarState.element}
              copyText={hook.toolbarState.selectionText}
              // HTML/live surfaces are comment-only: no Delete, no label
              // picker, no Alt+digit labels (commentOnly). Exactly ONE label
              // affordance is restored: the hardcoded 👍 "Looks good". The
              // wrapper filters by id as defense in depth, so no present or
              // future toolbar path can emit an arbitrary label here.
              commentOnly
              onQuickLabel={(label) => {
                if (label.id === THUMBS_UP_LABEL.id) hook.handleQuickLabel(label);
              }}
              onAnnotate={hook.handleAnnotate}
              onRequestComment={hook.handleRequestComment}
              onClose={hook.handleToolbarClose}
            />,
            document.body,
          )}

        {/* Comment popover portal */}
        {!readOnly && hook.commentPopover &&
          createPortal(
            <CommentPopover
              anchorEl={hook.commentPopover.anchorEl}
              contextText={hook.commentPopover.contextText}
              initialText={hook.commentPopover.initialText}
              isGlobal={false}
              draftKey={`html:${hook.commentPopover.draftKey}`}
              onSubmit={hook.handleCommentSubmit}
              // Pinpoint clicks open this composer directly, so it carries
              // the surface's one-click "Looks good" (the global composer
              // does not: a document-wide thumbs-up is not a thing).
              onQuickLookGood={hook.handleCommentLooksGood}
              onClose={hook.handleCommentClose}
              skillReferences
              onAskAI={onAskAI}
              askAIContext={{
                kind: "selection",
                label: "Selected HTML",
                text: hook.commentPopover.selectedText ?? hook.commentPopover.contextText,
              }}
              targetChips={targetChips}
              onRemoveTargetChip={targetChips ? hook.removeDraftTarget : undefined}
              onHoverTargetChip={targetChips ? hook.flashDraftTarget : undefined}
              refocusToken={targetChips ? hook.composerFocusToken : undefined}
              captureStrayKeys={multiSelectActive}
              yieldState={multiSelectActive ? composerYield : undefined}
            />,
            document.body,
          )}

        {/* Global comment popover portal */}
        {!readOnly && globalCommentPopover &&
          createPortal(
            <CommentPopover
              anchorEl={globalCommentPopover.anchorEl}
              contextText={globalCommentPopover.contextText}
              isGlobal={true}
              onSubmit={handleGlobalCommentSubmit}
              onClose={() => setGlobalCommentPopover(null)}
              skillReferences
              onAskAI={onAskAI}
              askAIContext={{ kind: "general", label: "Document" }}
            />,
            document.body,
          )}
      </>
    );
  },
);

HtmlViewer.displayName = "HtmlViewer";
