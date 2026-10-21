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

import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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
  isInboxQuestionSupersedable,
  parseInboxQuestionBlocks,
  parseInboxSupersedeRef,
  summarizeInboxQuestions,
  toInboxQuestion,
  type InboxAnswerRefusal,
} from "@plannotator/core/inbox-questions";
import {
  inboxId,
  INBOX_ACK_LABEL,
  INBOX_RECORD_VERSION,
  type InboxAck,
  type InboxAddressee,
  type InboxAuthor,
  type InboxGuideRef,
  type InboxLine,
  type InboxMessage,
  type InboxMessageWire,
  type InboxPicker,
  type InboxProject,
  type InboxQuestion,
  type InboxQuestionRecord,
  type InboxSupersededBy,
  type InboxListRow,
  type InboxListSection,
  type InboxThread,
  type InboxThreadSummary,
  checkInboxThreadName,
  type InboxThreadNaming,
  inboxThreadNameKey,
  isInboxNote,
  inboxAgentName,
  INBOX_HOST_NAMES,
  INBOX_TAGS_MAX,
  type InboxParticipant,
  type InboxSentRecipient,
  type InboxTag,
  inboxAskingMessage,
  inboxDefaultSkip,
  inboxDeliveryState,
  type InboxDeliveryConnection,
  type InboxQuestionState,
  type InboxRowDelivery,
} from "@plannotator/core/inbox-types";
import { inboxListSections, inboxRowUnread, inboxSectionOf } from "./list";
import { inboxProjectLabels } from "./project-name";
import { inboxAckLine } from "./connection";
import type { QuestionAnswer } from "@plannotator/core/question-block";
import { sanitizeTag } from "@plannotator/core/project";
import {
  INBOX_ANNOTATION_CURRENT,
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
  type InboxInlineImage,
} from "@plannotator/core/inbox-types";
import { isLineRangeInPatch, parseDiffToFiles, type DiffFile } from "@plannotator/core/diff-files";
import { inboxBlobPath, inboxBlobSizes, removeUnusedInboxBlobs } from "./attachments";
import { inboxMarkupNamesOf, removeInboxMarkups } from "./markups";
import { pendingInboxUploadBlobs, removeUnusedInboxUploadFiles } from "./uploads";
import { inboxDraftsBytes } from "./drafts";
import { INBOX_CARD_PR_HINT, parseInboxCardPr } from "./cards";
import {
  INBOX_CARD_COLUMN_LABELS,
  INBOX_CARD_KEY_MAX,
  INBOX_CARD_LINE_MAX,
  INBOX_CARD_LINKS_MAX,
  INBOX_CARD_REASON_MAX,
  INBOX_CARD_TITLE_MAX,
  inboxCardColumnIndex,
  isInboxCardColumn,
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
import {
  ANNOTATIONS_FILE,
  CARDS_FILE,
  LEGACY_DECISIONS_FILE,
  INBOX_PROJECTS_DIR,
  SEQ_FLOOR_FILE,
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
  body: string;
  subject?: string | null;
  reply_to?: string | null;
  idempotency_key?: string | null;
  /**
   * A thread name in this project: the open thread of that name, across
   * sessions, or a new one under it. Without it (and without reply_to) the
   * message joins its session's open default thread. Ignored with reply_to.
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
  /** A guided review the message carries (submit_guide); its blob is written once the message lands. */
  guide?: InboxGuideRef | null;
  /** The folder inside the project the agent sent from, when not its root (`InboxMessage.base_path`). */
  base_path?: string | null;
  /**
   * Earlier questions of the same thread this message supersedes:
   * `<message id>` (each open question of it) or `<message id>/<key>`. A
   * `Replaces:` line in the body's blocks does the same per block. One id
   * that names no open question of the thread refuses the whole send
   * (`invalid_supersedes`).
   */
  supersedes?: readonly string[] | null;
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
}

export interface InboxAnswerEntry {
  key: string;
  revision: number;
  /** Absent: keep the current pick (Send only). Null: clear the pick. */
  answer?: unknown;
}

export interface InboxReplyInput {
  words?: string;
  questions?: InboxAnswerEntry[];
  idempotency_key: string;
  /**
   * The person's annotations on the thread's attachments, as Plannotator's
   * feedback text (the window exports them), appended after the answers.
   */
  feedback?: string;
  /** The annotations that text carries: marked sent with the reply. */
  annotation_ids?: string[];
  /**
   * The person chose another live session to take this reply, because the
   * session that asked has ended (the window's choice at Send). Absent: the
   * reply goes to the asking session, as always. Null: a session was asked
   * for but the server found it not live; nothing is written
   * (`session_not_live`), except that a replay answers what it wrote.
   */
  to?: InboxAddressee | null;
  /**
   * Skip the message's questions this Send leaves unanswered (no pick): each
   * is sent as a skip marked `by_reply`, in the same reply. The window sends
   * true unless the person pressed Keep open; absent (an older window, the
   * MCP) keeps them open.
   */
  skip_unanswered?: boolean;
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
}

/** The person's Re-ask (approval "inbox-reask"): ask the agent for its open questions again, in one message. */
export interface InboxReaskInput {
  idempotency_key: string;
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

/** An annotation as stored: without the exporter's `exportLocation`, which only the window sets, on its export copies. */
function withoutExportLocation(annotation: Record<string, unknown>): Record<string, unknown> {
  if (!("exportLocation" in annotation)) return annotation;
  const { exportLocation: _dropped, ...rest } = annotation;
  return rest;
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

/** A person's reply that tags agents (`tags`, approval "inbox-tag-agents"). */
function hasTags(message: InboxMessage): boolean {
  return (message.tags?.length ?? 0) > 0;
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
    const { host, session, name, wakes, label } = entry as Record<string, unknown>;
    if (typeof session !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(session)) {
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
    });
  }
  return out;
}

/** The most ids one send may supersede. */
export const INBOX_SUPERSEDES_MAX = 100;

/** `<name>-<6 hex of the root>`, so two repositories with one name stay apart. */
export function inboxProjectKey(name: string, root: string, hashLength = 6): string {
  const base = sanitizeTag(name) ?? "project";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, Math.min(hashLength, 64));
  return `${base}-${hash}`;
}

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
  /** Whether the session that asked is still there, with the sessions route's grace (`askerLive`). */
  askerLive(session: string): boolean;
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
  private readonly messages = new Map<string, InboxMessage>();
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
  /**
   * Thread routing, kept from each root's first line in seq order, so a
   * replay of the log gives the same answers: the newest unnamed root an
   * agent session started in a project (`<project>\0<session>`), and the
   * newest root of each thread name (`<project>\0<name key>`).
   */
  private readonly sessionThreads = new Map<string, string>();
  /** Each thread's message ids in seq order. */
  private readonly threadMembers = new Map<string, string[]>();
  /** Every root of each thread name in seq order (`<project>\0<name key>`). */
  private readonly namedThreads = new Map<string, string[]>();
  /**
   * Threads the person started, by the name compose gave them (typed or the
   * suggestion): never routes anything, only keeps a second open thread
   * from taking the name (`threadNameTaken`).
   */
  private readonly personNamed = new Map<string, string[]>();
  /** The person's annotations on attachments, by id. */
  private readonly annotations = new Map<string, InboxAnnotationRecord>();
  /** The Board's cards, by id (approval "inbox-board"). Read by nothing that routes or lists threads. */
  private readonly cards = new Map<string, InboxCard>();
  /** A guided review's files by its snapshot's sha256 (a blob never changes). */
  private readonly guideFileSets = new Map<string, ReadonlyMap<string, DiffFile>>();
  private readonly tornFiles = new Set<string>();
  private readonly listeners = new Set<InboxListener>();
  /** How many times the store was read again from disk (a deletion): a reader's derived view is stale once it changes. */
  private reloads = 0;
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
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      // Best effort (Windows, a filesystem without modes).
    }
    this.seq = Math.max(this.seq, this.readSeqFloor());
    const projectsDir = join(this.dir, INBOX_PROJECTS_DIR);
    if (!existsSync(projectsDir)) return;
    const lines: InboxLine[] = [];
    for (const key of readdirSync(projectsDir)) {
      const folder = join(projectsDir, key);
      // Decisions were removed (2026-10): an older store's decisions.jsonl is
      // left on disk and never applied, but its seqs still count, so a seq is
      // never handed out twice.
      this.seq = Math.max(this.seq, legacySeqFloor(join(folder, LEGACY_DECISIONS_FILE)));
      for (const name of [PROJECT_FILE, MESSAGES_FILE, QUESTIONS_FILE, ANNOTATIONS_FILE, CARDS_FILE]) {
        const path = join(folder, name);
        let text: string;
        try {
          text = readFileSync(path, "utf8");
        } catch {
          continue;
        }
        if (text.length > 0 && !text.endsWith("\n")) this.tornFiles.add(path);
        for (const raw of text.split("\n")) {
          const line = parseInboxLine(raw);
          if (line) lines.push(line);
        }
      }
    }
    lines.sort((a, b) => a.seq - b.seq);
    for (const line of lines) this.apply(line);
    this.repairUnsentAnswers();
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
    this.questions.set(record.id, record);
    const key = `question:${record.id}`;
    const line = this.latest.get(key);
    if (line && line.kind === "question") this.latest.set(key, { ...line, record });
  }

  private apply(line: InboxLine): void {
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
        if (!this.messageSeq.has(line.record.id)) {
          this.messageSeq.set(line.record.id, line.seq);
          const members = this.threadMembers.get(line.record.thread_id);
          if (members) members.push(line.record.id);
          else this.threadMembers.set(line.record.thread_id, [line.record.id]);
          this.indexRoot(line.record);
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
        this.annotations.set(line.record.id, line.record);
        break;
      case "card":
        // Cards are their own records: nothing here touches routing or the list.
        this.cards.set(line.record.id, line.record);
        break;
    }
  }

  /** Note a root's routing keys, from its first line only. */
  private indexRoot(message: InboxMessage): void {
    if (message.thread_id !== message.id) return;
    // A thread the person started is no session's default thread, and its compose name (typed, or
    // the suggestion) routes nothing: it is noted only so no other thread takes the same name.
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
    if (name !== null) {
      this.indexName(message.project_id, name, message.id);
    } else if (message.author.session) {
      this.sessionThreads.set(`${message.project_id}\0${message.author.session}`, message.id);
    }
  }

  /** The roots a name routes to (agents' names: a name, once there, never changes), oldest first. */
  private rootsNamed(projectId: string, name: string): string[] {
    return this.namedThreads.get(`${projectId}\0${inboxThreadNameKey(name)}`) ?? [];
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
   * person reopened counts); else the newest unnamed thread the session
   * started there, while it is open (resolved means done, so the next message
   * starts anew). No session and no name: always a new thread.
   */
  private routeThread(projectId: string, session: string | null, name: string | null): string | null {
    if (name !== null) {
      const roots = this.rootsNamed(projectId, name);
      for (let i = roots.length - 1; i >= 0; i--) if (!this.isResolved(roots[i]!)) return roots[i]!;
      return null;
    }
    const rootId = session ? this.sessionThreads.get(`${projectId}\0${session}`) : undefined;
    if (!rootId || this.isResolved(rootId)) return null;
    return rootId;
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

  /**
   * The project as every reader sees it: `name` is the real name of its
   * folder (`inboxProjectLabels`), not the slug it was stored with, which
   * stays its folder key. The record on disk is unchanged.
   */
  private labeled(project: InboxProject): InboxProject {
    this.projectLabels ??= inboxProjectLabels([...this.projectsById.values()]);
    const name = this.projectLabels.get(project.id);
    return name && name !== project.name ? { ...project, name } : project;
  }

  listProjects(): InboxProject[] {
    return [...this.projectsById.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((project) => this.labeled(project));
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
    return questions.length > 0 ? { ...message, questions } : { ...message };
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
   * keeps the subject it gave.
   */
  threadSubject(threadId: string): string | null {
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
    const personRoots = (this.personNamed.get(`${projectId}\0${key}`) ?? []).filter(
      (rootId) => inboxThreadNameKey(this.messages.get(rootId)?.thread_name ?? "") === key,
    );
    return [...this.rootsNamed(projectId, name), ...personRoots].some((rootId) => rootId !== exceptRoot && !this.isResolved(rootId));
  }

  thread(threadId: string): InboxThread | null {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) return null;
    const project = this.project(root.project_id);
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
          ...(message.ack ? { ack: { ...message.ack, delivered_at: this.ackDeliveredAt(message.ack) } } : {}),
        };
      }),
    };
  }

  threadSummary(threadId: string): InboxThreadSummary | null {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) return null;
    // The note carrying a 👍 is not a message of the thread as the person sees it.
    const messages = this.threadMessages(threadId).filter((m) => !isAckNote(m));
    const last = messages[messages.length - 1] ?? root;
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

  /** A project's threads, the newest activity first. */
  threadsOf(projectId: string): InboxThreadSummary[] {
    const out: InboxThreadSummary[] = [];
    for (const message of this.messages.values()) {
      if (message.project_id !== projectId || message.thread_id !== message.id) continue;
      const summary = this.threadSummary(message.id);
      if (summary) out.push(summary);
    }
    return out.sort((a, b) => b.last_at.localeCompare(a.last_at) || b.thread_id.localeCompare(a.thread_id));
  }

  /** One row of the list: the thread's summary, its project label and its section. */
  listRow(threadId: string): InboxListRow | null {
    const summary = this.threadSummary(threadId);
    if (!summary) return null;
    const root = this.messages.get(threadId)!;
    const project = this.projectsById.get(root.project_id);
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
      if (message.author.kind === "person" && !isInboxNote(message)) lastPersonSeq = seqOf(message);
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
      // Sent until one of them takes it (its wait_for_reply) or reads the thread.
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
    const sent =
      lastReal.author.kind === "person"
        ? {
            at: lastReal.created_at,
            checked_at: recipients
              ? taggedChecked(recipients)
              : (root.agent_checked_seq ?? 0) >= seqOf(lastReal)
                ? (root.agent_checked_at ?? null)
                : null,
            wakes: this.wakesRecipient(lastReal),
            ...(recipients ? { recipients } : {}),
          }
        : null;
    const participants = this.participantsOf(messages);
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
      (root.agent_checked_seq ?? 0) < seqOf(lastReal);
    const backFromArchive =
      agentAfterArchive &&
      (messages.some((m) => m.author.kind === "agent" && seqOf(m) > archiveSeq! && seqOf(m) > seenSeq) ||
        summary.questions.open > 0 ||
        summary.questions.picked > 0 ||
        replyUnread);
    const statesOf = (message: InboxMessage) => askingStates?.get(message.id) ?? [];
    const asking = askingStates ? inboxAskingMessage(messages, statesOf, inboxDefaultSkip(messages, statesOf)) : null;
    const delivery = this.rowDelivery(root, lastReal, asking, sent, recipients, root.resolved_at !== null && !agentAfterArchive);
    const facts = {
      ...summary,
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
      last_agent_at: lastAgentAt,
      ...(root.started_by_person && root.to ? { addressee: { host: root.to.host, session: root.to.session } } : {}),
      ...(participants.length > 1 ? { participants } : {}),
    };
    const section = inboxSectionOf(facts);
    return { ...facts, section, unread: inboxRowUnread(section) };
  }

  /** The live sessions the rows' delivery reads (the server's); null forgets them. */
  setDeliveryPresence(presence: InboxDeliveryPresence | null): void {
    this.deliveryPresence = presence;
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
    sent: { checked_at: string | null } | null,
    recipients: InboxSentRecipient[] | null,
    resolved: boolean,
  ): InboxRowDelivery | null {
    const presence = this.deliveryPresence;
    // Not read (no presence): undefined, as the thread before it reads the session.
    const connectionOf = (session: string): InboxDeliveryConnection | null | undefined => {
      if (!presence) return undefined;
      const connection = presence.connection(session);
      return connection ? { busy: connection.busy, send_now: connection.send_now } : null;
    };
    const askerLive = (session: string): boolean => (presence ? presence.askerLive(session) : true);

    if (lastReal.author.kind === "person") {
      if (isInboxNote(lastReal)) return null;
      const last = lastReal;
      // A thread the person started is addressed to a session; a reply in it goes there too.
      const startedTo = root.started_by_person && root.to ? root.to : null;
      const lastTo = last.to ?? (startedTo && last.reply_to ? startedTo : null);
      const askedBy = last.reply_to ? this.messages.get(last.reply_to) : undefined;
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
          undelivered: !last.delivery && !askerLive(lastTo.session),
          askerEnded: false,
          wakes: true,
          sendingNow: !!last.deliver_now_at,
          connection,
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
        undelivered: false,
        askerEnded,
        wakes: wakingSession !== null || (askedSession !== null && connection != null),
        sendingNow: !!last.deliver_now_at,
        connection,
      });
      const author = root.author.kind === "agent" ? root.author : null;
      return {
        kind,
        state: decision.state,
        reason: decision.reason,
        send_now: decision.sendNow,
        message_id: last.id,
        at: deliveredAt,
        host: author?.host ?? null,
        name: author?.name ?? null,
        ...(decision.reason === "ended" && askingAuthor ? { asking: { host: askingAuthor.host ?? null, name: askingAuthor.name ?? null } } : {}),
      };
    }

    // 👍 Looks good on the latest agent message (the thread's `ackPillLine`): sent through, not withdrawn.
    const target = lastReal;
    const ack = target.ack;
    if (target.author.kind !== "agent" || !ack || ack.not_sent) return null;
    const base = { kind: "ack" as const, message_id: target.id, host: target.author.host ?? null, name: target.author.name ?? null, send_now: false };
    const deliveredAt = this.ackDeliveredAt(ack);
    if (deliveredAt) return { ...base, state: "delivered", reason: "delivered", at: deliveredAt };
    if (ack.settled_seq == null) return { ...base, state: "queued", reason: "ack_pending", at: null };
    if (target.wakes === true && ack.note_id) {
      const session = target.author.session;
      const decision = inboxDeliveryState({
        delivered: false,
        undelivered: false,
        askerEnded: false,
        wakes: true,
        sendingNow: false,
        connection: session ? connectionOf(session) : undefined,
      });
      return { ...base, state: decision.state === "sending" ? "sending" : "queued", reason: decision.reason, at: null };
    }
    return { ...base, state: "saved", reason: "reads", at: null };
  }

  /**
   * The list's rows, newest activity first: every thread, or one project's
   * (`projectId`), or the threads an agent session sent any message in
   * (`session`: the threads it started, joined or replied in).
   */
  listRows(filter: { projectId?: string | null; session?: string | null } = {}): InboxListRow[] {
    const out: InboxListRow[] = [];
    for (const [threadId, members] of this.threadMembers) {
      const root = this.messages.get(threadId);
      if (!root || root.thread_id !== threadId) continue;
      if (filter.projectId && root.project_id !== filter.projectId) continue;
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
        return state === "open" || state === "picked";
      });
      if (this.readAt(root, members) === null || waiting.length > 0) {
        const at = this.stamp();
        let latestAgent = 0;
        for (const m of members) if (m.author.kind === "agent") latestAgent = Math.max(latestAgent, this.messageSeq.get(m.id) ?? 0);
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
              answer: inboxSkipAnswer(record, { byReply: false }),
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
                },
              },
            },
            at,
          );
        }
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
        for (const message of members) {
          if (message.author.kind === "agent" && message.ack && root.person_read_seq != null && message.ack.read_seq === root.person_read_seq) {
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
    const row = this.listRow(threadId);
    if (!row) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    return row;
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
   * delivered like any reply (the wake, wait_for_reply). Each question is
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
   */
  ackMessage(messageId: string, on: boolean): { message: InboxMessageWire; thread: InboxListRow } {
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
        };
        this.appendMessage({ ...this.messages.get(messageId)!, ack }, at);
      }
    } else if (message.ack) {
      const ack = message.ack;
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
   * body is `inboxAckLine` (`ack_of`), delivered like any reply (the wake,
   * wait_for_reply's `acknowledged`). The note's line is the one a held
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
        body: inboxAckLine(message.id),
        created_at: noteAt,
        resolved_at: null,
        idempotency_key: null,
        ack_of: message.id,
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

  /** The note carrying a message's 👍 to the agent, while it stands. */
  ackNote(messageId: string): InboxMessage | null {
    const noteId = this.messages.get(messageId)?.ack?.note_id;
    const note = noteId ? this.messages.get(noteId) : undefined;
    return note && this.ackNoteLive(note) ? note : null;
  }

  /** Acks not settled yet (still inside their Undo window, or a stop interrupted it). */
  acksPending(): number {
    let count = 0;
    for (const message of this.messages.values()) if (message.ack && message.ack.settled_seq == null) count++;
    return count;
  }

  /**
   * A thread as an agent reads it (read_thread): an ack shows only once it
   * settled, as `{ label, at }`; one still inside its Undo window (or taken
   * back) is not there.
   */
  agentThread(threadId: string, caller: string | null = null): InboxThread | null {
    const thread = this.thread(threadId);
    if (!thread) return null;
    return {
      ...thread,
      messages: thread.messages.map((message) => {
        let out: InboxMessageWire = message;
        if (message.ack !== undefined) {
          const { ack, ...rest } = message;
          out = { ...rest, ack: ack && ack.settled_seq != null && !ack.not_sent ? { label: ack.label, at: ack.at } : null } as InboxMessageWire;
        }
        // Who a reply tagged (approval "inbox-tag-agents"), as an agent reads it: the agents and, for
        // the reader, that it was tagged. Delivery state is the person's view, not the agent's.
        if (message.tags && message.tags.length > 0) {
          const { tags, ...rest } = out;
          const taggedYou = caller !== null && !this.isOwner(message, caller) && tags!.some((t) => t.session === caller);
          out = {
            ...rest,
            tagged: tags!.map((t) => ({ agent: t.name || (t.host ? inboxAgentName({ kind: "agent", host: t.host, name: null }) : "An agent"), session: t.session })),
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
   * An agent read the thread's settled acks (read_thread, or wait_for_reply's
   * `acknowledged`): each gets `seen_at`, so the window's pill says "<agent>
   * saw it". `upToSeq` limits it to acks settled at or before that seq. An
   * ack that was not sent (`not_sent`) is never seen. `only` limits it to
   * those messages (a windowed read marks only the acks it showed).
   */
  markAcksSeen(threadId: string, upToSeq = Number.POSITIVE_INFINITY, at = this.stamp(), only?: ReadonlySet<string>): void {
    for (const message of this.threadMessages(threadId)) {
      const ack = message.ack;
      if (only && !only.has(message.id)) continue;
      if (!ack || ack.settled_seq == null || ack.not_sent || ack.settled_seq > upToSeq || ack.seen_at) continue;
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
      } else if (message && !isInboxNote(message)) seen = Math.max(seen, seq);
    }
    if (latestAgent > seen) {
      const at = this.stamp();
      this.appendMessage({ ...root, person_seen_seq: latestAgent }, at);
    }
    const row = this.listRow(threadId);
    if (!row) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    return row;
  }

  /**
   * An agent read the person's replies in a thread: read_thread read the
   * whole thread, or wait_for_reply returned one reply (`upToSeq`, that
   * reply's seq, so a later reply it was not given still reads as unread).
   * A Sent row moves to Quiet once its last reply is checked. No write when
   * there is no person reply it has not read.
   */
  markAgentChecked(threadId: string, upToSeq = Number.POSITIVE_INFINITY, at = this.stamp()): void {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) return;
    let checked = 0;
    for (const id of this.threadMembers.get(threadId) ?? []) {
      const seq = this.messageSeq.get(id) ?? 0;
      if (seq <= upToSeq && this.messages.get(id)?.author.kind === "person") checked = Math.max(checked, seq);
    }
    if (checked === 0 || (root.agent_checked_seq ?? 0) >= checked) return;
    this.appendMessage({ ...root, agent_checked_seq: checked, agent_checked_at: at }, at);
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
    let total = [...blobSizes.values()].reduce((sum, size) => sum + size, 0) + inboxDraftsBytes(this.dir);
    for (const project of this.listProjects()) {
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
      for (const name of [PROJECT_FILE, MESSAGES_FILE, QUESTIONS_FILE, LEGACY_DECISIONS_FILE, ANNOTATIONS_FILE, CARDS_FILE]) {
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
            line.kind === "message" ? line.record.id : line.kind === "question" || line.kind === "annotation" ? line.record.message_id : null;
          const threadId = messageId ? this.messages.get(messageId)?.thread_id : undefined;
          if (!threadId) continue;
          perThread.set(threadId, (perThread.get(threadId) ?? 0) + Buffer.byteLength(raw) + 1);
        }
      }
      const threads = [...perThread.entries()]
        .map(([threadId, threadBytes]) => ({ thread_id: threadId, subject: this.threadSubject(threadId), bytes: threadBytes }))
        .sort((a, b) => b.bytes - a.bytes || a.thread_id.localeCompare(b.thread_id));
      projects.push({ id: project.id, name: project.name, root: project.root, bytes, threads });
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
    // One line, written whole: temp file then rename.
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
    const body = input.body;
    if (typeof body !== "string" || body.trim() === "") throw new InboxError("validation_error", "body: a message needs a body.", { field: "body" });
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
    const key = input.idempotency_key?.trim() || null;
    if (key) {
      for (const message of this.messages.values()) {
        if (message.project_id !== projectId || message.idempotency_key !== key || message.author.kind !== "agent") continue;
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
        if (message.body !== body || message.reply_to !== replyTo || !sameName || !sameGuide || !sameSupersedes) {
          throw new InboxError(
            "idempotency_key_reused",
            "This idempotency_key was already used for a different message.",
            { message_id: message.id },
          );
        }
        return { message: this.wire(message), replayed: true, ...(message.thread_naming ? { naming: message.thread_naming } : {}) };
      }
    }

    if (!replyTo) threadId = this.routeThread(projectId, input.author.session, threadName);

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
    // Checked before anything is written: one id that names no open question
    // of this thread refuses the whole send.
    const superseding = this.planSupersede(threadId, id, supersedes, parsed);
    const agentSubject = input.subject?.trim() || null;
    const message: InboxMessage = {
      id,
      project_id: projectId,
      thread_id: threadId ?? id,
      reply_to: replyTo,
      author: input.author,
      subject: threadId ? null : (agentSubject || deriveInboxSubject(body, parsed)),
      ...(threadId ? {} : { subject_question: !agentSubject && parsed[0] ? `${id}/${parsed[0].key}` : null }),
      ...(supersedes.length > 0 ? { supersedes } : {}),
      body,
      created_at: at,
      resolved_at: null,
      idempotency_key: key,
      thread_name: threadName,
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments.map((attachment) => ({ ...attachment, sent_at: at })) }
        : {}),
      ...(input.inline_images !== undefined ? { inline_images: input.inline_images.map((image) => ({ ...image, sent_at: at })) } : {}),
      ...(input.guide ? { guide: input.guide } : {}),
      ...(input.base_path ? { base_path: input.base_path } : {}),
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
    // The superseded questions last, so whoever reads them finds the message
    // that superseded them. A pick saved on one stays on it, never sent.
    for (const [questionId, by] of superseding) {
      const record = this.questions.get(questionId)!;
      this.appendQuestion({ ...record, superseded_by: by }, at);
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
    return { message: this.wire(message), replayed: false, ...(naming ? { naming } : {}) };
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

  /** A thread's questions that may still be superseded (open, or picked and not sent), with their prompts. */
  openQuestionsOf(threadId: string | null): { id: string; prompt: string }[] {
    if (threadId === null) return [];
    const out: { id: string; prompt: string }[] = [];
    for (const message of this.threadMessages(threadId)) {
      const closed = this.closedByArchive(message);
      for (const record of this.questionRecords(message.id)) {
        if (isInboxQuestionSupersedable(inboxQuestionState(record, closed))) out.push({ id: record.id, prompt: record.prompt });
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
  ): Map<string, InboxSupersededBy> {
    const plan = new Map<string, InboxSupersededBy>();
    const only = parsed.length === 1 ? parsed[0]!.key : null;
    const requests: { ref: string; by: InboxSupersededBy; where: string }[] = [
      ...supersedes.map((ref) => ({ ref, by: { message_id: messageId, key: only }, where: "supersedes" })),
      ...parsed.flatMap((question) =>
        question.replaces.map((ref) => ({ ref, by: { message_id: messageId, key: question.key }, where: "Replaces:" })),
      ),
    ];
    if (requests.length === 0) return plan;
    const problems: string[] = [];
    // Which new block's Replaces: line claimed each old question: two blocks
    // cannot both replace one question.
    const claimedBy = new Map<string, string>();
    for (const { ref, by, where } of requests) {
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
      const records = this.questionRecords(message.id).filter((r) => target.key === null || r.key === target.key);
      if (target.key !== null && records.length === 0) {
        problems.push(`${where} ${ref}: message ${target.message_id} has no question ${target.key}.`);
        continue;
      }
      const resolved = this.closedByArchive(message);
      const open = records.filter((r) => isInboxQuestionSupersedable(inboxQuestionState(r, resolved)));
      if (open.length === 0) {
        problems.push(
          target.key === null
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
      for (const record of open) if (!plan.has(record.id) || by.key !== null) plan.set(record.id, by);
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
   * Check every entry against the message's questions and plan the new
   * records. Nothing is written unless every entry passes.
   */
  private planAnswers(
    message: InboxMessage,
    entries: readonly InboxAnswerEntry[],
    mode: "pick" | "send",
  ): { record: InboxQuestionRecord; answer: QuestionAnswer | null | undefined }[] {
    const records = new Map(this.questionRecords(message.id).map((r) => [r.key, r]));
    const seen = new Set<string>();
    const plan: { record: InboxQuestionRecord; answer: QuestionAnswer | null | undefined }[] = [];
    entries.forEach((entry, index) => {
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
      if (!record) throw refusalError({ code: "question_not_found", key: entry.key });
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
      }
      plan.push({ record, answer });
    });
    return plan;
  }

  /** Save picks at once (no reply is written): each revision goes up by one. */
  savePicks(messageId: string, entries: readonly InboxAnswerEntry[]): InboxQuestion[] {
    const message = this.targetMessage(messageId);
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new InboxError("validation_error", "questions: at least one question is required.", { field: "questions" });
    }
    const plan = this.planAnswers(message, entries, "pick");
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
    const plan = this.planAnswers(message, entries, "send");
    const feedback = typeof input.feedback === "string" ? input.feedback.trim() : "";
    const carried = this.planSentAnnotations(message.thread_id, input.annotation_ids);
    // A Send skips the message's questions it leaves unanswered (no pick),
    // unless the person pressed Keep open. Superseded and closed ones are not open.
    const planned = new Set(plan.map((p) => p.record.key));
    const skips =
      input.skip_unanswered === true
        ? this.questionRecords(message.id).filter((r) => !planned.has(r.key) && inboxQuestionState(r, false) === "open")
        : [];
    const attachments = input.attachments ?? [];
    if (plan.length === 0 && skips.length === 0 && words.trim() === "" && feedback === "" && attachments.length === 0) {
      // A target a Send meant only to skip, whose questions closed meanwhile
      // (answered, replaced, a Mark read): nothing to write, not a refusal.
      if (input.skip_unanswered === true) throw new InboxError("nothing_to_send", "Nothing is left to send on this message.");
      throw new InboxError("validation_error", "words: write a reply or send at least one answer.", { field: "words" });
    }

    const replyId = inboxId("msg");
    const at = this.stamp();
    const sentKeys = new Set([...plan.map((p) => p.record.key), ...skips.map((r) => r.key)]);
    const skipped = skips.map(
      (record) =>
        ({
          ...record,
          answer: inboxSkipAnswer(record, { byReply: true }),
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
    const updated = [...answered, ...skipped];
    const all = this.questionRecords(message.id);
    const earlier = all
      .filter((r) => !sentKeys.has(r.key) && r.answer !== null && r.sent_revision > 0 && r.sent_revision === r.revision)
      .map((r) => r.answer as QuestionAnswer);
    // A reply that answers nothing says which questions stay open: every one
    // the replied-to message's session asked in this thread (it asked in one
    // message and posted a plain update after it, and the words go to the
    // update), never another session's.
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
      : all;
    // The picks first, then the annotations as Plannotator's feedback text.
    const body = [
      composeInboxReplyBody({
        questions: all,
        sent: updated.map((r) => r.answer as QuestionAnswer),
        earlier,
        words,
        stillOpen,
      }),
      feedback,
    ]
      .filter((part) => part !== "")
      .join("\n\n");

    // The questions first, so whoever reads the reply finds them already sent.
    // If any of these writes fails, the questions written so far are put back
    // as they were (on disk, repairUnsentAnswers does the same at the next
    // start), so a failed Send never leaves answers "sent" with no reply.
    // Another live session takes it (the asking one ended), or, for more words
    // on a message of the person's own (a thread they started, before the agent
    // answered), the session that message is addressed to now. Stamped on the
    // line, so only that session is handed it and only its delivery settles it.
    const to = input.to ?? (message.author.kind === "person" && message.to ? message.to : undefined);
    const tags = normalizeInboxTags(input.tags, to?.session ?? (message.author.kind === "agent" ? (message.author.session ?? null) : null));
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
      ...(to ? { to: { host: to.host, session: to.session } } : {}),
      ...(attachments.length > 0 ? { attachments: attachments.map((attachment) => ({ ...attachment, sent_at: at })) } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    };
    try {
      for (const record of updated) this.appendQuestion(record, at);
      for (const record of carried) this.appendAnnotation({ ...record, sent_reply_id: replyId, updated_at: at }, at);
      this.appendMessage(reply, at);
    } catch (error) {
      for (const { record } of plan) this.restoreQuestion(record);
      for (const record of skips) this.restoreQuestion(record);
      for (const record of carried) this.restoreAnnotation(record);
      throw error;
    }
    return { reply, questions: this.questionsOf(message.id), replayed: false };
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
      .flatMap((m) => this.questionRecords(m.id));
    const picked = records.filter((r) => inboxQuestionState(r, false) === "picked" && r.answer !== null);
    const open = records.filter((r) => inboxQuestionState(r, false) === "open");
    if (open.length === 0) throw new InboxError("nothing_to_reask", "No open question is left to ask again.");

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
      ...(to ? { to: { host: to.host, session: to.session } } : {}),
    };
    try {
      for (const record of answered) this.appendQuestion(record, at);
      this.appendMessage(note, at);
    } catch (error) {
      for (const record of picked) this.restoreQuestion(record);
      throw error;
    }
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
  private reaskWaiting(messages: readonly InboxMessage[]): boolean {
    // Most threads have no Re-ask note: they cost nothing more.
    if (!messages.some((m) => m.author.kind === "person" && (m.reask?.length ?? 0) > 0)) return false;
    const states = new Map<string, string>();
    for (const m of messages) if (m.author.kind === "agent") for (const q of this.questionsOf(m.id)) states.set(`${m.id}/${q.key}`, q.state);
    const covered = new Set<string>();
    messages.forEach((note, index) => {
      if (note.author.kind !== "person" || (note.reask?.length ?? 0) === 0) return;
      const asked = note.reply_to ? this.messages.get(note.reply_to) : undefined;
      const by = note.to ?? (asked?.author.kind === "agent" ? { host: asked.author.host ?? "", session: asked.author.session } : null);
      if (!by) return;
      const wrote = messages
        .slice(index + 1)
        .some((m) => m.author.kind === "agent" && m.author.session === by.session && (m.author.host ?? "") === (by.host ?? ""));
      if (wrote) return;
      for (const id of note.reask!) if (states.get(id) === "open") covered.add(id);
    });
    const open = [...states].filter(([, state]) => state === "open").map(([id]) => id);
    return open.length > 0 && open.every((id) => covered.has(id));
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

  /** Resolve (or reopen) the thread a message belongs to. */
  resolveThread(messageId: string, resolved: boolean): InboxThreadSummary {
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
    if (existing && (existing.guide || existing.message || existing.path !== hit.attachment.path || existing.version !== input.version || existing.thread_id !== hit.message.thread_id)) {
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
   * attachment's annotation, as the review app's export.
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
    if (!isLineRangeInPatch(diff.patch, start as number, end as number, side)) {
      const range = start === end ? `line ${start}` : `lines ${start}-${end}`;
      throw new InboxError("validation_error", `annotation.lineStart / lineEnd: ${range} on the ${side} side of ${file} is not in one hunk of the guided review's patch.`, { field: "annotation.lineStart" });
    }
    if (fields.scope !== undefined && fields.scope !== "line") {
      throw new InboxError("validation_error", 'annotation.scope: a guided-review comment is on lines ("line").', { field: "annotation.scope" });
    }
    if (fields.text !== undefined && typeof fields.text !== "string") throw new InboxError("validation_error", "annotation.text: a string.", { field: "annotation.text" });
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
      annotation: fields,
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
   * the person selected. Only an agent's message takes one, and only while it
   * can be answered (an archive closes the messages before its line). The
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
    // A comment on selected words (a quick label such as 👍 is a comment too); never a deletion or a general comment.
    if (fields.type !== "COMMENT") throw new InboxError("validation_error", 'annotation.type: "COMMENT" (a comment on the words selected).', { field: "annotation.type" });
    const quote = fields.originalText;
    if (typeof quote !== "string" || quote.trim() === "" || quote.length > INBOX_MESSAGE_COMMENT_QUOTE_MAX) {
      throw new InboxError("validation_error", `annotation.originalText: the words selected (1 to ${INBOX_MESSAGE_COMMENT_QUOTE_MAX} characters).`, { field: "annotation.originalText" });
    }
    // The comment itself: a quick label (👍) carries its label as its text, so every comment has words to send.
    const text = fields.text;
    if (typeof text !== "string" || text.trim() === "" || text.length > INBOX_MESSAGE_COMMENT_TEXT_MAX) {
      throw new InboxError("validation_error", `annotation.text: the comment (1 to ${INBOX_MESSAGE_COMMENT_TEXT_MAX} characters).`, { field: "annotation.text" });
    }
    // A comment on a message's words is words: no images, no element or page it points at, no reply thread.
    for (const field of ["images", "elementContext", "pageUrl", "inReplyTo"] as const) {
      const value = fields[field];
      if (value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)) throw new InboxError("validation_error", `annotation.${field}: a comment on a message's text takes none.`, { field: `annotation.${field}` });
    }
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

  private restoreAnnotation(record: InboxAnnotationRecord): void {
    this.annotations.set(record.id, record);
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
    this.keepSeqFloor();
    for (const name of [MESSAGES_FILE, QUESTIONS_FILE, ANNOTATIONS_FILE]) {
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
    this.keepSeqFloor();
    rmSync(this.projectFolder(project), { recursive: true, force: true });
    this.reload(markups);
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
    this.latest.clear();
    this.projectsById.clear();
    this.projectsByRoot.clear();
    this.projectLabels = null;
    this.messages.clear();
    this.messageSeq.clear();
    this.resolvedSeq.clear();
    this.readdressed.clear();
    this.questions.clear();
    this.messageQuestions.clear();
    this.sessionThreads.clear();
    this.threadMembers.clear();
    this.namedThreads.clear();
    this.personNamed.clear();
    this.annotations.clear();
    this.cards.clear();
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
    // A person's sent uploads are files under inbox/uploads/<att_id>/: they go with their message.
    removeUnusedInboxUploadFiles(this.dir, attachmentIds);
    const stillNamed = this.markupsOf(() => true);
    removeInboxMarkups(this.dir, [...deletedMarkups].filter((name) => !stillNamed.has(name)));
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
   * agent (wait_for_reply or read_thread; any agent's read counts, as for the
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
      const owner = this.isOwner(message, session);
      const tag = owner ? null : tagOf(message, session);
      if (tag) {
        if (tag.delivery || options.tags === false) continue;
        out.push({ message, seq: this.messageSeq.get(message.id) ?? 0 });
        continue;
      }
      if (message.delivery || !owner) continue;
      // A 👍 taken back before it went is never delivered.
      if (isAckNote(message) && !this.ackNoteLive(message)) continue;
      const seq = this.messageSeq.get(message.id) ?? 0;
      // A New message, or a reply the person sent to another session, is
      // settled only by its delivery to the session it names (its own
      // wait_for_reply records one), never by another agent's read; so is a
      // reply that tags agents.
      if (!message.to && !hasTags(message) && (this.messages.get(message.thread_id)?.agent_checked_seq ?? 0) >= seq) continue;
      out.push({ message, seq });
    }
    return out.sort((a, b) => a.seq - b.seq).map((entry) => entry.message);
  }

  /**
   * A connection delivered a reply into a session as a turn: the reply
   * records it (`delivery` for its owner, the tag's own `delivery` for a
   * tagged session), and, for the owner, the thread counts as read by the
   * agent up to it (the Sent band's "Delivered to <agent>, <time>"). A tagged
   * session's delivery marks nothing for the owner. Idempotent per session.
   */
  recordDelivery(replyId: string, by: { host: string; session: string }): InboxMessage {
    const reply = this.messages.get(replyId);
    if (!reply || reply.author.kind !== "person" || (!reply.reply_to && !reply.to)) throw new InboxError("message_not_found", `No reply ${replyId}.`);
    if (!this.isFor(reply, by.session)) {
      throw new InboxError("validation_error", "session: this reply answers another session's message.", { field: "session" });
    }
    if (!this.isOwner(reply, by.session)) {
      const tag = tagOf(reply, by.session)!;
      if (tag.delivery) return reply;
      const at = this.stamp();
      const delivered: InboxMessage = {
        ...reply,
        tags: reply.tags!.map((t) => (t.session === by.session ? { ...t, delivery: { state: "delivered" as const, host: by.host, session: by.session, at } } : t)),
      };
      this.appendMessage(delivered, at);
      return delivered;
    }
    if (reply.delivery) return reply;
    const at = this.stamp();
    const delivered: InboxMessage = { ...reply, delivery: { state: "delivered", host: by.host, session: by.session, at } };
    this.appendMessage(delivered, at);
    this.markAgentChecked(reply.thread_id, this.messageSeq.get(reply.id) ?? 0, at);
    // A 👍 that reached the agent was seen: a later wait on every thread is not answered by it again.
    if (isAckNote(reply) && reply.ack_of) this.markAckSeen(reply.ack_of, at);
    return delivered;
  }

  /**
   * A session that is not woken (MCP) read a thread it was tagged in with
   * read_thread: its tags there record the read (`read_at`), so the window
   * can say it saw it. Its own read only; nothing changes for the owner or
   * any other recipient, and it is not a delivery. No write when nothing is new.
   */
  recordTagRead(threadId: string, session: string): void {
    for (const message of this.threadMessages(threadId)) {
      const tag = message.author.kind === "person" && !this.isOwner(message, session) ? tagOf(message, session) : null;
      if (!tag || tag.wakes || tag.delivery || tag.read_at) continue;
      const at = this.stamp();
      this.appendMessage({ ...message, tags: message.tags!.map((t) => (t.session === session ? { ...t, read_at: at } : t)) }, at);
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
   * taken yet (no delivery): wait_for_reply without a thread waits on them
   * too, and read_thread lists them, wherever their project is.
   */
  taggedThreadsOf(session: string): string[] {
    const out = new Set<string>();
    for (const message of this.messages.values()) {
      if (message.author.kind !== "person" || this.isOwner(message, session)) continue;
      const tag = tagOf(message, session);
      if (tag && !tag.delivery) out.add(message.thread_id);
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
  requestDeliverNow(messageId: string, session?: string | null): InboxMessage {
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
      const next: InboxMessage = { ...message, tags: message.tags!.map((t) => (t.session === tag.session ? { ...t, deliver_now_at: at } : t)) };
      this.appendMessage(next, at);
      return next;
    }
    if (!this.recipientOf(message)) {
      throw new InboxError("not_addressed", "Only your reply or message to an agent session can be sent now.");
    }
    if (message.delivery) throw new InboxError("already_delivered", "That session already took this.", { delivery: message.delivery });
    if (message.deliver_now_at) return message;
    const at = this.stamp();
    const next: InboxMessage = { ...message, deliver_now_at: at };
    this.appendMessage(next, at);
    return next;
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
  sendNewMessage(threadId: string, input: { body: unknown; to: InboxAddressee | null; idempotency_key: unknown }): { message: InboxMessage; replayed: boolean } {
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
    };
    this.appendMessage(message, at);
    return { message, replayed: false };
  }
  // ──────────── Compose: a thread the person starts with a live agent ────────────

  /**
   * The person starts a thread, addressed to one live agent session (`to`):
   * a root person message (`started_by_person`, `reply_to` null) whose
   * subject is derived from the body. It is no session's default thread
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
  }): { message: InboxMessage; replayed: boolean } {
    const key = typeof input.idempotency_key === "string" ? input.idempotency_key.trim() : "";
    if (!key) throw new InboxError("validation_error", "idempotency_key: required on a Send.", { field: "idempotency_key" });
    const body = typeof input.body === "string" ? input.body.trim() : "";
    const auto = input.thread_name_auto === true;
    let threadName: string | null = null;
    if (input.thread_name !== undefined && input.thread_name !== null && !(typeof input.thread_name === "string" && input.thread_name.trim() === "")) {
      const checked = checkInboxThreadName(input.thread_name);
      if (checked.ok) threadName = checked.name;
      else if (!auto) throw new InboxError("validation_error", `thread_name: ${checked.message}`, { field: "thread_name" });
    }
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
    if (!body) throw new InboxError("validation_error", "body: write a message.", { field: "body" });
    if (!this.projectsById.has(input.project_id)) throw new InboxError("project_not_found", `No project ${input.project_id}.`);
    if (threadName && auto && this.threadNameTaken(input.project_id, threadName, null)) threadName = null;
    if (threadName && this.threadNameTaken(input.project_id, threadName, null)) {
      throw new InboxError(
        "thread_name_taken",
        `Another open thread in this project is already named "${threadName}". Pick another name, or leave it empty.`,
        { field: "thread_name" },
      );
    }
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
      ...(threadName ? { thread_name: threadName, named_by: { kind: auto ? ("auto" as const) : ("person" as const), at } } : {}),
      ...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments.map((attachment) => ({ ...attachment, sent_at: at })) } : {}),
    };
    this.appendMessage(message, at);
    return { message, replayed: false };
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
   */
  readdressMessage(messageId: string, to: InboxAddressee | null): InboxMessage {
    const message = this.messages.get(messageId);
    if (!message) throw new InboxError("message_not_found", `No message ${messageId}.`);
    if (message.author.kind !== "person" || !message.to || isInboxNote(message)) {
      throw new InboxError("not_addressed", "Only a message you addressed to an agent session can be sent to another one.");
    }
    if (message.delivery) throw new InboxError("already_delivered", "That session already took this message.", { delivery: message.delivery });
    if (this.isResolved(message.thread_id)) throw new InboxError("thread_resolved", "This thread is archived; unarchive it first.");
    if (!to) throw new InboxError("session_not_live", "That session is not live any more: nothing was changed. Pick another live session.");
    if (message.to.session === to.session && message.to.host === to.host) return message;
    const at = this.stamp();
    const next: InboxMessage = { ...message, to: { host: to.host, session: to.session } };
    this.appendMessage(next, at);
    return next;
  }

  /**
   * Each agent session's latest message (any project): who it is (host, the
   * name it gave), whether its connection wakes it (`wakes`), where and when
   * it last wrote. Tagging lists the agents that read the Inbox only from it.
   */
  latestAgentMessages(): Map<string, InboxMessage> {
    const latest = new Map<string, { message: InboxMessage; seq: number }>();
    for (const message of this.messages.values()) {
      if (message.author.kind !== "agent" || !message.author.session) continue;
      const seq = this.messageSeq.get(message.id) ?? 0;
      const known = latest.get(message.author.session);
      if (!known || known.seq < seq) latest.set(message.author.session, { message, seq });
    }
    return new Map([...latest].map(([session, { message }]) => [session, message]));
  }

  /** The thread each agent session last wrote in (any project): compose's "Last: <subject>". */
  lastThreadsBySession(): Map<string, { id: string; subject: string | null; at: string; project_id: string }> {
    const latest = new Map<string, { message: InboxMessage; seq: number }>();
    for (const message of this.messages.values()) {
      if (message.author.kind !== "agent" || !message.author.session) continue;
      const seq = this.messageSeq.get(message.id) ?? 0;
      const known = latest.get(message.author.session);
      if (!known || known.seq < seq) latest.set(message.author.session, { message, seq });
    }
    const out = new Map<string, { id: string; subject: string | null; at: string; project_id: string }>();
    for (const [session, { message }] of latest) {
      out.set(session, { id: message.thread_id, subject: this.threadSubject(message.thread_id), at: message.created_at, project_id: message.project_id });
    }
    return out;
  }

  // ─────────────────────────── the Board's cards ───────────────────────────
  //
  // Approval "inbox-board" (2026-10-20). A card is its own record in its
  // project's cards.jsonl: append-only snapshots on the store's one seq
  // counter, so the event stream carries them, and read by nothing that
  // routes or lists threads. Who may move a card (COLUMNS.md, set d): an agent
  // moves its work through the live columns, ships it and may drop it with a
  // reason; only the person puts a card in the Icebox or brings one back from
  // it, and only the person restores a card they dropped. Nothing moves a card
  // by guessing: a linked PR that merges is shown, never acted on.

  card(id: string): InboxCard | null {
    return this.cards.get(id) ?? null;
  }

  /** A card as readers get it: only the linked threads that still exist. */
  cardWire(card: InboxCard): InboxCardWire {
    const threads = card.threads.filter((id) => this.messages.get(id)?.thread_id === id);
    return threads.length === card.threads.length ? card : { ...card, threads };
  }

  /**
   * The person looked at Dropped: every agent's drop they had not seen (in
   * `projectIds`, or everywhere; only those in `cardIds` when given, the drops
   * the window showed them) is marked seen, one line per card. Not a
   * write to the card itself: `heard_at` stays. Answers the cards it marked.
   */
  markCardDropsSeen(projectIds: ReadonlySet<string> | null = null, cardIds: ReadonlySet<string> | null = null): InboxCard[] {
    const marked: InboxCard[] = [];
    for (const card of this.listCards({ projectIds, columns: new Set(["dropped"]) })) {
      if (!isInboxCardDropUnseen(card)) continue;
      // Only the drops the person was shown (the window names them), when it names them.
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
    for (const card of this.cards.values()) {
      if (filter.projectIds && !filter.projectIds.has(card.project_id)) continue;
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
    for (const card of this.cards.values()) if (card.project_id === projectId && card.idempotency_key === key) return card;
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
      record: card,
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
      if (message.project_id !== projectId) {
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

  private cardPrs(values: readonly unknown[]): InboxCardPr[] {
    const out: InboxCardPr[] = [];
    for (const value of values) {
      const pr = parseInboxCardPr(value);
      if (!pr) throw new InboxError("validation_error", `${INBOX_CARD_PR_HINT} Not a PR: ${JSON.stringify(String(value).slice(0, 200))}.`, { field: "pr" });
      if (!out.some((known) => known.ref === pr.ref)) out.push(pr);
    }
    return out;
  }

  private cardText(value: unknown, field: string, max: number): string {
    const result = normalizeInboxCardText(value, field, max);
    if ("error" in result) throw new InboxError("validation_error", result.error, { field });
    return result.text;
  }

  private cardColumn(value: unknown): InboxCardColumn {
    if (!isInboxCardColumn(value)) {
      throw new InboxError("validation_error", `column: one of ${Object.keys(INBOX_CARD_COLUMN_LABELS).join(", ")}.`, { field: "column" });
    }
    return value;
  }

  /**
   * A new card in `project_id`. From a thread (`threads`), the title defaults
   * to the thread's subject. It starts in Asked unless a column is given: a
   * live column, or Shipped for work already done; the Icebox only by the
   * person, Dropped never. An agent that puts it in Your look or Your review
   * says what the person owes (`you`). The agent that makes a card is the
   * session it belongs to. Idempotent on `idempotency_key` per project.
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
    idempotency_key?: unknown;
  }): { card: InboxCard; replayed: boolean } {
    const project = this.projectsById.get(input.project_id);
    if (!project) throw new InboxError("project_not_found", `No project ${input.project_id}.`);
    const byAgent = input.by.kind === "agent";
    const threads = this.cardThreads(input.threads ?? [], project.id);
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
        return { card: known, replayed: true };
      }
    }
    const column = input.column === undefined || input.column === null ? "asked" : this.cardColumn(input.column);
    if (column === "dropped") throw new InboxError("validation_error", "column: a new card starts in a live column (or shipped), never dropped.", { field: "column" });
    if (column === "icebox" && byAgent) throw this.iceboxRefusal();
    const said = input.say === undefined || input.say === null ? null : this.cardText(input.say, "say", INBOX_CARD_LINE_MAX);
    const you: string | null = input.you === undefined || input.you === null ? null : this.cardText(input.you, "you", INBOX_CARD_LINE_MAX);
    if (you !== null && !isInboxCardPersonColumn(column)) throw this.youRefusal();
    if (byAgent && isInboxCardPersonColumn(column) && you === null) throw this.youRequired(column);
    const prs = this.cardPrs(input.prs ?? []);
    this.checkLinkCounts(threads.length, prs.length);
    const at = this.stamp();
    const card: InboxCard = {
      id: inboxId("crd"),
      project_id: project.id,
      title,
      column,
      you,
      said,
      threads,
      prs,
      agent: byAgent ? input.by : null,
      created_at: at,
      created_by: input.by,
      moved_at: at,
      heard_at: at,
      heard_by: input.by,
      dropped: null,
      aside_from: null,
      idempotency_key: key,
    };
    this.appendCard(card, at);
    return { card, replayed: false };
  }

  /**
   * One write to a card: any of a move (`column`), the agent's last word
   * (`say`), the person's line (`you`), a rename, more threads or PRs, and a
   * drop's `reason`. Every write counts as hearing from the card (`heard_at`).
   * `restore` (the person) puts a card in the Icebox or Dropped back where it
   * was. The rules are the column rules (COLUMNS.md, set d):
   *  - only the person puts a card in the Icebox, or moves one out of it;
   *  - an agent drops with a reason; only the person restores what they dropped;
   *  - an agent that moves a card into Your look or Your review says what the
   *    person owes (`you`), and `you` is kept only in those columns.
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
      reason?: unknown;
      restore?: boolean;
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
      !input.restore
    ) {
      throw new InboxError("validation_error", "Nothing to change: pass column, say, you, title, thread_id or pr.");
    }
    let column = card.column;
    if (input.restore) {
      if (byAgent) throw new InboxError("card_person_only", "Only the person restores a card from the Icebox or Dropped.");
      if (card.column !== "icebox" && card.column !== "dropped") {
        throw new InboxError("validation_error", `Card ${id} is in ${INBOX_CARD_COLUMN_LABELS[card.column]}, not the Icebox or Dropped: nothing to restore.`);
      }
      column = card.aside_from ?? "asked";
    } else if (given(input.column)) {
      column = this.cardColumn(input.column);
    }
    const moves = column !== card.column;
    if (moves && byAgent) {
      if (column === "icebox") throw this.iceboxRefusal();
      if (card.column === "icebox") {
        throw new InboxError("card_iceboxed", "The person put this card in the Icebox (paused); only they bring it back. You can still say or link.");
      }
      if (card.column === "dropped" && card.dropped?.by.kind === "person") {
        throw new InboxError("card_dropped_by_person", "The person dropped this card; only they restore it. You can still say or link.");
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
    const prs = [...card.prs];
    for (const pr of this.cardPrs(input.prs ?? [])) if (!prs.some((known) => known.ref === pr.ref)) prs.push(pr);
    this.checkLinkCounts(threads.length, prs.length);
    const at = this.stamp();
    // Leaving a live column (or Shipped) for the Icebox or Dropped remembers it, so restoring goes back there.
    const asideFrom =
      moves && (column === "icebox" || column === "dropped")
        ? isInboxCardLiveColumn(card.column) || card.column === "shipped"
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
      moved_at: moves ? at : card.moved_at,
      heard_at: at,
      heard_by: input.by,
      dropped,
      aside_from: asideFrom,
    };
    this.appendCard(next, at);
    return next;
  }

  private checkLinkCounts(threads: number, prs: number): void {
    if (threads > INBOX_CARD_LINKS_MAX || prs > INBOX_CARD_LINKS_MAX) {
      throw new InboxError("validation_error", `A card links at most ${INBOX_CARD_LINKS_MAX} threads and ${INBOX_CARD_LINKS_MAX} PRs.`);
    }
  }

  private iceboxRefusal(): InboxError {
    return new InboxError(
      "card_icebox_person_only",
      "Only the person puts a card in the Icebox (a pause is their call). Keep it in its column and say where it stands, or drop it with a reason.",
      { field: "column" },
    );
  }

  private youRefusal(): InboxError {
    return new InboxError(
      "validation_error",
      "you: what the person owes shows only in Your look and Your review. Move the card there with it, or use say for your own last word.",
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
