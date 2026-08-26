import React from 'react';
import { Dialog } from '@base-ui/react/dialog';
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
  const titleId = React.useId();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[1999] bg-black/60 backdrop-blur-sm" />
        <div className="pn-visible-viewport-overlay pointer-events-none z-[2000] flex items-center justify-center">
          <Dialog.Popup
            data-pn-secondary-input-dialog
            aria-modal="true"
            aria-labelledby={titleId}
            initialFocus={() => textareaRef.current}
            finalFocus={false}
            className="pn-suggestion-dialog pointer-events-auto relative flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
          >
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <Dialog.Title id={titleId} className="text-xs font-medium text-foreground">
                  Suggest Changes
                </Dialog.Title>
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
                  type="button"
                  onClick={() => setModalLayout(modalLayout === 'horizontal' ? 'vertical' : 'horizontal')}
                  className="pn-suggestion-layout-toggle rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  title={modalLayout === 'horizontal' ? 'Switch to vertical layout' : 'Switch to horizontal layout'}
                  aria-label={modalLayout === 'horizontal' ? 'Switch to vertical layout' : 'Switch to horizontal layout'}
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
                <Dialog.Close
                  render={
                    <button
                      type="button"
                      className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                      aria-label="Close code suggestion"
                    />
                  }
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </Dialog.Close>
              </div>
            </div>

            {/* Two-pane layout */}
            <div className={`pn-suggestion-panes flex min-h-0 flex-1 ${modalLayout === 'vertical' ? 'flex-col' : ''}`}>
              {/* Original code (read-only) */}
              <div className={`pn-suggestion-original flex min-h-0 min-w-0 flex-1 flex-col ${modalLayout === 'vertical' ? 'border-b border-border' : 'border-r border-border'}`}>
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
                  data-pn-mobile-editable
                  ref={textareaRef}
                  value={suggestedCode}
                  onChange={(e) => setSuggestedCode(e.target.value)}
                  placeholder={selectedOriginalCode || 'Enter code suggestion...'}
                  className="suggested-code-input flex-1 rounded-none border-0 min-h-[300px]"
                  spellCheck={false}
                  onKeyDown={(e) => {
                    if (e.key === 'Tab') {
                      handleTabIndent(e);
                    }
                  }}
                />
              </div>
            </div>

            {/* Footer */}
            <div className="flex shrink-0 items-center justify-between border-t border-border px-4 py-3">
              <span className="hidden text-[10px] text-muted-foreground sm:block">
                Tip: Edit the suggestion based on the original code on the left
              </span>
              <Dialog.Close
                render={<button type="button" className="review-toolbar-btn primary ml-auto" />}
              >
                Done
              </Dialog.Close>
            </div>
          </Dialog.Popup>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
