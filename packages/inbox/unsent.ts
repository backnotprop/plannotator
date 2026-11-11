import { onReplyDraftUnsavedChange, replyDraftUnsaved } from './replyDraft';

let open: { subject: string; files: boolean; writing?: boolean } | null = null;

export function reportUnsentReply(value: { subject: string; files: boolean; writing?: boolean } | null): void {
  open = value;
  syncBeforeUnload();
}

export function replyBeingWritten(): boolean {
  return open?.writing === true;
}

export function unsentReply(): { subject: string } | null {
  if (open?.files) return { subject: open.subject };
  if (replyDraftUnsaved()) return { subject: open?.subject ?? 'a reply' };
  return null;
}

/** The beforeunload listener is there only while something would be lost: a page with one runs it before every navigation and some browsers drop it from the back/forward cache. */
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

export function leaveOnPurpose(): void {
  leavingOnPurpose = true;
}
