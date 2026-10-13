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
  composeInboxReplyBody,
  composeInboxReopenedBody,
  composeInboxSetAsideBody,
  inboxSkipAnswer,
  deriveInboxSubject,
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
  INBOX_RECORD_VERSION,
  type InboxAddressee,
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
  type InboxSupersededBy,
  type InboxListRow,
  type InboxListSection,
  type InboxThread,
  type InboxThreadSummary,
  checkInboxThreadName,
  inboxThreadNameKey,
  isInboxNote,
} from "@plannotator/core/inbox-types";
import { inboxListSections, inboxRowUnread, inboxSectionOf } from "./list";
import type { QuestionAnswer } from "@plannotator/core/question-block";
import { sanitizeTag } from "@plannotator/core/project";
import {
  INBOX_ANNOTATION_CURRENT,
  isInboxAnnotationId,
  isInboxAnnotationVersion,
  isInboxAnnotatableKind,
  type InboxAnnotationRecord,
  type InboxAttachment,
} from "@plannotator/core/inbox-types";
import { isLineRangeInPatch, parseDiffToFiles, type DiffFile } from "@plannotator/core/diff-files";
import { inboxBlobPath, inboxBlobSizes, removeUnusedInboxBlobs } from "./attachments";
import { inboxMarkupNamesOf, removeInboxMarkups } from "./markups";
import {
  ANNOTATIONS_FILE,
  DECISIONS_FILE,
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

/** The most ids one send may supersede. */
export const INBOX_SUPERSEDES_MAX = 100;

/** `<name>-<6 hex of the root>`, so two repositories with one name stay apart. */
export function inboxProjectKey(name: string, root: string, hashLength = 6): string {
  const base = sanitizeTag(name) ?? "project";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, Math.min(hashLength, 64));
  return `${base}-${hash}`;
}

export class InboxStore {
  readonly dir: string;
  private seq = 0;
  private readonly latest = new Map<string, InboxLine>();
  private readonly projectsById = new Map<string, InboxProject>();
  private readonly projectsByRoot = new Map<string, InboxProject>();
  private readonly messages = new Map<string, InboxMessage>();
  /** The seq of a message's first line: its place in the event log. */
  private readonly messageSeq = new Map<string, number>();
  /**
   * A resolved thread's archive line: the seq of the root line that set its
   * current `resolved_at`. Derived from the log in seq order, so a replay
   * finds the same value; nothing is written for it.
   */
  private readonly resolvedSeq = new Map<string, number>();
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
  /** Every decision, by id (step 3; the rules are packages/server/inbox-decisions.ts). */
  private readonly decisions = new Map<string, InboxDecision>();
  /** The person's annotations on attachments, by id. */
  private readonly annotations = new Map<string, InboxAnnotationRecord>();
  /** A guided review's files by its snapshot's sha256 (a blob never changes). */
  private readonly guideFileSets = new Map<string, ReadonlyMap<string, DiffFile>>();
  private readonly tornFiles = new Set<string>();
  private readonly listeners = new Set<InboxListener>();
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
      for (const name of [PROJECT_FILE, MESSAGES_FILE, QUESTIONS_FILE, DECISIONS_FILE, ANNOTATIONS_FILE]) {
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
        break;
      case "message": {
        // The archive line: the root line whose resolved_at differs from the one before it.
        const before = previous?.kind === "message" ? previous.record.resolved_at : null;
        if (line.record.resolved_at == null) this.resolvedSeq.delete(line.record.id);
        else if (before !== line.record.resolved_at || !this.resolvedSeq.has(line.record.id)) this.resolvedSeq.set(line.record.id, line.seq);
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
      case "decision":
        this.decisions.set(line.record.id, line.record);
        break;
      case "annotation":
        this.annotations.set(line.record.id, line.record);
        break;
    }
  }

  /** Note a root's routing keys, from its first line only. */
  private indexRoot(message: InboxMessage): void {
    if (message.thread_id !== message.id || message.author.kind !== "agent") return;
    const name = message.thread_name ?? null;
    if (name !== null) {
      const key = `${message.project_id}\0${inboxThreadNameKey(name)}`;
      const roots = this.namedThreads.get(key);
      if (roots) roots.push(message.id);
      else this.namedThreads.set(key, [message.id]);
    } else if (message.author.session) {
      this.sessionThreads.set(`${message.project_id}\0${message.author.session}`, message.id);
    }
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
      const roots = this.namedThreads.get(`${projectId}\0${inboxThreadNameKey(name)}`) ?? [];
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

  subscribe(listener: InboxListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listProjects(): InboxProject[] {
    return [...this.projectsById.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  project(id: string): InboxProject | null {
    return this.projectsById.get(id) ?? null;
  }

  projectByRoot(root: string): InboxProject | null {
    return this.projectsByRoot.get(root) ?? null;
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
  private archiveSeq(threadId: string): number | null {
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

  thread(threadId: string): InboxThread | null {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) return null;
    const project = this.projectsById.get(root.project_id);
    if (!project) return null;
    return {
      thread_id: threadId,
      project,
      subject: this.threadSubject(threadId),
      thread_name: root.thread_name ?? null,
      resolved_at: root.resolved_at,
      messages: this.threadMessages(threadId).map((m) => this.wire(m)),
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
        };
      }),
    };
  }

  threadSummary(threadId: string): InboxThreadSummary | null {
    const root = this.messages.get(threadId);
    if (!root || root.thread_id !== threadId) return null;
    const messages = this.threadMessages(threadId);
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
    let waitingSince: string | null = null;
    for (const message of messages) {
      // The person's reply is a look; the Inbox's own notes (Mark read's
      // set-aside note, a late Undo's reopened note) are not.
      if (message.author.kind === "person" && !isInboxNote(message)) lastPersonSeq = seqOf(message);
      if (message.author.kind === "agent") lastAgentAt = message.created_at;
      if (waitingSince === null && this.questionsOf(message.id).some((q) => q.state === "open" && !q.orphaned)) {
        waitingSince = message.created_at;
      }
    }
    // A reply of the person's is a look at everything before it.
    const seenSeq = Math.max(root.person_seen_seq ?? 0, lastPersonSeq);
    const unseen = messages.filter((m) => m.author.kind === "agent" && seqOf(m) > seenSeq).length;
    // The last message with the Inbox's notes read past: rule 7 (Sent) and "came back".
    const lastReal = lastNonNote(messages) ?? root;
    const sent =
      lastReal.author.kind === "person"
        ? { at: lastReal.created_at, checked_at: (root.agent_checked_seq ?? 0) >= seqOf(lastReal) ? (root.agent_checked_at ?? null) : null }
        : null;
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
    const facts = {
      ...summary,
      agent_after_archive: agentAfterArchive,
      back_from_archive: backFromArchive,
      read_at: readAt,
      project: { id: project.id, name: project.name },
      thread_name: root.thread_name ?? null,
      answered_not_sent: (root.resolved_at === null || backFromArchive) && summary.questions.open === 0 && summary.questions.picked > 0,
      waiting_since: waitingSince,
      unseen,
      sent,
      guide: messages.some((m) => m.guide != null),
      last_agent_at: lastAgentAt,
    };
    const section = inboxSectionOf(facts);
    return { ...facts, section, unread: inboxRowUnread(section) };
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
      if (message.set_aside && message.author.kind === "person") continue;
      if ((this.messageSeq.get(message.id) ?? 0) > readSeq) return null;
    }
    return root.person_read_at ?? null;
  }

  /**
   * Mark read (`read`), or move it back (Undo, the pressed button). Mark read
   * moves the thread to Quiet without archiving it: every question still
   * waiting on the person (open, or picked and not sent) is closed as a skip
   * (`set_aside`, never a decision), and the thread counts as looked at. It
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
        if (root.person_read_seq != null) {
          // While the read still holds (no message since), the look it counted
          // is taken back too, so news it hid is news again.
          const restoreLook = this.readAt(root, members) !== null && root.person_seen_before_read !== undefined;
          this.appendMessage(
            {
              ...root,
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
    let total = [...blobSizes.values()].reduce((sum, size) => sum + size, 0);
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
      for (const name of [PROJECT_FILE, MESSAGES_FILE, QUESTIONS_FILE, DECISIONS_FILE, ANNOTATIONS_FILE]) {
        let text: string;
        try {
          text = readFileSync(join(folder, name), "utf8");
        } catch {
          continue;
        }
        bytes += Buffer.byteLength(text);
        total += Buffer.byteLength(text);
        // The project line and its decisions count for the project, not a thread.
        if (name === PROJECT_FILE || name === DECISIONS_FILE) continue;
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
    if (existing) return existing;
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
    return project;
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

    const supersedes = this.normalizeSupersedes(input.supersedes);
    const key = input.idempotency_key?.trim() || null;
    if (key) {
      for (const message of this.messages.values()) {
        if (message.project_id !== projectId || message.idempotency_key !== key || message.author.kind !== "agent") continue;
        // A retry is the same call: the same body, reply target, thread
        // name (compared as routing compares names) and superseded ids. The
        // thread it joined is the first call's, whatever the routing would
        // say now.
        const sameName = inboxThreadNameKey(message.thread_name ?? "") === inboxThreadNameKey(threadName ?? "");
        const sameGuide = (message.guide?.input_sha256 ?? null) === (input.guide?.input_sha256 ?? null);
        const sameSupersedes = [...(message.supersedes ?? [])].sort().join("\n") === [...supersedes].sort().join("\n");
        if (message.body !== body || message.reply_to !== replyTo || !sameName || !sameGuide || !sameSupersedes) {
          throw new InboxError(
            "idempotency_key_reused",
            "This idempotency_key was already used for a different message.",
            { message_id: message.id },
          );
        }
        return { message: this.wire(message), replayed: true };
      }
    }

    if (!replyTo) threadId = this.routeThread(projectId, input.author.session, threadName);

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
      ...(input.guide ? { guide: input.guide } : {}),
      ...(input.base_path ? { base_path: input.base_path } : {}),
      ...(input.wakes === true ? { wakes: true } : {}),
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
          decision_on_answer: question.decision_on_answer,
          stopped: question.stopped,
          holds_up: question.holds_up,
          asked_by_agent_id: input.author.session,
          answer: null,
          revision: 0,
          sent_revision: 0,
          picked_by: null,
          picked_at: null,
          sent_reply_id: null,
          decision_id: null,
        },
        at,
      );
    }
    // The superseded questions last, so whoever reads them finds the message
    // that superseded them. A pick saved on one stays on it, never sent; a
    // decision drafted on it is dropped.
    for (const [questionId, by] of superseding) {
      const record = this.questions.get(questionId)!;
      this.appendQuestion({ ...record, superseded_by: by, ...(record.decision_draft ? { decision_draft: null } : {}) }, at);
    }
    // A reply from the agent reopens nothing: a resolved thread stays resolved.
    return { message: this.wire(message), replayed: false };
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
  sendReply(messageId: string, input: InboxReplyInput): InboxReplyResult {
    const key = typeof input.idempotency_key === "string" ? input.idempotency_key.trim() : "";
    if (!key) throw new InboxError("validation_error", "idempotency_key: required on a Send.", { field: "idempotency_key" });
    const existingMessage = this.messages.get(messageId);
    if (existingMessage) {
      for (const message of this.messages.values()) {
        if (message.reply_to === messageId && message.author.kind === "person" && message.idempotency_key === key) {
          return { reply: message, questions: this.questionsOf(messageId), replayed: true };
        }
      }
    }
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
    if (plan.length === 0 && skips.length === 0 && words.trim() === "" && feedback === "") {
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
    // The picks first, then the annotations as Plannotator's feedback text.
    const body = [
      composeInboxReplyBody({
        questions: all,
        sent: updated.map((r) => r.answer as QuestionAnswer),
        earlier,
        words,
      }),
      feedback,
    ]
      .filter((part) => part !== "")
      .join("\n\n");

    // The questions first, so whoever reads the reply finds them already sent.
    // If any of these writes fails, the questions written so far are put back
    // as they were (on disk, repairUnsentAnswers does the same at the next
    // start), so a failed Send never leaves answers "sent" with no reply.
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
      // Another live session takes it: handed only to that session, like a New message.
      ...(input.to ? { to: { host: input.to.host, session: input.to.session } } : {}),
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

  // ─────────────── decisions (step 3; the rules: packages/server/inbox-decisions.ts) ───────────────

  decision(id: string): InboxDecision | null {
    return this.decisions.get(id) ?? null;
  }

  /** A project's decisions, oldest first. */
  decisionsOf(projectId: string): InboxDecision[] {
    return [...this.decisions.values()]
      .filter((d) => d.project_id === projectId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  /**
   * Every decision of every project, unordered: for one-pass counts. A live
   * view of the store's map: iterate it at once, never hold it across a write
   * or a reload().
   */
  allDecisions(): Iterable<Readonly<InboxDecision>> {
    return this.decisions.values();
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

  /** Append one decision snapshot (a new decision, or a retired or replaced one). */
  writeDecision(record: InboxDecision): void {
    const project = this.projectsById.get(record.project_id);
    if (!project) throw new InboxError("project_not_found", `No project ${record.project_id}.`);
    this.write(join(this.projectFolder(project), DECISIONS_FILE), {
      v: INBOX_RECORD_VERSION,
      seq: this.seq + 1,
      at: this.stamp(),
      kind: "decision",
      id: record.id,
      record,
    });
  }

  /**
   * Change a question's decision fields only (the switch, the card's words,
   * the recorded decision's id). Never its answer or revision, so a switch
   * never races a pick.
   */
  writeQuestionDecision(
    id: string,
    patch: Partial<Pick<InboxQuestionRecord, "decision_recording" | "decision_draft" | "decision_id">>,
  ): InboxQuestionRecord {
    const record = this.questions.get(id);
    if (!record) throw new InboxError("question_not_found", `No question ${id}.`);
    const next = { ...record, ...patch };
    this.appendQuestion(next, this.stamp());
    return next;
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
      const attachment = message.attachments?.find((a) => a.id === attachmentId);
      if (attachment) return { attachment, message };
    }
    return null;
  }

  /** The thread's attachments, message by message, in thread order. */
  threadAttachments(threadId: string): InboxAttachmentHit[] {
    return this.threadMessages(threadId).flatMap((message) => (message.attachments ?? []).map((attachment) => ({ attachment, message })));
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
    if (this.closedByArchive(hit.message)) throw new InboxError("thread_resolved", "This thread is resolved; reopen it to annotate.");
    const existing = this.annotations.get(id);
    // A draft's key is the file's path and the version, so an annotation
    // made through one attachment of a file edits from another of the same file.
    if (existing && (existing.guide || existing.path !== hit.attachment.path || existing.version !== input.version || existing.thread_id !== hit.message.thread_id)) {
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
      annotation: annotation as Record<string, unknown>,
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
      if (message.project_id !== projectId || (!message.attachments?.length && !message.guide)) continue;
      const blobs = out.get(message.thread_id) ?? new Set<string>();
      for (const attachment of message.attachments ?? []) blobs.add(attachment.sent_sha256);
      // A guided review's snapshot is a blob too (step 5).
      if (message.guide) blobs.add(message.guide.sha256);
      out.set(message.thread_id, blobs);
    }
    return out;
  }

  // ─────────────────────────── deleting ───────────────────────────

  /**
   * Delete a thread: its messages, questions and annotations are dropped from
   * the project's files (its decisions stay: they belong to the project) (each rewritten whole: temp file, then rename), and
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
    this.latest.clear();
    this.projectsById.clear();
    this.projectsByRoot.clear();
    this.messages.clear();
    this.messageSeq.clear();
    this.resolvedSeq.clear();
    this.questions.clear();
    this.messageQuestions.clear();
    this.sessionThreads.clear();
    this.threadMembers.clear();
    this.namedThreads.clear();
    this.decisions.clear();
    this.annotations.clear();
    this.tornFiles.clear();
    this.load();
    const used = new Set<string>();
    for (const message of this.messages.values()) {
      for (const attachment of message.attachments ?? []) used.add(attachment.sent_sha256);
      if (message.guide) used.add(message.guide.sha256);
    }
    removeUnusedInboxBlobs(this.dir, used);
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
   */
  pendingReplies(session: string): InboxMessage[] {
    const out: { message: InboxMessage; seq: number }[] = [];
    for (const message of this.messages.values()) {
      if (message.author.kind !== "person" || message.delivery || !this.isFor(message, session)) continue;
      const seq = this.messageSeq.get(message.id) ?? 0;
      // A New message, or a reply the person sent to another session, is
      // settled only by its delivery to the session it names (its own
      // wait_for_reply records one), never by another agent's read.
      if (!message.to && (this.messages.get(message.thread_id)?.agent_checked_seq ?? 0) >= seq) continue;
      out.push({ message, seq });
    }
    return out.sort((a, b) => a.seq - b.seq).map((entry) => entry.message);
  }

  /**
   * A connection delivered a reply into the asking session as a turn: the
   * reply records it (`delivery`), and the thread counts as read by the agent
   * up to it (the Sent band's "Delivered to <agent>, <time>"). Idempotent.
   */
  recordDelivery(replyId: string, by: { host: string; session: string }): InboxMessage {
    const reply = this.messages.get(replyId);
    if (!reply || reply.author.kind !== "person" || (!reply.reply_to && !reply.to)) throw new InboxError("message_not_found", `No reply ${replyId}.`);
    if (!this.isFor(reply, by.session)) {
      throw new InboxError("validation_error", "session: this reply answers another session's message.", { field: "session" });
    }
    if (reply.delivery) return reply;
    const at = this.stamp();
    const delivered: InboxMessage = { ...reply, delivery: { state: "delivered", host: by.host, session: by.session, at } };
    this.appendMessage(delivered, at);
    this.markAgentChecked(reply.thread_id, this.messageSeq.get(reply.id) ?? 0, at);
    return delivered;
  }

  /**
   * Whether a person's message goes to `session`: a New message addressed to
   * it (`to`), a reply the person sent to it because the asking session had
   * ended (`to` on a reply), or a reply to a message it sent.
   */
  private isFor(message: InboxMessage, session: string): boolean {
    if (message.to) return message.to.session === session;
    const asked = message.reply_to ? this.messages.get(message.reply_to) : undefined;
    return asked?.author.kind === "agent" && asked.author.session === session;
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
}
