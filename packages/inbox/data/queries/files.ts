import { replaceEqualDeep } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import type { InboxAnnotationRecord, InboxThread } from '@plannotator/core/inbox-types';
import { inboxApi, type AttachmentsModel } from '../../api';
import type { Signal } from '../../signal';

export function useThreadAttachments(threadId: string, revision: unknown, again: number, signal: Signal | null = null) {
  const [model, setModel] = useState<AttachmentsModel | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await inboxApi.attachments(threadId);
      setModel((current) => (current === null ? next : current.serverSession === next.serverSession ? replaceEqualDeep(current, next) : current));
    } catch {
    }
  }, [threadId]);
  useEffect(() => {
    setModel(null);
  }, [threadId]);
  useEffect(() => {
    void load();
  }, [load, revision, again]);
  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);
  useEffect(() => signal?.subscribe(() => void load()), [signal, load]);
  const patch = useCallback((update: (records: InboxAnnotationRecord[]) => InboxAnnotationRecord[]) => {
    setModel((current) => (current ? { ...current, annotations: update(current.annotations) } : current));
  }, []);
  return { model, load, patch };
}

type FileCarrier = InboxThread['messages'][number];
const carriesFiles = (m: FileCarrier) => (m.attachments?.length ?? 0) > 0 || (m.inline_images?.length ?? 0) > 0;
const filesOf = (m: FileCarrier) => JSON.stringify([m.attachments ?? null, m.inline_images ?? null]);

export function sameThreadFiles(before: InboxThread, after: InboxThread): boolean {
  if (before === after) return true;
  if (before.thread_id !== after.thread_id) return false;
  const was = new Map(before.messages.filter(carriesFiles).map((m) => [m.id, m] as const));
  const now = after.messages.filter(carriesFiles);
  if (now.length !== was.size) return false;
  return now.every((m) => {
    const b = was.get(m.id);
    return b !== undefined && (b === m || filesOf(b) === filesOf(m));
  });
}
