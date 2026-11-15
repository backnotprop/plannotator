export const inboxKeys = {
  all: ['inbox'] as const,
  list: () => ['inbox', 'list'] as const,
  archivedAll: () => ['inbox', 'archived'] as const,
  archived: (project: string | null, merged: boolean, limit: number) => ['inbox', 'archived', project ?? '', merged ? 1 : 0, limit] as const,
  drafts: () => ['inbox', 'drafts'] as const,
  threads: () => ['inbox', 'thread'] as const,
  thread: (threadId: string) => ['inbox', 'thread', threadId] as const,
  rowWrites: () => ['inbox', 'row-write'] as const,
  pickSave: () => ['inbox', 'pick-save'] as const,
  sendDraw: () => ['inbox', 'send-draw'] as const,
  send: () => ['inbox', 'send'] as const,
};
