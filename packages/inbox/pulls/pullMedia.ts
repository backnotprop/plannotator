import type { InboxAttachmentState, InboxPull } from '@plannotator/core/inbox-types';
import { isGitHubAttachmentUrl } from '@plannotator/core/pr-attachment-url';
import { inboxApi } from '../api';
import type { InboxFileSource } from '../fileSource';

export type PullMediaKind = 'image' | 'video';

export interface PullMediaItem {
  url: string;
  kind: PullMediaKind;
  name: string;
}

export function servesPullMedia(layer: Pick<InboxPull, 'platform' | 'host'>): boolean {
  return layer.platform === 'github' && layer.host.toLowerCase() === 'github.com';
}

/** GitHub saves a pasted video as a bare `user-attachments/assets/<id>` link with no extension. */
export function mayBeVideoLink(href: string): boolean {
  if (!isGitHubAttachmentUrl(href)) return false;
  const path = new URL(href).pathname.toLowerCase();
  return /\.(?:mp4|mov|webm|m4v)$/.test(path) || /^\/user-attachments\/assets\/[^/.]+$/.test(path);
}

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
