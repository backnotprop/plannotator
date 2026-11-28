import { inboxUrl } from '../inboxUrl';

/** Where the What's new page loads one of the notes' saved images. */
export function whatsNewImageUrl(version: string, src: string): string {
  return inboxUrl(`/whats-new/image?version=${encodeURIComponent(version)}&src=${encodeURIComponent(src)}`);
}
