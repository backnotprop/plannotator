import type {
  Annotation,
  ArtifactAnnotationAnchor,
  ArtifactAnnotationMeta,
  CommentAnnotation,
} from '@plannotator/ui/types';
import { AnnotationType } from '@plannotator/ui/types';

/** Format a non-negative media timestamp as M:SS or H:MM:SS. */
export function formatArtifactTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const two = (value: number): string => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${two(minutes)}:${two(secs)}`
    : `${minutes}:${two(secs)}`;
}

/** Describe an artifact annotation anchor for review output and note chrome. */
export function artifactAnchorLabel(anchor: ArtifactAnnotationAnchor): string {
  switch (anchor.kind) {
    case 'document':
      return anchor.originalText ? 'Selected text' : 'Document note';
    case 'image':
      return `Pin at ${Math.round(anchor.x * 100)}%, ${Math.round(anchor.y * 100)}%`;
    case 'video':
      return `Video at ${formatArtifactTimestamp(anchor.timestamp)}`;
    case 'page':
      return 'Whole artifact';
  }
}

/** Preserve a document annotation's durable text offsets as an artifact anchor. */
export function documentAnchorFromAnnotation(annotation: Annotation): ArtifactAnnotationAnchor {
  return {
    kind: 'document',
    originalText: annotation.originalText,
    blockId: annotation.blockId,
    startOffset: annotation.startOffset,
    endOffset: annotation.endOffset,
    startMeta: annotation.startMeta,
    endMeta: annotation.endMeta,
  };
}

/** Project comment-backed artifact notes into the shared document highlighter shape. */
export function commentAnnotationAsDocument(annotation: CommentAnnotation): Annotation | null {
  const anchor = annotation.artifact?.anchor;
  if (anchor?.kind !== 'document') return null;
  return {
    id: annotation.id,
    blockId: anchor.blockId,
    startOffset: anchor.startOffset,
    endOffset: anchor.endOffset,
    type: AnnotationType.COMMENT,
    text: annotation.text,
    originalText: anchor.originalText,
    createdA: annotation.createdAt,
    author: annotation.commentAuthor,
    prUrl: annotation.prUrl,
    artifact: annotation.artifact,
    startMeta: anchor.startMeta,
    endMeta: anchor.endMeta,
  };
}

/** Return the most useful quoted context for an artifact annotation, when available. */
export function artifactAnnotationQuote(meta: ArtifactAnnotationMeta): string | undefined {
  return meta.anchor.kind === 'document' && meta.anchor.originalText
    ? meta.anchor.originalText
    : artifactAnchorLabel(meta.anchor);
}
