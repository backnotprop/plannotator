/**
 * Export Modal with tabs for Share and Raw Diff
 *
 * Share tab (default): Shows shareable URL with copy button
 * Raw Diff tab: Shows human-readable diff output with copy/download
 */

import React, { useState } from 'react';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  shareUrl: string;
  shareUrlSize: string;
  diffOutput: string;
  annotationCount: number;
  taterSprite?: React.ReactNode;
}

type Tab = 'share' | 'diff';

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  shareUrl,
  shareUrlSize,
  diffOutput,
  annotationCount,
  taterSprite,
}) => {
  const [activeTab, setActiveTab] = useState<Tab>('share');
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy:', e);
    }
  };

  const handleCopyDiff = async () => {
    try {
      await navigator.clipboard.writeText(diffOutput);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy:', e);
    }
  };

  const handleDownloadDiff = () => {
    const blob = new Blob([diffOutput], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'annotations.diff';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div
        className="bg-card border border-border rounded-xl w-full max-w-2xl flex flex-col max-h-[80vh] shadow-2xl relative"
        onClick={e => e.stopPropagation()}
      >
        {taterSprite}

        {/* Header */}
        <div className="p-4 border-b border-border">
          <div className="flex justify-between items-center">
            <h3 className="font-semibold text-sm">Export</h3>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                {annotationCount} annotation{annotationCount !== 1 ? 's' : ''}
              </span>
              <button
                onClick={onClose}
                className="p-1.5 rounded-sm hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-4">
          {/* Tabs */}
          <div className="flex gap-1 bg-muted rounded-lg p-1 mb-4">
            <button
              onClick={() => setActiveTab('share')}
              className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-sm transition-colors ${
                activeTab === 'share'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Share
            </button>
            <button
              onClick={() => setActiveTab('diff')}
              className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-sm transition-colors ${
                activeTab === 'diff'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Raw Diff
            </button>
          </div>

          {/* Tab content */}
          {activeTab === 'share' ? (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-2">
                  Shareable URL
                </label>
                <div className="relative group">
                  <textarea
                    readOnly
                    value={shareUrl}
                    className="w-full h-32 bg-muted rounded-lg p-3 pr-20 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-accent/50"
                    onClick={e => (e.target as HTMLTextAreaElement).select()}
                  />
                  <button
                    onClick={handleCopyUrl}
                    className="absolute top-2 right-2 px-2 py-1 rounded text-xs font-medium bg-background/80 hover:bg-background border border-border/50 transition-colors flex items-center gap-1"
                  >
                    {copied ? (
                      <>
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                        Copied
                      </>
                    ) : (
                      <>
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                        Copy
                      </>
                    )}
                  </button>
                  <div className="absolute bottom-2 right-2 text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                    {shareUrlSize}
                  </div>
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                This URL contains the full plan and all annotations. Anyone with this link can view and add to your annotations.
              </p>
            </div>
          ) : (
            <pre className="bg-muted rounded-lg p-4 text-xs font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap">
              {diffOutput}
            </pre>
          )}
        </div>

        {/* Footer actions - only show for Raw Diff tab */}
        {activeTab === 'diff' && (
          <div className="p-4 border-t border-border flex justify-end gap-2">
            <button
              onClick={handleCopyDiff}
              className="px-3 py-1.5 rounded-sm text-xs font-medium bg-muted hover:bg-muted/80 transition-colors"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button
              onClick={handleDownloadDiff}
              className="px-3 py-1.5 rounded-sm text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
            >
              Download .diff
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
