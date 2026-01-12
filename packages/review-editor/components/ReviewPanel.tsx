import React, { useState } from 'react';
import { CodeAnnotation } from '@plannotator/ui/types';
import { isCurrentUser } from '@plannotator/ui/utils/identity';

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
  feedbackMarkdown?: string;
}

function formatTimestamp(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;

  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const typeConfig = {
  comment: {
    label: 'Comment',
    color: 'text-primary',
    bg: 'bg-primary/10',
    icon: (
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
      </svg>
    ),
  },
  suggestion: {
    label: 'Suggestion',
    color: 'text-success',
    bg: 'bg-success/10',
    icon: (
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
      </svg>
    ),
  },
  concern: {
    label: 'Concern',
    color: 'text-warning',
    bg: 'bg-warning/10',
    icon: (
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    ),
  },
};

export const ReviewPanel: React.FC<ReviewPanelProps> = ({
  isOpen,
  onToggle,
  annotations,
  files,
  selectedAnnotationId,
  onSelectAnnotation,
  onDeleteAnnotation,
  feedbackMarkdown,
}) => {
  const [copied, setCopied] = useState(false);

  const handleQuickCopy = async () => {
    if (!feedbackMarkdown) return;
    try {
      await navigator.clipboard.writeText(feedbackMarkdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy:', e);
    }
  };
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

  if (!isOpen) return null;

  return (
    <aside className="w-72 border-l border-border/50 bg-card/30 backdrop-blur-sm flex flex-col">
        {/* Header */}
        <div className="p-3 border-b border-border/50">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Annotations
            </h2>
            <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
              {annotations.length}
            </span>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
          {annotations.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-center px-4">
              <div className="w-10 h-10 rounded-full bg-muted/50 flex items-center justify-center mb-3">
                <svg className="w-5 h-5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
                </svg>
              </div>
              <p className="text-xs text-muted-foreground">
                Click on lines to add annotations
              </p>
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
                          {/* Author */}
                          {annotation.author && (
                            <div className={`flex items-center gap-1.5 text-[10px] font-mono truncate mb-1.5 ${isCurrentUser(annotation.author) ? 'text-muted-foreground/60' : 'text-muted-foreground'}`}>
                              <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                              </svg>
                              <span className="truncate">{annotation.author}{isCurrentUser(annotation.author) && ' (me)'}</span>
                            </div>
                          )}

                          {/* Type Badge + Line + Timestamp */}
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <div className={`flex items-center gap-1.5 ${typeConfig[annotation.type].color}`}>
                                <span className={`p-1 rounded ${typeConfig[annotation.type].bg}`}>
                                  {typeConfig[annotation.type].icon}
                                </span>
                                <span className="text-[10px] font-semibold uppercase tracking-wide">
                                  {typeConfig[annotation.type].label}
                                </span>
                              </div>
                              <span className="text-[10px] text-muted-foreground">
                                {annotation.lineStart === annotation.lineEnd
                                  ? `L${annotation.lineStart}`
                                  : `L${annotation.lineStart}-${annotation.lineEnd}`}
                              </span>
                            </div>
                            <span className="text-[10px] text-muted-foreground/50">
                              {formatTimestamp(annotation.createdAt)}
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
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
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

        {/* Quick Copy Footer */}
        {feedbackMarkdown && annotations.length > 0 && (
          <div className="p-2 border-t border-border/50">
            <button
              onClick={handleQuickCopy}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all text-muted-foreground hover:text-foreground hover:bg-muted/50"
            >
              {copied ? (
                <>
                  <svg className="w-3.5 h-3.5 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Copied
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  Copy Feedback
                </>
              )}
            </button>
          </div>
        )}
    </aside>
  );
};
