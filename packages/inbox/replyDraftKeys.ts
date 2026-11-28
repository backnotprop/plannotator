/**
 * The reply draft client's plain parts (replyDraft.ts): the box's state as the hook gives it, and how a box's words and
 * files compare with a draft's. No state of the page.
 */
import type { InboxReplyDraft } from '@plannotator/core/inbox-types';
import type { ReplyDraftFileOps, ReplyDraftFileRef } from '@plannotator/core/inbox-reply-draft';

/** The files a reply draft keeps beside its words: each finished upload, a long paste with its place. */
export type ReplyDraftFiles = readonly ReplyDraftFileRef[];
export const NO_FILES: ReplyDraftFiles = [];

/** A refusal's code, whichever store refused (the seam's errors carry `code`). */
export const codeOf = (cause: unknown): string | null =>
  cause && typeof cause === 'object' && typeof (cause as { code?: unknown }).code === 'string' ? (cause as { code: string }).code : null;
export const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : '');

/** What the box holds, as one string to compare: the words, and each long paste with its place. */
export function replyContentKey(text: string, files: ReplyDraftFiles | InboxReplyDraft['files'] = NO_FILES): string {
  const list = files ?? NO_FILES;
  if (list.length === 0) return text;
  return `${text}\u0000${list.map((file) => `${file.upload_id}@${file.pasted?.at ?? ''}`).join(',')}`;
}
export const draftKey = (draft: InboxReplyDraft | null | undefined): string | null => (draft ? replyContentKey(draft.body, draft.files) : null);
export const draftFilesOf = (draft: InboxReplyDraft | null | undefined): ReplyDraftFileRef[] =>
  (draft?.files ?? []).map((file) => (file.pasted ? { upload_id: file.upload_id, pasted: file.pasted } : { upload_id: file.upload_id }));
export const idsOf = (files: readonly { upload_id: string }[]) => files.map((file) => file.upload_id);
export const noOps = (ops: ReplyDraftFileOps) => ops.add.length === 0 && ops.remove.length === 0 && ops.place.length === 0;
/** The box's long pastes, each with its place in `text`: the save says where each goes now. */
export const placesIn = (files: ReplyDraftFiles, text: string): ReplyDraftFileOps['place'] =>
  files.flatMap((file) => (file.pasted ? [{ upload_id: file.upload_id, pasted: { ...file.pasted, at: Math.min(file.pasted.at, text.length) } }] : []));

export interface ReplyDraftState {
  /** The thread the draft below was read for (null until the first read answers). */
  loadedFor: string | null;
  /** The draft as the server holds it (null: none). */
  draft: InboxReplyDraft | null;
  /**
   * The words typed here that the server refused because another window
   * changed the draft since (null: none). They stay in the box, not saved,
   * until the person picks Keep mine or Discard.
   */
  conflict: string | null;
  /**
   * The box's words are longer than a draft holds (INBOX_DRAFT_BODY_MAX): they
   * are not saved, and the line above the box says so, until they are shorter.
   */
  tooLong: boolean;
  /**
   * The last save of the box's words did not land: the Inbox refused it (not for its length) or did not
   * answer, and reading the draft back did not find them. The line above the box says "Not saved" in
   * place of "Saved …" until a later save lands, a Send carries the words or Discard drops them.
   */
  failed: boolean;
  offer?: InboxReplyDraft | null;
  /** Words typed here whose save has not landed yet (`failedWords`): the box shows them, not the older draft. */
  unsaved?: string | null;
}
