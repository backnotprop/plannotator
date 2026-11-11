import type { InboxAnnotationRecord, InboxAttachmentState } from '@plannotator/core/inbox-types';
import { readInboxAttachmentKind } from '@plannotator/core/inbox-types';
import type { AttachmentView } from '../api';
import type { InboxFileSource } from '../fileSource';
import { keepTourMarkup, tourAssetText, tourAssetUrl } from './assets';
import { tourAssetOf, tourFileOf, tourRecord, tourSuggestionFor, type TourFixture } from './model';

export const MOCK_FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'";

export function mockSrcdoc(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${MOCK_FRAME_CSP}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (head) => `${head}${meta}`) : `${meta}${html}`;
}

export interface TourFileSourceOptions {
  onSave: (record: InboxAnnotationRecord) => void;
  onRemove: (id: string) => void;
  threadOf: (messageId: string) => string;
}

export function tourFileSource(fixture: TourFixture, options: TourFileSourceOptions): InboxFileSource {
  const asset = (attachment: InboxAttachmentState) => tourAssetOf(fixture, attachment.id) ?? 'none';
  const textOf = async (name: string): Promise<string> => {
    const kept = tourAssetText(name);
    if (kept !== null) return kept;
    const res = await fetch(tourAssetUrl(name));
    if (!res.ok) throw new Error('The tour keeps this file in memory once it is loaded.');
    return res.text();
  };
  return {
    writes: false,
    imageUrl: (attachment) => tourAssetUrl(asset(attachment)),
    videoUrl: (attachment) => tourAssetUrl(asset(attachment)),
    downloadUrl: (attachment) => tourAssetUrl(asset(attachment)),
    posterUrl: (attachment) => {
      const ref = tourFileOf(fixture, attachment.id);
      return ref && 'poster' in ref && ref.poster ? tourAssetUrl(ref.poster) : null;
    },
    view: async (attachment, version): Promise<AttachmentView> => {
      const text = await textOf(asset(attachment));
      const html = readInboxAttachmentKind(attachment.kind) === 'html' ? mockSrcdoc(text) : null;
      return { serverSession: 'tour', attachment, version: version === 'sent' ? attachment.sent_sha256 : 'current', text, html };
    },
    linkedPage: async () => {
      throw new Error('This page is part of the mock above.');
    },
    keepMarkup: async (blob) => keepTourMarkup(blob),
    saveAnnotation: async (attachment, _version, annotation) => {
      const id = typeof (annotation as { id?: unknown }).id === 'string' ? (annotation as { id: string }).id : `tour-ann-${Date.now()}`;
      const record = tourRecord({ id, thread: options.threadOf(attachment.message_id), message: attachment.message_id, attachment, annotation: annotation as Record<string, unknown> });
      options.onSave(record);
      return record;
    },
    removeAnnotation: async (id) => options.onRemove(id),
    suggestion: (attachment) => {
      const s = tourSuggestionFor(fixture, attachment);
      return s ? { comment: s.comment, ...(s.phrase ? { phrase: s.phrase } : {}), ...(s.at !== undefined ? { at: s.at } : {}) } : null;
    },
  };
}
