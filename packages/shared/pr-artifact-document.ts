import { getForgejoOrigin, type PRContext, type PRMetadata, type PRRuntime } from './pr-types';
import { ghAccountTokenFor } from './pr-github-account';

const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 4;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const AUTH_CACHE_MS = 5 * 60 * 1000;
const PRIVATE_IPV4_RE = /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
const PRIVATE_IPV6_RE = /^\[(?:::1|::ffff:|fe80:|fc|fd)/i;
/**
 * A GitLab upload secret is 32 lowercase hex characters and the filename is a single path
 * segment. Matching a looser shape would let a link in an attacker-authored MR body steer
 * the rewritten, credentialed GET at an arbitrary `/api/v4/...` path, leaving the safety of
 * that request to GitLab's router rather than to this allowlist.
 */
const GITLAB_UPLOAD_RE = /^\/uploads\/([0-9a-f]{32})\/([^/]+)$/;
/** Provider sign-in entry points. Landing here means our credentials were not accepted. */
const SIGN_IN_PATH_RE = /^\/(?:users\/(?:sign_in|auth)|login|session|oauth\/authorize)(?:\/|$)/;

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
  readonly followRedirect?: (next: URL) => boolean;
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
    if (needles.some((needle) => decodedEntities.includes(needle))) return true;
    // An absolute reference that differs only in the case of its scheme or
    // host, or by naming the default port, still names the requested URL.
    // Nothing else is normalized: an `http://` reference never names an
    // `https://` URL.
    return [...decodedEntities.matchAll(/https?:\/\/[^\s<>"'`\)\]]+/gi)]
      .some(([reference]) => referenceNamesUrl(reference, url));
  });
}

/** A dot segment (`.`/`..`, percent-encoded too) or a backslash, which URL parsing rewrites. */
const PATH_REWRITTEN_BY_PARSING_RE = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)|\\/i;

/**
 * Whether an absolute URL written in the PR text names `url` once only its
 * scheme, host case and default port are normalized. The path is compared as
 * written: a reference whose path URL parsing would rewrite (dot segments, a
 * backslash) never matches, so `…/assets/../../o/r/blob/main/x` does not
 * authorize `o/r/blob/main/x`, a URL the text never names.
 */
function referenceNamesUrl(reference: string, url: URL): boolean {
  const writtenPath = /^https?:\/\/[^/?#]*([^?#]*)/i.exec(reference)?.[1] ?? '';
  if (PATH_REWRITTEN_BY_PARSING_RE.test(writtenPath)) return false;
  try {
    const candidate = new URL(reference);
    candidate.hash = '';
    return candidate.href === url.href;
  } catch {
    return false;
  }
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

const FORGEJO_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type ForgejoArtifactKind = 'attachment' | 'raw' | 'src';

/**
 * Which kind of Forgejo artifact a URL is, or null when it is none. Only the
 * routes Forgejo serves to a token are accepted (`registerMixedRoutes`):
 *   /attachments/<uuid>                       an issue, PR or comment upload
 *   /<owner>/<repo>/attachments/<uuid>        the same, repository-scoped
 *   /<owner>/<repo>/raw/(branch|tag|commit)/<ref>/<path>   a file in the PR's repository
 *   /<owner>/<repo>/src/(branch|tag|commit)/<ref>/<path>    its page, read as the raw file
 * Everything else on the instance, `/api/v1/...` included, is refused, so a
 * link in a PR description cannot steer a credentialed request elsewhere.
 * The origin must be the one the review was started on: a PR whose own `url`
 * names another origin gets no artifacts, so a hostile instance cannot point
 * a token configured for a different instance at itself.
 */
function forgejoArtifactKind(
  url: URL,
  metadata: Extract<PRMetadata, { platform: 'forgejo' }>,
): ForgejoArtifactKind | null {
  const origin = getForgejoOrigin(metadata).toLowerCase();
  if (providerOrigin(metadata) !== origin || !isSameOrigin(url, origin)) return null;
  if (url.username !== '' || url.password !== '') return null;
  // An encoded slash, backslash, dot or percent stays inside one segment here, but a reverse proxy
  // in front of the instance may decode it and route `raw/branch/..%2F..%2Fapi/...` to the API.
  if (/%(?:2f|5c|2e|25)/i.test(url.pathname) || url.pathname.includes('\\')) return null;
  const parts = url.pathname.split('/');
  if (parts.length === 3 && parts[1] === 'attachments') {
    return FORGEJO_UUID_RE.test(parts[2] ?? '') ? 'attachment' : null;
  }
  if (parts.length < 5) return null;
  const [, owner, repo, section, ...rest] = parts;
  if (
    owner?.toLowerCase() !== metadata.owner.toLowerCase()
    || repo?.toLowerCase() !== metadata.repo.toLowerCase()
  ) return null;
  if (section === 'attachments') {
    return rest.length === 1 && FORGEJO_UUID_RE.test(rest[0] ?? '') ? 'attachment' : null;
  }
  if (section !== 'raw' && section !== 'src') return null;
  const [refType, ...path] = rest;
  if (refType !== 'branch' && refType !== 'tag' && refType !== 'commit') return null;
  if (path.length === 0 || path.some((segment) => segment === '')) return null;
  return section;
}

/** A Forgejo `src` page is read as its raw file; the token routes do not serve the page. */
function forgejoContentUrl(
  url: URL,
  metadata: Extract<PRMetadata, { platform: 'forgejo' }>,
): URL {
  if (forgejoArtifactKind(url, metadata) !== 'src') return url;
  const rawUrl = new URL(url);
  const parts = rawUrl.pathname.split('/');
  parts[3] = 'raw';
  rawUrl.pathname = parts.join('/');
  return rawUrl;
}

function gitlabProjectPath(metadata: Extract<PRMetadata, { platform: 'gitlab' }>): string {
  return metadata.projectPath.replace(/^\/+|\/+$/g, '');
}

/**
 * GitLab serves `/uploads/<secret>/<file>` from a Rails web route that only honors
 * session cookies — a `PRIVATE-TOKEN` request is redirected to the sign-in page, so the
 * link is unreadable from a CLI. The uploads REST API serves the same bytes for a token,
 * so route upload links through it.
 */
function gitlabUploadApiUrl(
  url: URL,
  metadata: Extract<PRMetadata, { platform: 'gitlab' }>,
): URL | null {
  const projectPath = gitlabProjectPath(metadata);
  const projectPrefix = `/${projectPath}`;
  const uploadPath = url.pathname.startsWith(`${projectPrefix}/uploads/`)
    ? url.pathname.slice(projectPrefix.length)
    : url.pathname;
  const match = GITLAB_UPLOAD_RE.exec(uploadPath);
  if (match === null) return null;
  const [, secret, filename] = match;
  return new URL(
    `${url.origin}/api/v4/projects/${encodeURIComponent(projectPath)}/uploads/${secret}/${filename}${url.search}`,
  );
}

function isProviderArtifactUrl(url: URL, metadata: PRMetadata): boolean {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  // Bitbucket artifact documents are not supported yet: no URL is a provider artifact.
  if (metadata.platform === 'bitbucket') return false;
  if (metadata.platform === 'forgejo') return forgejoArtifactKind(url, metadata) !== null;
  return metadata.platform === 'github'
    ? isGitHubArtifactHost(url, metadata)
    : isGitLabArtifactHost(url, metadata);
}

function providerContentUrl(url: URL, metadata: PRMetadata): URL {
  if (metadata.platform === 'bitbucket') return url;
  if (metadata.platform === 'forgejo') return forgejoContentUrl(url, metadata);
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

  const uploadUrl = gitlabUploadApiUrl(url, metadata);
  if (uploadUrl !== null) return uploadUrl;

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

const GITHUB_REDIRECT_ORIGINS = new Set([
  'https://github.com',
  'https://raw.githubusercontent.com',
  'https://user-images.githubusercontent.com',
  'https://private-user-images.githubusercontent.com',
]);
const GITHUB_UPLOAD_BUCKET_RE = /^github-production-user-asset-[0-9a-z]+\.s3\.amazonaws\.com$/;

// github.com redirects stay on GitHub's hosts and its S3 upload bucket. GitLab and GitHub Enterprise
// object storage hand off to a host each instance configures, so there only public https is checked.
function mayFollowProviderRedirect(currentUrl: URL, nextUrl: URL, metadata: PRMetadata): boolean {
  if (currentUrl.protocol === 'https:' && nextUrl.protocol !== 'https:') return false;
  if (nextUrl.protocol !== 'https:' && nextUrl.protocol !== 'http:') return false;
  // Forgejo: only to another artifact route on the instance the review was opened on, which may
  // itself be on a private network. Object storage served directly (SERVE_DIRECT) is not followed.
  if (metadata.platform === 'forgejo') return forgejoArtifactKind(nextUrl, metadata) !== null;
  if (nextUrl.username || nextUrl.password || isPrivateNetworkUrl(nextUrl)) return false;
  if (metadata.platform !== 'github' || providerOrigin(metadata) !== 'https://github.com') return true;
  if (nextUrl.origin.toLowerCase() === 'https://media.githubusercontent.com') {
    // Only Git LFS's hand-off for this repository's own file.
    const [kind, owner, repo] = nextUrl.pathname.split('/').filter(Boolean);
    return currentUrl.origin.toLowerCase() === 'https://raw.githubusercontent.com'
      && kind === 'media'
      && owner?.toLowerCase() === metadata.owner.toLowerCase()
      && repo?.toLowerCase() === metadata.repo.toLowerCase();
  }
  return GITHUB_REDIRECT_ORIGINS.has(nextUrl.origin.toLowerCase())
    || (nextUrl.protocol === 'https:' && nextUrl.port === '' && GITHUB_UPLOAD_BUCKET_RE.test(nextUrl.hostname));
}

async function providerAuthHeaders(runtime: PRRuntime, metadata: PRMetadata): Promise<Record<string, string>> {
  // The review runs as another signed-in gh account (#2157): send its token, not the active one's.
  if (metadata.platform === 'github') {
    const chosen = ghAccountTokenFor(metadata);
    if (chosen) return { Authorization: `Bearer ${chosen}` };
  }
  // Forgejo has no CLI to ask: the server hands the runtime the token configured for exactly this origin.
  if (metadata.platform === 'forgejo') {
    const token = runtime.forgejoToken?.(providerOrigin(metadata)) ?? null;
    return token ? { Authorization: `token ${token}` } : {};
  }
  const cacheKey = `${metadata.platform}:${metadata.host.toLowerCase()}`;
  const cached = providerAuthCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = (async (): Promise<Record<string, string>> => {
    try {
      if (metadata.platform === 'bitbucket') return {};
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

/**
 * Our credentials were not accepted. Name the command that fixes it: the alternative is a
 * bare transport status, which reads as a broken artifact rather than a missing login.
 */
function providerAuthRequiredError(metadata: PRMetadata, sentToken = false): PRArtifactDocumentError {
  if (metadata.platform === 'forgejo' && sentToken) {
    return new PRArtifactDocumentError(
      `Artifact host requires authentication: the token for ${providerOrigin(metadata)} was refused: check it `
        + '(scopes read:issue and read:repository), in forgejoTokens in config.json or PLANNOTATOR_FORGEJO_TOKEN',
      401,
    );
  }
  if (metadata.platform === 'forgejo') {
    return new PRArtifactDocumentError(
      `Artifact host requires authentication: add a token for ${providerOrigin(metadata)} under forgejoTokens in config.json `
        + '(scopes read:issue and read:repository), or set PLANNOTATOR_FORGEJO_TOKEN and PLANNOTATOR_FORGEJO_URL',
      401,
    );
  }
  const loginHint = metadata.platform === 'github'
    ? `gh auth login --hostname ${metadata.host}`
    : metadata.platform === 'bitbucket'
      ? 'set PLANNOTATOR_BITBUCKET_TOKEN'
      : `glab auth login --hostname ${metadata.host}`;
  return new PRArtifactDocumentError(
    `Artifact host requires authentication: run \`${loginHint}\``,
    401,
  );
}

/**
 * A direct refusal carries the same diagnosis as a sign-in redirect: GitLab's `/api/v4`
 * routes answer 401/403 as JSON instead of redirecting to a login page. GitHub's 403 is
 * excluded because it also covers rate limiting and SSO enforcement, where a login hint
 * would point at the wrong problem.
 */
function isProviderAuthRefusal(status: number, metadata: PRMetadata): boolean {
  // Forgejo answers 403 to a token missing the scope the attachment needs.
  return status === 401 || (status === 403 && (metadata.platform === 'gitlab' || metadata.platform === 'forgejo'));
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

/**
 * The GitLab uploads API answers every file with `application/octet-stream`. Responses are
 * served with `nosniff`, so an unrefined type would stop images and video from rendering.
 *
 * Deliberately no `html` or `js`: naming an active type here buys nothing, because an HTML
 * artifact is read through the document route, which always serves `text/plain`. Leaving
 * them in would make the safety of the media route depend on its CSP header forever.
 */
const EXTENSION_CONTENT_TYPES: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  css: 'text/css',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  md: 'text/markdown',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  webm: 'video/webm',
  webp: 'image/webp',
};

function refineOpaqueContentType(contentType: string, url: URL): string {
  if (contentType !== 'application/octet-stream') return contentType;
  const extension = url.pathname.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_CONTENT_TYPES[extension] ?? contentType;
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
  const sentToken = Object.keys(providerHeaders).length > 0;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const requestedUrl = new URL(rawUrl);
  requestedUrl.hash = '';
  // Kept so a 404 from the rewritten uploads API can be told apart from a 404 anywhere else.
  const uploadApiUrl = metadata.platform === 'gitlab'
    ? gitlabUploadApiUrl(requestedUrl, metadata)
    : null;
  let currentUrl = providerContentUrl(requestedUrl, metadata);
  const firstOrigin = currentUrl.origin;
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const response = await fetch(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: '*/*',
          'User-Agent': 'Plannotator artifact review',
          ...(isValidRangeHeader(options.range) ? { Range: options.range } : {}),
          // The token never crosses a redirect: GitHub's signed S3 URL needs none.
          ...(shouldSendProviderAuth(currentUrl, metadata) && currentUrl.origin === firstOrigin ? providerHeaders : {}),
        },
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (location === null || redirects === MAX_REDIRECTS) {
          throw new PRArtifactDocumentError('Artifact document redirected too many times', 502);
        }
        const nextUrl = new URL(location, currentUrl);
        // Forgejo sends a signed-out request on an instance that requires sign-in to its login page.
        if (metadata.platform === 'forgejo' && isSameOrigin(nextUrl, providerOrigin(metadata)) && nextUrl.pathname === '/user/login') {
          throw providerAuthRequiredError(metadata, sentToken);
        }
        if (!mayFollowProviderRedirect(currentUrl, nextUrl, metadata) || (options.followRedirect && !options.followRedirect(nextUrl))) {
          throw new PRArtifactDocumentError('Artifact document redirected to a blocked address', 403);
        }
        // A sign-in hop returns HTTP 200 with a login/SSO page. Following it would render
        // that page as the artifact, so fail loudly instead.
        if (SIGN_IN_PATH_RE.test(nextUrl.pathname)) {
          throw providerAuthRequiredError(metadata, sentToken);
        }
        // A Forgejo `src` page is read as its raw file on a redirect hop too.
        currentUrl = metadata.platform === 'forgejo' ? forgejoContentUrl(nextUrl, metadata) : nextUrl;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        // `GET /projects/:id/uploads/:secret/:filename` landed in GitLab 17.4. An older
        // self-hosted instance has no such route, while the original web route still reads
        // a public project anonymously, so retry that route once before giving up. The
        // retry is same-origin, so it carries credentials on the usual terms.
        if (response.status === 404 && uploadApiUrl !== null && currentUrl.href === uploadApiUrl.href) {
          currentUrl = requestedUrl;
          continue;
        }
        if (isProviderAuthRefusal(response.status, metadata)) {
          throw providerAuthRequiredError(metadata, sentToken);
        }
        throw new PRArtifactDocumentError(`Artifact host returned HTTP ${response.status}`, 502);
      }
      const contentType = refineOpaqueContentType(
        response.headers.get('content-type')?.split(';', 1)[0]?.trim() || 'text/plain',
        currentUrl,
      );
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

const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/quicktime', 'video/webm']);

/**
 * Fetch bounded media or a derived document resource with provider authentication.
 * A request without `sourceUrl` is a picture or video and must answer as one.
 */
export async function fetchPRArtifactContent(
  runtime: PRRuntime,
  metadata: PRMetadata,
  context: PRContext,
  rawUrl: string,
  options: PRArtifactContentOptions = {},
): Promise<PRArtifactContent> {
  const content = await fetchArtifactContent(
    runtime,
    metadata,
    context,
    rawUrl,
    MAX_MEDIA_BYTES,
    options,
  );
  if (options.sourceUrl === undefined && !MEDIA_TYPES.has(content.contentType.toLowerCase())) {
    throw new PRArtifactDocumentError('Artifact is not a picture or video', 415);
  }
  return content;
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
