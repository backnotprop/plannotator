/**
 * useAnnotationHighlighter — annotation infrastructure for Viewer.
 *
 * Manages: web-highlighter lifecycle, toolbar/popover/quicklabel state,
 * annotation creation, text-based restoration (drafts/shares), scroll-to-selected.
 */

import { useEffect, useRef, useState, useCallback, type RefObject } from 'react';
import Highlighter from '@plannotator/web-highlighter';
import type { Annotation, EditorMode, ImageAttachment } from '../types';
import { AnnotationType } from '../types';
import type { QuickLabel } from '../utils/quickLabels';
import { getIdentity } from '../utils/identity';
import { transformPlainText } from '../utils/inlineTransforms';

// --- Exported state types ---

export interface ToolbarState {
  element: HTMLElement;
  source: any;
  selectionText: string;
}

export interface CommentPopoverState {
  anchorEl: HTMLElement;
  contextText: string;
  initialText?: string;
  source?: any;
}

export interface QuickLabelPickerState {
  anchorEl: HTMLElement;
  cursorHint?: { x: number; y: number };
  source?: any;
}

// --- Hook options & return ---

export interface UseAnnotationHighlighterOptions {
  containerRef: RefObject<HTMLElement | null>;
  annotations: Annotation[];
  onAddAnnotation?: (ann: Annotation) => void;
  onSelectAnnotation?: (id: string | null) => void;
  selectedAnnotationId: string | null;
  mode: EditorMode;
  enabled?: boolean;
}

export interface UseAnnotationHighlighterReturn {
  highlighterRef: RefObject<Highlighter | null>;

  toolbarState: ToolbarState | null;
  commentPopover: CommentPopoverState | null;
  quickLabelPicker: QuickLabelPickerState | null;

  handleAnnotate: (type: AnnotationType) => void;
  handleQuickLabel: (label: QuickLabel) => void;
  handleToolbarClose: () => void;
  handleRequestComment: (initialChar?: string) => void;
  handleCommentSubmit: (text: string, images?: ImageAttachment[]) => void;
  handleCommentClose: () => void;
  handleFloatingQuickLabel: (label: QuickLabel) => void;
  handleQuickLabelPickerDismiss: () => void;

  removeHighlight: (id: string) => void;
  clearAllHighlights: () => void;
  applyAnnotations: (annotations: Annotation[]) => void;
}

export function useAnnotationHighlighter({
  containerRef,
  annotations,
  onAddAnnotation,
  onSelectAnnotation,
  selectedAnnotationId,
  mode,
  enabled = true,
}: UseAnnotationHighlighterOptions): UseAnnotationHighlighterReturn {
  const highlighterRef = useRef<Highlighter | null>(null);
  const modeRef = useRef<EditorMode>(mode);
  const onAddAnnotationRef = useRef(onAddAnnotation);
  const onSelectAnnotationRef = useRef(onSelectAnnotation);
  const pendingSourceRef = useRef<any>(null);
  const justCreatedIdRef = useRef<string | null>(null);
  const lastMousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const [toolbarState, setToolbarState] = useState<ToolbarState | null>(null);
  const [commentPopover, setCommentPopover] = useState<CommentPopoverState | null>(null);
  const [quickLabelPicker, setQuickLabelPicker] = useState<QuickLabelPickerState | null>(null);

  // Keep refs in sync
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { onAddAnnotationRef.current = onAddAnnotation; }, [onAddAnnotation]);
  useEffect(() => { onSelectAnnotationRef.current = onSelectAnnotation; }, [onSelectAnnotation]);

  // Track mouse position for quick label picker
  useEffect(() => {
    const track = (e: MouseEvent) => { lastMousePosRef.current = { x: e.clientX, y: e.clientY }; };
    document.addEventListener('mouseup', track, true);
    return () => document.removeEventListener('mouseup', track, true);
  }, []);

  // --- Helpers ---

  const findTextInDOM = useCallback((searchText: string): Range | null => {
    if (!containerRef.current) return null;

    // Search for an exact substring match inside the container's text tree.
    // Falls back to a multi-text-node walk when the match spans siblings.
    const searchOnce = (needle: string): Range | null => {
      if (!needle || !containerRef.current) return null;

      const walker = document.createTreeWalker(
        containerRef.current,
        NodeFilter.SHOW_TEXT,
        null
      );

      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const text = node.textContent || '';
        const index = text.indexOf(needle);
        if (index !== -1) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + needle.length);
          return range;
        }
      }

      const fullText = containerRef.current.textContent || '';
      const searchIndex = fullText.indexOf(needle);
      if (searchIndex === -1) return null;

      const walker2 = document.createTreeWalker(
        containerRef.current,
        NodeFilter.SHOW_TEXT,
        null
      );

      let charCount = 0;
      let startNode: Text | null = null;
      let startOffset = 0;
      let endNode: Text | null = null;
      let endOffset = 0;

      while ((node = walker2.nextNode() as Text | null)) {
        const nodeLength = node.textContent?.length || 0;

        if (!startNode && charCount + nodeLength > searchIndex) {
          startNode = node;
          startOffset = searchIndex - charCount;
        }

        if (startNode && charCount + nodeLength >= searchIndex + needle.length) {
          endNode = node;
          endOffset = searchIndex + needle.length - charCount;
          break;
        }

        charCount += nodeLength;
      }

      if (startNode && endNode) {
        const range = document.createRange();
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
        return range;
      }

      return null;
    };

    // First try the literal text. If that misses, re-try with the same
    // transform the renderer applies to plain text (emoji shortcodes +
    // smart punctuation) so annotations made before those transforms
    // shipped can still re-bind to their target after reload.
    const direct = searchOnce(searchText);
    if (direct) return direct;

    const transformed = transformPlainText(searchText);
    if (transformed !== searchText) {
      return searchOnce(transformed);
    }

    return null;
  }, []);

  const createAnnotationFromSource = (
    highlighter: Highlighter,
    source: any,
    type: AnnotationType,
    text?: string,
    images?: ImageAttachment[],
    isQuickLabel?: boolean,
    quickLabelTip?: string,
  ) => {
    const doms = highlighter.getDoms(source.id);
    let blockId = '';
    let startOffset = 0;

    if (doms?.length > 0) {
      const el = doms[0] as HTMLElement;
      let parent = el.parentElement;
      while (parent && !parent.dataset.blockId) {
        parent = parent.parentElement;
      }
      if (parent?.dataset.blockId) {
        blockId = parent.dataset.blockId;
        const blockText = parent.textContent || '';
        const beforeText = blockText.split(source.text)[0];
        startOffset = beforeText?.length || 0;
      }
    }

    const newAnnotation: Annotation = {
      id: source.id,
      blockId,
      startOffset,
      endOffset: startOffset + source.text.length,
      type,
      text,
      originalText: source.text,
      createdA: Date.now(),
      author: getIdentity(),
      startMeta: source.startMeta,
      endMeta: source.endMeta,
      images,
      ...(isQuickLabel ? { isQuickLabel: true } : {}),
      ...(quickLabelTip ? { quickLabelTip } : {}),
    };

    if (type === AnnotationType.DELETION) {
      highlighter.addClass('deletion', source.id);
    } else if (type === AnnotationType.COMMENT) {
      highlighter.addClass('comment', source.id);
    }

    justCreatedIdRef.current = newAnnotation.id;
    onAddAnnotationRef.current?.(newAnnotation);
  };

  // --- Imperative methods ---

  const applyAnnotationsInternal = useCallback((anns: Annotation[]) => {
    const highlighter = highlighterRef.current;
    if (!highlighter || !containerRef.current) return;

    anns.forEach(ann => {
      if (ann.type === AnnotationType.GLOBAL_COMMENT) return;

      // Skip if already highlighted
      try {
        const existingDoms = highlighter.getDoms(ann.id);
        if (existingDoms && existingDoms.length > 0) return;
      } catch {}
      const existingManual = containerRef.current?.querySelector(`[data-bind-id="${ann.id}"]`);
      if (existingManual) return;

      const range = findTextInDOM(ann.originalText);
      if (!range) {
        console.warn(`Could not find text for annotation ${ann.id}: "${ann.originalText.slice(0, 50)}..."`);
        return;
      }

      try {
        const textNodes: { node: Text; start: number; end: number }[] = [];
        const walker = document.createTreeWalker(
          range.commonAncestorContainer.nodeType === Node.TEXT_NODE
            ? range.commonAncestorContainer.parentNode!
            : range.commonAncestorContainer,
          NodeFilter.SHOW_TEXT,
          null
        );

        let node: Text | null;
        let inRange = false;

        while ((node = walker.nextNode() as Text | null)) {
          if (node === range.startContainer) {
            inRange = true;
            const start = range.startOffset;
            const end = node === range.endContainer ? range.endOffset : node.length;
            if (end > start) {
              textNodes.push({ node, start, end });
            }
            if (node === range.endContainer) break;
            continue;
          }

          if (node === range.endContainer) {
            if (inRange) {
              const end = range.endOffset;
              if (end > 0) {
                textNodes.push({ node, start: 0, end });
              }
            }
            break;
          }

          if (inRange && node.length > 0) {
            textNodes.push({ node, start: 0, end: node.length });
          }
        }

        if (textNodes.length === 0) {
          console.warn(`No text nodes found for annotation ${ann.id}`);
          return;
        }

        textNodes.reverse().forEach(({ node, start, end }) => {
          try {
            const nodeRange = document.createRange();
            nodeRange.setStart(node, start);
            nodeRange.setEnd(node, end);

            const mark = document.createElement('mark');
            mark.className = 'annotation-highlight';
            mark.dataset.bindId = ann.id;

            if (ann.type === AnnotationType.DELETION) {
              mark.classList.add('deletion');
            } else if (ann.type === AnnotationType.COMMENT) {
              mark.classList.add('comment');
            }

            nodeRange.surroundContents(mark);

            mark.addEventListener('click', () => {
              onSelectAnnotationRef.current?.(ann.id);
            });
          } catch (e) {
            console.warn(`Failed to wrap text node for annotation ${ann.id}:`, e);
          }
        });
      } catch (e) {
        console.warn(`Failed to apply highlight for annotation ${ann.id}:`, e);
      }
    });
  }, [findTextInDOM]);

  const removeHighlight = useCallback((id: string) => {
    highlighterRef.current?.remove(id);

    const manualHighlights = containerRef.current?.querySelectorAll(`[data-bind-id="${id}"]`);
    manualHighlights?.forEach(el => {
      const parent = el.parentNode;
      while (el.firstChild) {
        parent?.insertBefore(el.firstChild, el);
      }
      el.remove();
    });
  }, []);

  const clearAllHighlights = useCallback(() => {
    const manualHighlights = containerRef.current?.querySelectorAll('[data-bind-id]');
    manualHighlights?.forEach(el => {
      const parent = el.parentNode;
      while (el.firstChild) {
        parent?.insertBefore(el.firstChild, el);
      }
      el.remove();
    });

    const webHighlights = containerRef.current?.querySelectorAll('.annotation-highlight');
    webHighlights?.forEach(el => {
      const parent = el.parentNode;
      while (el.firstChild) {
        parent?.insertBefore(el.firstChild, el);
      }
      el.remove();
    });
  }, []);

  // --- Effects ---

  // Initialize web-highlighter (no callback deps — reads from refs)
  useEffect(() => {
    if (!containerRef.current || !enabled) return;

    const highlighter = new Highlighter({
      $root: containerRef.current,
      exceptSelectors: ['.annotation-toolbar', 'button'],
      wrapTag: 'mark',
      style: { className: 'annotation-highlight' },
    });

    highlighterRef.current = highlighter;

    highlighter.on(Highlighter.event.CREATE, ({ sources }: { sources: any[] }) => {
      if (sources.length > 0) {
        const source = sources[0];
        const doms = highlighter.getDoms(source.id);
        if (doms?.length > 0) {
          // Clean up previous pending
          if (pendingSourceRef.current) {
            highlighter.remove(pendingSourceRef.current.id);
            pendingSourceRef.current = null;
          }
          setCommentPopover(null);
          setQuickLabelPicker(null);

          if (modeRef.current === 'redline') {
            createAnnotationFromSource(highlighter, source, AnnotationType.DELETION);
            window.getSelection()?.removeAllRanges();
          } else if (modeRef.current === 'comment') {
            pendingSourceRef.current = source;
            setCommentPopover({
              anchorEl: doms[0] as HTMLElement,
              contextText: source.text.slice(0, 80),
              source,
            });
          } else if (modeRef.current === 'quickLabel') {
            pendingSourceRef.current = source;
            setQuickLabelPicker({
              anchorEl: doms[0] as HTMLElement,
              cursorHint: lastMousePosRef.current,
              source,
            });
          } else {
            // Selection mode — show toolbar
            pendingSourceRef.current = source;
            setToolbarState({
              element: doms[0] as HTMLElement,
              source,
              selectionText: source.text,
            });
          }
        }
      }
    });

    highlighter.on(Highlighter.event.CLICK, ({ id }: { id: string }) => {
      onSelectAnnotationRef.current?.(id);
    });

    highlighter.run();

    // Mobile bridge
    const isTouchPrimary = window.matchMedia('(pointer: coarse)').matches;
    let selectionTimer: ReturnType<typeof setTimeout>;
    const handleSelectionChange = isTouchPrimary
      ? () => {
          clearTimeout(selectionTimer);
          selectionTimer = setTimeout(() => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
            if (!containerRef.current?.contains(sel.anchorNode)) return;
            highlighter.fromRange(sel.getRangeAt(0));
          }, 400);
        }
      : null;

    if (handleSelectionChange) {
      document.addEventListener('selectionchange', handleSelectionChange);
    }

    return () => {
      if (handleSelectionChange) {
        clearTimeout(selectionTimer);
        document.removeEventListener('selectionchange', handleSelectionChange);
      }
      highlighter.dispose();
    };
  }, [enabled]);

  // Apply CSS classes to existing annotations
  useEffect(() => {
    const highlighter = highlighterRef.current;
    if (!highlighter) return;

    annotations.forEach(ann => {
      try {
        const doms = highlighter.getDoms(ann.id);
        if (doms && doms.length > 0) {
          if (ann.type === AnnotationType.DELETION) {
            highlighter.addClass('deletion', ann.id);
          } else if (ann.type === AnnotationType.COMMENT) {
            highlighter.addClass('comment', ann.id);
          }
        }
      } catch {}
    });
  }, [annotations]);

  // Scroll to selected annotation
  useEffect(() => {
    if (!containerRef.current) return;

    // Clear all previously focused highlights
    containerRef.current.querySelectorAll('.annotation-highlight.focused').forEach(el => {
      el.classList.remove('focused');
    });

    if (!selectedAnnotationId) return;

    // Skip scroll if we just created this annotation
    if (justCreatedIdRef.current === selectedAnnotationId) {
      justCreatedIdRef.current = null;
      return;
    }

    const highlighter = highlighterRef.current;
    let targetElements: Element[] = [];

    if (highlighter) {
      try {
        const doms = highlighter.getDoms(selectedAnnotationId);
        if (doms && doms.length > 0) targetElements = Array.from(doms);
      } catch {}
    }

    if (targetElements.length === 0) {
      const manualMarks = containerRef.current.querySelectorAll(
        `[data-bind-id="${selectedAnnotationId}"]`
      );
      if (manualMarks.length > 0) targetElements = Array.from(manualMarks);
    }

    if (targetElements.length === 0) return;

    targetElements.forEach(el => el.classList.add('focused'));
    targetElements[0].scrollIntoView({ behavior: 'smooth', block: 'center' });

    const timer = setTimeout(() => {
      targetElements.forEach(el => el.classList.remove('focused'));
    }, 2000);
    return () => clearTimeout(timer);
  }, [selectedAnnotationId]);

  // --- Handlers ---

  const handleAnnotate = (type: AnnotationType) => {
    const highlighter = highlighterRef.current;
    if (!toolbarState || !highlighter) return;
    createAnnotationFromSource(highlighter, toolbarState.source, type);
    pendingSourceRef.current = null;
    setToolbarState(null);
    window.getSelection()?.removeAllRanges();
  };

  const handleQuickLabel = (label: QuickLabel) => {
    const highlighter = highlighterRef.current;
    if (!toolbarState || !highlighter) return;
    createAnnotationFromSource(
      highlighter, toolbarState.source, AnnotationType.COMMENT,
      `${label.emoji} ${label.text}`, undefined, true, label.tip
    );
    pendingSourceRef.current = null;
    setToolbarState(null);
    window.getSelection()?.removeAllRanges();
  };

  const handleToolbarClose = () => {
    if (toolbarState && highlighterRef.current) {
      highlighterRef.current.remove(toolbarState.source.id);
    }
    pendingSourceRef.current = null;
    setToolbarState(null);
    window.getSelection()?.removeAllRanges();
  };

  const handleRequestComment = (initialChar?: string) => {
    if (!toolbarState) return;
    setCommentPopover({
      anchorEl: toolbarState.element,
      contextText: toolbarState.selectionText.slice(0, 80),
      initialText: initialChar,
      source: toolbarState.source,
    });
    setToolbarState(null);
  };

  const handleCommentSubmit = (text: string, images?: ImageAttachment[]) => {
    if (!commentPopover) return;
    if (commentPopover.source && highlighterRef.current) {
      createAnnotationFromSource(
        highlighterRef.current, commentPopover.source,
        AnnotationType.COMMENT, text, images
      );
      pendingSourceRef.current = null;
      window.getSelection()?.removeAllRanges();
    }
    setCommentPopover(null);
  };

  const handleCommentClose = useCallback(() => {
    setCommentPopover(prev => {
      if (prev?.source && highlighterRef.current) {
        highlighterRef.current.remove(prev.source.id);
        pendingSourceRef.current = null;
      }
      return null;
    });
    window.getSelection()?.removeAllRanges();
  }, []);

  const handleFloatingQuickLabel = useCallback((label: QuickLabel) => {
    if (!quickLabelPicker?.source || !highlighterRef.current) return;
    createAnnotationFromSource(
      highlighterRef.current, quickLabelPicker.source, AnnotationType.COMMENT,
      `${label.emoji} ${label.text}`, undefined, true, label.tip
    );
    pendingSourceRef.current = null;
    setQuickLabelPicker(null);
    window.getSelection()?.removeAllRanges();
  }, [quickLabelPicker]);

  const handleQuickLabelPickerDismiss = useCallback(() => {
    if (quickLabelPicker?.source && highlighterRef.current) {
      highlighterRef.current.remove(quickLabelPicker.source.id);
      pendingSourceRef.current = null;
    }
    setQuickLabelPicker(null);
    window.getSelection()?.removeAllRanges();
  }, [quickLabelPicker]);

  return {
    highlighterRef,
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
    applyAnnotations: applyAnnotationsInternal,
  };
}
