import { useCallback, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { parseDiagramAnchor, type DiagramAnchor } from '@plannotator/core/diagram-anchor';
import { AnnotationType, type Annotation, type Block, type HostDraft } from '../../types';
import { generateId } from '../../utils/generateId';
import { getIdentity } from '../../utils/identity';
import { sourceLineAttrs } from '../../utils/sourceLineAttrs';
import type { CommentAskAIHandler } from '../CommentPopover';
import { PopoutDialog } from '../PopoutDialog';
import { NativeDiagramReview, type NativeDiagramAskContext } from './NativeDiagramReview';
import type { NativeDiagramAnchor, NativeDiagramFileReference } from './nativeDiagramDrawing';

export function nativeReviewAnchor(part: NativeDiagramAnchor): DiagramAnchor {
  const kind = part.kind === 'link' ? 'edge' : part.kind === 'group' ? 'cluster' : 'node';
  return {
    v: 1, family: 'plannotator-diagram', kind, id: part.id, label: part.title,
    sourceLine: null, point: { kind: part.kind, x: part.x, y: part.y },
  };
}

interface NativeDiagramBlockProps {
  block: Block;
  annotations: readonly Annotation[];
  selectedAnnotationId?: string | null;
  onSelectAnnotation?: (id: string | null) => void;
  onAddAnnotation?: (annotation: Annotation) => void | boolean | Promise<void | boolean>;
  onDeleteAnnotation?: (id: string) => void | boolean | Promise<void | boolean>;
  onEditAnnotation?: (id: string, updates: Partial<Annotation>) => void | boolean | Promise<void | boolean>;
  onAskAI?: CommentAskAIHandler & { destination?: 'thread' };
  onOpenFile?: (ref: NativeDiagramFileReference) => void;
  /** Supplied by an Inbox message when a newer edition has been sent. */
  onOpenLatest?: () => void;
  latestEdition?: ReactNode;
  expandedOnly?: boolean;
  renderExpandedFile?: (ref: NativeDiagramFileReference, close: () => void) => ReactNode;
  sourcePath?: string;
  onHostDraft?: (draft: HostDraft | null) => void;
  onRestoreReport?: (report: { attempted: string[]; unanchored: string[] }) => void;
  /** Use the shorter, scroll-friendly canvas when a whole file is embedded in a message. */
  embedded?: boolean;
}

export function NativeDiagramBlock({
  block, annotations, selectedAnnotationId, onSelectAnnotation, onAddAnnotation,
  onEditAnnotation, onDeleteAnnotation, onAskAI, onOpenFile, onOpenLatest, latestEdition, expandedOnly, renderExpandedFile, sourcePath, onRestoreReport, onHostDraft, embedded = false,
}: NativeDiagramBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const [part, setPart] = useState<NativeDiagramAnchor | null>(null);
  const comments = useMemo(() => annotations.flatMap((a) => {
    if (a.blockId !== block.id) return [];
    const anchor = parseDiagramAnchor(a.diagramAnchor);
    if (!anchor?.point || !anchor.id) return [];
    return [{ id: a.id, createdAt: a.createdA, text: a.text ?? '', anchor: { ...anchor.point, id: anchor.id, title: anchor.label } }];
  // Updating a saved Inbox row can move it to the end of the store's result. Keep its pin number.
  }).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)), [annotations, block.id]);

  const annotationFor = (anchor: NativeDiagramAnchor, text: string): Annotation => ({
    id: generateId(),
    blockId: block.id, startOffset: 0, endOffset: 0, type: AnnotationType.COMMENT,
    originalText: anchor.title, text, diagramAnchor: nativeReviewAnchor(anchor), createdA: Date.now(), author: getIdentity(),
  });
  const pendingCreates = useRef(new Map<string, Annotation>());
  const create = onAddAnnotation && (async (anchor: NativeDiagramAnchor, text: string) => {
    const key = JSON.stringify([block.id, anchor.kind, anchor.id, anchor.x, anchor.y]);
    // Reuse the ID when a save reached the peer but its acknowledgment did not arrive.
    const next = pendingCreates.current.get(key) ?? annotationFor(anchor, text);
    pendingCreates.current.set(key, next);
    const saved = await onAddAnnotation({ ...next, text });
    if (saved !== false) pendingCreates.current.delete(key);
    return saved;
  });
  const request = onHostDraft && ((anchor: NativeDiagramAnchor) => onHostDraft({
    annotation: annotationFor(anchor, ''), intent: 'compose', label: anchor.title, cancel: () => setPart(null),
  }));
  const ask = onAskAI && (async (context: NativeDiagramAskContext) => {
    return onAskAI(context.question, {
      kind: 'selection', label: context.part ? `Diagram ${context.part.kind}` : 'Diagram',
      text: context.part?.title ?? context.title, sourcePath,
      diagramScope: [`Diagram: ${context.title.slice(0, 160)}`, context.assetId && `Asset: ${context.assetId.slice(0, 160)}`,
        context.part && `${context.part.kind}: ${context.part.title.slice(0, 160)} (${context.part.id.slice(0, 160)})`,
        context.part?.from && context.part.to && `Connection: ${context.part.from.slice(0, 160)} → ${context.part.to.slice(0, 160)}`,
      ].filter(Boolean).join('\n'),
      detail: [context.title, context.assetId && `Asset: ${context.assetId}`, context.part && JSON.stringify({
        kind: context.part.kind, id: context.part.id, title: context.part.title, from: context.part.from, to: context.part.to,
        refs: context.part.refs.slice(0, 12),
      }).slice(0, 6000), context.description.slice(0, 6000)].filter(Boolean).join('\n'),
    });
  });
  const resolved = useCallback((map: ReadonlyMap<string, boolean>) => {
    if (map.size) onRestoreReport?.({ attempted: [...map.keys()], unanchored: [...map].filter(([, found]) => !found).map(([id]) => id) });
  }, [onRestoreReport]);
  const viewer = {
    source: block.content, comments, onCreateComment: create, onRequestComment: request,
    onDeleteComment: onDeleteAnnotation,
    onEditComment: onEditAnnotation && ((id: string, text: string) => onEditAnnotation(id, { text })),
    selectedCommentId: selectedAnnotationId, onSelectComment: onSelectAnnotation,
    selectedPart: part, onSelectPart: setPart, onAskAI: ask, askDestination: onAskAI?.destination,
    onOpenFile,
    onResolutionChange: resolved, onOpenLatest,
  };
  const inline = embedded || block.diagramSourceLineOffset !== 0;
  const expandedView = <ExpandedView viewer={viewer} renderFile={renderExpandedFile}
    onOpenLatest={latestEdition ? () => setShowLatest(true) : onOpenLatest} />;
  if (expandedOnly) return expandedView;
  return (
    <div className="annotation-exclude my-5 relative" data-block-id={block.id} data-pinpoint-ignore="" data-diagram-block="plannotator-diagram" {...sourceLineAttrs(block)}>
      <div className="flex justify-end pb-1" data-print-hide="">
        <button type="button" className="px-2 py-1 text-xs rounded text-muted-foreground hover:text-foreground" data-diagram-expand="" onClick={() => setExpanded(true)}>Expand diagram</button>
      </div>
      <NativeDiagramReview {...viewer} inline={inline} className={inline ? "h-[min(65vh,32rem)] min-h-64" : "h-[calc(100dvh-12rem)] min-h-80"} />
      {expanded && <PopoutDialog open title="Diagram" relatedSurface="[data-chat-window]" onClose={() => { setExpanded(false); setShowLatest(false); }}
        className="h-[calc(var(--pn-viewport-height,100dvh)-2rem)] w-[calc(100vw-2rem)] max-w-none"
        dataAttributes={{ 'data-diagram-popout': '', 'data-block-id': block.id }}>
        {showLatest && latestEdition ? latestEdition : expandedView}
      </PopoutDialog>}
    </div>
  );
}

function ExpandedView({ viewer, renderFile, onOpenLatest }: {
  viewer: ComponentProps<typeof NativeDiagramReview>;
  renderFile?: NativeDiagramBlockProps['renderExpandedFile'];
  onOpenLatest?: () => void;
}) {
  const [reference, setReference] = useState<NativeDiagramFileReference | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  function closeFile() {
    setReference(null);
    opener.current?.focus({ preventScroll: true });
  }
  return <div className="ndr-expanded">
    <NativeDiagramReview {...viewer} onOpenLatest={onOpenLatest} className="flex-1 min-h-0 min-w-0"
      onOpenFile={renderFile && viewer.onOpenFile ? ref => {
        opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setReference(ref);
      } : viewer.onOpenFile} />
    {reference && renderFile && <aside className="ndr-expanded-file" aria-label={reference.path}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFile(); } }}>
      {renderFile(reference, closeFile)}
    </aside>}
  </div>;
}
