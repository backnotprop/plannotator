import React from 'react';
import type { EditorAnnotation } from '../types';

interface EditorAnnotationCardProps {
  annotation: EditorAnnotation;
  onDelete: () => void;
}

export const EditorAnnotationCard: React.FC<EditorAnnotationCardProps> = ({ annotation, onDelete }) => {
  const lineRange = annotation.lineStart === annotation.lineEnd
    ? `L${annotation.lineStart}`
    : `L${annotation.lineStart}-${annotation.lineEnd}`;

  return (
    <div className="group relative p-2.5 rounded-lg border border-transparent hover:bg-muted/50 hover:border-border/50 transition-all">
      {/* File path + line range */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="p-1 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </span>
          <span className="text-[10px] font-mono text-muted-foreground truncate" title={annotation.filePath}>
            {annotation.filePath}:{lineRange}
          </span>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
          title="Delete annotation"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Selected text */}
      <div className="text-[11px] font-mono text-muted-foreground bg-muted/50 rounded px-2 py-1.5 whitespace-pre-wrap max-h-24 overflow-y-auto">
        {annotation.selectedText}
      </div>

      {/* Comment */}
      {annotation.comment && (
        <div className="mt-2 text-xs text-foreground/90 pl-2 border-l-2 border-amber-500/50 whitespace-pre-wrap">
          {annotation.comment}
        </div>
      )}
    </div>
  );
};
