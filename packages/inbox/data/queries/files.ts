/**
 * A thread's files as they are now (its attachments, the images its messages show, and the person's comments
 * waiting for a Send), read again when the pane says so: a new `revision` of the thread, `again`, the window's
 * `signal` (a record that needs only the files), or the window coming back into focus (a file edited on disk).
 */
import { replaceEqualDeep } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import { inboxApi, type AttachmentsModel } from '../../api';
import type { Signal } from '../../signal';

/** The thread's attachments as they are now and the annotations waiting for a Send, kept fresh (read again when `revision` or `again` changes). */
export function useThreadAttachments(threadId: string, revision: unknown, again: number, signal: Signal | null = null) {
  const [model, setModel] = useState<AttachmentsModel | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await inboxApi.attachments(threadId);
      // Read again on every record: what did not change stays the same objects (structural sharing), so an earlier
      // read a kept callback still reaches does not hold a full copy of every file's record.
      setModel((current) => (current === null ? next : current.serverSession === next.serverSession ? replaceEqualDeep(current, next) : current));
    } catch {
      // The thread went away; the pane closes with it.
    }
  }, [threadId]);
  useEffect(() => {
    setModel(null);
  }, [threadId]);
  useEffect(() => {
    void load();
  }, [load, revision, again]);
  // A file edited on disk shows as changed when the person comes back to the window.
  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);
  // Read again when the window says so (a record that needs only the files, a re-read of the thread).
  useEffect(() => signal?.subscribe(() => void load()), [signal, load]);
  const patch = useCallback((update: (records: InboxAnnotationRecord[]) => InboxAnnotationRecord[]) => {
    setModel((current) => (current ? { ...current, annotations: update(current.annotations) } : current));
  }, []);
  return { model, load, patch };
}
