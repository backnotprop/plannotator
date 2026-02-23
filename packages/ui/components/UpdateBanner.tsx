import React, { useState } from 'react';
import { useUpdateCheck } from '../hooks/useUpdateCheck';

const INSTALL_COMMAND = 'curl -fsSL https://plannotator.ai/install.sh | bash';

interface UpdateBannerProps {
  origin?: 'claude-code' | 'opencode' | 'pi' | null;
}

export const UpdateBanner: React.FC<UpdateBannerProps> = ({ origin }) => {
  const updateInfo = useUpdateCheck();
  const [copied, setCopied] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Debug: ?preview-origin=opencode to test OpenCode-specific UI
  const urlParams = new URLSearchParams(window.location.search);
  const previewOrigin = urlParams.get('preview-origin');
  const effectiveOrigin = previewOrigin || origin;
  const isOpenCode = effectiveOrigin === 'opencode';

  if (!updateInfo?.updateAvailable || dismissed) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy:', e);
    }
  };

  const hasFeature = !!updateInfo.featureHighlight;

  // Expanded banner for milestone releases with feature highlights
  if (hasFeature) {
    return (
      <div className="fixed bottom-4 right-4 z-50 max-w-md animate-in slide-in-from-bottom-2 fade-in duration-300">
        <div className="bg-card border border-primary/30 rounded-xl shadow-2xl overflow-hidden">
          {/* Feature highlight header */}
          <div className="bg-gradient-to-r from-primary/20 to-primary/5 px-5 py-4 border-b border-border/50">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center">
                  <svg className="w-5 h-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                  </svg>
                </div>
                <div>
                  <h4 className="text-base font-semibold text-foreground">
                    {updateInfo.featureHighlight!.title}
                  </h4>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    New in {updateInfo.latestVersion}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setDismissed(true)}
                className="text-muted-foreground hover:text-foreground transition-colors p-1"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Feature description */}
          <div className="px-5 py-4">
            <p className="text-sm text-foreground/80 leading-relaxed">
              {updateInfo.featureHighlight!.description}
            </p>

            <p className="text-xs text-muted-foreground mt-3">
              You have {updateInfo.currentVersion}
            </p>

            {/* OpenCode extra instructions */}
            {isOpenCode && (
              <p className="text-xs text-muted-foreground mt-3">
                Run the install script, then restart OpenCode.
              </p>
            )}

            <div className="mt-4 flex items-center gap-2">
              <button
                onClick={handleCopy}
                className="flex-1 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity"
              >
                {copied ? 'Copied!' : 'Copy install command'}
              </button>
              <a
                href={updateInfo.releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground border border-border rounded-lg hover:bg-muted transition-colors"
              >
                Release notes
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Standard update banner
  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm animate-in slide-in-from-bottom-2 fade-in duration-300">
      <div className="bg-card border border-border rounded-lg shadow-xl p-4">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
            <svg className="w-4 h-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-medium text-foreground">
                Update available
              </h4>
              <button
                onClick={() => setDismissed(true)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {updateInfo.latestVersion} is available (you have {updateInfo.currentVersion})
            </p>
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={handleCopy}
                className="flex-1 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:opacity-90 transition-opacity"
              >
                {copied ? 'Copied!' : 'Copy install command'}
              </button>
              <a
                href={updateInfo.releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground border border-border rounded-md hover:bg-muted transition-colors"
              >
                Notes
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
