/**
 * Export Modal with tabs for Share, Raw Diff, and Notes
 *
 * Share tab (default): Shows shareable URL with copy button
 * Raw Diff tab: Shows human-readable diff output with copy/download
 * Notes tab: Save plan to Obsidian/Bear without approving
 */

import React, { useState, useEffect } from 'react';
import { getObsidianSettings, getEffectiveVaultPath } from '../utils/obsidian';
import { getBearSettings } from '../utils/bear';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  shareUrl: string;
  shareUrlSize: string;
  diffOutput: string;
  annotationCount: number;
  taterSprite?: React.ReactNode;
  sharingEnabled?: boolean;
  markdown?: string;
  isApiMode?: boolean;
  initialTab?: Tab;
}

type Tab = 'share' | 'diff' | 'notes';

type SaveTarget = 'obsidian' | 'bear';
type SaveStatus = 'idle' | 'saving' | 'success' | 'error';

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  shareUrl,
  shareUrlSize,
  diffOutput,
  annotationCount,
  taterSprite,
  sharingEnabled = true,
  markdown,
  isApiMode = false,
  initialTab,
}) => {
  const defaultTab = initialTab || (sharingEnabled ? 'share' : 'diff');
  const [activeTab, setActiveTab] = useState<Tab>(defaultTab);
  const [copied, setCopied] = useState(false);
  const [saveStatus, setSaveStatus] = useState<Record<SaveTarget, SaveStatus>>({ obsidian: 'idle', bear: 'idle' });
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});

  // Reset tab when modal opens
  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab || (sharingEnabled ? 'share' : 'diff'));
    }
  }, [isOpen, initialTab, sharingEnabled]);

  // Reset save status when modal opens
  useEffect(() => {
    if (isOpen) {
      setSaveStatus({ obsidian: 'idle', bear: 'idle' });
      setSaveErrors({});
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const showNotesTab = isApiMode && !!markdown;
  const obsidianSettings = getObsidianSettings();
  const bearSettings = getBearSettings();
  const effectiveVaultPath = getEffectiveVaultPath(obsidianSettings);
  const isObsidianReady = obsidianSettings.enabled && effectiveVaultPath.trim().length > 0;
  const isBearReady = bearSettings.enabled;

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

  const handleSaveToNotes = async (target: SaveTarget) => {
    if (!markdown) return;

    setSaveStatus(prev => ({ ...prev, [target]: 'saving' }));
    setSaveErrors(prev => { const next = { ...prev }; delete next[target]; return next; });

    const body: { obsidian?: object; bear?: object } = {};

    if (target === 'obsidian') {
      body.obsidian = {
        vaultPath: effectiveVaultPath,
        folder: obsidianSettings.folder || 'plannotator',
        plan: markdown,
      };
    }
    if (target === 'bear') {
      body.bear = { plan: markdown };
    }

    try {
      const res = await fetch('/api/save-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      const result = data.results?.[target];

      if (result?.success) {
        setSaveStatus(prev => ({ ...prev, [target]: 'success' }));
      } else {
        setSaveStatus(prev => ({ ...prev, [target]: 'error' }));
        setSaveErrors(prev => ({ ...prev, [target]: result?.error || 'Save failed' }));
      }
    } catch {
      setSaveStatus(prev => ({ ...prev, [target]: 'error' }));
      setSaveErrors(prev => ({ ...prev, [target]: 'Save failed' }));
    }
  };

  const handleSaveAll = async () => {
    const targets: SaveTarget[] = [];
    if (isObsidianReady) targets.push('obsidian');
    if (isBearReady) targets.push('bear');
    await Promise.all(targets.map(t => handleSaveToNotes(t)));
  };

  // Determine which tabs to show
  const showTabs = sharingEnabled || showNotesTab;

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
        <div className="flex-1 overflow-auto p-4">
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
                onClick={() => setActiveTab('diff')}
                className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  activeTab === 'diff'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Raw Diff
              </button>
              {showNotesTab && (
                <button
                  onClick={() => setActiveTab('notes')}
                  className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    activeTab === 'notes'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Notes
                </button>
              )}
            </div>
          )}

          {/* Tab content */}
          {activeTab === 'share' && sharingEnabled ? (
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
          ) : activeTab === 'notes' && showNotesTab ? (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Save this plan to your notes app without approving or denying.
              </p>

              {/* Obsidian */}
              <div className="border border-border rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${isObsidianReady ? 'bg-success' : 'bg-muted-foreground/30'}`} />
                    <span className="text-sm font-medium">Obsidian</span>
                  </div>
                  {isObsidianReady ? (
                    <button
                      onClick={() => handleSaveToNotes('obsidian')}
                      disabled={saveStatus.obsidian === 'saving'}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                        saveStatus.obsidian === 'success'
                          ? 'bg-success/15 text-success'
                          : saveStatus.obsidian === 'error'
                            ? 'bg-destructive/15 text-destructive'
                            : saveStatus.obsidian === 'saving'
                              ? 'bg-muted text-muted-foreground opacity-50'
                              : 'bg-primary text-primary-foreground hover:opacity-90'
                      }`}
                    >
                      {saveStatus.obsidian === 'saving' ? 'Saving...'
                        : saveStatus.obsidian === 'success' ? 'Saved'
                        : saveStatus.obsidian === 'error' ? 'Failed'
                        : 'Save'}
                    </button>
                  ) : (
                    <span className="text-xs text-muted-foreground">Not configured</span>
                  )}
                </div>
                {isObsidianReady && (
                  <div className="text-[10px] text-muted-foreground/70">
                    {effectiveVaultPath}/{obsidianSettings.folder || 'plannotator'}/
                  </div>
                )}
                {!isObsidianReady && (
                  <div className="text-[10px] text-muted-foreground/70">
                    Enable in Settings &gt; Saving &gt; Obsidian
                  </div>
                )}
                {saveErrors.obsidian && (
                  <div className="text-[10px] text-destructive">{saveErrors.obsidian}</div>
                )}
              </div>

              {/* Bear */}
              <div className="border border-border rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${isBearReady ? 'bg-success' : 'bg-muted-foreground/30'}`} />
                    <span className="text-sm font-medium">Bear</span>
                  </div>
                  {isBearReady ? (
                    <button
                      onClick={() => handleSaveToNotes('bear')}
                      disabled={saveStatus.bear === 'saving'}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                        saveStatus.bear === 'success'
                          ? 'bg-success/15 text-success'
                          : saveStatus.bear === 'error'
                            ? 'bg-destructive/15 text-destructive'
                            : saveStatus.bear === 'saving'
                              ? 'bg-muted text-muted-foreground opacity-50'
                              : 'bg-primary text-primary-foreground hover:opacity-90'
                      }`}
                    >
                      {saveStatus.bear === 'saving' ? 'Saving...'
                        : saveStatus.bear === 'success' ? 'Saved'
                        : saveStatus.bear === 'error' ? 'Failed'
                        : 'Save'}
                    </button>
                  ) : (
                    <span className="text-xs text-muted-foreground">Not configured</span>
                  )}
                </div>
                {!isBearReady && (
                  <div className="text-[10px] text-muted-foreground/70">
                    Enable in Settings &gt; Saving &gt; Bear
                  </div>
                )}
                {saveErrors.bear && (
                  <div className="text-[10px] text-destructive">{saveErrors.bear}</div>
                )}
              </div>

              {/* Save All button */}
              {isObsidianReady && isBearReady && (
                <div className="flex justify-end">
                  <button
                    onClick={handleSaveAll}
                    disabled={saveStatus.obsidian === 'saving' || saveStatus.bear === 'saving'}
                    className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    Save All
                  </button>
                </div>
              )}
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
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-muted hover:bg-muted/80 transition-colors"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button
              onClick={handleDownloadDiff}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
            >
              Download .diff
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
