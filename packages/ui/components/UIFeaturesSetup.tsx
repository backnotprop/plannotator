import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  saveUIPreferences,
  markUIFeaturesSetupDone,
  type UIPreferences,
} from '../utils/uiPreferences';

const PREVIEW_IMAGE_URL = 'https://plannotator.ai/assets/toc-sticky-preview.png';

interface UIFeaturesSetupProps {
  isOpen: boolean;
  onComplete: (prefs: UIPreferences) => void;
}

export const UIFeaturesSetup: React.FC<UIFeaturesSetupProps> = ({
  isOpen,
  onComplete,
}) => {
  const [tocEnabled, setTocEnabled] = useState(true);
  const [stickyActionsEnabled, setStickyActionsEnabled] = useState(true);
  const [imageLoaded, setImageLoaded] = useState(true);

  if (!isOpen) return null;

  const handleConfirm = () => {
    const prefs: UIPreferences = { tocEnabled, stickyActionsEnabled };
    saveUIPreferences(prefs);
    markUIFeaturesSetupDone();
    onComplete(prefs);
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/90 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-xl w-full max-w-lg shadow-2xl">
        {/* Header */}
        <div className="p-5 border-b border-border">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 rounded-lg bg-primary/15">
              <svg className="w-5 h-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
              </svg>
            </div>
            <h3 className="font-semibold text-base">New: Display Options</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            We've added two features that help navigate larger plans.
          </p>
        </div>

        {/* Preview + Options */}
        <div className="p-4 space-y-4">
          {imageLoaded && (
            <img
              src={PREVIEW_IMAGE_URL}
              alt="Table of Contents and Sticky Actions preview"
              className="w-full rounded-lg border border-border"
              onError={() => setImageLoaded(false)}
            />
          )}

          <label className="flex items-start gap-3 p-3 rounded-lg cursor-pointer border border-transparent bg-muted/50 hover:bg-muted transition-all">
            <input
              type="checkbox"
              checked={tocEnabled}
              onChange={() => setTocEnabled(!tocEnabled)}
              className="mt-0.5 accent-primary"
            />
            <div className="flex-1">
              <div className="text-sm font-medium">Table of Contents</div>
              <div className="text-xs text-muted-foreground">Show sidebar navigation on desktop</div>
            </div>
          </label>

          <label className="flex items-start gap-3 p-3 rounded-lg cursor-pointer border border-transparent bg-muted/50 hover:bg-muted transition-all">
            <input
              type="checkbox"
              checked={stickyActionsEnabled}
              onChange={() => setStickyActionsEnabled(!stickyActionsEnabled)}
              className="mt-0.5 accent-primary"
            />
            <div className="flex-1">
              <div className="text-sm font-medium">Sticky Actions</div>
              <div className="text-xs text-muted-foreground">Keep action buttons visible while scrolling</div>
            </div>
          </label>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border flex justify-between items-center">
          <p className="text-xs text-muted-foreground">
            You can change this later in Settings.
          </p>
          <button
            onClick={handleConfirm}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Save Settings
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
