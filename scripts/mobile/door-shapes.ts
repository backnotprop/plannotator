/**
 * The door's shapes the product declares no TypeScript type for: the pair
 * exchange, the error body, the stream's hello and record frames, and the
 * request bodies of the writes the first app slice sends. Each cites the code
 * that builds or reads it; everything else in the schema is the product's own
 * types (schema.ts ROOTS). When the product gains a type for one of these,
 * use it there and delete it here.
 *
 * Types only: nothing imports this file at run time.
 */
import type { InboxDevicePublic } from '../../packages/shared/inbox/devices';
import type { InboxAnnotationRecord, InboxAttachmentState } from '../../packages/core/inbox-attachments';
import type { InboxRowSnooze } from '../../packages/core/inbox-snooze';
import type { InboxListRow, InboxMessageWire, InboxQuestion, InboxRecordKind, InboxReplyDraft } from '../../packages/core/inbox-types';
import type { QuestionAnswer } from '../../packages/core/question-block';
import type { inboxPickBody } from '../../packages/core/inbox-answers';

/** Every refusal: `{ error, code, ...details }`. Act on `code`, never the words (packages/server/inbox-devices.ts `refuse`). */
export interface DoorError {
  error: string;
  code: string;
  /** The body field at fault, on `422 validation_error`. */
  field?: string;
  /** `401 pairing_code_wrong`: tries left before the offer closes. */
  tries_left?: number;
  /** `413 upload_too_large`, `413 markup_too_large`. */
  max_bytes?: number;
  /** `409 question_already_sent`: the question's key. */
  key?: string;
}

/** `POST pair`: by the QR's secret, or by the six digits typed (inbox-devices.ts, the pair handler). */
export interface DoorPairRequest {
  secret?: string;
  code?: string;
  name: string;
  /** `ios` or `android`. */
  platform: string;
}

/** `201` to `POST pair` (inbox-devices.ts: `json({ device, token, secret, computer, addresses, relay }, 201)`). */
export interface DoorPairAnswer {
  device: InboxDevicePublic;
  /** `tok_` and 43 characters; returned once. */
  token: string;
  /** The pairing secret, also when paired by the digits. */
  secret: string;
  computer: { name: string };
  addresses: { tailnet: string | null; lan: string | null; fingerprint: string | null };
  /** Null when the relay could not be reached at pairing. */
  relay: { url: string; mailbox_id: string } | null;
}

/** `POST revoke`: the device, with `revoked_at` set. */
export interface DoorRevokeAnswer {
  device: InboxDevicePublic;
}

/** The stream's first frame, `event: hello` (packages/server/inbox.ts, the events handler). */
export interface DoorHelloFrame {
  serverSession: string;
  /** The store's highest seq now. */
  cursor: number;
}

/**
 * `event: record`, with `id: <seq>` (packages/server/inbox.ts `eventPayload`). Kinds are added over time: skip
 * one you do not know.
 */
export interface DoorRecordFrame {
  seq: number;
  kind: InboxRecordKind;
  id: string;
  /** `message`: true on the message's first line. */
  first?: boolean;
  message?: InboxMessageWire;
  /** `question`, `steps`, `thread_pull`. */
  thread_id?: string;
  question?: InboxQuestion;
}

/** `POST threads/:id/seen`. */
export interface DoorSeenBody {
  idempotency_key: string;
  /** The seq of the newest message the phone showed; absent: every agent message so far. */
  through_seq?: number | null;
}

/** One question in a pick or a reply. */
export interface DoorQuestionPick {
  /** Another message of the same thread and session (a reply only). */
  message_id?: string;
  key: string;
  revision: number;
  /** Null takes the pick back (a pick only). */
  answer?: QuestionAnswer | null;
}

/** `POST messages/:id/picks`: the window's own body (packages/core/inbox-answers.ts inboxPickBody), with the door's key. */
export type DoorPicksBody = ReturnType<typeof inboxPickBody> & { idempotency_key: string };

/** `POST messages/:id/picks` answers. */
export interface DoorPicksAnswer {
  message_id: string;
  questions: InboxQuestion[];
  reply: null;
}

/** `POST messages/:id/reply` (docs/agent-guides/server-and-storage.md, the reply row). */
export interface DoorReplyBody {
  idempotency_key: string;
  words?: string;
  questions?: DoorQuestionPick[];
  /** Only questions the person chose to skip. */
  skip?: (string | { message_id?: string; key: string })[];
  actions?: { message_id?: string; key: string }[];
  feedback?: string;
  annotation_ids?: string[];
  /** `upl_` ids. */
  uploads?: string[];
  tags?: { host?: string; session: string; label?: string; mode?: 'add' | 'handoff' }[];
  to?: { host?: string; session: string };
  quote?: { of: string; words?: string; time?: string };
  /** The reply draft's `updated_at`, only for words prefilled from that draft. */
  clear_draft?: string;
  /** Add `thread_read` to the answer. */
  with_thread?: boolean;
  /** The `cursor` of the thread read the person saw (`409 thread_moved_on` when an agent wrote after it). */
  seen_through_seq?: number;
}

// The thread actions (packages/server/inbox.ts, inbox-pins.ts, inbox-snooze.ts, inbox-priority.ts): each body is the
// window's own (packages/inbox/api.ts) with the door's key. None compares and sets: each writes a state, and writing
// the state a thread already has changes nothing.

/** `POST messages/:id/resolve`: archive (`true`) or unarchive (`false`) the message's thread. */
export interface DoorResolveBody {
  idempotency_key: string;
  resolved: boolean;
}

/** `POST threads/:id/read` (Mark read), `unread` (Move back) and `mark-unread`: the key alone. */
export interface DoorKeyBody {
  idempotency_key: string;
}

/** `POST threads/:id/mark-unread`. `wrote: false`: nothing to make new. `through_seq`: what a `seen` puts back. */
export interface DoorMarkUnreadAnswer {
  thread: InboxListRow;
  wrote: boolean;
  through_seq: number;
}

/** `POST threads/:id/pin`: star or unstar (a new star goes last). */
export interface DoorPinBody {
  idempotency_key: string;
  pinned: boolean;
}

/** `POST pins`: one of `order` (the stars' new order) or `restore` (Unstar's Undo, at its place). */
export interface DoorPinsBody {
  idempotency_key: string;
  order?: string[];
  restore?: { thread_id: string; index: number; pinned_at: string };
}

/** `POST threads/:id/snooze`: until a time (ISO, UTC), or `null` to unsnooze. `at`: an Undo's earlier snooze's own time. */
export interface DoorSnoozeBody {
  idempotency_key: string;
  until: string | null;
  at?: string;
}

/** `POST threads/:id/snooze` answers the snooze as it stands (`null`: none, or a held time already past). */
export interface DoorSnoozeAnswer {
  snoozed: InboxRowSnooze | null;
}

/** `POST threads/:id/priority`: one of `priority` (add or remove) or `restore` (an Undo puts back what was). */
export interface DoorPriorityBody {
  idempotency_key: string;
  priority?: boolean;
  restore?: DoorPriorityBefore;
}

/** What a priority write found: its Undo's `restore`. */
export interface DoorPriorityBefore {
  at: string | null;
  off_at: string | null;
}

export interface DoorPriorityAnswer {
  before: DoorPriorityBefore;
}

/** `GET threads/:id/draft` (packages/server/inbox-reply-drafts.ts): the thread's reply draft on the computer, or none. */
export interface DoorThreadDraftAnswer {
  serverSession: string;
  draft: InboxReplyDraft | null;
}

/** `GET threads/:id/attachments` (packages/server/inbox-attachments.ts): every file the thread carries, as it is now. */
export interface DoorThreadAttachmentsAnswer {
  serverSession: string;
  attachments: InboxAttachmentState[];
  inline_images?: InboxAttachmentState[];
  /** The person's comments that wait for a Send (on files, on messages' words, on guided reviews). */
  annotations?: InboxAnnotationRecord[];
}

/** `POST annotations` (packages/server/inbox-attachments.ts): a comment on a file's version, new or edited (the same annotation id). */
export interface DoorAnnotationBody {
  idempotency_key: string;
  attachment_id: string;
  /** `current`, or the sent version's sha256. */
  version: string;
  /** Plannotator's annotation, as the viewer made it. */
  annotation: Record<string, unknown>;
}

/** `POST annotations` answers. */
export interface DoorAnnotationAnswer {
  annotation: InboxAnnotationRecord;
}

/** `POST annotations/:id/remove`. */
export interface DoorAnnotationRemoveBody {
  idempotency_key: string;
}

/** `POST markups` answers (packages/shared/inbox/markups.ts): where the drawing is kept, and the name a comment shows it by. */
export interface DoorMarkupAnswer {
  path: string;
  name: string;
  url?: string;
}
