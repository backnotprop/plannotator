/**
 * The person's comment writes on their way to the server: a comment added,
 * edited or removed on a message's words, a file, a guided review or a
 * running site. A Send waits for them, so the reply names every comment the
 * person made before pressing it, as the server holds it (`withCommentWrites`).
 * The list a Send was pressed with lacks a comment whose save had not answered
 * yet; over a slow link that answer can come many seconds later.
 */
import { parseDiagramAnchor } from '@plannotator/core/diagram-anchor';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import { InboxApiError } from './apiError';

/** Older receivers read only `annotation`. Omit it so they refuse a native pin before they write anything. */
export function annotationBody(annotation: object) {
  const anchor = 'diagramAnchor' in annotation ? annotation.diagramAnchor : undefined;
  return anchor && typeof anchor === 'object' && 'family' in anchor && anchor.family === 'plannotator-diagram'
    ? { diagram_annotation: annotation } : { annotation };
}


/**
 * How one write ended: the record the server answered with, or a refusal or no answer (`on`: the message, file,
 * thread or comment it was for; `id`: the comment's, when the request names it).
 */
export type CommentWrite = { kind: 'answered'; record: InboxAnnotationRecord } | { kind: 'failed'; remove: boolean; on: string; id: string | null };

const inFlight = new Set<Promise<CommentWrite>>();
const watchers = new Set<CommentWrite[]>();

/** Track one write; it resolves (or rejects) as `write` does. */
export function trackCommentWrite<T extends { annotation: InboxAnnotationRecord }>(write: Promise<T>, how: { on: string; id?: unknown; remove?: boolean; annotation?: { diagramAnchor?: unknown; text?: unknown } }): Promise<T> {
  const anchor = parseDiagramAnchor(how.annotation?.diagramAnchor);
  if (anchor?.family === 'plannotator-diagram') {
    // Confirm the exact part and edit before showing the pin as saved.
    write = write.then(answer => {
      const saved = answer.annotation?.annotation;
      if (saved?.text !== how.annotation?.text || JSON.stringify(parseDiagramAnchor(saved?.diagramAnchor)) !== JSON.stringify(anchor)) {
        throw new Error('The Inbox could not confirm this diagram comment.');
      }
      return answer;
    }, cause => {
      // An older store either misses the envelope or knows the drawing only as a download.
      if (cause instanceof InboxApiError && cause.status === 422 && (
        (cause.code === 'validation_error' && cause.field === 'annotation') ||
        (cause.code === 'annotation_not_allowed' && cause.field === 'attachment_id')
      )) {
        throw new DOMException('The other computer needs a newer Plannotator to pin this comment.', 'NotSupportedError');
      }
      throw cause;
    });
  }
  const ended: Promise<CommentWrite> = write
    .then(
      (answer): CommentWrite => ({ kind: 'answered', record: answer.annotation }),
      (): CommentWrite => ({ kind: 'failed', remove: how.remove === true, on: how.on, id: typeof how.id === 'string' ? how.id : null }),
    )
    .then((outcome) => {
      inFlight.delete(ended);
      for (const seen of watchers) seen.push(outcome);
      return outcome;
    });
  inFlight.add(ended);
  return write;
}

/**
 * Watch every write from now on. `settled` resolves once no write is on its way (one started meanwhile
 * included) with each write that ended since the watch began, in the order they ended. `stop` ends the watch.
 */
export function watchCommentWrites(): { settled: () => Promise<CommentWrite[]>; stop: () => void } {
  const seen: CommentWrite[] = [];
  watchers.add(seen);
  return {
    settled: async () => {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
      return [...seen];
    },
    stop: () => {
      watchers.delete(seen);
    },
  };
}

/** The first write that failed for one of `ours` (the thread's own ids) and was not answered for the same comment after it. */
export function failedCommentWrite(writes: readonly CommentWrite[], ours: ReadonlySet<string>): Extract<CommentWrite, { kind: 'failed' }> | null {
  for (const [index, write] of writes.entries()) {
    if (write.kind !== 'failed' || !ours.has(write.on)) continue;
    const later = writes.slice(index + 1).some((next) => next.kind === 'answered' && write.id !== null && next.record.id === write.id);
    if (!later) return write;
  }
  return null;
}

/** `records` (one thread's comments waiting for a Send) with what the writes answered: added, changed, or gone once removed or sent. */
export function withCommentWrites(records: readonly InboxAnnotationRecord[], writes: readonly CommentWrite[], threadId: string): InboxAnnotationRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const write of writes) {
    if (write.kind !== 'answered' || write.record.thread_id !== threadId) continue;
    if (write.record.removed_at !== null || write.record.sent_reply_id !== null) byId.delete(write.record.id);
    else byId.set(write.record.id, write.record);
  }
  return [...byId.values()];
}
