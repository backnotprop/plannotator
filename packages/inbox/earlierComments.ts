/**
 * Earlier comments on a file: what the person already said about it, from the
 * records a Send carried (`earlier_annotations` on the thread's files route).
 * Read only; nothing here rides a Send.
 */
import { AnnotationType, type Annotation } from '@plannotator/ui/types';
import { formatInboxVideoTime, readInboxVideoTime, type InboxAnnotationRecord, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import { annotationOf, annotationQuote, annotationTag, codeRangeOf } from './attachments';
import { clockTime, dateTime, dayWords } from './format';
import { isWordlessMarkup } from './markup';

/**
 * What counts as the same file: any file with the same path in this thread,
 * newer versions included (by realpath, as drafts are). The owner's question
 * q-7c398b8b is open; this is its recommended answer, and the one line to change.
 */
export function isSameFile(record: InboxAnnotationRecord, attachment: Pick<InboxAttachmentState, 'id' | 'path'>): boolean {
  return record.path === attachment.path;
}

export interface EarlierComment {
  id: string;
  words: string;
  /** The quoted words or the spot, when stored: `"…"`, `At 1:42`, `Lines 12–14`. */
  spot: string | null;
}

/** The comments one reply carried. */
export interface EarlierReply {
  replyId: string;
  /** "From your reply · Today, 6:30 PM". */
  label: string;
  comments: EarlierComment[];
}

/** What a comment says: a comment with no words says what it was. */
function wordsOf(annotation: Annotation): string {
  if (isWordlessMarkup(annotation)) return 'Drawing';
  const words = annotation.text?.trim() ?? '';
  return !words && annotation.type === AnnotationType.DELETION ? 'Remove this' : words;
}

/** Where the comment is, when the record keeps it. An image's comment is on the whole image, so it has none. */
function spotOf(annotation: Annotation): string | null {
  const time = readInboxVideoTime(annotation);
  if (time !== null) return `At ${formatInboxVideoTime(time)}`;
  const lines = codeRangeOf(annotation);
  if (lines) return lines.lineStart === lines.lineEnd ? `Line ${lines.lineStart}` : `Lines ${lines.lineStart}–${lines.lineEnd}`;
  if (annotation.type === AnnotationType.GLOBAL_COMMENT || annotation.blockId === 'image') return null;
  const quote = annotationQuote(annotation).replace(/\s+/g, ' ').trim();
  if (quote) return `"${quote}"`;
  return annotationTag(annotation);
}

/** "Today, 6:30 PM", "Yesterday, 6:30 PM", else "Oct 3, 6:30 PM". */
function replyWhen(iso: string, now: Date): string {
  const day = dayWords(iso, now);
  if (day === 'today') return `Today, ${clockTime(iso)}`;
  if (day === 'yesterday') return `Yesterday, ${clockTime(iso)}`;
  return dateTime(iso, now);
}

/** The earlier comments on this file by the reply that carried them, the newest reply first. */
export function earlierCommentsOn(
  records: readonly InboxAnnotationRecord[],
  attachment: Pick<InboxAttachmentState, 'id' | 'path'>,
  now: Date = new Date(),
): EarlierReply[] {
  const replies = new Map<string, { at: string; comments: EarlierComment[] }>();
  for (const record of records) {
    if (record.sent_reply_id === null || !isSameFile(record, attachment)) continue;
    const annotation = annotationOf(record);
    const reply = replies.get(record.sent_reply_id) ?? { at: record.updated_at, comments: [] };
    reply.comments.push({ id: record.id, words: wordsOf(annotation), spot: spotOf(annotation) });
    replies.set(record.sent_reply_id, reply);
  }
  return [...replies.entries()]
    .sort(([, a], [, b]) => b.at.localeCompare(a.at))
    .map(([replyId, { at, comments }]) => ({ replyId, label: `From your reply · ${replyWhen(at, now)}`, comments }));
}
