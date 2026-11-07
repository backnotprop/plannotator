/**
 * A reply draft's files: every file the person attached to a thread's reply
 * box (paperclip, drop, paste, a long paste) is part of the draft, beside its
 * words, until a Send carries it, on every device (the owner, 2026-11-02:
 * "ideally it just syncs").
 *
 * Two halves, both browser-safe (no `node:`):
 *  - the rules every draft store runs, as pure functions: a save carries the
 *    box's file changes (added, removed, placed) and the store applies them to
 *    the draft's files as they are, so two windows' changes never overwrite
 *    each other; and what a Send leaves;
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
 * A save's file changes, relative to what that window's box last held: files it
 * added (`add`, each with its place when a long paste), ids it removed
 * (`remove`), and the current place of long pastes it still holds (`place`).
 * The Inbox applies them to the draft's files as they are then
 * (`applyReplyDraftFileOps`), so a save never touches a file it does not name:
 * another window's file stays, and one another window removed stays removed.
 */
export interface ReplyDraftFileOps<F extends ReplyDraftFileRef = ReplyDraftFileRef> {
  add: F[];
  remove: string[];
  place: { upload_id: string; pasted: InboxDraftPasted }[];
}

export const NO_FILE_OPS: ReplyDraftFileOps = { add: [], remove: [], place: [] };

/**
 * Where an anchor at `at` in `before` is in `after`, for one edit between them
 * (typing, a deletion, a paste, a replace). The edit is the span between the
 * texts' common start and common end. An anchor before it stays; one after it
 * moves by the change in length; one inside a deleted or replaced span goes to
 * that span's start. An insertion exactly at the anchor goes after the pasted
 * text's place (the anchor stays), so typing on at the caret after a paste
 * keeps the paste ahead of the new words, as a plain paste would.
 *
 * Two edits at once (words added at both ends, as a save that spans several
 * pauses carries) look like one span covering the anchor: when the old span is
 * found whole, once, inside the new one, the anchor keeps its place in it. The
 * span never starts or ends between the two halves of a surrogate pair, so an
 * anchor never splits an emoji.
 */
export function mapAnchor(before: string, after: string, at: number): number {
  if (before === after) return at;
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  if (start > 0 && isHighSurrogate(before.charCodeAt(start - 1))) start--;
  let end = 0;
  while (end < max - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
  if (end > 0 && isLowSurrogate(before.charCodeAt(before.length - end))) end--;
  const removedEnd = before.length - end;
  if (at <= start) return at;
  if (at >= removedEnd) return at + (after.length - before.length);
  const old = before.slice(start, removedEnd);
  const span = after.slice(start, after.length - end);
  const found = span.indexOf(old);
  if (found >= 0 && span.lastIndexOf(old) === found) return start + found + (at - start);
  return start;
}
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * The draft's files after a save's changes: removed ids go, an added file joins
 * (once; one already there takes the added entry's place), and a long paste
 * still there takes its new place. A change for a file the draft does not hold
 * (removed, or placed) does nothing. Applying the same changes twice is the
 * same as once. `words`: the save changes the draft's words from `from` to
 * `to`, so a long paste it neither adds nor places (another window's) moves
 * with them (`mapAnchor`, within the new words).
 */
export function applyReplyDraftFileOps<F extends ReplyDraftFileRef>(
  existing: readonly F[],
  ops: ReplyDraftFileOps<F>,
  words?: { from: string; to: string },
): F[] {
  const removed = new Set(ops.remove);
  const added = new Map(ops.add.map((file) => [file.upload_id, file]));
  const places = new Map(ops.place.map((entry) => [entry.upload_id, entry.pasted]));
  const kept = existing
    .filter((file) => !removed.has(file.upload_id))
    .map((file) => {
      const again = added.get(file.upload_id);
      if (again) return again;
      const pasted = places.get(file.upload_id);
      if (pasted && file.pasted) return { ...file, pasted };
      if (file.pasted && words && words.from !== words.to) {
        const at = Math.max(0, Math.min(mapAnchor(words.from, words.to, file.pasted.at), words.to.length));
        return { ...file, pasted: { ...file.pasted, at } };
      }
      return file;
    });
  const here = new Set(kept.map((file) => file.upload_id));
  return [...kept, ...ops.add.filter((file) => !removed.has(file.upload_id) && !here.has(file.upload_id))];
}

/**
 * The same changes for other words: each long paste's place (added or placed), made in `from`, moved to where it is
 * in `to` (`mapAnchor`, within the new words), so a save of `to` never names a place past its end.
 */
export function rewordReplyDraftFileOps<F extends ReplyDraftFileRef>(ops: ReplyDraftFileOps<F>, from: string, to: string): ReplyDraftFileOps<F> {
  if (from === to) return ops;
  const move = <P extends InboxDraftPasted>(pasted: P): P => ({ ...pasted, at: Math.max(0, Math.min(mapAnchor(from, to, pasted.at), to.length)) });
  return {
    add: ops.add.map((file) => (file.pasted ? { ...file, pasted: move(file.pasted) } : file)),
    remove: ops.remove,
    place: ops.place.map((entry) => ({ ...entry, pasted: move(entry.pasted) })),
  };
}

/** What changed from `before` (ids) to `after` (the box's files): added files and removed ids. */
export function diffReplyDraftFiles<F extends ReplyDraftFileRef>(before: readonly string[], after: readonly F[]): ReplyDraftFileOps<F> {
  const was = new Set(before);
  const now = new Set(after.map((file) => file.upload_id));
  return { add: after.filter((file) => !was.has(file.upload_id)), remove: before.filter((id) => !now.has(id)), place: [] };
}

/**
 * `first`, then `then`: one set of changes (the later says last for an id). A long paste `first` adds and `then`
 * places goes in at `then`'s place (the place in the later words, which the save carries).
 */
export function composeReplyDraftFileOps<F extends ReplyDraftFileRef>(first: ReplyDraftFileOps<F>, then: ReplyDraftFileOps<F>): ReplyDraftFileOps<F> {
  const touched = new Set([...then.add.map((file) => file.upload_id), ...then.remove]);
  const placed = new Set(then.place.map((entry) => entry.upload_id));
  const placeOf = new Map(then.place.map((entry) => [entry.upload_id, entry.pasted]));
  return {
    add: [
      ...first.add.filter((file) => !touched.has(file.upload_id)).map((file) => {
        const pasted = file.pasted && placeOf.get(file.upload_id);
        return pasted ? { ...file, pasted } : file;
      }),
      ...then.add,
    ],
    remove: [...first.remove.filter((id) => !touched.has(id)), ...then.remove],
    place: [...first.place.filter((entry) => !placed.has(entry.upload_id)), ...then.place],
  };
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
  /**
   * The version this window last knew (`updated_at` here), or null for none: a compare-and-set on the words. A
   * save is refused (`draft_conflict`) only when the draft's words changed elsewhere: another window's file
   * changes never refuse it.
   */
  base: string | null;
  /** The words this window saved last, for a save a step behind on `base` (the draft still holding them is its own). */
  baseBody: string | null;
  /** The box's file changes since it last held the draft's files: the store applies them (`applyReplyDraftFileOps`). */
  files: ReplyDraftFileOps;
  /**
   * Who the reply goes to, as chosen in the recipient pill (session ids, the first answered, the rest tags); an
   * empty list: none chosen. Absent: the draft keeps the recipients it has (a host or page that does not send them).
   */
  recipients?: readonly string[];
}

/**
 * Where a host keeps reply drafts. `save` answers the draft as it is then (its files after this save's changes and
 * every other window's). A refusal rejects with an error carrying `code`: `draft_conflict` (the words changed in
 * another window; the store's newer draft is read with `read`) or `validation_error` (its `message` says which
 * field). A file added whose bytes are gone (sent or swept) is not added; the save does not fail for it.
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
  /**
   * A file this host already holds, as a ref of its own: no bytes travel, and the file names the version on
   * screen. Absent: the host cannot, and the window offers no control for it.
   */
  reuse?(attachmentId: string, version: 'current' | 'sent', options: { signal: AbortSignal; sha256?: string }): Promise<InboxUpload>;
}
