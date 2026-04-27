/**
 * Hook for URL-based state sharing in Plannotator
 *
 * Handles:
 * - Loading shared state from URL hash on mount
 * - Loading from paste-service short URLs (/p/<id>)
 * - Generating shareable URLs (hash-based and short)
 * - Tracking whether current session is from a shared link
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Annotation, type ImageAttachment } from '../types';
import {
  type SharePayload,
  parseShareHash,
  generateShareUrl,
  decompress,
  fromShareable,
  parseShareableImages,
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

  /** Generate a short URL via the paste service (user must explicitly trigger this) */
  generateShortUrl: () => Promise<void>;

  /** Import annotations from a teammate's share URL */
  importFromShareUrl: (url: string) => Promise<ImportResult>;

  /** Error message when a shared URL failed to load on mount */
  shareLoadError: string;

  /** Clear the share load error */
  clearShareLoadError: () => void;
}


// Share payloads are base64url-encoded deflate output: charset [A-Za-z0-9_-],
// realistically >=30 chars, and virtually always mixed-case because deflate
// output has high entropy. Plain heading anchors — whether the lowercase
// ASCII slugs from `slugifyHeading` ("section-overview"), Unicode slugs
// ("café", "中文-notes"), or raw HTML ids ("MySection") — miss at least one
// of those signals. So: run share parsing only when the hash looks like a
// share payload. Everything else is left for Viewer to scroll to (or ignore).
function looksLikeSharePayload(rawHash: string): boolean {
  const hash = rawHash.replace(/^#/, '').split('?')[0];
  return hash.length >= 30 && /^[A-Za-z0-9_-]+$/.test(hash) && /[A-Z]/.test(hash);
}

export function useSharing(
  markdown: string,
  annotations: Annotation[],
  globalAttachments: ImageAttachment[],
  setMarkdown: (m: string) => void,
  setAnnotations: React.Dispatch<React.SetStateAction<Annotation[]>>,
  setGlobalAttachments: React.Dispatch<React.SetStateAction<ImageAttachment[]>>,
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
  const [shareLoadError, setShareLoadError] = useState('');

  const clearPendingSharedAnnotations = useCallback(() => {
    setPendingSharedAnnotations(null);
    setSharedGlobalAttachments(null);
  }, []);

  const clearShareLoadError = useCallback(() => setShareLoadError(''), []);

  // Load shared state from URL hash (or paste-service short URL)
  const loadFromHash = useCallback(async () => {
    try {
      // Check for short URL path pattern: /p/<id>
      const pathMatch = window.location.pathname.match(/^\/p\/([A-Za-z0-9]{6,16})$/);
      if (pathMatch) {
        const pasteId = pathMatch[1];

        // Extract key and optional paste origin from fragment: #key=<k>&paste=<base64url>
        const fragment = window.location.hash.slice(1);
        const params = new URLSearchParams(fragment);
        const encryptionKey = params.get('key') ?? undefined;
        const pasteFromFragment = params.get('paste')
          ? atob(params.get('paste')!.replace(/-/g, '+').replace(/_/g, '/'))
          : undefined;

        const payload = await loadFromPasteId(pasteId, pasteFromFragment ?? pasteApiUrl, encryptionKey);
        if (payload) {
          setMarkdown(payload.p);

          const restoredAnnotations = fromShareable(payload.a, payload.d, payload.s);
          setAnnotations(restoredAnnotations);

          if (payload.g?.length) {
            const parsed = parseShareableImages(payload.g) ?? [];
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
        // Paste fetch failed — short URL path can't fall back to hash parsing
        // (the hash contains #key=, not plan data).
        setShareLoadError('Failed to load shared plan — the link may be expired or incomplete.');
        return false;
      }

      const hash = window.location.hash.slice(1);

      // Not a share payload — leave it for Viewer to scroll to (or ignore).
      if (!looksLikeSharePayload(hash)) {
        return false;
      }

      const payload = await parseShareHash();

      if (payload) {
        // Set plan content
        setMarkdown(payload.p);

        // Convert shareable annotations to full annotations
        const restoredAnnotations = fromShareable(payload.a, payload.d, payload.s);
        setAnnotations(restoredAnnotations);

        // Restore global attachments if present
        if (payload.g?.length) {
          const parsed = parseShareableImages(payload.g) ?? [];
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

      // Hash was present but failed to decompress (likely truncated by browser)
      if (hash) {
        setShareLoadError('Failed to load shared plan — the URL may have been truncated by your browser.');
      }
      return false;
    } catch (e) {
      console.error('Failed to load from share hash:', e);
      setShareLoadError('Failed to load shared plan — an unexpected error occurred.');
      return false;
    }
  }, [setMarkdown, setAnnotations, setGlobalAttachments, onSharedLoad, pasteApiUrl]);

  // Load from hash on mount
  useEffect(() => {
    loadFromHash().finally(() => setIsLoadingShared(false));
  }, []); // Only run on mount

  // Listen for hash changes (when user pastes a new share URL)
  useEffect(() => {
    const handleHashChange = () => {
      if (!looksLikeSharePayload(window.location.hash)) return;
      loadFromHash();
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

  // Clear stale short URL when content changes (does NOT auto-regenerate —
  // the user must explicitly click "Create short link" again)
  useEffect(() => {
    setShortShareUrl('');
    setShortUrlError('');
  }, [markdown, annotations]);

  /**
   * Generate a short URL via the paste service.
   * Only called when the user explicitly clicks "Create short link".
   * Clears the short URL if the service is unavailable — the full
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

  // Import annotations from a teammate's share URL (supports both hash-based and short /p/<id> URLs)
  const importFromShareUrl = useCallback(async (url: string): Promise<ImportResult> => {
    try {
      let payload: SharePayload | undefined;

      // Check for short URL pattern: /p/<id> with optional #key=<key> fragment
      const shortMatch = url.match(/\/p\/([A-Za-z0-9]{6,16})(?:#(.*))?(?:\?|$)/);
      if (shortMatch) {
        const pasteId = shortMatch[1];
        const fragParams = new URLSearchParams(shortMatch[2] ?? '');
        const encryptionKey = fragParams.get('key') ?? undefined;
        const pasteFromFragment = fragParams.get('paste')
          ? atob(fragParams.get('paste')!.replace(/-/g, '+').replace(/_/g, '/'))
          : undefined;
        const loaded = await loadFromPasteId(pasteId, pasteFromFragment ?? pasteApiUrl, encryptionKey);
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

        payload = (await decompress(hash)) as SharePayload;
      }

      // Extract plan title from embedded plan text
      const lines = (payload.p || '').trim().split('\n');
      const titleLine = lines.find(l => l.startsWith('#'));
      const planTitle = titleLine ? titleLine.replace(/^#+\s*/, '').trim() : 'Unknown Plan';

      // Convert to full annotations
      const importedAnnotations = fromShareable(payload.a, payload.d, payload.s);

      if (importedAnnotations.length === 0) {
        return { success: true, count: 0, planTitle, error: 'No annotations found in share link' };
      }

      // Estimate count from current closure (may be slightly stale, but
      // the actual merge below uses the latest state via functional updater)
      const estimatedNew = importedAnnotations.filter(imp =>
        !annotations.some(existing =>
          existing.originalText === imp.originalText &&
          existing.type === imp.type &&
          existing.text === imp.text
        )
      );

      if (estimatedNew.length > 0) {
        // Merge using functional updater to avoid stale closure
        setAnnotations(prev => {
          const newAnnotations = importedAnnotations.filter(imp =>
            !prev.some(existing =>
              existing.originalText === imp.originalText &&
              existing.type === imp.type &&
              existing.text === imp.text
            )
          );
          if (newAnnotations.length === 0) return prev;
          const merged = [...prev, ...newAnnotations];
          // Set ALL annotations as pending so DOM highlights include originals
          setPendingSharedAnnotations(merged);
          return merged;
        });

        // Handle global attachments (deduplicate by path)
        if (payload.g?.length) {
          const parsed = parseShareableImages(payload.g) ?? [];
          setGlobalAttachments(prev => {
            const existingPaths = new Set(prev.map(g => g.path));
            const newAttachments = parsed.filter(p => !existingPaths.has(p.path));
            return newAttachments.length > 0 ? [...prev, ...newAttachments] : prev;
          });
          setSharedGlobalAttachments(parsed);
        }
      }

      return { success: true, count: estimatedNew.length, planTitle };
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
    generateShortUrl,
    importFromShareUrl,
    shareLoadError,
    clearShareLoadError,
  };
}
