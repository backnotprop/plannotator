/**
 * Every key the window's cache uses, in one place (TanStack Query keys: arrays, matched by prefix). A screen or part
 * never builds a key itself: it asks for data through a hook in this folder.
 */
export const inboxKeys = {
  all: ['inbox'] as const,
  /** The list, as its last read brought it, with the stream's records applied since (`apply/list.ts`). */
  list: () => ['inbox', 'list'] as const,
  /** Every held thread (a stream gap marks them all stale through this prefix). */
  threads: () => ['inbox', 'thread'] as const,
  /** One thread as its read brought it, with the stream's records applied since (`apply/record.ts`). */
  thread: (threadId: string) => ['inbox', 'thread', threadId] as const,
  /** The row writes drawn while they are out (Mark read, Archive, Star): their pending mutations are the drawing. */
  rowWrites: () => ['inbox', 'row-write'] as const,
  /** A question's answer saved (the pick queue runs these one at a time per question). */
  pickSave: () => ['inbox', 'pick-save'] as const,
  /** A reply sent (one per reply of a Send). */
  send: () => ['inbox', 'send'] as const,
};
