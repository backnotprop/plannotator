import React, { useRef, useState, useEffect, useMemo, forwardRef, useImperativeHandle, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { AnnotationType, type Block, type Annotation, type EditorMode, type InputMethod, type ImageAttachment, type ActionsLabelMode } from '../types';
import { applyHighlight, codeBlockClassName, onCodeHighlightSwap } from '../utils/codeHighlight';
import { paintCodeBlockMark } from '../utils/codeBlockMark';
import { useFenceTheme } from '../hooks/useFenceTheme';
import { computeListIndices, groupBlocks, type Frontmatter } from '../utils/parser';
import { buildHeadingSlugMap } from '../utils/slugify';
import { copyTextToClipboard } from '../utils/clipboard';
import { BlockRenderer } from './BlockRenderer';
import { CodeBlock } from './blocks/CodeBlock';
import { TableBlock } from './blocks/TableBlock';
import { TableToolbar } from './blocks/TableToolbar';
import { TablePopout } from './blocks/TablePopout';
import { CodePathValidationContext } from './CodePathValidationContext';
import { useValidatedCodePaths } from '../hooks/useValidatedCodePaths';
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

import { CommentPopover, type CommentAskAIHandler } from './CommentPopover';
import { TaterSpriteSitting } from './TaterSpriteSitting';
import { AttachmentsButton } from './AttachmentsButton';
import { MessagesIcon } from './icons/MessagesIcon';
import { GraphvizBlock } from './GraphvizBlock';
import { MermaidBlock } from './MermaidBlock';
import { isGraphvizLanguage, isMermaidLanguage } from './diagramLanguages';
import { getIdentity } from '../utils/identity';
import { type QuickLabel } from '../utils/quickLabels';
import { DocBadges, type DocBadgesProps, type LinkedDocBadgeInfo } from './DocBadges';
import { PinpointOverlay } from './PinpointOverlay';
import { usePinpoint } from '../hooks/usePinpoint';
import { useAnnotationHighlighter } from '../hooks/useAnnotationHighlighter';
import { useVimSelection } from '../hooks/useVimSelection';
import {
  getScrollViewportIntersectionRoot,
  getScrollViewportRect,
  getScrollViewportTop,
  scrollViewportTo,
  useScrollViewport,
} from '../hooks/useScrollViewport';
import { decodeAnchorHash } from '../utils/anchors';
import { VimModeOverlay } from './VimModeOverlay';
import { AnnotationToolstrip } from './AnnotationToolstrip';
import {
  resolveCompactHeaderGeometry,
  snapCompactHeaderWidth,
} from './compactHeaderLayout';

/** Typed controls required for Viewer's opt-in, in-flow annotation header. */
export interface ViewerAnnotationHeaderConfig {
  /** Persist and apply a Select or Pinpoint input-method change. */
  readonly onInputMethodChange: (method: InputMethod) => void;
  /** Persist and apply an annotation-mode change. */
  readonly onModeChange: (mode: EditorMode) => void;
  /** Omit Quick Label without changing or coercing the current mode. */
  readonly hideQuickLabel?: boolean;
}

/** Public properties for the Markdown document Viewer. */
export interface ViewerProps {
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
  /**
   * Render compact annotation controls and the existing document actions in
   * one measured, in-flow header owned by Viewer. The header reserves its
   * responsive height before document content and follows `stickyActions`.
   * Omit this prop to retain the legacy floating action bar exactly. Read-only
   * viewers suppress the annotation header rather than expose dead controls.
   */
  annotationHeader?: ViewerAnnotationHeaderConfig;
  /** Render the plan as a floating card on a grid background (shadow/border/padding). Default false. */
  gridEnabled?: boolean;
  onOpenLinkedDoc?: (path: string) => void;
  onOpenCodeFile?: (path: string) => void;
  imageBaseDir?: string;
  /** Directory the active document lives in — used by the code-path validator
   *  so out-of-tree relative references (e.g. `../foo.ts` in a linked doc)
   *  resolve against the doc's own directory rather than only cwd. */
  codePathBaseDir?: string;
  /** Opt out of `/api/doc/exists` code-path validation (host without that
   *  endpoint). Default undefined for Plannotator => validation stays on. */
  disableCodePathValidation?: boolean;
  linkedDocInfo?: LinkedDocBadgeInfo | null;
  // Plan diff props
  planDiffStats?: { additions: number; deletions: number; modifications: number } | null;
  isPlanDiffActive?: boolean;
  onPlanDiffToggle?: () => void;
  hasPreviousVersion?: boolean;
  /** Baseline suffix + tooltip for the plan-diff badge (see DocBadges) —
   *  annotate/folder sessions pass "since last review"; plan review omits. */
  planDiffBaselineLabel?: string;
  planDiffBaselineTooltip?: string;
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
  /** Absolute path of the annotated source file for the Open-in-app control. */
  openInAppPath?: string | null;
  /**
   * Message picker affordance — annotate-last mode only. Shown as a button in
   * the sticky-top action bar so the user can switch to a different recent
   * assistant message. Clicking opens the full picker in the left sidebar's
   * Messages tab.
   */
  messagePickerInfo?: { current: number; total: number; onOpen: () => void };
  // Checkbox toggle props
  onToggleCheckbox?: (blockId: string, checked: boolean) => void;
  checkboxOverrides?: Map<string, boolean>;
  onAskAI?: CommentAskAIHandler;
  /** Whether comment popovers offer image attachments. Hosts without an
   *  uploadTransport pass false so the attach affordance never dead-ends.
   *  Default true — today's behavior. */
  allowImages?: boolean;
  /** View-only mode: suppresses every annotation-creation entry point
   *  (selection toolbar, comment popovers, quick labels, pinpoint, global
   *  comment, attachments, checkbox toggles). Existing annotations still
   *  render and remain selectable. Default false — today's behavior. */
  readOnly?: boolean;
  /** Opt-in Vim-style keyboard selection. Default false for compatibility. */
  vimModeEnabled?: boolean;
  /** Replace the compact Vim badge with the live video-style key HUD. */
  vimHudEnabled?: boolean;
  /** Show the bottom-right key panel without affecting the HUD reticle. */
  vimHudKeyPanelEnabled?: boolean;
  /** Persist a user request to hide the bottom-right key panel. */
  onVimHudKeyPanelChange?: (enabled: boolean) => void;
}

export interface ViewerHandle {
  removeHighlight: (id: string) => void;
  clearAllHighlights: () => void;
  applySharedAnnotations: (annotations: Annotation[]) => void;
}

interface CodeBlockToolbarTarget {
  readonly block: Block;
  readonly element: HTMLElement;
  readonly activation: 'pointer' | 'keyboard';
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

interface ViewerDocumentHeaderProps {
  readonly config: ViewerAnnotationHeaderConfig;
  readonly inputMethod: InputMethod;
  readonly mode: EditorMode;
  readonly taterMode: boolean;
  readonly sticky: boolean;
  readonly stuck: boolean;
  readonly sentinelRef: React.RefObject<HTMLDivElement | null>;
  readonly badges: Omit<DocBadgesProps, 'layout'>;
  readonly actions: React.ReactNode;
}

/** Viewer-owned header that keeps leading controls and trailing actions in one flow. */
const ViewerDocumentHeader: React.FC<ViewerDocumentHeaderProps> = ({
  config,
  inputMethod,
  mode,
  taterMode,
  sticky,
  stuck,
  sentinelRef,
  badges,
  actions,
}) => {
  const headerRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [headerWidth, setHeaderWidth] = useState(0);
  const [actionsWidth, setActionsWidth] = useState(0);

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = snapCompactHeaderWidth(entry.contentRect.width);
      setHeaderWidth((current) => current === next ? current : next);
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const actionCluster = actionsRef.current;
    if (!actionCluster) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = snapCompactHeaderWidth(entry.contentRect.width);
      setActionsWidth((current) => current === next ? current : next);
    });
    observer.observe(actionCluster);
    return () => observer.disconnect();
  }, []);

  const geometry = resolveCompactHeaderGeometry({
    containerWidth: headerWidth,
    trailingWidth: actionsWidth,
    leadingInset: 0,
  });
  const narrow = geometry.layout === 'narrow';
  const iconOnly = geometry.layout !== 'wide';

  return (
    <>
      {sticky && <div ref={sentinelRef} className="h-0 w-0" aria-hidden="true" />}
      <div
        ref={headerRef}
        data-annotation-exclude
        data-print-hide
        data-viewer-document-header
        data-header-layout={geometry.layout}
        className={`annotation-exclude ${sticky ? 'sticky top-3' : 'relative'} z-40 mb-3 md:mb-4 rounded-lg transition-colors duration-150 ${
          stuck ? 'bg-card/95 backdrop-blur-sm shadow-sm' : ''
        }`}
      >
        <div className={`flex min-w-0 ${
          narrow
            ? 'flex-col items-stretch gap-2'
            : 'flex-row items-start justify-between gap-4'
        }`}>
          <div
            data-viewer-annotation-controls
            className={`inline-flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-1 md:py-2 ${
              narrow ? 'w-full' : 'flex-1'
            }`}
          >
            <div className="flex-shrink-0">
              <AnnotationToolstrip
                inputMethod={inputMethod}
                onInputMethodChange={config.onInputMethodChange}
                mode={mode}
                onModeChange={config.onModeChange}
                taterMode={taterMode}
                hideQuickLabel={config.hideQuickLabel}
                compact
                iconOnly={iconOnly}
              />
            </div>
            <DocBadges layout="header" {...badges} />
          </div>
          <div
            ref={actionsRef}
            data-sticky-actions
            className={`flex flex-shrink-0 items-start gap-1 rounded-lg p-1 md:gap-2 md:p-2 ${
              narrow ? 'self-end' : ''
            }`}
          >
            {actions}
          </div>
        </div>
      </div>
    </>
  );
};

/**
 * Render and annotate a parsed Markdown document.
 *
 * Pointer and opt-in keyboard annotations share the same highlight callbacks;
 * the imperative handle mutates only highlights owned by this viewer.
 */
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
  annotationHeader,
  gridEnabled = false,
  planDiffStats,
  isPlanDiffActive,
  onPlanDiffToggle,
  hasPreviousVersion,
  planDiffBaselineLabel,
  planDiffBaselineTooltip,
  showDemoBadge,
  maxWidth,
  onOpenLinkedDoc,
  onOpenCodeFile,
  linkedDocInfo,
  imageBaseDir,
  codePathBaseDir,
  disableCodePathValidation,
  copyLabel,
  actionsLabelMode = 'full',
  archiveInfo,
  sourceInfo,
  openInAppPath,
  messagePickerInfo,
  onToggleCheckbox,
  checkboxOverrides,
  onAskAI,
  allowImages = true,
  readOnly = false,
  vimModeEnabled = false,
  vimHudEnabled = false,
  vimHudKeyPanelEnabled = true,
  onVimHudKeyPanelChange,
}, ref) => {
  const viewerAnnotationHeader = readOnly ? undefined : annotationHeader;
  const hasViewerAnnotationHeader = viewerAnnotationHeader !== undefined;
  const [copied, setCopied] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const [locationHash, setLocationHash] = useState(() => window.location.hash);
  const globalCommentButtonRef = useRef<HTMLButtonElement>(null);
  // Read through a ref: only the imperative removeHighlight path below needs
  // it, and CodeBlock re-highlights itself on palette change.
  const fenceTheme = useFenceTheme();
  const fenceThemeRef = useRef(fenceTheme);
  fenceThemeRef.current = fenceTheme;

  const handleCopyPlan = async () => {
    if (await copyTextToClipboard(markdown)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      console.error('Failed to copy');
    }
  };
  const containerRef = useRef<HTMLDivElement>(null);
  // The element that actually scrolls; shared by the Vim scroll math, the
  // sticky-header observer, and the reticle geometry.
  const scrollViewport = useScrollViewport();
  // The badge cluster (repo chips / diff badge) is absolutely positioned in the
  // card's top padding. One row fits; a second row (diff badge) or mobile
  // wrapping outgrows the padding and lands on the document's first heading.
  // Measure the cluster and insert exactly the clearance it needs (0 when it fits).
  const docBadgesRef = useRef<HTMLDivElement | null>(null);
  const [badgeClearance, setBadgeClearance] = useState(0);
  useEffect(() => {
    if (hasViewerAnnotationHeader) {
      setBadgeClearance(0);
      return;
    }
    const el = docBadgesRef.current;
    const article = containerRef.current;
    if (!el || !article) { setBadgeClearance(0); return; }
    const measure = () => {
      const pad = parseFloat(getComputedStyle(article).paddingTop) || 0;
      const overflow = el.offsetTop + el.offsetHeight - pad;
      setBadgeClearance(overflow > 1 ? overflow + 4 : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [hasViewerAnnotationHeader, repoInfo, hasPreviousVersion, showDemoBadge, linkedDocInfo, archiveInfo, sourceInfo, planDiffStats, openInAppPath]);

  // Per-doc heading slug map with dedup — computed once per blocks array so
  // anchor ids stay stable across re-renders and duplicate heading texts get
  // `-1`/`-2`/... suffixes rather than colliding on the same id.
  const headingSlugMap = useMemo(() => buildHeadingSlugMap(blocks), [blocks]);
  const isTouchDevice = useMemo(() => window.matchMedia('(pointer: coarse)').matches, []);
  const [codeBlockToolbar, setCodeBlockToolbar] =
    useState<CodeBlockToolbarTarget | null>(null);
  const [isCodeBlockToolbarExiting, setIsCodeBlockToolbarExiting] = useState(false);
  const [hoveredTable, setHoveredTable] = useState<{ block: Block; element: HTMLElement } | null>(null);
  const [isTableToolbarExiting, setIsTableToolbarExiting] = useState(false);
  const tableHoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [popoutTable, setPopoutTable] = useState<Block | null>(null);
  // Viewer-specific comment popover state (global comments + code blocks)
  const [viewerCommentPopover, setViewerCommentPopover] = useState<{
    anchorEl: HTMLElement;
    contextText: string;
    selectedText?: string;
    initialText?: string;
    isGlobal: boolean;
    codeBlock?: { block: Block; element: HTMLElement };
  } | null>(null);
  // Viewer-specific quick label state (code blocks)
  const [codeBlockQuickLabelPicker, setCodeBlockQuickLabelPicker] = useState<{
    anchorEl: HTMLElement;
    codeBlock: { block: Block; element: HTMLElement };
  } | null>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const stickySentinelRef = useRef<HTMLDivElement>(null);
  const lastAutoScrolledHashRef = useRef<string | null>(null);
  const [isStuck, setIsStuck] = useState(false);

  // Shared annotation infrastructure via hook
  const {
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
    highlightRange,
    highlightMathElement,
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
    enabled: !readOnly,
  });

  // Refs for code block annotation path
  const onAddAnnotationRef = useRef(onAddAnnotation);
  useEffect(() => { onAddAnnotationRef.current = onAddAnnotation; }, [onAddAnnotation]);
  const modeRef = useRef<EditorMode>(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  const applyCodeBlockAnnotation = useCallback((
    blockId: string,
    codeEl: Element,
    type: AnnotationType,
    text?: string,
    images?: ImageAttachment[],
    isQuickLabel?: boolean,
    quickLabelTip?: string,
  ) => {
    if (readOnlyRef.current) return;

    const id = `codeblock-${Date.now()}`;
    const codeText = codeEl.textContent || '';

    paintCodeBlockMark(codeEl, id, type);

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
  }, []);

  // Live annotation list for the imperative DOM paths below, which run outside
  // React's render (highlight swaps, the imperative handle).
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;

  // `removeHighlight` runs BEFORE the host drops the annotation from state and
  // re-highlights the block on the way out, so for one tick `annotationsRef`
  // still lists an annotation whose mark is deliberately gone. Remember those
  // ids so the swap listener below never paints a removed annotation back in,
  // whichever tick that block's re-highlight lands in.
  const removedAnnotationIdsRef = useRef<Set<string>>(new Set());
  // Retire a tombstone as soon as the host's list agrees the annotation is
  // gone: the window it guards is only the tick between removeHighlight and
  // the state update, and keeping it would block a later restore that brings
  // the same annotation (same id) back from a draft.
  for (const id of removedAnnotationIdsRef.current) {
    if (!annotations.some((a) => a.id === id)) removedAnnotationIdsRef.current.delete(id);
  }

  // A highlight swap replaces a `<code>` element's children — that is how the
  // palette/mode change repaints tokens, and how the first async grammar
  // attach lands after load. It also destroys any annotation mark inside the
  // fence. Re-paint it here, SYNCHRONOUSLY after the write, so the block ends
  // up with both the new theme's tokens and its mark.
  //
  // Being driven by the swap is also what makes the restore race safe without
  // timing: a share/draft restore that painted before the swap is
  // re-established in the same task the swap ran in, and one that runs after
  // it finds the mark already present and leaves it alone.
  useEffect(() => onCodeHighlightSwap((codeEl) => {
    const container = containerRef.current;
    if (!container || !container.contains(codeEl)) return;
    // The swap always clears the element, so a surviving mark means this write
    // was not the one that owns this block's contents.
    if (codeEl.querySelector('[data-bind-id]')) return;

    const codeText = codeEl.textContent ?? '';
    if (!codeText) return;
    const blockId = codeEl.closest('[data-block-id]')?.getAttribute('data-block-id') ?? '';

    // Fenced code is annotated all-or-nothing, so this block's annotations are
    // exactly the ones whose originalText is its full text. Share-restored
    // annotations arrive with an empty blockId (it is filled in during restore),
    // so an unset blockId still counts. The last one wins, matching what
    // annotating the same block twice does.
    const owner = annotationsRef.current.filter((a) =>
      a.type !== AnnotationType.GLOBAL_COMMENT
      && !a.diffContext
      && a.originalText === codeText
      && (a.blockId === blockId || !a.blockId)
      && !removedAnnotationIdsRef.current.has(a.id)
      && !container.querySelector(`[data-bind-id="${a.id}"], [data-highlight-id="${a.id}"]`)
    ).at(-1);

    if (owner) paintCodeBlockMark(codeEl, owner.id, owner.type);
  }), []);

  // Pinpoint mode: hover + click to select elements
  const handlePinpointCodeBlockClick = useCallback((blockId: string, element: HTMLElement) => {
    if (readOnlyRef.current) return;

    const block = blocks.find((candidate) => candidate.id === blockId);
    const codeEl = element.querySelector('code');
    if (!block || !codeEl) return;
    // In pinpoint mode, apply code block annotation based on current editor mode
    if (modeRef.current === 'redline') {
      applyCodeBlockAnnotation(blockId, codeEl, AnnotationType.DELETION);
    } else if (modeRef.current === 'quickLabel') {
      setCodeBlockQuickLabelPicker({
        anchorEl: element,
        codeBlock: { block, element },
      });
    } else {
      // Show comment popover anchored to the code block
      setViewerCommentPopover({
        anchorEl: element,
        contextText: (codeEl.textContent || '').slice(0, 80),
        selectedText: codeEl.textContent || '',
        isGlobal: false,
        codeBlock: { block, element },
      });
    }
  }, [applyCodeBlockAnnotation, blocks]);

  const handleKeyboardCodeBlockAction = useCallback((
    blockId: string,
    element: HTMLElement,
    modeOverride?: EditorMode,
  ) => {
    if (readOnlyRef.current) return;

    const block = blocks.find((candidate) => candidate.id === blockId);
    const codeEl = element.querySelector('code');
    if (!block || !codeEl) return;

    const effectiveMode = modeOverride ?? modeRef.current;
    if (effectiveMode === 'redline') {
      applyCodeBlockAnnotation(blockId, codeEl, AnnotationType.DELETION);
      return;
    }
    if (effectiveMode === 'quickLabel') {
      setCodeBlockQuickLabelPicker({
        anchorEl: element,
        codeBlock: { block, element },
      });
      return;
    }
    if (effectiveMode === 'selection') {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
        hoverTimeoutRef.current = null;
      }
      setCodeBlockToolbar({ block, element, activation: 'keyboard' });
      return;
    }
    setViewerCommentPopover({
      anchorEl: element,
      contextText: (codeEl.textContent || '').slice(0, 80),
      selectedText: codeEl.textContent || '',
      isGlobal: false,
      codeBlock: { block, element },
    });
  }, [applyCodeBlockAnnotation, blocks]);

  const vimModeActive = vimModeEnabled && !readOnly;
  const keyboardCodeBlockToolbarOpen = codeBlockToolbar?.activation === 'keyboard';
  const vimBlocked = !!toolbarState
    || !!hookCommentPopover
    || !!viewerCommentPopover
    || !!hookQuickLabelPicker
    || !!codeBlockQuickLabelPicker
    || keyboardCodeBlockToolbarOpen
    || !!isPlanDiffActive
    || !!popoutTable
    || !!lightbox;
  const clearPinpointHoverRef = useRef<() => void>(() => {});
  const handleVimCommand = useCallback(() => {
    clearPinpointHoverRef.current();
  }, []);
  const vim = useVimSelection({
    containerRef,
    scrollViewport,
    enabled: vimModeActive,
    hudEnabled: vimHudEnabled,
    blocked: vimBlocked,
    activeMode: mode,
    contentVersion: blocks,
    onHighlightRange: highlightRange,
    onCodeBlockAction: handleKeyboardCodeBlockAction,
    onMathAction: highlightMathElement,
    onHandledCommand: handleVimCommand,
  });

  const { hoverTarget, clearHover: clearPinpointHover } = usePinpoint({
    containerRef,
    inputMethod,
    enabled: !readOnly && !toolbarState && !hookCommentPopover && !viewerCommentPopover && !hookQuickLabelPicker && !codeBlockQuickLabelPicker && !(isPlanDiffActive ?? false) && !vim.helpOpen,
    onSelectRange: highlightRange,
    onCodeBlockClick: handlePinpointCodeBlockClick,
  });
  clearPinpointHoverRef.current = clearPinpointHover;
  const vimOwnsHudTarget = vimHudEnabled
    && vim.state.phase !== 'inactive'
    && (vim.focused || vim.state.phase === 'action');
  const vimOwnsDocumentNavigation = vimModeActive
    && vim.focused
    && vim.state.phase !== 'inactive'
    && vim.state.phase !== 'action';
  const legacyVimTarget = !vimHudEnabled
    && (vim.focused || vim.state.phase === 'action')
    ? vim.activeTarget
    : null;
  const pinpointOverlayTarget = vimOwnsHudTarget
    ? null
    : (inputMethod === 'pinpoint' ? hoverTarget : null) ?? legacyVimTarget;

  useEffect(() => {
    if (!readOnly) return;
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setCodeBlockToolbar(null);
    setIsCodeBlockToolbarExiting(false);
    setViewerCommentPopover(null);
    setCodeBlockQuickLabelPicker(null);
  }, [readOnly]);

  useEffect(() => {
    if (!vimOwnsDocumentNavigation) return;
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setCodeBlockToolbar((current) => (
      current?.activation === 'pointer' ? null : current
    ));
    setIsCodeBlockToolbarExiting(false);
  }, [vimOwnsDocumentNavigation]);

  // Suppress native context menu on touch devices (prevents cut/copy/paste overlay on mobile)
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isTouchDevice) return;

    const handleContextMenu = (e: Event) => {
      e.preventDefault();
    };

    container.addEventListener('contextmenu', handleContextMenu);
    return () => container.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  // Detect when sticky action bar is "stuck" to show card background.
  // The IntersectionObserver root must be the actual scroll element — the
  // OverlayScrollArea viewport — not the <main> host, which doesn't scroll.
  useEffect(() => {
    if (!stickyActions) {
      setIsStuck(false);
      return;
    }
    if (!stickySentinelRef.current || !scrollViewport) return;
    const observer = new IntersectionObserver(
      ([entry]) => setIsStuck(!entry.isIntersecting),
      { root: getScrollViewportIntersectionRoot(scrollViewport), threshold: 0 }
    );
    observer.observe(stickySentinelRef.current);
    return () => observer.disconnect();
  }, [hasViewerAnnotationHeader, stickyActions, scrollViewport]);

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
    if (!container || !scrollViewport) return false;

    const target = document.getElementById(anchor);
    if (!target || !container.contains(target)) return false;

    const documentHeader = stickyActions
      ? container.querySelector<HTMLElement>('[data-viewer-document-header]')
        ?? container.querySelector<HTMLElement>('[data-sticky-actions]')
      : null;
    const stickyTop = documentHeader
      ? Number.parseFloat(window.getComputedStyle(documentHeader).top || '0') || 0
      : 0;
    const headerOffset = documentHeader
      ? documentHeader.getBoundingClientRect().height + stickyTop
      : 0;
    const containerRect = getScrollViewportRect(scrollViewport);
    const targetRect = target.getBoundingClientRect();
    const relativeTop = targetRect.top - containerRect.top;
    const offsetPosition = getScrollViewportTop(scrollViewport) + relativeTop - headerOffset;

    scrollViewportTo(scrollViewport, {
      top: Math.max(0, offsetPosition),
      behavior: 'smooth',
    });
    return true;
  }, [scrollViewport, stickyActions]);

  useEffect(() => {
    if (!scrollViewport || !locationHash || lastAutoScrolledHashRef.current === locationHash) return;
    const timer = window.setTimeout(() => {
      if (scrollToAnchor(locationHash)) {
        lastAutoScrolledHashRef.current = locationHash;
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [blocks, locationHash, scrollToAnchor, scrollViewport]);

  // Use the native copy event so clipboard writes are synchronous (Safari
  // rejects the async navigator.clipboard API outside the user-gesture window).
  // web-highlighter clears the DOM selection on mouseup, so the browser has
  // nothing to copy by the time Cmd+C fires — we inject the captured text here.
  useEffect(() => {
    const handleCopy = (e: ClipboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (toolbarState?.selectionText) {
        e.preventDefault();
        e.clipboardData?.setData('text/plain', toolbarState.selectionText);
      }
    };

    document.addEventListener('copy', handleCopy);
    return () => document.removeEventListener('copy', handleCopy);
  }, [toolbarState]);

  // Imperative handle — delegates to hook, extends removeHighlight for code blocks
  useImperativeHandle(ref, () => ({
    removeHighlight: (id: string) => {
      // The re-highlight below notifies the swap listener, which would happily
      // paint this annotation's mark straight back in — the host has not
      // dropped it from state yet. Tombstone the id first.
      removedAnnotationIdsRef.current.add(id);
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
          codeEl.className = codeBlockClassName(block?.language);
          // Language-less fences stay plain (#1212) — applyHighlight never guesses.
          applyHighlight(codeEl, plainText, block?.language, fenceThemeRef.current);
        }
      });

      hookRemoveHighlight(id);
    },
    clearAllHighlights,
    applySharedAnnotations: applyAnnotations,
  }), [hookRemoveHighlight, clearAllHighlights, applyAnnotations, blocks]);

  // --- Viewer-specific: code block annotation ---

  const handleCodeBlockAnnotate = (type: AnnotationType) => {
    if (readOnlyRef.current || !codeBlockToolbar) return;
    const codeEl = codeBlockToolbar.element.querySelector('code');
    if (!codeEl) return;
    applyCodeBlockAnnotation(codeBlockToolbar.block.id, codeEl, type);
    setCodeBlockToolbar(null);
  };

  const handleCodeBlockQuickLabel = (label: QuickLabel) => {
    if (readOnlyRef.current || !codeBlockToolbar) return;
    const codeEl = codeBlockToolbar.element.querySelector('code');
    if (!codeEl) return;
    applyCodeBlockAnnotation(
      codeBlockToolbar.block.id, codeEl, AnnotationType.COMMENT,
      `${label.emoji} ${label.text}`, undefined, true, label.tip
    );
    setCodeBlockToolbar(null);
  };

  const handleCodeBlockToolbarClose = () => {
    setCodeBlockToolbar(null);
  };

  // Viewer-specific comment popover handlers (code blocks + global comments)

  const handleCodeBlockRequestComment = (initialChar?: string) => {
    if (readOnlyRef.current || !codeBlockToolbar) return;
    const codeText = codeBlockToolbar.element.querySelector('code')?.textContent || '';
    setViewerCommentPopover({
      anchorEl: codeBlockToolbar.element,
      contextText: codeText.slice(0, 80),
      selectedText: codeText,
      initialText: initialChar,
      isGlobal: false,
      codeBlock: codeBlockToolbar,
    });
    setCodeBlockToolbar(null);
  };

  const handleViewerCommentSubmit = (text: string, images?: ImageAttachment[]) => {
    if (readOnlyRef.current || !viewerCommentPopover) return;

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

  const commentDraftScope = linkedDocInfo?.filepath ?? sourceInfo ?? markdown.slice(0, 120);

  const codePathValidation = useValidatedCodePaths(markdown, codePathBaseDir, disableCodePathValidation);

  const documentActions = (
    <>
      {messagePickerInfo && (
        <button
          onClick={messagePickerInfo.onOpen}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-md transition-colors"
          title="Pick a different message to annotate"
        >
          <MessagesIcon />
          {actionsLabelMode === 'full' && (
            <span>Message {messagePickerInfo.current} of {messagePickerInfo.total}</span>
          )}
          {actionsLabelMode === 'short' && (
            <span>{messagePickerInfo.current}/{messagePickerInfo.total}</span>
          )}
        </button>
      )}

      {!readOnly && onAddGlobalAttachment && onRemoveGlobalAttachment && (
        <AttachmentsButton
          images={globalAttachments}
          onAdd={onAddGlobalAttachment}
          onRemove={onRemoveGlobalAttachment}
          variant="toolbar"
          hideLabel={actionsLabelMode === 'icon'}
        />
      )}

      {!readOnly && (
        <button
          ref={globalCommentButtonRef}
          onClick={() => {
            const anchorEl = globalCommentButtonRef.current;
            if (!anchorEl) return;
            setViewerCommentPopover({
              anchorEl,
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
      )}

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
    </>
  );

  return (
    <CodePathValidationContext.Provider value={codePathValidation}>
    <div className="relative z-50 w-full" style={maxWidth === null ? undefined : { maxWidth: maxWidth ?? 832 }}>
      {taterMode && <TaterSpriteSitting />}
      <article
        ref={containerRef}
        data-print-region="article"
        data-vim-mode={vimModeActive ? 'enabled' : undefined}
        data-vim-phase={vimModeActive ? vim.state.phase : undefined}
        data-vim-focused={vimModeActive ? String(vim.focused) : undefined}
        data-vim-blocked={vimModeActive ? String(vimBlocked) : undefined}
        data-vim-target-key={vimModeActive ? vim.activeTarget?.key : undefined}
        tabIndex={vimModeActive ? 0 : undefined}
        onFocus={vim.onFocus}
        onBlur={vim.onBlur}
        onMouseDown={vim.onMouseDown}
        className={`w-full bg-card rounded-xl py-5 md:py-8 lg:py-10 xl:py-12 relative ${gridEnabled ? 'px-5 md:px-8 lg:px-10 xl:px-12 shadow-xl border border-border/50' : ''} ${inputMethod === 'pinpoint' ? 'cursor-pointer' : ''}`}
        style={{
          WebkitTouchCallout: 'none',
          ...(vimModeActive ? { outline: 'none' } : {}),
        } as React.CSSProperties}
      >
        {/* Legacy badge placement remains byte-for-byte opt-out behavior. */}
        {!viewerAnnotationHeader && (repoInfo || hasPreviousVersion || showDemoBadge || linkedDocInfo || archiveInfo || sourceInfo || openInAppPath) && (
          <div ref={docBadgesRef} data-print-hide className={`absolute top-3 md:top-4 ${gridEnabled ? 'left-3 md:left-5' : 'left-0'}`}>
            <DocBadges
              layout="column"
              repoInfo={repoInfo}
              planDiffStats={planDiffStats}
              isPlanDiffActive={isPlanDiffActive}
              hasPreviousVersion={hasPreviousVersion}
              onPlanDiffToggle={onPlanDiffToggle}
              planDiffBaselineLabel={planDiffBaselineLabel}
              planDiffBaselineTooltip={planDiffBaselineTooltip}
              showDemoBadge={showDemoBadge}
              archiveInfo={archiveInfo}
              linkedDocInfo={linkedDocInfo}
              sourceInfo={sourceInfo}
              openInAppPath={openInAppPath}
            />
          </div>
        )}

        {viewerAnnotationHeader ? (
          <ViewerDocumentHeader
            config={viewerAnnotationHeader}
            inputMethod={inputMethod}
            mode={mode}
            taterMode={taterMode}
            sticky={stickyActions}
            stuck={isStuck}
            sentinelRef={stickySentinelRef}
            badges={{
              repoInfo,
              planDiffStats,
              isPlanDiffActive,
              hasPreviousVersion,
              onPlanDiffToggle,
              planDiffBaselineLabel,
              planDiffBaselineTooltip,
              showDemoBadge,
              archiveInfo,
              linkedDocInfo,
              sourceInfo,
              openInAppPath,
            }}
            actions={documentActions}
          />
        ) : (
          <>
            {badgeClearance > 0 && <div data-print-hide style={{ height: badgeClearance }} aria-hidden="true" />}
            {stickyActions && <div ref={stickySentinelRef} className="h-0 w-0 float-right" aria-hidden="true" />}
            <div data-print-hide data-sticky-actions className={`${stickyActions ? 'sticky top-3' : ''} z-30 float-right flex items-start gap-1 md:gap-2 rounded-lg p-1 md:p-2 transition-colors duration-150 ${isStuck ? 'bg-card/95 backdrop-blur-sm shadow-sm' : ''} ${gridEnabled ? '-mr-3 md:-mr-5 lg:-mr-7 xl:-mr-9' : '-mr-1 md:-mr-2'} mt-6 md:-mt-5 lg:-mt-7 xl:-mt-9`}>
              {documentActions}
            </div>
          </>
        )}
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
                      onToggleCheckbox={readOnly ? undefined : onToggleCheckbox}
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
              onHover={readOnly || inputMethod === 'pinpoint' ? undefined : (element) => {
                // Clear any pending leave timeout
                if (hoverTimeoutRef.current) {
                  clearTimeout(hoverTimeoutRef.current);
                  hoverTimeoutRef.current = null;
                }
                // Cancel exit animation if re-entering
                setIsCodeBlockToolbarExiting(false);
                // Only show hover toolbar if no selection toolbar is active
                if (
                  !toolbarState
                  && !vimOwnsDocumentNavigation
                  && !keyboardCodeBlockToolbarOpen
                ) {
                  setCodeBlockToolbar({
                    block: group.block,
                    element,
                    activation: 'pointer',
                  });
                }
              }}
              onLeave={readOnly || inputMethod === 'pinpoint' ? undefined : () => {
                if (keyboardCodeBlockToolbarOpen) return;
                // Delay then start exit animation
                hoverTimeoutRef.current = setTimeout(() => {
                  setIsCodeBlockToolbarExiting(true);
                  // After exit animation, unmount
                  setTimeout(() => {
                    setCodeBlockToolbar(null);
                    setIsCodeBlockToolbarExiting(false);
                  }, 150);
                }, 100);
              }}
              isHovered={
                !readOnly
                && inputMethod !== 'pinpoint'
                && !vimOwnsDocumentNavigation
                && codeBlockToolbar?.block.id === group.block.id
              }
            />
          ) : (
            <BlockRenderer imageBaseDir={imageBaseDir} onImageClick={(src, alt) => setLightbox({ src, alt })} key={group.block.id} block={group.block} onOpenLinkedDoc={onOpenLinkedDoc} onOpenCodeFile={onOpenCodeFile} onNavigateAnchor={scrollToAnchor} onToggleCheckbox={readOnly ? undefined : onToggleCheckbox} checkboxOverrides={checkboxOverrides} githubRepo={repoInfo?.display} headingAnchorId={headingSlugMap.get(group.block.id)} />
          )
        )}

        {/* Text selection toolbar */}
        {!readOnly && toolbarState && (
          <ToolbarErrorBoundary>
            <AnnotationToolbar
              element={toolbarState.element}
              positionMode="center-above"
              onAnnotate={handleAnnotate}
              onClose={handleToolbarClose}
              onRequestComment={handleRequestComment}
              onQuickLabel={handleQuickLabel}
              copyText={toolbarState.selectionText}
              hideCopyButton={!isTouchDevice}
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
        {!readOnly
          && codeBlockToolbar
          && !toolbarState
          && !(vimOwnsDocumentNavigation && codeBlockToolbar.activation === 'pointer')
          && (
            <ToolbarErrorBoundary>
              <AnnotationToolbar
                element={codeBlockToolbar.element}
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
                  if (codeBlockToolbar.activation === 'keyboard') return;
                  hoverTimeoutRef.current = setTimeout(() => {
                    setIsCodeBlockToolbarExiting(true);
                    setTimeout(() => {
                      setCodeBlockToolbar(null);
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
        {(inputMethod === 'pinpoint' || vim.activeTarget) && (
          <PinpointOverlay
            target={pinpointOverlayTarget}
            containerRef={containerRef}
          />
        )}
        {vimModeActive && (
          <VimModeOverlay
            containerRef={containerRef}
            inputMethod={inputMethod}
            state={vim.state}
            focused={vim.focused}
            hudEnabled={vimHudEnabled}
            keyPanelEnabled={vimHudKeyPanelEnabled}
            hudCommand={vim.hudCommand}
            activeTarget={vim.activeTarget}
            helpOpen={vim.helpOpen}
            onHelpOpenChange={vim.onHelpOpenChange}
            onKeyPanelHide={
              onVimHudKeyPanelChange
                ? () => onVimHudKeyPanelChange(false)
                : undefined
            }
            onHudFocusLeave={vim.onHudFocusLeave}
          />
        )}

        {/* Comment popover — hook handles text selection, Viewer handles global + code block */}
        {!readOnly && hookCommentPopover && (
            <CommentPopover
              anchorEl={hookCommentPopover.anchorEl}
              contextText={hookCommentPopover.contextText}
              isGlobal={false}
              initialText={hookCommentPopover.initialText}
              draftKey={`plan:${commentDraftScope}:${hookCommentPopover.draftKey}`}
              onSubmit={hookCommentSubmit}
              onClose={hookCommentClose}
              allowImages={allowImages}
              skillReferences
              onAskAI={onAskAI}
              askAIContext={{
                kind: 'selection',
                label: 'Selected text',
                text: hookCommentPopover.selectedText ?? hookCommentPopover.contextText,
                sourcePath: linkedDocInfo?.filepath ?? sourceInfo,
              }}
            />
          )}
        {!readOnly && viewerCommentPopover && (
          <CommentPopover
            anchorEl={viewerCommentPopover.anchorEl}
            contextText={viewerCommentPopover.contextText}
            isGlobal={viewerCommentPopover.isGlobal}
            initialText={viewerCommentPopover.initialText}
            draftKey={`plan:${commentDraftScope}:${
              viewerCommentPopover.isGlobal
                ? 'global'
                : `code-block:${viewerCommentPopover.codeBlock?.block.id ?? viewerCommentPopover.contextText}`
            }`}
            onSubmit={handleViewerCommentSubmit}
            onClose={handleViewerCommentClose}
            allowImages={allowImages}
            skillReferences
            onAskAI={onAskAI}
            askAIContext={{
              kind: viewerCommentPopover.isGlobal ? 'general' : 'selection',
              label: viewerCommentPopover.isGlobal ? 'Document' : 'Code block',
              text: viewerCommentPopover.selectedText,
              sourcePath: linkedDocInfo?.filepath ?? sourceInfo,
            }}
          />
        )}

        {/* Quick Label floating picker — hook handles text selection, Viewer handles code blocks */}
        {!readOnly && hookQuickLabelPicker && (
          <FloatingQuickLabelPicker
            anchorEl={hookQuickLabelPicker.anchorEl}
            cursorHint={hookQuickLabelPicker.cursorHint}
            onSelect={hookFloatingQuickLabel}
            onDismiss={hookQuickLabelPickerDismiss}
          />
        )}
        {!readOnly && codeBlockQuickLabelPicker && (
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
