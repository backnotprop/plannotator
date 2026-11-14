/**
 * A guided review's state in the window, for the full-window review
 * (ReviewPane.tsx), which opens every guide and review an agent sends: the
 * snapshot (loaded once per message), the reviewed ticks, and the person's
 * comments on its diffs.
 *
 * Reviewed ticks are kept with the thread, on the message in the store, so
 * they survive a reload, another browser and the Inbox moving to another
 * port. Each comment is kept in the store with the thread's other
 * annotations, listed in the review's comments panel and in the reply's
 * "N annotations"; without a verdict it rides the next Send as the review
 * app's export under "Feedback on the guided review". A resolved thread shows
 * the guide read-only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseGuideSnapshot, type GuideSnapshot } from '@plannotator/core/guide-format';
import type { InboxAnnotationRecord, InboxMessageWire, InboxThread } from '@plannotator/core/inbox-types';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { InboxApiError, inboxApi } from '../api';
import { guideCommentOf } from '../attachments';

/**
 * The review's state: the snapshot, the reviewed ticks, and the person's comments on its diffs as the store keeps
 * them until a Send.
 */
export function useGuideState(thread: InboxThread, message: InboxMessageWire) {
  const [snapshot, setSnapshot] = useState<GuideSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<boolean[]>(() => message.guide_reviewed ?? []);
  const [saveError, setSaveError] = useState<string | null>(null);
  // This guide's comments waiting for a Send, as the store keeps them.
  const [records, setRecords] = useState<InboxAnnotationRecord[]>([]);
  /** The first read of the comments answered (or failed): the panel's default can be chosen. */
  const [commentsRead, setCommentsRead] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<{ id: string; token: number } | null>(null);
  // Read only once archived, unless the guide arrived after the archive line (it behaves as an open thread's).
  const archiveSeq = thread.archive_seq ?? null;
  const readOnly = thread.resolved_at !== null && !(archiveSeq !== null && (message.seq ?? 0) > archiveSeq);
  /**
   * Bumped by every local save or removal: a read of the thread's annotations
   * that started before it answers with the store as it was, and must not put
   * back a comment just removed or drop one just saved.
   */
  const localWrites = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    setError(null);
    setReviewed(message.guide_reviewed ?? []);
    setSaveError(null);
    setSelectedId(null);
    inboxApi
      .guide(message.id)
      .then((answer) => {
        if (cancelled) return;
        const parsed = parseGuideSnapshot(answer.snapshot);
        if (parsed.ok) setSnapshot(parsed.value);
        else setError(`This guided review could not be read (${parsed.error.path}: ${parsed.error.message}).`);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'The guided review did not load.');
      });
    return () => {
      cancelled = true;
    };
    // A tick saved from another tab arrives with the thread; the open pane keeps its own until then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.id]);

  // The comments: read with the thread's annotations, again whenever the thread changes (a Send, an edit in the reply's list, another tab).
  useEffect(() => {
    let cancelled = false;
    const startedAt = localWrites.current;
    inboxApi
      .attachments(thread.thread_id)
      .then((model) => {
        if (cancelled) return;
        setCommentsRead(true);
        if (localWrites.current !== startedAt) return;
        setRecords(model.annotations.filter((r) => r.message_id === message.id && r.guide));
      })
      .catch(() => {
        // The thread went away; the pane closes with it.
        if (!cancelled) setCommentsRead(true);
      });
    return () => {
      cancelled = true;
    };
  }, [thread, message.id]);

  const changeReviewed = (next: boolean[]) => {
    setReviewed(next);
    setSaveError(null);
    inboxApi.saveGuideReviewed(message.id, next).then(
      (saved) => setReviewed(saved.reviewed),
      (cause: unknown) => setSaveError(cause instanceof Error ? cause.message : 'The reviewed tick was not saved.'),
    );
  };

  const comments = useMemo(() => records.map(guideCommentOf).filter((c): c is CodeAnnotation => c !== null), [records]);

  const save = useCallback(
    (annotation: CodeAnnotation): Promise<boolean> => {
      setSaveError(null);
      localWrites.current += 1;
      return inboxApi.saveGuideAnnotation(message.id, annotation).then(
        (saved) => {
          // Again on the answer: a read that started while the write was in flight may not hold it.
          localWrites.current += 1;
          setRecords((list) => [...list.filter((r) => r.id !== saved.annotation.id), saved.annotation]);
          return true;
        },
        (cause: unknown) => {
          setSaveError(cause instanceof InboxApiError ? cause.message : 'The comment was not saved.');
          return false;
        },
      );
    },
    [message.id],
  );
  const remove = useCallback((id: string) => {
    setSaveError(null);
    localWrites.current += 1;
    inboxApi.removeAnnotation(id).then(
      () => {
        localWrites.current += 1;
        setRecords((list) => list.filter((r) => r.id !== id));
      },
      (cause: unknown) => setSaveError(cause instanceof InboxApiError ? cause.message : 'The comment was not removed.'),
    );
  }, []);
  const edit = (id: string, updates: Partial<CodeAnnotation>) => {
    const before = comments.find((c) => c.id === id);
    if (before) save({ ...before, ...updates });
  };
  const showComment = (id: string) => {
    setSelectedId(id);
    setScrollTarget((current) => ({ id, token: (current?.token ?? 0) + 1 }));
  };

  const readerComments = useMemo(
    () => (readOnly ? undefined : { annotations: comments, selectedId, onSelect: setSelectedId, onSave: save, onDelete: remove, scrollTarget, draftScope: message.id }),
    [readOnly, comments, selectedId, save, remove, scrollTarget, message.id],
  );

  // The expand arrows' whole files, as the guide's patch names them.
  const fileContents = useCallback((path: string, signal: AbortSignal) => inboxApi.guideFile(message.id, path, signal), [message.id]);
  return { snapshot, error, reviewed, saveError, setSaveError, records, setRecords, commentsRead, comments, selectedId, setSelectedId, scrollTarget, readOnly, changeReviewed, save, remove, edit, showComment, readerComments, localWrites, fileContents };
}
