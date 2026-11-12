import { inboxApi, type InboxAskModel } from '../api';

export function createAskReader(read: (threadId: string) => Promise<InboxAskModel>): (threadId: string) => Promise<InboxAskModel> {
  const next = new Map<string, Promise<InboxAskModel>>();
  return (threadId) => {
    const waiting = next.get(threadId);
    if (waiting) return waiting;
    const leaving = Promise.resolve().then(() => {
      next.delete(threadId);
      return read(threadId);
    });
    next.set(threadId, leaving);
    return leaving;
  };
}

export const readAsk = createAskReader((threadId) => inboxApi.askRead(threadId));
