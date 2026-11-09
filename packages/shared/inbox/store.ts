/**
 * Plannotator Inbox store: per-project append-only JSONL under
 * `${dataDir}/inbox/`, read whole at start and kept in memory.
 *
 * One writer: the Inbox server process. Every change appends ONE line, a full
 * snapshot of the record, in a single append-mode write; the in-memory view is
 * updated from that same line and every subscriber is told, in seq order. A
 * line that does not parse is skipped on read (a torn last line after a
 * crash); before the first append to a file whose last line is torn, a newline
 * is appended first so the fragment stays its own unreadable line and the new
 * line stays whole.
 *
 * The rules (picks, Send, idempotency) live here so the window's API and the
 * MCP tools share them. See schema.ts for the layout.
 */

import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { inboxDecisionExcerpt, orderInboxDecisions, type InboxDecisionCandidate } from "./decisions";
import {
  checkInboxAnswer,
  composeInboxReaskBody,
  composeInboxReplyBody,
  composeInboxReopenedBody,
  composeInboxSetAsideBody,
  inboxSkipAnswer,
  deriveInboxSubject,
  derivePersonThreadSubject,
  inboxQuestionState,
  inboxReplyStillOpenOf,
  inboxQuestionWaitsOnPerson,
  inboxRowWaits,
  isInboxQuestionSupersedable,
  parseInboxQuestionBlocks,
  parseInboxSupersedeRef,
  splitInboxReplyBody,
  summarizeInboxQuestions,
  toInboxQuestion,
  type InboxAnswerRefusal,
} from "@plannotator/core/inbox-questions";
import { withoutInboxSkillsBlock } from "@plannotator/core/skill-reference-block";
import {
  checkInboxActionResult,
  composeInboxActionsReply,
  composeInboxActionsSection,
  withInboxActionsSection,
  parseInboxActionBlocks,
  parseInboxDoneRef,
  INBOX_ACTIONS_HEADING,
} from "@plannotator/core/inbox-actions";
import {
  inboxId,
  INBOX_ACK_LABEL,
  INBOX_AUTO_SEND_ACK_NOTES,
  INBOX_RECORD_VERSION,
  type InboxAck,
  type InboxReaction,
  type InboxAddressee,
  type InboxLaunchClone,
  type InboxLaunchError,
  type InboxLaunchRecord,
  type InboxReplyViewing,
  type InboxAuthor,
  type InboxDecision,
  type InboxGuideRef,
  type InboxLine,
  type InboxMessage,
  type InboxMessageWire,
  type InboxPicker,
  type InboxProject,
  type InboxQuestion,
  type InboxQuestionRecord,
  type InboxReplyDraft,
  type InboxPin,
  type InboxSupersededBy,
  type InboxListRow,
  type InboxListSection,
  type InboxThread,
  type InboxThreadSummary,
  checkInboxProjectName,
  checkInboxSubject,
  checkInboxThreadName,
  displayInboxSubject,
  type InboxThreadNaming,
  inboxThreadNameKey,
  isInboxNote,
  inboxPersonAnsweredSince,
  isInboxActionReport,
  inboxActionInDraft,
  inboxAgentName,
  INBOX_HOST_NAMES,
  INBOX_MCP_WAKING_HOSTS,
  INBOX_TAGS_MAX,
  INBOX_THREAD_NAME_MAX,
  INBOX_SESSION_ID_PATTERN,
  type InboxParticipant,
  type InboxSentRecipient,
  type InboxTag,
  inboxAskingMessage,
  inboxDefaultSkip,
  inboxDeliveryState,
  type InboxDeliveryConnection,
  type InboxDeliveryDecision,
  type InboxDeliverNowBy,
  type InboxQuestionState,
  type InboxRowDelivery,
} from "@plannotator/core/inbox-types";
import { inboxHasUnsent, inboxListSections, inboxRowUnread, inboxSectionOf } from "./list";
import { inboxProjectLabels } from "./project-name";
import { inboxActivity, type InboxActivitySource } from "./activity";
import { inboxAckLine, inboxClaimName, inboxStopNoticeId, inboxStopNoticeReply, type InboxWakeContext } from "./connection";
import { inboxWakeQuote } from "./wake-quote";
import type { QuestionAnswer } from "@plannotator/core/question-block";
import { INBOX_PERMISSION_FULL, INBOX_PERMISSION_SESSION_PREFIX, isInboxPermissionSession } from "@plannotator/core/inbox-permission";
import { inboxProjectKey } from "./project-key";
import { parseDiagramAnchor } from "@plannotator/core/diagram-anchor";
import {
  INBOX_ANNOTATION_CURRENT,
  INBOX_LIVE_ANNOTATION_MAX,
  INBOX_LIVE_ELEMENT_MAX,
  INBOX_LIVE_QUOTE_MAX,
  INBOX_LIVE_URL_MAX,
  INBOX_MESSAGE_COMMENT_QUOTE_MAX,
  INBOX_MESSAGE_COMMENT_TEXT_MAX,
  isInboxAnnotationId,
  isInboxAnnotationVersion,
  isInboxAnnotatableKind,
  INBOX_VIDEO_BLOCK_ID,
  readInboxAttachmentKind,
  readInboxVideoTime,
  type InboxAnnotationRecord,
  type InboxAttachment,
  type InboxDraftFile,
  type InboxInlineImage,
  type InboxLiveSiteRef,
} from "@plannotator/core/inbox-types";
import { applyReplyDraftFileOps, replyDraftFileIdsSeenBy, replyDraftFilesAfterSave, settleReplyDraftAfterSend } from "@plannotator/core/inbox-reply-draft";
import { isLineRangeInPatch, parseDiffToFiles, type DiffFile } from "@plannotator/core/diff-files";
import { inboxBlobPath, inboxBlobSizes, removeUnusedInboxBlobs } from "./attachments";
import { inboxMarkupNamesOf, removeInboxMarkups } from "./markups";
import { INBOX_VIEWING_TIME, inboxViewingText, pendingInboxUploadBlobs, readInboxUpload, removeUnusedInboxUploadFiles } from "./uploads";
import { DECISION_LINES_FILE, decisionLinesOf, type DecisionDataInput } from "./decision-data";
import { inboxDraftsBytes } from "./drafts";
import { pruneInboxAsks } from "./ask";
import { checkInboxReplyDraftInput, type InboxReplyDraftInput, inboxReplyDraftFileIds, readInboxReplyDrafts, removeInboxReplyDraft, sameInboxUploadIds, writeInboxReplyDraft } from "./reply-drafts";
import { checkInboxPinOrder, checkInboxPinRestore, readInboxPins, writeInboxPins } from "./pins";
import { readInboxSnoozes, refuseInboxSnoozeUntil, writeInboxSnoozes } from "./snoozes";
import { inboxSnoozeRefusal, inboxSnoozeRunning, type InboxSnooze } from "@plannotator/core/inbox-snooze";
import { INBOX_CARD_PR_HINT } from "./cards";
import { INBOX_CARD_REF_HINT, parseInboxCardRef } from "./card-refs";
import {
  INBOX_CARD_COLUMN_LABELS,
  INBOX_CARD_COLS_VERSION,
  inboxCardAutoShip,
  INBOX_CARD_KEY_MAX,
  INBOX_CARD_LINE_MAX,
  INBOX_CARD_LINKS_MAX,
  INBOX_CARD_REASON_MAX,
  INBOX_CARD_TITLE_MAX,
  inboxCardColumnIndex,
  inboxCardColumnOf,
  readInboxCard,
  isInboxCardSeenOnlyChange,
  isInboxCardSentWaiting,
  normalizeInboxCardNotes,
  inboxCardHistory,
  inboxCardRefIsLinkOnly,
  inboxCardRefsOf,
  inboxCardDonePrs,
  type InboxCardRef,
  type InboxCardHistoryEntry,
  isInboxCardDropUnseen,
  isInboxCardLiveColumn,
  isInboxCardPersonColumn,
  normalizeInboxCardText,
  stripInboxCardRefusedChars,
  type InboxCard,
  type InboxCardColumn,
  type InboxCardPr,
  type InboxCardWire,
} from "@plannotator/core/inbox-types";
import { isInboxStepsRecord, normalizeInboxSteps, sameInboxSteps, type InboxSteps } from "@plannotator/core/inbox-types";
import type { InboxActivityModel } from "@plannotator/core/inbox-types";
import {
  inboxHashtags,
  inboxInitiativeBareName,
  inboxInitiativeJoinKey,
  inboxInitiativeNameKey,
  inboxInitiativeTagKey,
  inboxTaggedInitiative,
  INBOX_INITIATIVE_NAME_MAX,
  isInboxInitiativeId,
  isInboxInitiativeRecord,
  type InboxInitiative,
} from "@plannotator/core/inbox-types";
import type { InboxReviewVerdictRecord } from "@plannotator/core/inbox-review";
import { INBOX_ATTACHMENT_FEEDBACK_TITLE, INBOX_GUIDE_FEEDBACK_TITLE, INBOX_MESSAGE_FEEDBACK_TITLE } from "@plannotator/core/inbox-review";
import { codeFenceCloseIndex } from "@plannotator/core/markdown-structure";
import {
  ANNOTATIONS_FILE,
  CARDS_FILE,
  INITIATIVES_FILE,
  LEGACY_DECISIONS_FILE,
  INBOX_PROJECTS_DIR,
  SEQ_FLOOR_FILE,
  STEPS_FILE,
  InboxError,
  inboxDir,
  MESSAGES_FILE,
  parseInboxLine,
  PROJECT_FILE,
  QUESTIONS_FILE,
} from "./schema";

/** The local person, the only picker on a local Inbox. */
export const INBOX_PERSON: InboxPicker = { id: "person", name: null };

export type InboxListener = (line: InboxLine) => void;

export interface InboxSendInput {
  project_id: string;
  author: Extract<InboxAuthor, { kind: "agent" }>;
  /**
   * Server only (launch's permission route): the author is a permission
   * question's `perm:<session>` identity. Every other writer is refused that
   * prefix, so a `perm:` author is always the Inbox's own permission card.
   */
  permission?: boolean;
  body: string;
  subject?: string | null;
  reply_to?: string | null;
  idempotency_key?: string | null;
  /**
   * A thread name in this project: the open thread of that name, across
   * sessions, or a new one under it. Without it (and without reply_to) the
   * message starts a new thread. Ignored with reply_to.
   */
  thread?: string | null;
  /** The files attached, already recorded (blobs written) by recordInboxAttachments. */
  attachments?: InboxAttachment[];
  /**
   * The images the body shows, already captured (blobs written) by
   * captureInboxInlineImages. Absent: the body shows none (nothing is
   * written); an empty list: it shows some but none could be read.
   */
  inline_images?: InboxInlineImage[];
  /** Running apps the body's question choices name as prototypes, already checked and probed by the server (`packages/server/inbox-live.ts`). */
  live_sites?: Omit<InboxLiveSiteRef, "opened_at">[];
  /** A guided review the message carries (submit_guide); its blob is written once the message lands. */
  guide?: InboxGuideRef | null;
  /** The folder inside the project the agent sent from, when not its root (`InboxMessage.base_path`). */
  base_path?: string | null;
  /** The sender's own project, when it sent into another project's thread (`InboxMessage.from_project`). */
  from_project?: { name: string; root: string } | null;
  /**
   * Earlier questions of the same thread this message supersedes:
   * `<message id>` (each open question of it) or `<message id>/<key>`. A
   * `Replaces:` line in the body's blocks does the same per block. One id
   * that names no open question of the thread refuses the whole send
   * (`invalid_supersedes`).
   */
  supersedes?: readonly string[] | null;
  /**
   * Action items (`:::action` blocks) of the same thread the agent saw done by
   * itself: `<message id>` (each open action item of it) or `<message id>/<key>`.
   * Recorded on the action item (`action_result` by the agent); nothing is sent to
   * the person or back. One id that names no open action item of the thread refuses
   * the whole send (`invalid_done`).
   */
  done?: readonly string[] | null;
  /**
   * The send came through a connection that wakes its session with the
   * person's reply (the Claude Code mod, Pi, OpenCode 2): kept on the message
   * (`InboxMessage.wakes`), the only evidence that the asking session can be
   * told to have ended when it stops polling.
   */
  wakes?: boolean;
}

export interface InboxSendResult {
  message: InboxMessageWire;
  replayed: boolean;
  /**
   * A reply into a thread the person started that this agent may still name
   * (`canNameThread`): `named` when its `thread` named the thread, `refused`
   * (with a code and why) when that name was not valid or another open thread
   * of the project has it, `unnamed` when it gave none. A replay answers what
   * the first call answered (kept on the reply as `thread_naming`). Absent
   * everywhere else.
   */
  naming?: InboxThreadNaming;
  /** The action items this send marked done (`done`), `<message id>/<key>`. Absent when none. */
  done?: string[];
}

export interface InboxAnswerEntry {
  /**
   * A Send only: the message the question is on, when it is not the message
   * the reply answers. It must be another message of the same thread from
   * the same agent session (one Send to one session is one reply, approval
   * "inbox-explicit-skip"). Absent: the reply's own message.
   */
  message_id?: string;
  key: string;
  revision: number;
  /** Absent: keep the current pick (Send only). Null: clear the pick. */
  answer?: unknown;
}

export interface InboxReplyInput {
  words?: string;
  /** Written by a tailnet guest (`InboxMessage.by_guest`): the server's `isGuest`, never the window's word. */
  by_guest?: boolean;
  questions?: InboxAnswerEntry[];
  idempotency_key: string;
  /** `to` takes the place of a session the server read as ended (`InboxMessage.took_over`). */
  took_over?: boolean;
  /**
   * The person's annotations on the thread's attachments, as Plannotator's
   * feedback text (the window exports them), appended after the answers.
   */
  feedback?: string;
  /** The annotations that text carries: marked sent with the reply. */
  annotation_ids?: string[];
  /**
   * The file on screen when the person sent this from full screen's floating box (`planViewing`): the window's
   * `{ attachment_id, time?, page?, as_sent? }`. Context only, so anything off about it drops it and never refuses the Send.
   */
  viewing?: unknown;
  /**
   * The person chose another live session to take this reply, because the
   * session that asked has ended (the window's choice at Send). Absent: the
   * reply goes to the asking session, as always. Null: a session was asked
   * for but the server found it not live; nothing is written
   * (`session_not_live`), except that a replay answers what it wrote.
   */
  to?: InboxAddressee | null;
  /**
   * The open questions the person chose to skip with this Send ("Skip them"
   * on the chip; approval "inbox-explicit-skip", 2026-10-21): each is sent as
   * a skip marked `by_reply`, in the same reply. A key alone is a question of
   * the reply's own message; `{ message_id, key }` names one on another
   * message of the same thread and session. A listed question that is no
   * longer open (answered, picked, closed, replaced) is left alone, so a race
   * never refuses the Send; one that is not a question of that message is
   * refused. Absent or empty: nothing is skipped. A Send never skips on its
   * own (the old `skip_unanswered` flag is gone).
   */
  skip?: unknown;
  /**
   * The action items whose Done or Can't do it waits in the person's draft
   * (approval "inbox-action-items-in-reply"): `{ key }` on the reply's own
   * message, `{ message_id, key }` on another message of the same thread and
   * session. Each is marked sent with the reply, under "Action items you asked
   * for". One no longer in the draft (taken back, sent, closed) is left out,
   * so a race never refuses the Send. Absent or empty: none.
   */
  actions?: unknown;
  /**
   * Files the person pasted into the reply box, already copied out of their
   * uploads (`inboxUploadAttachments`): the reply carries them as compose's
   * thread carries its files, and a reply of files alone is a reply.
   */
  attachments?: InboxAttachment[];
  /**
   * The agent sessions the person tagged with `@` (approval "inbox-tag-agents"),
   * as the server resolved them (live, or an MCP agent it knows): each one is
   * handed this reply too and records its own delivery. The owner is dropped
   * (it gets the reply anyway). Absent or empty: nobody is tagged.
   */
  tags?: unknown;
  /**
   * "Hand off instead" (approval "inbox-tag-handoff", A2): this reply hands
   * the thread to `to` (a live session the server checked), which then owns
   * it: the reply is addressed to it, and so is every later reply in the
   * thread. `from` is the thread's owner until now, as the server read it,
   * with whether its connection wakes it (only then is it sent a notice).
   * Held for the Undo window (`settleHandoffs`, `undoHandoff`).
   */
  handoff?: { to: InboxAddressee; label?: string | null; from: { host: string | null; session: string; wakes: boolean; label?: string | null } | null };
  /**
   * The person's verdict on the review this reply answers (code review in the
   * Inbox: Approve or Send feedback in the review's header). Only on a reply
   * to a message whose guide is a review; the server passes it only while the
   * person has Code review on. Stored on the reply as `review_verdict`, with
   * how many of the review's comments the reply carries.
   */
  review_verdict?: unknown;
}

/** The person's Re-ask (approval "inbox-reask"): ask the agent for its open questions again, in one message. */
export interface InboxReaskInput {
  idempotency_key: string;
  /** Written by a tailnet guest (`InboxMessage.by_guest`). */
  by_guest?: boolean;
  /**
   * Another live session takes the note, because the one that asked has
   * ended (the window's choice, as for a reply). Null: a session was asked
   * for but the server found it not live; nothing is written.
   */
  to?: InboxAddressee | null;
}

export interface InboxReplyResult {
  reply: InboxMessage;
  questions: InboxQuestion[];
  replayed: boolean;
}

export interface InboxProjectUsage {
  id: string;
  name: string;
  root: string;
  bytes: number;
  threads: { thread_id: string; subject: string | null; bytes: number }[];
  /** The project this folder was combined into, by name. */
  combined_into?: string;
  /** The projects combined into this one, by name: deleting it leaves them, as their own projects again. */
  combined?: string[];
}

/** An attachment found by its id: the record and the message that carries it. */
export interface InboxAttachmentHit {
  attachment: InboxAttachment;
  message: InboxMessage;
}

export interface InboxDiskUsage {
  /** The store's folder (`${dataDir}/inbox`). */
  dir: string;
  bytes: number;
  projects: InboxProjectUsage[];
}

/**
 * Whether a file's last line was torn by a crash, so the next append starts on a fresh line and can't be glued to it.
 * For a file the store never reads into memory, so it has no `tornFiles` entry; the last byte says, without reading the rest.
 */
function endsMidLine(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    const { size } = fstatSync(fd);
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

/** An annotation as stored: without the exporter's `exportLocation`, which only the window sets, on its export copies. */
function withoutExportLocation(annotation: Record<string, unknown>): Record<string, unknown> {
  if (!("exportLocation" in annotation)) return annotation;
  const { exportLocation: _dropped, ...rest } = annotation;
  return rest;
}

/**
 * A live comment's page as the bridge reports it: a path with its query
 * (`/settings?tab=billing`), never a scheme-relative `//host` address, no
 * control characters, at most INBOX_LIVE_URL_MAX characters.
 */
function isLivePagePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= INBOX_LIVE_URL_MAX &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith("/\\") &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/** An action item named where a question's answer or skip goes: it is marked on its card (Done, Can't do it). */
/** Why an action item the person marked through the timed path (decision mode, the phone door) is refused: it goes in seconds. */
const PERSON_MARKED_WORDS = "the person already marked it; their answer reaches you in a few seconds";

function actionNotQuestion(field: string, key: string): InboxError {
  return new InboxError("validation_error", `${field}: ${key} is an action item, not a question; mark it Done or Can't do it on its card.`, { field, key });
}

function refusalError(refusal: InboxAnswerRefusal): InboxError {
  switch (refusal.code) {
    case "validation_error":
      return new InboxError("validation_error", `${refusal.field}: ${refusal.message}`, { field: refusal.field });
    case "question_not_found":
      return new InboxError("question_not_found", `No question ${refusal.key} on this message.`, { key: refusal.key });
    case "question_revision_conflict":
      return new InboxError(
        "question_revision_conflict",
        `Question ${refusal.key} changed since you read it (revision ${refusal.current_revision}).`,
        { key: refusal.key, current_revision: refusal.current_revision },
      );
    case "question_already_sent":
      return new InboxError("question_already_sent", `The answer to ${refusal.key} was already sent.`, { key: refusal.key });
    case "question_superseded":
      return new InboxError(
        "question_superseded",
        refusal.superseded_by.key
          ? `Question ${refusal.key} was replaced by a newer question (${refusal.superseded_by.message_id}/${refusal.superseded_by.key}); it can no longer be answered.`
          : `Question ${refusal.key} no longer applies (${refusal.superseded_by.message_id}); it can no longer be answered.`,
        { key: refusal.key, superseded_by: refusal.superseded_by },
      );
  }
}

/** A thread's last message, the Inbox's own notes read past (`isInboxNote`). */
function lastNonNote(messages: readonly InboxMessage[]): InboxMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (!isInboxNote(messages[i]!)) return messages[i];
  return undefined;
}

/** The note that carries a 👍 Looks good to the agent (`ack_of`): never listed in a thread, the ack on its message says it. */
function isAckNote(message: InboxMessage): boolean {
  return message.author.kind === "person" && typeof message.ack_of === "string" && message.ack_of !== "";
}

/** Two tray reactions are the same emoji with the same name (null is 👍 Looks good). */
function sameReaction(a: InboxReaction | null, b: InboxReaction | null): boolean {
  return (a?.emoji ?? null) === (b?.emoji ?? null) && (a?.label ?? "") === (b?.label ?? "");
}

/**
 * An agent message from another session than `than` (a thread's first agent, or the session a thread the
 * person started is addressed to): a second agent in the thread, whom a reply to that message goes to.
 */
function otherSessionThan(message: InboxMessage | undefined, than: { host?: string | null; session?: string | null } | null): boolean {
  if (!message || message.author.kind !== "agent" || !than) return false;
  return (message.author.session ?? null) !== (than.session ?? null) || (message.author.host ?? null) !== (than.host ?? null);
}

/** A person's reply that tags agents (`tags`, approval "inbox-tag-agents"). */
function hasTags(message: InboxMessage): boolean {
  return (message.tags?.length ?? 0) > 0;
}

/**
 * A delivery's `into_turn`, written only for an item the Inbox marked to go
 * in by itself (the connection's report, decided by the server).
 */
function intoTurnOf(by: InboxDeliverNowBy | null | undefined, intoTurn: boolean | undefined): { into_turn?: boolean } {
  return by === "auto" && typeof intoTurn === "boolean" ? { into_turn: intoTurn } : {};
}

/** The tag a person's message carries for `session`, or null. */
function tagOf(message: InboxMessage, session: string): InboxTag | null {
  return message.tags?.find((tag) => tag.session === session) ?? null;
}

/**
 * The tags a Send asked for, as the server resolved them: each session once,
 * in the order typed, at most INBOX_TAGS_MAX, never the reply's owner (who
 * gets it anyway), each entry shaped exactly (fail closed: anything else is
 * a validation error, nothing written).
 */
export function normalizeInboxTags(value: unknown, owner: string | null): InboxTag[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new InboxError("validation_error", "tags: a list of tagged sessions.", { field: "tags" });
  if (value.length > INBOX_TAGS_MAX) throw new InboxError("validation_error", `tags: at most ${INBOX_TAGS_MAX} sessions.`, { field: "tags" });
  const out: InboxTag[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new InboxError("validation_error", "tags: each one { host, session, wakes }.", { field: "tags" });
    const { host, session, name, wakes, label, joined } = entry as Record<string, unknown>;
    if (typeof session !== "string" || !INBOX_SESSION_ID_PATTERN.test(session)) {
      throw new InboxError("validation_error", "tags: each session an id.", { field: "tags" });
    }
    if (host !== null && (typeof host !== "string" || host.length > 64)) throw new InboxError("validation_error", "tags: host a string or null.", { field: "tags" });
    if (typeof wakes !== "boolean") throw new InboxError("validation_error", "tags: wakes true or false.", { field: "tags" });
    if (name !== undefined && name !== null && (typeof name !== "string" || name.length > 80)) {
      throw new InboxError("validation_error", "tags: name a short string.", { field: "tags" });
    }
    if (label !== undefined && label !== null && (typeof label !== "string" || label.length > 120 || /[\u0000-\u001f\u007f]/.test(label))) {
      throw new InboxError("validation_error", "tags: label a short line.", { field: "tags" });
    }
    if (session === owner || out.some((tag) => tag.session === session)) continue;
    out.push({
      host: host as string | null,
      session,
      ...(typeof name === "string" && name ? { name } : {}),
      ...(typeof label === "string" && label.trim() ? { label: label.trim() } : {}),
      wakes,
      // "Add instead": the session joins the thread (later replies go to it too).
      ...(joined === true ? { joined: true } : {}),
    });
  }
  return out;
}

/** A hand-off still inside its Undo window: nobody is handed the reply yet. */
function handoffHeld(message: InboxMessage): boolean {
  return !!message.handoff && !message.handoff.settled_at && !message.handoff.undone_at;
}

/** A hand-off that moved the thread (not taken back). */
function handoffActive(message: InboxMessage): boolean {
  return message.author.kind === "person" && !!message.handoff && !message.handoff.undone_at && !!message.to;
}

/** The most ids one send may supersede. */
export const INBOX_SUPERSEDES_MAX = 100;

// `<name>-<6 hex of the root>`: in project-key.ts, so the Shape store files under the same keys without loading this store.
export { inboxProjectKey };

/**
 * The highest seq in an older store's decisions.jsonl (Decisions were removed
 * in 2026-10; the file is kept on disk and its records are never read), or 0.
 * Read leniently: only each line's `seq` counts.
 */
function legacySeqFloor(path: string): number {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  let high = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const seq = (JSON.parse(raw) as { seq?: unknown }).seq;
      if (typeof seq === "number" && Number.isSafeInteger(seq) && seq > high) high = seq;
    } catch {
      // A torn line: skipped, as the store skips one.
    }
  }
  return high;
}

/**
 * What a list row's delivery (`InboxListRow.delivery`) reads about the live
 * agent sessions, which the store does not hold: the server passes its live
 * sessions (packages/server/inbox-sessions.ts). Both answer from memory.
 */
export interface InboxDeliveryPresence {
  /** How a session is connected now (no grace), or null when it does not poll. */
  connection(session: string): InboxDeliveryConnection | null;
  /** The host a live session said it is (its poll, or an MCP call that named one). Absent or null: not known. */
  hostOf?(session: string): string | null;
  /** Whether the session that asked is still there, with the sessions route's grace (`askerLive`). */
  askerLive(session: string): boolean;
  /** Whether a reply to this session starts it again (a launched thread's own session): it has not ended. Absent: never. */
  launchResumes?(threadId: string, session: string): boolean;
  /**
   * Whether an item may not have reached its session though it was handed on
   * (a Codex `codex queue` call that ran out of time): the row says it is
   * saved for the agent's next read. Absent: never.
   */
  uncertain?(session: string, itemId: string): boolean;
  /**
   * Whether the session's connection claimed an item and will never deliver it (its wake was killed while it
   * delivered): the row says it was not delivered, and it may move to another session. Absent: never.
   */
  stuck?(session: string, itemId: string): boolean;
  /** The server's wait before an item goes into a busy session's turn by itself (`INBOX_AUTO_SEND_AFTER_MS`). Absent: never. */
  autoSendAfterMs?: number;
  /**
   * The server's clock for an item waiting on `session`: since when it waits
   * on that busy session, and since when it may go in by itself (null: not
   * yet, the session has not been seen able to take it mid-turn). Null when
   * no clock runs. Absent: never known.
   */
  waitOf?(session: string, itemId: string): { since: string; autoSince: string | null } | null;
}

/** The review app's comment types a guided-review line comment can be. */
const GUIDE_COMMENT_TYPES: ReadonlySet<unknown> = new Set(["comment", "suggestion", "concern"]);

/**
 * The fields of a comment on a guided review that are kept, checked: what the
 * export and the windows read, and nothing else (a field the client adds is
 * dropped; one of the wrong kind is refused, so a bad value can never break a
 * Send). A global comment (`general`) is words only: no suggestion, no quoted
 * lines, no token, no images. The caller sets the location fields.
 */
function guideCommentFields(fields: Record<string, unknown>, scope: "line" | "general"): Record<string, unknown> {
  const refuse = (field: string, what: string): never => {
    throw new InboxError("validation_error", `annotation.${field}: ${what}`, { field: `annotation.${field}` });
  };
  const absent = (value: unknown) => value === undefined || value === null || (Array.isArray(value) && value.length === 0);
  if (scope === "general") {
    if (fields.type !== "comment") refuse("type", '"comment" (a global comment is words).');
    for (const field of ["suggestedCode", "originalCode", "selectedText", "tokenText", "charStart", "charEnd", "images"]) {
      if (!absent(fields[field])) refuse(field, "a global comment is on the whole review and takes none.");
    }
  } else {
    if (!GUIDE_COMMENT_TYPES.has(fields.type)) refuse("type", '"comment", "suggestion" or "concern".');
    if (!absent(fields.images)) refuse("images", "a comment on a guided review takes none.");
  }
  const kept: Record<string, unknown> = { id: fields.id, type: fields.type, scope };
  if (fields.text !== undefined) kept.text = fields.text;
  const strings = scope === "general" ? ["author", "conventionalLabel"] : ["author", "conventionalLabel", "suggestedCode", "originalCode", "selectedText", "tokenText", "anchorText"];
  for (const field of strings) {
    const value = fields[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") refuse(field, "a string.");
    kept[field] = value;
  }
  if (scope === "line") {
    // On a line an expand arrow opened: a PR's review posts it in its main comment, never inline.
    if (fields.outsideDiff === true) kept.outsideDiff = true;
    for (const field of ["charStart", "charEnd"]) {
      const value = fields[field];
      if (value === undefined || value === null) continue;
      if (!Number.isInteger(value) || (value as number) < 0) refuse(field, "a character offset.");
      kept[field] = value;
    }
  }
  const decorations = fields.decorations;
  if (decorations !== undefined && decorations !== null) {
    if (!Array.isArray(decorations) || !decorations.every((d) => typeof d === "string")) refuse("decorations", "a list of words.");
    kept.decorations = decorations;
  }
  const createdAt = fields.createdAt;
  kept.createdAt = typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : Date.now();
  return kept;
}

/** The headings a Send appends after the person's words (the action items, the annotations' feedback). */
const SEND_APPENDED_HEADINGS: ReadonlySet<string> = new Set([
  `## ${INBOX_ACTIONS_HEADING}`,
  `# ${INBOX_MESSAGE_FEEDBACK_TITLE}`,
  `# ${INBOX_ATTACHMENT_FEEDBACK_TITLE}`,
  `# ${INBOX_GUIDE_FEEDBACK_TITLE}`,
]);

/**
 * The person's own words in a reply as stored (approval "board-hashtags"), for a card made later for its
 * thread (`threadTaggedInitiative`): without the reply's first line, the still-open line and the answers
 * section (`splitInboxReplyBody`) and the skills block, cut where a Send appends its own sections (the
 * action items, the annotations' feedback, which quote plans and files): only at those headings, each after
 * a blank line, never inside a code fence. The person's own headings and fenced `# comments` stay words.
 * At send time the reply's words are read directly (`sendReply`), and a New message's body is its words.
 */
function personWords(body: string): string {
  const lines = splitInboxReplyBody(withoutInboxSkillsBlock(body)).words.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i]!)) {
      i = codeFenceCloseIndex(lines, i);
      continue;
    }
    if (SEND_APPENDED_HEADINGS.has(lines[i]!.trimEnd()) && (i === 0 || lines[i - 1]!.trim() === "")) return lines.slice(0, i).join("\n");
  }
  return lines.join("\n");
}

export class InboxStore {
  readonly dir: string;
  /** The live sessions, for the rows' delivery; null (tests, tools): not known, every session counts as there. */
  private deliveryPresence: InboxDeliveryPresence | null = null;
  private seq = 0;
  private readonly latest = new Map<string, InboxLine>();
  private readonly projectsById = new Map<string, InboxProject>();
  private readonly projectsByRoot = new Map<string, InboxProject>();
  /** Each project's display name (`inboxProjectLabels`), worked out again when the projects change. */
  private projectLabels: Map<string, string> | null = null;
  private projectGroups: { heads: Map<string, string>; members: Map<string, string[]> } | null = null;
  private readonly messages = new Map<string, InboxMessage>();
  /** The agent sessions with a message through a waking connection (`hasWakingMessage`, read every second). */
  private readonly wakingSessions = new Set<string>();
  /** The ids of the thread roots an agent was launched for (`launch`): the launch sweep reads these, never every message. */
  private readonly launchedRootIds = new Set<string>();
  /** The seq of a message's first line: its place in the event log. */
  private readonly messageSeq = new Map<string, number>();
  /**
   * A resolved thread's archive line: the seq of the root line that set its
   * current `resolved_at`. Derived from the log in seq order, so a replay
   * finds the same value; nothing is written for it.
   */
  private readonly resolvedSeq = new Map<string, number>();
  /**
   * The roots of threads the person started whose address moved ("Send to
   * another session": a later root line names another `to.session`). Derived
   * from the log in seq order, like `resolvedSeq`; read by `threadNamers`.
   */
  private readonly readdressed = new Set<string>();
  private readonly questions = new Map<string, InboxQuestionRecord>();
  /** Each message's question ids (a question's message never changes, so the index only grows). */
  private readonly messageQuestions = new Map<string, Set<string>>();
  /** Each thread's message ids in seq order. */
  private readonly threadMembers = new Map<string, string[]>();
  /**
   * Thread routing: every root of each thread name in seq order
   * (`<project>\0<name key>`), kept from each root's first line, so a replay
   * of the log gives the same answers.
   */
  private readonly namedThreads = new Map<string, string[]>();
  /**
   * Threads the person started, by the name compose gave them (typed or the
   * suggestion): never routes anything, only keeps a second open thread
   * from taking the name (`threadNameTaken`).
   */
  private readonly personNamed = new Map<string, string[]>();
  /** The person's annotations on attachments, by id. */
  private readonly annotations = new Map<string, InboxAnnotationRecord>();
  /** Per thread, its annotations waiting for a Send (not sent, not removed): a row's `unsent.comments`. */
  private readonly unsentAnnotations = new Map<string, number>();
  /**
   * The words typed in each thread's reply box and not sent (reply-drafts.ts),
   * by thread id: files outside the event log, read at load and kept here.
   */
  private readonly replyDrafts = new Map<string, InboxReplyDraft>();
  /**
   * Per thread, the files its reply draft lost and has not taken back since, each with the `updated_at` of the
   * draft that dropped it. A page's save sent against an older version does not add one again (`saveReplyDraft`):
   * it is that page sending again a change whose answer it never read, after another window took the file out.
   * Kept in memory: after a restart such a file comes back at worst (never one lost).
   */
  private readonly replyDraftRemovals = new Map<string, Map<string, string>>();
  /**
   * The threads pinned to the window's sidebar, in pin order (pins.ts,
   * approval "inbox-pinned-threads"): a file outside the event log, read at
   * load. Read by nothing that routes, lists or answers an agent.
   */
  private pinList: InboxPin[] = [];
  /** Told when the pins change (no store line is written for them). */
  private readonly pinListeners = new Set<() => void>();
  /**
   * The snoozed threads (snoozes.ts, approval "inbox-snooze"): a file outside
   * the event log, read at load. Read by nothing that routes, lists or answers
   * an agent; `listRow` never carries it (the server's list model does).
   */
  private snoozeList: InboxSnooze[] = [];
  /** Told when the snoozes change (no store line is written for them). */
  private readonly snoozeListeners = new Set<() => void>();
  private readonly deletionListeners = new Set<() => void>();
  /** The Board's cards, by id (approval "inbox-board"). Read by nothing that routes or lists threads. */
  private readonly cards = new Map<string, InboxCard>();
  /** The seq of the line that last wrote to each card (a drop's seen mark is not a write): the Board's unread rule. */
  private readonly cardHeardSeq = new Map<string, number>();
  /**
   * Each agent session's steps per thread, by record id (approval
   * "inbox-thread-steps"), and the id of each (thread, session)'s record.
   * Read by nothing that routes, lists, counts unread or notifies.
   */
  private readonly stepsById = new Map<string, InboxSteps>();
  private readonly stepsIdOf = new Map<string, string>();
  /** Each thread's steps record ids (a thread's read never scans every list). */
  private readonly stepsIdsByThread = new Map<string, Set<string>>();
  /** The Board's initiatives, by id, deleted ones too (approval "board-initiatives"). Read by the Board only. */
  private readonly initiativesById = new Map<string, InboxInitiative>();
  /**
   * Hashtags (approval "board-hashtags"): every thread a message (an agent's or the person's) tags, by the
   * tag's key (`inboxInitiativeTagKey`, so a rename needs no rebuild): each thread's latest tagging seq, and
   * the threads in the order of those seqs (`order`, oldest first; a thread tagged again is appended again,
   * its earlier entry stale, compacted when stale entries outnumber live ones). Filled as each message is
   * first applied (load and write alike, both in seq order, `indexTags`), never rescanned and never written
   * to disk; a delete's reload builds it again. Read by `initiativeThreads` only, from the newest end.
   */
  private readonly tagThreads = new Map<string, { latest: Map<string, number>; order: string[] }>();
  /** A guided review's files by its snapshot's sha256 (a blob never changes). */
  private readonly guideFileSets = new Map<string, ReadonlyMap<string, DiffFile>>();
  private readonly tornFiles = new Set<string>();
  private readonly listeners = new Set<InboxListener>();
  /** Told when a thread's reply draft is saved or deleted (no store line is written for it). */
  private readonly replyDraftListeners = new Set<(threadId: string) => void>();
  /** How many times the store was read again from disk (a deletion): a reader's derived view is stale once it changes. */
  private reloads = 0;
  /**
   * Counts every change to what the list rows read (`listRow`): each line applied, a question or annotation put
   * back, a reply draft saved or dropped, a re-read, the live sessions handed in. `listRows()` keeps its last
   * answer while this stays the same (`rowsMemo`).
   */
  private changes = 0;
  /**
   * The last `listRows()` (every thread, no filter), with each answer the live sessions gave while it was built
   * (`InboxDeliveryPresence`, keyed by the call): it is given again while nothing in the store changed and every
   * one of those calls still answers the same, so it is exactly what building it again would give.
   */
  private rowsMemo: { changes: number; presence: InboxDeliveryPresence | null; calls: Map<string, { ask: () => unknown; answer: string }>; rows: InboxListRow[] } | null = null;
  /**
   * Each agent session's latest message id (by its first line's seq), kept as each message is first applied, in
   * the order the sessions first wrote: `latestAgentMessages` and `lastThreadsBySession` read it instead of every
   * message. A re-read builds it again.
   */
  private readonly latestAgentIds = new Map<string, string>();
  /** Per thread, how many message lines were applied to it: `threadVersion`. */
  private readonly threadLines = new Map<string, number>();
  private readonly now: () => Date;

  private constructor(dataDir: string, now: () => Date) {
    this.dir = inboxDir(dataDir);
    this.now = now;
  }

  /** Read the store under `dataDir` (created owner-only when missing). */
  static open(dataDir: string, options: { now?: () => Date } = {}): InboxStore {
    const store = new InboxStore(dataDir, options.now ?? (() => new Date()));
    store.load();
    return store;
  }

  // ─────────────────────────── reading ───────────────────────────

  private load(): void {
    this.changes += 1;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      // Best effort (Windows, a filesystem without modes).
    }
    this.seq = Math.max(this.seq, this.readSeqFloor());
    this.replyDrafts.clear();
    this.replyDraftRemovals.clear();
    for (const [threadId, draft] of readInboxReplyDrafts(this.dir)) this.replyDrafts.set(threadId, draft);
    const projectsDir = join(this.dir, INBOX_PROJECTS_DIR);
    const lines: InboxLine[] = [];
    // The Board's initiatives: one file for every project, on the same seq.
    this.readLines(join(this.dir, INITIATIVES_FILE), lines);
    if (!existsSync(projectsDir)) {
      lines.sort((a, b) => a.seq - b.seq);
      for (const line of lines) this.apply(line);
      this.loadPins();
      this.loadSnoozes();
      return;
    }
    for (const key of readdirSync(projectsDir)) {
      const folder = join(projectsDir, key);
      // Decisions were removed (2026-10): an older store's decisions.jsonl is
      // left on disk and never applied, but its seqs still count, so a seq is
      // never handed out twice.
      this.seq = Math.max(this.seq, legacySeqFloor(join(folder, LEGACY_DECISIONS_FILE)));
      for (const name of [PROJECT_FILE, MESSAGES_FILE, QUESTIONS_FILE, ANNOTATIONS_FILE, CARDS_FILE, STEPS_FILE]) this.readLines(join(folder, name), lines);
    }
    lines.sort((a, b) => a.seq - b.seq);
    for (const line of lines) this.apply(line);
    this.repairUnsentAnswers();
    this.loadPins();
    this.loadSnoozes();
  }

  /** One store file's lines into `into` (none when it is missing); a torn last line is noted for the next append. */
  private readLines(path: string, into: InboxLine[]): void {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return;
    }
    if (text.length > 0 && !text.endsWith("\n")) this.tornFiles.add(path);
    for (const raw of text.split("\n")) {
      const line = parseInboxLine(raw);
      if (line) into.push(line);
    }
  }

  /**
   * A Send writes its questions' "sent" lines before the reply line. When the
   * reply never landed (the process died, or the append failed), those
   * questions name a reply that does not exist: read them as picked again, so
   * the person can Send them, instead of "already sent" with nothing sent.
   * In memory only; the next pick or Send writes the corrected record.
   */
  private repairUnsentAnswers(): void {
    for (const record of this.questions.values()) {
      if (record.sent_reply_id === null || this.messages.has(record.sent_reply_id)) continue;
      this.restoreQuestion({ ...record, sent_revision: 0, sent_reply_id: null });
    }
    // Annotations a Send marked before its reply line landed wait again.
    for (const record of this.annotations.values()) {
      if (record.sent_reply_id === null || this.messages.has(record.sent_reply_id)) continue;
      this.restoreAnnotation({ ...record, sent_reply_id: null });
    }
  }

  /** Put a question record back in memory (and in the event log's current view) without writing. */
  private restoreQuestion(record: InboxQuestionRecord): void {
    this.changes += 1;
    this.questions.set(record.id, record);
    const key = `question:${record.id}`;
    const line = this.latest.get(key);
    if (line && line.kind === "question") this.latest.set(key, { ...line, record });
  }

  private apply(line: InboxLine): void {
    this.changes += 1;
    if (line.seq > this.seq) this.seq = line.seq;
    const id = `${line.kind}:${line.id}`;
    const previous = this.latest.get(id);
    if (previous && previous.seq > line.seq) return;
    this.latest.set(id, line);
    switch (line.kind) {
      case "project":
        this.projectsById.set(line.record.id, line.record);
        this.projectsByRoot.set(line.record.root, line.record);
        this.projectLabels = null;
        this.projectGroups = null;
        break;
      case "message": {
        // The archive line: the root line whose resolved_at differs from the one before it.
        const before = previous?.kind === "message" ? previous.record.resolved_at : null;
        if (line.record.resolved_at == null) this.resolvedSeq.delete(line.record.id);
        else if (before !== line.record.resolved_at || !this.resolvedSeq.has(line.record.id)) this.resolvedSeq.set(line.record.id, line.seq);
        if (previous?.kind === "message" && line.record.started_by_person && previous.record.to && line.record.to && previous.record.to.session !== line.record.to.session) {
          this.readdressed.add(line.record.id);
        }
        // A thread the person started routes by name only once an AGENT names it (sendMessage):
        // indexed at that line, in seq order, so later sends with the name join it and a replay
        // routes the same. A name the person typed, or compose's suggestion, never routes another
        // session's send into the person's thread (`personNamed`, for de-duplication only).
        if (
          previous?.kind === "message" &&
          line.record.started_by_person &&
          line.record.thread_name &&
          line.record.named_by?.kind === "agent" &&
          previous.record.named_by?.kind !== "agent"
        ) {
          this.indexName(line.record.project_id, line.record.thread_name, line.record.id);
        }
        this.messages.set(line.record.id, line.record);
        this.threadLines.set(line.record.thread_id, (this.threadLines.get(line.record.thread_id) ?? 0) + 1);
        if (line.record.wakes === true && line.record.author.kind === "agent" && line.record.author.session) this.wakingSessions.add(line.record.author.session);
        if (line.record.launch !== undefined && line.record.thread_id === line.record.id) this.launchedRootIds.add(line.record.id);
        if (!this.messageSeq.has(line.record.id)) {
          this.messageSeq.set(line.record.id, line.seq);
          this.noteAgentMessage(line.record, line.seq);
          const members = this.threadMembers.get(line.record.thread_id);
          if (members) members.push(line.record.id);
          else this.threadMembers.set(line.record.thread_id, [line.record.id]);
          this.indexRoot(line.record);
          this.indexTags(line.record, line.seq);
        }
        break;
      }
      case "question": {
        this.questions.set(line.record.id, line.record);
        const ids = this.messageQuestions.get(line.record.message_id);
        if (ids) ids.add(line.record.id);
        else this.messageQuestions.set(line.record.message_id, new Set([line.record.id]));
        break;
      }
      case "annotation":
        this.setAnnotation(line.record);
        break;
      case "card":
        // Cards are their own records: nothing here touches routing or the list.
        // A card stored before columns v2 reads in the v2 columns (readInboxCard: the migration table, never a rewrite).
        {
          let card = readInboxCard(line.record);
          const prev = this.cards.get(card.id);
          // A card in Done holds every PR it links (marked or not: a released Inbox wrote no `via`), with any
          // list it had; a later line without the field keeps what the card had. So a card shipped and moved back
          // before the upgrade, or by an older Inbox that carried a stale list along, is not moved to Done again.
          if (card.column === "done") card = { ...card, done_prs: inboxCardDonePrs(card, card.done_prs ?? prev?.done_prs) };
          else if (card.done_prs === undefined && prev?.done_prs) card = { ...card, done_prs: prev.done_prs };
          // An Inbox from before initiatives writes a card without the field: the card keeps its initiative
          // (only the person sets one, and that Inbox has no way to).
          if (line.record.initiative === undefined && prev?.initiative) card = { ...card, initiative: prev.initiative };
          if (!prev || !isInboxCardSeenOnlyChange(prev, card)) this.cardHeardSeq.set(card.id, line.seq);
          this.cards.set(card.id, card);
        }
        break;
      case "steps":
        // Steps are their own records: nothing here touches routing, the list, unread or notifications.
        if (isInboxStepsRecord(line.record)) {
          this.stepsById.set(line.record.id, line.record);
          this.stepsIdOf.set(`${line.record.thread_id}\0${line.record.agent.session}`, line.record.id);
          let ids = this.stepsIdsByThread.get(line.record.thread_id);
          if (!ids) this.stepsIdsByThread.set(line.record.thread_id, (ids = new Set()));
          ids.add(line.record.id);
        }
        break;
      case "initiative":
        // The Board's initiatives (approval "board-initiatives"): read by the Board only.
        if (isInboxInitiativeRecord(line.record)) this.initiativesById.set(line.record.id, line.record);
        break;
    }
  }

  /** Note a root's routing keys, from its first line only. */
  private indexRoot(message: InboxMessage): void {
    if (message.thread_id !== message.id) return;
    // A thread the person started: its compose name (typed, or the suggestion) routes nothing:
    // it is noted only so no other thread takes the same name.
    if (message.author.kind !== "agent") {
      if (message.started_by_person && message.thread_name) {
        const key = `${message.project_id}\0${inboxThreadNameKey(message.thread_name)}`;
        const roots = this.personNamed.get(key);
        if (roots) roots.push(message.id);
        else this.personNamed.set(key, [message.id]);
      }
      return;
    }
    const name = message.thread_name ?? null;
    if (name !== null) this.indexName(message.project_id, name, message.id);
  }

  /**
   * The roots a name routes to (agents' names: a name, once there, never
   * changes), oldest first, across a combined project: one name, one thread,
   * from either folder. The keys stay per folder, so an undo leaves each as it was.
   */
  private rootsNamed(projectId: string, name: string): string[] {
    const key = inboxThreadNameKey(name);
    const group = this.projectGroup(projectId);
    if (group.length === 1) return this.namedThreads.get(`${projectId}\0${key}`) ?? [];
    return group.flatMap((id) => this.namedThreads.get(`${id}\0${key}`) ?? []).sort((a, b) => (this.messageSeq.get(a) ?? 0) - (this.messageSeq.get(b) ?? 0));
  }

  /** Add a root under a thread name; the last one added is the newest of that name. */
  private indexName(projectId: string, name: string, rootId: string): void {
    const key = `${projectId}\0${inboxThreadNameKey(name)}`;
    const roots = this.namedThreads.get(key);
    if (roots) roots.push(rootId);
    else this.namedThreads.set(key, [rootId]);
  }

  /**
   * The thread a message without reply_to joins, or null for a new thread:
   * with a `name`, the newest OPEN thread of that name in the project (one the
   * person reopened counts). Without a name, always a new thread (the owner,
   * 2026-11-08: joining the session's last unnamed thread put long-lived
   * sessions' news into weeks-old, unrelated threads).
   */
  private routeThread(projectId: string, name: string | null): string | null {
    return name === null ? null : this.newestOpen(projectId, this.rootsNamed(projectId, name));
  }

  /**
   * The newest open thread of `roots` (oldest first): in `projectId`'s own
   * folder when it has one, so a combine never moves a live conversation;
   * else the newest in the rest of a combined project.
   */
  private newestOpen(projectId: string, roots: readonly string[]): string | null {
    const open = roots.filter((rootId) => !this.isResolved(rootId));
    return open.filter((rootId) => this.messages.get(rootId)!.project_id === projectId).at(-1) ?? open.at(-1) ?? null;
  }

  /** The highest seq written: the event-log cursor "now". */
  cursor(): number {
    return this.seq;
  }

  /** The current snapshot of every record changed after `cursor`, in seq order. */
  changesSince(cursor: number): InboxLine[] {
    const out: InboxLine[] = [];
    for (const line of this.latest.values()) if (line.seq > cursor) out.push(line);
    return out.sort((a, b) => a.seq - b.seq);
  }

  /**
   * Counts the store's re-reads from disk (after a deletion). Lines are told
   * to subscribers; a re-read is not, so a reader that keeps a derived view
   * (the search index) compares this number instead.
   */
  reloadCount(): number {
    return this.reloads;
  }

  /**
   * Changes whenever one of the thread's messages does (a message line for it, or a re-read): what is derived
   * from its messages alone (`imageCaptureGaps`) is the same while this is.
   */
  threadVersion(threadId: string): string {
    return `${this.reloads}.${this.threadLines.get(threadId) ?? 0}`;
  }

  /** Every thread's root id, in the order the threads began. */
  threadIds(): string[] {
    const out: string[] = [];
    for (const [threadId] of this.threadMembers) if (this.messages.get(threadId)?.thread_id === threadId) out.push(threadId);
    return out;
  }

  /** A thread's message ids in seq order. */
  threadMessageIds(threadId: string): readonly string[] {
    return this.threadMembers.get(threadId) ?? [];
  }

  subscribe(listener: InboxListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The pins changed (pinned, unpinned, reordered, or a deleted thread left them): no store line is written. */
  onPinsChange(listener: () => void): () => void {
    this.pinListeners.add(listener);
    return () => this.pinListeners.delete(listener);
  }

  /** A thread or project was deleted: whatever runs for a thread that is gone can stop. */
  onDeletion(listener: () => void): () => void {
    this.deletionListeners.add(listener);
    return () => this.deletionListeners.delete(listener);
  }

  private pinsChanged(): void {
    for (const listener of this.pinListeners) {
      try {
        listener();
      } catch {
        // A listener's failure never fails the write.
      }
    }
  }

  /**
   * Read pins.json and keep the pins of threads that exist. Pruning happens
   * here, on load, rather than when a thread is deleted, because the delete
   * paths (deleteThread, deleteProject) end in a full reload, and because an
   * Inbox that predates pins may have deleted a pinned thread while this file
   * sat on disk: every load is where a pin can outlive its thread, so every
   * load drops it and writes the file back. Called at the end of every load.
   */
  private loadPins(): void {
    const before = this.pinList;
    const read = readInboxPins(this.dir);
    const kept = read.filter((pin) => this.isThreadRoot(pin.thread_id));
    this.pinList = kept;
    if (kept.length !== read.length) {
      try {
        writeInboxPins(this.dir, kept);
      } catch {
        // Best effort: the next load prunes it again.
      }
    }
    // A reload that dropped a pin the window still draws: tell it.
    if (before.some((pin) => !kept.some((k) => k.thread_id === pin.thread_id))) this.pinsChanged();
  }

  private isThreadRoot(threadId: string): boolean {
    return this.messages.get(threadId)?.thread_id === threadId;
  }

  /** The pinned threads, in pin order (the sidebar's order). */
  pins(): readonly InboxPin[] {
    return this.pinList;
  }

  private commitPins(next: InboxPin[]): readonly InboxPin[] {
    const same = next.length === this.pinList.length && next.every((pin, i) => pin.thread_id === this.pinList[i]!.thread_id && pin.pinned_at === this.pinList[i]!.pinned_at);
    if (same) return this.pinList;
    writeInboxPins(this.dir, next);
    this.pinList = next;
    this.pinsChanged();
    return next;
  }

  /**
   * Pin a thread (at the bottom) or unpin it. Any thread may be pinned, an
   * archived one too, with no limit. Pinning a pinned thread, or unpinning one
   * that is not, changes nothing. Writes no store line.
   */
  setPinned(threadId: string, pinned: boolean): readonly InboxPin[] {
    if (!this.isThreadRoot(threadId)) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    const has = this.pinList.some((pin) => pin.thread_id === threadId);
    if (has === pinned) return this.pinList;
    return this.commitPins(pinned ? [...this.pinList, { thread_id: threadId, pinned_at: this.now().toISOString() }] : this.pinList.filter((pin) => pin.thread_id !== threadId));
  }

  /**
   * Put the pins in an order (Move up, Move down): a permutation of the
   * threads pinned NOW. The threads `order` names that are pinned come first,
   * in that order, then every other pin in its place, so a window that has
   * not seen another tab's pin never drops it. A named thread that is not
   * pinned (another tab unpinned it, or it no longer exists) is skipped: an
   * order never pins and never unpins.
   */
  orderPins(value: unknown): readonly InboxPin[] {
    const order = checkInboxPinOrder(value);
    const byId = new Map(this.pinList.map((pin) => [pin.thread_id, pin]));
    const named: InboxPin[] = [];
    for (const id of order) {
      const pin = byId.get(id);
      if (pin) named.push(pin);
    }
    const namedIds = new Set(named.map((pin) => pin.thread_id));
    return this.commitPins([...named, ...this.pinList.filter((pin) => !namedIds.has(pin.thread_id))]);
  }

  /**
   * Unpin's Undo: pin exactly one thread again at `index` (clamped to the
   * pins as they are now) with the `pinned_at` it had. A thread that is
   * pinned again already (another tab) keeps its place; one that no longer
   * exists is refused (`thread_not_found`).
   */
  restorePin(value: unknown): readonly InboxPin[] {
    const restore = checkInboxPinRestore(value);
    if (!this.isThreadRoot(restore.thread_id)) throw new InboxError("thread_not_found", `No thread ${restore.thread_id}.`);
    if (this.pinList.some((pin) => pin.thread_id === restore.thread_id)) return this.pinList;
    const next = [...this.pinList];
    next.splice(Math.min(restore.index, next.length), 0, { thread_id: restore.thread_id, pinned_at: restore.pinned_at });
    return this.commitPins(next);
  }

  /** The snoozes changed (set, ended, or a deleted thread left them): no store line is written. */
  onSnoozesChange(listener: () => void): () => void {
    this.snoozeListeners.add(listener);
    return () => this.snoozeListeners.delete(listener);
  }

  private snoozesChanged(): void {
    for (const listener of this.snoozeListeners) {
      try {
        listener();
      } catch {
        // A listener's failure never fails the write.
      }
    }
  }

  /** Read snoozes.json and keep the snoozes of threads that exist (the same load-time pruning as `loadPins`). */
  private loadSnoozes(): void {
    const before = this.snoozeList;
    const read = readInboxSnoozes(this.dir);
    const kept = read.filter((snooze) => this.isThreadRoot(snooze.thread_id));
    this.snoozeList = kept;
    if (kept.length !== read.length) {
      try {
        writeInboxSnoozes(this.dir, kept);
      } catch {
        // Best effort: the next load prunes it again.
      }
    }
    if (before.some((snooze) => !kept.some((k) => k.thread_id === snooze.thread_id))) this.snoozesChanged();
  }

  /** Every snooze on this Inbox, a return not read yet included. */
  snoozes(): readonly InboxSnooze[] {
    return this.snoozeList;
  }

  /** The threads snoozed now, by this store's clock (a return is not one). */
  snoozedThreads(): Set<string> {
    const now = this.now();
    return new Set(this.snoozeList.filter((entry) => inboxSnoozeRunning(entry.until, now)).map((entry) => entry.thread_id));
  }

  private commitSnoozes(next: InboxSnooze[]): void {
    writeInboxSnoozes(this.dir, next);
    this.snoozeList = next;
    this.snoozesChanged();
  }

  /**
   * Snooze a thread until `until`, or move a snooze it has. `at` keeps an
   * earlier snooze's own time (Undo). An archived thread refuses: it has
   * nowhere to come back to. Writes no store line.
   */
  setSnooze(threadId: string, until: unknown, at?: unknown): InboxSnooze {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    if (root.resolved_at !== null && !this.agentAfterArchive(threadId)) throw new InboxError("thread_resolved", "This thread is archived; unarchive it first.");
    refuseInboxSnoozeUntil(until, this.now());
    const now = this.now();
    // `at` (Undo's earlier snooze) is a real ISO time, not after now; stored normalized like `until`.
    if (at !== undefined && (typeof at !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(at) || Number.isNaN(Date.parse(at)) || Date.parse(at) > now.getTime())) {
      throw new InboxError("validation_error", "at: an ISO time, not after now.", { field: "at" });
    }
    const snooze: InboxSnooze = { thread_id: threadId, until: new Date(until as string).toISOString(), at: at === undefined ? now.toISOString() : new Date(at as string).toISOString() };
    this.commitSnoozes([...this.snoozeList.filter((entry) => entry.thread_id !== threadId), snooze]);
    return snooze;
  }

  /**
   * A snooze write a linked machine held for this one. Its time can pass on the way, and then it is not refused: the
   * person wanted the thread back by then. A snooze still running here returns now, as if the write had landed in
   * time (its mark included). A return not read yet keeps its own mark. Null: the thread is not snoozed now.
   */
  setHeldSnooze(threadId: string, until: unknown, at?: unknown): InboxSnooze | null {
    if (inboxSnoozeRefusal(until, this.now()) !== "past") return this.setSnooze(threadId, until, at);
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    const running = this.snoozeList.find((entry) => entry.thread_id === threadId && inboxSnoozeRunning(entry.until, this.now()));
    if (running) this.commitSnoozes([...this.snoozeList.filter((entry) => entry.thread_id !== threadId), { ...running, until: new Date(until as string).toISOString() }]);
    return null;
  }

  /** Unsnooze: the snooze ends, and with it a return's mark. A thread with none changes nothing. */
  clearSnooze(threadId: string): void {
    if (!this.snoozeList.some((entry) => entry.thread_id === threadId)) return;
    this.commitSnoozes(this.snoozeList.filter((entry) => entry.thread_id !== threadId));
  }

  /**
   * The person acted on the thread, so its snooze is over: their reply, Mark
   * read, Archive. The act already stands, so a file that cannot be written
   * never fails it; the snooze then runs out by itself.
   */
  endSnooze(threadId: string): void {
    try {
      this.clearSnooze(threadId);
    } catch {
      // See above.
    }
  }

  /**
   * Past its time, the entry goes: a look took the return, or an archived thread
   * was reopened, which brings it back for that reason and not as a return, so
   * no clock and no "Back from snooze". A snooze still running stays.
   */
  private endLapsedSnooze(threadId: string): void {
    const snooze = this.snoozeList.find((entry) => entry.thread_id === threadId);
    if (snooze && !inboxSnoozeRunning(snooze.until, this.now())) this.endSnooze(threadId);
  }

  /** A thread's reply draft was saved or deleted: its row's `unsent` (and section) changed with no store line. */
  onReplyDraftChange(listener: (threadId: string) => void): () => void {
    this.replyDraftListeners.add(listener);
    return () => this.replyDraftListeners.delete(listener);
  }

  private replyDraftChanged(threadId: string): void {
    for (const listener of this.replyDraftListeners) {
      try {
        listener(threadId);
      } catch {
        // A listener's failure never fails the save.
      }
    }
  }

  /**
   * The project as every reader sees it: `name` is the real name of its
   * folder (`inboxProjectLabels`), not the slug it was stored with, which
   * stays its folder key. The record on disk is unchanged.
   */
  private labeled(project: InboxProject): InboxProject {
    // A combined project reads the name of the project it went into, and takes no part in the others' clashes.
    this.projectLabels ??= inboxProjectLabels([...this.projectsById.values()].filter((p) => this.canonicalProjectId(p.id) === p.id));
    const name = this.projectLabels.get(this.canonicalProjectId(project.id));
    return name && name !== project.name ? { ...project, name } : project;
  }

  /** Each project's group head and each head's members (itself first, then oldest first). Built once per project change. */
  private groups(): { heads: Map<string, string>; members: Map<string, string[]> } {
    if (this.projectGroups) return this.projectGroups;
    const headOf = (id: string): string => {
      const seen = new Set([id]);
      let at = this.projectsById.get(id)!;
      for (;;) {
        const next = typeof at.merged_into === "string" ? this.projectsById.get(at.merged_into) : undefined;
        if (!next) return at.id;
        // A loop has no end: every project on it stands alone, so none is hidden.
        if (seen.has(next.id)) return id;
        seen.add(next.id);
        at = next;
      }
    };
    const heads = new Map<string, string>();
    const members = new Map<string, string[]>();
    const oldestFirst = [...this.projectsById.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    for (const project of oldestFirst) {
      const head = headOf(project.id);
      heads.set(project.id, head);
      if (head === project.id) members.set(head, [head, ...(members.get(head) ?? [])]);
      else members.set(head, [...(members.get(head) ?? []), project.id]);
    }
    this.projectGroups = { heads, members };
    return this.projectGroups;
  }

  /** The project whose name and list `projectId`'s threads show under: itself, unless it was combined. */
  canonicalProjectId(projectId: string): string {
    return this.groups().heads.get(projectId) ?? projectId;
  }

  /** Every project of `projectId`'s group, the head first. A project nothing was combined with is alone in it. */
  projectGroup(projectId: string): string[] {
    return this.groups().members.get(this.canonicalProjectId(projectId)) ?? [projectId];
  }

  /** Whether two projects read as one. */
  sameProject(a: string, b: string): boolean {
    return a === b || this.canonicalProjectId(a) === this.canonicalProjectId(b);
  }

  /**
   * The projects combined into `projectId`, each named by its own folder or
   * given name: the name an undo gives it back. Oldest first. Named beside the
   * project they are in, so a clone of it keeps its parent ("billing-svc · old"),
   * never a second "billing-svc".
   */
  combinedInto(projectId: string): InboxProject[] {
    if (this.canonicalProjectId(projectId) !== projectId) return [];
    const members = this.projectGroup(projectId)
      .slice(1)
      .map((id) => this.projectsById.get(id)!);
    const head = this.projectsById.get(projectId);
    const names = inboxProjectLabels(head ? [head, ...members] : members);
    return members.map((project) => ({ ...project, name: names.get(project.id) ?? project.name }));
  }

  /**
   * Combine `projectId` into `intoId`, or undo that (null). One new project line,
   * the pattern of `renameProject`: no message, question, card or file moves, so
   * an undo restores everything, what was sent since included. Messages stay where
   * they were written: a thread stays in its own project, whoever joined it.
   * A project that others were combined into takes them along and brings them back,
   * because they keep pointing at it. `intoId` may be a combined project: its head
   * is what is stored. Refuses a project already inside this one (the two would
   * loop), and a project already in another (`already_combined`: undo it first).
   */
  combineProject(projectId: string, intoId: string | null): InboxProject {
    const project = this.projectsById.get(projectId);
    if (!project) throw new InboxError("project_not_found", `No project ${projectId}.`);
    const { merged_into: previous, separated_from: _separated, ...rest } = project;
    let record: InboxProject;
    if (intoId === null) {
      if (typeof previous !== "string") return this.labeled(project);
      record = { ...rest, separated_from: previous };
    } else {
      if (intoId === projectId) throw new InboxError("validation_error", "into: a project cannot be combined into itself.", { field: "into" });
      if (!this.projectsById.has(intoId)) throw new InboxError("project_not_found", `No project ${intoId}.`, { field: "into" });
      const head = this.canonicalProjectId(intoId);
      if (head === projectId) throw new InboxError("validation_error", "into: that project is already combined into this one.", { field: "into" });
      const current = this.canonicalProjectId(projectId);
      if (head === current) return this.labeled(project);
      // Moving it would lose where it was: an undo would leave it alone, not back in that project.
      if (current !== projectId) {
        const name = this.combinedInto(current).find((member) => member.id === projectId)?.name ?? project.name;
        throw new InboxError("already_combined", `${name} is in ${this.project(current)?.name ?? current}. Undo it first.`, { field: "project" });
      }
      record = { ...rest, merged_into: head };
    }
    this.write(join(this.projectFolder(project), PROJECT_FILE), {
      v: INBOX_RECORD_VERSION,
      seq: this.seq + 1,
      at: this.stamp(),
      kind: "project",
      id: project.id,
      record,
    });
    return this.labeled(record);
  }

  /** The projects a person sees: one for each group. */
  listProjects(): InboxProject[] {
    return this.allProjects().filter((project) => this.canonicalProjectId(project.id) === project.id);
  }

  /** Every project folder, combined ones included: what is on disk (`listProjects` is what a person sees). */
  allProjects(): InboxProject[] {
    return [...this.projectsById.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((project) => this.labeled(project));
  }

  /**
   * A thread's project as readers see it: the group's id and name, with the
   * folder it was written from. `root` stays the thread's own, because readers
   * resolve its files from there and its `origin` is that folder's.
   */
  private shownProject(projectId: string): InboxProject | null {
    const own = this.projectsById.get(projectId);
    if (!own) return null;
    const head = this.project(this.canonicalProjectId(projectId))!;
    return head.id === projectId ? head : { ...head, key: own.key, root: own.root };
  }

  project(id: string): InboxProject | null {
    const project = this.projectsById.get(id);
    return project ? this.labeled(project) : null;
  }

  projectByRoot(root: string): InboxProject | null {
    const project = this.projectsByRoot.get(root);
    return project ? this.labeled(project) : null;
  }

  message(id: string): InboxMessage | null {
    return this.messages.get(id) ?? null;
  }

  /** The seq of a message's first line. */
  messageCursor(id: string): number | null {
    return this.messageSeq.get(id) ?? null;
  }

  /** A thread's messages in seq order (a message's thread never changes, so the index only grows). */
  private threadMessages(threadId: string): InboxMessage[] {
    return (this.threadMembers.get(threadId) ?? []).map((id) => this.messages.get(id)!);
  }

  private questionRecords(messageId: string): InboxQuestionRecord[] {
    const out: InboxQuestionRecord[] = [];
    for (const id of this.messageQuestions.get(messageId) ?? []) out.push(this.questions.get(id)!);
    return out.sort((a, b) => a.position - b.position);
  }

  private isResolved(threadId: string): boolean {
    return this.messages.get(threadId)?.resolved_at != null;
  }

  /**
   * A message's questions read as closed because the person archived its
   * thread after it arrived. A message an agent sent after the archive line
   * (a reply that brings the thread back) keeps its questions live, so the
   * list places the thread by them; the thread stays resolved.
   */
  private closedByArchive(message: InboxMessage): boolean {
    const archiveSeq = this.archiveSeq(message.thread_id);
    return archiveSeq !== null && (this.messageSeq.get(message.id) ?? 0) < archiveSeq;
  }

  /** The seq of a resolved thread's archive line, or null for an open thread. */
  archiveSeq(threadId: string): number | null {
    const root = this.messages.get(threadId);
    if (!root || root.resolved_at == null) return null;
    return this.resolvedSeq.get(root.id) ?? Number.MAX_SAFE_INTEGER;
  }

  /**
   * The message is in an open thread, or arrived after its thread's archive
   * line: it behaves as an open thread's (its questions live, answerable,
   * annotatable). A message the archive closed refuses. The thread stays
   * resolved either way.
   */
  messageAnswerable(messageId: string): boolean {
    const message = this.messages.get(messageId);
    return message !== undefined && !this.closedByArchive(message);
  }

  /** The one question state for every reader: closed when the archive closed its message, else as recorded. */
  questionWire(record: InboxQuestionRecord): InboxQuestion {
    const message = this.messages.get(record.message_id);
    return toInboxQuestion(record, message ? this.closedByArchive(message) : false);
  }

  /** An agent wrote in the thread after its archive line (a reply_to reply): a reply can still come, and be answered. */
  agentAfterArchive(threadId: string): boolean {
    const archiveSeq = this.archiveSeq(threadId);
    if (archiveSeq === null) return false;
    for (const id of this.threadMembers.get(threadId) ?? []) {
      if (this.messages.get(id)?.author.kind === "agent" && (this.messageSeq.get(id) ?? 0) > archiveSeq) return true;
    }
    return false;
  }

  /**
   * The seq of a question record's latest line (`<message id>/<key>`): when
   * its pick, answer, replacement or Mark read last changed. An archive closes
   * a question without a question line; `archiveSeq` says when that happened.
   */
  questionLineSeq(questionId: string): number | null {
    return this.latest.get(`question:${questionId}`)?.seq ?? null;
  }

  questionsOf(messageId: string): InboxQuestion[] {
    const message = this.messages.get(messageId);
    if (!message) return [];
    const closed = this.closedByArchive(message);
    return this.questionRecords(messageId).map((record) => toInboxQuestion(record, closed));
  }

  private wire(message: InboxMessage): InboxMessageWire {
    const questions = this.questionsOf(message.id);
    // A subject is served as shown (displayInboxSubject), never as stored.
    const shown = message.subject ? { ...message, subject: displayInboxSubject(message.subject) } : { ...message };
    return questions.length > 0 ? { ...shown, questions } : shown;
  }

  messageWire(id: string): InboxMessageWire | null {
    const message = this.messages.get(id);
    return message ? this.wire(message) : null;
  }

  /**
   * The question a root's subject was derived from (`<message id>/<key>`), or
   * null when the agent gave the subject or it came from the body. A record
   * older than `subject_question` counts as derived when its subject is the
   * one its first question's prompt gives.
   */
  private subjectQuestion(root: InboxMessage): string | null {
    if (root.subject_question !== undefined) return root.subject_question;
    const first = this.questionRecords(root.id)[0];
    if (!first || root.subject === null) return null;
    return deriveInboxSubject("", [first]) === root.subject ? first.id : null;
  }

  /**
   * A thread's subject as the list and the thread show it: the root's, except
   * that a subject derived from a question follows that question's
   * replacement (`superseded_by` with a key), down the chain. An agent-given
   * subject never changes, and a question withdrawn with nothing in its place
   * keeps the subject it gave. Served as shown (`displayInboxSubject`: one
   * line, no leaked tool-call text), never as an older store kept it.
   */
  threadSubject(threadId: string): string | null {
    return displayInboxSubject(this.storedThreadSubject(threadId));
  }

  private storedThreadSubject(threadId: string): string | null {
    const root = this.messages.get(threadId);
    if (!root) return null;
    let id = this.subjectQuestion(root);
    if (id === null) return root.subject;
    let record = this.questions.get(id);
    const seen = new Set<string>();
    while (record?.superseded_by?.key && !seen.has(id)) {
      seen.add(id);
      const next = `${record.superseded_by.message_id}/${record.superseded_by.key}`;
      const nextRecord = this.questions.get(next);
      if (!nextRecord) break;
      id = next;
      record = nextRecord;
    }
    if (seen.size === 0 || !record) return root.subject;
    return deriveInboxSubject("", [record]) ?? root.subject;
  }

  /**
   * A thread's short name as it stands now (a name given later counts), or
   * null when it has none. Served like a subject: it goes into an agent's
   * prompt, and a name stored earlier is not checked again.
   */
  threadShortName(threadId: string): string | null {
    return displayInboxSubject(this.messages.get(threadId)?.thread_name);
  }

  /**
   * The title a person's message shows the agent it reaches, the one place
   * this is decided (#2464, approval "inbox-reply-title"): the wake's first
   * line (the bridge command's `subject`, so Codex and Qwen too). A subject
   * can carry status that goes stale, and a plain reply repeated it every
   * time, so a plain reply takes the thread's short name, or null with none
   * (the connection then says `a reply`).
   * Everything else keeps the thread's subject (`plainReplyFor` says why).
   */
  agentTitle(message: InboxMessage, session: string | null): string | null {
    return this.plainReplyFor(message, session) ? this.threadShortName(message.thread_id) : this.threadSubject(message.thread_id);
  }

  /**
   * The still-open sentences this process wrote, by reply. In memory: a reply
   * that waits through a restart keeps its sentence in the wake, as well as
   * the details line, and nothing is lost.
   */
  private readonly stillOpenWritten = new Map<string, { line: string; at: number }>();

  /**
   * What a wake's details line says about the thread `message` is in, for the
   * session it goes to (approval "inbox-wake-context"): one pass over the
   * thread's own messages, since this runs for each reply a poll hands out.
   * The counts are read_thread's. `replying_to` is the session's own message
   * the person replied to, or else answered a question on, when it is not the
   * session's latest; never on a Re-ask, which replies to nothing.
   */
  wakeContext(message: InboxMessage, session: string | null): InboxWakeContext {
    let messages = 0;
    let open_questions = 0;
    let open_actions = 0;
    let latest: InboxMessage | null = null;
    const answered = new Set<string>();
    for (const member of this.threadMessages(message.thread_id)) {
      if (!isAckNote(member)) messages += 1;
      if (session && member.author.kind === "agent" && member.author.session === session) latest = member;
      const ids = this.messageQuestions.get(member.id);
      if (!ids) continue;
      const closed = this.closedByArchive(member);
      for (const id of ids) {
        const record = this.questions.get(id)!;
        const state = inboxQuestionState(record, closed);
        if (state === "open" || state === "picked") {
          if (record.kind === "action") open_actions += 1;
          else open_questions += 1;
        }
        if (record.sent_reply_id === message.id) answered.add(member.id);
      }
    }
    const own = (id: string | null | undefined) => {
      const target = id ? this.messages.get(id) : undefined;
      return target && latest && target.id !== latest.id && target.author.kind === "agent" && target.author.session === session ? target : null;
    };
    const target = (message.reask?.length ?? 0) > 0 ? null : (own(message.reply_to) ?? (answered.size === 1 ? own([...answered][0]) : null));
    const stillOpen = this.stillOpenWritten.get(message.id);
    return {
      messages,
      open_questions,
      open_actions,
      ...(latest ? { last_agent_at: latest.created_at } : {}),
      ...(target ? { replying_to: { id: target.id, at: target.created_at, ...inboxWakeQuote(target.body, this.questionRecords(target.id)) } } : {}),
      ...(stillOpen ? { still_open_line: stillOpen.line, still_open_at: stillOpen.at } : {}),
    };
  }

  /**
   * Whether `message` reaches `session` as the person's own reply in a thread
   * that session already has. Not one: a root, or a New message to a session new to the thread (a New message to one that has it counts, Board Ask too);
   * the Inbox's own notes and a Re-ask, which are not an answer from the
   * person; and a wake that is the session's first sight of the thread
   * (tagged, added, handed the thread, a reply sent on from an ended session,
   * words moved from another session), where the subject is what places it.
   * A session added to the thread gets the person's later replies as tags too:
   * those are plain replies, only the one that added it is a first sight.
   * An action report is a reply: it reaches the agent as one, in the same words.
   */
  private plainReplyFor(message: InboxMessage, session: string | null): boolean {
    if (message.author.kind !== "person") return false;
    // A New message (the window's, or a Board card's Ask) into a thread the session already has is as plain as a reply:
    // its subject is just as stale. A session new to the thread has not seen the subject, so it keeps it.
    if (!message.reply_to && !this.newMessageInKnownThread(message)) return false;
    if (isInboxNote(message) || (message.reask?.length ?? 0) > 0) return false;
    const tag = session && !this.isOwner(message, session) ? tagOf(message, session) : null;
    if (tag) {
      if (!tag.joined) return false;
      const added = this.threadMessages(message.thread_id).find((m) => m.author.kind === "person" && tagOf(m, session!)?.joined);
      return added?.id !== message.id;
    }
    return !handoffActive(message) && !this.redirectedFrom(message) && !this.continuesThread(message);
  }

  /** A New message (no `reply_to`) to a session that already has the thread: it started or answered in it, or was sent its first message. */
  private newMessageInKnownThread(message: InboxMessage): boolean {
    const session = message.to?.session;
    if (!session || message.thread_id === message.id) return false;
    const root = this.messages.get(message.thread_id);
    if (root?.delivery?.session === session || root?.to?.session === session) return true;
    return this.threadMessages(message.thread_id).some((m) => m.id !== message.id && m.author.kind === "agent" && m.author.session === session);
  }

  /**
   * The agent that asked, when the person sent this reply to another session
   * because the session that asked had ended; else null.
   */
  redirectedFrom(reply: InboxMessage) {
    const asked = reply.to && reply.reply_to ? this.messages.get(reply.reply_to) : null;
    return asked && asked.author.kind === "agent" && asked.author.session !== reply.to!.session ? asked.author : null;
  }

  /**
   * More words in a thread the person started, handed to a session that has
   * seen nothing of it (the person moved them there): it reads the thread
   * first. The root going to that session too (not taken yet, maybe in the
   * same poll) opens the thread, so that is not this.
   */
  continuesThread(reply: InboxMessage): boolean {
    const root = this.messages.get(reply.thread_id);
    return (
      !!reply.to &&
      reply.thread_id !== reply.id &&
      !!root?.started_by_person &&
      root.delivery?.session !== reply.to.session &&
      root.to?.session !== reply.to.session &&
      !this.threadMessages(reply.thread_id).some((m) => m.author.kind === "agent" && m.author.session === reply.to!.session)
    );
  }

  /**
   * The agent sessions that may still name a thread the person started
   * (approval "inbox-agent-names-own-thread"): the session it is addressed to
   * and, once the address moved, also the first agent that replied in it.
   * Empty when the thread is not one the person started, already carries a
   * name an agent gave (`named_by`), or is unknown. A subject the person set
   * would be marked the same way and so never change.
   */
  threadNamers(threadId: string): string[] {
    const root = this.messages.get(threadId);
    // Compose's own suggestion (`named_by.kind === "auto"`) does not count: the agent still names it.
    if (!root || root.thread_id !== threadId || !root.started_by_person || (root.named_by && root.named_by.kind !== "auto") || !root.to) return [];
    const sessions = [root.to.session];
    if (this.readdressed.has(threadId)) {
      for (const member of this.threadMembers.get(threadId) ?? []) {
        const message = this.messages.get(member);
        if (message?.author.kind !== "agent" || !message.author.session) continue;
        if (!sessions.includes(message.author.session)) sessions.push(message.author.session);
        break;
      }
    }
    return sessions;
  }

  /** May this agent session name the thread now? See `threadNamers`. */
  canNameThread(threadId: string, session: string | null | undefined): boolean {
    return !!session && this.threadNamers(threadId).includes(session);
  }

  /**
   * `canNameThread` for a reply about to be written: once the address moved
   * and no agent has replied yet, this sender is about to be the first one.
   */
  private mayNameWithReply(threadId: string, session: string | null): boolean {
    if (!session) return false;
    const namers = this.threadNamers(threadId);
    if (namers.includes(session)) return true;
    if (namers.length === 0 || !this.readdressed.has(threadId)) return false;
    return !(this.threadMembers.get(threadId) ?? []).some((member) => this.messages.get(member)?.author.kind === "agent");
  }

  /**
   * Does another OPEN thread of the project already have this name? Naming a
   * thread the person started refuses such a name: a later send with it would
   * otherwise move from that thread (perhaps another session's work) into
   * this one, which is addressed to someone else.
   */
  private threadNameTaken(projectId: string, name: string, exceptRoot: string | null): boolean {
    const key = inboxThreadNameKey(name);
    // Threads the person started that still carry their compose name (an agent may have replaced a suggestion).
    const personRoots = this.projectGroup(projectId)
      .flatMap((id) => this.personNamed.get(`${id}\0${key}`) ?? [])
      .filter((rootId) => inboxThreadNameKey(this.messages.get(rootId)?.thread_name ?? "") === key);
    return [...this.rootsNamed(projectId, name), ...personRoots].some((rootId) => rootId !== exceptRoot && !this.isResolved(rootId));
  }

  thread(threadId: string): InboxThread | null {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) return null;
    const project = this.shownProject(root.project_id);
    if (!project) return null;
    return {
      thread_id: threadId,
      project,
      subject: this.threadSubject(threadId),
      thread_name: root.thread_name ?? null,
      resolved_at: root.resolved_at,
      // The note carrying a 👍 to the agent is not listed: the ack on the message it marks says it.
      messages: this.threadMessages(threadId)
        .filter((m) => !isAckNote(m))
        .map((m) => this.wire(m)),
    };
  }

  /**
   * The thread as the window reads it (`GET /api/inbox/threads/:id`): each
   * message with its `seq`, and each person reply with the number of
   * annotations it carried (`sent_annotations`). Additive to `thread()`,
   * which the MCP tools return unchanged.
   */
  windowThread(threadId: string): InboxThread | null {
    const thread = this.thread(threadId);
    if (!thread) return null;
    const carried = new Map<string, number>();
    for (const record of this.annotations.values()) {
      if (record.thread_id !== threadId || record.removed_at !== null || record.sent_reply_id === null) continue;
      carried.set(record.sent_reply_id, (carried.get(record.sent_reply_id) ?? 0) + 1);
    }
    return {
      ...thread,
      archive_seq: this.archiveSeq(threadId),
      messages: thread.messages.map((message) => {
        const seq = this.messageSeq.get(message.id);
        return {
          ...message,
          ...(seq === undefined ? {} : { seq }),
          ...(message.author.kind === "person" ? { sent_annotations: carried.get(message.id) ?? 0 } : {}),
          // When the 👍 reached the agent: its note delivered as a turn, or an agent read it.
          ...(message.ack ? { ack: { ...message.ack, delivered_at: this.ackDeliveredAt(message.ack), ...this.ackNoteWire(message.ack) } } : {}),
        };
      }),
    };
  }

  threadSummary(threadId: string): InboxThreadSummary | null {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) return null;
    // The note carrying a 👍 is not a message of the thread as the person sees it.
    const messages = this.threadMessages(threadId).filter((m) => !isAckNote(m));
    // A Tidy note never moves the row: its time and author are the message before it.
    const last = [...messages].reverse().find((m) => !m.tidy) ?? root;
    // The Inbox's own notes are not the person's reply: the last word is the last other message's.
    const lastWord = lastNonNote(messages) ?? root;
    const questions = messages.flatMap((m) => this.questionsOf(m.id));
    return {
      thread_id: threadId,
      project_id: root.project_id,
      subject: this.threadSubject(threadId),
      author: root.author,
      created_at: root.created_at,
      last_at: last.created_at,
      last_author: last.author.kind,
      message_count: messages.length,
      resolved_at: root.resolved_at,
      questions: summarizeInboxQuestions(questions),
      // A standing Mark read means nothing here waits on the person.
      waiting_on_person: root.resolved_at === null && lastWord.author.kind === "agent" && this.readAt(root, messages) === null,
    };
  }

  /** A project's threads (a combined project's, all of them), the newest activity first. */
  threadsOf(projectId: string): InboxThreadSummary[] {
    const out: InboxThreadSummary[] = [];
    for (const message of this.messages.values()) {
      if (message.thread_id !== message.id || !this.sameProject(message.project_id, projectId)) continue;
      const summary = this.threadSummary(message.id);
      if (summary) out.push(summary);
    }
    return out.sort((a, b) => b.last_at.localeCompare(a.last_at) || b.thread_id.localeCompare(a.thread_id));
  }

  /**
   * Settings → Activity: every thread's messages counted by hour over `[fromMs, toMs)`, for one project (its
   * combined projects too) or all of them (`inboxActivity`, ./activity.ts). Reads the in-memory log only: each
   * thread's message times, its name only when it has a message in the span. Writes and logs nothing.
   */
  activity(span: { fromMs: number; toMs: number; projectId: string | null }): InboxActivityModel {
    const store = this;
    function* sources(): Iterable<InboxActivitySource> {
      for (const [threadId, members] of store.threadMembers) {
        const root = store.messages.get(threadId);
        if (!root || root.thread_id !== threadId) continue;
        // Messages are in seq order, so the last one written is the newest: a thread quiet since before the span
        // is passed over without reading the rest.
        const lastId = members[members.length - 1];
        const lastAt = lastId ? Date.parse(store.messages.get(lastId)?.created_at ?? "") : NaN;
        if (!(lastAt >= span.fromMs)) continue;
        const times: number[] = [];
        for (const id of members) {
          const at = Date.parse(store.messages.get(id)?.created_at ?? "");
          if (Number.isFinite(at)) times.push(at);
        }
        yield {
          thread_id: threadId,
          project_id: root.project_id,
          name: () => store.threadShortName(threadId) ?? store.threadSubject(threadId),
          times,
        };
      }
    }
    return inboxActivity(sources(), { ...span, inProject: span.projectId === null ? undefined : (projectId) => this.sameProject(projectId, span.projectId!) });
  }

  /** One row of the list: the thread's summary, its project label and its section. */
  listRow(threadId: string): InboxListRow | null {
    const summary = this.threadSummary(threadId);
    if (!summary) return null;
    const root = this.messages.get(threadId)!;
    // A combined project's rows read the project it went into.
    const project = this.projectsById.get(this.canonicalProjectId(root.project_id));
    if (!project) return null;
    const messages = this.threadMessages(threadId);
    const seqOf = (m: InboxMessage) => this.messageSeq.get(m.id) ?? 0;
    let lastPersonSeq = 0;
    let lastAgentAt: string | null = null;
    let lastAgent: InboxMessage | null = null;
    let waitingSince: string | null = null;
    // The last message with the Inbox's notes read past: rule 7 (Sent), "came back", and the row's delivery.
    const lastReal = lastNonNote(messages) ?? root;
    // A person's item is last: its delivery reads which session asked (`inboxAskingMessage`), from the
    // question states this one pass reads anyway.
    const askingStates = lastReal.author.kind === "person" ? new Map<string, InboxQuestionState[]>() : null;
    for (const message of messages) {
      if (message.author.kind === "agent") lastAgent = message;
      // The person's reply is a look; the Inbox's own notes (Mark read's
      // set-aside note, a late Undo's reopened note) are not.
      // An action item's report (written by the Inbox after the Undo window) is not a look either.
      if (message.author.kind === "person" && !isInboxNote(message) && !isInboxActionReport(message)) lastPersonSeq = seqOf(message);
      if (message.author.kind === "agent") lastAgentAt = message.created_at;
      if (waitingSince === null || (askingStates && message.author.kind === "agent")) {
        const questions = this.questionsOf(message.id);
        if (waitingSince === null && questions.some((q) => q.state === "open" && !q.orphaned)) waitingSince = message.created_at;
        if (askingStates && message.author.kind === "agent") askingStates.set(message.id, questions.map((q) => q.state));
      }
    }
    // A reply of the person's is a look at everything before it.
    const seenSeq = Math.max(root.person_seen_seq ?? 0, lastPersonSeq);
    const unseen = messages.filter((m) => m.author.kind === "agent" && seqOf(m) > seenSeq).length;
    // A reply that tags agents is read for each recipient by its own delivery:
    // it stays Sent until every session a connection wakes has it (an agent
    // that only reads the Inbox never holds it there).
    const recipients = lastReal.author.kind === "person" && hasTags(lastReal) ? this.recipientsOf(lastReal) : null;
    const taggedChecked = (list: InboxSentRecipient[]): string | null => {
      const awaited = list.filter((r) => r.wakes || r.owner);
      // No owner and nothing that wakes (only agents that read the Inbox through MCP):
      // Sent until one of them reads the thread.
      if (awaited.length === 0) {
        const taken = (lastReal.tags ?? [])
          .map((t) => t.delivery?.at ?? t.read_at ?? null)
          .filter((at): at is string => at !== null)
          .sort();
        return taken[0] ?? null;
      }
      if (awaited.some((r) => r.delivered_at === null)) return null;
      return awaited.reduce<string | null>((latest, r) => (latest === null || r.delivered_at! > latest ? r.delivered_at : latest), null) ?? lastReal.created_at;
    };
    // Who settled it, when that was not the agent it was for: the mark's read, else its own delivery's.
    const readBy = recipients ? null : (root.agent_checked_seq ?? 0) >= seqOf(lastReal) ? root.agent_checked_by : lastReal.delivery?.read_by;
    const sent =
      lastReal.author.kind === "person"
        ? {
            at: lastReal.created_at,
            checked_at: recipients
              ? taggedChecked(recipients)
              : (root.agent_checked_seq ?? 0) >= seqOf(lastReal)
                ? (root.agent_checked_at ?? null)
                : // Its recipient's own delivery or read, when the mark waits at a reply to another session.
                  (lastReal.delivery?.at ?? null),
            wakes: this.wakesRecipient(lastReal),
            ...(recipients ? { recipients } : {}),
            ...(readBy ? { read_by: readBy } : {}),
          }
        : null;
    const participants = this.participantsOf(messages);
    const waits = summary.questions.stopped || summary.questions.holds_up.length > 0
      ? inboxRowWaits(messages.filter((m) => !isAckNote(m)).flatMap((m) => this.questionsOf(m.id)))
      : [];
    // An agent wrote after the person archived the thread (mail apps' rule):
    // it comes back to the list while something there waits (an agent
    // message after the archive the person has not looked at, a live
    // question still open or picked, or the person's reply after the archive
    // the agent has not read), and goes back to the archive on its own once
    // handled. Derived; the thread stays resolved until the person acts.
    const archiveSeq = this.archiveSeq(threadId);
    const agentAfterArchive = archiveSeq !== null && messages.some((m) => m.author.kind === "agent" && seqOf(m) > archiveSeq);
    // Mark read on a came-back thread sends it back to the archive: while
    // that read stands, the person's reply before it no longer holds it out.
    const readAt = this.readAt(root, messages);
    const replyUnread =
      readAt === null &&
      lastReal.author.kind === "person" &&
      seqOf(lastReal) > (archiveSeq ?? 0) &&
      (root.agent_checked_seq ?? 0) < seqOf(lastReal) &&
      !lastReal.delivery;
    const backFromArchive =
      agentAfterArchive &&
      (messages.some((m) => m.author.kind === "agent" && seqOf(m) > archiveSeq! && seqOf(m) > seenSeq) ||
        summary.questions.open > 0 ||
        summary.questions.picked > 0 ||
        replyUnread);
    const draft = this.replyDrafts.get(threadId) ?? null;
    // Comments waiting for a Send: on attached files, the guided review, the messages (kept per thread).
    const comments = this.unsentAnnotations.get(threadId) ?? 0;
    // Action items whose Done or Can't do it waits in the reply draft (approval "inbox-action-items-in-reply").
    let draftDone = 0;
    let draftCant = 0;
    for (const message of messages) {
      if (message.author.kind !== "agent") continue;
      for (const q of this.questionsOf(message.id)) {
        if (!inboxActionInDraft(q)) continue;
        // The agent saw it done: it counts done, whatever the person had marked (their reason still goes).
        if (q.action_result?.by === "person" && q.action_result.outcome === "cant") draftCant += 1;
        else draftDone += 1;
      }
    }
    const unsent = draft !== null || summary.questions.picked > 0 || comments > 0 || draftDone + draftCant > 0
      ? {
          reply_at: draft?.updated_at ?? null,
          picks: summary.questions.picked,
          comments,
          ...(draftDone > 0 ? { done: draftDone } : {}),
          ...(draftCant > 0 ? { cant: draftCant } : {}),
        }
      : null;
    const statesOf = (message: InboxMessage) => askingStates?.get(message.id) ?? [];
    const asking = askingStates ? inboxAskingMessage(messages, statesOf, inboxDefaultSkip(messages, statesOf)) : null;
    const delivery = this.rowDelivery(root, lastReal, asking, sent, recipients, root.resolved_at !== null && !agentAfterArchive);
    // "Session ended" on the row: the session this thread would reach, by the rule the thread's note uses (a waking
    // connection, not heard from, with the grace). A person's reply with its own `to` is not owed to that session.
    const presence = this.deliveryPresence;
    const reached = asking ?? (lastReal.author.kind === "agent" ? lastReal : null);
    const reachedSession = reached?.author.kind === "agent" ? reached.author.session : null;
    const movedAway = lastReal.author.kind === "person" && !!lastReal.to;
    const resumes = (session: string | null | undefined) => !!session && presence?.launchResumes?.(root.id, session) === true;
    const askerGone = !!presence && root.resolved_at === null && !movedAway && reached?.wakes === true && !!reachedSession && !presence.askerLive(reachedSession) && !resumes(reachedSession);
    // Each reading is about its own session: a launched one that a reply starts again has not ended, another still has.
    const undelivered = delivery?.reason === "undelivered" && !resumes(this.replyAddressee(root, lastReal)?.session);
    const sessionEnded = askerGone || undelivered;
    const facts = {
      ...summary,
      unsent,
      delivery,
      agent_after_archive: agentAfterArchive,
      back_from_archive: backFromArchive,
      read_at: readAt,
      // The 👍 on the latest agent message, while the Mark read it made still holds.
      ack: readAt !== null && lastAgent?.ack ? { label: lastAgent.ack.label, at: lastAgent.ack.at } : null,
      project: { id: project.id, name: this.labeled(project).name },
      thread_name: root.thread_name ?? null,
      answered_not_sent: (root.resolved_at === null || backFromArchive) && summary.questions.open === 0 && summary.questions.picked > 0,
      // Rule 2a: every open question is in a Re-ask note that still waits (approval "inbox-reask").
      reask_pending: (root.resolved_at === null || backFromArchive) && this.reaskWaiting(messages),
      waiting_since: waitingSince,
      unseen,
      sent,
      guide: messages.some((m) => m.guide != null),
      ...(messages.filter((m) => m.guide != null).at(-1)?.guide?.walkthrough ? { guide_walkthrough: true } : {}),
      last_agent_at: lastAgentAt,
      ...(root.started_by_person && root.to ? { addressee: { host: root.to.host, session: root.to.session } } : {}),
      ...(participants.length > 1 ? { participants } : {}),
      // What the Stopped / Holds up badge holds (approval "inbox-row-badges"): the window's hover card.
      ...(waits.length > 0 ? { waits } : {}),
    };
    // An action item's report that lands after agent news the person has not looked at: the row shows the news
    // (New), not Sent; `sent` stays on the row for its delivery tick.
    const section = inboxSectionOf(isInboxActionReport(lastReal) && unseen > 0 ? { ...facts, sent: null } : facts);
    // In New only for the person's own unsent words or comments: not bold.
    const draftOnly = section === "new" && unseen === 0 && !facts.answered_not_sent && inboxHasUnsent(unsent);
    return { ...facts, ...(sessionEnded && section !== "quiet" ? { session_ended: true } : {}), section, unread: inboxRowUnread(section, unseen, draftOnly) };
  }

  /** The live sessions the rows' delivery reads (the server's); null forgets them. */
  setDeliveryPresence(presence: InboxDeliveryPresence | null): void {
    this.changes += 1;
    this.deliveryPresence = presence;
  }

  /**
   * The live sessions as `listRows()` builds its memo: each answer is noted with the call that gave it, so the
   * memo can ask again and know the rows would come out the same (`rowsMemo`).
   */
  private recordingPresence(presence: InboxDeliveryPresence, calls: Map<string, { ask: () => unknown; answer: string }>): InboxDeliveryPresence {
    const noted = <A extends unknown[], R>(name: string, fn: ((...args: A) => R) | undefined): ((...args: A) => R) | undefined => {
      if (!fn) return undefined;
      return (...args: A): R => {
        const answer = fn(...args);
        const key = `${name}\0${args.join("\0")}`;
        if (!calls.has(key)) calls.set(key, { ask: () => fn(...args), answer: JSON.stringify(answer) ?? "undefined" });
        return answer;
      };
    };
    const bound = <A extends unknown[], R>(fn: ((...args: A) => R) | undefined) => (fn ? (...args: A) => fn.apply(presence, args) : undefined);
    calls.set("autoSendAfterMs", { ask: () => presence.autoSendAfterMs, answer: JSON.stringify(presence.autoSendAfterMs) ?? "undefined" });
    return {
      connection: noted("connection", bound(presence.connection))!,
      askerLive: noted("askerLive", bound(presence.askerLive))!,
      hostOf: noted("hostOf", bound(presence.hostOf)),
      launchResumes: noted("launchResumes", bound(presence.launchResumes)),
      uncertain: noted("uncertain", bound(presence.uncertain)),
      stuck: noted("stuck", bound(presence.stuck)),
      autoSendAfterMs: presence.autoSendAfterMs,
      waitOf: noted("waitOf", bound(presence.waitOf)),
    };
  }

  /**
   * Where a person's message is addressed: its own `to`, or in a thread the person started, that thread's. Not when it
   * answers another session that wrote in it: the reply goes to that one (the thread's rule too).
   */
  private replyAddressee(root: InboxMessage, last: InboxMessage): InboxAddressee | null {
    const startedTo = root.started_by_person && root.to ? root.to : null;
    const askedBy = last.reply_to ? this.messages.get(last.reply_to) : undefined;
    return last.to ?? (startedTo && last.reply_to && !otherSessionThan(askedBy, startedTo) ? startedTo : null);
  }

  /**
   * Where the person's latest sent item in the thread is, for its list row:
   * the same inputs, gathered the same way, as the thread's delivery line
   * (packages/inbox/components/Thread.tsx, `deliveryLine` and `ackPillLine`),
   * decided by the one rule (`inboxDeliveryState`), so a row and its thread
   * agree. Memory only: a few map lookups per row.
   */
  private rowDelivery(
    root: InboxMessage,
    lastReal: InboxMessage,
    /** The agent message whose session asked (`inboxAskingMessage`, the thread's rule), when a person's item is last. */
    asking: InboxMessage | null,
    sent: { checked_at: string | null; read_by?: string } | null,
    recipients: InboxSentRecipient[] | null,
    resolved: boolean,
  ): InboxRowDelivery | null {
    const presence = this.deliveryPresence;
    // Not read (no presence): undefined, as the thread before it reads the session.
    const connectionOf = (session: string): InboxDeliveryConnection | null | undefined => {
      if (!presence) return undefined;
      const connection = presence.connection(session);
      return connection ? { busy: connection.busy, send_now: connection.send_now, ...(connection.held ? { held: true } : {}) } : null;
    };
    const askerLive = (session: string): boolean => (presence ? presence.askerLive(session) : true);
    const uncertain = (session: string | null, itemId: string): boolean => !!session && presence?.uncertain?.(session, itemId) === true;
    const stuck = (session: string | null, itemId: string): boolean => !!session && presence?.stuck?.(session, itemId) === true;
    // How long it waited on a busy session, and whether it goes in by itself (approval "inbox-busy-agent-reply"):
    // the server's clock while it waits, the item's own record once the Inbox marked it.
    const waitOf = (item: InboxMessage, session: string | null) => {
      const clock = session ? (presence?.waitOf?.(session, item.id) ?? null) : null;
      const ack = !!item.ack_of && !INBOX_AUTO_SEND_ACK_NOTES;
      return {
        waitingSince: clock?.since ?? item.wait_started_at ?? null,
        autoSince: clock?.autoSince ?? null,
        nowBy: item.deliver_now_by ?? null,
        nowAt: item.deliver_now_at ?? null,
        intoTurn: item.delivery?.into_turn ?? null,
        autoSendAfterMs: ack ? null : (presence?.autoSendAfterMs ?? null),
      };
    };
    const waitWire = (decision: InboxDeliveryDecision) => ({
      ...(decision.wait ? { waiting_since: decision.wait.since, steerable: decision.wait.steerable, auto_send_at: decision.wait.autoSendAt } : {}),
      ...(decision.autoAfterMin !== undefined ? { auto_after_min: decision.autoAfterMin } : {}),
      ...(decision.turnEnded ? { turn_ended: true } : {}),
    });

    if (lastReal.author.kind === "person") {
      if (isInboxNote(lastReal)) return null;
      const last = lastReal;
      const startedTo = root.started_by_person && root.to ? root.to : null;
      const askedBy = last.reply_to ? this.messages.get(last.reply_to) : undefined;
      const lastTo = this.replyAddressee(root, last);
      const repliedTo = lastTo ? undefined : askedBy;
      const askedSession = repliedTo?.author.kind === "agent" && repliedTo.author.session ? repliedTo.author.session : null;
      const wakingSession = askedSession && repliedTo?.wakes === true ? askedSession : null;
      const replySession = lastTo?.session ?? askedSession;
      const replyWaiting = !!replySession && !last.delivery && !(lastTo === null && sent?.checked_at);
      const connection = replyWaiting ? connectionOf(replySession!) : undefined;
      const kind = last.reply_to ? "reply" : "message";
      if (lastTo) {
        const to = last.delivery ?? last.to ?? lastTo;
        // "Claude Code (another session)": a reply sent to another session of the asker's own host.
        const another =
          !!last.to &&
          !!last.reply_to &&
          askedBy?.author.kind === "agent" &&
          askedBy.author.host !== null &&
          askedBy.author.host === to.host &&
          askedBy.author.session !== to.session;
        const decision = inboxDeliveryState({
          delivered: !!last.delivery,
          stuck: !last.delivery && stuck(lastTo.session, last.id),
          undelivered: !last.delivery && !askerLive(lastTo.session),
          askerEnded: false,
          wakes: !uncertain(lastTo.session, last.id),
          sendingNow: !!last.deliver_now_at,
          connection,
          ...waitOf(last, lastTo.session),
        });
        return {
          kind,
          state: decision.state,
          reason: decision.reason,
          send_now: decision.sendNow,
          message_id: last.id,
          at: last.delivery?.at ?? null,
          host: to.host ?? null,
          name: null,
          ...(another ? { another_session: true } : {}),
          ...waitWire(decision),
        };
      }
      // A reply that tags agents: the owner's own delivery, never another recipient's.
      const deliveredAt = recipients
        ? (last.delivery?.at ?? recipients.find((r) => r.owner)?.delivered_at ?? null)
        : (sent?.checked_at ?? null);
      // The session that asked (the thread's own rule, with its defaults): called ended only when its message
      // came through a waking connection and the Inbox has not heard from it (with the grace).
      const askingAuthor = asking?.author.kind === "agent" ? asking.author : null;
      const askerEnded = !resolved && asking?.wakes === true && !!askingAuthor?.session && !askerLive(askingAuthor.session);
      const decision = inboxDeliveryState({
        delivered: !!deliveredAt,
        stuck: replyWaiting && stuck(replySession, last.id),
        undelivered: false,
        askerEnded,
        wakes: (wakingSession !== null || (askedSession !== null && connection != null)) && !uncertain(replySession, last.id),
        sendingNow: !!last.deliver_now_at,
        connection,
        ...waitOf(last, replySession),
      });
      // Named for the session it goes to: the thread's first agent, unless it answers another one.
      const first = root.author.kind === "agent" ? root.author : null;
      const author = repliedTo?.author.kind === "agent" && otherSessionThan(repliedTo, first ?? startedTo) ? repliedTo.author : first;
      return {
        kind,
        state: decision.state,
        reason: decision.reason,
        send_now: decision.sendNow,
        message_id: last.id,
        at: deliveredAt,
        host: author?.host ?? null,
        name: author?.name ?? null,
        ...(decision.state === "delivered" && sent?.read_by ? { read_by: sent.read_by } : {}),
        ...(decision.reason === "ended" && askingAuthor ? { asking: { host: askingAuthor.host ?? null, name: askingAuthor.name ?? null } } : {}),
        ...waitWire(decision),
      };
    }

    // 👍 Looks good on the latest agent message (the thread's `ackPillLine`): sent through, not withdrawn.
    const target = lastReal;
    const ack = target.ack;
    if (target.author.kind !== "agent" || !ack || ack.not_sent) return null;
    const base = { kind: "ack" as const, message_id: target.id, host: target.author.host ?? null, name: target.author.name ?? null, send_now: false };
    const deliveredAt = this.ackDeliveredAt(ack);
    const note = ack.note_id ? this.messages.get(ack.note_id) : undefined;
    if (deliveredAt) {
      const decision = inboxDeliveryState({ delivered: true, undelivered: false, askerEnded: false, wakes: true, sendingNow: false, connection: undefined, ...(note ? waitOf(note, target.author.session ?? null) : {}) });
      return { ...base, state: "delivered", reason: "delivered", at: deliveredAt, ...waitWire(decision) };
    }
    if (ack.settled_seq == null) return { ...base, state: "queued", reason: "ack_pending", at: null };
    if (target.wakes === true && ack.note_id) {
      const session = target.author.session;
      const decision = inboxDeliveryState({
        delivered: false,
        undelivered: false,
        askerEnded: false,
        wakes: true,
        sendingNow: !!note?.deliver_now_at,
        connection: session ? connectionOf(session) : undefined,
        ...(note ? waitOf(note, session ?? null) : {}),
      });
      // A 👍 offers no Send now of its own (it asks nothing of the agent), and waits for the turn to end (INBOX_AUTO_SEND_ACK_NOTES).
      return { ...base, state: decision.state === "sending" ? "sending" : "queued", reason: decision.reason, at: null, ...waitWire(decision) };
    }
    return { ...base, state: "saved", reason: "reads", at: null };
  }

  /**
   * The list's rows, newest activity first: every thread, or one project's
   * (`projectId`), or the threads an agent session sent any message in
   * (`session`: the threads it started, joined or replied in).
   */
  listRows(filter: { projectId?: string | null; session?: string | null } = {}): InboxListRow[] {
    if (filter.projectId || filter.session) return this.buildRows(filter);
    // Every thread: the last answer while nothing it read changed (`rowsMemo`). A copy of the list, the same rows.
    const memo = this.rowsMemo;
    if (memo && memo.changes === this.changes && memo.presence === this.deliveryPresence) {
      let same = true;
      for (const { ask, answer } of memo.calls.values()) {
        if ((JSON.stringify(ask()) ?? "undefined") !== answer) {
          same = false;
          break;
        }
      }
      if (same) return memo.rows.slice();
    }
    const presence = this.deliveryPresence;
    const calls = new Map<string, { ask: () => unknown; answer: string }>();
    const changes = this.changes;
    let rows: InboxListRow[];
    if (presence) {
      this.deliveryPresence = this.recordingPresence(presence, calls);
      try {
        rows = this.buildRows(filter);
      } finally {
        this.deliveryPresence = presence;
      }
    } else {
      rows = this.buildRows(filter);
    }
    this.rowsMemo = { changes, presence, calls, rows };
    return rows.slice();
  }

  /** `listRows` built from the store, every row worked out again. */
  private buildRows(filter: { projectId?: string | null; session?: string | null }): InboxListRow[] {
    const out: InboxListRow[] = [];
    for (const [threadId, members] of this.threadMembers) {
      const root = this.messages.get(threadId);
      if (!root || root.thread_id !== threadId) continue;
      if (filter.projectId && !this.sameProject(root.project_id, filter.projectId)) continue;
      if (filter.session) {
        const session = filter.session;
        const took = members.some((id) => {
          const author = this.messages.get(id)?.author;
          return author?.kind === "agent" && author.session === session;
        });
        if (!took) continue;
      }
      const row = this.listRow(threadId);
      if (row) out.push(row);
    }
    return out.sort((a, b) => b.last_at.localeCompare(a.last_at) || b.thread_id.localeCompare(a.thread_id));
  }

  /**
   * The rows of the threads that may hold unsent work, for the Drafts read:
   * the rows `listRows()` gives whose `unsent` is set, and maybe a few more
   * (the caller filters on `unsent` as before). Only these rows are built, not
   * the whole list. A row's `unsent` comes from four places (`listRow`): its
   * reply draft, its comments waiting for a Send, a picked question, and an
   * action item whose result waits in the draft. A question counts here when
   * it holds an answer or an action result not sent yet, which every picked
   * question and every action item in the draft does.
   */
  unsentRows(): InboxListRow[] {
    const threads = new Set<string>([...this.replyDrafts.keys(), ...this.unsentAnnotations.keys()]);
    for (const record of this.questions.values()) {
      if (record.answer === null && record.action_result == null) continue;
      if (record.revision > 0 && record.sent_revision === record.revision) continue;
      const threadId = this.messages.get(record.message_id)?.thread_id;
      if (threadId) threads.add(threadId);
    }
    const out: InboxListRow[] = [];
    for (const threadId of threads) {
      const row = this.listRow(threadId);
      if (row) out.push(row);
    }
    return out;
  }

  /**
   * Decision mode's projection (approval "inbox-decision-mode", brief §10):
   * every question and action item that waits on the person (core's
   * `inboxQuestionWaitsOnPerson`) in a live agent message, across threads, in
   * queue order. What a waiting Re-ask note lists is left out, since the
   * agent is about to ask it again (per note, so a thread where one session
   * was asked to re-ask still shows another session's questions); a thread
   * whose every open question is listed (the list puts it in Sent) shows
   * nothing. Read only; no record.
   */
  openDecisions(filter: { projectId?: string | null } = {}): InboxDecision[] {
    const candidates: InboxDecisionCandidate[] = [];
    for (const [threadId] of this.threadMembers) {
      const root = this.messages.get(threadId);
      if (!root || root.thread_id !== threadId) continue;
      if (filter.projectId && !this.sameProject(root.project_id, filter.projectId)) continue;
      const waiting: { message: InboxMessage; question: InboxQuestion }[] = [];
      // What a waiting Re-ask note lists is about to be asked again: left out, per note (so per session).
      const reasked = this.reaskListedIds(threadId);
      for (const message of this.threadMessages(threadId)) {
        if (message.author.kind !== "agent" || this.closedByArchive(message)) continue;
        for (const question of this.questionsOf(message.id)) {
          // A listed question the person picked since still waits for their Send (as the list's rule 2a reads it).
          const reask = question.state === "open" && reasked.has(`${message.id}/${question.key}`);
          if (inboxQuestionWaitsOnPerson(question) && !reask) waiting.push({ message, question });
        }
      }
      if (waiting.length === 0) continue;
      const row = this.listRow(threadId);
      if (!row) continue;
      for (const { message, question } of waiting) {
        const author = message.author as Extract<InboxAuthor, { kind: "agent" }>;
        const inBlock = (ref: string) =>
          [question.context ?? "", ...question.choices.flatMap((c) => [c.label, c.description ?? ""])].some((text) => text.includes(ref));
        const images = [...(message.inline_images ?? [])].sort((a, b) => Number(inBlock(b.ref)) - Number(inBlock(a.ref)));
        candidates.push({
          seq: this.messageSeq.get(message.id) ?? 0,
          decision: {
            id: `${message.id}/${question.key}`,
            question,
            message: { id: message.id, created_at: message.created_at, author: message.author, excerpt: inboxDecisionExcerpt(message.body) },
            pictures: {
              inline: images.map((image) => ({
                attachment_id: image.id,
                ref: image.ref,
                name: image.name,
                media_type: image.media_type ?? null,
                width: image.width ?? null,
                height: image.height ?? null,
              })),
              attachments: (message.attachments ?? []).map((file) => ({
                attachment_id: file.id,
                name: file.name,
                kind: file.kind,
                size: file.size,
                media_type: file.media_type ?? null,
                paths: [file.path, ...(file.named_path ? [file.named_path] : [])],
              })),
            },
            thread: { id: threadId, subject: row.subject, thread_name: row.thread_name, project: row.project, section: row.section },
            session: {
              key: author.session ? `s:${author.host ?? ""}\u0000${author.session}` : `m:${message.id}`,
              host: author.host,
              session: author.session,
              name: author.name,
              wakes: message.wakes === true,
            },
          },
        });
      }
    }
    return orderInboxDecisions(candidates);
  }

  /** The list, placed in its sections; a project filter keeps the sections and drops other rows. */
  listSections(projectId?: string | null): InboxListSection[] {
    return inboxListSections(this.listRows({ projectId }));
  }

  /**
   * When the person marked the thread read, while that still holds: the
   * thread is open, and no message came after the Mark read except a
   * set-aside note it sent. Null otherwise. Derived, so an agent's next
   * message (or the person's reply) ends it without a write.
   */
  private readAt(root: InboxMessage, messages: readonly InboxMessage[] = this.threadMessages(root.id)): string | null {
    const readSeq = root.person_read_seq;
    if (readSeq == null) return null;
    // On an archived thread only a Mark read after the archive line counts (a thread that came back).
    const archiveSeq = this.archiveSeq(root.id);
    if (archiveSeq !== null && readSeq <= archiveSeq) return null;
    for (const message of messages) {
      if ((message.set_aside || isAckNote(message)) && message.author.kind === "person") continue;
      if ((this.messageSeq.get(message.id) ?? 0) > readSeq) return null;
    }
    return root.person_read_at ?? null;
  }

  /**
   * Mark read (`read`), or move it back (Undo, the pressed button). Mark read
   * moves the thread to Quiet without archiving it: every question still
   * waiting on the person (open, or picked and not sent) is closed as a skip
   * (`set_aside`), and the thread counts as looked at. It
   * comes back when an agent writes again. Moving back reopens the questions
   * that Mark read closed (not an earlier one's) exactly as they were, a
   * saved pick included (its revision goes up by one, so a pick in flight is
   * refused rather than lost). No write when nothing changes. An archived
   * thread refuses.
   */
  markRead(threadId: string, read: boolean): InboxListRow {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    // An archived thread refuses, except for what an agent wrote after the
    // archive line (a thread that came back): Mark read handles that part,
    // and the thread goes back to the archive.
    if (root.resolved_at !== null && !this.agentAfterArchive(threadId)) {
      throw new InboxError("thread_resolved", "This thread is archived; unarchive it first.");
    }
    const members = this.threadMessages(threadId);
    const records = members.filter((m) => m.author.kind === "agent" && !this.closedByArchive(m)).flatMap((m) => this.questionRecords(m.id));
    if (read) {
      const waiting = records.filter((r) => {
        const state = inboxQuestionState(r, false);
        // An action item the person marked (in their reply draft, or its Undo window running) is theirs: Mark read leaves it.
        return state === "open" || (state === "picked" && r.kind !== "action");
      });
      let latestAgent = 0;
      for (const m of members) if (m.author.kind === "agent") latestAgent = Math.max(latestAgent, this.messageSeq.get(m.id) ?? 0);
      if (this.readAt(root, members) === null || waiting.length > 0) {
        const at = this.stamp();
        // This Mark read's identity: the seq of its root line, kept on each
        // question it closes, so its Undo reopens exactly those.
        const readSeq = this.seq + 1;
        this.appendMessage(
          {
            ...root,
            person_read_seq: readSeq,
            person_read_at: at,
            person_seen_seq: Math.max(root.person_seen_seq ?? 0, latestAgent),
            // The look before, so an Undo puts unseen news back as it was.
            person_seen_before_read: root.person_seen_seq ?? null,
          },
          at,
        );
        for (const record of waiting) {
          this.appendQuestion(
            {
              ...record,
              // An action item keeps no answer: set aside is its whole state.
              answer: record.kind === "action" ? null : inboxSkipAnswer({ key: record.key, kind: record.kind, prompt: record.prompt }, { byReply: false }),
              revision: record.revision + 1,
              set_aside: {
                at,
                read_seq: readSeq,
                previous: {
                  answer: record.answer,
                  revision: record.revision,
                  sent_revision: record.sent_revision,
                  picked_by: record.picked_by,
                  picked_at: record.picked_at,
                  ...(record.kind === "action" ? { action_result: record.action_result ?? null } : {}),
                },
              },
            },
            at,
          );
        }
      } else if ((root.person_seen_seq ?? 0) < latestAgent) {
        // Mark unread took the look back and the Mark read still stands: give the look back. A new Mark read
        // here would lose the questions the standing one closed, which Move back reopens by its seq.
        this.appendMessage({ ...root, person_seen_seq: latestAgent }, this.stamp());
      }
    } else {
      // Undo reopens only what its own Mark read closed (owner ruling
      // 2026-10-12): a question an earlier Mark read set aside, and told the
      // agent about, stays closed. With no Mark read on the root there is
      // nothing to undo.
      const closed = records.filter((r) => this.closedByThisRead(r, root));
      if (root.person_read_seq != null || closed.length > 0) {
        const at = this.stamp();
        // Move back withdraws a 👍 standing on this Mark read too, so the agent never sees a 👍
        // on a thread the person moved back to the top.
        // A delivered one stays: the agent has it, and the message takes no second one.
        for (const message of members) {
          if (message.author.kind === "agent" && message.ack && root.person_read_seq != null && message.ack.read_seq === root.person_read_seq && this.ackDeliveredAt(message.ack) === null) {
            this.appendMessage({ ...message, ack: null }, at);
          }
        }
        if (root.person_read_seq != null) {
          // While the read still holds (no message since), the look it counted
          // is taken back too, so news it hid is news again.
          const restoreLook = this.readAt(root, members) !== null && root.person_seen_before_read !== undefined;
          this.appendMessage(
            {
              // Read again: in a one-message thread the root is the agent message whose ack was just withdrawn.
              ...this.messages.get(threadId)!,
              person_read_seq: null,
              person_read_at: null,
              ...(restoreLook ? { person_seen_seq: root.person_seen_before_read } : {}),
              person_seen_before_read: undefined,
            },
            at,
          );
        }
        for (const record of closed) {
          const previous = record.set_aside!.previous;
          this.appendQuestion(
            {
              ...record,
              answer: previous.answer,
              revision: record.revision + 1,
              sent_revision: previous.sent_revision,
              picked_by: previous.picked_by,
              picked_at: previous.picked_at,
              ...(record.kind === "action" ? { action_result: previous.action_result ?? null } : {}),
              set_aside: null,
            },
            at,
          );
        }
        // The agent was already told not to wait on some of these: tell it
        // they are open again, one note per asking message, so it does not
        // go on believing it need not wait.
        const told = this.toldSetAside(members);
        const byMessage = new Map<string, InboxQuestionRecord[]>();
        for (const record of closed) {
          if (!told.has(record.id) || record.superseded_by) continue;
          const list = byMessage.get(record.message_id) ?? [];
          list.push(record);
          byMessage.set(record.message_id, list);
        }
        for (const message of members) {
          const reopened = byMessage.get(message.id);
          if (!reopened) continue;
          this.appendMessage(
            {
              id: inboxId("msg"),
              project_id: message.project_id,
              thread_id: message.thread_id,
              reply_to: message.id,
              author: { kind: "person" },
              subject: null,
              body: composeInboxReopenedBody(reopened),
              created_at: at,
              resolved_at: null,
              idempotency_key: null,
              reopened: reopened.map((r) => r.id),
            },
            at,
          );
        }
      }
    }
    if (read) this.endSnooze(threadId);
    const row = this.listRow(threadId);
    if (!row) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    return row;
  }

  /**
   * Mark unread (the owner's ask, 2026-10-31: "I need a way to mark a
   * message unread"): the thread's latest agent message counts as not looked
   * at again, so the row is New and bold, as if the person had not opened
   * it. Only the look moves, and nothing is sent to any agent. A Mark read
   * that stands is left alone: the questions it set aside stay closed (the
   * agent is told about them as before), Move back, `markRead(id, false)`,
   * still reopens them, and the next look puts the row back as read.
   *
   * `wrote` is false when there was nothing to make unread: no agent message,
   * the person's own reply after the latest one (a reply is a look), or the
   * latest one already new. `through_seq` is that latest agent message: a look
   * capped there (`markSeen(id, through_seq)`) is the exact Undo, since it
   * puts this look back and covers nothing that arrived since. Every archived
   * thread refuses, one that came back too: its Mark read sends it to the
   * archive, and the window offers Mark unread on none of them.
   */
  markUnread(threadId: string): { thread: InboxListRow; wrote: boolean; through_seq: number } {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    if (root.resolved_at !== null) throw new InboxError("thread_resolved", "This thread is archived; unarchive it first.");
    const members = this.threadMessages(threadId);
    let latestAgent = 0;
    let lastPerson = 0;
    for (const message of members) {
      const seq = this.messageSeq.get(message.id) ?? 0;
      if (message.author.kind === "agent") latestAgent = Math.max(latestAgent, seq);
      else if (!isInboxNote(message) && !isInboxActionReport(message)) lastPerson = Math.max(lastPerson, seq);
    }
    const wrote = latestAgent > 0 && lastPerson < latestAgent && (root.person_seen_seq ?? 0) >= latestAgent;
    // Every agent message but the latest stays looked at.
    if (wrote) this.appendMessage({ ...root, person_seen_seq: latestAgent - 1 }, this.stamp());
    const row = this.listRow(threadId);
    if (!row) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    return { thread: row, wrote, through_seq: latestAgent };
  }

  /**
   * The root's current Mark read closed this question: its `set_aside`
   * names that Mark read (`read_seq`), or, on a record older than the field,
   * was written at that Mark read's `person_read_at` (the same stamp).
   */
  private closedByThisRead(record: InboxQuestionRecord, root: InboxMessage): boolean {
    const setAside = record.set_aside;
    if (!setAside || root.person_read_seq == null) return false;
    if (setAside.read_seq !== undefined) return setAside.read_seq === root.person_read_seq;
    return root.person_read_at != null && setAside.at === root.person_read_at;
  }

  /**
   * The questions a set-aside note has told the agent not to wait on, and no
   * later reopened note has taken back (thread order decides).
   */
  private toldSetAside(members: readonly InboxMessage[]): Set<string> {
    const told = new Set<string>();
    for (const message of members) {
      if (message.author.kind !== "person") continue;
      for (const id of message.set_aside ?? []) told.add(id);
      for (const id of message.reopened ?? []) told.delete(id);
    }
    return told;
  }

  /**
   * The questions a Mark read closed that no set-aside note has named yet,
   * closed at least `afterMs` ago and not replaced since, grouped by the
   * message that asked them (thread order).
   */
  private untoldSetAside(threadId: string, afterMs: number): { message: InboxMessage; records: InboxQuestionRecord[] }[] {
    const members = this.threadMessages(threadId);
    const told = this.toldSetAside(members);
    const now = this.now().getTime();
    const out: { message: InboxMessage; records: InboxQuestionRecord[] }[] = [];
    for (const message of members) {
      if (message.author.kind !== "agent" || this.closedByArchive(message)) continue;
      const records = this.questionRecords(message.id).filter(
        (r) => r.set_aside && !r.superseded_by && !told.has(r.id) && Date.parse(r.set_aside.at) + afterMs <= now,
      );
      if (records.length > 0) out.push({ message, records });
    }
    return out;
  }

  /**
   * Tell the agents what a Mark read closed (approval 2026-10-11, "tells the
   * asking agent once"): once the Undo window (`afterMs`) has passed and the
   * questions are still closed, one person note per asking message, a reply
   * to it ("Set aside for now; don't wait on these:" and the questions),
   * delivered like any reply (the wake). Each question is
   * named once, across Mark reads. Returns the notes written.
   */
  tellSetAside(threadId: string, afterMs: number): InboxMessage[] {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) return [];
    const notes: InboxMessage[] = [];
    for (const { message, records } of this.untoldSetAside(threadId, afterMs)) {
      const at = this.stamp();
      const note: InboxMessage = {
        id: inboxId("msg"),
        project_id: message.project_id,
        thread_id: message.thread_id,
        reply_to: message.id,
        author: { kind: "person" },
        subject: null,
        body: composeInboxSetAsideBody(records),
        created_at: at,
        resolved_at: null,
        idempotency_key: null,
        set_aside: records.map((r) => r.id),
      };
      this.appendMessage(note, at);
      notes.push(note);
    }
    return notes;
  }

  /** The open threads with a set-aside note due (a question a Mark read closed at least `afterMs` ago, not yet named). */
  setAsideDue(afterMs: number): string[] {
    const out: string[] = [];
    for (const threadId of this.threadMembers.keys()) {
      const root = this.messages.get(threadId);
      if (!root || root.thread_id !== threadId) continue;
      if (this.untoldSetAside(threadId, afterMs).length > 0) out.push(threadId);
    }
    return out;
  }

  /**
   * 👍 Looks good (design record "inbox-acknowledge", approved 2026-10-15,
   * amended 2026-10-16), or take it back (`on: false`: the toast's Undo, the
   * pressed button). It records `ack` on the agent's latest message and marks
   * the thread read (Quiet until an agent writes again); once the Undo window
   * passes, `settleAcks` sends it to the agent. Taking it back removes the ack
   * and undoes the Mark read it made, and a note not delivered yet is then
   * never delivered. Refused on a person's message, on a message that is not the
   * thread's latest agent message (a newer one arrived), while a question in
   * the thread is open or picked, and on an archived thread. No write when
   * nothing changes.
   *
   * `reaction` (approval "inbox-reaction-tray"): the emoji the person picked
   * in the 👍's tray, kept on the ack; undefined keeps an ack's reaction as it
   * is, null makes it 👍 Looks good again. Picking another emoji on a message
   * already marked, inside its Undo window, changes only the emoji: the ack
   * and its window stay, and the note carries the one it has when the window
   * closes. Once sent it never changes (owner, 2026-11-07: "Reaction should go
   * away after sending and only come back when I can send a new one"): another
   * emoji after the window closed is `409 ack_sent`, and so is taking back one
   * that was delivered (Move back leaves a delivered one standing too). The
   * message takes no second one; the agent's next message takes a new one.
   */
  ackMessage(messageId: string, on: boolean, reaction?: InboxReaction | null): { message: InboxMessageWire; thread: InboxListRow } {
    const message = this.messages.get(messageId);
    if (!message) throw new InboxError("message_not_found", `No message ${messageId}.`);
    const threadId = message.thread_id;
    const root = this.messages.get(threadId)!;
    if (on) {
      if (message.author.kind !== "agent") throw new InboxError("ack_not_allowed", "Only an agent's message takes 👍 Looks good.");
      if (root.resolved_at !== null) throw new InboxError("thread_resolved", "This thread is archived; unarchive it first.");
      const members = this.threadMessages(threadId);
      const latest = [...members].reverse().find((m) => m.author.kind === "agent");
      if (latest?.id !== message.id) {
        throw new InboxError("ack_stale", "A newer message arrived in this thread; read it first.", { latest: latest?.id ?? null });
      }
      // The person already wrote back (their reply, a New message): that reply is the answer, and
      // a 👍 would hide its Sent / Delivered state. The Inbox's own notes do not count.
      const after = members.slice(members.findIndex((m) => m.id === message.id) + 1);
      if (after.some((m) => m.author.kind === "person" && !isInboxNote(m))) {
        throw new InboxError("ack_after_reply", "You already replied in this thread after this message.");
      }
      const open = members
        .filter((m) => m.author.kind === "agent")
        .flatMap((m) => this.questionRecords(m.id))
        .filter((r) => {
          const state = inboxQuestionState(r, false);
          return state === "open" || state === "picked";
        });
      if (open.length > 0) throw new InboxError("question_open", "A question here waits on you: answer it, or Mark read.");
      if (!message.ack) {
        const readBefore = root.person_read_seq ?? null;
        this.markRead(threadId, true);
        const readSeq = this.messages.get(threadId)!.person_read_seq ?? null;
        const at = this.stamp();
        const ack: InboxAck = {
          label: INBOX_ACK_LABEL,
          at,
          read_seq: readSeq,
          made_read: readSeq !== readBefore,
          settled_seq: null,
          settled_at: null,
          seen_at: null,
          ...(reaction ? { reaction } : {}),
        };
        this.appendMessage({ ...this.messages.get(messageId)!, ack }, at);
      } else if (reaction !== undefined && !sameReaction(message.ack.reaction ?? null, reaction)) {
        // Sent (its Undo window closed): a reaction never changes after that (owner, 2026-11-07).
        if (message.ack.settled_seq != null) throw new InboxError("ack_sent", "This reaction was sent already; it can't be changed.");
        // Another emoji on a message already marked, inside its Undo window: only the emoji changes.
        const at = this.stamp();
        const { reaction: _was, ...rest } = message.ack;
        this.appendMessage({ ...message, ack: reaction ? { ...rest, reaction } : rest }, at);
      }
    } else if (message.ack) {
      const ack = message.ack;
      // Delivered (its note reached the session, or an agent read it): it stays, so the message never takes a second one.
      if (this.ackDeliveredAt(ack) !== null) throw new InboxError("ack_sent", "This reaction was sent already; it can't be taken back.");
      const at = this.stamp();
      this.appendMessage({ ...message, ack: null }, at);
      const current = this.messages.get(threadId)!;
      // Undo the Mark read this ack made (not an earlier one it stood on), while it is still the thread's.
      if (ack.made_read && ack.read_seq != null && current.person_read_seq === ack.read_seq && current.resolved_at === null) this.markRead(threadId, false);
    }
    const row = this.listRow(threadId);
    if (!row) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    return { message: this.wire(this.messages.get(messageId)!), thread: row };
  }

  /**
   * Acks whose Undo window (`afterMs`) has passed while they still stand
   * are sent to the agent (amended 2026-10-16: "send looks good through"):
   * first the ack's line with `settled_seq` (the seq of that line) and
   * `note_id`, then the note it names, a person's reply to the message whose
   * body is `inboxAckLine` (`ack_of`; with the tray reaction the ack has now,
   * also kept as `ack_reaction`), delivered like any reply (the wake).
   * The note's line is the one a held
   * bridge poll wakes on. From then on agents see it in read_thread too.
   * `ackMessage`'s conditions are checked again here: when the person wrote
   * back after the message inside the window, or the agent wrote again, the
   * ack settles with `not_sent` (`replied` / `wrote_again`) and no note, and
   * no agent ever sees it. Returns the messages settled.
   */
  settleAcks(afterMs: number): InboxMessage[] {
    const now = this.now().getTime();
    const out: InboxMessage[] = [];
    for (const message of [...this.messages.values()]) {
      const ack = message.ack;
      if (!ack || ack.settled_seq != null || Date.parse(ack.at) + afterMs > now) continue;
      const notSent = this.ackNotSentReason(message);
      if (notSent) {
        const at = this.stamp();
        const settled: InboxMessage = { ...message, ack: { ...ack, settled_seq: this.seq + 1, settled_at: at, note_id: null, not_sent: notSent } };
        this.appendMessage(settled, at);
        out.push(settled);
        continue;
      }
      const noteId = inboxId("msg");
      const at = this.stamp();
      const settled: InboxMessage = { ...message, ack: { ...ack, settled_seq: this.seq + 1, settled_at: at, note_id: noteId } };
      this.appendMessage(settled, at);
      const noteAt = this.stamp();
      const note: InboxMessage = {
        id: noteId,
        project_id: message.project_id,
        thread_id: message.thread_id,
        reply_to: message.id,
        author: { kind: "person" },
        subject: null,
        body: inboxAckLine(message.id, ack.reaction),
        created_at: noteAt,
        resolved_at: null,
        idempotency_key: null,
        ack_of: message.id,
        ...(ack.reaction ? { ack_reaction: ack.reaction } : {}),
      };
      this.appendMessage(note, noteAt);
      out.push(settled);
    }
    return out;
  }

  /**
   * Why a 👍 can no longer go to the agent when its Undo window ends
   * (`ackMessage`'s rules, again): the agent wrote again after the message
   * (the 👍 would read as the answer to the newer one), or the person wrote
   * back after it (their reply is the answer). The Inbox's own notes do not
   * count. Null when it can go.
   */
  private ackNotSentReason(message: InboxMessage): "replied" | "wrote_again" | null {
    const members = this.threadMessages(message.thread_id);
    const after = members.slice(members.findIndex((m) => m.id === message.id) + 1);
    if (after.some((m) => m.author.kind === "agent")) return "wrote_again";
    if (after.some((m) => m.author.kind === "person" && !isInboxNote(m))) return "replied";
    return null;
  }

  /**
   * Whether the note carrying a 👍 still stands for it: the message it marks
   * still carries that ack. A 👍 taken back (Undo, the pressed button, Move
   * back) leaves its note in the log, never delivered.
   */
  private ackNoteLive(note: InboxMessage): boolean {
    return !!note.ack_of && this.messages.get(note.ack_of)?.ack?.note_id === note.id;
  }

  /** When a 👍 reached the agent: its note delivered as a turn, else when an agent read it; null while it waits. */
  private ackDeliveredAt(ack: InboxAck): string | null {
    const note = ack.note_id ? this.messages.get(ack.note_id) : undefined;
    return note?.delivery?.at ?? ack.seen_at ?? null;
  }

  /** The window's view of a 👍's note: when it was written, and whether it was asked to go now (and by whom). */
  private ackNoteWire(ack: InboxAck): {
    note_at?: string;
    deliver_now_at?: string | null;
    deliver_now_by?: InboxDeliverNowBy | null;
    wait_started_at?: string | null;
    delivered_into_turn?: boolean | null;
  } {
    const note = ack.note_id ? this.messages.get(ack.note_id) : undefined;
    if (!note) return {};
    return {
      note_at: note.created_at,
      deliver_now_at: note.deliver_now_at ?? null,
      deliver_now_by: note.deliver_now_by ?? null,
      wait_started_at: note.wait_started_at ?? null,
      delivered_into_turn: note.delivery?.into_turn ?? null,
    };
  }

  /**
   * The person's Done or Can't do it on an action item, or taking it back
   * (`outcome: null`). Recorded at once.
   *
   * `staged: true` (the window; approval "inbox-action-items-in-reply"): the
   * mark waits in the person's reply draft, like a pick, and goes with their
   * next Send (`sendReply`'s `actions`); no timer. Marking it again changes the
   * outcome or the note (the time it was first marked stays); `null` takes it
   * out of the draft. Once the agent saw the item done itself (its `done`),
   * the person's staged mark is kept under `action_result.person` and its
   * note can still be changed or taken back until it is sent.
   *
   * Without `staged` (decision mode, the phone door, an older window;
   * approval "inbox-next-actions"): sent by `settleActions` once the Undo
   * window passes; `null` inside the window is the Undo, and a second mark
   * starts the window again.
   *
   * `note_only: true` (a note typed under the marked row): it changes the
   * note of a mark that still waits and never marks an item again: on an
   * item taken back meanwhile it changes nothing, so a late note save never
   * puts back a mark the person took out of their draft.
   *
   * Refused once sent (`action_already_sent`), on an action item that is
   * closed, replaced or that the agent saw done with nothing of the person's
   * waiting (`action_closed`), on a question (`validation_error`), and on a
   * message the archive closed.
   */
  markAction(messageId: string, key: string, input: { outcome?: unknown; note?: unknown; staged?: unknown; note_only?: unknown }): InboxQuestion[] {
    const message = this.targetMessage(messageId);
    const record = this.questionRecords(message.id).find((r) => r.key === key);
    if (!record) throw new InboxError("question_not_found", `No action item ${key} on message ${message.id}.`, { key, message_id: message.id });
    if (record.kind !== "action") throw new InboxError("validation_error", `${key} is a question, not an action item; answer it on its card.`, { field: "key", key });
    if (input.staged !== undefined && input.staged !== null && typeof input.staged !== "boolean") {
      throw new InboxError("validation_error", "staged: a boolean.", { field: "staged" });
    }
    if (input.note_only !== undefined && input.note_only !== null && typeof input.note_only !== "boolean") {
      throw new InboxError("validation_error", "note_only: a boolean.", { field: "note_only" });
    }
    const staged = input.staged === true;
    const checked = checkInboxActionResult(input);
    if (!checked.ok) throw new InboxError("validation_error", checked.message, { field: checked.field });
    const state = inboxQuestionState(record, false);
    const result = record.action_result ?? null;
    // The agent saw it done while the person's mark waited in their draft: only that mark's note is still theirs to change.
    if (result?.by === "agent" && state === "closed" && !record.set_aside && !record.superseded_by && result.person && (staged || checked.outcome === null)) {
      if (record.revision > 0 && record.sent_revision === record.revision) throw new InboxError("action_already_sent", `Action item ${key} was already sent to the agent.`, { key });
      const at = this.stamp();
      const person = checked.outcome === null ? null : { outcome: checked.outcome, note: checked.note, at: result.person.at };
      this.appendQuestion({ ...record, action_result: { ...result, person }, revision: record.revision + 1 }, at);
      return this.questionsOf(messageId);
    }
    if (state === "sent") throw new InboxError("action_already_sent", `Action item ${key} was already sent to the agent.`, { key });
    // A note save that lands after the mark was taken back (two requests, unordered): the take-back wins.
    if (input.note_only === true && state === "open") return this.questionsOf(messageId);
    if (state !== "open" && state !== "picked") throw new InboxError("action_closed", `Action item ${key} is ${state}: it can no longer be marked.`, { key, state });
    if (checked.outcome === null) {
      // Taken back (out of the draft, or inside the Undo window): nothing was sent. Nothing to take back on an open action item.
      if (state === "open") return this.questionsOf(messageId);
      const at = this.stamp();
      this.appendQuestion({ ...record, action_result: null, revision: record.revision + 1, picked_by: null, picked_at: null }, at);
      return this.questionsOf(messageId);
    }
    const at = this.stamp();
    // A staged mark changed (its note, or Done to Can't do it) keeps the time it was first marked.
    const keepAt = staged && result?.by === "person" && result.staged === true && state === "picked";
    this.appendQuestion(
      {
        ...record,
        action_result: {
          outcome: checked.outcome,
          note: checked.note,
          at: keepAt ? result!.at : at,
          by: "person",
          ...(staged ? { staged: true } : {}),
        },
        revision: record.revision + 1,
        picked_by: INBOX_PERSON,
        picked_at: keepAt ? (record.picked_at ?? at) : at,
      },
      at,
    );
    return this.questionsOf(messageId);
  }

  /**
   * The action items the person marked and that are not sent yet, grouped by the
   * message that asked (in log order), for each message whose marked action items
   * are ALL past their Undo window (`afterMs`): two Done clicks seconds apart
   * on one message go together in one reply, once the later one's window
   * passed. A message the archive closed waits (archive holds a pending Done
   * back; Unarchive sends it).
   */
  private actionsDue(afterMs: number): { message: InboxMessage; records: InboxQuestionRecord[] }[] {
    const now = this.now().getTime();
    const byMessage = new Map<string, InboxQuestionRecord[]>();
    for (const record of this.questions.values()) {
      if (record.kind !== "action" || record.action_result?.by !== "person") continue;
      // A staged mark goes with the person's Send, never on the timer (approval "inbox-action-items-in-reply").
      if (record.action_result.staged) continue;
      if (inboxQuestionState(record, false) !== "picked") continue;
      byMessage.set(record.message_id, [...(byMessage.get(record.message_id) ?? []), record]);
    }
    const out: { message: InboxMessage; records: InboxQuestionRecord[] }[] = [];
    for (const [id, records] of byMessage) {
      const message = this.messages.get(id);
      if (!message || this.closedByArchive(message)) continue;
      if (records.some((r) => Date.parse(r.action_result!.at) + afterMs > now)) continue;
      out.push({ message, records });
    }
    return out.sort((a, b) => (this.messageSeq.get(a.message.id) ?? 0) - (this.messageSeq.get(b.message.id) ?? 0));
  }

  /** How many marked action items wait for their Undo window to pass (the server's timer). */
  actionsPending(): number {
    let count = 0;
    for (const record of this.questions.values()) {
      if (record.kind === "action" && record.action_result?.by === "person" && !record.action_result.staged && inboxQuestionState(record, false) === "picked") count++;
    }
    return count;
  }

  /**
   * Send what the person marked once the Undo window passed: one reply per
   * asking message ("Did 1 action item." and the "Action items you asked for"
   * section), the person's reply like any Send's (delivered by the reply
   * machinery: the wake, Send now), the action items marked sent
   * with it first. Returns the replies written.
   */
  settleActions(afterMs: number): InboxMessage[] {
    const out: InboxMessage[] = [];
    for (const { message, records } of this.actionsDue(afterMs)) {
      const replyId = inboxId("msg");
      const at = this.stamp();
      const sent = records.map((record) => ({ ...record, sent_revision: record.revision, sent_reply_id: replyId }) satisfies InboxQuestionRecord);
      const all = this.questionRecords(message.id).filter((r) => r.kind === "action");
      // What of that message still waits on the person, named on the report's last line (#2059).
      const closed = this.closedByArchive(message);
      const stillOpen = this.questionRecords(message.id)
        .filter((r) => !sent.some((x) => x.id === r.id))
        .filter((r) => {
          const state = inboxQuestionState(r, closed);
          return state === "open" || (r.kind !== "action" && state === "picked");
        })
        .map((r) => ({ kind: r.kind === "action" ? ("action" as const) : ("question" as const), position: r.position, prompt: r.prompt }));
      const body = composeInboxActionsReply({ reported: sent, all: all.map((r) => sent.find((x) => x.id === r.id) ?? r), stillOpen });
      const reply: InboxMessage = {
        id: replyId,
        project_id: message.project_id,
        thread_id: message.thread_id,
        reply_to: message.id,
        author: { kind: "person" },
        subject: null,
        body,
        created_at: at,
        resolved_at: null,
        idempotency_key: null,
        action_report: sent.map((r) => r.id),
      };
      try {
        for (const record of sent) this.appendQuestion(record, at);
        this.appendMessage(reply, at);
      } catch (error) {
        for (const record of records) this.restoreQuestion(record);
        throw error;
      }
      out.push(reply);
    }
    return out;
  }

  /**
   * Whether a thread's owner can be known to have ended: it has a waking message, or it holds the thread by address
   * (only a connection can be addressed) and wrote nothing here. An agent that only reads through MCP cannot.
   */
  ownerCanEnd(threadId: string, session: string): boolean {
    return this.hasWakingMessage(session) || !this.threadMessages(threadId).some((message) => message.author.kind === "agent" && message.author.session === session);
  }

  /**
   * The session that owns a thread now (the one the person's plain reply
   * goes to): the new owner of its latest hand-off that was not taken back
   * and that no later reply took over from (window: `activeHandoff`), else
   * today's rule (the latest agent writer, or a session that took over
   * from an ended one since, else the session a thread the person started is
   * addressed to). Null when there is none.
   */
  threadOwner(threadId: string): { host: string | null; session: string } | null {
    const messages = this.threadMessages(threadId);
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!;
      if (handoffActive(message)) return { host: message.to!.host, session: message.to!.session };
      if (message.took_over) break;
    }
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!;
      // A permission prompt (launch, `perm:…`) is not its session's words, as in the window's `wordsMessage`.
      if (message.author.kind === "agent" && message.author.session && !isInboxPermissionSession(message.author.session)) return { host: message.author.host ?? null, session: message.author.session };
      if (message.took_over && message.to) return { host: message.to.host, session: message.to.session };
    }
    const root = messages[0];
    return root?.to ? { host: root.to.host, session: root.to.session } : null;
  }

  /**
   * The sessions the person added to a thread ("Add instead"): each joined
   * tag of the person's messages, once, as a tag a later reply carries again
   * (no delivery, no Send now, no read).
   */
  addedSessions(threadId: string): InboxTag[] {
    const out: InboxTag[] = [];
    for (const message of this.threadMessages(threadId)) {
      if (message.author.kind !== "person") continue;
      for (const tag of message.tags ?? []) {
        if (!tag.joined || out.some((t) => t.session === tag.session)) continue;
        out.push({ host: tag.host, session: tag.session, ...(tag.name ? { name: tag.name } : {}), ...(tag.label ? { label: tag.label } : {}), wakes: tag.wakes, joined: true });
      }
    }
    return out;
  }

  /** Hand-offs still inside their Undo window (or that a stop interrupted). */
  handoffsPending(): number {
    let count = 0;
    for (const message of this.messages.values()) if (handoffHeld(message)) count++;
    return count;
  }

  /**
   * Hand-offs whose Undo window passed: each gets `settled_at` (a new
   * snapshot), so the new owner and the former one are handed it.
   */
  settleHandoffs(afterMs: number): InboxMessage[] {
    const now = this.now().getTime();
    const out: InboxMessage[] = [];
    for (const message of [...this.messages.values()]) {
      if (!handoffHeld(message) || Date.parse(message.handoff!.at) + afterMs > now) continue;
      const at = this.stamp();
      const settled: InboxMessage = { ...message, handoff: { ...message.handoff!, settled_at: at } };
      this.appendMessage(settled, at);
      out.push(settled);
    }
    return out;
  }

  /** Settle now every hand-off still held in one thread: the person wrote again in it. */
  settleHandoffsIn(threadId: string): InboxMessage[] {
    const out: InboxMessage[] = [];
    for (const message of this.threadMessages(threadId)) {
      if (!handoffHeld(message)) continue;
      const at = this.stamp();
      const settled: InboxMessage = { ...message, handoff: { ...message.handoff!, settled_at: at } };
      this.appendMessage(settled, at);
      out.push(settled);
    }
    return out;
  }

  /**
   * The person took a hand-off back inside its Undo window: the reply goes
   * as an Ask instead. A new snapshot: addressed as it would have been
   * without the hand-off, the new owner tagged (this message only), no
   * notice for the former owner, and `undone_at` set (so nothing waits for
   * the window). Refused once it settled (`handoff_settled`): by then the
   * sessions were told.
   */
  undoHandoff(messageId: string): InboxMessage {
    const message = this.messages.get(messageId);
    if (!message || message.author.kind !== "person" || !message.handoff) throw new InboxError("message_not_found", `No hand-off ${messageId}.`);
    if (message.handoff.undone_at) return message;
    if (message.handoff.settled_at) {
      throw new InboxError("handoff_settled", "The hand-off already went: both sessions were told. Hand the thread back with a new reply instead.");
    }
    const asked = message.reply_to ? this.messages.get(message.reply_to) : undefined;
    const before = asked?.author.kind === "person" && asked.to ? asked.to : null;
    const owner = before?.session ?? (asked?.author.kind === "agent" ? (asked.author.session ?? null) : null);
    const handedTo = message.to!;
    const kept = (message.tags ?? []).filter((t) => !t.handed_away && t.session !== handedTo.session);
    const tags: InboxTag[] =
      handedTo.session === owner
        ? kept
        : [{ host: handedTo.host, session: handedTo.session, ...(message.handoff.label ? { label: message.handoff.label } : {}), wakes: true }, ...kept];
    const { to: _to, tags: _tags, ...rest } = message;
    const at = this.stamp();
    const undone: InboxMessage = {
      ...rest,
      ...(before ? { to: { host: before.host, session: before.session } } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      handoff: { ...message.handoff, undone_at: at },
    };
    this.appendMessage(undone, at);
    return undone;
  }

  /** Acks not settled yet (still inside their Undo window, or a stop interrupted it). */
  acksPending(): number {
    let count = 0;
    for (const message of this.messages.values()) if (message.ack && message.ack.settled_seq == null) count++;
    return count;
  }

  /**
   * A thread as an agent reads it (read_thread): an ack shows only once it
   * settled, as `{ label, at, reaction }` (`reaction` always, 👍 Looks good
   * for an ack without a tray emoji); one still inside its Undo window (or taken back) is not
   * there.
   */
  agentThread(threadId: string, caller: string | null = null): InboxThread | null {
    const thread = this.thread(threadId);
    if (!thread) return null;
    return {
      ...thread,
      messages: thread.messages.map((message) => {
        let out: InboxMessageWire = message;
        // The writer's own folder, by name only: an agent never reads another folder's absolute path.
        if (message.from_project) out = { ...out, from_project: { name: message.from_project.name } } as unknown as InboxMessageWire;
        if (message.ack !== undefined) {
          const { ack, ...rest } = out;
          out = { ...rest, ack: ack && ack.settled_seq != null && !ack.not_sent ? { label: ack.label, at: ack.at, reaction: ack.reaction ?? { emoji: "👍", label: INBOX_ACK_LABEL } } : null } as InboxMessageWire;
        }
        // Who a reply tagged (approval "inbox-tag-agents"), as an agent reads it: the agents and, for
        // the reader, that it was tagged. Delivery state is the person's view, not the agent's.
        if (message.tags && message.tags.length > 0) {
          // A hand-off's stop notice to the former owner is not a tag (approval "inbox-tag-handoff").
          const { tags: all, ...rest } = out;
          const tags = all!.filter((t) => !t.handed_away);
          const taggedYou = caller !== null && !this.isOwner(message, caller) && tags.some((t) => t.session === caller);
          out = {
            ...rest,
            ...(tags.length > 0
              ? { tagged: tags.map((t) => ({ agent: t.name || (t.host ? inboxAgentName({ kind: "agent", host: t.host, name: null }) : "An agent"), session: t.session })) }
              : {}),
            ...(taggedYou ? { tagged_you: true } : {}),
          } as unknown as InboxMessageWire;
        }
        return out;
      }),
    };
  }

  /** One message's settled ack was seen by its agent (its note delivered). No write when already seen. */
  private markAckSeen(messageId: string, at: string): void {
    const message = this.messages.get(messageId);
    const ack = message?.ack;
    if (!message || !ack || ack.settled_seq == null || ack.not_sent || ack.seen_at) return;
    this.appendMessage({ ...message, ack: { ...ack, seen_at: at } }, at);
  }

  /**
   * An agent read the thread's settled acks (read_thread): each gets
   * `seen_at`, so the window's pill says "<agent>
   * saw it". An ack that was not sent (`not_sent`) is never seen. `only`
   * limits it to those messages (a windowed read marks only the acks it showed).
   */
  markAcksSeen(threadId: string, only?: ReadonlySet<string>): void {
    const at = this.stamp();
    for (const message of this.threadMessages(threadId)) {
      const ack = message.ack;
      if (only && !only.has(message.id)) continue;
      if (!ack || ack.settled_seq == null || ack.not_sent || ack.seen_at) continue;
      this.appendMessage({ ...message, ack: { ...ack, seen_at: at } }, at);
    }
  }

  /**
   * The person looked at a thread: its agent messages so far are no longer
   * new. No write when nothing is new. `throughSeq` caps the look at what the
   * window showed: it covers only agent messages whose seq is at or below it,
   * so a message that landed after the window read the thread stays new. A
   * cap at or below the look already recorded writes nothing (a look never
   * goes back), and one past the newest message is the newest message.
   * Without it: every agent message so far (older clients, the phone door).
   */
  markSeen(threadId: string, throughSeq?: number): InboxListRow {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    // What listRow counts as seen: the last look, or the person's own last
    // reply (never the Inbox's notes). Only an agent message after both is
    // new, so only then is a write due.
    let seen = root.person_seen_seq ?? 0;
    let latestAgent = 0;
    for (const id of this.threadMembers.get(threadId) ?? []) {
      const seq = this.messageSeq.get(id) ?? 0;
      const message = this.messages.get(id);
      if (message?.author.kind === "agent") {
        if (throughSeq === undefined || seq <= throughSeq) latestAgent = Math.max(latestAgent, seq);
      } else if (message && !isInboxNote(message) && !isInboxActionReport(message)) seen = Math.max(seen, seq);
    }
    if (latestAgent > seen) {
      const at = this.stamp();
      this.appendMessage({ ...root, person_seen_seq: latestAgent }, at);
    }
    // A look reads a thread back from its snooze (its small clock goes); before the snooze's time it does nothing to it.
    this.endLapsedSnooze(threadId);
    const row = this.listRow(threadId);
    if (!row) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    return row;
  }

  /**
   * An agent read the person's replies in a thread: read_thread read the
   * thread, up to `upToSeq` (a later reply it was not given still reads as
   * unread), or a connection delivered one reply.
   * A Sent row moves to Quiet once its last reply is checked. No write when
   * there is no person reply it has not read.
   *
   * `reader` is the session that read (null: a read that names none). The
   * mark settles a plain reply (no `to`, no tags), so it never moves past one
   * still owed to another session, or to no session when a session reads:
   * only a reply's recipient settles it (a second agent in the thread must
   * not swallow it). A reader new to the thread counts as the recipient of a
   * reply no connection wakes (`owedToAnother`). Undefined: every reply, for
   * a caller that is not a read.
   */
  markAgentChecked(threadId: string, upToSeq = Number.POSITIVE_INFINITY, at = this.stamp(), reader?: string | null): void {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) return;
    const from = root.agent_checked_seq ?? 0;
    // Worked out once per read, and only when a reply asks for it.
    let newcomer: boolean | undefined;
    const isNewcomer = () => (newcomer ??= this.newcomerTo(threadId, reader ?? null));
    let checked = 0;
    let lastChecked: InboxMessage | null = null;
    for (const id of this.threadMembers.get(threadId) ?? []) {
      const seq = this.messageSeq.get(id) ?? 0;
      const message = this.messages.get(id);
      if (seq > upToSeq || message?.author.kind !== "person") continue;
      if (reader !== undefined && seq > from && this.owedToAnother(message, reader, isNewcomer)) break;
      checked = Math.max(checked, seq);
      lastChecked = message;
    }
    if (checked === 0 || (root.agent_checked_seq ?? 0) >= checked) {
      // The agent it was for read it after another did: it has it now, so the line goes back to Delivered.
      const asked = lastChecked?.reply_to ? this.messages.get(lastChecked.reply_to) : undefined;
      if (root.agent_checked_by && reader && asked?.author.kind === "agent" && asked.author.session === reader) {
        this.appendMessage({ ...root, agent_checked_at: at, agent_checked_by: undefined }, at);
      }
      return;
    }
    // Undefined when no other agent read it: an earlier read's name goes with the mark it moved.
    const by = (lastChecked && this.readByAnother(lastChecked, reader)) || undefined;
    this.appendMessage({ ...root, agent_checked_seq: checked, agent_checked_at: at, agent_checked_by: by }, at);
  }

  /**
   * The host of `reader`, when its read of this reply is known not to be the agent the reply was for: another host
   * than the session it answers. Null when it may be that agent: its own session, the same host (a raw MCP client
   * takes a new `ses_` id each time it restarts, `owedToAnother`), a host not known, or one the Inbox has no name for.
   */
  private readByAnother(message: InboxMessage, reader: string | null | undefined): string | null {
    if (!reader || message.to || hasTags(message)) return null;
    const asked = message.reply_to ? this.messages.get(message.reply_to) : undefined;
    if (asked?.author.kind !== "agent" || !asked.author.host || asked.author.session === reader) return null;
    // Both from the names the Inbox knows: an agent's host is free text, "Cursor" and "cursor" are one agent, and so
    // are `claude` and `claude-code`, so the names are what differ.
    if (!Object.hasOwn(INBOX_HOST_NAMES, asked.author.host)) return null;
    const known = this.deliveryPresence?.hostOf?.(reader);
    const wrote = known ? null : this.latestAgentMessages().get(reader)?.author;
    const host = known ?? (wrote?.kind === "agent" ? wrote.host : null);
    return host && Object.hasOwn(INBOX_HOST_NAMES, host) && INBOX_HOST_NAMES[host] !== INBOX_HOST_NAMES[asked.author.host] ? host : null;
  }

  /**
   * A person's plain reply (no `to`, no tags) still owed to a recipient other
   * than `reader`: the session of the agent message it answers (none, for a
   * message sent without a session), not delivered, and not a Tidy note left
   * to its wake. A 👍's note is not a reply: any agent's read sees it, as
   * `markAcksSeen` does.
   *
   * Not owed to another when no connection wakes its recipient and `reader`
   * is new to the thread (`newcomerTo`): a raw MCP client's shim takes a new
   * `ses_` id each time the client restarts, and a script may name a session
   * on send but none on read, so that read is the recipient's own as far as
   * the Inbox can tell. Without it the reply would wait for a session that
   * never comes back, with no ended state to offer the route choice. A
   * waking recipient stays strict (its connection takes the reply, and the
   * route choice opens when it ended), and so does any reader that wrote,
   * owns a message or was tagged in the thread.
   */
  private owedToAnother(message: InboxMessage, reader: string | null, isNewcomer = () => this.newcomerTo(message.thread_id, reader)): boolean {
    if (message.to || hasTags(message) || message.delivery || isAckNote(message)) return false;
    if (message.tidy && !message.tidy.wake) return false;
    const asked = message.reply_to ? this.messages.get(message.reply_to) : undefined;
    if (asked?.author.kind !== "agent") return false;
    if ((asked.author.session ?? null) === reader) return false;
    return asked.wakes === true || !isNewcomer();
  }

  /**
   * Whether `reader`'s read of the thread settles this person's message as
   * far as the agent-read mark goes: the rule `markAgentChecked` applies
   * (read_thread's `unread` for that reader follows it).
   */
  readSettles(message: InboxMessage, reader: string | null): boolean {
    return !this.owedToAnother(message, reader);
  }

  /**
   * After `markAgentChecked` for a read: each plain reply the read showed
   * (`shown`; all without it) that this read settles but the mark could not
   * reach, because an earlier reply still owed to another session holds it
   * (a waking session that has not taken its reply yet, or ended), records
   * its delivery to the session it answers. So a restarted raw MCP client's
   * read, or a read that names no session, settles its reply in a shared
   * thread too, and read_thread's `unread` (`readSettles`) says what the read
   * did. A reply the reader owns is `recordOwnRead`'s. No write when nothing
   * is left.
   */
  settleReadPast(threadId: string, reader: string | null, shown?: ReadonlySet<string>): void {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) return;
    let newcomer: boolean | undefined;
    const isNewcomer = () => (newcomer ??= this.newcomerTo(threadId, reader));
    for (const message of this.threadMessages(threadId)) {
      if (message.author.kind !== "person" || message.delivery || isInboxNote(message) || isAckNote(message) || message.tidy) continue;
      if (message.to || hasTags(message) || (shown && !shown.has(message.id))) continue;
      if ((this.messageSeq.get(message.id) ?? 0) <= (this.messages.get(threadId)?.agent_checked_seq ?? 0)) continue;
      const asked = message.reply_to ? this.messages.get(message.reply_to) : undefined;
      if (asked?.author.kind !== "agent") continue;
      if (reader !== null && asked.author.session === reader) continue;
      if (this.owedToAnother(message, reader, isNewcomer)) continue;
      const at = this.stamp();
      // A session it answers when it had one; else the reader's (a message and a read that both name none: "").
      const session = asked.author.session ?? reader ?? "";
      const readBy = this.readByAnother(message, reader);
      this.appendMessage({ ...message, delivery: { state: "delivered", host: asked.author.host ?? "agent", session, at, ...(readBy ? { read_by: readBy } : {}) } }, at);
    }
  }

  /**
   * Whether `reader` is new to the thread: it never wrote there (null: no
   * agent message sent without a session), owns none of the person's
   * messages and is tagged in none.
   */
  private newcomerTo(threadId: string, reader: string | null): boolean {
    for (const message of this.threadMessages(threadId)) {
      if (message.author.kind === "agent") {
        if ((message.author.session ?? null) === reader) return false;
        continue;
      }
      if (reader !== null && (this.isOwner(message, reader) || tagOf(message, reader))) return false;
    }
    return true;
  }

  /**
   * What the store takes on disk, per project and per thread, read from the
   * files themselves (Settings' "Stored on this machine"). A thread's bytes
   * are the lines of its messages and their questions; a project's are its
   * whole folder, so they include the project line and any torn fragment.
   */
  diskUsage(): InboxDiskUsage {
    const projects: InboxProjectUsage[] = [];
    const blobSizes = inboxBlobSizes(this.dir);
    // Every blob once in the total; a project and a thread count each blob they use once.
    // Drafts count in the total (compose); their files, uploaded or not yet sent, are blobs already counted.
    let total = [...blobSizes.values()].reduce((sum, size) => sum + size, 0) + inboxDraftsBytes(this.dir) + this.replyDraftsBytes() + this.decisionLinesBytes();
    // Size and Delete stay per folder: a combined project keeps its own files, so it keeps its own row, by its own name.
    for (const stored of this.allProjects()) {
      const head = this.canonicalProjectId(stored.id);
      const project = head === stored.id ? stored : (this.combinedInto(head).find((member) => member.id === stored.id) ?? stored);
      const folder = this.projectFolder(project);
      const perThread = new Map<string, number>();
      let bytes = 0;
      const projectBlobs = new Set<string>();
      for (const [threadId, blobs] of this.threadBlobs(project.id)) {
        let threadBytes = 0;
        for (const sha256 of blobs) {
          threadBytes += blobSizes.get(sha256) ?? 0;
          projectBlobs.add(sha256);
        }
        perThread.set(threadId, threadBytes);
      }
      for (const sha256 of projectBlobs) bytes += blobSizes.get(sha256) ?? 0;
      for (const name of [PROJECT_FILE, MESSAGES_FILE, QUESTIONS_FILE, LEGACY_DECISIONS_FILE, ANNOTATIONS_FILE, CARDS_FILE, STEPS_FILE]) {
        let text: string;
        try {
          text = readFileSync(join(folder, name), "utf8");
        } catch {
          continue;
        }
        bytes += Buffer.byteLength(text);
        total += Buffer.byteLength(text);
        // The project line, an older store's decisions file and the cards count for the project, not a thread.
        if (name === PROJECT_FILE || name === LEGACY_DECISIONS_FILE || name === CARDS_FILE) continue;
        for (const raw of text.split("\n")) {
          const line = parseInboxLine(raw);
          if (!line) continue;
          const messageId =
            line.kind === "message"
              ? line.record.id
              : line.kind === "question" || line.kind === "annotation"
                ? line.record.message_id
                : line.kind === "steps"
                  ? line.record.thread_id
                  : null;
          const threadId = messageId ? this.messages.get(messageId)?.thread_id : undefined;
          if (!threadId) continue;
          perThread.set(threadId, (perThread.get(threadId) ?? 0) + Buffer.byteLength(raw) + 1);
        }
      }
      const threads = [...perThread.entries()]
        .map(([threadId, threadBytes]) => ({ thread_id: threadId, subject: this.threadSubject(threadId), bytes: threadBytes }))
        .sort((a, b) => b.bytes - a.bytes || a.thread_id.localeCompare(b.thread_id));
      // The ones a Delete leaves on their own: a project deeper in the chain stays in the one it went into.
      const combined = this.combinedInto(project.id).flatMap((member) => (member.merged_into === project.id ? [member.name] : []));
      projects.push({
        id: project.id,
        name: project.name,
        root: project.root,
        bytes,
        threads,
        ...(head === project.id ? {} : { combined_into: stored.name }),
        ...(combined.length > 0 ? { combined } : {}),
      });
    }
    projects.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
    return { dir: this.dir, bytes: total, projects };
  }

  // ─────────────────────────── writing ───────────────────────────

  private stamp(): string {
    return this.now().toISOString();
  }

  private write(file: string, line: InboxLine): void {
    const prefix = this.tornFiles.has(file) ? "\n" : "";
    try {
      appendFileSync(file, `${prefix}${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch (error) {
      // A failed append may have left part of the line (disk full): the next
      // append starts on a fresh line so it cannot be glued to the fragment.
      this.tornFiles.add(file);
      throw error;
    }
    this.tornFiles.delete(file);
    this.apply(line);
    for (const listener of this.listeners) {
      try {
        listener(line);
      } catch {
        // A subscriber's failure never undoes a write or blocks the others.
      }
    }
  }

  private projectFolder(project: InboxProject): string {
    return join(this.dir, INBOX_PROJECTS_DIR, project.key);
  }

  private appendMessage(message: InboxMessage, at: string): void {
    const project = this.projectsById.get(message.project_id);
    if (!project) throw new InboxError("project_not_found", `No project ${message.project_id}.`);
    this.write(join(this.projectFolder(project), MESSAGES_FILE), {
      v: INBOX_RECORD_VERSION,
      seq: this.seq + 1,
      at,
      kind: "message",
      id: message.id,
      record: message,
    });
  }

  private appendQuestion(record: InboxQuestionRecord, at: string): void {
    const project = this.projectsById.get(record.project_id);
    if (!project) throw new InboxError("project_not_found", `No project ${record.project_id}.`);
    this.write(join(this.projectFolder(project), QUESTIONS_FILE), {
      v: INBOX_RECORD_VERSION,
      seq: this.seq + 1,
      at,
      kind: "question",
      id: record.id,
      record,
    });
  }

  /** The project for `root` (an absolute realpath), created on first use. */
  ensureProject(input: { name: string; root: string }): InboxProject {
    const existing = this.projectsByRoot.get(input.root);
    if (existing) return this.labeled(existing);
    const at = this.stamp();
    // Six hex of the root's hash keeps two same-named repositories apart; on
    // the rare collision take more of the hash, so one folder never holds two
    // projects (the second project.json would replace the first).
    const taken = new Set([...this.projectsById.values()].map((p) => p.key));
    let key = inboxProjectKey(input.name, input.root);
    const inUse = (candidate: string) => taken.has(candidate) || existsSync(join(this.dir, INBOX_PROJECTS_DIR, candidate));
    for (let length = 12; inUse(key) && length <= 64; length += 13) key = inboxProjectKey(input.name, input.root, length);
    if (inUse(key)) key = `${inboxProjectKey(input.name, input.root)}-${inboxId("prj").slice(-6).toLowerCase()}`;
    const project: InboxProject = {
      id: inboxId("prj"),
      key,
      name: input.name,
      root: input.root,
      created_at: at,
    };
    const folder = this.projectFolder(project);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const line: InboxLine = { v: INBOX_RECORD_VERSION, seq: this.seq + 1, at, kind: "project", id: project.id, record: project };
    // The first line, written whole: temp file then rename (a rename appends later lines through write()).
    const path = join(folder, PROJECT_FILE);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    renameSync(temp, path);
    this.apply(line);
    for (const listener of this.listeners) {
      try {
        listener(line);
      } catch {
        // see write()
      }
    }
    return this.labeled(project);
  }

  /**
   * The person's name for a project (Rename… in the project menu), or null
   * for Reset name (back to its folder's name). One new project line with the
   * same id, key, slug and root; the last line wins on every read, so nothing
   * else on disk changes and an older reader ignores the field. A name equal
   * to the current one writes nothing. Refuses an empty or too long name
   * (`checkInboxProjectName`) and an unknown project.
   */
  renameProject(projectId: string, name: string | null): InboxProject {
    const project = this.projectsById.get(projectId);
    if (!project) throw new InboxError("project_not_found", `No project ${projectId}.`);
    let displayName: string | null = null;
    if (name !== null) {
      const checked = checkInboxProjectName(name);
      if (!checked.ok) throw new InboxError("validation_error", `name: ${checked.message}`, { field: "name" });
      displayName = checked.name;
    }
    if ((project.display_name ?? null) === displayName) return this.labeled(project);
    const { display_name: _previous, ...rest } = project;
    const record: InboxProject = displayName === null ? rest : { ...rest, display_name: displayName };
    this.write(join(this.projectFolder(project), PROJECT_FILE), {
      v: INBOX_RECORD_VERSION,
      seq: this.seq + 1,
      at: this.stamp(),
      kind: "project",
      id: project.id,
      record,
    });
    return this.labeled(record);
  }

  /**
   * An agent's message. Where it lands (owner ruling 2026-10-07, "a row is a
   * thread"), first match wins:
   *  1. reply_to: that message's thread, as a reply to it (`thread` ignored);
   *  2. `thread`: the open thread of that name in the project, across
   *     sessions; a new thread under the name when there is none or it is
   *     resolved;
   *  3. otherwise: the session's open default (unnamed) thread in the
   *     project; a new one when it has none or its last one is resolved, or
   *     when the sender has no session.
   * A thread keeps its first message's subject. Routing reads only the
   * store's log, so a replay routes the same way.
   */
  sendMessage(input: InboxSendInput): InboxSendResult {
    if (input.permission !== true && isInboxPermissionSession(input.author.session)) {
      throw new InboxError("validation_error", `agent_session: "${INBOX_PERMISSION_SESSION_PREFIX}" is reserved for the Inbox's own permission questions.`, { field: "agent_session" });
    }
    const body = input.body;
    if (typeof body !== "string" || body.trim() === "") throw new InboxError("validation_error", "body: a message needs a body.", { field: "body" });
    // One line of plain text, checked before anything else (a reply ignores
    // its subject, but leaked tool-call text means the call itself was
    // malformed): nothing is written, so a corrected retry with the same
    // idempotency_key lands once.
    const subjectCheck = checkInboxSubject(input.subject);
    if (!subjectCheck.ok) throw new InboxError("validation_error", `subject: ${subjectCheck.message}`, { field: "subject" });
    let threadName: string | null = null;
    if (input.thread !== undefined && input.thread !== null && !input.reply_to) {
      const checked = checkInboxThreadName(input.thread);
      if (!checked.ok) throw new InboxError("validation_error", `thread: ${checked.message}`, { field: "thread" });
      threadName = checked.name;
    }
    let projectId = input.project_id;
    let threadId: string | null = null;
    let replyTo: string | null = null;
    if (input.reply_to) {
      const parent = this.messages.get(input.reply_to);
      if (!parent) throw new InboxError("message_not_found", `No message ${input.reply_to}.`, { field: "reply_to" });
      projectId = parent.project_id;
      threadId = parent.thread_id;
      replyTo = parent.id;
    }
    if (!this.projectsById.has(projectId)) throw new InboxError("project_not_found", `No project ${projectId}.`);
    // A reply's `thread` routes nothing; it may name a thread the person started (below).
    const replyThread = replyTo && typeof input.thread === "string" && input.thread.trim() !== "" ? input.thread.trim() : null;

    const supersedes = this.normalizeSupersedes(input.supersedes);
    const done = this.normalizeDone(input.done);
    const key = input.idempotency_key?.trim() || null;
    if (key) {
      for (const message of this.messages.values()) {
        // Across a combined project: a retry from either folder is the same call.
        if (message.idempotency_key !== key || message.author.kind !== "agent" || !this.sameProject(message.project_id, projectId)) continue;
        // A retry is the same call: the same body, reply target, thread
        // name (a reply's `thread` included; compared as routing compares
        // names) and superseded ids. The thread it joined is the first
        // call's, whatever the routing would say now, and so is what its
        // naming came to.
        // A reply's `thread` counts only where it could name the thread (the reply kept `thread_naming`):
        // anywhere else it is ignored, and an older store never recorded it.
        const sameName =
          inboxThreadNameKey(message.thread_name ?? "") === inboxThreadNameKey(threadName ?? "") &&
          (!message.thread_naming || inboxThreadNameKey(message.reply_thread ?? "") === inboxThreadNameKey(replyThread ?? ""));
        const sameGuide = (message.guide?.input_sha256 ?? null) === (input.guide?.input_sha256 ?? null);
        const sameSupersedes = [...(message.supersedes ?? [])].sort().join("\n") === [...supersedes].sort().join("\n");
        const sameDone = [...(message.done ?? [])].sort().join("\n") === [...done].sort().join("\n");
        const liveIds = (sites: readonly { id: string }[] | undefined) => [...new Set((sites ?? []).map((site) => site.id))].sort().join("\n");
        const sameLive = liveIds(message.live_sites) === liveIds(input.live_sites);
        if (message.body !== body || message.reply_to !== replyTo || !sameName || !sameGuide || !sameSupersedes || !sameDone || !sameLive) {
          throw new InboxError(
            "idempotency_key_reused",
            "This idempotency_key was already used for a different message.",
            { message_id: message.id },
          );
        }
        const markedDone = this.doneBy(message.id);
        return {
          message: this.wire(message),
          replayed: true,
          ...(message.thread_naming ? { naming: message.thread_naming } : {}),
          ...(markedDone.length > 0 ? { done: markedDone } : {}),
        };
      }
    }

    if (!replyTo) threadId = this.routeThread(projectId, threadName);
    // A send across a combined project can land in the other folder's thread. Every message of a thread
    // stays in its root's project (deleting a thread reads one folder), so this one is written there, and
    // its relative files keep starting at the folder it came from.
    let basePath = input.base_path;
    if (threadId && !replyTo) projectId = this.messages.get(threadId)!.project_id;
    if (projectId !== input.project_id && this.sameProject(projectId, input.project_id)) basePath ??= this.projectsById.get(input.project_id)!.root;

    // A reply into a thread the person started may name it, once (approval
    // "inbox-agent-names-own-thread"): its `thread`, checked by the
    // thread-name rules, and refused when another open thread of the project
    // already has the name (`threadNameTaken`). Decided before the reply is
    // written and kept on it (`thread_naming`), so a retry answers the same.
    let naming: InboxThreadNaming | undefined;
    if (replyTo && threadId && this.mayNameWithReply(threadId, input.author.session)) {
      if (replyThread === null) {
        naming = { status: "unnamed" };
      } else {
        const checked = checkInboxThreadName(replyThread);
        if (!checked.ok) {
          naming = { status: "refused", code: "invalid_thread_name", reason: `The name ${checked.message}` };
        } else if (this.threadNameTaken(projectId, checked.name, threadId)) {
          naming = {
            status: "refused",
            code: "thread_name_taken",
            reason: `Another open thread in this project is already named "${checked.name}".`,
          };
        } else {
          naming = { status: "named", name: checked.name };
        }
      }
    }

    const at = this.stamp();
    const id = inboxId("msg");
    const parsed = parseInboxQuestionBlocks(body);
    // Action items (approval "inbox-next-actions"): `:::action` blocks, kept as
    // question records of kind "action", numbered on their own (A1, A2…).
    const actions = parseInboxActionBlocks(body);
    // Checked before anything is written: one id that names no open question
    // of this thread refuses the whole send.
    const superseding = this.planSupersede(threadId, id, supersedes, parsed, actions);
    const doneIds = this.planDone(threadId, done, superseding, input.author);
    const agentSubject = subjectCheck.subject;
    const message: InboxMessage = {
      id,
      project_id: projectId,
      thread_id: threadId ?? id,
      reply_to: replyTo,
      author: input.author,
      // A message that asks nothing but carries an action item is named by the action item: it is what waits on the person.
      subject: threadId ? null : (agentSubject || deriveInboxSubject(body, parsed.length > 0 ? parsed : actions)),
      ...(threadId ? {} : { subject_question: !agentSubject && (parsed[0] ?? actions[0]) ? `${id}/${(parsed[0] ?? actions[0])!.key}` : null }),
      ...(supersedes.length > 0 ? { supersedes } : {}),
      ...(done.length > 0 ? { done } : {}),
      body,
      created_at: at,
      resolved_at: null,
      idempotency_key: key,
      thread_name: threadName,
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments.map((attachment) => ({ ...attachment, sent_at: at })) }
        : {}),
      ...(input.inline_images !== undefined ? { inline_images: input.inline_images.map((image) => ({ ...image, sent_at: at })) } : {}),
      ...(input.live_sites && input.live_sites.length > 0 ? { live_sites: input.live_sites.map((site) => ({ ...site, opened_at: at })) } : {}),
      ...(input.guide ? { guide: input.guide } : {}),
      ...(basePath ? { base_path: basePath } : {}),
      // Only into another project's thread: a send that landed in its own project (or one combined with it) is from there.
      ...(input.from_project && input.from_project.root !== this.projectsById.get(projectId)?.root && !this.projectGroup(projectId).some((id) => this.projectsById.get(id)?.root === input.from_project!.root)
        ? { from_project: { name: input.from_project.name, root: input.from_project.root } }
        : {}),
      ...(input.wakes === true ? { wakes: true } : {}),
      ...(replyThread !== null ? { reply_thread: replyThread } : {}),
      ...(naming ? { thread_naming: naming } : {}),
    };
    this.appendMessage(message, at);
    for (const question of parsed) {
      this.appendQuestion(
        {
          id: `${id}/${question.key}`,
          project_id: projectId,
          message_id: id,
          key: question.key,
          position: question.position,
          kind: question.kind,
          prompt: question.prompt,
          parsed: question.parsed,
          stopped: question.stopped,
          holds_up: question.holds_up,
          asked_by_agent_id: input.author.session,
          answer: null,
          revision: 0,
          sent_revision: 0,
          picked_by: null,
          picked_at: null,
          sent_reply_id: null,
        },
        at,
      );
    }
    for (const action of actions) {
      this.appendQuestion(
        {
          id: `${id}/${action.key}`,
          project_id: projectId,
          message_id: id,
          key: action.key,
          position: action.position,
          kind: "action",
          prompt: action.prompt,
          parsed: { context: action.why, choices: [], aliases: [], recommendation: null, suggested_text: null, line: action.line },
          stopped: action.stopped,
          holds_up: action.holds_up,
          asked_by_agent_id: input.author.session,
          answer: null,
          revision: 0,
          sent_revision: 0,
          picked_by: null,
          picked_at: null,
          sent_reply_id: null,
          action: action.action,
          action_result: null,
        },
        at,
      );
    }
    // The superseded questions last, so whoever reads them finds the message
    // that superseded them. A pick saved on one stays on it, never sent.
    for (const [questionId, by] of superseding) {
      const record = this.questions.get(questionId)!;
      this.appendQuestion({ ...record, superseded_by: by }, at);
    }
    // The action items the agent saw done: closed, nothing sent. A Done or Can't do it the person
    // had waiting in their draft is kept under `person`: its note still goes with their Send (Q3).
    for (const questionId of doneIds) {
      const record = this.questions.get(questionId)!;
      const mine = record.action_result?.by === "person" && record.action_result.staged === true ? record.action_result : null;
      this.appendQuestion(
        {
          ...record,
          revision: record.revision + 1,
          action_result: {
            outcome: "done",
            note: null,
            at,
            by: "agent",
            message_id: id,
            ...(mine ? { person: { outcome: mine.outcome, note: mine.note, at: mine.at } } : {}),
          },
        },
        at,
      );
    }
    // The name, last: the root written again with `thread_name` and
    // `named_by` (append-only; `apply` indexes a name it gains at that line,
    // in seq order, so a replay routes the same). A crash between the reply
    // line and this one leaves the reply saying `named` over an unnamed
    // thread, which a later reply can still name; accepted, as for any
    // half-written send.
    if (naming?.status === "named" && threadId) {
      const root = this.messages.get(threadId)!;
      this.appendMessage(
        {
          ...root,
          thread_name: naming.name,
          named_by: { kind: "agent", host: input.author.host, session: input.author.session!, message_id: id, at },
        },
        at,
      );
    }
    // A reply from the agent reopens nothing: a resolved thread stays resolved.
    return { message: this.wire(message), replayed: false, ...(naming ? { naming } : {}), ...(doneIds.length > 0 ? { done: doneIds } : {}) };
  }

  /** send_message's `done` as the store keeps it: trimmed, each once, in order. */
  private normalizeDone(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    const refuse = (message: string) => new InboxError("invalid_done", `done: ${message}`, { field: "done" });
    if (!Array.isArray(value)) throw refuse("a list of ids, each `<message id>/<key>` of an action item (or `<message id>` for all its action items).");
    if (value.length > INBOX_SUPERSEDES_MAX) throw refuse(`at most ${INBOX_SUPERSEDES_MAX} ids.`);
    const out: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string" || entry.trim() === "") throw refuse("each id is a string, `<message id>/<key>` of an action item.");
      const id = entry.trim();
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  /** The action items a message marked done by its `done` (`<message id>/<key>`), in thread order. */
  doneBy(messageId: string): string[] {
    const message = this.messages.get(messageId);
    if (!message) return [];
    const out: string[] = [];
    for (const member of this.threadMessages(message.thread_id)) {
      for (const record of this.questionRecords(member.id)) {
        if (record.kind === "action" && record.action_result?.by === "agent" && record.action_result.message_id === messageId) out.push(record.id);
      }
    }
    return out;
  }

  /** A thread's action items still waiting on the person (open, or marked inside the Undo window), with what to do. */
  openActionsOf(threadId: string | null): { id: string; prompt: string }[] {
    if (threadId === null) return [];
    const out: { id: string; prompt: string }[] = [];
    for (const message of this.threadMessages(threadId)) {
      const closed = this.closedByArchive(message);
      for (const record of this.questionRecords(message.id)) {
        if (record.kind === "action" && isInboxQuestionSupersedable(inboxQuestionState(record, closed))) out.push({ id: record.id, prompt: record.prompt });
      }
    }
    return out;
  }

  /**
   * Which action items a new message marks done (send_message's `done`): each id
   * must name an open action item (open, or marked inside its Undo window) of
   * `threadId`, the thread the message lands in, else the whole send is
   * refused with `invalid_done`, listing that thread's open action items. One this
   * message also supersedes stays superseded.
   */
  private planDone(
    threadId: string | null,
    done: readonly string[],
    superseding: ReadonlyMap<string, InboxSupersededBy>,
    author: Extract<InboxAuthor, { kind: "agent" }>,
  ): string[] {
    if (done.length === 0) return [];
    const out: string[] = [];
    const problems: string[] = [];
    for (const ref of done) {
      const target = parseInboxDoneRef(ref);
      if (!target) {
        problems.push(`"${ref}" is not an action item's id: write <message id>/<key> (the key starts with a-; read_thread gives it).`);
        continue;
      }
      const message = this.messages.get(target.message_id);
      if (!message || message.author.kind !== "agent") {
        problems.push(`${ref}: no agent message ${target.message_id}.`);
        continue;
      }
      if (threadId === null || message.thread_id !== threadId) {
        problems.push(`${ref} is in another thread (${message.thread_id}): send with reply_to ${target.message_id} to mark it done there.`);
        continue;
      }
      // Only the session that wrote an action item marks it done (another agent's action item is not yours to close),
      // or the session a still-waiting Re-ask note was sent to, for the ids that note lists (the asker ended; #2059).
      const writer =
        (message.author.session ?? null) === (author.session ?? null) && (message.author.host ?? null) === (author.host ?? null);
      const granted = writer ? null : this.reaskGrants(threadId, author);
      if (!writer && ![...granted!].some((id) => id === `${message.id}/${target.key}` || (target.key === null && id.startsWith(`${message.id}/`)))) {
        problems.push(`${ref}: that action item is another session's; only the session that wrote an action item marks it done.`);
        continue;
      }
      const records = this.questionRecords(message.id).filter(
        (r) => r.kind === "action" && (target.key === null || r.key === target.key) && (granted === null || granted.has(r.id)),
      );
      if (records.length === 0) {
        problems.push(target.key === null ? `${ref}: that message has no action item.` : `${ref}: message ${target.message_id} has no action item ${target.key}.`);
        continue;
      }
      const resolved = this.closedByArchive(message);
      // Open, or the person's Done or Can't do it waiting in their draft: the agent's done settles that one, and the
      // person's note still goes with their Send (approval "inbox-action-items-in-reply", Q3). One the person marked
      // through the timed path (decision mode, the phone door), inside its Undo window, is theirs and goes as they said.
      const open = records.filter((r) => {
        const state = inboxQuestionState(r, resolved);
        return state === "open" || (state === "picked" && r.action_result?.by === "person" && r.action_result.staged === true);
      });
      if (open.length === 0) {
        const state = inboxQuestionState(records[0]!, resolved);
        problems.push(
          target.key === null
            ? `${ref}: that message has no open action item.`
            : state === "picked"
              ? `${ref}: ${PERSON_MARKED_WORDS}.`
              : `${ref} is not open (it is ${state}).`,
        );
        continue;
      }
      for (const record of open) if (!superseding.has(record.id) && !out.includes(record.id)) out.push(record.id);
    }
    if (problems.length > 0) {
      const open = this.openActionsOf(threadId);
      const listing =
        threadId === null
          ? "This message would start a new thread, which has no action items yet."
          : open.length > 0
            ? `Open action items in this thread: ${open.map((a) => `${a.id} (${a.prompt})`).join("; ")}.`
            : "This thread has no open action items.";
      throw new InboxError("invalid_done", `done: ${problems.join(" ")} Nothing was sent. ${listing}`, { field: "done", open_actions: open });
    }
    return out;
  }

  /** send_message's `supersedes` as the store keeps it: trimmed, each once, in order. */
  private normalizeSupersedes(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    const refuse = (message: string) => new InboxError("invalid_supersedes", `supersedes: ${message}`, { field: "supersedes" });
    if (!Array.isArray(value)) throw refuse("a list of ids, each `<message id>` or `<message id>/<key>`.");
    if (value.length > INBOX_SUPERSEDES_MAX) throw refuse(`at most ${INBOX_SUPERSEDES_MAX} ids.`);
    const out: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string" || entry.trim() === "") throw refuse("each id is a string, `<message id>` or `<message id>/<key>`.");
      const id = entry.trim();
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  /** The questions a message superseded (`<message id>/<key>`), in thread order. */
  supersededBy(messageId: string): string[] {
    const message = this.messages.get(messageId);
    if (!message) return [];
    const out: string[] = [];
    for (const member of this.threadMessages(message.thread_id)) {
      for (const record of this.questionRecords(member.id)) if (record.superseded_by?.message_id === messageId) out.push(record.id);
    }
    return out;
  }

  /**
   * A thread's questions and action items that may still be superseded (open, or picked and not sent), with
   * their prompts, as `invalid_supersedes` lists them. An action item the person marked through the timed path
   * (inside its Undo window) is never superseded, so it is not listed either: the refusal and the list agree.
   */
  openQuestionsOf(threadId: string | null): { id: string; prompt: string }[] {
    if (threadId === null) return [];
    const out: { id: string; prompt: string }[] = [];
    for (const message of this.threadMessages(threadId)) {
      const closed = this.closedByArchive(message);
      for (const record of this.questionRecords(message.id)) {
        const state = inboxQuestionState(record, closed);
        if (!isInboxQuestionSupersedable(state)) continue;
        if (record.kind === "action" && state === "picked" && record.action_result?.staged !== true) continue;
        out.push({ id: record.id, prompt: record.prompt });
      }
    }
    return out;
  }

  /**
   * Which questions a new message supersedes, and by what: each id of
   * `supersedes` (replaced by the message's only question when it asks
   * exactly one, else by the message alone: "No longer applies"), then each
   * block's `Replaces:` line (replaced by that block's question, which
   * wins). Every id must name an open question of `threadId`, the thread the
   * message lands in, else the whole send is refused with
   * `invalid_supersedes`, listing that thread's open questions.
   */
  private planSupersede(
    threadId: string | null,
    messageId: string,
    supersedes: readonly string[],
    parsed: readonly { key: string; replaces: string[] }[],
    /**
     * The new message's action items (`:::action`). A question is replaced only by a
     * question and an action item only by an action item: `supersedes` names the new
     * message's only question (or only action item) as the replacement of an old
     * one of the same kind, and a block's `Replaces:` line reaches only
     * records of its own kind.
     */
    actions: readonly { key: string; replaces: string[] }[] = [],
  ): Map<string, InboxSupersededBy> {
    const plan = new Map<string, InboxSupersededBy>();
    const onlyQuestion = parsed.length === 1 ? parsed[0]!.key : null;
    const onlyAction = actions.length === 1 ? actions[0]!.key : null;
    type Family = "question" | "action" | null;
    const requests: { ref: string; by: InboxSupersededBy; where: string; family: Family }[] = [
      ...supersedes.map((ref) => ({ ref, by: { message_id: messageId, key: null }, where: "supersedes", family: null as Family })),
      ...parsed.flatMap((question) =>
        question.replaces.map((ref) => ({ ref, by: { message_id: messageId, key: question.key }, where: "Replaces:", family: "question" as Family })),
      ),
      ...actions.flatMap((action) =>
        action.replaces.map((ref) => ({ ref, by: { message_id: messageId, key: action.key }, where: "Replaces:", family: "action" as Family })),
      ),
    ];
    const familyOf = (record: InboxQuestionRecord): "question" | "action" => (record.kind === "action" ? "action" : "question");
    // `supersedes`: the new message's only block of the old record's kind replaces it, else "No longer applies".
    const byFor = (request: { by: InboxSupersededBy; family: Family }, record: InboxQuestionRecord): InboxSupersededBy =>
      request.family === null ? { message_id: messageId, key: familyOf(record) === "action" ? onlyAction : onlyQuestion } : request.by;
    if (requests.length === 0) return plan;
    const problems: string[] = [];
    // Which new block's Replaces: line claimed each old question: two blocks
    // cannot both replace one question.
    const claimedBy = new Map<string, string>();
    for (const request of requests) {
      const { ref, by, where, family } = request;
      const target = parseInboxSupersedeRef(ref);
      if (!target) {
        problems.push(`${where} "${ref}" is not an id: write <message id>/<key> (read_thread gives the keys) or <message id>.`);
        continue;
      }
      const message = this.messages.get(target.message_id);
      if (!message || message.author.kind !== "agent") {
        problems.push(`${where} ${ref}: no agent message ${target.message_id}.`);
        continue;
      }
      if (threadId === null || message.thread_id !== threadId) {
        problems.push(
          `${where} ${ref} is in another thread (${message.thread_id}): only questions of the thread this message lands in can be superseded; send with reply_to ${target.message_id} to write in that thread.`,
        );
        continue;
      }
      const records = this.questionRecords(message.id).filter(
        (r) => (target.key === null || r.key === target.key) && (family === null || familyOf(r) === family),
      );
      if (target.key !== null && records.length === 0) {
        const other = this.questionRecords(message.id).some((r) => r.key === target.key);
        problems.push(
          other
            ? `${where} ${ref}: a ${family === "action" ? "action item" : "question"} replaces only a ${family === "action" ? "action item" : "question"}; use supersedes to withdraw it.`
            : `${where} ${ref}: message ${target.message_id} has no question ${target.key}.`,
        );
        continue;
      }
      const resolved = this.closedByArchive(message);
      // An action item the person marked through the timed path (inside its Undo window) is theirs: it is never
      // superseded, so their answer goes as they said (a message-wide id leaves it out). One waiting in their reply
      // draft (`staged`) may never be sent: it is superseded like a picked question, and leaves the draft as Replaced.
      const personMarked = (r: InboxQuestionRecord) =>
        r.kind === "action" && inboxQuestionState(r, resolved) === "picked" && r.action_result?.staged !== true;
      const open = records.filter((r) => isInboxQuestionSupersedable(inboxQuestionState(r, resolved)) && !personMarked(r));
      if (open.length === 0) {
        problems.push(
          target.key !== null && personMarked(records[0]!)
            ? `${where} ${ref}: ${PERSON_MARKED_WORDS}.`
            : target.key === null
              ? `${where} ${ref}: that message has no open question.`
              : `${where} ${ref} is not open (it is ${inboxQuestionState(records[0]!, resolved)}).`,
        );
        continue;
      }
      // A block's own Replaces: line names the replacement exactly, so it wins over the argument.
      if (where === "Replaces:" && by.key !== null) {
        const twice = open.find((record) => claimedBy.has(record.id) && claimedBy.get(record.id) !== by.key);
        if (twice) {
          problems.push(`Replaces: ${twice.id} is named by two questions (${claimedBy.get(twice.id)} and ${by.key}); one question can replace it.`);
          continue;
        }
        for (const record of open) claimedBy.set(record.id, by.key);
      }
      for (const record of open) {
        const replacement = byFor(request, record);
        if (!plan.has(record.id) || replacement.key !== null) plan.set(record.id, replacement);
      }
    }
    if (problems.length > 0) {
      const open = this.openQuestionsOf(threadId);
      const listing =
        threadId === null
          ? "This message would start a new thread, which has no questions yet."
          : open.length > 0
            ? `Open questions in this thread: ${open.map((q) => `${q.id} (${q.prompt})`).join("; ")}.`
            : "This thread has no open questions.";
      throw new InboxError("invalid_supersedes", `${problems.join(" ")} Nothing was sent. ${listing}`, {
        field: "supersedes",
        open_questions: open,
      });
    }
    return plan;
  }

  private targetMessage(messageId: string): InboxMessage {
    const message = this.messages.get(messageId);
    if (!message) throw new InboxError("message_not_found", `No message ${messageId}.`);
    // A message the archive closed refuses; one an agent sent after the archive line is answerable.
    if (this.closedByArchive(message)) {
      throw new InboxError("thread_resolved", "This thread is resolved; reopen it to answer.");
    }
    return message;
  }

  /**
   * The message a Send's answer or skip is on: the reply's own (`raw`
   * absent), or another message of the same thread written by the same agent
   * session (one Send to one session is one reply, approval
   * "inbox-explicit-skip"). Anything else is refused before anything is
   * written; a message the archive closed refuses as the reply's own does.
   */
  private sendMessageOf(reply: InboxMessage, raw: string | undefined, field: string): InboxMessage {
    if (raw === undefined || raw === reply.id) return reply;
    const other = this.messages.get(raw);
    const sameSession =
      other !== undefined &&
      other.thread_id === reply.thread_id &&
      other.author.kind === "agent" &&
      reply.author.kind === "agent" &&
      !!reply.author.session &&
      other.author.session === reply.author.session &&
      (other.author.host ?? "") === (reply.author.host ?? "");
    if (!sameSession) {
      throw new InboxError("validation_error", `${field}: ${raw} is not a message of this thread from the session the reply goes to.`, { field });
    }
    if (this.closedByArchive(other!)) throw new InboxError("thread_resolved", "This thread is resolved; reopen it to answer.");
    return other!;
  }

  /**
   * A Send's `skip` list, checked: each entry a question key (the reply's own
   * message) or `{ message_id?, key }`, on a message `sendMessageOf` accepts,
   * and a question of that message (else refused). Returns the records as
   * they are now; the caller keeps the open ones.
   */
  private planSkips(reply: InboxMessage, raw: unknown): InboxQuestionRecord[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new InboxError("validation_error", "skip: a list of question keys.", { field: "skip" });
    const out = new Map<string, InboxQuestionRecord>();
    raw.forEach((item, index) => {
      const field = `skip[${index}]`;
      const entry = typeof item === "string" ? { key: item } : item;
      if (!entry || typeof entry !== "object" || typeof (entry as { key?: unknown }).key !== "string") {
        throw new InboxError("validation_error", `${field}: a question key, or { message_id, key }.`, { field });
      }
      const messageId = (entry as { message_id?: unknown }).message_id;
      if (messageId !== undefined && typeof messageId !== "string") throw new InboxError("validation_error", `${field}.message_id: a message id.`, { field: `${field}.message_id` });
      const target = this.sendMessageOf(reply, messageId as string | undefined, `${field}.message_id`);
      const key = (entry as { key: string }).key;
      const record = this.questionRecords(target.id).find((r) => r.key === key);
      if (!record) throw new InboxError("question_not_found", `No question ${key} on message ${target.id}.`, { key, message_id: target.id });
      if (record.kind === "action") throw actionNotQuestion(field, key);
      out.set(record.id, record);
    });
    return [...out.values()];
  }

  /**
   * Check every entry against the message's questions and plan the new
   * records. Nothing is written unless every entry passes.
   */
  private planAnswers(
    message: InboxMessage,
    entries: readonly InboxAnswerEntry[],
    mode: "pick" | "send",
    /** Each entry's index in the request's `questions` (a Send's entries are planned per message). */
    indices?: readonly number[],
    options: { unsentOnly?: boolean; confirmFull?: boolean } = {},
  ): { record: InboxQuestionRecord; answer: QuestionAnswer | null | undefined }[] {
    const records = new Map(this.questionRecords(message.id).map((r) => [r.key, r]));
    const seen = new Set<string>();
    const plan: { record: InboxQuestionRecord; answer: QuestionAnswer | null | undefined }[] = [];
    entries.forEach((entry, position) => {
      const index = indices?.[position] ?? position;
      const field = `questions[${index}]`;
      if (!entry || typeof entry !== "object" || typeof entry.key !== "string") {
        throw new InboxError("validation_error", `${field}.key: required.`, { field: `${field}.key` });
      }
      if (seen.has(entry.key)) throw new InboxError("validation_error", `${field}.key: listed twice.`, { field: `${field}.key` });
      seen.add(entry.key);
      if (typeof entry.revision !== "number" || !Number.isInteger(entry.revision) || entry.revision < 0) {
        throw new InboxError("validation_error", `${field}.revision: a non-negative integer is required.`, { field: `${field}.revision` });
      }
      const record = records.get(entry.key);
      if (!record) throw new InboxError("question_not_found", `No question ${entry.key} on message ${message.id}.`, { key: entry.key, message_id: message.id });
      if (record.kind === "action") throw actionNotQuestion(`${field}.key`, entry.key);
      // A superseded question takes no pick and no Send: a pick saved on it stays, never sent.
      if (record.superseded_by) {
        const by = { message_id: record.superseded_by.message_id, key: record.superseded_by.key ?? null };
        throw refusalError({ code: "question_superseded", key: entry.key, superseded_by: by });
      }
      // Mark read closed it: Move back reopens it, pick included.
      if (record.set_aside) {
        throw new InboxError("question_set_aside", `Question ${entry.key} was closed when the thread was marked read; move the thread back to answer it.`, { key: entry.key });
      }
      if (record.revision !== entry.revision) {
        throw refusalError({ code: "question_revision_conflict", key: entry.key, current_revision: record.revision });
      }
      // `unsentOnly` (decision mode): a question a reply already sent takes no new pick (nor a cleared one). Its
      // revision matches when the pick raced the Send (read before it, saved after), and saving it would reopen an
      // answer the agent already has. Without it a sent question takes a pick again, as the thread-state model has
      // it (the window never offers one; adr/implementation/inbox-thread-state.md).
      // A launched session's permission question is always unsent-only: its answer already went to the hook, and
      // a stale window or phone must never reopen it or rewrite what the thread says Claude was told.
      const permission = message.author.kind === "agent" && isInboxPermissionSession(message.author.session);
      const alreadySent = record.answer !== null && record.revision > 0 && record.sent_revision === record.revision;
      if (mode === "pick" && (options.unsentOnly === true || permission) && alreadySent) {
        throw refusalError({ code: "question_already_sent", key: entry.key });
      }
      // The same for a reply that carries its own answer: once the prompt is answered, the reply posts as text
      // and leaves the answer record alone (sendReply refuses it when nothing else is left to send).
      if (mode === "send" && permission && alreadySent) return;
      let answer: QuestionAnswer | null | undefined;
      if (entry.answer === null) {
        if (mode === "send") throw new InboxError("validation_error", `${field}.answer: a Send cannot clear a pick.`, { field: `${field}.answer` });
        answer = null;
      } else if (entry.answer === undefined) {
        if (mode === "pick") throw new InboxError("validation_error", `${field}.answer: a pick needs an answer (or null to clear).`, { field: `${field}.answer` });
        if (record.answer === null) throw new InboxError("validation_error", `${field}.answer: nothing is picked for ${entry.key}.`, { field: `${field}.answer` });
        if (record.sent_revision === record.revision) throw refusalError({ code: "question_already_sent", key: entry.key });
        answer = undefined;
      } else {
        const checked = checkInboxAnswer(record, entry.answer, `${field}.answer`);
        if (!checked.ok) throw refusalError(checked.refusal);
        answer = checked.answer;
        // Full permissions turns every later prompt off: the first time in a session it is picked only with the
        // person's confirmation (`confirm_full`, the window's "Switch this session to Full permissions?").
        // A consent step, not a control: the window that asks can send it.
        if (permission && answer?.selected.includes(INBOX_PERMISSION_FULL) && !(mode === "pick" && options.confirmFull === true) && !this.fullPermissionsUsed(message)) {
          throw new InboxError("validation_error", "Full permissions: confirm it first (confirm_full).", { field: "confirm_full" });
        }
      }
      plan.push({ record, answer });
    });
    return plan;
  }

  /**
   * Whether the session that wrote this permission question already switched to Full permissions from an
   * earlier one in the thread (its answer sent): only the first time asks for `confirm_full`.
   */
  private fullPermissionsUsed(message: InboxMessage): boolean {
    if (message.author.kind !== "agent") return false;
    const session = message.author.session;
    for (const id of this.threadMessageIds(message.thread_id)) {
      if (id === message.id) continue;
      const earlier = this.message(id);
      if (earlier?.author.kind !== "agent" || earlier.author.session !== session) continue;
      for (const record of this.questionRecords(id)) {
        if (record.answer?.selected.includes(INBOX_PERMISSION_FULL) && record.revision > 0 && record.sent_revision === record.revision) return true;
      }
    }
    return false;
  }

  /** Save picks at once (no reply is written): each revision goes up by one. */
  /** `unsentOnly`: refuse a pick on a question a reply already sent (`question_already_sent`), as decision mode asks. */
  /** `confirmFull`: the person confirmed Full permissions on a launched session's permission question. */
  savePicks(messageId: string, entries: readonly InboxAnswerEntry[], options: { unsentOnly?: boolean; confirmFull?: boolean } = {}): InboxQuestion[] {
    const message = this.targetMessage(messageId);
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new InboxError("validation_error", "questions: at least one question is required.", { field: "questions" });
    }
    const plan = this.planAnswers(message, entries, "pick", undefined, options);
    const at = this.stamp();
    for (const { record, answer } of plan) {
      this.appendQuestion(
        {
          ...record,
          answer: answer ?? null,
          revision: record.revision + 1,
          picked_by: answer ? INBOX_PERSON : null,
          picked_at: answer ? at : null,
        },
        at,
      );
    }
    return this.questionsOf(messageId);
  }

  /**
   * The person's Send: optional words plus the listed questions' answers,
   * written as ONE reply in the thread. Replaying the same idempotency key on
   * the same message answers the reply it wrote, and writes nothing.
   */
  /**
   * The agent message a project already has under this idempotency key (what
   * `sendMessage` would replay), so a caller can skip work a replay never
   * uses: probing its live sites again, for one, which could refuse a retry
   * after the first send landed.
   */
  agentMessageByKey(projectId: string, key: string): InboxMessage | null {
    const trimmed = key.trim();
    if (!trimmed) return null;
    for (const message of this.messages.values()) {
      if (message.project_id === projectId && message.idempotency_key === trimmed && message.author.kind === "agent") return message;
    }
    return null;
  }

  /** The person's reply to this message written under this idempotency key, for a replayed Send. */
  replyByKey(messageId: string, key: string): InboxMessage | null {
    if (!this.messages.has(messageId) || !key) return null;
    for (const message of this.messages.values()) {
      if (message.reply_to === messageId && message.author.kind === "person" && message.idempotency_key === key) return message;
    }
    return null;
  }

  sendReply(messageId: string, input: InboxReplyInput): InboxReplyResult {
    const key = typeof input.idempotency_key === "string" ? input.idempotency_key.trim() : "";
    if (!key) throw new InboxError("validation_error", "idempotency_key: required on a Send.", { field: "idempotency_key" });
    const replayed = this.replyByKey(messageId, key);
    if (replayed) return { reply: replayed, questions: this.questionsOf(messageId), replayed: true };
    const message = this.targetMessage(messageId);
    // After the message's own refusals (not found, resolved), so a gone
    // session is only ever the reason when it is the reason.
    if (input.to === null) {
      throw new InboxError("session_not_live", "That session is not live any more: the reply was not sent. Pick another session, or leave it for the next agent.");
    }
    const entries = input.questions ?? [];
    if (!Array.isArray(entries)) throw new InboxError("validation_error", "questions: must be a list.", { field: "questions" });
    const words = typeof input.words === "string" ? input.words : "";
    // One Send to one session is one reply: the answers may be on any of the
    // session's messages in this thread. Each is planned against its own
    // message's questions (revisions included); nothing is written unless
    // every entry passes.
    const byMessage = new Map<string, { entry: InboxAnswerEntry; index: number }[]>();
    entries.forEach((entry, index) => {
      const field = `questions[${index}].message_id`;
      const raw = entry && typeof entry === "object" ? (entry as InboxAnswerEntry).message_id : undefined;
      if (raw !== undefined && typeof raw !== "string") throw new InboxError("validation_error", `${field}: a message id.`, { field });
      const target = this.sendMessageOf(message, raw, field);
      byMessage.set(target.id, [...(byMessage.get(target.id) ?? []), { entry, index }]);
    });
    const plan: { record: InboxQuestionRecord; answer: QuestionAnswer | null | undefined }[] = [];
    for (const [id, list] of byMessage) {
      const target = this.messages.get(id)!;
      plan.push(...this.planAnswers(target, list.map((x) => x.entry), "send", list.map((x) => x.index)));
    }
    const feedback = typeof input.feedback === "string" ? input.feedback.trim() : "";
    // Every listed answer was on an answered permission question (planAnswers leaves those alone) and the reply
    // has no words of its own: say so, rather than "write a reply".
    if (entries.length > 0 && plan.length === 0 && words.trim() === "" && feedback === "" && (input.attachments ?? []).length === 0) {
      throw refusalError({ code: "question_already_sent", key: entries[0]!.key });
    }
    const carried = this.planSentAnnotations(message.thread_id, input.annotation_ids);
    const viewing = this.planViewing(message.thread_id, input.viewing, carried);
    // Skips only what the person listed ("Skip them"), and only while still open.
    const planned = new Set(plan.map((p) => p.record.id));
    const listed = this.planSkips(message, input.skip);
    const skips = listed.filter((r) => !planned.has(r.id) && inboxQuestionState(r, false) === "open");
    const attachments = input.attachments ?? [];
    const verdict = this.planReviewVerdict(message, input.review_verdict, carried);
    // The reviews whose comments this reply carries (code review in the Inbox): marked on the reply, whichever
    // message it answers (a Send puts guide comments on the thread's newest agent message), so the window can
    // tell a review happened in this thread (`inboxThreadHadReview`).
    const reviewCommentsOf = [...new Set(carried.filter((record) => !!record.guide && this.messages.get(record.message_id)?.guide?.review).map((record) => record.message_id))];
    // The action items whose Done or Can't do it waits in the draft go with this Send (approval "inbox-action-items-in-reply").
    const stagedActions = this.planStagedActions(message, input.actions);
    if (plan.length === 0 && skips.length === 0 && stagedActions.length === 0 && words.trim() === "" && feedback === "" && attachments.length === 0) {
      // A Send meant only to skip, whose questions closed meanwhile
      // (answered, replaced, a Mark read), or only to carry action items that left the draft meanwhile
      // (taken back, sent from another window, the agent saw it done with no note): nothing to write, not a refusal.
      if (listed.length > 0 || (Array.isArray(input.actions) && input.actions.length > 0)) {
        throw new InboxError("nothing_to_send", "Nothing is left to send on this message.");
      }
      throw new InboxError("validation_error", "words: write a reply or send at least one answer.", { field: "words" });
    }

    const replyId = inboxId("msg");
    const at = this.stamp();
    const sentIds = new Set([...plan.map((p) => p.record.id), ...skips.map((r) => r.id)]);
    const skipped = skips.map(
      (record) =>
        ({
          ...record,
          // planSkips refuses an action item: every skip is a question's.
          answer: inboxSkipAnswer({ key: record.key, kind: record.kind as QuestionAnswer["kind"], prompt: record.prompt }, { byReply: true }),
          revision: record.revision + 1,
          sent_revision: record.revision + 1,
          sent_reply_id: replyId,
          picked_by: INBOX_PERSON,
          picked_at: at,
        }) satisfies InboxQuestionRecord,
    );
    const answered = plan.map(({ record, answer }) => {
      const nextAnswer = answer === undefined ? record.answer : answer;
      const revision = answer === undefined ? record.revision : record.revision + 1;
      return {
        ...record,
        answer: nextAnswer,
        revision,
        sent_revision: revision,
        sent_reply_id: replyId,
        ...(answer === undefined ? {} : { picked_by: INBOX_PERSON, picked_at: at }),
      } satisfies InboxQuestionRecord;
    });
    const actionsSent = stagedActions.map(
      (record) => ({ ...record, sent_revision: record.revision, sent_reply_id: replyId }) satisfies InboxQuestionRecord,
    );
    const updated = [...answered, ...skipped];
    // Every message the reply answers questions on (the reply's own first
    // when it has none), in thread order, for the answers section.
    const order = this.threadMessages(message.thread_id).map((m) => m.id);
    const touched = new Set([message.id, ...updated.map((r) => r.message_id)]);
    const groups = order
      .filter((id) => touched.has(id))
      .map((id) => {
        const all = this.questionRecords(id);
        const sent = updated.filter((r) => r.message_id === id).map((r) => r.answer as QuestionAnswer);
        const earlier = all
          .filter((r) => !sentIds.has(r.id) && r.answer !== null && r.sent_revision > 0 && r.sent_revision === r.revision)
          .map((r) => r.answer as QuestionAnswer);
        return { message_id: id, questions: all, sent, earlier };
      });
    // The reply says which questions stay open: every one the replied-to
    // message's session asked in this thread (it asked in one message and
    // posted a plain update after it, and the words go to the update), never
    // another session's.
    const asker = message.author.kind === "agent" && message.author.session ? message.author : null;
    const stillOpen = asker
      ? this.threadMessages(message.thread_id)
          .filter(
            (m) =>
              m.author.kind === "agent" &&
              m.author.session === asker.session &&
              (m.author.host ?? "") === (asker.host ?? "") &&
              !this.closedByArchive(m),
          )
          .flatMap((m) => this.questionRecords(m.id))
      : this.questionRecords(message.id);
    // The picks first, then the annotations as Plannotator's feedback text.
    const replyParts = { questions: [], sent: [], earlier: [], messages: groups, replyTo: message.id, words, stillOpen };
    const replyBody = composeInboxReplyBody(replyParts);
    const actionsSection = this.stagedActionsSection(message, actionsSent, stillOpen);
    const body = [withInboxActionsSection(replyBody, actionsSection), feedback]
      .filter((part) => part !== "")
      .join("\n\n");
    // Where the store wrote the still-open sentence: a wake may leave out that paragraph, never one the person typed.
    const composed = inboxReplyStillOpenOf(replyParts);
    const opened = withInboxActionsSection(composed.head, actionsSection.split("\n\n")[0] ?? "");
    const stillOpenAt = opened === "" ? 0 : opened.length + 2;

    // The questions first, so whoever reads the reply finds them already sent.
    // If any of these writes fails, the questions written so far are put back
    // as they were (on disk, repairUnsentAnswers does the same at the next
    // start), so a failed Send never leaves answers "sent" with no reply.
    // Another live session takes it (the asking one ended), or, for more words
    // on a message of the person's own (a thread they started, before the agent
    // answered), the session that message is addressed to now. Stamped on the
    // line, so only that session is handed it and only its delivery settles it.
    const handoff = input.handoff ?? null;
    const to = handoff ? handoff.to : (input.to ?? (message.author.kind === "person" && message.to ? message.to : undefined));
    const recipient = to?.session ?? (message.author.kind === "agent" ? (message.author.session ?? null) : null);
    const typed = normalizeInboxTags(input.tags, recipient);
    // The former owner of a handed-off thread is told (a notice), when its connection wakes it.
    const notice: InboxTag[] =
      handoff?.from && handoff.from.wakes && handoff.from.session !== recipient && !typed.some((t) => t.session === handoff.from!.session)
        ? [{ host: handoff.from.host, session: handoff.from.session, ...(handoff.from.label ? { label: handoff.from.label } : {}), wakes: true, handed_away: true }]
        : [];
    // The sessions the person added to this thread ("Add instead") get every later reply that carries
    // the person's words or files too, tagged again; never the reply's owner or the former owner.
    const carriesWords = words.trim() !== "" || attachments.length > 0;
    const members = carriesWords
      ? this.addedSessions(message.thread_id).filter(
          (m) => m.session !== recipient && m.session !== handoff?.from?.session && !typed.some((t) => t.session === m.session),
        )
      : [];
    const tags = [...typed, ...members, ...notice];
    if (composed.stillOpen && body.startsWith(composed.stillOpen, stillOpenAt)) this.stillOpenWritten.set(replyId, { line: composed.stillOpen, at: stillOpenAt });
    const reply: InboxMessage = {
      id: replyId,
      project_id: message.project_id,
      thread_id: message.thread_id,
      reply_to: message.id,
      author: { kind: "person" },
      subject: null,
      body,
      created_at: at,
      resolved_at: null,
      idempotency_key: key,
      ...(input.by_guest ? { by_guest: true as const } : {}),
      ...(to ? { to: { host: to.host, session: to.session } } : {}),
      ...(to && input.took_over ? { took_over: true } : {}),
      ...(attachments.length > 0 ? { attachments: attachments.map((attachment) => ({ ...attachment, sent_at: at })) } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(handoff
        ? { handoff: { from: handoff.from ? { host: handoff.from.host, session: handoff.from.session } : null, ...(handoff.label ? { label: handoff.label } : {}), at } }
        : {}),
      ...(verdict ? { review_verdict: verdict } : {}),
      ...(viewing ? { viewing } : {}),
      ...(reviewCommentsOf.length > 0 ? { review_comments_of: reviewCommentsOf } : {}),
    };
    // A hand-off still inside its Undo window in this thread goes first (approval "inbox-tag-handoff"):
    // a later reply never reaches the new owner before the hand-off does, and Undo can no longer
    // send the thread back past a reply the new owner already has.
    this.settleHandoffsIn(message.thread_id);
    try {
      for (const record of [...updated, ...actionsSent]) this.appendQuestion(record, at);
      for (const record of carried) this.appendAnnotation({ ...record, sent_reply_id: replyId, updated_at: at }, at);
      this.appendMessage(reply, at);
    } catch (error) {
      for (const { record } of plan) this.restoreQuestion(record);
      for (const record of skips) this.restoreQuestion(record);
      for (const record of stagedActions) this.restoreQuestion(record);
      for (const record of carried) this.restoreAnnotation(record);
      throw error;
    }
    this.endSnooze(message.thread_id);
    // The person's words as typed: never the picks, the action items or the feedback the Send adds.
    this.tagThreadCards(reply.thread_id, words);
    return { reply, questions: this.questionsOf(message.id), replayed: false };
  }

  /**
   * What a reply says was on screen (`InboxReplyInput.viewing`): the name and the message read from the thread's own
   * file, never from the window. Undefined for a file not of this thread, and for a file the reply carries a comment
   * on: its "Feedback on the attached files" names it already.
   */
  private planViewing(threadId: string, raw: unknown, carried: readonly InboxAnnotationRecord[]): InboxReplyViewing | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const input = raw as { attachment_id?: unknown; time?: unknown; page?: unknown; as_sent?: unknown };
    if (typeof input.attachment_id !== "string") return undefined;
    const hit = this.attachment(input.attachment_id);
    if (!hit || hit.message.thread_id !== threadId || carried.some((record) => record.attachment_id === hit.attachment.id)) return undefined;
    const time = typeof input.time === "string" ? inboxViewingText(input.time) : "";
    const page = typeof input.page === "string" ? inboxViewingText(input.page) : "";
    return {
      name: hit.attachment.name,
      message_id: hit.message.id,
      ...(INBOX_VIEWING_TIME.test(time) ? { time } : {}),
      ...(page ? { page } : {}),
      ...(input.as_sent === true ? { as_sent: true as const } : {}),
    };
  }

  /**
   * A reply's verdict on a review (`review_verdict`), checked: only on a reply
   * to a message whose guide is a review, `approved` or `changes_requested`.
   * Counts the review's comments the reply carries. Undefined without one.
   */
  private planReviewVerdict(message: InboxMessage, raw: unknown, carried: readonly InboxAnnotationRecord[]): InboxReviewVerdictRecord | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (!message.guide?.review) throw new InboxError("validation_error", "review_verdict: this message carries no review.", { field: "review_verdict" });
    if (raw !== "approved" && raw !== "changes_requested") {
      throw new InboxError("validation_error", 'review_verdict: "approved" or "changes_requested".', { field: "review_verdict" });
    }
    const comments = carried.filter((record) => record.message_id === message.id && !!record.guide).length;
    return { of: message.id, verdict: raw, comments };
  }

  /** The action items a Send names (`actions`) that wait in the person's draft: each of this thread and session, else refused. */
  private planStagedActions(message: InboxMessage, raw: unknown): InboxQuestionRecord[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new InboxError("validation_error", "actions: a list of { key, message_id? }.", { field: "actions" });
    const out: InboxQuestionRecord[] = [];
    for (const [index, entry] of raw.entries()) {
      const field = `actions[${index}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new InboxError("validation_error", `${field}: { key, message_id? }.`, { field });
      const e = entry as { message_id?: unknown; key?: unknown };
      if (e.message_id !== undefined && typeof e.message_id !== "string") throw new InboxError("validation_error", `${field}.message_id: a message id.`, { field: `${field}.message_id` });
      if (typeof e.key !== "string") throw new InboxError("validation_error", `${field}.key: an action item's key.`, { field: `${field}.key` });
      // An action item on a message the archive closed is no longer in the draft (it reads closed): left out, as
      // one taken back is, so a window that has not caught up never has its Send refused for it.
      const other = e.message_id === undefined ? undefined : this.messages.get(e.message_id as string);
      if (other && other.thread_id === message.thread_id && this.closedByArchive(other)) continue;
      const target = this.sendMessageOf(message, e.message_id as string | undefined, `${field}.message_id`);
      const record = this.questionRecords(target.id).find((r) => r.key === e.key);
      if (!record) throw new InboxError("question_not_found", `${field}: message ${target.id} has no action item ${e.key}.`, { field, key: e.key });
      if (record.kind !== "action") throw new InboxError("validation_error", `${field}: ${e.key} is a question, not an action item.`, { field, key: e.key });
      const wire = { ...record, state: inboxQuestionState(record, false) };
      if (!inboxActionInDraft(wire) || out.some((r) => r.id === record.id)) continue;
      out.push(record);
    }
    return out;
  }

  /** The reply's "Action items you asked for" for the action items it sends, one group per asking message, in thread order. */
  private stagedActionsSection(message: InboxMessage, sent: readonly InboxQuestionRecord[], stillOpen: readonly InboxQuestionRecord[]): string {
    if (sent.length === 0) return "";
    const sentIds = new Set(sent.map((r) => r.id));
    const order = this.threadMessages(message.thread_id).map((m) => m.id);
    const groups = order
      .filter((id) => sent.some((r) => r.message_id === id))
      .map((id) => ({
        message_id: id,
        reported: sent.filter((r) => r.message_id === id),
        all: this.questionRecords(id).filter((r) => r.kind === "action").map((r) => sent.find((x) => x.id === r.id) ?? r),
      }));
    // The asking session's action items still open (its questions' still-open line is the reply's own), each
    // named with its message when that is not the one the reply answers: A1 is per message, so never two items.
    const open = stillOpen
      .filter((r) => r.kind === "action" && !sentIds.has(r.id) && inboxQuestionState(r, false) === "open")
      .map((r) => ({ kind: "action" as const, position: r.position, prompt: r.prompt, ...(r.message_id ? { message_id: r.message_id } : {}) }));
    return composeInboxActionsSection({ groups, stillOpen: open, replyTo: message.id });
  }

  /**
   * The person's Re-ask (approval "inbox-reask"): a note to the session that
   * wrote `messageId`, asking it to ask its questions still open in this
   * thread again, together in one new message (with `Replaces:` lines, or
   * `supersedes` for those that no longer apply). Picks the person made and
   * did not send go with the note as answers (marked sent with it); the
   * others stay open until the agent replaces them. The note is the person's
   * reply: delivered like one, and the row sits in Sent while it is the
   * thread's last message. One note per session: a thread where several
   * sessions asked gets one Re-ask per session from the window.
   */
  sendReask(messageId: string, input: InboxReaskInput): InboxReplyResult {
    const key = typeof input.idempotency_key === "string" ? input.idempotency_key.trim() : "";
    if (!key) throw new InboxError("validation_error", "idempotency_key: required on a Re-ask.", { field: "idempotency_key" });
    const replayed = this.replyByKey(messageId, key);
    if (replayed) {
      if (!replayed.reask?.length) throw new InboxError("idempotency_key_reused", "That idempotency_key already sent a reply, not a Re-ask.");
      return { reply: replayed, questions: this.questionsOf(messageId), replayed: true };
    }
    const message = this.targetMessage(messageId);
    if (input.to === null) {
      throw new InboxError("session_not_live", "That session is not live any more: nothing was sent. Pick another session, or leave it for the next agent.");
    }
    if (message.author.kind !== "agent") {
      throw new InboxError("validation_error", "Re-ask goes to an agent's message: the questions it asked.", { field: "message_id" });
    }
    // A launched session's permission prompt is never asked again: its hook waits on this one question,
    // and a Re-ask would send the person's unsent picks without their Send.
    if (isInboxPermissionSession(message.author.session)) {
      throw new InboxError("validation_error", "A permission prompt is not asked again: answer it here, or in Terminal.", { field: "message_id" });
    }
    // The questions this session asked in the thread (only this message's
    // when the agent named no session), not one the archive closed.
    const asker = message.author.session ? message.author : null;
    const records = this.threadMessages(message.thread_id)
      .filter((m) =>
        m.author.kind === "agent" && asker
          ? m.author.session === asker.session && (m.author.host ?? "") === (asker.host ?? "")
          : m.id === message.id,
      )
      .filter((m) => !this.closedByArchive(m))
      // Open action items are asked again too (owner, #2059); one the person marked inside its Undo window is not open.
      .flatMap((m) => this.questionRecords(m.id));
    const picked = records.filter((r) => inboxQuestionState(r, false) === "picked" && r.answer !== null);
    const open = records.filter((r) => inboxQuestionState(r, false) === "open");
    if (open.length === 0) throw new InboxError("nothing_to_reask", "No open question or action item is left to ask again.");

    const replyId = inboxId("msg");
    const at = this.stamp();
    // The picks go with the note, as a Send would send them.
    const answered = picked.map(
      (record) => ({ ...record, sent_revision: record.revision, sent_reply_id: replyId }) satisfies InboxQuestionRecord,
    );
    const to = input.to ?? undefined;
    // Sent to another session because the one that asked ended: the note says whose questions they are.
    const redirected = to && asker && to.session !== asker.session;
    const body = composeInboxReaskBody({
      reask: open,
      answered: picked.map((record) => ({ record, answer: record.answer as QuestionAnswer })),
      noteId: replyId,
      askedBy: redirected ? (INBOX_HOST_NAMES[asker.host ?? ""] ?? "agent") : null,
    });
    const note: InboxMessage = {
      id: replyId,
      project_id: message.project_id,
      thread_id: message.thread_id,
      reply_to: message.id,
      author: { kind: "person" },
      subject: null,
      body,
      created_at: at,
      resolved_at: null,
      idempotency_key: key,
      reask: open.map((r) => r.id),
      ...(input.by_guest ? { by_guest: true as const } : {}),
      ...(to ? { to: { host: to.host, session: to.session } } : {}),
    };
    try {
      for (const record of answered) this.appendQuestion(record, at);
      this.appendMessage(note, at);
    } catch (error) {
      for (const record of picked) this.restoreQuestion(record);
      throw error;
    }
    this.endSnooze(message.thread_id);
    return { reply: note, questions: this.questionsOf(message.id), replayed: false };
  }

  /**
   * Rule 2a (approval "inbox-reask"): a thread's messages (in order) sit in
   * Sent only while every question open in them is listed in a Re-ask note
   * that still waits. A note waits until the session it went to (its `to`,
   * else the session of the message it answers) writes again, and only while
   * one of the questions it lists is still open. Another session's new
   * question, or the last listed one answered, superseded or closed, ends it.
   */
  /**
   * The ids a still-waiting Re-ask note sent to `author` (its `to`: the
   * person redirected it because the asker ended) lists: that session may
   * mark those action items done, as the asker could. A note stops granting
   * once that session wrote in the thread after it.
   */
  private reaskGrants(threadId: string, author: Extract<InboxAuthor, { kind: "agent" }>): Set<string> {
    const out = new Set<string>();
    const messages = this.threadMessages(threadId);
    const same = (to: { host?: string; session?: string } | null | undefined): boolean =>
      !!to && (to.session ?? null) === (author.session ?? null) && (to.host ?? "") === (author.host ?? "");
    messages.forEach((note, index) => {
      if (note.author.kind !== "person" || (note.reask?.length ?? 0) === 0 || !same(note.to)) return;
      const wrote = messages
        .slice(index + 1)
        .some((m) => m.author.kind === "agent" && same({ host: m.author.host ?? "", session: m.author.session ?? undefined }));
      if (!wrote) for (const id of note.reask!) out.add(id);
    });
    return out;
  }

  private reaskWaiting(messages: readonly InboxMessage[]): boolean {
    // Most threads have no Re-ask note: they cost nothing more.
    if (!messages.some((m) => m.author.kind === "person" && (m.reask?.length ?? 0) > 0)) return false;
    const states = new Map<string, string>();
    for (const m of messages) if (m.author.kind === "agent") for (const q of this.questionsOf(m.id)) states.set(`${m.id}/${q.key}`, q.state);
    const listed = this.reaskListedIn(messages);
    const open = [...states].filter(([, state]) => state === "open").map(([id]) => id);
    return open.length > 0 && open.every((id) => listed.has(id));
  }

  /**
   * The questions (`<message id>/<key>`) a Re-ask note in these messages lists
   * while the note still waits: the session it went to (its `to`, else the
   * session of the message it answers) has not written since. Per note, so
   * per session: another session's questions in the same thread are not in it.
   */
  private reaskListedIn(messages: readonly InboxMessage[], options: { live?: boolean } = {}): Set<string> {
    const listed = new Set<string>();
    const presence = this.deliveryPresence;
    messages.forEach((note, index) => {
      if (note.author.kind !== "person" || (note.reask?.length ?? 0) === 0) return;
      const asked = note.reply_to ? this.messages.get(note.reply_to) : undefined;
      const by = note.to ?? (asked?.author.kind === "agent" ? { host: asked.author.host ?? "", session: asked.author.session } : null);
      if (!by) return;
      const wrote = messages
        .slice(index + 1)
        .some((m) => m.author.kind === "agent" && m.author.session === by.session && (m.author.host ?? "") === (by.host ?? ""));
      if (wrote) return;
      // `live`: only while that session is still there (the sessions route's grace). A note to a session that ended
      // waits on nobody who will ask again. Only a session that wakes can be told ended (the thread's rule): the note
      // went `to` a live session, or the asking message came through a connection that wakes its session. An agent
      // that reads the Inbox through MCP may read the thread at any time, so its note always waits.
      const wakes = note.to ? true : asked?.wakes === true;
      if (options.live && presence && by.session && wakes && !presence.askerLive(by.session)) return;
      for (const id of note.reask!) listed.add(id);
    });
    return listed;
  }

  /**
   * The questions of a thread a still-waiting Re-ask note lists: the agent is
   * about to ask them again, so decision mode leaves those still open out (the
   * rest of the thread, another session's questions included, stays).
   *
   * A note waits exactly as the list's rule 2a reads it: until the session it
   * went to writes in the thread again, and only for what it lists that is
   * still open (answered, superseded, set aside or archived, a question is no
   * longer hidden; one the person picks since shows, waiting for its Send).
   * One bound more than the list: only while that session is still there
   * (presence's `askerLive`, with its grace), so a note to a session that ended
   * never hides its questions for good; the list's row may still read Sent then.
   * That bound holds only for a session that wakes (the note went `to` a live
   * session, or the asked message has `wakes`), the one kind that can be told
   * ended: an MCP-only agent's note waits until it writes again. With no
   * presence (tests, tools) every session counts as there.
   */
  reaskListedIds(threadId: string): Set<string> {
    const messages = this.threadMessages(threadId);
    if (!messages.some((m) => m.author.kind === "person" && (m.reask?.length ?? 0) > 0)) return new Set();
    return this.reaskListedIn(messages, { live: true });
  }

  /**
   * Every question record of every project, unordered: for one-pass counts.
   * A live view of the store's map: iterate it at once, never hold it across
   * a write or a reload().
   */
  allQuestionRecords(): Iterable<Readonly<InboxQuestionRecord>> {
    return this.questions.values();
  }

  /** The stored question record (`<message id>/<key>`). */
  questionRecord(id: string): InboxQuestionRecord | null {
    return this.questions.get(id) ?? null;
  }

  /** Every question record of a project, in seq order of their messages. */
  questionRecordsOf(projectId: string): InboxQuestionRecord[] {
    const out: InboxQuestionRecord[] = [];
    for (const record of this.questions.values()) if (record.project_id === projectId) out.push(record);
    return out.sort(
      (a, b) => (this.messageSeq.get(a.message_id) ?? 0) - (this.messageSeq.get(b.message_id) ?? 0) || a.position - b.position,
    );
  }

  /**
   * The person's reviewed ticks on the guide a message carries (one per
   * section; padded with false or cut to the guide's sections). No write when
   * nothing changed.
   */
  saveGuideReviewed(messageId: string, reviewed: unknown): boolean[] {
    const message = this.messages.get(messageId);
    if (!message) throw new InboxError("message_not_found", `No message ${messageId}.`);
    if (!message.guide) throw new InboxError("guide_not_found", "This message carries no guided review.");
    if (!Array.isArray(reviewed) || reviewed.some((value) => typeof value !== "boolean")) {
      throw new InboxError("validation_error", "reviewed: a list of booleans, one per section.", { field: "reviewed" });
    }
    const next = Array.from({ length: message.guide.sections }, (_, i) => reviewed[i] === true);
    if (JSON.stringify(next) !== JSON.stringify(message.guide_reviewed ?? null)) {
      const at = this.stamp();
      this.appendMessage({ ...message, guide_reviewed: next }, at);
    }
    return next;
  }

  /**
   * The files the person ticked Viewed in a review (code review in the Inbox):
   * each a file of the review's patch, once, in the order given. No write
   * when nothing changed. Only on a message whose guide is a review.
   */
  saveGuideViewed(messageId: string, viewed: unknown, files: readonly string[]): string[] {
    const message = this.messages.get(messageId);
    if (!message) throw new InboxError("message_not_found", `No message ${messageId}.`);
    if (!message.guide?.review) throw new InboxError("guide_not_found", "This message carries no review.");
    if (!Array.isArray(viewed) || viewed.some((value) => typeof value !== "string")) {
      throw new InboxError("validation_error", "viewed: a list of the review's file paths.", { field: "viewed" });
    }
    const known = new Set(files);
    const unknown = (viewed as string[]).find((path) => !known.has(path));
    if (unknown !== undefined) throw new InboxError("validation_error", `viewed: ${JSON.stringify(unknown)} is not a file of this review.`, { field: "viewed" });
    const next = [...new Set(viewed as string[])];
    if (JSON.stringify(next) !== JSON.stringify(message.guide_viewed ?? [])) {
      const at = this.stamp();
      this.appendMessage({ ...message, guide_viewed: next }, at);
    }
    return next;
  }

  /**
   * Resolve (or reopen) the thread a message belongs to. `by`: whose Archive
   * it is. Only the person's ends a snooze (approval "inbox-snooze": nothing an
   * agent writes ends it); an agent's `resolve_message` leaves the snooze, so
   * a thread the agent archives and then writes in again stays snoozed.
   */
  resolveThread(messageId: string, resolved: boolean, by: "person" | "agent" = "agent"): InboxThreadSummary {
    const message = this.messages.get(messageId);
    if (!message) throw new InboxError("message_not_found", `No message ${messageId}.`);
    const root = this.messages.get(message.thread_id);
    if (!root) throw new InboxError("message_not_found", `No thread ${message.thread_id}.`);
    const isResolved = root.resolved_at !== null;
    if (isResolved !== resolved) {
      const at = this.stamp();
      // Unarchive drops a Mark read made while the thread was archived (on
      // what came back): it covered only the part after the archive line, and
      // must not hold the reopened thread in Quiet over the questions the
      // archive had closed. Written in the same root line, so a replay agrees.
      const archiveSeq = this.archiveSeq(root.id);
      const readWhileArchived = !resolved && archiveSeq !== null && root.person_read_seq != null && root.person_read_seq > archiveSeq;
      this.appendMessage(
        {
          ...root,
          resolved_at: resolved ? at : null,
          ...(readWhileArchived ? { person_read_seq: null, person_read_at: null, person_seen_before_read: undefined } : {}),
        },
        at,
      );
    }
    if (resolved && by === "person") this.endSnooze(root.id);
    if (!resolved && isResolved) this.endLapsedSnooze(root.id);
    return this.threadSummary(root.id)!;
  }

  // ─────────────────────────── attachments and annotations ───────────────────────────

  /** An attachment by its id: the record and the message that carries it. */
  attachment(attachmentId: string): InboxAttachmentHit | null {
    for (const message of this.messages.values()) {
      // An image the body shows is a file of the thread too, reached by the same id routes.
      const attachment = message.attachments?.find((a) => a.id === attachmentId) ?? message.inline_images?.find((a) => a.id === attachmentId);
      if (attachment) return { attachment, message };
    }
    return null;
  }

  /** The thread's attachments, message by message, in thread order. */
  threadAttachments(threadId: string): InboxAttachmentHit[] {
    return this.threadMessages(threadId).flatMap((message) => (message.attachments ?? []).map((attachment) => ({ attachment, message })));
  }

  /** The images the thread's messages show, captured as files (`inline_images`), message by message, each in text order. */
  threadInlineImages(threadId: string): { attachment: InboxInlineImage; message: InboxMessage }[] {
    return this.threadMessages(threadId).flatMap((message) => (message.inline_images ?? []).map((attachment) => ({ attachment, message })));
  }

  /**
   * The thread's messages (an agent's or the person's) with images their body
   * shows that have no captured record yet, and the sources missing, in text
   * order: a message sent before capture existed, an image written after the
   * send, one past the send's 64, one a read refused for a moment. `refsOf`
   * lists a body's images (inline-images.ts). A message with no local image
   * is never listed.
   */
  imageCaptureGaps(threadId: string, refsOf: (body: string) => readonly string[]): { message: InboxMessage; refs: string[] }[] {
    const out: { message: InboxMessage; refs: string[] }[] = [];
    for (const message of this.threadMessages(threadId)) {
      const refs = refsOf(message.body);
      if (refs.length === 0) continue;
      const have = new Set((message.inline_images ?? []).map((image) => image.ref));
      const missing = refs.filter((ref) => !have.has(ref));
      if (missing.length > 0) out.push({ message, refs: missing });
    }
    return out;
  }

  /**
   * Keep images captured on a later read of the thread: one more line for the
   * message, its latest snapshot with these records added after the ones it
   * has (a source it already has is skipped), in `order` when given. Nothing is written when nothing
   * is new, except that a message with no `inline_images` at all gets its
   * (possibly empty) list once. Returns the message as it is now.
   */
  addCapturedImages(messageId: string, images: readonly InboxInlineImage[], order?: readonly string[]): InboxMessage {
    const message = this.messages.get(messageId);
    if (!message) throw new InboxError("message_not_found", `No message ${messageId}.`);
    const have = new Set((message.inline_images ?? []).map((image) => image.ref));
    const added = images.filter((image) => !have.has(image.ref) && have.add(image.ref));
    if (added.length === 0 && message.inline_images !== undefined) return message;
    const merged = [...(message.inline_images ?? []), ...added];
    // In the order the body shows them (`order`: its sources in text order), when given.
    if (order) {
      const rank = new Map(order.map((ref, index) => [ref, index]));
      merged.sort((a, b) => (rank.get(a.ref) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.ref) ?? Number.MAX_SAFE_INTEGER));
    }
    const next: InboxMessage = { ...message, inline_images: merged };
    this.appendMessage(next, this.stamp());
    return next;
  }

  /** The person's annotations in a thread still waiting for a Send (not removed, not sent). */
  pendingAnnotations(threadId: string): InboxAnnotationRecord[] {
    const out: InboxAnnotationRecord[] = [];
    for (const record of this.annotations.values()) {
      if (record.thread_id === threadId && record.removed_at === null && record.sent_reply_id === null) out.push(record);
    }
    return out.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  /**
   * The person's comments on files in a thread that a Send already carried: what the file view lists as earlier
   * comments (`earlierCommentsOn` in packages/inbox/earlierComments.ts narrows them to the file open). A sent record
   * is never edited, so its `updated_at` is its reply's `created_at`. Comments on a guided review or a message's text are not on a file.
   */
  earlierAnnotations(threadId: string): InboxAnnotationRecord[] {
    const out: InboxAnnotationRecord[] = [];
    for (const record of this.annotations.values()) {
      if (record.thread_id !== threadId || record.removed_at !== null || record.sent_reply_id === null) continue;
      if (record.guide || record.message) continue;
      if (this.messages.get(record.sent_reply_id)?.author.kind !== "person") continue;
      out.push(record);
    }
    return out.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  /**
   * Save an annotation on an attachment's version (a new one, or an edit of
   * one still waiting). Its key is the attachment's path and the version:
   * "current" (the file on disk, whatever its bytes are now) or the sent
   * blob's hash.
   */
  saveAnnotation(input: { attachment_id: string; version: unknown; annotation: unknown }): InboxAnnotationRecord {
    const hit = this.attachment(input.attachment_id);
    if (!hit) throw new InboxError("attachment_not_found", `No attachment ${input.attachment_id}.`);
    // A PDF and a plain file are downloads: there is nothing in the window to comment on.
    if (!isInboxAnnotatableKind(hit.attachment.kind)) {
      throw new InboxError("annotation_not_allowed", `annotation: ${hit.attachment.name} is offered as a download; it takes no annotations.`, { field: "attachment_id" });
    }
    if (!isInboxAnnotationVersion(input.version)) {
      throw new InboxError("validation_error", "version: \"current\" or the sent version's sha256.", { field: "version" });
    }
    if (input.version !== INBOX_ANNOTATION_CURRENT && input.version !== hit.attachment.sent_sha256) {
      throw new InboxError("validation_error", "version: not a version of this attachment.", { field: "version" });
    }
    const annotation = input.annotation;
    if (!annotation || typeof annotation !== "object" || Array.isArray(annotation)) {
      throw new InboxError("validation_error", "annotation: an object.", { field: "annotation" });
    }
    const id = (annotation as Record<string, unknown>).id;
    if (!isInboxAnnotationId(id)) throw new InboxError("validation_error", "annotation.id: a short id.", { field: "annotation.id" });
    // A comment on a video is at a moment: `blockId: "video"` and `inboxVideo.time` in seconds (contract 4).
    if (readInboxAttachmentKind(hit.attachment.kind) === "video") {
      if ((annotation as Record<string, unknown>).blockId !== INBOX_VIDEO_BLOCK_ID) {
        throw new InboxError("validation_error", `annotation.blockId: "${INBOX_VIDEO_BLOCK_ID}" on a video.`, { field: "annotation.blockId" });
      }
      if (readInboxVideoTime(annotation) === null) {
        throw new InboxError("validation_error", "annotation.inboxVideo.time: the moment in seconds from the start (a number, 0 or more).", { field: "annotation.inboxVideo" });
      }
    }
    if (this.closedByArchive(hit.message)) throw new InboxError("thread_resolved", "This thread is resolved; reopen it to annotate.");
    const existing = this.annotations.get(id);
    // A draft's key is the file's path and the version, so an annotation
    // made through one attachment of a file edits from another of the same file.
    if (existing && (existing.guide || existing.message || existing.live || existing.path !== hit.attachment.path || existing.version !== input.version || existing.thread_id !== hit.message.thread_id)) {
      throw new InboxError("validation_error", "annotation.id: already used on another file or version.", { field: "annotation.id" });
    }
    if (existing && (existing.sent_reply_id !== null || existing.removed_at !== null)) {
      throw new InboxError("annotation_closed", "This annotation was already sent or removed.");
    }
    const at = this.stamp();
    const record: InboxAnnotationRecord = {
      id,
      project_id: hit.message.project_id,
      thread_id: hit.message.thread_id,
      message_id: existing?.message_id ?? hit.message.id,
      attachment_id: existing?.attachment_id ?? hit.attachment.id,
      path: hit.attachment.path,
      version: input.version,
      // `exportLocation` is the exporter's line the window computes at Send
      // (a video comment's "At 1:42 …"): never taken from a client.
      annotation: withoutExportLocation(annotation as Record<string, unknown>),
      created_at: existing?.created_at ?? at,
      updated_at: at,
      removed_at: null,
      sent_reply_id: null,
    };
    this.appendAnnotation(record, at);
    return record;
  }

  /**
   * Save a comment on the diff of the guided review a message carries (a new
   * one, or an edit of one still waiting): the review app's line comment
   * (`CodeAnnotation`) on a file of the guide's patch, one side, a line range.
   * Its key is the message and the file; `version` is the guide snapshot's
   * sha256 and `attachment_id` is empty. Sent with the reply like an
   * attachment's annotation, as the review app's export. A global comment
   * (`scope: "general"`, on the whole review) is the review app's general
   * comment: no file, no lines (its "" / 0 / 0 sentinels), and words.
   */
  saveGuideAnnotation(messageId: string, annotation: unknown): InboxAnnotationRecord {
    const message = this.messages.get(messageId);
    if (!message) throw new InboxError("message_not_found", `No message ${messageId}.`);
    if (!message.guide) throw new InboxError("guide_not_found", "This message carries no guided review.");
    if (!annotation || typeof annotation !== "object" || Array.isArray(annotation)) {
      throw new InboxError("validation_error", "annotation: an object.", { field: "annotation" });
    }
    const fields = annotation as Record<string, unknown>;
    const id = fields.id;
    if (!isInboxAnnotationId(id)) throw new InboxError("validation_error", "annotation.id: a short id.", { field: "annotation.id" });
    if (fields.scope === "general") return this.saveGuideGlobalComment(message, message.guide, id, fields);
    const file = fields.filePath;
    if (typeof file !== "string" || file === "") throw new InboxError("validation_error", "annotation.filePath: a file of the guide's patch.", { field: "annotation.filePath" });
    const diff = this.guideFiles(message.guide.sha256).get(file);
    if (!diff) {
      throw new InboxError("validation_error", `annotation.filePath: ${file} is not in the guided review's patch.`, { field: "annotation.filePath" });
    }
    const side = fields.side;
    if (side !== "old" && side !== "new") throw new InboxError("validation_error", 'annotation.side: "old" or "new".', { field: "annotation.side" });
    const start = fields.lineStart;
    const end = fields.lineEnd;
    if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) < 1 || (end as number) < (start as number)) {
      throw new InboxError("validation_error", "annotation.lineStart / lineEnd: line numbers, start first.", { field: "annotation.lineStart" });
    }
    // A line an expand arrow opened is outside every hunk by its nature; the file must still be one the patch changes.
    if (fields.outsideDiff !== true && !isLineRangeInPatch(diff.patch, start as number, end as number, side)) {
      const range = start === end ? `line ${start}` : `lines ${start}-${end}`;
      throw new InboxError("validation_error", `annotation.lineStart / lineEnd: ${range} on the ${side} side of ${file} is not in one hunk of the guided review's patch.`, { field: "annotation.lineStart" });
    }
    if (fields.scope !== undefined && fields.scope !== "line") {
      throw new InboxError("validation_error", 'annotation.scope: a guided-review comment is on lines ("line") or on the whole review ("general").', { field: "annotation.scope" });
    }
    if (fields.text !== undefined && typeof fields.text !== "string") throw new InboxError("validation_error", "annotation.text: a string.", { field: "annotation.text" });
    const kept = guideCommentFields(fields, "line");
    if (this.closedByArchive(message)) throw new InboxError("thread_resolved", "This thread is resolved; reopen it to annotate.");
    const existing = this.annotations.get(id);
    if (existing && (!existing.guide || existing.message_id !== message.id || existing.path !== file)) {
      throw new InboxError("validation_error", "annotation.id: already used on another file.", { field: "annotation.id" });
    }
    if (existing && (existing.sent_reply_id !== null || existing.removed_at !== null)) {
      throw new InboxError("annotation_closed", "This annotation was already sent or removed.");
    }
    const at = this.stamp();
    const record: InboxAnnotationRecord = {
      id,
      project_id: message.project_id,
      thread_id: message.thread_id,
      message_id: message.id,
      attachment_id: "",
      path: file,
      version: message.guide.sha256,
      guide: { title: message.guide.title, file, side, line_start: start as number, line_end: end as number },
      annotation: { ...kept, filePath: file, lineStart: start, lineEnd: end, side },
      created_at: existing?.created_at ?? at,
      updated_at: at,
      removed_at: null,
      sent_reply_id: null,
    };
    this.appendAnnotation(record, at);
    return record;
  }

  /**
   * A global comment on a guided review (saveGuideAnnotation with `scope:
   * "general"`): words on the whole review, kept with the thread's other
   * comments until a Send. It names no file and no lines; the record's
   * `path` is "" and its `guide` carries the review app's sentinels.
   */
  private saveGuideGlobalComment(message: InboxMessage, guide: NonNullable<InboxMessage["guide"]>, id: string, fields: Record<string, unknown>): InboxAnnotationRecord {
    if (fields.filePath !== undefined && fields.filePath !== "") {
      throw new InboxError("validation_error", "annotation.filePath: a global comment is on the whole review, on no file.", { field: "annotation.filePath" });
    }
    const text = fields.text;
    if (typeof text !== "string" || text.trim() === "" || text.length > INBOX_MESSAGE_COMMENT_TEXT_MAX) {
      throw new InboxError("validation_error", `annotation.text: the comment (1 to ${INBOX_MESSAGE_COMMENT_TEXT_MAX} characters).`, { field: "annotation.text" });
    }
    const kept = guideCommentFields(fields, "general");
    if (this.closedByArchive(message)) throw new InboxError("thread_resolved", "This thread is resolved; reopen it to annotate.");
    const existing = this.annotations.get(id);
    if (existing && (!existing.guide || existing.message_id !== message.id || existing.guide.scope !== "general")) {
      throw new InboxError("validation_error", "annotation.id: already used on another file.", { field: "annotation.id" });
    }
    if (existing && (existing.sent_reply_id !== null || existing.removed_at !== null)) {
      throw new InboxError("annotation_closed", "This annotation was already sent or removed.");
    }
    const at = this.stamp();
    const record: InboxAnnotationRecord = {
      id,
      project_id: message.project_id,
      thread_id: message.thread_id,
      message_id: message.id,
      attachment_id: "",
      path: "",
      version: guide.sha256,
      guide: { title: guide.title, file: "", side: "new", line_start: 0, line_end: 0, scope: "general" },
      // The review app's general comment: no file, no lines, whatever the client sent for them.
      annotation: { ...kept, scope: "general", filePath: "", lineStart: 0, lineEnd: 0, side: "new" },
      created_at: existing?.created_at ?? at,
      updated_at: at,
      removed_at: null,
      sent_reply_id: null,
    };
    this.appendAnnotation(record, at);
    return record;
  }

  /**
   * Save a comment on the text of an agent's message (a new one, or an edit
   * of one still waiting; approval "inbox-message-comments", 2026-10-19):
   * Plannotator's text-selection annotation, `originalText` the exact words
   * the person selected, or a comment on a rendered diagram part, with
   * `diagramAnchor` and the part's label as `originalText`, or a Delete on
   * selected words (`type` "DELETION", no words of its own needed; approval
   * "inbox-toolbar-delete"). Only an agent's
   * message takes one, and only while it can be answered (an archive closes
   * the messages before its line). The
   * record's key is the message: `path` is its id, `version` "current", and
   * `message` names it. Sent with the reply like an attachment's annotation.
   */
  saveMessageAnnotation(messageId: string, annotation: unknown): InboxAnnotationRecord {
    const message = this.messages.get(messageId);
    if (!message) throw new InboxError("message_not_found", `No message ${messageId}.`);
    if (message.author.kind !== "agent") {
      throw new InboxError("annotation_not_allowed", "annotation: only an agent's message takes comments; this one is yours.", { field: "message_id" });
    }
    if (!annotation || typeof annotation !== "object" || Array.isArray(annotation)) {
      throw new InboxError("validation_error", "annotation: an object.", { field: "annotation" });
    }
    const fields = annotation as Record<string, unknown>;
    const id = fields.id;
    if (!isInboxAnnotationId(id)) throw new InboxError("validation_error", "annotation.id: a short id.", { field: "annotation.id" });
    // A comment on selected words (a quick label such as 👍 is a comment too), or a Delete on them (approval
    // "inbox-toolbar-delete": the toolbar's Delete, as in plan review); never a general comment.
    const deletion = fields.type === "DELETION";
    if (fields.type !== "COMMENT" && !deletion) throw new InboxError("validation_error", 'annotation.type: "COMMENT" (a comment on the words selected) or "DELETION" (remove them).', { field: "annotation.type" });
    const quote = fields.originalText;
    if (typeof quote !== "string" || quote.trim() === "" || quote.length > INBOX_MESSAGE_COMMENT_QUOTE_MAX) {
      throw new InboxError("validation_error", `annotation.originalText: the words selected (1 to ${INBOX_MESSAGE_COMMENT_QUOTE_MAX} characters).`, { field: "annotation.originalText" });
    }
    // The comment itself: a quick label (👍) carries its label as its text, so every comment has words to send.
    // A deletion's words are the ones selected; it may carry none of its own.
    const text = fields.text;
    const noText = text === undefined || text === null || text === "";
    if (!(deletion && noText) && (typeof text !== "string" || text.trim() === "" || text.length > INBOX_MESSAGE_COMMENT_TEXT_MAX)) {
      throw new InboxError("validation_error", `annotation.text: the comment (1 to ${INBOX_MESSAGE_COMMENT_TEXT_MAX} characters).`, { field: "annotation.text" });
    }
    // A comment on a message's words is words: no images, no element or page it points at, no reply thread.
    for (const field of ["images", "elementContext", "pageUrl", "inReplyTo"] as const) {
      const value = fields[field];
      if (value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)) throw new InboxError("validation_error", `annotation.${field}: a comment on a message's text takes none.`, { field: `annotation.${field}` });
    }
    // A comment on a part of a diagram in the message: the part's label is its "words", and the anchor names the part.
    // The same fail-closed parser as the external-annotations route: what the window and the export read is what is stored.
    const diagramAnchor = fields.diagramAnchor === undefined ? undefined : parseDiagramAnchor(fields.diagramAnchor);
    if (diagramAnchor === null) throw new InboxError("validation_error", "annotation.diagramAnchor: { v: 1, family, kind, id | from + to, label, sourceLine }.", { field: "annotation.diagramAnchor" });
    if (this.closedByArchive(message)) throw new InboxError("thread_resolved", "This thread is resolved; reopen it to annotate.");
    const existing = this.annotations.get(id);
    if (existing && (!existing.message || existing.message_id !== message.id)) {
      throw new InboxError("validation_error", "annotation.id: already used on another message or file.", { field: "annotation.id" });
    }
    if (existing && (existing.sent_reply_id !== null || existing.removed_at !== null)) {
      throw new InboxError("annotation_closed", "This annotation was already sent or removed.");
    }
    const at = this.stamp();
    const record: InboxAnnotationRecord = {
      id,
      project_id: message.project_id,
      thread_id: message.thread_id,
      message_id: message.id,
      attachment_id: "",
      path: message.id,
      version: INBOX_ANNOTATION_CURRENT,
      message: { at: message.created_at },
      annotation: { ...withoutExportLocation(fields), ...(diagramAnchor ? { diagramAnchor } : {}) },
      created_at: existing?.created_at ?? at,
      updated_at: at,
      removed_at: null,
      sent_reply_id: null,
    };
    this.appendAnnotation(record, at);
    return record;
  }

  /**
   * The running local apps a thread shows: the ones its agents' question
   * choices name as prototypes (each message's `live_sites`, in thread
   * order). One entry per site id.
   */
  liveSites(threadId: string): InboxLiveSiteRef[] {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== root.id) return [];
    const out: InboxLiveSiteRef[] = [];
    const add = (site: InboxLiveSiteRef) => {
      if (!out.some((known) => known.id === site.id)) out.push(site);
    };
    for (const message of this.threadMessages(threadId)) for (const site of message.live_sites ?? []) add(site);
    return out;
  }

  /**
   * Save a comment the person made on a running local site the thread shows
   * (a new one, or an edit of one still waiting): Plannotator's annotation
   * as the live bridge made it, comment-only (an element pin, selected words,
   * or a comment on the whole site), with `elementContext` and the page it
   * was made on (`pageUrl`: a path, kept on the record as `live.page_url`).
   * It rides the next Send like a file's annotation; `message_id` is the
   * thread's latest agent message (the root when no agent wrote yet).
   */
  saveLiveAnnotation(threadId: string, siteId: string, annotation: unknown): InboxAnnotationRecord {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== root.id) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    const site = this.liveSites(threadId).find((candidate) => candidate.id === siteId);
    if (!site) throw new InboxError("live_site_not_found", "This thread shows no such site.");
    if (!annotation || typeof annotation !== "object" || Array.isArray(annotation)) {
      throw new InboxError("validation_error", "annotation: an object.", { field: "annotation" });
    }
    const fields = annotation as Record<string, unknown>;
    const id = fields.id;
    if (!isInboxAnnotationId(id)) throw new InboxError("validation_error", "annotation.id: a short id.", { field: "annotation.id" });
    // Comment-only, as on every HTML surface: never a deletion or a replacement.
    if (fields.type !== "COMMENT" && fields.type !== "GLOBAL_COMMENT") {
      throw new InboxError("validation_error", 'annotation.type: "COMMENT" or "GLOBAL_COMMENT".', { field: "annotation.type" });
    }
    const text = fields.text;
    if (typeof text !== "string" || text.trim() === "" || text.length > INBOX_MESSAGE_COMMENT_TEXT_MAX) {
      throw new InboxError("validation_error", `annotation.text: the comment (1 to ${INBOX_MESSAGE_COMMENT_TEXT_MAX} characters).`, { field: "annotation.text" });
    }
    // What the page itself supplies (the words or element text, the element's context and anchor) is
    // capped, since it rides into the agent's feedback: a page cannot fill a reply or the store.
    const quoted = fields.originalText;
    if (quoted !== undefined && (typeof quoted !== "string" || quoted.length > INBOX_LIVE_QUOTE_MAX)) {
      throw new InboxError("validation_error", `annotation.originalText: at most ${INBOX_LIVE_QUOTE_MAX} characters.`, { field: "annotation.originalText" });
    }
    for (const key of ["elementContext", "htmlAnchor"] as const) {
      if (fields[key] !== undefined && JSON.stringify(fields[key]).length > INBOX_LIVE_ELEMENT_MAX) {
        throw new InboxError("validation_error", `annotation.${key}: at most ${INBOX_LIVE_ELEMENT_MAX} characters as JSON.`, { field: `annotation.${key}` });
      }
    }
    if (JSON.stringify(fields).length > INBOX_LIVE_ANNOTATION_MAX) {
      throw new InboxError("validation_error", `annotation: at most ${INBOX_LIVE_ANNOTATION_MAX} characters as JSON.`, { field: "annotation" });
    }
    // The page: a path the site serves (`/settings?tab=billing`), never another origin's address.
    const page = fields.pageUrl;
    if (page !== undefined && page !== null && !isLivePagePath(page)) {
      throw new InboxError("validation_error", `annotation.pageUrl: a path on the site, starting with one "/" (at most ${INBOX_LIVE_URL_MAX} characters).`, { field: "annotation.pageUrl" });
    }
    const existing = this.annotations.get(id);
    if (existing && (!existing.live || existing.live.site_id !== site.id || existing.thread_id !== threadId)) {
      throw new InboxError("validation_error", "annotation.id: already used on another file, message or site.", { field: "annotation.id" });
    }
    if (existing && (existing.sent_reply_id !== null || existing.removed_at !== null)) {
      throw new InboxError("annotation_closed", "This annotation was already sent or removed.");
    }
    const lastAgent = [...this.threadMessages(threadId)].reverse().find((m) => m.author.kind === "agent") ?? root;
    const target = (existing && this.messages.get(existing.message_id)) || lastAgent;
    if (this.closedByArchive(target)) throw new InboxError("thread_resolved", "This thread is resolved; reopen it to annotate.");
    const pageUrl = typeof page === "string" ? page : null;
    const at = this.stamp();
    const record: InboxAnnotationRecord = {
      id,
      project_id: root.project_id,
      thread_id: threadId,
      message_id: target.id,
      attachment_id: "",
      path: site.url,
      version: INBOX_ANNOTATION_CURRENT,
      live: { site_id: site.id, url: site.url, page_url: pageUrl },
      annotation: withoutExportLocation(fields),
      created_at: existing?.created_at ?? at,
      updated_at: at,
      removed_at: null,
      sent_reply_id: null,
    };
    this.appendAnnotation(record, at);
    return record;
  }

  /** A guided review's files by the paths its patch names (new and old), read from its snapshot blob once. */
  private guideFiles(sha256: string): ReadonlyMap<string, DiffFile> {
    const known = this.guideFileSets.get(sha256);
    if (known) return known;
    const files = new Map<string, DiffFile>();
    try {
      const snapshot = JSON.parse(readFileSync(inboxBlobPath(this.dir, sha256), "utf8")) as { review?: { rawPatch?: unknown } };
      const patch = snapshot.review?.rawPatch;
      if (typeof patch === "string") {
        for (const file of parseDiffToFiles(patch)) {
          files.set(file.path, file);
          if (file.oldPath && !files.has(file.oldPath)) files.set(file.oldPath, file);
        }
      }
    } catch {
      throw new InboxError("guide_not_found", "The guided review is missing from the store.");
    }
    this.guideFileSets.set(sha256, files);
    return files;
  }

  /** One annotation by id, removed or sent ones included; null when this store has none. */
  annotation(id: string): InboxAnnotationRecord | null {
    return this.annotations.get(id) ?? null;
  }

  /** Remove an annotation still waiting for a Send. Removing it again changes nothing. */
  removeAnnotation(id: string): InboxAnnotationRecord {
    const record = this.annotations.get(id);
    if (!record) throw new InboxError("annotation_not_found", `No annotation ${id}.`);
    if (record.removed_at !== null) return record;
    if (record.sent_reply_id !== null) throw new InboxError("annotation_closed", "This annotation was already sent.");
    const at = this.stamp();
    const next = { ...record, removed_at: at, updated_at: at };
    this.appendAnnotation(next, at);
    return next;
  }

  /** The annotations a Send names: each in this thread and still waiting. */
  private planSentAnnotations(threadId: string, ids: unknown): InboxAnnotationRecord[] {
    if (ids === undefined || ids === null) return [];
    if (!Array.isArray(ids)) throw new InboxError("validation_error", "annotation_ids: must be a list.", { field: "annotation_ids" });
    const seen = new Set<string>();
    return ids.map((id, index) => {
      const field = `annotation_ids[${index}]`;
      const record = typeof id === "string" ? this.annotations.get(id) : undefined;
      if (!record || record.thread_id !== threadId) throw new InboxError("annotation_not_found", `${field}: no such annotation in this thread.`, { field });
      if (seen.has(record.id)) throw new InboxError("validation_error", `${field}: listed twice.`, { field });
      seen.add(record.id);
      if (record.removed_at !== null || record.sent_reply_id !== null) {
        throw new InboxError("annotation_closed", `${field}: already sent or removed.`, { field });
      }
      return record;
    });
  }

  private appendAnnotation(record: InboxAnnotationRecord, at: string): void {
    const project = this.projectsById.get(record.project_id);
    if (!project) throw new InboxError("project_not_found", `No project ${record.project_id}.`);
    this.write(join(this.projectFolder(project), ANNOTATIONS_FILE), {
      v: INBOX_RECORD_VERSION,
      seq: this.seq + 1,
      at,
      kind: "annotation",
      id: record.id,
      record,
    });
  }

  /** Every write to `annotations` goes here, so the per-thread unsent count follows it. */
  private setAnnotation(record: InboxAnnotationRecord): void {
    this.changes += 1;
    const unsent = (r: InboxAnnotationRecord | undefined) => (r && r.sent_reply_id === null && r.removed_at === null ? 1 : 0);
    const before = this.annotations.get(record.id);
    this.annotations.set(record.id, record);
    if (before && before.thread_id !== record.thread_id) this.bumpUnsent(before.thread_id, -unsent(before));
    this.bumpUnsent(record.thread_id, unsent(record) - (before && before.thread_id === record.thread_id ? unsent(before) : 0));
  }

  private bumpUnsent(threadId: string, delta: number): void {
    if (delta === 0) return;
    const next = (this.unsentAnnotations.get(threadId) ?? 0) + delta;
    if (next > 0) this.unsentAnnotations.set(threadId, next);
    else this.unsentAnnotations.delete(threadId);
  }

  private restoreAnnotation(record: InboxAnnotationRecord): void {
    this.setAnnotation(record);
    const key = `annotation:${record.id}`;
    const line = this.latest.get(key);
    if (line && line.kind === "annotation") this.latest.set(key, { ...line, record });
  }

  /** Each thread of a project with the blobs its attachments use. */
  private threadBlobs(projectId: string): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const message of this.messages.values()) {
      if (message.project_id !== projectId || (!message.attachments?.length && !message.inline_images?.length && !message.guide)) continue;
      const blobs = out.get(message.thread_id) ?? new Set<string>();
      for (const attachment of message.attachments ?? []) blobs.add(attachment.sent_sha256);
      // The images its body shows, captured as files of the thread.
      for (const image of message.inline_images ?? []) blobs.add(image.sent_sha256);
      // A guided review's snapshot is a blob too (step 5).
      if (message.guide) blobs.add(message.guide.sha256);
      out.set(message.thread_id, blobs);
    }
    return out;
  }

  // ─────────────────────────── deleting ───────────────────────────

  // ─────────────────────────── reply drafts ───────────────────────────

  /** The words typed in a thread's reply box and not sent, or null. */
  replyDraft(threadId: string): InboxReplyDraft | null {
    return this.replyDrafts.get(threadId) ?? null;
  }

  /**
   * Save the reply box's words for a thread (a compare-and-set on
   * `updated_at`: `base` is the `updated_at` the writer last read, null to
   * create; another tab's newer save is `409 draft_conflict` with it). An empty
   * body (whitespace only) deletes the draft and answers null. Never a line in
   * the event log: agents, the MCP and search never see it.
   */
  saveReplyDraft(
    threadId: string,
    input: InboxReplyDraftInput,
  ): InboxReplyDraft | null {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    const { body, base, baseBody, files: incoming, baseFiles, allFiles, ops, recipients: given } = checkInboxReplyDraftInput(this.dir, input);
    const existing = this.replyDrafts.get(threadId) ?? null;
    if (ops) {
      // This Inbox's page: the box's file changes, applied to the files as they are now (another window's stay).
      // Only the words are compared: a file change elsewhere never refuses this save.
      const ownWords = baseBody !== null && existing !== null && existing.body === baseBody;
      if ((existing?.updated_at ?? null) !== base && !ownWords) {
        throw new InboxError(
          "draft_conflict",
          existing ? "This reply changed in another window since you opened it." : "This reply's draft was discarded or sent in another window.",
          { draft: existing },
        );
      }
      // A save a step behind (its own words, `base_body`) adds no file the draft lost since the version it names:
      // another window took it out after this page's earlier save of it landed (its answer lost), so the add is
      // that save's, sent again, not a new one.
      const removals = existing && existing.updated_at !== base ? this.replyDraftRemovals.get(threadId) : undefined;
      const add = removals ? ops.add.filter((file) => !((removals.get(file.upload_id) ?? "") > (base ?? ""))) : ops.add;
      // Words changed: another window's long paste this save does not place moves with them.
      const after = applyReplyDraftFileOps(existing?.files ?? [], { ...ops, add }, existing ? { from: existing.body, to: body } : undefined);
      if (body.trim() === "" && after.length === 0) {
        this.deleteReplyDraft(threadId);
        return null;
      }
      return this.writeReplyDraft(threadId, existing, body, after, given);
    }
    // An older page (no `all_files`) names long pastes only: the draft's other files stay (a file it does not know
    // is never dropped by it).
    const files = replyDraftFilesAfterSave(existing?.files ?? [], incoming, allFiles);
    // `base_body`: the words this window wrote last. A save sent as the page goes may carry a base read
    // before that write's answer came back; the draft still holding those words is the window's own.
    // With `base_files` (the files it wrote last), the draft must hold those too: the compare covers both.
    // A file a Send carried since is no upload any more and left every draft (`dropSentUploadsFromReplyDrafts`):
    // the window that still names it is not told apart by it.
    const existingIds = replyDraftFileIdsSeenBy(existing?.files ?? [], allFiles);
    const ownWords =
      baseBody !== null &&
      existing !== null &&
      existing.body === baseBody &&
      (baseFiles === null ||
        sameInboxUploadIds(
          existingIds,
          baseFiles.filter((id) => existingIds.includes(id) || readInboxUpload(this.dir, id) !== null),
        ));
    if ((existing?.updated_at ?? null) !== base && !ownWords) {
      throw new InboxError(
        "draft_conflict",
        existing ? "This reply changed in another window since you opened it." : "This reply's draft was discarded or sent in another window.",
        { draft: existing },
      );
    }
    // Nothing left: no words and no file kept beside them.
    if (body.trim() === "" && files.length === 0) {
      this.deleteReplyDraft(threadId);
      return null;
    }
    return this.writeReplyDraft(threadId, existing, body, files, given);
  }

  /**
   * Write a thread's draft whole, its `updated_at` strictly later than the last one's. `recipients`: who the reply
   * goes to as the save names it (the recipient pill; empty: none chosen); null keeps the draft's own.
   */
  private writeReplyDraft(threadId: string, existing: InboxReplyDraft | null, body: string, files: readonly InboxDraftFile[], recipients: readonly string[] | null = null): InboxReplyDraft {
    const at = this.stamp();
    // Strictly later than the last save, so a compare-and-set within one millisecond still tells the two apart.
    const updatedAt = existing && at <= existing.updated_at ? new Date(Date.parse(existing.updated_at) + 1).toISOString() : at;
    const draft: InboxReplyDraft = {
      v: 1,
      thread_id: threadId,
      body,
      created_at: existing?.created_at ?? at,
      updated_at: updatedAt,
      ...(files.length > 0 ? { files: [...files] } : {}),
    };
    const aimed = recipients ?? existing?.recipients ?? [];
    if (aimed.length > 0) draft.recipients = [...aimed];
    writeInboxReplyDraft(this.dir, draft);
    this.replyDrafts.set(threadId, draft);
    this.changes += 1;
    this.noteReplyDraftRemovals(threadId, existing, draft);
    this.replyDraftChanged(threadId);
    return draft;
  }

  /** The files `existing` held that `draft` (its next version) does not: dropped at its `updated_at`; one back is not. */
  private noteReplyDraftRemovals(threadId: string, existing: InboxReplyDraft | null, draft: InboxReplyDraft): void {
    const kept = new Set((draft.files ?? []).map((file) => file.upload_id));
    let removals = this.replyDraftRemovals.get(threadId);
    for (const id of kept) removals?.delete(id);
    for (const file of existing?.files ?? []) {
      if (kept.has(file.upload_id)) continue;
      if (!removals) this.replyDraftRemovals.set(threadId, (removals = new Map()));
      removals.set(file.upload_id, draft.updated_at);
    }
    if (removals?.size === 0) this.replyDraftRemovals.delete(threadId);
  }

  /**
   * The Send that carried the reply box's draft (`clear_draft`), settled by
   * `settleReplyDraftAfterSend` (@plannotator/core/inbox-reply-draft):
   *  - still the draft those words were saved as (`updated_at`): the words go,
   *    and so do the files the Send carried; a file it did not carry (a phone
   *    or an older page that sent the words alone) stays, as a draft of files only;
   *  - an older `updated_at` (the window may not know the one of a save whose
   *    answer it never read): it goes only while it holds exactly the sent
   *    `words` and only files among the Send's `uploads` (a file alone counts
   *    when the words are empty). A newer, different draft another window
   *    saved meanwhile (other words, or a file this Send did not carry) stays.
   * True when the draft changed.
   */
  clearSentReplyDraft(threadId: string, updatedAt: string, words?: string, uploads: readonly string[] = []): boolean {
    const existing = this.replyDrafts.get(threadId);
    if (!existing) return false;
    const after = settleReplyDraftAfterSend(existing, { clearDraft: updatedAt, words, uploads });
    if (after.kind === "unchanged") return false;
    if (after.kind === "delete") return this.deleteReplyDraft(threadId);
    // The words went to whom they were aimed at: the files left behind are aimed at no one yet.
    this.writeReplyDraft(threadId, existing, "", after.files, []);
    return true;
  }

  /**
   * A reply sent these uploads, so they are attachments now and no longer
   * uploads: every reply draft naming one (a draft that kept other pastes the
   * Send did not carry, or another thread's) drops it, with a new
   * `updated_at`; a draft left with no words and no paste goes. The ids of the
   * threads whose draft changed.
   */
  dropSentUploadsFromReplyDrafts(uploads: readonly string[]): string[] {
    const sent = new Set(uploads);
    if (sent.size === 0) return [];
    const changed: string[] = [];
    for (const draft of [...this.replyDrafts.values()]) {
      const files = draft.files ?? [];
      const kept = files.filter((file) => !sent.has(file.upload_id));
      if (kept.length === files.length) continue;
      changed.push(draft.thread_id);
      if (draft.body.trim() === "" && kept.length === 0) {
        this.deleteReplyDraft(draft.thread_id);
        continue;
      }
      this.writeReplyDraft(draft.thread_id, draft, draft.body, kept);
    }
    return changed;
  }

  /** Drop a thread's reply draft (Discard); true when there was one. */
  deleteReplyDraft(threadId: string): boolean {
    // Gone whole: a draft made again later starts with no removals (a save against no draft adds every file it names).
    this.replyDraftRemovals.delete(threadId);
    const had = this.replyDrafts.delete(threadId);
    this.changes += 1;
    const removed = removeInboxReplyDraft(this.dir, threadId) || had;
    if (removed) this.replyDraftChanged(threadId);
    return removed;
  }

  /** The uploads every reply draft keeps (each file beside its words): the upload sweep keeps them, at any age. */
  replyDraftUploadIds(): Set<string> {
    const out = new Set<string>();
    for (const draft of this.replyDrafts.values()) for (const id of inboxReplyDraftFileIds(draft)) out.add(id);
    return out;
  }

  /** Bytes Decision data's kept lines take on disk (Settings → Storage). */
  private decisionLinesBytes(): number {
    try {
      return statSync(join(this.dir, DECISION_LINES_FILE)).size;
    } catch {
      return 0;
    }
  }

  /** Bytes the reply drafts take on disk (Settings → Storage). */
  private replyDraftsBytes(): number {
    let total = 0;
    for (const draft of this.replyDrafts.values()) total += Buffer.byteLength(`${JSON.stringify(draft)}\n`);
    return total;
  }

  /**
   * Delete a thread: its messages, questions and annotations are dropped from
   * the project's files (each rewritten whole: temp file, then rename), and
   * every blob no other record uses is removed. The store is then read again
   * from disk, so what routes and lists next is exactly what a restart reads.
   */
  deleteThread(threadId: string): void {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    const project = this.projectsById.get(root.project_id);
    if (!project) throw new InboxError("project_not_found", `No project ${root.project_id}.`);
    const messageIds = new Set(this.threadMembers.get(threadId) ?? []);
    const folder = this.projectFolder(project);
    const markups = this.markupsOf((record) => record.thread_id === threadId);
    this.keepDecisionLines((question) => messageIds.has(question.message_id));
    this.keepSeqFloor();
    for (const name of [MESSAGES_FILE, QUESTIONS_FILE, ANNOTATIONS_FILE, STEPS_FILE]) {
      const path = join(folder, name);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const kept = text.split("\n").filter((raw) => {
        const line = parseInboxLine(raw);
        if (!line) return false;
        if (line.kind === "message") return line.record.thread_id !== threadId;
        if (line.kind === "question") return !messageIds.has(line.record.message_id);
        if (line.kind === "annotation") return line.record.thread_id !== threadId;
        if (line.kind === "steps") return line.record.thread_id !== threadId;
        return true;
      });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, kept.length > 0 ? `${kept.join("\n")}\n` : "", { mode: 0o600 });
      renameSync(temp, path);
    }
    this.reload(markups);
  }

  /** Delete a project: its whole folder, then every blob no other record uses. */
  deleteProject(projectId: string): void {
    const project = this.projectsById.get(projectId);
    if (!project) throw new InboxError("project_not_found", `No project ${projectId}.`);
    const markups = this.markupsOf((record) => record.project_id === projectId);
    this.keepDecisionLines((question) => question.project_id === projectId);
    this.keepSeqFloor();
    rmSync(this.projectFolder(project), { recursive: true, force: true });
    this.reload(markups);
  }

  /**
   * Settings -> Decision data keeps its numbers when a thread goes (the owner, round 2): one line per question, no
   * words, written before the delete. A crash in between leaves a line beside a question still stored, which the count
   * reads once. A line that cannot be written, or a record that cannot be read, costs a number, never the person's
   * delete: Delete is the way out of a bad thread.
   */
  private keepDecisionLines(which: (question: InboxQuestionRecord) => boolean): void {
    try {
      const questions = [...this.questions.values()].filter(which);
      const lines = decisionLinesOf(
        questions,
        this.messages,
        (id) => this.decisionProjectLabel(id),
        (message) => this.closedByArchive(message),
      );
      if (!lines) return;
      const file = join(this.dir, DECISION_LINES_FILE);
      appendFileSync(file, `${endsMidLine(file) ? "\n" : ""}${lines}`, { mode: 0o600 });
    } catch {
      // See above.
    }
  }

  private decisionProjectLabel(id: string): string | null {
    const project = this.projectsById.get(id);
    return project ? this.labeled(project).name : null;
  }

  /** What Decision data counts, from memory: the store's records, not a copy of them. */
  decisionDataInput(): DecisionDataInput {
    return {
      headOf: (id) => (this.projectsById.has(id) ? this.canonicalProjectId(id) : id),
      labelOf: (id) => this.decisionProjectLabel(id),
      messages: [...this.messages.values()],
      byId: this.messages,
      closedByArchive: (message) => this.closedByArchive(message),
      reaskListedIds: (threadId) => this.reaskListedIds(threadId),
      questions: [...this.questions.values()],
    };
  }

  /** The marked-up images the annotations matching `which` name. */
  private markupsOf(which: (record: InboxAnnotationRecord) => boolean): Set<string> {
    const names = new Set<string>();
    for (const record of this.annotations.values()) if (which(record)) for (const name of inboxMarkupNamesOf(this.dir, record.annotation)) names.add(name);
    return names;
  }

  /**
   * Read the store again from disk (after a deletion), then drop the blobs
   * nothing uses and the deleted records' markups no remaining annotation
   * names. A markup no annotation names yet (uploaded, its comment not saved)
   * is never touched.
   */
  private reload(deletedMarkups: ReadonlySet<string> = new Set()): void {
    this.reloads += 1;
    this.changes += 1;
    this.latestAgentIds.clear();
    this.threadLines.clear();
    this.latest.clear();
    this.projectsById.clear();
    this.projectsByRoot.clear();
    this.projectLabels = null;
    this.projectGroups = null;
    this.messages.clear();
    this.launchedRootIds.clear();
    this.messageSeq.clear();
    this.resolvedSeq.clear();
    this.readdressed.clear();
    this.questions.clear();
    this.messageQuestions.clear();
    this.threadMembers.clear();
    this.namedThreads.clear();
    this.personNamed.clear();
    this.annotations.clear();
    this.unsentAnnotations.clear();
    this.cards.clear();
    this.cardHeardSeq.clear();
    this.stepsById.clear();
    this.stepsIdOf.clear();
    this.stepsIdsByThread.clear();
    this.initiativesById.clear();
    this.tagThreads.clear();
    this.tornFiles.clear();
    this.load();
    const used = pendingInboxUploadBlobs(this.dir);
    const attachmentIds = new Set<string>();
    for (const message of this.messages.values()) {
      for (const attachment of message.attachments ?? []) {
        used.add(attachment.sent_sha256);
        attachmentIds.add(attachment.id);
      }
      for (const image of message.inline_images ?? []) used.add(image.sent_sha256);
      if (message.guide) used.add(message.guide.sha256);
    }
    removeUnusedInboxBlobs(this.dir, used);
    // A deleted thread's reply draft goes with it.
    for (const threadId of [...this.replyDrafts.keys()]) {
      if (this.messages.get(threadId)?.thread_id === threadId) continue;
      removeInboxReplyDraft(this.dir, threadId);
      this.replyDrafts.delete(threadId);
      this.replyDraftRemovals.delete(threadId);
      this.changes += 1;
    }
    // So does its Ask AI conversation.
    pruneInboxAsks(this.dir, (threadId) => this.messages.get(threadId)?.thread_id === threadId);
    // A person's sent uploads are files under inbox/uploads/<att_id>/: they go with their message.
    removeUnusedInboxUploadFiles(this.dir, attachmentIds);
    const stillNamed = this.markupsOf(() => true);
    removeInboxMarkups(this.dir, [...deletedMarkups].filter((name) => !stillNamed.has(name)));
    for (const listener of this.deletionListeners) {
      try {
        listener();
      } catch {
        // A listener's failure never fails the deletion.
      }
    }
  }

  /**
   * Keep the highest seq across a deletion: the lines removed may hold it,
   * and an agent's cursor already past it must never see that number again.
   */
  private keepSeqFloor(): void {
    const path = join(this.dir, SEQ_FLOOR_FILE);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ seq: this.seq })}\n`, { mode: 0o600 });
    renameSync(temp, path);
  }

  private readSeqFloor(): number {
    try {
      const value = JSON.parse(readFileSync(join(this.dir, SEQ_FLOOR_FILE), "utf8")) as { seq?: unknown };
      return typeof value.seq === "number" && Number.isSafeInteger(value.seq) && value.seq > 0 ? value.seq : 0;
    } catch {
      return 0;
    }
  }

  // ──────────── agent connections (step 6: the reply wake) ────────────

  /**
   * The person's replies waiting for an agent connection's `session`: replies
   * to a message that session sent, and New messages and replies addressed to
   * it (`to`; settled only by their delivery), not yet delivered, and not yet read by an
   * agent (read_thread; any agent's read counts, as for the
   * Sent band). Derived from the log, so a reply waits for its session across
   * Inbox restarts and is handed out again until it is delivered. Oldest first.
   *
   * A reply that tags agents (`tags`, approval "inbox-tag-agents") is handed
   * to its owner and to each tagged session, and settled for each one only by
   * its own delivery: another agent's read never settles it (a tagged agent
   * told to read the thread first must not swallow the owner's wake).
   * `options.tags` false (a connection that did not say it understands tags)
   * leaves out what this session was only tagged in: its wake would say "the
   * person replied to you", which is not true.
   */
  pendingReplies(session: string, options: { tags?: boolean } = {}): InboxMessage[] {
    const out: { message: InboxMessage; seq: number }[] = [];
    for (const message of this.messages.values()) {
      if (message.author.kind !== "person") continue;
      if (this.pendingFor(message, session, options)) out.push({ message, seq: this.messageSeq.get(message.id) ?? 0 });
    }
    return out.sort((a, b) => a.seq - b.seq).map((entry) => entry.message);
  }

  /**
   * `pendingReplies` for many sessions in ONE pass over the messages (the
   * Codex wake, which delivers for every Codex thread itself): each session
   * that has something waiting, with its items oldest first. A person's item
   * is looked at only for its owner and the sessions it tags.
   */
  pendingRepliesFor(sessions: ReadonlySet<string>, options: { tags?: boolean } = {}): Map<string, InboxMessage[]> {
    const found = new Map<string, { message: InboxMessage; seq: number }[]>();
    if (sessions.size === 0) return new Map();
    for (const message of this.messages.values()) {
      if (message.author.kind !== "person") continue;
      const candidates: string[] = [];
      if (message.to) candidates.push(message.to.session);
      else {
        const asked = message.reply_to ? this.messages.get(message.reply_to) : undefined;
        if (asked?.author.kind === "agent" && asked.author.session) candidates.push(asked.author.session);
      }
      for (const tag of message.tags ?? []) candidates.push(tag.session);
      for (const session of new Set(candidates)) {
        if (!sessions.has(session) || !this.pendingFor(message, session, options)) continue;
        const list = found.get(session) ?? found.set(session, []).get(session)!;
        list.push({ message, seq: this.messageSeq.get(message.id) ?? 0 });
      }
    }
    return new Map([...found].map(([session, list]) => [session, list.sort((a, b) => a.seq - b.seq).map((entry) => entry.message)]));
  }

  /** Whether a person's `message` waits for `session` (the rules of `pendingReplies`). */
  private pendingFor(message: InboxMessage, session: string, options: { tags?: boolean }): boolean {
    // A hand-off inside its Undo window goes to nobody yet.
    if (handoffHeld(message)) return false;
    const owner = this.isOwner(message, session);
    const tag = owner ? null : tagOf(message, session);
    if (tag) return !tag.delivery && options.tags !== false;
    if (message.delivery || !owner) return false;
    // A Tidy note in a thread other than the one carrying the session's wake is never delivered.
    if (message.tidy && !message.tidy.wake) return false;
    // A 👍 taken back before it went is never delivered.
    if (isAckNote(message) && !this.ackNoteLive(message)) return false;
    const seq = this.messageSeq.get(message.id) ?? 0;
    // A New message, or a reply the person sent to another session, is
    // settled only by its delivery to the session it names, never by another
    // agent's read; so is a reply that tags agents.
    if (!message.to && !hasTags(message) && (this.messages.get(message.thread_id)?.agent_checked_seq ?? 0) >= seq) return false;
    return true;
  }

  /**
   * A Tidy wake the Inbox withdrew before any hand-off (steps turned off, the
   * wake listed only steps): recorded delivered under `host` (the Inbox's own
   * marker) so nothing hands it, and nothing else. Unlike `recordDelivery` it
   * settles nothing in the thread: the person's earlier replies to that
   * session stay owed (no `markAgentChecked`), and no 👍 reads seen.
   */
  recordTidyWithdrawn(noteId: string, host: string): InboxMessage {
    const note = this.messages.get(noteId);
    if (!note || !note.tidy?.wake || !note.to) throw new InboxError("message_not_found", `No Tidy wake ${noteId}.`);
    if (note.delivery) return note;
    const at = this.stamp();
    const withdrawn: InboxMessage = { ...note, delivery: { state: "delivered", host, session: note.to.session, at } };
    this.appendMessage(withdrawn, at);
    return withdrawn;
  }

  /** What a delivery of this message to `session` goes by: the message's id, or a former owner's stop notice's own. */
  deliveryIdOf(message: InboxMessage, session: string): string {
    return tagOf(message, session)?.handed_away ? inboxStopNoticeId(message.id) : message.id;
  }

  /**
   * A connection delivered a reply into a session as a turn: the reply
   * records it (`delivery` for its owner, the tag's own `delivery` for a
   * tagged session), and, for the owner, the thread counts as read by the
   * agent up to it (the Sent band's "Delivered to <agent>, <time>"). A tagged
   * session's delivery marks nothing for the owner. Idempotent per session.
   */
  recordDelivery(deliveryId: string, by: { host: string; session: string; intoTurn?: boolean }): InboxMessage {
    const noticeOf = inboxStopNoticeReply(deliveryId);
    const replyId = noticeOf ?? deliveryId;
    const reply = this.messages.get(replyId);
    if (!reply || reply.author.kind !== "person" || (!reply.reply_to && !reply.to)) throw new InboxError("message_not_found", `No reply ${replyId}.`);
    // A stop notice says nothing about the words, and nothing at all once the reply moved back to this session.
    if (noticeOf && !tagOf(reply, by.session)?.handed_away) return reply;
    if (!this.isFor(reply, by.session)) {
      throw new InboxError("validation_error", "session: this reply answers another session's message.", { field: "session" });
    }
    if (!this.isOwner(reply, by.session)) {
      const tag = tagOf(reply, by.session)!;
      if (tag.delivery) return reply;
      const at = this.stamp();
      const delivered: InboxMessage = {
        ...reply,
        tags: reply.tags!.map((t) =>
          t.session === by.session ? { ...t, delivery: { state: "delivered" as const, host: by.host, session: by.session, at, ...intoTurnOf(t.deliver_now_by, by.intoTurn) } } : t,
        ),
      };
      this.appendMessage(delivered, at);
      return delivered;
    }
    if (reply.delivery) return reply;
    const at = this.stamp();
    const delivered: InboxMessage = { ...reply, delivery: { state: "delivered", host: by.host, session: by.session, at, ...intoTurnOf(reply.deliver_now_by, by.intoTurn) } };
    this.appendMessage(delivered, at);
    // Up to it, but never past a reply still owed to another session.
    this.markAgentChecked(reply.thread_id, this.messageSeq.get(reply.id) ?? 0, at, by.session);
    // A 👍 that reached the agent was seen.
    if (isAckNote(reply) && reply.ack_of) this.markAckSeen(reply.ack_of, at);
    return delivered;
  }

  /**
   * `session` read a thread with read_thread: what it was owed among the
   * messages the read showed (`shown`; all of them without it) is settled, for
   * it alone, and only where no wake is left to do it. A tag that does not
   * wake records the read (`read_at`, the window says it saw it). A reply it
   * owns that tags others, when nothing wakes it, is delivered. So is what
   * only a delivery settles on Codex and Qwen, whose wake the Inbox sends once
   * and never again when it is lost: a message addressed to it, a reply it
   * owns that tags others, a waking tag. A connection that polls hands its
   * items until they are delivered, so its session keeps "only the wake
   * delivers". A Tidy note is left to its wake: a read shows it as one line.
   * No write when nothing is new.
   */
  recordOwnRead(threadId: string, session: string, shown?: ReadonlySet<string>): void {
    for (const message of this.threadMessages(threadId)) {
      if (message.author.kind !== "person" || message.tidy || (shown && !shown.has(message.id))) continue;
      const owner = this.isOwner(message, session);
      const tag = owner ? null : tagOf(message, session);
      if (!owner && !tag) continue;
      if (tag && !tag.wakes) {
        if (tag.delivery || tag.read_at) continue;
        const at = this.stamp();
        this.appendMessage({ ...message, tags: message.tags!.map((t) => (t.session === session ? { ...t, read_at: at } : t)) }, at);
        continue;
      }
      if (!this.pendingFor(message, session, {})) continue;
      const host = tag ? tag.host : this.recipientOf(message)?.host;
      const wakes = tag ? true : this.wakesRecipient(message);
      // A plain reply it owns that the read mark could not cover (a reply still owed to another
      // session comes before it): its read settles it, as the mark does, so the wake never repeats it.
      const plain = !tag && !message.to && !hasTags(message);
      if (wakes && !plain && !INBOX_MCP_WAKING_HOSTS.includes(host ?? "")) continue;
      this.recordDelivery(message.id, { host: host ?? "agent", session });
    }
  }

  /**
   * Whether `session` is only a guest in this thread: the person tagged it
   * there, and it never wrote there and owns none of the person's messages.
   * Its reads must not count as "the agent read it" (`markAgentChecked`,
   * `markAcksSeen`): that would settle a plain reply still queued for the
   * thread's owner, which a tagged agent told to read the thread first would
   * otherwise swallow. Once it writes in the thread it is a participant.
   */
  isTaggedGuest(threadId: string, session: string | null): boolean {
    if (!session) return false;
    let tagged = false;
    for (const message of this.threadMessages(threadId)) {
      if (message.author.kind === "agent") {
        if (message.author.session === session) return false;
        continue;
      }
      if (this.isOwner(message, session)) return false;
      if (tagOf(message, session)) tagged = true;
    }
    return tagged;
  }

  /**
   * The threads a person's reply tagged `session` in and that session has not
   * taken yet (no delivery, and for a session not woken no read): read_thread
   * lists them, wherever their project is.
   */
  taggedThreadsOf(session: string): string[] {
    const out = new Set<string>();
    for (const message of this.messages.values()) {
      if (message.author.kind !== "person" || this.isOwner(message, session)) continue;
      const tag = tagOf(message, session);
      // A hand-off's stop notice is not a tag: the former owner was not tagged here.
      if (tag && !tag.delivery && !tag.read_at && !tag.handed_away) out.add(message.thread_id);
    }
    return [...out];
  }

  /**
   * The threads holding a message addressed to `session` (`to`) that it has
   * not taken: read_thread lists them, also when it never wrote there (a New
   * message), wherever their project is.
   */
  addressedThreadsOf(session: string): string[] {
    const out = new Set<string>();
    for (const message of this.messages.values()) {
      if (message.author.kind === "person" && message.to?.session === session && this.pendingFor(message, session, {})) out.add(message.thread_id);
    }
    return [...out];
  }

  /**
   * Whether a person's message goes to `session`: its owner (a New message
   * addressed to it, `to`; a reply the person sent to it because the asking
   * session had ended, `to` on a reply; a reply to a message it sent), or a
   * session the reply tags.
   */
  isFor(message: InboxMessage, session: string): boolean {
    return this.isOwner(message, session) || tagOf(message, session) !== null;
  }

  /** Whether `session` owns a person's message: the session it goes to without any tag. */
  isOwner(message: InboxMessage, session: string): boolean {
    if (message.to) return message.to.session === session;
    const asked = message.reply_to ? this.messages.get(message.reply_to) : undefined;
    return asked?.author.kind === "agent" && asked.author.session === session;
  }

  /**
   * The agent session a person's message goes to without any tag (its owner):
   * the session it is addressed to, else the session of the message it
   * replies to; null when there is none (a reply to a message sent without a
   * session, the Inbox's own notes).
   */
  recipientOf(message: InboxMessage): { host: string | null; session: string } | null {
    if (message.author.kind !== "person" || isInboxNote(message)) return null;
    if (message.to) return { host: message.to.host, session: message.to.session };
    const asked = message.reply_to ? this.messages.get(message.reply_to) : undefined;
    if (asked?.author.kind !== "agent" || !asked.author.session) return null;
    return { host: asked.author.host ?? null, session: asked.author.session };
  }

  /** Whether a person's message goes to a session whose connection delivers it as a turn by itself. */
  private wakesRecipient(message: InboxMessage): boolean {
    if (message.author.kind !== "person" || isInboxNote(message)) return false;
    if (message.to) return true;
    const asked = message.reply_to ? this.messages.get(message.reply_to) : undefined;
    return asked?.author.kind === "agent" && asked.wakes === true;
  }

  /**
   * Who a person's message goes to, the owner first and then each tagged
   * session, each with its own delivery: the Sent row's "1 of 3 delivered".
   * An owner that is not woken counts as delivered once an agent read the
   * thread up to it, as before tags; a tagged session only by its own delivery.
   */
  recipientsOf(message: InboxMessage): InboxSentRecipient[] {
    const out: InboxSentRecipient[] = [];
    const owner = this.recipientOf(message);
    if (owner) {
      const wakes = this.wakesRecipient(message);
      const root = this.messages.get(message.thread_id);
      const read = !wakes && (root?.agent_checked_seq ?? 0) >= (this.messageSeq.get(message.id) ?? 0) ? (root?.agent_checked_at ?? null) : null;
      out.push({ host: owner.host, session: owner.session, owner: true, wakes, delivered_at: message.delivery?.at ?? read });
    }
    for (const tag of message.tags ?? []) {
      out.push({ host: tag.host, session: tag.session, ...(tag.name ? { name: tag.name } : {}), owner: false, wakes: tag.wakes, delivered_at: tag.delivery?.at ?? null });
    }
    return out;
  }

  /**
   * The agent sessions a thread involves, in order of first appearance: the
   * session a thread the person started is addressed to, every agent that
   * wrote, and every session the person tagged. For the overlapping marks.
   */
  participantsOf(messages: readonly InboxMessage[]): InboxParticipant[] {
    const out: InboxParticipant[] = [];
    const add = (host: string | null, session: string | null | undefined, name?: string | null) => {
      if (!session || out.some((p) => p.session === session)) return;
      out.push({ host, session, ...(name ? { name } : {}) });
    };
    for (const message of messages) {
      if (message.author.kind === "agent") add(message.author.host ?? null, message.author.session, message.author.name);
      else if (message.started_by_person && message.to) add(message.to.host, message.to.session);
      for (const tag of message.tags ?? []) add(tag.host, tag.session, tag.name);
    }
    return out;
  }

  /**
   * Send now: the person asks for a reply or message of theirs to be
   * delivered at once (the bridge command's `now`), into the running turn
   * when one runs. A new snapshot of the same message with `deliver_now_at`
   * (the last line wins); a second press writes nothing. Refused once
   * delivered (`already_delivered`) or for a message that goes to no
   * session (`not_addressed`). Whether that session's connection can do it
   * is the server's check, before this is called. `session` names one
   * recipient (a tagged session's own line); absent, the owner.
   */
  requestDeliverNow(messageId: string, session?: string | null, by: InboxDeliverNowBy = "person"): InboxMessage {
    const message = this.messages.get(messageId);
    if (!message) throw new InboxError("message_not_found", `No message ${messageId}.`);
    const tag = session && !this.isOwner(message, session) ? tagOf(message, session) : null;
    if (session && !tag && !this.isOwner(message, session)) {
      throw new InboxError("not_addressed", "That session is not one this message goes to.");
    }
    if (tag) {
      if (tag.delivery) throw new InboxError("already_delivered", "That session already took this.", { delivery: tag.delivery });
      if (tag.deliver_now_at) return message;
      const at = this.stamp();
      const next: InboxMessage = { ...message, tags: message.tags!.map((t) => (t.session === tag.session ? { ...t, deliver_now_at: at, deliver_now_by: by } : t)) };
      this.appendMessage(next, at);
      return next;
    }
    if (!this.recipientOf(message)) {
      throw new InboxError("not_addressed", "Only your reply or message to an agent session can be sent now.");
    }
    if (message.delivery) throw new InboxError("already_delivered", "That session already took this.", { delivery: message.delivery });
    if (message.deliver_now_at) return message;
    const at = this.stamp();
    const next: InboxMessage = { ...message, deliver_now_at: at, deliver_now_by: by };
    this.appendMessage(next, at);
    return next;
  }

  /**
   * What goes into `session`'s running turn by itself now (owner approval
   * "inbox-busy-agent-reply", 2026-10-21): every item the session is handed
   * (`pendingReplies`: the person's replies, messages, Re-ask notes and, while
   * `INBOX_AUTO_SEND_ACK_NOTES` holds, the note carrying a 👍) whose clock
   * (`clockOf`: the server's, started the first time it saw this session busy
   * with Send now possible while the item waited; null while not started) has
   * run `afterMs`, and that was never asked to go now (no `deliver_now_by`, by
   * the person or by an earlier automatic attempt, so it fires once). The
   * Inbox's set-aside and reopened notes never do. Each is marked as a Send
   * now with `deliver_now_by: "auto"` and `wait_started_at` (when it began to
   * wait, `waitedSince`); the caller has checked that the session works now
   * and its connection can take an item mid-turn. Returns the items it marked.
   */
  autoSendDue(
    session: string,
    options: {
      afterMs: number;
      tags?: boolean;
      clockOf: (itemId: string) => { autoSince: number | null; since: number } | null;
    },
  ): InboxMessage[] {
    const now = this.now().getTime();
    const marked: InboxMessage[] = [];
    for (const item of this.pendingReplies(session, { tags: options.tags })) {
      if ((item.set_aside?.length ?? 0) > 0 || (item.reopened?.length ?? 0) > 0) continue;
      if (!INBOX_AUTO_SEND_ACK_NOTES && item.ack_of) continue;
      // Tidy goes to a busy session when its turn ends, never into it.
      if (item.tidy) continue;
      const clock = options.clockOf(item.id);
      if (!clock || clock.autoSince === null || clock.autoSince + options.afterMs > now) continue;
      const owner = this.isOwner(item, session);
      const tag = owner ? null : tagOf(item, session);
      const asked = owner ? item.deliver_now_at || item.deliver_now_by : !tag || tag.deliver_now_at || tag.deliver_now_by;
      if (asked) continue;
      const at = this.stamp();
      const waited = new Date(clock.since).toISOString();
      const next: InboxMessage = tag
        ? { ...item, tags: item.tags!.map((t) => (t.session === session ? { ...t, deliver_now_at: at, deliver_now_by: "auto" as const, wait_started_at: waited } : t)) }
        : { ...item, deliver_now_at: at, deliver_now_by: "auto", wait_started_at: waited };
      this.appendMessage(next, at);
      marked.push(next);
    }
    return marked;
  }

  /**
   * The session's connection could not put a Send now reply into the running
   * turn (the engine refused it): the mark goes, so the window reads it as
   * queued again and the reply waits for idle as before. Only the session it
   * goes to may say so, for its own mark; a delivered reply or one without the
   * mark is left as it is.
   */
  clearDeliverNow(messageId: string, session: string): InboxMessage {
    const message = this.messages.get(messageId);
    if (!message) throw new InboxError("message_not_found", `No message ${messageId}.`);
    if (!this.isFor(message, session)) throw new InboxError("validation_error", "session: this message goes to another session.", { field: "session" });
    if (!this.isOwner(message, session)) {
      const tag = tagOf(message, session)!;
      if (tag.delivery || !tag.deliver_now_at) return message;
      const at = this.stamp();
      this.appendMessage({ ...message, tags: message.tags!.map((t) => (t.session === session ? { ...t, deliver_now_at: null } : t)) }, at);
      return this.messages.get(messageId)!;
    }
    if (message.delivery || !message.deliver_now_at) return message;
    const at = this.stamp();
    const next: InboxMessage = { ...message, deliver_now_at: null };
    this.appendMessage(next, at);
    return next;
  }

  /** The blobs the store's messages use (attachments and guided reviews): the upload sweep keeps them. */
  usedBlobs(): Set<string> {
    const used = new Set<string>();
    for (const message of this.messages.values()) {
      for (const attachment of message.attachments ?? []) used.add(attachment.sent_sha256);
      for (const image of message.inline_images ?? []) used.add(image.sent_sha256);
      if (message.guide) used.add(message.guide.sha256);
    }
    return used;
  }

  // ──────────── New message (step 8) ────────────

  /**
   * The person's New message: their words in a thread, addressed to one agent
   * session (`to`), answering nothing. That session's connection is handed it
   * on its next poll (`pendingReplies`) and delivers it as a turn, like a
   * reply. Replaying the same idempotency key in the thread answers the
   * message it wrote, and writes nothing. Whether the session is live is the
   * server's check: `to` null means it is not, and only a replay answers.
   */
  sendNewMessage(threadId: string, input: { body: unknown; to: InboxAddressee | null; idempotency_key: unknown; by_guest?: boolean }): { message: InboxMessage; replayed: boolean } {
    const key = typeof input.idempotency_key === "string" ? input.idempotency_key.trim() : "";
    if (!key) throw new InboxError("validation_error", "idempotency_key: required on a Send.", { field: "idempotency_key" });
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    for (const message of this.threadMessages(threadId)) {
      if (message.author.kind === "person" && message.to && message.idempotency_key === key) return { message, replayed: true };
    }
    if (!input.to) {
      throw new InboxError("session_not_live", "That session is not live any more: the message was not sent. Press New message again to pick a live one.");
    }
    if (root.resolved_at !== null) throw new InboxError("thread_resolved", "This thread is resolved; reopen it to write in it.");
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (!body) throw new InboxError("validation_error", "body: write a message.", { field: "body" });
    const at = this.stamp();
    const message: InboxMessage = {
      id: inboxId("msg"),
      project_id: root.project_id,
      thread_id: threadId,
      reply_to: null,
      author: { kind: "person" },
      subject: null,
      body,
      created_at: at,
      resolved_at: null,
      idempotency_key: key,
      to: { host: input.to.host, session: input.to.session },
      ...(input.by_guest ? { by_guest: true as const } : {}),
    };
    this.appendMessage(message, at);
    this.endSnooze(threadId);
    this.tagThreadCards(threadId, message.body);
    return { message, replayed: false };
  }
  // ──────────── Tidy ────────────

  /**
   * The person's Tidy for one session (owner-approved design, 2026-10-28):
   * one Inbox note per thread, addressed to the session (`to`), the first
   * carrying its wake (`tidy.wake`, the only one `pendingReplies` hands
   * out). They are Inbox notes, so no row moves. The same `idempotency_key`
   * for the same session answers the notes it wrote and writes nothing.
   * Whether the session may be asked is the server's check.
   */
  sendTidy(input: { run: string; to: InboxAddressee; threadIds: readonly string[]; body: string; idempotency_key: string }): { notes: InboxMessage[]; replayed: boolean } {
    const key = input.idempotency_key.trim();
    if (!key) throw new InboxError("validation_error", "idempotency_key: required on a Tidy.", { field: "idempotency_key" });
    const done = this.tidyNotes().filter((m) => m.idempotency_key === key && m.to?.session === input.to.session);
    if (done.length > 0) return { notes: done, replayed: true };
    const notes: InboxMessage[] = [];
    for (const threadId of new Set(input.threadIds)) {
      const root = this.messages.get(threadId);
      if (!root || root.thread_id !== threadId) continue;
      const at = this.stamp();
      const note: InboxMessage = {
        id: inboxId("msg"),
        project_id: root.project_id,
        thread_id: threadId,
        reply_to: null,
        author: { kind: "person" },
        subject: null,
        body: input.body,
        created_at: at,
        resolved_at: null,
        idempotency_key: key,
        to: { host: input.to.host, session: input.to.session },
        tidy: { id: input.run, wake: notes.length === 0 },
      };
      this.appendMessage(note, at);
      notes.push(note);
    }
    return { notes, replayed: false };
  }

  /** Every Tidy note, oldest first. */
  tidyNotes(): InboxMessage[] {
    const out = [...this.messages.values()].filter((m) => m.tidy);
    return out.sort((a, b) => (this.messageSeq.get(a.id) ?? 0) - (this.messageSeq.get(b.id) ?? 0));
  }

  // ──────────── Compose: a thread the person starts with a live agent ────────────

  /**
   * The person starts a thread, addressed to one live agent session (`to`):
   * a root person message (`started_by_person`, `reply_to` null) whose
   * subject is derived from the body. No send joins it by default
   * (routing indexes agent roots only), and the agent's answer lands in it by
   * `reply_to`. The session is handed it on its next poll (`pendingReplies`,
   * `isFor` by `to`) and only its delivery settles it. Replaying the same
   * idempotency key answers the thread it wrote and writes nothing; the same
   * key with another body is `idempotency_key_reused`. Whether the session is
   * live is the server's check: `to` null means it is not, and only a replay
   * answers. Question blocks in the body are the person's text: no question
   * records are written.
   */
  startPersonThread(input: {
    project_id: string;
    body: unknown;
    to: InboxAddressee | null;
    idempotency_key: unknown;
    /** Written by a tailnet guest (`InboxMessage.by_guest`). */
    by_guest?: boolean;
    attachments?: InboxAttachment[];
    /** The thread's name (its chip), when the person gave one: checked by the thread-name rules; an agent never replaces it. */
    thread_name?: unknown;
    /**
     * `true` when `thread_name` is compose's suggestion the person left as it
     * was: best effort, so a name that is not valid or another open thread
     * already has is dropped (no refusal), and the first agent that may name
     * the thread replaces it.
     */
    thread_name_auto?: unknown;
    /**
     * `true` with `thread_name_auto` (New review's box): a suggestion another open thread already has is numbered,
     * "Review web-app: uncommitted on main (2)", rather than dropped, so a second review of the same changes is named.
     */
    thread_name_numbered?: unknown;
    /**
     * Compose's Board chip was on (approval "inbox-compose-board-chip"): the
     * root carries `board_request`, and what the agent receives for it asks it
     * to track the work on the Board. Only `true` sets it; a replay keeps the
     * first Send's.
     */
    board_request?: unknown;
    /**
     * Sent from Settings -> Decision data's Ask: the root carries `decision_ask`, and what the agent receives for it
     * says how to answer. Only `true` sets it; a replay keeps the first Send's.
     */
    decision_ask?: unknown;
    /** Launch: the agent the Inbox starts for this thread (the server's record; `to` is then its placeholder). */
    launch?: InboxLaunchRecord;
  }): { message: InboxMessage; replayed: boolean } {
    const key = typeof input.idempotency_key === "string" ? input.idempotency_key.trim() : "";
    if (!key) throw new InboxError("validation_error", "idempotency_key: required on a Send.", { field: "idempotency_key" });
    const body = typeof input.body === "string" ? input.body.trim() : "";
    const auto = input.thread_name_auto === true;
    let threadName = this.sentThreadName(input.thread_name, auto);
    for (const message of this.messages.values()) {
      if (!message.started_by_person || message.idempotency_key !== key) continue;
      // A retry is the same Send: the same body and the same name the person typed (compose's suggestion is the body's own).
      if (message.body !== body || (message.named_by?.kind === "person" ? message.thread_name : null) !== (auto ? null : threadName)) {
        throw new InboxError("idempotency_key_reused", "This idempotency_key was already used for a different message.", { message_id: message.id });
      }
      return { message, replayed: true };
    }
    if (!input.to) {
      throw new InboxError("session_not_live", "That session is not live any more: nothing was sent. Pick a live session, or save it as a draft.");
    }
    // Words or files: a message of attached files alone (a long paste) is the person's too, as a reply of files is.
    if (!body && !(input.attachments && input.attachments.length > 0)) throw new InboxError("validation_error", "body: write a message.", { field: "body" });
    if (!this.projectsById.has(input.project_id)) throw new InboxError("project_not_found", `No project ${input.project_id}.`);
    threadName = this.freeThreadName(input.project_id, threadName, auto, input.thread_name_numbered === true);
    const at = this.stamp();
    const id = inboxId("msg");
    const message: InboxMessage = {
      id,
      project_id: input.project_id,
      thread_id: id,
      reply_to: null,
      author: { kind: "person" },
      subject: derivePersonThreadSubject(body, { files: (input.attachments ?? []).map((attachment) => attachment.name) }),
      subject_question: null,
      body,
      created_at: at,
      resolved_at: null,
      idempotency_key: key,
      to: { host: input.to.host, session: input.to.session },
      started_by_person: true,
      ...(input.by_guest ? { by_guest: true as const } : {}),
      ...(input.board_request === true ? { board_request: true as const } : {}),
      ...(input.decision_ask === true ? { decision_ask: true as const } : {}),
      ...(input.launch ? { launch: input.launch } : {}),
      ...(threadName ? { thread_name: threadName, named_by: { kind: auto ? ("auto" as const) : ("person" as const), at } } : {}),
      ...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments.map((attachment) => ({ ...attachment, sent_at: at })) } : {}),
    };
    this.appendMessage(message, at);
    return { message, replayed: false };
  }

  /** A Send's thread name, or null for none. A suggestion (`auto`) that is not a valid name is dropped; a typed one is refused. */
  private sentThreadName(name: unknown, auto: boolean): string | null {
    if (name === undefined || name === null || (typeof name === "string" && name.trim() === "")) return null;
    const checked = checkInboxThreadName(name);
    if (checked.ok) return checked.name;
    if (!auto) throw new InboxError("validation_error", `thread_name: ${checked.message}`, { field: "thread_name" });
    return null;
  }

  /**
   * The name a thread would get in this project: a suggestion another open thread has is dropped, or with `numbered`
   * given the first free " (2)", " (3)"…; a typed one is refused.
   */
  private freeThreadName(projectId: string, name: string | null, auto: boolean, numbered = false): string | null {
    if (!name || !this.threadNameTaken(projectId, name, null)) return name;
    if (auto && numbered) return this.numberedThreadName(projectId, name);
    if (auto) return null;
    throw new InboxError("thread_name_taken", `Another open thread in this project is already named "${name}". Pick another name, or leave it empty.`, { field: "thread_name" });
  }

  /** `name (n)` for the first n from 2 no open thread in the project has, cut to fit the name limit; null past 99. */
  private numberedThreadName(projectId: string, name: string): string | null {
    for (let n = 2; n < 100; n++) {
      const suffix = ` (${n})`;
      const base = [...name].slice(0, INBOX_THREAD_NAME_MAX - suffix.length).join("").trimEnd();
      const checked = checkInboxThreadName(`${base}${suffix}`);
      if (checked.ok && !this.threadNameTaken(projectId, checked.name, null)) return checked.name;
    }
    return null;
  }

  /** What `startPersonThread` would refuse about a thread's name, with nothing written: for a Send with work to do before the write. */
  checkPersonThreadName(input: { project_id: string; thread_name?: unknown; thread_name_auto?: unknown; thread_name_numbered?: unknown }): void {
    const auto = input.thread_name_auto === true;
    this.freeThreadName(input.project_id, this.sentThreadName(input.thread_name, auto), auto, input.thread_name_numbered === true);
  }

  /** The thread the person started with this idempotency key, for a replayed Send. */
  personThreadByKey(key: string): InboxMessage | null {
    for (const message of this.messages.values()) if (message.started_by_person && message.idempotency_key === key) return message;
    return null;
  }

  /**
   * "Send to another session": the person re-addresses a message of theirs
   * that no session has taken yet (a thread they started, a New message, or
   * a reply sent to another session) because the session it was for ended.
   * The same message, a new snapshot with the new `to` (the last line wins).
   * Refused once delivered (`already_delivered`); `to` null means the chosen
   * session is not live (`session_not_live`). The same session writes nothing.
   *
   * `targetLive`: the server read that the session it waits on is still there, so it stays on its way
   * (`session_still_live`). `askerEnded`: the session the reply answers has ended (only a waking session can be known to);
   * a plain reply moves only then. `tookOver`: the moved reply takes the thread (`took_over`, the server's `takesOver`). A plain reply a read already
   * settled, or a session that already took it through a tag, is refused as taken. What was saved earlier for the same
   * session goes with it, so none stays owed there with no line saying so. A move is a new delivery for the session it
   * reaches: an old claim on it does not stand.
   */
  readdressMessage(messageId: string, to: InboxAddressee | null, options: { targetLive?: boolean; askerEnded?: boolean; tookOver?: boolean } = {}): InboxMessage {
    const message = this.messages.get(messageId);
    if (!message) throw new InboxError("message_not_found", `No message ${messageId}.`);
    const notAddressed = () => new InboxError("not_addressed", "Only a message you addressed to an agent session can be sent to another one.");
    if (message.author.kind !== "person" || isInboxNote(message)) throw notAddressed();
    if (message.delivery) throw new InboxError("already_delivered", "That session already took this message.", { delivery: message.delivery });
    const taken = () => new InboxError("already_delivered", "That session already took this message.");
    const checkedSeq = this.messages.get(message.thread_id)?.agent_checked_seq ?? 0;
    if (!message.to && checkedSeq >= (this.messageSeq.get(message.id) ?? 0)) throw taken();
    if (this.isResolved(message.thread_id)) throw new InboxError("thread_resolved", "This thread is archived; unarchive it first.");
    if (!to) throw new InboxError("session_not_live", "That session is not live any more: nothing was changed. Pick another live session.");
    // Through a tag: a notice it was handed away with is not the reply, and a tag it has not taken yet cannot deliver twice.
    const tookIt = (m: InboxMessage) => {
      const tag = tagOf(m, to.session);
      return !!tag?.delivery && !tag.handed_away;
    };
    if (tookIt(message)) throw taken();
    if (message.to && message.to.session === to.session && message.to.host === to.host) return message;
    if (options.targetLive) throw new InboxError("session_still_live", "That session is still running, so it still gets this. Nothing was changed.");
    if (!message.to && !options.askerEnded) throw notAddressed();
    const at = this.stamp();
    // Moved to another session: an earlier mark (the person's Send now or the Inbox's own) belonged to the
    // old one, so it neither goes in at once nor stays blocked from going in by itself; its wait starts again.
    const moved = (m: InboxMessage): InboxMessage => {
      // No old claim on it stands, the Claude Code mod's included (its claims are per session, under its own folder).
      const claims = [join(this.dir, "claims", m.id), join(this.dir, "claims", inboxClaimName(m.id, to.session))];
      if (/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(to.session)) claims.push(join(this.dir, "..", "claude-code-mod", to.session, "inbox", "claims", m.id));
      for (const claim of claims) {
        try {
          rmSync(claim, { recursive: true, force: true });
        } catch {
          // A leftover claim: that session reports the reply instead of delivering it.
        }
      }
      // It is that session's own now, not also a tag of it.
      const { tags: allTags, ...rest } = m;
      const tags = (allTags ?? []).filter((t) => t.session !== to.session);
      return {
        ...rest,
        ...(tags.length > 0 ? { tags } : {}),
        to: { host: to.host, session: to.session },
        deliver_now_at: null,
        deliver_now_by: null,
        wait_started_at: null,
        ...(options.tookOver ? { took_over: true } : {}),
        // A hand-off's new owner is not this session: back with the former owner it is taken back, else no old label stands.
        ...(m.handoff && !m.handoff.undone_at
          ? { handoff: m.handoff.from?.session === to.session ? { ...m.handoff, undone_at: at } : { ...m.handoff, label: null } }
          : {}),
      };
    };
    const owedTo = (m: InboxMessage): string | null => {
      if (m.to) return m.to.session;
      const asked = m.reply_to ? this.messages.get(m.reply_to) : undefined;
      return asked?.author.kind === "agent" ? (asked.author.session ?? null) : null;
    };
    const from = owedTo(message);
    for (const earlier of this.threadMessages(message.thread_id)) {
      if (earlier.id === message.id) break;
      if (earlier.author.kind !== "person" || earlier.delivery || isInboxNote(earlier) || earlier.tidy) continue;
      if (!from || owedTo(earlier) !== from || tookIt(earlier)) continue;
      if (!earlier.to && checkedSeq >= (this.messageSeq.get(earlier.id) ?? 0)) continue;
      this.appendMessage(moved(earlier), at);
    }
    const next = moved(message);
    this.appendMessage(next, at);
    return next;
  }

  /** Whether a message of this session came through a waking connection: only such a session can be called ended. */
  hasWakingMessage(session: string): boolean {
    return this.wakingSessions.has(session);
  }

  /**
   * Launch: the host answered for the agent started for this root. Started:
   * the root moves from its placeholder to the real session (`to`, no
   * liveness check: the session polls a moment later) and records the host's
   * own id; an earlier error is cleared. Failed (or Try again clearing it):
   * `launch.error`; the root keeps its placeholder, so the window shows Not
   * delivered. Deleted: `launch.deleted_at` (no run line, no respawn). One
   * snapshot each.
   */
  settleLaunch(
    messageId: string,
    outcome: { to: InboxAddressee; session_ref: string } | { error: InboxLaunchError | null } | { deleted_at: string } | { clone: InboxLaunchClone; made_inode?: string | null },
  ): InboxMessage {
    const message = this.messages.get(messageId);
    if (!message?.launch) throw new InboxError("message_not_found", `No launched thread ${messageId}.`);
    // A clone's folder: a new identity when the Inbox made it again, or none (`null`) once it is gone or no longer
    // the Inbox's, so a later Cancel never removes a folder made at that path since.
    const { made_folder: _madeFolder, made_inode: _madeInode, ...unmade } = message.launch;
    const next: InboxMessage =
      "clone" in outcome
        ? { ...message, launch: { ...(outcome.made_inode === null ? unmade : message.launch), clone: outcome.clone, ...(outcome.made_inode ? { made_folder: true as const, made_inode: outcome.made_inode } : {}) } }
        : "to" in outcome
        ? { ...message, to: { host: outcome.to.host, session: outcome.to.session }, launch: { ...message.launch, session: outcome.to.session, session_ref: outcome.session_ref, error: null } }
        : "error" in outcome
          ? { ...message, launch: { ...message.launch, error: outcome.error } }
          : { ...message, launch: { ...message.launch, deleted_at: outcome.deleted_at } };
    this.appendMessage(next, this.stamp());
    return next;
  }

  /** The launched threads' roots (any project, archived included). */
  launchedRoots(): InboxMessage[] {
    return [...this.launchedRootIds].flatMap((id) => {
      const message = this.messages.get(id);
      return message ? [message] : [];
    });
  }

  /**
   * Each agent session's latest message (any project): who it is (host, the
   * name it gave), whether its connection wakes it (`wakes`), where and when
   * it last wrote. Tagging lists the agents that read the Inbox only from it.
   */
  latestAgentMessages(): Map<string, InboxMessage> {
    const out = new Map<string, InboxMessage>();
    for (const [session, id] of this.latestAgentIds) {
      const message = this.messages.get(id);
      // Kept as each message is first applied; a message whose author reads otherwise now is read the long way.
      if (!message || message.author.kind !== "agent" || message.author.session !== session) return this.scanLatestAgentMessages();
      out.set(session, message);
    }
    return out;
  }

  /** `latestAgentMessages` from every message: the index's check. */
  private scanLatestAgentMessages(): Map<string, InboxMessage> {
    const latest = new Map<string, { message: InboxMessage; seq: number }>();
    for (const message of this.messages.values()) {
      if (message.author.kind !== "agent" || !message.author.session) continue;
      const seq = this.messageSeq.get(message.id) ?? 0;
      const known = latest.get(message.author.session);
      if (!known || known.seq < seq) latest.set(message.author.session, { message, seq });
    }
    return new Map([...latest].map(([session, { message }]) => [session, message]));
  }

  /** A message first applied at `seq`: its session's latest, when it is an agent's and the newest of that session's. */
  private noteAgentMessage(message: InboxMessage, seq: number): void {
    if (message.author.kind !== "agent" || !message.author.session) return;
    const session = message.author.session;
    const known = this.latestAgentIds.get(session);
    if (known === undefined || (this.messageSeq.get(known) ?? 0) < seq) this.latestAgentIds.set(session, message.id);
  }

  /**
   * The agent sessions on `host` the person's items can wake: sessions whose
   * messages came through a waking connection (`wakes`), sessions a person's
   * message is addressed to (`to`), and sessions a reply tags with a wake.
   * One pass over the messages (the Codex wake builds its index from it once).
   */
  wakingSessionsOfHost(host: string): Set<string> {
    const out = new Set<string>();
    for (const message of this.messages.values()) {
      if (message.author.kind === "agent") {
        if (message.wakes === true && message.author.host === host && message.author.session) out.add(message.author.session);
        continue;
      }
      if (message.to?.host === host) out.add(message.to.session);
      for (const tag of message.tags ?? []) if (tag.host === host && tag.wakes) out.add(tag.session);
    }
    return out;
  }

  /** The sessions of `host` with a message of their own that wakes. A person's message or tag only names a session, however it runs. */
  sessionsThatWoke(host: string): Set<string> {
    const out = new Set<string>();
    for (const message of this.messages.values()) {
      if (message.author.kind === "agent" && message.wakes === true && message.author.host === host && message.author.session) out.add(message.author.session);
    }
    return out;
  }

  /** The thread each agent session last wrote in (any project): compose's "Last: <subject>". */
  lastThreadsBySession(): Map<string, { id: string; subject: string | null; at: string; project_id: string }> {
    const out = new Map<string, { id: string; subject: string | null; at: string; project_id: string }>();
    for (const [session, message] of this.latestAgentMessages()) {
      out.set(session, { id: message.thread_id, subject: this.threadSubject(message.thread_id), at: message.created_at, project_id: message.project_id });
    }
    return out;
  }

  // ─────────────────────────── thread steps ───────────────────────────
  //
  // Approval "inbox-thread-steps" (2026-11-03). One record per (thread, agent
  // session) in its project's steps.jsonl, on the store's one seq: each line
  // the session's whole list, which replaces the last one. Silent: no message,
  // no unread, no notification, and nothing that routes or lists threads
  // reads it. Whether agents may send steps (the person's switch) is the
  // server's to check; the store keeps whatever was written.

  /** The session's steps in `threadId` (a thread or message id), or null when it sent none. */
  stepsOf(threadId: string, session: string): InboxSteps | null {
    const root = this.messages.get(threadId)?.thread_id ?? threadId;
    const id = this.stepsIdOf.get(`${root}\0${session}`);
    return id ? (this.stepsById.get(id) ?? null) : null;
  }

  /** A thread's lists that hold steps, one per agent session, the latest first. */
  threadSteps(threadId: string): InboxSteps[] {
    const root = this.messages.get(threadId)?.thread_id ?? threadId;
    const out: InboxSteps[] = [];
    for (const id of this.stepsIdsByThread.get(root) ?? []) {
      const record = this.stepsById.get(id);
      if (record && record.steps.length > 0) out.push(record);
    }
    return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
  }

  /**
   * The person answered in the thread at or after `since` (a list's last write): a message of theirs, or a 👍 Looks
   * good still standing on an agent's message (`inboxPersonAnsweredSince`). Read over the stored messages, so a 👍
   * counts though its note is never listed in the thread. The checklist's waiting rule (the row's `steps_waiting`).
   */
  personAnsweredSince(threadId: string, since: string): boolean {
    const root = this.messages.get(threadId)?.thread_id ?? threadId;
    return inboxPersonAnsweredSince(this.threadMessages(root), since);
  }

  /**
   * The person's `reply` answers at least one of `session`'s questions: a question (never an action item) that agent
   * session asked in the thread, sent with this reply and not skipped. A plain reply, a 👍 or a skip answers none. The
   * wake's line that says when to start a checklist (INBOX_STEPS_START_WAKE_LINE) rides only on such a reply.
   */
  answersQuestionsOf(reply: InboxMessage, session: string): boolean {
    if (reply.author.kind !== "person" || reply.ack_of) return false;
    for (const member of this.threadMessages(reply.thread_id)) {
      if (member.author.kind !== "agent" || member.author.session !== session) continue;
      for (const id of this.messageQuestions.get(member.id) ?? []) {
        const record = this.questions.get(id);
        if (record && record.kind !== "action" && record.sent_reply_id === reply.id && record.answer && !record.answer.skipped) return true;
      }
    }
    return false;
  }

  /** Every list that holds steps, in threads that still exist (Tidy reads them). */
  allSteps(): InboxSteps[] {
    const out: InboxSteps[] = [];
    for (const record of this.stepsById.values()) {
      if (record.steps.length > 0 && this.messages.get(record.thread_id)?.thread_id === record.thread_id) out.push(record);
    }
    return out;
  }

  /**
   * Set an agent session's steps in a thread: `steps` is the whole list (an
   * empty one clears it). Refused with a validation_error, nothing written,
   * when the list does not read (inboxSteps limits) or the caller has no
   * session; thread_not_found for an unknown thread. A list that reads the
   * same as the last one writes nothing (`changed` false). `record` is the
   * session's record after the call: null only when it never sent a list and
   * this one is empty (there is no record to name).
   */
  setThreadSteps(input: { thread_id: string; agent: InboxAuthor; steps: unknown }): { record: InboxSteps | null; changed: boolean } {
    const agent = input.agent;
    if (agent.kind !== "agent" || !agent.session?.trim()) {
      throw new InboxError("validation_error", "agent_session: steps belong to an agent session (the connection fills it).", { field: "agent_session" });
    }
    const message = this.messages.get(input.thread_id?.trim?.() ?? "");
    if (!message) throw new InboxError("thread_not_found", `No thread or message ${input.thread_id}.`, { field: "thread_id" });
    const root = this.messages.get(message.thread_id);
    if (!root) throw new InboxError("thread_not_found", `No thread ${message.thread_id}.`, { field: "thread_id" });
    const session = agent.session.trim();
    const previous = this.stepsOf(root.id, session);
    const at = this.now().toISOString();
    const checked = normalizeInboxSteps(input.steps, previous?.steps ?? [], at);
    if ("error" in checked) throw new InboxError("validation_error", checked.error, { field: checked.field });
    if (previous ? sameInboxSteps(previous.steps, checked.steps) : checked.steps.length === 0) {
      return { record: previous, changed: false };
    }
    const record: InboxSteps = {
      id: previous?.id ?? inboxId("stp"),
      project_id: root.project_id,
      thread_id: root.id,
      agent: { kind: "agent", host: agent.host, session, name: agent.name },
      steps: checked.steps,
      updated_at: at,
    };
    const project = this.projectsById.get(root.project_id);
    if (!project) throw new InboxError("project_not_found", `No project ${root.project_id}.`);
    this.write(join(this.projectFolder(project), STEPS_FILE), { v: INBOX_RECORD_VERSION, seq: this.seq + 1, at, kind: "steps", id: record.id, record });
    // An older Inbox never reads steps.jsonl: the floor keeps it from handing out this seq again.
    try {
      this.keepSeqFloor();
    } catch {
      // Best effort: the line is written; only a downgrade would read the floor.
    }
    return { record, changed: true };
  }

  // ─────────────────────────── the Board's cards ───────────────────────────
  //
  // Approval "inbox-board" (2026-10-20). A card is its own record in its
  // project's cards.jsonl: append-only snapshots on the store's one seq
  // counter, so the event stream carries them, and read by nothing that
  // routes or lists threads. Who may move a card (approval
  // "inbox-board-columns-v2"): an agent moves its work through the live
  // columns, ships it and may drop it with a reason; an agent never moves out
  // of Backlog a card the person put there (`moved_by`), and only the person
  // restores a card they dropped. One rule moves a card by itself: every PR it
  // links merged (autoShipCard); nothing else is guessed.

  card(id: string): InboxCard | null {
    return this.cards.get(id) ?? null;
  }

  /** A card as readers get it: only the linked threads that still exist, and the seq of its last write. */
  cardWire(card: InboxCard): InboxCardWire {
    const threads = card.threads.filter((id) => this.messages.get(id)?.thread_id === id);
    // A combined project's cards read the project it went into, as its rows do. The record keeps its own.
    // A card whose initiative was deleted reads as in none (the record keeps the id, for its history).
    // A raw line an older Inbox wrote has no field: it reads the initiative the store kept (apply carries it).
    const held = card.initiative === undefined ? this.cards.get(card.id)?.initiative : card.initiative;
    const initiative = held ? (this.initiativesById.get(held)?.deleted_at === null ? held : null) : null;
    return { ...card, project_id: this.canonicalProjectId(card.project_id), threads, initiative, heard_seq: this.cardHeardSeq.get(card.id) ?? 0 };
  }

  // ─────────────────────────── initiatives ───────────────────────────
  // The Board's initiatives (approval "board-initiatives"): named by the
  // person, across projects; a card is in at most one. Only the person
  // renames them. An agent puts its card in one through the card tool's
  // `initiative` (createCard and updateCard's `initiative_name`), makes one
  // only that way, and may delete one (op `initiative_delete`). Deleting
  // writes no card: a card whose initiative is deleted reads as in none
  // (cardWire), and is back in it if the person undoes the delete. A card made
  // for a thread the person tagged starts in the tagged one, whatever the agent
  // named (createCard). After that whoever sets it last wins, the person or an
  // agent (no write is refused for the other's earlier pick), as any card field.

  /** Every initiative, deleted ones too (a card's history still names them), oldest first. */
  initiatives(): InboxInitiative[] {
    return [...this.initiativesById.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  initiative(id: string): InboxInitiative | null {
    return this.initiativesById.get(id) ?? null;
  }

  private liveInitiative(id: unknown): InboxInitiative {
    const found = isInboxInitiativeId(id) ? this.initiativesById.get(id) : undefined;
    if (!found || found.deleted_at !== null) throw new InboxError("initiative_not_found", `No initiative ${String(id)}.`, { field: "initiative" });
    return found;
  }

  /** A name the person typed, one line; refused when a live initiative (not `self`) already has it, ignoring case. */
  private initiativeName(value: unknown, self: string | null): string {
    const name = this.cardText(value, "name", INBOX_INITIATIVE_NAME_MAX);
    const key = inboxInitiativeNameKey(name);
    for (const other of this.initiativesById.values()) {
      if (other.id !== self && other.deleted_at === null && inboxInitiativeNameKey(other.name) === key) {
        throw new InboxError("initiative_exists", `There is already an initiative named ${other.name}.`, { field: "name", initiative_id: other.id });
      }
    }
    return name;
  }

  private appendInitiative(record: InboxInitiative, at: string): void {
    this.write(join(this.dir, INITIATIVES_FILE), { v: INBOX_RECORD_VERSION, seq: this.seq + 1, at, kind: "initiative", id: record.id, record });
    // An older Inbox never reads initiatives.jsonl: the floor keeps it from handing out this seq again.
    try {
      this.keepSeqFloor();
    } catch {
      // Best effort: the line is written; only a downgrade would read the floor.
    }
  }

  /** A new initiative, named `name` (the person's; an agent makes one only through a card's `initiative_name`). */
  createInitiative(input: { name: unknown; by: InboxAuthor }): InboxInitiative {
    if (input.by.kind !== "person") throw new InboxError("initiative_person_only", "Only the person makes an initiative.");
    const name = this.initiativeName(input.name, null);
    return this.appendNewInitiative(name, input.by);
  }

  private appendNewInitiative(name: string, by: InboxAuthor): InboxInitiative {
    const at = this.stamp();
    const record: InboxInitiative = { id: inboxId("ini"), name, created_at: at, created_by: by, updated_at: at, deleted_at: null };
    this.appendInitiative(record, at);
    return record;
  }

  /**
   * The live initiative a card tool's `initiative` means: its `ini_` id, or
   * its name, ignoring case, or else the first made with the same join key
   * (inboxInitiativeJoinKey). Null when none is, a stale id included.
   */
  initiativeNamed(value: string): InboxInitiative | null {
    return this.initiativeAnswering(value, inboxInitiativeJoinKey);
  }

  /**
   * The live initiative `initiative_delete` means: its `ini_` id, or its name
   * ignoring case, spaces and a leading `#` only. Narrower than initiativeNamed:
   * a card put in the wrong one can be moved, a deleted initiative cannot.
   */
  initiativeToDelete(value: string): InboxInitiative | null {
    return this.initiativeAnswering(value, (name) => inboxInitiativeNameKey(inboxInitiativeBareName(name)).normalize("NFC").replace(/\s+/gu, ""));
  }

  /** A live one by `ini_` id, else by name ignoring case, else the first made with `name`'s `key` (an empty key matches nothing). */
  private initiativeAnswering(value: string, key: (name: string) => string): InboxInitiative | null {
    const text = value.trim();
    const byId = isInboxInitiativeId(text) ? this.initiativesById.get(text) : undefined;
    if (byId?.deleted_at === null) return byId;
    // In the order they were made, as a tag reads them (`initiatives()` breaks a same-millisecond tie by random id).
    const live = [...this.initiativesById.values()].filter((i) => i.deleted_at === null);
    const name = text.replace(/\s+/g, " ");
    const exact = live.find((i) => inboxInitiativeNameKey(i.name) === inboxInitiativeNameKey(name));
    if (exact) return exact;
    const wanted = key(name);
    return wanted ? (live.find((i) => key(i.name) === wanted) ?? null) : null;
  }

  /**
   * A card's initiative given by the card tool's `initiative`: `""` is none, and
   * so is that written out (two quote characters, as agents do send it);
   * a live initiative it names (initiativeNamed) is that one; a stale `ini_`
   * id is ignored (null: the card's initiative stays as it is, never one named
   * after the id), and a value only shaped like an id ("ini_abc", cut short or
   * upper-cased) is not found rather than a name; anything else is a new one's
   * name, without a leading `#` ("#Billing" makes "Billing"; "#" alone is
   * refused as an empty name), checked
   * here (one line, the length) and made by `initiativeOfPick` only once the card
   * write can no longer be refused, so a refused card leaves no initiative behind.
   */
  private initiativePick(value: unknown): { id: string | null } | { make: string } | null {
    if (typeof value !== "string") throw new InboxError("validation_error", "initiative: a name, or \"\" for none.", { field: "initiative" });
    const text = value.trim();
    if (text === "" || text === '""' || text === "''") return { id: null };
    const named = this.initiativeNamed(text);
    if (named) return { id: named.id };
    if (isInboxInitiativeId(text)) return null;
    const name = inboxInitiativeBareName(text);
    if (/^ini_\S*$/iu.test(name)) throw new InboxError("initiative_not_found", `No initiative ${name}.`, { field: "initiative" });
    return { make: this.cardText(name, "initiative", INBOX_INITIATIVE_NAME_MAX) };
  }

  private initiativeOfPick(pick: { id: string | null } | { make: string }, by: InboxAuthor): string | null {
    return "make" in pick ? this.appendNewInitiative(pick.make, by).id : pick.id;
  }

  /** The person renamed an initiative: every card in it reads the new name (they name it by id). */
  renameInitiative(id: string, name: unknown): InboxInitiative {
    const current = this.liveInitiative(id);
    const next = this.initiativeName(name, current.id);
    if (next === current.name) return current;
    const at = this.stamp();
    const record: InboxInitiative = { ...current, name: next, updated_at: at };
    this.appendInitiative(record, at);
    return record;
  }

  /** Deleted (the person, or an agent's `initiative_delete`): its cards read as in none; no card line is written (their ages stay). */
  deleteInitiative(id: string): InboxInitiative {
    const current = this.liveInitiative(id);
    const at = this.stamp();
    const record: InboxInitiative = { ...current, updated_at: at, deleted_at: at };
    this.appendInitiative(record, at);
    return record;
  }

  /**
   * The person's Undo of a delete: its cards read as in it again (they kept
   * its id). Refused when a live one has taken the name since; a live one
   * answers as it is.
   */
  restoreInitiative(id: string): InboxInitiative {
    const current = isInboxInitiativeId(id) ? this.initiativesById.get(id) : undefined;
    if (!current) throw new InboxError("initiative_not_found", `No initiative ${id}.`, { field: "initiative" });
    if (current.deleted_at === null) return current;
    this.initiativeName(current.name, current.id);
    const at = this.stamp();
    const record: InboxInitiative = { ...current, updated_at: at, deleted_at: null };
    this.appendInitiative(record, at);
    return record;
  }

  /** The person put a card in an initiative, or took it out of one (null): one card line, a history entry. */
  setCardInitiative(id: string, initiative: unknown, by: InboxAuthor): InboxCard {
    if (by.kind !== "person") throw new InboxError("initiative_person_only", "Only the person puts a card in an initiative.");
    const card = this.cards.get(id);
    if (!card) throw new InboxError("card_not_found", `No card ${id}.`);
    const next = initiative === null ? null : this.liveInitiative(initiative).id;
    const now = this.cardWire(card).initiative ?? null;
    if (next === now) return card;
    const at = this.stamp();
    const written: InboxCard = { ...card, initiative: next, heard_at: at, heard_by: by };
    this.appendCard(written, at);
    return this.cards.get(id) ?? written;
  }

  /**
   * The person looked at Dropped: every agent's drop they had not seen (in
   * `projectIds`, or everywhere) is marked seen, one line per card. Not a
   * write to the card itself: `heard_at` stays. Answers the cards it marked.
   */
  markCardDropsSeen(projectIds: ReadonlySet<string> | null = null, cardIds: ReadonlySet<string> | null = null): InboxCard[] {
    const marked: InboxCard[] = [];
    for (const card of this.listCards({ projectIds, columns: new Set(["dropped"]) })) {
      if (!isInboxCardDropUnseen(card)) continue;
      // Only the drops the person was shown (the window names them): one that landed after the page drew stays unseen.
      if (cardIds && !cardIds.has(card.id)) continue;
      const at = this.stamp();
      const next: InboxCard = { ...card, dropped: { ...card.dropped!, seen_at: at } };
      this.appendCard(next, at);
      marked.push(next);
    }
    return marked;
  }

  /**
   * Cards in the Board's column order, then the latest move first. Filters:
   * the projects; the columns; the agent session a card belongs to.
   */
  listCards(filter: { projectIds?: ReadonlySet<string> | null; columns?: ReadonlySet<InboxCardColumn> | null; agentSession?: string | null } = {}): InboxCard[] {
    const out: InboxCard[] = [];
    const heads = filter.projectIds ? new Set([...filter.projectIds].map((id) => this.canonicalProjectId(id))) : null;
    for (const card of this.cards.values()) {
      if (heads && !heads.has(this.canonicalProjectId(card.project_id))) continue;
      if (filter.columns && !filter.columns.has(card.column)) continue;
      if (filter.agentSession && !(card.agent?.kind === "agent" && card.agent.session === filter.agentSession)) continue;
      out.push(card);
    }
    return out.sort(
      (a, b) => inboxCardColumnIndex(a.column) - inboxCardColumnIndex(b.column) || b.moved_at.localeCompare(a.moved_at) || a.id.localeCompare(b.id),
    );
  }

  /** An agent's create is idempotent on its key, per project. */
  private cardByKey(projectId: string, key: string): InboxCard | null {
    for (const card of this.cards.values()) if (card.idempotency_key === key && this.sameProject(card.project_id, projectId)) return card;
    return null;
  }

  private appendCard(card: InboxCard, at: string): void {
    const project = this.projectsById.get(card.project_id);
    if (!project) throw new InboxError("project_not_found", `No project ${card.project_id}.`);
    this.write(join(this.projectFolder(project), CARDS_FILE), {
      v: INBOX_RECORD_VERSION,
      seq: this.seq + 1,
      at,
      kind: "card",
      id: card.id,
      // Every line since v2 says so: a line without it is read through the pre-v2 map (readInboxCardColumns).
      record: { ...card, cols: INBOX_CARD_COLS_VERSION },
    });
    // An older Inbox never reads cards.jsonl: the floor keeps it from handing out a card's seq again.
    try {
      this.keepSeqFloor();
    } catch {
      // Best effort: the line is written; only a downgrade would read the floor.
    }
  }

  /** The thread roots `ids` (thread or message ids) name, each in `projectId`. */
  private cardThreads(ids: readonly unknown[], projectId: string): string[] {
    const out: string[] = [];
    for (const id of ids) {
      if (typeof id !== "string" || !id.trim()) throw new InboxError("validation_error", "thread_id: a thread or message id.", { field: "thread_id" });
      const message = this.messages.get(id.trim());
      if (!message) throw new InboxError("thread_not_found", `No thread or message ${id.trim()}.`);
      if (!this.sameProject(message.project_id, projectId)) {
        const project = this.project(message.project_id);
        throw new InboxError(
          "card_other_project",
          `Thread ${message.thread_id} is in project ${project?.name ?? message.project_id} (${project?.root ?? "?"}), not this card's: a card links threads of its own project only.`,
        );
      }
      if (!out.includes(message.thread_id)) out.push(message.thread_id);
    }
    return out;
  }

  /**
   * The references `prs` (each a PR: the card action's `pr`) and `refs` (any
   * source: an issue, a PR, …) name, through the source registry
   * (card-refs.ts), added to `known` each once: by URL, or by `ref` for a
   * forge (`owner/repo#12` as an issue and as a PR). A link-only ref (Jira,
   * YouTrack, a web link) is the same only by URL: its `ref` is a bare key or
   * a label, and DEMO-1 on two Jira sites are two issues. A link the person
   * gives is marked `by: "person"`, also when an agent linked it first (only
   * such a link's favicon is ever fetched); an agent's link is left unmarked.
   */
  private cardRefs(known: readonly InboxCardRef[], prs: readonly unknown[], refs: readonly unknown[], by: InboxAuthor): InboxCardRef[] {
    const out = [...known];
    const add = (value: unknown, hint: "pr" | "any") => {
      const ref = parseInboxCardRef(value, hint);
      if (!ref) {
        const field = hint === "pr" ? "pr" : "ref";
        const help = hint === "pr" ? INBOX_CARD_PR_HINT : INBOX_CARD_REF_HINT;
        throw new InboxError("validation_error", `${help} Not one: ${JSON.stringify(String(value).slice(0, 200))}.`, { field });
      }
      const person = by.kind === "person";
      const linked: InboxCardRef = { ...ref, via: hint === "pr" ? "pr" : "ref", ...(person ? { by: "person" as const } : {}) };
      const same = (k: InboxCardRef) => k.url === ref.url || (k.ref === ref.ref && !inboxCardRefIsLinkOnly(k) && !inboxCardRefIsLinkOnly(ref));
      const at = out.findIndex(same);
      if (at < 0) out.push(linked);
      else {
        // A PR first linked as context, then given as the card's own `pr`: it is the card's PR now (inboxCardShipPrs in core).
        if (hint === "pr" && out[at]!.via !== "pr") out[at] = { ...out[at]!, via: "pr" };
        // The person linking what an agent linked makes it theirs.
        if (person && out[at]!.by !== "person") out[at] = { ...out[at]!, by: "person" };
      }
    };
    for (const value of prs) add(value, "pr");
    for (const value of refs) add(value, "any");
    return out;
  }

  /** The PRs among a card's references, as step 1's `prs` (still written, for an older Inbox). */
  private prsOf(refs: readonly InboxCardRef[]): InboxCardPr[] {
    return refs.filter((ref) => ref.kind === "pr").map((ref) => ({ ref: ref.ref, url: ref.url }));
  }

  private cardText(value: unknown, field: string, max: number): string {
    const result = normalizeInboxCardText(value, field, max);
    if ("error" in result) throw new InboxError("validation_error", result.error, { field });
    return result.text;
  }

  private cardColumn(value: unknown): InboxCardColumn {
    // The ids before v2 (asked, designing, your_look, icebox, …) are still read, so an older agent keeps working.
    const column = inboxCardColumnOf(value);
    if (column === null) {
      throw new InboxError("validation_error", `column: one of ${Object.keys(INBOX_CARD_COLUMN_LABELS).join(", ")}.`, { field: "column" });
    }
    return column;
  }

  /**
   * A new card in `project_id`. From a thread (`threads`), the title defaults
   * to the thread's subject. Unless a column is given it starts in Todo when
   * an agent makes it (it took an ask) and in Backlog when the person does; a
   * live column, or Done for work already finished; Dropped never. An agent
   * that puts it in In review says what the person owes (`you`). The agent
   * that makes a card is the session it belongs to. Idempotent on
   * `idempotency_key` per project.
   */
  createCard(input: {
    project_id: string;
    by: InboxAuthor;
    title?: unknown;
    column?: unknown;
    say?: unknown;
    you?: unknown;
    threads?: readonly unknown[];
    prs?: readonly unknown[];
    refs?: readonly unknown[];
    idempotency_key?: unknown;
    notes?: unknown;
    /** The person's message that sends the new card to an agent: checked before the card is written, one line for both. */
    send_thread_id?: unknown;
    /** The person's New card on a Board filtered to an initiative: it starts in that one (an `ini_` id; null or absent: none). */
    initiative?: unknown;
    /** The card tool's `initiative` (anyone, agents included): a name, matched or made (initiativePick); `""` is none. */
    initiative_name?: unknown;
  }): { card: InboxCard; replayed: boolean; tag_decided?: true } {
    const project = this.projectsById.get(input.project_id);
    if (!project) throw new InboxError("project_not_found", `No project ${input.project_id}.`);
    const byAgent = input.by.kind === "agent";
    const givenInitiative = input.initiative !== undefined && input.initiative !== null;
    if (givenInitiative && byAgent) throw new InboxError("initiative_person_only", "Only the person puts a card in an initiative.", { field: "initiative" });
    const givenName = input.initiative_name !== undefined && input.initiative_name !== null;
    if (givenInitiative && givenName) throw new InboxError("validation_error", "initiative: an id or a name, not both.", { field: "initiative" });
    const initiativeById = givenInitiative ? this.liveInitiative(input.initiative).id : null;
    const sending = input.send_thread_id !== undefined && input.send_thread_id !== null;
    if (sending && byAgent) throw new InboxError("validation_error", "thread_id: only the person sends a card to an agent.", { field: "thread_id" });
    const target = sending ? this.cardSendTarget(project.id, input.send_thread_id) : null;
    const threads = this.cardThreads(input.threads ?? [], project.id);
    if (target && !threads.includes(target.thread)) threads.push(target.thread);
    // Made for a thread of a combined project: filed in that thread's folder, so an undo takes the card along.
    const owner = threads.length > 0 ? this.messages.get(threads[0]!)!.project_id : project.id;
    let titleValue = input.title;
    if ((titleValue === undefined || titleValue === null || titleValue === "") && threads.length > 0) {
      // The agent did not write the subject: characters a title refuses (bidi controls) are dropped, not refused.
      const subject = stripInboxCardRefusedChars(this.threadSubject(threads[0]!) ?? "");
      titleValue = [...subject.replace(/\s+/g, " ").trim()].slice(0, INBOX_CARD_TITLE_MAX).join("");
    }
    if (titleValue === undefined || titleValue === null || titleValue === "") {
      throw new InboxError("validation_error", "title: a short title (or thread_id, whose subject it takes).", { field: "title" });
    }
    const title = this.cardText(titleValue, "title", INBOX_CARD_TITLE_MAX);
    const rawKey = input.idempotency_key;
    if (rawKey !== undefined && rawKey !== null && typeof rawKey !== "string") throw new InboxError("validation_error", "idempotency_key: a string.", { field: "idempotency_key" });
    const key = typeof rawKey === "string" && rawKey.trim() !== "" ? rawKey.trim() : null;
    if (key !== null && ([...key].length > INBOX_CARD_KEY_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(key))) {
      throw new InboxError("validation_error", `idempotency_key: at most ${INBOX_CARD_KEY_MAX} characters, one line.`, { field: "idempotency_key" });
    }
    if (key !== null) {
      const known = this.cardByKey(project.id, key);
      if (known) {
        if (known.title !== title) throw new InboxError("idempotency_key_reused", "This idempotency_key made another card.", { card_id: known.id });
        // A retry that sends: the card the key made is sent now if it was not (sendCard is a no-op when it was).
        if (target) return { card: this.sendCard(known.id, { thread_id: input.send_thread_id }), replayed: true };
        return { card: known, replayed: true };
      }
    }
    // Checked here, after a replay answered (a retry makes no initiative), and made only just before the card is written.
    const pick = givenName ? this.initiativePick(input.initiative_name) : null;
    // Sent to an agent: Todo (the person asked for it). Otherwise an agent's card is work it took on (Todo), the person's an idea (Backlog).
    const column = input.column === undefined || input.column === null ? (byAgent || target ? "todo" : "backlog") : this.cardColumn(input.column);
    if (column === "dropped") throw new InboxError("validation_error", "column: a new card starts in a live column (or done), never dropped.", { field: "column" });
    if (target && column !== "backlog" && column !== "todo") throw new InboxError("validation_error", "thread_id: a card sent to an agent starts in Todo.", { field: "thread_id" });
    const said = input.say === undefined || input.say === null ? null : this.cardText(input.say, "say", INBOX_CARD_LINE_MAX);
    const you: string | null = input.you === undefined || input.you === null ? null : this.cardText(input.you, "you", INBOX_CARD_LINE_MAX);
    if (you !== null && !isInboxCardPersonColumn(column)) throw this.youRefusal();
    if (byAgent && isInboxCardPersonColumn(column) && you === null) throw this.youRequired(column);
    const refs = this.cardRefs([], input.prs ?? [], input.refs ?? [], input.by);
    const prs = this.prsOf(refs);
    this.checkLinkCounts(threads.length, refs.length);
    // The last check that can refuse (notes) comes before a new initiative is made.
    const notes = this.cardNotes(input.notes);
    // Made for a thread the person tagged (`#Shape`, approval "board-hashtags"): it starts in that initiative,
    // over an agent's name (none is made for it) or "". Only the person's own pick on New card holds.
    const tagged = initiativeById === null ? this.threadTaggedInitiative(threads) : null;
    const initiative = tagged ? null : pick ? this.initiativeOfPick(pick, input.by) : initiativeById;
    const at = this.stamp();
    const card: InboxCard = {
      id: inboxId("crd"),
      project_id: owner,
      title,
      // A sent card goes to Todo: the send asks the agent to do it.
      column: target ? "todo" : column,
      you,
      said,
      threads,
      prs,
      agent: target ? target.to : byAgent ? input.by : null,
      created_at: at,
      created_by: input.by,
      moved_at: at,
      moved_by: input.by,
      heard_at: at,
      heard_by: input.by,
      dropped: null,
      aside_from: null,
      idempotency_key: key,
      notes,
      sent: target ? { at, to: target.to, thread_id: target.thread } : null,
      refs,
      ...(column === "done" && !target ? { done_prs: inboxCardDonePrs({ refs, prs }) } : {}),
      initiative,
    };
    this.appendCard(card, at);
    if (tagged) {
      // The tag is what decided it, unless the agent named that very one.
      const agreed = pick !== null && "id" in pick && pick.id === tagged;
      return { card: this.setCardInitiative(card.id, tagged, { kind: "person" }), replayed: false, ...(agreed ? {} : { tag_decided: true as const }) };
    }
    return { card, replayed: false };
  }

  /**
   * One write to a card: any of a move (`column`), the agent's last word
   * (`say`), the person's line (`you`), a rename, more threads or PRs, and a
   * drop's `reason`. Every write counts as hearing from the card (`heard_at`).
   * `restore` (the person) puts a card in Dropped back where it was. The
   * rules (approval "inbox-board-columns-v2"):
   *  - an agent may put a card in Backlog, but moves one out of it only when
   *    an agent put it there (`moved_by`): what the person parked stays;
   *  - an agent drops with a reason; only the person restores what they dropped;
   *  - an agent that moves a card into In review says what the person owes
   *    (`you`), and `you` is kept only there.
   */
  updateCard(
    id: string,
    input: {
      by: InboxAuthor;
      column?: unknown;
      say?: unknown;
      you?: unknown;
      title?: unknown;
      threads?: readonly unknown[];
      prs?: readonly unknown[];
      refs?: readonly unknown[];
      reason?: unknown;
      restore?: boolean;
      notes?: unknown;
      /** The card tool's `initiative` (anyone): a name, matched or made (initiativePick); `""` takes the card out. */
      initiative_name?: unknown;
    },
  ): InboxCard {
    const card = this.cards.get(id);
    if (!card) throw new InboxError("card_not_found", `No card ${id}.`);
    const byAgent = input.by.kind === "agent";
    const given = (value: unknown) => value !== undefined && value !== null;
    if (
      !given(input.column) &&
      !given(input.say) &&
      !given(input.you) &&
      !given(input.title) &&
      !(input.threads && input.threads.length > 0) &&
      !(input.prs && input.prs.length > 0) &&
      !(input.refs && input.refs.length > 0) &&
      input.notes === undefined &&
      !given(input.initiative_name) &&
      !input.restore
    ) {
      throw new InboxError("validation_error", "Nothing to change: pass column, say, you, title, thread_id, pr or initiative.");
    }
    let column = card.column;
    if (input.restore) {
      if (byAgent) throw new InboxError("card_person_only", "Only the person restores a cancelled card.");
      if (card.column !== "dropped") {
        throw new InboxError("validation_error", `Card ${id} is in ${INBOX_CARD_COLUMN_LABELS[card.column]}, not Cancelled: nothing to restore.`);
      }
      column = card.aside_from ?? "backlog";
    } else if (given(input.column)) {
      column = this.cardColumn(input.column);
    }
    const moves = column !== card.column;
    if (moves && byAgent) {
      if (card.column === "backlog" && card.moved_by?.kind === "person") {
        throw new InboxError(
          "card_backlog_person_only",
          "The person put this card in Backlog; only they move it out (they send it to an agent when it is to be done). You can still say or link.",
          { field: "column" },
        );
      }
      if (card.column === "dropped" && card.dropped?.by.kind === "person") {
        throw new InboxError("card_dropped_by_person", "The person cancelled this card; only they restore it. You can still say or link.");
      }
    }
    let dropped = card.dropped;
    if (moves && column === "dropped") {
      const reason = given(input.reason) ? this.cardText(input.reason, "reason", INBOX_CARD_REASON_MAX) : null;
      if (byAgent && reason === null) throw new InboxError("validation_error", "reason: an agent drops a card with a reason (one line the person reads).", { field: "reason" });
      const at = this.stamp();
      // An agent's drop waits for the person to see it; one they made is seen when made.
      dropped = { at, by: input.by, reason, seen_at: byAgent ? null : at };
    } else if (given(input.reason)) {
      throw new InboxError("validation_error", "reason: only with a drop (column dropped).", { field: "reason" });
    } else if (moves) {
      dropped = null;
    }
    let you = card.you;
    if (moves && !isInboxCardPersonColumn(column)) you = null;
    if (given(input.you)) {
      if (!isInboxCardPersonColumn(column)) throw this.youRefusal();
      you = this.cardText(input.you, "you", INBOX_CARD_LINE_MAX);
    } else if (moves && byAgent && isInboxCardPersonColumn(column)) {
      throw this.youRequired(column);
    }
    const said = given(input.say) ? this.cardText(input.say, "say", INBOX_CARD_LINE_MAX) : card.said;
    const title = given(input.title) ? this.cardText(input.title, "title", INBOX_CARD_TITLE_MAX) : card.title;
    const threads = [...card.threads];
    for (const thread of this.cardThreads(input.threads ?? [], card.project_id)) if (!threads.includes(thread)) threads.push(thread);
    const refs = this.cardRefs(inboxCardRefsOf(card), input.prs ?? [], input.refs ?? [], input.by);
    const prs = this.prsOf(refs);
    this.checkLinkCounts(threads.length, refs.length);
    const notes = input.notes === undefined ? card.notes : this.cardNotes(input.notes);
    // Made (when new) only now, with nothing left to refuse the card's write.
    const pick = given(input.initiative_name) ? this.initiativePick(input.initiative_name) : null;
    const picked = pick ? { initiative: this.initiativeOfPick(pick, input.by) } : {};
    const at = this.stamp();
    // Leaving a live column (or Done) for Dropped remembers it, so restoring goes back there.
    const asideFrom =
      moves && column === "dropped"
        ? isInboxCardLiveColumn(card.column) || card.column === "done"
          ? card.column
          : card.aside_from
        : moves
          ? null
          : card.aside_from;
    const next: InboxCard = {
      ...card,
      title,
      column,
      you,
      said,
      threads,
      prs,
      refs,
      moved_at: moves ? at : card.moved_at,
      moved_by: moves ? input.by : (card.moved_by ?? null),
      heard_at: at,
      heard_by: input.by,
      dropped,
      aside_from: asideFrom,
      notes,
      ...picked,
      // Into Done by hand (anyone's ship, a restore to Done): its PRs then never move it there again by themselves.
      ...(moves && column === "done" ? { done_prs: inboxCardDonePrs({ refs, prs }, card.done_prs) } : {}),
    };
    this.appendCard(next, at);
    // A thread the person tagged, linked now to a card in none: the card goes in that initiative.
    const added = threads.filter((thread) => !card.threads.includes(thread));
    const tagged = added.length > 0 && this.cardWire(next).initiative === null ? this.threadTaggedInitiative(added) : null;
    if (tagged) return this.setCardInitiative(id, tagged, { kind: "person" });
    return next;
  }

  /** Hashtags: the tags in a message's body, indexed to its thread (`tagThreads`). Code holds no tag. */
  private indexTags(message: InboxMessage, seq: number): void {
    if (typeof message.body !== "string" || !message.body.includes("#")) return;
    for (const key of new Set(inboxHashtags(message.body).map((tag) => tag.key))) {
      if (!key) continue;
      let entry = this.tagThreads.get(key);
      if (!entry) this.tagThreads.set(key, (entry = { latest: new Map(), order: [] }));
      if ((entry.latest.get(message.thread_id) ?? -1) >= seq) continue;
      entry.latest.set(message.thread_id, seq);
      entry.order.push(message.thread_id);
      if (entry.order.length > 2 * entry.latest.size + 16) {
        // Keep each thread's last entry only, in order.
        const seen = new Set<string>();
        entry.order = entry.order.reverse().filter((id) => !seen.has(id) && !!seen.add(id)).reverse();
      }
    }
  }

  /**
   * Hashtags: for each live initiative that a message tags, the latest-tagged threads (at most `limit`,
   * thread ids, newest tag first) that `linked` (its cards' threads) leaves out, and `total`, how many such
   * threads there are. Walks the index from its newest end and stops at `limit`: no sort, no message parsed,
   * so a tag used in thousands of threads costs the same as one used in a few.
   */
  initiativeThreads(options: { limit?: number; linked?: (initiativeId: string) => ReadonlySet<string> | undefined } = {}): Record<string, { threads: string[]; total: number }> {
    const limit = options.limit ?? Infinity;
    const out: Record<string, { threads: string[]; total: number }> = {};
    for (const initiative of this.initiativesById.values()) {
      if (initiative.deleted_at !== null) continue;
      const entry = this.tagThreads.get(inboxInitiativeTagKey(initiative.name));
      if (!entry || entry.latest.size === 0) continue;
      const linked = options.linked?.(initiative.id);
      let total = entry.latest.size;
      if (linked) for (const id of linked) if (entry.latest.has(id)) total--;
      const threads: string[] = [];
      const seen = new Set<string>();
      for (let i = entry.order.length - 1; i >= 0 && threads.length < limit; i--) {
        const id = entry.order[i]!;
        if (seen.has(id)) continue;
        seen.add(id);
        if (linked?.has(id)) continue;
        // A delete reloads the store, so every indexed thread exists; checked anyway, cheaply.
        if (this.isThreadRoot(id)) threads.push(id);
      }
      if (total > 0) out[initiative.id] = { threads, total };
    }
    return out;
  }

  /**
   * Hashtags (approval "board-hashtags"): the person's message in a thread
   * that tags a live initiative (`#Shape`; the last one wins) puts the
   * thread's cards in it, as if the person set it on each (a history line
   * each). A cancelled card stays as it is.
   */
  private tagThreadCards(threadId: string, words: string): void {
    const tagged = inboxTaggedInitiative(words, [...this.initiativesById.values()]);
    if (!tagged) return;
    for (const card of [...this.cards.values()]) {
      if (card.column === "dropped" || !card.threads.includes(threadId)) continue;
      if (this.cardWire(card).initiative === tagged.id) continue;
      this.setCardInitiative(card.id, tagged.id, { kind: "person" });
    }
  }

  /** The initiative the person's latest tag in any of `threads` names (newest message first), or null. */
  private threadTaggedInitiative(threads: readonly string[]): string | null {
    const live = [...this.initiativesById.values()];
    if (!live.some((i) => i.deleted_at === null)) return null;
    let best: { seq: number; id: string } | null = null;
    for (const thread of threads) {
      const messages = this.threadMessages(thread);
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]!;
        if (message.author.kind !== "person") continue;
        const found = inboxTaggedInitiative(personWords(message.body), live);
        if (!found) continue;
        const seq = this.messageSeq.get(message.id) ?? 0;
        if (!best || seq > best.seq) best = { seq, id: found.id };
        break;
      }
    }
    return best?.id ?? null;
  }

  private cardNotes(value: unknown): string | null {
    const result = normalizeInboxCardNotes(value);
    if ("error" in result) throw new InboxError("validation_error", result.error, { field: "notes" });
    return result.notes;
  }

  /**
   * What happened to a card, newest first (the opened card's History). Read
   * from its project's cards.jsonl when asked (one card opened), so memory
   * holds only each card's latest snapshot, never every line of every card.
   */
  cardHistory(id: string): InboxCardHistoryEntry[] {
    const card = this.cards.get(id);
    if (!card) return [];
    const project = this.projectsById.get(card.project_id);
    let text = "";
    try {
      if (project) text = readFileSync(join(this.projectFolder(project), CARDS_FILE), "utf8");
    } catch {
      // No file to read (removed under us): the card as it stands is all there is.
    }
    const lines: { seq: number; card: InboxCard }[] = [];
    for (const raw of text.split("\n")) {
      const line = parseInboxLine(raw);
      if (line?.kind === "card" && line.record.id === id) lines.push({ seq: line.seq, card: line.record });
    }
    lines.sort((a, b) => a.seq - b.seq);
    // A line an Inbox from before initiatives wrote has no `initiative`: the card kept its own (as apply reads it).
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!.card;
      const kept = i > 0 && raw.initiative === undefined ? lines[i - 1]!.card.initiative : raw.initiative;
      lines[i] = { seq: lines[i]!.seq, card: readInboxCard({ ...raw, initiative: kept }) };
    }
    return inboxCardHistory(lines.length > 0 ? lines.map((line) => line.card) : [card]);
  }

  /**
   * The person sent a card to an agent (step 2): `thread_id` is the thread
   * they just started for it (compose's Send, its body the card's notes),
   * addressed to one session. The card links the thread and becomes that
   * agent's (`agent`, so the agent's `card list` shows it as its own), and
   * keeps `sent` so the Board says "Sent to <agent>" until the card moves.
   * Only the person sends, only a Backlog or Todo card (it lands in Todo,
   * as the person's move), only into a thread of the
   * card's own project that the person started.
   */
  sendCard(id: string, input: { thread_id: unknown }): InboxCard {
    const card = this.cards.get(id);
    if (!card) throw new InboxError("card_not_found", `No card ${id}.`);
    const { thread, to } = this.cardSendTarget(card.project_id, input.thread_id, card.threads);
    // A retry of the same send (the window's Send or Start, after an answer that was lost) changes nothing.
    if (isInboxCardSentWaiting(card) && card.sent!.thread_id === thread && card.sent!.to.kind === "agent" && to.kind === "agent" && card.sent!.to.session === to.session) {
      return card;
    }
    if (card.column !== "backlog" && card.column !== "todo") {
      throw new InboxError("validation_error", `Card ${id} is in ${INBOX_CARD_COLUMN_LABELS[card.column]}: only a Backlog or Todo card is sent to an agent.`, { field: "op" });
    }
    const at = this.stamp();
    // A send asks the agent to do it: the card is in Todo from now (the person moved it).
    const moves = card.column !== "todo";
    const next: InboxCard = {
      ...card,
      column: "todo",
      moved_at: moves ? at : card.moved_at,
      moved_by: moves ? { kind: "person" } : (card.moved_by ?? null),
      threads: card.threads.includes(thread) ? card.threads : [...card.threads, thread],
      agent: to,
      heard_at: at,
      heard_by: { kind: "person" },
      sent: { at, to, thread_id: thread },
    };
    this.checkLinkCounts(next.threads.length, next.refs.length);
    this.appendCard(next, at);
    return next;
  }

  /**
   * Where a card goes when the person sends it: `threadId` is the person's
   * message for it (a thread they started, or a New message in the card's
   * thread), in `projectId` or already on the card (`linked`: a thread linked
   * while two projects were combined stays linked after an undo), addressed
   * to one agent session. Checked before anything is written, so a refused
   * send leaves no card and no line.
   */
  private cardSendTarget(projectId: string, threadId: unknown, linked: readonly string[] = []): { thread: string; to: InboxAuthor } {
    const sentMessage = typeof threadId === "string" ? this.messages.get(threadId.trim()) : undefined;
    const [thread] = sentMessage && linked.includes(sentMessage.thread_id) ? [sentMessage.thread_id] : this.cardThreads([threadId], projectId);
    if (!sentMessage || sentMessage.author.kind !== "person" || !sentMessage.to || (sentMessage.id === sentMessage.thread_id && !sentMessage.started_by_person)) {
      throw new InboxError("validation_error", "thread_id: the person's message for this card (a thread they started, or a message in its thread), addressed to one agent session.", { field: "thread_id" });
    }
    return { thread: thread!, to: { kind: "agent", host: sentMessage.to.host, session: sentMessage.to.session, name: INBOX_HOST_NAMES[sentMessage.to.host] ?? null } };
  }

  private checkLinkCounts(threads: number, prs: number): void {
    if (threads > INBOX_CARD_LINKS_MAX || prs > INBOX_CARD_LINKS_MAX) {
      throw new InboxError("validation_error", `A card links at most ${INBOX_CARD_LINKS_MAX} threads and ${INBOX_CARD_LINKS_MAX} PRs.`);
    }
  }

  /**
   * The Inbox ships a card by itself (v2, Q3): every PR it links has merged
   * and none is open (`prs`, the URLs inboxCardAutoShip answered). Rechecked
   * here against the card as it stands, so a card that moved since the
   * states were read, or was already moved to Done for these PRs, is left alone.
   * Not an agent's write: `heard_by` is the person's side (no unread bold),
   * and the history says "Done automatically". Answers the card, or null
   * when nothing was done.
   */
  autoShipCard(id: string, prs: readonly string[]): InboxCard | null {
    const card = this.cards.get(id);
    if (!card) return null;
    const merged = new Set(prs);
    const urls = inboxCardAutoShip(card, (url) => (merged.has(url) ? "merged" : undefined));
    if (!urls) return null;
    const at = this.stamp();
    const by: InboxAuthor = { kind: "person" };
    const next: InboxCard = {
      ...card,
      column: "done",
      you: null,
      moved_at: at,
      moved_by: by,
      heard_at: at,
      heard_by: by,
      dropped: null,
      aside_from: null,
      auto_shipped: { at, prs: urls },
      done_prs: inboxCardDonePrs(card, card.done_prs),
    };
    this.appendCard(next, at);
    return next;
  }

  private youRefusal(): InboxError {
    return new InboxError(
      "validation_error",
      "you: what the person owes shows only in In review. Move the card there with it, or use say for your own last word.",
      { field: "you" },
    );
  }

  private youRequired(column: InboxCardColumn): InboxError {
    return new InboxError(
      "validation_error",
      `you: a card moved into ${INBOX_CARD_COLUMN_LABELS[column]} says what the person owes, one line (e.g. "pick one of the five hero options").`,
      { field: "you" },
    );
  }
}
