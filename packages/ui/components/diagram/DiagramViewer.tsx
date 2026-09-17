import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DiagramKind } from '@plannotator/core/diagram-anchor';
import { cn } from '../../lib/utils';
import { diagramFinder, type DiagramTheme } from '../../utils/diagram-render';
import { DiagramCanvas, type DiagramCanvasHandle, type DiagramEscapeOutcome } from './DiagramCanvas';
import { DiagramComposer } from './DiagramComposer';
import { DiagramOverlay } from './DiagramOverlay';
import { DiagramSourcePane } from './DiagramSourcePane';
import { useDiagramComments, type DiagramComment, type DiagramCreateComment } from './useDiagramComments';
import { useDiagramRender, type DiagramRenderState } from './useDiagramRender';
import { useDiagramSourceDraft, type SaveResult } from './useDiagramSourceDraft';

/**
 * The one diagram viewer: the canvas with its overlay, the Source pane on
 * its LEFT (stacked under it on the phone) when the host can save, the
 * parse-error strip over a dimmed last-good render. It takes the diagram
 * source and the host's comments on it, and reports a new comment through
 * `onCreateComment`; the comments rail, storage and identity are the
 * host's. Plannotator's fence blocks render through it in the document
 * (`components/DiagramBlock`) and again at full size in the popout; a host
 * with its own document store renders it wherever a diagram lives.
 */
export interface DiagramViewerProps {
  readonly kind: DiagramKind;
  /** The diagram text. With `onSave` this is the saved baseline the pane's
   * draft starts from; without it, what the canvas renders. */
  readonly source: string;
  readonly theme: DiagramTheme;
  readonly comments: readonly DiagramComment[];
  /** A comment composed on a part. Absent: clicks open nothing. */
  readonly onCreateComment?: DiagramCreateComment;
  /** Save the pane's text. Absent: there is no Source pane. */
  readonly onSave?: (source: string) => Promise<SaveResult>;
  /** With `onSave`: show the pane read-only (no edit access). */
  readonly readOnlySource?: boolean;
  /** Whether the Source pane is open (the host owns the toggle). */
  readonly sourceOpen?: boolean;
  readonly selectedCommentId?: string | null;
  readonly onSelectComment?: (id: string | null) => void;
  /** The comments whose part is gone from the current render, once per
   * membership change, after every render. */
  readonly onUnanchoredChange?: (ids: ReadonlySet<string>) => void;
  /** Escape with no composer open and nothing selected: a popout closes. */
  readonly onDismiss?: () => void;
  /** A stable prefix for the rendered element ids; two viewers over one
   * document need two. */
  readonly renderId?: string;
  /** Lines to add so a comment's `sourceLine` names DOCUMENT lines: 0 when
   * the document is the diagram, the fence's opening line for a fence. */
  readonly sourceLineOffset?: number;
  /** Shift-click targets one comment may also cover. Default 0: a comment
   * covers one part. */
  readonly maxAdditionalTargets?: number;
  /** Commenting is off, and this is why (shown in place of the composer). */
  readonly commentingDisabledReason?: string;
  /** Bumped by the host's Retry after a failed engine load. */
  readonly retryToken?: number;
  /** Every render state change (the host sizes itself, shows its own
   * pending or error chrome). */
  readonly onRenderState?: (state: DiagramRenderState) => void;
  /** What to show while there is no svg yet (the first render pending, or
   * the first render failed). Default: a quiet status line. */
  readonly renderFallback?: (state: DiagramRenderState) => ReactNode;
  /** Take the keyboard on mount (a popout). */
  readonly autoFocus?: boolean;
  readonly className?: string;
}

export function DiagramViewer({
  kind,
  source,
  theme,
  comments,
  onCreateComment,
  onSave,
  readOnlySource = false,
  sourceOpen = false,
  selectedCommentId = null,
  onSelectComment,
  onUnanchoredChange,
  onDismiss,
  renderId = 'diagram',
  sourceLineOffset = 0,
  maxAdditionalTargets = 0,
  commentingDisabledReason,
  retryToken,
  onRenderState,
  renderFallback,
  autoFocus,
  className,
}: DiagramViewerProps) {
  const finder = diagramFinder(kind);
  const hasPane = onSave !== undefined;
  const editable = hasPane && !readOnlySource;

  const draft = useDiagramSourceDraft({ source, editable, onSave });
  const rendered = hasPane ? draft.preview : source;
  const savedSource = hasPane ? draft.baseline : source;
  const sourceDirty = hasPane && draft.dirty;

  const render = useDiagramRender(kind, renderId, rendered, theme, { retryToken });
  useEffect(() => {
    onRenderState?.(render);
  }, [onRenderState, render]);

  const [svgRoot, setSvgRoot] = useState<SVGSVGElement | null>(null);
  const onSvgRoot = useCallback((root: SVGSVGElement | null) => setSvgRoot(root), []);

  const canCreate = onCreateComment !== undefined || commentingDisabledReason !== undefined;
  const commentsState = useDiagramComments({
    finder,
    svgRoot,
    renderId: render.renderId,
    renderVersion: render.renderVersion,
    comments,
    savedSource,
    sourceLineOffset,
    sourceDirty,
    maxAdditionalTargets,
    canCreate,
    onCreateComment,
    onSelectComment,
    onUnanchoredChange,
  });

  // The selected comment's source line for the pane's gutter mark. The
  // anchor names DOCUMENT lines; the pane shows the diagram text.
  const markedLines = useMemo(() => {
    if (selectedCommentId === null) return null;
    const line = comments.find((entry) => entry.id === selectedCommentId)?.anchor.sourceLine;
    if (line === null || line === undefined) return null;
    return [line[0] - sourceLineOffset, line[1] - sourceLineOffset] as const;
  }, [comments, selectedCommentId, sourceLineOffset]);

  const onEscape = useCallback((): DiagramEscapeOutcome => {
    if (commentsState.composer !== null) {
      commentsState.cancel();
      return 'consumed';
    }
    if (selectedCommentId !== null && onSelectComment !== undefined) {
      onSelectComment(null);
      return 'consumed';
    }
    onDismiss?.();
    return 'pass';
  }, [commentsState, onDismiss, onSelectComment, selectedCommentId]);

  // Closing the pane only closes an open composer so the layout shift does
  // not strand it; the draft survives a reopen.
  const cancelComposer = commentsState.cancel;
  useEffect(() => {
    if (!sourceOpen) cancelComposer();
  }, [cancelComposer, sourceOpen]);

  const overlay = useCallback(
    (handle: DiagramCanvasHandle) => (
      <DiagramOverlay
        handle={handle}
        resolved={commentsState.resolved}
        hover={commentsState.hover}
        composer={commentsState.composer}
        selectedCommentId={selectedCommentId}
        onSelectComment={onSelectComment}
        renderComposer={(anchorRect) =>
          commentsState.composer === null ? null : (
            <DiagramComposer
              key={`${commentsState.composer.primary.target.id ?? ''}:${commentsState.composer.primary.target.from ?? ''}:${commentsState.composer.primary.target.to ?? ''}`}
              draft={commentsState.composer}
              anchorRect={anchorRect}
              hostWidth={handle.hostRef.current?.getBoundingClientRect().width ?? 0}
              sourceDirty={sourceDirty}
              submitting={commentsState.submitting}
              error={commentsState.submitError}
              disabledReason={commentingDisabledReason}
              onSubmit={(text) => void commentsState.submit(text)}
              onCancel={commentsState.cancel}
            />
          )
        }
      />
    ),
    [commentingDisabledReason, commentsState, onSelectComment, selectedCommentId, sourceDirty],
  );

  const showFallback = render.svgNode === null;

  return (
    <div data-diagram-viewer="" className={cn('flex h-full min-h-0 w-full flex-col md:flex-row', className)}>
      {/* The pane comes FIRST in the row (owner ruling: the source sits on
          the left of the diagram while editing). On the phone the row is a
          column and the pane stays stacked UNDER the canvas, which
          `order-last` keeps while `md:order-first` puts it left from `md`. */}
      {hasPane && sourceOpen && (
        <DiagramSourcePane
          draft={draft}
          editable={editable}
          markedLines={markedLines}
          className="order-last min-h-0 shrink-0 basis-2/5 border-t border-border md:order-first md:w-80 md:basis-auto md:border-r md:border-t-0"
        />
      )}
      <div className="relative min-h-0 min-w-0 flex-1">
        {showFallback ? (
          <div data-diagram-fallback="" className="h-full min-h-0 w-full">
            {renderFallback !== undefined ? (
              renderFallback(render)
            ) : (
              <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground" aria-live="polite">
                {render.error !== null
                  ? `The diagram does not parse${render.error.line === null ? '' : ` (line ${render.error.line})`}: ${render.error.message}`
                  : render.pending
                    ? 'Rendering diagram…'
                    : 'Nothing to render yet.'}
              </div>
            )}
          </div>
        ) : (
          <DiagramCanvas
            svgNode={render.svgNode}
            targetSelector={finder.targetSelector}
            dimmed={render.error !== null}
            onSvgRoot={onSvgRoot}
            onHoverElement={commentsState.setHoverElement}
            onClickElement={commentsState.clickElement}
            onEscape={onEscape}
            overlay={overlay}
            autoFocus={autoFocus}
          >
            {render.error !== null && (
              <div
                data-diagram-parse-error=""
                role="alert"
                className="absolute inset-x-3 top-3 z-10 rounded-md border border-warning/40 bg-card/95 px-3 py-2 text-xs shadow-lg backdrop-blur"
              >
                <div className="font-medium text-foreground">
                  {render.error.line === null ? 'The diagram does not parse' : `The diagram does not parse (line ${render.error.line})`}
                </div>
                <div className="mt-0.5 text-muted-foreground">
                  {render.error.message}
                  {' The last good render stays below.'}
                </div>
              </div>
            )}
            {/* The chip earns its place only while the pane is closed (the
                draft survives a close); with the pane open its header carries
                the one "Draft · unsaved". */}
            {editable && draft.dirty && !sourceOpen && (
              <span
                data-diagram-preview-state=""
                className="absolute left-3 top-3 z-10 rounded-sm border border-border bg-card/85 px-1.5 py-0.5 text-[10px] text-muted-foreground backdrop-blur"
              >
                Draft preview · unsaved
              </span>
            )}
          </DiagramCanvas>
        )}
      </div>
    </div>
  );
}
