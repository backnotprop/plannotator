/**
 * A pull request's own pictures and videos in the Inbox (owner, 2026-11-11: "Yes, inline"): the uploads GitHub keeps
 * for a PR on github.com show in place, read through the Inbox's own route (`GET /api/inbox/pulls/media`, which
 * fetches them with the person's sign-in), and a click opens them in the attachment viewer. The window still loads
 * nothing from the web. Which URLs count is the review app's rule (`isGitHubAttachmentUrl`).
 */
import type { InboxAttachmentState, InboxPull } from '@plannotator/core/inbox-types';
import { isGitHubAttachmentUrl } from '@plannotator/core/pr-attachment-url';
import { inboxApi } from '../api';
import type { InboxFileSource } from '../fileSource';

export type PullMediaKind = 'image' | 'video';

export interface PullMediaItem {
  /** The URL the PR's text wrote. */
  url: string;
  kind: PullMediaKind;
  /** The picture's words, or the link's. */
  name: string;
}

/** Only a PR on github.com: GitHub's upload hosts are github.com's. A GitLab MR keeps its chips. */
export function servesPullMedia(layer: Pick<InboxPull, 'platform' | 'host'>): boolean {
  return layer.platform === 'github' && layer.host.toLowerCase() === 'github.com';
}

/**
 * A link that may be a video: GitHub saves a pasted video as a bare `user-attachments/assets/<id>` link with no
 * extension (a picture keeps its image markup), or an upload whose name ends in a video's extension. The route's
 * answer decides (`probeVideo`); anything else stays a link.
 */
export function mayBeVideoLink(href: string): boolean {
  if (!isGitHubAttachmentUrl(href)) return false;
  const path = new URL(href).pathname.toLowerCase();
  return /\.(?:mp4|mov|webm|m4v)$/.test(path) || /^\/user-attachments\/assets\/[^/.]+$/.test(path);
}

/** The URL the PR's text wrote, from the Inbox's own address for it (an `<img>` the resolver pointed at the route). */
export function writtenMediaUrl(src: string): string | null {
  try {
    const url = new URL(src, 'http://inbox.invalid');
    if (!url.pathname.endsWith('/pulls/media')) return null;
    return url.searchParams.get('url');
  } catch {
    return null;
  }
}

const probes = new Map<string, Promise<boolean>>();

/**
 * Whether the route answers this link as a video: one byte asked for, remembered for the page's life. A link that is
 * not one (a file, a refusal, a failure) stays the link it was.
 */
export function probeVideo(key: string, url: string): Promise<boolean> {
  const id = `${key}\u0000${url}`;
  let probe = probes.get(id);
  if (!probe) {
    probe = fetch(inboxApi.pullMediaUrl(key, url), { headers: { Range: 'bytes=0-0' } })
      .then(async (res) => {
        const video = res.ok && (res.headers.get('content-type') ?? '').toLowerCase().startsWith('video/');
        await res.body?.cancel().catch(() => {});
        return video;
      })
      .catch(() => false);
    probes.set(id, probe);
    // A failure is not kept: the next opening of the page asks again.
    void probe.then((video) => {
      if (!video) probes.delete(id);
    });
  }
  return probe;
}

function idOf(url: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `pr-media-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** The viewer's record for one item: nothing the Inbox keeps, so no size, no versions, nothing to send. */
export function pullMediaAttachment(item: PullMediaItem): InboxAttachmentState {
  const at = new Date(0).toISOString();
  const name = item.name.trim() || (item.kind === 'video' ? 'Video' : 'Picture');
  return {
    id: idOf(item.url),
    path: item.url,
    named_path: null,
    name,
    kind: item.kind,
    sent_sha256: '',
    size: 0,
    sent_at: at,
    sent_mtime: at,
    message_id: '',
    current: { sha256: '', size: 0, mtime: at },
    changed_since_sent: false,
    unavailable: null,
  } as InboxAttachmentState;
}

const readOnly = () => Promise.reject(new Error('A pull request’s pictures are read here, not kept.'));

/** The viewers read the item from the route; nothing is written (no Open in, Download or Copy path). */
export function pullMediaSource(key: string): InboxFileSource {
  const url = (attachment: InboxAttachmentState) => inboxApi.pullMediaUrl(key, attachment.path);
  return {
    writes: false,
    imageUrl: url,
    videoUrl: url,
    downloadUrl: url,
    view: readOnly,
    linkedPage: readOnly,
    keepMarkup: readOnly,
    saveAnnotation: readOnly,
    removeAnnotation: readOnly,
  };
}
