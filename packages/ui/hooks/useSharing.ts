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
  fromShareable,
  formatUrlSize,
} from '../utils/sharing';

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

  /** Call after applying shared annotations to clear the pending state */
  clearPendingSharedAnnotations: () => void;

  /** Manually trigger share URL generation */
  refreshShareUrl: () => Promise<void>;

  /** Instructions loaded from share URL (if any) */
  loadedInstructions: string | null;
}

export function useSharing(
  markdown: string,
  annotations: Annotation[],
  setMarkdown: (m: string) => void,
  setAnnotations: (a: Annotation[]) => void,
  onSharedLoad?: () => void,
  instructions?: string
): UseSharingResult {
  const [isSharedSession, setIsSharedSession] = useState(false);
  const [isLoadingShared, setIsLoadingShared] = useState(true);
  const [shareUrl, setShareUrl] = useState('');
  const [shareUrlSize, setShareUrlSize] = useState('');
  const [pendingSharedAnnotations, setPendingSharedAnnotations] = useState<Annotation[] | null>(null);
  const [loadedInstructions, setLoadedInstructions] = useState<string | null>(null);

  const clearPendingSharedAnnotations = useCallback(() => {
    setPendingSharedAnnotations(null);
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

        // Store for later application to DOM
        setPendingSharedAnnotations(restoredAnnotations);

        // Store loaded instructions (if any)
        if (payload.i) {
          setLoadedInstructions(payload.i);
        }

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
  }, [setMarkdown, setAnnotations, onSharedLoad]);

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
      const url = await generateShareUrl(markdown, annotations, instructions);
      setShareUrl(url);
      setShareUrlSize(formatUrlSize(url));
    } catch (e) {
      console.error('Failed to generate share URL:', e);
      setShareUrl('');
      setShareUrlSize('');
    }
  }, [markdown, annotations, instructions]);

  // Auto-refresh share URL when dependencies change
  useEffect(() => {
    refreshShareUrl();
  }, [refreshShareUrl]);

  return {
    isSharedSession,
    isLoadingShared,
    shareUrl,
    shareUrlSize,
    pendingSharedAnnotations,
    clearPendingSharedAnnotations,
    refreshShareUrl,
    loadedInstructions,
  };
}
