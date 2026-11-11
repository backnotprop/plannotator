import { createContext, useContext, type ReactNode } from 'react';
import type { InboxAnnotationRecord, InboxAttachmentState } from '@plannotator/core/inbox-types';
import { inboxApi, type AttachmentView, type LinkedPageView } from './api';
import { attachmentDownloadUrl, attachmentImageUrl, attachmentVideoUrl } from './attachments';
import { inboxUrl } from './inboxUrl';

type Version = 'current' | 'sent';

export interface FileSuggestion {
  phrase?: string;
  comment: string;
  at?: number;
}

const flatWords = (s: string) => s.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

export function selectionOnPhrase(phrase: string, selected: string): boolean {
  const p = flatWords(phrase);
  const s = flatWords(selected);
  if (!p || !s) return false;
  if (s.includes(p)) return true;
  const need = Math.min(p.length, Math.max(12, Math.ceil(p.length / 2)));
  if (s.length >= need && p.includes(s)) return true;
  for (let k = Math.min(p.length, s.length); k >= need; k--) if (s.endsWith(p.slice(0, k)) || s.startsWith(p.slice(p.length - k))) return true;
  return false;
}

export interface InboxFileSource {
  imageUrl(attachment: InboxAttachmentState, version: Version): string;
  videoUrl(attachment: InboxAttachmentState, version: Version): string;
  downloadUrl(attachment: InboxAttachmentState, version: Version): string;
  posterUrl?(attachment: InboxAttachmentState): string | null;
  view(attachment: InboxAttachmentState, version: Version): Promise<AttachmentView>;
  linkedPage(attachment: InboxAttachmentState, path: string): Promise<LinkedPageView>;
  pageFrameUrl?(html: string): Promise<string | null>;
  keepMarkup(blob: Blob): Promise<{ path: string; name: string }>;
  saveAnnotation(attachment: InboxAttachmentState, version: string, annotation: object): Promise<InboxAnnotationRecord>;
  removeAnnotation(id: string): Promise<void>;
  suggestion?(attachment: InboxAttachmentState): FileSuggestion | null;
  writes: boolean;
}

export const INBOX_FILE_SOURCE: InboxFileSource = {
  imageUrl: (attachment, version) => attachmentImageUrl(attachment, version),
  videoUrl: (attachment, version) => attachmentVideoUrl(attachment, version),
  downloadUrl: (attachment, version) => attachmentDownloadUrl(attachment, version),
  view: (attachment, version) => inboxApi.view(attachment.id, version),
  linkedPage: (attachment, path) => inboxApi.linkedPage(attachment.id, path),
  pageFrameUrl: async (html) => {
    const answer = await inboxApi.page(html);
    return typeof answer.url === 'string' && answer.url.startsWith(inboxUrl('/pages/')) ? answer.url : null;
  },
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

export function useInboxFileSource(): InboxFileSource {
  return useContext(FileSourceContext);
}
