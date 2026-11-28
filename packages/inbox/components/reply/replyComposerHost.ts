/**
 * What a host hands the reply box's controller (useReplyComposer.tsx), and what a Send hands back to it. Plain data and
 * callbacks: the host sends, uploads and keeps the draft; the controller owns the words, the files, who gets the reply
 * and the Send's guards, so no host can send while a file uploads, save a draft over a Send, or lose words to a Send
 * that failed.
 */
import type { DraftFileUploader, ReplyDraftStore } from '@plannotator/core/inbox-reply-draft';
import type { InboxReplyMention } from '@plannotator/core/inbox-types';
import type { RecipientRow } from '../../replyRecipients';
import type { SessionLabels } from '../../sessionLabels';
import type { ReplyBoxProps } from './ReplyBox';
import type { ReplyBoxSkills, ReplyBoxVoice } from './replyBoxSeams';

/** What one Send carries, as the box holds it when Send is pressed. */
export interface ReplySendResult {
  /** The words (markdown), trimmed. May be empty when files go. */
  body: string;
  /** The threads mentioned in the words, as they stand in `body`. */
  mentions: readonly InboxReplyMention[];
  /** Who gets the reply (recipient ids, the one it answers first). Empty: everyone (the host's default). */
  to: readonly string[];
  /** The line the reply answers (`host.replyTo` at the press). Null: none. */
  reply_to: string | null;
  /** The files' upload ids, in the order their tiles show. */
  files: readonly string[];
  /** The version the box's words were saved as just before the Send (null: no draft holds them). What a store clears. */
  draft: string | null;
  /** `host.extra()` at the press, untouched: whatever the host's own Send needs beside the box's. */
  extra?: unknown;
}

/** Who can get the reply, as data: the box never fetches it. */
export interface ReplyComposerRecipients {
  /** Every agent the list offers, live first, ended last. */
  rows: readonly RecipientRow[];
  /** Who gets the reply when the box opens (ids). Absent: none chosen (everyone). */
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
  /** The thread the reply answers (its draft, its mentions). */
  threadId: string;
  /** The host sends. Resolves: the box empties and the draft is cleared. Rejects: words and files stay, the Error's message shows. */
  send: (result: ReplySendResult) => Promise<void>;
  /** Where the files' bytes go. `previewUrl` draws a reloaded draft's picture. */
  uploader: DraftFileUploader;
  /** Where the draft is kept: read when the thread opens, saved after a pause in typing, cleared after a Send. */
  draftStore: ReplyDraftStore;
  /** Who can get the reply. Absent: no recipient control, `to` is empty. */
  recipients?: ReplyComposerRecipients;
  /** The Skills button and the `/` list. Absent: neither, and no skill list is read. */
  skills?: ReplyBoxSkills;
  /** The reply's voice (from reply/replyVoice.ts). Absent: no microphone and no voice code. */
  voice?: ReplyBoxVoice;
  /** False: nothing the box does is kept in localStorage or sessionStorage (a shared computer keeps no one's words). */
  browserStorage: boolean;
  /** The host's send clears the draft itself (as the Inbox's does, with `clear_draft`): the controller does not. */
  sendClearsDraft?: boolean;
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
  /** What shows above the box and with the reply (quote, notices, answers, chips…). */
  slots?: ReplyComposerSlots;
}
