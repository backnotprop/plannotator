import { useEffect, useState } from 'react';

/** Loading state for a remote HTML or Markdown artifact. */
export type RemoteArtifactDocumentState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly content: string }
  | { readonly status: 'error' };

type ArtifactDocumentCacheEntry =
  | { readonly status: 'loading'; readonly promise: Promise<string> }
  | { readonly status: 'ready'; readonly content: string; readonly expiresAt: number };

export interface ArtifactProviderLocation {
  readonly platform: 'github' | 'gitlab';
  readonly host: string;
}

const artifactDocumentCache = new Map<string, ArtifactDocumentCacheEntry>();
const MAX_CACHED_DOCUMENTS = 128;
const DOCUMENT_CACHE_TTL_MS = 5 * 60 * 1000;

function readCachedDocument(url: string): ArtifactDocumentCacheEntry | undefined {
  const entry = artifactDocumentCache.get(url);
  if (entry?.status === 'ready' && entry.expiresAt <= Date.now()) {
    artifactDocumentCache.delete(url);
    return undefined;
  }
  return entry;
}

function cacheDocument(url: string, entry: ArtifactDocumentCacheEntry): void {
  artifactDocumentCache.delete(url);
  artifactDocumentCache.set(url, entry);
  if (artifactDocumentCache.size <= MAX_CACHED_DOCUMENTS) return;
  for (const [cachedUrl, cachedEntry] of artifactDocumentCache) {
    if (cachedUrl !== url && cachedEntry.status === 'ready') {
      artifactDocumentCache.delete(cachedUrl);
      return;
    }
  }
}

function loadRemoteArtifactDocument(url: string): Promise<string> {
  const cached = readCachedDocument(url);
  if (cached?.status === 'ready') return Promise.resolve(cached.content);
  if (cached?.status === 'loading') return cached.promise;

  const endpoint = `/api/pr-artifact-document?${new URLSearchParams({ url })}`;
  const promise = fetch(endpoint)
    .then(async (response) => {
      if (response.ok) return response.text();
      throw new Error(`HTTP ${response.status}`);
    })
    .then((content) => {
      cacheDocument(url, {
        status: 'ready',
        content,
        expiresAt: Date.now() + DOCUMENT_CACHE_TTL_MS,
      });
      return content;
    })
    .catch((error: unknown) => {
      artifactDocumentCache.delete(url);
      throw error;
    });
  cacheDocument(url, { status: 'loading', promise });
  return promise;
}

/**
 * Fetch a hosted document through the authenticated review server. Requests
 * are shared across gallery and focused views; callers can defer the first
 * request until a preview is near the viewport.
 */
export function useRemoteArtifactDocument(
  url: string,
  enabled = true,
): RemoteArtifactDocumentState {
  const cached = readCachedDocument(url);
  const [state, setState] = useState<RemoteArtifactDocumentState>(
    cached?.status === 'ready' ? cached : { status: 'loading' },
  );
  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      setState({ status: 'loading' });
      return () => {
        cancelled = true;
      };
    }
    const current = readCachedDocument(url);
    if (current?.status === 'ready') {
      setState(current);
      return () => {
        cancelled = true;
      };
    }
    setState({ status: 'loading' });
    void loadRemoteArtifactDocument(url)
      .then((content) => {
        if (!cancelled) setState({ status: 'ready', content });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, url]);
  return state;
}

/** Resolve a rendered Markdown reference against its remote artifact URL. */
export function resolveArtifactReferenceUrl(
  rawUrl: string,
  artifactUrl: string,
  provider: ArtifactProviderLocation,
): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;

  let candidate = trimmed;
  if (trimmed.startsWith('/api/image?')) {
    const localImageUrl = new URL(trimmed, 'http://plannotator.invalid');
    const originalPath = localImageUrl.searchParams.get('path');
    if (originalPath === null || originalPath === '') return null;
    candidate = originalPath;
  }

  try {
    const resolved = new URL(candidate, artifactContentBaseUrl(artifactUrl, provider));
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : null;
  } catch {
    return null;
  }
}

/** Turn provider file-viewer URLs into raw-content bases for relative assets. */
export function artifactContentBaseUrl(
  artifactUrl: string,
  provider: ArtifactProviderLocation,
): string {
  const url = new URL(artifactUrl);
  if (url.host.toLowerCase() !== provider.host.toLowerCase()) return artifactUrl;

  const gitlabBlobMarker = '/-/blob/';
  if (provider.platform === 'gitlab' && url.pathname.includes(gitlabBlobMarker)) {
    url.pathname = url.pathname.replace(gitlabBlobMarker, '/-/raw/');
    return url.href;
  }

  if (provider.platform !== 'github') return artifactUrl;
  const githubMatch = /^(\/[^/]+\/[^/]+)\/(?:blob|raw)\/(.+)$/.exec(url.pathname);
  if (githubMatch) {
    const repoPrefix = githubMatch[1];
    const remainder = githubMatch[2];
    if (url.hostname.toLowerCase() === 'github.com') {
      return `https://raw.githubusercontent.com${repoPrefix}/${remainder}${url.search}`;
    }
    url.pathname = `${repoPrefix}/raw/${remainder}`;
    return url.href;
  }
  return artifactUrl;
}

/** Build the same-origin URL used for authenticated provider media/resources. */
export function artifactContentProxyUrl(url: string, sourceUrl?: string): string {
  const endpoint = `/api/pr-artifact-content?${new URLSearchParams({
    url,
    ...(sourceUrl === undefined ? {} : { source: sourceUrl }),
  })}`;
  if (typeof window === 'undefined' || !/^https?:$/.test(window.location.protocol)) return endpoint;
  return new URL(endpoint, window.location.origin).href;
}

function existingArtifactContentProxyUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  const browserOrigin = typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol)
    ? window.location.origin
    : null;
  const isRelativeProxy = trimmed.startsWith('/api/pr-artifact-content?');
  let parsed: URL;
  try {
    parsed = new URL(trimmed, browserOrigin ?? 'http://plannotator.invalid');
  } catch {
    return null;
  }
  if (
    parsed.pathname !== '/api/pr-artifact-content'
    || (!isRelativeProxy && (browserOrigin === null || parsed.origin !== browserOrigin))
  ) return null;
  const targetUrl = parsed.searchParams.get('url');
  if (targetUrl === null || targetUrl === '') return null;
  return artifactContentProxyUrl(targetUrl, parsed.searchParams.get('source') ?? undefined);
}

function isProviderManagedArtifactReference(
  url: URL,
  provider: ArtifactProviderLocation,
): boolean {
  const host = url.host.toLowerCase();
  const providerHost = provider.host.toLowerCase();
  if (host === providerHost) return true;
  if (provider.platform !== 'github' || providerHost !== 'github.com') return false;
  return host === 'raw.githubusercontent.com'
    || host === 'user-images.githubusercontent.com'
    || host === 'private-user-images.githubusercontent.com';
}

function proxiedArtifactReferenceUrl(
  rawUrl: string,
  artifactUrl: string,
  provider: ArtifactProviderLocation,
): string | null {
  const existingProxy = existingArtifactContentProxyUrl(rawUrl);
  if (existingProxy !== null) return existingProxy;
  const resolved = resolveArtifactReferenceUrl(rawUrl, artifactUrl, provider);
  if (resolved === null) return null;
  const resolvedUrl = new URL(resolved);
  return isProviderManagedArtifactReference(resolvedUrl, provider)
    ? artifactContentProxyUrl(resolved, artifactUrl)
    : resolved;
}

function rewriteSrcSetValue(
  value: string,
  rewriteUrl: (rawUrl: string) => string | null,
): string {
  const candidates: string[] = [];
  let position = 0;
  while (position < value.length) {
    while (position < value.length && /[\s,]/.test(value[position] ?? '')) position += 1;
    if (position >= value.length) break;

    const urlStart = position;
    while (position < value.length && !/\s/.test(value[position] ?? '')) position += 1;
    let rawUrl = value.slice(urlStart, position);
    let endedWithComma = false;
    while (rawUrl.endsWith(',')) {
      rawUrl = rawUrl.slice(0, -1);
      endedWithComma = true;
    }
    if (rawUrl === '') continue;

    let descriptor = '';
    if (!endedWithComma) {
      while (position < value.length && /\s/.test(value[position] ?? '')) position += 1;
      const descriptorStart = position;
      let parentheses = 0;
      while (position < value.length) {
        const character = value[position];
        if (character === '(') parentheses += 1;
        if (character === ')' && parentheses > 0) parentheses -= 1;
        if (character === ',' && parentheses === 0) break;
        position += 1;
      }
      descriptor = value.slice(descriptorStart, position).trim();
      if (value[position] === ',') position += 1;
    }

    const rewrittenUrl = rewriteUrl(rawUrl) ?? rawUrl;
    candidates.push(descriptor === '' ? rewrittenUrl : `${rewrittenUrl} ${descriptor}`);
  }
  return candidates.join(', ');
}

/**
 * Repair relative references after RenderedMarkdown has produced DOM. Its
 * normal image resolver targets local files through /api/image; remote
 * artifact documents instead need their own URL as the base.
 */
export function rewriteArtifactMarkdownReferences(
  root: HTMLElement,
  artifactUrl: string,
  provider: ArtifactProviderLocation,
): void {
  const rewriteAttribute = (selector: string, attribute: string): void => {
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      const rawValue = element.getAttribute(attribute);
      if (rawValue === null) continue;
      const resolved = proxiedArtifactReferenceUrl(rawValue, artifactUrl, provider);
      if (resolved !== null) element.setAttribute(attribute, resolved);
    }
  };
  rewriteAttribute(
    'img[src], source[src], video[src], audio[src], track[src], embed[src], iframe[src], frame[src], input[src]',
    'src',
  );
  rewriteAttribute('object[data]', 'data');
  rewriteAttribute('image[href], feImage[href], use[href], script[href], link[href]', 'href');
  rewriteAttribute(
    'image[xlink\\:href], feImage[xlink\\:href], use[xlink\\:href], script[xlink\\:href]',
    'xlink:href',
  );
  rewriteAttribute('body[background], table[background], td[background], th[background]', 'background');
  for (const element of root.querySelectorAll<HTMLElement>('img[srcset], source[srcset]')) {
    const rawSrcSet = element.getAttribute('srcset');
    if (rawSrcSet === null) continue;
    element.setAttribute(
      'srcset',
      rewriteSrcSetValue(
        rawSrcSet,
        (rawUrl) => proxiedArtifactReferenceUrl(rawUrl, artifactUrl, provider),
      ),
    );
  }
  for (const element of root.querySelectorAll<HTMLElement>('link[imagesrcset]')) {
    const rawSrcSet = element.getAttribute('imagesrcset');
    if (rawSrcSet === null) continue;
    element.setAttribute(
      'imagesrcset',
      rewriteSrcSetValue(
        rawSrcSet,
        (rawUrl) => proxiedArtifactReferenceUrl(rawUrl, artifactUrl, provider),
      ),
    );
  }
  rewriteAttribute('[poster]', 'poster');
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const rawHref = link.getAttribute('href');
    if (rawHref === null) continue;
    const resolved = resolveArtifactReferenceUrl(rawHref, artifactUrl, provider);
    if (resolved === null) continue;
    link.href = resolved;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
}

function decodeHtmlAttributeValue(value: string): string {
  return value.replace(
    /&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi,
    (entity) => {
      const normalized = entity.toLowerCase();
      if (normalized === '&amp;') return '&';
      if (normalized === '&quot;') return '"';
      if (normalized === '&apos;') return "'";
      if (normalized === '&lt;') return '<';
      if (normalized === '&gt;') return '>';
      const numeric = normalized.startsWith('&#x')
        ? Number.parseInt(normalized.slice(3, -1), 16)
        : Number.parseInt(normalized.slice(2, -1), 10);
      return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff
        ? String.fromCodePoint(numeric)
        : entity;
    },
  );
}

function rewriteResourceAttributes(
  html: string,
  artifactUrl: string,
  provider: ArtifactProviderLocation,
): string {
  const rewriteAttribute = (tag: string, attribute: string): string => tag.replace(
    new RegExp(`(\\s${attribute}\\s*=\\s*)(["'])(.*?)\\2`, 'gi'),
    (match, prefix: string, quote: string, rawValue: string) => {
      const proxied = proxiedArtifactReferenceUrl(
        decodeHtmlAttributeValue(rawValue),
        artifactUrl,
        provider,
      );
      const escaped = proxied?.replace(/&/g, '&amp;');
      return escaped === undefined ? match : `${prefix}${quote}${escaped}${quote}`;
    },
  );
  const rewriteSrcSet = (tag: string, attribute = 'srcset'): string => tag.replace(
    new RegExp(`(\\s${attribute}\\s*=\\s*)(["'])(.*?)\\2`, 'gi'),
    (match, prefix: string, quote: string, rawValue: string) => {
      const rewritten = rewriteSrcSetValue(
        rawValue,
        (rawUrl) => proxiedArtifactReferenceUrl(
          decodeHtmlAttributeValue(rawUrl),
          artifactUrl,
          provider,
        )?.replace(/&/g, '&amp;') ?? null,
      );
      return `${prefix}${quote}${rewritten}${quote}`;
    },
  );

  let rewritten = html.replace(
    /<(?:img|video|audio|source|script|iframe|frame|track|embed|input)\b[^>]*>/gi,
    (tag) => rewriteSrcSet(rewriteAttribute(rewriteAttribute(tag, 'src'), 'poster')),
  );
  rewritten = rewritten.replace(
    /<link\b[^>]*>/gi,
    (tag) => rewriteSrcSet(rewriteAttribute(tag, 'href'), 'imagesrcset'),
  );
  rewritten = rewritten.replace(
    /<object\b[^>]*>/gi,
    (tag) => rewriteAttribute(tag, 'data'),
  );
  rewritten = rewritten.replace(
    /<(?:image|feimage|use|script)\b[^>]*>/gi,
    (tag) => rewriteAttribute(rewriteAttribute(tag, 'xlink:href'), 'href'),
  );
  rewritten = rewritten.replace(
    /<(?:body|table|td|th)\b[^>]*>/gi,
    (tag) => rewriteAttribute(tag, 'background'),
  );
  const rewriteCssReference = (rawValue: string): string | null => proxiedArtifactReferenceUrl(
    decodeHtmlAttributeValue(rawValue),
    artifactUrl,
    provider,
  );
  const rewriteCss = (css: string): string => {
    const urlsRewritten = css.replace(
      /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
      (match, quote: string, rawValue: string) => {
        const proxied = rewriteCssReference(rawValue);
        return proxied === null ? match : `url(${quote}${proxied}${quote})`;
      },
    );
    return urlsRewritten.replace(
      /(@import\s+)(["'])([^"']+)\2/gi,
      (match, prefix: string, quote: string, rawValue: string) => {
        const proxied = rewriteCssReference(rawValue);
        return proxied === null ? match : `${prefix}${quote}${proxied}${quote}`;
      },
    );
  };
  rewritten = rewritten.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_match, open: string, css: string, close: string) => `${open}${rewriteCss(css)}${close}`,
  );
  return rewritten.replace(
    /(\bstyle\s*=\s*)(["'])(.*?)\2/gi,
    (_match, prefix: string, quote: string, css: string) => {
      const escapedCss = rewriteCss(css).replace(/&/g, '&amp;');
      return `${prefix}${quote}${escapedCss}${quote}`;
    },
  );
}

/** Inject a safe base element so relative assets resolve against the artifact URL. */
export function injectArtifactBaseUrl(
  rawHtml: string,
  artifactUrl: string,
  provider: ArtifactProviderLocation,
): string {
  const rewrittenHtml = rewriteResourceAttributes(rawHtml, artifactUrl, provider);
  const href = artifactContentBaseUrl(artifactUrl, provider)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
  const base = `<base href="${href}">`;
  if (/<head\b[^>]*>/i.test(rewrittenHtml)) {
    return rewrittenHtml.replace(/<head\b[^>]*>/i, (head) => `${head}${base}`);
  }
  return `${base}${rewrittenHtml}`;
}
