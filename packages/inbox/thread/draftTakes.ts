import type { InboxDraftFile, InboxReplyDraft, InboxThread } from '@plannotator/core/inbox-types';
import { pastedSignature } from '../compose/ComposeFiles';
import type { ReplyBoxTook } from '../replyDraft';

interface DraftTakesHost {
  threadRef: { readonly current: InboxThread };
  boxRef: { readonly current: { open: boolean; text: string } };
  replyDraft: { heldOf: (threadId: string) => readonly string[]; boxTook: (threadId: string, ids: readonly string[]) => void };
  replyFiles: { draftFiles: (text?: string) => readonly { upload_id: string; pasted?: unknown }[] };
  setBox: (next: { open: boolean; text: string }) => void;
  takeDraftFiles: (files: readonly InboxDraftFile[], words: string, mode?: 'replace' | 'add', alsoKeep?: readonly string[]) => void;
  draftFilesWithMine: (files: readonly InboxDraftFile[]) => InboxDraftFile[];
  filesSaved: { current: string };
  announce: (text: string) => void;
}

export function takeTheirWords(host: DraftTakesHost, threadId: string, draft: InboxReplyDraft, was: string): ReplyBoxTook {
  const { threadRef, boxRef, replyDraft, replyFiles } = host;
  if (threadId !== threadRef.current.thread_id || !boxRef.current.open) return 'hidden';
  if (boxRef.current.text !== was) return 'differs';
  const files = host.draftFilesWithMine(draft.files ?? []);
  const listed = new Set(files.map((file) => file.upload_id));
  const held = new Set(replyDraft.heldOf(threadId));
  const fresh = replyFiles.draftFiles().map((file) => file.upload_id).filter((id) => !held.has(id) && !listed.has(id));
  host.setBox({ open: true, text: draft.body });
  host.takeDraftFiles(files, draft.body, 'replace', fresh);
  if (fresh.length > 0) {
    const saved = replyFiles.draftFiles().filter((file) => !fresh.includes(file.upload_id));
    host.filesSaved.current = pastedSignature(saved);
    replyDraft.boxTook(threadId, saved.map((file) => file.upload_id));
  }
  host.announce('This reply changed in another window.');
  return 'took';
}

export function takeMergedFiles(host: DraftTakesHost, threadId: string, draft: InboxReplyDraft, wanted: readonly string[]): void {
  const { threadRef, boxRef, replyDraft, replyFiles } = host;
  if (threadId !== threadRef.current.thread_id || !boxRef.current.open) return;
  const text = boxRef.current.text;
  const want = new Set(wanted);
  const held = new Set(replyDraft.heldOf(threadId));
  const all = replyFiles.draftFiles(text).map((file) => file.upload_id);
  const fresh = all.filter((id) => !held.has(id) && !want.has(id));
  const now = all.filter((id) => !fresh.includes(id));
  if (now.length !== want.size || now.some((id) => !want.has(id))) {
    const inDraft = new Set((draft.files ?? []).map((file) => file.upload_id));
    const pastesGone = replyFiles.draftFiles(text).filter((file) => file.pasted && !want.has(file.upload_id) && !fresh.includes(file.upload_id)).length;
    if (pastesGone > 0) host.announce(pastesGone === 1 ? 'A pasted text was sent or removed on another device.' : `${pastesGone} pasted texts were sent or removed on another device.`);
    host.takeDraftFiles((draft.files ?? []).filter((file) => want.has(file.upload_id)), text, 'replace', [...wanted.filter((id) => !inDraft.has(id)), ...fresh]);
  }
  const saved = replyFiles.draftFiles().filter((file) => !fresh.includes(file.upload_id));
  if (fresh.length > 0) host.filesSaved.current = pastedSignature(saved);
  replyDraft.boxTook(threadId, saved.map((file) => file.upload_id));
}
