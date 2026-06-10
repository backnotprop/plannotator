import React from 'react';
import type { EditorAnnotation } from '../types';
import { cn } from '../lib/utils';

// EditorAnnotationCard is SHARED across surfaces:
//  - the plan/annotate AnnotationPanel (flat surface-1 cards), and
//  - the code-review ReviewSidebar (bordered cards, sitting next to
//    renderAnnotationCard's `p-2.5 rounded border border-transparent
//    hover:bg-muted/30` code cards).
// The `variant` prop keeps each surface visually cohesive:
//  - 'plan'        → flat surface-1 hover (matches the plan AnnotationCard restyle)
//  - 'code-review' → bordered + muted hover (matches code-review's code cards)
type EditorAnnotationVariant = 'plan' | 'code-review';

interface EditorAnnotationCardProps {
  annotation: EditorAnnotation;
  onDelete: () => void;
  variant?: EditorAnnotationVariant;
}

export const EditorAnnotationCard: React.FC<EditorAnnotationCardProps> = ({ annotation, onDelete, variant = 'plan' }) => {
  const lineRange = annotation.lineStart === annotation.lineEnd
    ? `L${annotation.lineStart}`
    : `L${annotation.lineStart}-${annotation.lineEnd}`;

  return (
    <div
      className={cn(
        'group w-full text-left transition-colors duration-150',
        variant === 'code-review'
          ? 'relative p-2.5 rounded border border-transparent hover:bg-muted/30'
          : 'rounded-lg px-3 py-2.5 hover:bg-surface-1/50',
      )}
    >
      {/* Header: type word + file:line + delete */}
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">Editor</span>
        <span className="text-[10px] font-mono text-muted-foreground/50 truncate" title={annotation.filePath}>
          {annotation.filePath}:{lineRange}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="ml-auto relative rounded-md p-1.5 text-muted-foreground transition-colors before:absolute before:-inset-1.5 before:content-[''] opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 hover:text-destructive"
          title="Delete annotation"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Selected text */}
      <p className="mb-1.5 line-clamp-2 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground/80">
        {annotation.selectedText}
      </p>

      {/* Comment */}
      {annotation.comment && (
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">
          {annotation.comment}
        </p>
      )}
    </div>
  );
};
