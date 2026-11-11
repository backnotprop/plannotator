import type { ImageResolver } from '@plannotator/ui/components/ImageResolverContext';
import type { PRMetadata } from '@plannotator/shared/pr-types';
import { parseSrcset, serializeSrcset } from '@plannotator/ui/utils/srcset';
import { isGitHubAttachmentUrl } from '@plannotator/core/pr-attachment-url';
import { artifactContentProxyUrl } from '../dock/panels/artifactDocument';

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
export function prImageSrcset(srcset: string): string {
  return serializeSrcset(
    parseSrcset(srcset).map(({ url, descriptors }) => ({ url: prImageSrc(url), descriptors })),
  );
}

export const resolvePRImage: ImageResolver = (src) => {
  const resolved = prImageSrc(src);
  return resolved === src ? null : { kind: 'src', src: resolved };
};
