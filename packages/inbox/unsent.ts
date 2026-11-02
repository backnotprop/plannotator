/**
 * The reply a person is writing that a restart (or a reload) would lose, for
 * the update control's restart guard and the page's beforeunload: restarting
 * the Inbox reloads the page. The words are kept as a reply draft as they are
 * typed (replyDraft.ts), and picks and comments are saved at once, so what a
 * restart loses is files pasted into the box, and words not saved yet (a save
 * waiting or on its way, or words a conflict left unsaved). The open thread
 * reports its subject and its pasted files; the guard reads it. It reports too
 * whether its reply box is open with words or files in it (`replyBeingWritten`),
 * for the list options dialog, which waits while a reply is written.
 */
import { onReplyDraftUnsavedChange, replyDraftUnsaved } from './replyDraft';

let open: { subject: string; files: boolean; writing?: boolean } | null = null;

/**
 * The open thread's reply box: its subject, whether it holds pasted files and whether it is open with words or
 * files in it (`writing`), else null (no thread open).
 */
export function reportUnsentReply(value: { subject: string; files: boolean; writing?: boolean } | null): void {
  open = value;
  syncBeforeUnload();
}

/** The open thread's reply box is open with words or files in it, wherever focus is (saved as a draft or not). */
export function replyBeingWritten(): boolean {
  return open?.writing === true;
}

/** What a restart would lose, by the thread's subject, else null. */
export function unsentReply(): { subject: string } | null {
  if (open?.files) return { subject: open.subject };
  if (replyDraftUnsaved()) return { subject: open?.subject ?? 'a reply' };
  return null;
}

/**
 * A reload or a closed tab asks while a reply would be lost. The listener is
 * there only while something would be: a page with a beforeunload listener
 * runs it before every navigation (and some browsers then keep it out of the
 * back/forward cache), so it is never left on for nothing.
 */
let leavingOnPurpose = false;
let listening = false;
const onBeforeUnload = (event: BeforeUnloadEvent) => {
  if (leavingOnPurpose || !unsentReply()) return;
  event.preventDefault();
  event.returnValue = '';
};
function syncBeforeUnload(): void {
  if (typeof window === 'undefined') return;
  const want = unsentReply() !== null;
  if (want === listening) return;
  listening = want;
  if (want) window.addEventListener('beforeunload', onBeforeUnload);
  else window.removeEventListener('beforeunload', onBeforeUnload);
}
onReplyDraftUnsavedChange(syncBeforeUnload);

/** A restart the person already chose reloads the page: the question is not asked again. */
export function leaveOnPurpose(): void {
  leavingOnPurpose = true;
}
