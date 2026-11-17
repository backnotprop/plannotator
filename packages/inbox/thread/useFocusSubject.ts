import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Focus was in a thread pane's place when it gave way to the thread (ThreadSlot.tsx sets the flag): it goes to the
 * thread's subject, never to the page. A new thread clears the flag.
 */
export function useFocusSubject(thread: { thread_id: string } | null, threadId: string | null) {
  const focusSubject = useRef(false);
  useEffect(() => {
    focusSubject.current = false;
  }, [threadId]);
  useLayoutEffect(() => {
    if (!focusSubject.current || !thread || thread.thread_id !== threadId) return;
    focusSubject.current = false;
    document.querySelector<HTMLElement>(`section.ib-pane[data-thread-id="${CSS.escape(thread.thread_id)}"] .ib-subject`)?.focus();
  }, [thread, threadId]);
  return focusSubject;
}
