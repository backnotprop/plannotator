import React, { useRef, useState, useEffect, useMemo, forwardRef, useImperativeHandle, useCallback } from 'react';
import { createPortal } from 'react-dom';
import hljs from 'highlight.js';
import { Block, Annotation, AnnotationType, EditorMode, type InputMethod, type ImageAttachment, type ActionsLabelMode } from '../types';
import { Frontmatter, computeListIndices } from '../utils/parser';
import { buildHeadingSlugMap } from '../utils/slugify';
import { BlockRenderer } from './BlockRenderer';
import { CodeBlock } from './blocks/CodeBlock';
import { TableBlock } from './blocks/TableBlock';
import { TableToolbar } from './blocks/TableToolbar';
import { TablePopout } from './blocks/TablePopout';
import { CodePathValidationContext } from './CodePathValidationContext';
import { useValidatedCodePaths } from '../hooks/useValidatedCodePaths';
import { ListMarker } from './ListMarker';
import { AnnotationToolbar } from './AnnotationToolbar';
import { FloatingQuickLabelPicker } from './FloatingQuickLabelPicker';

// Debug error boundary to catch silent toolbar crashes
class ToolbarErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('AnnotationToolbar crashed:', error); }
  render() {
    if (this.state.error) {
      return <div style={{ position: 'fixed', top: 10, left: 10, zIndex: 9999, background: 'red', color: 'white', padding: '8px 12px', borderRadius: 6, fontSize: 12 }}>
        Toolbar error: {this.state.error.message}
      </div>;
    }
    return this.props.children;
  }
}

import { CommentPopover } from './CommentPopover';
import { TaterSpriteSitting } from './TaterSpriteSitting';
import { AttachmentsButton } from './AttachmentsButton';
import { GraphvizBlock } from './GraphvizBlock';
import { MermaidBlock } from './MermaidBlock';
import { getImageSrc } from './ImageThumbnail';
import { isGraphvizLanguage, isMermaidLanguage } from './diagramLanguages';
import { getIdentity } from '../utils/identity';
import { type QuickLabel } from '../utils/quickLabels';
import { DocBadges } from './DocBadges';
import { PinpointOverlay } from './PinpointOverlay';
import { usePinpoint } from '../hooks/usePinpoint';
import { useAnnotationHighlighter } from '../hooks/useAnnotationHighlighter';
import { useScrollViewport } from '../hooks/useScrollViewport';
import { decodeAnchorHash } from '../utils/anchors';

interface ViewerProps {
  blocks: Block[];
  markdown: string;
  frontmatter?: Frontmatter | null;
  annotations: Annotation[];
  onAddAnnotation: (ann: Annotation) => void;
  onSelectAnnotation: (id: string | null) => void;
  selectedAnnotationId: string | null;
  mode: EditorMode;
  inputMethod?: InputMethod;
  taterMode: boolean;
  globalAttachments?: ImageAttachment[];
  onAddGlobalAttachment?: (image: ImageAttachment) => void;
  onRemoveGlobalAttachment?: (path: string) => void;
  repoInfo?: { display: string; branch?: string; host?: string } | null;
  stickyActions?: boolean;
  onOpenLinkedDoc?: (path: string) => void;
  onOpenCodeFile?: (path: string) => void;
  imageBaseDir?: string;
  /** Directory the active document lives in — used by the code-path validator
   *  so out-of-tree relative references (e.g. `../foo.ts` in a linked doc)
   *  resolve against the doc's own directory rather than only cwd. */
  codePathBaseDir?: string;
  linkedDocInfo?: { filepath: string; onBack: () => void; label?: string; backLabel?: string } | null;
  // Plan diff props
  planDiffStats?: { additions: number; deletions: number; modifications: number } | null;
  isPlanDiffActive?: boolean;
  onPlanDiffToggle?: () => void;
  hasPreviousVersion?: boolean;
  /** Show amber "Demo" badge (portal mode, no shared content loaded) */
  showDemoBadge?: boolean;
  /** Max width in px for the plan card; null removes the cap entirely. */
  maxWidth?: number | null;
  /** Label for the copy button (default: "Copy plan") */
  copyLabel?: string;
  /**
   * Compactness of the action button labels. See ActionsLabelMode in
   * types.ts. Defaults to 'full' to preserve the original look for
   * callers that don't measure plan-area width.
   */
  actionsLabelMode?: ActionsLabelMode;
  archiveInfo?: { status: 'approved' | 'denied' | 'unknown'; timestamp: string; title: string } | null;
  /** Source attribution for HTML/URL annotations (e.g. URL or filename) */
  sourceInfo?: string;
  // Checkbox toggle props
  onToggleCheckbox?: (blockId: string, checked: boolean) => void;
  checkboxOverrides?: Map<string, boolean>;
}

export interface ViewerHandle {
  removeHighlight: (id: string) => void;
  clearAllHighlights: () => void;
  applySharedAnnotations: (annotations: Annotation[]) => void;
}

/**
 * Renders YAML frontmatter as a styled metadata card.
 */
const FrontmatterCard: React.FC<{ frontmatter: Frontmatter }> = ({ frontmatter }) => {
  const entries = Object.entries(frontmatter);
  if (entries.length === 0) return null;

  return (
    <div className="mt-4 mb-6 p-4 bg-muted/30 border border-border/50 rounded-lg">
      <div className="grid gap-2 text-sm">
        {entries.map(([key, value]) => (
          <div key={key} className="flex gap-2">
            <span className="font-medium text-muted-foreground min-w-[80px]">{key}:</span>
            <span className="text-foreground">
              {Array.isArray(value) ? (
                <span className="flex flex-wrap gap-1">
                  {value.map((v, i) => (
                    <span key={i} className="px-1.5 py-0.5 bg-primary/10 text-primary rounded text-xs">
                      {v}
                    </span>
                  ))}
                </span>
              ) : (
                value
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export const Viewer = forwardRef<ViewerHandle, ViewerProps>(({
  blocks,
  markdown,
  frontmatter,
  annotations,
  onAddAnnotation,
  onSelectAnnotation,
  selectedAnnotationId,
  mode,
  inputMethod = 'drag',
  taterMode,
  globalAttachments = [],
  onAddGlobalAttachment,
  onRemoveGlobalAttachment,
  repoInfo,
  stickyActions = true,
  planDiffStats,
  isPlanDiffActive,
  onPlanDiffToggle,
  hasPreviousVersion,
  showDemoBadge,
  maxWidth,
  onOpenLinkedDoc,
  onOpenCodeFile,
  linkedDocInfo,
  imageBaseDir,
  codePathBaseDir,
  copyLabel,
  actionsLabelMode = 'full',
  archiveInfo,
  sourceInfo,
  onToggleCheckbox,
  checkboxOverrides,
}, ref) => {
  const [copied, setCopied] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const [locationHash, setLocationHash] = useState(() => window.location.hash);
  const globalCommentButtonRef = useRef<HTMLButtonElement>(null);

  const handleCopyPlan = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy:', e);
    }
  };
  const containerRef = useRef<HTMLDivElement>(null);
  // Per-doc heading slug map with dedup — computed once per blocks array so
  // anchor ids stay stable across re-renders and duplicate heading texts get
  // `-1`/`-2`/... suffixes rather than colliding on the same id.
  const headingSlugMap = useMemo(() => buildHeadingSlugMap(blocks), [blocks]);
  const [hoveredCodeBlock, setHoveredCodeBlock] = useState<{ block: Block; element: HTMLElement } | null>(null);
  const [isCodeBlockToolbarExiting, setIsCodeBlockToolbarExiting] = useState(false);
  const [hoveredTable, setHoveredTable] = useState<{ block: Block; element: HTMLElement } | null>(null);
  const [isTableToolbarExiting, setIsTableToolbarExiting] = useState(false);
  const tableHoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [popoutTable, setPopoutTable] = useState<Block | null>(null);
  // Viewer-specific comment popover state (global comments + code blocks)
  const [viewerCommentPopover, setViewerCommentPopover] = useState<{
    anchorEl: HTMLElement;
    contextText: string;
    initialText?: string;
    isGlobal: boolean;
    codeBlock?: { block: Block; element: HTMLElement };
  } | null>(null);
  // Viewer-specific quick label state (code blocks)
  const [codeBlockQuickLabelPicker, setCodeBlockQuickLabelPicker] = useState<{
    anchorEl: HTMLElement;
    codeBlock: { block: Block; element: HTMLElement };
  } | null>(null);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const stickySentinelRef = useRef<HTMLDivElement>(null);
  const lastAutoScrolledHashRef = useRef<string | null>(null);
  const [isStuck, setIsStuck] = useState(false);

  // Shared annotation infrastructure via hook
  const {
    highlighterRef,
    toolbarState,
    commentPopover: hookCommentPopover,
    quickLabelPicker: hookQuickLabelPicker,
    handleAnnotate,
    handleQuickLabel,
    handleToolbarClose,
    handleRequestComment,
    handleCommentSubmit: hookCommentSubmit,
    handleCommentClose: hookCommentClose,
    handleFloatingQuickLabel: hookFloatingQuickLabel,
    handleQuickLabelPickerDismiss: hookQuickLabelPickerDismiss,
    removeHighlight: hookRemoveHighlight,
    clearAllHighlights,
    applyAnnotations,
  } = useAnnotationHighlighter({
    containerRef,
    annotations,
    onAddAnnotation,
    onSelectAnnotation,
    selectedAnnotationId,
    mode,
  });

  // Refs for code block annotation path
  const onAddAnnotationRef = useRef(onAddAnnotation);
  useEffect(() => { onAddAnnotationRef.current = onAddAnnotation; }, [onAddAnnotation]);
  const modeRef = useRef<EditorMode>(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  // Pinpoint mode: hover + click to select elements
  const handlePinpointCodeBlockClick = useCallback((blockId: string, element: HTMLElement) => {
    const codeEl = element.querySelector('code');
    if (!codeEl) return;
    // In pinpoint mode, apply code block annotation based on current editor mode
    if (modeRef.current === 'redline') {
      applyCodeBlockAnnotation(blockId, codeEl, AnnotationType.DELETION);
    } else if (modeRef.current === 'quickLabel') {
      setCodeBlockQuickLabelPicker({
        anchorEl: element,
        codeBlock: { block: blocks.find(b => b.id === blockId)!, element },
      });
    } else {
      // Show comment popover anchored to the code block
      setViewerCommentPopover({
        anchorEl: element,
        contextText: (codeEl.textContent || '').slice(0, 80),
        isGlobal: false,
        codeBlock: { block: blocks.find(b => b.id === blockId)!, element },
      });
    }
  }, [blocks]);

  const { hoverTarget } = usePinpoint({
    containerRef,
    highlighterRef,
    inputMethod,
    enabled: !toolbarState && !hookCommentPopover && !viewerCommentPopover && !hookQuickLabelPicker && !codeBlockQuickLabelPicker && !(isPlanDiffActive ?? false),
    onCodeBlockClick: handlePinpointCodeBlockClick,
  });

  // Suppress native context menu on touch devices (prevents cut/copy/paste overlay on mobile)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const isTouchPrimary = window.matchMedia('(pointer: coarse)').matches;
    if (!isTouchPrimary) return;

    const handleContextMenu = (e: Event) => {
      e.preventDefault();
    };

    container.addEventListener('contextmenu', handleContextMenu);
    return () => container.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  // Detect when sticky action bar is "stuck" to show card background.
  // The IntersectionObserver root must be the actual scroll element — the
  // OverlayScrollArea viewport — not the <main> host, which doesn't scroll.
  const stickyScrollViewport = useScrollViewport();
  useEffect(() => {
    if (!stickyActions || !stickySentinelRef.current || !stickyScrollViewport) return;
    const observer = new IntersectionObserver(
      ([entry]) => setIsStuck(!entry.isIntersecting),
      { root: stickyScrollViewport, threshold: 0 }
    );
    observer.observe(stickySentinelRef.current);
    return () => observer.disconnect();
  }, [stickyActions, stickyScrollViewport]);

  useEffect(() => {
    const handleHashChange = () => {
      lastAutoScrolledHashRef.current = null;
      setLocationHash(window.location.hash);
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const scrollToAnchor = useCallback((hash: string) => {
    const anchor = decodeAnchorHash(hash);
    if (!anchor) return false;

    const container = containerRef.current;
    if (!container || !stickyScrollViewport) return false;

    const target = document.getElementById(anchor);
    if (!target || !container.contains(target)) return false;

    const stickyActionsEl = container.querySelector<HTMLElement>('[data-sticky-actions]');
    const stickyTop = stickyActionsEl
      ? Number.parseFloat(window.getComputedStyle(stickyActionsEl).top || '0') || 0
      : 0;
    const headerOffset = stickyActionsEl
      ? stickyActionsEl.getBoundingClientRect().height + stickyTop
      : 0;
    const containerRect = stickyScrollViewport.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const relativeTop = targetRect.top - containerRect.top;
    const offsetPosition = stickyScrollViewport.scrollTop + relativeTop - headerOffset;

    stickyScrollViewport.scrollTo({
      top: Math.max(0, offsetPosition),
      behavior: 'smooth',
    });
    return true;
  }, [stickyScrollViewport]);

  useEffect(() => {
    if (!stickyScrollViewport || !locationHash || lastAutoScrolledHashRef.current === locationHash) return;
    const timer = window.setTimeout(() => {
      if (scrollToAnchor(locationHash)) {
        lastAutoScrolledHashRef.current = locationHash;
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [blocks, locationHash, scrollToAnchor, stickyScrollViewport]);

  // Cmd+C / Ctrl+C keyboard shortcut for copying selected text
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // Check for Cmd+C (Mac) or Ctrl+C (Windows/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
        // Don't intercept if typing in an input/textarea
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;

        // If we have an active selection with captured text, use that
        if (toolbarState?.selectionText) {
          e.preventDefault();
          try {
            await navigator.clipboard.writeText(toolbarState.selectionText);
          } catch (err) {
            console.error('Failed to copy:', err);
          }
        }
        // Otherwise let the browser handle default copy behavior
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [toolbarState]);

  // Imperative handle — delegates to hook, extends removeHighlight for code blocks
  useImperativeHandle(ref, () => ({
    removeHighlight: (id: string) => {
      // Code block annotations need syntax re-highlighting after removal.
      // Must run BEFORE hookRemoveHighlight, which removes the <mark> elements.
      const manualHighlights = containerRef.current?.querySelectorAll(`[data-bind-id="${id}"]`);
      manualHighlights?.forEach(el => {
        const parent = el.parentNode;
        if (parent && parent.nodeName === 'CODE') {
          const codeEl = parent as HTMLElement;
          const plainText = el.textContent || '';
          el.remove();
          codeEl.textContent = plainText;
          const block = blocks.find(b => b.id === codeEl.closest('[data-block-id]')?.getAttribute('data-block-id'));
          codeEl.removeAttribute('data-highlighted');
          codeEl.className = `hljs font-mono${block?.language ? ` language-${block.language}` : ''}`;
          hljs.highlightElement(codeEl);
        }
      });

      hookRemoveHighlight(id);
    },
    clearAllHighlights,
    applySharedAnnotations: applyAnnotations,
  }), [hookRemoveHighlight, clearAllHighlights, applyAnnotations, blocks]);

  // --- Viewer-specific: code block annotation ---

  const applyCodeBlockAnnotation = (
    blockId: string,
    codeEl: Element,
    type: AnnotationType,
    text?: string,
    images?: ImageAttachment[],
    isQuickLabel?: boolean,
    quickLabelTip?: string,
  ) => {
    const id = `codeblock-${Date.now()}`;
    const codeText = codeEl.textContent || '';

    const wrapper = document.createElement('mark');
    wrapper.className = `annotation-highlight ${type === AnnotationType.DELETION ? 'deletion' : type === AnnotationType.COMMENT ? 'comment' : ''}`.trim();
    wrapper.dataset.bindId = id;
    wrapper.textContent = codeText;

    codeEl.innerHTML = '';
    codeEl.appendChild(wrapper);

    const newAnnotation: Annotation = {
      id,
      blockId,
      startOffset: 0,
      endOffset: codeText.length,
      type,
      text,
      originalText: codeText,
      createdA: Date.now(),
      author: getIdentity(),
      images,
      ...(isQuickLabel ? { isQuickLabel: true } : {}),
      ...(quickLabelTip ? { quickLabelTip } : {}),
    };

    onAddAnnotationRef.current(newAnnotation);
    window.getSelection()?.removeAllRanges();
  };

  const handleCodeBlockAnnotate = (type: AnnotationType) => {
    if (!hoveredCodeBlock) return;
    const codeEl = hoveredCodeBlock.element.querySelector('code');
    if (!codeEl) return;
    applyCodeBlockAnnotation(hoveredCodeBlock.block.id, codeEl, type);
    setHoveredCodeBlock(null);
  };

  const handleCodeBlockQuickLabel = (label: QuickLabel) => {
    if (!hoveredCodeBlock) return;
    const codeEl = hoveredCodeBlock.element.querySelector('code');
    if (!codeEl) return;
    applyCodeBlockAnnotation(
      hoveredCodeBlock.block.id, codeEl, AnnotationType.COMMENT,
      `${label.emoji} ${label.text}`, undefined, true, label.tip
    );
    setHoveredCodeBlock(null);
  };

  const handleCodeBlockToolbarClose = () => {
    setHoveredCodeBlock(null);
  };

  // Viewer-specific comment popover handlers (code blocks + global comments)

  const handleCodeBlockRequestComment = (initialChar?: string) => {
    if (!hoveredCodeBlock) return;
    const codeText = hoveredCodeBlock.element.querySelector('code')?.textContent || '';
    setViewerCommentPopover({
      anchorEl: hoveredCodeBlock.element,
      contextText: codeText.slice(0, 80),
      initialText: initialChar,
      isGlobal: false,
      codeBlock: hoveredCodeBlock,
    });
    setHoveredCodeBlock(null);
  };

  const handleViewerCommentSubmit = (text: string, images?: ImageAttachment[]) => {
    if (!viewerCommentPopover) return;

    if (viewerCommentPopover.isGlobal) {
      const newAnnotation: Annotation = {
        id: `global-${Date.now()}`,
        blockId: '',
        startOffset: 0,
        endOffset: 0,
        type: AnnotationType.GLOBAL_COMMENT,
        text: text.trim(),
        originalText: '',
        createdA: Date.now(),
        author: getIdentity(),
        images,
      };
      onAddAnnotation(newAnnotation);
    } else if (viewerCommentPopover.codeBlock) {
      const codeEl = viewerCommentPopover.codeBlock.element.querySelector('code');
      if (codeEl) {
        applyCodeBlockAnnotation(viewerCommentPopover.codeBlock.block.id, codeEl, AnnotationType.COMMENT, text, images);
      }
    }

    setViewerCommentPopover(null);
  };

  const handleViewerCommentClose = useCallback(() => {
    setViewerCommentPopover(null);
  }, []);

  const codePathValidation = useValidatedCodePaths(markdown, codePathBaseDir);

  return (
    <CodePathValidationContext.Provider value={codePathValidation}>
    <div className="relative z-50 w-full" style={maxWidth === null ? undefined : { maxWidth: maxWidth ?? 832 }}>
      {taterMode && <TaterSpriteSitting />}
      <article
        ref={containerRef}
        data-print-region="article"
        className={`w-full bg-card rounded-xl shadow-xl p-5 md:p-8 lg:p-10 xl:p-12 relative border border-border/50 ${inputMethod === 'pinpoint' ? 'cursor-crosshair' : ''}`}
        style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
      >
        {/* Repo info + plan diff badge + demo badge + linked doc badge + archive badge - top left */}
        {(repoInfo || hasPreviousVersion || showDemoBadge || linkedDocInfo || archiveInfo || sourceInfo) && (
          <div data-print-hide className="absolute top-3 left-3 md:top-4 md:left-5">
            <DocBadges
              layout="column"
              repoInfo={repoInfo}
              planDiffStats={planDiffStats}
              isPlanDiffActive={isPlanDiffActive}
              hasPreviousVersion={hasPreviousVersion}
              onPlanDiffToggle={onPlanDiffToggle}
              showDemoBadge={showDemoBadge}
              archiveInfo={archiveInfo}
              linkedDocInfo={linkedDocInfo}
              sourceInfo={sourceInfo}
            />
          </div>
        )}

        {/* Sentinel for sticky detection */}
        {stickyActions && <div ref={stickySentinelRef} className="h-0 w-0 float-right" aria-hidden="true" />}

        {/* Header buttons - top right */}
        <div data-print-hide data-sticky-actions className={`${stickyActions ? 'sticky top-3' : ''} z-30 float-right flex items-start gap-1 md:gap-2 rounded-lg p-1 md:p-2 transition-colors duration-150 ${isStuck ? 'bg-card/95 backdrop-blur-sm shadow-sm' : ''} -mr-3 mt-6 md:-mr-5 md:-mt-5 lg:-mr-7 lg:-mt-7 xl:-mr-9 xl:-mt-9`}>
          {/* Attachments button */}
          {onAddGlobalAttachment && onRemoveGlobalAttachment && (
            <AttachmentsButton
              images={globalAttachments}
              onAdd={onAddGlobalAttachment}
              onRemove={onRemoveGlobalAttachment}
              variant="toolbar"
              hideLabel={actionsLabelMode === 'icon'}
            />
          )}

          {/* <span className="md:hidden">Comment</span><span className="hidden md:inline">Global comment</span> button */}
          <button
            ref={globalCommentButtonRef}
            onClick={() => {
              setViewerCommentPopover({
                anchorEl: globalCommentButtonRef.current!,
                contextText: '',
                isGlobal: true,
              });
            }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-md transition-colors"
            title="Add global comment"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
            </svg>
            {actionsLabelMode === 'full' && <span>Global comment</span>}
            {actionsLabelMode === 'short' && <span>Comment</span>}
          </button>

          {/* Copy plan/file button */}
          <button
            onClick={handleCopyPlan}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-md transition-colors"
            title={copied ? 'Copied!' : copyLabel || (linkedDocInfo ? 'Copy file' : 'Copy plan')}
          >
            {copied ? (
              <>
                <svg className="w-3.5 h-3.5 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Copied!
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                {actionsLabelMode === 'full' && <span>{copyLabel || (linkedDocInfo ? 'Copy file' : 'Copy plan')}</span>}
                {actionsLabelMode === 'short' && <span>Copy</span>}
              </>
            )}
          </button>
        </div>
        {frontmatter && <><div className="clear-right md:hidden" /><FrontmatterCard frontmatter={frontmatter} /></>}
        {!frontmatter && blocks.length > 0 && blocks[0].type !== 'heading' && <div className="mt-4" />}
        {groupBlocks(blocks).map(group =>
          group.type === 'list-group' ? (
            (() => {
              const indices = computeListIndices(group.blocks);
              return (
                <div key={group.key} data-pinpoint-group="list" className="py-1 -mx-2 px-2">
                  {group.blocks.map((block, i) => (
                    <BlockRenderer
                      imageBaseDir={imageBaseDir}
                      onImageClick={(src, alt) => setLightbox({ src, alt })}
                      key={block.id}
                      block={block}
                      orderedIndex={indices[i]}
                      onOpenLinkedDoc={onOpenLinkedDoc}
                      onOpenCodeFile={onOpenCodeFile}
                      onToggleCheckbox={onToggleCheckbox}
                      checkboxOverrides={checkboxOverrides}
                      githubRepo={repoInfo?.display}
                      headingAnchorId={headingSlugMap.get(block.id)}
                      onNavigateAnchor={scrollToAnchor}
                    />
                  ))}
                </div>
              );
            })()
          ) : group.block.type === 'code' && isMermaidLanguage(group.block.language) ? (
            <MermaidBlock key={group.block.id} block={group.block} />
          ) : group.block.type === 'code' && isGraphvizLanguage(group.block.language) ? (
            <GraphvizBlock key={group.block.id} block={group.block} />
          ) : group.block.type === 'table' ? (
            <TableBlock
              key={group.block.id}
              block={group.block}
              imageBaseDir={imageBaseDir}
              onImageClick={(src, alt) => setLightbox({ src, alt })}
              onOpenLinkedDoc={onOpenLinkedDoc}
              onOpenCodeFile={onOpenCodeFile}
              githubRepo={repoInfo?.display}
              onNavigateAnchor={scrollToAnchor}
              onHover={(element) => {
                if (tableHoverTimeoutRef.current) {
                  clearTimeout(tableHoverTimeoutRef.current);
                  tableHoverTimeoutRef.current = null;
                }
                setIsTableToolbarExiting(false);
                if (!toolbarState) {
                  setHoveredTable({ block: group.block, element });
                }
              }}
              onLeave={() => {
                tableHoverTimeoutRef.current = setTimeout(() => {
                  setIsTableToolbarExiting(true);
                  setTimeout(() => {
                    setHoveredTable(null);
                    setIsTableToolbarExiting(false);
                  }, 150);
                }, 100);
              }}
            />
          ) : group.block.type === 'code' ? (
            <CodeBlock
              key={group.block.id}
              block={group.block}
              onHover={inputMethod === 'pinpoint' ? () => {} : (element) => {
                // Clear any pending leave timeout
                if (hoverTimeoutRef.current) {
                  clearTimeout(hoverTimeoutRef.current);
                  hoverTimeoutRef.current = null;
                }
                // Cancel exit animation if re-entering
                setIsCodeBlockToolbarExiting(false);
                // Only show hover toolbar if no selection toolbar is active
                if (!toolbarState) {
                  setHoveredCodeBlock({ block: group.block, element });
                }
              }}
              onLeave={inputMethod === 'pinpoint' ? () => {} : () => {
                // Delay then start exit animation
                hoverTimeoutRef.current = setTimeout(() => {
                  setIsCodeBlockToolbarExiting(true);
                  // After exit animation, unmount
                  setTimeout(() => {
                    setHoveredCodeBlock(null);
                    setIsCodeBlockToolbarExiting(false);
                  }, 150);
                }, 100);
              }}
              isHovered={inputMethod !== 'pinpoint' && hoveredCodeBlock?.block.id === group.block.id}
            />
          ) : (
            <BlockRenderer imageBaseDir={imageBaseDir} onImageClick={(src, alt) => setLightbox({ src, alt })} key={group.block.id} block={group.block} onOpenLinkedDoc={onOpenLinkedDoc} onOpenCodeFile={onOpenCodeFile} onNavigateAnchor={scrollToAnchor} onToggleCheckbox={onToggleCheckbox} checkboxOverrides={checkboxOverrides} githubRepo={repoInfo?.display} headingAnchorId={headingSlugMap.get(group.block.id)} />
          )
        )}

        {/* Text selection toolbar */}
        {toolbarState && (
          <ToolbarErrorBoundary>
            <AnnotationToolbar
              element={toolbarState.element}
              positionMode="center-above"
              onAnnotate={handleAnnotate}
              onClose={handleToolbarClose}
              onRequestComment={handleRequestComment}
              onQuickLabel={handleQuickLabel}
              copyText={toolbarState.selectionText}
              closeOnScrollOut
            />
          </ToolbarErrorBoundary>
        )}

        {/* Table hover toolbar */}
        {hoveredTable && !toolbarState && (
          <TableToolbar
            element={hoveredTable.element}
            markdown={hoveredTable.block.content}
            isExiting={isTableToolbarExiting}
            onExpand={() => {
              setPopoutTable(hoveredTable.block);
              setHoveredTable(null);
              setIsTableToolbarExiting(false);
              if (tableHoverTimeoutRef.current) {
                clearTimeout(tableHoverTimeoutRef.current);
                tableHoverTimeoutRef.current = null;
              }
            }}
            onMouseEnter={() => {
              if (tableHoverTimeoutRef.current) {
                clearTimeout(tableHoverTimeoutRef.current);
                tableHoverTimeoutRef.current = null;
              }
              setIsTableToolbarExiting(false);
            }}
            onMouseLeave={() => {
              tableHoverTimeoutRef.current = setTimeout(() => {
                setIsTableToolbarExiting(true);
                setTimeout(() => {
                  setHoveredTable(null);
                  setIsTableToolbarExiting(false);
                }, 150);
              }, 100);
            }}
          />
        )}

        {/* Code block hover toolbar */}
        {hoveredCodeBlock && !toolbarState && (
          <ToolbarErrorBoundary>
          <AnnotationToolbar
            element={hoveredCodeBlock.element}
            positionMode="top-right"
            onAnnotate={handleCodeBlockAnnotate}
            onClose={handleCodeBlockToolbarClose}
            onRequestComment={handleCodeBlockRequestComment}
            onQuickLabel={handleCodeBlockQuickLabel}
            isExiting={isCodeBlockToolbarExiting}
            onMouseEnter={() => {
              if (hoverTimeoutRef.current) {
                clearTimeout(hoverTimeoutRef.current);
                hoverTimeoutRef.current = null;
              }
              setIsCodeBlockToolbarExiting(false);
            }}
            onMouseLeave={() => {
              hoverTimeoutRef.current = setTimeout(() => {
                setIsCodeBlockToolbarExiting(true);
                setTimeout(() => {
                  setHoveredCodeBlock(null);
                  setIsCodeBlockToolbarExiting(false);
                }, 150);
              }, 100);
            }}
          />
          </ToolbarErrorBoundary>
        )}

        {/* Table popout dialog — portaled into containerRef so annotations */}
        {/* can walk into its text nodes the same way they do the inline table. */}
        {popoutTable && (
          <TablePopout
            block={popoutTable}
            open={!!popoutTable}
            onClose={() => setPopoutTable(null)}
            container={containerRef.current}
            imageBaseDir={imageBaseDir}
            onImageClick={(src, alt) => setLightbox({ src, alt })}
            onOpenLinkedDoc={onOpenLinkedDoc}
            onOpenCodeFile={onOpenCodeFile}
            githubRepo={repoInfo?.display}
            onNavigateAnchor={scrollToAnchor}
          />
        )}

        {/* Pinpoint hover overlay */}
        {inputMethod === 'pinpoint' && (
          <PinpointOverlay target={hoverTarget} containerRef={containerRef} />
        )}

        {/* Comment popover — hook handles text selection, Viewer handles global + code block */}
        {hookCommentPopover && (
          <CommentPopover
            anchorEl={hookCommentPopover.anchorEl}
            contextText={hookCommentPopover.contextText}
            isGlobal={false}
            initialText={hookCommentPopover.initialText}
            onSubmit={hookCommentSubmit}
            onClose={hookCommentClose}
          />
        )}
        {viewerCommentPopover && (
          <CommentPopover
            anchorEl={viewerCommentPopover.anchorEl}
            contextText={viewerCommentPopover.contextText}
            isGlobal={viewerCommentPopover.isGlobal}
            initialText={viewerCommentPopover.initialText}
            onSubmit={handleViewerCommentSubmit}
            onClose={handleViewerCommentClose}
          />
        )}

        {/* Quick Label floating picker — hook handles text selection, Viewer handles code blocks */}
        {hookQuickLabelPicker && (
          <FloatingQuickLabelPicker
            anchorEl={hookQuickLabelPicker.anchorEl}
            cursorHint={hookQuickLabelPicker.cursorHint}
            onSelect={hookFloatingQuickLabel}
            onDismiss={hookQuickLabelPickerDismiss}
          />
        )}
        {codeBlockQuickLabelPicker && (
          <FloatingQuickLabelPicker
            anchorEl={codeBlockQuickLabelPicker.anchorEl}
            onSelect={(label: QuickLabel) => {
              const codeEl = codeBlockQuickLabelPicker.codeBlock.element.querySelector('code');
              if (codeEl) {
                applyCodeBlockAnnotation(
                  codeBlockQuickLabelPicker.codeBlock.block.id, codeEl, AnnotationType.COMMENT,
                  `${label.emoji} ${label.text}`, undefined, true, label.tip
                );
              }
              setCodeBlockQuickLabelPicker(null);
              window.getSelection()?.removeAllRanges();
            }}
            onDismiss={() => {
              setCodeBlockQuickLabelPicker(null);
              window.getSelection()?.removeAllRanges();
            }}
          />
        )}
      </article>

      {/* Image lightbox */}
      {lightbox && createPortal(
        <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />,
        document.body
      )}
    </div>
    </CodePathValidationContext.Provider>
  );
});

/** Simple lightbox overlay for enlarged image viewing. */
const ImageLightbox: React.FC<{ src: string; alt: string; onClose: () => void }> = ({ src, alt, onClose }) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm cursor-zoom-out"
      onClick={onClose}
    >
      <img
        src={src}
        alt={alt}
        className="max-w-[90vw] max-h-[85vh] object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
      {alt && (
        <div className="mt-3 text-sm text-white/70 max-w-[90vw] text-center truncate">{alt}</div>
      )}
    </div>
  );
};





/** Groups consecutive list-item blocks so they can share a pinpoint hover wrapper. */
type RenderGroup =
  | { type: 'single'; block: Block }
  | { type: 'list-group'; blocks: Block[]; key: string };

function groupBlocks(blocks: Block[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  let i = 0;
  while (i < blocks.length) {
    if (blocks[i].type === 'list-item') {
      const listBlocks: Block[] = [];
      while (i < blocks.length && blocks[i].type === 'list-item') {
        listBlocks.push(blocks[i]);
        i++;
      }
      groups.push({ type: 'list-group', blocks: listBlocks, key: `list-${listBlocks[0].id}` });
    } else {
      groups.push({ type: 'single', block: blocks[i] });
      i++;
    }
  }
  return groups;
}


