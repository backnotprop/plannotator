const POP_WINDOW_MS = 1500;

let last: { threadId: string; at: number } | null = null;

export function noteStarred(threadId: string | null): void {
  last = threadId === null ? null : { threadId, at: Date.now() };
}

export function starPopping(threadId?: string): boolean {
  if (!last || Date.now() - last.at > POP_WINDOW_MS) return false;
  return threadId === undefined || last.threadId === threadId;
}
