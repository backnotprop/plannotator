/**
 * Hook for URL-based state sharing in Plannotator
 *
 * Handles:
 * - Loading shared state from URL hash on mount
 * - Generating shareable URLs
 * - Tracking whether current session is from a shared link
 */

import { useState, useEffect, useCallback } from 'react';
import { Annotation } from '../types';
import {
  parseShareHash,
  generateShareUrl,
  decompress,
  fromShareable,
  formatUrlSize,
} from '../utils/sharing';

export interface ImportResult {
  success: boolean;
  count: number;
  planTitle: string;
  error?: string;
}

interface UseSharingResult {
  /** Whether the current session was loaded from a shared URL */
  isSharedSession: boolean;

  /** Whether we're currently loading from a shared URL */
  isLoadingShared: boolean;

  /** The current shareable URL (updates when annotations change) */
  shareUrl: string;

  /** Human-readable size of the share URL */
  shareUrlSize: string;

  /** Annotations loaded from share that need to be applied to DOM */
  pendingSharedAnnotations: Annotation[] | null;

  /** Global attachments loaded from share */
  sharedGlobalAttachments: string[] | null;

  /** Call after applying shared annotations to clear the pending state */
  clearPendingSharedAnnotations: () => void;

  /** Manually trigger share URL generation */
  refreshShareUrl: () => Promise<void>;

  /** Import annotations from a teammate's share URL */
  importFromShareUrl: (url: string) => Promise<ImportResult>;
}

export function useSharing(
  markdown: string,
  annotations: Annotation[],
  globalAttachments: string[],
  setMarkdown: (m: string) => void,
  setAnnotations: (a: Annotation[]) => void,
  setGlobalAttachments: (g: string[]) => void,
  onSharedLoad?: () => void
): UseSharingResult {
  const [isSharedSession, setIsSharedSession] = useState(false);
  const [isLoadingShared, setIsLoadingShared] = useState(true);
  const [shareUrl, setShareUrl] = useState('');
  const [shareUrlSize, setShareUrlSize] = useState('');
  const [pendingSharedAnnotations, setPendingSharedAnnotations] = useState<Annotation[] | null>(null);
  const [sharedGlobalAttachments, setSharedGlobalAttachments] = useState<string[] | null>(null);

  const clearPendingSharedAnnotations = useCallback(() => {
    setPendingSharedAnnotations(null);
    setSharedGlobalAttachments(null);
  }, []);

  // Load shared state from URL hash
  const loadFromHash = useCallback(async () => {
    try {
      const payload = await parseShareHash();

      if (payload) {
        // Set plan content
        setMarkdown(payload.p);

        // Convert shareable annotations to full annotations
        const restoredAnnotations = fromShareable(payload.a);
        setAnnotations(restoredAnnotations);

        // Restore global attachments if present
        if (payload.g?.length) {
          setGlobalAttachments(payload.g);
          setSharedGlobalAttachments(payload.g);
        }

        // Store for later application to DOM
        setPendingSharedAnnotations(restoredAnnotations);

        setIsSharedSession(true);

        // Notify parent that we loaded from a share
        onSharedLoad?.();

        // Clear the hash from URL to prevent re-loading on refresh
        // but keep the state in memory
        window.history.replaceState(
          {},
          '',
          window.location.pathname
        );

        return true;
      }
      return false;
    } catch (e) {
      console.error('Failed to load from share hash:', e);
      return false;
    }
  }, [setMarkdown, setAnnotations, setGlobalAttachments, onSharedLoad]);

  // Load from hash on mount
  useEffect(() => {
    loadFromHash().finally(() => setIsLoadingShared(false));
  }, []); // Only run on mount

  // Listen for hash changes (when user pastes a new share URL)
  useEffect(() => {
    const handleHashChange = () => {
      if (window.location.hash.length > 1) {
        loadFromHash();
      }
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [loadFromHash]);

  // Generate share URL when markdown or annotations change
  const refreshShareUrl = useCallback(async () => {
    try {
      const url = await generateShareUrl(markdown, annotations, globalAttachments);
      setShareUrl(url);
      setShareUrlSize(formatUrlSize(url));
    } catch (e) {
      console.error('Failed to generate share URL:', e);
      setShareUrl('');
      setShareUrlSize('');
    }
  }, [markdown, annotations, globalAttachments]);

  // Auto-refresh share URL when dependencies change
  useEffect(() => {
    refreshShareUrl();
  }, [refreshShareUrl]);

  // Import annotations from a teammate's share URL
  const importFromShareUrl = useCallback(async (url: string): Promise<ImportResult> => {
    try {
      // Extract hash from URL
      const hashIndex = url.indexOf('#');
      if (hashIndex === -1) {
        return { success: false, count: 0, planTitle: '', error: 'Invalid share URL: no hash fragment found' };
      }
      const hash = url.slice(hashIndex + 1);
      if (!hash) {
        return { success: false, count: 0, planTitle: '', error: 'Invalid share URL: empty hash' };
      }

      // Decompress payload
      const payload = await decompress(hash);

      // Extract plan title from embedded plan text
      const lines = (payload.p || '').trim().split('\n');
      const titleLine = lines.find(l => l.startsWith('#'));
      const planTitle = titleLine ? titleLine.replace(/^#+\s*/, '').trim() : 'Unknown Plan';

      // Convert to full annotations
      const importedAnnotations = fromShareable(payload.a);

      if (importedAnnotations.length === 0) {
        return { success: true, count: 0, planTitle, error: 'No annotations found in share link' };
      }

      // Deduplicate: skip annotations that already exist (by originalText + type + text)
      const newAnnotations = importedAnnotations.filter(imp =>
        !annotations.some(existing =>
          existing.originalText === imp.originalText &&
          existing.type === imp.type &&
          existing.text === imp.text
        )
      );

      if (newAnnotations.length > 0) {
        // Merge: append new annotations to existing ones
        setAnnotations([...annotations, ...newAnnotations]);

        // Set as pending so they get applied to DOM highlights
        setPendingSharedAnnotations(newAnnotations);

        // Handle global attachments (deduplicate by path)
        if (payload.g?.length) {
          const newPaths = payload.g.filter(p => !globalAttachments.includes(p));
          if (newPaths.length > 0) {
            setGlobalAttachments([...globalAttachments, ...newPaths]);
          }
          setSharedGlobalAttachments(payload.g);
        }
      }

      return { success: true, count: newAnnotations.length, planTitle };
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to decompress share URL';
      return { success: false, count: 0, planTitle: '', error: errorMessage };
    }
  }, [annotations, globalAttachments, setAnnotations, setGlobalAttachments]);

  return {
    isSharedSession,
    isLoadingShared,
    shareUrl,
    shareUrlSize,
    pendingSharedAnnotations,
    sharedGlobalAttachments,
    clearPendingSharedAnnotations,
    refreshShareUrl,
    importFromShareUrl,
  };
}
