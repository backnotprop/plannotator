/**
 * A thread on screen that is no longer in the Inbox (deleted in another window, or by an agent): it stays as it was
 * (what is open stays open; only the person closes it) and says so above it, in the words the Inbox already uses for
 * a thread it does not have (ThreadWait.tsx). Not read again: the Inbox's answer was definite (paneReads.ts `gone`).
 */
export function ThreadGone() {
  return (
    <div className="ib-pwait-line my-2.5 mx-auto" role="status" data-thread-gone="">
      <span>This thread is not in the Inbox. It may have been deleted.</span>
    </div>
  );
}
