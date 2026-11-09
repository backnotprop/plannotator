/**
 * One read of a thread's Ask (`GET /api/inbox/threads/:id/ask`) for everything on the page that wants it now.
 *
 * Three parts of a window read the same thread's Ask on each `onAskChange` (askEvents.ts): the Ask window
 * (useInboxAsk), Show me (useShowMe) and a Change it that waits for a busy session (inboxShapeHost's
 * `wakeWhenFree`). Each asked on its own, so one event made three GETs of the same answer. Here, every call
 * made before the read leaves (the same task: one event's listeners, one commit's effects) shares it.
 *
 * A read never waits for another: a call after the read left (a later event, while it is on its way or not)
 * sends its own at once, so it sees any change that came meanwhile, as each reader's own read did before.
 */
import { inboxApi, type InboxAskModel } from '../api';

export function createAskReader(read: (threadId: string) => Promise<InboxAskModel>): (threadId: string) => Promise<InboxAskModel> {
  /** Each thread's read that has not left yet. */
  const next = new Map<string, Promise<InboxAskModel>>();
  return (threadId) => {
    const waiting = next.get(threadId);
    if (waiting) return waiting;
    // Leaves a microtask later, after the calls of this task.
    const leaving = Promise.resolve().then(() => {
      next.delete(threadId);
      return read(threadId);
    });
    next.set(threadId, leaving);
    return leaving;
  };
}

/** The page's one reader: tests that replace `inboxApi.askRead` still reach it. */
export const readAsk = createAskReader((threadId) => inboxApi.askRead(threadId));
