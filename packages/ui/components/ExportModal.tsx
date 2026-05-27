/**
 * Export Modal with tabs for Share and Annotations
 *
 * Share tab (default): Shows shareable URL with copy button
 * Annotations tab: Shows human-readable annotations output with copy/download
 */

import React, { useState, useEffect } from 'react';
import { wrapFeedbackForAgent } from '../utils/parser';
import { OverlayScrollArea } from './OverlayScrollArea';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  shareUrl: string;
  shareUrlSize: string;
  /** Short share URL from the paste service (empty string when unavailable) */
  shortShareUrl?: string;
  /** Whether the short URL is currently being generated */
  isGeneratingShortUrl?: boolean;
  /** Error from the last short URL generation attempt (empty string = no error) */
  shortUrlError?: string;
  /** Generate a short URL on demand (user clicks "Create short link") */
  onGenerateShortUrl?: () => void;
  annotationsOutput: string;
  annotationCount: number;
  taterSprite?: React.ReactNode;
  sharingEnabled?: boolean;
  markdown?: string;
  isApiMode?: boolean;
  initialTab?: Tab;
}

type Tab = 'share' | 'annotations';

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  shareUrl,
  shareUrlSize,
  shortShareUrl = '',
  isGeneratingShortUrl = false,
  shortUrlError = '',
  onGenerateShortUrl,
  annotationsOutput,
  annotationCount,
  taterSprite,
  sharingEnabled = true,
  initialTab,
}) => {
  const defaultTab = initialTab || (sharingEnabled ? 'share' : 'annotations');
  const [activeTab, setActiveTab] = useState<Tab>(defaultTab);
  const [copied, setCopied] = useState<'short' | 'full' | 'annotations' | false>(false);

  // Reset tab when modal opens
  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab || (sharingEnabled ? 'share' : 'annotations'));
    }
  }, [isOpen, initialTab, sharingEnabled]);

  if (!isOpen) return null;

  const handleCopy = async (text: string, which: 'short' | 'full' | 'annotations') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy:', e);
    }
  };

  const handleCopyAnnotations = async () => {
    await handleCopy(wrapFeedbackForAgent(annotationsOutput), 'annotations');
  };

  // Whether the hash URL is large enough to warrant a short URL option
  const urlIsLarge = shareUrl.length > 2048;
  // Hash-based sharing unavailable (e.g. HTML render mode) — show only short link
  const hashUnavailable = !shareUrl && !!onGenerateShortUrl;

  const handleDownloadAnnotations = () => {
    const blob = new Blob([annotationsOutput], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'annotations.md';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Determine which tabs to show
  const showTabs = sharingEnabled;

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
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Body */}
        <OverlayScrollArea className="flex-1 min-h-0">
        <div className="p-4">
          {/* Tabs */}
          {showTabs && (
            <div className="flex gap-1 bg-muted rounded-lg p-1 mb-4">
              {sharingEnabled && (
                <button
                  onClick={() => setActiveTab('share')}
                  className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    activeTab === 'share'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Share
                </button>
              )}
              <button
                onClick={() => setActiveTab('annotations')}
                className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  activeTab === 'annotations'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Annotations
              </button>
            </div>
          )}

          {/* Tab content */}
          {activeTab === 'share' && sharingEnabled ? (
            <div className="space-y-4">
              {/* Short URL — primary copy target when available */}
              {shortShareUrl ? (
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-2">
                    Share Link
                  </label>
                  <div className="relative group">
                    <input
                      readOnly
                      value={shortShareUrl}
                      className="w-full bg-muted rounded-lg p-3 pr-20 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-accent/50"
                      onClick={e => (e.target as HTMLInputElement).select()}
                    />
                    <button
                      onClick={() => handleCopy(shortShareUrl, 'short')}
                      className="absolute top-1.5 right-2 px-2 py-1 rounded text-xs font-medium bg-background/80 hover:bg-background border border-border/50 transition-colors flex items-center gap-1"
                    >
                      {copied === 'short' ? (
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
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Encrypted short link. Your plan is end-to-end encrypted before it leaves your browser — not even the server can read it.
                  </p>
                </div>
              ) : isGeneratingShortUrl ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground p-3 bg-muted rounded-lg">
                  <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4m-3.93 7.07l-2.83-2.83M7.76 7.76L4.93 4.93" />
                  </svg>
                  Generating short link...
                </div>
              ) : (urlIsLarge || hashUnavailable) && onGenerateShortUrl ? (
                <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                  {!hashUnavailable && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mb-2">
                      This URL may be too long for some messaging apps.
                    </p>
                  )}
                  <button
                    onClick={onGenerateShortUrl}
                    className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
                  >
                    Create short link
                  </button>
                  {shortUrlError && (
                    <p className="text-[10px] text-amber-500 mt-1">({shortUrlError})</p>
                  )}
                </div>
              ) : null}

              {/* Full hash URL — hidden when hash-based sharing is unavailable (HTML mode) */}
              {!hashUnavailable && <div>
                <label className="block text-xs font-medium text-muted-foreground mb-2">
                  {shortShareUrl ? 'Full URL (backup)' : 'Shareable URL'}
                </label>
                <div className="relative group">
                  <textarea
                    readOnly
                    value={shareUrl}
                    className="w-full h-24 bg-muted rounded-lg p-3 pr-20 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-accent/50"
                    onClick={e => (e.target as HTMLTextAreaElement).select()}
                  />
                  <button
                    onClick={() => handleCopy(shareUrl, 'full')}
                    className="absolute top-2 right-2 px-2 py-1 rounded text-xs font-medium bg-background/80 hover:bg-background border border-border/50 transition-colors flex items-center gap-1"
                  >
                    {copied === 'full' ? (
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
                {!shortShareUrl && !isGeneratingShortUrl && !urlIsLarge && (
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Your plan is encoded entirely in the URL — it never touches a server.
                  </p>
                )}
              </div>}

              <p className="text-xs text-muted-foreground">
                Only someone with this exact link can view your plan. Short links are end-to-end encrypted — the decryption key is in the URL and never sent to the server.
              </p>
            </div>
          ) : (
            <pre className="bg-muted rounded-lg p-4 text-xs font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap">
              {annotationsOutput}
            </pre>
          )}
        </div>
        </OverlayScrollArea>

        {/* Footer actions - only show for Annotations tab */}
        {activeTab === 'annotations' && (
          <div className="p-4 border-t border-border flex justify-end gap-2">
            <button
              onClick={handleCopyAnnotations}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-muted hover:bg-muted/80 transition-colors"
            >
              {copied === 'annotations' ? 'Copied!' : 'Copy'}
            </button>
            <button
              onClick={handleDownloadAnnotations}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
            >
              Download Annotations
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
