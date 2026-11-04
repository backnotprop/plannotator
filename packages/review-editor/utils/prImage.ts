import type { ImageResolver } from '@plannotator/ui/components/ImageResolverContext';
import type { PRMetadata } from '@plannotator/shared/pr-types';
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
  try {
    const url = new URL(src);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return src;
    if (
      (url.hostname === 'github.com' && /^\/user-attachments\/(?:assets|files)\//.test(url.pathname))
      || url.hostname === 'user-images.githubusercontent.com'
      || url.hostname === 'private-user-images.githubusercontent.com'
    ) {
      return artifactContentProxyUrl(url.href);
    }
  } catch {
    // Relative and non-URL sources retain the renderer's existing behavior.
  }
  return src;
}

/**
 * A `srcset` with each candidate URL passed through `prImageSrc`, descriptors
 * kept, so a `<picture>`'s dark-mode `<source>` loads through the proxy too.
 */
export function prImageSrcset(srcset: string): string {
  return srcset
    .split(',')
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .map((candidate) => {
      const [url = '', ...descriptors] = candidate.split(/\s+/);
      return [prImageSrc(url), ...descriptors].join(' ');
    })
    .join(', ');
}

export const resolvePRImage: ImageResolver = (src) => {
  const resolved = prImageSrc(src);
  return resolved === src ? null : { kind: 'src', src: resolved };
};
