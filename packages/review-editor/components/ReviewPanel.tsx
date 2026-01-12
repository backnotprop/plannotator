import React from 'react';
import { CodeAnnotation } from '@plannotator/ui/types';

interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
}

interface ReviewPanelProps {
  isOpen: boolean;
  onToggle: () => void;
  annotations: CodeAnnotation[];
  files: DiffFile[];
  selectedAnnotationId: string | null;
  onSelectAnnotation: (id: string | null) => void;
  onDeleteAnnotation: (id: string) => void;
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

const TypeIcon: React.FC<{ type: CodeAnnotation['type'] }> = ({ type }) => {
  switch (type) {
    case 'comment':
      return (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
      );
    case 'suggestion':
      return (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
        </svg>
      );
    case 'concern':
      return (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      );
  }
};

export const ReviewPanel: React.FC<ReviewPanelProps> = ({
  isOpen,
  onToggle,
  annotations,
  files,
  selectedAnnotationId,
  onSelectAnnotation,
  onDeleteAnnotation,
}) => {
  // Group annotations by file
  const groupedAnnotations = React.useMemo(() => {
    const grouped = new Map<string, CodeAnnotation[]>();
    for (const ann of annotations) {
      const existing = grouped.get(ann.filePath) || [];
      existing.push(ann);
      grouped.set(ann.filePath, existing);
    }
    // Sort each group by line number
    for (const [, anns] of grouped) {
      anns.sort((a, b) => a.lineStart - b.lineStart);
    }
    return grouped;
  }, [annotations]);

  return (
    <>
      {/* Toggle button when closed */}
      {!isOpen && (
        <button
          onClick={onToggle}
          className="absolute right-0 top-1/2 -translate-y-1/2 z-20 px-1 py-4 bg-card border border-r-0 border-border rounded-l-lg hover:bg-muted transition-colors"
          title="Show annotations"
        >
          <svg className="w-4 h-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          {annotations.length > 0 && (
            <span className="absolute -top-1 -left-1 w-4 h-4 bg-primary text-primary-foreground text-[10px] rounded-full flex items-center justify-center">
              {annotations.length}
            </span>
          )}
        </button>
      )}

      {/* Panel */}
      <aside
        className={`border-l border-border bg-card/30 flex flex-col transition-all ${
          isOpen ? 'w-80' : 'w-0 overflow-hidden'
        }`}
      >
        {/* Header */}
        <div className="p-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Annotations</span>
            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {annotations.length}
            </span>
          </div>
          <button
            onClick={onToggle}
            className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="Hide panel"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {annotations.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              <div className="mb-2">No annotations yet</div>
              <div className="text-xs">
                Click on lines or drag to select a range, then add comments, suggestions, or concerns.
              </div>
            </div>
          ) : (
            <div className="p-2 space-y-4">
              {Array.from(groupedAnnotations.entries()).map(([filePath, fileAnnotations]) => (
                <div key={filePath}>
                  {/* File header */}
                  <div className="px-2 py-1 text-xs font-mono text-muted-foreground truncate">
                    {filePath.split('/').pop()}
                  </div>

                  {/* Annotations for this file */}
                  <div className="space-y-1">
                    {fileAnnotations.map((annotation) => {
                      const isSelected = selectedAnnotationId === annotation.id;
                      return (
                        <div
                          key={annotation.id}
                          onClick={() => onSelectAnnotation(annotation.id)}
                          className={`group relative p-2.5 rounded-lg border cursor-pointer transition-all ${
                            isSelected
                              ? 'bg-primary/5 border-primary/30 shadow-sm'
                              : 'border-transparent hover:bg-muted/50 hover:border-border/50'
                          }`}
                        >
                          {/* Header row */}
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`annotation-badge ${annotation.type}`}>
                              <TypeIcon type={annotation.type} />
                              <span className="ml-1">{annotation.type}</span>
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {annotation.lineStart === annotation.lineEnd
                                ? `L${annotation.lineStart}`
                                : `L${annotation.lineStart}-${annotation.lineEnd}`}
                            </span>
                            <span className="text-[10px] text-muted-foreground ml-auto">
                              {formatRelativeTime(annotation.createdAt)}
                            </span>
                          </div>

                          {/* Content */}
                          {annotation.text && (
                            <div className="text-xs text-foreground/80 line-clamp-2">
                              {annotation.text}
                            </div>
                          )}

                          {annotation.suggestedCode && (
                            <div className="mt-1 text-[10px] font-mono text-muted-foreground bg-muted/50 px-2 py-1 rounded truncate">
                              {annotation.suggestedCode.split('\n')[0]}...
                            </div>
                          )}

                          {/* Delete button */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteAnnotation(annotation.id);
                            }}
                            className="absolute top-2 right-2 p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
                            title="Delete annotation"
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
};
