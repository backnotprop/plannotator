import React from 'react';
import { SEVERITY_STYLES, DiffAnnotationMetadata } from '@plannotator/ui/types';
import { SuggestionBlock } from './SuggestionBlock';
import { CommentMeta } from './CommentMeta';
import { CommentActions } from './CommentActions';
import { renderInlineMarkdown } from '../utils/renderInlineMarkdown';
import { isAgentGeneratedFinding } from '../utils/explainFinding';

interface InlineAnnotationProps {
  metadata: DiffAnnotationMetadata;
  language?: string;
  isSelected?: boolean;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onExplain?: (id: string) => void;
  agentFindingSources: ReadonlySet<string>;
  explainDisabled?: boolean;
}

/** Renders a single annotation comment inside the diff view */
export const InlineAnnotation: React.FC<InlineAnnotationProps> = ({
  metadata,
  language,
  isSelected = false,
  onSelect,
  onEdit,
  onDelete,
  onExplain,
  agentFindingSources,
  explainDisabled = false,
}) => {
  const severity = metadata.severity ? SEVERITY_STYLES[metadata.severity] : null;

  return (
    <div
      className={`review-comment group${isSelected ? ' is-selected' : ''}`}
      data-annotation-id={metadata.annotationId}
      onClick={() => onSelect(metadata.annotationId)}
    >
      <CommentMeta
        leading={
          severity && (
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${severity.dot}`} title={severity.label} />
          )
        }
        conventionalLabel={metadata.conventionalLabel}
        decorations={metadata.decorations}
        reviewProfileLabel={metadata.reviewProfileLabel}
        source={metadata.source}
        author={metadata.author}
        createdAt={metadata.createdAt}
      />
      {metadata.text && (
        <div className="review-comment-body">{renderInlineMarkdown(metadata.text)}</div>
      )}
      {metadata.reasoning && (
        <div className="review-comment-reasoning text-[11px] text-muted-foreground/60 leading-relaxed mt-1.5">
          {metadata.reasoning}
        </div>
      )}
      {metadata.suggestedCode && (
        <div className="mt-2">
          <SuggestionBlock code={metadata.suggestedCode} originalCode={metadata.originalCode} language={language} />
        </div>
      )}
      <CommentActions
        onEdit={() => onEdit(metadata.annotationId)}
        onExplain={isAgentGeneratedFinding(metadata, agentFindingSources) && onExplain
          ? () => onExplain(metadata.annotationId)
          : undefined}
        explainDisabled={explainDisabled}
        copyText={metadata.copyText}
        onDelete={() => onDelete(metadata.annotationId)}
      />
    </div>
  );
};
