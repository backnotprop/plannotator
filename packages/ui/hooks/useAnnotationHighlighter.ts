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
  selectedText?: string;
  initialText?: string;
  source?: any;
}

export interface QuickLabelPickerState {
  anchorEl: HTMLElement;
  cursorHint?: { x: number; y: number };
  source?: any;
}

type MathAnnotationSource = {
  kind: 'math';
  element: HTMLElement;
  text: string;
  blockId: string;
  displayMode: boolean;
};

const isMathAnnotationSource = (source: any): source is MathAnnotationSource =>
  source?.kind === 'math';

type MathAnnotationTarget = {
  element: HTMLElement;
  blockId: string;
  tex: string;
  displayMode: boolean;
};

const elementFromNode = (node: Node | null): HTMLElement | null => {
  if (!node) return null;
  if (node.nodeType === Node.ELEMENT_NODE) return node as HTMLElement;
  return node.parentNode instanceof HTMLElement ? node.parentNode : null;
};

const closestMathElement = (node: Node | null, root: HTMLElement | null): HTMLElement | null => {
  const element = elementFromNode(node);
  const math = element?.closest<HTMLElement>('.math-annotatable[data-math-tex]');
  if (!math || !root?.contains(math)) return null;
  return math;
};

const mathElementFromSelection = (selection: Selection | null, root: HTMLElement | null): HTMLElement | null => {
  if (!selection || selection.rangeCount === 0) return null;
  return (
    closestMathElement(selection.anchorNode, root) ||
    closestMathElement(selection.focusNode, root) ||
    closestMathElement(selection.getRangeAt(0).commonAncestorContainer, root)
  );
};

const selectionContainsNode = (range: Range, node: Node): boolean => {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
};

const mathSourceFromElement = (element: HTMLElement): MathAnnotationSource | null => {
  const text = element.dataset.mathTex;
  if (!text) return null;

  const block = element.closest<HTMLElement>('[data-block-id]');
  const blockId = block?.dataset.blockId;
  if (!blockId) return null;

  return {
    kind: 'math',
    element,
    text,
    blockId,
    displayMode: element.dataset.mathDisplay === 'true',
  };
};

const mathTargetsFromSelection = (
  selection: Selection | null,
  root: HTMLElement | null,
): MathAnnotationTarget[] => {
  if (!selection || selection.rangeCount === 0 || !root) return [];

  const seen = new Set<HTMLElement>();
  const targets: MathAnnotationTarget[] = [];
  const candidates = root.querySelectorAll<HTMLElement>('.math-annotatable[data-math-tex]');

  for (let i = 0; i < selection.rangeCount; i += 1) {
    const range = selection.getRangeAt(i);
    candidates.forEach(element => {
      if (seen.has(element) || !selectionContainsNode(range, element)) return;
      const source = mathSourceFromElement(element);
      if (!source) return;
      seen.add(element);
      targets.push({
        element,
        blockId: source.blockId,
        tex: source.text,
        displayMode: source.displayMode,
      });
    });
  }

  return targets;
};

const selectionHasNonMathContent = (
  selection: Selection | null,
  root: HTMLElement | null,
): boolean => {
  if (!selection || selection.rangeCount === 0 || !root) return false;

  for (let i = 0; i < selection.rangeCount; i += 1) {
    const range = selection.getRangeAt(i);
    if (!root.contains(range.commonAncestorContainer)) continue;

    // Whole selection sits inside a single formula (both endpoints within the
    // rendered KaTeX): a pure-math selection, not mixed content.
    if (closestMathElement(range.commonAncestorContainer, root)) continue;

    // Otherwise clone the selection, drop any whole math elements it covers,
    // and see if meaningful text is left. Leftover text = genuinely mixed
    // (prose + formula) and should fall through to the normal text path.
    // Nothing left = the selection only spans formulas — even when an endpoint
    // spills into an adjacent text node at offset 0, which the browser does on
    // nearly every drag-select of an inline formula.
    const fragment = range.cloneContents();
    fragment.querySelectorAll?.('.math-annotatable[data-math-tex]').forEach(element => {
      element.remove();
    });
    if (fragment.textContent?.trim()) return true;
  }

  return false;
};

const annotationId = (): string => {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }
  return `ann-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const escapeAttrValue = (value: string): string => {
  if (globalThis.CSS && typeof globalThis.CSS.escape === 'function') {
    return globalThis.CSS.escape(value);
  }
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
};

const applyMathAnnotationClass = (
  element: HTMLElement,
  id: string,
  type: AnnotationType,
  displayMode: boolean,
) => {
  element.classList.add(
    'annotation-highlight',
    displayMode ? 'math-block-annotation' : 'math-inline-annotation',
  );
  element.classList.remove('deletion', 'comment');
  if (type === AnnotationType.DELETION) {
    element.classList.add('deletion');
  } else if (type === AnnotationType.COMMENT) {
    element.classList.add('comment');
  }
  element.dataset.bindId = id;
  element.dataset.mathAnnotation = 'true';
};

const applyMathTargets = (
  targets: MathAnnotationTarget[],
  id: string,
  type: AnnotationType,
) => {
  targets.forEach(target => {
    applyMathAnnotationClass(target.element, id, type, target.displayMode);
  });
};

const clearMathAnnotationClass = (element: Element) => {
  element.classList.remove(
    'annotation-highlight',
    'math-block-annotation',
    'math-inline-annotation',
    'deletion',
    'comment',
    'focused',
  );
  delete (element as HTMLElement).dataset.bindId;
  delete (element as HTMLElement).dataset.mathAnnotation;
};

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
  const pendingMathTargetsRef = useRef<MathAnnotationTarget[]>([]);
  const pendingMathElementRef = useRef<HTMLElement | null>(null);
  const justCreatedIdRef = useRef<string | null>(null);
  const lastMousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const mouseDownMathRef = useRef<HTMLElement | null>(null);

  const [toolbarState, setToolbarState] = useState<ToolbarState | null>(null);
  const [commentPopover, setCommentPopover] = useState<CommentPopoverState | null>(null);
  const [quickLabelPicker, setQuickLabelPicker] = useState<QuickLabelPickerState | null>(null);

  // Keep refs in sync
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { onAddAnnotationRef.current = onAddAnnotation; }, [onAddAnnotation]);
  useEffect(() => { onSelectAnnotationRef.current = onSelectAnnotation; }, [onSelectAnnotation]);

  const clearPendingSelection = useCallback(() => {
    pendingSourceRef.current = null;
    pendingMathTargetsRef.current = [];
    // Strip the pre-submission preview highlight if the annotation was never
    // finalized (createAnnotationFromMathSource nulls this ref once committed).
    if (pendingMathElementRef.current) {
      clearMathAnnotationClass(pendingMathElementRef.current);
      pendingMathElementRef.current = null;
    }
  }, []);

  // Paint a preview highlight on a formula the moment its toolbar/popover opens,
  // so the target is visible before the user commits the annotation.
  const showPendingMathPreview = useCallback((source: MathAnnotationSource) => {
    applyMathAnnotationClass(source.element, 'pending-math', AnnotationType.COMMENT, source.displayMode);
    pendingMathElementRef.current = source.element;
  }, []);

  // Track mouse position for quick label picker
  useEffect(() => {
    const track = (e: MouseEvent) => { lastMousePosRef.current = { x: e.clientX, y: e.clientY }; };
    document.addEventListener('mouseup', track, true);
    return () => document.removeEventListener('mouseup', track, true);
  }, [clearPendingSelection]);

  // --- Helpers ---

  const findTextInDOM = useCallback((searchText: string): Range | null => {
    if (!containerRef.current) return null;

    // Search for an exact substring match inside the container's text tree.
    // Falls back to a multi-text-node walk when the match spans siblings.
    const searchOnce = (needle: string): Range | null => {
      if (!needle || !containerRef.current) return null;

      const rangeFromTextOffsets = (startIndex: number, endIndex: number): Range | null => {
        const walker = document.createTreeWalker(
          containerRef.current!,
          NodeFilter.SHOW_TEXT,
          null
        );

        let charCount = 0;
        let startNode: Text | null = null;
        let startOffset = 0;
        let endNode: Text | null = null;
        let endOffset = 0;
        let node: Text | null;

        while ((node = walker.nextNode() as Text | null)) {
          const nodeLength = node.textContent?.length || 0;

          if (!startNode && charCount + nodeLength > startIndex) {
            startNode = node;
            startOffset = startIndex - charCount;
          }

          if (startNode && charCount + nodeLength >= endIndex) {
            endNode = node;
            endOffset = endIndex - charCount;
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

      const normalizeWithMap = (text: string): { text: string; map: number[] } => {
        let normalized = '';
        const map: number[] = [];
        let inWhitespace = false;

        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (/\s/.test(ch)) {
            if (!inWhitespace) {
              normalized += ' ';
              map.push(i);
              inWhitespace = true;
            }
          } else {
            normalized += ch;
            map.push(i);
            inWhitespace = false;
          }
        }

        let start = 0;
        let end = normalized.length;
        while (start < end && normalized[start] === ' ') start++;
        while (end > start && normalized[end - 1] === ' ') end--;

        return {
          text: normalized.slice(start, end),
          map: map.slice(start, end),
        };
      };

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
      if (searchIndex !== -1) {
        return rangeFromTextOffsets(searchIndex, searchIndex + needle.length);
      }

      const haystack = normalizeWithMap(fullText);
      const normalizedNeedle = normalizeWithMap(needle).text;
      const normalizedIndex = haystack.text.indexOf(normalizedNeedle);
      if (normalizedNeedle && normalizedIndex !== -1) {
        const originalStart = haystack.map[normalizedIndex];
        const originalEnd = haystack.map[normalizedIndex + normalizedNeedle.length - 1] + 1;
        return rangeFromTextOffsets(originalStart, originalEnd);
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

    const mathTargets = pendingMathTargetsRef.current;

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
      ...(mathTargets.length > 0 ? {
        mathTargets: mathTargets.map(target => ({
          blockId: target.blockId,
          tex: target.tex,
          displayMode: target.displayMode,
        })),
      } : {}),
      ...(isQuickLabel ? { isQuickLabel: true } : {}),
      ...(quickLabelTip ? { quickLabelTip } : {}),
    };

    if (type === AnnotationType.DELETION) {
      highlighter.addClass('deletion', source.id);
    } else if (type === AnnotationType.COMMENT) {
      highlighter.addClass('comment', source.id);
    }
    applyMathTargets(mathTargets, source.id, type);

    justCreatedIdRef.current = newAnnotation.id;
    onAddAnnotationRef.current?.(newAnnotation);
  };

  const createAnnotationFromMathSource = (
    source: MathAnnotationSource,
    type: AnnotationType,
    text?: string,
    images?: ImageAttachment[],
    isQuickLabel?: boolean,
    quickLabelTip?: string,
  ) => {
    const id = annotationId();
    applyMathAnnotationClass(source.element, id, type, source.displayMode);
    // Committed — hand ownership of the highlight to the annotation so a later
    // clearPendingSelection() doesn't strip it.
    pendingMathElementRef.current = null;

    const newAnnotation: Annotation = {
      id,
      blockId: source.blockId,
      startOffset: 0,
      endOffset: source.text.length,
      type,
      text,
      originalText: source.text,
      createdA: Date.now(),
      author: getIdentity(),
      images,
      ...(isQuickLabel ? { isQuickLabel: true } : {}),
      ...(quickLabelTip ? { quickLabelTip } : {}),
    };

    justCreatedIdRef.current = newAnnotation.id;
    onAddAnnotationRef.current?.(newAnnotation);
  };

  const findMathElementForAnnotation = useCallback((ann: Annotation): HTMLElement | null => {
    if (!containerRef.current || !ann.blockId || !ann.originalText) return null;

    const block = containerRef.current.querySelector<HTMLElement>(
      `[data-block-id="${escapeAttrValue(ann.blockId)}"]`
    );
    if (!block) return null;

    if (
      block.matches('.math-annotatable[data-math-tex]') &&
      block.dataset.mathTex === ann.originalText
    ) {
      return block;
    }

    const candidates = block.querySelectorAll<HTMLElement>('.math-annotatable[data-math-tex]');
    for (const candidate of Array.from(candidates)) {
      if (candidate.dataset.mathTex === ann.originalText) return candidate;
    }

    return null;
  }, []);

  const findMathElementsForAnnotation = useCallback((ann: Annotation): MathAnnotationTarget[] => {
    if (!containerRef.current) return [];

    if (ann.mathTargets?.length) {
      const targets: MathAnnotationTarget[] = [];
      const seen = new Set<HTMLElement>();

      ann.mathTargets.forEach(target => {
        const block = containerRef.current?.querySelector<HTMLElement>(
          `[data-block-id="${escapeAttrValue(target.blockId)}"]`
        );
        if (!block) return;

        const candidates = [
          ...(block.matches('.math-annotatable[data-math-tex]') ? [block] : []),
          ...Array.from(block.querySelectorAll<HTMLElement>('.math-annotatable[data-math-tex]')),
        ];
        const element = candidates.find(candidate => candidate.dataset.mathTex === target.tex);
        if (!element || seen.has(element)) return;

        seen.add(element);
        targets.push({
          element,
          blockId: target.blockId,
          tex: target.tex,
          displayMode: target.displayMode,
        });
      });

      return targets;
    }

    const mathElement = findMathElementForAnnotation(ann);
    if (!mathElement) return [];

    return [{
      element: mathElement,
      blockId: ann.blockId,
      tex: mathElement.dataset.mathTex ?? ann.originalText,
      displayMode: mathElement.dataset.mathDisplay === 'true',
    }];
  }, [findMathElementForAnnotation]);

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

      const mathTargets = findMathElementsForAnnotation(ann);
      if (mathTargets.length > 0) {
        applyMathTargets(mathTargets, ann.id, ann.type);
        if (!ann.startMeta && !ann.endMeta && !ann.mathTargets?.length) {
          return;
        }
      }

      if (ann.startMeta && ann.endMeta) {
        try {
          highlighter.fromStore(ann.startMeta, ann.endMeta, ann.originalText, ann.id);
          const restoredDoms = highlighter.getDoms(ann.id);
          if (restoredDoms && restoredDoms.length > 0) {
            if (ann.type === AnnotationType.DELETION) {
              highlighter.addClass('deletion', ann.id);
            } else if (ann.type === AnnotationType.COMMENT) {
              highlighter.addClass('comment', ann.id);
            }
            return;
          }
        } catch {}
      }

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
  }, [findMathElementsForAnnotation, findTextInDOM]);

  const removeHighlight = useCallback((id: string) => {
    highlighterRef.current?.remove(id);

    const mathHighlights = containerRef.current?.querySelectorAll(
      `[data-bind-id="${id}"][data-math-annotation="true"]`
    );
    mathHighlights?.forEach(clearMathAnnotationClass);

    const manualHighlights = containerRef.current?.querySelectorAll(`[data-bind-id="${id}"]`);
    manualHighlights?.forEach(el => {
      if ((el as HTMLElement).dataset.mathAnnotation === 'true') return;
      const parent = el.parentNode;
      while (el.firstChild) {
        parent?.insertBefore(el.firstChild, el);
      }
      el.remove();
    });
  }, []);

  const clearAllHighlights = useCallback(() => {
    const mathHighlights = containerRef.current?.querySelectorAll('[data-math-annotation="true"]');
    mathHighlights?.forEach(clearMathAnnotationClass);

    const manualHighlights = containerRef.current?.querySelectorAll('[data-bind-id]');
    manualHighlights?.forEach(el => {
      if ((el as HTMLElement).dataset.mathAnnotation === 'true') return;
      const parent = el.parentNode;
      while (el.firstChild) {
        parent?.insertBefore(el.firstChild, el);
      }
      el.remove();
    });

    const webHighlights = containerRef.current?.querySelectorAll('.annotation-highlight');
    webHighlights?.forEach(el => {
      if ((el as HTMLElement).dataset.mathAnnotation === 'true') return;
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
      exceptSelectors: ['.annotation-toolbar', 'button', '.math-annotatable', '.katex'],
      wrapTag: 'mark',
      style: { className: 'annotation-highlight' },
    });

    highlighterRef.current = highlighter;

    highlighter.on(Highlighter.event.CREATE, ({ sources, type }: { sources: any[]; type?: string }) => {
      if (type === 'from-store') return;
      if (sources.length > 0) {
        const source = sources[0];
        const doms = highlighter.getDoms(source.id);
        if (doms?.length > 0) {
          // Clean up previous pending
          if (pendingSourceRef.current) {
            highlighter.remove(pendingSourceRef.current.id);
          }
          clearPendingSelection();
          pendingMathTargetsRef.current = mathTargetsFromSelection(window.getSelection(), containerRef.current);
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
              selectedText: source.text,
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

    const handleMathMouseDown = (event: MouseEvent) => {
      mouseDownMathRef.current = closestMathElement(event.target as Node, containerRef.current);
      if (mouseDownMathRef.current) {
        event.stopPropagation();
      }
    };

    const handleMathMouseUp = (event: MouseEvent) => {
      if (!containerRef.current) return;

      const selection = window.getSelection();
      const mathElement =
        closestMathElement(event.target as Node, containerRef.current) ||
        mouseDownMathRef.current ||
        mathElementFromSelection(selection, containerRef.current);
      mouseDownMathRef.current = null;

      if (!mathElement) return;

      const existingId = mathElement.dataset.bindId;
      const selectedText = selection?.toString().trim() ?? '';
      if (!selectedText && existingId && modeRef.current !== 'redline') {
        event.preventDefault();
        event.stopPropagation();
        onSelectAnnotationRef.current?.(existingId);
        return;
      }
      if (selectionHasNonMathContent(selection, containerRef.current)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const source = mathSourceFromElement(mathElement);
      if (!source) return;

      if (pendingSourceRef.current && !isMathAnnotationSource(pendingSourceRef.current)) {
        highlighter.remove(pendingSourceRef.current.id);
      }
      clearPendingSelection();
      setToolbarState(null);
      setCommentPopover(null);
      setQuickLabelPicker(null);

      if (modeRef.current === 'redline') {
        createAnnotationFromMathSource(source, AnnotationType.DELETION);
        selection?.removeAllRanges();
        return;
      }

      if (modeRef.current === 'comment') {
        pendingSourceRef.current = source;
        showPendingMathPreview(source);
        setCommentPopover({
          anchorEl: source.element,
          contextText: source.text.slice(0, 80),
          selectedText: source.text,
          source,
        });
        return;
      }

      if (modeRef.current === 'quickLabel') {
        pendingSourceRef.current = source;
        showPendingMathPreview(source);
        setQuickLabelPicker({
          anchorEl: source.element,
          cursorHint: lastMousePosRef.current,
          source,
        });
        return;
      }

      pendingSourceRef.current = source;
      showPendingMathPreview(source);
      setToolbarState({
        element: source.element,
        source,
        selectionText: source.text,
      });
    };

    containerRef.current.addEventListener('mousedown', handleMathMouseDown, true);
    containerRef.current.addEventListener('mouseup', handleMathMouseUp, true);

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
      containerRef.current?.removeEventListener('mousedown', handleMathMouseDown, true);
      containerRef.current?.removeEventListener('mouseup', handleMathMouseUp, true);
      highlighter.dispose();
    };
  }, [clearPendingSelection, enabled]);

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
    if (!toolbarState) return;
    if (isMathAnnotationSource(toolbarState.source)) {
      createAnnotationFromMathSource(toolbarState.source, type);
      clearPendingSelection();
      setToolbarState(null);
      window.getSelection()?.removeAllRanges();
      return;
    }
    if (!highlighter) return;
    createAnnotationFromSource(highlighter, toolbarState.source, type);
    clearPendingSelection();
    setToolbarState(null);
    window.getSelection()?.removeAllRanges();
  };

  const handleQuickLabel = (label: QuickLabel) => {
    const highlighter = highlighterRef.current;
    if (!toolbarState) return;
    if (isMathAnnotationSource(toolbarState.source)) {
      createAnnotationFromMathSource(
        toolbarState.source, AnnotationType.COMMENT,
        `${label.emoji} ${label.text}`, undefined, true, label.tip
      );
      clearPendingSelection();
      setToolbarState(null);
      window.getSelection()?.removeAllRanges();
      return;
    }
    if (!highlighter) return;
    createAnnotationFromSource(
      highlighter, toolbarState.source, AnnotationType.COMMENT,
      `${label.emoji} ${label.text}`, undefined, true, label.tip
    );
    clearPendingSelection();
    setToolbarState(null);
    window.getSelection()?.removeAllRanges();
  };

  const handleToolbarClose = () => {
    if (toolbarState && highlighterRef.current && !isMathAnnotationSource(toolbarState.source)) {
      highlighterRef.current.remove(toolbarState.source.id);
    }
    clearPendingSelection();
    setToolbarState(null);
    window.getSelection()?.removeAllRanges();
  };

  const handleRequestComment = (initialChar?: string) => {
    if (!toolbarState) return;
    setCommentPopover({
      anchorEl: toolbarState.element,
      contextText: toolbarState.selectionText.slice(0, 80),
      selectedText: toolbarState.selectionText,
      initialText: initialChar,
      source: toolbarState.source,
    });
    setToolbarState(null);
  };

  const handleCommentSubmit = (text: string, images?: ImageAttachment[]) => {
    if (!commentPopover) return;
    if (isMathAnnotationSource(commentPopover.source)) {
      createAnnotationFromMathSource(
        commentPopover.source,
        AnnotationType.COMMENT,
        text,
        images,
      );
      clearPendingSelection();
      window.getSelection()?.removeAllRanges();
      setCommentPopover(null);
      return;
    }
    if (commentPopover.source && highlighterRef.current) {
      createAnnotationFromSource(
        highlighterRef.current, commentPopover.source,
        AnnotationType.COMMENT, text, images
      );
      clearPendingSelection();
      window.getSelection()?.removeAllRanges();
    }
    setCommentPopover(null);
  };

  const handleCommentClose = useCallback(() => {
    setCommentPopover(prev => {
      if (prev?.source && highlighterRef.current && !isMathAnnotationSource(prev.source)) {
        highlighterRef.current.remove(prev.source.id);
      }
      return null;
    });
    clearPendingSelection();
    window.getSelection()?.removeAllRanges();
  }, [clearPendingSelection]);

  const handleFloatingQuickLabel = useCallback((label: QuickLabel) => {
    if (!quickLabelPicker?.source) return;
    if (isMathAnnotationSource(quickLabelPicker.source)) {
      createAnnotationFromMathSource(
        quickLabelPicker.source,
        AnnotationType.COMMENT,
        `${label.emoji} ${label.text}`,
        undefined,
        true,
        label.tip,
      );
      clearPendingSelection();
      setQuickLabelPicker(null);
      window.getSelection()?.removeAllRanges();
      return;
    }
    if (!highlighterRef.current) return;
    createAnnotationFromSource(
      highlighterRef.current, quickLabelPicker.source, AnnotationType.COMMENT,
      `${label.emoji} ${label.text}`, undefined, true, label.tip
    );
    clearPendingSelection();
    setQuickLabelPicker(null);
    window.getSelection()?.removeAllRanges();
  }, [clearPendingSelection, quickLabelPicker]);

  const handleQuickLabelPickerDismiss = useCallback(() => {
    if (
      quickLabelPicker?.source &&
      highlighterRef.current &&
      !isMathAnnotationSource(quickLabelPicker.source)
    ) {
      highlighterRef.current.remove(quickLabelPicker.source.id);
    }
    clearPendingSelection();
    setQuickLabelPicker(null);
    window.getSelection()?.removeAllRanges();
  }, [clearPendingSelection, quickLabelPicker]);

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
