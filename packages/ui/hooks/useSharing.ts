/**
 * Hook for URL-based state sharing in Plannotator
 *
 * Handles:
 * - Loading shared state from URL hash on mount
 * - Generating shareable URLs
 * - Tracking whether current session is from a shared link
 */

import { useState, useEffect, useCallback } from 'react';
import { Annotation, type ImageAttachment } from '../types';
import {
  type SharePayload,
  parseShareHash,
  generateShareUrl,
  decompress,
  fromShareable,
  formatUrlSize,
  createShortShareUrl,
  loadFromPasteId,
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

  /** Short share URL backed by the paste service (empty string when unavailable) */
  shortShareUrl: string;

  /** Whether the short URL is currently being generated */
  isGeneratingShortUrl: boolean;

  /** Error message from the last short URL generation attempt, or empty string */
  shortUrlError: string;

  /** Annotations loaded from share that need to be applied to DOM */
  pendingSharedAnnotations: Annotation[] | null;

  /** Global attachments loaded from share */
  sharedGlobalAttachments: ImageAttachment[] | null;

  /** Call after applying shared annotations to clear the pending state */
  clearPendingSharedAnnotations: () => void;

  /** Manually trigger share URL generation */
  refreshShareUrl: () => Promise<void>;

  /** Import annotations from a teammate's share URL */
  importFromShareUrl: (url: string) => Promise<ImportResult>;
}

/**
 * Parse SharePayload.g (which can be old string[] or new [path,name][] format) into ImageAttachment[]
 */
function parseGlobalAttachments(g: unknown[] | undefined): ImageAttachment[] {
  if (!g?.length) return [];
  return g.map((item, idx) => {
    if (typeof item === 'string') {
      const name = item.split('/').pop()?.replace(/\.[^.]+$/, '') || `image-${idx + 1}`;
      return { path: item, name };
    }
    if (Array.isArray(item) && item.length >= 2) {
      return { path: item[0] as string, name: item[1] as string };
    }
    return { path: String(item), name: `image-${idx + 1}` };
  });
}

export function useSharing(
  markdown: string,
  annotations: Annotation[],
  globalAttachments: ImageAttachment[],
  setMarkdown: (m: string) => void,
  setAnnotations: (a: Annotation[]) => void,
  setGlobalAttachments: (g: ImageAttachment[]) => void,
  onSharedLoad?: () => void,
  shareBaseUrl?: string,
  pasteApiUrl?: string
): UseSharingResult {
  const [isSharedSession, setIsSharedSession] = useState(false);
  const [isLoadingShared, setIsLoadingShared] = useState(true);
  const [shareUrl, setShareUrl] = useState('');
  const [shareUrlSize, setShareUrlSize] = useState('');
  const [shortShareUrl, setShortShareUrl] = useState('');
  const [isGeneratingShortUrl, setIsGeneratingShortUrl] = useState(false);
  const [shortUrlError, setShortUrlError] = useState('');
  const [pendingSharedAnnotations, setPendingSharedAnnotations] = useState<Annotation[] | null>(null);
  const [sharedGlobalAttachments, setSharedGlobalAttachments] = useState<ImageAttachment[] | null>(null);

  const clearPendingSharedAnnotations = useCallback(() => {
    setPendingSharedAnnotations(null);
    setSharedGlobalAttachments(null);
  }, []);

  // Load shared state from URL hash (or paste-service short URL)
  const loadFromHash = useCallback(async () => {
    try {
      // Check for short URL path pattern: /p/<id>
      const pathMatch = window.location.pathname.match(/^\/p\/([A-Za-z0-9]{6,16})$/);
      if (pathMatch) {
        const pasteId = pathMatch[1];
        const payload = await loadFromPasteId(pasteId, pasteApiUrl);
        if (payload) {
          setMarkdown(payload.p);

          const restoredAnnotations = fromShareable(payload.a);
          setAnnotations(restoredAnnotations);

          if (payload.g?.length) {
            const parsed = parseGlobalAttachments(payload.g);
            setGlobalAttachments(parsed);
            setSharedGlobalAttachments(parsed);
          }

          setPendingSharedAnnotations(restoredAnnotations);
          setIsSharedSession(true);
          onSharedLoad?.();

          // Remove the /p/<id> path from browser history so a refresh doesn't
          // attempt a network fetch. The plan is now held in memory.
          const basePath = window.location.pathname.replace(/\/p\/[A-Za-z0-9]+$/, '') || '/';
          window.history.replaceState({}, '', basePath);

          return true;
        }
        // Paste fetch failed — fall through to try the hash fragment instead.
      }

      const payload = await parseShareHash();

      if (payload) {
        // Set plan content
        setMarkdown(payload.p);

        // Convert shareable annotations to full annotations
        const restoredAnnotations = fromShareable(payload.a);
        setAnnotations(restoredAnnotations);

        // Restore global attachments if present
        if (payload.g?.length) {
          const parsed = parseGlobalAttachments(payload.g);
          setGlobalAttachments(parsed);
          setSharedGlobalAttachments(parsed);
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
  }, [setMarkdown, setAnnotations, setGlobalAttachments, onSharedLoad, shareBaseUrl, pasteApiUrl]);

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
      const url = await generateShareUrl(markdown, annotations, globalAttachments, shareBaseUrl);
      setShareUrl(url);
      setShareUrlSize(formatUrlSize(url));
    } catch (e) {
      console.error('Failed to generate share URL:', e);
      setShareUrl('');
      setShareUrlSize('');
    }
  }, [markdown, annotations, globalAttachments, shareBaseUrl]);

  // Auto-refresh share URL when dependencies change
  useEffect(() => {
    refreshShareUrl();
  }, [refreshShareUrl]);

  /**
   * Generate a short URL via the paste service.
   * Silently clears the short URL if the service is unavailable — the full
   * hash-based URL remains usable as a fallback.
   */
  const generateShortUrl = useCallback(async () => {
    if (!markdown) return;

    setIsGeneratingShortUrl(true);
    setShortUrlError('');

    try {
      const result = await createShortShareUrl(
        markdown,
        annotations,
        globalAttachments,
        { pasteApiUrl, shareBaseUrl }
      );

      if (result) {
        setShortShareUrl(result.shortUrl);
      } else {
        setShortShareUrl('');
        setShortUrlError('Short URL service unavailable');
      }
    } catch {
      setShortShareUrl('');
      setShortUrlError('Failed to generate short URL');
    } finally {
      setIsGeneratingShortUrl(false);
    }
  }, [markdown, annotations, globalAttachments, shareBaseUrl, pasteApiUrl]);

  // Auto-generate short URL with a 1-second debounce whenever the plan or
  // annotations change. A debounce avoids hammering the paste service on
  // every keystroke during active editing.
  // Clear the stale short URL immediately so the UI doesn't show an outdated link.
  useEffect(() => {
    setShortShareUrl('');
    const timer = setTimeout(() => {
      generateShortUrl();
    }, 1_000);
    return () => clearTimeout(timer);
  }, [generateShortUrl]);

  // Import annotations from a teammate's share URL (supports both hash-based and short /p/<id> URLs)
  const importFromShareUrl = useCallback(async (url: string): Promise<ImportResult> => {
    try {
      let payload: SharePayload | undefined;

      // Check for short URL pattern: /p/<id>
      const shortMatch = url.match(/\/p\/([A-Za-z0-9]{6,16})(?:\?|$)/);
      if (shortMatch) {
        const pasteId = shortMatch[1];
        const loaded = await loadFromPasteId(pasteId, pasteApiUrl);
        if (!loaded) {
          return { success: false, count: 0, planTitle: '', error: 'Failed to load from short URL — paste may have expired' };
        }
        payload = loaded;
      } else {
        // Fall back to hash-based URL
        const hashIndex = url.indexOf('#');
        if (hashIndex === -1) {
          return { success: false, count: 0, planTitle: '', error: 'Invalid share URL: no hash fragment or short link found' };
        }
        const hash = url.slice(hashIndex + 1);
        if (!hash) {
          return { success: false, count: 0, planTitle: '', error: 'Invalid share URL: empty hash' };
        }

        payload = await decompress(hash);
      }

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
          const parsed = parseGlobalAttachments(payload.g);
          const existingPaths = new Set(globalAttachments.map(g => g.path));
          const newAttachments = parsed.filter(p => !existingPaths.has(p.path));
          if (newAttachments.length > 0) {
            setGlobalAttachments([...globalAttachments, ...newAttachments]);
          }
          setSharedGlobalAttachments(parsed);
        }
      }

      return { success: true, count: newAnnotations.length, planTitle };
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to decompress share URL';
      return { success: false, count: 0, planTitle: '', error: errorMessage };
    }
  }, [annotations, globalAttachments, setAnnotations, setGlobalAttachments, pasteApiUrl]);

  return {
    isSharedSession,
    isLoadingShared,
    shareUrl,
    shareUrlSize,
    shortShareUrl,
    isGeneratingShortUrl,
    shortUrlError,
    pendingSharedAnnotations,
    sharedGlobalAttachments,
    clearPendingSharedAnnotations,
    refreshShareUrl,
    importFromShareUrl,
  };
}
