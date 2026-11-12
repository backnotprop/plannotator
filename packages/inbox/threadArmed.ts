import { useState } from 'react';

/**
 * An HTML file's Annotate (true) or Interact (false) as the person last chose it in this thread: every HTML file of
 * the thread opens that way while the thread is open (the window's memory only, never saved). A thread starts in
 * Interact, and so does the next thread opened. Feeds AttachmentPane's `armedStart` and `onArmed`.
 */
export function useThreadArmed(threadId: string): { armedStart: boolean; onArmed: (armed: boolean) => void } {
  const [choice, setChoice] = useState({ threadId, armed: false });
  if (choice.threadId !== threadId) setChoice({ threadId, armed: false });
  return {
    armedStart: choice.threadId === threadId && choice.armed,
    onArmed: (armed) => setChoice((was) => (was.threadId === threadId && was.armed === armed ? was : { threadId, armed })),
  };
}
