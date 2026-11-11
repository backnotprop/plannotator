import type { PRMetadata } from '@plannotator/shared/pr-types';
import { findPRArtifactByUrl, type PRArtifact } from './prArtifacts';

const PROXY_PATH = '/api/pr-artifact-content';

export function writtenMediaUrl(element: Element): string | null {
  const written = element.getAttribute('data-image-src');
  if (written) return written;
  const raw = element.tagName === 'A'
    ? element.getAttribute('href')
    : element.getAttribute('src') ?? element.querySelector('source[src]')?.getAttribute('src') ?? null;
  if (!raw) return null;
  try {
    const url = new URL(raw, /^https?:$/.test(window.location.protocol) ? window.location.href : 'http://page.invalid');
    if (url.pathname === PROXY_PATH && (raw.startsWith('/') || url.origin === window.location.origin)) {
      return url.searchParams.get('url') ?? raw;
    }
  } catch {
  }
  return raw;
}

/** A link opens in the panel only for a video, so links to pages keep opening the forge. */
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
