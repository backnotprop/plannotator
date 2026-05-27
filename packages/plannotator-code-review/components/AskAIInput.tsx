import React, { useState } from 'react';
import { formatLineRange } from '../utils/formatLineRange';
import { SparklesIcon } from './SparklesIcon';
import type { AIChatEntry } from '../hooks/useAIChat';
import { submitHint } from '@plannotator/ui/utils/platform';

interface AskAIInputProps {
  lineStart: number;
  lineEnd: number;
  onSubmit: (question: string) => void;
  onCancel: () => void;
  isLoading: boolean;
  /** Pre-filled text from the comment textarea */
  initialText?: string;
  /** AI messages that overlap the current line selection */
  aiHistory: AIChatEntry[];
  onViewResponse?: (questionId: string) => void;
  /** Toggle back to comment mode */
  onSwitchToComment?: () => void;
  /** Props to make the header a drag handle */
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement> & { style?: React.CSSProperties };
}

export const AskAIInput: React.FC<AskAIInputProps> = ({
  lineStart,
  lineEnd,
  onSubmit,
  onCancel,
  isLoading,
  initialText = '',
  aiHistory,
  onViewResponse,
  onSwitchToComment,
  dragHandleProps,
}) => {
  const [question, setQuestion] = useState(initialText);

  const handleSubmit = () => {
    if (!question.trim() || isLoading) return;
    onSubmit(question.trim());
    setQuestion('');
  };

  return (
    <div className="w-80">
      <div className="flex items-center justify-between mb-2" {...dragHandleProps}>
        <span className="text-xs text-muted-foreground flex items-center gap-1.5">
          <SparklesIcon className="w-3 h-3 text-primary" />
          Ask AI · {formatLineRange(lineStart, lineEnd)}
        </span>
        <button
          onClick={onCancel}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          title="Close"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <textarea
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Ask about this code..."
        className="w-full px-3 py-2 bg-muted rounded-lg text-xs resize-none focus:outline-none focus:ring-1 focus:ring-primary/50"
        rows={2}
        autoFocus
        disabled={isLoading}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onCancel();
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
            handleSubmit();
          }
        }}
      />

      <div className="flex items-center gap-2 mt-2">
        {/* Comment toggle — left side, mirrors Ask AI position in comment mode */}
        {onSwitchToComment && (
          <button
            onClick={onSwitchToComment}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
            </svg>
            Comment
          </button>
        )}

        {/* Ask button — right side */}
        <button
          onClick={handleSubmit}
          disabled={!question.trim() || isLoading}
          className="review-toolbar-btn primary disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 ml-auto"
          title={`Ask (${submitHint})`}
        >
          {isLoading ? (
            <>
              <span className="ai-streaming-cursor" />
              Asking...
            </>
          ) : (
            <>
              <SparklesIcon className="w-3 h-3" />
              Ask
            </>
          )}
        </button>
      </div>

      {/* Previous AI questions on these lines */}
      {aiHistory.length > 0 && (
        <div className="mt-2 pt-2 border-t border-border/30 space-y-1.5 max-h-40 overflow-y-auto">
          {aiHistory.map(({ question: q, response: r }) => (
            <button
              key={q.id}
              onClick={() => onViewResponse?.(q.id)}
              className="w-full text-left p-1.5 rounded border border-border/50 hover:border-primary/30 hover:bg-primary/5 transition-colors"
            >
              <p className="text-[10px] text-muted-foreground truncate">{q.prompt}</p>
              {r.text && (
                <p className="text-[10px] text-foreground/60 truncate mt-0.5">
                  {r.text.slice(0, 80)}
                </p>
              )}
              {r.isStreaming && (
                <span className="ai-streaming-cursor inline-block ml-0.5" style={{ width: '0.25rem', height: '0.5rem' }} />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
