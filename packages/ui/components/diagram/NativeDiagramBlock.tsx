import { useCallback, useMemo, useState } from 'react';
import { parseDiagramAnchor, type DiagramAnchor } from '@plannotator/core/diagram-anchor';
import { AnnotationType, type Annotation, type Block } from '../../types';
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
  onEditAnnotation?: (id: string, updates: Partial<Annotation>) => void | boolean | Promise<void | boolean>;
  onAskAI?: CommentAskAIHandler;
  onOpenFile?: (ref: NativeDiagramFileReference) => void;
  sourcePath?: string;
  onRestoreReport?: (report: { attempted: string[]; unanchored: string[] }) => void;
  /** Use the shorter, scroll-friendly canvas when a whole file is embedded in a message. */
  embedded?: boolean;
}

export function NativeDiagramBlock({
  block, annotations, selectedAnnotationId, onSelectAnnotation, onAddAnnotation,
  onEditAnnotation, onAskAI, onOpenFile, sourcePath, onRestoreReport, embedded = false,
}: NativeDiagramBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [part, setPart] = useState<NativeDiagramAnchor | null>(null);
  const comments = useMemo(() => annotations.flatMap((a) => {
    if (a.blockId !== block.id) return [];
    const anchor = parseDiagramAnchor(a.diagramAnchor);
    if (!anchor?.point || !anchor.id) return [];
    return [{ id: a.id, text: a.text ?? '', anchor: { ...anchor.point, id: anchor.id, title: anchor.label } }];
  }), [annotations, block.id]);

  const create = onAddAnnotation && ((anchor: NativeDiagramAnchor, text: string) => onAddAnnotation({
    id: globalThis.crypto?.randomUUID?.() ?? `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    blockId: block.id, startOffset: 0, endOffset: 0, type: AnnotationType.COMMENT,
    originalText: anchor.title, text, diagramAnchor: nativeReviewAnchor(anchor), createdA: Date.now(), author: getIdentity(),
  }));
  const ask = onAskAI && (async (context: NativeDiagramAskContext) => {
    const answer = await onAskAI(context.question, {
      kind: 'selection', label: context.part ? `Diagram ${context.part.kind}` : 'Diagram',
      text: context.part?.title ?? context.title, sourcePath,
      detail: [context.title, context.assetId && `Asset: ${context.assetId}`, context.part && JSON.stringify({
        kind: context.part.kind, id: context.part.id, title: context.part.title, from: context.part.from, to: context.part.to,
        refs: context.part.refs.slice(0, 12),
      }).slice(0, 6000), context.description.slice(0, 6000)].filter(Boolean).join('\n'),
    });
    if (answer !== false) setExpanded(false);
    return answer;
  });
  const resolved = useCallback((map: ReadonlyMap<string, boolean>) => {
    if (map.size) onRestoreReport?.({ attempted: [...map.keys()], unanchored: [...map].filter(([, found]) => !found).map(([id]) => id) });
  }, [onRestoreReport]);
  const viewer = {
    source: block.content, comments, onCreateComment: create,
    onEditComment: onEditAnnotation && ((id: string, text: string) => onEditAnnotation(id, { text })),
    selectedCommentId: selectedAnnotationId, onSelectComment: onSelectAnnotation,
    selectedPart: part, onSelectPart: setPart, onAskAI: ask,
    onOpenFile: onOpenFile && ((ref: NativeDiagramFileReference) => { setExpanded(false); onOpenFile(ref); }),
    onResolutionChange: resolved,
  };
  const inline = embedded || block.diagramSourceLineOffset !== 0;
  return (
    <div className="annotation-exclude my-5 relative" data-block-id={block.id} data-pinpoint-ignore="" data-diagram-block="plannotator-diagram" {...sourceLineAttrs(block)}>
      <div className="flex justify-end pb-1" data-print-hide="">
        <button type="button" className="px-2 py-1 text-xs rounded text-muted-foreground hover:text-foreground" data-diagram-expand="" onClick={() => setExpanded(true)}>Expand diagram</button>
      </div>
      <NativeDiagramReview {...viewer} inline={inline} className={inline ? "h-[min(65vh,32rem)] min-h-64" : "h-[calc(100dvh-12rem)] min-h-80"} />
      {expanded && <PopoutDialog open title="Diagram" onClose={() => setExpanded(false)}
        className="h-[calc(var(--pn-viewport-height,100dvh)-2rem)] w-[calc(100vw-2rem)] max-w-none"
        dataAttributes={{ 'data-diagram-popout': '', 'data-block-id': block.id }}>
        <div className="h-10 shrink-0 border-b border-border px-4 flex items-center text-sm">Diagram</div>
        <NativeDiagramReview {...viewer} className="flex-1 min-h-0" />
      </PopoutDialog>}
    </div>
  );
}
