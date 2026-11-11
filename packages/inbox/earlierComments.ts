import { AnnotationType, type Annotation } from '@plannotator/ui/types';
import { formatInboxVideoTime, readInboxVideoTime, type InboxAnnotationRecord, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import { annotationOf, annotationQuote, annotationTag, codeRangeOf, compareVideoTimes } from './attachments';
import { clockTime, dateTime, dayWords } from './format';
import { isWordlessMarkup } from './markup';

export function isSameFile(record: InboxAnnotationRecord, attachment: Pick<InboxAttachmentState, 'id' | 'path'>): boolean {
  return record.path === attachment.path;
}

export interface EarlierComment {
  id: string;
  words: string;
  spot: string | null;
}

export interface EarlierReply {
  replyId: string;
  label: string;
  comments: EarlierComment[];
}

function wordsOf(annotation: Annotation): string {
  if (isWordlessMarkup(annotation)) return 'Drawing';
  const words = annotation.text?.trim() ?? '';
  return !words && annotation.type === AnnotationType.DELETION ? 'Remove this' : words;
}

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

function replyWhen(iso: string, now: Date): string {
  const day = dayWords(iso, now);
  if (day === 'today') return `Today, ${clockTime(iso)}`;
  if (day === 'yesterday') return `Yesterday, ${clockTime(iso)}`;
  return dateTime(iso, now);
}

export function earlierCommentsOn(
  records: readonly InboxAnnotationRecord[],
  attachment: Pick<InboxAttachmentState, 'id' | 'path'>,
  now: Date = new Date(),
): EarlierReply[] {
  const replies = new Map<string, { at: string; comments: EarlierComment[] }>();
  // A film's comments read by time, as its current ones do ("By time"); any other file's have no time and keep their order.
  const here = records
    .filter((record) => record.sent_reply_id !== null && isSameFile(record, attachment))
    .map((record) => ({ record, annotation: annotationOf(record) }))
    .sort((a, b) => compareVideoTimes(a.annotation, b.annotation));
  for (const { record, annotation } of here) {
    const reply = replies.get(record.sent_reply_id!) ?? { at: record.updated_at, comments: [] };
    reply.comments.push({ id: record.id, words: wordsOf(annotation), spot: spotOf(annotation) });
    replies.set(record.sent_reply_id!, reply);
  }
  return [...replies.entries()]
    .sort(([, a], [, b]) => b.at.localeCompare(a.at))
    .map(([replyId, { at, comments }]) => ({ replyId, label: `From your reply · ${replyWhen(at, now)}`, comments }));
}
