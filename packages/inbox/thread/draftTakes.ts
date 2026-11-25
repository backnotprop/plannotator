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

/**
 * The words an offered draft and the box make together, nothing of either lost, and where the caret goes (after the
 * words typed here; null: their end). The box holds the draft already, then more: the box's words. Both went on from
 * the words the box held when the draft came (`from`): this box's edit (an addition at the end, or a change in the
 * middle the draft left as it was) is made in the draft. Otherwise the draft, a blank line, then the box's words.
 */
export function offeredWithTyped(offered: string, from: string, typed: string): { text: string; caret: number | null } {
  if (offered.trim() !== '' && typed.startsWith(offered)) return { text: typed, caret: null };
  if (from.trim() !== '' && typed.startsWith(from) && offered.startsWith(from)) return { text: offered + typed.slice(from.length), caret: null };
  if (!offered.trim()) return { text: typed, caret: null };
  if (!typed.trim()) return { text: offered, caret: null };
  // The box's one edit since `from`: `removed` taken out after `before`, `inserted` put in its place.
  let start = 0;
  while (start < from.length && start < typed.length && from[start] === typed[start]) start += 1;
  let end = 0;
  while (end < from.length - start && end < typed.length - start && from[from.length - 1 - end] === typed[typed.length - 1 - end]) end += 1;
  const before = from.slice(0, start);
  const removed = from.slice(start, from.length - end);
  const after = from.slice(from.length - end);
  const inserted = typed.slice(start, typed.length - end);
  if (from.trim() !== '' && before.length + removed.length > 0 && offered.startsWith(before + removed)) {
    return { text: before + inserted + offered.slice(before.length + removed.length), caret: before.length + inserted.length };
  }
  if (from.trim() !== '' && removed.length + after.length > 0 && offered.endsWith(removed + after)) {
    const at = offered.length - removed.length - after.length;
    return { text: offered.slice(0, at) + inserted + offered.slice(at + removed.length), caret: at + inserted.length };
  }
  const joined = `${offered.trimEnd()}\n\n${typed.trimStart()}`;
  const lead = typed.length - typed.trimStart().length;
  return { text: joined, caret: joined.length - typed.trimStart().length + Math.max(0, start + inserted.length - lead) };
}

interface OfferHost {
  replyDraft: { restoreOffer: () => { draft: InboxReplyDraft; typed: boolean; from: string } | null };
  replyText: { get: () => string };
  setBox: (next: { open: boolean; text: string }) => void;
  takeDraftFiles: (files: readonly InboxDraftFile[], words: string, mode?: 'replace' | 'add') => void;
  draftFilesWithMine: (files: readonly InboxDraftFile[]) => InboxDraftFile[];
  changeReply: (text: string, behind?: boolean) => void;
  focusReplyEnd: () => void;
  announce: (text: string) => void;
  textRef?: { readonly current: HTMLTextAreaElement | null };
}

/**
 * Restore draft (`edited` false), or the box's first edit while the offer stands (`edited`): the offered draft goes in the
 * box. Words typed since it came go after it (`offeredWithTyped`), and the result is saved.
 */
export function takeOffered(host: OfferHost, edited = false): void {
  const offered = host.replyDraft.restoreOffer();
  if (!offered) return;
  const { draft } = offered;
  if (offered.typed || edited) {
    const { text, caret } = offeredWithTyped(draft.body, offered.from, host.replyText.get());
    host.takeDraftFiles(host.draftFilesWithMine(draft.files ?? []), text, 'add');
    host.changeReply(text, true);
    // An edit made in the box keeps focus, the caret where the person was typing (the words were set under it);
    // Restore draft puts the caret after the words.
    if (!edited) host.focusReplyEnd();
    else if (caret !== null && host.textRef) {
      const field = host.textRef;
      const place = () => field.current === document.activeElement && field.current?.setSelectionRange(caret, caret);
      place();
      requestAnimationFrame(place);
    }
  } else {
    host.setBox({ open: true, text: draft.body });
    host.takeDraftFiles(draft.files ?? [], draft.body);
  }
  host.announce('Your saved draft is in the reply.');
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
