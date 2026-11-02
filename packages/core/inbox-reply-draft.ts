/**
 * A reply draft's files: every file the person attached to a thread's reply
 * box (paperclip, drop, paste, a long paste) is part of the draft, beside its
 * words, until a Send carries it, on every device (the owner, 2026-11-02:
 * "ideally it just syncs").
 *
 * Two halves, both browser-safe (no `node:`):
 *  - the rules every draft store runs, as pure functions: what a save keeps,
 *    how two windows' file changes merge, and what a Send leaves;
 *  - the seam a host plugs its storage into (`ReplyDraftStore`,
 *    `DraftFileUploader`). The Plannotator Inbox's adapters are HTTP
 *    (packages/inbox/replyDraftHttp.ts): drafts in `inbox/reply-drafts/`,
 *    bytes as pending uploads. A host with other storage (Workspaces: a
 *    per-person draft row, bytes private until Send) passes its own.
 *
 * The contract the window relies on: a file ref (`upload_id`) names bytes
 * held for this person's draft only. Nobody else sees them (no agent, phone
 * event, search or teammate) until a Send turns them into an attachment.
 */
import type { InboxDraftPasted, InboxReplyDraft, InboxUpload } from './inbox-types';

/** A file as a draft save names it: the ref of bytes not sent yet, and for a long paste where it goes back in the words. */
export interface ReplyDraftFileRef {
  upload_id: string;
  pasted?: InboxDraftPasted;
}

/**
 * Two windows changed one draft's files: this window's own change (what it
 * added and removed since `base`, the ids it last read or saved) applied to
 * `theirs`, the list the store holds now. Add and remove commute, so files two
 * windows attach at the same time both stay, and a file either one removed
 * goes. Order: theirs, then what this window added. A file both lists hold
 * takes this window's entry (its long paste's place follows this window's words).
 */
export function mergeReplyDraftFiles<F extends { upload_id: string }>(base: readonly string[], mine: readonly F[], theirs: readonly F[]): F[] {
  const before = new Set(base);
  const mineIds = new Set(mine.map((file) => file.upload_id));
  const theirIds = new Set(theirs.map((file) => file.upload_id));
  const removed = new Set(base.filter((id) => !mineIds.has(id)));
  const ownEntry = new Map(mine.map((file) => [file.upload_id, file]));
  return [
    ...theirs.filter((file) => !removed.has(file.upload_id)).map((file) => ownEntry.get(file.upload_id) ?? file),
    ...mine.filter((file) => !before.has(file.upload_id) && !theirIds.has(file.upload_id)),
  ];
}

/**
 * The files a save leaves in the draft. `allFiles`: the writer sends every
 * file its box holds (`all_files: true`), so its list is the draft's. Without
 * it the writer is an older Inbox page that knows long pastes only: its list
 * replaces the draft's long pastes, and every other file stays. So a writer
 * that does not know a file can never drop it; the worst it does is leave it.
 */
export function replyDraftFilesAfterSave<F extends { upload_id: string; pasted?: unknown }>(existing: readonly F[], incoming: readonly F[], allFiles: boolean): F[] {
  if (allFiles) return [...incoming];
  const named = new Set(incoming.map((file) => file.upload_id));
  return [...existing.filter((file) => !file.pasted && !named.has(file.upload_id)), ...incoming];
}

/** The draft's files a writer can name in `base_files`: all of them, or (an older page) its long pastes only. */
export function replyDraftFileIdsSeenBy(existing: readonly { upload_id: string; pasted?: unknown }[], allFiles: boolean): string[] {
  return existing.filter((file) => allFiles || file.pasted).map((file) => file.upload_id);
}

/** What a Send leaves of the thread's draft (`settleReplyDraftAfterSend`). */
export type ReplyDraftAfterSend<F> = { kind: 'unchanged' } | { kind: 'delete' } | { kind: 'files'; files: F[] };

/**
 * The Send that carried the reply box's draft (`clear_draft`): what is left.
 *  - It names the draft's own version (`clearDraft === updated_at`): the
 *    words go, and so does every file the Send carried. A file it did not
 *    carry (a phone, or an older page, that sent the words alone) stays, as a
 *    draft of files only: never lost, at worst left behind.
 *  - It names an older version: the draft goes only while it holds exactly the
 *    sent words and only files the Send carried. Anything else is another
 *    window's newer work, and stays whole.
 * The files a Send carried also leave every other draft (they are attachments
 * now); the store does that apart from this rule.
 */
export function settleReplyDraftAfterSend<F extends { upload_id: string; pasted?: InboxDraftPasted }>(
  existing: Pick<InboxReplyDraft, 'body' | 'updated_at'> & { files?: readonly F[] },
  sent: { clearDraft: string; words?: string; uploads: readonly string[] },
): ReplyDraftAfterSend<F> {
  const files = existing.files ?? [];
  const carried = new Set(sent.uploads);
  if (existing.updated_at === sent.clearDraft) {
    const left = files.filter((file) => !carried.has(file.upload_id));
    if (left.length === 0) return { kind: 'delete' };
    // The words went: a long paste left behind goes back at the start of the (empty) words.
    return { kind: 'files', files: left.map((file) => (file.pasted ? { ...file, pasted: { at: 0, preview: file.pasted.preview } } : file)) };
  }
  const words = sent.words;
  const sameWords = words !== undefined && existing.body.trim() === words.trim() && (words.trim() !== '' || files.length > 0);
  if (!sameWords || !files.every((file) => carried.has(file.upload_id))) return { kind: 'unchanged' };
  return { kind: 'delete' };
}

/** A save as the window sends it to its draft store. */
export interface ReplyDraftSaveInput {
  body: string;
  /** The version this window last knew (`updated_at` here), or null for none: a compare-and-set. */
  base: string | null;
  /** The words this window saved last, for a save a step behind on `base`. */
  baseBody: string | null;
  /** Every finished file in the box. */
  files: readonly ReplyDraftFileRef[];
  /** The refs this window saved last (with `baseBody`). */
  baseFiles: readonly string[] | null;
}

/**
 * Where a host keeps reply drafts. A refusal rejects with an error carrying
 * `code`: `draft_conflict` (another window changed it; the store's newer draft
 * is read with `read`), `validation_error` (its `message` says which field),
 * or `upload_not_found` (`field`: `files[i]`, a file whose bytes are gone).
 */
export interface ReplyDraftStore {
  read(threadId: string): Promise<InboxReplyDraft | null>;
  /** `keepalive`: sent as the page goes; its answer may never be read. */
  save(threadId: string, input: ReplyDraftSaveInput, options: { keepalive: boolean }): Promise<{ draft: InboxReplyDraft | null }>;
  discard(threadId: string): Promise<void>;
}

/**
 * Where a host keeps the bytes of a file attached to a draft. The ref it
 * answers (`upload_id`) is private to the person until a Send carries it.
 */
export interface DraftFileUploader {
  upload(file: File, options: { signal: AbortSignal; onProgress: (loaded: number, total: number) => void }): Promise<InboxUpload>;
  /** A long paste's words, read back for Put back after a reload or in another window. */
  readText(uploadId: string): Promise<string>;
}
