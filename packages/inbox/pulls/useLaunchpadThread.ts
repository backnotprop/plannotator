import { useEffect, useState } from 'react';
import type { InboxThread } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';

export type LaunchpadThread = InboxThread | 'failed' | null;

export function useLaunchpadThread(threadId: string | null, version: string): LaunchpadThread {
  const [read, setRead] = useState<{ threadId: string; thread: InboxThread | 'failed' } | null>(null);
  useEffect(() => {
    if (!threadId) return;
    const abort = new AbortController();
    inboxApi.thread(threadId, undefined, abort.signal).then(
      (model) => setRead({ threadId, thread: model.thread }),
      () => {
        if (!abort.signal.aborted) setRead((was) => (was?.threadId === threadId && was.thread !== 'failed' ? was : { threadId, thread: 'failed' }));
      },
    );
    return () => abort.abort();
  }, [threadId, version]);
  return threadId && read?.threadId === threadId ? read.thread : null;
}
