/**
 * One read of a thread's Ask (`GET /api/inbox/threads/:id/ask`) for everything on the page that wants it now.
 *
 * Three parts of a window read the same thread's Ask on each `onAskChange` (askEvents.ts): the Ask window
 * (useInboxAsk), Show me (useShowMe) and a Change it that waits for a busy session (inboxShapeHost's
 * `wakeWhenFree`). Each asked on its own, so one event made three GETs of the same answer. Here, every call
 * made before the read leaves (the same task: one event's listeners, one commit's effects) shares it.
 *
 * Every caller gets an answer read at or after its call, so no change is lost: a call while a read is on its
 * way waits for it and reads once more after, and the calls that come meanwhile share that one read. A read
 * stalled past `STALLED_MS` (a held connection) is not waited for: a new call reads at once.
 */
import { inboxApi, type InboxAskModel } from '../api';

/** A read on its way longer than this is not waited for. */
const STALLED_MS = 10_000;

interface ThreadReads {
  /** The read on its way, and when it left. A call now did not see what it answers. */
  flight: { read: Promise<InboxAskModel>; at: number } | null;
  /** The read that has not left yet: every call until it does gets its answer. */
  next: Promise<InboxAskModel> | null;
}

export function createAskReader(read: (threadId: string) => Promise<InboxAskModel>, now: () => number = Date.now): (threadId: string) => Promise<InboxAskModel> {
  const threads = new Map<string, ThreadReads>();
  return (threadId) => {
    let reads = threads.get(threadId);
    if (!reads) {
      reads = { flight: null, next: null };
      threads.set(threadId, reads);
    }
    if (reads.next) return reads.next;
    const own = reads;
    const waitFor = own.flight && now() - own.flight.at < STALLED_MS ? own.flight.read.then(noop, noop) : Promise.resolve();
    // Leaves after the calls of this task (a microtask later), or after the read on its way.
    const next = waitFor.then(() => {
      own.next = null;
      const sent = read(threadId);
      own.flight = { read: sent, at: now() };
      const landed = () => {
        if (own.flight?.read === sent) own.flight = null;
        if (!own.flight && !own.next && threads.get(threadId) === own) threads.delete(threadId);
      };
      sent.then(landed, landed);
      return sent;
    });
    own.next = next;
    return next;
  };
}

function noop(): void {}

/** The page's one reader: tests that replace `inboxApi.askRead` still reach it. */
export const readAsk = createAskReader((threadId) => inboxApi.askRead(threadId));
