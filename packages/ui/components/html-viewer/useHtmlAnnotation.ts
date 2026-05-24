import { useState, useEffect, useCallback, useRef, type RefObject } from "react";
import { AnnotationType, type Annotation, type EditorMode, type ImageAttachment } from "../../types";
import type { QuickLabel } from "../../utils/quickLabels";
import { getIdentity } from "../../utils/identity";
import type {
  ToolbarState,
  CommentPopoverState,
  QuickLabelPickerState,
  UseAnnotationHighlighterReturn,
} from "../../hooks/useAnnotationHighlighter";

const PREFIX = "plannotator-bridge-";

interface BridgeSelectionMessage {
  type: `${typeof PREFIX}selection`;
  text: string;
  rect: { top: number; left: number; width: number; height: number };
}

interface BridgeMarkClickMessage {
  type: `${typeof PREFIX}mark-click`;
  id: string;
}

interface BridgeResizeMessage {
  type: `${typeof PREFIX}resize`;
  height: number;
}

type BridgeMessage = BridgeSelectionMessage | BridgeMarkClickMessage | BridgeResizeMessage | { type: string };

export interface UseHtmlAnnotationOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  annotations: Annotation[];
  onAddAnnotation?: (ann: Annotation) => void;
  onSelectAnnotation?: (id: string | null) => void;
  selectedAnnotationId: string | null;
  mode: EditorMode;
  onResize?: (height: number) => void;
}

function postToIframe(iframe: HTMLIFrameElement | null, msg: Record<string, unknown>) {
  iframe?.contentWindow?.postMessage(msg, "*");
}

export function useHtmlAnnotation({
  iframeRef,
  annotations,
  onAddAnnotation,
  onSelectAnnotation,
  selectedAnnotationId,
  mode,
  onResize,
}: UseHtmlAnnotationOptions): Omit<UseAnnotationHighlighterReturn, "highlighterRef"> {
  const [toolbarState, setToolbarState] = useState<ToolbarState | null>(null);
  const [commentPopover, setCommentPopover] = useState<CommentPopoverState | null>(null);
  const [quickLabelPicker, setQuickLabelPicker] = useState<QuickLabelPickerState | null>(null);

  const pendingTextRef = useRef<string>("");
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const onAddRef = useRef(onAddAnnotation);
  onAddRef.current = onAddAnnotation;
  const onSelectRef = useRef(onSelectAnnotation);
  onSelectRef.current = onSelectAnnotation;

  const anchorRef = useRef<HTMLDivElement | null>(null);

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
      const anchor = getOrCreateAnchor();
      anchor.style.top = `${iframeRect.top + bridgeRect.top}px`;
      anchor.style.left = `${iframeRect.left + bridgeRect.left + bridgeRect.width / 2}px`;
      return anchor;
    },
    [iframeRef, getOrCreateAnchor],
  );

  useEffect(() => {
    function handler(e: MessageEvent<BridgeMessage>) {
      if (!e.data || typeof e.data.type !== "string" || !e.data.type.startsWith(PREFIX)) return;

      const type = e.data.type;

      if (type === `${PREFIX}selection`) {
        const msg = e.data as BridgeSelectionMessage;
        pendingTextRef.current = msg.text;
        const anchor = positionAnchor(msg.rect);
        if (!anchor) return;

        const currentMode = modeRef.current;

        if (currentMode === "redline") {
          const id = `html-ann-${Date.now()}`;
          postToIframe(iframeRef.current, { type: `${PREFIX}create-mark`, id, annotationType: "deletion" });
          onAddRef.current?.({
            id,
            blockId: "",
            startOffset: 0,
            endOffset: 0,
            type: AnnotationType.DELETION,
            originalText: msg.text,
            author: getIdentity(),
            createdA: Date.now(),
          });
          pendingTextRef.current = "";
        } else if (currentMode === "comment") {
          setCommentPopover({
            anchorEl: anchor,
            contextText: msg.text,
            selectedText: msg.text,
          });
        } else if (currentMode === "quickLabel") {
          setQuickLabelPicker({
            anchorEl: anchor,
            cursorHint: { x: parseFloat(anchor.style.left), y: parseFloat(anchor.style.top) },
          });
        } else {
          setToolbarState({
            element: anchor,
            source: null,
            selectionText: msg.text,
          });
        }
      }

      if (type === `${PREFIX}selection-clear`) {
        setToolbarState(null);
        pendingTextRef.current = "";
      }

      if (type === `${PREFIX}mark-click`) {
        const msg = e.data as BridgeMarkClickMessage;
        onSelectRef.current?.(msg.id);
      }

      if (type === `${PREFIX}resize`) {
        const msg = e.data as BridgeResizeMessage;
        onResize?.(msg.height);
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
  }, [iframeRef, positionAnchor, onResize]);

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
      const text = pendingTextRef.current;
      if (!text || type !== AnnotationType.DELETION) return;

      const id = `html-ann-${Date.now()}`;
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
      });

      setToolbarState(null);
      pendingTextRef.current = "";
    },
    [iframeRef],
  );

  const handleRequestComment = useCallback(
    (initialChar?: string) => {
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
      const text = pendingTextRef.current;
      if (!text) return;

      const id = `html-ann-${Date.now()}`;
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
      });

      setCommentPopover(null);
      pendingTextRef.current = "";
    },
    [iframeRef],
  );

  const handleCommentClose = useCallback(() => {
    setCommentPopover(null);
    pendingTextRef.current = "";
  }, []);

  const handleToolbarClose = useCallback(() => {
    setToolbarState(null);
    pendingTextRef.current = "";
  }, []);

  const applyQuickLabel = useCallback(
    (label: QuickLabel, clearState: () => void) => {
      const text = pendingTextRef.current;
      if (!text) return;
      const id = `html-ann-${Date.now()}`;
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
      });
      clearState();
      pendingTextRef.current = "";
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
    setQuickLabelPicker(null);
    pendingTextRef.current = "";
  }, []);

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
        postToIframe(iframeRef.current, {
          type: `${PREFIX}find-and-mark`,
          id: ann.id,
          originalText: ann.originalText,
          annotationType: annType,
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
  };
}
