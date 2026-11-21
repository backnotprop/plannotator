/**
 * When a thread was just starred, so its star can pop once. The list redraws and a row can mount for many reasons;
 * only the person's own starring in this window, a moment ago, plays the motion. Pure timing, nothing stored.
 */
const POP_WINDOW_MS = 1500;

let last: { threadId: string; at: number } | null = null;

/** Called as the star goes out, so a row drawn from its event pops too; null when it failed. */
export function noteStarred(threadId: string | null): void {
  last = threadId === null ? null : { threadId, at: Date.now() };
}

/** A thread's star (or, with no id, any star) was starred in the last moment. */
export function starPopping(threadId?: string): boolean {
  if (!last || Date.now() - last.at > POP_WINDOW_MS) return false;
  return threadId === undefined || last.threadId === threadId;
}
