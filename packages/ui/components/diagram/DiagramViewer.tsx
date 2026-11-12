import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { buildDiagramAnchorValue, type DiagramAnchor, type DiagramKind, type DiagramTarget } from '@plannotator/core/diagram-anchor';
import { cn } from '../../lib/utils';
import { diagramFamilyOf } from '../../utils/diagram-anchor';
import { diagramFinder, type DiagramTheme } from '../../utils/diagram-render';
import { DiagramCanvas, type DiagramCanvasHandle, type DiagramEscapeOutcome } from './DiagramCanvas';
import { DiagramComposer } from './DiagramComposer';
import { DiagramOverlay } from './DiagramOverlay';
import { useDiagramComments, type DiagramComment, type DiagramCreateComment } from './useDiagramComments';
import { useDiagramRender, type DiagramRenderState } from './useDiagramRender';
import { useDiagramSourceDraft, type SaveResult } from './useDiagramSourceDraft';
import { LazyBlockBoundary } from '../LazyBlockBoundary';
import type { DiagramReopenRequest } from './reopen';

const DiagramSourcePane = lazy(async () => ({ default: (await import('./DiagramSourcePane')).DiagramSourcePane }));

const PANE_CLASS = 'order-last min-h-0 shrink-0 basis-2/5 border-t border-border md:order-first md:w-80 md:basis-auto md:border-r md:border-t-0';

export type DiagramAskAI = (
  question: string,
  anchor: DiagramAnchor,
  additionalTargets: readonly DiagramTarget[],
) => boolean | void | Promise<boolean | void>;

export interface DiagramHostDraft {
  readonly anchor: DiagramAnchor;
  readonly cancel: () => void;
}

export interface DiagramViewerProps {
  readonly kind: DiagramKind;
  readonly source: string;
  readonly theme: DiagramTheme;
  readonly comments: readonly DiagramComment[];
  readonly onCreateComment?: DiagramCreateComment;
  readonly onHostDraft?: (draft: DiagramHostDraft | null) => void;
  readonly onAskAI?: DiagramAskAI;
  readonly onSave?: (source: string) => Promise<SaveResult>;
  readonly readOnlySource?: boolean;
  readonly sourceOpen?: boolean;
  readonly selectedCommentId?: string | null;
  readonly onSelectComment?: (id: string | null) => void;
  readonly onUnanchoredChange?: (ids: ReadonlySet<string>) => void;
  readonly onResolutionChange?: (resolution: ReadonlyMap<string, boolean>) => void;
  readonly onDismiss?: () => void;
  readonly renderId?: string;
  readonly sourceLineOffset?: number;
  readonly maxAdditionalTargets?: number;
  readonly commentingDisabledReason?: string;
  readonly retryToken?: number;
  readonly onRenderState?: (state: DiagramRenderState) => void;
  readonly renderFallback?: (state: DiagramRenderState) => ReactNode;
  readonly autoFocus?: boolean;
  readonly className?: string;
  readonly canvasClassName?: string;
  readonly reopenComment?: DiagramReopenRequest;
  readonly onComposerAnchor?: (anchor: DiagramAnchor | null) => void;
}

const diagramPartKey = (target: DiagramTarget): string => `${target.kind}:${target.id ?? ''}:${target.from ?? ''}:${target.to ?? ''}`;

export function DiagramViewer({
  kind,
  source,
  theme,
  comments,
  onCreateComment,
  onHostDraft,
  onComposerAnchor,
  onAskAI,
  onSave,
  readOnlySource = false,
  sourceOpen = false,
  selectedCommentId = null,
  onSelectComment,
  onUnanchoredChange,
  onResolutionChange,
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
  canvasClassName,
  reopenComment,
}: DiagramViewerProps) {
  const finder = diagramFinder(kind);
  const familyOf = useCallback((svg: Element) => (kind === 'graphviz' ? ('graphviz' as const) : diagramFamilyOf(svg)), [kind]);
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

  const canCreate = onCreateComment !== undefined || commentingDisabledReason !== undefined || onHostDraft !== undefined;
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
    onResolutionChange,
    familyOf,
  });

  const [reopenedText, setReopenedText] = useState<{ part: string; text: string } | null>(null);
  const reopenDoneRef = useRef<DiagramReopenRequest | null>(null);
  const openAt = commentsState.openAt;
  useEffect(() => {
    if (reopenComment === undefined || reopenDoneRef.current === reopenComment) return;
    if (svgRoot === null || render.renderId === null) return;
    reopenDoneRef.current = reopenComment;
    if (openAt(reopenComment.anchor)) setReopenedText({ part: diagramPartKey(reopenComment.anchor), text: reopenComment.text });
    else reopenComment.onMissing?.();
  }, [openAt, reopenComment, render.renderId, svgRoot]);
  const hadComposerRef = useRef(false);
  useEffect(() => {
    const open = commentsState.composer !== null;
    if (hadComposerRef.current && !open) setReopenedText(null);
    hadComposerRef.current = open;
  }, [commentsState.composer]);

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

  const cancelComposer = commentsState.cancel;
  useEffect(() => {
    if (!sourceOpen) cancelComposer();
  }, [cancelComposer, sourceOpen]);

  useEffect(() => {
    if (!canCreate) cancelComposer();
  }, [cancelComposer, canCreate]);

  const onHostDraftRef = useRef(onHostDraft);
  onHostDraftRef.current = onHostDraft;
  const openComposer = commentsState.composer;
  const openComposerRef = useRef(openComposer);
  openComposerRef.current = openComposer;
  const hostComposes = onHostDraft !== undefined;
  const onComposerAnchorRef = useRef(onComposerAnchor);
  onComposerAnchorRef.current = onComposerAnchor;
  useEffect(() => {
    onComposerAnchorRef.current?.(openComposer === null ? null : buildDiagramAnchorValue(openComposer.primary.target, openComposer.sourceLine));
  }, [openComposer]);
  useEffect(() => {
    const report = onHostDraftRef.current;
    if (!report) return;
    if (openComposer === null) {
      report(null);
      return;
    }
    report({
      anchor: buildDiagramAnchorValue(openComposer.primary.target, openComposer.sourceLine),
      cancel: () => {
        if (openComposerRef.current === openComposer) cancelComposer();
      },
    });
  }, [cancelComposer, hostComposes, openComposer]);

  const composerDraft = commentsState.composer;
  const askFromComposer = useMemo(() => {
    if (onAskAI === undefined || composerDraft === null || onCreateComment === undefined) return undefined;
    return async (question: string): Promise<boolean> => {
      const anchor = buildDiagramAnchorValue(composerDraft.primary.target, composerDraft.sourceLine);
      const accepted = await onAskAI(question, anchor, composerDraft.additional.map((extra) => extra.target));
      if (accepted === false) return false;
      cancelComposer();
      return true;
    };
  }, [cancelComposer, composerDraft, onAskAI, onCreateComment]);

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
          commentsState.composer === null || hostComposes ? null : (
            <DiagramComposer
              key={`${commentsState.composer.primary.target.id ?? ''}:${commentsState.composer.primary.target.from ?? ''}:${commentsState.composer.primary.target.to ?? ''}`}
              draft={commentsState.composer}
              anchorRect={anchorRect}
              hostWidth={handle.hostRef.current?.getBoundingClientRect().width ?? 0}
              hostHeight={handle.hostRef.current?.getBoundingClientRect().height ?? 0}
              sourceDirty={sourceDirty}
              submitting={commentsState.submitting}
              error={commentsState.submitError}
              disabledReason={commentingDisabledReason}
              onSubmit={(text) => void commentsState.submit(text)}
              onCancel={commentsState.cancel}
              onAskAI={askFromComposer}
              initialText={reopenedText?.part === diagramPartKey(commentsState.composer.primary.target) ? reopenedText.text : undefined}
            />
          )
        }
      />
    ),
    [askFromComposer, commentingDisabledReason, commentsState, hostComposes, onSelectComment, reopenedText, selectedCommentId, sourceDirty],
  );

  const showFallback = render.svgNode === null;

  return (
    <div data-diagram-viewer="" className={cn('annotation-exclude flex h-full min-h-0 w-full flex-col md:flex-row', className)}>
      {hasPane && sourceOpen && (
        <LazyBlockBoundary
          fallback={(notice) => (
            <div data-diagram-source-pane-failed="" className={cn(PANE_CLASS, 'overflow-auto p-3')}>
              {notice}
              <pre className="text-xs text-muted-foreground"><code className="font-mono">{draft.draft}</code></pre>
            </div>
          )}
        >
          <Suspense fallback={<div data-diagram-source-pane-pending="" aria-hidden="true" className={PANE_CLASS} />}>
            <DiagramSourcePane draft={draft} editable={editable} markedLines={markedLines} className={PANE_CLASS} />
          </Suspense>
        </LazyBlockBoundary>
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
            pickTarget={commentsState.pickTarget}
            className={canvasClassName}
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
