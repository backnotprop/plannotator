import React from 'react';
import type { ExternalAnnotation, ExternalAnnotationKind } from '../types';

interface ExternalAnnotationCardProps {
  annotation: ExternalAnnotation;
  onDelete: () => void;
}

const KIND_STYLES: Record<ExternalAnnotationKind, { bg: string; text: string; border: string; label: string }> = {
  error:      { bg: 'bg-red-500/10',    text: 'text-red-600 dark:text-red-400',       border: 'border-red-500/50',    label: 'error' },
  warning:    { bg: 'bg-amber-500/10',   text: 'text-amber-600 dark:text-amber-400',   border: 'border-amber-500/50',  label: 'warning' },
  suggestion: { bg: 'bg-blue-500/10',    text: 'text-blue-600 dark:text-blue-400',     border: 'border-blue-500/50',   label: 'suggestion' },
  info:       { bg: 'bg-muted',          text: 'text-muted-foreground',                border: 'border-border/50',     label: 'info' },
  comment:    { bg: 'bg-amber-500/10',   text: 'text-amber-600 dark:text-amber-400',   border: 'border-amber-500/50',  label: 'comment' },
};

export const ExternalAnnotationCard: React.FC<ExternalAnnotationCardProps> = ({ annotation, onDelete }) => {
  const style = KIND_STYLES[annotation.kind] || KIND_STYLES.comment;

  const lineRange = annotation.lineStart != null && annotation.lineEnd != null
    ? annotation.lineStart === annotation.lineEnd
      ? `L${annotation.lineStart}`
      : `L${annotation.lineStart}-${annotation.lineEnd}`
    : null;

  const location = [annotation.filePath, lineRange].filter(Boolean).join(':');

  return (
    <div className="group relative p-2.5 rounded-lg border border-transparent hover:bg-muted/50 hover:border-border/50 transition-all">
      {/* Header: kind badge + source + location + delete */}
      <div className="flex items-center justify-between mb-2 gap-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          {/* Kind badge */}
          <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wide ${style.bg} ${style.text}`}>
            {style.label}
          </span>
          {/* Source */}
          <span className="text-[9px] text-muted-foreground/70 font-medium">
            {annotation.source}
          </span>
          {/* Location */}
          {location && (
            <span className="text-[10px] font-mono text-muted-foreground truncate" title={location}>
              {location}
            </span>
          )}
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 shrink-0"
          title="Delete annotation"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Rule ID */}
      {annotation.ruleId && (
        <div className="text-[10px] text-muted-foreground mb-1.5">
          {annotation.url ? (
            <a href={annotation.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">
              {annotation.ruleId}
            </a>
          ) : (
            <span>{annotation.ruleId}</span>
          )}
        </div>
      )}

      {/* Selected text */}
      {annotation.selectedText && (
        <div className="text-[11px] font-mono text-muted-foreground bg-muted/50 rounded px-2 py-1.5 whitespace-pre-wrap max-h-24 overflow-y-auto">
          {annotation.selectedText}
        </div>
      )}

      {/* Comment */}
      {annotation.comment && (
        <div className={`mt-2 text-xs text-foreground/90 pl-2 border-l-2 ${style.border} whitespace-pre-wrap`}>
          {annotation.comment}
        </div>
      )}

      {/* Suggested code */}
      {annotation.suggestedCode && (
        <div className="mt-2">
          <div className="text-[10px] text-muted-foreground mb-0.5">Suggested:</div>
          <div className="text-[11px] font-mono bg-muted/50 rounded px-2 py-1.5 whitespace-pre-wrap max-h-32 overflow-y-auto border border-border/30">
            {annotation.suggestedCode}
          </div>
        </div>
      )}
    </div>
  );
};
