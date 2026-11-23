import { useEffect, useLayoutEffect, useRef } from 'react';
import type { InboxThread } from '@plannotator/core/inbox-types';

/**
 * Focus was in the thread's place when it gave way to the thread (ThreadSlot.tsx): set the ref, and once the thread
 * lands the focus goes to its subject, never to the page. Another thread forgets it.
 */
export function useFocusSubject(thread: InboxThread | null, threadId: string | null) {
  const focusSubject = useRef(false);
  useEffect(() => {
    focusSubject.current = false;
  }, [threadId]);
  // The thread landed while focus was in its place: focus goes to its subject, never to the page.
  useLayoutEffect(() => {
    if (!focusSubject.current || !thread || thread.thread_id !== threadId) return;
    focusSubject.current = false;
    document.querySelector<HTMLElement>(`section.ib-pane[data-thread-id="${CSS.escape(thread.thread_id)}"] .ib-subject`)?.focus();
  }, [thread, threadId]);
  return focusSubject;
}
