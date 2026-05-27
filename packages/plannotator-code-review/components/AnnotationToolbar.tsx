import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ToolbarState } from '../hooks/useAnnotationToolbar';
import { useTabIndent } from '../hooks/useTabIndent';
import { formatLineRange, formatTokenContext } from '../utils/formatLineRange';
import { AskAIInput } from './AskAIInput';
import { SparklesIcon } from './SparklesIcon';
import { ConventionalLabelPicker, type LabelDef } from './ConventionalLabelPicker';
import type { ConventionalLabel, ConventionalDecoration } from '@plannotator/ui/types';
import type { AIChatEntry } from '../hooks/useAIChat';
import { useDraggable } from '@plannotator/ui/hooks/useDraggable';

interface AnnotationToolbarProps {
  toolbarState: ToolbarState;
  toolbarRef: React.RefObject<HTMLDivElement>;
  commentText: string;
  setCommentText: (text: string) => void;
  suggestedCode: string;
  setSuggestedCode: React.Dispatch<React.SetStateAction<string>>;
  showSuggestedCode: boolean;
  setShowSuggestedCode: (show: boolean) => void;
  selectedOriginalCode?: string;
  isEditing?: boolean;
  setShowCodeModal: (show: boolean) => void;
  onSubmit: () => void;
  onDismiss: () => void;
  onCancel: () => void;
  // Conventional Comments
  conventionalCommentsEnabled: boolean;
  conventionalLabel: ConventionalLabel | null;
  onConventionalLabelChange: (label: ConventionalLabel | null) => void;
  decorations: ConventionalDecoration[];
  onDecorationsChange: (decorations: ConventionalDecoration[]) => void;
  enabledLabels?: LabelDef[];
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
  selectedOriginalCode,
  isEditing = false,
  setShowCodeModal,
  onSubmit,
  onDismiss,
  onCancel,
  conventionalCommentsEnabled,
  conventionalLabel,
  onConventionalLabelChange,
  decorations,
  onDecorationsChange,
  enabledLabels,
  aiAvailable = false,
  onAskAI,
  isAILoading = false,
  onViewAIResponse,
  aiHistoryMessages = [],
}) => {
  const suggestedCodeRef = useRef<HTMLTextAreaElement>(null);
  const handleTabIndent = useTabIndent(setSuggestedCode);
  const [askAIMode, setAskAIMode] = useState(false);
  const { dragPosition, dragHandleProps, wasDragged, reset: resetDrag } = useDraggable(toolbarRef);

  // Reset drag when toolbar reopens for a new selection
  useEffect(() => {
    resetDrag();
  }, [toolbarState.range.start, toolbarState.range.end, toolbarState.range.side, resetDrag]);

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

  const content = (
    <div
      ref={toolbarRef}
      className="review-toolbar"
      style={dragPosition
        ? { position: 'fixed', top: dragPosition.top, left: dragPosition.left, zIndex: 1000 }
        : {
            position: 'fixed',
            top: Math.min(toolbarState.position.top, window.innerHeight - 200),
            left: Math.max(150, Math.min(toolbarState.position.left, window.innerWidth - 150)),
            transform: 'translateX(-50%)',
            zIndex: 1000,
          }
      }
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
          dragHandleProps={dragHandleProps}
        />
      ) : (
        <div className="w-80">
          <div className="flex items-center justify-between mb-2" {...dragHandleProps}>
            <span className="text-xs text-muted-foreground">
              {isEditing
                ? 'Edit annotation'
                : toolbarState.tokenSelection
                  ? formatTokenContext(toolbarState.tokenSelection)
                  : formatLineRange(toolbarState.range.start, toolbarState.range.end)}
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

          {conventionalCommentsEnabled && (
            <ConventionalLabelPicker
              selected={conventionalLabel}
              decorations={decorations}
              onSelect={onConventionalLabelChange}
              onDecorationsChange={onDecorationsChange}
              enabledLabels={enabledLabels}
            />
          )}

          <textarea
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="Leave feedback..."
            className="w-full px-3 py-2 bg-muted rounded-lg text-xs resize-none focus:outline-none focus:ring-1 focus:ring-primary/50"
            rows={3}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                onDismiss();
              } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                onSubmit();
              }
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
                ref={suggestedCodeRef}
                value={suggestedCode}
                onChange={(e) => setSuggestedCode(e.target.value)}
                placeholder="Enter code suggestion..."
                className="suggested-code-input"
                rows={4}
                autoFocus
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === 'Tab') {
                    handleTabIndent(e);
                  } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                    onSubmit();
                  }
                }}
              />
            </div>
          ) : (
            <button
              onClick={() => {
                setShowSuggestedCode(true);

                const prefill = !suggestedCode && selectedOriginalCode;
                if (prefill) {
                  setSuggestedCode(selectedOriginalCode);

                  // Focus at the end of the textarea
                  requestAnimationFrame(() => {
                    const ta = suggestedCodeRef.current;
                    if (ta) {
                      ta.setSelectionRange(ta.value.length, ta.value.length);
                    }
                  });
                }
              }}
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

  if (typeof document === 'undefined') {
    return content;
  }

  return createPortal(content, document.body);
};
