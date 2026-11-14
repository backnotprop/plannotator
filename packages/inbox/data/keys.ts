export const inboxKeys = {
  all: ['inbox'] as const,
  threads: () => ['inbox', 'thread'] as const,
  thread: (threadId: string) => ['inbox', 'thread', threadId] as const,
  rowWrites: () => ['inbox', 'row-write'] as const,
  pickSave: () => ['inbox', 'pick-save'] as const,
  send: () => ['inbox', 'send'] as const,
};
