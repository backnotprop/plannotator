import React, { lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { diagramTargetText, type DiagramKind } from '@plannotator/core/diagram-anchor';
import type { AnnotationRestoreReport } from '../hooks/useAnnotationHighlighter';
import { AnnotationType, type Annotation, type Block } from '../types';
import { useConfigValue } from '../config';
import type { DiagramTheme } from '../utils/diagram-render';
import { diagramShadowAmount } from '../utils/diagramShadow';
import { getIdentity } from '../utils/identity';
import { createRuntimeRetryEpoch } from '../utils/runtimeRetry';
import { DiagramAnchorClaims, DiagramAnchorClaimsContext } from './diagram/anchorClaims';
import { DiagramPending, DiagramInlineSource } from './diagram/DiagramPending';
import { DiagramViewer } from './diagram/DiagramViewer';
import { svgContentSize } from './diagram/svgContentSize';
import type { DiagramComment, DiagramCreateComment } from './diagram/useDiagramComments';
import type { DiagramRenderState } from './diagram/useDiagramRender';
import { useTheme } from './ThemeProvider';

/**
 * A diagram fence in the document: the fence's language picks the engine
 * (`MermaidBlock`, `GraphvizBlock`), and everything else is one code path
 * through the renderer slot and `DiagramViewer` — the canvas with zoom, pan
 * and fit, the comment overlay, and the same viewer at full size in the
 * popout. What this block owns is the document side: the source fence under
 * a status until the first render lands (never the error panel as a
 * placeholder), the error panel with the source and a Retry for a failed
 * engine load, the "Show source" toggle, and the bridge between a comment
 * composed on a part and an `Annotation` on the document (`diagramAnchor`
 * plus the fence's document lines), so it lists in the rail beside text
 * comments, exports, drafts and restores after a reload.
 */

/** One Retry re-attempts every block whose engine import failed (see utils/runtimeRetry). */
const RETRY_EPOCHS: Record<DiagramKind, ReturnType<typeof createRuntimeRetryEpoch>> = {
  mermaid: createRuntimeRetryEpoch(),
  graphviz: createRuntimeRetryEpoch(),
};

const LABELS: Record<DiagramKind, string> = { mermaid: 'Mermaid', graphviz: 'Graphviz' };

/** The full-size popout is only ever reached by pressing Expand, so it loads
 * then and not with the document. Its fallback is null: the overlay simply
 * has not opened yet, and nothing in the document flow moves. */
const DiagramPopout = lazy(async () => ({ default: (await import('./diagram/DiagramPopout')).DiagramPopout }));

/** The inline box height from the diagram's aspect at a nominal width, so
 * a wide flowchart is not letterboxed in a tall box and a tall state
 * diagram is not squeezed into a short one; clamped so neither extreme
 * takes the page. The canvas fits the diagram inside whatever it gets. */
const NOMINAL_WIDTH_PX = 800;
const MIN_HEIGHT_PX = 16 * 16;
const MAX_HEIGHT_PX = 36 * 16;

function inlineHeight(state: DiagramRenderState | null): string {
  const size = state?.svgNode ? svgContentSize(state.svgNode) : null;
  if (size === null) return 'min(65vh, 24rem)';
  const px = Math.round(size.height * (NOMINAL_WIDTH_PX / size.width)) + 48;
  return `min(65vh, ${Math.min(MAX_HEIGHT_PX, Math.max(MIN_HEIGHT_PX, px))}px)`;
}

function newAnnotationId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface DiagramBlockProps {
  block: Block;
  /** The document's annotations; the block keeps the ones anchored on this
   * fence (`diagramAnchor` + its `blockId`). */
  annotations?: readonly Annotation[];
  selectedAnnotationId?: string | null;
  onSelectAnnotation?: (id: string | null) => void;
  /** A comment composed on a part becomes an annotation on the document. */
  onAddAnnotation?: (annotation: Annotation) => void;
  readOnly?: boolean;
  /** The block's restore verdict after every render: its own comments as
   * `attempted`, the ones whose part is gone as `unanchored`, so the host's
   * panel shows the same "Unanchored" chip a text comment gets. */
  onRestoreReport?: (report: AnnotationRestoreReport) => void;
}

const NO_ANNOTATIONS: readonly Annotation[] = [];

export const DiagramBlock: React.FC<DiagramBlockProps & { kind: DiagramKind }> = ({
  kind,
  block,
  annotations = NO_ANNOTATIONS,
  selectedAnnotationId = null,
  onSelectAnnotation,
  onAddAnnotation,
  readOnly = false,
  onRestoreReport,
}) => {
  const label = LABELS[kind];
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [renderState, setRenderState] = useState<DiagramRenderState | null>(null);

  // The (palette, mode) the diagram must follow: the same resolution the
  // code fences use (see useFenceTheme). Outside a ThemeProvider the default
  // context yields the Plannotator dark pair, and with no theme tokens on the
  // document the renderer keeps the static config, so a host without the
  // provider renders exactly as before. A key change re-runs the render,
  // which is what re-themes an already rendered diagram.
  const { colorTheme, resolvedMode } = useTheme();
  // The node shadow reaches the renderer the same way the palette does: as
  // part of the theme key, so changing it re-initializes Mermaid and re-renders
  // every mounted diagram.
  const diagramShadow = useConfigValue('diagramShadow');
  const theme = useMemo<DiagramTheme>(
    () => ({
      colorTheme,
      mode: resolvedMode === 'light' ? 'light' : 'dark',
      shadowAmount: diagramShadowAmount(diagramShadow),
    }),
    [colorTheme, resolvedMode, diagramShadow],
  );

  // A sibling's Retry re-attempts this block too, but only while its own
  // failure was the shared engine import; a healthy block or a diagram
  // syntax error is left alone.
  const runtimeUnavailableRef = useRef(false);
  runtimeUnavailableRef.current = renderState?.error?.runtimeUnavailable ?? false;
  useEffect(
    () =>
      RETRY_EPOCHS[kind].subscribe(() => {
        if (!runtimeUnavailableRef.current) return;
        setRetryToken((token) => token + 1);
      }),
    [kind],
  );

  useEffect(() => {
    setIsExpanded(false);
  }, [block.content]);

  // Comments that name no diagram block of the document (an external POST
  // carries `blockId: "external"`; a deleted fence leaves a dead id) belong
  // to whichever diagram resolves their anchor first: see anchorClaims.
  const sharedClaims = useContext(DiagramAnchorClaimsContext);
  const ownClaims = useMemo(() => new DiagramAnchorClaims([block.id]), [block.id]);
  const claims = sharedClaims ?? ownClaims;
  const claimsVersion = useSyncExternalStore(claims.subscribe, claims.getVersion, claims.getVersion);

  // `diagramAnchor` is read defensively everywhere: a row can reach the
  // renderer from any local ingest (the external-annotations API, a draft, a
  // share link), so a nullish or malformed anchor must list as unanchored,
  // never take the page down with a property read (`null.family`).
  const ownAnnotations = useMemo(
    () => annotations.filter((ann) => ann.diagramAnchor != null && ann.blockId === block.id),
    [annotations, block.id],
  );
  const unownedAnnotations = useMemo(
    () =>
      annotations.filter(
        (ann) =>
          ann.diagramAnchor != null &&
          ann.blockId !== block.id &&
          !claims.blockIds.includes(ann.blockId) &&
          // A Graphviz anchor names a DOT part; it is never a Mermaid one.
          (ann.diagramAnchor?.family === 'graphviz') === (kind === 'graphviz'),
      ),
    [annotations, block.id, claims, kind],
  );

  // The comments on this fence, in document order (the badge numbers): its
  // own, then the unowned ones it shows or is still trying.
  const comments = useMemo<readonly DiagramComment[]>(() => {
    void claimsVersion;
    const tried = unownedAnnotations.filter((ann) => {
      const owner = claims.owner(ann.id);
      return owner === undefined || owner === block.id;
    });
    return [...ownAnnotations, ...tried].map((ann) => ({
      id: ann.id,
      anchor: ann.diagramAnchor!,
      text: ann.text ?? '',
      author: ann.author,
    }));
  }, [block.id, claims, claimsVersion, ownAnnotations, unownedAnnotations]);

  const selectedCommentId = useMemo(
    () => (selectedAnnotationId !== null && comments.some((c) => c.id === selectedAnnotationId) ? selectedAnnotationId : null),
    [comments, selectedAnnotationId],
  );
  useEffect(() => {
    if (selectedCommentId === null) return;
    rootRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedCommentId]);

  const handleCreate = useMemo<DiagramCreateComment | undefined>(() => {
    if (readOnly || onAddAnnotation === undefined) return undefined;
    return (anchor, text) => {
      onAddAnnotation({
        id: newAnnotationId(),
        blockId: block.id,
        startOffset: 0,
        endOffset: 0,
        type: AnnotationType.COMMENT,
        text,
        originalText: diagramTargetText(anchor),
        createdA: Date.now(),
        author: getIdentity(),
        diagramAnchor: anchor,
      });
    };
  }, [block.id, onAddAnnotation, readOnly]);

  const [resolution, setResolution] = useState<ReadonlyMap<string, boolean> | null>(null);
  const svgReady = renderState?.svgNode != null;
  const renderFailed = renderState !== null && renderState.error !== null && !svgReady;

  // This block's verdicts for the unowned comments. A diagram that failed
  // to render resolves nothing, and must say so or the verdict stays
  // pending forever.
  useEffect(() => {
    if (unownedAnnotations.length === 0) return;
    const results = new Map<string, boolean>();
    for (const ann of unownedAnnotations) {
      if (renderFailed) results.set(ann.id, false);
      else if (resolution?.has(ann.id)) results.set(ann.id, resolution.get(ann.id) === true);
    }
    if (results.size > 0) claims.report(block.id, results);
  }, [block.id, claims, renderFailed, resolution, unownedAnnotations]);

  // The restore verdict the panel's "Unanchored" chip runs on: this block's
  // own comments, the unowned ones it shows, and (from the first diagram
  // block only, so it is said once) the unowned ones nobody resolved.
  useEffect(() => {
    if (onRestoreReport === undefined || (resolution === null && !renderFailed)) return;
    const attempted: string[] = [];
    const unanchored: string[] = [];
    for (const ann of ownAnnotations) {
      attempted.push(ann.id);
      if (renderFailed || resolution?.get(ann.id) === false) unanchored.push(ann.id);
    }
    for (const ann of unownedAnnotations) {
      const owner = claims.owner(ann.id);
      if (owner === block.id) attempted.push(ann.id);
      else if (owner === null && claims.blockIds[0] === block.id) {
        attempted.push(ann.id);
        unanchored.push(ann.id);
      }
    }
    if (attempted.length > 0) onRestoreReport({ attempted, unanchored });
  }, [block.id, claims, claimsVersion, onRestoreReport, ownAnnotations, renderFailed, resolution, unownedAnnotations]);

  const renderFallback = useCallback(
    (state: DiagramRenderState) => {
      if (state.error !== null) {
        return (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 overflow-hidden">
            <div className="px-3 py-2 bg-destructive/10 border-b border-destructive/20 flex items-center gap-2">
              <svg className="w-4 h-4 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span className="text-xs text-destructive font-medium">{label} Error</span>
              {state.error.runtimeUnavailable && (
                <button
                  type="button"
                  onClick={() => RETRY_EPOCHS[kind].bump()}
                  className="ml-auto rounded-md border border-destructive/30 px-2 py-0.5 text-xs text-destructive hover:bg-destructive/10"
                  title="Retry loading the diagram renderer"
                >
                  Retry
                </button>
              )}
            </div>
            <pre className="p-3 text-xs text-destructive/80 overflow-x-auto">{state.error.message}</pre>
            <pre className="p-3 text-xs text-muted-foreground bg-muted/30 border-t border-border/30 overflow-x-auto">
              <code>{block.content}</code>
            </pre>
          </div>
        );
      }
      // First render still in flight (the engine import on the lazy path,
      // then the render itself): the source stays readable under a quiet
      // status line. A re-render for a theme change keeps the previous SVG,
      // so this shows only before the first diagram lands.
      return <DiagramPending block={block} kind={kind} />;
    },
    [block, kind, label],
  );

  const viewerProps = {
    kind,
    source: block.content,
    theme,
    comments,
    onCreateComment: handleCreate,
    selectedCommentId,
    onSelectComment: onSelectAnnotation,
    sourceLineOffset: block.startLine,
    retryToken,
  };

  return (
    <>
      {/* `annotation-exclude`: the text highlighter never enters a diagram,
          so a text restore (a reply that lost its anchor, a quote that also
          appears in a node label) can never wrap a <mark> inside the svg. */}
      <div ref={rootRef} className="annotation-exclude my-5 group relative" data-block-id={block.id} data-pinpoint-ignore="" data-diagram-block={kind}>
        {svgReady && !showSource && (
          <div data-print-hide="" className="absolute top-2 right-2 z-10 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={() => setShowSource(true)}
              className="p-1.5 rounded-md bg-muted/85 hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Show source"
              aria-label="Show source"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => setIsExpanded(true)}
              className="p-1.5 rounded-md bg-muted/85 hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Expand diagram"
              aria-label="Expand diagram"
              data-diagram-expand=""
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
              </svg>
            </button>
          </div>
        )}
        {showSource ? (
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowSource(false)}
              className="absolute top-2 right-2 z-10 p-1.5 rounded-md bg-muted/85 hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Show diagram"
              aria-label="Show diagram"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </button>
            <DiagramInlineSource block={block} kind={kind} />
          </div>
        ) : (
          <div
            data-diagram-inline=""
            className={svgReady ? 'rounded-xl bg-muted/30 border border-border/30 overflow-hidden' : undefined}
            style={svgReady ? { height: inlineHeight(renderState) } : undefined}
          >
            <DiagramViewer
              {...viewerProps}
              renderId={`${kind}-${block.id}`}
              onResolutionChange={setResolution}
              onRenderState={setRenderState}
              renderFallback={renderFallback}
            />
          </div>
        )}
      </div>
      {isExpanded && svgReady && typeof document !== 'undefined' && (
        <Suspense fallback={null}>
          <DiagramPopout
            {...viewerProps}
            open
            onClose={() => setIsExpanded(false)}
            title={`${label} diagram`}
            renderId={`${kind}-${block.id}-popout`}
            dataAttributes={{ 'data-block-id': block.id }}
          />
        </Suspense>
      )}
    </>
  );
};
