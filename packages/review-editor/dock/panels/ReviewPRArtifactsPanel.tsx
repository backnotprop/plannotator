import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { IDockviewPanelProps } from 'dockview-react';
import { EyeOff, ExternalLink, LayoutGrid, MessageSquarePlus, Paperclip, RotateCcw } from 'lucide-react';
import { CommentPopover } from '@plannotator/ui/components/CommentPopover';
import { HtmlViewer } from '@plannotator/ui/components/html-viewer';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';
import { RenderedMarkdown } from '@plannotator/ui/components/RenderedMarkdown';
import { useAnnotationHighlighter } from '@plannotator/ui/hooks/useAnnotationHighlighter';
import type {
  Annotation,
  ArtifactAnnotationAnchor,
  ArtifactAnnotationMeta,
} from '@plannotator/ui/types';
import { AnnotationType } from '@plannotator/ui/types';
import {
  commentAnnotationAsDocument,
  documentAnchorFromAnnotation,
  formatArtifactTimestamp,
} from '../../utils/artifactAnnotations';
import type { PRArtifact } from '../../utils/prArtifacts';
import { useReviewState } from '../ReviewStateContext';
import {
  type ArtifactProviderLocation,
  artifactContentProxyUrl,
  injectArtifactBaseUrl,
  rewriteArtifactMarkdownReferences,
  useRemoteArtifactDocument,
} from './artifactDocument';
import { PRArtifactGallery } from './PRArtifactGallery';
import { PRArtifactIcon } from './PRArtifactIcon';

interface ArtifactGroup {
  readonly key: 'description' | 'comments';
  readonly label: string;
  readonly artifacts: readonly PRArtifact[];
}

interface ArtifactNote {
  readonly id: string;
  readonly text: string;
  readonly meta: ArtifactAnnotationMeta;
}

type PendingCommentTarget =
  | { readonly anchorEl: HTMLElement; readonly anchorRect?: never }
  | { readonly anchorEl?: never; readonly anchorRect: DOMRect };

type PendingComment = PendingCommentTarget & {
  readonly artifactId: string;
  readonly anchor: ArtifactAnnotationAnchor;
};

const ARTIFACT_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function isResolvedArtifact(artifact: PRArtifact): boolean {
  return artifact.provenance.surface === 'review-thread' && artifact.provenance.resolved;
}

function artifactSourceLabel(artifact: PRArtifact): string {
  switch (artifact.provenance.surface) {
    case 'description':
      return 'PR description';
    case 'comment':
      return 'Comment';
    case 'review':
      return 'Review';
    case 'review-thread':
      return 'Review thread';
  }
}

function formattedTimestamp(artifact: PRArtifact): string | null {
  if (artifact.provenance.surface === 'description') return null;
  const timestamp = Date.parse(artifact.provenance.createdAt);
  if (Number.isNaN(timestamp)) return null;
  return ARTIFACT_TIMESTAMP_FORMATTER.format(timestamp);
}

function artifactGroups(artifacts: readonly PRArtifact[]): readonly ArtifactGroup[] {
  return [
    {
      key: 'description',
      label: 'PR description',
      artifacts: artifacts.filter((artifact) => artifact.provenance.surface === 'description'),
    },
    {
      key: 'comments',
      label: 'Comments · newest first',
      artifacts: artifacts.filter((artifact) => artifact.provenance.surface !== 'description'),
    },
  ];
}

function hiddenStorageKey(prUrl: string): string {
  return `plannotator-pr-artifacts:hidden:${prUrl}`;
}

function readHiddenArtifacts(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function ExternalArtifactState({
  artifact,
  message,
}: {
  artifact: PRArtifact;
  message: string;
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 p-8 text-center">
      <PRArtifactIcon kind={artifact.kind} className="h-12 w-12 opacity-75" />
      <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{message}</p>
      <a
        href={artifact.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-10 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Open artifact <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </div>
  );
}

function ImageArtifactStage({
  artifact,
  notes,
  pending,
  onRequestComment,
  onSelectNote,
}: {
  artifact: PRArtifact;
  notes: readonly ArtifactNote[];
  pending: PendingComment | null;
  onRequestComment: (target: PendingCommentTarget, anchor: ArtifactAnnotationAnchor) => void;
  onSelectNote: (id: string) => void;
}): React.JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (failedUrl === artifact.url) {
    return (
      <ExternalArtifactState
        artifact={artifact}
        message="This image could not be loaded inline. It may require GitHub authentication."
      />
    );
  }
  const pins = notes.filter((note) => note.meta.anchor.kind === 'image');
  const pendingPin = pending?.artifactId === artifact.id && pending.anchor.kind === 'image'
    ? pending.anchor
    : null;
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto p-5">
      <div
        className="relative inline-flex max-h-full max-w-full cursor-crosshair touch-manipulation"
        title="Click the image to comment at that point"
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          if (box.width <= 0 || box.height <= 0) return;
          onRequestComment({ anchorRect: new DOMRect(event.clientX, event.clientY, 0, 0) }, {
            kind: 'image',
            x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
            y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
          });
        }}
      >
        <img
          src={artifactContentProxyUrl(artifact.url)}
          alt={artifact.name}
          className="block max-h-full max-w-full rounded-md object-contain shadow-sm"
          draggable={false}
          onError={() => setFailedUrl(artifact.url)}
        />
        {pins.map((note, index) => {
          const anchor = note.meta.anchor;
          if (anchor.kind !== 'image') return null;
          return (
            <button
              key={note.id}
              type="button"
              aria-label={`Open image annotation ${index + 1}`}
              className="absolute z-10 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{ left: `${anchor.x * 100}%`, top: `${anchor.y * 100}%` }}
              onClick={(event) => {
                event.stopPropagation();
                onSelectNote(note.id);
              }}
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground shadow-md ring-2 ring-background/80">
                {index + 1}
              </span>
            </button>
          );
        })}
        {pendingPin && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow-md ring-2 ring-background"
            style={{ left: `${pendingPin.x * 100}%`, top: `${pendingPin.y * 100}%` }}
          />
        )}
      </div>
    </div>
  );
}

function VideoArtifactStage({
  artifact,
  notes,
  onRequestComment,
  onSelectNote,
}: {
  artifact: PRArtifact;
  notes: readonly ArtifactNote[];
  onRequestComment: (target: PendingCommentTarget, anchor: ArtifactAnnotationAnchor) => void;
  onSelectNote: (id: string) => void;
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  if (failedUrl === artifact.url) {
    return (
      <ExternalArtifactState
        artifact={artifact}
        message="This video could not be loaded inline. It may require GitHub authentication."
      />
    );
  }
  const timestampNotes = notes.filter((note) => note.meta.anchor.kind === 'video');
  const timelineDuration = Math.max(
    duration,
    ...timestampNotes.map((note) => note.meta.anchor.kind === 'video' ? note.meta.anchor.timestamp : 0),
    1,
  );
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 overflow-auto p-5">
      <video
        ref={videoRef}
        src={artifactContentProxyUrl(artifact.url)}
        aria-label={artifact.name}
        controls
        preload="metadata"
        className="max-h-[calc(100%-4.5rem)] max-w-full rounded-md bg-black shadow-sm"
        onLoadedMetadata={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onError={() => setFailedUrl(artifact.url)}
      />
      <div className="flex w-full max-w-3xl items-center gap-2">
        <button
          type="button"
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md bg-muted/60 px-3 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => onRequestComment({ anchorEl: event.currentTarget }, { kind: 'video', timestamp: currentTime })}
        >
          <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
          Comment at {formatArtifactTimestamp(currentTime)}
        </button>
        <div className="relative h-11 min-w-0 flex-1" aria-label="Video annotation timeline">
          <span className="absolute left-0 right-0 top-1/2 h-px bg-border" aria-hidden="true" />
          {timestampNotes.map((note, index) => {
            const anchor = note.meta.anchor;
            if (anchor.kind !== 'video') return null;
            return (
              <button
                key={note.id}
                type="button"
                aria-label={`Go to annotation ${index + 1} at ${formatArtifactTimestamp(anchor.timestamp)}`}
                title={formatArtifactTimestamp(anchor.timestamp)}
                className="absolute top-0 flex h-11 w-11 -translate-x-1/2 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{ left: `${Math.min(1, Math.max(0, anchor.timestamp / timelineDuration)) * 100}%` }}
                onClick={() => {
                  if (videoRef.current) videoRef.current.currentTime = anchor.timestamp;
                  onSelectNote(note.id);
                }}
              >
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground shadow-sm ring-2 ring-background">
                  {index + 1}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function AnnotatableMarkdownStage({
  markdown,
  artifactUrl,
  provider,
  annotations,
  selectedAnnotationId,
  onAddAnnotation,
  onSelectAnnotation,
  onAskAI,
}: {
  markdown: string;
  artifactUrl: string;
  provider: ArtifactProviderLocation;
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  onAddAnnotation: (annotation: Annotation) => void;
  onSelectAnnotation: (id: string | null) => void;
  onAskAI: React.ComponentProps<typeof CommentPopover>['onAskAI'];
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const hook = useAnnotationHighlighter({
    containerRef,
    annotations,
    onAddAnnotation,
    onSelectAnnotation,
    selectedAnnotationId,
    mode: 'comment',
  });
  const previousIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (containerRef.current !== null) {
      rewriteArtifactMarkdownReferences(containerRef.current, artifactUrl, provider);
    }
    const ids = new Set(annotations.map((annotation) => annotation.id));
    for (const id of previousIdsRef.current) {
      if (!ids.has(id)) hook.removeHighlight(id);
    }
    hook.applyAnnotations(annotations);
    previousIdsRef.current = ids;
  }, [annotations, artifactUrl, markdown, provider]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <OverlayScrollArea className="h-full px-8 py-6">
      <div ref={containerRef}>
        <RenderedMarkdown markdown={markdown} className="md-compact mx-auto max-w-3xl" />
      </div>
      {hook.commentPopover && createPortal(
        <CommentPopover
          anchorEl={hook.commentPopover.anchorEl}
          contextText={hook.commentPopover.contextText}
          initialText={hook.commentPopover.initialText}
          isGlobal={false}
          allowImages={false}
          onSubmit={hook.handleCommentSubmit}
          onClose={hook.handleCommentClose}
          onAskAI={onAskAI}
          askAIContext={{
            kind: 'selection',
            label: 'Artifact document',
            text: hook.commentPopover.selectedText ?? hook.commentPopover.contextText,
          }}
        />,
        document.body,
      )}
    </OverlayScrollArea>
  );
}

function MarkdownArtifactStage({
  artifact,
  provider,
  annotations,
  selectedAnnotationId,
  onAddAnnotation,
  onSelectAnnotation,
  onAskAI,
}: {
  artifact: PRArtifact;
  provider: ArtifactProviderLocation;
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  onAddAnnotation: (annotation: Annotation) => void;
  onSelectAnnotation: (id: string | null) => void;
  onAskAI: React.ComponentProps<typeof CommentPopover>['onAskAI'];
}): React.JSX.Element {
  const state = useRemoteArtifactDocument(artifact.url);
  if (state.status === 'loading') {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading document…</div>;
  }
  if (state.status === 'error') {
    return (
      <ExternalArtifactState
        artifact={artifact}
        message="This Markdown document could not be loaded inline. It may have moved or require different access."
      />
    );
  }
  return (
    <AnnotatableMarkdownStage
      markdown={state.content}
      artifactUrl={artifact.url}
      provider={provider}
      annotations={annotations}
      selectedAnnotationId={selectedAnnotationId}
      onAddAnnotation={onAddAnnotation}
      onSelectAnnotation={onSelectAnnotation}
      onAskAI={onAskAI}
    />
  );
}

function HtmlArtifactStage({
  artifact,
  provider,
  annotations,
  selectedAnnotationId,
  onAddAnnotation,
  onSelectAnnotation,
  onAskAI,
}: {
  artifact: PRArtifact;
  provider: ArtifactProviderLocation;
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  onAddAnnotation: (annotation: Annotation) => void;
  onSelectAnnotation: (id: string | null) => void;
  onAskAI: React.ComponentProps<typeof CommentPopover>['onAskAI'];
}): React.JSX.Element {
  const state = useRemoteArtifactDocument(artifact.url);
  if (state.status === 'loading') {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading HTML…</div>;
  }
  if (state.status === 'error') {
    return (
      <ExternalArtifactState
        artifact={artifact}
        message="This HTML document could not be loaded inline. It may have moved or require different access."
      />
    );
  }
  return (
    <HtmlViewer
      rawHtml={injectArtifactBaseUrl(state.content, artifact.url, provider)}
      annotations={annotations}
      onAddAnnotation={onAddAnnotation}
      onSelectAnnotation={onSelectAnnotation}
      selectedAnnotationId={selectedAnnotationId}
      mode="comment"
      inputMethod="drag"
      fullViewport
      hideControls
      title={`HTML artifact: ${artifact.name}`}
      onAskAI={onAskAI}
    />
  );
}

function ArtifactStage({
  artifact,
  provider,
  notes,
  documentAnnotations,
  selectedAnnotationId,
  pending,
  onAddDocumentAnnotation,
  onRequestComment,
  onSelectAnnotation,
  onAskAI,
}: {
  artifact: PRArtifact;
  provider: ArtifactProviderLocation;
  notes: readonly ArtifactNote[];
  documentAnnotations: Annotation[];
  selectedAnnotationId: string | null;
  pending: PendingComment | null;
  onAddDocumentAnnotation: (annotation: Annotation) => void;
  onRequestComment: (target: PendingCommentTarget, anchor: ArtifactAnnotationAnchor) => void;
  onSelectAnnotation: (id: string | null) => void;
  onAskAI: React.ComponentProps<typeof CommentPopover>['onAskAI'];
}): React.JSX.Element {
  switch (artifact.kind) {
    case 'image':
    case 'gif':
      return (
        <ImageArtifactStage
          artifact={artifact}
          notes={notes}
          pending={pending}
          onRequestComment={onRequestComment}
          onSelectNote={onSelectAnnotation}
        />
      );
    case 'video':
      return (
        <VideoArtifactStage
          artifact={artifact}
          notes={notes}
          onRequestComment={onRequestComment}
          onSelectNote={onSelectAnnotation}
        />
      );
    case 'markdown':
      return (
        <MarkdownArtifactStage
          artifact={artifact}
          provider={provider}
          annotations={documentAnnotations}
          selectedAnnotationId={selectedAnnotationId}
          onAddAnnotation={onAddDocumentAnnotation}
          onSelectAnnotation={onSelectAnnotation}
          onAskAI={onAskAI}
        />
      );
    case 'html':
      return (
        <HtmlArtifactStage
          artifact={artifact}
          provider={provider}
          annotations={documentAnnotations}
          selectedAnnotationId={selectedAnnotationId}
          onAddAnnotation={onAddDocumentAnnotation}
          onSelectAnnotation={onSelectAnnotation}
          onAskAI={onAskAI}
        />
      );
  }
}

/** Hosted PR/MR attachments viewer with inline media and shared review annotations. */
export const ReviewPRArtifactsPanel: React.FC<IDockviewPanelProps> = () => {
  const {
    prMetadata,
    prArtifacts,
    isPRContextLoading,
    prContextError,
    fetchPRContext,
    descriptionAnnotations,
    selectedDescriptionAnnotationId,
    onAddDescriptionAnnotation,
    onSelectDescriptionAnnotation,
    onAskAIForDescription,
    commentAnnotations,
    selectedCommentAnnotationId,
    onAddCommentAnnotation,
    onSelectCommentAnnotation,
    onAskAIForComment,
  } = useReviewState();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hideResolved, setHideResolved] = useState(false);
  const [pendingComment, setPendingComment] = useState<PendingComment | null>(null);
  const prUrl = prMetadata?.url ?? 'unknown';
  const storageKey = hiddenStorageKey(prUrl);
  const [hiddenState, setHiddenState] = useState<{ key: string; ids: Set<string> }>(() => ({
    key: storageKey,
    ids: readHiddenArtifacts(storageKey),
  }));
  const hiddenIds = hiddenState.key === storageKey ? hiddenState.ids : readHiddenArtifacts(storageKey);

  useEffect(() => {
    if (hiddenState.key !== storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify([...hiddenState.ids]));
    } catch {
      // Storage is an optional convenience; the viewer still works without it.
    }
  }, [hiddenState, storageKey]);

  const visibleArtifacts = useMemo(
    () => prArtifacts.filter((artifact) =>
      !hiddenIds.has(artifact.id) && (!hideResolved || !isResolvedArtifact(artifact))),
    [hiddenIds, hideResolved, prArtifacts],
  );
  const selected = selectedId === null
    ? null
    : visibleArtifacts.find((artifact) => artifact.id === selectedId) ?? null;
  const groups = useMemo(() => artifactGroups(visibleArtifacts), [visibleArtifacts]);
  const hasResolved = prArtifacts.some(isResolvedArtifact);
  const selectedTimestamp = selected === null ? null : formattedTimestamp(selected);
  const annotationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const annotation of [...descriptionAnnotations, ...commentAnnotations]) {
      const artifactId = annotation.artifact?.artifactId;
      if (artifactId) counts.set(artifactId, (counts.get(artifactId) ?? 0) + 1);
    }
    return counts;
  }, [commentAnnotations, descriptionAnnotations]);
  const hiddenCatalogCount = prArtifacts.filter((artifact) => hiddenIds.has(artifact.id)).length;

  useEffect(() => setPendingComment(null), [selected?.id]);

  useEffect(() => {
    if (selectedId !== null && !visibleArtifacts.some((artifact) => artifact.id === selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId, visibleArtifacts]);

  useEffect(() => {
    const descriptionArtifactId = descriptionAnnotations.find(
      (annotation) => annotation.id === selectedDescriptionAnnotationId,
    )?.artifact?.artifactId;
    const commentArtifactId = commentAnnotations.find(
      (annotation) => annotation.id === selectedCommentAnnotationId,
    )?.artifact?.artifactId;
    const artifactId = descriptionArtifactId ?? commentArtifactId;
    if (artifactId && visibleArtifacts.some((artifact) => artifact.id === artifactId)) {
      setSelectedId(artifactId);
    }
  }, [
    commentAnnotations,
    descriptionAnnotations,
    selectedCommentAnnotationId,
    selectedDescriptionAnnotationId,
    visibleArtifacts,
  ]);

  const selectedIsDescription = selected?.provenance.surface === 'description';
  const artifactNotes = useMemo<ArtifactNote[]>(() => {
    if (selected === null) return [];
    if (selectedIsDescription) {
      return descriptionAnnotations
        .filter((annotation): annotation is Annotation & { artifact: ArtifactAnnotationMeta } => annotation.artifact?.artifactId === selected.id)
        .map((annotation) => ({
          id: annotation.id,
          text: annotation.text ?? '',
          meta: annotation.artifact,
        }));
    }
    return commentAnnotations
      .filter((annotation): annotation is typeof annotation & { artifact: ArtifactAnnotationMeta } => annotation.artifact?.artifactId === selected.id)
      .map((annotation) => ({
        id: annotation.id,
        text: annotation.text,
        meta: annotation.artifact,
      }));
  }, [commentAnnotations, descriptionAnnotations, selected, selectedIsDescription]);

  const documentAnnotations = useMemo<Annotation[]>(() => {
    if (selected === null) return [];
    if (selectedIsDescription) {
      return descriptionAnnotations.filter(
        (annotation) => annotation.artifact?.artifactId === selected.id && annotation.artifact.anchor.kind === 'document',
      );
    }
    return commentAnnotations
      .filter((annotation) => annotation.artifact?.artifactId === selected.id)
      .map(commentAnnotationAsDocument)
      .filter((annotation): annotation is Annotation => annotation !== null);
  }, [commentAnnotations, descriptionAnnotations, selected, selectedIsDescription]);

  if (prMetadata === null) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        Artifacts are available for hosted pull requests and merge requests.
      </div>
    );
  }
  const changeRequestLabel = prMetadata.platform === 'gitlab' ? 'MR' : 'PR';
  if (isPRContextLoading && prArtifacts.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading PR artifacts…</div>;
  }
  if (prContextError && prArtifacts.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-destructive">{prContextError}</p>
        <button type="button" onClick={fetchPRContext} className="min-h-10 rounded-md bg-muted px-3 text-xs font-medium hover:bg-muted/80">
          Retry
        </button>
      </div>
    );
  }
  if (prArtifacts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md text-center">
          <Paperclip className="mx-auto mb-3 h-7 w-7 text-muted-foreground/50" />
          <h2 className="text-sm font-medium text-foreground">No {changeRequestLabel} artifacts</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Images, videos, HTML, and Markdown shared in the {changeRequestLabel} description or comments will appear here.
          </p>
        </div>
      </div>
    );
  }

  const setHidden = (update: (ids: Set<string>) => Set<string>): void => {
    setHiddenState((current) => {
      const ids = current.key === storageKey ? current.ids : readHiddenArtifacts(storageKey);
      return { key: storageKey, ids: update(new Set(ids)) };
    });
  };
  const selectedAnnotationId = selectedIsDescription
    ? selectedDescriptionAnnotationId
    : selectedCommentAnnotationId;
  const selectAnnotation = selectedIsDescription
    ? onSelectDescriptionAnnotation
    : onSelectCommentAnnotation;

  const artifactMeta = (anchor: ArtifactAnnotationAnchor): ArtifactAnnotationMeta | null => selected === null ? null : ({
    artifactId: selected.id,
    artifactName: selected.name,
    artifactUrl: selected.url,
    artifactKind: selected.kind,
    sourceUrl: selected.provenance.sourceUrl,
    anchor,
  });

  const addArtifactAnnotation = (
    anchor: ArtifactAnnotationAnchor,
    text: string,
    documentAnnotation?: Annotation,
  ): void => {
    if (selected === null) return;
    const meta = artifactMeta(anchor);
    if (meta === null) return;
    if (selected.provenance.surface === 'description') {
      const now = Date.now();
      onAddDescriptionAnnotation({
        id: documentAnnotation?.id ?? crypto.randomUUID(),
        blockId: documentAnnotation?.blockId ?? '',
        startOffset: documentAnnotation?.startOffset ?? 0,
        endOffset: documentAnnotation?.endOffset ?? 0,
        type: documentAnnotation?.type ?? AnnotationType.GLOBAL_COMMENT,
        text,
        originalText: documentAnnotation?.originalText ?? '',
        createdA: documentAnnotation?.createdA ?? now,
        author: documentAnnotation?.author,
        startMeta: documentAnnotation?.startMeta,
        endMeta: documentAnnotation?.endMeta,
        artifact: meta,
      });
      return;
    }
    onAddCommentAnnotation(
      selected.provenance.refId,
      selected.provenance.authorLogin,
      selected.sourceMarkdown,
      text,
      { id: documentAnnotation?.id, artifact: meta },
    );
  };

  const stepSelection = (direction: -1 | 1): void => {
    if (visibleArtifacts.length === 0) return;
    const currentIndex = selected ? visibleArtifacts.findIndex((artifact) => artifact.id === selected.id) : -1;
    const nextIndex = Math.min(visibleArtifacts.length - 1, Math.max(0, currentIndex + direction));
    const next = visibleArtifacts[nextIndex];
    if (next) setSelectedId(next.id);
  };

  return (
    <div
      className="flex h-full min-w-0 bg-background"
      onKeyDown={(event) => {
        const target = event.target;
        const isArrowKey = event.key === 'ArrowDown'
          || event.key === 'ArrowRight'
          || event.key === 'ArrowUp'
          || event.key === 'ArrowLeft';
        if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
        if (target instanceof HTMLElement && target.tagName === 'VIDEO') {
          if (isArrowKey) event.stopPropagation();
          return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
          event.preventDefault();
          event.stopPropagation();
          stepSelection(1);
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
          event.preventDefault();
          event.stopPropagation();
          stepSelection(-1);
        }
      }}
    >
      <aside className="flex h-full w-[17rem] max-w-[36%] shrink-0 flex-col border-r border-border/50 bg-card/15">
        <div className="flex min-h-[var(--panel-header-h)] shrink-0 items-center justify-between border-b border-border/50 px-3">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Artifacts <span className="font-mono opacity-70">{visibleArtifacts.length}</span>
          </span>
          <div className="flex items-center gap-1">
            {hiddenCatalogCount > 0 && (
              <button
                type="button"
                className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setHidden(() => new Set())}
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Restore {hiddenCatalogCount}
              </button>
            )}
            {hasResolved && (
              <label className="flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[10px] text-muted-foreground hover:bg-muted">
                <input type="checkbox" checked={hideResolved} onChange={(event) => setHideResolved(event.target.checked)} className="h-3 w-3 accent-primary" />
                Hide resolved
              </label>
            )}
          </div>
        </div>
        <OverlayScrollArea className="min-h-0 flex-1 px-1 py-1">
          <button
            type="button"
            aria-current={selectedId === null ? 'page' : undefined}
            className={`mb-2 flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${selectedId === null ? 'bg-primary/12 text-foreground' : 'text-muted-foreground hover:bg-muted/65 hover:text-foreground'}`}
            onClick={() => setSelectedId(null)}
          >
            <span className="flex h-7 w-7 items-center justify-center">
              <LayoutGrid className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">Gallery</span>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-muted-foreground">
              {visibleArtifacts.length}
            </span>
          </button>
          {groups.map((group) => group.artifacts.length === 0 ? null : (
            <section key={group.key} className="mb-3 last:mb-0">
              <div className="flex items-center justify-between px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/65">
                <span>{group.label}</span>
                <span className="font-mono">{group.artifacts.length}</span>
              </div>
              {group.artifacts.map((artifact) => {
                const active = selected?.id === artifact.id;
                const resolved = isResolvedArtifact(artifact);
                const timestamp = formattedTimestamp(artifact);
                const noteCount = annotationCounts.get(artifact.id) ?? 0;
                return (
                  <div
                    key={artifact.id}
                    className={`group mb-0.5 flex min-h-12 items-stretch rounded-md ${active ? 'bg-primary/12 text-foreground' : 'text-muted-foreground hover:bg-muted/65 hover:text-foreground'} ${resolved ? 'opacity-60' : ''}`}
                  >
                    <button
                      type="button"
                      aria-current={active ? 'true' : undefined}
                      onClick={() => setSelectedId(artifact.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-l-md px-2 text-left focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <PRArtifactIcon kind={artifact.kind} />
                      <span className="min-w-0 flex-1 py-1.5">
                        <span className="flex items-center gap-1 truncate text-xs font-medium">
                          <span className="truncate">{artifact.name}</span>
                          {resolved && <span className="text-[8px] uppercase tracking-wide text-muted-foreground">resolved</span>}
                        </span>
                        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-[9px] opacity-70">
                          <span className="truncate">@{artifact.provenance.authorLogin}</span>
                          {timestamp && <time dateTime={artifact.provenance.surface === 'description' ? undefined : artifact.provenance.createdAt}>{timestamp}</time>}
                          {noteCount > 0 && <span aria-label={`${noteCount} annotations`}>· {noteCount}</span>}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Hide ${artifact.name}`}
                      title="Hide artifact"
                      className={`flex min-h-11 w-11 shrink-0 items-center justify-center rounded-r-md text-muted-foreground/55 transition-opacity duration-150 hover:bg-muted hover:text-foreground focus-visible:z-10 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none ${active ? 'opacity-70' : 'opacity-0 group-hover:opacity-55 group-focus-within:opacity-55'}`}
                      onClick={() => setHidden((ids) => {
                        ids.add(artifact.id);
                        return ids;
                      })}
                    >
                      <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </section>
          ))}
          {visibleArtifacts.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              <p>No visible artifacts.</p>
              {hiddenCatalogCount > 0 && (
                <button type="button" className="mt-2 min-h-10 rounded-md px-3 text-foreground hover:bg-muted" onClick={() => setHidden(() => new Set())}>
                  Restore hidden artifacts
                </button>
              )}
            </div>
          )}
        </OverlayScrollArea>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {prContextError && (
          <div className="shrink-0 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
            PR artifacts may be stale: {prContextError}
          </div>
        )}
        {selected === null ? (
          <>
            <header className="flex min-h-[var(--panel-header-h)] shrink-0 items-center gap-2 border-b border-border/50 px-3">
              <LayoutGrid className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">Gallery</span>
            </header>
            <div className="min-h-0 flex-1 bg-muted/10">
              <PRArtifactGallery
                artifacts={visibleArtifacts}
                provider={prMetadata}
                onSelectArtifact={setSelectedId}
              />
            </div>
            <footer className="shrink-0 border-t border-border/50 px-3 py-2 text-[10px] text-muted-foreground">
              {visibleArtifacts.length} {visibleArtifacts.length === 1 ? 'artifact' : 'artifacts'} · select one to review
            </footer>
          </>
        ) : (
          <>
            <header className="flex min-h-[var(--panel-header-h)] shrink-0 items-center gap-2 border-b border-border/50 px-3">
              <PRArtifactIcon kind={selected.kind} className="h-5 w-5" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{selected.name}</span>
              <button
                type="button"
                className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-muted/55 px-2.5 text-[10px] font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={(event) => setPendingComment({ artifactId: selected.id, anchorEl: event.currentTarget, anchor: { kind: 'page' } })}
              >
                <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" /> Add note
              </button>
              <a href={selected.provenance.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Source <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
              <a href={selected.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Open <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            </header>
            <div className="min-h-0 flex-1 bg-muted/10">
              <ArtifactStage
                key={selected.url}
                artifact={selected}
                provider={prMetadata}
                notes={artifactNotes}
                documentAnnotations={documentAnnotations}
                selectedAnnotationId={selectedAnnotationId}
                pending={pendingComment}
                onAddDocumentAnnotation={(annotation) => addArtifactAnnotation(documentAnchorFromAnnotation(annotation), annotation.text ?? '', annotation)}
                onRequestComment={(target, anchor) => setPendingComment({ artifactId: selected.id, ...target, anchor })}
                onSelectAnnotation={selectAnnotation}
                onAskAI={selectedIsDescription ? onAskAIForDescription : onAskAIForComment}
              />
            </div>
            <footer className="shrink-0 border-t border-border/50 px-3 py-2 text-[10px] text-muted-foreground">
              From <span className="font-medium text-foreground/80">{artifactSourceLabel(selected)}</span>
              {' by '}@{selected.provenance.authorLogin}
              {selectedTimestamp ? ` · ${selectedTimestamp}` : ''}
              {isResolvedArtifact(selected) ? ' · resolved thread' : ''}
              {selected.kind === 'image' || selected.kind === 'gif'
                ? ' · click the image to annotate a point'
                : selected.kind === 'video'
                  ? ' · pause, then comment at the current time'
                  : ' · select text to annotate'}
            </footer>
          </>
        )}
      </section>

      {pendingComment && selected && pendingComment.artifactId === selected.id && createPortal(
        <CommentPopover
          anchorEl={pendingComment.anchorEl}
          anchorRect={pendingComment.anchorRect}
          contextText={
            pendingComment.anchor.kind === 'video'
              ? `at ${formatArtifactTimestamp(pendingComment.anchor.timestamp)}`
              : pendingComment.anchor.kind === 'image'
                ? 'this point'
                : ''
          }
          isGlobal={pendingComment.anchor.kind === 'page'}
          allowImages={false}
          onSubmit={(text) => {
            addArtifactAnnotation(pendingComment.anchor, text);
            setPendingComment(null);
          }}
          onClose={() => setPendingComment(null)}
          onAskAI={selectedIsDescription ? onAskAIForDescription : onAskAIForComment}
          askAIContext={{
            kind: pendingComment.anchor.kind === 'page' ? 'general' : 'selection',
            label: selected.name,
            text: pendingComment.anchor.kind === 'video'
              ? `Video at ${formatArtifactTimestamp(pendingComment.anchor.timestamp)}`
              : pendingComment.anchor.kind === 'image'
                ? `Image point ${Math.round(pendingComment.anchor.x * 100)}%, ${Math.round(pendingComment.anchor.y * 100)}%`
                : selected.name,
          }}
        />,
        document.body,
      )}
    </div>
  );
};
