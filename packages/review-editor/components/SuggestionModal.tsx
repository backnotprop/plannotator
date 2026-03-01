import React from 'react';
import { HighlightedCode } from './HighlightedCode';
import { ToolbarState } from '../hooks/useAnnotationToolbar';
import { useTabIndent } from '../hooks/useTabIndent';
import { detectLanguage } from '../utils/detectLanguage';

interface SuggestionModalProps {
  filePath: string;
  toolbarState: ToolbarState | null;
  selectedOriginalCode: string;
  suggestedCode: string;
  setSuggestedCode: React.Dispatch<React.SetStateAction<string>>;
  modalLayout: 'horizontal' | 'vertical';
  setModalLayout: (layout: 'horizontal' | 'vertical') => void;
  onClose: () => void;
}

/** Expanded two-pane code editor modal for writing suggestions */
export const SuggestionModal: React.FC<SuggestionModalProps> = ({
  filePath,
  toolbarState,
  selectedOriginalCode,
  suggestedCode,
  setSuggestedCode,
  modalLayout,
  setModalLayout,
  onClose,
}) => {
  const language = detectLanguage(filePath);
  const handleTabIndent = useTabIndent(setSuggestedCode);

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-[960px] max-w-[95vw] max-h-[85vh] flex flex-col bg-popover border border-border rounded-xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-foreground">Suggest Changes</span>
            {language && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                {language}
              </span>
            )}
            {toolbarState && (
              <span className="text-[10px] font-mono text-muted-foreground">
                L{Math.min(toolbarState.range.start, toolbarState.range.end)}
                {toolbarState.range.start !== toolbarState.range.end &&
                  `-${Math.max(toolbarState.range.start, toolbarState.range.end)}`}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {/* Layout toggle */}
            <button
              onClick={() => setModalLayout(modalLayout === 'horizontal' ? 'vertical' : 'horizontal')}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              title={modalLayout === 'horizontal' ? 'Switch to vertical layout' : 'Switch to horizontal layout'}
            >
              {modalLayout === 'horizontal' ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4h16v7H4zM4 13h16v7H4z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4h7v16H4zM13 4h7v16h-7z" />
                </svg>
              )}
            </button>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Two-pane layout */}
        <div className={`flex flex-1 min-h-0 ${modalLayout === 'vertical' ? 'flex-col' : ''}`}>
          {/* Original code (read-only) */}
          <div className={`flex-1 flex flex-col min-w-0 min-h-0 ${modalLayout === 'vertical' ? 'border-b border-border' : 'border-r border-border'}`}>
            <div className="px-3 py-1.5 border-b border-border/50 bg-muted/30">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Original</span>
            </div>
            <pre className="flex-1 overflow-auto p-3 m-0 text-xs leading-relaxed suggestion-modal-original">
              <HighlightedCode code={selectedOriginalCode || '(no lines selected)'} language={language} />
            </pre>
          </div>

          {/* Suggested code input */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <div className="px-3 py-1.5 border-b border-border/50 bg-muted/30">
              <span className="text-[10px] font-medium text-success uppercase tracking-wider">Suggestion</span>
            </div>
            <textarea
              value={suggestedCode}
              onChange={(e) => setSuggestedCode(e.target.value)}
              placeholder={selectedOriginalCode || 'Enter code suggestion...'}
              className="suggested-code-input flex-1 rounded-none border-0 min-h-[300px]"
              autoFocus
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  onClose();
                } else if (e.key === 'Tab') {
                  handleTabIndent(e);
                }
              }}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border">
          <span className="text-[10px] text-muted-foreground">Tip: Edit the suggestion based on the original code on the left</span>
          <button
            onClick={onClose}
            className="review-toolbar-btn primary"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
