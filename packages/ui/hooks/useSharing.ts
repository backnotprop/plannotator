import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Annotation, type DocumentRenderAs, type ImageAttachment } from '../types';
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
  isSharedSession: boolean;

  isLoadingShared: boolean;

  shareUrl: string;

  shareUrlSize: string;

  shortShareUrl: string;

  isGeneratingShortUrl: boolean;

  shortUrlError: string;

  pendingSharedAnnotations: Annotation[] | null;

  sharedGlobalAttachments: ImageAttachment[] | null;

  clearPendingSharedAnnotations: () => void;

  refreshShareUrl: () => Promise<void>;

  generateShortUrl: () => Promise<string | null>;

  importFromShareUrl: (url: string) => Promise<ImportResult>;

  shareLoadError: string;

  clearShareLoadError: () => void;
}

type ShortShareUrlLifecycle =
  | { readonly _tag: 'none' }
  | { readonly _tag: 'incoming-hydration' }
  | { readonly _tag: 'generating'; readonly requestContext: object }
  | { readonly _tag: 'associated'; readonly requestContext: object }
  | { readonly _tag: 'failed'; readonly requestContext: object };

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
  pasteApiUrl?: string,
  rawHtml?: string,
  resolveRawHtmlForShare?: () => Promise<string | null>,
  setRawHtml?: (h: string) => void,
  setShareHtml?: (h: string) => void,
  setRenderAs?: (m: DocumentRenderAs) => void,
  contentRevision = 0,
  renderAs?: DocumentRenderAs,
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
  const shareRequestContext = useMemo(() => ({}), [
    markdown,
    annotations,
    globalAttachments,
    shareBaseUrl,
    pasteApiUrl,
    rawHtml,
    contentRevision,
    renderAs,
  ]);
  const latestShareRequestContextRef = useRef(shareRequestContext);
  latestShareRequestContextRef.current = shareRequestContext;
  const shortShareUrlLifecycleRef = useRef<ShortShareUrlLifecycle>({ _tag: 'none' });

  const clearPendingSharedAnnotations = useCallback(() => {
    setPendingSharedAnnotations(null);
    setSharedGlobalAttachments(null);
  }, []);

  const clearShareLoadError = useCallback(() => setShareLoadError(''), []);

  const loadFromHash = useCallback(async () => {
    try {
      const pathMatch = window.location.pathname.match(/^\/p\/([A-Za-z0-9]{6,16})$/);
      if (pathMatch) {
        const pasteId = pathMatch[1];
        const incomingShortUrl = window.location.href;

        const fragment = window.location.hash.slice(1);
        const params = new URLSearchParams(fragment);
        const encryptionKey = params.get('key') ?? undefined;
        const pasteFromFragment = params.get('paste')
          ? atob(params.get('paste')!.replace(/-/g, '+').replace(/_/g, '/'))
          : undefined;

        const payload = await loadFromPasteId(pasteId, pasteFromFragment ?? pasteApiUrl, encryptionKey);
        if (payload) {
          if (payload.h && payload.r === 'html') {
            setRawHtml?.(payload.h);
            setShareHtml?.(payload.h);
            setRenderAs?.('html');
            setMarkdown('');
          } else {
            setMarkdown(payload.p);
            setRenderAs?.(payload.r === 'asciidoc' ? 'asciidoc' : 'markdown');
            setRawHtml?.('');
            setShareHtml?.('');
          }

          const restoredAnnotations = fromShareable(payload.a, payload.d, payload.s);
          setAnnotations(restoredAnnotations);

          const parsedGlobalAttachments = parseShareableImages(payload.g) ?? [];
          setGlobalAttachments(parsedGlobalAttachments);
          setSharedGlobalAttachments(parsedGlobalAttachments.length ? parsedGlobalAttachments : null);

          setPendingSharedAnnotations(restoredAnnotations);
          setIsSharedSession(true);
          shortShareUrlLifecycleRef.current = { _tag: 'incoming-hydration' };
          setShortShareUrl(incomingShortUrl);
          onSharedLoad?.();

          const basePath = window.location.pathname.replace(/\/p\/[A-Za-z0-9]+$/, '') || '/';
          window.history.replaceState({}, '', basePath);

          return true;
        }
        setShareLoadError('Failed to load shared plan — the link may be expired or incomplete.');
        return false;
      }

      const hash = window.location.hash.slice(1);

      if (!looksLikeSharePayload(hash)) {
        return false;
      }

      const payload = await parseShareHash();

      if (payload) {
        if (payload.h && payload.r === 'html') {
          setRawHtml?.(payload.h);
          setShareHtml?.(payload.h);
          setRenderAs?.('html');
          setMarkdown('');
        } else {
          setMarkdown(payload.p);
          setRenderAs?.(payload.r === 'asciidoc' ? 'asciidoc' : 'markdown');
          setRawHtml?.('');
          setShareHtml?.('');
        }

        const restoredAnnotations = fromShareable(payload.a, payload.d, payload.s);
        setAnnotations(restoredAnnotations);

        const parsedGlobalAttachments = parseShareableImages(payload.g) ?? [];
        setGlobalAttachments(parsedGlobalAttachments);
        setSharedGlobalAttachments(parsedGlobalAttachments.length ? parsedGlobalAttachments : null);

        setPendingSharedAnnotations(restoredAnnotations);

        setIsSharedSession(true);

        onSharedLoad?.();

        window.history.replaceState(
          {},
          '',
          window.location.pathname
        );

        return true;
      }

      if (hash) {
        setShareLoadError('Failed to load shared plan — the URL may have been truncated by your browser.');
      }
      return false;
    } catch (e) {
      console.error('Failed to load from share hash:', e);
      setShareLoadError('Failed to load shared plan — an unexpected error occurred.');
      return false;
    }
  }, [setMarkdown, setAnnotations, setGlobalAttachments, onSharedLoad, pasteApiUrl, setRawHtml, setShareHtml, setRenderAs]);

  useEffect(() => {
    loadFromHash().finally(() => setIsLoadingShared(false));
  }, []);

  useEffect(() => {
    const handleHashChange = () => {
      if (!looksLikeSharePayload(window.location.hash)) return;
      loadFromHash();
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [loadFromHash]);

  const refreshShareUrl = useCallback(async () => {
    const requestContext = shareRequestContext;
    try {
      const url = await generateShareUrl(markdown, annotations, globalAttachments, shareBaseUrl, rawHtml, renderAs);
      if (latestShareRequestContextRef.current !== requestContext) return;
      setShareUrl(url ?? '');
      setShareUrlSize(url ? formatUrlSize(url) : '');
    } catch (e) {
      if (latestShareRequestContextRef.current !== requestContext) return;
      console.error('Failed to generate share URL:', e);
      setShareUrl('');
      setShareUrlSize('');
    }
  }, [markdown, annotations, globalAttachments, shareBaseUrl, rawHtml, renderAs, shareRequestContext]);

  useEffect(() => {
    refreshShareUrl();
  }, [refreshShareUrl]);

  useEffect(() => {
    const lifecycle = shortShareUrlLifecycleRef.current;
    if (lifecycle._tag === 'incoming-hydration') {
      if (!shortShareUrl) return;
      shortShareUrlLifecycleRef.current = {
        _tag: 'associated',
        requestContext: shareRequestContext,
      };
      return;
    }
    if (
      (
        lifecycle._tag === 'generating'
        || lifecycle._tag === 'associated'
        || lifecycle._tag === 'failed'
      )
      && lifecycle.requestContext === shareRequestContext
    ) {
      return;
    }
    if (lifecycle._tag === 'none' && !shortShareUrl) return;

    shortShareUrlLifecycleRef.current = { _tag: 'none' };
    setIsGeneratingShortUrl(false);
    setShortShareUrl('');
    setShortUrlError('');
  }, [shareRequestContext, shortShareUrl]);

  const generateShortUrl = useCallback(async (): Promise<string | null> => {
    if (!markdown && !rawHtml) return null;

    setIsGeneratingShortUrl(true);
    setShortUrlError('');
    const requestContext = shareRequestContext;
    shortShareUrlLifecycleRef.current = {
      _tag: 'generating',
      requestContext,
    };

    try {
      const htmlForShare = rawHtml
        ? (await resolveRawHtmlForShare?.()) ?? rawHtml
        : undefined;
      const result = await createShortShareUrl(
        markdown,
        annotations,
        globalAttachments,
        { pasteApiUrl, shareBaseUrl },
        htmlForShare,
        renderAs,
      );

      if (latestShareRequestContextRef.current !== requestContext) return null;

      if (result) {
        shortShareUrlLifecycleRef.current = {
          _tag: 'associated',
          requestContext,
        };
        setShortShareUrl(result.shortUrl);
        return result.shortUrl;
      } else {
        shortShareUrlLifecycleRef.current = { _tag: 'failed', requestContext };
        setShortShareUrl('');
        setShortUrlError('Short URL service unavailable');
        return null;
      }
    } catch (e) {
      if (latestShareRequestContextRef.current !== requestContext) return null;
      shortShareUrlLifecycleRef.current = { _tag: 'failed', requestContext };
      setShortShareUrl('');
      setShortUrlError(e instanceof Error ? e.message : 'Failed to generate short URL');
      return null;
    } finally {
      if (latestShareRequestContextRef.current === requestContext) setIsGeneratingShortUrl(false);
    }
  }, [markdown, annotations, globalAttachments, shareBaseUrl, pasteApiUrl, rawHtml, resolveRawHtmlForShare, renderAs, shareRequestContext]);

  const importFromShareUrl = useCallback(async (url: string): Promise<ImportResult> => {
    try {
      let payload: SharePayload | undefined;

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

      let planTitle = 'Unknown Plan';
      if (payload.p) {
        const titleLine = payload.p.trim().split('\n').find(l => l.startsWith('#'));
        if (titleLine) planTitle = titleLine.replace(/^#+\s*/, '').trim();
      } else if (payload.h) {
        const titleMatch = payload.h.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch) planTitle = titleMatch[1].trim();
      }

      const importedAnnotations = fromShareable(payload.a, payload.d, payload.s);

      if (importedAnnotations.length === 0) {
        return { success: true, count: 0, planTitle, error: 'No annotations found in share link' };
      }

      const estimatedNew = importedAnnotations.filter(imp =>
        !annotations.some(existing =>
          existing.originalText === imp.originalText &&
          existing.type === imp.type &&
          existing.text === imp.text
        )
      );

      if (estimatedNew.length > 0) {
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
          setPendingSharedAnnotations(merged);
          return merged;
        });

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
