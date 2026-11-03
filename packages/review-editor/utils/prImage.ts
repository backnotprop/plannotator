import type { ImageResolver } from '@plannotator/ui/components/ImageResolverContext';
import { artifactContentProxyUrl } from '../dock/panels/artifactDocument';

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

export const resolvePRImage: ImageResolver = (src) => {
  const resolved = prImageSrc(src);
  return resolved === src ? null : { kind: 'src', src: resolved };
};
