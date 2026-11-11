import type { PRMetadata } from '@plannotator/shared/pr-types';
import { findPRArtifactByUrl, type PRArtifact } from './prArtifacts';

const PROXY_PATH = '/api/pr-artifact-content';

/**
 * The URL the PR's text wrote for a picture, video or link the page shows.
 * A picture the proxy serves carries the proxy's address, so its `url`
 * parameter is the one the text wrote; a markdown image also says it as
 * `data-image-src`.
 */
export function writtenMediaUrl(element: Element): string | null {
  const written = element.getAttribute('data-image-src');
  if (written) return written;
  const raw = element.tagName === 'A'
    ? element.getAttribute('href')
    : element.getAttribute('src') ?? element.querySelector('source[src]')?.getAttribute('src') ?? null;
  if (!raw) return null;
  try {
    // Off http(s) (a test page) the proxy address is written relative.
    const url = new URL(raw, /^https?:$/.test(window.location.protocol) ? window.location.href : 'http://page.invalid');
    if (url.pathname === PROXY_PATH && (raw.startsWith('/') || url.origin === window.location.origin)) {
      return url.searchParams.get('url') ?? raw;
    }
  } catch {
    // Not a URL: the artifact lookup decides.
  }
  return raw;
}

/**
 * What a picture, video or link in PR text opens: the Artifacts panel when
 * the list holds it. A link opens there only for a video (a pasted GitHub
 * video is a bare link), so links to pages keep opening the forge.
 */
export function mediaArtifact(
  element: Element,
  artifacts: readonly PRArtifact[],
  metadata: PRMetadata | null,
): PRArtifact | null {
  const url = writtenMediaUrl(element);
  if (url === null) return null;
  const artifact = findPRArtifactByUrl(artifacts, metadata, url);
  if (artifact === null) return null;
  if (element.tagName === 'A' && artifact.kind !== 'video') return null;
  return artifact;
}
