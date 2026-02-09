/**
 * Import Modal for loading teammate annotations from a share URL
 */

import React, { useState, useRef } from 'react';
import type { ImportResult } from '../hooks/useSharing';

interface ImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (url: string) => Promise<ImportResult>;
}

export const ImportModal: React.FC<ImportModalProps> = ({
  isOpen,
  onClose,
  onImport,
}) => {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const autoCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!isOpen) return null;

  const handleImport = async () => {
    if (!url.trim()) return;
    setLoading(true);
    setResult(null);
    const res = await onImport(url.trim());
    setResult(res);
    setLoading(false);
    if (res.success && res.count > 0) {
      // Auto-close after successful import
      autoCloseTimer.current = setTimeout(() => {
        autoCloseTimer.current = null;
        setUrl('');
        setResult(null);
        onClose();
      }, 1500);
    }
  };

  const handleClose = () => {
    if (autoCloseTimer.current) {
      clearTimeout(autoCloseTimer.current);
      autoCloseTimer.current = null;
    }
    setUrl('');
    setResult(null);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !loading) {
      handleImport();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div
        className="bg-card border border-border rounded-xl w-full max-w-lg flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 border-b border-border">
          <div className="flex justify-between items-center">
            <h3 className="font-semibold text-sm">Import Teammate Review</h3>
            <button
              onClick={handleClose}
              className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-2">
              Plannotator Share Link
            </label>
            <input
              type="text"
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="https://share.plannotator.ai/#..."
              className="w-full bg-muted rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-accent/50"
              disabled={loading}
              autoFocus
            />
          </div>

          <p className="text-xs text-muted-foreground">
            Paste a share link from a teammate to import their annotations into the current plan review.
          </p>

          {/* Result feedback */}
          {result && (
            <div className={`rounded-lg px-3 py-2 text-xs ${
              result.success && result.count > 0
                ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                : result.success && result.count === 0
                ? 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400'
                : 'bg-destructive/10 text-destructive'
            }`}>
              {result.success && result.count > 0 && (
                <span>Imported {result.count} annotation{result.count !== 1 ? 's' : ''} from "{result.planTitle}"</span>
              )}
              {result.success && result.count === 0 && (
                <span>{result.error || 'No new annotations to import (all already exist)'}</span>
              )}
              {!result.success && (
                <span>{result.error || 'Failed to import'}</span>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border flex justify-end gap-2">
          <button
            onClick={handleClose}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-muted hover:bg-muted/80 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={!url.trim() || loading}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Importing...' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
};
