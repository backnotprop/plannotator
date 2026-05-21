import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { Annotation, EditorMode, ImageAttachment } from "../../types";
import { AnnotationType } from "../../types";
import { getIdentity } from "../../utils/identity";
import { AnnotationToolbar } from "../AnnotationToolbar";
import { AttachmentsButton } from "../AttachmentsButton";
import { CommentPopover, type CommentAskAIContext } from "../CommentPopover";
import { FloatingQuickLabelPicker } from "../FloatingQuickLabelPicker";
import type { ViewerHandle } from "../Viewer";
import { useHtmlAnnotation } from "./useHtmlAnnotation";
import { ANNOTATION_HIGHLIGHT_CSS, BRIDGE_SCRIPT } from "./bridge-script";

const PREFIX = "plannotator-bridge-";

const THEME_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--success",
  "--success-foreground",
  "--warning",
  "--warning-foreground",
  "--border",
  "--input",
  "--ring",
  "--code-bg",
  "--focus-highlight",
  "--font-sans",
  "--font-mono",
  "--radius",
] as const;

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

export interface HtmlViewerProps {
  rawHtml: string;
  annotations: Annotation[];
  onAddAnnotation: (ann: Annotation) => void;
  onSelectAnnotation: (id: string | null) => void;
  selectedAnnotationId: string | null;
  mode: EditorMode;
  globalAttachments?: ImageAttachment[];
  onAddGlobalAttachment?: (image: ImageAttachment) => void;
  onRemoveGlobalAttachment?: (path: string) => void;
  maxWidth?: number | null;
  onAskAI?: (question: string, context: CommentAskAIContext) => void;
}

export const HtmlViewer = forwardRef<ViewerHandle, HtmlViewerProps>(
  (
    {
      rawHtml,
      annotations,
      onAddAnnotation,
      onSelectAnnotation,
      selectedAnnotationId,
      mode,
      globalAttachments = [],
      onAddGlobalAttachment,
      onRemoveGlobalAttachment,
      maxWidth,
      onAskAI,
    },
    ref,
  ) => {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const globalCommentButtonRef = useRef<HTMLButtonElement>(null);
    const [iframeHeight, setIframeHeight] = useState(600);
    const [iframeReady, setIframeReady] = useState(false);
    const [globalCommentPopover, setGlobalCommentPopover] = useState<{
      anchorEl: HTMLElement;
      contextText: string;
    } | null>(null);

    const srcdoc = useMemo(() => {
      const tokens = readThemeTokens();
      let themeCSS = ":root {\n";
      for (const [key, val] of Object.entries(tokens)) {
        themeCSS += `  ${key}: ${val};\n`;
      }
      themeCSS += "}\n";
      if (isLightTheme()) themeCSS += ":root { color-scheme: light; }\n:root.light, :root { }\n";

      const injection = `<style>${themeCSS}${ANNOTATION_HIGHLIGHT_CSS}</style><script>${BRIDGE_SCRIPT}</script>`;
      const headClose = rawHtml.indexOf("</head>");
      if (headClose !== -1) {
        return rawHtml.slice(0, headClose) + injection + rawHtml.slice(headClose);
      }
      return injection + rawHtml;
    }, [rawHtml]);

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
      function handler(e: MessageEvent) {
        if (e.data?.type === `${PREFIX}ready`) {
          setIframeReady(true);
        }
      }
      window.addEventListener("message", handler);
      return () => window.removeEventListener("message", handler);
    }, []);

    useEffect(() => {
      if (!iframeReady) return;
      if (annotations.length > 0) {
        hook.applyAnnotations(annotations);
      }
    }, [iframeReady]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
      if (!iframeReady) return;
      function sendTheme() {
        const tokens = readThemeTokens();
        iframeRef.current?.contentWindow?.postMessage(
          { type: `${PREFIX}theme`, tokens, isLight: isLightTheme() },
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
    }, [iframeReady]);

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

    return (
      <>
        <div
          className="relative w-full"
          style={{ maxWidth: maxWidth ?? undefined }}
        >
          {/* Action bar — positioned above the iframe, outside overflow:hidden */}
          <div data-print-hide className="flex justify-end gap-1 md:gap-2 mb-2">
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
          </div>

          <article
            data-print-region="article"
            className="relative bg-card rounded-xl shadow-xl overflow-hidden w-full"
          >
            <iframe
            ref={iframeRef}
            srcDoc={srcdoc}
            sandbox="allow-scripts"
            style={{
              width: "100%",
              height: `${iframeHeight}px`,
              border: "none",
              display: "block",
              colorScheme: "auto",
            }}
            title="HTML Plan Viewer"
          />
          </article>
        </div>

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
