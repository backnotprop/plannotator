import React, { useState } from 'react';
import { ToolbarState } from '../hooks/useAnnotationToolbar';
import { useTabIndent } from '../hooks/useTabIndent';
import { formatLineRange } from '../utils/formatLineRange';
import { AskAIInput } from './AskAIInput';
import { SparklesIcon } from './SparklesIcon';
import type { AIChatEntry } from '../hooks/useAIChat';
import { dispatchShortcutEvent } from '@plannotator/ui/shortcuts';
import { reviewAnnotationToolbarShortcuts } from '../annotationToolbar.shortcuts';

interface AnnotationToolbarProps {
  toolbarState: ToolbarState;
  toolbarRef: React.RefObject<HTMLDivElement>;
  commentText: string;
  setCommentText: (text: string) => void;
  suggestedCode: string;
  setSuggestedCode: React.Dispatch<React.SetStateAction<string>>;
  showSuggestedCode: boolean;
  setShowSuggestedCode: (show: boolean) => void;
  isEditing?: boolean;
  setShowCodeModal: (show: boolean) => void;
  onSubmit: () => void;
  onDismiss: () => void;
  onCancel: () => void;
  // AI props
  aiAvailable?: boolean;
  onAskAI?: (question: string) => void;
  isAILoading?: boolean;
  onViewAIResponse?: (questionId?: string) => void;
  /** AI messages that overlap the current line selection */
  aiHistoryMessages?: AIChatEntry[];
}

/** Floating comment input form that appears after line selection */
export const AnnotationToolbar: React.FC<AnnotationToolbarProps> = ({
  toolbarState,
  toolbarRef,
  commentText,
  setCommentText,
  suggestedCode,
  setSuggestedCode,
  showSuggestedCode,
  setShowSuggestedCode,
  isEditing = false,
  setShowCodeModal,
  onSubmit,
  onDismiss,
  onCancel,
  aiAvailable = false,
  onAskAI,
  isAILoading = false,
  onViewAIResponse,
  aiHistoryMessages = [],
}) => {
  const handleTabIndent = useTabIndent(setSuggestedCode);
  const [askAIMode, setAskAIMode] = useState(false);

  const handleAskAIClick = () => {
    // If user already typed text in the comment box, send it directly as an AI question
    if (commentText.trim()) {
      onAskAI?.(commentText.trim());
      setCommentText('');
      setAskAIMode(true); // Switch to AI mode to show history/preview
    } else {
      setAskAIMode(true);
    }
  };

  const handleAskAISubmit = (question: string) => {
    onAskAI?.(question);
    // Stay in AI mode so the history updates
  };

  const handleAskAIClose = () => {
    setAskAIMode(false);
    onCancel(); // close the whole toolbar
  };

  return (
    <div
      ref={toolbarRef}
      className="review-toolbar"
      style={{
        position: 'fixed',
        top: Math.min(toolbarState.position.top, window.innerHeight - 200),
        left: Math.max(150, Math.min(toolbarState.position.left, window.innerWidth - 150)),
        transform: 'translateX(-50%)',
        zIndex: 1000,
      }}
    >
      {askAIMode ? (
        <AskAIInput
          lineStart={toolbarState.range.start}
          lineEnd={toolbarState.range.end}
          onSubmit={handleAskAISubmit}
          onCancel={handleAskAIClose}
          isLoading={isAILoading}
          aiHistory={aiHistoryMessages}
          onViewResponse={onViewAIResponse}
          onSwitchToComment={() => setAskAIMode(false)}
        />
      ) : (
        <div className="w-80">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-muted-foreground">
              {isEditing ? 'Edit annotation' : formatLineRange(toolbarState.range.start, toolbarState.range.end)}
            </span>
            <button
              onClick={onCancel}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              title="Cancel"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <textarea
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="Leave feedback..."
            className="w-full px-3 py-2 bg-muted rounded-lg text-xs resize-none focus:outline-none focus:ring-1 focus:ring-primary/50"
            rows={3}
            autoFocus
            onKeyDown={(e) => {
              dispatchShortcutEvent(reviewAnnotationToolbarShortcuts, {
                cancel: () => {
                  onDismiss();
                },
                submitComment: {
                  when: (event) => !event.isComposing,
                  handle: () => {
                    onSubmit();
                  },
                },
              }, e.nativeEvent);
            }}
          />

          {/* Optional suggested code section */}
          {showSuggestedCode ? (
            <div className="mt-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-muted-foreground">Suggested code</span>
                <button
                  onClick={() => setShowCodeModal(true)}
                  className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  title="Expand editor"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
                  </svg>
                </button>
              </div>
              <textarea
                value={suggestedCode}
                onChange={(e) => setSuggestedCode(e.target.value)}
                placeholder="Enter code suggestion..."
                className="suggested-code-input"
                rows={4}
                autoFocus
                spellCheck={false}
                onKeyDown={(e) => {
                  dispatchShortcutEvent(reviewAnnotationToolbarShortcuts, {
                    indentSuggestedCode: () => {
                      handleTabIndent(e);
                    },
                    submitComment: {
                      when: (event) => !event.isComposing,
                      handle: () => {
                        onSubmit();
                      },
                    },
                  }, e.nativeEvent);
                }}
              />
            </div>
          ) : (
            <button
              onClick={() => setShowSuggestedCode(true)}
              className="mt-2 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Add suggested code
            </button>
          )}

          <div className="flex items-center gap-2 mt-3">
            {/* Ask AI button — left side */}
            {aiAvailable && !isEditing && (
              <button
                onClick={handleAskAIClick}
                className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors"
                title={commentText.trim() ? 'Ask AI this question' : 'Switch to AI mode'}
              >
                <SparklesIcon className="w-3 h-3" />
                Ask AI
                {aiHistoryMessages.length > 0 && (
                  <span className="text-[9px] font-mono bg-muted px-1 py-0.5 rounded">
                    {aiHistoryMessages.length}
                  </span>
                )}
              </button>
            )}

            {/* Add Comment button — right side */}
            <button
              onClick={onSubmit}
              disabled={!commentText.trim() && !suggestedCode.trim()}
              className="review-toolbar-btn primary disabled:opacity-50 disabled:cursor-not-allowed ml-auto"
            >
              {isEditing ? 'Update' : 'Add Comment'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
