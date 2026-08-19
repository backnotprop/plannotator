import { marked, type Token } from 'marked';
import { isPRArtifactDocumentUrlAllowed } from '@plannotator/shared/pr-artifact-document';
import type { PRContext, PRMetadata } from '@plannotator/shared/pr-types';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov']);
const HTML_EXTENSIONS = new Set(['html', 'htm']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);
const MAX_ARTIFACT_NAME_CHARS = 120;

type AuthoredAs = 'image' | 'video' | 'link';

interface RawArtifactRef {
  readonly url: string;
  readonly label: string;
  readonly authoredAs: AuthoredAs;
}

/** The render strategy for one harvested pull-request or merge-request attachment. */
export type PRArtifactKind = 'image' | 'gif' | 'video' | 'html' | 'markdown';

/** The review surface containing the canonical occurrence of an attachment. */
export type PRArtifactProvenance =
  | {
      readonly surface: 'description';
      readonly authorLogin: string;
      readonly sourceUrl: string;
    }
  | {
      readonly surface: 'comment' | 'review';
      readonly authorLogin: string;
      readonly sourceUrl: string;
      readonly createdAt: string;
      readonly refId: string;
    }
  | {
      readonly surface: 'review-thread';
      readonly authorLogin: string;
      readonly sourceUrl: string;
      readonly createdAt: string;
      readonly refId: string;
      readonly resolved: boolean;
    };

/** A read-only attachment harvested from hosted change-request markdown. */
export interface PRArtifact {
  readonly id: string;
  readonly kind: PRArtifactKind;
  readonly name: string;
  readonly url: string;
  readonly provenance: PRArtifactProvenance;
  /** Exact authored markdown containing this artifact, used as review context. */
  readonly sourceMarkdown: string;
}

interface HarvestSource {
  readonly markdown: string;
  readonly provenance: PRArtifactProvenance;
}

const IMG_TAG_RE = /<img\b[^>]*>/gi;
const SRC_ATTR_RE = /\bsrc\s*=\s*["']([^"']+)["']/i;
const ALT_ATTR_RE = /\balt\s*=\s*["']([^"']*)["']/i;
const VIDEO_SRC_RE = /<(?:video|source)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
const A_HREF_RE = /<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi;

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

function refsFromHtml(html: string): RawArtifactRef[] {
  const refs: RawArtifactRef[] = [];
  for (const tag of html.matchAll(IMG_TAG_RE)) {
    const src = SRC_ATTR_RE.exec(tag[0])?.[1];
    if (src === undefined) continue;
    refs.push({
      url: decodeHtmlAttributeValue(src),
      label: decodeHtmlAttributeValue(ALT_ATTR_RE.exec(tag[0])?.[1] ?? ''),
      authoredAs: 'image',
    });
  }
  for (const match of html.matchAll(VIDEO_SRC_RE)) {
    refs.push({
      url: decodeHtmlAttributeValue(match[1] ?? ''),
      label: '',
      authoredAs: 'video',
    });
  }
  for (const match of html.matchAll(A_HREF_RE)) {
    refs.push({
      url: decodeHtmlAttributeValue(match[1] ?? ''),
      label: '',
      authoredAs: 'link',
    });
  }
  return refs;
}

function collectRefs(markdown: string): RawArtifactRef[] {
  if (markdown.trim() === '') return [];
  const refs: RawArtifactRef[] = [];
  const tokens = marked.lexer(markdown, { gfm: true });
  marked.walkTokens(tokens, (token: Token) => {
    switch (token.type) {
      case 'image':
        refs.push({
          url: decodeHtmlAttributeValue(token.href),
          label: token.text ?? '',
          authoredAs: 'image',
        });
        break;
      case 'link':
        refs.push({
          url: decodeHtmlAttributeValue(token.href),
          label: token.text ?? '',
          authoredAs: 'link',
        });
        break;
      case 'html':
        refs.push(...refsFromHtml(token.raw));
        break;
    }
  });
  return refs;
}

function isKnownGitHubAssetUrl(url: URL, githubHost: string): boolean {
  const host = url.host.toLowerCase();
  if (host === 'user-images.githubusercontent.com' || host === 'private-user-images.githubusercontent.com') {
    return true;
  }
  const normalizedGithubHost = githubHost.toLowerCase();
  return (
    (host === 'github.com' || host === normalizedGithubHost) &&
    /^\/user-attachments\/(?:assets|files)\//.test(url.pathname)
  );
}

function isKnownGitLabAssetUrl(
  url: URL,
  metadata: Extract<PRMetadata, { platform: 'gitlab' }>,
): boolean {
  if (url.host.toLowerCase() !== metadata.host.toLowerCase()) return false;
  const projectPath = `/${metadata.projectPath.replace(/^\/+|\/+$/g, '')}`;
  return url.pathname.startsWith('/uploads/')
    || url.pathname.startsWith(`${projectPath}/uploads/`);
}

function resolveArtifactUrl(raw: string, baseUrl: string): URL | null {
  try {
    const url = new URL(raw, baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function classifyArtifactUrl(
  url: URL,
  label: string,
  authoredAs: AuthoredAs,
  metadata: PRMetadata,
): PRArtifactKind | null {
  const urlExtension = /\.([a-z0-9]+)$/.exec(url.pathname.toLowerCase())?.[1];
  const labelExtension = /\.([a-z0-9]+)$/.exec(label.trim().toLowerCase())?.[1];
  const extension = urlExtension ?? (
    metadata.platform === 'github' && isKnownGitHubAssetUrl(url, metadata.host)
      ? labelExtension
      : undefined
  );
  if (extension !== undefined) {
    if (extension === 'gif') return 'gif';
    if (IMAGE_EXTENSIONS.has(extension)) return 'image';
    if (VIDEO_EXTENSIONS.has(extension)) return 'video';
    if (HTML_EXTENSIONS.has(extension)) return 'html';
    if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown';
  }
  if (metadata.platform === 'github' && isKnownGitHubAssetUrl(url, metadata.host)) {
    // GitHub inserts pasted videos as a bare user-attachments URL with no
    // extension. Images retain image markdown, so an untyped link here is the
    // only durable authored signal that the attachment is video.
    return authoredAs === 'image' ? 'image' : 'video';
  }
  if (authoredAs === 'image') return 'image';
  if (authoredAs === 'video') return 'video';
  return null;
}

function sanitizeArtifactName(raw: string): string {
  const cleaned = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are intentionally stripped from display names.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '')
    .trim();
  return cleaned.slice(0, MAX_ARTIFACT_NAME_CHARS).trim() || 'artifact';
}

function artifactName(ref: RawArtifactRef, url: URL): string {
  const label = ref.label.trim();
  if (label !== '' && label !== ref.url) return sanitizeArtifactName(label);
  const filename = url.pathname.split('/').filter(Boolean).at(-1);
  if (filename !== undefined) {
    try {
      return sanitizeArtifactName(decodeURIComponent(filename));
    } catch {
      return sanitizeArtifactName(filename);
    }
  }
  return sanitizeArtifactName(url.hostname);
}

const SIGNING_QUERY_PARAM_RE = /^(?:x-amz-|x-goog-|awsaccesskeyid$|signature$|expires$)/i;

function artifactDedupeKey(url: URL, metadata: PRMetadata): string {
  const pathKey = `${url.origin.toLowerCase()}${url.pathname}`;
  const isPlatformUpload = metadata.platform === 'github'
    ? isKnownGitHubAssetUrl(url, metadata.host)
    : isKnownGitLabAssetUrl(url, metadata);
  if (isPlatformUpload) return pathKey;

  const semanticQuery = new URLSearchParams();
  for (const [name, value] of url.searchParams) {
    if (!SIGNING_QUERY_PARAM_RE.test(name)) semanticQuery.append(name, value);
  }
  semanticQuery.sort();
  const query = semanticQuery.toString();
  return query === '' ? pathKey : `${pathKey}?${query}`;
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function conversationTimestamp(source: HarvestSource): string {
  return source.provenance.surface === 'description' ? '' : source.provenance.createdAt;
}

function conversationRefId(source: HarvestSource): string {
  return source.provenance.surface === 'description' ? '' : source.provenance.refId;
}

function buildSources(metadata: PRMetadata, context: PRContext) {
  const conversation: HarvestSource[] = [
    ...context.comments.map((comment): HarvestSource => ({
      markdown: comment.body,
      provenance: {
        surface: 'comment',
        authorLogin: comment.author,
        sourceUrl: comment.url || metadata.url,
        createdAt: comment.createdAt,
        refId: comment.id,
      },
    })),
    ...context.reviews.map((review): HarvestSource => ({
      markdown: review.body,
      provenance: {
        surface: 'review',
        authorLogin: review.author,
        sourceUrl: review.url || metadata.url,
        createdAt: review.submittedAt,
        refId: review.id,
      },
    })),
    ...context.reviewThreads.flatMap((thread) =>
      thread.comments.map((comment): HarvestSource => ({
        markdown: comment.body,
        provenance: {
          surface: 'review-thread',
          authorLogin: comment.author,
          sourceUrl: comment.url || metadata.url,
          createdAt: comment.createdAt,
          refId: comment.id,
          resolved: thread.isResolved,
        },
      })),
    ),
  ].sort(
    (left, right) =>
      conversationTimestamp(right).localeCompare(conversationTimestamp(left)) ||
      conversationRefId(right).localeCompare(conversationRefId(left)),
  );

  return [
    {
      markdown: context.body,
      provenance: {
        surface: 'description',
        authorLogin: metadata.author,
        sourceUrl: metadata.url,
      },
    } satisfies HarvestSource,
    ...conversation,
  ];
}

/**
 * Harvest viewable attachments from a hosted PR/MR's normalized live context.
 * Relative upload URLs are resolved against the change request's host URL.
 * Returns an empty catalog for local reviews or absent context.
 * The description is canonical: if a URL appears more than once, its first
 * description/comment occurrence supplies the retained provenance.
 */
export function buildPRArtifacts(
  metadata: PRMetadata | null,
  context: PRContext | null,
): readonly PRArtifact[] {
  if (metadata === null || context === null) return [];

  const seen = new Set<string>();
  const artifacts: PRArtifact[] = [];
  for (const source of buildSources(metadata, context)) {
    for (const ref of collectRefs(source.markdown)) {
      const url = resolveArtifactUrl(ref.url, metadata.url);
      if (url === null) continue;
      if (!isPRArtifactDocumentUrlAllowed(url.href, metadata, context)) continue;
      const kind = classifyArtifactUrl(url, ref.label, ref.authoredAs, metadata);
      if (kind === null) continue;
      const key = artifactDedupeKey(url, metadata);
      if (seen.has(key)) continue;
      seen.add(key);
      artifacts.push({
        id: `pr-artifact-${fnv1aHex(key)}`,
        kind,
        name: artifactName(ref, url),
        url: url.href,
        provenance: source.provenance,
        sourceMarkdown: source.markdown,
      });
    }
  }
  return artifacts;
}
