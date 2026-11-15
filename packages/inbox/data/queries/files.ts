import { replaceEqualDeep } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
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
