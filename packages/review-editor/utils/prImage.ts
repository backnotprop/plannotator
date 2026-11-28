import type { ImageResolver } from '@plannotator/ui/components/ImageResolverContext';
import type { PRMetadata } from '@plannotator/shared/pr-types';
import { parseSrcset, serializeSrcset } from '@plannotator/ui/utils/srcset';
import { isGitHubAttachmentUrl } from '@plannotator/core/pr-attachment-url';
import { artifactContentProxyUrl } from '../dock/panels/artifactDocument';
import { isKnownForgejoAssetUrl } from './prArtifacts';

/**
 * Whether GitHub attachment images in this PR's text load through the server
 * proxy. The server reads github.com attachments with the reviewer's token only
 * for a PR on github.com (`isGitHubArtifactHost`) and answers 403 for any other
 * PR, so in a GitLab MR or a GitHub Enterprise PR they keep loading directly.
 */
export function proxiesGitHubImages(pr: Pick<PRMetadata, 'platform' | 'url'> | null | undefined): boolean {
  if (!pr || pr.platform !== 'github') return false;
  try {
    return new URL(pr.url).origin.toLowerCase() === 'https://github.com';
  } catch {
    return false;
  }
}

/** Keep provider credentials server-side when loading GitHub attachment images. */
export function prImageSrc(src: string): string {
  // Relative and non-URL sources retain the renderer's existing behavior.
  return isGitHubAttachmentUrl(src) ? artifactContentProxyUrl(new URL(src).href) : src;
}

/**
 * A `srcset` with each candidate URL passed through `prImageSrc`, descriptors
 * kept, so a `<picture>`'s dark-mode `<source>` loads through the proxy too.
 * Candidates are split as the browser splits them, so a `data:` URL's comma
 * stays inside its URL.
 */
export function prImageSrcset(srcset: string, resolve: (src: string) => string = prImageSrc): string {
  return serializeSrcset(
    parseSrcset(srcset).map(({ url, descriptors }) => ({ url: resolve(url), descriptors })),
  );
}

type ForgejoPR = Extract<PRMetadata, { platform: 'forgejo' }>;

/** Applies `rewrite` to the text outside fenced code blocks and inline code spans, which stay as written. */
function outsideCode(markdown: string, rewrite: (text: string) => string): string {
  let fence: string | null = null;
  return markdown.split('\n').map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      return line;
    }
    if (marker) {
      fence = marker;
      return line;
    }
    return line.split(/(`+[^`]*`+)/).map((part, index) => (index % 2 === 1 ? part : rewrite(part))).join('');
  }).join('\n');
}

/**
 * A Forgejo PR's own uploads in comment text. The editor writes them as
 * relative links (`![a.png](/attachments/<uuid>)`), which the comment renderer
 * would show as plain text and which need the reviewer's token to load. The
 * links are made absolute on the PR's own origin, and then load through the
 * same proxy as GitHub's. A link to any other place is left as it was.
 */
export function forgejoImageHandling(pr: PRMetadata | null | undefined): {
  prepare: (markdown: string) => string;
  src: (src: string) => string;
  /** The same, for a renderer that asks about each image as written (the PR description). */
  resolve: ImageResolver;
} | null {
  if (!pr || pr.platform !== 'forgejo') return null;
  const origin = new URL(pr.url).origin;
  const known = (raw: string): URL | null => {
    try {
      const url = new URL(raw, origin);
      return isKnownForgejoAssetUrl(url, pr) ? url : null;
    } catch {
      return null;
    }
  };
  return {
    prepare: (markdown) => outsideCode(markdown, (text) => text.replace(/!\[([^\]]*)\]\((\/[^)\s]+)\)/g, (whole, alt: string, path: string) => {
      const url = known(path);
      return url ? `![${alt}](${url.href})` : whole;
    })),
    src: (src) => {
      const url = known(src);
      return url ? artifactContentProxyUrl(url.href) : src;
    },
    resolve: (src) => {
      const url = known(src);
      return url ? { kind: 'src', src: artifactContentProxyUrl(url.href) } : null;
    },
  };
}

export const resolvePRImage: ImageResolver = (src) => {
  const resolved = prImageSrc(src);
  return resolved === src ? null : { kind: 'src', src: resolved };
};
