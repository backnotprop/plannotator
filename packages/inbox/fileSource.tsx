/**
 * Where the attachment viewers read and write (tour v2, the "file source"
 * seam): the image, video and download URLs, a text file's view, keeping a
 * drawing, and saving or removing an annotation. AttachmentTiles,
 * ImageGallery, AttachmentPane, ImageAttachmentView, VideoAttachmentView and
 * OpenIn's full-screen menu read it from this context.
 *
 * The default is the window's own: `inboxApi` and the `attachments.ts` URL
 * builders, so without a provider every viewer is exactly as before. The
 * onboarding tour provides its own (tour/fileSource.ts): its assets in
 * memory, comments kept in the tour's state, nothing written anywhere
 * (`writes: false`, which also hides Open in, Download and Copy path).
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { InboxAnnotationRecord, InboxAttachmentState } from '@plannotator/core/inbox-types';
import { inboxApi, type AttachmentView, type LinkedPageView } from './api';
import { attachmentDownloadUrl, attachmentImageUrl, attachmentVideoUrl } from './attachments';

type Version = 'current' | 'sent';

/** A suggested comment the tour puts in a comment box (the developer's real one, condensed): kept with one press, or replaced. */
export interface FileSuggestion {
  /** The words the comment is about (a text file): the suggestion fills the composer for a selection inside them. */
  phrase?: string;
  comment: string;
  /** A film: the moment (seconds) the comment was made at. */
  at?: number;
}

const flatWords = (s: string) => s.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Whether a selection is on a suggestion's phrase: it holds the whole phrase, or covers at least half of it
 * (12 characters at least), inside it or across one of its ends. A stray word in the phrase ("the", "hover")
 * opens an empty box.
 */
export function selectionOnPhrase(phrase: string, selected: string): boolean {
  const p = flatWords(phrase);
  const s = flatWords(selected);
  if (!p || !s) return false;
  if (s.includes(p)) return true;
  const need = Math.min(p.length, Math.max(12, Math.ceil(p.length / 2)));
  if (s.length >= need && p.includes(s)) return true;
  // Across an end: the selection's tail is the phrase's start, or its head is the phrase's end.
  for (let k = Math.min(p.length, s.length); k >= need; k--) if (s.endsWith(p.slice(0, k)) || s.startsWith(p.slice(p.length - k))) return true;
  return false;
}

export interface InboxFileSource {
  imageUrl(attachment: InboxAttachmentState, version: Version): string;
  videoUrl(attachment: InboxAttachmentState, version: Version): string;
  downloadUrl(attachment: InboxAttachmentState, version: Version): string;
  /** A film's still before it plays (`<video poster>`); absent: the film's first frame. */
  posterUrl?(attachment: InboxAttachmentState): string | null;
  view(attachment: InboxAttachmentState, version: Version): Promise<AttachmentView>;
  linkedPage(attachment: InboxAttachmentState, path: string): Promise<LinkedPageView>;
  /** Keep a drawing (a marked-up image, a film's frame): its path rides the comment's `images`. */
  keepMarkup(blob: Blob): Promise<{ path: string; name: string }>;
  saveAnnotation(attachment: InboxAttachmentState, version: string, annotation: object): Promise<InboxAnnotationRecord>;
  removeAnnotation(id: string): Promise<void>;
  /** A comment box's suggestion for this file, if any. */
  suggestion?(attachment: InboxAttachmentState): FileSuggestion | null;
  /** False in the tour: nothing leaves the window (no Open in, Download or Copy path). */
  writes: boolean;
}

/** The window's own: every route of the Inbox, as the viewers always called them. */
export const INBOX_FILE_SOURCE: InboxFileSource = {
  imageUrl: (attachment, version) => attachmentImageUrl(attachment, version),
  videoUrl: (attachment, version) => attachmentVideoUrl(attachment, version),
  downloadUrl: (attachment, version) => attachmentDownloadUrl(attachment, version),
  view: (attachment, version) => inboxApi.view(attachment.id, version),
  linkedPage: (attachment, path) => inboxApi.linkedPage(attachment.id, path),
  keepMarkup: async (blob) => {
    const kept = await inboxApi.uploadMarkup(blob);
    return { path: kept.path, name: kept.name };
  },
  saveAnnotation: async (attachment, version, annotation) => (await inboxApi.saveAnnotation(attachment.id, version, annotation)).annotation,
  removeAnnotation: async (id) => {
    await inboxApi.removeAnnotation(id);
  },
  writes: true,
};

const FileSourceContext = createContext<InboxFileSource>(INBOX_FILE_SOURCE);

export function InboxFileSourceProvider({ source, children }: { source: InboxFileSource; children: ReactNode }) {
  return <FileSourceContext.Provider value={source}>{children}</FileSourceContext.Provider>;
}

/** The viewers' source: the window's own unless a provider (the tour) says otherwise. */
export function useInboxFileSource(): InboxFileSource {
  return useContext(FileSourceContext);
}
