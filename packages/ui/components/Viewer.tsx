import React, { useRef, useState, useEffect, forwardRef, useImperativeHandle, useCallback } from 'react';
import { createPortal } from 'react-dom';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { Block, Annotation, AnnotationType, EditorMode, type InputMethod, type ImageAttachment } from '../types';
import { Frontmatter } from '../utils/parser';
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
import { PlanDiffBadge } from './plan-diff/PlanDiffBadge';
import { PinpointOverlay } from './PinpointOverlay';
import { usePinpoint } from '../hooks/usePinpoint';
import { useAnnotationHighlighter } from '../hooks/useAnnotationHighlighter';

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
  repoInfo?: { display: string; branch?: string } | null;
  stickyActions?: boolean;
  onOpenLinkedDoc?: (path: string) => void;
  imageBaseDir?: string;
  linkedDocInfo?: { filepath: string; onBack: () => void; label?: string } | null;
  // Plan diff props
  planDiffStats?: { additions: number; deletions: number; modifications: number } | null;
  isPlanDiffActive?: boolean;
  onPlanDiffToggle?: () => void;
  hasPreviousVersion?: boolean;
  /** Show amber "Demo" badge (portal mode, no shared content loaded) */
  showDemoBadge?: boolean;
  /** Max width in px for the plan card (from plan width setting) */
  maxWidth?: number;
  /** Label for the copy button (default: "Copy plan") */
  copyLabel?: string;
  archiveInfo?: { status: 'approved' | 'denied' | 'unknown'; timestamp: string; title: string } | null;
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
  linkedDocInfo,
  imageBaseDir,
  copyLabel,
  archiveInfo,
  onToggleCheckbox,
  checkboxOverrides,
}, ref) => {
  const [copied, setCopied] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
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
  const [hoveredCodeBlock, setHoveredCodeBlock] = useState<{ block: Block; element: HTMLElement } | null>(null);
  const [isCodeBlockToolbarExiting, setIsCodeBlockToolbarExiting] = useState(false);
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

  // Detect when sticky action bar is "stuck" to show card background
  useEffect(() => {
    if (!stickyActions || !stickySentinelRef.current) return;
    const scrollContainer = document.querySelector('main');
    const observer = new IntersectionObserver(
      ([entry]) => setIsStuck(!entry.isIntersecting),
      { root: scrollContainer, threshold: 0 }
    );
    observer.observe(stickySentinelRef.current);
    return () => observer.disconnect();
  }, [stickyActions]);

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

  return (
    <div className="relative z-50 w-full" style={maxWidth ? { maxWidth } : { maxWidth: 832 }}>
      {taterMode && <TaterSpriteSitting />}
      <article
        ref={containerRef}
        data-print-region="article"
        className={`w-full bg-card rounded-xl shadow-xl p-5 md:p-8 lg:p-10 xl:p-12 relative ${
          linkedDocInfo ? 'border border-primary/40' : 'border border-border/50'
        } ${inputMethod === 'pinpoint' ? 'cursor-crosshair' : ''}`}
        style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
      >
        {/* Repo info + plan diff badge + demo badge + linked doc badge + archive badge - top left */}
        {(repoInfo || hasPreviousVersion || showDemoBadge || linkedDocInfo || archiveInfo) && (
          <div data-print-hide className="absolute top-3 left-3 md:top-4 md:left-5 flex flex-col items-start gap-1 text-[9px] text-muted-foreground/50 font-mono">
            {repoInfo && !linkedDocInfo && (
              <div className="flex items-center gap-1.5">
                <span className="px-1.5 py-0.5 bg-muted/50 rounded truncate max-w-[140px]" title={repoInfo.display}>
                  {repoInfo.display}
                </span>
                {repoInfo.branch && (
                  <span className="px-1.5 py-0.5 bg-muted/30 rounded max-w-[120px] flex items-center gap-1 overflow-hidden" title={repoInfo.branch}>
                    <svg className="w-2.5 h-2.5 flex-shrink-0" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
                    </svg>
                    <span className="truncate">{repoInfo.branch}</span>
                  </span>
                )}
              </div>
            )}
            {onPlanDiffToggle && !linkedDocInfo && (
              <PlanDiffBadge
                stats={planDiffStats ?? null}
                isActive={isPlanDiffActive ?? false}
                onToggle={onPlanDiffToggle}
                hasPreviousVersion={hasPreviousVersion ?? false}
              />
            )}
            {showDemoBadge && !linkedDocInfo && (
              <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-amber-500/15 text-amber-600 dark:text-amber-400">
                Demo
              </span>
            )}
            {archiveInfo && !linkedDocInfo && (
              <div className="flex items-center gap-1.5">
                <span className={`px-1.5 py-0.5 rounded ${
                  archiveInfo.status === 'approved'
                    ? 'bg-green-500/15 text-green-600 dark:text-green-400'
                    : archiveInfo.status === 'denied'
                      ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                      : 'bg-muted/50 text-muted-foreground'
                }`}>
                  {archiveInfo.status === 'approved' ? 'Approved' : archiveInfo.status === 'denied' ? 'Denied' : 'Unknown'}
                </span>
                {archiveInfo.timestamp && (
                  <span className="px-1.5 py-0.5 bg-muted/50 rounded" title={archiveInfo.timestamp}>
                    {new Date(archiveInfo.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    {' '}
                    {new Date(archiveInfo.timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                  </span>
                )}
              </div>
            )}
            {linkedDocInfo && (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={linkedDocInfo.onBack}
                  className="px-1.5 py-0.5 bg-primary/10 text-primary rounded hover:bg-primary/20 transition-colors flex items-center gap-1"
                >
                  <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
                  </svg>
                  plan
                </button>
                <span className="px-1.5 py-0.5 bg-primary/10 text-primary/80 rounded">
                  {linkedDocInfo.label || 'Linked File'}
                </span>
                <span
                  className="px-1.5 py-0.5 bg-muted/50 text-muted-foreground rounded truncate max-w-[200px]"
                  title={linkedDocInfo.filepath}
                >
                  {linkedDocInfo.filepath.split('/').pop()}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Sentinel for sticky detection */}
        {stickyActions && <div ref={stickySentinelRef} className="h-0 w-0 float-right" aria-hidden="true" />}

        {/* Header buttons - top right */}
        <div data-print-hide className={`${stickyActions ? 'sticky top-3' : ''} z-30 float-right flex items-start gap-1 md:gap-2 rounded-lg p-1 md:p-2 transition-colors duration-150 ${isStuck ? 'bg-card/95 backdrop-blur-sm shadow-sm' : ''} -mr-3 mt-6 md:-mr-5 md:-mt-5 lg:-mr-7 lg:-mt-7 xl:-mr-9 xl:-mt-9`}>
          {/* Attachments button */}
          {onAddGlobalAttachment && onRemoveGlobalAttachment && (
            <AttachmentsButton
              images={globalAttachments}
              onAdd={onAddGlobalAttachment}
              onRemove={onRemoveGlobalAttachment}
              variant="toolbar"
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
            <span className="md:hidden">Comment</span><span className="hidden md:inline">Global comment</span>
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
                <span className="md:hidden">Copy</span><span className="hidden md:inline">{copyLabel || (linkedDocInfo ? 'Copy file' : 'Copy plan')}</span>
              </>
            )}
          </button>
        </div>
        {frontmatter && <><div className="clear-right md:hidden" /><FrontmatterCard frontmatter={frontmatter} /></>}
        {!frontmatter && blocks.length > 0 && blocks[0].type !== 'heading' && <div className="mt-4" />}
        {groupBlocks(blocks).map(group =>
          group.type === 'list-group' ? (
            <div key={group.key} data-pinpoint-group="list" className="py-1 -mx-2 px-2">
              {group.blocks.map(block => (
                <BlockRenderer imageBaseDir={imageBaseDir} onImageClick={(src, alt) => setLightbox({ src, alt })} key={block.id} block={block} onOpenLinkedDoc={onOpenLinkedDoc} onToggleCheckbox={onToggleCheckbox} checkboxOverrides={checkboxOverrides} />
              ))}
            </div>
          ) : group.block.type === 'code' && isMermaidLanguage(group.block.language) ? (
            <MermaidBlock key={group.block.id} block={group.block} />
          ) : group.block.type === 'code' && isGraphvizLanguage(group.block.language) ? (
            <GraphvizBlock key={group.block.id} block={group.block} />
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
            <BlockRenderer imageBaseDir={imageBaseDir} onImageClick={(src, alt) => setLightbox({ src, alt })} key={group.block.id} block={group.block} onOpenLinkedDoc={onOpenLinkedDoc} onToggleCheckbox={onToggleCheckbox} checkboxOverrides={checkboxOverrides} />
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

/**
 * Renders inline markdown: **bold**, *italic*, `code`, [links](url)
 */
const InlineMarkdown: React.FC<{ text: string; onOpenLinkedDoc?: (path: string) => void; imageBaseDir?: string; onImageClick?: (src: string, alt: string) => void }> = ({ text, onOpenLinkedDoc, imageBaseDir, onImageClick }) => {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold: **text**
    let match = remaining.match(/^\*\*(.+?)\*\*/);
    if (match) {
      parts.push(<strong key={key++} className="font-semibold"><InlineMarkdown imageBaseDir={imageBaseDir} onImageClick={onImageClick} text={match[1]} onOpenLinkedDoc={onOpenLinkedDoc} /></strong>);
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Italic: *text*
    match = remaining.match(/^\*(.+?)\*/);
    if (match) {
      parts.push(<em key={key++}><InlineMarkdown imageBaseDir={imageBaseDir} onImageClick={onImageClick} text={match[1]} onOpenLinkedDoc={onOpenLinkedDoc} /></em>);
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Inline code: `code`
    match = remaining.match(/^`([^`]+)`/);
    if (match) {
      parts.push(
        <code key={key++} className="px-1.5 py-0.5 rounded bg-muted text-sm font-mono">
          {match[1]}
        </code>
      );
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Wikilinks: [[filename]] or [[filename|display text]]
    match = remaining.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
    if (match) {
      const target = match[1].trim();
      const display = match[2]?.trim() || target;
      const targetPath = /\.mdx?$/i.test(target) ? target : `${target}.md`;

      if (onOpenLinkedDoc) {
        parts.push(
          <a
            key={key++}
            href={targetPath}
            onClick={(e) => {
              e.preventDefault();
              onOpenLinkedDoc(targetPath);
            }}
            className="text-primary underline underline-offset-2 hover:text-primary/80 inline-flex items-center gap-1 cursor-pointer"
            title={`Open: ${target}`}
          >
            {display}
            <svg className="w-3 h-3 opacity-50 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
          </a>
        );
      } else {
        parts.push(
          <span key={key++} className="text-primary">{display}</span>
        );
      }
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Images: ![alt](path)
    match = remaining.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (match) {
      const alt = match[1];
      const src = match[2];
      const imgSrc = /^https?:\/\//.test(src) ? src : getImageSrc(src, imageBaseDir);
      parts.push(
        <img
          key={key++}
          src={imgSrc}
          alt={alt}
          className="max-w-full rounded my-2 cursor-zoom-in"
          loading="lazy"
          onClick={(e) => { e.stopPropagation(); onImageClick?.(imgSrc, alt); }}
        />
      );
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Links: [text](url)
    match = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (match) {
      const linkText = match[1];
      const linkUrl = match[2];
      const isLocalMd = /\.md(x?)$/i.test(linkUrl) &&
        !linkUrl.startsWith('http://') &&
        !linkUrl.startsWith('https://');

      if (isLocalMd && onOpenLinkedDoc) {
        parts.push(
          <a
            key={key++}
            href={linkUrl}
            onClick={(e) => {
              e.preventDefault();
              onOpenLinkedDoc(linkUrl);
            }}
            className="text-primary underline underline-offset-2 hover:text-primary/80 inline-flex items-center gap-1 cursor-pointer"
            title={`Open: ${linkUrl}`}
          >
            {linkText}
            <svg className="w-3 h-3 opacity-50 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
          </a>
        );
      } else if (isLocalMd) {
        // No handler — render as plain link (e.g., in shared/portal views)
        parts.push(
          <a
            key={key++}
            href={linkUrl}
            className="text-primary underline underline-offset-2 hover:text-primary/80"
          >
            {linkText}
          </a>
        );
      } else {
        parts.push(
          <a
            key={key++}
            href={linkUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 hover:text-primary/80"
          >
            {linkText}
          </a>
        );
      }
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Find next special character or consume one regular character
    const nextSpecial = remaining.slice(1).search(/[\*`\[!]/);
    if (nextSpecial === -1) {
      parts.push(remaining);
      break;
    } else {
      parts.push(remaining.slice(0, nextSpecial + 1));
      remaining = remaining.slice(nextSpecial + 1);
    }
  }

  return <>{parts}</>;
};

const parseTableContent = (content: string): { headers: string[]; rows: string[][] } => {
  const lines = content.split('\n').filter(line => line.trim());
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseRow = (line: string): string[] => {
    // Remove leading/trailing pipes, split by unescaped |, then unescape \|
    return line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/(?<!\\)\|/)
      .map(cell => cell.trim().replace(/\\\|/g, '|'));
  };

  const headers = parseRow(lines[0]);
  const rows: string[][] = [];

  // Skip the separator line (contains dashes) and parse data rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    // Skip separator lines (contain only dashes, pipes, colons, spaces)
    if (/^[\|\-:\s]+$/.test(line)) continue;
    rows.push(parseRow(line));
  }

  return { headers, rows };
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

const BlockRenderer: React.FC<{
  block: Block;
  onOpenLinkedDoc?: (path: string) => void;
  imageBaseDir?: string;
  onImageClick?: (src: string, alt: string) => void;
  onToggleCheckbox?: (blockId: string, checked: boolean) => void;
  checkboxOverrides?: Map<string, boolean>;
}> = ({ block, onOpenLinkedDoc, imageBaseDir, onImageClick, onToggleCheckbox, checkboxOverrides }) => {
  switch (block.type) {
    case 'heading':
      const Tag = `h${block.level || 1}` as keyof JSX.IntrinsicElements;
      const styles = {
        1: 'text-2xl font-bold mb-4 mt-6 first:mt-0 tracking-tight',
        2: 'text-xl font-semibold mb-3 mt-8 text-foreground/90',
        3: 'text-base font-semibold mb-2 mt-6 text-foreground/80',
      }[block.level || 1] || 'text-base font-semibold mb-2 mt-4';

      return <Tag className={styles} data-block-id={block.id} data-block-type="heading"><InlineMarkdown imageBaseDir={imageBaseDir} onImageClick={onImageClick} text={block.content} onOpenLinkedDoc={onOpenLinkedDoc} /></Tag>;

    case 'blockquote':
      return (
        <blockquote
          className="border-l-2 border-primary/50 pl-4 my-4 text-muted-foreground italic"
          data-block-id={block.id}
        >
          <InlineMarkdown imageBaseDir={imageBaseDir} onImageClick={onImageClick} text={block.content} onOpenLinkedDoc={onOpenLinkedDoc} />
        </blockquote>
      );

    case 'list-item': {
      const indent = (block.level || 0) * 1.25; // 1.25rem per level
      const isCheckbox = block.checked !== undefined;
      const isChecked = checkboxOverrides?.has(block.id)
        ? checkboxOverrides.get(block.id)!
        : block.checked;
      const isInteractive = isCheckbox && !!onToggleCheckbox;
      return (
        <div
          className="flex gap-3 my-1.5"
          data-block-id={block.id}
          style={{ marginLeft: `${indent}rem` }}
        >
          <span
            className={`select-none shrink-0 flex items-center${isInteractive ? ' cursor-pointer' : ''}`}
            onClick={isInteractive ? (e) => { e.stopPropagation(); onToggleCheckbox!(block.id, !isChecked); } : undefined}
            role={isInteractive ? 'checkbox' : undefined}
            aria-checked={isInteractive ? isChecked : undefined}
          >
            {isCheckbox ? (
              isChecked ? (
                <svg className="w-4 h-4 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ) : (
                <svg className={`w-4 h-4 text-muted-foreground/50${isInteractive ? ' hover:text-muted-foreground transition-colors' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <circle cx="12" cy="12" r="9" />
                </svg>
              )
            ) : (
              <span className="text-primary/60">
                {(block.level || 0) === 0 ? '•' : (block.level || 0) === 1 ? '◦' : '▪'}
              </span>
            )}
          </span>
          <span className={`text-sm leading-relaxed ${isCheckbox && isChecked ? 'text-muted-foreground line-through' : 'text-foreground/90'}`}>
            <InlineMarkdown imageBaseDir={imageBaseDir} onImageClick={onImageClick} text={block.content} onOpenLinkedDoc={onOpenLinkedDoc} />
          </span>
        </div>
      );
    }

    case 'code':
      return <CodeBlock block={block} onHover={() => {}} onLeave={() => {}} isHovered={false} />;

    case 'table': {
      const { headers, rows } = parseTableContent(block.content);
      return (
        <div className="my-4 overflow-x-auto" data-block-id={block.id}>
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border">
                {headers.map((header, i) => (
                  <th
                    key={i}
                    className="px-3 py-2 text-left font-semibold text-foreground/90 bg-muted/30"
                  >
                    <InlineMarkdown imageBaseDir={imageBaseDir} onImageClick={onImageClick} text={header} onOpenLinkedDoc={onOpenLinkedDoc} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIdx) => (
                <tr key={rowIdx} className="border-b border-border/50 hover:bg-muted/20">
                  {row.map((cell, cellIdx) => (
                    <td key={cellIdx} className="px-3 py-2 text-foreground/80">
                      <InlineMarkdown imageBaseDir={imageBaseDir} onImageClick={onImageClick} text={cell} onOpenLinkedDoc={onOpenLinkedDoc} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    case 'hr':
      return <hr className="border-border/30 my-8" data-block-id={block.id} />;

    default:
      return (
        <p
          className="mb-4 leading-relaxed text-foreground/90 text-[15px]"
          data-block-id={block.id}
        >
          <InlineMarkdown imageBaseDir={imageBaseDir} onImageClick={onImageClick} text={block.content} onOpenLinkedDoc={onOpenLinkedDoc} />
        </p>
      );
  }
};

interface CodeBlockProps {
  block: Block;
  onHover: (element: HTMLElement) => void;
  onLeave: () => void;
  isHovered: boolean;
}

const CodeBlock: React.FC<CodeBlockProps> = ({ block, onHover, onLeave, isHovered }) => {
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLElement>(null);

  // Highlight code block on mount and when content/language changes
  useEffect(() => {
    if (codeRef.current) {
      // Reset any previous highlighting
      codeRef.current.removeAttribute('data-highlighted');
      codeRef.current.className = `hljs font-mono${block.language ? ` language-${block.language}` : ''}`;
      hljs.highlightElement(codeRef.current);
    }
  }, [block.content, block.language]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(block.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [block.content]);

  const handleMouseEnter = () => {
    if (containerRef.current) {
      onHover(containerRef.current);
    }
  };

  // Build className for code element
  const codeClassName = `hljs font-mono${block.language ? ` language-${block.language}` : ''}`;

  return (
    <div
      ref={containerRef}
      className="relative group my-5"
      data-block-id={block.id}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={onLeave}
    >
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-muted/80 hover:bg-muted text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity z-10"
        title={copied ? 'Copied!' : 'Copy code'}
      >
        {copied ? (
          <svg className="w-4 h-4 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        )}
      </button>
      <pre className="rounded-lg text-[13px] overflow-x-auto bg-muted/50 border border-border/30">
        <code ref={codeRef} className={codeClassName}>{block.content}</code>
      </pre>
    </div>
  );
};
