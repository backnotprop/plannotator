/**
 * Files (approval "inbox-files-tabs"): a file of the thread's project folder,
 * shown by the same viewers as an attachment.
 *
 * A project file is reached by its path relative to the thread's files root
 * (packages/server/inbox-files.ts), never by an absolute path. In the window
 * it is a synthetic attachment state whose id is `pf:<path>`: the route
 * (`#thread=…&file=pf:src%2Fa.ts`), the tabs and AttachmentPane carry it like
 * an `att_` id, and `projectFileSource` sends its reads and comments to the
 * Files routes instead of the attachment routes. Its `path` is the relative
 * path too, and its comments are keyed by it (`fileCommentRecords`), so the
 * pane's per-file lists find them.
 */
import { inboxAttachmentKind, readInboxAttachmentKind, type InboxAnnotationRecord, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import { inboxApi, type AttachmentView, type ProjectFileContent } from '../api';
import type { InboxFileSource } from '../fileSource';

const PREFIX = 'pf:';

export function projectFileId(path: string): string {
  return `${PREFIX}${path}`;
}

export function isProjectFileId(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.startsWith(PREFIX) && id.length > PREFIX.length;
}

/** The relative path a `pf:` id names (null for an attachment id). */
export function projectFilePath(id: string | null | undefined): string | null {
  return isProjectFileId(id) ? id.slice(PREFIX.length) : null;
}

function baseName(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? path : path.slice(cut + 1);
}

/** The folder part of a relative path ('' at the root). */
export function projectFileDir(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const VIDEO_NAME = /\.(mp4|m4v|mov|webm)$/i;

/** The viewer a name asks for before the server has read the bytes (it decides, `fileContent().kind`). */
export function guessProjectFileKind(path: string): InboxAttachmentState['kind'] {
  const name = baseName(path);
  if (/\.svg$/i.test(name)) return 'code';
  if (IMAGE_NAME.test(name)) return 'image';
  if (VIDEO_NAME.test(name)) return 'video';
  if (/\.pdf$/i.test(name)) return 'pdf';
  return inboxAttachmentKind(name);
}

/**
 * The attachment state the viewers read for a project file: by its name until
 * the server's read (`content`) says what it is. It was never sent, so it has
 * no sent version and nothing changed since.
 */
export function projectFileState(path: string, content?: ProjectFileContent | null, messageId = ''): InboxAttachmentState {
  const kind = content ? readInboxAttachmentKind(content.kind) : guessProjectFileKind(path);
  const sha = content?.sha256 ?? '';
  const mtime = content?.mtime ?? '';
  return {
    id: projectFileId(path),
    path,
    named_path: null,
    name: baseName(path),
    kind,
    sent_sha256: sha,
    size: content?.size ?? 0,
    sent_at: mtime,
    sent_mtime: mtime,
    ...(content?.media_type ? { media_type: content.media_type } : {}),
    ...(content?.width !== undefined ? { width: content.width, height: content.height } : {}),
    message_id: messageId,
    current: content ? { sha256: sha, size: content.size, mtime } : null,
    changed_since_sent: false,
    unavailable: null,
  };
}

function rawUrl(threadId: string, path: string, download = false): string {
  return `/api/inbox/threads/${encodeURIComponent(threadId)}/files/raw?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;
}

/**
 * The viewers' file source for a thread: a `pf:` file reads and comments
 * through the Files routes, anything else goes to `base` (the window's own),
 * unchanged. `onContent` hears every read, so the state the pane shows can
 * take the server's kind and size.
 */
export function projectFileSource(threadId: string, base: InboxFileSource, onContent?: (content: ProjectFileContent) => void): InboxFileSource {
  return {
    ...base,
    imageUrl: (attachment, version) => {
      const path = projectFilePath(attachment.id);
      return path !== null ? rawUrl(threadId, path) : base.imageUrl(attachment, version);
    },
    videoUrl: (attachment, version) => {
      const path = projectFilePath(attachment.id);
      return path !== null ? rawUrl(threadId, path) : base.videoUrl(attachment, version);
    },
    downloadUrl: (attachment, version) => {
      const path = projectFilePath(attachment.id);
      return path !== null ? rawUrl(threadId, path, true) : base.downloadUrl(attachment, version);
    },
    view: async (attachment, version): Promise<AttachmentView> => {
      const path = projectFilePath(attachment.id);
      if (path === null) return base.view(attachment, version);
      const content = await inboxApi.fileContent(threadId, path);
      onContent?.(content);
      return { serverSession: content.serverSession, attachment: projectFileState(path, content, attachment.message_id), version: 'current', text: content.text ?? '', html: content.html };
    },
    linkedPage: (attachment, linked) => {
      // A page a project HTML page links to is a project file itself: the pane's links open it as one (not read-only over it).
      if (isProjectFileId(attachment.id)) return Promise.reject(new Error('Open the linked page from the files panel.'));
      return base.linkedPage(attachment, linked);
    },
    saveAnnotation: async (attachment, version, annotation) => {
      const path = projectFilePath(attachment.id);
      if (path === null) return base.saveAnnotation(attachment, version, annotation);
      return (await inboxApi.saveProjectFileAnnotation(threadId, path, annotation)).annotation;
    },
  };
}

/**
 * The thread's comments as the file viewers list them: a project file's
 * comment keyed by its relative path (the store keeps its realpath), so the
 * pane matches it to the `pf:` state, whose path is that relative path.
 */
export function fileCommentKey(record: InboxAnnotationRecord): InboxAnnotationRecord {
  return record.project_file ? { ...record, path: record.project_file.path, version: 'current' } : record;
}

/** Save an edited comment where it lives: a project file's through the Files route. */
export function isProjectFileComment(record: InboxAnnotationRecord): boolean {
  return record.project_file !== undefined;
}
