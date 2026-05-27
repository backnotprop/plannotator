import React from 'react';
import { SEVERITY_STYLES, DiffAnnotationMetadata } from '@plannotator/ui/types';
import { SuggestionBlock } from './SuggestionBlock';
import { ConventionalLabelBadge } from './ConventionalLabelPicker';
import { renderInlineMarkdown } from '../utils/renderInlineMarkdown';

interface InlineAnnotationProps {
  metadata: DiffAnnotationMetadata;
  language?: string;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}

/** Renders a single annotation comment inside the diff view */
export const InlineAnnotation: React.FC<InlineAnnotationProps> = ({
  metadata,
  language,
  onSelect,
  onEdit,
  onDelete,
}) => {
  const severity = metadata.severity ? SEVERITY_STYLES[metadata.severity] : null;

  return (
    <div
      className="review-comment"
      data-annotation-id={metadata.annotationId}
      onClick={() => onSelect(metadata.annotationId)}
    >
      <div className="review-comment-header">
        <div className="flex items-center gap-1.5">
          {severity && (
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${severity.dot}`} title={severity.label} />
          )}
          {metadata.conventionalLabel && (
            <ConventionalLabelBadge label={metadata.conventionalLabel} decorations={metadata.decorations} />
          )}
          {metadata.author && <span className="text-xs text-muted-foreground">{metadata.author}</span>}
        </div>
        <div className="review-comment-actions">
          <button
            className="review-comment-action"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(metadata.annotationId);
            }}
            title="Edit"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
          <button
            className="review-comment-action destructive"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(metadata.annotationId);
            }}
            title="Delete"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
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
    </div>
  );
};
