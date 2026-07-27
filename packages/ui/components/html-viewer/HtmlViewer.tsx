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
import {
  createVimHudCommand,
  getVimHudPhase,
  type VimHudCommand,
} from "../../utils/vimHud";
import { AnnotationToolbar } from "../AnnotationToolbar";
import { AttachmentsButton } from "../AttachmentsButton";
import { CommentPopover, type CommentAskAIHandler } from "../CommentPopover";
import { FloatingQuickLabelPicker } from "../FloatingQuickLabelPicker";
import { VimKeyHud } from "../VimKeyHud";
import type { ViewerHandle } from "../Viewer";
import { useHtmlAnnotation } from "./useHtmlAnnotation";
import {
  THEME_TOKENS,
  buildSrcdocInjection,
  buildThemeTokenPayload,
  hasHostThemeOptIn,
  injectIntoHead,
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
  annotations: Annotation[];
  onAddAnnotation: (ann: Annotation) => void;
  onSelectAnnotation: (id: string | null) => void;
  selectedAnnotationId: string | null;
  mode: EditorMode;
  /** Input method: 'drag' = text selection, 'pinpoint' = click an element. */
  inputMethod: InputMethod;
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
  /** Accessible iframe title. */
  title?: string;
}

/**
 * Render arbitrary HTML in a sandbox and adapt its validated bridge messages
 * to the same annotation controls used by the Markdown viewer.
 */
export const HtmlViewer = forwardRef<ViewerHandle, HtmlViewerProps>(
  (
    {
      rawHtml,
      annotations,
      onAddAnnotation,
      onSelectAnnotation,
      selectedAnnotationId,
      mode,
      inputMethod,
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
      title = "HTML Plan Viewer",
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
    const vimHudActive = vimModeEnabled && vimHudEnabled;
    const [globalCommentPopover, setGlobalCommentPopover] = useState<{
      anchorEl: HTMLElement;
      contextText: string;
    } | null>(null);

    // Host theming is opt-in per document (Plannotator-generated artifacts tag
    // themselves); arbitrary HTML renders untouched, like a standalone tab.
    const hostTheme = useMemo(() => hasHostThemeOptIn(rawHtml), [rawHtml]);

    const srcdoc = useMemo(() => {
      const injection = buildSrcdocInjection({
        tokens: readThemeTokens(),
        isLight: isLightTheme(),
        hostTheme,
        diffActive: !!diffActive,
      });
      return injectIntoHead(rawHtml, injection);
    }, [rawHtml, hostTheme, diffActive]);

    const handleResize = useCallback((height: number) => {
      setIframeHeight(height);
    }, []);

    const hook = useHtmlAnnotation({
      iframeRef,
      annotations,
      onAddAnnotation,
      onSelectAnnotation,
      selectedAnnotationId,
      mode,
      onResize: handleResize,
    });

    useEffect(() => {
      function handler(e: MessageEvent<unknown>) {
        if (e.source !== iframeRef.current?.contentWindow) return;
        if (isBridgeReadyMessage(e.data)) {
          setIframeReadyVersion((version) => version + 1);
          setVimBridgePhase("inactive");
          setVimHudCommand(null);
          setVimHelpOpen(false);
          return;
        }
        const vimCopy = parseVimBridgeCopy(e.data);
        if (vimCopy !== null) {
          const iframe = iframeRef.current;
          if (
            vimModeEnabled
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
    }, [vimHudActive, vimModeEnabled]);

    useEffect(() => {
      if (vimHudActive) return;
      setVimBridgePhase("inactive");
      setVimHudCommand(null);
      setVimHelpOpen(false);
    }, [vimHudActive]);

    const handleVimHelpOpenChange = useCallback((open: boolean) => {
      setVimHelpOpen(open);
      iframeRef.current?.contentWindow?.postMessage(
        { type: `${PREFIX}set-vim-help`, open },
        "*",
      );
    }, []);

    const handleVimHudFocusLeave = useCallback(() => {
      if (iframeRef.current === document.activeElement) return;
      setIframeFocused(false);
    }, []);

    const focusVimDocument = useCallback((): boolean => {
      const iframe = iframeRef.current;
      if (!vimModeEnabled || !iframe) return false;
      if (document.activeElement === iframe) return false;
      iframe.focus({ preventScroll: true });
      if (document.activeElement !== iframe) return false;
      iframe.contentWindow?.postMessage(
        { type: `${PREFIX}focus-vim` },
        "*",
      );
      return true;
    }, [vimModeEnabled]);

    useVimDocumentFocus({
      enabled: vimModeEnabled,
      blocked: !!hook.toolbarState || !!hook.commentPopover || !!hook.quickLabelPicker,
      focusDocument: focusVimDocument,
    });

    useEffect(() => {
      if (iframeReadyVersion === 0) return;
      if (annotations.length > 0) {
        hook.applyAnnotations(annotations);
      }
    }, [iframeReadyVersion]); // eslint-disable-line react-hooks/exhaustive-deps

    // Tell the bridge the current input method (drag vs pinpoint). Re-posts on
    // ready (fresh iframe) and whenever the user switches it in the toolstrip.
    useEffect(() => {
      if (iframeReadyVersion === 0) return;
      iframeRef.current?.contentWindow?.postMessage(
        { type: `${PREFIX}set-input-method`, method: inputMethod },
        "*",
      );
    }, [iframeReadyVersion, inputMethod]);

    useEffect(() => {
      if (iframeReadyVersion === 0) return;
      const iframe = iframeRef.current;
      iframe?.contentWindow?.postMessage(
        {
          type: `${PREFIX}set-vim-mode`,
          enabled: vimModeEnabled,
          hudEnabled: vimHudEnabled,
          mode,
        },
        "*",
      );
      if (vimModeEnabled && iframe === document.activeElement) {
        // The initial parent focus can land before the sandbox bridge is ready.
        // Reassert it after configuration so raw HTML enters BLOCK immediately,
        // matching the Markdown surface instead of waiting for the first key.
        iframe.contentWindow?.postMessage(
          { type: `${PREFIX}focus-vim` },
          "*",
        );
      }
    }, [iframeReadyVersion, mode, vimHudEnabled, vimModeEnabled]);

    const vimOverlayWasOpenRef = useRef(false);
    useEffect(() => {
      const overlayOpen = !!hook.toolbarState || !!hook.commentPopover || !!hook.quickLabelPicker;
      const wasOpen = vimOverlayWasOpenRef.current;
      vimOverlayWasOpenRef.current = overlayOpen;
      if (
        vimModeEnabled
        && wasOpen
        && !overlayOpen
        && (document.activeElement === document.body || document.activeElement === null)
      ) {
        iframeRef.current?.focus({ preventScroll: true });
        iframeRef.current?.contentWindow?.postMessage(
          { type: `${PREFIX}focus-vim` },
          "*",
        );
      }
    }, [hook.commentPopover, hook.quickLabelPicker, hook.toolbarState, vimModeEnabled]);

    useEffect(() => {
      if (iframeReadyVersion === 0) return;
      function sendTheme() {
        iframeRef.current?.contentWindow?.postMessage(
          {
            type: `${PREFIX}theme`,
            tokens: buildThemeTokenPayload(readThemeTokens(), hostTheme),
            isLight: isLightTheme(),
            hostTheme,
          },
          "*",
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
      removeHighlight: hook.removeHighlight,
      clearAllHighlights: hook.clearAllHighlights,
      applySharedAnnotations: hook.applyAnnotations,
    }));

    const handleGlobalCommentSubmit = useCallback(
      (text: string, images?: ImageAttachment[]) => {
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
      [onAddAnnotation],
    );

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
        {onAddGlobalAttachment && onRemoveGlobalAttachment && (
          <AttachmentsButton
            images={globalAttachments}
            onAdd={onAddGlobalAttachment}
            onRemove={onRemoveGlobalAttachment}
            variant="toolbar"
          />
        )}
        <button
          ref={globalCommentButtonRef}
          onClick={() => {
            setGlobalCommentPopover({
              anchorEl: globalCommentButtonRef.current!,
              contextText: "",
            });
          }}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-md transition-colors cursor-pointer"
          title="Add global comment"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 011.037-.443 48.282 48.282 0 005.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
          </svg>
          <span>Comment</span>
        </button>
      </>
    );

    return (
      <>
        <div
          className={`relative w-full${fullViewport ? " h-full flex flex-col" : ""}`}
          style={fullViewport ? undefined : { maxWidth: maxWidth ?? undefined }}
        >
          {/* Action bar — above the iframe in normal mode (outside overflow:hidden). */}
          {!fullViewport && (
            <div data-print-hide className="flex justify-end gap-1 md:gap-2 mb-2">
              {actionButtons}
            </div>
          )}

          <article
            data-print-region="article"
            className={fullViewport ? "relative overflow-hidden w-full flex-1" : "relative bg-card rounded-xl shadow-xl overflow-hidden w-full"}
          >
            {/* Full-viewport mode has no card chrome, so float the same controls
                over the top-right of the iframe (with a backdrop so they read over
                any HTML). The selection toolbar is portaled separately. */}
            {fullViewport && !hideControls && (
              <div
                data-print-hide
                className="absolute top-3 right-3 z-10 flex items-center gap-1 md:gap-2 rounded-lg border border-border/50 bg-background/80 px-1.5 py-1 shadow-md backdrop-blur-sm"
              >
                {actionButtons}
              </div>
            )}
            <iframe
              ref={iframeRef}
              srcDoc={srcdoc}
              sandbox="allow-scripts"
              style={{
                width: "100%",
                height: fullViewport ? "100%" : `${iframeHeight}px`,
                border: "none",
                display: "block",
                colorScheme: "auto",
                outline: vimModeEnabled ? "none" : undefined,
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
        {hook.toolbarState &&
          createPortal(
            <AnnotationToolbar
              positionMode="center-above"
              element={hook.toolbarState.element}
              copyText={hook.toolbarState.selectionText}
              onAnnotate={hook.handleAnnotate}
              onRequestComment={hook.handleRequestComment}
              onQuickLabel={hook.handleQuickLabel}
              onClose={hook.handleToolbarClose}
            />,
            document.body,
          )}

        {/* Comment popover portal */}
        {hook.commentPopover &&
          createPortal(
            <CommentPopover
              anchorEl={hook.commentPopover.anchorEl}
              contextText={hook.commentPopover.contextText}
              initialText={hook.commentPopover.initialText}
              isGlobal={false}
              onSubmit={hook.handleCommentSubmit}
              onClose={hook.handleCommentClose}
              onAskAI={onAskAI}
              askAIContext={{
                kind: "selection",
                label: "Selected HTML",
                text: hook.commentPopover.selectedText ?? hook.commentPopover.contextText,
              }}
            />,
            document.body,
          )}

        {/* Quick label picker portal */}
        {hook.quickLabelPicker &&
          createPortal(
            <FloatingQuickLabelPicker
              anchorEl={hook.quickLabelPicker.anchorEl}
              cursorHint={hook.quickLabelPicker.cursorHint}
              onSelect={hook.handleFloatingQuickLabel}
              onDismiss={hook.handleQuickLabelPickerDismiss}
            />,
            document.body,
          )}

        {/* Global comment popover portal */}
        {globalCommentPopover &&
          createPortal(
            <CommentPopover
              anchorEl={globalCommentPopover.anchorEl}
              contextText={globalCommentPopover.contextText}
              isGlobal={true}
              onSubmit={handleGlobalCommentSubmit}
              onClose={() => setGlobalCommentPopover(null)}
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
