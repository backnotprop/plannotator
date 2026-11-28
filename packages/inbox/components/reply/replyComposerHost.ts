/**
 * What a host hands the reply box's controller (useReplyComposer.tsx), and what a Send hands back to it. Plain data and
 * callbacks: the host sends, uploads and keeps the draft; the controller owns the words, the files, who gets the reply
 * and the Send's guards. The rules, each held by a test in replyComposer.test.tsx:
 *
 * Send
 * - `host.send` is called exactly once per press, never while a file uploads (the line says why), never twice at once
 *   for one thread. It MUST settle: resolve when the reply went, reject (an Error whose message is for the person)
 *   when it did not. A rejected Send may be pressed again any number of times; the words and files stay each time.
 * - Idempotency is the host's: it mints a key the first time a message is sent and keeps it while what would be sent
 *   is unchanged (`body`, `files` in order, `to`, `reply_to`, `extra`), dropping it on a confirmed Send or a change.
 *   The controller holds no key; for an unchanged box each press hands over those same values. `draft` is not one of
 *   them: the box saves its words again after a rejected Send, so `result.draft` changes from press to press.
 * - While a Send is out the box is read-only: the field takes no keys, and Discard, attach, paste, drop, `addFiles`,
 *   a tile's remove and Put back do nothing. `handle.cancel()` frees the box (words and files kept) when the host
 *   gives up on the press; that press's later settling is ignored.
 * - A Send with no words and no files goes only when `hasOtherContent()` says the host carries something (`extra`).
 *
 * Draft
 * - After a good Send: with `sendClearsDraft` the controller makes NO draft store call (no discard, no save); without
 *   it, exactly one `discard(threadId, { base: result.draft })`, and none when `result.draft` is null. The box is free
 *   at once; its next words are saved once that discard answers (a rejected one shows in `handle.draft.clearFailed`).
 * - "Not saved" (a save that did not land, words longer than a draft holds) is drawn only when the host gives a
 *   `draftStamp` slot to draw it in; with none, nothing shows (`handle.draft.failed` / `tooLong` still say so).
 * - A save refused as `draft_conflict` never replaces or drops the box's words: saving pauses, `onDraftConflict` gets
 *   the store's own error and its newer draft, and `handle.draft.keepMine()` / `takeTheirs()` resume.
 *   `handle.draft.reload()` is how a host says the draft changed elsewhere: an untouched box takes the newer words,
 *   an edited one raises the conflict.
 * - A change of `threadId` is a new box: the old thread's words and files go to ITS draft (uploads land there), and
 *   nothing of it is sent to, or saved on, the new one. A Send still out finishes for its own thread
 *   (`result.threadId`).
 *
 * Files: the uploader's own ids, in order, opaque. A refusal (`{ message }` or an Error) shows its message on its
 * tile, as is (so word it for the person); the words are never blocked by it. Recipients: data only; `to` is in the
 * picker's order, capped at `maxRecipients`. Mentions: a pasted thread id becomes one only through `mentionRefs`; with
 * none nothing is read. With `browserStorage: false` nothing is kept in localStorage or sessionStorage. The box never
 * fetches on its own.
 */
import type { DraftFileUploader, ReplyDraftStore } from '@plannotator/core/inbox-reply-draft';
import type { InboxReplyDraft, InboxReplyMention } from '@plannotator/core/inbox-types';
import type { RecipientRow } from '../../replyRecipients';
import type { SessionLabels } from '../../sessionLabels';
import type { MentionRefs } from '../../threadMentions';
import type { ReplyBoxProps } from './ReplyBox';
import type { ReplyBoxSkills, ReplyBoxVoice } from './replyBoxSeams';

/** What one Send carries, as the box holds it when Send is pressed. */
export interface ReplySendResult {
  /** The thread this Send answers (the box's at the press, whatever it shows when the Send ends). */
  threadId: string;
  /** The words (markdown), trimmed. May be empty when files go, or when `hasOtherContent` said so. */
  body: string;
  /** The threads mentioned in the words, as they stand in `body`. */
  mentions: readonly InboxReplyMention[];
  /** Who gets the reply (recipient ids, in the picker's order, at most `maxRecipients`). Empty: everyone. */
  to: readonly string[];
  /** The line the reply answers (`host.replyTo` at the press). Null: none. */
  reply_to: string | null;
  /** The files' upload ids, in the order their tiles show. */
  files: readonly string[];
  /**
   * The version the box's words were saved as just before the Send: what a store clears. Null: do NOT clear the
   * server's draft (none holds these words: none was saved, or another window's newer draft refused them).
   */
  draft: string | null;
  /** `host.extra()` at the press, untouched: whatever the host's own Send needs beside the box's. */
  extra?: unknown;
}

/** A draft save the store refused because the draft changed elsewhere. */
export interface ReplyDraftConflict {
  threadId: string;
  /** The box's words, not saved (still in the box). */
  mine: string;
  /** The draft as the store holds it now (read after the refusal; null: none). */
  theirs: InboxReplyDraft | null;
  /** The store's own rejection (its `code: 'draft_conflict'` and whatever it carries). Null: not seen (a read raised it). */
  refusal: unknown;
}

/** The box's draft, for the host's own lines and choices (`handle.draft`). */
export interface ReplyComposerDraft {
  /** The draft as the store last held it (null: none). */
  current: InboxReplyDraft | null;
  /** Saving is paused on this conflict until `keepMine` or `takeTheirs`. */
  conflict: ReplyDraftConflict | null;
  /** The words are longer than a draft holds: not saved. */
  tooLong: boolean;
  /** The last save did not land (refused, or no answer). */
  failed: boolean;
  /** The discard after a good Send was rejected: the sent words' draft may still be in the store. */
  clearFailed: boolean;
  /** Save the box's words over the newer draft; saving resumes. */
  keepMine: () => void;
  /** Drop the box's words; the box takes the store's draft (words and files); saving resumes. */
  takeTheirs: () => void;
  /** Read the draft again (it changed elsewhere): an untouched box takes it, an edited one raises the conflict. */
  reload: () => Promise<void>;
}

/** Who can get the reply, as data: the box never fetches it. */
export interface ReplyComposerRecipients {
  /** Every agent the list offers, live first, ended last. */
  rows: readonly RecipientRow[];
  /** Who gets the reply when the box opens, or whenever the host changes it (ids). Absent: none chosen (everyone). */
  chosen?: readonly string[];
  /** The most agents one reply goes to (1: the list picks one). Absent: as many as a draft holds. */
  maxRecipients?: number;
  labels?: SessionLabels;
  folderOf?: (session: string) => string;
}

/** The props the controller owns: a host's `slots` cannot set them, so the guards cannot be passed by. */
export type ReplyComposerOwned =
  | 'threadId'
  | 'mentions'
  | 'replyText'
  | 'sendingWords'
  | 'textRef'
  | 'onChange'
  | 'onFieldKeyDown'
  | 'files'
  | 'onRemoveFile'
  | 'onPutBackFile'
  | 'onAttachFiles'
  | 'onPaste'
  | 'dropOver'
  | 'dropHandlers'
  | 'recipients'
  | 'voice'
  | 'skills'
  | 'sending'
  | 'sendRef'
  | 'onSend'
  | 'onSendWhileUploading'
  | 'onDiscardDraft'
  | 'onClose'
  | 'errorLine'
  | 'draftNotSaved';

/** The rest of the box (what shows above it and with the reply): neutral by default, the host's to fill. */
export type ReplyComposerSlots = Partial<Omit<ReplyBoxProps, ReplyComposerOwned>>;

export interface ReplyComposerHost {
  /** The thread the reply answers (its draft, its mentions). Changing it is a new box (the rules above). */
  threadId: string;
  /** The host sends; MUST settle. Resolves: the box empties. Rejects: words and files stay, the Error's message shows. */
  send: (result: ReplySendResult) => Promise<void>;
  /** Where the files' bytes go. `previewUrl` draws a reloaded draft's picture. A refusal's message shows on its tile. */
  uploader: DraftFileUploader;
  /** Where the draft is kept: read when the thread opens, saved after a pause in typing, cleared after a Send. */
  draftStore: ReplyDraftStore;
  /** A draft save was refused as `draft_conflict` (once each time the conflict is raised). */
  onDraftConflict?: (conflict: ReplyDraftConflict) => void;
  /** Who can get the reply. Absent: no recipient control, `to` is empty. */
  recipients?: ReplyComposerRecipients;
  /** The Skills button and the `/` list. Absent: neither, and no skill list is read. */
  skills?: ReplyBoxSkills;
  /** The reply's voice (from reply/replyVoice.ts). Absent: no microphone and no voice code. */
  voice?: ReplyBoxVoice;
  /** How a pasted or dropped thread id becomes a mention. Absent: it stays words, and nothing is read. */
  mentionRefs?: MentionRefs;
  /** False: nothing the box does is kept in localStorage or sessionStorage (a shared computer keeps no one's words). */
  browserStorage: boolean;
  /** The host's send clears the draft itself (as the Inbox's does, with `clear_draft`): the controller makes no store call after it. */
  sendClearsDraft?: boolean;
  /** True: the host carries something to send beside the box's (answers in `extra`), so an empty box may Send. */
  hasOtherContent?: () => boolean;
  /** The line the reply answers, handed back as `reply_to`. */
  replyTo?: string | null;
  /** Read at each Send and handed back as `extra`. */
  extra?: () => unknown;
  /** The line a Send pressed while a file uploads shows. Default: the Inbox's. */
  uploadingLine?: string;
  phone?: boolean;
  /** The field's placeholder and accessible name's "Reply to …". */
  placeholder?: string;
  replyToNames?: string;
  /** What shows above the box and with the reply (quote, notices, answers, chips, `draftStamp`, `conflict`…). */
  slots?: ReplyComposerSlots;
}
