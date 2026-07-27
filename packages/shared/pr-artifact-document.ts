import type { PRContext, PRMetadata, PRRuntime } from './pr-types';

const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 4;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const AUTH_CACHE_MS = 5 * 60 * 1000;
const PRIVATE_IPV4_RE = /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
const PRIVATE_IPV6_RE = /^\[(?:::1|::ffff:|fe80:|fc|fd)/i;

interface ProviderAuthCacheEntry {
  readonly expiresAt: number;
  readonly promise: Promise<Record<string, string>>;
}

const providerAuthCache = new Map<string, ProviderAuthCacheEntry>();

export class PRArtifactDocumentError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'PRArtifactDocumentError';
    this.status = status;
  }
}

export interface PRArtifactDocument {
  readonly content: string;
  readonly contentType: string;
}

/** Bounded provider content suitable for a same-origin media response. */
export interface PRArtifactContent {
  readonly content: Uint8Array;
  readonly contentType: string;
  readonly status: number;
  readonly contentRange?: string;
  readonly acceptRanges?: string;
}

export interface PRArtifactContentOptions {
  /** Context-referenced document from which a relative resource was derived. */
  readonly sourceUrl?: string;
  /** Valid single-range header forwarded for video seeking. */
  readonly range?: string;
}

function contextMarkdown(context: PRContext): readonly string[] {
  return [
    context.body,
    ...context.comments.map((comment) => comment.body),
    ...context.reviews.map((review) => review.body),
    ...context.reviewThreads.flatMap((thread) => thread.comments.map((comment) => comment.body)),
  ];
}

function decodeHtmlEntities(value: string): string {
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

function isReferencedByContext(url: URL, metadata: PRMetadata, context: PRContext): boolean {
  const metadataOrigin = new URL(metadata.url).origin.toLowerCase();
  const needles = [url.href];
  if (url.origin.toLowerCase() === metadataOrigin) {
    needles.push(`${url.pathname}${url.search}`);
  }
  return contextMarkdown(context).some((markdown) => {
    const decodedEntities = decodeHtmlEntities(markdown);
    return needles.some((needle) => decodedEntities.includes(needle));
  });
}

function providerOrigin(metadata: PRMetadata): string {
  return new URL(metadata.url).origin.toLowerCase();
}

function isSameOrigin(url: URL, origin: string): boolean {
  return url.origin.toLowerCase() === origin;
}

interface GitHubRepositoryPath {
  readonly mode: 'blob' | 'raw';
  readonly remainder: string;
}

function githubRepositoryPath(
  url: URL,
  metadata: Extract<PRMetadata, { platform: 'github' }>,
): GitHubRepositoryPath | null {
  const [owner, repo, rawMode, ...remainder] = url.pathname.split('/').filter(Boolean);
  if (
    owner?.toLowerCase() !== metadata.owner.toLowerCase()
    || repo?.toLowerCase() !== metadata.repo.toLowerCase()
  ) return null;
  const mode = rawMode?.toLowerCase();
  if ((mode !== 'blob' && mode !== 'raw') || remainder.length === 0) return null;
  return { mode, remainder: remainder.join('/') };
}

function isGitHubArtifactHost(url: URL, metadata: Extract<PRMetadata, { platform: 'github' }>): boolean {
  const origin = url.origin.toLowerCase();
  const metadataOrigin = providerOrigin(metadata);
  if (origin === metadataOrigin) {
    if (/^\/user-attachments\/(?:assets|files)\//.test(url.pathname)) return true;
    return githubRepositoryPath(url, metadata) !== null;
  }
  if (metadataOrigin !== 'https://github.com') return false;
  if (origin === 'https://raw.githubusercontent.com') {
    const [owner, repo] = url.pathname.split('/').filter(Boolean);
    return owner?.toLowerCase() === metadata.owner.toLowerCase()
      && repo?.toLowerCase() === metadata.repo.toLowerCase();
  }
  return origin === 'https://user-images.githubusercontent.com'
    || origin === 'https://private-user-images.githubusercontent.com';
}

function isGitLabArtifactHost(url: URL, metadata: Extract<PRMetadata, { platform: 'gitlab' }>): boolean {
  if (!isSameOrigin(url, providerOrigin(metadata))) return false;
  const projectPath = `/${metadata.projectPath.replace(/^\/+|\/+$/g, '')}`;
  return url.pathname.startsWith('/uploads/')
    || url.pathname.startsWith(`${projectPath}/uploads/`)
    || url.pathname.startsWith(`${projectPath}/-/raw/`)
    || url.pathname.startsWith(`${projectPath}/-/blob/`);
}

function isProviderArtifactUrl(url: URL, metadata: PRMetadata): boolean {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  return metadata.platform === 'github'
    ? isGitHubArtifactHost(url, metadata)
    : isGitLabArtifactHost(url, metadata);
}

function providerContentUrl(url: URL, metadata: PRMetadata): URL {
  if (metadata.platform === 'github') {
    const metadataOrigin = providerOrigin(metadata);
    if (isSameOrigin(url, metadataOrigin)) {
      const repositoryPath = githubRepositoryPath(url, metadata);
      if (repositoryPath !== null) {
        const repoPrefix = `/${metadata.owner}/${metadata.repo}/`;
        if (metadataOrigin === 'https://github.com') {
          return new URL(
            `https://raw.githubusercontent.com${repoPrefix}${repositoryPath.remainder}${url.search}`,
          );
        }
        if (repositoryPath.mode === 'blob') {
          return new URL(
            `${url.origin}${repoPrefix}raw/${repositoryPath.remainder}${url.search}`,
          );
        }
      }
    }
    return url;
  }

  const blobMarker = '/-/blob/';
  if (url.pathname.includes(blobMarker)) {
    const rawUrl = new URL(url);
    rawUrl.pathname = rawUrl.pathname.replace(blobMarker, '/-/raw/');
    return rawUrl;
  }
  return url;
}

/** True only for context-referenced attachment/file URLs on the active provider. */
export function isPRArtifactDocumentUrlAllowed(
  rawUrl: string,
  metadata: PRMetadata,
  context: PRContext,
): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  url.hash = '';
  return isProviderArtifactUrl(url, metadata)
    && isReferencedByContext(url, metadata, context);
}

function isPRArtifactContentUrlAllowed(
  rawUrl: string,
  sourceUrl: string | undefined,
  metadata: PRMetadata,
  context: PRContext,
): boolean {
  if (sourceUrl === undefined) {
    return isPRArtifactDocumentUrlAllowed(rawUrl, metadata, context);
  }
  if (!isPRArtifactDocumentUrlAllowed(sourceUrl, metadata, context)) return false;
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    return isProviderArtifactUrl(url, metadata);
  } catch {
    return false;
  }
}

function isPrivateNetworkUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === 'localhost'
    || host === '0.0.0.0'
    || host === '::1'
    || host === '[::1]'
    || host.endsWith('.local')
    || PRIVATE_IPV4_RE.test(host)
    || PRIVATE_IPV6_RE.test(host);
}

function mayFollowProviderRedirect(currentUrl: URL, nextUrl: URL): boolean {
  if (currentUrl.protocol === 'https:' && nextUrl.protocol !== 'https:') return false;
  return (nextUrl.protocol === 'https:' || nextUrl.protocol === 'http:')
    && !isPrivateNetworkUrl(nextUrl);
}

async function providerAuthHeaders(runtime: PRRuntime, metadata: PRMetadata): Promise<Record<string, string>> {
  const cacheKey = `${metadata.platform}:${metadata.host.toLowerCase()}`;
  const cached = providerAuthCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = (async (): Promise<Record<string, string>> => {
    try {
      const command = metadata.platform === 'github' ? 'gh' : 'glab';
      const args = metadata.platform === 'github'
        ? ['auth', 'token', '--hostname', metadata.host]
        : ['config', 'get', 'token', '--host', metadata.host];
      const result = await runtime.runCommand(command, args);
      const token = result.exitCode === 0 ? result.stdout.trim() : '';
      if (token === '') return {};
      return metadata.platform === 'github'
        ? { Authorization: `Bearer ${token}` }
        : { 'PRIVATE-TOKEN': token };
    } catch {
      return {};
    }
  })();
  providerAuthCache.set(cacheKey, { expiresAt: Date.now() + AUTH_CACHE_MS, promise });
  const headers = await promise;
  if (Object.keys(headers).length === 0) {
    providerAuthCache.delete(cacheKey);
  }
  return headers;
}

function shouldSendProviderAuth(url: URL, metadata: PRMetadata): boolean {
  const origin = url.origin.toLowerCase();
  const metadataOrigin = providerOrigin(metadata);
  if (origin === metadataOrigin) return true;
  if (metadata.platform === 'gitlab' || metadataOrigin !== 'https://github.com') return false;
  return origin === 'https://raw.githubusercontent.com'
    || origin === 'https://private-user-images.githubusercontent.com';
}

function responseContentLength(response: Response): number | undefined {
  const contentEncoding = response.headers.get('content-encoding');
  if (contentEncoding !== null && contentEncoding.toLowerCase() !== 'identity') return undefined;
  const rawLength = response.headers.get('content-length');
  if (rawLength === null || !/^\d+$/.test(rawLength)) return undefined;
  const contentLength = Number(rawLength);
  return Number.isSafeInteger(contentLength) ? contentLength : undefined;
}

async function rejectOversizedResponse(response: Response, maxBytes: number): Promise<void> {
  const contentLength = responseContentLength(response);
  if (contentLength === undefined || contentLength <= maxBytes) return;
  await response.body?.cancel();
  throw new PRArtifactDocumentError('Artifact content is too large to preview', 413);
}

async function readBytesWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
  await rejectOversizedResponse(response, maxBytes);
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const content = new Uint8Array(await response.arrayBuffer());
    if (content.byteLength > maxBytes) {
      throw new PRArtifactDocumentError('Artifact content is too large to preview', 413);
    }
    return content;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    totalBytes += chunk.value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new PRArtifactDocumentError('Artifact content is too large to preview', 413);
    }
    chunks.push(chunk.value);
  }
  const content = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

function isValidRangeHeader(range: string | undefined): range is string {
  return range !== undefined && /^bytes=\d*-\d*$/.test(range);
}

function proxyUrl(rawUrl: string, sourceUrl: string): string {
  return `/api/pr-artifact-content?${new URLSearchParams({ url: rawUrl, source: sourceUrl })}`;
}

function rewriteCssReferences(
  css: string,
  cssUrl: URL,
  sourceUrl: string,
  metadata: PRMetadata,
): string {
  const rewriteReference = (rawReference: string): string | null => {
    const reference = rawReference.trim();
    if (reference === '' || reference.startsWith('#') || /^(?:data|blob):/i.test(reference)) {
      return null;
    }
    try {
      const resolved = new URL(reference, cssUrl);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
      if (!isProviderArtifactUrl(resolved, metadata)) return null;
      return proxyUrl(resolved.href, sourceUrl);
    } catch {
      return null;
    }
  };
  const urlsRewritten = css.replace(
    /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
    (match, quote: string, rawReference: string) => {
      const rewritten = rewriteReference(rawReference);
      return rewritten === null ? match : `url(${quote}${rewritten}${quote})`;
    },
  );
  return urlsRewritten.replace(
    /(@import\s+)(["'])([^"']+)\2/gi,
    (match, prefix: string, quote: string, rawReference: string) => {
      const rewritten = rewriteReference(rawReference);
      return rewritten === null ? match : `${prefix}${quote}${rewritten}${quote}`;
    },
  );
}

async function fetchArtifactContent(
  runtime: PRRuntime,
  metadata: PRMetadata,
  context: PRContext,
  rawUrl: string,
  maxBytes: number,
  options: PRArtifactContentOptions,
): Promise<PRArtifactContent> {
  if (!isPRArtifactContentUrlAllowed(rawUrl, options.sourceUrl, metadata, context)) {
    throw new PRArtifactDocumentError('Artifact URL is not available in this review', 403);
  }

  const providerHeaders = await providerAuthHeaders(runtime, metadata);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let currentUrl = providerContentUrl(new URL(rawUrl), metadata);
  currentUrl.hash = '';
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const response = await fetch(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: '*/*',
          'User-Agent': 'Plannotator artifact review',
          ...(isValidRangeHeader(options.range) ? { Range: options.range } : {}),
          ...(shouldSendProviderAuth(currentUrl, metadata) ? providerHeaders : {}),
        },
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (location === null || redirects === MAX_REDIRECTS) {
          throw new PRArtifactDocumentError('Artifact document redirected too many times', 502);
        }
        const nextUrl = new URL(location, currentUrl);
        if (!mayFollowProviderRedirect(currentUrl, nextUrl)) {
          throw new PRArtifactDocumentError('Artifact document redirected to a blocked address', 403);
        }
        currentUrl = nextUrl;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new PRArtifactDocumentError(`Artifact host returned HTTP ${response.status}`, 502);
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim()
        || 'text/plain';
      const shouldRewriteCss = contentType === 'text/css' && options.sourceUrl !== undefined;
      let content = await readBytesWithLimit(
        response,
        shouldRewriteCss ? Math.min(maxBytes, MAX_DOCUMENT_BYTES) : maxBytes,
      );
      if (shouldRewriteCss && options.sourceUrl !== undefined) {
        const css = new TextDecoder().decode(content);
        content = new TextEncoder().encode(
          rewriteCssReferences(css, currentUrl, options.sourceUrl, metadata),
        );
      }
      const contentRange = response.headers.get('content-range');
      const acceptRanges = response.headers.get('accept-ranges');
      return {
        content,
        contentType,
        status: response.status,
        ...(contentRange === null ? {} : { contentRange }),
        ...(acceptRanges === null ? {} : { acceptRanges }),
      };
    }
    throw new PRArtifactDocumentError('Artifact document redirected too many times', 502);
  } catch (error) {
    if (error instanceof PRArtifactDocumentError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new PRArtifactDocumentError('Artifact document request timed out', 504);
    }
    throw new PRArtifactDocumentError('Failed to fetch artifact document', 502);
  } finally {
    clearTimeout(timeout);
  }
}

/** Fetch bounded media or a derived document resource with provider authentication. */
export function fetchPRArtifactContent(
  runtime: PRRuntime,
  metadata: PRMetadata,
  context: PRContext,
  rawUrl: string,
  options: PRArtifactContentOptions = {},
): Promise<PRArtifactContent> {
  return fetchArtifactContent(
    runtime,
    metadata,
    context,
    rawUrl,
    MAX_MEDIA_BYTES,
    options,
  );
}

/** Fetch one active PR/MR text document without exposing provider credentials to the browser. */
export async function fetchPRArtifactDocument(
  runtime: PRRuntime,
  metadata: PRMetadata,
  context: PRContext,
  rawUrl: string,
): Promise<PRArtifactDocument> {
  const result = await fetchArtifactContent(
    runtime,
    metadata,
    context,
    rawUrl,
    MAX_DOCUMENT_BYTES,
    {},
  );
  return {
    content: new TextDecoder().decode(result.content),
    contentType: result.contentType,
  };
}
