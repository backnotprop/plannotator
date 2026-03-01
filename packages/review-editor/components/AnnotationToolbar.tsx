import React from 'react';
import { ToolbarState } from '../hooks/useAnnotationToolbar';
import { useTabIndent } from '../hooks/useTabIndent';
import { formatLineRange } from '../utils/formatLineRange';

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
}) => {
  const handleTabIndent = useTabIndent(setSuggestedCode);

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
            if (e.key === 'Escape') {
              onDismiss();
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
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
                } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  onSubmit();
                }
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

        <div className="flex justify-end gap-2 mt-3">
          <button
            onClick={onSubmit}
            disabled={!commentText.trim() && !suggestedCode.trim()}
            className="review-toolbar-btn primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isEditing ? 'Update' : 'Add Comment'}
          </button>
        </div>
      </div>
    </div>
  );
};
